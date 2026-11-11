#!/usr/bin/env python
"""從 score_gen.js 的實跑輸出自動產生 model card 的 metrics（不手寫數字）。
用法: .venv/bin/python make_metrics.py <tuned_scored_json> [--eval_file data/heldout_v1.jsonl]
輸出 JSON：{"split_legal_rate":{"base","tuned","n"}, "fc_format_rate":{...}（只在有 fc 組時）}"""
import json, re, subprocess, sys
tuned, *rest = sys.argv[1:]
out = subprocess.run(["node", "score_gen.js", "out/eval/base.json", tuned, "--eval_file", "data/heldout_v1.jsonl"],
                     capture_output=True, text=True, check=True).stdout
sec = None; vals = {}
for line in out.splitlines():
    if line and not line.startswith(" "):
        sec = line.strip()
    m = re.match(r"\s+(\w+)\s+base\.json (\d+)/(\d+)\s+\S+\.json (\d+)/(\d+)", line)
    if m and sec:
        vals[(sec, m.group(1))] = (int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)))
b, n, t, _ = vals[("fn_template/code_split", "valid")]
metrics = {"split_legal_rate": {"base": round(b / n, 4), "tuned": round(t / _ , 4), "n": n}}
json.dump(metrics, open(sys.argv[0].replace("make_metrics.py", "out/eval/decompose_metrics.json"), "w"), indent=1)
print(json.dumps(metrics, ensure_ascii=False)); print("source:", vals[("fn_template/code_split", "valid")])
