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


ACTIVE = True  # 網頁版：停用轉接（一般的 python_execute）時設成 False，攔截會全部放行


class BridgeError(RuntimeError):
    pass


class NotSupported(BridgeError):
    """助理設定的所有 LLM Model 都沒有這個能力（embeddings、圖片、語音、工具呼叫…）。有任何一個 Model 支援就不會丟這個。"""


def _fail(data, op):
    msg = data.get("error") or "橋接呼叫失敗：" + op
    if str(msg).startswith("NOT_SUPPORTED:"):
        raise NotSupported(str(msg)[len("NOT_SUPPORTED:"):].strip())
    raise BridgeError(msg)


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
        # 同步等待 JS Promise：pyodide.ffi.run_sync 在 JSPI 下掛起 wasm 堆疊，不需要 SharedArrayBuffer。
        # 前提是整支程式包在 callPromising 裡執行（見 floating-assistant.js 的 worker 路徑）；否則這裡會報錯。
        from pyodide.ffi import run_sync
        import _fa_pybridge
        raw = run_sync(_fa_pybridge.call(op, json.dumps(args or {})))
        data = json.loads(str(raw))
        if not data.get("ok", False):
            _fail(data, op)
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
                _fail(data, op)
            return data.get("result")
        if time.time() - t0 > timeout:
            raise BridgeError("橋接逾時（%d 秒沒有回應）：%s" % (int(timeout), op))
        time.sleep(delay)
        delay = min(0.2, delay * 1.5)


def can_present():
    """零拷貝送畫面（ImageBitmap）可不可用：只有網頁版（Worker 的 Pyodide）而且頁面端新到認得 present 才可以。"""
    if not IN_BROWSER:
        return False
    try:
        import _fa_pybridge
        return hasattr(_fa_pybridge, "present")
    except Exception:
        return False


def present_ready():
    """在途的畫面還沒滿（頁面還來得及畫）。滿了就別白做一次擷取。
    Python 迴圈是同步的，Worker 的事件迴圈不會自己轉，頁面回的確認（present_ack）就收不到；所以在途滿的時候主動讓出幾次事件迴圈等確認，還是沒空才回 False（這一幀丟掉）。"""
    try:
        import _fa_pybridge
        if _fa_pybridge.ready():
            return True
        from pyodide.ffi import run_sync
        for _ in range(6):
            run_sync(_fa_pybridge.tick())
            if _fa_pybridge.ready():
                return True
        return False
    except Exception:
        return False


def present_acked():
    """頁面確認畫完的畫面張數（累計）。"""
    try:
        import _fa_pybridge
        return int(_fa_pybridge.acked())
    except Exception:
        return 0


def present_pref():
    """這個 process（頁面）已經量好的畫面路徑：{'mode': 'bitmap'|'png', 'bitmap': 幀率, 'png': 幀率}，還沒量過是 None。同一台機器之後的 process 也會沿用（存在 GPU 相容層的速率紀錄）。"""
    try:
        return call("gui.present_path", {})
    except Exception:
        return None


def present_pref_set(mode, bitmap_fps, png_fps):
    try:
        call("gui.present_path", {"set": True, "mode": mode, "bitmap_fps": float(bitmap_fps), "png_fps": float(png_fps)})
    except Exception:
        pass


def present(win_id, node_id, bitmap):
    """把一張 ImageBitmap（OffscreenCanvas 擷取的，所有權轉移給頁面）畫到視窗的畫布上，不等頁面回覆。
    回傳 1＝已送出、0＝在途太多被丟掉（照常往下跑，下一幀再送）、-1＝不支援（呼叫端退回 PNG 的 image＋draw）。"""
    if not can_present():
        return -1
    import _fa_pybridge
    return int(_fa_pybridge.present(str(win_id), str(node_id), bitmap))


async def acall(op, args=None, timeout=240.0):
    """call 的 async 版：網頁版直接 await 助理頁面的 JS（不會卡住事件迴圈）；桌面版把檔案信箱的等待丟到執行緒，不擋住別的 async 工作。"""
    if IN_BROWSER:
        import _fa_pybridge
        raw = await _fa_pybridge.call(op, json.dumps(args or {}))
        data = json.loads(str(raw))
        if not data.get("ok", False):
            _fail(data, op)
        return data.get("result")
    import asyncio
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: call(op, args, timeout))


def install_hooks():
    """裝上轉接用的攔截：直接送 HTTP 的 LLM 呼叫（OpenAI 標準與 Claude 格式）轉給助理的模型；網頁版另外把檔案寫入繞進 fap。可重複呼叫。"""
    try:
        import fa_http
        fa_http.install()
    except Exception as e:  # 缺 requests／httpx 之類不是錯誤
        sys.stderr.write("[fa-bridge] http hook: %s\n" % e)
    if IN_BROWSER:
        try:
            import fa_fs
            fa_fs.install()
        except Exception as e:
            sys.stderr.write("[fa-bridge] fs hook: %s\n" % e)
    try:  # 程式有 import OpenGL（Worker 會預先用 micropip 裝 PyOpenGL）：先登記平台後端，之後 import OpenGL.GL 才會選到它
        import fa_opengl_platform
        fa_opengl_platform.register()
    except Exception as e:
        sys.stderr.write("[fa-bridge] opengl hook: %s\n" % e)
    try:  # 程式有 import pygame（Worker 會預先載入 pygame-ce）才接上真 pygame 的後端；其他程式什麼都不會發生
        import fa_pygame
        fa_pygame.install()
    except Exception as e:
        sys.stderr.write("[fa-bridge] pygame hook: %s\n" % e)


def tool(name, **args):
    """呼叫助理的一個工具（目前開放 browser_* 這組）。回傳工具的結果（已解析的 dict）。"""
    return call("tool", {"name": name, "args": args})


def domain(domain_key, task):
    """把一個任務委派給助理的領域（子 AI，例如 browser_control、desktop_ops）。回傳它的文字結論。"""
    return call("domain", {"domain": domain_key, "task": task}, timeout=900.0)
