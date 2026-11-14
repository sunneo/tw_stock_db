# -*- coding: utf-8 -*-
# 播放控制：只改狀態（播放中、速度、起始拍）與場景；播放頭的推進與卷簾重畫由主元件的 frame 處理負責。


def build(win, spec, slots):
    def play(ctx):
        if ctx.state.get("playing"):
            return
        try:
            bpm = float(ctx.get("bpm"))
        except (TypeError, ValueError):
            bpm = 120.0
        if not 20 <= bpm <= 300:
            bpm = 120.0
        ctx.state.update(playing=True, beat=0.0, bpm=bpm, next=0)
        ctx.goto("playing")
        ctx.set("status", text="播放中（%g BPM）" % bpm)

    def stop(ctx):
        ctx.state.update(playing=False, beat=0.0, dirty=True)
        ctx.goto("stopped")
        ctx.set("status", text="已停止")

    return {"handlers": {"click:play": play, "click:stop": stop, "shortcut:play": play, "shortcut:stop": stop}}
