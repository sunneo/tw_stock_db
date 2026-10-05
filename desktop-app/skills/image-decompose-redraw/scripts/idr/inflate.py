# -*- coding: utf-8 -*-
"""第 3 步：幾何充氣——用距離變換把 2D 頂點推進 Z 軸，形成膨脹的 2.5D 幾何體，同時保留頂點跟原圖的一對一對應。

=====================================================================================================
數學
=====================================================================================================
對每個區域 r，取它在影像上的遮罩 M_r。網格頂點落在「像素角點」（整數座標）上，所以距離也定義在角點格子上：
    角點 (i,j) 是區域 r 的「內部角點」⇔ 圍著它的四個像素都屬於 r。
    d_r(v) = 角點 v 到最近的「非內部角點」的歐氏距離（edt.py）。
區域邊界上的角點 d=0，越往內部越大。葉子中心之類不在整數座標的頂點，對角點格子做雙線性內插。

把距離變成高度。令 d_ref = min(d_max, β)，β 是倒角寬度（預設影像長邊的 6%），t = clip(d / d_ref, 0, 1)，
    z_local = A · d_ref · P(t)，  P(t) = √(1 − (1 − t)²)      （四分之一圓輪廓）
P(0)=0、P(1)=1、P'(0)=∞：邊界處是垂直的切面、往內變成圓滑的肩膀，離邊界超過 β 後是平坦的高原。這種「枕頭／氣球」輪廓
讓邊緣有立體感，又不會讓大面積背景鼓成一個巨大的山丘（那樣的話一轉動視角整張圖都會扭曲）。A 是振幅（預設 0.8）。

最後的 z = z_base(r) + z_local，其中 z_base(r) = z_norm(r) · depth_range 是上一步猜出的景深（越近越大）。

=====================================================================================================
頂點與原圖的一對一對應
=====================================================================================================
每個 3D 頂點都記著 src_vertex：它來自哪一個 2D 網格頂點，而它的 (x, y) 一個像素也不動——充氣只改 z。所以
把 3D 頂點直接正投影回影像平面（丟掉 z）就會剛好得到原本的 2D 頂點位置：3D → 2D 是一對一的（每個 3D 頂點對應唯一
的 2D 位置與 UV），重新取樣貼圖時不會有任何偏移。
  * separate_regions=True（預設）：位於兩個區域交界的 2D 頂點，每個區域各有一份 3D 頂點（x、y 相同，z 因為景深不同而不同）。
    這樣前後區域能真的分在不同深度，視角轉動時產生視差；反向（2D → 3D）在交界處是一對多，這是景深分層必然的代價。
  * separate_regions=False：每個 2D 頂點只有一份 3D 頂點（交界處取各區域 z 的平均），網格是一張連續不斷的單片，
    2D ↔ 3D 完全一對一，但區域之間沒有真正的景深落差。
"""
import numpy as np

from .edt import edt


class Mesh3D(object):
    pass


def _lattice_distance(mask):
    """mask：(h,w) 布林，區域在 bbox 裡的遮罩。回傳 (h+1,w+1) 的角點距離（邊界角點為 0）。"""
    m = np.pad(mask, 1)
    interior = m[:-1, :-1] & m[:-1, 1:] & m[1:, :-1] & m[1:, 1:]
    return edt(interior)


def _bilinear(grid, x, y):
    h, w = grid.shape
    x = np.clip(x, 0, w - 1.0)
    y = np.clip(y, 0, h - 1.0)
    x0 = np.minimum(np.floor(x).astype(int), w - 2) if w > 1 else np.zeros_like(x, dtype=int)
    y0 = np.minimum(np.floor(y).astype(int), h - 2) if h > 1 else np.zeros_like(y, dtype=int)
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    fx, fy = x - x0, y - y0
    return (grid[y0, x0] * (1 - fx) * (1 - fy) + grid[y0, x1] * fx * (1 - fy) +
            grid[y1, x0] * (1 - fx) * fy + grid[y1, x1] * fx * fy)


