# -*- coding: utf-8 -*-
"""純幾何軌道（Without Vision Model）的整條流程：點陣圖 → 四叉樹三角網格 → 區域聚類＋景深猜測 → 距離變換充氣 → UV 貼圖。"""
import json
import time
from dataclasses import asdict, dataclass, field

import numpy as np

from . import export, inflate as inflate_mod, mesh as mesh_mod, quadtree, regions as regions_mod, resample
from .colorspace import srgb_to_lab


@dataclass
class Params:
    max_side: int = 640          # 工作解析度：長邊縮到這個大小（貼圖也是這個大小；結果的座標以這個大小為準）
    var_thresh: float = 10.0     # 四叉樹：Lab 方差大於這個才繼續切
    min_size: int = 2            # 四叉樹：最小格子邊長（像素）
    max_leaves: int = 8000       # 四叉樹：格子數上限（決定三角形數量，約 ×4～×8）
    tau_edge: float = 6.0        # 聚類：邊界平均色差小於這個才可能合併
    tau_color: float = 12.0      # 聚類：合併後區域平均色差小於這個才合併
    min_region_area: float = 0.0  # 太小的區域併進鄰居（0＝自動：影像面積的 0.04%）
    depth_weights: dict = field(default_factory=dict)  # 景深線索權重，見 regions.py
    amplitude: float = 0.8       # 充氣振幅 A
    bevel: float = 0.0           # 倒角寬度 β（像素；0＝自動：長邊的 6%）
    depth_range: float = 0.0     # 景深落差（像素；0＝自動：長邊的 20%）
    style: str = "smooth"        # smooth＝連續單片浮雕（預設，適合照片、動畫、人物）；layered＝各區域分層剪紙、交界補側面牆（適合物體放在乾淨背景上的圖）
    global_smooth_iters: int = 24  # smooth 風格：整張網格的 z 平滑次數
    flip_v: bool = True          # UV 的 v 軸翻轉（OpenGL 慣例）
    smooth_iters: int = 6        # 充氣後的表面平滑次數（0＝不平滑）
    parts_depth: float = 1.0     # 部位局部深度的強度（0＝只偵測與細分、不加深度；1＝標準）
    skirts: bool = True          # 區域交界補側面牆（separate_regions 時）


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


def decompose(source, params=None, vision="off", parts=None):
    """vision："off"（純幾何）、"auto"（有支援讀圖的模型就用它決定前後順序，否則退回純幾何）、"on"（一定要用，失敗就報錯）。"""
    p = params or Params()
    t0 = time.time()
    rgb, scale = load_rgb(source, p.max_side)
    H, W, _ = rgb.shape
    lab = srgb_to_lab(rgb)
    det = None
    if parts:
        from . import parts as parts_mod
        try:
            det = parts_mod.detect_parts(lab, parts_mod.load_parts(parts))
        except Exception as e:  # 部位偵測是加分項：失敗不影響主流程
            det = {"container": None, "parts": [], "reason": "%s: %s" % (type(e).__name__, str(e)[:160])}
    refine = parts_mod.refine_boxes(det, (W, H)) if det and det.get("container") else None
    leaves = quadtree.build_quadtree(lab, p.var_thresh, p.min_size, p.max_leaves, refine=refine)
    V, T, tri_leaf = mesh_mod.build_mesh(leaves)
    leaf_region, region_label = regions_mod.merge_leaves(leaves, lab, p.tau_edge, p.tau_color, p.min_region_area or None, p.var_thresh)
    reg = regions_mod.analyze_regions(region_label, lab, p.depth_weights)
    tri_region = leaf_region[tri_leaf]
    leaf_rgb = np.array([rgb[lf.y0:lf.y1, lf.x0:lf.x1].reshape(-1, 3).mean(0) for lf in leaves])
    r = Result()
    r.params, r.scale, r.rgb, r.size = p, scale, rgb, (W, H)
    r.leaves, r.V, r.T, r.tri_leaf, r.tri_region = leaves, V, T, tri_leaf, tri_region
    r.regions, r.tri_color = reg, leaf_rgb[tri_leaf]
    r.lab = lab
    r.depth_source = "geometry"
    rebuild_3d(r)
    r.stats = {"size": [W, H], "scale": round(scale, 4), "leaves": len(leaves), "triangles_2d": int(len(T)), "vertices_2d": int(len(V)),
               "regions": int(reg.R), "vertices_3d": int(len(r.mesh.vertices)), "faces_3d": int(len(r.mesh.faces)), "triangles_3d_total": int(len(r.mesh.faces)), "wall_faces": int(r.mesh.wall_mask.sum()), "depth_source": "geometry"}
    mode = (vision or "off")
    if mode in ("auto", "on"):
        from . import vision as vision_mod
        try:
            vision_mod.apply_vision_depth(r)
            r.stats["depth_source"] = "vision"
            r.stats["vision_labels"] = getattr(r.regions, "labels", {})
        except Exception as e:  # 沒有支援讀圖的模型、模型回傳格式不對…：auto 退回純幾何，on 直接報錯
            if mode == "on":
                raise
            r.stats["vision_fallback"] = "%s: %s" % (type(e).__name__, str(e)[:200])
    r.parts = det
    if det is not None:
        from . import parts as parts_mod
        try:
            applied = parts_mod.apply_part_depth(r, det, p.parts_depth)
            r.stats["parts"] = parts_mod.summarize(det)
            r.stats["parts"]["depth_applied"] = applied
            r.stats["leaves_refined"] = int(len(leaves))
        except Exception as e:
            r.stats["parts"] = {"error": "%s: %s" % (type(e).__name__, str(e)[:160])}
    r.stats["seconds"] = round(time.time() - t0, 2)
    return r


