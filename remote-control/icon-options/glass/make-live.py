#!/usr/bin/env python3
"""J580: π's live icon = the pre-compensated 66-half (Angus: "lets go w 66-half"), light, D's colours compensated for
iOS 26's glass (precomp.py), y–P at half the gap. Each size rendered directly (whole-pixel blocks), or as an exact
whole-factor copy of the 180 / 204."""
import os
from PIL import Image
from precomp import precomp
OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
def pc(size): return precomp(66, 0.5, size)[1]
up = lambda im, k: im.resize((im.size[0] * k, im.size[1] * k), Image.NEAREST)
b180, b204 = pc(180), pc(204)
files = {"icon-180.png": b180, "icon-360.png": up(b180, 2), "icon-540.png": up(b180, 3), "icon-maskable-540.png": up(b180, 3),
         "icon-204.png": b204, "icon-1024.png": pc(1024), "icon-192.png": pc(192), "icon-512.png": pc(512),
         "icon-maskable-512.png": pc(512), "favicon.png": pc(64)}
for n, im in files.items(): im.save(os.path.join(OUT, n)); print(n, im.size, len(im.getcolors(1 << 20)))
