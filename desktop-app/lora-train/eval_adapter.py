#!/usr/bin/env python
"""Compare base Qwen3-0.6B vs base+LoRA adapter on heldout.jsonl (greedy decoding, CPU).
Scoring is exact match on the normalized completion (whitespace stripped; for {"choice": N}
rows the integer is compared). Every group is reported, including groups where the adapter
loses to the base -- no cherry-picking (see DESIGN.lora-training.md section 8).

    lora-train/.venv/Scripts/python lora-train/eval_adapter.py --adapter_dir lora-train/out/adapter_r2
"""
import argparse, json, re, collections
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel


def norm(s):
    s = s.strip()
    m = re.search(r'"choice"\s*:\s*"?(\d+)"?', s)
    return 'choice=' + m.group(1) if m else re.sub(r'\s+', '', s)


def run(model, tok, rows, max_new):
    out = []
    for r in rows:
        ids = tok.apply_chat_template(r['messages'], tokenize=True, add_generation_prompt=True, enable_thinking=False, return_dict=True)
        x = torch.tensor([ids['input_ids']])
        with torch.no_grad():
            y = model.generate(x, max_new_tokens=max_new, do_sample=False, pad_token_id=tok.eos_token_id)
        out.append(tok.decode(y[0][x.shape[1]:], skip_special_tokens=True))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='Qwen/Qwen3-0.6B')
    ap.add_argument('--adapter_dir', required=True)
    ap.add_argument('--eval_file', default='lora-train/data/heldout.jsonl')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--max_new', type=int, default=24)
    a = ap.parse_args()
    rows = [json.loads(l) for l in open(a.eval_file, encoding='utf-8') if l.strip()]
    if a.limit: rows = rows[:a.limit]
    tok = AutoTokenizer.from_pretrained(a.base)
    base = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.float32).eval()
    base_out = run(base, tok, rows, a.max_new)
    tuned = PeftModel.from_pretrained(base, a.adapter_dir).eval()
    tuned_out = run(tuned, tok, rows, a.max_new)
    g = collections.defaultdict(lambda: [0, 0, 0])
    for r, b, t in zip(rows, base_out, tuned_out):
        k = r['domain'] + '/' + r['stage']; want = norm(r['completion'])
        g[k][0] += 1; g[k][1] += norm(b) == want; g[k][2] += norm(t) == want
    print('group\tn\tbase\ttuned')
    for k, (n, b, t) in sorted(g.items()):
        print(f'{k}\t{n}\t{b}/{n}\t{t}/{n}' + ('\tREGRESSION' if t < b else ''))
    tp = collections.Counter(re.sub(r'\D', '', r['completion']) for r in rows)
    print('answer position distribution:', dict(tp))


if __name__ == '__main__':
    main()
