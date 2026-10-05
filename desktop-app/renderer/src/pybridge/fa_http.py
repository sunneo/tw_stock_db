# -*- coding: utf-8 -*-
"""
fa_http — 直接送 HTTP 的 LLM 呼叫也轉給助理的模型。

有些腳本不用 openai／anthropic 套件，而是自己用 requests／httpx／urllib 打 API：
    requests.post("https://api.openai.com/v1/chat/completions", headers={"Authorization": ...}, json={...})
    requests.post("https://api.anthropic.com/v1/messages", headers={"x-api-key": ..., "anthropic-version": ...}, json={...})
或打自己架的相容伺服器（任何主機，路徑長得一樣就算）。這裡攔截這些呼叫，**不真的連出去**，改由助理已設定的 LLM Model 回答，
回傳的格式跟被呼叫的端點一樣（OpenAI 標準或 Claude 格式；一般回應與串流 SSE 都支援）。

支援的端點（路徑後綴比對，前面的 /v1、/openai/v1 之類不拘）：
  OpenAI 標準：POST /chat/completions、/responses、/completions、/embeddings、/images/generations|edits|variations、
               /audio/transcriptions|translations|speech、/moderations；GET /models
  Claude：     POST /messages（含 stream）、/messages/count_tokens
embeddings、圖片、語音、工具呼叫一律先從已設定的 LLM Model 清單找有這個能力的 Model，全部都不支援才回 501。
不是這些路徑的請求完全不碰（照原本連網）。想讓某個主機不被攔截：環境變數 FA_HTTP_BYPASS_HOSTS=host1,host2。
"""
import base64
import io
import json
import os
import re
import sys

import fa_bridge
import fa_llm
import fa_sim

_INSTALLED = {"done": False, "hooked": set()}


# ---------------------------------------------------------------- multipart 解析（圖片編輯、語音轉文字會用到）
def parse_multipart(body, content_type):
    m = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not m:
        return {}, []
    boundary = ("--" + m.group(1)).encode()
    fields, files = {}, []
    for part in body.split(boundary):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        head, _, data = part.partition(b"\r\n\r\n")
        h = head.decode("utf-8", "replace")
        name = re.search(r'name="([^"]*)"', h)
        fn = re.search(r'filename="([^"]*)"', h)
        ct = re.search(r"Content-Type:\s*([^\r\n]+)", h, re.I)
        if data.endswith(b"\r\n"):
            data = data[:-2]
        if fn:
            files.append({"name": name.group(1) if name else "file", "filename": fn.group(1), "type": ct.group(1).strip() if ct else "application/octet-stream",
                          "b64": base64.b64encode(data).decode("ascii")})
        elif name:
            fields[name.group(1)] = data.decode("utf-8", "replace")
    return fields, files


def _err(status, message, style):
    if style == "anthropic":
        body = {"type": "error", "error": {"type": "api_error" if status != 501 else "not_supported_error", "message": message}}
    else:
        body = {"error": {"message": message, "type": "not_supported" if status == 501 else "api_error", "param": None, "code": "not_supported" if status == 501 else None}}
    return status, {"content-type": "application/json"}, json.dumps(body, ensure_ascii=False).encode("utf-8")


def _status_of(e):
    if isinstance(e, fa_bridge.NotSupported):
        return 501
    m = re.search(r"API錯誤\((\d{3})\)", str(e))
    return int(m.group(1)) if m else 502


def _json(obj, status=200):
    return status, {"content-type": "application/json"}, json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _sse(events, done):
    return 200, {"content-type": "text/event-stream", "cache-control": "no-cache"}, fa_llm.sse(events, done=done).encode("utf-8")


# ---------------------------------------------------------------- 路由
_ROUTES = [
    ("POST", re.compile(r"/messages/count_tokens/?$"), "count_tokens"),
    ("POST", re.compile(r"/messages/?$"), "anthropic"),
    ("POST", re.compile(r"/chat/completions/?$"), "chat"),
    ("POST", re.compile(r"/responses/?$"), "responses"),
    ("POST", re.compile(r"/completions/?$"), "completions"),
    ("POST", re.compile(r"/embeddings/?$"), "embeddings"),
    ("POST", re.compile(r"/images/(generations|edits|variations)/?$"), "images"),
    ("POST", re.compile(r"/audio/(transcriptions|translations|speech)/?$"), "audio"),
    ("POST", re.compile(r"/moderations/?$"), "moderations"),
    ("GET", re.compile(r"/models/?$"), "models"),
]


