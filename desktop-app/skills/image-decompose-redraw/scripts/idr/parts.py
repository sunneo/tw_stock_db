# -*- coding: utf-8 -*-
"""部位偵測與局部深度（純幾何、不需要 AI）：依知識庫裡展開好的 visual_part 定義，找出臉（容器）與五官、頭髮、耳朵等部位，
把「臉是圓頂、鼻子突起、眼窩凹陷、頭髮有體積」這類語意加到 2.5D 模型的深度上。

知識從哪來：`parts.json`（由助理的知識庫 `ref_resolve` 展開，或 `scripts/export-visual-parts.js` 匯出）。這個模組只實作「基本動作」——
顏色落在範圍內、在容器的相對位置、左右對稱配對、形狀與大小比對、局部深度；定義（哪個部位在哪、多大、什麼顏色、凸或凹）全部來自知識庫，
所以使用者或 AI 修正定義（同 key 覆蓋）後，下次執行直接生效，不用改程式。

演算法（每一步都是可以解釋的幾何，信心低就老實標示，不硬套）：
1. 容器偵測：把容器定義的顏色族群（Lab 範圍）聯集成遮罩，做連通元件；每個元件依「面積占整張圖的比例是否在 size 範圍內、
   外框填滿率（橢圓約 0.785）、寬高比」打分，取最高分且超過門檻的當容器。各種膚色／毛色只是不同的顏色族群，沒有任何人種或物種標籤。
2. 部位比對：對容器的每個子部位，把定義的 box（相對於容器外框，可以超出 0~1）換算成圖上的視窗；視窗內用部位的顏色族群做遮罩、
   連通元件、剔除已被其他部位占用的像素；單一部位取「離預期位置最近、大小形狀最符合」的元件；成對（count=2、symmetric）的部位
   用鏡像配對：找出一左一右、高度與大小相近、對稱軸（容器中線）上互為鏡像的兩個元件。
3. 找不到時退回「位置先驗」：照 box 的中心與 size 的中間值放一個橢圓，來源標成 prior、信心很低（鼻子本來就沒有明顯色塊，所以預設走先驗）。
4. 頭髮：視窗內「不是容器、也不像背景（跟影像邊緣平均色的色差夠大）」且貼著容器的最大元件（髮色不限，所以染髮與動畫髮色也行）。
5. 局部深度：每個部位產生一張 0~1 的權重圖（偵測到的遮罩經模糊，或先驗的橢圓），頂點的 z 加上 ± 振幅 × 容器尺寸 × 權重（bump＝朝相機、sunken＝往內）。
   容器本身加一個圓頂（中間高、邊緣低）。xy 完全不動，UV 與貼圖不受影響。
"""
import json

import numpy as np

CONTAINER_MIN_SCORE = 0.38
DEPTH_UNIT = 0.3  # 振幅 1.0 ＝ 容器較短邊的 30%


# ------------------------------------------------------------------ 基本動作
def color_mask(lab, families):
    """Lab 影像落在任一顏色族群範圍內的遮罩。families：[{L:[lo,hi], a:[..], b:[..]}]"""
    m = np.zeros(lab.shape[:2], dtype=bool)
    for f in families or []:
        try:
            m |= ((lab[..., 0] >= f["L"][0]) & (lab[..., 0] <= f["L"][1]) & (lab[..., 1] >= f["a"][0]) & (lab[..., 1] <= f["a"][1])
                  & (lab[..., 2] >= f["b"][0]) & (lab[..., 2] <= f["b"][1]))
        except (KeyError, TypeError, IndexError):
            continue
    return m


