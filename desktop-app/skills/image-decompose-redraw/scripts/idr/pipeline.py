# -*- coding: utf-8 -*-
"""純幾何軌道（Without Vision Model）的整條流程：點陣圖 → 四叉樹三角網格 → 區域聚類＋景深猜測 → 距離變換充氣 → UV 貼圖。"""
import time
from dataclasses import asdict, dataclass, field

import numpy as np

from . import export, inflate as inflate_mod, mesh as mesh_mod, quadtree, regions as regions_mod, resample
from .colorspace import srgb_to_lab


@dataclass
class Params:
    max_side: int = 384          # 工作解析度：長邊縮到這個大小（貼圖也是這個大小；結果的座標以這個大小為準）
    var_thresh: float = 20.0     # 四叉樹：Lab 方差大於這個才繼續切
    min_size: int = 4            # 四叉樹：最小格子邊長（像素）
    max_leaves: int = 3000       # 四叉樹：格子數上限（決定三角形數量，約 ×4～×8）
    tau_edge: float = 6.0        # 聚類：邊界平均色差小於這個才可能合併
    tau_color: float = 12.0      # 聚類：合併後區域平均色差小於這個才合併
    min_region_area: float = 0.0  # 太小的區域併進鄰居（0＝自動：影像面積的 0.04%）
    depth_weights: dict = field(default_factory=dict)  # 景深線索權重，見 regions.py
    amplitude: float = 0.8       # 充氣振幅 A
    bevel: float = 0.0           # 倒角寬度 β（像素；0＝自動：長邊的 6%）
    depth_range: float = 0.0     # 景深落差（像素；0＝自動：長邊的 20%）
    separate_regions: bool = True  # True：各區域有各自的 3D 頂點（真的有景深）；False：單片連續網格
    flip_v: bool = True          # UV 的 v 軸翻轉（OpenGL 慣例）


class Result(object):
    pass


def load_rgb(source, max_side):
    """source：路徑、PIL.Image 或 (H,W,3) 陣列。回傳 (H,W,3) float 0..1（長邊縮到 max_side）與縮放比例。"""
    from PIL import Image
    if isinstance(source, str):
        img = Image.open(source)
    elif isinstance(source, np.ndarray):
        img = Image.fromarray((np.clip(source, 0, 1) * 255).astype(np.uint8) if source.dtype != np.uint8 else source)
    else:
        img = source
    if img.mode in ("RGBA", "LA", "P"):
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, rgba)
    img = img.convert("RGB")
    s = min(1.0, float(max_side) / max(img.size))
    if s < 1.0:
        img = img.resize((max(1, round(img.size[0] * s)), max(1, round(img.size[1] * s))), Image.LANCZOS)
    return np.asarray(img, dtype=np.float64) / 255.0, s


def decompose(source, params=None):
    p = params or Params()
    t0 = time.time()
    rgb, scale = load_rgb(source, p.max_side)
    H, W, _ = rgb.shape
    lab = srgb_to_lab(rgb)
    leaves = quadtree.build_quadtree(lab, p.var_thresh, p.min_size, p.max_leaves)
    V, T, tri_leaf = mesh_mod.build_mesh(leaves)
    leaf_region, region_label = regions_mod.merge_leaves(leaves, lab, p.tau_edge, p.tau_color, p.min_region_area or None, p.var_thresh)
    reg = regions_mod.analyze_regions(region_label, lab, p.depth_weights)
    tri_region = leaf_region[tri_leaf]
    m3 = inflate_mod.inflate(V, T, tri_region, reg, W, H, p.amplitude, p.bevel or None, p.depth_range or None, p.separate_regions)
    uv = resample.uv_from_vertices(m3.vertices[:, :2], W, H, p.flip_v)
    colors = resample.bake_vertex_colors(rgb, region_label, m3.vertices[:, :2], m3.vertex_region)
    leaf_rgb = np.array([rgb[lf.y0:lf.y1, lf.x0:lf.x1].reshape(-1, 3).mean(0) for lf in leaves])
    r = Result()
    r.params, r.scale, r.rgb, r.size = p, scale, rgb, (W, H)
    r.leaves, r.V, r.T, r.tri_leaf, r.tri_region = leaves, V, T, tri_leaf, tri_region
    r.regions, r.mesh, r.uv, r.vertex_colors, r.tri_color = reg, m3, uv, colors, leaf_rgb[tri_leaf]
    r.stats = {"size": [W, H], "scale": round(scale, 4), "leaves": len(leaves), "triangles_2d": int(len(T)), "vertices_2d": int(len(V)),
               "regions": int(reg.R), "vertices_3d": int(len(m3.vertices)), "faces_3d": int(len(m3.faces)),
               "seconds": round(time.time() - t0, 2)}
    return r


def save_all(result, out_dir, name="out"):
    """寫出 SVG、網格 JSON、OBJ＋MTL、貼圖 PNG，回傳檔案清單。"""
    import os
    from PIL import Image
    os.makedirs(out_dir, exist_ok=True)
    W, H = result.size
    files = {}
    svg = export.to_svg(result.V, result.T, result.tri_color, result.tri_region, result.regions, W, H)
    files["svg"] = os.path.join(out_dir, name + ".svg")
    open(files["svg"], "w", encoding="utf-8").write(svg)
    files["json"] = os.path.join(out_dir, name + ".mesh.json")
    open(files["json"], "w", encoding="utf-8").write(export.to_json(result.mesh, result.uv, result.vertex_colors, result.regions, asdict(result.params), result.stats))
    obj, mtl = export.to_obj(result.mesh, result.uv, name + ".texture.png")
    files["obj"], files["mtl"] = os.path.join(out_dir, name + ".obj"), os.path.join(out_dir, "mesh.mtl")
    open(files["obj"], "w", encoding="utf-8").write(obj.replace("mtllib mesh.mtl", "mtllib mesh.mtl"))
    open(files["mtl"], "w", encoding="utf-8").write(mtl)
    files["texture"] = os.path.join(out_dir, name + ".texture.png")
    Image.fromarray((np.clip(result.rgb, 0, 1) * 255).astype(np.uint8)).save(files["texture"])
    return files
