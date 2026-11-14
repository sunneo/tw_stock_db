# -*- coding: utf-8 -*-
# 文件狀態列：更新字數（主畫面在內容改動、新增章節後呼叫 refresh）。


def refresh(ctx):
    ctx.set("count", text="%d 字" % len(ctx.get("body")))


def build(win, spec, slots):
    return {"refresh": refresh}
