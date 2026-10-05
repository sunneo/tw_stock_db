# -*- coding: utf-8 -*-
"""第 4 步：頂點投影與重新取樣貼圖（UV 綁定）。

=====================================================================================================
數學
=====================================================================================================
座標約定：影像座標 (x, y)，x 向右、y 向下，像素 (i, j) 的中心在 (i+½, j+½)；3D 頂點 P = (x, y, z)，z 越大越靠近相機。

1. 歸一化 UV。 UV(P) = (x / W, y / H)（再依需要把 v 翻成 1 − y/H，OpenGL 慣例）。
   UV 只看頂點「原本的」影像位置，與充氣後的 z 無關，所以不管幾何怎麼變形，貼圖永遠從原圖的同一個點取樣。

2. 逆向映射取樣（inverse mapping）。要畫三角形內部的像素 q：先算它的重心座標 (λ0, λ1, λ2)（對螢幕上的 2D 三角形），
        uv(q) = Σ λ_k · UV(P_k)，   color(q) = Bilinear(原圖, uv(q) · (W, H) − ½)
   在原視角（相機正對、不旋轉）下，螢幕三角形就是原圖三角形，uv(q) 剛好等於 q 自己的位置，所以重畫結果等於原圖——
   這也是 render_view(yaw=0) 能拿來當自我檢查（PSNR）的原因。

3. 轉動視角（頂點投影）。繞影像中心 c 轉 yaw θ、pitch φ 的小角度，正交投影：
        P' = R_x(φ) · R_y(θ) · (P − c) + c，螢幕位置 = (P'.x, P'.y)，深度 = P'.z
   三角形用 z-buffer 解遮擋。z 由景深猜測與距離變換充氣決定，所以邊緣會有圓潤的立體感、前景相對背景會有視差。
   轉動後原本被擋住的地方會露出空洞（沒有任何三角形覆蓋），本模組不編造內容，空洞回傳透明（alpha=0）。

4. 頂點顏色（區域感知的雙線性取樣）。交界處的頂點旁邊四個像素有的屬於別的區域，直接雙線性取樣會把鄰居的顏色滲進來。
   用「正規化卷積」只取屬於該頂點所在區域的像素：
        color(v) = Σ_p w_p · m_p · c_p / Σ_p w_p · m_p，   m_p = 1 若像素 p 屬於 v 的區域，w_p 是雙線性權重。
   若四個像素都不屬於該區域（頂點恰好貼在細長區域的尖端），退而取附近最近的區域像素。
"""
import numpy as np


def uv_from_vertices(xy, W, H, flip_v=True):
    uv = np.column_stack([xy[:, 0] / float(W), xy[:, 1] / float(H)])
    if flip_v:
        uv[:, 1] = 1.0 - uv[:, 1]
    return uv


def sample_bilinear(img, x, y):
    """img：(H,W,C) 浮點；x、y：像素座標（中心在 +½）。回傳 (n,C)。超出邊界取最近的邊緣像素。"""
    H, W = img.shape[:2]
    fx, fy = x - 0.5, y - 0.5
    x0, y0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    wx, wy = (fx - x0)[:, None], (fy - y0)[:, None]
    x0c, x1c = np.clip(x0, 0, W - 1), np.clip(x0 + 1, 0, W - 1)
    y0c, y1c = np.clip(y0, 0, H - 1), np.clip(y0 + 1, 0, H - 1)
    return (img[y0c, x0c] * (1 - wx) * (1 - wy) + img[y0c, x1c] * wx * (1 - wy) +
            img[y1c, x0c] * (1 - wx) * wy + img[y1c, x1c] * wx * wy)


