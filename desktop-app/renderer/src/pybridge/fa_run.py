# -*- coding: utf-8 -*-
"""
fa_run.py — Floating AI Assistant 執行 Python 腳本的啟動器。

用法（由助理自動改寫指令，不需要手動打）：
    python fa_run.py [--gpu-only] [--cuda-compat on|off] [--cuda-f64 auto|f32|exact] --rpc <信箱資料夾> -- <腳本.py> [腳本參數…]
    python fa_run.py ... --rpc <信箱資料夾> --argsfile <args.json>   （腳本路徑或參數含中文等非 ASCII 字元時用）

作用：
  - 一般模式（技能包執行期間）：讓腳本 import 到「轉接版」的 playwright（實際呼叫助理的瀏覽器工具）與 fa_bridge，
    並安裝 GPU 相容層（numba／cupy／torch／pycuda 墊片）。
  - --gpu-only（一般的 run_command，不在技能包裡）：只安裝 GPU 相容層，不裝 LLM／瀏覽器的轉接。
    腳本如果沒有 import 那四個套件，就照原樣執行（跟直接 python 腳本一樣：sys.path、編碼、環境都不改）。
  - --cuda-compat off：不安裝 GPU 相容層（真的 numba 等套件照常 import）。
  - --cuda-f64：設定環境變數 FA_CUDA_F64（float64 的處理模式，見 fa_gpu.f64_mode）。
"""
import os
import re
import runpy
import sys


def _parse_opts(argv):
    rpc, gpu_only, compat, f64 = "", False, None, None
    while argv:
        a = argv[0]
        if a == "--gpu-only":
            gpu_only = True
            argv = argv[1:]
        elif a in ("--rpc", "--cuda-compat", "--cuda-f64") and len(argv) >= 2:
            if a == "--rpc":
                rpc = argv[1]
            elif a == "--cuda-compat":
                compat = argv[1]
            else:
                f64 = argv[1]
            argv = argv[2:]
        else:
            break
    return rpc, gpu_only, compat, f64, argv


def _read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def main():
    rpc, gpu_only, compat, f64, argv = _parse_opts(sys.argv[1:])
    if argv[:1] == ["--argsfile"] and len(argv) >= 2:
        # Windows 的指令列碰到中文路徑會變成亂碼（例如 週報 → �g��），所以腳本路徑與參數改放在 UTF-8 的 JSON 檔裡傳進來
        import json
        with open(argv[1], "r", encoding="utf-8") as f:
            data = json.load(f)
        argv = [data["script"]] + list(data.get("args", []))
    elif argv[:1] == ["--"]:
        argv = argv[1:]
    if not argv:
        sys.stderr.write("fa_run.py: 沒有指定要執行的腳本\n")
        return 2
    here = os.path.dirname(os.path.abspath(__file__))
    script = os.path.abspath(argv[0])
    # 環境變數要在 import fa_gpu 之前設好（fa_gpu 在載入時讀取 FA_BRIDGE_RPC）
    os.environ["FA_BRIDGE_RPC"] = rpc
    if compat in ("on", "off"):
        os.environ["FA_CUDA_COMPAT"] = compat
    if f64 in ("exact", "f32", "auto"):
        os.environ["FA_CUDA_F64"] = f64

    if gpu_only:
        # 只為 numba／cupy／torch／pycuda 服務：腳本沒有 import 它們，就完全照原樣執行（不改編碼、環境、sys.path）
        text = _read_text(script)
        sys.path.insert(0, here)
        import fa_gpu
        if text is None or not fa_gpu.script_needs_shim(text):
            sys.path[:] = [os.path.dirname(script)] + [p for p in sys.path if p != here]
            sys.argv = [script] + argv[1:]
            runpy.run_path(script, run_name="__main__")
            return 0

    # Windows 主控台預設是 cp950，助理讀輸出時當 UTF-8 解碼，中文會變成亂碼（�g��）；統一輸出 UTF-8（子程序也一樣）
    os.environ["PYTHONIOENCODING"] = "utf-8"
    os.environ["PYTHONUTF8"] = "1"
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    os.environ["PYTHONPATH"] = here + os.pathsep + os.environ.get("PYTHONPATH", "")
    sys.path.insert(0, here)
    sys.path.insert(1, os.path.dirname(script))  # 跟直接 python script.py 一樣，腳本所在資料夾在 sys.path 裡
    sys.argv = [script] + argv[1:]
    try:
        import fa_gpu
        if os.environ.get("FA_CUDA_COMPAT", "on") != "off":
            fa_gpu.install()  # GPU 相容層：numba／cupy 墊片（真套件存在時不遮蔽）
    except Exception as e:
        sys.stderr.write("[fa-bridge] gpu compat: %s" % e + chr(10))
    if not gpu_only:
        try:
            import fa_bridge
            fa_bridge.install_hooks()  # 直接送 HTTP 的 LLM 呼叫（OpenAI 標準與 Claude 格式）轉給助理的模型
        except Exception as e:
            sys.stderr.write("[fa-bridge] install_hooks: %s" % e + chr(10))
    runpy.run_path(script, run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