def route(method, url, headers=None, body=b""):
    """是 LLM 端點就回 (status, headers, body_bytes)，不是就回 None。"""
    if not fa_bridge.ACTIVE:
        return None
    try:
        from urllib.parse import urlparse
        u = urlparse(url)
    except Exception:
        return None
    if not u.scheme.startswith("http"):
        return None
    bypass = [h.strip().lower() for h in os.environ.get("FA_HTTP_BYPASS_HOSTS", "").split(",") if h.strip()]
    if (u.hostname or "").lower() in bypass:
        return None
    method = (method or "GET").upper()
    kind = None
    for m, rx, k in _ROUTES:
        if m == method and rx.search(u.path):
            kind = k
            m_ = rx.search(u.path)
            break
    if kind is None:
        return None
    ct = ""
    for k, v in (headers or {}).items():
        if str(k).lower() == "content-type":
            ct = str(v)
    if isinstance(body, str):
        body = body.encode("utf-8")
    body = body or b""
    style = "anthropic" if kind in ("anthropic", "count_tokens") else "openai"
    data = {}
    fields, files = {}, []
    if kind not in ("models",):
        if "multipart/form-data" in ct:
            fields, files = parse_multipart(body, ct)
        else:
            try:
                data = json.loads(body.decode("utf-8") or "{}")
            except ValueError:
                return None
            if not isinstance(data, dict):
                return None
    # 保險：看起來不像 LLM 請求就不碰（例如別的服務剛好也有 /messages 這種路徑）
    if kind == "anthropic" and not ("messages" in data and ("model" in data or "max_tokens" in data)):
        return None
    if kind == "count_tokens" and "messages" not in data:
        return None
    if kind == "chat" and "messages" not in data:
        return None
    if kind == "responses" and "input" not in data and "instructions" not in data:
        return None
    if kind == "completions" and "prompt" not in data:
        return None
    try:
        return _handle(kind, m_, data, fields, files, u)
    except Exception as e:
        return _err(_status_of(e), str(e), style)


def _handle(kind, m, data, fields, files, u):
    if kind == "chat":
        d = dict(data)
        stream, so = d.pop("stream", False), d.pop("stream_options", None)
        r = fa_llm.complete(fa_llm.chat_request(d.pop("model", None), d.pop("messages"), **d))
        r.setdefault("object", "chat.completion")
        if stream:
            return _sse(fa_llm.chat_chunks(r, include_usage=bool((so or {}).get("include_usage"))), done=True)
        return _json(r)
    if kind == "responses":
        d = dict(data)
        stream = d.pop("stream", False)
        r = fa_llm.complete(fa_llm.responses_to_chat(model=d.pop("model", None), input=d.pop("input", None), instructions=d.pop("instructions", None), **d))
        resp = fa_llm.chat_to_response(r, data.get("model"))
        return _sse(fa_llm.response_events(resp), done=False) if stream else _json(resp)
    if kind == "completions":
        d = dict(data)
        stream = d.pop("stream", False)
        r = fa_llm.complete(fa_llm.completions_to_chat(d.pop("prompt"), model=d.pop("model", None), **{k: v for k, v in d.items() if k in ("temperature", "max_tokens", "top_p", "stop", "n", "seed")}))
        out = fa_llm.chat_to_completion(r)
        return _json(out)
    if kind == "anthropic":
        d = dict(data)
        stream = d.pop("stream", False)
        r = fa_llm.complete(fa_llm.anthropic_to_chat(**d))
        msg = fa_llm.chat_to_anthropic(r, data.get("model"))
        return _sse(fa_llm.anthropic_events(msg), done=False) if stream else _json(msg)
    if kind == "count_tokens":
        return _json({"input_tokens": fa_llm.estimate_tokens({"s": data.get("system"), "m": data.get("messages")})})
    if kind == "embeddings":
        r = fa_llm.upstream("embeddings", "/embeddings", json_body=data)
        return _json(r.get("json") or {})
    if kind == "images":
        sub = m.group(1)
        path = "/images/" + sub
        if files:
            r = fa_llm.upstream("images", path, form={"fields": fields, "files": files})
        else:
            r = fa_llm.upstream("images", path, json_body=data)
        return _json(r.get("json") or {})
    if kind == "audio":
        sub = m.group(1)
        if sub == "speech":
            r = fa_llm.upstream("audio_speech", "/audio/speech", json_body=data, want="bytes")
            return 200, {"content-type": r.get("content_type") or "audio/mpeg"}, base64.b64decode(r.get("b64") or "")
        fmt = fields.get("response_format")
        r = fa_llm.upstream("audio_transcribe", "/audio/" + sub, form={"fields": fields, "files": files}, want="bytes" if fmt in ("text", "srt", "vtt") else "json")
        if fmt in ("text", "srt", "vtt"):
            return 200, {"content-type": "text/plain; charset=utf-8"}, base64.b64decode(r.get("b64") or "")
        return _json(r.get("json") or {})
    if kind == "moderations":
        return _json(fa_sim.moderation(**{k: v for k, v in data.items() if k in ("input", "model")}))
    if kind == "models":
        return _json(fa_sim.models(fa_bridge.call("llm.info", {}, timeout=10.0).get("model"))[0])
    return None


