#!/usr/bin/env python
"""批次產生模型輸出（貪婪、不開思考），寫成 JSON，之後由 score_gen.js 評分（判題器要用 node）。

    .venv/bin/python eval_gen.py --out out/eval/base.json [--adapter_dir out/runs/r4/sft] \
        --eval_file data/heldout.jsonl --stages fn_template/code_split,fn_template/code_write_fn,think_stack/self_validate \
        --per_stage 60

--per_stage：每個 domain/stage 取前 N 筆（以 id 排序後均勻抽樣，基底與微調用同一批）。
adapter 在這支腳本裡先合併進基底再產生（與 eval_run.py 同樣做法，速度比 PeftModel 快）。
"""
import argparse, json, os, time
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MAX_NEW = {"code_split": 360, "code_write_fn": 420, "code_write": 600, "plan_check": 120, "review_return": 120, "self_validate": 60}


def pick(rows, stages, per):
    by = {}
    for r in rows:
        k = r["domain"] + "/" + r["stage"]
        if stages and k not in stages:
            continue
        by.setdefault(k, []).append(r)
    out = []
    for k, rs in sorted(by.items()):
        rs.sort(key=lambda r: r["id"])
        if per and len(rs) > per:
            step = len(rs) / per
            rs = [rs[int(i * step)] for i in range(per)]
        out += rs
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="models/Qwen3-0.6B")
    ap.add_argument("--adapter_dir", default="")
    ap.add_argument("--eval_file", default="data/heldout.jsonl")
    ap.add_argument("--stages", default="")
    ap.add_argument("--per_stage", type=int, default=0)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--threads", type=int, default=int(os.environ.get("LORA_THREADS", "12")))
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    tok = AutoTokenizer.from_pretrained(a.base)
    tok.padding_side = "left"
    model = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.float32)
    if a.adapter_dir:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, a.adapter_dir).merge_and_unload()
    model.eval()
    rows = [json.loads(l) for l in open(a.eval_file, encoding="utf-8") if l.strip()]
    rows = pick(rows, set(s for s in a.stages.split(",") if s), a.per_stage)
    # 同一個 stage 一批，長度上限用該 stage 的
    res = []
    t0 = time.time()
    groups = {}
    for r in rows:
        groups.setdefault(r["stage"], []).append(r)
    for stage, rs in groups.items():
        mx = MAX_NEW.get(stage, 60)
        rs = sorted(rs, key=lambda r: sum(len(m["content"]) for m in r["messages"]))
        for i in range(0, len(rs), a.batch):
            chunk = rs[i:i + a.batch]
            texts = [tok.apply_chat_template(r["messages"], tokenize=False, add_generation_prompt=True, enable_thinking=False) for r in chunk]
            enc = tok(texts, return_tensors="pt", padding=True)
            with torch.no_grad():
                y = model.generate(**enc, max_new_tokens=mx, do_sample=False, pad_token_id=tok.eos_token_id)
            for r, row in zip(chunk, y):
                res.append({"id": r["id"], "domain": r["domain"], "stage": r["stage"], "output": tok.decode(row[enc["input_ids"].shape[1]:], skip_special_tokens=True)})
            print(f"{stage} {min(i + a.batch, len(rs))}/{len(rs)}  {time.time() - t0:.0f}s", flush=True)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    json.dump({"adapter": a.adapter_dir, "n": len(res), "rows": res}, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)
    print("wrote", a.out, len(res), f"{time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
