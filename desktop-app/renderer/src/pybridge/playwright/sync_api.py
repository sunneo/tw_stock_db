# -*- coding: utf-8 -*-
"""
playwright.sync_api 的「轉接版」：Floating AI Assistant 在執行技能包的 Python 腳本時提供。

腳本照原本的寫法用 Playwright（connect_over_cdp／launch、new_page、goto、inner_text、locator、screenshot…），
但這裡的每個動作實際上都是呼叫 AI 助理自己的瀏覽器控制工具（Chrome 擴充功能開的「AI Controlled」分頁），
不需要 Chrome 遠端除錯埠、也不用安裝 Playwright。使用者的登入狀態就是他自己 Chrome 的登入狀態。

支援的子集合：sync_playwright().start()/stop()/with、chromium|firefox|webkit .connect_over_cdp()/.launch()、
browser.contexts/new_context/new_page/close、context.pages/new_page/close、
page.goto/url/title/content/inner_text/text_content/evaluate/screenshot/wait_for_timeout/wait_for_load_state/
wait_for_selector/locator/close、locator.first/count/inner_text/text_content/screenshot/click。
其他功能會丟出說明清楚的 NotImplementedError——請改用 fa_bridge.tool(...) 或 fa_bridge.domain(...)。
"""
import sys
import time

import fa_bridge

_NOTED = [False]


def _note():
    if not _NOTED[0]:
        _NOTED[0] = True
        sys.stderr.write("[fa-bridge] playwright is routed to the AI assistant browser tools (no Chrome debug port needed)\n")


def _nyi(what):
    raise NotImplementedError(
        "%s 在 AI 助理的 playwright 轉接版沒有支援。可以改用 fa_bridge.tool('browser_…', …) 呼叫助理的瀏覽器工具，"
        "或 fa_bridge.domain('browser_control', '要做的事') 委派給瀏覽器控制領域。" % what)


class Locator(object):
    def __init__(self, page, selector, index=0):
        self._page = page
        self._sel = selector
        self._idx = index

    @property
    def first(self):
        return Locator(self._page, self._sel, 0)

    @property
    def last(self):
        return Locator(self._page, self._sel, -1)

    def nth(self, i):
        return Locator(self._page, self._sel, i)

    def locator(self, sub):
        return Locator(self._page, self._sel + " " + sub, 0)

    def count(self):
        return int(fa_bridge.call("pw.count", {"tab": self._page._tab, "selector": self._sel}) or 0)

    def inner_text(self, **kw):
        return fa_bridge.call("pw.text", {"tab": self._page._tab, "selector": self._sel, "index": self._idx}) or ""

    text_content = inner_text

    def screenshot(self, path=None, **kw):
        return self._page._shot(path, False, self._sel, self._idx)

    def click(self, **kw):
        fa_bridge.call("pw.click", {"tab": self._page._tab, "selector": self._sel, "index": self._idx})

    def is_visible(self, **kw):
        return self.count() > 0

    def __getattr__(self, name):
        _nyi("locator." + name)


