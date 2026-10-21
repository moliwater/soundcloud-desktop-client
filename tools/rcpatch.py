#!/usr/bin/env python3
"""Replace the icon and version strings of a Windows .exe from Linux/macOS.

Used to brand the stock electron.exe as Soundfast.exe when building the
portable Windows release without Windows or Wine. It leaves every existing
section untouched: the rebuilt resource tree is appended as a new section and
the resource data directory is pointed at it.

usage: rcpatch.py IN.exe OUT.exe ICON.ico --version 1.0.0 --name Soundfast \
         [--description ...] [--company ...] [--copyright ...]
"""
import argparse
import struct

RT_ICON, RT_GROUP_ICON, RT_VERSION = 3, 14, 16
LANG_EN_US = 1033


def align(n, a):
    return (n + a - 1) // a * a


class PE:
    def __init__(self, data):
        self.d = bytearray(data)
        d = self.d
        if d[:2] != b'MZ':
            raise ValueError('not an MZ file')
        self.pe = struct.unpack_from('<I', d, 0x3C)[0]
        if d[self.pe:self.pe + 4] != b'PE\0\0':
            raise ValueError('not a PE file')
        self.nsec_off = self.pe + 6
        self.nsec = struct.unpack_from('<H', d, self.nsec_off)[0]
        optsz = struct.unpack_from('<H', d, self.pe + 20)[0]
        self.opt = self.pe + 24
        magic = struct.unpack_from('<H', d, self.opt)[0]
        if magic != 0x20B:
            raise ValueError('only PE32+ (64-bit) is supported')
        self.dd = self.opt + 112
        self.sec = self.opt + optsz
        self.sec_align = struct.unpack_from('<I', d, self.opt + 32)[0]
        self.file_align = struct.unpack_from('<I', d, self.opt + 36)[0]
        self.size_of_headers = struct.unpack_from('<I', d, self.opt + 60)[0]

    def sections(self):
        out = []
        for i in range(self.nsec):
            o = self.sec + 40 * i
            vs, va, rs, rp = struct.unpack_from('<IIII', self.d, o + 8)
            out.append(dict(off=o, name=bytes(self.d[o:o + 8]).rstrip(b'\0'), vs=vs, va=va, rs=rs, rp=rp,
                            ch=struct.unpack_from('<I', self.d, o + 36)[0]))
        return out

    def rva_to_off(self, rva):
        for s in self.sections():
            if s['va'] <= rva < s['va'] + max(s['vs'], s['rs']):
                return rva - s['va'] + s['rp']
        raise ValueError(f'RVA {rva:#x} not in any section')

    def data_dir(self, i):
        return struct.unpack_from('<II', self.d, self.dd + 8 * i)


def read_resources(pe):
    """Return {type: {name: {lang: bytes}}}; only integer IDs are expected."""
    rva, _size = pe.data_dir(2)
    base = pe.rva_to_off(rva)
    d = pe.d

    def entries(off):
        named, ids = struct.unpack_from('<HH', d, off + 12)
        for i in range(named + ids):
            name, target = struct.unpack_from('<II', d, off + 16 + 8 * i)
            if name & 0x80000000:
                soff = base + (name & 0x7FFFFFFF)
                ln = struct.unpack_from('<H', d, soff)[0]
                name = d[soff + 2:soff + 2 + 2 * ln].decode('utf-16-le')
            yield name, target

    tree = {}
    for t, t_tgt in entries(base):
        assert t_tgt & 0x80000000
        for n, n_tgt in entries(base + (t_tgt & 0x7FFFFFFF)):
            assert n_tgt & 0x80000000
            for lang, l_tgt in entries(base + (n_tgt & 0x7FFFFFFF)):
                assert not l_tgt & 0x80000000
                drva, dsize = struct.unpack_from('<II', d, base + l_tgt)
                doff = pe.rva_to_off(drva)
                tree.setdefault(t, {}).setdefault(n, {})[lang] = bytes(d[doff:doff + dsize])
    return tree


