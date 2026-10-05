# -*- coding: utf-8 -*-
"""精確的歐氏距離變換（Felzenszwalb & Huttenlocher 2012），只用 numpy／純 Python，不需要 scipy。

距離變換 D(p) = min_{q ∉ 前景} ‖p − q‖。它是可分離的：先對每一欄、再對每一列各做一次一維的「下包絡線」運算。
一維問題：給 f(q)（前景為 +∞、背景為 0），求 d(p) = min_q [ (p−q)² + f(q) ]。
每個 q 對應一條拋物線 (p−q)² + f(q)，d(p) 就是所有拋物線的下包絡線，用堆疊 O(n) 掃一遍就能求出。
"""
import numpy as np

_INF = 1e20


def _dt1d(f):
    n = len(f)
    d = [0.0] * n
    v = [0] * n
    z = [0.0] * (n + 1)
    k = 0
    z[0], z[1] = -_INF, _INF
    for q in range(1, n):
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k])
        while s <= z[k]:
            k -= 1
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k])
        k += 1
        v[k] = q
        z[k] = s
        z[k + 1] = _INF
    k = 0
    for q in range(n):
        while z[k + 1] < q:
            k += 1
        d[q] = (q - v[k]) ** 2 + f[v[k]]
    return d


def edt_sq(fg):
    """fg：布林陣列（True＝前景）。回傳每個前景像素到最近的非前景像素的「距離平方」；沒有任何背景時全部是 ~1e20。"""
    f = np.where(fg, _INF, 0.0)
    H, W = f.shape
    if not (~fg).any():
        return f
    g = np.empty_like(f)
    for x in range(W):
        col = f[:, x]
        g[:, x] = col if col.min() >= _INF else _dt1d(col.tolist())
    out = np.empty_like(f)
    for y in range(H):
        row = g[y]
        out[y] = row if row.min() >= _INF else _dt1d(row.tolist())
    return out


def edt(fg):
    """距離（不是平方）。"""
    return np.sqrt(np.minimum(edt_sq(fg), _INF))
