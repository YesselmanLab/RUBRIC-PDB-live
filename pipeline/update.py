"""Score every RNA-containing PDB entry with RUBRIC and keep data/ up to date.

Each run asks RCSB which entries contain RNA, scores the entries that are new, were
revised since they were last scored, failed last time, or were scored with another
RUBRIC version, and drops entries that are no longer in the PDB. It then rewrites

    data/summary.csv     one row per scored entry
    data/failures.csv    entries that could not be scored, with the reason
    data/manifest.json   per entry: RCSB revision date, status, RUBRIC version, results
    data/updates.csv     one line per run

and stores the full RUBRIC report of each entry in results/entries/<xy>/<ID>.json.gz,
where <xy> is the middle two characters of the PDB ID.

    python pipeline/update.py                  # incremental update
    python pipeline/update.py --full           # rescore every entry
    python pipeline/update.py --limit 200      # score at most 200 entries (testing)
    python pipeline/update.py --ids 1GID 7K00  # only these entries (testing)
    python pipeline/update.py --min-days 14    # do nothing if the last update is newer
"""
import argparse
import csv
import datetime as dt
import gzip
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEARCH_URL = "https://search.rcsb.org/rcsbsearch/v2/query"
GRAPHQL_URL = "https://data.rcsb.org/graphql"
DOWNLOAD_URL = "https://files.rcsb.org/download/{}.cif.gz"
USER_AGENT = "RUBRIC-PDB-live (https://github.com/YesselmanLab/RUBRIC-PDB-live)"
METADATA_BATCH = 200
CHECKPOINT_EVERY = 250

SUMMARY_COLUMNS = [
    "pdb_id", "title", "method", "resolution", "release_date", "revision_date",
    "rna_chains", "rna_nucleotides", "n_pairs", "n_rna_pairs", "n_scored_pairs", "n_ambiguous_pairs",
    "pairs_score", "n_preferred", "n_secondary_review", "n_priority_review",
    "backbone_suiteness", "n_pucker_outliers", "rubric_version", "scored_on",
]
FAILURE_COLUMNS = ["pdb_id", "revision_date", "error", "rubric_version", "attempted_on"]
UPDATE_COLUMNS = ["date", "rubric_version", "entries", "scored", "failed",
                  "added", "revised", "rescored", "removed"]

METADATA_QUERY = """
query ($ids: [String!]!) {
  entries(entry_ids: $ids) {
    rcsb_id
    struct { title }
    exptl { method }
    rcsb_entry_info { resolution_combined }
    rcsb_accession_info { initial_release_date revision_date }
    polymer_entities {
      entity_poly { rcsb_entity_polymer_type rcsb_sample_sequence_length }
      rcsb_polymer_entity_container_identifiers { asym_ids auth_asym_ids }
    }
  }
}
"""


# ---- RCSB --------------------------------------------------------------------

def http(url, payload=None, retries=4, timeout=180):
    """Response body of a GET (or a JSON POST when payload is given), with retries."""
    headers = {"User-Agent": USER_AGENT}
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, headers=headers)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as err:
            if err.code == 404 or attempt == retries - 1:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == retries - 1:
                raise
        time.sleep(5 * 2 ** attempt)
    raise RuntimeError("unreachable")


def rna_entry_ids():
    """IDs of every current PDB entry with at least one RNA polymer entity."""
    query = {
        "query": {"type": "terminal", "service": "text", "parameters": {
            "attribute": "rcsb_entry_info.polymer_entity_count_RNA",
            "operator": "greater", "value": 0}},
        "return_type": "entry",
        "request_options": {"return_all_hits": True},
    }
    result = json.loads(http(SEARCH_URL, query))
    return sorted(hit["identifier"].upper() for hit in result["result_set"])


