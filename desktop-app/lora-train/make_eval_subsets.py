#!/usr/bin/env python
"""從 data/heldout.jsonl（gen/merge_dataset.js 產生，split=heldout）切出四顆的評量子集（DESIGN.lora-training.md §27.8）。
每個 domain/stage 依 id 排序後均勻抽樣，上限 cap 列；基底與微調用同一批（沒有重抽）。
輸出：data/eval_<name>.jsonl。用法：.venv/bin/python make_eval_subsets.py
"""
import json, os

SETS = {
    # decompose-r4-v2：拆題（code_split／code_write_fn）、UML 編輯、think_stack 的三種封閉題
    "decompose-r4-v2": {"fn_template/code_split": 60, "fn_template/code_write_fn": 60,
                        "uml_design/uml_edit_real": 30, "uml_design/uml_edit_shuf": 30,
                        "think_stack/plan_check": 60, "think_stack/review_return": 60, "think_stack/self_validate": 60},
    # toolcall-r4：工具選擇、接線、when2call 四種、agent、natural、writer
    "toolcall-r4": {"tool_routing/choose_tool_full": 61, "toolwire/wiring": 60,
                    "when2call/w2c_call": 60, "when2call/w2c_ask": 25, "when2call/w2c_direct": 60,
                    "when2call/w2c_nofit": 60, "when2call/w2c_missing": 55,
                    "agent/agent_call_ref": 30, "agent/agent_use": 30, "agent/agent_ask": 10,
                    "agent/agent_direct": 20, "agent/agent_nofit": 5, "natural/natural_call": 38,
                    "writer/writer_answer": 12, "writer/writer_copycode": 3, "writer/writer_unsure": 3},
    # plan-r4：think_stack 的 plan_check、review_return、self_validate（與 decompose 同源，評量判準相同）
    "plan-r4": {"think_stack/plan_check": 60, "think_stack/review_return": 60, "think_stack/self_validate": 60},
    # colu-r4：CoLU 字母選單、blockly 微選擇
    "colu-r4": {"colu/colu_letter_choice": 57, "colu/colu_letter_choice_nonefirst": 57, "blockly_matrix/block_micro_select": 48},
}

rows = [json.loads(l) for l in open("data/heldout.jsonl", encoding="utf-8") if l.strip()]
by = {}
for r in rows:
    by.setdefault(r["domain"] + "/" + r["stage"], []).append(r)

for name, caps in SETS.items():
    out = []
    for k in sorted(caps):
        rs = sorted(by.get(k, []), key=lambda r: r["id"])
        cap = caps[k]
        if len(rs) > cap:
            step = len(rs) / cap
            rs = [rs[int(i * step)] for i in range(cap)]
        out.extend(rs)
    with open(f"data/eval_{name}.jsonl", "w", encoding="utf-8") as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(name, len(out))