def _smooth(zl, tri_local, d, iters):
    """拉普拉斯平滑（內部頂點取鄰居平均，邊界頂點 d=0 固定）。四叉樹的階梯狀邊界會讓距離場帶有細碎的鋸齒，
    直接充氣會長出一堆尖刺；平滑幾次之後表面才像一個圓滑的氣球。"""
    if iters <= 0 or len(zl) == 0:
        return zl
    e = np.concatenate([tri_local[:, [0, 1]], tri_local[:, [1, 2]], tri_local[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    free = d > 1e-9
    z = zl.copy()
    cnt = np.bincount(e[:, 0], minlength=len(z)).astype(np.float64)
    for _ in range(iters):
        s = np.bincount(e[:, 0], weights=z[e[:, 1]], minlength=len(z))
        avg = s / np.maximum(cnt, 1)
        z = np.where(free, 0.5 * z + 0.5 * avg, z)
    return z


def _smooth_global(z, T, iters):
    """連續單片模式：對整張 2D 網格的 z 再做拉普拉斯平滑。各區域的景深是分段常數，區域交界會有高低落差，
    平滑後變成連續的緩坡（淺浮雕），轉動視角時才不會把一張臉切成一片一片。"""
    if iters <= 0:
        return z
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    cnt = np.maximum(np.bincount(e[:, 0], minlength=len(z)), 1).astype(np.float64)
    z = z.copy()
    for _ in range(iters):
        z = 0.5 * z + 0.5 * np.bincount(e[:, 0], weights=z[e[:, 1]], minlength=len(z)) / cnt
    return z


def _add_skirts(mesh, T, tri_region):
    """區域交界的側面牆：不同區域的同一個 2D 頂點因為景深不同，z 不一樣，中間會露出縫隙（從側面看是黑洞）。
    對每條「兩側屬於不同區域」的 2D 邊，補一個四邊形（兩個三角形）把兩個區域的頂點接起來。牆的 UV 沿用頂點原本的位置，
    貼圖在牆上是把邊界像素拉伸，看起來像物體的側面。"""
    idx = {}
    for k, (v, r) in enumerate(zip(mesh.src_vertex.tolist(), mesh.vertex_region.tolist())):
        idx[(v, r)] = k
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    tri = np.concatenate([np.arange(len(T))] * 3)
    lo, hi = np.minimum(e[:, 0], e[:, 1]), np.maximum(e[:, 0], e[:, 1])
    key = lo.astype(np.int64) * (int(T.max()) + 1) + hi
    order = np.argsort(key, kind="stable")
    key, lo, hi, tri = key[order], lo[order], hi[order], tri[order]
    same = key[1:] == key[:-1]
    a = np.where(same)[0]
    quads = []
    for i in a:
        ra, rb = int(tri_region[tri[i]]), int(tri_region[tri[i + 1]])
        if ra == rb:
            continue
        u, v = int(lo[i]), int(hi[i])
        try:
            p, q, r_, s = idx[(u, ra)], idx[(v, ra)], idx[(v, rb)], idx[(u, rb)]
        except KeyError:
            continue
        quads.append((p, q, r_))
        quads.append((p, r_, s))
    if quads:
        mesh.faces = np.vstack([mesh.faces, np.array(quads, dtype=mesh.faces.dtype)])
        mesh.face_region = np.concatenate([mesh.face_region, np.full(len(quads), -1)])
        mesh.wall_mask = np.concatenate([mesh.wall_mask, np.ones(len(quads), dtype=bool)])


def inflate(V, T, tri_region, regions, W, H, amplitude=0.8, bevel=None, depth_range=None, separate_regions=True, smooth_iters=6, skirts=True, global_smooth_iters=24):
    """V (N,2)、T (M,3)、tri_region (M,)、regions（regions.Regions）。回傳 Mesh3D。"""
    bevel = float(bevel if bevel is not None else 0.06 * max(W, H))
    depth_range = float(depth_range if depth_range is not None else 0.2 * max(W, H))
    R = regions.R
    verts, src, vreg, faces, fregion = [], [], [], [], []
    base = 0
    z_by_vid = {}
    for r in range(R):
        tri_idx = np.where(tri_region == r)[0]
        if not len(tri_idx):
            continue
        x0, y0, x1, y1 = regions.bbox[r]
        D = _lattice_distance(regions.label[y0:y1, x0:x1] == r)
        dmax = float(D.max())
        dref = min(dmax, bevel)
        vids, inv = np.unique(T[tri_idx].ravel(), return_inverse=True)
        xy = V[vids]
        d = _bilinear(D, xy[:, 0] - x0, xy[:, 1] - y0)
        t = np.clip(d / dref, 0, 1) if dref > 1e-9 else np.zeros_like(d)
        zl = amplitude * dref * np.sqrt(1.0 - (1.0 - t) ** 2)
        zl = _smooth(zl, inv.reshape(-1, 3), d, smooth_iters)
        z = regions.z_norm[r] * depth_range + zl
        if separate_regions:
            verts.append(np.column_stack([xy, z]))
            src.append(vids)
            vreg.append(np.full(len(vids), r))
            faces.append(inv.reshape(-1, 3) + base)
            fregion.append(np.full(len(tri_idx), r))
            base += len(vids)
        else:
            for vid, zz in zip(vids.tolist(), z.tolist()):
                z_by_vid.setdefault(vid, []).append(zz)
            faces.append(T[tri_idx])
            fregion.append(np.full(len(tri_idx), r))
    out = Mesh3D()
    if separate_regions:
        out.vertices, out.src_vertex, out.vertex_region = np.vstack(verts), np.concatenate(src), np.concatenate(vreg)
    else:
        zz = np.zeros(len(V))
        for vid, zs in z_by_vid.items():
            zz[vid] = float(np.mean(zs))
        zz = _smooth_global(zz, T, global_smooth_iters)
        out.vertices, out.src_vertex = np.column_stack([V, zz]), np.arange(len(V))
        vr = np.zeros(len(V), dtype=np.int64)
        for f, r in zip(np.vstack(faces), np.concatenate(fregion)):
            vr[f] = r
        out.vertex_region = vr
    out.faces = np.vstack(faces)
    out.face_region = np.concatenate(fregion)
    out.wall_mask = np.zeros(len(out.faces), dtype=bool)
    if separate_regions and skirts:
        _add_skirts(out, T, tri_region)
    out.size = (W, H)
    return out
