#!/usr/bin/env python3
"""從留出集（lora-train/data，不在訓練集內）抽每個題型 3 題，寫成 lora_four_adapters.items.json（評估腳本讀它）。
用法：python3 -I scripts/eval/lora_four_adapters.make_items.py <lora-train/data 資料夾>
產品的原生路徑只做純文字生成（沒有 tools 欄位、沒有預填），所以：
  - toolcall：tools 依 Qwen3 聊天樣板的格式折進 system 訊息（與樣板渲染出的文字相同，只是由這裡預先寫好）。
  - colu／decompose／plan：不帶預填（原生不支援預填）。"""
import json, sys, os
d = sys.argv[1]
def load(f):
    return [json.loads(l) for l in open(os.path.join(d, f), encoding='utf-8') if l.strip()]
def pick(rows, n, ok=lambda r: True):
    rows = sorted([r for r in rows if ok(r)], key=lambda r: r['id'])
    step = len(rows) / n
    return [rows[int(i * step)] for i in range(n)]
def fold_tools(msgs, tools):
    head = ("\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>")
    for t in tools: head += "\n" + json.dumps(t, ensure_ascii=False)
    head += "\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{\"name\": <function-name>, \"arguments\": <args-json-object>}\n</tool_call>"
    out = [dict(m) for m in msgs]
    if out and out[0]['role'] == 'system': out[0]['content'] += head
    else: out.insert(0, {'role': 'system', 'content': head.lstrip()})
    return out
items = []
H = load('heldout.jsonl'); T = load('heldout_toolcall_v2.jsonl'); C = load('heldout_colu_v1.jsonl')
for r in pick(H, 3, lambda r: r['stage'] == 'code_split' and len(r['messages'][1]['content']) < 700):
    items.append({'type': 'decompose', 'id': r['id'], 'task': 'decompose', 'messages': r['messages'], 'gold': r['completion'], 'maxTokens': 320})
seen = set()
tc = []
for r in sorted([r for r in T if r['stage'] == 'w2c_call'], key=lambda r: r['id']):
    if r['tool'] in seen or '"arguments":{}' in r['completion']: continue
    seen.add(r['tool']); tc.append(r)
step = len(tc) / 3
for r in [tc[int(i * step)] for i in range(3)]:
    items.append({'type': 'toolcall', 'id': r['id'], 'task': 'toolcall', 'messages': fold_tools(r['messages'], r['tools']), 'gold': r['completion'], 'toolNames': [t['function']['name'] for t in r['tools']], 'maxTokens': 160})
for r in pick(C, 3, lambda r: r['stage'] == 'colu_letter_choice'):
    items.append({'type': 'colu', 'id': r['id'], 'task': 'colu', 'messages': r['messages'], 'gold': r['completion'], 'maxTokens': 6})
for r in pick(H, 3, lambda r: r['stage'] == 'plan_check'):
    items.append({'type': 'plan', 'id': r['id'], 'task': 'plan', 'messages': r['messages'], 'gold': r['completion'], 'maxTokens': 120})
json.dump(items, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lora_four_adapters.items.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(len(items), 'items')
