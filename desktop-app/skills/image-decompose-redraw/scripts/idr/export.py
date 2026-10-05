# -*- coding: utf-8 -*-
"""輸出：SVG（依景深由遠到近的向量重繪）、網格 JSON、Wavefront OBJ（含 UV）。"""
import json

import numpy as np


def _hex(rgb):
    c = np.clip(np.round(np.asarray(rgb) * 255), 0, 255).astype(int)
    return "#%02x%02x%02x" % (c[0], c[1], c[2])


def to_svg_cells(leaves, leaf_rgb, leaf_region, regions, W, H, scale=1.0, stroke=0.5):
    """SVG（葉子格子版）：每個四叉樹葉子一個 <rect>，依區域的景深由遠到近分組。同樣的畫面，檔案大小約是三角形版的 1/5，
    也比較快；要看三角網格本身用 to_svg。"""
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d" shape-rendering="crispEdges">' % (W * scale, H * scale, W, H)]
    for r in np.argsort(regions.z_index, kind="stable"):
        idx = np.where(leaf_region == r)[0]
        if not len(idx):
            continue
        parts.append('<g id="region-%d" data-z-index="%d" data-z="%.4f">' % (r, regions.z_index[r], regions.z_norm[r]))
        for i in idx:
            lf = leaves[i]
            col = _hex(leaf_rgb[i])
            parts.append('<rect x="%d" y="%d" width="%d" height="%d" fill="%s" stroke="%s" stroke-width="%.2f"/>' % (lf.x0, lf.y0, lf.x1 - lf.x0, lf.y1 - lf.y0, col, col, stroke))
        parts.append("</g>")
    parts.append("</svg>")
    return "\n".join(parts)


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


def to_obj(mesh, uv, texture_name="texture.png", mtl_name="mesh.mtl"):
    L = ["# image-decompose-redraw：2.5D 網格（x 右、y 下、z 朝相機）", "mtllib " + mtl_name, "o mesh"]
    L += ["v %.3f %.3f %.3f" % tuple(v) for v in mesh.vertices]
    L += ["vt %.5f %.5f" % tuple(t) for t in uv]
    L.append("usemtl tex")
    L += ["f %d/%d %d/%d %d/%d" % (a + 1, a + 1, b + 1, b + 1, c + 1, c + 1) for a, b, c in mesh.faces]
    mtl = "newmtl tex\nKd 1 1 1\nmap_Kd %s\n" % texture_name
    return "\n".join(L) + "\n", mtl


def _jpeg_bytes(rgb, quality=90):
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def _png_bytes(rgb):
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8)).save(buf, "PNG", optimize=True)
    return buf.getvalue()


def to_scene_yaml(mesh, uv, texture_rgb, title="2.5D 圖片模型", width_units=10.0, jpeg_quality=88):
    """助理的 3D 檢視器（render_3d_scene）能直接顯示的 YAML：只有「一個」polygon 節點，頂點／面／UV 都在節點裡，
    貼圖用 data URL 內嵌（JPEG，比 PNG 小很多）。YAML 是 JSON 的超集，所以這裡直接寫 JSON 文字，檢視器照樣解析。
    座標：影像中心為原點、y 向上、整張圖的長邊 = width_units；z 朝相機。"""
    import base64
    W, H = mesh.size
    s = float(width_units) / max(W, H)
    v = mesh.vertices
    verts = np.column_stack([(v[:, 0] - W / 2.0) * s, -(v[:, 1] - H / 2.0) * s, v[:, 2] * s])
    tex = "data:image/jpeg;base64," + base64.b64encode(_jpeg_bytes(texture_rgb, jpeg_quality)).decode("ascii")
    dist = (max(W, H) * s / 2.0) / np.tan(np.radians(25.0)) * 1.15
    scene = {
        "title": title,
        "background": "#101418",
        "camera": {"position": [0, 0, round(float(dist), 3)], "look_at": [0, 0, 0], "fov": 50},
        "lights": [{"type": "ambient", "intensity": 1.0, "color": "#ffffff"}],
        "nodes": [{"id": "image-model", "mesh": "polygon", "position": [0, 0, 0],
                   "vertices": np.round(verts, 3).tolist(), "faces": mesh.faces.tolist(), "uvs": np.round(uv, 5).tolist(),
                   "material": {"texture": tex, "color": "#ffffff", "roughness": 1, "metalness": 0, "side": "double"}}],
    }
    return json.dumps(scene, ensure_ascii=False, separators=(",", ":"))


def to_glb(mesh, texture_rgb, width_units=1.0):
    """單一檔案的 glTF 2.0 二進位（.glb），貼圖內嵌——大多數 3D 檢視器（Windows 3D 檢視器、Blender、three.js、線上檢視器）
    開起來就有貼圖，不像 OBJ 要靠旁邊另一個 MTL 檔再指向 PNG（分開下載就掉了）。材質用 KHR_materials_unlit（不受光，顏色就是原圖）。
    UV 用 glTF 慣例（原點在左上，v = y / H）。"""
    import struct
    W, H = mesh.size
    s = float(width_units) / max(W, H)
    v = mesh.vertices
    pos = np.column_stack([(v[:, 0] - W / 2.0) * s, -(v[:, 1] - H / 2.0) * s, v[:, 2] * s]).astype("<f4")
    uv = np.column_stack([v[:, 0] / W, v[:, 1] / H]).astype("<f4")
    idx = mesh.faces.astype("<u4").ravel()
    png = _png_bytes(texture_rgb)

    def pad(b, fill=b"\x00"):
        return b + fill * ((4 - len(b) % 4) % 4)
    parts = [pos.tobytes(), uv.tobytes(), idx.tobytes(), png]
    views, off = [], 0
    for k, b in enumerate(parts):
        views.append({"buffer": 0, "byteOffset": off, "byteLength": len(b)})
        off += len(pad(b))
    views[0]["target"], views[1]["target"], views[2]["target"] = 34962, 34962, 34963
    gltf = {
        "asset": {"version": "2.0", "generator": "image-decompose-redraw"},
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "image-model"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0, "mode": 4}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0, "roughnessFactor": 1.0},
                       "extensions": {"KHR_materials_unlit": {}}, "doubleSided": True}],
        "textures": [{"source": 0, "sampler": 0}], "samplers": [{"magFilter": 9729, "minFilter": 9729, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": 3, "mimeType": "image/png"}],
        "buffers": [{"byteLength": off}], "bufferViews": views,
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3", "min": pos.min(0).tolist(), "max": pos.max(0).tolist()},
            {"bufferView": 1, "componentType": 5126, "count": len(uv), "type": "VEC2"},
            {"bufferView": 2, "componentType": 5125, "count": len(idx), "type": "SCALAR"},
        ],
    }
    js = pad(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")
    binchunk = b"".join(pad(b) for b in parts)
    total = 12 + 8 + len(js) + 8 + len(binchunk)
    return struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(binchunk), 0x004E4942) + binchunk
