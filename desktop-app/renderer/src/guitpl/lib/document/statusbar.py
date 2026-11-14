# -*- coding: utf-8 -*-
# 文件狀態列：字數（主畫面在內容改動後呼叫 refresh）與游標位置（頁面回報游標，這裡換成第幾行第幾欄）。


def refresh(ctx):
    ctx.set("count", text="%d 字" % len(ctx.get("body")))
    show_pos(ctx)


def show_pos(ctx):
    a, _b = ctx.caret("body")
    text = ctx.get("body")
    line = text.count("\n", 0, a) + 1
    col = a - (text.rfind("\n", 0, a) + 1) + 1
    ctx.set("pos", text="第 %d 行，第 %d 欄" % (line, col))


def build(win, spec, slots):
    return {"refresh": refresh, "handlers": {"caret:body": show_pos}}
