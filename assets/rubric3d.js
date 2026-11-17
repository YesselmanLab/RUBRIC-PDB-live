/* Interactive 3D view of one entry in the style of the home-page picture: RNA as a
 * grey cartoon, priority-review pairs as red sticks, and optional layers for
 * secondary-review pairs (orange) and unassigned backbone suites (red). RNA chains can
 * be shown or hidden. Built with Mol* from a MolViewSpec description, so the look is
 * set in one place; the structure file is downloaded once per entry.
 */
(function (root) {
  "use strict";

  const GREY = "#8f96a3";
  const ORANGE = "#dd8452";
  const RED = "#c0393f";

  // RUBRIC residue IDs look like "A-G-12", "A-PSU-5" or "A-G--3".
  function parseRes(resId) {
    const s = String(resId);
    const i = s.indexOf("-");
    const rest = s.slice(i + 1);
    const j = rest.indexOf("-");
    const num = rest.slice(j + 1);
    const m = /^(-?\d+)([A-Za-z]?)$/.exec(num);
    if (!m) return null;
    const sel = { auth_asym_id: s.slice(0, i), auth_seq_id: Number(m[1]) };
    if (m[2]) sel.pdbx_PDB_ins_code = m[2];
    return sel;
  }
  const chainOf = (resId) => String(resId).slice(0, String(resId).indexOf("-"));

  const unique = (list) => {
    const seen = new Set();
    return list.filter((x) => {
      if (!x) return false;
      const k = JSON.stringify(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  // Flagged pairs keep both residues together, so a pair between two chains can be
  // dropped when either chain is hidden.
  function flagged(report) {
    const pri = [], sec = [];
    for (const p of report.pairs || []) {
      const target = p.tier === "Priority review" ? pri : p.tier === "Secondary review" ? sec : null;
      if (target) target.push([p.res_id1, p.res_id2]);
    }
    const bb = (report.backbone_residues || []).filter((b) => b.suiteness === 0).map((b) => b.res_id);
    return { pri, sec, bb };
  }

  const node = (kind, params, children) => {
    const n = { kind };
    if (params) n.params = params;
    if (children && children.length) n.children = children;
    return n;
  };

  function buildMvs(report, opts) {
    const f = flagged(report);
    const layers = opts.layers;
    const hidden = opts.hidden || new Set();
    const shown = (resId) => !hidden.has(chainOf(resId));
    const residues = (pairs) => unique(pairs.filter(([a, b]) => shown(a) && shown(b)).flat().map(parseRes));
    const pri = residues(f.pri);
    const sec = residues(f.sec);
    const bb = unique(f.bb.filter(shown).map(parseRes));

    const cartoonColors = [node("color", { color: GREY })];
    if (layers.backbone && bb.length) cartoonColors.push(node("color", { color: RED, selector: bb }));
    if (layers.secondary && sec.length) cartoonColors.push(node("color", { color: ORANGE, selector: sec }));
    if (layers.priority && pri.length) cartoonColors.push(node("color", { color: RED, selector: pri }));

    const visible = hidden.size ? (opts.chains || []).filter((c) => !hidden.has(c.id)).map((c) => ({ auth_asym_id: c.id })) : null;
    const structure = [];
    if (!visible || visible.length) {
      structure.push(node("component", { selector: visible || "nucleic" }, [
        node("representation", { type: "cartoon", size_factor: 1.4 }, cartoonColors)]));
    }
    if (layers.priority && pri.length) {
      structure.push(node("component", { selector: pri }, [
        node("representation", { type: "ball_and_stick" }, [node("color", { color: RED })])]));
    }
    const focus = unique((opts.focus || []).map(parseRes));
    if (focus.length) {
      structure.push(node("component", { selector: focus }, [
        node("representation", { type: "ball_and_stick" }, [node("color", { color: opts.focusColor || RED })]),
        node("focus", { radius_extent: 14 }),
      ]));
    }

    return {
      metadata: { version: "1", title: "RUBRIC", timestamp: new Date().toISOString() },
      root: node("root", null, [
        node("canvas", { background_color: opts.background || "#ffffff" }),
        node("download", { url: opts.url }, [
          node("parse", { format: "bcif" }, [node("structure", { type: "model" }, structure)]),
        ]),
      ]),
    };
  }

  // RNA and DNA chains of the loaded model: auth chain ID, entity name and length.
  function readChains(viewer) {
    const s = viewer.plugin.managers.structure.hierarchy.current.structures[0];
    const st = s && s.cell.obj && s.cell.obj.data;
    if (!st) return [];
    const m = st.model;
    const h = m.atomicHierarchy;
    const chains = h.chains;
    const offsets = h.chainAtomSegments.offsets;
    const resIndex = h.residueAtomSegments.index;
    const byId = new Map();
    for (let i = 0; i < chains._rowCount; i++) {
      const ei = m.entities.getEntityIndex(chains.label_entity_id.value(i));
      const subtype = String(m.entities.subtype.value(ei) || "");
      if (!/nucleotide/.test(subtype)) continue;
      const id = chains.auth_asym_id.value(i);
      const a0 = offsets[i], a1 = offsets[i + 1];
      const nt = a1 > a0 ? resIndex[a1 - 1] - resIndex[a0] + 1 : 0;
      const desc = m.entities.data.pdbx_description.value(ei);
      const name = Array.isArray(desc) ? desc.join(", ") : String(desc || "");
      const prev = byId.get(id);
      if (prev) prev.nt += nt;
      else byId.set(id, { id, name, nt, dna: subtype === "polydeoxyribonucleotide" });
    }
    return [...byId.values()];
  }

  async function create(element, id, report, opts = {}) {
    const response = await fetch(`https://models.rcsb.org/${encodeURIComponent(id)}.bcif`);
    if (!response.ok) throw new Error(`structure download failed (HTTP ${response.status})`);
    const url = URL.createObjectURL(await response.blob());

    const viewer = await molstar.Viewer.create(element, {
      layoutIsExpanded: false,
      layoutShowControls: false,
      layoutShowSequence: false,
      layoutShowLog: false,
      layoutShowLeftPanel: false,
      collapseLeftPanel: true,
      viewportShowExpand: true,
      viewportShowControls: false,
      viewportShowSettings: false,
      viewportShowSelectionMode: false,
      viewportShowAnimation: false,
      viewportShowTrajectoryControls: false,
      viewportShowScreenshotControls: false,
      viewportShowIllumination: false,
      viewportShowXR: "never",
      viewportShowToggleFullscreen: false,
      pdbProvider: "rcsb",
    });

    const state = { layers: { priority: true, secondary: false, backbone: false }, hidden: new Set(), chains: [] };
    const show = async (extra = {}, keepCamera = false) => {
      const mvs = buildMvs(report, { ...opts, ...state, url, ...extra });
      await viewer.loadMvsData(JSON.stringify(mvs), "mvsj", { replaceExisting: true, keepCamera });
    };

    await show();
    state.chains = readChains(viewer);
    const canvas = viewer.plugin.canvas3d;
    if (canvas) {
      canvas.setProps({
        camera: { helper: { axes: { name: "off", params: {} } } },
        renderer: { ambientIntensity: 0.6, exposure: 1.1 },
        postprocessing: { occlusion: { name: "off", params: {} }, outline: { name: "off", params: {} } },
      });
    }

    return {
      viewer,
      chains: () => state.chains.slice(),
      hiddenChains: () => new Set(state.hidden),
      focusResidues: (resIds, color) => {
        resIds.forEach((r) => state.hidden.delete(chainOf(r)));
        return show({ focus: resIds, focusColor: color });
      },
      reset: () => show(),
      setBackground: (color) => { opts.background = color; return show({}, true); },
      setLayers: (next) => { state.layers = { ...state.layers, ...next }; return show({}, true); },
      setHiddenChains: (ids) => { state.hidden = new Set(ids); return show({}, true); },
      dispose: () => { viewer.plugin.dispose(); URL.revokeObjectURL(url); },
    };
  }

  function counts(report) {
    const f = flagged(report);
    return { priority: f.pri.length, secondary: f.sec.length, backbone: new Set(f.bb).size };
  }

  root.Rubric3D = { create, buildMvs, parseRes, counts, colors: { GREY, ORANGE, RED } };
})(typeof window !== "undefined" ? window : globalThis);