def bake_vertex_colors(img, region_label, xy, vert_region):
    """區域感知的雙線性取樣（見上面第 4 點）。img (H,W,3)，xy (K,2)，vert_region (K,)。回傳 (K,3)。"""
    H, W = region_label.shape
    fx, fy = xy[:, 0] - 0.5, xy[:, 1] - 0.5
    x0, y0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    wx, wy = fx - x0, fy - y0
    num = np.zeros((len(xy), img.shape[2]))
    den = np.zeros(len(xy))
    for dx, dy, w in ((0, 0, (1 - wx) * (1 - wy)), (1, 0, wx * (1 - wy)), (0, 1, (1 - wx) * wy), (1, 1, wx * wy)):
        px, py = x0 + dx, y0 + dy
        inside = (px >= 0) & (px < W) & (py >= 0) & (py < H)
        pxc, pyc = np.clip(px, 0, W - 1), np.clip(py, 0, H - 1)
        m = inside & (region_label[pyc, pxc] == vert_region)
        ww = np.where(m, w, 0.0)
        num += img[pyc, pxc] * ww[:, None]
        den += ww
    out = num / np.maximum(den, 1e-12)[:, None]
    for k in np.where(den < 1e-9)[0]:  # 附近最近的區域像素
        cx, cy = int(np.clip(round(xy[k, 0] - 0.5), 0, W - 1)), int(np.clip(round(xy[k, 1] - 0.5), 0, H - 1))
        for rad in range(1, 12):
            ys, xs = np.mgrid[max(cy - rad, 0):min(cy + rad + 1, H), max(cx - rad, 0):min(cx + rad + 1, W)]
            hit = region_label[ys, xs] == vert_region[k]
            if hit.any():
                dd = (ys - cy) ** 2 + (xs - cx) ** 2
                dd = np.where(hit, dd, 10 ** 9)
                j = np.unravel_index(np.argmin(dd), dd.shape)
                out[k] = img[ys[j], xs[j]]
                break
        else:
            out[k] = img[cy, cx]
    return out


def render_view(mesh, texture, yaw=0.0, pitch=0.0, size=None):
    """用 3D 網格＋原圖貼圖畫出一個視角（軟體光柵化）。回傳 (H,W,4) 浮點 RGBA（空洞 alpha=0）。
    mesh：Mesh3D；texture：(H,W,3) 0..1 的原圖；yaw、pitch：弧度。"""
    Wt, Ht = mesh.size
    W, H = size or (Wt, Ht)
    out = np.zeros((H, W, 4))
    zbuf = np.full((H, W), -np.inf)
    P = mesh.vertices.copy()
    cx, cy = Wt / 2.0, Ht / 2.0
    X, Y, Z = P[:, 0] - cx, P[:, 1] - cy, P[:, 2]
    cyw, syw, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
    X2, Z2 = X * cyw + Z * syw, -X * syw + Z * cyw       # 繞 y 軸（yaw）
    Y3, Z3 = Y * cp - Z2 * sp, Y * sp + Z2 * cp          # 繞 x 軸（pitch）
    sx, sy, sz = X2 + cx + (W - Wt) / 2.0, Y3 + cy + (H - Ht) / 2.0, Z3
    uvpx = mesh.vertices[:, :2]                          # 貼圖座標＝原圖像素位置（UV × 尺寸）
    for f in mesh.faces:
        a, b, c = f
        xs, ys = sx[[a, b, c]], sy[[a, b, c]]
        x0, x1 = max(int(np.floor(xs.min())), 0), min(int(np.ceil(xs.max())), W)
        y0, y1 = max(int(np.floor(ys.min())), 0), min(int(np.ceil(ys.max())), H)
        if x1 <= x0 or y1 <= y0:
            continue
        den = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
        if abs(den) < 1e-12:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        l0 = ((ys[1] - ys[2]) * (gx - xs[2]) + (xs[2] - xs[1]) * (gy - ys[2])) / den
        l1 = ((ys[2] - ys[0]) * (gx - xs[2]) + (xs[0] - xs[2]) * (gy - ys[2])) / den
        l2 = 1.0 - l0 - l1
        eps = -1e-9
        m = (l0 >= eps) & (l1 >= eps) & (l2 >= eps)
        if not m.any():
            continue
        z = l0 * sz[a] + l1 * sz[b] + l2 * sz[c]
        sub = zbuf[y0:y1, x0:x1]
        win = m & (z > sub)
        if not win.any():
            continue
        u = l0 * uvpx[a, 0] + l1 * uvpx[b, 0] + l2 * uvpx[c, 0]
        v = l0 * uvpx[a, 1] + l1 * uvpx[b, 1] + l2 * uvpx[c, 1]
        col = sample_bilinear(texture, u[win], v[win])
        sub[win] = z[win]
        o = out[y0:y1, x0:x1]
        o[win, :3] = col
        o[win, 3] = 1.0
    return out


def psnr(a, b, mask=None):
    d = (a - b) ** 2
    if mask is not None:
        d = d[mask]
    mse = float(d.mean()) if d.size else 0.0
    return 99.0 if mse <= 1e-12 else 10.0 * np.log10(1.0 / mse)
