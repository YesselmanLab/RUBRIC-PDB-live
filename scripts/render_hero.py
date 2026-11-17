# Renders assets/hero-1gid.png: 1GID chain A (Tetrahymena P4-P6) in grey, with
# residues from its RUBRIC report coloured: the priority-review pairs and a run of
# unassigned backbone suites in red, four secondary-review pairs in orange.
#
#   curl -sO https://files.rcsb.org/download/1GID.cif
#   pymol -cq scripts/render_hero.py -- 1GID.cif assets/hero-1gid.png
import sys

from PIL import Image
from pymol import cmd

cif, out = sys.argv[1], sys.argv[2]
priority = "127+195+235+239"                   # C127-G195, A235-U239
secondary = "234+240+226+249+129+193+131+192"  # G234-C240, A226-U249, G129-C193, U131-A192
backbone = "121-125"                           # suites 122-125 match no conformer
side = "not name P+OP1+OP2+O5'+C5'+C4'+O4'+C3'+O3'+C2'+O2'+C1'"

cmd.load(cif, "m")
cmd.remove("not chain A or not polymer or hydro")
cmd.hide("everything")
cmd.set_color("g_back", [0.60, 0.63, 0.68])
cmd.set_color("g_base", [0.80, 0.82, 0.86])
cmd.set_color("r_red", [0xc0 / 255, 0x39 / 255, 0x3f / 255])
cmd.set_color("r_orange", [0xdd / 255, 0x84 / 255, 0x52 / 255])
cmd.set("cartoon_ring_mode", 3)
cmd.set("cartoon_ring_finder", 1)
cmd.set("cartoon_tube_radius", 0.9)
cmd.set("cartoon_ring_transparency", 0.0)
cmd.show("cartoon", "m")
cmd.color("g_back", "m")
cmd.color("r_red", f"m and resi {backbone}")
cmd.set("cartoon_ring_color", "g_base", "m")
cmd.set("cartoon_ring_color", "r_orange", f"m and resi {secondary}")
cmd.set("cartoon_ring_color", "r_red", f"m and resi {priority}")
cmd.show("sticks", f"m and resi {priority}+{secondary} and {side}")
cmd.set("stick_radius", 0.28)
cmd.color("r_orange", f"m and resi {secondary} and elem C+N+O")
cmd.color("r_red", f"m and resi {priority} and elem C+N+O")

# Same orientation as Fig. S12A (camera view of 7A_1GID_current.pse).
cmd.set_view((0.15256021916866302, -0.6710037589073181, 0.7255889177322388,
              -0.9444023370742798, -0.31534847617149353, -0.09305790066719055,
              0.29125556349754333, -0.6710509657859802, -0.6818069815635681,
              0.0, -0.0, -381.6987609863281,
              42.55404281616211, 62.22097396850586, 80.97030639648438,
              300.9342041015625, 462.46331787109375, -20.0))
cmd.zoom("m", 3, complete=1)

cmd.bg_color("white")
cmd.set("ray_opaque_background", 0)
cmd.set("ray_trace_mode", 0)
cmd.set("ambient", 0.35)
cmd.set("specular", 0.25)
cmd.set("ray_shadows", 0)
cmd.set("depth_cue", 0)
cmd.set("antialias", 2)
cmd.png(out, width=1400, height=1400, dpi=150, ray=1)

# Trim the transparent margin and size for the page (shown 440 px tall).
im = Image.open(out)
im = im.crop(im.getchannel("A").getbbox())
im.thumbnail((1000, 1000), Image.LANCZOS)
im.save(out, optimize=True)
