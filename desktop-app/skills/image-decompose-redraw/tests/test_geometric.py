# -*- coding: utf-8 -*-
"""自我檢查（不需要 pytest）：python tests/test_geometric.py"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from idr import Params, decompose  # noqa: E402
from idr.edt import edt_sq  # noqa: E402
from idr.mesh import check_conforming  # noqa: E402
from idr.resample import psnr, render_view  # noqa: E402

OK, BAD = [], []


def check(name, cond, extra=""):
    (OK if cond else BAD).append(name)
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)


def synthetic(W=256, H=192):
    """天空漸層＋草地＋一棟建築（矩形）＋建築上的窗戶（被包住的小塊）＋跨在建築邊緣的圓球。"""
    img = np.zeros((H, W, 3))
    ys = np.linspace(0, 1, H)[:, None]
    img[:] = (np.array([0.35, 0.6, 0.95]) * (1 - ys) + np.array([0.75, 0.88, 1.0]) * ys)[:, None, :].reshape(H, 1, 3)
    img[int(H * 0.72):] = [0.25, 0.6, 0.25]
    img[40:150, 70:170] = [0.55, 0.35, 0.3]
    img[60:90, 95:125] = [0.95, 0.9, 0.5]
    yy, xx = np.mgrid[0:H, 0:W]
    img[(xx - 170) ** 2 + (yy - 120) ** 2 < 20 ** 2] = [0.9, 0.15, 0.15]
    return img


def _cross2(a, b):
    return a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0]


def region_at(res, x, y):
    return int(res.regions.label[y, x])


def main():
    # 1. 距離變換跟暴力解一致
    rng = np.random.RandomState(1)
    m = rng.rand(23, 31) > 0.35
    m[5, 5] = False
    d = edt_sq(m)
    pts = np.argwhere(~m)
    brute = np.array([[min(((i - p[0]) ** 2 + (j - p[1]) ** 2) for p in pts) if m[i, j] else 0 for j in range(31)] for i in range(23)], dtype=float)
    check("edt == brute force", np.allclose(d, brute), np.abs(d - brute).max())

    img = synthetic()
    p = Params(max_side=256, max_leaves=1500, style="layered")
    res = decompose(img, p)
    W, H = res.size
    print("stats:", res.stats)

    # 2. 四叉樹鋪滿整張圖、網格沒有裂縫
    area = sum(l.area for l in res.leaves)
    check("leaves tile the image", area == W * H, (area, W * H))
    ok, msg = check_conforming(res.T, res.V, W, H)
    check("mesh is conforming (no cracks)", ok, msg)
    check("every triangle has positive area", bool((np.abs(_cross2(res.V[res.T[:, 1]] - res.V[res.T[:, 0]], res.V[res.T[:, 2]] - res.V[res.T[:, 0]])) > 1e-9).all()))

    # 3. 區域與景深：窗戶在建築前面、建築在天空前面、圓球在建築前面
    rs, rb, rw, rc, rg = (region_at(res, 20, 10), region_at(res, 80, 120), region_at(res, 110, 75), region_at(res, 170, 120), region_at(res, 20, 170))
    check("distinct regions found", len({rs, rb, rw, rc, rg}) == 5, (rs, rb, rw, rc, rg))
    zi = res.regions.z_index
    check("window in front of building (enclosure)", zi[rw] > zi[rb], (zi[rw], zi[rb]))
    check("building in front of sky", zi[rb] > zi[rs], (zi[rb], zi[rs]))
    check("ball in front of building", zi[rc] > zi[rb], (zi[rc], zi[rb]))
    check("sky gradient stays together locally", region_at(res, 20, 5) == region_at(res, 20, 30))
    check("no sliver regions around objects", int((res.regions.area < 60).sum()) <= 3, int((res.regions.area < 60).sum()))

    # 4. 充氣：邊界頂點 z = 基底，內部頂點更高；頂點 (x,y) 沒動、src_vertex 對得上原 2D 頂點
    m3 = res.mesh
    check("x,y unchanged by inflation", bool(np.allclose(m3.vertices[:, :2], res.V[m3.src_vertex])))
    z_loc = m3.vertices[:, 2] - res.regions.z_norm[m3.vertex_region] * 0.2 * max(W, H)
    check("inflation >= 0 and has a bulge", z_loc.min() >= -1e-9 and z_loc.max() > 2.0, (z_loc.min(), z_loc.max()))
    corner = np.where((np.abs(m3.vertices[:, 0] - 0) < 1e-9) & (np.abs(m3.vertices[:, 1] - 0) < 1e-9))[0]
    check("image-border vertices are not inflated", bool((z_loc[corner] < 1e-6).all()))
    check("each 2D vertex used by a 3D vertex", len(np.unique(m3.src_vertex)) == len(np.unique(res.T)))
    welded = decompose(img, Params(max_side=256, max_leaves=1500, style="smooth")).mesh
    dz = float(np.abs(welded.vertices[welded.faces[:, 0], 2] - welded.vertices[welded.faces[:, 1], 2]).max())
    check("layered mode adds side walls between regions", int(m3.wall_mask.sum()) > 0 and not bool(welded.wall_mask.any()), int(m3.wall_mask.sum()))
    check("smooth mode: z is continuous (no big jumps between neighbours)", dz < 0.06 * max(W, H), dz)
    check("smooth mode: one 3D vertex per 2D vertex", len(welded.vertices) == len(res.V) and bool((welded.src_vertex == np.arange(len(res.V))).all()))

    # 5. 貼圖重新取樣：正對視角重畫應該回到原圖；轉動視角有視差且露出空洞
    r0 = render_view(m3, res.rgb, 0.0, 0.0)
    cover = r0[..., 3] > 0.5
    check("front view covers the whole image", cover.mean() > 0.995, cover.mean())
    check("front view PSNR vs original", psnr(r0[..., :3], res.rgb, cover) > 38.0, psnr(r0[..., :3], res.rgb, cover))
    r1 = render_view(m3, res.rgb, 0.25, 0.0)
    check("yawed view differs (parallax)", float(np.abs(r1[..., :3] - r0[..., :3]).mean()) > 0.003)
    check("yawed view exposes holes (no invented content)", float((r1[..., 3] < 0.5).mean()) > 0.0005, float((r1[..., 3] < 0.5).mean()))
    # 6. 輸出：GLB（貼圖內嵌、單一檔案）、3D 檢視器 YAML（單一 polygon 節點、貼圖內嵌）、SVG（葉子格子版）
    import json, struct, tempfile
    from idr import save_all
    out = save_all(res, tempfile.mkdtemp(prefix="idr_test"), "t")
    g = open(out["glb"], "rb").read()
    magic, ver, total = struct.unpack("<III", g[:12])
    jl, jt = struct.unpack("<II", g[12:20])
    gl = json.loads(g[20:20 + jl])
    check("glb header and length", magic == 0x46546C67 and ver == 2 and total == len(g))
    check("glb embeds the texture and uses it", gl["images"][0]["mimeType"] == "image/png" and gl["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"] == 0 and gl["accessors"][1]["type"] == "VEC2")
    check("glb counts match mesh", gl["accessors"][0]["count"] == len(res.mesh.vertices) and gl["accessors"][2]["count"] == 3 * len(res.mesh.faces))
    y = json.loads(open(out["scene3d_yaml"], encoding="utf-8").read())
    node = y["nodes"][0]
    check("scene3d yaml: one polygon node with embedded texture", len(y["nodes"]) == 1 and node["mesh"] == "polygon" and node["material"]["texture"].startswith("data:image/jpeg;base64,") and len(node["uvs"]) == len(node["vertices"]))
    svg = open(out["svg"], encoding="utf-8").read()
    check("svg is compact (one rect per leaf)", svg.count("<rect") == len(res.leaves), svg.count("<rect"))
    print("\n%d passed, %d failed" % (len(OK), len(BAD)), BAD)
    return 1 if BAD else 0


if __name__ == "__main__":
    sys.exit(main())
