# -*- coding: utf-8 -*-
"""第 2 步：拓撲連接（把葉子聚成區域）與景深猜測（每個區域的 Z-Index）。

=====================================================================================================
A. 拓撲連接：相鄰葉子「顏色像、中間又沒有真正的邊」就合併成同一個區域
=====================================================================================================
最小單位是葉子（矩形，內部顏色已經夠均勻）。先在影像解析度上建一張葉子標籤圖 label[y,x]，再數所有「橫向或縱向相鄰、
標籤不同」的像素對。每個相鄰葉子對 (a,b) 得到：
    L_ab   共用邊界長度（像素對的個數）
    E_ab   邊界上的平均色差 = mean ‖Lab(p) − Lab(q)‖，p、q 是跨過邊界的相鄰像素
E_ab 小代表邊界兩側顏色連續（只是同一個漸層被切成兩塊），E_ab 大代表真的有輪廓。
合併條件（Kruskal 式：依 E_ab 由小到大處理，用 union-find 合併）：
    E_ab < τ_edge   且   ‖mean_lab(R_a) − mean_lab(R_b)‖ < τ_color
第二個條件看的是「合併後區域的平均色」，防止一條很長的漸層被一路合併成「慢慢漂移到完全不同顏色」的一大塊（chain drift）。

=====================================================================================================
B. 連接形狀猜測景深：用 figure–ground（圖地分離）線索，對每一對相鄰區域猜「誰在前面」，再解全域一致的深度
=====================================================================================================
單張 2D 圖沒有真的深度，只能用視覺心理學裡的圖地線索猜。對每一對相鄰區域 (i, j)，定義有號分數
    s_ij ∈ [−約5, +約5]，s_ij > 0 表示「i 在 j 前面（離相機近）」，s_ij = −s_ji。
由五個線索加權相加（權重 w 可調）：

  1. 包圍（enclosure，最強）   E_ij = e_ij − e_ji，e_ij = L_ij / P_i（i 的周長有多少比例貼著 j）。
     被另一塊整個包住的區域（e_ij 接近 1，反過來 e_ji 很小）通常是放在底圖上的物體，在前面。
  2. 面積（smaller is nearer）  A_ij = tanh( ½·ln(area_j / area_i) )。小的比大的更像物體，大的更像背景。
     取對數是因為面積的「倍數」才有意義；tanh 把它壓到 (−1,1)，免得一塊超大背景壓過其他線索。
  3. 凸性（convexity）          C_ij = solidity_i − solidity_j，solidity = 面積 / 凸包面積 ∈ (0,1]。
     輪廓比較凸的區域更像「完整的物體」（在前），凹的更像是被別人切掉一塊的（在後、被遮住）。
  4. 影像邊界接觸（border）     B_ij = bf_j − bf_i，bf = 區域周長裡有多少比例是影像邊緣。碰到影像邊緣的多半是背景。
  5. 垂直位置（弱先驗）         Y_ij = clip(2·(cy_i − cy_j)/H, −1, 1)。影像座標 y 向下，所以下面的在前（地面場景）。權重很小。

每一對的可信度 c_ij = √L_ij（共用邊界越長越可信）。

全域一致的深度：每個區域一個深度 z_i（越大越近）。成對的猜測可能互相矛盾（A 比 B 近、B 比 C 近、C 比 A 近），
所以不是做拓撲排序，而是解最小平方問題：
        min_z  Σ_(i,j) c_ij · (z_i − z_j − s_ij)²  +  ε Σ_i (z_i − p_i)²
其中 p_i = −bf_i（碰邊界的先驗在後面），ε 是很小的嶺回歸項，用來固定整體的平移（解唯一），並處理不相連的幾塊。
令 L 是以 c_ij 為邊權的圖拉普拉斯矩陣，b_i = Σ_j c_ij·s_ij，則正規方程為
        (L + ε I) z = b + ε p
區域數 R 通常幾十到幾百，直接用 np.linalg.solve 就夠。z 正規化到 [0,1]，再取名次當 z_index（0 = 最遠）。

這是「猜測」：它在『物體放在背景上』的圖上很準，在複雜重疊（例如人物手臂擋在身體前）上可能猜錯；
有 Vision AI 的軌道可以直接給每個區域的深度順序覆蓋這裡的結果（見 SKILL.md）。
"""
import numpy as np

