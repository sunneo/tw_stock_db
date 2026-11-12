#!/usr/bin/env python3
"""合併後的 HF 資料夾 → ONNX（fp32）→ 動態 q8 → 核對 → 寫資產 manifest。DESIGN.lora-training.md §25。

分四步，每步可單獨跑（工作室的執行器一步一步呼叫）；全部在 <out> 資料夾內：
  convert   optimum-cli export onnx（fp32，text-generation-with-past，圖的輸入輸出與 app 的 q8 圖相同）→ <out>/fp32/
  quantize  onnxruntime quantize_dynamic（per_channel、QUInt8 權重）→ <out>/q8/model_quantized.onnx
            recipe=full：所有 MatMul 都量化（與官方 q8 同結構，可接 lora-slot-build.js 的 LoRA 槽）
            recipe=mixed：down_proj 保留 fp32（其他照舊）；品質明顯較好，但不能再套 LoRA 槽（槽轉換器要求 196 個 MatMulInteger）
  verify    與 HF（PyTorch fp32）比對：每個提示首步 logits 的餘弦與 top-1、貪婪 N 個 token（用 KV cache 跑 ONNX）→ <out>/check.json
  pack      寫 <out>/manifest.json：每個產物的檔名、大小、sha256、來源與 recipe

用法（一定要用 .venv-export：transformers 4.57.x；訓練用的 .venv 是 5.x，tokenizer 會壞）：
    .venv-export/bin/python export_onnx.py --step convert   --model <merged_dir> --out <out> --tokenizer <base_dir>
    .venv-export/bin/python export_onnx.py --step quantize  --out <out> --recipe mixed
    .venv-export/bin/python export_onnx.py --step verify    --model <merged_dir> --out <out> --tokenizer <base_dir>
    .venv-export/bin/python export_onnx.py --step pack      --out <out>
每一步成功會在 stdout 印一行 JSON（{"step":…,"ok":true,…}），失敗印 {"step":…,"ok":false,"error":…} 並以非零碼結束。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

PROMPTS = [
    "台北在哪個國家？",
    "def add(a, b):",
    "Choose the best tool: A. search B. calc\nAnswer:",
    "請把這個任務拆成三個子步驟：整理資料、計算平均、輸出報表。",
    '{"name": "get_weather", "arguments": {"city": "Taipei"}}',
    "The quick brown fox jumps over",
]
GREEDY_N = 16


def emit(step, ok, **kw):
    print(json.dumps(dict(step=step, ok=ok, **kw), ensure_ascii=False), flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def size_of(path):
    """ONNX 外部資料檔一起算"""
    total = os.path.getsize(path)
    if os.path.exists(path + "_data"):
        total += os.path.getsize(path + "_data")
    return total


def find_optimum_cli():
    cand = os.path.join(os.path.dirname(sys.executable), "optimum-cli")
    if os.path.exists(cand):
        return cand
    found = shutil.which("optimum-cli")
    if not found:
        raise RuntimeError("找不到 optimum-cli（請用 .venv-export 的 python 執行）")
    return found


def step_convert(a):
    fp = os.path.join(a.out, "fp32")
    if os.path.exists(os.path.join(fp, "model.onnx")):
        return {"skipped": "已存在 " + fp}
    os.makedirs(a.out, exist_ok=True)
    cmd = [find_optimum_cli(), "export", "onnx", "--model", a.model, "--task", "text-generation-with-past",
           "--dtype", "fp32", "--no-post-process", fp]
    t0 = time.time()
    subprocess.check_call(cmd)
    return {"model": os.path.join(fp, "model.onnx"), "bytes": size_of(os.path.join(fp, "model.onnx")),
            "seconds": round(time.time() - t0, 1)}


def step_quantize(a):
    from onnxruntime.quantization import QuantType, quantize_dynamic
    import onnx
    src = os.path.join(a.out, "fp32", "model.onnx")
    if not os.path.exists(src):
        raise RuntimeError("沒有 fp32 圖：先跑 --step convert")
    excl = []
    if a.recipe == "mixed":
        m = onnx.load(src, load_external_data=False)
        excl = [n.name for n in m.graph.node if n.op_type == "MatMul" and "down_proj" in n.name]
        if not excl:
            raise RuntimeError("mixed 找不到 down_proj 節點，圖結構不符")
    elif a.recipe != "full":
        raise RuntimeError("recipe 必須是 full 或 mixed")
    os.makedirs(os.path.join(a.out, "q8"), exist_ok=True)
    dst = os.path.join(a.out, "q8", "model_quantized.onnx")
    t0 = time.time()
    quantize_dynamic(src, dst, weight_type=QuantType.QUInt8, per_channel=True, nodes_to_exclude=excl,
                     use_external_data_format=False)
    return {"model": dst, "recipe": a.recipe, "fp32_kept_nodes": len(excl), "bytes": size_of(dst),
            "seconds": round(time.time() - t0, 1)}


def cosine(x, y):
    import numpy as np
    return float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y)))


def onnx_greedy(sess, ids_list, n_new, cfg_layers, kv_heads, head_dim):
    """KV cache 貪婪解碼；回傳 (首步 logits, 生成的 token)"""
    import numpy as np
    past = {f"past_key_values.{l}.{k}": np.zeros((1, kv_heads, 0, head_dim), dtype=np.float32)
            for l in range(cfg_layers) for k in ("key", "value")}
    ids = list(ids_list)
    first = None
    out = []
    plen = 0
    feed_ids = ids
    for _ in range(n_new):
        L = plen + len(feed_ids)
        feed = dict(past)
        feed["input_ids"] = np.array([feed_ids], dtype=np.int64)
        feed["attention_mask"] = np.ones((1, L), dtype=np.int64)
        feed["position_ids"] = np.arange(plen, L, dtype=np.int64)[None]
        names = [o.name for o in sess.get_outputs()]
        res = dict(zip(names, sess.run(None, feed)))
        lg = res["logits"][0, -1]
        if first is None:
            first = lg.copy()
        nxt = int(lg.argmax())
        out.append(nxt)
        past = {f"past_key_values.{l}.{k}": res[f"present.{l}.{k}"] for l in range(cfg_layers) for k in ("key", "value")}
        plen = L
        feed_ids = [nxt]
    return first, out


def hf_greedy(hf, ids_list, n_new):
    import torch
    import numpy as np
    ids = list(ids_list)
    first = None
    out = []
    with torch.no_grad():
        for _ in range(n_new):
            lg = hf(torch.tensor([ids])).logits[0, -1].numpy()
            if first is None:
                first = lg.copy()
            nxt = int(lg.argmax())
            out.append(nxt)
            ids.append(nxt)
    return first, out


def step_verify(a):
    import numpy as np
    import onnxruntime as ort
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    hf = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32).eval()
    cfg = hf.config
    layers, kv_heads = cfg.num_hidden_layers, cfg.num_key_value_heads
    head_dim = getattr(cfg, "head_dim", cfg.hidden_size // cfg.num_attention_heads)
    models = {"fp32": os.path.join(a.out, "fp32", "model.onnx")}
    q8 = os.path.join(a.out, "q8", "model_quantized.onnx")
    if os.path.exists(q8):
        models["q8"] = q8
    sessions = {k: ort.InferenceSession(p, providers=["CPUExecutionProvider"]) for k, p in models.items()}
    rows = []
    summary = {}
    refs = {}
    for p in PROMPTS:
        ids = tok(p)["input_ids"]
        refs[p] = hf_greedy(hf, ids, GREEDY_N)
    for name, sess in sessions.items():
        cos, top1, gmatch, gfull = [], 0, 0, 0
        for p in PROMPTS:
            ids = tok(p)["input_ids"]
            ref_first, ref_tokens = refs[p]
            first, toks = onnx_greedy(sess, ids, GREEDY_N, layers, kv_heads, head_dim)
            c = cosine(first.astype(np.float64), ref_first.astype(np.float64))
            cos.append(c)
            top1 += int(first.argmax()) == int(ref_first.argmax())
            k = 0
            while k < len(toks) and toks[k] == ref_tokens[k]:
                k += 1
            gmatch += k
            gfull += int(toks == ref_tokens)
            rows.append({"variant": name, "prompt": p, "cos": round(c, 6), "top1": int(first.argmax()) == int(ref_first.argmax()),
                         "greedy_prefix_match": k, "greedy_total": GREEDY_N, "onnx_tokens": toks, "hf_tokens": ref_tokens})
        summary[name] = {"cos_min": round(min(cos), 6), "cos_mean": round(sum(cos) / len(cos), 6),
                         "top1": f"{top1}/{len(PROMPTS)}", "greedy_prefix_match": f"{gmatch}/{GREEDY_N * len(PROMPTS)}",
                         "greedy_full_match": f"{gfull}/{len(PROMPTS)}", "bytes": size_of(models[name])}
    check = {"reference": "HF（PyTorch fp32，合併後模型）", "prompts": PROMPTS, "greedy_n": GREEDY_N,
             "summary": summary, "rows": rows}
    with open(os.path.join(a.out, "check.json"), "w", encoding="utf-8") as f:
        json.dump(check, f, ensure_ascii=False, indent=1)
    return {"summary": summary, "check": os.path.join(a.out, "check.json")}


TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt"]


def step_pack(a):
    # 桌面版 nr-engine 要 modelPath＋tokenizerPath：把基底 tokenizer 檔放進匯出資料夾（與 app 的 q8 資料夾結構一致）
    if a.tokenizer and os.path.isdir(a.tokenizer):
        for f in TOKENIZER_FILES:
            src = os.path.join(a.tokenizer, f)
            if os.path.exists(src):
                shutil.copyfile(src, os.path.join(a.out, f))
    files = []
    for rel in [os.path.join("fp32", "model.onnx"), os.path.join("fp32", "model.onnx_data"),
                os.path.join("q8", "model_quantized.onnx"), "check.json"] + TOKENIZER_FILES:
        p = os.path.join(a.out, rel)
        if os.path.exists(p):
            files.append({"path": rel.replace(os.sep, "/"), "bytes": os.path.getsize(p), "sha256": sha256(p)})
    cfg_src = os.path.join(a.out, "fp32", "config.json")
    if os.path.exists(cfg_src):
        files.append({"path": "fp32/config.json", "bytes": os.path.getsize(cfg_src), "sha256": sha256(cfg_src)})
    man = {"kind": "llm", "format": "onnx", "source": a.model or None, "recipe": a.recipe, "files": files,
           "note": "fp32/ 是未量化圖；q8/model_quantized.onnx 是 quantize_dynamic 的結果（recipe=mixed 時 down_proj 保留 fp32，不能再套 lora-slot-build 的 LoRA 槽）",
           "io": "input_ids/attention_mask/position_ids/past_key_values.*（與 app 的 q8 圖相同）"}
    with open(os.path.join(a.out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=1)
    return {"manifest": os.path.join(a.out, "manifest.json"), "files": len(files)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--step", required=True, choices=["convert", "quantize", "verify", "pack"])
    ap.add_argument("--model", help="合併後的 HF 資料夾（convert／verify）")
    ap.add_argument("--tokenizer", help="tokenizer 資料夾（預設同 --model；合併後資料夾的 tokenizer 若由 transformers 5 存的，4.x 讀不了，請指向基底）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--recipe", default="full", choices=["full", "mixed"])
    a = ap.parse_args()
    a.tokenizer = a.tokenizer or a.model
    fn = {"convert": step_convert, "quantize": step_quantize, "verify": step_verify, "pack": step_pack}[a.step]
    try:
        res = fn(a)
        emit(a.step, True, **res)
    except Exception as e:  # 讓執行器拿到明確錯誤
        emit(a.step, False, error=f"{type(e).__name__}: {str(e)[:500]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
