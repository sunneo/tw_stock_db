#!/usr/bin/env python3
"""匯出腳本的 smoke 測試（DESIGN.lora-training.md §25）。不需要 Qwen3-0.6B 權重，也不需要 llama.cpp：
用隨機初始化的「迷你 Qwen3」（2 層、hidden 64）跑完整條路：
  迷你基底 → 迷你 LoRA（PEFT）→ merge_and_export.py → export_onnx.py（convert／quantize full／verify／pack）
  → export_gguf.py（convert／quantize／verify／pack，需要 llama.cpp）
每一步都走真正的 CLI，並檢查它在 stdout 印出的 JSON 結果行（與工作室執行器用的協定相同）。

需要的東西（缺了就略過該段並印出原因，不算失敗）：
  - 匯出環境 python（有 optimum、onnxruntime、transformers）：預設 lora-train/.venv-export/bin/python，或 FA_EXPORT_PYTHON
  - 訓練環境 python（有 peft）：預設 lora-train/.venv/bin/python，或 FA_TRAIN_PYTHON（沒有就略過合併，改用迷你基底直接匯出）
  - Qwen3 基底資料夾（需含 tokenizer.json 與 config.json；只取它的 tokenizer 與架構設定，不載入權重）：FA_QWEN3_TOKENIZER；沒有就整個略過
  - llama.cpp：FA_LLAMA_SRC（原始碼根）與 FA_LLAMA_BIN（含 llama-quantize、llama-server 的 bin）；沒有就略過 GGUF 段

用法：
    lora-train/.venv-export/bin/python lora-train/test_export_smoke.py
結尾行：「N passed, M failed, K skipped」。這個測試只檢查管線是否跑通與產物格式，不檢查品質（迷你模型是隨機的）。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PASS, FAIL, SKIP = [], [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    if not cond:
        print("FAIL", name, str(detail)[:400], flush=True)


def skip(name, why):
    SKIP.append(name)
    print("SKIP", name, "：", why, flush=True)


def find_python(env_key, rel_candidates):
    cands = ([os.environ[env_key]] if os.environ.get(env_key) else []) + [os.path.join(HERE, r) for r in rel_candidates]
    for c in cands:
        if c and os.path.exists(c):
            return c
    return None


def last_json(stdout):
    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                j = json.loads(line)
                if "step" in j and "ok" in j:
                    return j
            except ValueError:
                pass
    return None


def run_step(name, argv, cwd=None):
    p = subprocess.run(argv, capture_output=True, text=True, cwd=cwd)
    j = last_json(p.stdout)
    ok = p.returncode == 0 and j is not None and j.get("ok") is True
    check(name, ok, (j or {}).get("error") or p.stderr[-400:])
    return j


def _run_or_explain(argv, what):
    p = subprocess.run(argv, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(what + " 產生失敗：" + (p.stderr or "")[-600:])


def make_tiny_base(py, tok_dir, out):
    """隨機初始化的迷你 Qwen3（與 Qwen3-0.6B 同一套 tokenizer，詞表 151936）。"""
    code = (
        "import sys, torch\n"
        "from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer\n"
        "torch.manual_seed(0)\n"
        "cfg = AutoConfig.from_pretrained(sys.argv[1])\n"
        "cfg.hidden_size=64; cfg.intermediate_size=128; cfg.num_hidden_layers=2; cfg.num_attention_heads=4\n"
        "cfg.num_key_value_heads=2; cfg.head_dim=16; cfg.max_position_embeddings=512\n"
        "cfg.layer_types=['full_attention']*2\n"
        "m = AutoModelForCausalLM.from_config(cfg)\n"
        "m.save_pretrained(sys.argv[2], safe_serialization=True)\n"
        "AutoTokenizer.from_pretrained(sys.argv[1]).save_pretrained(sys.argv[2])\n"
    )
    _run_or_explain([py, "-c", code, tok_dir, out], "迷你基底")


def make_tiny_adapter(py, base_dir, out):
    code = (
        "import sys, torch\n"
        "from transformers import AutoModelForCausalLM\n"
        "from peft import LoraConfig, get_peft_model\n"
        "torch.manual_seed(1)\n"
        "m = AutoModelForCausalLM.from_pretrained(sys.argv[1], dtype=torch.float32)\n"
        "cfg = LoraConfig(r=4, lora_alpha=8, target_modules=['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj'], task_type='CAUSAL_LM')\n"
        "pm = get_peft_model(m, cfg)\n"
        "for n, p in pm.named_parameters():\n"
        "    if 'lora_B' in n: torch.nn.init.normal_(p, std=0.02)\n"
        "pm.save_pretrained(sys.argv[2])\n"
    )
    _run_or_explain([py, "-c", code, base_dir, out], "迷你 LoRA")


def main():
    export_py = find_python("FA_EXPORT_PYTHON", ["../lora-train/.venv-export/bin/python", ".venv-export/bin/python"])
    train_py = find_python("FA_TRAIN_PYTHON", ["../lora-train/.venv/bin/python", ".venv/bin/python"])
    tok_dir = os.environ.get("FA_QWEN3_TOKENIZER", "")
    llama_src = os.environ.get("FA_LLAMA_SRC", "")
    llama_bin = os.environ.get("FA_LLAMA_BIN", "")
    if not export_py:
        print("SKIP 匯出 smoke：沒有匯出環境 python（設 FA_EXPORT_PYTHON，或建立 lora-train/.venv-export）")
        print(f"{len(PASS)} passed, {len(FAIL)} failed, {len(SKIP) + 1} skipped")
        return 0
    if not (tok_dir and all(os.path.exists(os.path.join(tok_dir, f)) for f in ("tokenizer.json", "config.json"))):
        print("SKIP 匯出 smoke：沒有 Qwen3 的 tokenizer 與 config（設 FA_QWEN3_TOKENIZER 指向含 tokenizer.json 與 config.json 的基底資料夾）")
        print(f"{len(PASS)} passed, {len(FAIL)} failed, {len(SKIP) + 1} skipped")
        return 0
    work = tempfile.mkdtemp(prefix="fa-export-smoke-")
    try:
        base = os.path.join(work, "base")
        make_tiny_base(export_py, tok_dir, base)
        check("迷你基底可以產生", os.path.exists(os.path.join(base, "model.safetensors")))
        merged = os.path.join(work, "merged")
        if train_py:
            adapter = os.path.join(work, "adapter")
            make_tiny_adapter(train_py, base, adapter)
            j = run_step("合併 smoke（merge_and_export.py）", [train_py, os.path.join(HERE, "merge_and_export.py"),
                                                               "--base_dir", base, "--adapter_dir", adapter, "--output_dir", merged])
            check("合併後的 PEFT 與合併前首步 logits 一致（<1e-3）", j is not None and j.get("merge_max_abs_logit_diff", 1) < 1e-3, j)
        else:
            skip("合併 smoke", "沒有訓練環境 python（peft）；改用迷你基底直接匯出，合併路徑未測")
            merged = base
        out = os.path.join(work, "onnx")
        run_step("ONNX convert", [export_py, os.path.join(HERE, "export_onnx.py"), "--step", "convert", "--model", merged, "--out", out])
        run_step("ONNX quantize（full）", [export_py, os.path.join(HERE, "export_onnx.py"), "--step", "quantize", "--out", out, "--recipe", "full"])
        j = run_step("ONNX verify", [export_py, os.path.join(HERE, "export_onnx.py"), "--step", "verify", "--model", merged, "--tokenizer", tok_dir, "--out", out])
        check("ONNX verify 的 fp32 與 HF 首步 logits 餘弦為 1（迷你模型也必須逐字一致）",
              j is not None and abs(j["summary"]["fp32"]["cos_min"] - 1.0) < 1e-4, j)
        run_step("ONNX pack", [export_py, os.path.join(HERE, "export_onnx.py"), "--step", "pack", "--out", out, "--recipe", "full",
                               "--model", merged, "--tokenizer", tok_dir])
        man_p = os.path.join(out, "manifest.json")
        ok_man = os.path.exists(man_p)
        if ok_man:
            man = json.load(open(man_p, encoding="utf-8"))
            paths = [f["path"] for f in man["files"]]
            check("ONNX manifest 含 fp32、q8 與 tokenizer", {"fp32/model.onnx", "q8/model_quantized.onnx", "tokenizer.json"} <= set(paths), paths)
        check("ONNX manifest 存在", ok_man)
        if llama_src and llama_bin and os.path.exists(os.path.join(llama_src, "convert_hf_to_gguf.py")):
            gout = os.path.join(work, "gguf")
            run_step("GGUF convert", [export_py, os.path.join(HERE, "export_gguf.py"), "--step", "convert", "--model", merged, "--tokenizer", tok_dir,
                                      "--out", gout, "--llama_src", llama_src])
            run_step("GGUF quantize（Q8_0）", [export_py, os.path.join(HERE, "export_gguf.py"), "--step", "quantize", "--out", gout, "--llama_dir", llama_bin])
            j = run_step("GGUF verify（llama-server）", [export_py, os.path.join(HERE, "export_gguf.py"), "--step", "verify", "--model", merged,
                                                         "--tokenizer", tok_dir, "--out", gout, "--llama_dir", llama_bin])
            check("GGUF verify 有 summary", j is not None and "greedy_prefix_match" in j.get("summary", {}), j)
            run_step("GGUF pack", [export_py, os.path.join(HERE, "export_gguf.py"), "--step", "pack", "--out", gout])
        else:
            skip("GGUF smoke", "沒有 llama.cpp（設 FA_LLAMA_SRC 與 FA_LLAMA_BIN）")
        # 完整微調 smoke（train_full.py）：迷你模型、4 筆合成資料、2 步；再測暫停（stop_file）與續訓
        if train_py:
            rows = os.path.join(work, "train.jsonl")
            with open(rows, "w", encoding="utf-8") as f:
                for i in range(4):
                    f.write(json.dumps({"id": "t%d" % i, "split": "train", "domain": "smoke", "stage": "s",
                                        "messages": [{"role": "user", "content": "第 %d 題" % i}], "completion": "答 %d" % i},
                                       ensure_ascii=False) + "\n")
            ft_out = os.path.join(work, "full")
            stop = os.path.join(work, "STOP")
            open(stop, "w").close()
            p1 = subprocess.run([train_py, os.path.join(HERE, "train_full.py"), "--model_name_or_path", base, "--train_file", rows,
                                 "--output_dir", ft_out, "--max_steps", "3", "--per_device_train_batch_size", "1",
                                 "--max_seq_len", "128", "--save_steps", "1000", "--stop_file", stop],
                                capture_output=True, text=True)
            check("完整微調：遇到 stop_file 會存檢查點並停（[paused]）", p1.returncode == 0 and "[paused] step=1" in p1.stdout, p1.stderr[-300:])
            os.remove(stop)
            ck = os.path.join(ft_out, "checkpoint-1")
            p2 = subprocess.run([train_py, os.path.join(HERE, "train_full.py"), "--model_name_or_path", base, "--train_file", rows,
                                 "--output_dir", ft_out, "--max_steps", "3", "--per_device_train_batch_size", "1",
                                 "--max_seq_len", "128", "--save_steps", "1000", "--resume_from_checkpoint", ck],
                                capture_output=True, text=True)
            summ = os.path.join(ft_out, "train_full_summary.json")
            check("完整微調：從 checkpoint-1 續訓到第 3 步並存出 HF 模型", p2.returncode == 0 and os.path.exists(summ)
                  and json.load(open(summ))["global_step"] == 3, p2.stderr[-300:])
            check("完整微調輸出是 HF 資料夾（model.safetensors＋config.json）", os.path.exists(os.path.join(ft_out, "model.safetensors"))
                  and os.path.exists(os.path.join(ft_out, "config.json")))
        else:
            skip("完整微調 smoke", "沒有訓練環境 python（transformers、peft）")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(f"{len(PASS)} passed, {len(FAIL)} failed, {len(SKIP)} skipped")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
