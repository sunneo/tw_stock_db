#!/usr/bin/env python
"""Self-written DPO (no trl) on top of an SFT LoRA adapter. CPU fp32. Aligned with ref/lora/train_dpo.py.

Rows: reference format {messages, tools, prefill, chosen, rejected} or our unified rows (completion == chosen);
only rows with a `rejected` different from chosen are used (default max DPO_MAX/--max_pairs = 400). chosen/rejected are the
assistant continuation after (templated prompt + prefill) + '<|im_end|>' (lora_common.encode); loss only on those tokens.
Reference log-probs = the starting adapter's outputs, precomputed ONCE before training (no second model copy).
Env: LORA_SEQ, LORA_THREADS, LORA_BATCH (pairs per step, default 4), DPO_MAX.

    lora-train/.venv/Scripts/python lora-train/train_dpo.py --adapter_dir lora-train/out/adapter_r2 \
        --train_file lora-train/data/train.jsonl --output_dir lora-train/out/adapter_r2_dpo
"""
import argparse, os, random, sys, time
import torch
import torch.nn.functional as F
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel
from lora_common import read_jsonl, normalize, encode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--adapter_dir", required=True)
    ap.add_argument("--train_file", required=True)
    ap.add_argument("--output_dir", required=True)
    ap.add_argument("--beta", type=float, default=0.1)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--max_pairs", type=int, default=int(os.environ.get("DPO_MAX", 400)))
    ap.add_argument("--batch", type=int, default=int(os.environ.get("LORA_BATCH", 4)), help="pairs per optimizer step")
    ap.add_argument("--max_steps", type=int, default=-1, help="optimizer steps cap (smoke test)")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()

    torch.set_num_threads(int(os.environ.get("LORA_THREADS", torch.get_num_threads())))
    random.seed(a.seed); torch.manual_seed(a.seed)
    raw = read_jsonl(a.train_file)
    bad = [r for r in raw if r.get("split") not in (None, "train")]
    if bad:
        raise SystemExit(f"{len(bad)} row(s) with split != 'train' (id={bad[0].get('id')!r}); heldout must never be trained on")
    rows = [normalize(r) for r in raw]
    rows = [x for x in rows if x.get("rejected") and x["rejected"] != x["chosen"]]
    random.shuffle(rows); rows = rows[: a.max_pairs]
    if not rows:
        raise SystemExit("no rows with a `rejected` field")
    print(f"[dpo] pairs={len(rows)} beta={a.beta} lr={a.lr}", flush=True)

    tok = AutoTokenizer.from_pretrained(a.base)
    m = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.float32)
    m = PeftModel.from_pretrained(m, a.adapter_dir, is_trainable=True)
    m.config.use_cache = False

    def enc(x, tail):
        ids, lab = encode(tok, x, tail=tail)
        n = sum(1 for t in lab if t != -100)   # number of loss tokens (continuation + <|im_end|>)
        return ids, n

    pairs = [(enc(x, x["chosen"]), enc(x, x["rejected"])) for x in rows]
    pairs = [p for p in pairs if p[0][1] > 0 and p[1][1] > 0]

    def logp(batch):   # summed log-prob of the last n tokens of every sequence (right-padded batch)
        L = max(len(i) for i, _ in batch)
        ids = torch.full((len(batch), L), tok.pad_token_id); att = torch.zeros((len(batch), L), dtype=torch.long)
        for r, (i, _) in enumerate(batch):
            ids[r, : len(i)] = torch.tensor(i); att[r, : len(i)] = 1
        lg = m(input_ids=ids, attention_mask=att).logits[:, :-1].float()
        lp = torch.log_softmax(lg, -1).gather(-1, ids[:, 1:, None])[..., 0]
        return torch.stack([lp[r, len(i) - 1 - n: len(i) - 1].sum() for r, (i, n) in enumerate(batch)])

    m.eval(); ref = []
    with torch.no_grad():
        for i in range(0, len(pairs), 8):
            b = pairs[i: i + 8]; lp = logp([p[0] for p in b] + [p[1] for p in b]); n = len(b)
            ref += list(zip(lp[:n].tolist(), lp[n:].tolist()))
    print("[dpo] reference log-probs precomputed", flush=True)

    m.train()
    params = [p for p in m.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=0.0)
    B = a.batch; steps = a.epochs * ((len(pairs) + B - 1) // B); step = 0; t0 = time.time(); done = False
    for e in range(a.epochs):
        order = list(range(len(pairs))); random.shuffle(order)
        for i in range(0, len(order), B):
            bi = order[i: i + B]; n = len(bi)
            lp = logp([pairs[j][0] for j in bi] + [pairs[j][1] for j in bi]); pc, pr = lp[:n], lp[n:]
            rc = torch.tensor([ref[j][0] for j in bi]); rr = torch.tensor([ref[j][1] for j in bi])
            margin = a.beta * ((pc - rc) - (pr - rr))
            loss = -F.logsigmoid(margin).mean(); loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0); opt.step(); opt.zero_grad(); step += 1
            print(f"[dpo] ep{e} step {step}/{steps} loss {loss.item():.4f} pref_acc {(margin > 0).float().mean().item():.2f} {time.time() - t0:.0f}s", flush=True)
            if 0 < a.max_steps <= step:
                done = True; break
        if done:
            break
    os.makedirs(a.output_dir, exist_ok=True)
    m.save_pretrained(a.output_dir); tok.save_pretrained(a.output_dir)
    print(f"[dpo] saved to {a.output_dir} after {step} optimizer step(s)")


if __name__ == "__main__":
    main()
