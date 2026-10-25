#!/usr/bin/env python3
"""
从 PE 可执行文件中提取内嵌图标（RT_GROUP_ICON / RT_ICON），纯 Python 实现。

用法：
    python extract_pe_icon.py <exe路径> <输出目录>

用途：验证打包产物是否真的内嵌了应用图标。
本机 Add-Type 被安全策略拦截，无法用 System.Drawing.Icon，故自行解析 PE 资源表。
"""
import os
import struct
import sys

RT_ICON = 3
RT_GROUP_ICON = 14


def read_u16(data, off):
    return struct.unpack_from("<H", data, off)[0]


def read_u32(data, off):
    return struct.unpack_from("<I", data, off)[0]


def parse_pe(data):
    """返回 (sections, data_directory_offset)"""
    pe_off = read_u32(data, 0x3C)
    if data[pe_off:pe_off + 4] != b"PE\x00\x00":
        raise ValueError("不是有效的 PE 文件")
    num_sections = read_u16(data, pe_off + 6)
    opt_size = read_u16(data, pe_off + 20)
    opt_off = pe_off + 24
    magic = read_u16(data, opt_off)
    # 数据目录在可选头里：PE32+ 偏移 112，PE32 偏移 96
    ddir_off = opt_off + (112 if magic == 0x20B else 96)
    num_dd = read_u32(data, ddir_off - 4)

    sections = []
    sec_off = opt_off + opt_size
    for i in range(num_sections):
        base = sec_off + i * 40
        name = data[base:base + 8].rstrip(b"\x00").decode("ascii", "replace")
        vsize = read_u32(data, base + 8)
        vaddr = read_u32(data, base + 12)
        rawsize = read_u32(data, base + 16)
        rawptr = read_u32(data, base + 20)
        sections.append({
            "name": name, "vaddr": vaddr, "vsize": vsize,
            "rawsize": rawsize, "rawptr": rawptr,
        })
    return sections, ddir_off, num_dd


def rva_to_offset(rva, sections):
    for s in sections:
        if s["vaddr"] <= rva < s["vaddr"] + max(s["vsize"], s["rawsize"]):
            return s["rawptr"] + (rva - s["vaddr"])
    return None


def parse_resource_dir(data, base_off, dir_off, depth=0, prefix=()):
    """递归解析资源目录，返回 [(type_id, name_id, lang, data_offset, size)]"""
    results = []
    num_named = read_u16(data, dir_off + 12)
    num_id = read_u16(data, dir_off + 14)
    entry_off = dir_off + 16
    for i in range(num_named + num_id):
        e = entry_off + i * 8
        name_or_id = read_u32(data, e)
        offset_to_data = read_u32(data, e + 4)
        is_dir = bool(offset_to_data & 0x80000000)
        child_off = base_off + (offset_to_data & 0x7FFFFFFF)
        if is_dir:
            results.extend(parse_resource_dir(data, base_off, child_off, depth + 1, prefix + (name_or_id,)))
        else:
            # 数据项：RVA(4) + size(4) + codepage(4) + reserved(4)
            data_rva = read_u32(data, child_off)
            data_size = read_u32(data, child_off + 4)
            results.append((prefix + (name_or_id,), data_rva, data_size))
    return results


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    exe_path = sys.argv[1]
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    with open(exe_path, "rb") as fh:
        data = fh.read()

    sections, ddir_off, num_dd = parse_pe(data)
    if num_dd <= 2:
        print("无资源目录")
        return 1

    res_rva = read_u32(data, ddir_off + 2 * 8)
    res_size = read_u32(data, ddir_off + 2 * 8 + 4)
    if not res_rva:
        print("exe 内无资源段（.rsrc）")
        return 1

    res_base = rva_to_offset(res_rva, sections)
    if res_base is None:
        print("无法定位资源段")
        return 1

    entries = parse_resource_dir(data, res_base, res_base)
    icons = []
    groups = []
    for path, rva, size in entries:
        if len(path) >= 1 and path[0] == RT_ICON:
            icons.append((path, rva, size))
        elif len(path) >= 1 and path[0] == RT_GROUP_ICON:
            groups.append((path, rva, size))

    print(f"资源段: RVA={res_rva} 大小={res_size}")
    print(f"RT_ICON 条目: {len(icons)}")
    print(f"RT_GROUP_ICON 条目: {len(groups)}")

    if not groups:
        print("结论: 未找到图标组，exe 不含应用图标")
        return 2

    # 逐个导出 RT_ICON 数据（可能是 PNG 或 DIB）
    saved = 0
    for idx, (path, rva, size) in enumerate(sorted(icons, key=lambda x: x[0])):
        off = rva_to_offset(rva, sections)
        if off is None:
            continue
        blob = data[off:off + size]
        is_png = blob[:8] == b"\x89PNG\r\n\x1a\n"
        ext = "png" if is_png else "bmp"
        name = "_".join(str(p) for p in path)
        out = os.path.join(out_dir, f"icon_{name}.{ext}")
        with open(out, "wb") as fh:
            fh.write(blob)
        saved += 1
        print(f"  导出 {name}.{ext}  {size} 字节  {'(PNG)' if is_png else '(DIB)'}")

    # 解析组目录，列出各尺寸
    for path, rva, size in groups:
        off = rva_to_offset(rva, sections)
        if off is None:
            continue
        reserved = read_u16(data, off)
        gtype = read_u16(data, off + 2)
        count = read_u16(data, off + 4)
        print(f"图标组: 类型={gtype} 条目数={count}")
        for i in range(count):
            e = off + 6 + i * 14
            w = data[e]
            h = data[e + 1]
            planes = read_u16(data, e + 4)
            bpp = read_u16(data, e + 6)
            dsize = read_u32(data, e + 8)
            nid = read_u16(data, e + 12)
            dims = f"{w or 256}x{h or 256}"
            print(f"    {dims}  {bpp}bpp  {dsize} 字节  -> icon id {nid}")

    print(f"结论: exe 已内嵌 {saved} 个图标资源")
    return 0


if __name__ == "__main__":
    sys.exit(main())
