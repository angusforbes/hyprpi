#!/usr/bin/env python3
"""J61 v2, round 5 (Angus: "the bottom of the y lines up with the bottom of the Pi. the space in the h is only 1 block.
the height is only 4 instead of 5"): hy 4 blocks tall like pi's logo, no descender, h's inner gap 1 block, pi's colours,
no borders, pi's logo unchanged. B blue, C coral, Y yellow. Writes f-N.png and the sheet."""
import os
from PIL import Image, ImageDraw, ImageFont
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "make4.py")).read()
exec(src[:src.index("LOGO =")]); exec(src[src.index("def render"):src.index("FONT =")])
LOGO = ["CCC.", "B.C.", "BB.Y", "B..Y"]   # pi's logo, rows 0-3
H = ["B..", "BCC", "B.C", "B.C"]          # h, 4 high, its inner gap 1 block

def mark(y, yx=3, gap=1, ycol="Y", hc=None):
    w = yx + max(len(r) for r in y) + gap + 4
    g = [["."] * w for _ in range(4)]
    for r, line in enumerate(H):
        for c, ch in enumerate(line):
            if ch != ".": g[r][c] = (hc or {}).get(ch, ch)
    for r, line in enumerate(y):
        for c, ch in enumerate(line):
            if ch == "X" and g[r][yx + c] == ".": g[r][yx + c] = ycol
    for r, line in enumerate(LOGO):
        for c, ch in enumerate(line):
            if ch != ".": g[r][w - 4 + c] = ch
    return ["".join(r) for r in g]

OPTS = [
    ("f-1", "arms meet, stem to the baseline: y = two arms joining in one stem", mark(["X.X", "X.X", ".X.", ".X."])),
    ("f-2", "wide V: diagonal arms, a 2-block stem", mark(["X...X", ".X.X.", "..X..", "..X.."])),
    ("f-3", "short arms: arms join on row 2, stem leans left", mark(["X.X", "X.X", ".X.", "X.."])),
    ("f-4", "u-y: a u whose right side runs on to the baseline", mark(["X.X", "X.X", "XXX", "..X"])),
    ("f-5", "shared column: the h's right leg is the y's left arm", mark(["..X", "..X", "XXX", "..X"], yx=2)),
    ("f-6", "as 1, coral h (yellow shoulder), blue y", mark(["X.X", "X.X", ".X.", ".X."], ycol="B", hc={"B": "C", "C": "Y"})),
]
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
sheet.save(os.path.join(HERE, "contact-f.png"))