def label_components(mask):
    """4-連通元件標記（用每一列的連續段做並查集，不需要 scipy）。回傳 (labels, n)，標籤 1..n，0 是背景。"""
    H, W = mask.shape
    parent = [0]

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    lab = np.zeros((H, W), dtype=np.int32)
    prev = []
    for y in range(H):
        row = mask[y].astype(np.int8)
        d = np.diff(np.concatenate(([0], row, [0])))
        starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
        runs, pi = [], 0
        for s, e in zip(starts.tolist(), ends.tolist()):
            while pi < len(prev) and prev[pi][1] <= s:
                pi += 1
            cur, pj = 0, pi
            while pj < len(prev) and prev[pj][0] < e:
                o = find(prev[pj][2])
                if cur == 0:
                    cur = o
                elif o != cur:
                    parent[max(o, cur)] = min(o, cur)
                    cur = min(o, cur)
                pj += 1
            if cur == 0:
                parent.append(len(parent))
                cur = len(parent) - 1
            runs.append((s, e, cur))
            lab[y, s:e] = cur
        prev = runs
    roots = np.array([find(i) for i in range(len(parent))])
    uniq = np.unique(roots[1:]) if len(roots) > 1 else np.array([], dtype=int)
    remap = np.zeros(len(parent), dtype=np.int32)
    for k, r in enumerate(uniq, start=1):
        remap[roots == r] = k
    return remap[lab], len(uniq)


def components(mask, min_area=4, limit=40):
    """連通元件清單（面積由大到小，最多 limit 個）：{area, bbox(x0,y0,x1,y1), cx, cy, label, labels}"""
    labels, n = label_components(mask)
    if n == 0:
        return []
    area = np.bincount(labels.ravel(), minlength=n + 1)
    out = []
    for l in np.argsort(-area[1:])[:limit] + 1:
        if area[l] < min_area:
            break
        ys, xs = np.where(labels == l)
        out.append({"area": int(area[l]), "bbox": (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1),
                    "cx": float(xs.mean() + 0.5), "cy": float(ys.mean() + 0.5), "label": int(l), "labels": labels})
    return out


def _fit(v, lo, hi, soft=0.5):
    """v 落在 [lo,hi] 內＝1，超出的部分依相對距離遞減（soft 越大越寬容）。"""
    if lo <= v <= hi:
        return 1.0
    d = (lo - v) / max(lo, 1e-9) if v < lo else (v - hi) / max(hi, 1e-9)
    return float(max(0.0, 1.0 - d / soft))


def _shape_score(shape, area, bbox):
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if w <= 0 or h <= 0:
        return 0.0
    fill = area / float(w * h)
    asp = w / float(h)
    if shape == "ellipse":
        return min(_fit(fill, 0.62, 0.95, 0.4), _fit(asp, 0.4, 2.5, 1.0))
    if shape == "bar":
        return min(_fit(asp, 1.8, 40.0, 0.6), _fit(fill, 0.5, 1.0, 0.5))
    if shape == "triangle":
        return _fit(fill, 0.3, 0.65, 0.4)
    if shape == "rect":
        return _fit(fill, 0.75, 1.0, 0.4)
    if shape == "blob":
        return _fit(fill, 0.4, 0.95, 0.5)
    return 1.0


def _blur(w, k):
    """方形平均模糊（積分圖）。k：半徑像素。"""
    k = int(max(1, k))
    H, W = w.shape
    S = np.zeros((H + 1, W + 1))
    S[1:, 1:] = w.cumsum(0).cumsum(1)
    y0, y1 = np.clip(np.arange(H) - k, 0, H), np.clip(np.arange(H) + k + 1, 0, H)
    x0, x1 = np.clip(np.arange(W) - k, 0, W), np.clip(np.arange(W) + k + 1, 0, W)
    tot = S[y1][:, x1] - S[y0][:, x1] - S[y1][:, x0] + S[y0][:, x0]
    return tot / ((y1 - y0)[:, None] * (x1 - x0)[None, :])


def _ellipse_weight(shape, cx, cy, rx, ry, power=2):
    H, W = shape
    yy, xx = np.mgrid[0:H, 0:W]
    r2 = ((xx + 0.5 - cx) / max(rx, 1e-6)) ** 2 + ((yy + 0.5 - cy) / max(ry, 1e-6)) ** 2
    return np.where(r2 < 1, (1 - r2) ** power, 0.0)


