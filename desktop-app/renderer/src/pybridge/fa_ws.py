# -*- coding: utf-8 -*-
"""
fa_ws — Python 的 WebSocket 用戶端接到沙盒 mock 伺服器（跟 fa_net 的 HTTP 同一層，支援 websocket-client 與 websockets）。

本機網址（127.0.0.1、localhost、[::1]、*.localhost、*.local）有 mock 伺服器就接過去；
沒有：網頁版丟 ConnectionRefusedError（Pyodide 沒有 socket），桌面版照原本連真的本機伺服器。
外部網址：網頁版丟 ConnectionError（沒有可用的 WebSocket 出口），桌面版照原本連網。

支援：
  websocket-client：websocket.create_connection()（send／send_binary／recv／recv_data／settimeout／close）、WebSocketApp.run_forever()（on_open／on_message／on_error／on_close、send、close）
  websockets：websockets.sync.client.connect()、websockets.connect()／websockets.asyncio.client.connect()（async with／await／async for、send／recv／close）
模組在轉接安裝之後才被 import 也會補上（見 fa_http 的 import 攔截）。收訊息是短輪詢（每次最多等 250 毫秒），非同步程式同時收送不會互相卡住。
"""
import base64
import sys
import time

import fa_bridge
import fa_net


class Closed(Exception):
    def __init__(self, code=1005, reason=""):
        Exception.__init__(self, "連線已關閉（%s %s）" % (code, reason))
        self.code = code
        self.reason = reason


def _applies(url):
    """要接手就回 True；不接手回 False（桌面版放行）；網頁版沒出口就丟錯。"""
    if not fa_bridge.ACTIVE:
        return False
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if fa_net.is_local_host(host):
        return True
    if fa_bridge.IN_BROWSER:
        raise ConnectionError("網頁版連不到外部 WebSocket（%s）：沒有可用的 WebSocket 出口；本機網址（127.0.0.1／localhost／*.local）可以連沙盒的 mock 伺服器。" % host)
    return False


def _headers(h):
    out = {}
    if isinstance(h, dict):
        out = {str(k): str(v) for k, v in h.items()}
    elif h:
        for x in h:
            if isinstance(x, (tuple, list)) and len(x) == 2:
                out[str(x[0])] = str(x[1])
            elif isinstance(x, str) and ":" in x:
                k, _, v = x.partition(":")
                out[k.strip()] = v.strip()
    return out


def _opened(r, url):
    if not r.get("found"):
        if fa_bridge.IN_BROWSER:
            raise ConnectionRefusedError("連不到 %s：網頁版沒有真的本機伺服器，也沒有開著的 mock 伺服器（沙盒部署過的：%s）。先用 sandbox_mock 部署一個有 WebSocket 的伺服器程式。" % (url, "、".join(r.get("servers") or []) or "無"))
        return None
    if not r.get("ok"):
        raise ConnectionError("WebSocket 連線失敗：%s" % r.get("error"))
    return _Sock(r["id"])


def open_mock(url, headers=None):
    """接手就回 _Sock；桌面版沒有 mock 伺服器回 None（照原本連）。"""
    if not _applies(url):
        return None
    return _opened(fa_bridge.call("ws.open", {"url": url, "headers": _headers(headers)}, timeout=30.0), url)


async def aopen_mock(url, headers=None):
    if not _applies(url):
        return None
    return _opened(await fa_bridge.acall("ws.open", {"url": url, "headers": _headers(headers)}, timeout=30.0), url)


def _msg(r):
    if r.get("text") is not None:
        return r["text"]
    if r.get("binary"):
        return base64.b64decode(r.get("b64") or "")
    return None


