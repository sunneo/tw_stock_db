import zlib, random
random.seed(9)
# 固定霍夫曼（RFC1951）：碼長 0-143:8, 144-255:9, 256-279:7, 280-287:8；建「位元 trie」＝以位元為輸入字母的 DFA（含葉節點輸出）
lens = [8]*144 + [9]*112 + [7]*24 + [8]*8
bl = {}; 
for l in lens: bl[l] = bl.get(l, 0) + 1
code = 0; nxt = {}; 
for b in range(1, 10): code = (code + bl.get(b - 1, 0)) << 1; nxt[b] = code
trans = [[None, None]]; out = {}    # 狀態 → [δ(0), δ(1)]；out[state]＝符號
for sym, l in enumerate(lens):
    c = nxt[l]; nxt[l] += 1; s = 0
    for i in range(l - 1, -1, -1):
        b = (c >> i) & 1
        if trans[s][b] is None: trans.append([None, None]); trans[s][b] = len(trans) - 1
        s = trans[s][b]
    out[s] = sym
print('固定霍夫曼 DFA 狀態數：', len(trans), '（葉 %d）' % len(out))
def bits(data):
    for byte in data:
        for i in range(8): yield (byte >> i) & 1     # DEFLATE 位元序：低位先
def decode_literals(raw):
    it = bits(raw); next(it); next(it); next(it)     # BFINAL(1)+BTYPE(2)
    res = []; s = 0
    for b in it:
        s = trans[s][b]
        if s in out:
            sym = out[s]; s = 0
            if sym == 256: return bytes(res), 'end'
            if sym > 256: return bytes(res), 'match'   # 長度／距離：要 LZ77 視窗（陣列記憶體），DFA 做不到
            res.append(sym)
    return bytes(res), 'trunc'
ok = lit = 0
for _ in range(300):
    s = bytes(random.choice(b'abcdefghijklmnopqrstuvwxyz') for _ in range(random.randrange(1, 12)))
    c = zlib.compressobj(9, zlib.DEFLATED, -15, 9, zlib.Z_FIXED); raw = c.compress(s) + c.flush()
    d, st = decode_literals(raw)
    if st == 'end': lit += 1; ok += d == s
print('只有字面字元的串：DFA 解出與原文一致 %d / %d；其餘 %d 串含 LZ77 匹配（需視窗）' % (ok, lit, 300 - lit))