def build_resources(tree, base_rva):
    """Serialize {type: {name: {lang: bytes}}} into a .rsrc section image."""
    def sort_keys(keys):
        named = sorted(k for k in keys if isinstance(k, str))
        ids = sorted(k for k in keys if isinstance(k, int))
        return named, ids

    # Layout: all directories, then name strings, then data entries, then data.
    dirs = []  # (path, keys)
    dirs.append(((), tree))
    for t in sum(sort_keys(tree.keys()), []):
        dirs.append(((t,), tree[t]))
    for t in sum(sort_keys(tree.keys()), []):
        for n in sum(sort_keys(tree[t].keys()), []):
            dirs.append(((t, n), tree[t][n]))

    dir_off = {}
    pos = 0
    for path, node in dirs:
        dir_off[path] = pos
        pos += 16 + 8 * len(node)

    str_off = {}
    for path, node in dirs:
        for k in node:
            if isinstance(k, str) and k not in str_off:
                str_off[k] = pos
                pos += 2 + 2 * len(k)
    pos = align(pos, 8)

    leaves = []
    for t in sum(sort_keys(tree.keys()), []):
        for n in sum(sort_keys(tree[t].keys()), []):
            for lang in sum(sort_keys(tree[t][n].keys()), []):
                leaves.append((t, n, lang))
    entry_off = {}
    for leaf in leaves:
        entry_off[leaf] = pos
        pos += 16

    data_off = {}
    for leaf in leaves:
        pos = align(pos, 8)
        data_off[leaf] = pos
        t, n, lang = leaf
        pos += len(tree[t][n][lang])
    total = align(pos, 8)

    out = bytearray(total)
    for path, node in dirs:
        named, ids = sort_keys(node.keys())
        o = dir_off[path]
        struct.pack_into('<IIHHHH', out, o, 0, 0, 4, 0, len(named), len(ids))
        for i, k in enumerate(named + ids):
            name_field = (0x80000000 | str_off[k]) if isinstance(k, str) else k
            child = path + (k,)
            if len(child) < 3:
                target = 0x80000000 | dir_off[child]
            else:
                target = entry_off[child]
            struct.pack_into('<II', out, o + 16 + 8 * i, name_field, target)
    for k, o in str_off.items():
        enc = k.encode('utf-16-le')
        struct.pack_into('<H', out, o, len(k))
        out[o + 2:o + 2 + len(enc)] = enc
    for leaf in leaves:
        t, n, lang = leaf
        blob = tree[t][n][lang]
        struct.pack_into('<IIII', out, entry_off[leaf], base_rva + data_off[leaf], len(blob), 0, 0)
        out[data_off[leaf]:data_off[leaf] + len(blob)] = blob
    return bytes(out)


def ico_to_resources(ico_bytes):
    reserved, typ, count = struct.unpack_from('<HHH', ico_bytes, 0)
    if reserved != 0 or typ != 1:
        raise ValueError('not an .ico file')
    images, group = [], bytearray(struct.pack('<HHH', 0, 1, count))
    for i in range(count):
        w, h, colors, res, planes, bpp, size, offset = struct.unpack_from('<BBBBHHII', ico_bytes, 6 + 16 * i)
        images.append(ico_bytes[offset:offset + size])
        group += struct.pack('<BBBBHHIH', w, h, colors, res, planes, bpp, size, i + 1)
    return images, bytes(group)


def version_info(version, strings):
    parts = [int(p) for p in (version.split('.') + ['0', '0', '0'])[:4]]
    ms = (parts[0] << 16) | parts[1]
    ls = (parts[2] << 16) | parts[3]
    fixed = struct.pack('<13I', 0xFEEF04BD, 0x00010000, ms, ls, ms, ls, 0x3F, 0, 0x00040004, 1, 0, 0, 0)

    def node(key, value=b'', wtype=0, children=(), value_len=None):
        b = bytearray(6)
        b += (key + '\0').encode('utf-16-le')
        while len(b) % 4:
            b += b'\0'
        b += value
        for c in children:
            while len(b) % 4:
                b += b'\0'
            b += c
        vlen = len(value) if value_len is None else value_len
        struct.pack_into('<HHH', b, 0, len(b), vlen, wtype)
        return bytes(b)

    def string(k, v):
        return node(k, (v + '\0').encode('utf-16-le'), 1, value_len=len(v) + 1)

    table = node('040904b0', b'', 1, [string(k, v) for k, v in strings.items()])
    sfi = node('StringFileInfo', b'', 1, [table])
    var = node('Translation', struct.pack('<HH', 0x0409, 0x04B0), 0)
    vfi = node('VarFileInfo', b'', 1, [var])
    return node('VS_VERSION_INFO', fixed, 0, [sfi, vfi])


