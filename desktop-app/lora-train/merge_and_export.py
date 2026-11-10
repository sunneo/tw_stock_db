#!/usr/bin/env python
"""Merge a trained LoRA adapter back into the Qwen3-0.6B base weights and save a
plain HF checkpoint (safetensors), ready for either:

  (a) GGUF conversion via llama.cpp's convert_hf_to_gguf.py, to serve through
      scripts/eval/mini_llama_server.py and run the existing JS eval harnesses
      (bench_coverage.js / stack_consistency.js / code_loop_bench.js --backend http)
      against the fine-tuned model -- this is the fastest path to an honest
      before/after accuracy number, and needs no change to production code.
  (b) ONNX re-export (optimum-cli export onnx) if/when the gains are worth wiring
      into the production native-runner path (nr-engine.js). Not done by this
      script -- that's a separate, bigger follow-up once (a) shows real gains.

Usage:
    lora-train/.venv/Scripts/python lora-train/merge_and_export.py \
        --base_model Qwen/Qwen3-0.6B \
        --adapter_dir lora-train/out/adapter \
        --output_dir lora-train/out/merged
"""
import argparse

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--base_model", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--adapter_dir", required=True)
    ap.add_argument("--output_dir", required=True)
    args = ap.parse_args()

    print(f"[load] base model {args.base_model}")
    base = AutoModelForCausalLM.from_pretrained(args.base_model, torch_dtype=torch.float32)
    tokenizer = AutoTokenizer.from_pretrained(args.adapter_dir)

    print(f"[load] adapter {args.adapter_dir}")
    merged = PeftModel.from_pretrained(base, args.adapter_dir)
    print("[merge] merging LoRA weights into base")
    merged = merged.merge_and_unload()

    print(f"[save] writing merged checkpoint to {args.output_dir}")
    merged.save_pretrained(args.output_dir, safe_serialization=True)
    tokenizer.save_pretrained(args.output_dir)
    print("[done] next step: convert to GGUF with llama.cpp's convert_hf_to_gguf.py, "
          "then serve with scripts/eval/mini_llama_server.py for evaluation.")


if __name__ == "__main__":
    main()