# ------------------------------------------------------------------ 容器偵測
def container_candidates(lab, containers, limit=6):
    """容器候選（還沒驗證裡面有沒有五官）：對每個容器，把每個顏色族群「單獨」找一次，再找一次聯集；
    不能只用聯集——棕色頭髮與棕色皮膚的族群重疊，聯集會把頭髮併進臉。回傳依形狀／大小分數排序的 [(容器, 元件, 分數)]。"""
    H, W = lab.shape[:2]
    img_area = float(H * W)
    cands = []
    for cont in containers:
        v = cont["value"]
        fams = v.get("colors") or []
        if not fams:
            continue
        variants = [[f] for f in fams] + ([fams] if len(fams) > 1 else [])
        seen = set()
        for vf in variants:
            for comp in components(color_mask(lab, vf), min_area=max(30, int(0.002 * img_area)), limit=8):
                key = (tuple(comp["bbox"]), comp["area"])
                if key in seen:
                    continue
                seen.add(key)
                ratio = comp["area"] / img_area
                lo, hi = (v.get("size") or [0.02, 0.7])
                a = _fit(ratio, lo, hi, 0.8)
                s = _shape_score(v.get("shape", "ellipse"), comp["area"], comp["bbox"])
                touch = (comp["bbox"][0] <= 0) + (comp["bbox"][1] <= 0) + (comp["bbox"][2] >= W) + (comp["bbox"][3] >= H)
                tt = 1.0 if touch <= 1 else 0.6  # 整塊貼著影像邊緣的多半是背景
                score = float((a * s * tt) ** (1 / 3.0))
                if score >= CONTAINER_MIN_SCORE:
                    cands.append((cont, comp, score))
    cands.sort(key=lambda x: -x[2])
    return cands[:limit]


# ------------------------------------------------------------------ 部位比對
def _window(box, cb, shape):
    H, W = shape
    cw, ch = cb[2] - cb[0], cb[3] - cb[1]
    x0, y0 = cb[0] + box[0] * cw, cb[1] + box[1] * ch
    x1, y1 = cb[0] + box[2] * cw, cb[1] + box[3] * ch
    return int(max(0, np.floor(x0))), int(max(0, np.floor(y0))), int(min(W, np.ceil(x1))), int(min(H, np.ceil(y1)))


def _prior(part, cb, shape, conf=0.15):
    """位置先驗：照 box 的中心與 size 中間值放橢圓。"""
    cw, ch = cb[2] - cb[0], cb[3] - cb[1]
    b = part.get("box") or [0.25, 0.25, 0.75, 0.75]
    n = int(part.get("count") or 1)
    sz = part.get("size") or [0.01, 0.05]
    area = (sz[0] + sz[1]) / 2.0 * cw * ch
    out = []
    cy = cb[1] + (b[1] + b[3]) / 2.0 * ch
    xs = [cb[0] + (b[0] + b[2]) / 2.0 * cw] if n == 1 else [cb[0] + (b[0] + (b[2] - b[0]) * f) * cw for f in (0.25, 0.75)]
    wbox = (b[2] - b[0]) * cw
    hbox = (b[3] - b[1]) * ch
    for x in xs:
        rw = max(2.0, min(np.sqrt(area * max(wbox / max(hbox, 1e-6), 0.3) / np.pi) * 1.0, wbox / 2.0))
        rh = max(2.0, min(area / (np.pi * rw), hbox / 2.0))
        out.append({"bbox": (x - rw, cy - rh, x + rw, cy + rh), "cx": float(x), "cy": float(cy), "rx": float(rw), "ry": float(rh), "mask": None, "confidence": conf, "source": "prior"})
    return out


