# Renders assets/hero-1ehz.png: yeast tRNA-Phe (1EHZ) with the six pairs RUBRIC
# flags for secondary review in orange, on a transparent background.
#
#   curl -sO https://files.rcsb.org/download/1EHZ.cif
#   pymol -cq scripts/render_hero.py -- 1EHZ.cif assets/hero-1ehz.png
import sys

from PIL import Image
from pymol import cmd

cif, out = sys.argv[1], sys.argv[2]
flagged = "16+19+26+30+32+38+40+44+54+56+58+59"

cmd.load(cif, "t")
cmd.remove("not polymer or hydro")
cmd.hide("everything")
cmd.set_color("rubric_blue", [0x4c / 255, 0x72 / 255, 0xb0 / 255])
cmd.set_color("rubric_base", [0xa9 / 255, 0xbd / 255, 0xdd / 255])
cmd.set_color("rubric_orange", [0xdd / 255, 0x84 / 255, 0x52 / 255])
cmd.set("cartoon_ring_mode", 3)
cmd.set("cartoon_ring_finder", 1)
cmd.set("cartoon_tube_radius", 0.9)
cmd.set("cartoon_ring_transparency", 0.0)
cmd.show("cartoon", "t")
cmd.color("rubric_blue", "t")
cmd.set("cartoon_ring_color", "rubric_base", "t")
cmd.set("cartoon_ring_color", "rubric_orange", f"t and resi {flagged}")
cmd.show("sticks", f"t and resi {flagged} and not name P+OP1+OP2+O5'+C5'+C4'+O4'+C3'+O3'+C2'+O2'+C1'")
cmd.set("stick_radius", 0.28)
cmd.color("rubric_orange", f"t and resi {flagged} and elem C+N+O")

cmd.orient("t")
cmd.turn("z", -60)
cmd.turn("y", 15)
cmd.zoom("t", 3, complete=1)

cmd.bg_color("white")
cmd.set("ray_opaque_background", 0)
cmd.set("ray_trace_mode", 0)
cmd.set("ambient", 0.35)
cmd.set("specular", 0.25)
cmd.set("ray_shadows", 0)
cmd.set("depth_cue", 0)
cmd.set("antialias", 2)
cmd.png(out, width=1000, height=1000, dpi=150, ray=1)

# Trim the transparent margin and size for the page (shown at 340 px wide).
im = Image.open(out)
im = im.crop(im.getchannel("A").getbbox())
im.thumbnail((760, 760), Image.LANCZOS)
im.save(out, optimize=True)