def entry_metadata(raw):
    """One summary-ready metadata dict from a GraphQL entry."""
    exptl = raw.get("exptl") or []
    info = raw.get("rcsb_entry_info") or {}
    accession = raw.get("rcsb_accession_info") or {}
    resolutions = [r for r in info.get("resolution_combined") or [] if r is not None]
    chains = nucleotides = 0
    rna_auth_chains = set()
    for entity in raw.get("polymer_entities") or []:
        poly = entity.get("entity_poly") or {}
        if poly.get("rcsb_entity_polymer_type") != "RNA":
            continue
        ids = entity.get("rcsb_polymer_entity_container_identifiers") or {}
        copies = len(ids.get("asym_ids") or [])
        chains += copies
        nucleotides += copies * (poly.get("rcsb_sample_sequence_length") or 0)
        rna_auth_chains.update(ids.get("auth_asym_ids") or [])
    return {
        "pdb_id": raw["rcsb_id"].upper(),
        "title": ((raw.get("struct") or {}).get("title") or "").strip(),
        "method": "; ".join(sorted({e["method"] for e in exptl if e.get("method")})),
        "resolution": min(resolutions) if resolutions else None,
        "release_date": (accession.get("initial_release_date") or "")[:10],
        "revision_date": (accession.get("revision_date") or "")[:10],
        "rna_chains": chains,
        "rna_nucleotides": nucleotides,
        # Author chain IDs of the RNA chains (the chain IDs in RUBRIC's res_id); used
        # to count RNA-RNA pairs, not written to the summary.
        "rna_auth_chains": sorted(rna_auth_chains),
    }


def fetch_metadata(ids):
    """Metadata for each ID that RCSB still serves, keyed by PDB ID."""
    metadata = {}
    for start in range(0, len(ids), METADATA_BATCH):
        batch = ids[start:start + METADATA_BATCH]
        body = json.loads(http(GRAPHQL_URL, {"query": METADATA_QUERY, "variables": {"ids": batch}}))
        if body.get("errors") and not body.get("data"):
            raise RuntimeError(f"RCSB metadata query failed: {body['errors'][0].get('message')}")
        for raw in (body.get("data") or {}).get("entries") or []:
            if raw:
                meta = entry_metadata(raw)
                metadata[meta["pdb_id"]] = meta
    return metadata


# ---- RUBRIC ------------------------------------------------------------------

def find_engine(explicit=None):
    """The compiled rubric program (the bundled binary, not the Python launcher)."""
    if explicit:
        return str(Path(explicit).resolve())
    try:
        import rubric_rna
        binary = rubric_rna.binary_path()
        if binary.is_file():
            return str(binary)
    except ImportError:
        pass
    found = shutil.which("rubric")
    if found:
        return found
    sys.exit("rubric was not found; install it with `pip install -r pipeline/requirements.txt`")


def engine_version(engine):
    return subprocess.run([engine, "--version"], capture_output=True, text=True,
                          check=True).stdout.strip()


def result_path(results_dir, pdb_id):
    return results_dir / pdb_id[1:3].lower() / f"{pdb_id}.json.gz"


def chain_of(res_id):
    """Chain ID of a RUBRIC residue ID such as 'A-G-12'."""
    return res_id.split("-", 1)[0]


def report_fields(report, rna_chains):
    """The summary columns taken from one RUBRIC report.

    A pair counts as RNA-RNA when both residues lie in chains that RCSB types as RNA.
    """
    tiers = report.get("tier_summary") or {}
    pairs = report.get("pairs") or []
    rna_chains = set(rna_chains)
    return {
        "n_pairs": report.get("n_pairs", len(pairs)),
        "n_rna_pairs": sum(1 for p in pairs
                           if chain_of(p["res_id1"]) in rna_chains
                           and chain_of(p["res_id2"]) in rna_chains),
        "n_scored_pairs": sum(tiers.values()),
        "n_ambiguous_pairs": sum(1 for p in pairs
                                 if (p.get("classification") or {}).get("is_ambiguous")),
        "pairs_score": report.get("pairs_score"),
        "n_preferred": tiers.get("Preferred", 0),
        "n_secondary_review": tiers.get("Secondary review", 0),
        "n_priority_review": tiers.get("Priority review", 0),
        "backbone_suiteness": report.get("backbone_suiteness"),
        "n_pucker_outliers": len(report.get("pucker_outliers") or []),
    }


