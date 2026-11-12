#!/usr/bin/env python3
"""合併後的 HF 資料夾 → GGUF（f16）→ Q8_0 → 用 llama.cpp 的 llama-server 實際推論核對 → 寫資產 manifest。
DESIGN.lora-training.md §25。工具來自 llama.cpp（實測版本 b12286）：convert_hf_to_gguf.py、llama-quantize、llama-server。

分四步（與 export_onnx.py 同樣格式：每步在 stdout 印一行 JSON）：
  convert   convert_hf_to_gguf.py --outtype f16 → <out>/model-f16.gguf
            轉換器會讀 tokenizer；transformers 5 存的 tokenizer_config.json 在 4.x 讀不了，所以本步會先在
            <out>/hf-input/ 建一個「合併後權重＋基底 tokenizer」的符號連結資料夾，只給轉換器用。
  quantize  llama-quantize <f16> Q8_0 → <out>/model-q8_0.gguf
  verify    起 llama-server（-c 512、--port 隨機空閒埠），對每個提示用 /completion（temperature 0、top_k 1、
            return_tokens）取貪婪 N 個 token，與 HF（PyTorch fp32，合併後模型）的貪婪 token 逐一比對 → <out>/check_gguf.json
  pack      寫 <out>/manifest_gguf.json（檔名、大小、sha256、來源、recipe）

用法（用 .venv-export 的 python；llama.cpp 的工具路徑用 --llama_dir 指向含 llama-quantize／llama-server 的 bin 資料夾，
convert_hf_to_gguf.py 用 --llama_src 指向 llama.cpp 原始碼根目錄）：
    .venv-export/bin/python export_gguf.py --step convert  --model <merged> --tokenizer <base> --out <out> \
        --llama_src <llama.cpp 根> --llama_dir <llama.cpp>/build/bin
    .venv-export/bin/python export_gguf.py --step quantize --out <out> --llama_dir <llama.cpp>/build/bin
    .venv-export/bin/python export_gguf.py --step verify   --model <merged> --tokenizer <base> --out <out> --llama_dir <llama.cpp>/build/bin
    .venv-export/bin/python export_gguf.py --step pack     --out <out>

注意：verify 只比對貪婪 token（llama-server 不回傳完整 logits），所以不宣稱首步 logits 餘弦；這一點寫在 check_gguf.json。
"""
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

GREEDY_N = 16
PROMPTS = [
    "台北在哪個國家？",
    "def add(a, b):",
    "Choose the best tool: A. search B. calc\nAnswer:",
    "請把這個任務拆成三個子步驟：整理資料、計算平均、輸出報表。",
    '{"name": "get_weather", "arguments": {"city": "Taipei"}}',
    "The quick brown fox jumps over",
]
BASE_TOK_FILES = ["tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt", "generation_config.json"]


def emit(step, ok, **kw):
    print(json.dumps(dict(step=step, ok=ok, **kw), ensure_ascii=False), flush=True)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tool(a, name):
    if a.llama_dir:
        p = os.path.join(a.llama_dir, name)
        if os.path.exists(p):
            return p
        raise RuntimeError(f"找不到 {p}")
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"找不到 {name}（請用 --llama_dir 指定）")
    return found


def step_convert(a):
    if not a.llama_src:
        raise RuntimeError("convert 需要 --llama_src（llama.cpp 原始碼根目錄，內含 convert_hf_to_gguf.py）")
    inp = os.path.join(a.out, "hf-input")
    os.makedirs(inp, exist_ok=True)
    for f in ["model.safetensors", "config.json"]:
        dst = os.path.join(inp, f)
        if not os.path.exists(dst):
            os.symlink(os.path.abspath(os.path.join(a.model, f)), dst)
    for f in BASE_TOK_FILES:
        src = os.path.join(a.tokenizer, f)
        dst = os.path.join(inp, f)
        if os.path.exists(src) and not os.path.exists(dst):
            os.symlink(os.path.abspath(src), dst)
    outp = os.path.join(a.out, "model-f16.gguf")
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([a.llama_src, os.path.join(a.llama_src, "gguf-py")])
    t0 = time.time()
    subprocess.check_call([sys.executable, os.path.join(a.llama_src, "convert_hf_to_gguf.py"), inp,
                           "--outtype", "f16", "--outfile", outp], env=env, stdout=subprocess.DEVNULL)
    return {"model": outp, "bytes": os.path.getsize(outp), "seconds": round(time.time() - t0, 1)}


