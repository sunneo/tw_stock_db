# -*- coding: utf-8 -*-
# 基本工具列的行為：存檔次數記在 ctx.state，狀態列用名稱 "status"（由使用這個工具列的範本提供）。


def build(win, spec, slots):
    def save(ctx):
        ctx.state["saved"] = ctx.state.get("saved", 0) + 1
        ctx.set("status", text="已存 %d 次" % ctx.state["saved"])

    def clear(ctx):
        ctx.set("editor", value="")
        ctx.set("status", text="已清除")

    return {"handlers": {"click:save": save, "click:clear": clear}}
