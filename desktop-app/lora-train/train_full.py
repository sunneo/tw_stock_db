#!/usr/bin/env python
"""完整參數微調（全部權重可訓練）的 SFT 腳本，DESIGN.lora-training.md §25（路徑 B）。

與 train_lora.py 用同一份資料與編碼（ChatSFTDataset／PadCollator／StopFileCallback 直接沿用），差別只有：
  - 不包 PEFT：整個 Qwen3-0.6B 都訓練，優化器是 HF Trainer 預設的 AdamW（記憶體：權重＋梯度＋Adam 兩份狀態，fp32 約 10 GB）。
  - 存檔是完整 HF 資料夾（safetensors＋config＋tokenizer），可直接餵 merge 之後的匯出流程：
    export_onnx.py --model <本腳本的輸出> 與 export_gguf.py --model <本腳本的輸出>（不需要 merge）。
  - 暫停／續訓與 train_lora.py 相同：--stop_file 存在就存檢查點並停；--resume_from_checkpoint 接續 checkpoint-N。
  - 存檔時也把 config.json 換回基底的（transformers 5.x 存的 rope 欄位格式 4.x 讀不到，見 merge_and_export.py）。

CPU only（這台沒有 GPU）。用 lora-train/.venv（transformers 5.x）執行：
    lora-train/.venv/bin/python lora-train/train_full.py --train_file <train.jsonl> --output_dir <新空目錄> \
        --max_steps 4 --per_device_train_batch_size 1 --gradient_accumulation_steps 1 --max_seq_len 512

注意：
  - 完整微調的輸出 **不是** 1 MB 級的 adapter，而是約 2.4 GB 的權重；每個 checkpoint 另加約 4.8 GB 的優化器狀態。
    `save_total_limit=2`，磁碟要先確認。
  - 沒有足夠資料與時間的完整訓練不在本次範圍；本腳本只保證「能跑、能暫停續訓、輸出能匯出」。
"""
import argparse
import hashlib
import json
import os
import resource
import shutil
import sys
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainerCallback, TrainingArguments

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_lora import ChatSFTDataset, PadCollator, StopFileCallback, read_jsonl, split_train_val  # noqa: E402


class FullCkptCallback(TrainerCallback):
    """每次存檔寫 checkpoint-N/fa-ckpt.json（描述與 train_lora.py 的 fa-ckpt 相同格式，但 producer／權重格式不同）。"""

    def __init__(self, meta):
        self.meta = meta

    def on_save(self, args, state, control, **kwargs):
        ck = os.path.join(args.output_dir, f"checkpoint-{state.global_step}")
        os.makedirs(ck, exist_ok=True)
        doc = {
            "format": "fa-ckpt", "version": 1, "producer": "lora-train/train_full.py",
            "step": state.global_step, "epoch": state.epoch,
            "cursor": {"order_seed": args.seed, "micro_batches_per_step": args.gradient_accumulation_steps,
                       "consumed_micro_batches": state.global_step * args.gradient_accumulation_steps,
                       "method": "seeded RandomSampler + skip_first_batches on resume"},
            "optimizer": {"kind": "adamw", "lr": args.learning_rate, "schedule": {"type": "linear", "warmup": 10, "total": state.max_steps}},
            "data_sha256": self.meta["data_sha256"], "compat": {"base": self.meta["base"], "full_finetune": True},
            "produced_by": {"backend": "cpu-py", "precision": "float32", "torch": torch.__version__},
            "differences": ["權重是完整 HF safetensors（不是 LoRA），優化器狀態 HF 原生檔（optimizer.pt）"],
        }
        with open(os.path.join(ck, "fa-ckpt.json"), "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model_name_or_path", default="lora-train/models/Qwen3-0.6B")
    ap.add_argument("--train_file", required=True, help="unified JSONL（split=train）")
    ap.add_argument("--output_dir", required=True)
    ap.add_argument("--val_fraction", type=float, default=0.0)
    ap.add_argument("--max_seq_len", type=int, default=512)
    ap.add_argument("--num_train_epochs", type=float, default=1.0)
    ap.add_argument("--per_device_train_batch_size", type=int, default=1)
    ap.add_argument("--gradient_accumulation_steps", type=int, default=1)
    ap.add_argument("--learning_rate", type=float, default=1e-5)
    ap.add_argument("--logging_steps", type=int, default=1)
    ap.add_argument("--save_steps", type=int, default=200)
    ap.add_argument("--max_steps", type=int, default=-1)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--resume_from_checkpoint", default="")
    ap.add_argument("--stop_file", default="")
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    torch.set_num_threads(int(os.environ.get("LORA_THREADS", torch.get_num_threads())))
    t0 = time.time()

    rows = read_jsonl(args.train_file)
    bad = [r for r in rows if r.get("split") != "train"]
    if bad:
        raise SystemExit(f"--train_file 有 {len(bad)} 列 split != 'train'（heldout 不得拿來訓練）")
    if not rows:
        raise SystemExit("沒有訓練資料")
    train_rows, val_rows = split_train_val(rows, args.val_fraction, args.seed)

    tokenizer = AutoTokenizer.from_pretrained(args.model_name_or_path)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.model_name_or_path, dtype=torch.float32)
    model.config.use_cache = False
    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"[model] {args.model_name_or_path} fp32，可訓練參數 {n_params}", flush=True)

    train_ds = ChatSFTDataset(train_rows, tokenizer, args.max_seq_len)
    print(f"[data] train examples={len(train_ds)}", flush=True)
    if len(train_ds) == 0:
        raise SystemExit("編碼後沒有任何樣本")

    targs = TrainingArguments(
        output_dir=args.output_dir, num_train_epochs=args.num_train_epochs,
        per_device_train_batch_size=args.per_device_train_batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps, learning_rate=args.learning_rate,
        logging_steps=args.logging_steps, save_steps=args.save_steps, save_total_limit=2, warmup_steps=10,
        lr_scheduler_type="linear", max_steps=args.max_steps, report_to=[], use_cpu=True, bf16=False, fp16=False,
        dataloader_num_workers=0, remove_unused_columns=False, seed=args.seed,
    )
    meta = {"data_sha256": hashlib.sha256(open(args.train_file, "rb").read()).hexdigest(), "base": args.model_name_or_path}
    trainer = Trainer(model=model, args=targs, train_dataset=train_ds, data_collator=PadCollator(tokenizer.pad_token_id),
                      callbacks=([StopFileCallback(args.stop_file)] if args.stop_file else []) + [FullCkptCallback(meta)])
    t_train = time.time()
    trainer.train(resume_from_checkpoint=args.resume_from_checkpoint or None)
    train_secs = time.time() - t_train

    os.makedirs(args.output_dir, exist_ok=True)
    trainer.model.save_pretrained(args.output_dir, safe_serialization=True)
    tokenizer.save_pretrained(args.output_dir)
    base_cfg = os.path.join(args.model_name_or_path, "config.json")
    if os.path.exists(base_cfg):
        shutil.copyfile(base_cfg, os.path.join(args.output_dir, "config.json"))
    peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    summary = {"global_step": trainer.state.global_step, "train_seconds": round(train_secs, 1),
               "total_seconds": round(time.time() - t0, 1), "peak_rss_mb": round(peak_mb, 1),
               "losses": [h["loss"] for h in trainer.state.log_history if "loss" in h]}
    with open(os.path.join(args.output_dir, "train_full_summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print(f"[done] full model saved to {args.output_dir} steps={summary['global_step']} "
          f"train_seconds={summary['train_seconds']} peak_rss_mb={summary['peak_rss_mb']}", flush=True)


if __name__ == "__main__":
    main()