def rebuild_3d(r):
    """依目前的 regions.z_norm（純幾何猜的，或 Vision 覆蓋後的）重新充氣、算 UV 與頂點顏色。"""
    p, (W, H) = r.params, r.size
    r.mesh = inflate_mod.inflate(r.V, r.T, r.tri_region, r.regions, W, H, p.amplitude, p.bevel or None, p.depth_range or None, p.style == "layered", p.smooth_iters, p.skirts, p.global_smooth_iters)
    r.uv = resample.uv_from_vertices(r.mesh.vertices[:, :2], W, H, p.flip_v)
    r.vertex_colors = resample.bake_vertex_colors(r.rgb, r.regions.label, r.mesh.vertices[:, :2], r.mesh.vertex_region)
    return r


def _parts_title(result):
    c = (getattr(result, "parts", None) or {}).get("container")
    if not c:
        return ""
    det = [p for p in result.parts["parts"] if p["source"] == "detected"]
    return "；部位：%s（信心 %.2f，偵測到 %d 個、先驗 %d 個）" % (c["id"], c["confidence"], len(det), len(result.parts["parts"]) - len(det))


def save_all(result, out_dir, name="out", triangles_svg=False, all_formats=False):
    """寫出 SVG、3D 模型（.glb 單檔含貼圖、助理 3D 檢視器用的 .scene3d.yaml、.mesh.json、OBJ＋MTL）、貼圖 PNG，回傳檔案清單。"""
    import os
    from PIL import Image
    os.makedirs(out_dir, exist_ok=True)
    W, H = result.size
    files = {}

    def w(key, fname, data, binary=False):
        files[key] = os.path.join(out_dir, fname)
        with open(files[key], "wb" if binary else "w", **({} if binary else {"encoding": "utf-8"})) as f:
            f.write(data)
    leaf_rgb = np.array([result.rgb[lf.y0:lf.y1, lf.x0:lf.x1].reshape(-1, 3).mean(0) for lf in result.leaves])
    leaf_region = np.zeros(len(result.leaves), dtype=np.int64)
    for i, r in zip(result.tri_leaf, result.tri_region):
        leaf_region[i] = r
    w("svg", name + ".svg", export.to_svg_cells(result.leaves, leaf_rgb, leaf_region, result.regions, W, H))
    if triangles_svg:
        w("svg_triangles", name + ".triangles.svg", export.to_svg(result.V, result.T, result.tri_color, result.tri_region, result.regions, W, H))
    w("glb", name + ".glb", export.to_glb(result.mesh, result.rgb), binary=True)
    w("scene3d_yaml", name + ".scene3d.yaml", export.to_scene_yaml(result.mesh, result.uv, result.rgb, title="2.5D 模型：%s（%d 個區域、%d 個三角形、景深來源：%s）" % (name, result.stats["regions"], result.stats["faces_3d"], "視覺模型" if result.stats["depth_source"] == "vision" else "純幾何猜測") + _parts_title(result)))
    if all_formats:
        w("json", name + ".mesh.json", export.to_json(result.mesh, result.uv, result.vertex_colors, result.regions, asdict(result.params), result.stats))
        obj, mtl = export.to_obj(result.mesh, result.uv, name + ".texture.png", name + ".mtl")
        w("obj", name + ".obj", obj)
        w("mtl", name + ".mtl", mtl)
    if getattr(result, "parts", None) is not None:
        from . import parts as parts_mod
        w("parts", name + ".parts.json", json.dumps(parts_mod.summarize(result.parts), ensure_ascii=False, indent=1))
    files["texture"] = os.path.join(out_dir, name + ".texture.png")
    Image.fromarray((np.clip(result.rgb, 0, 1) * 255).astype(np.uint8)).save(files["texture"])
    return files
