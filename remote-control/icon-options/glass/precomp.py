#!/usr/bin/env python3
"""J572: pre-compensate π's icon for iOS 26's glass (as glass.py simulates it), so that after the glass it looks like
the plain design. Colours: invert the frost per channel, c = (t - LIFT - (1-SAT)·L)/SAT, solved iteratively since L
(luma) depends on c; clamped to 0..255. Edges: pre-darken the 1 px top/left rim (glass adds 45% white there) and
pre-lighten the bottom/right rim (glass darkens to 82%); the drop shadow on the background is left (it's outside the
blocks, and darkening the plate there would show as a halo on the real phone if our model is off)."""
import os, numpy as np
from PIL import Image, ImageDraw, ImageFont
from glass import glass, SAT, LIFT
from sheet import tile, rounded, LIGHT, DEEP, GAPS, F
HERE = os.path.dirname(os.path.abspath(__file__))
def unfrost(t):
    c = np.array(t, float)
    for _ in range(50):
        L = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        c = (np.array(t) - LIFT - (1 - SAT) * L) / SAT
    return tuple(int(v) for v in np.clip(np.round(c), 0, 255))
def precomp(pct, gap, size=204):
    target = tile(pct, gap, DEEP, LIGHT, size); a = np.asarray(target).astype(float)
    fg = np.any(np.abs(a - np.array(LIGHT)) > 3, axis=2); out = a.copy()
    for col in {tuple(map(int, p)) for p in a[fg].reshape(-1, 3)}:
        out[np.all(a == col, axis=2)] = unfrost(col)
    s = max(1, round(size / 204))
    up = np.zeros_like(fg); up[s:] = fg[s:] & ~fg[:-s]; lf = np.zeros_like(fg); lf[:, s:] = fg[:, s:] & ~fg[:, :-s]
    dn = np.zeros_like(fg); dn[:-s] = fg[:-s] & ~fg[s:]; rt = np.zeros_like(fg); rt[:, :-s] = fg[:, :-s] & ~fg[:, s:]
    hi = up | lf; lo = (dn | rt) & ~hi
    # after glass: hi -> x*0.55 + 115 (then the frost was already applied to x). Want the frosted interior value there.
    want = np.zeros_like(out)
    for col in {tuple(map(int, p)) for p in a[fg].reshape(-1, 3)}:
        m = np.all(a == col, axis=2); want[m] = col
    # the glass frosts first, then rims: solve on frosted values f(x) = SAT*x + (1-SAT)L + LIFT ≈ target
    out[hi] = np.clip((want[hi] - 115) / 0.55, 0, 255)   # frosted pixel needed before the highlight
    out[lo] = np.clip(want[lo] / 0.82, 0, 255)
    for m in (hi, lo):  # undo the frost for those rim targets too
        out[m] = np.array([unfrost(tuple(p)) for p in out[m]]).reshape(-1, 3) if m.any() else out[m]
    return target, Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
def err(a, b, fgmask=None):
    a = np.asarray(a).astype(float); b = np.asarray(b).astype(float); d = np.abs(a - b).mean(axis=2)
    return d[fgmask].mean() if fgmask is not None else d.mean()
font = ImageFont.truetype(F, 24)
VARS = [(86, "half"), (82, "half")]
rows = []
sheet = Image.new("RGB", (40 + 3 * 460, 60 + len(VARS) * 720), (238, 238, 236)); d = ImageDraw.Draw(sheet)
for i, (p, g) in enumerate(VARS):
    target, pc = precomp(p, GAPS[g]); pc.save(os.path.join(HERE, f"precomp-{p}-{g}.png"))
    plain_g, pc_g = glass(target, LIGHT), glass(pc, LIGHT)
    fg = np.any(np.abs(np.asarray(target).astype(float) - np.array(LIGHT)) > 3, axis=2)
    e0, e1 = err(plain_g, target, fg), err(pc_g, target, fg)
    rows.append((p, g, e0, e1))
    big = [im.resize((408, 408), Image.NEAREST) for im in (target, plain_g, pc_g)]
    y = 40 + i * 720
    d.text((20, y - 30 if i else 10), f"{p}-{g}: plain target · ordinary icon through glass · pre-compensated through glass", fill=(20, 20, 20), font=font)
    for j, (sm, bg) in enumerate(zip((target, plain_g, pc_g), big)):
        t = rounded(sm); sheet.paste(t, (40 + j * 460, y + 10), t); t = rounded(bg); sheet.paste(t, (40 + j * 460, y + 230), t)
    d.text((40 + 460, y + 650), f"error {e0:.1f}", fill=(60, 60, 60), font=font); d.text((40 + 920, y + 650), f"error {e1:.1f}", fill=(60, 60, 60), font=font)
sheet.save(os.path.join(HERE, "precomp-compare.png"))
for r in rows: print("%d-%s: mean colour error on the mark, ordinary %.1f -> pre-compensated %.1f /255" % r)
print("clamped (out of gamut):", [c for c in DEEP.values() if any(v in (0, 255) for v in unfrost(c))])
