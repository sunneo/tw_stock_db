# -*- coding: utf-8 -*-
# 工具列：清除訊息只動主畫面的訊息列與狀態列（名稱由主畫面提供）。


def build(win, spec, slots):
    def clear(ctx):
        ctx.set("msg", text="")
        ctx.set("sb_text", text="")

    return {"handlers": {"click:tb_clear": clear}}
