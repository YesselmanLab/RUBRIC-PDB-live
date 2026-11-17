/* Interactive 3D view of one entry in the style of the home-page picture: RNA as a
 * grey cartoon, flagged base pairs as sticks (orange: secondary review, red: priority
 * review) and unassigned backbone suites in red. Built with Mol* from a MolViewSpec
 * description, so the look is set in one place.
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

  function flagged(report) {
    const pri = [], sec = [];
    for (const p of report.pairs || []) {
      const target = p.tier === "Priority review" ? pri : p.tier === "Secondary review" ? sec : null;
      if (target) target.push(parseRes(p.res_id1), parseRes(p.res_id2));
    }
    const bb = (report.backbone_residues || []).filter((b) => b.suiteness === 0).map((b) => parseRes(b.res_id));
    return { pri: unique(pri), sec: unique(sec), bb: unique(bb) };
  }

  const node = (kind, params, children) => {
    const n = { kind };
    if (params) n.params = params;
    if (children && children.length) n.children = children;
    return n;
  };

  function buildMvs(id, report, opts) {
    const f = flagged(report);
    const layers = opts.layers || { priority: true, secondary: false, backbone: false };
    const cartoonColors = [node("color", { color: GREY })];
    if (layers.backbone && f.bb.length) cartoonColors.push(node("color", { color: RED, selector: f.bb }));
    if (layers.secondary && f.sec.length) cartoonColors.push(node("color", { color: ORANGE, selector: f.sec }));
    if (layers.priority && f.pri.length) cartoonColors.push(node("color", { color: RED, selector: f.pri }));

    const structure = [
      node("component", { selector: "nucleic" }, [node("representation", { type: "cartoon", size_factor: 1.4 }, cartoonColors)]),
    ];
    if (layers.priority && f.pri.length) {
      structure.push(node("component", { selector: f.pri }, [
        node("representation", { type: "ball_and_stick" }, [node("color", { color: RED })])]));
    }
    if (opts.focus && opts.focus.length) {
      structure.push(node("component", { selector: opts.focus }, [
        node("representation", { type: "ball_and_stick" }, [node("color", { color: opts.focusColor || RED })]),
        node("focus", { radius_extent: 14 }),
      ]));
    }

    return {
      metadata: { version: "1", title: `RUBRIC ${id}`, timestamp: new Date().toISOString() },
      root: node("root", null, [
        node("canvas", { background_color: opts.background || "#ffffff" }),
        node("download", { url: `https://models.rcsb.org/${encodeURIComponent(id)}.bcif` }, [
          node("parse", { format: "bcif" }, [node("structure", { type: "model" }, structure)]),
        ]),
      ]),
    };
  }

  async function create(element, id, report, opts = {}) {
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
    let layers = { priority: true, secondary: false, backbone: false };
    const show = async (extra = {}) => {
      const mvs = buildMvs(id, report, { ...opts, layers, ...extra });
      await viewer.loadMvsData(JSON.stringify(mvs), "mvsj", { replaceExisting: true });
    };
    await show();
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
      focusResidues: (resIds, color) => show({ focus: unique(resIds.map(parseRes)), focusColor: color }),
      reset: () => show(),
      setBackground: (color) => { opts.background = color; return show(); },
      setLayers: (next) => { layers = { ...layers, ...next }; return show(); },
      dispose: () => viewer.plugin.dispose(),
    };
  }

  function counts(report) {
    const f = flagged(report);
    return { priority: f.pri.length, secondary: f.sec.length, backbone: f.bb.length };
  }

  root.Rubric3D = { create, buildMvs, parseRes, counts, colors: { GREY, ORANGE, RED } };
})(typeof window !== "undefined" ? window : globalThis);
