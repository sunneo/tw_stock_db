# -*- coding: utf-8 -*-
# 元件工具列：新增、刪除、匯出。元件資料放在 ctx.state["comps"]；畫面重畫由主元件包住這些處理函式負責。
import html
import re

TYPES = ["標題", "段落", "按鈕"]
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def to_html(title, comps):
    parts = []
    for c in comps:
        color = c.get("color") or ""
        style = ' style="color:%s"' % color if HEX.match(color) else ""
        text = html.escape(c["text"], quote=True)
        if c["type"] == "標題":
            parts.append("<h1%s>%s</h1>" % (style, text))
        elif c["type"] == "段落":
            parts.append("<p%s>%s</p>" % (style, text))
        else:
            parts.append("<button%s>%s</button>" % (style, text))
    return ('<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n<title>%s</title>\n</head>\n'
            '<body>\n%s\n</body>\n</html>\n' % (html.escape(title, quote=True), "\n".join(parts)))


def build(win, spec, slots):
    def comps_of(ctx):
        return ctx.state.setdefault("comps", [])

    def add(ctx):
        cs = comps_of(ctx)
        n = len(cs) + 1
        kind = TYPES[(n - 1) % len(TYPES)]
        cs.append({"type": kind, "text": "%s %d" % (kind, n), "color": ""})
        ctx.state["sel"] = len(cs) - 1
        ctx.set("status", text="已新增「%s」，共 %d 個元件" % (kind, len(cs)))

    def remove(ctx):
        cs = comps_of(ctx)
        i = ctx.state.get("sel")
        if isinstance(i, int) and 0 <= i < len(cs):
            del cs[i]
            ctx.state["sel"] = None
            ctx.set("status", text="已刪除，剩 %d 個元件" % len(cs))
        else:
            ctx.set("status", text="請先在清單選一個元件")

    def export(ctx):
        ctx.set("code", value=to_html(spec["params"]["page_title"], comps_of(ctx)))
        ctx.goto("code")
        ctx.set("status", text="已匯出 %d 個元件的 HTML" % len(comps_of(ctx)))

    return {"handlers": {"click:add": add, "click:remove": remove, "click:export": export,
                         "shortcut:add": add, "shortcut:remove": remove}}
