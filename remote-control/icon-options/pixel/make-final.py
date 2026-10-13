#!/usr/bin/env python3
"""J61: Angus's pick, f2 ("let's use f2... final answer!"): coral short h, blue y, yellow hook, pi's logo. Writes the app
icons into remote-control/: icon-180/192/512.png, icon-maskable-512.png (content inside the 80% safe circle), favicon.png."""
import os
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "make8.py")).read()
exec(src[:src.index("\nFONT = next")])
grid = mark(dict(OPTS)["f2"] if False else [o for o in OPTS if o[0] == "f2"][0][2])
OUT = os.path.abspath(os.path.join(HERE, "..", ".."))
# J61 fuzz fix (Angus: "the icon seems a bit fuzzy on my iphone"): iOS may take a manifest icon and scale it to 180 px;
# a 512 px icon has 38 px blocks, which land between pixels at 180. So every icon is the 180 px drawing (13 px blocks,
# whole-pixel edges) scaled by a WHOLE factor with nearest-neighbour: 180, 360, 540 (any) and a 540 maskable built the
# same way from a 180 px drawing with more padding; 192/512 the same idea for other platforms.
from PIL import Image
base = render(grid, size=180, pad=0.11); maskb = render(grid, size=180, pad=0.167)   # mark 140 px wide = 78% of the tile (Angus: it looked small); maskable inside the 80% circle
def up(im, k): return im.resize((im.size[0] * k, im.size[1] * k), Image.NEAREST)
outs = {"icon-180.png": base, "icon-360.png": up(base, 2), "icon-540.png": up(base, 3), "icon-maskable-540.png": up(maskb, 3),
        "icon-192.png": render(grid, size=192, pad=0.11), "icon-512.png": render(grid, size=512, pad=0.11),
        "icon-maskable-512.png": render(grid, size=512, pad=0.167), "favicon.png": render(grid, size=64, pad=0.06)}
for name, im in outs.items(): im.save(os.path.join(OUT, name)); print(name, im.size)