def score_entry(pdb_id, rna_chains, engine, work_dir, results_dir, timeout):
    """Download one entry, run RUBRIC on it and store the report.

    Returns (fields, None) on success and (None, error message) on failure.
    """
    structure = work_dir / f"{pdb_id}.cif.gz"
    try:
        try:
            structure.write_bytes(http(DOWNLOAD_URL.format(pdb_id)))
        except urllib.error.HTTPError as err:
            return None, f"download failed (HTTP {err.code})"
        except Exception as err:  # network errors after all retries
            return None, f"download failed ({type(err).__name__})"
        with tempfile.TemporaryDirectory(dir=work_dir) as tmp:
            out = Path(tmp) / "report.json"
            try:
                run = subprocess.run([engine, str(structure), "--no-download", "--out", str(out)],
                                     capture_output=True, text=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                return None, f"rubric did not finish within {timeout} s"
            if run.returncode != 0 or not out.is_file() or out.stat().st_size == 0:
                lines = [l for l in (run.stderr or "").splitlines() if l.strip()]
                detail = lines[-1][:200] if lines else "no message"
                return None, f"rubric exited with code {run.returncode}: {detail}"
            raw = out.read_bytes()
        report = json.loads(raw)
        target = result_path(results_dir, pdb_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(gzip.compress(raw, mtime=0))
        return report_fields(report, rna_chains), None
    finally:
        structure.unlink(missing_ok=True)


# ---- data/ files -------------------------------------------------------------

def load_manifest(path):
    if path.is_file():
        return json.loads(path.read_text())
    return {"entries": {}}


def write_manifest(path, manifest):
    """Write the manifest with entries in PDB ID order (the in-memory dict is left as is)."""
    ordered = {**manifest, "entries": dict(sorted(manifest["entries"].items()))}
    path.write_text(json.dumps(ordered, indent=1) + "\n")


def write_csv(path, columns, rows):
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def last_update_date(updates_path):
    if not updates_path.is_file():
        return None
    with updates_path.open() as handle:
        rows = list(csv.DictReader(handle))
    return dt.date.fromisoformat(rows[-1]["date"]) if rows else None


def append_update(updates_path, row):
    new = not updates_path.is_file()
    with updates_path.open("a", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=UPDATE_COLUMNS)
        if new:
            writer.writeheader()
        writer.writerow(row)


# ---- main --------------------------------------------------------------------

def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--full", action="store_true", help="rescore every entry")
    ap.add_argument("--limit", type=int, help="score at most this many entries")
    ap.add_argument("--ids", nargs="+", help="only these PDB IDs")
    ap.add_argument("--min-days", type=int, default=0,
                    help="do nothing if the last update is fewer than this many days old")
    ap.add_argument("--workers", type=int, default=4, help="entries scored in parallel")
    ap.add_argument("--timeout", type=int, default=900, help="seconds allowed per entry")
    ap.add_argument("--engine", help="path to the rubric program (default: the installed one)")
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data")
    ap.add_argument("--results-dir", type=Path, default=ROOT / "results" / "entries")
    ap.add_argument("--work-dir", type=Path, default=ROOT / "work")
    return ap.parse_args()


def main():
    args = parse_args()
    today = dt.datetime.now(dt.timezone.utc).date()
    data_dir, results_dir, work_dir = args.data_dir, args.results_dir, args.work_dir
    manifest_path = data_dir / "manifest.json"
    updates_path = data_dir / "updates.csv"

    last = last_update_date(updates_path)
    if args.min_days and last and (today - last).days < args.min_days:
        print(f"Last update was on {last}; nothing to do before {args.min_days} days have passed.")
        return

    engine = find_engine(args.engine)
    version = engine_version(engine)
    for d in (data_dir, results_dir, work_dir):
        d.mkdir(parents=True, exist_ok=True)

    partial = bool(args.ids or args.limit)
    ids = sorted({i.upper() for i in args.ids}) if args.ids else rna_entry_ids()
    print(f"Checking {len(ids)} RNA-containing entries; fetching their RCSB metadata", flush=True)
    metadata = fetch_metadata(ids)

    manifest = load_manifest(manifest_path)
    entries = manifest["entries"]
    removed = [] if partial else sorted(set(entries) - set(metadata))
    for pdb_id in removed:
        entries.pop(pdb_id)
        result_path(results_dir, pdb_id).unlink(missing_ok=True)

    todo, reason = [], {}
    for pdb_id in sorted(metadata):
        old = entries.get(pdb_id)
        if old is None:
            reason[pdb_id] = "added"
        elif args.full or old.get("rubric_version") != version or old.get("status") != "scored":
            reason[pdb_id] = "rescored"
        elif old.get("revision_date") != metadata[pdb_id]["revision_date"]:
            reason[pdb_id] = "revised"
        else:
            continue
        todo.append(pdb_id)
    if args.limit:
        todo = todo[:args.limit]
    print(f"Scoring {len(todo)} entries with RUBRIC {version} ({args.workers} workers)", flush=True)

    counts = {"added": 0, "revised": 0, "rescored": 0}
    started = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(score_entry, pdb_id, metadata[pdb_id]["rna_auth_chains"], engine,
                               work_dir, results_dir, args.timeout): pdb_id
                   for pdb_id in todo}
        for done, future in enumerate(as_completed(futures), 1):
            pdb_id = futures[future]
            fields, error = future.result()
            entry = {"revision_date": metadata[pdb_id]["revision_date"],
                     "rubric_version": version, "scored_on": today.isoformat()}
            if error is None:
                entry.update(status="scored", results=fields)
            else:
                entry.update(status="failed", error=error)
                result_path(results_dir, pdb_id).unlink(missing_ok=True)
            entries[pdb_id] = entry
            counts[reason[pdb_id]] += 1
            if done % CHECKPOINT_EVERY == 0 or done == len(todo):
                write_manifest(manifest_path, manifest)
                rate = done / max(time.time() - started, 1e-9)
                print(f"  {done}/{len(todo)} done ({rate:.1f} entries/s)", flush=True)

    manifest["rubric_version"] = version
    manifest["updated_on"] = today.isoformat()
    write_manifest(manifest_path, manifest)

    summary, failures = [], []
    for pdb_id, entry in sorted(entries.items()):
        meta = metadata.get(pdb_id)
        if meta is None:
            continue
        if entry["status"] == "scored":
            summary.append({**meta, **entry["results"], "rubric_version": entry["rubric_version"],
                            "scored_on": entry["scored_on"]})
        else:
            failures.append({"pdb_id": pdb_id, "revision_date": entry["revision_date"],
                             "error": entry["error"], "rubric_version": entry["rubric_version"],
                             "attempted_on": entry["scored_on"]})
    write_csv(data_dir / "summary.csv", SUMMARY_COLUMNS, summary)
    write_csv(data_dir / "failures.csv", FAILURE_COLUMNS, failures)
    append_update(updates_path, {
        "date": today.isoformat(), "rubric_version": version, "entries": len(entries),
        "scored": len(summary), "failed": len(failures), **counts, "removed": len(removed)})
    shutil.rmtree(work_dir, ignore_errors=True)
    print(f"Done: {len(summary)} scored, {len(failures)} failed, {counts['added']} added, "
          f"{counts['revised']} revised, {counts['rescored']} rescored, {len(removed)} removed")


if __name__ == "__main__":
    main()
