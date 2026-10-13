#!/usr/bin/env python3
"""J61 v2: pixel-block icon options in pi's own logo style and palette (Angus: "something similar to the Pi
terminal window icon … but with an 'hypi' or 'hpi' or 'HyPi'"). Each option is a grid of letters: C coral, B blue,
Y yellow (pi's startup logo colours), . empty. Writes NAME.png (512 px) and contact.png (all, labelled, with 180
and 60 px previews)."""
import os
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
COL = {"C": (230, 140, 124), "B": (82, 144, 181), "Y": (234, 184, 96), "W": (250, 250, 248)}
LIGHT, DARK = (250, 250, 248), (30, 31, 40)
OPTS = [
    ("1-hpi", "hpi: a blue h before pi's own logo", LIGHT, [
        "B.......",
        "B...CCC.",
        "BCC.B.C.",
        "B.C.BB.Y",
        "B.C.B..Y"]),
    ("2-hypi", "hypi in two lines: hy over pi's logo", LIGHT, [
        "B......",
        "B......",
        "BCC.Y.Y",
        "B.C.Y.Y",
        "B.C.YYY",
        "......Y",
        "....YY.",
        ".......",
        "..CCC..",
        "..B.C..",
        "..BB.Y.",
        "..B..Y."]),
    ("3-HyPi", "HyPi: capital H, y with a tail, pi's logo", LIGHT, [
        "B.B.....CCC.",
        "BBB.Y.Y.B.C.",
        "B.B.YYY.BB.Y",
        "B.B...Y.B..Y",
        "....YY......"]),
    ("4-h-pi", "h and a pixel π (hyprpi)", LIGHT, [
        "B........",
        "B...CCCCC",
        "BCC...B.Y",
        "B.C...B.Y",
        "B.C...B.Y"]),
    ("5-hpi-stacked", "a small coral h over pi's logo, big", LIGHT, [
        ".C..",
        ".C..",
        ".CCC",
        ".C.C",
        "....",
        "CCC.",
        "B.C.",
        "BB.Y",
        "B..Y"]),
    ("6-hpi-dark", "option 1 on a dark tile (like the terminal)", DARK, None),
]
OPTS[5] = (OPTS[5][0], OPTS[5][1], DARK, OPTS[0][3])

def render(grid, bg, size=512, pad=0.16, radius=0.0):
    h, w = len(grid), max(len(r) for r in grid)
    cell = int(size * (1 - 2 * pad) / max(w, h))
    im = Image.new("RGB", (size, size), bg)
    d = ImageDraw.Draw(im)
    x0, y0 = (size - cell * w) // 2, (size - cell * h) // 2
    for y, row in enumerate(grid):
        for x, ch in enumerate(row):
            if ch in COL: d.rectangle([x0 + x * cell, y0 + y * cell, x0 + (x + 1) * cell - 1, y0 + (y + 1) * cell - 1], fill=COL[ch])
    return im

def rounded(im, r=0.22):  # how iOS will show it (its own mask), for the preview only
    m = Image.new("L", im.size, 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius=int(im.size[0] * r), fill=255)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0)); out.paste(im, (0, 0), m); return out

font = None
for f in ("/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/noto/NotoSans-Regular.ttf"):
    if os.path.exists(f): font = ImageFont.truetype(f, 26); small = ImageFont.truetype(f, 20); break
tiles = []
for name, label, bg, grid in OPTS:
    im = render(grid, bg); im.save(os.path.join(HERE, name + ".png")); tiles.append((name, label, im))
# contact sheet: per option a 300 px rounded tile + 180 and 60 px previews + label
W, H = 3 * 560, 2 * 520
sheet = Image.new("RGB", (W, H), (236, 236, 232)); d = ImageDraw.Draw(sheet)
for i, (name, label, im) in enumerate(tiles):
    cx, cy = (i % 3) * 560 + 20, (i // 3) * 520 + 20
    sheet.paste(rounded(im.resize((300, 300), Image.LANCZOS)), (cx, cy), rounded(im.resize((300, 300), Image.LANCZOS)))
    sm = rounded(im.resize((180, 180), Image.LANCZOS)); sheet.paste(sm, (cx + 320, cy), sm)
    t = rounded(im.resize((60, 60), Image.LANCZOS)); sheet.paste(t, (cx + 320, cy + 200), t)
    d.text((cx, cy + 315), name.split("-", 1)[0] + ". " + name.split("-", 1)[1], fill=(30, 30, 30), font=font)
    d.text((cx, cy + 352), label, fill=(80, 80, 80), font=small)
    d.text((cx + 320, cy + 265), "180 px · 60 px", fill=(110, 110, 110), font=small)
sheet.save(os.path.join(HERE, "contact.png"))
print("ok")