# ---------------------------------------------------------------- 安裝：requests／httpx／urllib（模組之後才被 import 也會補上）
def _patch_requests():
    import requests
    from requests import Session
    if getattr(Session.send, "_fa_patched", False):
        return
    orig = Session.send

    def send(self, request, **kw):
        hdrs = dict(request.headers or {})
        r = route(request.method, request.url, hdrs, request.body if not hasattr(request.body, "read") else request.body.read())
        if r is None:
            return orig(self, request, **kw)
        status, h, body = r
        resp = requests.Response()
        resp.status_code = status
        resp._content = body
        resp.headers = requests.structures.CaseInsensitiveDict(h)
        resp.url = request.url
        resp.request = request
        resp.encoding = "utf-8"
        resp.raw = io.BytesIO(body)
        resp.reason = "OK" if status < 400 else "Error"
        return resp
    send._fa_patched = True
    Session.send = send


def _patch_httpx():
    import httpx
    for cls_name, is_async in (("Client", False), ("AsyncClient", True)):
        cls = getattr(httpx, cls_name, None)
        if cls is None or getattr(cls.send, "_fa_patched", False):
            continue
        orig = cls.send
        if is_async:
            async def send(self, request, *a, __orig=orig, **kw):
                r = route(request.method, str(request.url), dict(request.headers), request.content if hasattr(request, "content") else b"")
                if r is None:
                    return await __orig(self, request, *a, **kw)
                return httpx.Response(r[0], headers=r[1], content=r[2], request=request)
        else:
            def send(self, request, *a, __orig=orig, **kw):
                r = route(request.method, str(request.url), dict(request.headers), request.read() if hasattr(request, "read") else b"")
                if r is None:
                    return __orig(self, request, *a, **kw)
                return httpx.Response(r[0], headers=r[1], content=r[2], request=request)
        send._fa_patched = True
        cls.send = send


def _patch_urllib():
    import urllib.request
    import urllib.response
    import urllib.error
    import email.message
    if getattr(urllib.request.urlopen, "_fa_patched", False):
        return
    orig = urllib.request.urlopen

    def urlopen(url, data=None, *a, **kw):
        req = url if isinstance(url, urllib.request.Request) else None
        full = req.full_url if req else url
        method = req.get_method() if req else ("POST" if data is not None else "GET")
        body = data if data is not None else (req.data if req else None)
        hdrs = dict(req.header_items()) if req else {}
        r = route(method, full, hdrs, body or b"")
        if r is None:
            return orig(url, data, *a, **kw)
        status, h, payload = r
        msg = email.message.Message()
        for k, v in h.items():
            msg[k] = v
        resp = urllib.response.addinfourl(io.BytesIO(payload), msg, full, status)
        if status >= 400:
            raise urllib.error.HTTPError(full, status, "Error", msg, io.BytesIO(payload))
        return resp
    urlopen._fa_patched = True
    urllib.request.urlopen = urlopen


_PATCHERS = {"requests": _patch_requests, "httpx": _patch_httpx}


class _OnImport(object):
    """requests／httpx 在安裝轉接之後才被 import（例如 Pyodide 裡 micropip 現裝）時，import 完成後補上攔截。"""

    def find_spec(self, name, path=None, target=None):
        if name not in _PATCHERS or name in _INSTALLED["hooked"]:
            return None
        import importlib.util
        _INSTALLED["hooked"].add(name)
        try:
            spec = importlib.util.find_spec(name)
        finally:
            _INSTALLED["hooked"].discard(name)
        if spec is None or spec.loader is None:
            return None
        loader = spec.loader
        orig_exec = loader.exec_module

        def exec_module(module, _o=orig_exec, _n=name):
            _o(module)
            try:
                _PATCHERS[_n]()
            except Exception as e:
                sys.stderr.write("[fa-bridge] patch %s: %s\n" % (_n, e))
        try:
            loader.exec_module = exec_module
        except Exception:
            return None
        return spec


def install():
    if _INSTALLED["done"]:
        return
    _INSTALLED["done"] = True
    try:
        _patch_urllib()
    except Exception as e:
        sys.stderr.write("[fa-bridge] patch urllib: %s\n" % e)
    for name, fn in _PATCHERS.items():
        if name in sys.modules:
            try:
                fn()
            except Exception as e:
                sys.stderr.write("[fa-bridge] patch %s: %s\n" % (name, e))
        else:
            import importlib.util
            try:
                if importlib.util.find_spec(name) is not None:
                    try:
                        fn()
                    except Exception as e:
                        sys.stderr.write("[fa-bridge] patch %s: %s\n" % (name, e))
            except Exception:
                pass
    if not any(isinstance(f, _OnImport) for f in sys.meta_path):
        sys.meta_path.insert(0, _OnImport())
