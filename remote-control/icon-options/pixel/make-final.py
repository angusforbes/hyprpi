#!/usr/bin/env python3
"""J61: Angus's pick, f2 ("let's use f2... final answer!"): coral short h, blue y, yellow hook, pi's logo. Writes the app
icons into remote-control/: icon-180/192/512.png, icon-maskable-512.png (content inside the 80% safe circle), favicon.png."""
import os
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "make8.py")).read()
exec(src[:src.index("\nFONT = next")])
grid = mark(dict(OPTS)["f2"] if False else [o for o in OPTS if o[0] == "f2"][0][2])
OUT = os.path.abspath(os.path.join(HERE, "..", ".."))
for size, pad, name in ((180, 0.12, "icon-180.png"), (192, 0.12, "icon-192.png"), (512, 0.12, "icon-512.png"), (512, 0.24, "icon-maskable-512.png"), (64, 0.06, "favicon.png")):
    render(grid, size=size, pad=pad).save(os.path.join(OUT, name)); print(name)
