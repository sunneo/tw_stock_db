# -*- coding: utf-8 -*-
# 多媒體播放與編碼（簡化版）：不真的解碼，用畫布畫出模擬的畫面，進度與時間依播放頭計算；
# 編碼只估算輸出大小。播放、暫停、停止與切換在 transport 子元件與這裡的處理函式。
# 畫布每秒 10 個 frame 事件，每個 frame 前進 0.1 秒。

TRACKS = [("片段 A（30 秒）", 30), ("片段 B（45 秒）", 45), ("片段 C（20 秒）", 20)]
BAR_COLORS = ["#2563eb", "#16a34a", "#dc2626"]
FORMATS = ("MP4", "WebM", "MP3")
STEP = 0.1


def mmss(sec):
    sec = int(sec)
    return "%d:%02d" % (sec // 60, sec % 60)


def draw_screen(ctx, track, pos):
    name, total = TRACKS[track]
    ops = [["clear", "#111827"]]
    for i in range(8):
        h = 20 + (int(pos * 10) + i * 17) % 60
        ops.append(["rect", 10 + i * 28, 135 - h - 30, 20, h, BAR_COLORS[track]])
    ops.append(["text", 10, 10, name, "#ffffff"])
    ops.append(["text", 10, 28, mmss(pos) + " / " + mmss(total), "#d1d5db"])
    ctx.w.draw(ctx.id("screen"), ops)


def on_frame(ctx):
    st = ctx.state
    track = st.get("track", 0)
    total = TRACKS[track][1]
    if not st.get("playing") and not st.get("dirty", True):
        return
    if st.get("playing"):
        st["pos"] = st.get("pos", 0.0) + STEP
        if st["pos"] >= total:
            st.update(playing=False, pos=float(total))
            ctx.goto("idle")
            ctx.set("status", text="播放完畢")
    st["dirty"] = False
    pos = st.get("pos", 0.0)
    draw_screen(ctx, track, pos)
    ctx.set("progress", value=int(pos * 100 / total))
    ctx.set("time", text="%s / %s" % (mmss(pos), mmss(total)))


def select_track(ctx):
    ctx.set("playlist", selected=TRACKS[ctx.state.get("track", 0)][0])


def change(ctx, step):
    st = ctx.state
    st["track"] = (st.get("track", 0) + step) % len(TRACKS)
    st.update(pos=0.0, dirty=True)
    select_track(ctx)
    ctx.set("status", text="切換到 %s" % TRACKS[st["track"]][0])


def on_select(ctx):
    names = [name for name, _ in TRACKS]
    value = ctx.get("playlist")
    if value in names:
        ctx.state.update(track=names.index(value), pos=0.0, dirty=True)


def encode(ctx):
    name, total = TRACKS[ctx.state.get("track", 0)]
    try:
        kbps = int(ctx.get("bitrate"))
    except (TypeError, ValueError):
        kbps = 0
    if not 64 <= kbps <= 20000:
        ctx.set("status", text="位元率要在 64 到 20000 kbps 之間")
        return
    fmt = ctx.get("fmt")
    if fmt not in FORMATS:
        fmt = "MP4"
    size_kb = total * kbps / 8.0
    ctx.set("status", text="已輸出 %s（%s，約 %d KB，模擬）" % (fmt, name, size_kb))


def build(win, spec, slots):
    return {"handlers": {
        "frame:screen": on_frame,
        "click:prev": lambda ctx: change(ctx, -1),
        "click:next": lambda ctx: change(ctx, 1),
        "select:playlist": on_select,
        "click:encode": encode,
        "shortcut:encode": encode,
    }}
