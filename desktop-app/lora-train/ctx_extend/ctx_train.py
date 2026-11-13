#!/usr/bin/env python
"""長文 LoRA 微調（適應 YaRN 後的旋轉位置）→ 合併 → 完整 HF 資料夾。DESIGN.offline-training-studio.md §16。

每一步（optimizer step）的資料：
  - 1 段長文窗（--long_len 個權杖，預設 8192）
  - 2 段短文窗（--short_len 個權杖，預設 1024），避免原長度內的能力退步
loss 是各段 token 的平均（依 token 數加權）。LoRA 放在每層 7 個線性層（與 lora-train 的慣例相同）。
lm_head 與交叉熵分段計算（每段 2048 權杖，逐段 checkpoint），避免 8K×15 萬詞表的整張 logits 佔滿記憶體。

用法（CPU，約 2 小時內可跑完 --steps 40 的預設）：
  ~/fa-work/ctx/venv/bin/python lora-train/ctx_extend/ctx_train.py --factor 2 --out <新空目錄> --steps 40
輸出：<out>/hf（merge 後的完整權重＋YaRN config＋tokenizer）、<out>/adapter、<out>/train_log.json
"""
import argparse
import json
import math
import os
import random
import sys
import time

import torch
import torch.nn.functional as F
from torch.utils.checkpoint import checkpoint

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ctx_common import BASE_DIR, corpus_docs, encode, join_docs, write_config  # noqa: E402


def chunked_ce(hidden, lm_head, labels, chunk=2048):
    """hidden [T,D]、labels [T]（已位移）；回傳 (loss 總和, token 數)。"""
    total = hidden.new_zeros(())
    n = labels.numel()
    for s in range(0, n, chunk):
        h = hidden[s:s + chunk]
        y = labels[s:s + chunk]

        def part(hh, yy):
            lg = lm_head(hh).float()
            return F.cross_entropy(lg, yy, reduction="sum")
        total = total + checkpoint(part, h, y, use_reentrant=False)
    return total, n


def window_loss(core, ids):
    """core：get_base_model() 取得的 Qwen3ForCausalLM（LoRA 已注入其線性層）；ids: LongTensor [1, L]。回傳 (loss 總和, token 數)。"""
    out = core.model(input_ids=ids, use_cache=False)
    hidden = out.last_hidden_state[0, :-1]
    labels = ids[0, 1:]
    return chunked_ce(hidden, core.lm_head, labels)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=BASE_DIR)
    ap.add_argument("--factor", type=int, default=2, choices=[1, 2, 4])
    ap.add_argument("--out", required=True)
    ap.add_argument("--steps", type=int, default=40)
    ap.add_argument("--long_len", type=int, default=8192)
    ap.add_argument("--short_len", type=int, default=1024)
    ap.add_argument("--short_per_step", type=int, default=2)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=8)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--threads", type=int, default=24)
    ap.add_argument("--stop_file", default="", help="存在就存檔並停止（與 train_full 相同的暫停慣例）")
    a = ap.parse_args()

    torch.manual_seed(a.seed)
    random.seed(a.seed)
    torch.set_num_threads(a.threads)
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()

    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import LoraConfig, get_peft_model

    from transformers import AutoConfig
    cfg_dir = os.path.join(a.out, "config_src")
    write_config(a.base, cfg_dir, a.factor)
    tok = AutoTokenizer.from_pretrained(a.base)
    cfg = AutoConfig.from_pretrained(cfg_dir)
    model = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.float32, config=cfg)
    model.config.use_cache = False
    print(f"[model] factor={a.factor} rope={model.config.rope_parameters} max_pos={model.config.max_position_embeddings}", flush=True)

    train_docs, held_docs = corpus_docs()
    train_ids = encode(tok, join_docs(train_docs))
    print(f"[data] 訓練文件 {len(train_docs)} 份，權杖 {len(train_ids)}；留出文件 {len(held_docs)} 份（不進訓練）", flush=True)
    if len(train_ids) < a.long_len + 1:
        raise SystemExit("訓練文字不足一個長窗")

    lcfg = LoraConfig(r=a.rank, lora_alpha=2 * a.rank, lora_dropout=0.0, bias="none",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lcfg)
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    model.train()
    core = model.get_base_model()
    trainable = [p for p in model.parameters() if p.requires_grad]
    print(f"[lora] 可訓練參數 {sum(p.numel() for p in trainable)}", flush=True)

    opt = torch.optim.AdamW(trainable, lr=a.lr, weight_decay=0.0)
    warm = max(1, a.steps // 10)

    def lr_at(s):
        if s < warm:
            return a.lr * (s + 1) / warm
        return a.lr * max(0.0, (a.steps - s) / max(1, a.steps - warm))

    rng = random.Random(a.seed)
    log = []
    stop = False
    for step in range(a.steps):
        if a.stop_file and os.path.exists(a.stop_file):
            print("[stop] 偵測到停止檔，存檔後結束", flush=True)
            break
        for g in opt.param_groups:
            g["lr"] = lr_at(step)
        windows = []
        s0 = rng.randrange(0, len(train_ids) - a.long_len - 1)
        windows.append(train_ids[s0:s0 + a.long_len + 1])
        for _ in range(a.short_per_step):
            s1 = rng.randrange(0, len(train_ids) - a.short_len - 1)
            windows.append(train_ids[s1:s1 + a.short_len + 1])
        total_loss = 0.0
        total_tok = sum(len(w) - 1 for w in windows)
        opt.zero_grad(set_to_none=True)
        for w in windows:
            ids = torch.tensor([w], dtype=torch.long)
            s, n = window_loss(core, ids)
            (s / total_tok).backward()
            total_loss += float(s.detach()) / total_tok
        torch.nn.utils.clip_grad_norm_(trainable, 1.0)
        opt.step()
        rec = {"step": step + 1, "loss": round(total_loss, 5), "lr": lr_at(step), "elapsed_s": round(time.time() - t0, 1)}
        log.append(rec)
        print(f"[step] {rec}", flush=True)
        if not math.isfinite(total_loss):
            raise SystemExit("loss 不是有限數，停止")

    adir = os.path.join(a.out, "adapter")
    model.save_pretrained(adir)
    merged = model.merge_and_unload()
    merged.config.use_cache = True
    hf_dir = os.path.join(a.out, "hf")
    merged.save_pretrained(hf_dir, safe_serialization=True)
    tok.save_pretrained(hf_dir)
    write_config(a.base, hf_dir, a.factor)  # 覆寫成我們的 YaRN config（save_pretrained 會寫 transformers 5 的格式）
    with open(os.path.join(a.out, "train_log.json"), "w", encoding="utf-8") as f:
        json.dump({"factor": a.factor, "steps_done": len(log), "steps_planned": a.steps, "long_len": a.long_len,
                   "short_len": a.short_len, "short_per_step": a.short_per_step, "lr": a.lr, "rank": a.rank,
                   "seed": a.seed, "train_docs": [n for n, _ in train_docs], "held_docs": [n for n, _ in held_docs],
                   "log": log, "total_seconds": round(time.time() - t0, 1), "peak_rss_mb": round(_rss_mb(), 1)},
                  f, ensure_ascii=False, indent=1)
    print(f"[done] hf={hf_dir} steps={len(log)} seconds={round(time.time() - t0, 1)}", flush=True)


def _rss_mb():
    import resource
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


if __name__ == "__main__":
    main()
