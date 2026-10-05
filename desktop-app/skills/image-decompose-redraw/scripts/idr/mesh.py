# -*- coding: utf-8 -*-
"""第 1 步（續）：把四叉樹的矩形葉子變成「沒有裂縫」的三角網格。

四叉樹相鄰的葉子大小不同時，大格子的一條邊上會有小格子的角（T 字接點，hanging node）。如果大格子只用自己的四個角，
就會跟小格子之間留下裂縫（頂點沒有共用）。解法：大格子的每條邊都把「落在這條邊上的所有別人的角」也收進來當邊界頂點，
再從格子中心連扇形三角形（fan）。這樣：
  * 相鄰格子在共用邊上的頂點完全相同 → 網格是 conforming（每條內部邊剛好被兩個三角形共用）；
  * 每個三角形形狀不會太細長（中心到邊界點）；
  * 每個葉子的三角形都帶著 leaf id，之後的顏色、區域、深度都以葉子為最小單位。
"""
import bisect
from collections import defaultdict

import numpy as np


def build_mesh(leaves):
    """回傳 (V, T, tri_leaf)：V (N,2) 浮點 (x,y)；T (M,3) 頂點索引；tri_leaf (M,) 三角形所屬的葉子編號。
    三角形的頂點順序一律是同一個方向（影像座標 y 向下時為順時針）。"""
    corners = set()
    for lf in leaves:
        corners.update([(lf.x0, lf.y0), (lf.x1, lf.y0), (lf.x1, lf.y1), (lf.x0, lf.y1)])
    by_y, by_x = defaultdict(list), defaultdict(list)
    for (x, y) in corners:
        by_y[y].append(x)
        by_x[x].append(y)
    for k in by_y:
        by_y[k].sort()
    for k in by_x:
        by_x[k].sort()

    vid, V = {}, []

    def vertex(x, y):
        k = (x, y)
        if k not in vid:
            vid[k] = len(V)
            V.append((float(x), float(y)))
        return vid[k]

    def between(sorted_list, a, b):
        i, j = bisect.bisect_right(sorted_list, a), bisect.bisect_left(sorted_list, b)
        return sorted_list[i:j]

    T, tri_leaf = [], []
    for li, lf in enumerate(leaves):
        x0, y0, x1, y1 = lf.x0, lf.y0, lf.x1, lf.y1
        ring = [(x0, y0)]
        ring += [(x, y0) for x in between(by_y[y0], x0, x1)]
        ring.append((x1, y0))
        ring += [(x1, y) for y in between(by_x[x1], y0, y1)]
        ring.append((x1, y1))
        ring += [(x, y1) for x in reversed(between(by_y[y1], x0, x1))]
        ring.append((x0, y1))
        ring += [(x0, y) for y in reversed(between(by_x[x0], y0, y1))]
        ids = [vertex(x, y) for (x, y) in ring]
        c = len(V)
        V.append(((x0 + x1) / 2.0, (y0 + y1) / 2.0))
        for k in range(len(ids)):
            T.append((c, ids[k], ids[(k + 1) % len(ids)]))
            tri_leaf.append(li)
    return np.array(V, dtype=np.float64), np.array(T, dtype=np.int64), np.array(tri_leaf, dtype=np.int64)


def check_conforming(T, V, W, H):
    """檢查：每條內部邊剛好被 2 個三角形共用；只被 1 個共用的邊必須在影像邊界上。回傳 (ok, 訊息)。"""
    edges = defaultdict(int)
    for a, b, c in T:
        for u, v in ((a, b), (b, c), (c, a)):
            edges[(min(u, v), max(u, v))] += 1
    bad = []
    for (u, v), n in edges.items():
        if n > 2:
            bad.append(("共用超過兩次", u, v))
        elif n == 1:
            (x0, y0), (x1, y1) = V[u], V[v]
            on_border = (x0 == x1 == 0) or (x0 == x1 == W) or (y0 == y1 == 0) or (y0 == y1 == H)
            if not on_border:
                bad.append(("內部邊只有一個三角形（有裂縫）", u, v))
    return (not bad), (bad[:5] if bad else "ok")
