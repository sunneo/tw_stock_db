#!/usr/bin/env python
"""decompose-r4-v2 的訓練檔（DESIGN.lora-training.md §17.2）：
v1（fn_template＋uml_design，677 列）＋ think_stack/self_validate 的「正例」（completion 的 ok 為 true）＋ think_stack/review_return 全部。
順序與 split_multi.py 一樣用固定種子打亂。輸出 data/multi/decompose_v2.jsonl，並印出各來源列數。
用法：.venv/bin/python build_decompose_v2.py
"""
import json, random, collections, os

rows = [json.loads(l) for l in open("data/train.jsonl", encoding="utf-8") if l.strip()]
rows = [r for r in rows if r.get("split") == "train"]

def is_ok(r):
    try:
        return json.loads(r["completion"]).get("ok") is True
    except Exception:
        return False

sel, src = [], collections.Counter()
for r in rows:
    d, s = r["domain"], r["stage"]
    if d in ("fn_template", "uml_design"):
        sel.append(r); src["v1:" + d] += 1
    elif d == "think_stack" and s == "self_validate" and is_ok(r):
        sel.append(r); src["self_validate_pos"] += 1
    elif d == "think_stack" and s == "review_return":
        sel.append(r); src["review_return"] += 1

rng = random.Random(7)
rng.shuffle(sel)
os.makedirs("data/multi", exist_ok=True)
with open("data/multi/decompose_v2.jsonl", "w", encoding="utf-8") as f:
    for r in sel:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(json.dumps({"rows": len(sel), "sources": dict(src)}, ensure_ascii=False))
