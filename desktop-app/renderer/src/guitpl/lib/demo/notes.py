# -*- coding: utf-8 -*-
import time


def build(win, spec, slots):
    # Ctrl+S 與工具列的存檔是同一個動作：直接用子元件的處理函式
    save = slots["toolbar"]["handlers"]["click:save"]

    def stamp(ctx):
        ctx.state["opened"] = time.time()

    return {"handlers": {"shortcut:save": save}, "stamp": stamp}
