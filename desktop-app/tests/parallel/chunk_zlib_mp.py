"""檔案壓縮的區塊平行：把輸入切成固定大小的區塊，每個區塊獨立用 zlib 壓縮（無相依），
用多行程依排程分配：block（連續切塊）、cyclic（第 i 塊給 i mod p）、dynamic（工作佇列先到先做）。
輸出依區塊編號組回，所以三種排程的位元組輸出必須完全相同；解壓後要還原原始資料。
用法：python3 chunk_zlib_mp.py <mode> <procs> <size_mib> <chunk_kib>   mode：seq | block | cyclic | dynamic
stdout 三行：sha256 of 壓縮輸出、壓縮後大小、解壓還原是否相同；耗時寫到 stderr。"""
import hashlib, multiprocessing as mp, struct, sys, time, zlib

def make_input(size):
    # 確定性的合成資料：文字樣的重複片段＋偽隨機位元組（不同區塊壓縮比不同，才看得出負載不均）
    out = bytearray(); s = 12345
    words = [b"alpha ", b"beta ", b"gamma\n", b"delta ", b"epsilon ", b"0123456789 "]
    while len(out) < size:
        s = (s * 1103515245 + 12345) & 0x7FFFFFFF
        if (s >> 16) % 5 == 0:
            out += bytes((s >> (i * 4)) & 0xFF for i in range(16))
        else:
            out += words[(s >> 8) % len(words)] * ((s >> 4) % 7 + 1)
    return bytes(out[:size])

def work(items):
    # items：這個行程負責的 (編號, 區塊) 清單；只傳自己的區塊，避免整份資料被每個行程都序列化一次
    return [(i, zlib.compress(c, 6)) for i, c in items]

def assign(mode, n, p):
    if mode == "block":
        q, r = divmod(n, p); out = []; s = 0
        for t in range(p):
            ln = q + (1 if t < r else 0); out.append(list(range(s, s + ln))); s += ln
        return out
    if mode == "cyclic":
        return [list(range(t, n, p)) for t in range(p)]
    raise ValueError(mode)

def run_dynamic(chunks, p):
    # 工作佇列：每個行程一次拿一塊，先做完先拿；結果仍依編號組回
    with mp.Pool(p) as pool:
        res = pool.map(zlib.compress, chunks, chunksize=1)  # chunksize=1 等同 dynamic,1
    return list(enumerate(res))

def main():
    mode, p, mib, kib = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
    data = make_input(int(mib * 1024 * 1024)); cs = kib * 1024
    chunks = [data[i:i + cs] for i in range(0, len(data), cs)]
    t0 = time.perf_counter()
    if mode == "seq":
        pairs = [(i, zlib.compress(c, 6)) for i, c in enumerate(chunks)]
    elif mode == "dynamic":
        pairs = run_dynamic(chunks, p)
    else:
        parts = assign(mode, len(chunks), p)
        with mp.Pool(p) as pool:
            got = pool.map(work, [[(i, chunks[i]) for i in idx] for idx in parts])
        pairs = [x for g in got for x in g]
    pairs.sort(key=lambda x: x[0])
    t1 = time.perf_counter()
    # 框架格式：每塊前面是 4 位元組的長度（大端）
    blob = b"".join(struct.pack(">I", len(z)) + z for _, z in pairs)
    back = bytearray(); pos = 0
    while pos < len(blob):
        (ln,) = struct.unpack(">I", blob[pos:pos + 4]); back += zlib.decompress(blob[pos + 4:pos + 4 + ln]); pos += 4 + ln
    print(hashlib.sha256(blob).hexdigest()); print(len(blob)); print("roundtrip_ok" if bytes(back) == data else "roundtrip_BAD")
    print("耗時 %.3f 秒 行程數 %d" % (t1 - t0, p), file=sys.stderr)

if __name__ == "__main__":
    main()
