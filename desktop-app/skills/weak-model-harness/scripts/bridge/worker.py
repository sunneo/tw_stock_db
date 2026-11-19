#!/usr/bin/env python3
"""弱模型 harness 的 Python 工具橋：常駐 worker，stdin/stdout 一行一個 JSON。
  {"op":"list"}                          → {"ok":true,"tools":[{name,description,input_schema}]}  （Claude tool 格式）
  {"id":1,"tool":"browser_open","args":{}} → {"id":1,"ok":true,"result":{...},"images":["/path.png"]}
Playwright 的瀏覽器狀態（頁面、登入）留在這個程序裡，跨呼叫保留；OpenAI 工具（openai_vision / openai_run）重用同一組瀏覽器工具。
環境變數：WH_OUT（截圖資料夾）、OPENAI_API_KEY、OPENAI_MODEL（預設 gpt-4o）、WH_HEADED=1（顯示瀏覽器視窗）。
"""
import base64, json, os, sys, time, traceback

OUT = os.environ.get("WH_OUT") or os.path.join(os.getcwd(), ".weak-harness", "shots")
_pw = {"p": None, "browser": None, "page": None}

def _obj(props, required=()):
    return {"type": "object", "properties": props, "required": list(required)}
S = lambda d: {"type": "string", "description": d}
N = lambda d: {"type": "number", "description": d}
B = lambda d: {"type": "boolean", "description": d}

# ---------------- Playwright ----------------
def _page():
    if _pw["page"] is None:
        from playwright.sync_api import sync_playwright
        _pw["p"] = sync_playwright().start()
        _pw["browser"] = _pw["p"].chromium.launch(headless=os.environ.get("WH_HEADED") != "1")
        _pw["page"] = _pw["browser"].new_page(viewport={"width": 1280, "height": 800})
    return _pw["page"]

def browser_open(a):
    pg = _page()
    if a.get("url"): pg.goto(a["url"], wait_until="domcontentloaded", timeout=30000)
    return {"url": pg.url, "title": pg.title()}

def browser_screenshot(a):
    os.makedirs(OUT, exist_ok=True)
    path = a.get("path") or os.path.join(OUT, "shot_%d.png" % int(time.time() * 1000))
    pg = _page()
    if a.get("selector"): pg.locator(a["selector"]).first.screenshot(path=path)
    else: pg.screenshot(path=path, full_page=bool(a.get("full_page")))
    return {"path": path, "url": pg.url, "_images": [path]}

def browser_click(a):
    pg = _page()
    if a.get("selector"): pg.locator(a["selector"]).first.click(timeout=10000)
    elif a.get("x") is not None and a.get("y") is not None: pg.mouse.click(a["x"], a["y"])
    else: raise ValueError("要給 selector，或 x 與 y")
    return {"url": pg.url}

def browser_type(a):
    pg = _page()
    if a.get("selector"): pg.locator(a["selector"]).first.fill(a["text"], timeout=10000)
    else: pg.keyboard.type(a["text"])
    if a.get("press_enter"): pg.keyboard.press("Enter")
    return {"typed": len(a["text"])}

def browser_press(a):
    _page().keyboard.press(a["key"]); return {"pressed": a["key"]}

def browser_text(a):
    pg = _page()
    t = pg.locator(a["selector"]).first.inner_text(timeout=10000) if a.get("selector") else pg.inner_text("body")
    return {"text": t[: int(a.get("max_chars") or 6000)], "url": pg.url}

def browser_eval(a):
    return {"value": _page().evaluate(a["js"])}

def browser_close(a):
    for k in ("browser", "p"):
        try: (_pw[k].close() if k == "browser" else _pw[k].stop())
        except Exception: pass
    _pw.update(p=None, browser=None, page=None); return {"closed": True}

# ---------------- OpenAI ----------------
def _client():
    key = os.environ.get("OPENAI_API_KEY")
    if not key: raise RuntimeError("沒有設定 OPENAI_API_KEY")
    from openai import OpenAI
    return OpenAI(api_key=key)

def _data_url(path):
    ext = os.path.splitext(path)[1].lower().lstrip(".") or "png"
    return "data:image/%s;base64,%s" % ("jpeg" if ext == "jpg" else ext, base64.b64encode(open(path, "rb").read()).decode())

def openai_vision(a):
    model = a.get("model") or os.environ.get("OPENAI_MODEL") or "gpt-4o"
    path = a["image_path"]
    r = _client().chat.completions.create(model=model, messages=[{"role": "user", "content": [
        {"type": "text", "text": a.get("question") or "描述這張圖片，列出可見的文字與介面元素。"},
        {"type": "image_url", "image_url": {"url": _data_url(path)}}]}])
    return {"answer": r.choices[0].message.content, "model": model}

BROWSER_TOOLS = ["browser_open", "browser_screenshot", "browser_click", "browser_type", "browser_press", "browser_text", "browser_eval"]