from .colorspace import delta_e


# ------------------------------------------------------------------ 小工具
def _pair_stats(label, lab, n):
    """相鄰且標籤不同的像素對 → 每個 (lo,hi) 標籤對的 (共用長度, 平均色差)。"""
    keys, des = [], []
    for axis in (0, 1):
        if axis == 0:
            a, b, d = label[:, :-1], label[:, 1:], lab[:, :-1] - lab[:, 1:]
        else:
            a, b, d = label[:-1], label[1:], lab[:-1] - lab[1:]
        m = a != b
        if not m.any():
            continue
        a, b = a[m].astype(np.int64), b[m].astype(np.int64)
        keys.append(np.minimum(a, b) * n + np.maximum(a, b))
        des.append(np.sqrt((d[m] ** 2).sum(1)))
    if not keys:
        z = np.zeros(0)
        return z.astype(np.int64), z.astype(np.int64), z, z
    key, de = np.concatenate(keys), np.concatenate(des)
    uniq, inv = np.unique(key, return_inverse=True)
    cnt = np.bincount(inv).astype(np.float64)
    return uniq // n, uniq % n, cnt, np.bincount(inv, weights=de) / cnt


class _UF(object):
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x


def _hull_area(points):
    """Andrew monotone chain 凸包面積。points：(k,2)。"""
    pts = sorted(set(map(tuple, points.tolist())))
    if len(pts) < 3:
        return 0.0

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    h = lo[:-1] + up[:-1]
    return abs(sum(h[i][0] * h[(i + 1) % len(h)][1] - h[(i + 1) % len(h)][0] * h[i][1] for i in range(len(h)))) / 2.0


