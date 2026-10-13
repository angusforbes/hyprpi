#!/usr/bin/env python3
"""J61 v2, round 3 (Angus: "every piece is a tetris piece, so we have that as a constraint. make sure each piece is a
different color"): "hy" + P built ONLY from tetrominoes, each piece its own colour. Each option is a grid of piece
letters (a, b, c …; "." empty); the script checks every piece is 4 connected squares, names its tetromino (I O T S Z J L),
gives each piece a different colour, and draws thin outlines on the sheet so the pieces show."""
import os
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
# pi's three (coral, blue, yellow) first, then the same muted family
PAL = [(230, 140, 124), (82, 144, 181), (234, 184, 96), (90, 168, 154), (154, 123, 181), (141, 176, 106), (201, 112, 138), (112, 128, 150)]
LIGHT, DARK = (250, 250, 248), (30, 31, 40)

def norm(cells):
    mx, my = min(x for x, y in cells), min(y for x, y in cells); return frozenset((x - mx, y - my) for x, y in cells)
def rots(cells):
    out, c = set(), set(cells)
    for _ in range(4):
        c = {(y, -x) for x, y in c}; out.add(norm(c)); out.add(norm({(-x, y) for x, y in c}))
    return out
BASE = {"I": {(0, 0), (1, 0), (2, 0), (3, 0)}, "O": {(0, 0), (1, 0), (0, 1), (1, 1)}, "T": {(0, 0), (1, 0), (2, 0), (1, 1)},
        "S": {(1, 0), (2, 0), (0, 1), (1, 1)}, "Z": {(0, 0), (1, 0), (1, 1), (2, 1)}, "L": {(0, 0), (0, 1), (0, 2), (1, 2)}, "J": {(1, 0), (1, 1), (1, 2), (0, 2)}}
SHAPES = {k: rots(v) for k, v in BASE.items()}
def kind(cells):
    n = norm(cells)
    for k, v in SHAPES.items():
        if n in v: return "L/J" if k in "LJ" else ("S/Z" if k in "SZ" else k)
    return None

def pieces(grid):
    ps = {}
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch != ".": ps.setdefault(ch, set()).add((x, y))
    return ps

def render(grid, bg, size=512, pad=0.14, outline=False):
    h, w = len(grid), max(len(r) for r in grid)
    cell = int(size * (1 - 2 * pad) / max(w, h))
    im = Image.new("RGB", (size, size), bg); d = ImageDraw.Draw(im)
    x0, y0 = (size - cell * w) // 2, (size - cell * h) // 2
    ps = pieces(grid); order = sorted(ps, key=lambda k: OPT_ORDER.get(k, k))
    col = {k: PAL[i % len(PAL)] for i, k in enumerate(order)}
    for k, cells in ps.items():
        for x, y in cells: d.rectangle([x0 + x * cell, y0 + y * cell, x0 + (x + 1) * cell - 1, y0 + (y + 1) * cell - 1], fill=col[k])
    if outline:  # piece borders: a line wherever a cell's neighbour belongs to another piece (or nothing)
        lw = max(2, cell // 14); oc = (255, 255, 255) if bg == LIGHT else (30, 31, 40)
        for k, cells in ps.items():
            for x, y in cells:
                X, Y = x0 + x * cell, y0 + y * cell
                if (x, y - 1) not in cells: d.line([X, Y, X + cell, Y], fill=oc, width=lw)
                if (x, y + 1) not in cells: d.line([X, Y + cell - 1, X + cell, Y + cell - 1], fill=oc, width=lw)
                if (x - 1, y) not in cells: d.line([X, Y, X, Y + cell], fill=oc, width=lw)
                if (x + 1, y) not in cells: d.line([X + cell - 1, Y, X + cell - 1, Y + cell], fill=oc, width=lw)
    return im
OPT_ORDER = {}

# pi's logo exactly as pi draws it: coral J/L (a tetromino), blue T (a tetromino), yellow i (2 squares: not one).
LOGO = {"P1": [(0, 0), (1, 0), (2, 0), (2, 1)], "P2": [(0, 1), (0, 2), (1, 2), (0, 3)], "P3": [(3, 2), (3, 3)]}
LOGO_COL = {"P1": PAL[0], "P2": PAL[1], "P3": PAL[2]}
HY_COL = [PAL[3], PAL[4], PAL[5], PAL[6], PAL[7]]

H = [(0, 0), (0, 1), (0, 2), (0, 3), (1, 1), (2, 1), (2, 2), (2, 3)]                       # h: stem + shoulder + leg
YS = {  # y shapes (x from 0; rows 1.. like the h's x-height), all multiples of 4 squares
    "straight": ["X.X", "X.X", "XXX", "..X"],
    "wide-curl": ["X..X", "X..X", "XXXX", "...X", ".XXX"],
    "long-curl": ["X.X", "X.X", "XXX", "..X", "..X", "XXX"],
}
def ycells(name, x0):
    return [(x0 + x, 1 + y) for y, row in enumerate(YS[name]) for x, ch in enumerate(row) if ch == "X"]

def tilings(cells, limit=200):
    cells = set(cells); out = []
    def go(left, acc):
        if len(out) >= limit: return
        if not left: out.append(list(acc)); return
        c = min(left, key=lambda p: (p[1], p[0]))
        for k, shapes in SHAPES.items():
            for sh in shapes:
                for ax, ay in sh:  # anchor any square of the shape on c
                    pl = {(c[0] + x - ax, c[1] + y - ay) for x, y in sh}
                    if pl <= left and min(pl, key=lambda p: (p[1], p[0])) == c:
                        acc.append((k, pl)); go(left - pl, acc); acc.pop()
    go(cells, []); 
    uniq, seen = [], set()
    for t in out:
        key = frozenset(frozenset(p) for _, p in t)
        if key not in seen: seen.add(key); uniq.append(t)
    return uniq

def compose(yname, tile_pick, gap=1, bg=LIGHT, across=False):
    """across: pieces may span the h and the y; else each letter is tiled on its own (the letters read better)"""
    yc = ycells(yname, 3)
    if across: ts = tilings(H + yc); t = ts[tile_pick % len(ts)]
    else:
        th, ty = tilings(H), tilings(yc); t = th[0] + ty[tile_pick % len(ty)]
    w = 3 + len(YS[yname][0])
    lx = w + gap
    cells = []  # (x, y, colour, piece id)
    for i, (k, pl) in enumerate(t):
        for x, y in pl: cells.append((x, y, HY_COL[i % len(HY_COL)], f"h{i}"))
    for pid, pl in LOGO.items():
        for x, y in pl: cells.append((lx + x, y, LOGO_COL[pid], pid))
    names = " + ".join(("L/J" if k in "LJ" else "S/Z" if k in "SZ" else k) for k, _ in t)
    return cells, names, len(t)

def draw(cells, bg, size=512, pad=0.13, outline=False):
    xs = [c[0] for c in cells]; ys = [c[1] for c in cells]
    w, h = max(xs) + 1, max(ys) + 1
    cell = int(size * (1 - 2 * pad) / max(w, h))
    im = Image.new("RGB", (size, size), bg); d = ImageDraw.Draw(im)
    x0, y0 = (size - cell * w) // 2, (size - cell * h) // 2
    own = {(x, y): pid for x, y, _, pid in cells}
    for x, y, col, pid in cells: d.rectangle([x0 + x * cell, y0 + y * cell, x0 + (x + 1) * cell - 1, y0 + (y + 1) * cell - 1], fill=col)
    if outline:
        lw = max(2, cell // 16); oc = (60, 60, 70) if bg == LIGHT else (230, 230, 230)
        for x, y, col, pid in cells:
            X, Y = x0 + x * cell, y0 + y * cell
            if own.get((x, y - 1)) != pid: d.line([X, Y, X + cell, Y], fill=oc, width=lw)
            if own.get((x, y + 1)) != pid: d.line([X, Y + cell - 1, X + cell, Y + cell - 1], fill=oc, width=lw)
            if own.get((x - 1, y)) != pid: d.line([X, Y, X, Y + cell], fill=oc, width=lw)
            if own.get((x + 1, y)) != pid: d.line([X + cell - 1, Y, X + cell - 1, Y + cell], fill=oc, width=lw)
    return im

def rounded(im, r=0.22):
    m = Image.new("L", im.size, 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius=int(im.size[0] * r), fill=255)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0)); out.paste(im, (0, 0), m); return out

