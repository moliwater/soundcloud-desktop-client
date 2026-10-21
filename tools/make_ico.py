#!/usr/bin/env python3
"""Build a Windows .ico from a large PNG: BMP frames for small sizes (best
compatibility), PNG for 256x256. usage: make_ico.py SRC.png OUT.ico [sizes...]"""
import io, struct, sys
from PIL import Image

def bmp_frame(img):
    w, h = img.size
    px = img.convert('RGBA').transpose(Image.FLIP_TOP_BOTTOM).tobytes('raw', 'BGRA')
    row = ((w + 31) // 32) * 4
    mask = bytearray(row * h)  # all zero: alpha channel decides transparency
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(px) + len(mask), 0, 0, 0, 0)
    return header + px + bytes(mask)

def main(src, out, sizes):
    base = Image.open(src).convert('RGBA')
    frames = []
    for s in sizes:
        img = base.resize((s, s), Image.LANCZOS)
        if s >= 256:
            buf = io.BytesIO(); img.save(buf, 'PNG'); data = buf.getvalue()
        else:
            data = bmp_frame(img)
        frames.append((s, data))
    head = struct.pack('<HHH', 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries, blobs = b'', b''
    for s, data in frames:
        dim = 0 if s >= 256 else s
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data); blobs += data
    open(out, 'wb').write(head + entries + blobs)

if __name__ == '__main__':
    sizes = [int(x) for x in sys.argv[3:]] or [16, 20, 24, 32, 40, 48, 64, 128, 256]
    main(sys.argv[1], sys.argv[2], sizes)
