# -*- coding: utf-8 -*-
"""Vision 軌道自我檢查：python tests/test_vision.py（不需要真的模型：①直接換掉 ask；②走 Floating AI Assistant 的轉接層，假的主機端）。"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "renderer", "src", "pybridge"))
from idr import Params, decompose, vision  # noqa: E402
from test_geometric import synthetic  # noqa: E402

OK, BAD = [], []


def check(name, cond, extra=""):
    (OK if cond else BAD).append(name)
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)


img = synthetic()
P = Params(max_side=256, max_leaves=1500)
geo = decompose(img, P)
big = int(np.argmax(geo.regions.area))

# 1. 直接換掉 ask：模型把最大的區域（天空）說成最近 → 順序被覆蓋、3D 重新充氣
calls = []


def fake_ask(system, text, images):
    calls.append((text, images))
    return "好的：\n```json\n" + json.dumps({"regions": [{"id": big, "label": "天空", "depth": 9}, {"id": 999, "label": "不存在", "depth": 0}]}) + "\n```"

res = decompose(img, P)
n = vision.apply_vision_depth(res, ask=fake_ask)
check("vision overrides listed regions only", n == 1 and res.regions.z_norm[big] == 0.5 and res.depth_source == "vision")
check("two PNG images sent (original + label map)", len(calls[0][1]) == 2 and all(b[:4] == b"\x89PNG" for b in calls[0][1]))
check("prompt lists region table", "編號 | 面積占比" in calls[0][0])
check("labels kept", res.regions.labels.get(big) == "天空")
check("3D rebuilt (mesh still valid)", res.mesh.vertices.shape[1] == 3 and len(res.mesh.faces) == len(geo.mesh.faces))
items = vision.parse_regions_json('說明 {"regions":[{"id":"1","label":"a","depth":"2"},{"id":2}]} 結尾')
check("parse tolerates strings and bad items", items == [{"id": 1, "label": "a", "depth": 2.0}])
try:
    vision.parse_regions_json("沒有 json")
    check("parse rejects non-json", False)
except ValueError:
    check("parse rejects non-json", True)

# 2. 走轉接層：標準的 anthropic／openai 寫法，主機端（假的）收到的是帶 image_url 的聊天請求
import fa_bridge  # noqa: E402
SEEN = []
MODE = {"fail": False}


def fake_call(op, args=None, timeout=0):
    a = args or {}
    if op == "llm.info":
        return {"model": "vision-model"}
    if op == "llm.complete":
        SEEN.append(a)
        if MODE["fail"]:
            raise fa_bridge.NotSupported("已設定的所有 LLM Model 都不支援讀圖")
        content = json.dumps({"regions": [{"id": big, "label": "天空", "depth": 5}, {"id": 0, "label": "x", "depth": 1}]})
        return {"id": "c", "object": "chat.completion", "created": 1, "model": "vision-model", "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}], "usage": {}}
    raise fa_bridge.BridgeError("op " + op)

fa_bridge.call = fake_call
for client in ("anthropic", "openai"):
    os.environ["IDR_VISION_CLIENT"] = client
    SEEN.clear()
    r = decompose(img, P, vision="auto")
    imgs = [p for m in SEEN[0]["messages"] if isinstance(m.get("content"), list) for p in m["content"] if p.get("type") == "image_url"] if SEEN else []
    check("bridge (%s): used vision model" % client, r.stats["depth_source"] == "vision" and len(imgs) == 2 and imgs[0]["image_url"]["url"].startswith("data:image/png;base64,"), r.stats)
MODE["fail"] = True
r = decompose(img, P, vision="auto")
check("no vision model -> falls back to geometry", r.stats["depth_source"] == "geometry" and "NotSupported" in r.stats.get("vision_fallback", ""), r.stats)
try:
    decompose(img, P, vision="on")
    check("vision=on raises when unsupported", False)
except Exception as e:
    check("vision=on raises when unsupported", "NotSupported" in type(e).__name__ or "不支援" in str(e), repr(e))
print("\n%d passed, %d failed" % (len(OK), len(BAD)), BAD)
sys.exit(1 if BAD else 0)
