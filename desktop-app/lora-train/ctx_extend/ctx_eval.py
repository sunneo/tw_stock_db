#!/usr/bin/env python
"""上下文擴展的量測（HF fp32，CPU）。DESIGN.offline-training-studio.md §16。

子命令：
  passkey  藏密碼（passkey retrieval）：在長度 L 的留出文字中，於深度 d 埋一句「The pass key is N」，
           結尾問答，貪婪解碼後程式比對數字。判分：生成文字中出現正確的 5 位數 → 通過。
  ppl      留出長文的困惑度（每段 L 權杖、不重疊）與下一詞 top-1 準確率。
  short    原長度內的退步檢查：留出的 512 權杖窗（8 段）的困惑度與 top-1（與 ppl 同一判分）。

留出文件來自 ctx_common.corpus_docs()（訓練未使用的 DESIGN*.md），不是訓練資料。
每筆結果都寫進 --out（JSON），包含耗時與 ru_maxrss。
"""
import argparse
import json
import math
import os
import random
import resource
import sys
import time

import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ctx_common import corpus_docs, encode, join_docs  # noqa: E402

PASS_NUMBERS = ["48213", "71936", "30582", "95127", "16048"]
NEEDLE = "The pass key is {n}. Remember it. {n} is the pass key."
QUESTION = "\nWhat is the pass key mentioned in the text above? The pass key is"


def rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def load(model_dir):
    from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer
    cfg = AutoConfig.from_pretrained(model_dir)
    model = AutoModelForCausalLM.from_pretrained(model_dir, dtype=torch.float32, config=cfg).eval()
    tok = AutoTokenizer.from_pretrained(model_dir)
    return model, tok, cfg


def passkey_prompt(tok, hay_ids, L, depth, number):
    """組成剛好 L 權杖的提示（不含答案）：haystack 前綴 + 針 + haystack 後綴 + 問句。"""
    needle_ids = encode(tok, "\n" + NEEDLE.format(n=number) + "\n")
    q_ids = encode(tok, QUESTION)
    body = L - len(needle_ids) - len(q_ids)
    if body <= 0:
        raise ValueError("L 太短")
    hay = (hay_ids * (body // len(hay_ids) + 2))[:body]
    cut = int(round(depth * body))
    ids = hay[:cut] + needle_ids + hay[cut:]
    ids = ids + q_ids
    assert len(ids) == L, (len(ids), L)
    return ids


@torch.no_grad()
def passkey_run(model, tok, hay_ids, L, depth, number):
    ids = passkey_prompt(tok, hay_ids, L, depth, number)
    x = torch.tensor([ids], dtype=torch.long)
    t0 = time.time()
    out = model.generate(x, max_new_tokens=8, do_sample=False, use_cache=True,
                         pad_token_id=tok.eos_token_id)
    gen = tok.decode(out[0, L:], skip_special_tokens=True)
    secs = time.time() - t0
    ok = str(number) in gen
    return {"L": L, "depth": depth, "number": number, "generated": gen, "pass": ok, "seconds": round(secs, 1)}


@torch.no_grad()
def chunk_stats(model, ids, chunk=2048):
    """回傳 (NLL 總和, top-1 命中數, token 數)；只計算 ids[1:]。"""
    x = torch.tensor([ids], dtype=torch.long)
    hidden = model.model(input_ids=x, use_cache=False).last_hidden_state[0, :-1]
    labels = x[0, 1:]
    nll = 0.0
    hit = 0
    for s in range(0, labels.numel(), chunk):
        lg = model.lm_head(hidden[s:s + chunk]).float()
        y = labels[s:s + chunk]
        nll += float(F.cross_entropy(lg, y, reduction="sum"))
        hit += int((lg.argmax(-1) == y).sum())
    return nll, hit, labels.numel()


def cmd_passkey(a):
    model, tok, cfg = load(a.model)
    _, held = corpus_docs()
    hay = encode(tok, join_docs(held))
    results = []
    rnd = random.Random(a.seed)
    for L in a.lengths:
        for d in a.depths:
            num = PASS_NUMBERS[rnd.randrange(len(PASS_NUMBERS))]
            r = passkey_run(model, tok, hay, L, d, num)
            r["rss_mb"] = round(rss_mb(), 1)
            results.append(r)
            print(json.dumps(r, ensure_ascii=False), flush=True)
    return results


def cmd_ppl(a):
    model, tok, cfg = load(a.model)
    _, held = corpus_docs()
    ids = encode(tok, join_docs(held))
    out = []
    for L in a.lengths:
        nll, hit, n = 0.0, 0, 0
        starts = list(range(0, max(1, len(ids) - L), L))[: a.windows]
        t0 = time.time()
        for s in starts:
            w = ids[s:s + L]
            if len(w) < L:
                continue
            x_nll, x_hit, x_n = chunk_stats(model, w)
            nll += x_nll
            hit += x_hit
            n += x_n
        if n == 0:
            out.append({"L": L, "note": "留出文字不足一個窗"})
            continue
        r = {"L": L, "windows": len(starts), "tokens": n, "ppl": round(math.exp(nll / n), 4),
             "top1": round(hit / n, 4), "seconds": round(time.time() - t0, 1), "rss_mb": round(rss_mb(), 1)}
        out.append(r)
        print(json.dumps(r, ensure_ascii=False), flush=True)
    return out


def cmd_short(a):
    a.lengths = [512]
    a.windows = 8
    return cmd_ppl(a)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("passkey", "ppl", "short"):
        p = sub.add_parser(name)
        p.add_argument("--model", required=True, help="HF 資料夾（含 config.json 與權重）")
        p.add_argument("--out", required=True)
        p.add_argument("--threads", type=int, default=24)
        p.add_argument("--seed", type=int, default=7)
        p.add_argument("--lengths", type=int, nargs="+", default=[1024, 4096, 8192])
        p.add_argument("--depths", type=float, nargs="+", default=[0.0, 0.25, 0.5, 0.75, 1.0])
        p.add_argument("--windows", type=int, default=2)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    t0 = time.time()
    res = {"passkey": cmd_passkey, "ppl": cmd_ppl, "short": cmd_short}[a.cmd](a)
    doc = {"cmd": a.cmd, "model": a.model, "results": res, "total_seconds": round(time.time() - t0, 1),
           "peak_rss_mb": round(rss_mb(), 1)}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    print(f"[done] {a.cmd} -> {a.out}", flush=True)


if __name__ == "__main__":
    main()