# ------------------------------------------------------------------ A. 聚類
def merge_leaves(leaves, lab, tau_edge=6.0, tau_color=12.0, min_region_area=None, var_thresh=None):
    """回傳 (leaf_region[len(leaves)], region_label[H,W])，區域編號 0..R-1。

    var_thresh：方差高於這個值的葉子是「混合葉子」（物體邊緣剛好穿過這個格子，裡面有兩種以上的顏色，格子已經小到不能再切）。
    它們的平均色是兩邊的混色，如果跟別人一起合併，會變成沿著輪廓的一圈細長假區域。所以先不參與合併；等其他葉子聚成區域後，
    再逐像素看這個格子裡的顏色比較像哪個相鄰區域，由多數像素決定整個葉子歸誰（葉子仍然是最小單位，網格與標籤保持一致，
    代價是區域邊界的精度大約是 min_size 個像素）。"""
    H, W, _ = lab.shape
    n = len(leaves)
    leaf_label = np.zeros((H, W), dtype=np.int32)
    for i, lf in enumerate(leaves):
        leaf_label[lf.y0:lf.y1, lf.x0:lf.x1] = i
    a, b, cnt, de = _pair_stats(leaf_label, lab, n)
    area = np.array([lf.area for lf in leaves], dtype=np.float64)
    sum_lab = np.array([lf.mean_lab * lf.area for lf in leaves])
    unres = np.array([(lf.var > var_thresh) if var_thresh is not None else False for lf in leaves])
    uf = _UF(n)
    for e in np.argsort(de, kind="stable"):
        if de[e] >= tau_edge:
            break
        if unres[a[e]] or unres[b[e]]:
            continue
        ra, rb = uf.find(int(a[e])), uf.find(int(b[e]))
        if ra == rb:
            continue
        if delta_e(sum_lab[ra] / area[ra], sum_lab[rb] / area[rb]) >= tau_color:
            continue
        uf.p[rb] = ra
        area[ra] += area[rb]
        sum_lab[ra] += sum_lab[rb]
    roots = np.array([uf.find(i) for i in range(n)])
    if unres.any():
        res_roots = np.unique(roots[~unres])
        rid = {int(r): k for k, r in enumerate(res_roots)}
        leaf_region = np.full(n, -1, dtype=np.int64)
        for i in np.where(~unres)[0]:
            leaf_region[i] = rid[int(roots[i])]
        means = np.array([sum_lab[r] / area[r] for r in res_roots])
        nbrs = [[] for _ in range(n)]
        for x, y in zip(a.tolist(), b.tolist()):
            nbrs[x].append(y)
            nbrs[y].append(x)
        todo = [int(i) for i in np.where(unres)[0]]
        for _ in range(40):
            nxt = []
            for i in todo:
                cand = sorted(set(int(leaf_region[j]) for j in nbrs[i] if leaf_region[j] >= 0))
                if not cand:
                    nxt.append(i)
                    continue
                lf = leaves[i]
                px = lab[lf.y0:lf.y1, lf.x0:lf.x1].reshape(-1, 3)
                dist = np.stack([((px - means[c]) ** 2).sum(1) for c in cand], 1)
                leaf_region[i] = cand[int(np.argmax(np.bincount(np.argmin(dist, 1), minlength=len(cand))))]
            if not nxt or len(nxt) == len(todo):
                todo = nxt
                break
            todo = nxt
        for i in todo:  # 周圍全是混合葉子（極少見）：各自成一個區域
            leaf_region[i] = len(means)
            means = np.vstack([means, leaves[i].mean_lab])
        _, leaf_region = np.unique(leaf_region, return_inverse=True)
    else:
        _, leaf_region = np.unique(roots, return_inverse=True)
    min_area = float(min_region_area if min_region_area is not None else max(16, 0.0004 * H * W))
    for _ in range(6):  # 太小的區域併進共用邊界最長的鄰居
        R = int(leaf_region.max()) + 1
        reg_label = leaf_region[leaf_label]
        ra, rb, rc, _ = _pair_stats(reg_label, lab, R)
        ra_area = np.bincount(reg_label.ravel(), minlength=R).astype(np.float64)
        small = np.where(ra_area < min_area)[0]
        if not len(small):
            break
        remap = np.arange(R)
        for s in small[np.argsort(ra_area[small])]:
            m = (ra == s) | (rb == s)
            if not m.any():
                continue
            other = np.where(ra[m] == s, rb[m], ra[m])
            tgt = int(other[np.argmax(rc[m])])
            while remap[tgt] != tgt:
                tgt = int(remap[tgt])
            if tgt != s:
                remap[s] = tgt
        for i in range(R):  # 路徑壓縮
            r = i
            while remap[r] != r:
                r = remap[r]
            remap[i] = r
        _, leaf_region = np.unique(remap[leaf_region], return_inverse=True)
    region_label = leaf_region[leaf_label].astype(np.int32)
    return leaf_region.astype(np.int64), region_label


# ------------------------------------------------------------------ B. 區域統計與景深
class Regions(object):
    pass


