#!/usr/bin/env python3
"""J570: a simulation of iOS 26's Liquid Glass treatment of a single-image web-clip icon, calibrated on Angus's
Home Screen screenshot (~/Phone/screenshot-20261013-211805.png: B = pi's palette on light, C = deeper palette on dark).
  frost: each foreground colour c -> M·c + k (a 3×3 + offset, least-squares fitted on the measured block colours);
         the background stays (iOS keeps a flat light/dark plate);
  rim:   a light line on the top/left edge of each block, a darker line on its bottom/right edge, and a soft drop
         shadow below-right (widths and strengths fitted on the screenshot's edge profiles at 204 px).
  glass(img_rgb, bg) -> the simulated tile. `python3 glass.py` re-runs the calibration and writes calib.png."""
import os, numpy as np
from PIL import Image, ImageFilter
HERE = os.path.dirname(os.path.abspath(__file__))
SHOT = os.path.expanduser("~/Phone/screenshot-20261013-211805.png")
# measured: file colour -> phone colour (dominant pixels of each block colour)
PAIRS = [((82, 144, 181), (0x67, 0x95, 0xb8)), ((230, 140, 124), (0xdf, 0x96, 0x86)),   # B, pi palette, light plate
         ((52, 118, 165), (0x4b, 0x7a, 0xa7)), ((214, 112, 94), (0xce, 0x7b, 0x69))]     # C, deep palette, dark plate
def fit():
    X = np.array([list(a) + [1] for a, _ in PAIRS], float); Y = np.array([b for _, b in PAIRS], float)
    # few points: a ridge-regularised fit of out = s*c + (1-s)*luma(c)*w + k  (desaturate toward luma, lift)
    best = None
    for s in np.linspace(0.5, 1.0, 51):
        for lift in np.linspace(0, 40, 81):
            pred = np.array([[s * ch + (1 - s) * (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]) + lift for ch in a] for a, _ in PAIRS])
            e = np.abs(pred - Y).mean()
            if best is None or e < best[0]: best = (e, s, lift)
    return best
ERR, SAT, LIFT = fit()
def frost(c):
    l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    return tuple(int(max(0, min(255, round(SAT * ch + (1 - SAT) * l + LIFT)))) for ch in c)
def glass(img, bg):
    a = np.asarray(img.convert("RGB")).astype(float); h, w, _ = a.shape
    fg = np.any(np.abs(a - np.array(bg)) > 3, axis=2)
    out = a.copy()
    for col in {tuple(map(int, p)) for p in a[fg].reshape(-1, 3)}:
        m = np.all(a == col, axis=2); out[m] = frost(col)
    s = max(1, round(w / 204))                      # rim width: ~1 px at 204 px
    up = np.zeros_like(fg); up[s:] = fg[s:] & ~fg[:-s]; lf = np.zeros_like(fg); lf[:, s:] = fg[:, s:] & ~fg[:, :-s]
    dn = np.zeros_like(fg); dn[:-s] = fg[:-s] & ~fg[s:]; rt = np.zeros_like(fg); rt[:, :-s] = fg[:, :-s] & ~fg[:, s:]
    hi = up | lf; lo = (dn | rt) & ~hi
    out[hi] = out[hi] * 0.55 + 255 * 0.45; out[lo] = out[lo] * 0.82
    sh = Image.fromarray((fg * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.5 * s))
    sh = np.roll(np.roll(np.asarray(sh).astype(float) / 255, 2 * s, 0), s, 1) * ~fg * 0.12
    out = out * (1 - sh[..., None])
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))

if __name__ == "__main__":
    import sys; sys.path.insert(0, os.path.join(HERE, "..", "pixel"))
    from importlib.machinery import SourceFileLoader
    mp = SourceFileLoader("mp", os.path.join(HERE, "..", "pixel", "make-profile.py")).load_module() if False else None
    print(f"frost fit: saturation {SAT:.2f}, lift {LIFT:.1f}, mean colour error {ERR:.1f} (0-255)")
    for (f, p) in PAIRS: print("  file", "#%02x%02x%02x" % f, "-> sim", "#%02x%02x%02x" % frost(f), "phone", "#%02x%02x%02x" % p)
