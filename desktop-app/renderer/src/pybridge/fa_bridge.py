# -*- coding: utf-8 -*-
"""
fa_bridge — Python 端的「API 轉接」通道（由 Floating AI Assistant 在執行技能包的 Python 腳本時自動提供）。

腳本裡呼叫的某些公開 API（例如 playwright.sync_api）在這個環境裡其實是轉接到 AI 助理自己的工具／領域，
所以腳本不需要真的有 Chrome 遠端除錯埠、也不需要裝 Playwright。

通訊方式：桌面版用檔案當信箱；網頁版（Pyodide）直接呼叫助理頁面的 JS 模組。桌面版的信箱做法：——把請求寫成 req-<id>.json 放進 FA_BRIDGE_RPC 資料夾，助理（主程式）處理後寫出 res-<id>.json。
不需要開任何網路埠、不需要改主程式。

直接用法：
    import fa_bridge
    fa_bridge.tool("browser_get_page_text", tab_id=3)           # 呼叫助理的一個工具
    fa_bridge.domain("browser_control", "開啟 https://… 並截圖")  # 委派給助理的一個領域（子 AI）
"""
import json
import os
import sys
import time
import uuid

RPC_DIR = os.environ.get("FA_BRIDGE_RPC", "")
IN_BROWSER = sys.platform == "emscripten"  # 網頁版／Pyodide：直接呼叫助理頁面的 JS 模組 _fa_pybridge，不需要信箱檔案


class BridgeError(RuntimeError):
    pass


def available():
    return IN_BROWSER or (bool(RPC_DIR) and os.path.isdir(RPC_DIR))


def sleep(seconds):
    """等一下。在網頁版（Pyodide）不能用 time.sleep（會卡住整個頁面），改用 JS 的計時器。"""
    if IN_BROWSER:
        import asyncio
        import _fa_pybridge
        asyncio.run(_fa_pybridge.sleep(int(float(seconds) * 1000)))
    else:
        time.sleep(seconds)


def call(op, args=None, timeout=240.0):
    """送一個請求給助理並等回應。op 例如 'pw.goto'、'tool'、'domain'。"""
    if IN_BROWSER:
        import asyncio
        import _fa_pybridge
        raw = asyncio.run(_fa_pybridge.call(op, json.dumps(args or {})))
        data = json.loads(str(raw))
        if not data.get("ok", False):
            raise BridgeError(data.get("error") or "橋接呼叫失敗：" + op)
        return data.get("result")
    if not available():
        raise BridgeError("不在 AI 助理的橋接環境裡（沒有 FA_BRIDGE_RPC）。這支腳本要由助理的 run_command（桌面版）或 python_execute 執行。")
    rid = uuid.uuid4().hex[:12]
    req = os.path.join(RPC_DIR, "req-%s.json" % rid)
    res = os.path.join(RPC_DIR, "res-%s.json" % rid)
    tmp = req + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"id": rid, "op": op, "args": args or {}}, f, ensure_ascii=False)
    os.replace(tmp, req)
    t0 = time.time()
    delay = 0.03
    while True:
        if os.path.exists(res):
            try:
                with open(res, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (ValueError, OSError):
                time.sleep(0.05)  # 助理還在寫入
                continue
            for p in (res, req):
                try:
                    os.remove(p)
                except OSError:
                    pass
            if not data.get("ok", False):
                raise BridgeError(data.get("error") or "橋接呼叫失敗：" + op)
            return data.get("result")
        if time.time() - t0 > timeout:
            raise BridgeError("橋接逾時（%d 秒沒有回應）：%s" % (int(timeout), op))
        time.sleep(delay)
        delay = min(0.2, delay * 1.5)


def tool(name, **args):
    """呼叫助理的一個工具（目前開放 browser_* 這組）。回傳工具的結果（已解析的 dict）。"""
    return call("tool", {"name": name, "args": args})


def domain(domain_key, task):
    """把一個任務委派給助理的領域（子 AI，例如 browser_control、desktop_ops）。回傳它的文字結論。"""
    return call("domain", {"domain": domain_key, "task": task}, timeout=900.0)
