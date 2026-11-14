# -*- coding: utf-8 -*-
# 播放控制：播放、暫停、停止與空白鍵切換。只改播放狀態與場景；畫面與進度由主元件的 frame 處理負責。


def build(win, spec, slots):
    def play(ctx):
        ctx.state["playing"] = True
        ctx.goto("playing")
        ctx.set("status", text="播放中")

    def pause(ctx):
        ctx.state["playing"] = False
        ctx.goto("idle")
        ctx.set("status", text="已暫停")

    def stop(ctx):
        ctx.state.update(playing=False, pos=0.0, dirty=True)
        ctx.goto("idle")
        ctx.set("status", text="已停止")

    def toggle(ctx):
        if ctx.state.get("playing"):
            pause(ctx)
        else:
            play(ctx)

    return {"handlers": {"click:play": play, "click:pause": pause, "click:stop": stop, "shortcut:toggle": toggle}}
