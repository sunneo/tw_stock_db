# -*- coding: utf-8 -*-
# 文件工具列的行為：新增章節在內容尾端加一行「# 新章節」（大綱由主畫面更新）；存檔次數記在 ctx.state。


def add_heading(ctx):
    body = ctx.get("body").rstrip("\n")
    body = (body + "\n\n" if body else "") + "# 新章節"
    ctx.set("body", value=body)
    ctx.set("msg", text="已加入新章節")


def save(ctx):
    ctx.state["saved"] = ctx.state.get("saved", 0) + 1
    ctx.set("msg", text="已存 %d 次" % ctx.state["saved"])


def build(win, spec, slots):
    return {"handlers": {"click:add_heading": add_heading, "click:save": save}}
