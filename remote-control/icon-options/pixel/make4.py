#!/usr/bin/env python3
"""J61 v2, round 4 (Angus: "get rid of the borders … first make a version with only the colors from the Pi … loosen the
tetris requirement, I don't like any of the y's"): pi's three colours only, no outlines, new y's; lowercase h touching
the y, then pi's logo unchanged. Grids: B blue, C coral, Y yellow, . empty. Writes y-N.png and the sheet."""
import os
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
COL = {"C": (230, 140, 124), "B": (82, 144, 181), "Y": (234, 184, 96)}
BG = (250, 250, 248)
LOGO = ["CCC.", "B.C.", "BB.Y", "B..Y"]   # pi's logo as pi draws it, rows 1-4 here (baseline row 4)
H = ["B..", "B..", "BCC", "B.C", "B.C"]   # lowercase h, rows 0-4

def mark(y, yx=3, gap=1, ycol="Y", hc=None):
    """y: rows from row 1 down (list of strings, X = filled); yx: its first column (3 = right against the h)"""
    rows = max(5, 1 + len(y)); w = max(yx + max(len(r) for r in y), 3) + gap + 4
    g = [["."] * w for _ in range(rows)]
    for r, line in enumerate(H):
        for c, ch in enumerate(line):
            if ch != ".": g[r][c] = (hc or {}).get(ch, ch)
    for r, line in enumerate(y):
        for c, ch in enumerate(line):
            if ch == "X" and g[1 + r][yx + c] == ".": g[1 + r][yx + c] = ycol
    lx = w - 4
    for r, line in enumerate(LOGO):
        for c, ch in enumerate(line):
            if ch != ".": g[1 + r][lx + c] = ch
    return ["".join(r) for r in g]

OPTS = [
    ("y-1", "classic y: two arms join, then one stem leans down-left", mark(["....", "X..X", "X..X", ".XX.", ".X..", "X..."])),
    ("y-2", "Y-shaped y: two arms join, the stem drops straight down", mark([".....", "X...X", ".X.X.", "..X..", "..X..", "..X.."])),
    ("y-3", "hooked y: a u whose right side hooks back left", mark(["....", "X..X", "X..X", "XXXX", "...X", ".XX."])),
    ("y-4", "compact y: stays within the P's height", mark(["X.X", "XXX", "..X", "XX."])),
    ("y-5", "shared column: the h's right leg is the y's left arm", mark(["...", "..X", "..X", "XXX", "..X", "XX."], yx=2)),
    ("y-6", "as 5, with a blue y and a coral h", mark(["...", "..X", "..X", "XXX", "..X", "XX."], yx=2, ycol="B", hc={"B": "C", "C": "Y"})),
]

def render(grid, size=512, pad=0.13):
    h, w = len(grid), max(len(r) for r in grid)
    cell = int(size * (1 - 2 * pad) / max(w, h))
    im = Image.new("RGB", (size, size), BG); d = ImageDraw.Draw(im)
    x0, y0 = (size - cell * w) // 2, (size - cell * h) // 2
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch in COL: d.rectangle([x0 + x * cell, y0 + y * cell, x0 + (x + 1) * cell - 1, y0 + (y + 1) * cell - 1], fill=COL[ch])
    return im
def rounded(im, r=0.22):
    m = Image.new("L", im.size, 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius=int(im.size[0] * r), fill=255)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0)); out.paste(im, (0, 0), m); return out

FONT = next(f for f in ("/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/noto/NotoSans-Regular.ttf") if os.path.exists(f))
font, small = ImageFont.truetype(FONT, 26), ImageFont.truetype(FONT, 19)
sheet = Image.new("RGB", (3 * 560, 2 * 500), (236, 236, 232)); d = ImageDraw.Draw(sheet)
for i, (name, label, grid) in enumerate(OPTS):
    print(name); print("\n".join(grid)); print()
    im = render(grid); im.save(os.path.join(HERE, name + ".png"))
    cx, cy = (i % 3) * 560 + 20, (i // 3) * 500 + 20
    for sz, at in ((300, (cx, cy)), (180, (cx + 320, cy)), (60, (cx + 320, cy + 200))):
        t = rounded(im.resize((sz, sz), Image.LANCZOS)); sheet.paste(t, at, t)
    d.text((cx, cy + 315), f"{i + 1}. {label.split(':')[0]}", fill=(30, 30, 30), font=font)
    d.text((cx, cy + 352), label.split(":", 1)[1].strip() if ":" in label else "", fill=(80, 80, 80), font=small)
    d.text((cx + 320, cy + 265), "180 px · 60 px", fill=(110, 110, 110), font=small)
sheet.save(os.path.join(HERE, "contact-y.png"))
