#!/usr/bin/env python
"""擴展後的 HF 模型 → ONNX q8（沿用 app 內既有 q8 圖的結構）。DESIGN.offline-training-studio.md §16。

為什麼不重新匯出：app 的 q8 圖是 ORT-GenAI 風格的融合圖（GroupQueryAttention＋RotaryEmbedding），
匯出工具鏈（optimum）綁 transformers 4.x，本機沒有。改為在既有圖上做「外科手術」，只替換三類初始值：
  1. cos_cache／sin_cache：改成 YaRN 的表，列數 = 原長度 × 倍數（RotaryEmbedding 以列數當位置上限）。
  2. 196 個線性層（q,k,v,o,gate,up,down × 28）的 weight_quantized／weight_scale／weight_zero_point：
     依 HF 權重（已含 LoRA 合併）重新量化。格式與原圖相同：每張量一個 scale、一個 zero point（uint8）、
     權重形狀 [in, out]。量化法與 ORT 的 QUInt8 相同（範圍必含 0）。
  3. embed_tokens（與 lm_head 綁定）與 norm 不動：LoRA 沒有碰它們。
圖的其餘節點、輸入輸出名稱完全不變，所以 app 的載入與 KV 快取程式碼不需要改。

子命令：
  build   --hf <HF 資料夾> --factor F --src <原 q8 onnx> --out <新資料夾>   → <out>/model_quantized.onnx
  verify  --hf <HF 資料夾> --onnx <q8 onnx> --lengths 512 2048 ...           → 與 HF fp32 比對（餘弦、top-1、貪婪一致）
"""
import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ctx_common import rope_tables, sha256_file  # noqa: E402

COS_MIN = 0.9
LIN = [("self_attn.q_proj", "attn.q_proj"), ("self_attn.k_proj", "attn.k_proj"),
       ("self_attn.v_proj", "attn.v_proj"), ("self_attn.o_proj", "attn.o_proj"),
       ("mlp.gate_proj", "mlp.gate_proj"), ("mlp.up_proj", "mlp.up_proj"), ("mlp.down_proj", "mlp.down_proj")]


def quant_per_tensor(W):
    """W: float32 [in, out]。回傳 (uint8 [in,out], scale float, zp int)，與 ORT QUInt8 同一規則（範圍含 0）。"""
    lo = min(float(W.min()), 0.0)
    hi = max(float(W.max()), 0.0)
    scale = (hi - lo) / 255.0
    if scale == 0.0:
        scale = 1e-8
    zp = int(np.clip(np.round(-lo / scale), 0, 255))
    q = np.clip(np.round(W / scale) + zp, 0, 255).astype(np.uint8)
    return q, np.float32(scale), zp


def load_hf_state(hf_dir):
    from safetensors.torch import load_file
    import torch  # noqa: F401
    st = {}
    for f in sorted(os.listdir(hf_dir)):
        if f.endswith(".safetensors"):
            st.update(load_file(os.path.join(hf_dir, f)))
    return st


