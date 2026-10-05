# -*- coding: utf-8 -*-
"""輸出：SVG（依景深由遠到近的向量重繪）、網格 JSON、Wavefront OBJ（含 UV）。"""
import json

import numpy as np


def _hex(rgb):
    c = np.clip(np.round(np.asarray(rgb) * 255), 0, 255).astype(int)
    return "#%02x%02x%02x" % (c[0], c[1], c[2])


def to_svg(V, T, tri_color, tri_region, regions, W, H, scale=1.0, stroke=0.6):
    """SVG 預設輸出。每個區域一個 <g>，依 z_index 由遠到近排列（畫家演算法：後畫的蓋在前面）。
    三角形用跟自己同色的細線描邊，避免相鄰三角形之間出現抗鋸齒的縫。"""
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">' % (W * scale, H * scale, W, H)]
    for r in np.argsort(regions.z_index, kind="stable"):
        idx = np.where(tri_region == r)[0]
        if not len(idx):
            continue
        parts.append('<g id="region-%d" data-z-index="%d" data-z="%.4f">' % (r, regions.z_index[r], regions.z_norm[r]))
        for t in idx:
            p = V[T[t]]
            col = _hex(tri_color[t])
            parts.append('<polygon points="%.2f,%.2f %.2f,%.2f %.2f,%.2f" fill="%s" stroke="%s" stroke-width="%.2f" stroke-linejoin="round"/>'
                         % (p[0, 0], p[0, 1], p[1, 0], p[1, 1], p[2, 0], p[2, 1], col, col, stroke))
        parts.append("</g>")
    parts.append("</svg>")
    return "\n".join(parts)


def to_json(mesh, uv, colors, regions, params=None, stats=None):
    return json.dumps({
        "format": "image-decompose-redraw/geometric-2.5d",
        "size": list(mesh.size),
        "vertices": np.round(mesh.vertices, 3).tolist(),
        "uv": np.round(uv, 5).tolist(),
        "vertex_colors": np.round(colors, 4).tolist(),
        "src_vertex": mesh.src_vertex.tolist(),
        "vertex_region": mesh.vertex_region.tolist(),
        "faces": mesh.faces.tolist(),
        "face_region": mesh.face_region.tolist(),
        "regions": [{"id": int(r), "z_index": int(regions.z_index[r]), "z": round(float(regions.z_norm[r]), 5),
                     "area": int(regions.area[r]), "bbox": regions.bbox[r].tolist(), "solidity": round(float(regions.solidity[r]), 4),
                     "border_fraction": round(float(regions.border_frac[r]), 4)} for r in range(regions.R)],
        "params": params or {}, "stats": stats or {},
    }, ensure_ascii=False)


def to_obj(mesh, uv, texture_name="texture.png"):
    L = ["# image-decompose-redraw：2.5D 網格（x 右、y 下、z 朝相機）", "mtllib mesh.mtl", "o mesh"]
    L += ["v %.3f %.3f %.3f" % tuple(v) for v in mesh.vertices]
    L += ["vt %.5f %.5f" % tuple(t) for t in uv]
    L.append("usemtl tex")
    L += ["f %d/%d %d/%d %d/%d" % (a + 1, a + 1, b + 1, b + 1, c + 1, c + 1) for a, b, c in mesh.faces]
    mtl = "newmtl tex\nKd 1 1 1\nmap_Kd %s\n" % texture_name
    return "\n".join(L) + "\n", mtl
