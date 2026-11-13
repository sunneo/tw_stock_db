#!/usr/bin/env python
"""把評量結果轉成描述檔（descriptor）與把關認得的 eval.groups 格式（DESIGN.lora-training.md §32.2）。

輸入：eval_run.py 的 JSON（groups 為 {n, base, tuned}，可有 neg／pos；--regate 重算後的 JSON 會有 neg／pos）
      或已是 {adapter, base, n} 格式的 JSON（codewrite／reading 的結果）。
輸出：{"groups": {name: {"adapter", "base", "n", ["neg", "pos"], ["scope": "out"]}}}，scope 依 eval_scope.json。
用法：.venv/bin/python make_card_eval.py <R> <評量 JSON> <輸出 JSON>
"""
import json, re, sys

R, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
scope = json.load(open("eval_scope.json", encoding="utf-8")).get(R, {"out": []})
pats = [re.compile(p) for p in scope.get("out", [])]
d = json.load(open(src, encoding="utf-8"))
groups = {}
for name, v in d["groups"].items():
    adapter = v["adapter"] if "adapter" in v else v["tuned"]
    g = {"adapter": adapter, "base": v["base"], "n": v["n"]}
    for k in ("neg", "pos"):
        if k in v:
            g[k] = v[k]
    if any(p.search(name) for p in pats):
        g["scope"] = "out"
    groups[name] = g
json.dump({"groups": groups, "scope": scope}, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
n_out = sum(1 for g in groups.values() if g.get("scope") == "out")
print(f"{R}: groups {len(groups)}（範圍外 {n_out}）→ {dst}")
