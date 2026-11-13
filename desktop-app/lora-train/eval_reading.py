#!/usr/bin/env python
"""閱讀理解（rc）留出評量：基底 vs 微調，同一批留出題（DESIGN.lora-training.md §27.9）。

判準（預先登記，寫在這裡，看輸出之前就定）：
  rc_extract       答對 ＝ 輸出（去掉前後空白與引號）包含標準答案（說明原文）。
  rc_quote         逐字 ＝ 輸出包含標準答案（整句原文）；另列「輸出是文中的連續子字串」率（引用一定要能在文中找到）。
  rc_unanswerable  拒答 ＝ 輸出包含「文中沒寫」。
  幻覺率           ＝ 在 rc_extract 中，輸出不是文中子字串、又不是拒答的比率（越低越好）。
  退步判定         ＝ 任一組微調 < 基底（n >= 20 才判退步；n < 20 只報告）。

用法：.venv/bin/python eval_reading.py --out out/eval/rc_base.json [--adapter_dir out/multi/reading]
      --eval_file data/reading_heldout.jsonl --per_stage 60
"""
import argparse, collections, json, os, random
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

NONE = "文中沒寫"


def pick(rows, per):
    by = collections.defaultdict(list)
    for r in rows:
        by[r["stage"]].append(r)
    out = []
    for k in sorted(by):
        rs = sorted(by[k], key=lambda r: r["id"])
        if per and len(rs) > per:
            step = len(rs) / per
            rs = [rs[int(i * step)] for i in range(per)]
        out.extend(rs)
    return out


def grade(stage, gold, text, article):
    t = text.strip().strip("「」\"'")
    if stage == "rc_unanswerable":
        return {"ok": NONE in text, "verbatim": None, "halluc": False}
    ok = gold in text
    verb = t in article if t else False
    halluc = (not ok) and NONE not in text and not verb
    return {"ok": ok, "verbatim": verb, "halluc": halluc}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="models/Qwen3-0.6B")
    ap.add_argument("--adapter_dir", default="")
    ap.add_argument("--eval_file", required=True)
    ap.add_argument("--per_stage", type=int, default=60)
    ap.add_argument("--max_new", type=int, default=160)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    torch.set_num_threads(int(os.environ.get("LORA_THREADS", torch.get_num_threads())))
    rows = pick([json.loads(l) for l in open(a.eval_file, encoding="utf-8") if l.strip()], a.per_stage)
    tok = AutoTokenizer.from_pretrained(a.base)
    model = AutoModelForCausalLM.from_pretrained(a.base, torch_dtype=torch.float32).eval()
    if a.adapter_dir:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, a.adapter_dir).merge_and_unload().eval()
    res, det = collections.defaultdict(lambda: collections.Counter()), []
    for i, r in enumerate(rows):
        msgs = r["messages"]
        prompt = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        ids = tok(prompt, return_tensors="pt")
        with torch.no_grad():
            o = model.generate(**ids, max_new_tokens=a.max_new, do_sample=False, repetition_penalty=1.1,
                               pad_token_id=tok.pad_token_id or tok.eos_token_id)
        text = tok.decode(o[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)
        text = text.split("</think>")[-1].strip()
        article = msgs[1]["content"].split("【問題】")[0]
        g = grade(r["stage"], r["completion"], text, article)
        c = res[r["stage"]]
        c["n"] += 1
        c["ok"] += int(g["ok"])
        if g["verbatim"] is not None:
            c["verbatim"] += int(g["verbatim"])
        if g["halluc"]:
            c["halluc"] += 1
        det.append({"id": r["id"], "stage": r["stage"], "gold": r["completion"], "out": text, **g})
        print(f"[rc] {i + 1}/{len(rows)}", flush=True)
    summary = {k: dict(v) for k, v in res.items()}
    json.dump({"summary": summary, "rows": det}, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for k, v in sorted(summary.items()):
        print(k, v)


if __name__ == "__main__":
    main()
