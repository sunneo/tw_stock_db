#!/usr/bin/env python
"""從 eval_run.py 的 --json_out 實跑結果，算 function call 格式合法率（gold 是 tool call 的列；輸出能解析出合法 <tool_call> JSON）。
用法: .venv/bin/python make_fc_metrics.py out/eval/toolcall.json data/heldout_toolcall_v1.jsonl out/eval/toolcall_metrics.json
輸出 {"fc_format_rate": {"base", "tuned", "n"}}（比率為 0～1 小數）。"""
import json, re, sys
ev, heldout, out = sys.argv[1:4]
d = json.load(open(ev, encoding="utf-8"))
gold = {}
for l in open(heldout, encoding="utf-8"):
    if l.strip():
        r = json.loads(l); gold[r["id"]] = r
def valid(t):
    m = re.search(r"<tool_call>\s*(\{.*?\})\s*(?:</tool_call>|$)", t, re.S)
    if not m: return False
    try: json.loads(m.group(1)); return True
    except Exception: return False
rows = [x for x in d["rows"] if x.get("id") in gold and "<tool_call>" in ((gold[x["id"]].get("prefill") or "") + (gold[x["id"]].get("completion") or "") + (gold[x["id"]].get("chosen") or ""))]
n = len(rows)
b = sum(valid((gold[x["id"]].get("prefill") or "") + x["base_out"]) for x in rows)
t = sum(valid((gold[x["id"]].get("prefill") or "") + x["tuned_out"]) for x in rows)
metrics = {"fc_format_rate": {"base": round(b / n, 4), "tuned": round(t / n, 4), "n": n}}
json.dump(metrics, open(out, "w", encoding="utf-8"), indent=1)
print(json.dumps(metrics), f"(raw base {b}/{n}, tuned {t}/{n})")