class _Sock(object):
    def __init__(self, sid):
        self.id = sid
        self.closed = None

    def _send_args(self, data):
        if isinstance(data, (bytes, bytearray, memoryview)):
            return {"id": self.id, "binary": True, "b64": base64.b64encode(bytes(data)).decode("ascii")}
        return {"id": self.id, "text": str(data)}

    def _check(self, r):
        if r.get("closed"):
            self.closed = r["closed"]
            raise Closed(self.closed.get("code"), self.closed.get("reason"))

    def send(self, data):
        self._check(fa_bridge.call("ws.send", self._send_args(data), timeout=30.0) or {})

    async def asend(self, data):
        self._check(await fa_bridge.acall("ws.send", self._send_args(data), timeout=30.0) or {})

    def recv(self, timeout=None):
        end = None if timeout is None else time.time() + timeout
        while True:
            if self.closed:
                raise Closed(self.closed.get("code"), self.closed.get("reason"))
            r = fa_bridge.call("ws.recv", {"id": self.id, "wait_ms": 250}, timeout=30.0) or {}
            self._check(r)
            m = _msg(r)
            if m is not None:
                return m
            if end is not None and time.time() >= end:
                raise TimeoutError("等不到 WebSocket 訊息")

    async def arecv(self, timeout=None):
        import asyncio
        end = None if timeout is None else time.time() + timeout
        while True:
            if self.closed:
                raise Closed(self.closed.get("code"), self.closed.get("reason"))
            r = await fa_bridge.acall("ws.recv", {"id": self.id, "wait_ms": 250}, timeout=30.0) or {}
            self._check(r)
            m = _msg(r)
            if m is not None:
                return m
            if end is not None and time.time() >= end:
                raise TimeoutError("等不到 WebSocket 訊息")
            await asyncio.sleep(0)

    def close(self, code=1000, reason=""):
        if self.closed is None:
            try:
                fa_bridge.call("ws.close", {"id": self.id, "code": code, "reason": reason}, timeout=15.0)
            except Exception:
                pass
            self.closed = {"code": code, "reason": reason}

    async def aclose(self, code=1000, reason=""):
        if self.closed is None:
            try:
                await fa_bridge.acall("ws.close", {"id": self.id, "code": code, "reason": reason}, timeout=15.0)
            except Exception:
                pass
            self.closed = {"code": code, "reason": reason}


# ---------------------------------------------------------------- websocket-client
def patch_websocket_client():
    import websocket
    if getattr(websocket.create_connection, "_fa_patched", False):
        return
    exc_closed = getattr(websocket, "WebSocketConnectionClosedException", Exception)
    exc_timeout = getattr(websocket, "WebSocketTimeoutException", TimeoutError)

    class _WSC(object):
        def __init__(self, sock):
            self._s = sock
            self.timeout = None
            self.status = 101
            self.headers = {}

        @property
        def connected(self):
            return self._s.closed is None

        def send(self, payload, opcode=1):
            self._s.send(payload.encode("utf-8") if opcode == 2 and isinstance(payload, str) else payload)
            return len(payload)

        def send_text(self, s):
            return self.send(s)

        def send_binary(self, b):
            self._s.send(bytes(b))
            return len(b)

        def recv(self):
            try:
                return self._s.recv(self.timeout)
            except Closed:
                raise exc_closed("Connection is already closed.")
            except TimeoutError:
                raise exc_timeout("timed out")

        def recv_data(self, control_frame=False):
            m = self.recv()
            return (2, m) if isinstance(m, bytes) else (1, m.encode("utf-8"))

        def settimeout(self, t):
            self.timeout = t

        def gettimeout(self):
            return self.timeout

        def getstatus(self):
            return 101

        def getheaders(self):
            return {}

        def close(self, status=1000, reason=b"", timeout=3):
            self._s.close(status, reason.decode("utf-8", "replace") if isinstance(reason, bytes) else str(reason))

        shutdown = close

        def __enter__(self):
            return self

        def __exit__(self, *a):
            self.close()

        def __iter__(self):
            while self.connected:
                try:
                    yield self.recv()
                except exc_closed:
                    return

    orig_create = websocket.create_connection

    def create_connection(url, timeout=None, **options):
        s = open_mock(url, options.get("header"))
        if s is None:
            return orig_create(url, timeout=timeout, **options)
        c = _WSC(s)
        c.timeout = timeout
        return c
    create_connection._fa_patched = True
    websocket.create_connection = create_connection

    App = getattr(websocket, "WebSocketApp", None)
    if App is None:
        return
    orig_run, orig_send, orig_close = App.run_forever, App.send, App.close

    def run_forever(self, *a, **kw):
        s = None
        try:
            s = open_mock(self.url, getattr(self, "header", None))
        except Exception as e:
            self._fa_call("on_error", e)
            return False
        if s is None:
            return orig_run(self, *a, **kw)
        self._fa_sock = s
        self.keep_running = True
        self._fa_call("on_open")
        try:
            while self.keep_running and s.closed is None:
                try:
                    m = s.recv(0.25)
                except TimeoutError:
                    continue
                except Closed:
                    break
                self._fa_call("on_message", m)
        except Exception as e:
            self._fa_call("on_error", e)
        finally:
            c = s.closed or {"code": 1005, "reason": ""}
            s.close()
            self.keep_running = False
            self._fa_call("on_close", c.get("code"), c.get("reason"))
        return False

    def _fa_call(self, name, *args):
        cb = getattr(self, name, None)
        if cb:
            cb(self, *args)

    def send(self, data, opcode=1):
        s = getattr(self, "_fa_sock", None)
        if s is None:
            return orig_send(self, data, opcode)
        s.send(data.encode("utf-8") if opcode == 2 and isinstance(data, str) else data)

    def close(self, **kw):
        s = getattr(self, "_fa_sock", None)
        if s is None:
            return orig_close(self, **kw)
        self.keep_running = False
        s.close(kw.get("status", 1000), "")
    App.run_forever, App.send, App.close, App._fa_call = run_forever, send, close, _fa_call


