#!/usr/bin/env python3
"""J61 v2, round 8 (Angus: "only the bottom 2 blocks of the y are yellow, the block in the row above is the same color as
the rest of the y"): the short-h shape, the tail split into the drop (y's colour) and the 2-block hook (yellow).
Writes t-*.png and contact-t.png.
Round 7 (Angus: "try making the left side of the h one block shorter, so same height as the P"): round 6 with
the h's stem starting on the P's top row. Writes s-a…s-h.png and contact-s.png.
Round 6 (Angus: "go back to #5 and #6 … make some more versions with different colors and the way y is
colored"): round 4's y-5 shape exactly (shared column: the h's right leg is the y's left arm; with the descender), pi's
logo unchanged, colour variants per part. Writes c-N.png and the sheet."""
import os
from PIL import Image, ImageDraw, ImageFont
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "make4.py")).read()
exec(src[:src.index("LOGO =")]); exec(src[src.index("def render"):src.index("FONT =")])
COL.update({"T": (90, 168, 154), "P": (154, 123, 181)})   # the one extra muted colour some variants use: teal, purple
# y-5's parts, as (col, row): h stem, h shoulder, the shared column (h's right leg = y's left arm), the y's join,
# its right arm, its tail (descender + hook)
PARTS = {
    "stem": [(0, r) for r in range(1, 5)],   # rows 1-4: the top lines up with the P's
    "shoulder": [(1, 2), (2, 2)],
    "shared": [(2, 3), (2, 4)],
    "join": [(3, 4)],
    "arm": [(4, 2), (4, 3), (4, 4)],
    "drop": [(4, 5)],
    "hook": [(3, 6), (2, 6)],
}
LOGO = ["CCC.", "B.C.", "BB.Y", "B..Y"]   # pi's logo, rows 1-4 (baseline row 4), columns 6-9
def mark(c):
    g = [["."] * 10 for _ in range(7)]
    for part, cells in PARTS.items():
        for x, y in cells: g[y][x] = c[part]
    for r, line in enumerate(LOGO):
        for x, ch in enumerate(line):
            if ch != ".": g[1 + r][6 + x] = ch
    return ["".join(r) for r in g[1:]]   # row 0 is empty now
def v(stem, shoulder, shared, join, arm, drop, hook="Y"): return dict(stem=stem, shoulder=shoulder, shared=shared, join=join, arm=arm, drop=drop, hook=hook)

OPTS = [
    ("d2", "d2 (from d): blue h + coral arch, blue y, only the 2-block hook yellow", v("B", "C", "C", "B", "B", "B")),
    ("f2", "f2 (from f): coral h, blue y, only the 2-block hook yellow", v("C", "C", "C", "B", "B", "B")),
    ("c2", "c2 (from c): blue h, coral shared column and y, the hook yellow", v("B", "B", "C", "C", "C", "C")),
    ("a2", "a2 (from a): blue h + coral arch, coral y, the hook yellow", v("B", "C", "C", "C", "C", "C")),
]
FONT = next(f for f in ("/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/noto/NotoSans-Regular.ttf") if os.path.exists(f))
font, small = ImageFont.truetype(FONT, 24), ImageFont.truetype(FONT, 18)
sheet = Image.new("RGB", (4 * 520, 1 * 470), (236, 236, 232)); d = ImageDraw.Draw(sheet)
for i, (name, label, cs) in enumerate(OPTS):
    grid = mark(cs); print(name); print("\n".join(grid)); print()
    im = render(grid); im.save(os.path.join(HERE, "t-" + name + ".png"))
    cx, cy = (i % 4) * 520 + 20, (i // 4) * 470 + 20
    for sz, at in ((280, (cx, cy)), (150, (cx + 300, cy)), (60, (cx + 300, cy + 170))):
        t = rounded(im.resize((sz, sz), Image.LANCZOS)); sheet.paste(t, at, t)
    d.text((cx, cy + 295), f"{name}.", fill=(30, 30, 30), font=font)
    words, line, ys = label.split(" "), "", cy + 330
    for w in words:  # wrap the label to the tile
        if d.textlength(line + " " + w, font=small) > 480: d.text((cx, ys), line.strip(), fill=(80, 80, 80), font=small); line, ys = "", ys + 24
        line += " " + w
    d.text((cx, ys), line.strip(), fill=(80, 80, 80), font=small)
sheet.save(os.path.join(HERE, "contact-t.png"))