def match_part(part, cb, cont_area, lab, taken, bg_color=None, cont_ref=None):
    """依部位定義在容器 cb 裡找這個部位。回傳 [{bbox, cx, cy, mask(或 None), confidence, source}]。"""
    H, W = lab.shape[:2]
    det = part.get("detect") or {}
    n = int(part.get("count") or 1)
    sym = bool(part.get("symmetric")) and n == 2
    fams = part.get("colors") or []
    prior_only = bool(det.get("prior_only")) or not fams
    min_conf = float(det.get("min_confidence") or 0.0)
    box = part.get("box") or [0, 0, 1, 1]
    wx0, wy0, wx1, wy1 = _window(box, cb, (H, W))
    if wx1 - wx0 < 3 or wy1 - wy0 < 3:
        return _prior(part, cb, (H, W))
    if prior_only:
        return _prior(part, cb, (H, W))
    sub = lab[wy0:wy1, wx0:wx1]
    group = part.get("group")
    is_any = any((f.get("L") == [0, 100] and f.get("a") == [-128, 127]) for f in fams)
    if is_any and bg_color is not None:  # 髮色不限：用「不像背景」找前景，再扣掉容器
        m = np.sqrt(((sub - bg_color) ** 2).sum(-1)) > 14.0
    else:
        m = color_mask(sub, fams)
        # 五官（顏色族群 group=feature：深色、嘴唇紅）要跟容器本身的顏色有對比才算：深膚色的臉，「深色」範圍跟皮膚重疊，
        # 光看顏色整張臉都會中，所以要求比容器的中位顏色更暗（ΔL ≤ -10）或更紅（Δa ≥ 8）
        if cont_ref is not None and any(f.get("group") == "feature" for f in fams):
            m &= (sub[..., 0] <= cont_ref[0] - 10.0) | (sub[..., 1] >= cont_ref[1] + 8.0)
    m &= ~taken[wy0:wy1, wx0:wx1]
    cw, ch = cb[2] - cb[0], cb[3] - cb[1]
    sz = part.get("size") or [0.001, 1.0]
    comps = components(m, min_area=max(3, int(0.0003 * cont_area)), limit=30)
    cands = []
    for c in comps:
        ratio = c["area"] / float(max(cont_area, 1))
        bb = (c["bbox"][0] + wx0, c["bbox"][1] + wy0, c["bbox"][2] + wx0, c["bbox"][3] + wy0)
        a = _fit(ratio, sz[0], sz[1], 0.9)
        s = _shape_score(part.get("shape", "any"), c["area"], c["bbox"])
        ecx, ecy = (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0
        cands.append({"bbox": bb, "cx": c["cx"] + wx0, "cy": c["cy"] + wy0, "area": c["area"], "q": float((a * s) ** 0.5), "comp": c, "off": (wx0, wy0)})
    if not cands:
        return _prior(part, cb, (H, W))
    axis = (cb[0] + cb[2]) / 2.0
    picks = []
    if sym:
        best = None
        left = [c for c in cands if c["cx"] < axis]
        right = [c for c in cands if c["cx"] >= axis]
        for l in left:
            for r in right:
                mirror = 1.0 - min(1.0, abs(((l["cx"] + r["cx"]) / 2.0 - axis)) / max(cw * 0.2, 1.0))
                ys = 1.0 - min(1.0, abs(l["cy"] - r["cy"]) / max(ch * 0.15, 1.0))
                sim = 1.0 - min(1.0, abs(l["area"] - r["area"]) / float(max(l["area"], r["area"])))
                sc = (l["q"] * r["q"]) ** 0.5 * (0.4 * mirror + 0.3 * ys + 0.3 * sim)
                if best is None or sc > best[0]:
                    best = (sc, l, r)
        if best and best[0] >= max(min_conf, 0.12):
            picks = [(best[1], best[0]), (best[2], best[0])]
    else:
        scored = []
        for c in cands:
            wcx, wcy = (wx0 + wx1) / 2.0, (wy0 + wy1) / 2.0
            d = np.hypot((c["cx"] - wcx) / max(wx1 - wx0, 1), (c["cy"] - wcy) / max(wy1 - wy0, 1))
            scored.append((c["q"] * (1.0 - min(1.0, d)), c))
        scored.sort(key=lambda x: -x[0])
        for sc, c in scored[:n]:
            if sc >= max(min_conf, 0.1):
                picks.append((c, sc))
    if not picks:
        return _prior(part, cb, (H, W))
    out = []
    for c, sc in picks:
        mask = np.zeros((H, W), dtype=bool)
        comp = c["comp"]
        wx0_, wy0_ = c["off"]
        sel = comp["labels"] == comp["label"]
        mask[wy0_:wy0_ + sel.shape[0], wx0_:wx0_ + sel.shape[1]] = sel
        out.append({"bbox": c["bbox"], "cx": c["cx"], "cy": c["cy"], "mask": mask, "confidence": round(float(sc), 3), "source": "detected"})
    return out


# ------------------------------------------------------------------ 主流程
def _run_container(lab, cont, comp, score):
    """對一個容器候選實際比對所有子部位。回傳 (result dict, 證據分數 0~1)。"""
    H, W = lab.shape[:2]
    cv = cont["value"]
    cb = comp["bbox"]
    cmask = comp["labels"] == comp["label"]
    cont_area = comp["area"]
    taken = np.zeros((H, W), dtype=bool)
    border = np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])
    bg = np.median(border, axis=0)
    cref = np.median(lab[cmask], axis=0)
    result = {"container": {"id": cont["key"], "group": cv.get("group"), "bbox": [int(v) for v in cb], "confidence": round(score, 3), "mask": cmask, "depth": cv.get("depth"),
                            "attach": [a["_ref"]["key"] if isinstance(a, dict) and "_ref" in a else a for a in (cv.get("attach") or [])]}, "parts": []}
    ev_num = ev_den = 0.0
    for p in sorted(cv.get("parts") or [], key=lambda q: -int(q.get("priority") or 0)):
        pid = (p.get("_ref") or {}).get("key") or "part"
        w = 1.0 + float(p.get("priority") or 0) / 10.0
        prior_only = bool((p.get("detect") or {}).get("prior_only"))
        found_parts = match_part(dict(p), cb, cont_area, lab, taken | cmask if p.get("group") == "hair" else taken, bg_color=bg, cont_ref=cref)
        for k, fp in enumerate(found_parts):
            if fp.get("mask") is not None:
                taken |= fp["mask"]
            result["parts"].append({"id": pid, "group": p.get("group"), "index": k, "bbox": [round(float(v), 1) for v in fp["bbox"]], "confidence": fp["confidence"],
                                    "source": fp["source"], "depth": p.get("depth"), "mask": fp.get("mask"), "rx": fp.get("rx"), "ry": fp.get("ry"), "cx": fp["cx"], "cy": fp["cy"],
                                    "attach": [a["_ref"]["key"] if isinstance(a, dict) and "_ref" in a else a for a in (p.get("attach") or [])]})
        if not prior_only:  # 位置先驗的部位本來就沒有證據，不計入
            n = max(1, int(p.get("count") or 1))
            ev_den += w
            ev_num += w * sum(fp["confidence"] for fp in found_parts if fp["source"] == "detected") / n
    return result, (ev_num / ev_den if ev_den else 0.0)