def pe_checksum(data, checksum_off):
    """Standard PE checksum (the checksum field itself must already be zero)."""
    n = len(data)
    padded = data + (b'\0' if n % 2 else b'')
    try:
        import numpy as np
        total = int(np.frombuffer(padded, dtype='<u2').sum(dtype=np.uint64))
    except ImportError:
        total = sum(struct.unpack(f'<{len(padded) // 2}H', padded))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return (total + n) & 0xFFFFFFFF


def patch(src, dst, ico, version, name, description, company, copyright_):
    pe = PE(open(src, 'rb').read())
    if pe.data_dir(4) != (0, 0):
        raise ValueError('signed executables are not supported (strip the signature first)')
    tree = read_resources(pe)

    group_name = sorted(tree.get(RT_GROUP_ICON, {1: None}).keys(), key=str)[0]
    for t in (RT_ICON, RT_GROUP_ICON, RT_VERSION):
        tree.pop(t, None)
    images, group = ico_to_resources(open(ico, 'rb').read())
    tree[RT_ICON] = {i + 1: {LANG_EN_US: img} for i, img in enumerate(images)}
    tree[RT_GROUP_ICON] = {group_name: {LANG_EN_US: group}}
    exe = f'{name}.exe'
    tree[RT_VERSION] = {1: {LANG_EN_US: version_info(version, {
        'CompanyName': company,
        'FileDescription': description,
        'FileVersion': version,
        'InternalName': exe,
        'LegalCopyright': copyright_,
        'OriginalFilename': exe,
        'ProductName': name,
        'ProductVersion': version,
    })}}

    secs = pe.sections()
    last = max(secs, key=lambda s: s['va'])
    new_va = align(last['va'] + max(last['vs'], last['rs']), pe.sec_align)
    rsrc = build_resources(tree, new_va)
    raw_size = align(len(rsrc), pe.file_align)
    file_end = max(s['rp'] + s['rs'] for s in secs)
    if file_end != len(pe.d):
        raise ValueError('file has overlay data after the last section; refusing to patch')
    raw_ptr = align(len(pe.d), pe.file_align)

    hdr = pe.sec + 40 * pe.nsec
    first_raw = min(s['rp'] for s in secs if s['rs'])
    if hdr + 40 > min(pe.size_of_headers, first_raw) or any(pe.d[hdr:hdr + 40]):
        raise ValueError('no room for another section header')

    old = next((s for s in secs if s['name'] == b'.rsrc'), None)
    if old:
        pe.d[old['off']:old['off'] + 8] = b'.rsrc_o\0'
    characteristics = old['ch'] if old else 0x40000040
    struct.pack_into('<8sIIIIIIHHI', pe.d, hdr, b'.rsrc', len(rsrc), new_va, raw_size, raw_ptr, 0, 0, 0, 0,
                     characteristics)
    struct.pack_into('<H', pe.d, pe.nsec_off, pe.nsec + 1)
    struct.pack_into('<II', pe.d, pe.dd + 8 * 2, new_va, len(rsrc))
    struct.pack_into('<I', pe.d, pe.opt + 56, align(new_va + len(rsrc), pe.sec_align))  # SizeOfImage
    init = struct.unpack_from('<I', pe.d, pe.opt + 8)[0]
    struct.pack_into('<I', pe.d, pe.opt + 8, init + raw_size)  # SizeOfInitializedData

    pe.d += b'\0' * (raw_ptr - len(pe.d))
    pe.d += rsrc + b'\0' * (raw_size - len(rsrc))
    csum_off = pe.opt + 64
    struct.pack_into('<I', pe.d, csum_off, 0)
    struct.pack_into('<I', pe.d, csum_off, pe_checksum(bytes(pe.d), csum_off))
    open(dst, 'wb').write(pe.d)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('ico')
    ap.add_argument('--version', required=True)
    ap.add_argument('--name', required=True)
    ap.add_argument('--description')
    ap.add_argument('--company', default='')
    ap.add_argument('--copyright', default='')
    a = ap.parse_args()
    patch(a.src, a.dst, a.ico, a.version, a.name, a.description or a.name, a.company, a.copyright)
    print(f'wrote {a.dst}')
