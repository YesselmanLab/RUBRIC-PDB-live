/* RUBRIC-PDB-live: search, table of all entries, and the per-entry view.
 *
 * Reads data/summary.csv and data/updates.csv from this site, each entry's full
 * report from the entries branch on GitHub (gzipped JSON, decompressed in the
 * browser) and the structure picture from RCSB.
 */
(function () {
  "use strict";

  const SITE_URL = "https://yesselmanlab.github.io/RUBRIC-PDB-live/";
  const REPORT_URL = "https://raw.githubusercontent.com/YesselmanLab/RUBRIC-PDB-live/entries/";
  const RCSB_URL = "https://www.rcsb.org/structure/";
  const RCSB_IMAGE = (id) => `https://cdn.rcsb.org/images/structures/${id.toLowerCase()}_assembly-1.jpeg`;
  const RCSB_IMAGE_MODEL = (id) => `https://cdn.rcsb.org/images/structures/${id.toLowerCase()}_model-1.jpeg`;
  const ROW_LIMIT = 300;  // rows shown at first in the entry tables

  const state = {
    rows: [],
    byId: new Map(),
    filtered: [],
    sortKey: "release_date",
    sortDir: -1,
    page: 1,
    pageSize: 50,
    lastUpdate: null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtInt = (n) => (n == null || Number.isNaN(n) ? "" : Number(n).toLocaleString("en-US"));
  const na = (text = "n/a") => `<span class="na">${text}</span>`;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  // ---- Small helpers ---------------------------------------------------------

  function methodLabel(method) {
    if (!method) return "";
    const one = (m) => ({
      "X-RAY DIFFRACTION": "X-ray",
      "ELECTRON MICROSCOPY": "Cryo-EM",
      "SOLUTION NMR": "NMR",
      "SOLID-STATE NMR": "Solid-state NMR",
      "NEUTRON DIFFRACTION": "Neutron",
      "FIBER DIFFRACTION": "Fiber diffraction",
      "SOLUTION SCATTERING": "Solution scattering",
      "THEORETICAL MODEL": "Model",
      "FLUORESCENCE TRANSFER": "FRET",
    }[m] || m.charAt(0) + m.slice(1).toLowerCase());
    return method.split(";").map((m) => one(m.trim())).join(" + ");
  }

  function methodGroup(method) {
    const first = (method || "").split(";")[0].trim();
    if (first === "X-RAY DIFFRACTION") return "X-ray";
    if (first === "ELECTRON MICROSCOPY") return "Cryo-EM";
    if (first.includes("NMR")) return "NMR";
    return "Other";
  }
  const METHOD_CLASS = { "X-ray": "method-xray", "Cryo-EM": "method-em", "NMR": "method-nmr", "Other": "method-other" };
  const methodBadge = (r) => (r.method
    ? `<span class="method ${METHOD_CLASS[r.method_group]}" title="${esc(r.method)}">${esc(r.method_label)}</span>`
    : na());

  function toast(message) {
    const t = $("toast");
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  function downloadBlob(text, name, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function copyText(text, what = "Copied to the clipboard") {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast(what), () => toast("Copy failed"));
    } else {
      toast("Copy is not available in this browser");
    }
  }

  // ---- Theme -----------------------------------------------------------------

  function currentTheme() {
    const set = document.documentElement.getAttribute("data-theme");
    if (set) return set;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  $("theme-toggle").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    store.set("rubric-theme", next);
  });

  // ---- Data loading ------------------------------------------------------------

  const NUMERIC = ["resolution", "rna_chains", "rna_nucleotides", "n_pairs", "n_rna_pairs",
    "n_scored_pairs", "n_ambiguous_pairs", "pairs_score", "n_preferred", "n_secondary_review",
    "n_priority_review", "backbone_suiteness", "n_unassigned_suites", "n_pucker_outliers"];

  const parseCsv = (text) => Papa.parse(text, { header: true, skipEmptyLines: true }).data;

  async function loadData() {
    const [summaryText, updatesText] = await Promise.all([
      fetch("data/summary.csv", { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error("summary.csv " + r.status);
        return r.text();
      }),
      fetch("data/updates.csv", { cache: "no-cache" }).then((r) => (r.ok ? r.text() : "")),
    ]);
    const rows = parseCsv(summaryText).map((r) => {
      for (const k of NUMERIC) r[k] = r[k] === "" || r[k] == null ? null : Number(r[k]);
      r.year = r.release_date ? Number(r.release_date.slice(0, 4)) : null;
      r.method_group = methodGroup(r.method);
      r.method_label = methodLabel(r.method);
      r._search = (r.pdb_id + " " + (r.title || "")).toLowerCase();
      return r;
    });
    state.rows = rows;
    state.byId = new Map(rows.map((r) => [r.pdb_id, r]));
    const updates = updatesText ? parseCsv(updatesText) : [];
    state.lastUpdate = updates.length ? updates[updates.length - 1] : null;
  }

  function renderStats() {
    const last = state.lastUpdate;
    $("stat-entries").textContent = fmtInt(state.rows.length);
    $("stat-updated").textContent = last ? last.date : "n/a";
    $("stat-version").textContent = last ? last.rubric_version : "n/a";
  }

  // ---- Table of all entries ----------------------------------------------------

  const ALL_COLUMNS = [
    { key: "pdb_id", label: "PDB ID", fixed: true },
    { key: "title", label: "Title", def: true },
    { key: "method_label", label: "Method", def: true },
    { key: "resolution", label: "Res. (Å)", num: true, def: true, title: "Resolution in Å" },
    { key: "release_date", label: "Released", def: true },
    { key: "revision_date", label: "Revised" },
    { key: "rna_chains", label: "RNA chains", num: true },
    { key: "rna_nucleotides", label: "RNA nt", num: true, def: true, title: "RNA nucleotides" },
    { key: "n_pairs", label: "All pairs", num: true, title: "All base pairs found, including pairs involving DNA" },
    { key: "n_rna_pairs", label: "Base pairs", num: true, def: true, title: "Base pairs between two RNA chains" },
    { key: "n_scored_pairs", label: "Scored", num: true, title: "Pairs that received a score" },
    { key: "n_ambiguous_pairs", label: "Ambiguous", num: true, title: "Pairs between two Leontis-Westhof classes" },
    { key: "pairs_score", label: "Pair score", num: true, def: true },
    { key: "n_preferred", label: "Preferred", num: true, title: "Pairs scoring 100" },
    { key: "n_priority_review", label: "Priority", num: true, def: true, title: "Priority-review pairs, scoring below 80" },
    { key: "n_secondary_review", label: "Secondary", num: true, def: true, title: "Secondary-review pairs, scoring 80 or more, below 100" },
    { key: "backbone_suiteness", label: "Suiteness", num: true, def: true },
    { key: "n_unassigned_suites", label: "Unassigned", num: true, def: true, title: "Backbone suites that fit none of the conformers" },
    { key: "n_pucker_outliers", label: "Pucker", num: true, def: true, title: "Pucker outliers: riboses whose pucker from δ and from P-perp disagree" },
  ];
  const DEFAULT_COLS = ALL_COLUMNS.filter((c) => c.fixed || c.def).map((c) => c.key);
  let visibleCols = (() => {
    const saved = (store.get("rubric-columns") || "").split(",").filter((k) => ALL_COLUMNS.some((c) => c.key === k));
    return saved.length ? ["pdb_id", ...saved.filter((k) => k !== "pdb_id")] : DEFAULT_COLS.slice();
  })();
  const columns = () => ALL_COLUMNS.filter((c) => visibleCols.includes(c.key));

  function renderColumnMenu() {
    $("col-menu").innerHTML = ALL_COLUMNS.filter((c) => !c.fixed).map((c) => `
      <label><input type="checkbox" data-col="${c.key}" ${visibleCols.includes(c.key) ? "checked" : ""}>${esc(c.label)}${c.title ? ` <span class="muted small">${esc(c.title.split(",")[0])}</span>` : ""}</label>`).join("")
      + `<div class="col-reset"><button type="button" class="link-btn" data-col-reset>Default columns</button></div>`;
  }

  function renderHead() {
    $("entries-head").innerHTML = columns().map((c) => {
      const active = state.sortKey === c.key;
      const arrow = active ? (state.sortDir === 1 ? "▲" : "▼") : "";
      return `<th class="sortable${c.num ? " num" : ""}" data-key="${c.key}" scope="col"
        aria-sort="${active ? (state.sortDir === 1 ? "ascending" : "descending") : "none"}"
        ${c.title ? `title="${esc(c.title)}"` : ""}>${esc(c.label)}<span class="arrow">${arrow}</span></th>`;
    }).join("");
  }

  function cell(c, r) {
    const v = r[c.key];
    switch (c.key) {
      case "pdb_id":
        return `<td class="id">${esc(v)}</td>`;
      case "title":
        return `<td class="title"><span class="clamp" title="${esc(v)}">${esc(v) || na("untitled")}</span></td>`;
      case "method_label":
        return `<td>${methodBadge(r)}</td>`;
      case "resolution":
        return `<td class="num">${v == null ? na() : v.toFixed(2)}</td>`;
      case "pairs_score":
        return v == null ? `<td class="num" title="No scored pairs">${na("none")}</td>` : `<td class="num">${v.toFixed(2)}</td>`;
      case "n_priority_review":
        return `<td class="num"><span class="count-pill ${v ? "priority" : "zero"}">${fmtInt(v)}</span></td>`;
      case "n_secondary_review":
        return `<td class="num"><span class="count-pill ${v ? "secondary" : "zero"}">${fmtInt(v)}</span></td>`;
      case "backbone_suiteness":
        return `<td class="num">${v == null ? na() : v.toFixed(2)}</td>`;
      default:
        return `<td class="${c.num ? "num" : ""}">${v == null || v === "" ? na() : (c.num ? fmtInt(v) : esc(v))}</td>`;
    }
  }

  // Filters: the form fields, the query string (shareable links) and the chips.
  const FILTERS = [
    { id: "f-text", param: "q", chip: (v) => `Text: ${v}` },
    { id: "f-method", param: "method", chip: (v) => v },
    { id: "f-res", param: "res", chip: (v) => `≤ ${v} Å` },
    { id: "f-year-min", param: "from", chip: (v) => `Released from ${v}` },
    { id: "f-year-max", param: "to", chip: (v) => `Released up to ${v}` },
    { id: "f-score-min", param: "smin", chip: (v) => `Pair score ≥ ${v}` },
    { id: "f-score-max", param: "smax", chip: (v) => `Pair score ≤ ${v}` },
    { id: "f-priority", param: "priority", check: true, chip: () => "Has priority-review pairs" },
    { id: "f-rna", param: "rna", check: true, chip: () => "Has RNA-RNA pairs" },
  ];
  const fieldValue = (f) => (f.check ? ($(f.id).checked ? "1" : "") : $(f.id).value.trim());

  function filtersFromUrl() {
    const p = new URLSearchParams(location.search);
    for (const f of FILTERS) {
      const v = p.get(f.param);
      if (v == null) continue;
      if (f.check) $(f.id).checked = v === "1";
      else $(f.id).value = v;
    }
    if (p.get("sort") && ALL_COLUMNS.some((c) => c.key === p.get("sort"))) {
      state.sortKey = p.get("sort");
      state.sortDir = p.get("dir") === "asc" ? 1 : -1;
    }
  }

  function filtersToUrl() {
    const p = new URLSearchParams();
    for (const f of FILTERS) {
      const v = fieldValue(f);
      if (v) p.set(f.param, v);
    }
    if (!(state.sortKey === "release_date" && state.sortDir === -1)) {
      p.set("sort", state.sortKey);
      p.set("dir", state.sortDir === 1 ? "asc" : "desc");
    }
    const qs = p.toString();
    history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }

  function renderChips() {
    const active = FILTERS.map((f) => ({ f, v: fieldValue(f) })).filter((x) => x.v);
    $("active-chips").innerHTML = active.map(({ f, v }) =>
      `<span class="fchip">${esc(f.chip(v))}<button type="button" data-clear="${f.id}" aria-label="Remove this filter">×</button></span>`).join("")
      + (active.length > 1 ? `<button type="button" class="fchip clear" data-clear-all>Clear all</button>` : "");
  }

  function numberInput(id) {
    const v = $(id).value.trim();
    return v === "" ? null : Number(v);
  }

  function applyFilters(keepPage) {
    const text = $("f-text").value.trim().toLowerCase();
    const terms = text ? text.split(/\s+/) : [];
    const method = $("f-method").value;
    const resMax = numberInput("f-res");
    const yMin = numberInput("f-year-min");
    const yMax = numberInput("f-year-max");
    const sMin = numberInput("f-score-min");
    const sMax = numberInput("f-score-max");
    const needPriority = $("f-priority").checked;
    const needRna = $("f-rna").checked;
    const scoreFilter = sMin != null || sMax != null;

    state.filtered = state.rows.filter((r) => {
      if (terms.length && !terms.every((t) => r._search.includes(t))) return false;
      if (method && r.method_group !== method) return false;
      if (resMax != null && (r.resolution == null || r.resolution > resMax)) return false;
      if (yMin != null && (r.year == null || r.year < yMin)) return false;
      if (yMax != null && (r.year == null || r.year > yMax)) return false;
      if (scoreFilter) {
        if (r.pairs_score == null) return false;
        if (sMin != null && r.pairs_score < sMin) return false;
        if (sMax != null && r.pairs_score > sMax) return false;
      }
      if (needPriority && !(r.n_priority_review > 0)) return false;
      if (needRna && !(r.n_rna_pairs > 0)) return false;
      return true;
    });
    sortRows();
    if (!keepPage) state.page = 1;
    renderChips();
    filtersToUrl();
    renderTable();
  }

  function sortRows() {
    const k = state.sortKey;
    const dir = state.sortDir;
    state.filtered.sort((a, b) => {
      const x = a[k];
      const y = b[k];
      const xm = x == null || x === "";
      const ym = y == null || y === "";
      if (xm || ym) return xm && ym ? 0 : xm ? 1 : -1;  // empty values last either way
      if (typeof x === "number") return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }

  function renderTable() {
    renderHead();
    const cols = columns();
    const total = state.filtered.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * state.pageSize;
    const slice = state.filtered.slice(start, start + state.pageSize);
    $("entries-body").innerHTML = slice.length
      ? slice.map((r) => `<tr data-id="${esc(r.pdb_id)}" tabindex="0">${cols.map((c) => cell(c, r)).join("")}</tr>`).join("")
      : `<tr><td class="empty" colspan="${cols.length}">No entries match these filters.</td></tr>`;
    const all = state.rows.length;
    $("result-count").textContent = total === all ? `${fmtInt(all)} entries` : `${fmtInt(total)} of ${fmtInt(all)} entries`;
    renderPager(pages);
  }

  function renderPager(pages) {
    const p = state.page;
    const btn = (n, label = n, extra = "") =>
      `<button type="button" data-page="${n}" ${n === p ? 'aria-current="page"' : ""} ${extra}>${label}</button>`;
    let html = btn(p - 1, "Previous", p === 1 ? "disabled" : "");
    const shown = new Set([1, pages, p - 1, p, p + 1].filter((n) => n >= 1 && n <= pages));
    let last = 0;
    for (const n of [...shown].sort((a, b) => a - b)) {
      if (n - last > 1) html += `<span class="gap">…</span>`;
      html += btn(n);
      last = n;
    }
    html += btn(p + 1, "Next", p === pages ? "disabled" : "");
    $("pager").innerHTML = pages > 1 ? html : "";
  }

  function bindTable() {
    $("entries-head").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-key]");
      if (!th) return;
      const key = th.dataset.key;
      if (state.sortKey === key) state.sortDir *= -1;
      else {
        state.sortKey = key;
        const col = ALL_COLUMNS.find((c) => c.key === key);
        state.sortDir = col.num || key.endsWith("_date") ? -1 : 1;  // numbers and dates: largest first
      }
      applyFilters();
    });
    $("entries-body").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr) openEntry(tr.dataset.id);
    });
    $("entries-body").addEventListener("keydown", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (tr && e.key === "Enter") openEntry(tr.dataset.id);
    });
    $("pager").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-page]");
      if (!b || b.disabled) return;
      state.page = Number(b.dataset.page);
      renderTable();
      $("browse").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("page-size").addEventListener("change", (e) => {
      state.pageSize = Number(e.target.value);
      state.page = 1;
      renderTable();
    });

    let timer = null;
    const debounced = () => { clearTimeout(timer); timer = setTimeout(() => applyFilters(), 140); };
    $("filters").addEventListener("input", debounced);
    $("filters").addEventListener("change", debounced);
    $("f-reset").addEventListener("click", () => { $("filters").reset(); applyFilters(); });
    $("active-chips").addEventListener("click", (e) => {
      const one = e.target.closest("[data-clear]");
      if (one) {
        const f = FILTERS.find((x) => x.id === one.dataset.clear);
        if (f.check) $(f.id).checked = false; else $(f.id).value = "";
        applyFilters();
      } else if (e.target.closest("[data-clear-all]")) {
        $("filters").reset();
        applyFilters();
      }
    });

    $("col-menu").addEventListener("change", (e) => {
      const box = e.target.closest("[data-col]");
      if (!box) return;
      const key = box.dataset.col;
      visibleCols = box.checked
        ? ALL_COLUMNS.map((c) => c.key).filter((k) => k === key || visibleCols.includes(k))
        : visibleCols.filter((k) => k !== key);
      store.set("rubric-columns", visibleCols.join(","));
      renderTable();
    });
    $("col-menu").addEventListener("click", (e) => {
      if (!e.target.closest("[data-col-reset]")) return;
      visibleCols = DEFAULT_COLS.slice();
      store.set("rubric-columns", "");
      renderColumnMenu();
      renderTable();
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#col-picker")) $("col-picker").open = false;
    });

    $("download-filtered").addEventListener("click", () => {
      const cols = Object.keys(state.rows[0] || {}).filter((k) => !k.startsWith("_") &&
        !["year", "method_group", "method_label"].includes(k));
      const rows = state.filtered.map((r) => Object.fromEntries(cols.map((k) => [k,
        k === "backbone_suiteness" && r[k] != null ? r[k].toFixed(2) : r[k]])));
      downloadBlob(Papa.unparse(rows, { columns: cols }), `rubric_pdb_filtered_${state.filtered.length}.csv`, "text/csv");
    });
  }

  // ---- Search box ----------------------------------------------------------------

  function bindSearch() {
    const input = $("search-input");
    const list = $("search-suggest");
    let items = [];
    let active = -1;

    const close = () => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      active = -1;
    };
    const highlight = () => {
      [...list.children].forEach((li, i) => li.setAttribute("aria-selected", i === active ? "true" : "false"));
    };
    const suggest = () => {
      const q = input.value.trim();
      if (!q || !state.rows.length) { close(); return; }
      const ql = q.toLowerCase();
      const id = q.toUpperCase();
      const exact = state.byId.get(id);
      const prefix = state.rows.filter((r) => r.pdb_id.startsWith(id) && r !== exact).slice(0, 5);
      const inTitle = q.length >= 3
        ? state.rows.filter((r) => (r.title || "").toLowerCase().includes(ql)).slice(0, 8 - prefix.length)
        : [];
      items = [exact, ...prefix, ...inTitle].filter(Boolean);
      items = items.filter((r, i) => items.indexOf(r) === i).slice(0, 8);
      if (!items.length) {
        list.innerHTML = /^[0-9][A-Za-z0-9]{3}$/.test(q)
          ? `<li class="s-note">${esc(id)} is not in the table. It may contain no RNA, or it was released after the last update.</li>`
          : `<li class="s-note">No match. Try a PDB ID or another word from a title.</li>`;
      } else {
        const n = q.length >= 3 ? state.rows.filter((r) => r._search.includes(ql)).length : 0;
        list.innerHTML = items.map((r, i) =>
          `<li role="option" data-id="${esc(r.pdb_id)}" aria-selected="${i === 0}"><span class="s-id">${esc(r.pdb_id)}</span><span class="s-title">${esc(r.title)}</span></li>`).join("")
          + (n > items.length ? `<li class="s-note" data-all="1">Show all ${fmtInt(n)} matching entries in the table</li>` : "");
      }
      active = items.length ? 0 : -1;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };
    const showAll = () => {
      close();
      $("f-text").value = input.value.trim();
      applyFilters();
      $("browse").scrollIntoView({ behavior: "smooth", block: "start" });
    };

    input.addEventListener("input", suggest);
    input.addEventListener("focus", suggest);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && items.length) { active = (active + 1) % items.length; highlight(); e.preventDefault(); }
      else if (e.key === "ArrowUp" && items.length) { active = (active - 1 + items.length) % items.length; highlight(); e.preventDefault(); }
      else if (e.key === "Escape") close();
      else if (e.key === "Enter") {
        const q = input.value.trim().toUpperCase();
        if (state.byId.has(q)) { close(); openEntry(q); }
        else if (active >= 0 && items[active]) { close(); openEntry(items[active].pdb_id); }
        else if (q) showAll();
      }
    });
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      e.preventDefault();
      if (li.dataset.id) { close(); openEntry(li.dataset.id); }
      else if (li.dataset.all) showAll();
    });
    document.addEventListener("click", (e) => { if (!e.target.closest(".search")) close(); });
  }

  // ---- Entry view ------------------------------------------------------------------

  function openEntry(id) {
    location.hash = encodeURIComponent(id.toUpperCase());
  }

  async function fetchReport(id) {
    const r = await fetch(REPORT_URL + encodeURIComponent(id) + ".json.gz");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let text;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot decompress the report");
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      text = await new Response(stream).text();
    } else {
      text = new TextDecoder().decode(bytes);
    }
    return { text, report: JSON.parse(text) };
  }

  function splitRes(resId) {
    // RUBRIC residue IDs look like "A-G-12", "A-PSU-5" or "A-G--3" (negative number).
    const s = String(resId || "");
    const i = s.indexOf("-");
    const rest = s.slice(i + 1);
    const j = rest.indexOf("-");
    return { chain: s.slice(0, i), name: rest.slice(0, j), num: rest.slice(j + 1) };
  }
  const resHtml = (resId) => {
    const r = splitRes(resId);
    return `<span class="res"><span class="chain">${esc(r.chain)}:</span>${esc(r.name)}${esc(r.num)}</span>`;
  };

  const ISSUE_LABELS = { hbond_angles: "H-bond angles", incorrect_hbond_count: "H-bond count", clash: "Clash" };
  const issueLabel = (k) => ISSUE_LABELS[k] || (k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " "));
  const ANGLES = { alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", chi: "χ" };
  const angleLabel = (a) => {
    const prev = a.endsWith("_prev");
    const base = prev ? a.slice(0, -5) : a;
    return (ANGLES[base] || base) + (prev ? " (i-1)" : "");
  };
  const BB_TIERS = { fixable: "Fixable", review: "Review", flag_only: "Flag only" };
  const BB_ORDER = { fixable: 0, review: 1, flag_only: 2 };
  const TIER_ORDER = { "Priority review": 0, "Secondary review": 1, "Preferred": 2 };

  function tierPill(tier, ambiguous) {
    if (tier === "Priority review") return `<span class="tier tier-priority">Priority review</span>`;
    if (tier === "Secondary review") return `<span class="tier tier-secondary">Secondary review</span>`;
    if (tier === "Preferred") return `<span class="tier tier-preferred">Preferred</span>`;
    return `<span class="tier tier-none">${ambiguous ? "Ambiguous" : "Not scored"}</span>`;
  }

  function pairRows(pairs, offset) {
    return pairs.map((p, i) => {
      const cls = p.classification || {};
      const issues = (p.issue_details || []).map((d) =>
        `<span class="issue${d.tier === "Of Concern" ? " concern" : ""}" title="${esc(d.tier || "")}${d.severity != null ? " · severity " + d.severity : ""}">${esc(issueLabel(d.issue))}</span>`).join("");
      return `<tr>
        <td>${tierPill(p.tier, cls.is_ambiguous)}</td>
        <td>${resHtml(p.res_id1)}</td>
        <td>${resHtml(p.res_id2)}</td>
        <td class="mono">${esc(cls.lw_class || "")}</td>
        <td>${esc(p.bp_type || "")}</td>
        <td class="num">${p.score == null ? na() : Number(p.score).toFixed(1)}</td>
        <td class="num">${p.num_hbonds ?? ""}</td>
        <td><div class="issues">${issues || na("none")}</div></td>
      </tr>`;
    }).join("");
  }

  function backboneRows(list) {
    return list.map((b, i) => `<tr>
        <td>${resHtml(b.res_id)}</td>
        <td><span class="tier tier-none">${esc(BB_TIERS[b.tier] || b.tier || "")}</span></td>
        <td class="num">${b.suiteness == null ? na() : Number(b.suiteness).toFixed(2)}</td>
        <td class="mono">${esc(b.target_conformer || "")}</td>
        <td>${(b.deviations || []).map((d) =>
          `<span class="dev">${esc(angleLabel(d.angle))} ${Number(d.value).toFixed(1)}°<span class="arrow">→</span>${Number(d.target).toFixed(1)}°</span>`).join("")}</td>
      </tr>`).join("");
  }

  function puckerRows(list, unclassified) {
    return list.map((p, i) => `<tr>
        <td>${resHtml(p.res_id)}</td>
        <td class="num">${p.delta == null ? na() : Number(p.delta).toFixed(1) + "°"}</td>
        <td class="num">${p.pperp == null ? na() : Number(p.pperp).toFixed(2) + " Å"}</td>
        ${unclassified ? "" : `<td>${esc(p.pucker_by_delta || "")}</td>`}
        <td>${esc(p.pucker_by_pperp || "")}</td>
      </tr>`).join("");
  }

  function table(head, rows, colspan, emptyText) {
    return `<div class="inner-table"><table class="data"><thead><tr>${head}</tr></thead><tbody>${
      rows || `<tr><td class="empty" colspan="${colspan}">${emptyText}</td></tr>`}</tbody></table></div>`;
  }

  const BACK = `<a class="back" href="#"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>All entries</a>`;

  function entrySkeleton(id) {
    return `${BACK}
      <div class="entry-head"><div class="entry-head-main">
        <div class="thumb skeleton"></div>
        <div style="flex:1"><div class="entry-id">${esc(id)}</div>
        <div class="skeleton" style="height:20px;width:70%;margin:10px 0"></div>
        <div class="skeleton" style="height:14px;width:45%"></div></div>
      </div></div>
      <div class="tiles">${'<div class="tile"><div class="skeleton" style="height:46px"></div></div>'.repeat(6)}</div>
      <div class="panel"><div class="tab-body"><span class="spinner"></span> Loading the RUBRIC report</div></div>`;
  }

  async function showEntry(id) {
    const host = $("entry");
    const row = state.byId.get(id);
    document.title = `${id} · RUBRIC-PDB-live`;
    if (!row) {
      host.innerHTML = `${BACK}
        <div class="notice"><h2>${esc(id)} is not in RUBRIC-PDB-live</h2>
        <p>The entry may contain no RNA, or it was released after the last weekly update. It could also have failed to score; those entries are listed in <a href="data/failures.csv">failures.csv</a>.</p>
        <p><a href="${RCSB_URL}${encodeURIComponent(id)}" target="_blank" rel="noopener">Open ${esc(id)} at RCSB</a></p></div>`;
      return;
    }
    host.innerHTML = entrySkeleton(id);
    window.scrollTo({ top: 0 });

    let data;
    try {
      data = await fetchReport(id);
    } catch (err) {
      if (location.hash.slice(1) !== encodeURIComponent(id)) return;
      host.innerHTML = renderEntryHead(row) + renderTiles(row, null) + renderContext(row) +
        `<div class="notice"><h2>The full report could not be loaded</h2>
        <p>${esc(err.message)}. Check the connection and reload the page, or download the report directly:</p>
        <p><a href="${REPORT_URL}${encodeURIComponent(id)}.json.gz">${esc(id)}.json.gz</a></p></div>`;
      return;
    }
    if (location.hash.slice(1) !== encodeURIComponent(id)) return;  // user moved on
    renderEntry(host, row, data);
  }

  function renderEntryHead(r) {
    const rcsb = RCSB_URL + encodeURIComponent(r.pdb_id);
    return `${BACK}
      <div class="entry-head">
        <div class="entry-head-main">
          <img class="thumb" src="${RCSB_IMAGE(r.pdb_id)}" alt="Structure of ${esc(r.pdb_id)} (image from RCSB PDB)" loading="lazy"
               onerror="if(!this.dataset.f){this.dataset.f=1;this.src='${RCSB_IMAGE_MODEL(r.pdb_id)}'}else{this.style.display='none'}">
          <div style="flex:1;min-width:0">
            <div class="entry-id">${esc(r.pdb_id)}</div>
            <div class="entry-title">${esc(r.title) || na("untitled")}</div>
            <div class="meta">
              <span>${methodBadge(r)}</span>
              <span><b>Resolution</b>${r.resolution == null ? na() : r.resolution.toFixed(2) + " Å"}</span>
              <span><b>Released</b>${esc(r.release_date)}</span>
              <span><b>Revised</b>${esc(r.revision_date)}</span>
              <span><b>RNA</b>${fmtInt(r.rna_chains)} chain${r.rna_chains === 1 ? "" : "s"}, ${fmtInt(r.rna_nucleotides)} nt</span>
            </div>
          </div>
        </div>
        <div class="entry-links">
          <a class="btn" href="${rcsb}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M18 14v5H5V6h5"/></svg>View at RCSB</a>
          <button type="button" class="btn" data-copy-link>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>Copy link to this entry</button>
        </div>
      </div>`;
  }

  function renderTiles(r, rep) {
    const unassigned = r.n_unassigned_suites != null ? r.n_unassigned_suites
      : rep ? (rep.backbone_residues || []).filter((b) => b.suiteness === 0).length : null;
    const suiteNote = unassigned == null ? "backbone, 0 to 1"
      : `${fmtInt(unassigned)} suite${unassigned === 1 ? "" : "s"} unassigned`;
    const scored = r.n_scored_pairs || 0;
    const pct = (n) => (scored ? (100 * (n || 0) / scored) : 0);
    const bar = scored ? `<div class="tierbar" title="Priority, secondary and preferred pairs">
        <i class="p" style="width:${pct(r.n_priority_review)}%"></i><i class="s" style="width:${pct(r.n_secondary_review)}%"></i><i class="f" style="width:${pct(r.n_preferred)}%"></i></div>` : "";
    return `<div class="tiles">
      <div class="tile"><div class="k">Pair score</div><div class="v">${r.pairs_score == null ? "n/a" : r.pairs_score.toFixed(2)}</div><div class="s">${r.pairs_score == null ? "no scored pairs" : "out of 100"}</div></div>
      <div class="tile"><div class="k">Pairs scored</div><div class="v">${fmtInt(scored)}</div>${bar}<div class="s">of ${fmtInt(r.n_pairs)} found, ${fmtInt(r.n_rna_pairs)} RNA-RNA</div></div>
      <div class="tile priority"><div class="k">Priority review</div><div class="v">${fmtInt(r.n_priority_review)}</div><div class="s">score below 80</div></div>
      <div class="tile secondary"><div class="k">Secondary review</div><div class="v">${fmtInt(r.n_secondary_review)}</div><div class="s">score 80 to below 100</div></div>
      <div class="tile"><div class="k">Suiteness</div><div class="v">${r.backbone_suiteness == null ? "n/a" : r.backbone_suiteness.toFixed(2)}</div><div class="s" title="Suites that fit none of the 54 conformers">${suiteNote}</div></div>
      <div class="tile"><div class="k">Pucker outliers</div><div class="v">${fmtInt(r.n_pucker_outliers)}</div><div class="s">riboses flagged</div></div>
    </div>`;
  }

  // ---- "Where this entry sits": percentile among comparable entries ----------------

  function peerGroup(r) {
    const g = r.method_group;
    if ((g === "X-ray" || g === "Cryo-EM") && r.resolution != null) {
      const bins = [[0, 2, "better than 2 Å"], [2, 3, "at 2 to 3 Å"], [3, 4, "at 3 to 4 Å"], [4, Infinity, "at 4 Å or worse"]];
      const [lo, hi, text] = bins.find(([a, b]) => r.resolution >= a && r.resolution < b);
      const peers = state.rows.filter((x) => x.method_group === g && x.resolution != null && x.resolution >= lo && x.resolution < hi);
      if (peers.length >= 20) return { peers, label: `${g} entries ${text}` };
    }
    return { peers: state.rows.filter((x) => x.method_group === g), label: `${g} entries` };
  }

  function percentile(value, values) {
    let lower = 0, equal = 0;
    for (const v of values) { if (v < value) lower++; else if (v === value) equal++; }
    return 100 * (lower + 0.5 * equal) / values.length;
  }

  function contextCard(title, value, digits, peers, key, label) {
    if (value == null) {
      return `<div class="ctx"><div class="k">${title}</div><div class="line">${na("No value for this entry")}</div></div>`;
    }
    const values = peers.map((x) => x[key]).filter((v) => v != null);
    if (values.length < 5) {
      return `<div class="ctx"><div class="k">${title}</div><div class="line">${na("Too few comparable entries")}</div></div>`;
    }
    const p = percentile(value, values);
    return `<div class="ctx"><div class="k">${title}</div>
      <div class="line"><b>${value.toFixed(digits)}</b> is higher than <b>${Math.round(p)}%</b> of ${esc(label)} (n = ${fmtInt(values.length)})</div>
      <div class="ctx-bar" role="img" aria-label="Percentile ${Math.round(p)}"><i style="left:${Math.max(1, Math.min(99, p))}%"></i></div>
      <div class="ctx-scale"><span>lowest</span><span>median</span><span>highest</span></div></div>`;
  }

  function renderContext(r) {
    const { peers, label } = peerGroup(r);
    return `<div class="context">
      ${contextCard("Pair score in context", r.pairs_score, 2, peers, "pairs_score", label)}
      ${contextCard("Suiteness in context", r.backbone_suiteness, 2, peers, "backbone_suiteness", label)}
    </div>`;
  }

  function renderEntry(host, row, data) {
    const rep = data.report;
    const id = row.pdb_id;
    const pairs = (rep.pairs || []).slice().sort((a, b) => {
      const ta = TIER_ORDER[a.tier] ?? 3;
      const tb = TIER_ORDER[b.tier] ?? 3;
      if (ta !== tb) return ta - tb;
      return (a.score ?? 101) - (b.score ?? 101);
    });
    const flagged = pairs.filter((p) => p.tier === "Priority review" || p.tier === "Secondary review");
    const backbone = (rep.backbone_residues || []).slice().sort((a, b) =>
      (BB_ORDER[a.tier] ?? 3) - (BB_ORDER[b.tier] ?? 3) || (a.suiteness ?? 1) - (b.suiteness ?? 1));
    const outliers = rep.pucker_outliers || [];
    const unclassified = rep.pucker_unclassified || [];

    const view = { tab: "pairs", pairMode: flagged.length ? "flagged" : "all", limit: ROW_LIMIT };

    host.innerHTML = renderEntryHead(row) + renderTiles(row, rep) + renderContext(row) + `
      <div class="panel">
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" data-tab="pairs">Base pairs<span class="n">${fmtInt(flagged.length)} flagged</span></button>
          <button class="tab" role="tab" data-tab="backbone">Backbone suites<span class="n">${fmtInt(backbone.length)}</span></button>
          <button class="tab" role="tab" data-tab="riboses">Riboses<span class="n">${fmtInt(outliers.length + unclassified.length)}</span></button>
        </div>
        <div class="tab-body" id="tab-body"></div>
      </div>
      <div class="downloads">
        <div class="panel">
          <h3>Download the full report</h3>
          <p class="muted small">Every pair with its class, score and issues, every flagged suite and every ribose result, as JSON.</p>
          <div class="dl-row">
            <button type="button" class="btn btn-primary" data-dl="json">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/></svg>${esc(id)}.json</button>
            <a class="btn" href="${REPORT_URL}${encodeURIComponent(id)}.json.gz" download>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/></svg>${esc(id)}.json.gz</a>
          </div>
        </div>
        <div class="panel">
          <h3>Reproduce or view in PyMOL</h3>
          <p class="muted small">Install RUBRIC, then write the same report and a PyMOL script that colours the flagged pairs.</p>
          <div class="cmd"><span>pip install rubric-rna</span><button type="button" data-copy="pip install rubric-rna">Copy</button></div>
          <div class="cmd"><span>rubric ${esc(id)} --out --pml</span><button type="button" data-copy="rubric ${esc(id)} --out --pml">Copy</button></div>
        </div>
      </div>`;

    const body = host.querySelector("#tab-body");
    let shown = { pair: [], suite: [], pucker: outliers, unclassified };
    const draw = () => {
      host.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.tab === view.tab ? "true" : "false"));
      if (view.tab === "pairs") {
        const list = view.pairMode === "flagged" ? flagged : pairs;
        shown.pair = list.slice(0, view.limit);
        body.innerHTML = `<div class="tab-tools">
            <p class="tab-note">Pairs are sorted by tier, then by score. Issues in red are of concern; hover an issue for its severity.</p>
            <div class="seg" role="group" aria-label="Pairs to show">
              <button type="button" data-mode="flagged" aria-pressed="${view.pairMode === "flagged"}">Flagged (${fmtInt(flagged.length)})</button>
              <button type="button" data-mode="all" aria-pressed="${view.pairMode === "all"}">All pairs (${fmtInt(pairs.length)})</button>
            </div>
          </div>` +
          table(`<th>Tier</th><th>Residue 1</th><th>Residue 2</th><th>Class</th><th>Bases</th><th class="num">Score</th><th class="num">H-bonds</th><th>Issues</th>`,
            pairRows(shown.pair, 0), 8, view.pairMode === "flagged" ? "No flagged pairs in this entry." : "No base pairs in this entry.") +
          (list.length > shown.pair.length ? `<div class="more"><button type="button" class="btn" data-more>Show all ${fmtInt(list.length)} rows</button></div>` : "");
      } else if (view.tab === "backbone") {
        shown.suite = backbone.slice(0, view.limit);
        body.innerHTML = `<div class="tab-tools"><p class="tab-note">Suites that fit their conformer poorly or match none, with RUBRIC's suggested target torsions. Fixable suites come first.</p></div>` +
          table(`<th>Residue</th><th>Recommendation</th><th class="num">Suiteness</th><th>Target conformer</th><th>Torsions (current → target)</th>`,
            backboneRows(shown.suite), 5, "No backbone suites flagged in this entry.") +
          (backbone.length > shown.suite.length ? `<div class="more"><button type="button" class="btn" data-more>Show all ${fmtInt(backbone.length)} rows</button></div>` : "");
      } else {
        body.innerHTML = `<h3 style="margin-top:0">Pucker outliers <span class="muted">(${fmtInt(outliers.length)})</span></h3>
          <p class="tab-note" style="margin-bottom:10px">Riboses whose pucker from the δ torsion and from the P-perpendicular distance disagree.</p>` +
          table(`<th>Residue</th><th class="num">δ</th><th class="num">P-perp</th><th>Pucker from δ</th><th>Pucker from P-perp</th>`,
            puckerRows(outliers, false), 5, "No pucker outliers in this entry.") +
          `<h3>Unclassified puckers <span class="muted">(${fmtInt(unclassified.length)})</span></h3>
          <p class="tab-note" style="margin-bottom:10px">Riboses for which the δ torsion gives no pucker assignment; the pucker from the P-perpendicular distance is shown.</p>` +
          table(`<th>Residue</th><th class="num">δ</th><th class="num">P-perp</th><th>Pucker from P-perp</th>`,
            puckerRows(unclassified, true), 4, "No unclassified puckers in this entry.");
      }
    };

    host.onclick = (e) => {
      const tab = e.target.closest("[data-tab]");
      if (tab) { view.tab = tab.dataset.tab; view.limit = ROW_LIMIT; draw(); return; }
      const mode = e.target.closest("[data-mode]");
      if (mode) { view.pairMode = mode.dataset.mode; view.limit = ROW_LIMIT; draw(); return; }
      if (e.target.closest("[data-more]")) { view.limit = Infinity; draw(); return; }
      const copy = e.target.closest("[data-copy]");
      if (copy) { copyText(copy.dataset.copy); return; }
      if (e.target.closest("[data-copy-link]")) { copyText(location.href, "Link copied"); return; }
      if (e.target.closest('[data-dl="json"]')) downloadBlob(data.text, `${id}.json`, "application/json");
    };
    draw();
  }

  // ---- Citation ------------------------------------------------------------------------

  function renderCite() {
    const today = new Date().toISOString().slice(0, 10);
    const last = state.lastUpdate;
    const version = last ? `RUBRIC ${last.rubric_version}, data of ${last.date}` : "";
    const text = `Yesselman Lab. RUBRIC-PDB-live: RUBRIC results for every RNA-containing entry in the Protein Data Bank. ${SITE_URL} (accessed ${today}${version ? "; " + version : ""}).`;
    $("cite-ref").textContent = text;
    const bib = `@misc{rubric_pdb_live,
  author       = {{Yesselman Lab}},
  title        = {{RUBRIC-PDB-live}: {RUBRIC} results for every {RNA}-containing entry in the {Protein Data Bank}},
  howpublished = {\\url{${SITE_URL}}},
  note         = {Accessed ${today}${version ? "; " + version : ""}},
  year         = {${today.slice(0, 4)}}
}`;
    $("cite-copy").onclick = () => copyText(text, "Citation copied");
    $("cite-bibtex").onclick = () => copyText(bib, "BibTeX copied");
  }

  // ---- Routing -----------------------------------------------------------------------

  function route() {
    const id = decodeURIComponent(location.hash.slice(1)).trim().toUpperCase();
    const isEntry = /^[0-9A-Z]{4,12}$/.test(id) && id !== "ABOUT";
    $("view-home").hidden = isEntry;
    $("view-entry").hidden = !isEntry;
    if (isEntry) {
      showEntry(id);
    } else {
      document.title = "RUBRIC-PDB-live";
      if (id === "ABOUT") $("about").scrollIntoView({ behavior: "smooth" });
    }
  }

  const goHome = () => {
    history.pushState("", document.title, location.pathname + location.search);
    route();
  };

  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    if (open) { openEntry(open.dataset.open); return; }
    const home = e.target.closest('[data-route="home"]');
    if (home) {
      e.preventDefault();
      if (location.hash) goHome();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (e.target.closest("a.back")) { e.preventDefault(); goHome(); return; }
    const scroll = e.target.closest("[data-scroll]");
    if (scroll) {
      e.preventDefault();
      if (!$("view-entry").hidden) goHome();
      $(scroll.dataset.scroll).scrollIntoView({ behavior: "smooth" });
    }
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("popstate", route);

  // ---- Start ---------------------------------------------------------------------------

  bindTable();
  bindSearch();
  renderColumnMenu();
  filtersFromUrl();
  renderHead();
  loadData()
    .then(() => {
      renderStats();
      renderCite();
      applyFilters();
      route();
    })
    .catch((err) => {
      $("entries-body").innerHTML = `<tr><td class="empty" colspan="${columns().length}">The table could not be loaded (${esc(err.message)}). Please reload the page.</td></tr>`;
      $("result-count").textContent = "";
      route();
    });
})();