# ---------------------------------------------------------------- websockets
def _closed_exc():
    try:
        from websockets.exceptions import ConnectionClosedOK
        return ConnectionClosedOK
    except Exception:
        return Closed


def _mk_closed(c):
    cls = _closed_exc()
    try:
        return cls(None, None)
    except Exception:
        return cls(c.code, c.reason)


class _WSS(object):
    """websockets.sync.client 的連線。"""

    def __init__(self, sock):
        self._s = sock

    def send(self, message, text=None):
        try:
            self._s.send(message)
        except Closed as c:
            raise _mk_closed(c)

    def recv(self, timeout=None, decode=None):
        try:
            m = self._s.recv(timeout)
        except Closed as c:
            raise _mk_closed(c)
        if decode is True and isinstance(m, bytes):
            return m.decode("utf-8")
        if decode is False and isinstance(m, str):
            return m.encode("utf-8")
        return m

    def close(self, code=1000, reason=""):
        self._s.close(code, reason)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def __iter__(self):
        while True:
            try:
                yield self.recv()
            except _closed_exc():
                return

    @property
    def open(self):
        return self._s.closed is None

    @property
    def closed(self):
        return self._s.closed is not None


class _AWSS(object):
    """websockets 非同步連線。"""

    def __init__(self, sock):
        self._s = sock

    async def send(self, message, text=None):
        try:
            await self._s.asend(message)
        except Closed as c:
            raise _mk_closed(c)

    async def recv(self, decode=None):
        try:
            m = await self._s.arecv()
        except Closed as c:
            raise _mk_closed(c)
        if decode is True and isinstance(m, bytes):
            return m.decode("utf-8")
        if decode is False and isinstance(m, str):
            return m.encode("utf-8")
        return m

    async def close(self, code=1000, reason=""):
        await self._s.aclose(code, reason)

    async def wait_closed(self):
        return None

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return await self.recv()
        except _closed_exc():
            raise StopAsyncIteration

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        await self.close()

    @property
    def open(self):
        return self._s.closed is None

    @property
    def closed(self):
        return self._s.closed is not None


class _AConnect(object):
    def __init__(self, orig, uri, a, kw):
        self._orig, self._uri, self._a, self._kw = orig, uri, a, kw
        self._real = None

    async def _open(self):
        s = await aopen_mock(self._uri, self._kw.get("additional_headers") or self._kw.get("extra_headers"))
        if s is not None:
            return _AWSS(s)
        self._real = self._orig(self._uri, *self._a, **self._kw)
        return await self._real

    def __await__(self):
        return self._open().__await__()

    async def __aenter__(self):
        self._conn = await self._open()
        if self._real is not None:
            return self._conn
        return self._conn

    async def __aexit__(self, *exc):
        if self._real is not None and hasattr(self._real, "__aexit__"):
            return await self._real.__aexit__(*exc)
        await self._conn.close()


def patch_websockets():
    import websockets
    if getattr(websockets, "_fa_ws_patched", False):
        return
    websockets._fa_ws_patched = True
    try:
        import websockets.sync.client as sc
        orig_sc = sc.connect

        def sync_connect(uri, *a, **kw):
            s = open_mock(uri, kw.get("additional_headers"))
            return _WSS(s) if s is not None else orig_sc(uri, *a, **kw)
        sc.connect = sync_connect
    except Exception:
        pass
    for modname in ("websockets.asyncio.client", "websockets.client", "websockets.legacy.client"):
        try:
            mod = __import__(modname, fromlist=["connect"])
            orig = getattr(mod, "connect", None)
            if orig is None or getattr(orig, "_fa_patched", False):
                continue

            def make(o):
                def connect(uri, *a, **kw):
                    return _AConnect(o, uri, a, kw)
                connect._fa_patched = True
                return connect
            mod.connect = make(orig)
        except Exception:
            continue
    try:
        orig_top = websockets.connect
        if not getattr(orig_top, "_fa_patched", False):
            def top(uri, *a, **kw):
                return _AConnect(orig_top, uri, a, kw)
            top._fa_patched = True
            websockets.connect = top
    except Exception:
        pass
