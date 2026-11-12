#!/usr/bin/env python
"""把 data/train.jsonl 依領域切成四顆 LoRA 的訓練檔（data/multi/<id>.jsonl）；toolcall 對 when2call／agent／toolwire 降取樣（固定種子）。"""
import json, random, collections, os
G = {"decompose": {"fn_template", "uml_design"}, "toolcall": {"when2call", "agent", "toolwire", "tool_routing", "natural", "writer"},
     "colu": {"colu", "blockly_matrix"}, "plan": {"think_stack"}}
DOWN = {"when2call": 0.4, "agent": 0.4, "toolwire": 0.4}
rows = [json.loads(l) for l in open("data/train.jsonl", encoding="utf-8") if l.strip()]
rng = random.Random(7); os.makedirs("data/multi", exist_ok=True); rep = {}
for g, doms in G.items():
    sel = [r for r in rows if r["domain"] in doms and r.get("split") == "train"]
    if g == "toolcall":
        keep = []
        for r in sel:
            if rng.random() < DOWN.get(r["domain"], 1.0): keep.append(r)
        sel = keep
    rng.shuffle(sel)
    with open(f"data/multi/{g}.jsonl", "w", encoding="utf-8") as f:
        for r in sel: f.write(json.dumps(r, ensure_ascii=False) + "\n")
    rep[g] = {"rows": len(sel), "domains": dict(collections.Counter(r["domain"] for r in sel))}
json.dump(rep, open("data/multi/summary.json", "w"), ensure_ascii=False, indent=1); print(json.dumps(rep, ensure_ascii=False))
