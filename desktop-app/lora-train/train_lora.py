#!/usr/bin/env python
"""LoRA SFT fine-tuning of Qwen3-0.6B on the unified dataset produced by gen/merge_dataset.js.

CPU-only by design (see requirements.txt): this machine has no CUDA GPU, and the Intel
AI Boost NPU here is inference-only, so this script never touches accelerators other
than the CPU. Run it from the project's isolated venv:

    lora-train/.venv/Scripts/python lora-train/train_lora.py --train_file lora-train/data/train.jsonl ...

Each training example comes from lora-train/schema.md's unified format:
    {"messages": [...], "completion": "...", "domain": "...", "stage": "...", "meta": {...}}
"messages" is the exact production prompt (already produced by the real recipe_core.js /
think_stack.js / uml_core.js / ... formatters -- see gen/*.js). "completion" is the single
program-verified correct assistant reply. We apply the tokenizer's own chat template so the
trained model sees exactly the token sequence production will feed it at inference time,
then mask the loss to the completion tokens only (standard SFT: don't waste gradient on
learning to reproduce the prompt).

Only "meta.thinking": true examples get enable_thinking=True in the chat template; everything
else defaults to False, matching the native runner's hardcoded enable_thinking:false path
(DESIGN.offline-text.md / DESIGN.TODO.native-runner.md).
"""
import argparse
import json
import os
import random
import sys
from dataclasses import dataclass

import torch
from torch.utils.data import Dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    Trainer,
    TrainingArguments,
)
from peft import LoraConfig, get_peft_model, TaskType
from lora_common import normalize, encode


def read_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"{path}:{line_no}: bad JSON ({e})") from e
    return rows


class ChatSFTDataset(Dataset):
    """Builds (input_ids, labels) with the prompt masked out (-100) and only the
    completion contributing to the loss. One example at a time; the data collator
    pads/batches."""

    def __init__(self, rows, tokenizer, max_seq_len):
        self.tokenizer = tokenizer
        self.max_seq_len = max_seq_len
        self.examples = []
        for row in rows:
            x = normalize(row)
            if not x.get("messages") or x["chosen"] is None:
                continue
            # same encode as eval and DPO (lora_common.encode): chat template (+tools) + prefill,
            # loss only on chosen + <|im_end|>, left-truncated to max_seq_len
            ids, labels = encode(tokenizer, x, seq=max_seq_len)
            self.examples.append({"input_ids": ids, "labels": labels, "attention_mask": [1] * len(ids)})

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, idx):
        return self.examples[idx]


@dataclass
class PadCollator:
    pad_token_id: int

    def __call__(self, batch):
        max_len = max(len(b["input_ids"]) for b in batch)
        input_ids, labels, attn = [], [], []
        for b in batch:
            pad_len = max_len - len(b["input_ids"])
            input_ids.append(b["input_ids"] + [self.pad_token_id] * pad_len)
            labels.append(b["labels"] + [-100] * pad_len)
            attn.append(b["attention_mask"] + [0] * pad_len)
        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
            "attention_mask": torch.tensor(attn, dtype=torch.long),
        }


def split_train_val(rows, val_fraction, seed):
    """Carve a validation slice out of the TRAIN split (never the frozen heldout
    files -- those are merged separately by gen/merge_dataset.js and must only be
    used for final eval, per schema.md's holdout discipline)."""
    rng = random.Random(seed)
    rows = rows[:]
    rng.shuffle(rows)
    n_val = max(1, int(len(rows) * val_fraction)) if len(rows) > 10 else 0
    return rows[n_val:], rows[:n_val]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model_name_or_path", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--train_file", required=True, help="unified JSONL, split=train only")
    ap.add_argument("--output_dir", default="lora-train/out/adapter")
    ap.add_argument("--val_fraction", type=float, default=0.1)
    ap.add_argument("--max_seq_len", type=int, default=int(os.environ.get("LORA_SEQ", 1024)))
    ap.add_argument("--num_train_epochs", type=float, default=3.0)
    ap.add_argument("--per_device_train_batch_size", type=int, default=int(os.environ.get("LORA_BATCH", 2)))
    ap.add_argument("--gradient_accumulation_steps", type=int, default=8)
    ap.add_argument("--learning_rate", type=float, default=1e-4)
    ap.add_argument("--lora_r", type=int, default=16)
    ap.add_argument("--lora_alpha", type=int, default=32)
    ap.add_argument("--lora_dropout", type=float, default=0.05)
    ap.add_argument(
        "--lora_target_modules",
        default="q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj",
    )
    ap.add_argument("--logging_steps", type=int, default=10)
    ap.add_argument("--save_steps", type=int, default=200)
    ap.add_argument("--max_steps", type=int, default=-1, help="set >0 for a quick smoke test")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--domains", default="", help="comma list to filter training to specific domains; empty = all")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    torch.set_num_threads(int(os.environ.get("LORA_THREADS", torch.get_num_threads())))

    rows = read_jsonl(args.train_file)
    bad_split = [r for r in rows if r.get("split") != "train"]
    if bad_split:
        raise SystemExit(
            f"--train_file contains {len(bad_split)} row(s) with split != 'train' "
            f"(e.g. id={bad_split[0].get('id')!r}) -- heldout data must never be trained on. "
            f"Re-run gen/merge_dataset.js or filter the file first."
        )
    if args.domains:
        wanted = set(d.strip() for d in args.domains.split(",") if d.strip())
        rows = [r for r in rows if r.get("domain") in wanted]
        print(f"[data] filtered to domains={sorted(wanted)}: {len(rows)} rows")

    if not rows:
        raise SystemExit("no training rows after filtering -- nothing to train on")

    by_domain = {}
    for r in rows:
        by_domain.setdefault(r.get("domain", "?"), 0)
        by_domain[r.get("domain", "?")] += 1
    print("[data] rows per domain:", by_domain)

    train_rows, val_rows = split_train_val(rows, args.val_fraction, args.seed)
    print(f"[data] train={len(train_rows)} val={len(val_rows)}")

    print(f"[model] loading {args.model_name_or_path} (CPU, fp32)")
    tokenizer = AutoTokenizer.from_pretrained(args.model_name_or_path)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        args.model_name_or_path, torch_dtype=torch.float32
    )
    model.config.use_cache = False  # required for gradient checkpointing / training

    lora_config = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        target_modules=[m.strip() for m in args.lora_target_modules.split(",") if m.strip()],
        bias="none",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    train_ds = ChatSFTDataset(train_rows, tokenizer, args.max_seq_len)
    val_ds = ChatSFTDataset(val_rows, tokenizer, args.max_seq_len) if val_rows else None
    collator = PadCollator(pad_token_id=tokenizer.pad_token_id)

    training_args = TrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.num_train_epochs,
        per_device_train_batch_size=args.per_device_train_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        learning_rate=args.learning_rate,
        logging_steps=args.logging_steps,
        save_steps=args.save_steps,
        save_total_limit=2,
        warmup_steps=10,
        lr_scheduler_type="linear",
        eval_strategy="steps" if val_ds else "no",
        eval_steps=args.save_steps if val_ds else None,
        max_steps=args.max_steps,
        report_to=[],
        use_cpu=True,
        bf16=False,
        fp16=False,
        dataloader_num_workers=0,
        remove_unused_columns=False,
        seed=args.seed,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=val_ds,
        data_collator=collator,
    )
    trainer.train()

    os.makedirs(args.output_dir, exist_ok=True)
    model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print(f"[done] adapter saved to {args.output_dir}")


if __name__ == "__main__":
    main()