class Page(object):
    def __init__(self, tab=None):
        self._tab = tab
        self._url = ""
        self.closed = False

    @property
    def url(self):
        try:
            self._url = fa_bridge.call("pw.url", {"tab": self._tab}) or self._url
        except fa_bridge.BridgeError:
            pass
        return self._url

    def goto(self, url, wait_until=None, timeout=None, **kw):
        r = fa_bridge.call("pw.goto", {"tab": self._tab, "url": url})
        if isinstance(r, dict) and r.get("tab"):
            self._tab = r["tab"]
        self._url = url
        return None

    def title(self):
        return fa_bridge.call("pw.eval", {"tab": self._tab, "js": "document.title"}) or ""

    def content(self):
        return fa_bridge.call("pw.eval", {"tab": self._tab, "js": "document.documentElement.outerHTML"}) or ""

    def inner_text(self, selector="body", **kw):
        return fa_bridge.call("pw.text", {"tab": self._tab, "selector": selector}) or ""

    text_content = inner_text

    def evaluate(self, expression, arg=None):
        js = expression
        e = expression.lstrip()
        is_fn = e.startswith(("function", "async function")) or ("=>" in e and e.startswith(("(", "async", "_", "x", "e", "el")) and not e.endswith(")"))
        if arg is not None:
            import json
            js = "(" + expression + ")(" + json.dumps(arg) + ")"
        elif is_fn:
            js = "(" + expression + ")()"
        return fa_bridge.call("pw.eval", {"tab": self._tab, "js": js})

    def locator(self, selector, **kw):
        return Locator(self, selector)

    def query_selector(self, selector):
        loc = Locator(self, selector)
        return loc if loc.count() > 0 else None

    def wait_for_timeout(self, ms):
        fa_bridge.sleep(float(ms) / 1000.0)

    def wait_for_load_state(self, *a, **kw):
        fa_bridge.sleep(0.3)

    def wait_for_selector(self, selector, timeout=30000, **kw):
        t0 = time.time()
        loc = Locator(self, selector)
        while time.time() - t0 < timeout / 1000.0:
            if loc.count() > 0:
                return loc
            fa_bridge.sleep(0.4)
        raise TimeoutError("等不到元素：" + selector)

    def set_viewport_size(self, *a, **kw):
        pass

    def bring_to_front(self):
        pass

    def screenshot(self, path=None, full_page=False, **kw):
        return self._shot(path, full_page, None, 0)

    def _shot(self, path, full_page, selector, index):
        if path:
            import os
            path = os.path.abspath(path)
            d = os.path.dirname(path)
            if d and not os.path.isdir(d):
                os.makedirs(d)
        r = fa_bridge.call("pw.screenshot", {"tab": self._tab, "full_page": bool(full_page), "selector": selector, "index": index})
        if not (isinstance(r, dict) and r.get("base64")):
            raise RuntimeError("截圖失敗")
        import base64
        data = base64.b64decode(r["base64"])
        if path:
            with open(path, "wb") as f:
                f.write(data)
            return None
        return data

    def close(self, **kw):
        if not self.closed:
            self.closed = True
            try:
                fa_bridge.call("pw.close", {"tab": self._tab})
            except fa_bridge.BridgeError:
                pass

    def __getattr__(self, name):
        _nyi("page." + name)


class Context(object):
    def __init__(self, browser):
        self._browser = browser
        self.pages = []

    def new_page(self):
        p = Page(None)
        r = fa_bridge.call("pw.new_page", {})
        p._tab = r.get("tab") if isinstance(r, dict) else None
        self.pages.append(p)
        return p

    def close(self):
        for p in list(self.pages):
            p.close()

    def __getattr__(self, name):
        _nyi("context." + name)


class Browser(object):
    def __init__(self):
        self.contexts = [Context(self)]

    def new_context(self, **kw):
        c = Context(self)
        self.contexts.append(c)
        return c

    def new_page(self, **kw):
        return self.contexts[0].new_page()

    def close(self):
        for c in self.contexts:
            c.close()

    def is_connected(self):
        return True

    def __getattr__(self, name):
        _nyi("browser." + name)


class BrowserType(object):
    def connect_over_cdp(self, endpoint_url=None, **kw):
        _note()
        fa_bridge.call("pw.status", {})
        return Browser()

    connect = connect_over_cdp

    def launch(self, **kw):
        _note()
        fa_bridge.call("pw.status", {})
        return Browser()

    def launch_persistent_context(self, user_data_dir=None, **kw):
        return self.launch().contexts[0]


class Playwright(object):
    def __init__(self):
        self.chromium = BrowserType()
        self.firefox = BrowserType()
        self.webkit = BrowserType()

    def stop(self):
        pass


class _Manager(object):
    def start(self):
        return Playwright()

    def __enter__(self):
        return Playwright()

    def __exit__(self, *a):
        return False


def sync_playwright():
    return _Manager()


# 常見的型別名稱，讓 `from playwright.sync_api import Page, Browser, TimeoutError` 不會出錯
TimeoutError = TimeoutError
Error = RuntimeError
