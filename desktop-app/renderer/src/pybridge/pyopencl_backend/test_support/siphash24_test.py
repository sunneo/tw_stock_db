# SipHash 核心的驗證：SipHash-2-4 對論文附錄 A 的官方測試向量（key=00..0f，輸入 00..0e 共 15 位元組 → 0xa129ca6149be45e5），
# 以及空輸入的官方向量（0x726fdb47dd0e0e31）。用法：python3 -I siphash24_test.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import siphash24 as S
key = bytes(range(16))
ok = fail = 0
def chk(name, got, want):
    global ok, fail
    if got == want: ok += 1
    else: fail += 1; print("FAIL", name, hex(got), hex(want))
chk("2-4 論文向量 15 位元組", S.siphash(bytes(range(15)), key, 2, 4), 0xa129ca6149be45e5)
chk("2-4 空輸入", S.siphash(b"", key, 2, 4), 0x726fdb47dd0e0e31)
chk("update 分段等於一次給", S.siphash13(b"ab").update(b"cd").intdigest(), S.siphash13(b"abcd").intdigest())
chk("hexdigest 長度", len(S.siphash13(b"x").hexdigest()), 16)
chk("不同輸入不同雜湊", int(S.siphash13(b"a").intdigest() != S.siphash13(b"b").intdigest()), 1)
chk("copy 之後互不影響", S.siphash13(b"a").copy().update(b"b").intdigest(), S.siphash13(b"ab").intdigest())
print("%d passed, %d failed" % (ok, fail)); sys.exit(1 if fail else 0)