def step_quantize(a):
    src = os.path.join(a.out, "model-f16.gguf")
    if not os.path.exists(src):
        raise RuntimeError("沒有 f16 GGUF：先跑 --step convert")
    dst = os.path.join(a.out, "model-q8_0.gguf")
    t0 = time.time()
    subprocess.check_call([tool(a, "llama-quantize"), src, dst, "Q8_0"], stdout=subprocess.DEVNULL)
    return {"model": dst, "bytes": os.path.getsize(dst), "seconds": round(time.time() - t0, 1)}


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def post(port, payload, timeout=120):
    req = urllib.request.Request(f"http://127.0.0.1:{port}/completion", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def step_verify(a):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    gguf = os.path.join(a.out, "model-q8_0.gguf")
    if not os.path.exists(gguf):
        raise RuntimeError("沒有 q8_0 GGUF：先跑 --step quantize")
    tok = AutoTokenizer.from_pretrained(a.tokenizer)
    hf = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32).eval()
    ref = {}
    with torch.no_grad():
        for p in PROMPTS:
            ids = tok(p)["input_ids"]
            seq = list(ids)
            out = []
            for _ in range(GREEDY_N):
                nxt = int(hf(torch.tensor([seq])).logits[0, -1].argmax())
                out.append(nxt)
                seq.append(nxt)
            ref[p] = (ids, out)
    del hf
    port = free_port()
    log = os.path.join(a.out, "llama-server.log")
    with open(log, "w") as lf:
        srv = subprocess.Popen([tool(a, "llama-server"), "-m", gguf, "--port", str(port), "-c", "512", "-t", "8",
                                "--no-webui"], stdout=lf, stderr=subprocess.STDOUT)
    rows, pref, full, top1 = [], 0, 0, 0
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2)
                break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError("llama-server 沒有在 120 秒內就緒，見 llama-server.log")
        for p in PROMPTS:
            ids, ref_out = ref[p]
            res = post(port, {"prompt": p, "n_predict": GREEDY_N, "temperature": 0, "top_k": 1, "return_tokens": True,
                              "cache_prompt": False})
            toks = res.get("tokens", [])
            k = 0
            while k < min(len(toks), len(ref_out)) and toks[k] == ref_out[k]:
                k += 1
            pref += k
            full += int(toks == ref_out)
            rows.append({"prompt": p, "prompt_ids_match_hf": None, "llama_tokens": toks, "hf_tokens": ref_out,
                         "greedy_prefix_match": k, "greedy_total": GREEDY_N})
    finally:
        srv.terminate()
        try:
            srv.wait(timeout=20)
        except subprocess.TimeoutExpired:
            srv.kill()
    summary = {"greedy_prefix_match": f"{pref}/{GREEDY_N * len(PROMPTS)}", "greedy_full_match": f"{full}/{len(PROMPTS)}",
               "bytes": os.path.getsize(gguf)}
    check = {"reference": "HF（PyTorch fp32，合併後模型，貪婪）", "runtime": "llama-server（llama.cpp b12286，/completion，temperature 0，top_k 1）",
             "note": "只比貪婪 token；llama-server 不回傳完整 logits，因此不含首步 logits 餘弦", "summary": summary, "rows": rows}
    with open(os.path.join(a.out, "check_gguf.json"), "w", encoding="utf-8") as f:
        json.dump(check, f, ensure_ascii=False, indent=1)
    return {"summary": summary, "check": os.path.join(a.out, "check_gguf.json")}


def step_pack(a):
    files = []
    for rel in ["model-q8_0.gguf", "check_gguf.json"]:
        p = os.path.join(a.out, rel)
        if os.path.exists(p):
            files.append({"path": rel, "bytes": os.path.getsize(p), "sha256": sha256(p)})
    man = {"kind": "llm", "format": "gguf", "quant": "Q8_0", "source": a.model, "files": files,
           "runtime_check": "llama-server（b12286）貪婪 token 對 HF 參考"}
    with open(os.path.join(a.out, "manifest_gguf.json"), "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=1)
    return {"manifest": os.path.join(a.out, "manifest_gguf.json"), "files": len(files)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--step", required=True, choices=["convert", "quantize", "verify", "pack"])
    ap.add_argument("--model", help="合併後的 HF 資料夾（convert／verify）")
    ap.add_argument("--tokenizer", help="tokenizer 資料夾（預設同 --model；建議指向基底）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--llama_src", help="llama.cpp 原始碼根目錄（convert）")
    ap.add_argument("--llama_dir", help="含 llama-quantize／llama-server 的資料夾（預設用 PATH）")
    a = ap.parse_args()
    a.tokenizer = a.tokenizer or a.model
    os.makedirs(a.out, exist_ok=True)
    fn = {"convert": step_convert, "quantize": step_quantize, "verify": step_verify, "pack": step_pack}[a.step]
    try:
        emit(a.step, True, **fn(a))
    except Exception as e:
        emit(a.step, False, error=f"{type(e).__name__}: {str(e)[:500]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