def detect_parts(lab, parts_data):
    """回傳 {container: {...} 或 None, parts: [...], reason}。每個 part：{id, group, bbox, confidence, source, depth, mask?}。
    容器候選（顏色、大小、形狀）每一個都實際比對一次部位，用「找到的五官證據」加權後才選：
    只靠形狀與顏色，棕色頭髮會被當成臉，裡面有沒有眼睛嘴巴才是區分的關鍵。最後的信心 ＝ 形狀分數 ×（0.4 + 0.6 × 五官證據）。"""
    containers = [c for c in (parts_data or {}).get("containers", []) if c.get("value", {}).get("parts")]
    if not containers:
        return {"container": None, "parts": [], "reason": "知識庫裡沒有可用的容器定義（visual_part 的 parts）"}
    cands = container_candidates(lab, containers)
    if not cands:
        return {"container": None, "parts": [], "reason": "沒有偵測到符合的容器（臉或動物臉）：顏色、大小或形狀都對不上；這張圖可能沒有臉，或臉的顏色不在已登記的顏色族群裡（可以用 ref_define 補顏色族群與容器）"}
    best = None
    for cont, comp, score in cands:
        res, ev = _run_container(lab, cont, comp, score)
        total = score * (0.4 + 0.6 * ev)
        res["container"]["confidence"] = round(total, 3)
        res["container"]["evidence"] = round(ev, 3)
        if best is None or total > best[0]:
            best = (total, res)
    if best[0] < CONTAINER_MIN_SCORE * 0.7:
        return {"container": None, "parts": [], "reason": "有顏色與形狀接近的區塊，但裡面找不到對應的五官／部位，信心太低（%.2f），不當成臉" % best[0]}
    return best[1]


