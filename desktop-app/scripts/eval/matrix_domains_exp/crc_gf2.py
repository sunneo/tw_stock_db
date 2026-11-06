import zlib, random
random.seed(5)
# 1) CRC32 一個位元組的更新是 GF(2) 上的仿射映射：state'(32) = A·state ⊕ B·byte(8) ⊕ c。從「黑箱」探測（單位向量）學出矩陣，再用矩陣跑整個字串
def step(state, byte):          # 黑箱（reflected CRC-32，無前後處理）
    s = state ^ byte
    for _ in range(8): s = (s >> 1) ^ (0xEDB88320 if s & 1 else 0)
    return s
bit = lambda v, i: (v >> i) & 1
c0 = step(0, 0)                                   # 仿射常數（這裡是 0）
cols_state = [step(1 << j, 0) ^ c0 for j in range(32)]   # A 的 32 欄
cols_byte = [step(0, 1 << j) ^ c0 for j in range(8)]     # B 的 8 欄
def apply(cols, v): 
    r = 0
    for j, c in enumerate(cols):
        if (v >> j) & 1: r ^= c                    # 矩陣×向量 over GF(2)：欄的 XOR
    return r
def crc_mat(data):
    s = 0xFFFFFFFF
    for b in data: s = apply(cols_state, s) ^ apply(cols_byte, b) ^ c0
    return s ^ 0xFFFFFFFF
ok = 0
for _ in range(500):
    d = bytes(random.randrange(256) for _ in range(random.randrange(0, 40)))
    ok += crc_mat(d) == zlib.crc32(d)
print('CRC32 GF(2) 矩陣（探測學出）對 zlib：', ok, '/ 500')
# 2) 整段一次做：n 位元組輸入 → 32 位元 CRC 是 (8n+32)→32 的 GF(2) 仿射映射。只給隨機「範例」用高斯消去法解出矩陣（合成），要幾筆範例？
def solve_gf2(rows, ys):   # rows: list of int bitvectors(length m), ys: list of int(32) ; 解 X(32×m) 使 X·row = y
    m = max(r.bit_length() for r in rows)
    # 增廣高斯消去，一個輸出位元一個方程組
    aug = [(r, y) for r, y in zip(rows, ys)]; piv = []
    basis = []  # (lead, row, y)
    for r, y in aug:
        for lead, br, by in basis:
            if (r >> lead) & 1: r ^= br; y ^= by
        if r: basis.append((r.bit_length() - 1, r, y))
        # 注意 basis 依加入順序化簡，足以判斷秩
    return len(basis)
n = 4
Xs = []; Ys = []
for _ in range(120):
    d = bytes(random.randrange(256) for _ in range(n))
    v = int.from_bytes(d, 'little') | (1 << (8 * n))   # 最後一位固定 1 代表仿射常數
    Xs.append(v); Ys.append(zlib.crc32(d))
rank = solve_gf2(Xs, Ys)
print('n=4 位元組：輸入維度 %d（含常數位），範例 120 筆，秩 %d → 秩==維度才能唯一解出矩陣' % (8 * n + 1, rank))
# 3) 反例：CRC 不是 count 半環的線性映射（要 GF(2)，不是整數加）
a, b = b'ab', b'cd'
print('整數加法下不線性：crc(a)+crc(b) == crc(a+b)?', (zlib.crc32(a) + zlib.crc32(b)) & 0xFFFFFFFF == zlib.crc32(a + b))
# 4) BMP/tar 欄位：定寬切片＋小端權重 = 整數線性映射（權重 256^i）
hdr = bytes(random.randrange(256) for _ in range(54)); W = [256 ** i for i in range(4)]
print('BMP 欄位 w=Σ byte_i·256^i 對 int.from_bytes：', all(sum(hdr[18 + i] * W[i] for i in range(4)) == int.from_bytes(hdr[18:22], 'little') for _ in range(1)))
