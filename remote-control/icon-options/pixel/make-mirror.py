#!/usr/bin/env python3
"""J61 idea (Angus: "What if the y is one block shorter, so that the blue block in the y is exactly the same as the blue
block in the P for pi, but backwards"): f2 with the y's blue part = pi's blue T mirrored left-right, one block shorter,
the yellow hook kept under it. Shown next to f2, with the whole-pixel / 78% / full-colour fixes. Writes mirror-*.png."""
import os
from PIL import Image, ImageDraw, ImageFont
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "make4.py")).read()
exec(src[:src.index("LOGO =")]); exec(src[src.index("def render"):src.index("FONT =")])
F2 = ["C.....CCC.", "CCC.B.B.C.", "C.C.B.BB.Y", "C.CBB.B..Y", "....B.....", "..YY......"]
# pi's T (logo rows 1-3): stem + a nub to the RIGHT on its middle row; mirrored: stem in column 4, nub to the LEFT (col 3)
MIRROR = ["C.....CCC.", "CCC...B.C.", "C.C.B.BB.Y", "C.CBB.B..Y", "....B.....", "..YY......"]   # one row lower (Angus); the hook where f2 has it
def tile(grid, size=180, pad=0.11): return render(grid, size=size, pad=pad)  # 14 px blocks at 180: whole pixels
FONT = next(f for f in ("/usr/share/fonts/TTF/DejaVuSans.ttf", "/usr/share/fonts/noto/NotoSans-Regular.ttf") if os.path.exists(f))
font, small = ImageFont.truetype(FONT, 24), ImageFont.truetype(FONT, 18)
sheet = Image.new("RGB", (2 * 520, 450), (236, 236, 232)); d = ImageDraw.Draw(sheet)
for i, (name, label, grid) in enumerate((("f2", "f2 now (live)", F2), ("mirror", "y's blue = pi's blue piece, mirrored", MIRROR))):
    base = tile(grid); base.save(os.path.join(HERE, f"mirror-{name}-180.png"))
    cx = i * 520 + 20
    for k, sz, at in ((280, 280, (cx, 20)), (150, 150, (cx + 300, 20)), (60, 60, (cx + 300, 190))):
        im = base.resize((sz, sz), Image.NEAREST) if sz % 180 == 0 else tile(grid, size=sz)
        t = rounded(im); sheet.paste(t, at, t)
    d.text((cx, 315), f"{i + 1}. {label}", fill=(30, 30, 30), font=font)
sheet.save(os.path.join(HERE, "contact-mirror.png")); print("\n".join(MIRROR))