def analyze_regions(region_label, lab, weights=None):
    """計算每個區域的面積、重心、凸性、碰邊界比例、相鄰關係，並猜 z。回傳 Regions。"""
    H, W = region_label.shape
    R = int(region_label.max()) + 1
    w = dict(enclosure=2.0, area=1.0, convexity=1.0, border=1.0, vertical=0.3)
    w.update(weights or {})
    flat = region_label.ravel()
    area = np.bincount(flat, minlength=R).astype(np.float64)
    ys, xs = np.divmod(np.arange(H * W), W)
    cx = np.bincount(flat, weights=xs + 0.5, minlength=R) / area
    cy = np.bincount(flat, weights=ys + 0.5, minlength=R) / area
    mean_lab = np.stack([np.bincount(flat, weights=lab.reshape(-1, 3)[:, k], minlength=R) / area for k in range(3)], axis=1)
    order = np.argsort(flat, kind="stable")
    ends = np.cumsum(area).astype(np.int64)
    starts = ends - area.astype(np.int64)
    solidity = np.ones(R)
    bbox = np.zeros((R, 4), dtype=np.int64)
    for r in range(R):
        idx = order[starts[r]:ends[r]]
        yy, xx = idx // W, idx % W
        y0, y1, x0, x1 = yy.min(), yy.max() + 1, xx.min(), xx.max() + 1
        bbox[r] = (x0, y0, x1, y1)
        rowmin = np.full(y1 - y0, 10 ** 9)
        rowmax = np.full(y1 - y0, -1)
        np.minimum.at(rowmin, yy - y0, xx)
        np.maximum.at(rowmax, yy - y0, xx)
        ok = rowmax >= 0
        ry = np.arange(y0, y1)[ok]
        pts = np.concatenate([np.stack([rowmin[ok], ry], 1), np.stack([rowmax[ok] + 1, ry], 1),
                              np.stack([rowmin[ok], ry + 1], 1), np.stack([rowmax[ok] + 1, ry + 1], 1)]).astype(np.float64)
        ha = _hull_area(pts)
        solidity[r] = min(1.0, area[r] / ha) if ha > 0 else 1.0
    ra, rb, L, de = _pair_stats(region_label, lab, R)
    border_len = np.zeros(R)
    for edge in (region_label[0], region_label[-1], region_label[:, 0], region_label[:, -1]):
        border_len += np.bincount(edge, minlength=R)
    perim = border_len.copy()
    np.add.at(perim, ra, L)
    np.add.at(perim, rb, L)
    perim = np.maximum(perim, 1.0)
    bf = border_len / perim
    # 每一對相鄰區域：i 在 j 前面的分數 s_ij
    s = np.zeros(len(ra))
    for k in range(len(ra)):
        i, j = int(ra[k]), int(rb[k])
        e_ij, e_ji = L[k] / perim[i], L[k] / perim[j]
        E = e_ij - e_ji
        A = np.tanh(0.5 * np.log(area[j] / area[i]))
        C = solidity[i] - solidity[j]
        B = bf[j] - bf[i]
        Y = np.clip(2.0 * (cy[i] - cy[j]) / H, -1, 1)
        s[k] = w["enclosure"] * E + w["area"] * A + w["convexity"] * C + w["border"] * B + w["vertical"] * Y
    c = np.sqrt(L)
    eps = 1e-3 * (c.mean() if len(c) else 1.0)
    A_mat = np.eye(R) * eps
    rhs = eps * (-bf)
    for k in range(len(ra)):
        i, j = int(ra[k]), int(rb[k])
        A_mat[i, i] += c[k]
        A_mat[j, j] += c[k]
        A_mat[i, j] -= c[k]
        A_mat[j, i] -= c[k]
        rhs[i] += c[k] * s[k]
        rhs[j] -= c[k] * s[k]
    z = np.linalg.solve(A_mat, rhs)
    zn = (z - z.min()) / (z.max() - z.min()) if z.max() > z.min() else np.full(R, 0.5)
    rank = np.zeros(R, dtype=np.int64)
    rank[np.argsort(z, kind="stable")] = np.arange(R)
    out = Regions()
    out.R, out.label, out.area, out.centroid = R, region_label, area, np.stack([cx, cy], 1)
    out.mean_lab, out.solidity, out.border_frac, out.bbox = mean_lab, solidity, bf, bbox
    out.pairs = (ra, rb, L, de)
    out.pair_score = s
    out.z_raw, out.z_norm, out.z_index = z, zn, rank
    return out