def cmd_build(a):
    import onnx
    from onnx import numpy_helper, TensorProto
    t0 = time.time()
    model = onnx.load(a.src, load_external_data=False)
    # 1) 旋轉表
    rows = 40960 * a.factor
    cos, sin, info = rope_tables(a.factor, rows)
    names = {i.name: i for i in model.graph.initializer}
    if "cos_cache" not in names or "sin_cache" not in names:
        raise SystemExit("原圖沒有 cos_cache／sin_cache")
    new_inits = {}
    new_inits["cos_cache"] = numpy_helper.from_array(cos, "cos_cache")
    new_inits["sin_cache"] = numpy_helper.from_array(sin, "sin_cache")
    # 2) 線性層重新量化
    st = load_hf_state(a.hf)
    report = {}
    for hf_name, onnx_name in LIN:
        for i in range(28):
            key = f"model.layers.{i}.{hf_name}.weight"
            W = st[key].float().numpy().T.copy()  # HF [out,in] → ONNX [in,out]
            base = f"model.layers.{i}.{onnx_name}.MatMul."
            old = names[base + "weight_quantized"]
            if list(old.dims) != list(W.shape):
                raise SystemExit(f"{base} 形狀不符 {list(old.dims)} vs {list(W.shape)}")
            q, scale, zp = quant_per_tensor(W)
            new_inits[base + "weight_quantized"] = numpy_helper.from_array(q, base + "weight_quantized")
            new_inits[base + "weight_scale"] = numpy_helper.from_array(np.array(scale, dtype=np.float32), base + "weight_scale")
            new_inits[base + "weight_zero_point"] = numpy_helper.from_array(np.array(zp, dtype=np.uint8), base + "weight_zero_point")
    # 3) 替換：保留順序，其餘初始值原樣
    rebuilt = []
    for init in model.graph.initializer:
        rebuilt.append(new_inits.get(init.name, init))
    del model.graph.initializer[:]
    model.graph.initializer.extend(rebuilt)
    # 第二次呼叫的 cos／sin 形狀要同步給 value_info（若有）
    for vi in list(model.graph.value_info):
        if vi.name in ("cos_cache", "sin_cache"):
            model.graph.value_info.remove(vi)
    os.makedirs(a.out, exist_ok=True)
    dst = os.path.join(a.out, "model_quantized.onnx")
    onnx.save(model, dst)
    doc = {"src": a.src, "src_sha256": None, "factor": a.factor, "cache_rows": rows, "rope": info,
           "requantized_linears": len(LIN) * 28, "quantization": "per-tensor QUInt8（與原圖同格式，ORT QUInt8 規則）",
           "embed_and_norm": "未改", "bytes": os.path.getsize(dst), "dst_sha256": sha256_file(dst),
           "seconds": round(time.time() - t0, 1), "hf": a.hf}
    with open(os.path.join(a.out, "build.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
    print(json.dumps(doc, ensure_ascii=False), flush=True)


def cmd_verify(a):
    """以 ORT 跑 q8 圖（KV 快取、逐步解碼）與 HF fp32 比對：首步 logits 餘弦、top-1、貪婪 16 權杖一致率。"""
    import onnxruntime as ort
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, AutoConfig
    cfg = AutoConfig.from_pretrained(a.hf)
    model = AutoModelForCausalLM.from_pretrained(a.hf, dtype=torch.float32, config=cfg).eval()
    tok = AutoTokenizer.from_pretrained(a.hf)
    sess = ort.InferenceSession(a.onnx, providers=["CPUExecutionProvider"])
    out_names = [o.name for o in sess.get_outputs()]
    L_layers, kvh, hd = cfg.num_hidden_layers, cfg.num_key_value_heads, cfg.head_dim
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from ctx_common import corpus_docs, encode, join_docs
    _, held = corpus_docs()
    ids_all = encode(tok, join_docs(held))
    res = []
    for L in a.lengths:
        prompt = ids_all[1000:1000 + L]
        t0 = time.time()
        # ORT：一次 prefill，取最後一列 logits
        past = {f"past_key_values.{l}.{k}": np.zeros((1, kvh, 0, hd), dtype=np.float32) for l in range(L_layers) for k in ("key", "value")}
        feed = dict(past)
        feed["input_ids"] = np.array([prompt], dtype=np.int64)
        feed["attention_mask"] = np.ones((1, L), dtype=np.int64)
        feed["position_ids"] = np.arange(0, L, dtype=np.int64)[None]
        r = dict(zip(out_names, sess.run(None, feed)))
        q_lg = r["logits"][0, -1]
        ort_secs = time.time() - t0
        with torch.no_grad():
            h_lg = model(torch.tensor([prompt]), use_cache=False, logits_to_keep=1).logits[0, -1].numpy()
        cos = float(q_lg @ h_lg / (np.linalg.norm(q_lg) * np.linalg.norm(h_lg)))
        top1 = int(q_lg.argmax()) == int(h_lg.argmax())
        # 貪婪 16 權杖（ORT 用 KV 快取；HF 用 generate）
        n_new = 16
        past = {f"past_key_values.{l}.{k}": np.zeros((1, kvh, 0, hd), dtype=np.float32) for l in range(L_layers) for k in ("key", "value")}
        cur = list(prompt)
        plen = 0
        feed_ids = prompt
        gen_q = []
        for _ in range(n_new):
            Lc = plen + len(feed_ids)
            feed = dict(past)
            feed["input_ids"] = np.array([feed_ids], dtype=np.int64)
            feed["attention_mask"] = np.ones((1, Lc), dtype=np.int64)
            feed["position_ids"] = np.arange(plen, Lc, dtype=np.int64)[None]
            rr = dict(zip(out_names, sess.run(None, feed)))
            nxt = int(rr["logits"][0, -1].argmax())
            gen_q.append(nxt)
            past = {f"past_key_values.{l}.{k}": rr[f"present.{l}.{k}"] for l in range(L_layers) for k in ("key", "value")}
            plen = Lc
            feed_ids = [nxt]
        with torch.no_grad():
            gen_h = model.generate(torch.tensor([prompt]), max_new_tokens=n_new, do_sample=False, use_cache=True)[0, L:].tolist()
        match = sum(1 for x, y in zip(gen_q, gen_h) if x == y)
        row = {"L": L, "logits_cosine": round(cos, 6), "first_top1_agree": bool(top1), "greedy_match": f"{match}/{n_new}",
               "ort_prefill_seconds": round(ort_secs, 1), "total_seconds": round(time.time() - t0, 1)}
        res.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    # 預先登記的驗收門檻（在量測前寫定）：每個長度的首步 logits 餘弦 ≥ 0.9，且首步 top-1 一致。
    # 這只檢查「替換後的圖與 HF 權重一致到量化誤差」，不代表長上下文的品質（品質另由 ctx_eval 量）。
    ok = bool(res) and all(r["logits_cosine"] >= COS_MIN and r["first_top1_agree"] for r in res)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"onnx": a.onnx, "hf": a.hf, "results": res, "ok": ok, "gate": {"logits_cosine_min": COS_MIN, "first_top1_agree": True}},
                  f, ensure_ascii=False, indent=1)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--hf", required=True)
    b.add_argument("--factor", type=int, default=2, choices=[1, 2, 4])
    b.add_argument("--src", required=True)
    b.add_argument("--out", required=True)
    v = sub.add_parser("verify")
    v.add_argument("--hf", required=True)
    v.add_argument("--onnx", required=True)
    v.add_argument("--lengths", type=int, nargs="+", default=[512])
    v.add_argument("--out", required=True)
    a = ap.parse_args()
    {"build": cmd_build, "verify": cmd_verify}[a.cmd](a)


if __name__ == "__main__":
    main()
