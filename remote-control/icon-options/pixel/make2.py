#!/usr/bin/env python3
"""J61 v2, round 2 (Angus: option 3 HyPi, but "a lowercase h and the y should be next to the h with no space, try some
iterations of that"): lowercase h + y touching it + pi's logo, in pi's palette. Writes hy-N-*.png and ~/Phone sheet."""
import os
from PIL import Image, ImageDraw
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "make.py")).read().split("OPTS = [")[0])  # COL, LIGHT, DARK, imports
src = open(os.path.join(HERE, "make.py")).read()
exec(src[src.index("def render"):src.index("font = None")])  # render(), rounded()
from PIL import ImageFont

LOGO = ["CCC.", "B.C.", "BB.Y", "B..Y"]                    # pi's logo, rows 1-4
TAILS = {"left": ["..Y", "YY."], "straight": ["..Y", "..Y"], "curl": ["Y.Y", "YYY"]}

def compose(hc, hs, yc, tail, gap, shared):
    """h stem colour hc, shoulder hs; y colour yc; tail style; gap columns before the logo; y shares the h's right leg"""
    rows = 7; grid = [[" "] * 30 for _ in range(rows)]
    def put(r, c, ch):
        if ch not in ". ": grid[r][c] = ch
    hh = [hc + "..", hc + "..", hc + hs + hs, hc + "." + hs, hc + "." + hs]
    for r, line in enumerate(hh):
        for c, ch in enumerate(line): put(r, c, ch)
    y0 = 2 if shared else 3                                 # y's left column: h's right leg (shared) or right next to it
    yy = ["Y.Y", "Y.Y", "YYY"] + TAILS[tail]
    for r, line in enumerate(yy):
        for c, ch in enumerate(line):
            if ch == "Y" and not (shared and c == 0 and r < 3): put(2 + r, y0 + c, yc)
    lx = y0 + 3 + gap
    for r, line in enumerate(LOGO):
        for c, ch in enumerate(line): put(1 + r, lx + c, ch)
    w = lx + 4
    return ["".join(x if x != " " else "." for x in row[:w]) for row in grid]

ITER = [
    ("hy-1", "h blue, y yellow right after it, tail down-left", LIGHT, compose("B", "C", "Y", "left", 1, False)),
    ("hy-2", "y shares the h's right leg (one column), tail down-left", LIGHT, compose("B", "C", "Y", "left", 1, True)),
    ("hy-3", "as 1, straight tail", LIGHT, compose("B", "C", "Y", "straight", 1, False)),
    ("hy-4", "as 1, curled tail, no gap before the P", LIGHT, compose("B", "C", "Y", "curl", 0, False)),
    ("hy-5", "h coral, y blue, a wider gap before the P", LIGHT, compose("C", "Y", "B", "left", 2, False)),
    ("hy-6", "1 on a dark tile", DARK, compose("B", "C", "Y", "left", 1, False)),
]
FONT = next(f for f in ("/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/noto/NotoSans-Regular.ttf") if os.path.exists(f)); font = ImageFont.truetype(FONT, 26); small = ImageFont.truetype(FONT, 20)
tiles = []
for name, label, bg, grid in ITER:
    im = render(grid, bg); im.save(os.path.join(HERE, name + ".png")); tiles.append((name, label, im))
    print(name); print("\n".join(grid)); print()
sheet = Image.new("RGB", (3 * 560, 2 * 520), (236, 236, 232)); d = ImageDraw.Draw(sheet)
for i, (name, label, im) in enumerate(tiles):
    cx, cy = (i % 3) * 560 + 20, (i // 3) * 520 + 20
    for sz, at in ((300, (cx, cy)), (180, (cx + 320, cy)), (60, (cx + 320, cy + 200))):
        t = rounded(im.resize((sz, sz), Image.LANCZOS)); sheet.paste(t, at, t)
    d.text((cx, cy + 315), f"{name[-1]}. {name}", fill=(30, 30, 30), font=font)
    d.text((cx, cy + 352), label, fill=(80, 80, 80), font=small)
    d.text((cx + 320, cy + 265), "180 px · 60 px", fill=(110, 110, 110), font=small)
sheet.save(os.path.join(HERE, "contact-hy.png"))
