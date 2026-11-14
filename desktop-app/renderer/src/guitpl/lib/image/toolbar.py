# -*- coding: utf-8 -*-
# 圖層工具列：復原最上面一層、清空全部圖層。圖層資料在 ctx.state["layers"]，畫面重畫由主元件負責。


def build(win, spec, slots):
    def undo(ctx):
        layers = ctx.state.setdefault("layers", [])
        if layers:
            name = layers.pop()
            ctx.set("status", text="已復原「%s」" % name)
        else:
            ctx.set("status", text="沒有可以復原的圖層")

    def clear(ctx):
        ctx.state["layers"] = []
        ctx.set("status", text="已清空圖層")

    return {"handlers": {"click:undo": undo, "click:clear": clear, "shortcut:undo": undo}}
