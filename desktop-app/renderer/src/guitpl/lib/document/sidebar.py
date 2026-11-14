# -*- coding: utf-8 -*-
# 大綱側欄：從內容抓出 # 開頭的標題（# 是一級，## 二級，最多六級），縮排表示層級；沒有標題就切到「沒有大綱」場景。


def headings(text):
    out = []
    for ln in text.split("\n"):
        s = ln.lstrip()
        if not s.startswith("#"):
            continue
        level = len(s) - len(s.lstrip("#"))
        title = s[level:].strip()
        if 1 <= level <= 6 and title:
            out.append("  " * (level - 1) + title)
    return out


def refresh(ctx):
    items = headings(ctx.get("body"))
    ctx.set("outline", value="\n".join(items))
    ctx.goto("has_outline" if items else "no_outline")


def build(win, spec, slots):
    return {"refresh": refresh}
