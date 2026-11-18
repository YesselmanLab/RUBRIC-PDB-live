# RUBRIC-PDB-live

[![Update RUBRIC results](https://github.com/YesselmanLab/RUBRIC-PDB-live/actions/workflows/update.yml/badge.svg)](https://github.com/YesselmanLab/RUBRIC-PDB-live/actions/workflows/update.yml)

RUBRIC base-pair, backbone and ribose results for every RNA-containing entry in the
Protein Data Bank, updated weekly.

[RUBRIC](https://github.com/YesselmanLab/RUBRIC) classifies the base pairs of an RNA
structure in the Leontis-Westhof scheme, scores each pair from 0 to 100 against
pairs of the same type and class in high-quality structures, assigns each backbone
suite to a conformer and flags riboses with an inconsistent pucker. This repository
applies it to every PDB entry that contains RNA and keeps the results current as
new entries are released and existing ones are revised.

## Files

| File | Contents |
|---|---|
| `data/summary.csv` | One row per scored entry (columns below) |
| `data/failures.csv` | Entries that could not be scored, with the reason |
| `data/updates.csv` | One line per update: entries added, revised, rescored and removed |
| `data/manifest.json` | Per entry: RCSB revision date, status and RUBRIC version |
| `<ID>.json.gz` on the `entries` branch | The full RUBRIC report (gzipped JSON) of each entry |

The full report of a single entry can also be produced locally with
`pip install rubric-rna` and `rubric <PDB ID>`.

## Columns of `summary.csv`

| Column | Meaning |
|---|---|
| `pdb_id` | PDB ID |
| `title`, `method`, `resolution` | From RCSB (resolution in Å; empty for NMR) |
| `release_date`, `revision_date` | First release and latest revision at RCSB |
| `rna_chains`, `rna_nucleotides` | RNA chains in the entry and their total sequence length |
| `n_pairs` | Base pairs found by RUBRIC, including pairs involving DNA |
| `n_rna_pairs` | Base pairs between two RNA chains (chains that RCSB types as RNA) |
| `n_scored_pairs` | Pairs that received a score; ambiguous pairs and pairs involving DNA are not scored |
| `n_ambiguous_pairs` | Pairs whose geometry lies between two Leontis-Westhof classes |
| `pairs_score` | Pair score of the entry (0 to 100); empty when no pair was scored |
| `n_preferred` | Pairs scoring 100 |
| `n_secondary_review` | Pairs scoring 80 or more but below 100 |
| `n_priority_review` | Pairs scoring below 80 |
| `backbone_suiteness` | Suiteness of the RNA backbone (0 to 1) |
| `n_unassigned_suites` | Backbone suites that fit none of the conformers |
| `n_pucker_outliers` | Riboses whose pucker from δ and from the P-perpendicular distance disagree |
| `rubric_version`, `scored_on` | RUBRIC version and date of scoring |

## Site

The site at https://yesselmanlab.github.io/RUBRIC-PDB-live/ is static and served by
GitHub Pages from `main`; there is no server or build step.

| File | Role |
|---|---|
| `index.html` | Page layout: search, table of entries, about |
| `assets/app.js` | Loads `data/summary.csv` and `data/updates.csv`, draws the table and filters, and shows one entry per URL hash (`#1EHZ`) from its report |
| `assets/zip.js` | Builds the bulk-download ZIP in the browser (see below) |
| `assets/rubric3d.js` | Interactive 3D view on each entry page: Mol* draws the structure from RCSB, coloured from the entry's report |
| `assets/style.css` | Styles, light and dark |
| `404.html` | Page for unknown addresses |

Entry reports are fetched from the `entries` branch through raw.githubusercontent.com
and decompressed in the browser. The two ZIP buttons download the reports of the
filtered or of all entries and write them into one ZIP as they arrive. A gzip file
and a ZIP entry hold the same deflate stream, so each report is copied into the ZIP
without decompressing it, and unzipping gives plain `.json` files. Chrome and Edge
write the ZIP straight to disk; other browsers keep it in memory until it is saved.

`index.html` loads the stylesheet and scripts with a `?v=` date; change it whenever
`assets/` changes, so browsers do not combine a new page with a cached old stylesheet.

Tests for `zip.js` run on every push that changes `assets/` or `tests/`:

```bash
node --test tests/*.test.mjs
```

## Updates

A scheduled GitHub Actions job runs every Thursday, the day after the weekly PDB
release. It asks RCSB for every entry with an RNA polymer, scores
the entries that are new or were revised since they were last scored, removes
obsoleted entries and publishes the updated files. When RUBRIC itself changes,
every entry is rescored, so all rows always come from one RUBRIC version.

To run an update locally:

```bash
python -m venv .venv
.venv/bin/pip install -r pipeline/requirements.txt
.venv/bin/python pipeline/update.py              # incremental update
.venv/bin/python pipeline/update.py --limit 50   # quick test
```

## Licence

The code is released under the MIT License (`LICENSE`). The results are released
under CC BY 4.0 (`data/LICENSE`); please cite RUBRIC when you use them. The
structures come from the Protein Data Bank (CC0 1.0).
