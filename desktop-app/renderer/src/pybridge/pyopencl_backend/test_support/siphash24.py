# -*- coding: utf-8 -*-
"""siphash24 的純 Python 後備（只給測試與之後的 Pyodide 路徑評估用）。

真的 `siphash24` 是 C 擴充套件，pytools 在 import 時就需要它（`from siphash24 import siphash13`），而 pyopencl 一定會載入 pytools。
這裡只實作 pytools／pyopencl 用到的介面：siphash13(data=b"", key=16 位元組) 回傳有 update／digest／hexdigest／intdigest／copy 的物件。
pyopencl 只用它算快取鍵（不跨行程比對、不與真套件交換雜湊值），所以只要同一個程式內一致即可；但核心的 SipHash 演算法仍照規格實作，
並用 SipHash 論文附錄的官方測試向量（SipHash-2-4）驗證過（見 siphash24_test.py），1-3 只是輪數不同。
是否要在產品（Pyodide）路徑出貨這個後備，是使用者要決定的事（DESIGN.pyopencl.md §7.2）。"""
import struct

_M = 0xFFFFFFFFFFFFFFFF


def _rotl(x, b):
    return ((x << b) | (x >> (64 - b))) & _M


def siphash(data, key=b"\0" * 16, c=1, d=3):
    """SipHash-c-d，回傳 64 位元整數。"""
    if len(key) != 16:
        raise ValueError("key 要是 16 位元組")
    k0, k1 = struct.unpack("<QQ", key)
    v0, v1 = k0 ^ 0x736f6d6570736575, k1 ^ 0x646f72616e646f6d
    v2, v3 = k0 ^ 0x6c7967656e657261, k1 ^ 0x7465646279746573

    def rounds(n, v0, v1, v2, v3):
        for _ in range(n):
            v0 = (v0 + v1) & _M; v1 = _rotl(v1, 13); v1 ^= v0; v0 = _rotl(v0, 32)
            v2 = (v2 + v3) & _M; v3 = _rotl(v3, 16); v3 ^= v2
            v0 = (v0 + v3) & _M; v3 = _rotl(v3, 21); v3 ^= v0
            v2 = (v2 + v1) & _M; v1 = _rotl(v1, 17); v1 ^= v2; v2 = _rotl(v2, 32)
        return v0, v1, v2, v3

    n = len(data)
    end = n - (n % 8)
    for i in range(0, end, 8):
        m, = struct.unpack_from("<Q", data, i)
        v3 ^= m
        v0, v1, v2, v3 = rounds(c, v0, v1, v2, v3)
        v0 ^= m
    last = (n & 0xFF) << 56
    for j, byte in enumerate(data[end:]):
        last |= byte << (8 * j)
    v3 ^= last
    v0, v1, v2, v3 = rounds(c, v0, v1, v2, v3)
    v0 ^= last
    v2 ^= 0xFF
    v0, v1, v2, v3 = rounds(d, v0, v1, v2, v3)
    return v0 ^ v1 ^ v2 ^ v3


class _Hash(object):
    digest_size = 8
    block_size = 8

    def __init__(self, data=b"", key=b"\0" * 16, c=1, d=3, name="siphash13"):
        self._buf, self._key, self._c, self._d, self.name = bytearray(), key, c, d, name
        self.update(data)

    def update(self, data):
        self._buf += bytes(data)
        return self

    def copy(self):
        h = _Hash(bytes(self._buf), self._key, self._c, self._d, self.name)
        return h

    def intdigest(self):
        return siphash(bytes(self._buf), self._key, self._c, self._d)

    def digest(self):
        return struct.pack("<Q", self.intdigest())

    def hexdigest(self):
        return self.digest().hex()


class siphash13(_Hash):
    """真的 siphash24.siphash13 是 C 型別（類別）；pytools 把它放在類別屬性上當 new_hash，所以這裡也必須是類別（函式會被綁成方法、收到 self）。"""

    def __init__(self, data=b"", key=b"\0" * 16):
        _Hash.__init__(self, data, key, 1, 3, "siphash13")


class siphash24(_Hash):
    def __init__(self, data=b"", key=b"\0" * 16):
        _Hash.__init__(self, data, key, 2, 4, "siphash24")
