"""Bake the Milky Way panorama for the app: 8K JPG -> 4K WebP, already stretched.

The source is very dark (the faint band sits on 8-bit levels 1..20), and the shader used to
lift it x12 after subtracting a floor, so every 8-bit step (and every compression blotch)
became a visible contour. Here, in floating point: average 2x2 down to 4K, split into a
smooth glow and the detail (stars), smooth the floor with a soft knee, drop the
quantisation noise from the detail, lift, and store gamma-encoded with dither so the dark
range gets most of the code values.

Source: the 8K original from Solar System Scope (CC BY 4.0), also in git history:
    git show 8ee6958~1:public/textures/sky/milky_way_8k.jpg > milky_way_8k.jpg
Run (numpy, Pillow):
    python scripts/bake_sky.py milky_way_8k.jpg public/textures/sky/milky_way.webp 88

Decode in the shader: S = K * pow(T, GAMMA)   (S = the old max(c - 0.006, 0) * 12)
"""
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
FLOOR, GAIN, K, GAMMA = 0.006, 12.0, 6.0, 2.2

src, out = sys.argv[1], sys.argv[2]
x8 = np.asarray(Image.open(src).convert('RGB'))
h, w = x8.shape[0] // 2, x8.shape[1] // 2
x = x8.reshape(h, 2, w, 2, 3).astype(np.float32).mean(axis=(1, 3)) / 255.0
del x8


def box(a, r, axis, wrap):
    """Box blur of radius r along an axis (wrapping round for longitude)."""
    n = a.shape[axis]
    if wrap:
        a = np.concatenate([a.take(range(n - r, n), axis), a, a.take(range(r), axis)], axis)
    else:
        a = np.concatenate([a.take([0] * r, axis), a, a.take([n - 1] * r, axis)], axis)
    c = np.cumsum(a, axis=axis, dtype=np.float64)
    c = np.concatenate([np.zeros_like(c.take([0], axis)), c], axis)
    hi = c.take(range(2 * r + 1, n + 2 * r + 1), axis)
    lo = c.take(range(0, n), axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(a, r):
    for _ in range(3):  # three box passes ~ a Gaussian
        a = box(a, r, 1, True)
        a = box(a, r, 0, False)
    return a


glow = blur(x, 2)
detail = x - glow
# Quantisation and JPEG noise is a level or two: core it away, keep the stars.
core = 1.6 / 255.0
detail = np.sign(detail) * np.maximum(np.abs(detail) - core, 0.0)
# Soft knee instead of a hard max(v, 0): no sharp edge where the glow meets the floor.
v = glow - FLOOR
knee = 0.0025
glow_s = 0.5 * (v + np.sqrt(v * v + knee * knee)) - 0.5 * (np.sqrt(FLOOR * FLOOR + knee * knee) - FLOOR)
s = np.maximum(glow_s + detail, 0.0) * GAIN

t = np.clip(s / K, 0.0, 1.0) ** (1.0 / GAMMA)
rng = np.random.default_rng(7)
t = t * 255.0 + rng.uniform(-0.5, 0.5, t.shape).astype(np.float32)
img = Image.fromarray(np.clip(np.rint(t), 0, 255).astype(np.uint8), 'RGB')
img.save(out, 'WEBP', quality=int(sys.argv[3]) if len(sys.argv) > 3 else 86, method=6)
print('saved', out, img.size)
