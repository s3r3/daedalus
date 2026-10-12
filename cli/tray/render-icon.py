#!/usr/bin/env python3
"""Render Daedalus/cli/assets/tray-icon.png from the placeholder "D" design.

Pure stdlib (struct + zlib) — no Pillow, no rsvg, no network. The PNG is a
build artifact committed next to the SVG source of truth
(Daedalus/cli/assets/tray-icon.svg): AppIndicator needs a raster icon, and
this keeps tray startup dependency-free. When Farid replaces the SVG with
his final design, re-run this script (adapt the drawing) and commit the
new PNG alongside it.
"""

import math
import struct
import sys
import zlib
from pathlib import Path

SIZE = 64
BG = (0x14, 0x10, 0x1F, 0xFF)      # #14101f
ACCENT = (0x6B, 0x50, 0xFF, 0xFF)  # #6b50ff


def blend(dst, src):
    dr, dg, db, da = dst
    sr, sg, sb, sa = src
    a = sa / 255.0
    return (
        round(sr * a + dr * (1 - a)),
        round(sg * a + dg * (1 - a)),
        round(sb * a + db * (1 - a)),
        255,
    )


class Canvas:
    def __init__(self, size):
        self.size = size
        self.px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]

    def dot(self, x, y, color):
        x, y = round(x), round(y)
        if 0 <= x < self.size and 0 <= y < self.size:
            self.px[y][x] = blend(self.px[y][x], color)

    def disc(self, cx, cy, r, color):
        r2 = r * r
        for y in range(math.floor(cy - r), math.ceil(cy + r) + 1):
            for x in range(math.floor(cx - r), math.ceil(cx + r) + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
                    self.dot(x, y, color)

    def hline(self, x0, x1, y, color):
        for x in range(round(x0), round(x1) + 1):
            self.dot(x, y, color)

    def rect(self, x0, y0, x1, y1, color):
        for y in range(round(y0), round(y1) + 1):
            self.hline(x0, x1, y, color)

    def rounded_rect(self, x0, y0, x1, y1, radius, color):
        self.rect(x0 + radius, y0, x1 - radius, y1, color)
        self.rect(x0, y0 + radius, x1, y1 - radius, color)
        for cx, cy in (
            (x0 + radius, y0 + radius),
            (x1 - radius, y0 + radius),
            (x0 + radius, y1 - radius),
            (x1 - radius, y1 - radius),
        ):
            self.disc(cx, cy, radius, color)

    def ring_arc(self, cx, cy, r, width, a0, a1, color):
        steps = max(8, int(abs(a1 - a0) * r / 2))
        for i in range(steps + 1):
            a = a0 + (a1 - a0) * i / steps
            self.disc(cx + r * math.cos(a), cy + r * math.sin(a), width / 2, color)


def write_png(path, canvas):
    size = canvas.size
    raw = bytearray()
    for row in canvas.px:
        raw.append(0)  # filter type 0 (None)
        for r, g, b, a in row:
            raw.extend((r, g, b, a))

    def chunk(ctype, data):
        out = struct.pack(">I", len(data)) + ctype + data
        out += struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)
        return out

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def main():
    c = Canvas(SIZE)
    # Background: rounded rect like the SVG (rx=14 on 64px).
    c.rounded_rect(2, 2, 61, 61, 14, BG)
    # Border: rounded-rect outline, ~2px, accent.
    c.ring_arc(16, 16, 14, 2, math.pi, 1.5 * math.pi, ACCENT)
    c.ring_arc(47, 16, 14, 2, 1.5 * math.pi, 2 * math.pi, ACCENT)
    c.ring_arc(16, 47, 14, 2, 0.5 * math.pi, math.pi, ACCENT)
    c.ring_arc(47, 47, 14, 2, 0, 0.5 * math.pi, ACCENT)
    c.rect(16, 2, 47, 3, ACCENT)
    c.rect(16, 60, 47, 61, ACCENT)
    c.rect(2, 16, 3, 47, ACCENT)
    c.rect(60, 16, 61, 47, ACCENT)
    # Bold "D": stem + right-half bowl, accent.
    c.rect(20, 18, 27, 46, ACCENT)
    c.ring_arc(27, 32, 14, 8, -math.pi / 2, math.pi / 2, ACCENT)

    out = Path(__file__).resolve().parent.parent / "assets" / "tray-icon.png"
    write_png(out, c)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    sys.exit(main())
