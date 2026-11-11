#!/usr/bin/env python
"""用已存的實跑輸出重新評分（不重跑模型）。用途：修正 eval_run.py 的 missing 判準後，對 out/eval/toolcall.json 重算各組。
用法: .venv/bin/python regrade_toolcall.py out/eval/toolcall.json data/heldout_toolcall_v1.jsonl out/eval/toolcall_regraded.json"""
import json, sys, collections
from lora_common import normalize
from eval_run import safe_grade
ev, heldout, out = sys.argv[1:4]
d = json.load(open(ev, encoding="utf-8"))
gold = {}
for l in open(heldout, encoding="utf-8"):
    if l.strip():
        r = json.loads(l); gold[r["id"]] = r
st = collections.defaultdict(lambda: [0, 0, 0]); det = []
for x in d["rows"]:
    g = normalize(gold[x["id"]])
    ob, ot = safe_grade(g, x["base_out"]), safe_grade(g, x["tuned_out"])
    names = [f"{x['key']}"]
    grp = gold[x["id"]].get("group") or (gold[x["id"]].get("meta") or {}).get("family")
    if grp: names.append("group/" + grp)
    for n in names:
        st[n][0] += 1; st[n][1] += bool(ob[0]); st[n][2] += bool(ot[0])
    det.append({"id": x["id"], "key": x["key"], "base_ok": bool(ob[0]), "tuned_ok": bool(ot[0]), "tuned_out": x["tuned_out"]})
res = {k: {"n": v[0], "base": v[1], "tuned": v[2]} for k, v in st.items()}
json.dump({"groups": res, "rows": det}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for k in sorted(res):
    if k.startswith(("group/git", "rtool/missing", "seen/unseen/missing", "rtool/call", "tool_routing")):
        print(k, res[k])
regress = [k for k, v in res.items() if v["tuned"] < v["base"]]
print("REGRESS", regress)
