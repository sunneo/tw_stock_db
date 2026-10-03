# -*- coding: utf-8 -*-
"""
fa_run.py — Floating AI Assistant 執行技能包 Python 腳本的啟動器。

用法（由助理自動改寫指令，不需要手動打）：
    python fa_run.py --rpc <信箱資料夾> -- <腳本.py> [腳本參數…]

作用：讓腳本 import 到「轉接版」的 playwright（實際呼叫助理的瀏覽器工具）與 fa_bridge，
並把同樣的設定傳給腳本再啟動的子程序（PYTHONPATH），然後照原樣執行腳本。
"""
import os
import runpy
import sys


def main():
    argv = sys.argv[1:]
    rpc = ""
    if argv[:1] == ["--rpc"] and len(argv) >= 2:
        rpc = argv[1]
        argv = argv[2:]
    if argv[:1] == ["--"]:
        argv = argv[1:]
    if not argv:
        sys.stderr.write("fa_run.py: 沒有指定要執行的腳本\n")
        return 2
    here = os.path.dirname(os.path.abspath(__file__))
    script = os.path.abspath(argv[0])
    os.environ["FA_BRIDGE_RPC"] = rpc
    os.environ["PYTHONPATH"] = here + os.pathsep + os.environ.get("PYTHONPATH", "")
    sys.path.insert(0, here)
    sys.path.insert(1, os.path.dirname(script))  # 跟直接 python script.py 一樣，腳本所在資料夾在 sys.path 裡
    sys.argv = [script] + argv[1:]
    runpy.run_path(script, run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