def apply_part_depth(res, detection, scale=1.0):
    """把偵測到的部位的凸凹加到 2.5D 模型頂點的 z（xy、UV 完全不動）。回傳實際套用的部位數。"""
    c = detection.get("container")
    if not c:
        return 0
    H, W = res.size[1], res.size[0]
    V = res.mesh.vertices
    X = np.clip((V[:, 0]).astype(int), 0, W - 1)
    Y = np.clip((V[:, 1]).astype(int), 0, H - 1)
    cb = c["bbox"]
    unit = DEPTH_UNIT * min(cb[2] - cb[0], cb[3] - cb[1]) * scale
    dz = np.zeros(len(V))
    k = max(2, int(0.03 * (cb[2] - cb[0])))
    n = 0
    # 容器：圓頂
    d = c.get("depth") or {}
    if d.get("kind") in ("bump", "sunken") and d.get("amp"):
        cx, cy = (cb[0] + cb[2]) / 2.0, (cb[1] + cb[3]) / 2.0
        dome = _ellipse_weight((H, W), cx, cy, (cb[2] - cb[0]) / 2.0, (cb[3] - cb[1]) / 2.0, power=1)
        w = _blur(c["mask"].astype(float), k) * dome
        dz += (1 if d["kind"] == "bump" else -1) * float(d["amp"]) * unit * w[Y, X]
        n += 1
    for p in detection["parts"]:
        d = p.get("depth") or {}
        if d.get("kind") not in ("bump", "sunken") or not d.get("amp"):
            continue
        if p.get("mask") is not None:
            w = _blur(p["mask"].astype(float), k)
        else:
            rx = p.get("rx") or max(2.0, (p["bbox"][2] - p["bbox"][0]) / 2.0)
            ry = p.get("ry") or max(2.0, (p["bbox"][3] - p["bbox"][1]) / 2.0)
            w = _ellipse_weight((H, W), p["cx"], p["cy"], rx * 1.6, ry * 1.6, power=2)
        dz += (1 if d["kind"] == "bump" else -1) * float(d["amp"]) * unit * w[Y, X] * (1.0 if p["source"] == "detected" else 0.6)
        n += 1
    res.mesh.vertices = V.copy()
    res.mesh.vertices[:, 2] = V[:, 2] + dz
    return n


def refine_boxes(detection, image_size, size=8):
    """偵測到的臉（含上方頭髮與兩側）要細分到的範圍：[(x0,y0,x1,y1,leaf_size)]。大片平色的臉在四叉樹裡是很大的格子，頂點太稀疏，
    局部深度（圓頂、眼窩、鼻子）加不上去；這個範圍內強制切到 leaf_size。"""
    c = detection.get("container")
    if not c:
        return []
    W, H = image_size
    x0, y0, x1, y1 = c["bbox"]
    w, h = x1 - x0, y1 - y0
    return [(max(0, int(x0 - 0.3 * w)), max(0, int(y0 - 0.55 * h)), min(W, int(x1 + 0.3 * w)), min(H, int(y1 + 0.2 * h)), int(size))]


def summarize(detection):
    c = detection.get("container")
    return {
        "container": ({"id": c["id"], "bbox": c["bbox"], "confidence": c["confidence"]} if c else None),
        "reason": detection.get("reason"),
        "parts": [{"id": p["id"], "index": p["index"], "bbox": p["bbox"], "confidence": p["confidence"], "source": p["source"], "attach": p.get("attach") or []} for p in detection.get("parts", [])],
    }


def load_parts(source):
    """source：parts.json 的路徑或已載入的 dict。"""
    if isinstance(source, dict):
        return source
    with open(source, "r", encoding="utf-8") as f:
        return json.load(f)
