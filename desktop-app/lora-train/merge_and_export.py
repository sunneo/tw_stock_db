#!/usr/bin/env python3
"""把 LoRA adapter（PEFT 格式）併回基底權重，存成一般 HF 資料夾（safetensors），供後續匯出用。
DESIGN.lora-training.md §25。

    python3 merge_and_export.py --base_dir models/Qwen3-0.6B \
        --adapter_dir <含 adapter_config.json 與 adapter_model.safetensors 的資料夾> \
        --output_dir <新的空目錄>

注意：
- tokenizer 一律取自基底資料夾（adapter 資料夾通常沒有 tokenizer 檔）。
- 輸出的 config.json 與 tokenizer 與基底相同；權重為 fp32。
- 合併前後各算一次首步 logits，最大絕對差寫進 merge_info.json。
- 只做合併與存檔，不匯出 ONNX／GGUF。
- config.json 會換成基底的（見程式內註解：5.x 的 rope 欄位格式 4.x 讀不到）。
"""
import argparse
import json
import os
import shutil
import sys

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base_dir", required=True, help="基底 HF 資料夾（例如 models/Qwen3-0.6B）")
    ap.add_argument("--adapter_dir", required=True)
    ap.add_argument("--output_dir", required=True)
    ap.add_argument("--probe", default="台北在哪個國家？", help="合併前後各算一次首步 logits 做一致性檢查")
    a = ap.parse_args()

    if os.path.exists(a.output_dir) and os.listdir(a.output_dir):
        sys.exit(f"[error] output_dir 不是空目錄：{a.output_dir}")
    os.makedirs(a.output_dir, exist_ok=True)

    print(f"[load] base {a.base_dir}", flush=True)
    tok = AutoTokenizer.from_pretrained(a.base_dir)
    base = AutoModelForCausalLM.from_pretrained(a.base_dir, dtype=torch.float32).eval()

    print(f"[load] adapter {a.adapter_dir}", flush=True)
    peft_model = PeftModel.from_pretrained(base, a.adapter_dir).eval()
    ids = tok(a.probe, return_tensors="pt")["input_ids"]
    with torch.no_grad():
        ref = peft_model(ids).logits[0, -1].clone()

    print("[merge] merge_and_unload", flush=True)
    merged = peft_model.merge_and_unload().eval()
    with torch.no_grad():
        got = merged(ids).logits[0, -1]
    diff = float((ref - got).abs().max())
    print(f"[check] PEFT vs merged 首步 logits 最大絕對差 = {diff:.3e}", flush=True)

    print(f"[save] {a.output_dir}", flush=True)
    merged.save_pretrained(a.output_dir, safe_serialization=True)
    tok.save_pretrained(a.output_dir)
    # transformers 5.x 存的 config 把 rope_theta 改放進 rope_parameters，4.x 讀不到會退回預設 10000，
    # 實測 4.57 讀 5.x 存的合併權重首步 logprob 偏掉 ~0.2（llama.cpp 與 5.x 一致）。所以改回基底的 config.json
    # （架構相同，只差 dtype 欄位，載入時會轉 fp32）。
    shutil.copyfile(os.path.join(a.base_dir, "config.json"), os.path.join(a.output_dir, "config.json"))
    info = {"base_dir": a.base_dir, "adapter_dir": a.adapter_dir,
            "merge_max_abs_logit_diff": diff, "dtype": "float32", "config_source": "base（覆寫 5.x 存的 config）",
            "adapter_config": json.load(open(os.path.join(a.adapter_dir, "adapter_config.json")))}
    with open(os.path.join(a.output_dir, "merge_info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=1)
    print("[done]", flush=True)
    print(json.dumps({"step": "merge", "ok": True, "output_dir": a.output_dir, "merge_max_abs_logit_diff": diff},
                     ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:  # 空目錄檢查等明確錯誤：照樣回報 JSON，讓執行器拿得到原因
        if e.code not in (0, None):
            print(json.dumps({"step": "merge", "ok": False, "error": str(e.code)[:500]}, ensure_ascii=False), flush=True)
        raise
    except Exception as e:
        print(json.dumps({"step": "merge", "ok": False, "error": f"{type(e).__name__}: {str(e)[:500]}"}, ensure_ascii=False), flush=True)
        sys.exit(1)
