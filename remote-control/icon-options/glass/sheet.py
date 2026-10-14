#!/usr/bin/env python3
"""J570 v2: variants of π's icon (mark size × y–P gap, D's colours, light plate), shown plain and through glass.py,
at phone size (204 px tiles) plus an enlarged row; a calibration image; a Home Screen row mock-up."""
import os, numpy as np
from PIL import Image, ImageDraw, ImageFont
from glass import glass, frost, ERR, SAT, LIFT
HERE = os.path.dirname(os.path.abspath(__file__)); SHOT = os.path.expanduser("~/Phone/screenshot-20261013-211805.png")
LETTERS = ["C.....", "CCC...", "C.C.B.", "C.CBB.", "....B.", "..YY.."]   # h + y (6 cols)
P = ["CCC.", "B.C.", "BB.Y", "B..Y", "....", "...."]                     # pi's logo
PI = {"C": (230, 140, 124), "B": (82, 144, 181), "Y": (234, 184, 96)}
DEEP = {"C": (214, 112, 94), "B": (52, 118, 165), "Y": (226, 164, 52)}
LIGHT, DARKBG = (250, 250, 248), (30, 31, 40)
GAPS = {"gap": 1.0, "half": 0.5, "touch": 0.0}

def tile(pct, gap, cols=DEEP, bg=LIGHT, size=204):
    width_blocks = 5 + gap + 4                   # h+y span 5 cols (col 5 is empty), then the gap, then the P
    cell = max(1, round(pct / 100 * size / width_blocks))
    im = Image.new("RGB", (size, size), bg); d = ImageDraw.Draw(im)
    W, H = round(width_blocks * cell), 6 * cell; x0, y0 = (size - W) // 2, (size - H) // 2
    def put(grid, xoff):
        for y, row in enumerate(grid):
            for x, ch in enumerate(row):
                if ch in cols:
                    X = x0 + round(xoff + x * cell); d.rectangle([X, y0 + y * cell, X + cell - 1, y0 + (y + 1) * cell - 1], fill=cols[ch])
    put([r[:5] for r in LETTERS], 0); put(P, (5 + gap) * cell)
    return im

def rounded(im, r=0.225):
    m = Image.new("L", im.size, 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius=int(im.size[0] * r), fill=255)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0)); out.paste(im, (0, 0), m); return out

F = "/usr/share/fonts/TTF/DejaVuSans.ttf" if os.path.exists("/usr/share/fonts/TTF/DejaVuSans.ttf") else "/usr/share/fonts/noto/NotoSans-Regular.ttf"
font, big = ImageFont.truetype(F, 26), ImageFont.truetype(F, 34)
shot = Image.open(SHOT).convert("RGB")
real = {"B": shot.crop((410, 1535, 615, 1740)).resize((204, 204)), "C": shot.crop((700, 1535, 905, 1740)).resize((204, 204)),
        "Passport Parking": shot.crop((105, 570, 310, 775)).resize((204, 204)), "π now": shot.crop((105, 1535, 310, 1740)).resize((204, 204))}

# 1. calibration: simulated B and C (as the files were) next to the phone's pixels
simB = glass(tile(78, 1, PI, LIGHT), LIGHT); simC = glass(tile(93, 1, DEEP, DARKBG), DARKBG)
def err(a, b):
    a = np.asarray(a).astype(float)[30:174, 20:184]; b = np.asarray(b).astype(float)[30:174, 20:184]; return np.abs(a - b).mean()
eB, eC = err(simB, real["B"]), err(simC, real["C"])
cal = Image.new("RGB", (2 * 440 + 40, 330), (236, 236, 232)); d = ImageDraw.Draw(cal)
for i, (lab, s, r, e) in enumerate((("B", simB, real["B"], eB), ("C", simC, real["C"], eC))):
    x = 20 + i * 460
    for j, im in enumerate((s, r)): t = rounded(im); cal.paste(t, (x + j * 220, 20), t)
    d.text((x, 240), f"{lab}: simulated · phone", fill=(30, 30, 30), font=font); d.text((x, 275), f"mean error {e:.1f} /255 per channel", fill=(90, 90, 90), font=font)
cal.save(os.path.join(HERE, "calibration.png"))

# 2. the sheet: rows = sizes, column pairs = gaps (plain | glass)
SIZES = [78, 82, 86, 90, 93]
cw, ch = 230, 270
sheet = Image.new("RGB", (60 + 6 * cw, 120 + len(SIZES) * ch + 560), (238, 238, 236)); d = ImageDraw.Draw(sheet)
d.text((20, 20), "π icon variants · light · D's colours · plain | through the simulated iOS glass", fill=(20, 20, 20), font=big)
for j, g in enumerate(GAPS):
    d.text((60 + j * 2 * cw + 10, 75), f"{g}: plain | glass", fill=(60, 60, 60), font=font)
for i, pct in enumerate(SIZES):
    y = 120 + i * ch
    for j, (g, gv) in enumerate(GAPS.items()):
        im = tile(pct, gv)
        for k, v in enumerate((im, glass(im, LIGHT))):
            t = rounded(v); sheet.paste(t, (60 + (2 * j + k) * cw, y), t)
        d.text((60 + 2 * j * cw, y + 212), f"{pct}-{g}", fill=(30, 30, 30), font=font)
# enlarged row: 86 at each gap, glass, 2×
y = 120 + len(SIZES) * ch + 20; d.text((20, y), "enlarged 2× (86%, through the glass): gap · half · touch", fill=(20, 20, 20), font=font)
for j, gv in enumerate(GAPS.values()):
    v = glass(tile(86, gv, size=408), LIGHT); t = rounded(v); sheet.paste(t, (60 + j * 440, y + 45), t)
sheet.save(os.path.join(HERE, "sheet.png"))

# 3. a Home Screen row mock-up: real Passport Parking + real π now (phone pixels), then the best simulated candidates
BEST = [(82, "half"), (86, "half"), (86, "touch"), (90, "half"), (86, "gap")]
row = [("Passport Parking", real["Passport Parking"]), ("π now", real["π now"])] + [(f"{p}-{g}", glass(tile(p, GAPS[g]), LIGHT)) for p, g in BEST]
mock = Image.new("RGB", (40 + 4 * 300, 2 * 320 + 40), (183, 176, 166)); d = ImageDraw.Draw(mock)
for i, (lab, im) in enumerate(row):
    x, y = 40 + (i % 4) * 300, 30 + (i // 4) * 320
    t = rounded(im); mock.paste(t, (x + 30, y), t)
    d.text((x + 132 - d.textlength(lab, font=font) / 2, y + 220), lab, fill=(255, 255, 255), font=font)
mock.save(os.path.join(HERE, "homescreen-mock.png"))
print(f"calibration: B {eB:.1f}, C {eC:.1f} (frost fit {ERR:.1f}; saturation {SAT:.2f}, lift {LIFT:.1f})")
