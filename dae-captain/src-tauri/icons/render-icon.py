#!/usr/bin/env python3
"""Render the Dae Captain placeholder icon: a light 'D' on a dark rounded square.

Pure stdlib (struct + zlib) — no Pillow, no converters. Re-run after editing:
    python3 render-icon.py
Farid will design the real icon later; this keeps the build working until then.
"""
import struct
import zlib

SIZE = 128
BG = (18, 20, 38)      # dark navy
FG = (196, 205, 255)   # light periwinkle


def rounded_mask(x, y, r=24):
    # inside rounded rect?
    cx = min(max(x, r), SIZE - 1 - r)
    cy = min(max(y, r), SIZE - 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r or (
        r <= x < SIZE - r or r <= y < SIZE - r
    )


def in_d(x, y):
    # Bold 'D': vertical bar + bowl approximated from a thick stroked path.
    # Bar: x in [34,52], y in [28,100]
    if 34 <= x <= 52 and 28 <= y <= 100:
        return True
    # Bowl: ring centered at (52,64), outer rx=42 ry=36, thickness 18,
    # only the right half (x >= 46).
    if x < 44:
        return False
    nx = (x - 52) / 42.0
    ny = (y - 64) / 36.0
    d = nx * nx + ny * ny
    return 0.55 <= d <= 1.0


def main():
    px = bytearray()
    for y in range(SIZE):
        px.append(0)  # filter byte
        for x in range(SIZE):
            if not rounded_mask(x, y):
                px.extend((0, 0, 0, 0))
            elif in_d(x, y):
                px.extend((*FG, 255))
            else:
                px.extend((*BG, 255))
    raw = bytes(px)
    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )
    with open("icon.png", "wb") as f:
        f.write(png)
    print(f"wrote icon.png ({len(png)} bytes)")


if __name__ == "__main__":
    main()