def openai_run(a):
    """讓 OpenAI 模型下指令、呼叫上面的瀏覽器工具、看每次截圖，直到完成或步數用完。"""
    model = a.get("model") or os.environ.get("OPENAI_MODEL") or "gpt-4o"; client = _client()
    tools = [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}} for t in TOOLS if t["name"] in BROWSER_TOOLS]
    msgs = [{"role": "system", "content": "你用提供的瀏覽器工具完成使用者的指令。需要看畫面時先截圖。完成後直接用文字回報結果。"}, {"role": "user", "content": a["instruction"]}]
    steps, shots = [], []
    for _ in range(int(a.get("max_steps") or 8)):
        m = client.chat.completions.create(model=model, messages=msgs, tools=tools).choices[0].message
        msgs.append(m.model_dump(exclude_none=True))
        if not m.tool_calls: return {"final": m.content, "steps": steps, "model": model, "_images": shots[-1:]}
        for c in m.tool_calls:
            try: res = HANDLERS[c.function.name](json.loads(c.function.arguments or "{}"))
            except Exception as e: res = {"error": str(e)}
            imgs = res.pop("_images", []) if isinstance(res, dict) else []
            steps.append({"tool": c.function.name, "args": c.function.arguments, "ok": "error" not in res})
            msgs.append({"role": "tool", "tool_call_id": c.id, "content": json.dumps(res, ensure_ascii=False)[:4000]})
            if imgs:
                shots.extend(imgs)
                msgs.append({"role": "user", "content": [{"type": "text", "text": "剛才的截圖："}, {"type": "image_url", "image_url": {"url": _data_url(imgs[0])}}]})
    return {"final": None, "steps": steps, "model": model, "error": "步數用完仍未完成", "_images": shots[-1:]}

HANDLERS = {f.__name__: f for f in (browser_open, browser_screenshot, browser_click, browser_type, browser_press, browser_text, browser_eval, browser_close, openai_vision, openai_run)}
TOOLS = [
    {"name": "browser_open", "description": "用 Playwright 開啟（或沿用）瀏覽器；有給 url 就前往該網址。", "input_schema": _obj({"url": S("要前往的網址，可省略")})},
    {"name": "browser_screenshot", "description": "對目前頁面截圖，存成 PNG 並回傳圖片。", "input_schema": _obj({"full_page": B("整頁截圖"), "selector": S("只截這個元素"), "path": S("存檔路徑，可省略")})},
    {"name": "browser_click", "description": "點擊元素（CSS selector）或座標（x、y，像素）。", "input_schema": _obj({"selector": S("CSS selector"), "x": N("x 座標"), "y": N("y 座標")})},
    {"name": "browser_type", "description": "在元素裡輸入文字（沒給 selector 就對目前焦點輸入）。", "input_schema": _obj({"selector": S("CSS selector"), "text": S("要輸入的文字"), "press_enter": B("輸入後按 Enter")}, ["text"])},
    {"name": "browser_press", "description": "按鍵盤按鍵，例如 Enter、Tab、Control+A。", "input_schema": _obj({"key": S("按鍵名稱")}, ["key"])},
    {"name": "browser_text", "description": "讀取頁面或某元素的可見文字。", "input_schema": _obj({"selector": S("CSS selector，可省略表示整頁"), "max_chars": N("最多回傳字數，預設 6000")})},
    {"name": "browser_eval", "description": "在頁面執行 JavaScript 運算式並回傳結果。", "input_schema": _obj({"js": S("JavaScript 運算式")}, ["js"])},
    {"name": "browser_close", "description": "關閉瀏覽器。", "input_schema": _obj({})},
    {"name": "openai_vision", "description": "把一張圖片交給 OpenAI 視覺模型辨識，回答問題（需要 OPENAI_API_KEY）。", "input_schema": _obj({"image_path": S("圖片檔路徑"), "question": S("要問的問題，可省略"), "model": S("模型名稱，可省略")}, ["image_path"])},
    {"name": "openai_run", "description": "交給 OpenAI 模型自己下指令：它會呼叫瀏覽器工具、看截圖，直到完成並回報（需要 OPENAI_API_KEY）。", "input_schema": _obj({"instruction": S("要完成的事"), "max_steps": N("最多幾步，預設 8"), "model": S("模型名稱，可省略")}, ["instruction"])},
]

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try:
            req = json.loads(line)
            if req.get("op") == "list": resp = {"ok": True, "tools": TOOLS}
            else:
                res = HANDLERS[req["tool"]](req.get("args") or {})
                resp = {"id": req.get("id"), "ok": True, "images": res.pop("_images", []) if isinstance(res, dict) else [], "result": res}
        except Exception as e:
            resp = {"id": (locals().get("req") or {}).get("id"), "ok": False, "error": "%s: %s" % (type(e).__name__, e), "trace": traceback.format_exc()[-600:]}
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n"); sys.stdout.flush()
    browser_close({})

if __name__ == "__main__":
    main()
