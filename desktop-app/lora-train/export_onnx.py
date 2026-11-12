#!/usr/bin/env python
"""合併後的完整模型（HF 資料夾）→ ONNX fp32 → 動態 q8，並用幾個提示核對 logits（DESIGN.lora-training.md §21）。
用 .venv-export（optimum-onnx 0.1.0／transformers 4.57.6），不要用訓練用的 .venv（transformers 5.x）。

    .venv-export/bin/python export_onnx.py --model out/merged --out out/export/tuned-onnx [--no_quant]

只做匯出與數值核對；與 app 槽版轉換器（lora-slot-build.js）是否相容尚未驗證（圖結構不同於 transformers.js 那包）。
"""
import argparse, os, subprocess, sys, json
import numpy as np

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--no_quant", action="store_true")
    a = ap.parse_args()
    fp = os.path.join(a.out, "fp32")
    subprocess.check_call([sys.executable.replace("python", "optimum-cli"), "export", "onnx", "--model", a.model, "--task", "text-generation-with-past",
                           "--dtype", "fp32", "--no-post-process", fp])
    res = {"fp32": os.path.join(fp, "model.onnx")}
    if not a.no_quant:
        from onnxruntime.quantization import quantize_dynamic, QuantType
        q = os.path.join(a.out, "model_quantized.onnx")
        quantize_dynamic(res["fp32"], q, weight_type=QuantType.QUInt8, per_channel=True, use_external_data_format=False)
        res["q8"] = q
    # logits 核對：同一批提示，fp32 ONNX vs（若有）q8 ONNX vs HF 參考
    import onnxruntime as ort, torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.model)
    hf = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32).eval()
    cfg = hf.config; L, H, D = cfg.num_hidden_layers, cfg.num_key_value_heads, getattr(cfg, "head_dim", cfg.hidden_size // cfg.num_attention_heads)
    prompts = ["台北在哪個國家？", "def add(a, b):", "Choose the best tool: A. search B. calc\nAnswer:"]
    out = {}
    for name, path in res.items():
        s = ort.InferenceSession(path, providers=["CPUExecutionProvider"]); cos = []; top1 = []
        for p in prompts:
            ids = tok(p, return_tensors="pt")["input_ids"]; n = ids.shape[1]
            feed = {"input_ids": ids.numpy(), "attention_mask": np.ones((1, n), dtype=np.int64), "position_ids": np.arange(n, dtype=np.int64)[None]}
            for l in range(L):
                for kv in ("key", "value"): feed[f"past_key_values.{l}.{kv}"] = np.zeros((1, H, 0, D), dtype=np.float32)
            lg = s.run(["logits"], feed)[0][0, -1]
            with torch.no_grad(): ref = hf(ids).logits[0, -1].numpy()
            cos.append(float(lg @ ref / (np.linalg.norm(lg) * np.linalg.norm(ref)))); top1.append(int(lg.argmax()) == int(ref.argmax()))
        out[name] = {"cos_min": min(cos), "top1_match": f"{sum(top1)}/{len(top1)}", "size_bytes": os.path.getsize(path) + (os.path.getsize(path + "_data") if os.path.exists(path + "_data") else 0)}
    print(json.dumps(out, ensure_ascii=False, indent=1)); json.dump(out, open(os.path.join(a.out, "export_check.json"), "w"), indent=1)

if __name__ == "__main__":
    main()