if __name__ == "__main__":
    import sys
    if "--list" in sys.argv:
        for yn in YS:
            ts = tilings(H + ycells(yn, 3))
            print(yn, len(ts))
            for t in ts[:12]: print("   ", " + ".join(k for k, _ in sorted(t, key=lambda kp: min(kp[1]))))

ITER = [  # (name, y shape, which tiling, gap before the P, background, pieces across letters)
    ("tet-1", "straight", 0, 1, LIGHT, False),
    ("tet-2", "wide-curl", 0, 1, LIGHT, False),
    ("tet-3", "long-curl", 0, 1, LIGHT, False),
    ("tet-4", "straight", 0, 1, LIGHT, True),
    ("tet-5", "wide-curl", 0, 2, LIGHT, False),
    ("tet-6", "straight", 0, 1, DARK, False),
]
if __name__ == "__main__" and "--list" not in __import__("sys").argv:
    FONT = next(f for f in ("/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/noto/NotoSans-Regular.ttf") if os.path.exists(f))
    font, small = ImageFont.truetype(FONT, 26), ImageFont.truetype(FONT, 19)
    sheet = Image.new("RGB", (3 * 560, 2 * 540), (236, 236, 232)); d = ImageDraw.Draw(sheet)
    for i, (name, yn, pick, gap, bg, across) in enumerate(ITER):
        cells, names, n = compose(yn, pick, gap, bg, across)
        plain = draw(cells, bg); plain.save(os.path.join(HERE, name + ".png"))
        lined = draw(cells, bg, outline=True)
        cx, cy = (i % 3) * 560 + 20, (i // 3) * 540 + 20
        for im, sz, at in ((lined, 300, (cx, cy)), (plain, 180, (cx + 320, cy)), (plain, 60, (cx + 320, cy + 200))):
            t = rounded(im.resize((sz, sz), Image.LANCZOS)); sheet.paste(t, at, t)
        hy = names.split(" + ")
        d.text((cx, cy + 315), f"{i + 1}. {yn.replace('-', ' ')} y" + (", pieces across h/y" if across else "") + (", wider gap" if gap > 1 else "") + (", dark" if bg == DARK else ""), fill=(30, 30, 30), font=font)
        d.text((cx, cy + 350), (f"h and y together = {names}" if across else f"h = {hy[0]} + {hy[1]} · y = {' + '.join(hy[2:])}"), fill=(80, 80, 80), font=small)
        d.text((cx, cy + 376), "P = L/J + T (pi's) · i = pi's 2-square", fill=(80, 80, 80), font=small)
        d.text((cx + 320, cy + 265), "180 px · 60 px", fill=(110, 110, 110), font=small)
    sheet.save(os.path.join(HERE, "contact-tet.png")); print("ok")
