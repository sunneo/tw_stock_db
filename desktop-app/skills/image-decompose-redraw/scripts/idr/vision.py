# -*- coding: utf-8 -*-
"""With Vision AI 軌道：請視覺模型決定每個區域「是什麼、誰在前面」，覆蓋純幾何猜的景深順序。

模型怎麼來：腳本用標準的 openai／anthropic 寫法呼叫（帶圖片訊息）。在 Floating AI Assistant 裡執行技能包時，
Python API 轉接層會把這個呼叫轉給助理已設定、而且支援讀圖的 LLM Model（金鑰、網址、model 名稱都不用管）；
全部 Model 都不支援讀圖時丟 NotSupportedError，pipeline 在 vision="auto" 時就退回純幾何。
在別的環境（沒有轉接）會用真正的 SDK，需要自己的金鑰。

給模型看的東西：①原圖 ②同一張標籤圖的著色版（每個區域塗上平均色、畫出邊界、在重心標上編號）。這樣模型說的「3 號」
就是 res.regions.label 裡的 3，兩條軌道共用同一組幾何。模型只要回 JSON：
    {"regions": [{"id": 3, "label": "天空", "depth": 0}, ...]}      depth 越小越遠（0＝最遠的背景）
沒被模型提到的區域保留純幾何的結果；深度順序被覆蓋後，充氣、UV、輸出（pipeline.rebuild_3d）完全不用改。
"""
import base64
import io
import json
import os
import re

import numpy as np

SYSTEM = ("你是影像分析助理。使用者給你一張圖，以及同一張圖切出的區域標籤圖（每個區域塗成平均色、標了編號）。"
          "請判斷每個編號的區域是什麼（簡短名稱），以及前後景深順序：depth 越小越遠（0 是最遠的背景），"
          "被別的東西擋住或放在別的東西上面的，depth 比較大。同一層可以給相同的 depth。"
          "只輸出 JSON，格式：{\"regions\":[{\"id\":編號,\"label\":\"名稱\",\"depth\":整數}]}，不要加說明文字。")


def _png_bytes(arr):
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8)).save(buf, "PNG")
    return buf.getvalue()


def label_image(res, max_regions=60):
    """標籤圖著色版（編號只標面積最大的 max_regions 個，免得太擠）。"""
    from PIL import Image, ImageDraw
    reg = res.regions
    H, W = reg.label.shape
    mean_rgb = np.zeros((reg.R, 3))
    for r in range(reg.R):
        mean_rgb[r] = res.rgb[reg.label == r].mean(0)
    img = mean_rgb[reg.label]
    edge = np.zeros((H, W), dtype=bool)
    edge[:, 1:] |= reg.label[:, 1:] != reg.label[:, :-1]
    edge[1:, :] |= reg.label[1:, :] != reg.label[:-1, :]
    img[edge] = [0.1, 0.1, 0.1]
    pil = Image.fromarray((img * 255).astype(np.uint8))
    d = ImageDraw.Draw(pil)
    for r in np.argsort(-reg.area)[:max_regions]:
        cx, cy = reg.centroid[r]
        lum = float(mean_rgb[r] @ [0.3, 0.59, 0.11])
        d.text((cx - 4, cy - 5), str(int(r)), fill=(0, 0, 0) if lum > 0.5 else (255, 255, 255))
    return np.asarray(pil, dtype=np.float64) / 255.0


def build_prompt(res):
    reg = res.regions
    rows = ["編號 | 面積占比 | 外框 x0,y0,x1,y1 | 碰到圖片邊緣的比例"]
    W, H = res.size
    for r in np.argsort(-reg.area)[:60]:
        rows.append("%d | %.1f%% | %s | %.0f%%" % (r, 100.0 * reg.area[r] / (W * H), ",".join(str(int(v)) for v in reg.bbox[r]), 100.0 * reg.border_frac[r]))
    return "第一張是原圖，第二張是區域標籤圖。區域資料：\n" + "\n".join(rows) + "\n請輸出 JSON。"


def _client_call(system, text, images_png, model=None):
    """用標準 SDK 的寫法問一次，回傳文字。優先 anthropic，沒有再用 openai（環境變數 IDR_VISION_CLIENT 可以指定）。"""
    pref = os.environ.get("IDR_VISION_CLIENT", "").lower()
    order = [pref] if pref in ("anthropic", "openai") else ["anthropic", "openai"]
    last = None
    for kind in order:
        try:
            if kind == "anthropic":
                import anthropic
                blocks = [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": base64.b64encode(b).decode("ascii")}} for b in images_png]
                r = anthropic.Anthropic().messages.create(model=model or "claude-sonnet", max_tokens=2000, system=system,
                                                          messages=[{"role": "user", "content": blocks + [{"type": "text", "text": text}]}])
                return "".join(getattr(b, "text", "") or "" for b in r.content)
            import openai
            parts = [{"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(b).decode("ascii")}} for b in images_png]
            r = openai.OpenAI().chat.completions.create(model=model or "gpt-4o", messages=[{"role": "system", "content": system},
                                                                                           {"role": "user", "content": parts + [{"type": "text", "text": text}]}])
            return r.choices[0].message.content or ""
        except ImportError as e:
            last = e
            continue
    raise RuntimeError("找不到可用的 anthropic 或 openai 套件：%s" % last)


def parse_regions_json(text):
    """從模型回應取出 JSON（容忍外面包了說明文字或 ``` 圍欄）。回傳 [{id,label,depth}]。"""
    m = re.search(r"\{[\s\S]*\}", text or "")
    if not m:
        raise ValueError("模型回應裡沒有 JSON")
    data = json.loads(m.group(0))
    items = data.get("regions") if isinstance(data, dict) else data
    out = []
    for it in items or []:
        try:
            out.append({"id": int(it["id"]), "label": str(it.get("label", ""))[:40], "depth": float(it["depth"])})
        except (KeyError, TypeError, ValueError):
            continue
    if not out:
        raise ValueError("JSON 裡沒有可用的區域")
    return out


def apply_depth(res, items):
    """用模型給的 depth 覆蓋被提到的區域的 z_norm／z_index，再重新充氣。回傳實際覆蓋的區域數。"""
    from .pipeline import rebuild_3d
    reg = res.regions
    ids = [it for it in items if 0 <= it["id"] < reg.R]
    if not ids:
        raise ValueError("模型回傳的區域編號都不在 0..%d 範圍內" % (reg.R - 1))
    ds = np.array([it["depth"] for it in ids])
    lo, hi = ds.min(), ds.max()
    z = reg.z_norm.copy()
    for it in ids:
        z[it["id"]] = (it["depth"] - lo) / (hi - lo) if hi > lo else 0.5
    reg.z_norm = z
    rank = np.zeros(reg.R, dtype=np.int64)
    rank[np.argsort(z, kind="stable")] = np.arange(reg.R)
    reg.z_index = rank
    reg.labels = {int(it["id"]): it["label"] for it in ids if it["label"]}
    rebuild_3d(res)
    res.depth_source = "vision"
    return len(ids)


def apply_vision_depth(res, ask=None):
    """問視覺模型並套用。ask(system, text, images_png) -> str 可以換掉（測試用）。"""
    ask = ask or _client_call
    text = ask(SYSTEM, build_prompt(res), [_png_bytes(res.rgb), _png_bytes(label_image(res))])
    return apply_depth(res, parse_regions_json(text))
