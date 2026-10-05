# -*- coding: utf-8 -*-
"""
fa_net — 一般 HTTP（不是 LLM 端點）的去處，以及 http.client 的攔截。

兩個去處：
  1. 本機網址（127.0.0.1、localhost、[::1]、*.localhost、*.local）
     助理的沙盒有 mock 伺服器（資料存在 IndexedDB 的持久儲存那一層）時，請求就接給它；
     沒有 mock 伺服器：網頁版回「連線被拒」（Pyodide 沒有 socket，本來就連不到），桌面版照原本連真的本機伺服器。
  2. 外部網址（只有網頁版）
     Pyodide 沒有 socket、又有 CORS，所以改走助理既有的出口 _terminalHttpFetch：有設定 proxy／Cloudflare Worker 就經過它，
     沒設定就直接 fetch（可能被 CORS 擋下，錯誤訊息會說明）。桌面版的外部網址照原本連網，不經過這裡。

http.client 的 HTTPConnection／HTTPSConnection.request() 會先問 route()；有人接手就不真的連線，getresponse() 回一個標準的 HTTPResponse。
requests／httpx／urllib 由 fa_http 的攔截呼叫同一個 route()（先看是不是 LLM 端點，再看這裡）。
想讓某個主機完全不被攔截：環境變數 FA_HTTP_BYPASS_HOSTS=host1,host2。
限制：只攔 request()（urlopen、requests 的 urllib3 都是用它）；自己用 putrequest／putheader／endheaders 逐步組請求的程式不攔。
"""
import base64
import http.client
import io
import os
import sys

import fa_bridge

_INSTALLED = {"done": False}


def is_local_host(host):
    h = (host or "").lower().strip("[]")
    return h in ("localhost", "127.0.0.1", "::1", "0.0.0.0") or h.startswith("127.") or h.endswith(".localhost") or h.endswith(".local")


def route(method, url, headers=None, body=b""):
    """回 (status, headers_dict, body_bytes)；不接手就回 None。連不上會丟 ConnectionError。"""
    if not fa_bridge.ACTIVE:
        return None
    try:
        from urllib.parse import urlparse
        u = urlparse(url)
    except Exception:
        return None
    if not (u.scheme or "").startswith("http"):
        return None
    host = (u.hostname or "").lower()
    if host in [h.strip().lower() for h in os.environ.get("FA_HTTP_BYPASS_HOSTS", "").split(",") if h.strip()]:
        return None
    local = is_local_host(host)
    if not local and not fa_bridge.IN_BROWSER:
        return None
    if isinstance(body, str):
        body = body.encode("utf-8")
    args = {"method": (method or "GET").upper(), "url": url, "headers": {str(k): str(v) for k, v in (headers or {}).items()},
            "b64": base64.b64encode(body).decode("ascii") if body else ""}
    if local:
        r = fa_bridge.call("net.local", args, timeout=90.0)
        if r.get("found"):
            return _pack(r)
        if fa_bridge.IN_BROWSER:
            names = r.get("servers") or []
            raise ConnectionRefusedError("連不到 %s：網頁版沒有真的本機伺服器，也沒有開著的 mock 伺服器（沙盒的 sandbox_mock 部署過的：%s）。先用 sandbox_mock 部署一個伺服器程式再連。" % (host, "、".join(names) or "無"))
        return None
    try:
        r = fa_bridge.call("net.fetch", args, timeout=180.0)
    except fa_bridge.BridgeError as e:
        raise ConnectionError(str(e))
    return _pack(r)


def _pack(r):
    h = {}
    for k, v in r.get("headers") or []:
        k = str(k).lower()
        h[k] = (h[k] + ", " + v) if k in h and k != "set-cookie" else v
    return int(r.get("status") or 502), h, base64.b64decode(r.get("b64") or "")


class _FakeSock(object):
    def __init__(self, raw):
        self._raw = raw

    def makefile(self, *a, **k):
        return io.BytesIO(self._raw)

    def close(self):
        pass


def _make_response(status, headers, body, reason, method):
    lines = ["HTTP/1.1 %d %s" % (status, reason or http.client.responses.get(status, "Status"))]
    hs = {k: v for k, v in headers.items() if k not in ("content-length", "transfer-encoding", "connection")}
    for k, v in hs.items():
        lines.append("%s: %s" % (k, v))
    lines.append("Content-Length: %d" % len(body))
    lines.append("Connection: close")
    raw = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1", "replace") + (b"" if method == "HEAD" else body)
    resp = http.client.HTTPResponse(_FakeSock(raw), method=method)
    resp.begin()
    return resp


def patch_http_client():
    if getattr(http.client.HTTPConnection.request, "_fa_patched", False):
        return
    orig_request = http.client.HTTPConnection.request
    orig_getresponse = http.client.HTTPConnection.getresponse
    orig_close = http.client.HTTPConnection.close

    def request(self, method, url, body=None, headers=None, *a, **kw):
        self._fa_pending = None
        self._fa_method = (method or "GET").upper()
        if fa_bridge.ACTIVE:
            try:
                import fa_http
                scheme = "https" if isinstance(self, http.client.HTTPSConnection) else "http"
                default = 443 if scheme == "https" else 80
                host = self.host if ":" not in self.host else "[" + self.host + "]"
                full = url if url.startswith("http") else "%s://%s%s%s" % (scheme, host, "" if self.port == default else ":%d" % self.port, url)
                payload = body
                if payload is not None and not isinstance(payload, (bytes, bytearray, str)):
                    payload = payload.read() if hasattr(payload, "read") else b"".join(x if isinstance(x, bytes) else str(x).encode("utf-8") for x in payload)
                r = fa_http.route(method, full, dict(headers or {}), payload or b"")
            except OSError as e:
                self._fa_pending = e
                return None
            if r is not None:
                self._fa_pending = r
                return None
        return orig_request(self, method, url, body, headers or {}, *a, **kw)

    def getresponse(self):
        p = getattr(self, "_fa_pending", None)
        if p is None:
            return orig_getresponse(self)
        self._fa_pending = None
        if isinstance(p, Exception):
            raise p
        status, h, payload = p[0], p[1], p[2]
        reason = ""
        return _make_response(status, h, payload, reason, getattr(self, "_fa_method", "GET"))

    def close(self):
        self._fa_pending = None
        return orig_close(self)
    request._fa_patched = True
    http.client.HTTPConnection.request = request
    http.client.HTTPConnection.getresponse = getresponse
    http.client.HTTPConnection.close = close


def install():
    if _INSTALLED["done"]:
        return
    _INSTALLED["done"] = True
    try:
        patch_http_client()
    except Exception as e:
        sys.stderr.write("[fa-bridge] patch http.client: %s\n" % e)
