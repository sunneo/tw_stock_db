# -*- coding: utf-8 -*-
"""部位偵測自我檢查：python tests/test_parts.py（先 node scripts/export-visual-parts.js 產生 data/parts_builtin.json）"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
from idr import Params, decompose  # noqa: E402
from idr import parts as P  # noqa: E402
from idr.colorspace import srgb_to_lab  # noqa: E402

PARTS = os.path.join(HERE, "..", "data", "parts_builtin.json")
OK, BAD = [], []


def check(name, cond, extra=""):
    (OK if cond else BAD).append(name)
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)


def face_image(skin, hair, bg=(70, 90, 120), eye=(30, 20, 20), mouth=(170, 60, 70), W=320, H=360, ears=True):
    """合成人臉：背景、頭髮、膚色橢圓臉、兩隻眼睛、嘴、耳朵。"""
    im = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(im)
    d.ellipse([60, 20, 260, 230], fill=hair)                 # 頭髮（比臉大，露在上方與兩側）
    d.ellipse([90, 70, 230, 250], fill=skin)                 # 臉
    if ears:
        d.ellipse([78, 140, 94, 172], fill=skin)
        d.ellipse([226, 140, 242, 172], fill=skin)
    d.ellipse([118, 120, 144, 138], fill=eye)                # 左眼
    d.ellipse([176, 120, 202, 138], fill=eye)                # 右眼
    d.rectangle([140, 200, 180, 210], fill=mouth)            # 嘴
    d.rectangle([60, 300, 260, 360], fill=skin)              # 身體（膚色，貼著影像下緣：不該被當成臉）
    return np.asarray(im, dtype=np.float64) / 255.0


def run(img, **kw):
    lab = srgb_to_lab(img)
    parts = P.load_parts(PARTS)
    det = P.detect_parts(lab, parts)
    return det


def by_id(det, pid):
    return [p for p in det["parts"] if p["id"] == pid]


def main():
    if not os.path.exists(PARTS):
        print("缺少 data/parts_builtin.json，先執行 node scripts/export-visual-parts.js")
        return 2
    # 1) 連通元件
    m = np.zeros((20, 30), dtype=bool)
    m[2:6, 2:8] = True
    m[10:14, 10:20] = True
    m[4, 8:12] = False
    lab, n = P.label_components(m)
    check("components: two blobs", n == 2 and lab[3, 3] != lab[11, 12])
    m2 = m.copy()
    m2[5, 8:12] = True
    m2[5:10, 12] = True   # 連起來
    check("components: bridge merges", P.label_components(m2)[1] == 1)
    check("components: diagonal not connected (4-conn)", P.label_components(np.array([[1, 0], [0, 1]], dtype=bool))[1] == 2)

    # 2) 各種膚色／髮色的人臉：都要找到臉、兩隻眼睛、嘴
    tones = {"pale": (245, 215, 195), "medium": (200, 150, 110), "tan": (160, 110, 75), "deep": (95, 60, 40), "anime": (252, 226, 208)}
    for name, skin in tones.items():
        det = run(face_image(skin, hair=(40, 30, 25)))
        c = det["container"]
        ok_c = c is not None and 70 <= c["bbox"][0] <= 100 and 215 <= c["bbox"][2] <= 250 and c["bbox"][1] <= 100 and c["bbox"][3] < 300
        check("face found (%s)" % name, ok_c, det.get("reason") or (c and c["bbox"]))
        if not c:
            continue
        eyes = by_id(det, "human-eye")
        eyes_ok = len(eyes) == 2 and all(e["source"] == "detected" for e in eyes) and eyes[0]["cx"] < 160 < eyes[1]["cx"] if len(eyes) == 2 else False
        check("two symmetric eyes detected (%s)" % name, eyes_ok, [(e["source"], e["bbox"]) for e in eyes])
        mo = by_id(det, "human-mouth")
        check("mouth detected (%s)" % name, len(mo) == 1 and mo[0]["source"] == "detected" and abs(mo[0]["cx"] - 160) < 12, [(m_["source"], m_["bbox"]) for m_ in mo])
        nose = by_id(det, "human-nose")
        check("nose is a position prior with low confidence (%s)" % name, len(nose) == 1 and nose[0]["source"] == "prior" and nose[0]["confidence"] < 0.3)
    # 3) 頭髮：髮色不限（紅、金、藍紫的動畫髮色）
    for hn, hc in {"black": (40, 30, 25), "blond": (230, 200, 90), "vivid-blue": (60, 90, 220)}.items():
        det = run(face_image(tones["pale"], hair=hc))
        hair = by_id(det, "human-hair")
        check("hair found (%s)" % hn, len(hair) == 1 and hair[0]["source"] == "detected" and hair[0]["bbox"][1] < 60, [(h["source"], h["bbox"]) for h in hair])
    # 3b) 棕色頭髮跟棕色皮膚的顏色族群重疊：頭髮不能被併進臉（容器外框要是臉，不是頭髮）
    det = run(face_image(tones["pale"], hair=(120, 74, 40)))
    cb = det["container"]["bbox"] if det["container"] else None
    check("brown hair is not merged into the face", cb is not None and cb[1] >= 60 and cb[0] >= 70 and cb[3] < 300, cb)
    # 3c) 沒見過的膚色（綠色）：內建知識認不得臉；補顏色族群與容器（同使用者用 ref_define 補）後就認得
    green = (80, 200, 80)
    base_parts = P.load_parts(PARTS)
    g_before = P.detect_parts(srgb_to_lab(face_image(green, hair=(40, 30, 25))), base_parts)
    check("unknown skin colour: no confident human face", g_before["container"] is None or g_before["container"]["id"] != "human-face", g_before.get("container") and g_before["container"]["id"])
    import copy
    custom = copy.deepcopy(base_parts)
    hf = next(c for c in custom["containers"] if c["key"] == "human-face")
    gf = copy.deepcopy(hf)
    gf["key"] = "green-face"
    gf["value"]["colors"] = [{"L": [40, 85], "a": [-80, -15], "b": [10, 70], "group": "skin", "_ref": {"kind": "color_family", "key": "skin-green"}}]
    custom["containers"].append(gf)
    g_after = P.detect_parts(srgb_to_lab(face_image(green, hair=(40, 30, 25))), custom)
    check("after adding the colour family + container: recognised", g_after["container"] is not None and g_after["container"]["id"] == "green-face" and len([p for p in g_after["parts"] if p["source"] == "detected"]) >= 3, g_after.get("reason") or g_after["container"])
    # 3d) 容器信心要有五官證據：一塊沒有五官的膚色橢圓不該有高信心
    bl = Image.fromarray((np.ones((360, 320, 3)) * np.array([70, 90, 120])).astype(np.uint8))
    ImageDraw.Draw(bl).ellipse([90, 70, 230, 250], fill=tones["pale"])
    blank_face = P.detect_parts(srgb_to_lab(np.asarray(bl, dtype=np.float64) / 255.0), base_parts)
    check("skin-coloured ellipse without features: low confidence", blank_face["container"] is None or blank_face["container"]["confidence"] < 0.6, blank_face.get("container") and blank_face["container"]["confidence"])
    # 4) 沒有臉的圖：不硬套
    rng = np.random.RandomState(0)
    noface = np.clip(0.5 + 0.1 * rng.randn(200, 240, 3), 0, 1)
    nf = run(noface)
    check("no face -> no container, with reason", nf["container"] is None and nf["reason"])
    blue = np.ones((200, 240, 3)) * np.array([0.2, 0.4, 0.8])
    check("blue image -> no container", run(blue)["container"] is None)
    # 5) 身體貼著影像下緣：不能把它當成臉
    det = run(face_image(tones["pale"], hair=(40, 30, 25)))
    check("body at bottom edge is not the face", det["container"]["bbox"][3] < 300, det["container"]["bbox"])

    # 6) 局部深度：臉是圓頂、眼窩凹、頭髮有體積；xy 與 UV 不動
    img = face_image(tones["pale"], hair=(40, 30, 25))
    base = decompose(img, Params(max_side=360, max_leaves=4000, parts_depth=0.0), parts=PARTS)   # 同一張（細分過的）網格，只是不加部位深度
    withp = decompose(img, Params(max_side=360, max_leaves=4000), parts=PARTS)
    Wd = withp.size[0]
    check("parts stats present", withp.stats.get("parts", {}).get("container") is not None and withp.stats["parts"]["depth_applied"] >= 4, withp.stats.get("parts"))
    check("face region is densely meshed (forced refinement)", withp.stats["leaves_refined"] > base.stats["leaves"] * 0.99 and withp.stats["vertices_2d"] > 3000, withp.stats)
    check("xy unchanged by part depth", bool(np.allclose(base.mesh.vertices[:, :2], withp.mesh.vertices[:, :2])))
    check("uv = position / size (texture untouched)", bool(np.allclose(withp.uv[:, 0], withp.mesh.vertices[:, 0] / Wd)))
    dz = withp.mesh.vertices[:, 2] - base.mesh.vertices[:, 2]
    V = withp.mesh.vertices

    def zat(x, y, r=7):
        m = (np.abs(V[:, 0] - x) < r) & (np.abs(V[:, 1] - y) < r)
        return float(dz[m].mean()) if m.any() else float("nan")
    center, cheek, eye, bg = zat(160, 170, 10), zat(105, 215, 8), zat(131, 129, 6), zat(10, 10, 8)
    check("face dome: centre higher than far cheek", center > cheek + 0.5, (center, cheek))
    check("eye socket sunken relative to the face around it", eye < center - 0.3, (eye, center))
    check("background untouched", abs(bg) < 1e-6, bg)
    # 7) 輸出：parts.json
    import tempfile
    from idr import save_all
    out = save_all(withp, tempfile.mkdtemp(prefix="idr_parts"), "t")
    pj = json.load(open(out["parts"], encoding="utf-8"))
    check("parts.json written", pj["container"]["id"] and len(pj["parts"]) >= 6 and all("confidence" in p for p in pj["parts"]))
    print("\n%d passed, %d failed" % (len(OK), len(BAD)), BAD)
    return 1 if BAD else 0


if __name__ == "__main__":
    sys.exit(main())
