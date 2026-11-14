# -*- coding: utf-8 -*-
# 大綱側欄：從內容抓出 # 開頭的標題（# 是一級，## 二級，最多六級），用縮排表示層級；點一下大綱的項目，編輯區的游標就跳到那一行（並選起來）。
# 沒有標題就切到「沒有大綱」場景。內容一改動主畫面就呼叫 refresh；大綱沒變就不重畫。

NBSP = " "  # 選單項目前面的空白會被網頁吃掉，縮排要用不斷行空白


def headings(text):
    """[(level, title, offset of the line, line length)] for every heading line (a ``` code fence hides its lines)."""
    out = []
    pos = 0
    fenced = False
    for ln in text.split("\n"):
        s = ln.strip()
        if s.startswith("```"):
            fenced = not fenced
        elif not fenced and s.startswith("#"):
            level = len(s) - len(s.lstrip("#"))
            title = s[level:].strip()
            if 1 <= level <= 6 and title and (len(s) == level or s[level] == " "):
                out.append((level, title, pos, len(ln)))
        pos += len(ln) + 1
    return out


def labels(items):
    return [NBSP * 2 * (lv - 1) + title for lv, title, _off, _n in items]


def refresh(ctx):
    items = headings(ctx.get("body"))
    ctx.state["outline"] = items
    names = labels(items)
    if names != ctx.state.get("outline_names"):
        ctx.state["outline_names"] = names
        ctx.set("outline", items=names)
    ctx.goto("has_outline" if items else "no_outline")


def jump(ctx):
    items = ctx.state.get("outline") or []
    names = labels(items)
    picked = (ctx.event or {}).get("value")
    if picked in names:
        _lv, _title, off, n = items[names.index(picked)]
        ctx.set("body", caret=off, caret_to=off + n)


def build(win, spec, slots):
    return {"refresh": refresh, "handlers": {"select:outline": jump}}
