# -*- coding: utf-8 -*-
# 鋼琴卷簾：每個 frame 事件推進播放頭、觸發音符聲音，並重畫卷簾。播放與停止在 transport 子元件。

PITCH_HI = 71
PITCH_LO = 60
BEATS = 8
FPS = 20
KEY_W = 40
ROW_H = 14
BEAT_W = 35
BLACK = (1, 3, 6, 8, 10)
# (音高, 起拍, 長度)，依起拍排序
NOTES = [(60, 0, 1), (64, 1, 1), (67, 2, 1), (72, 3, 1), (71, 4, 0.5), (69, 4.5, 0.5), (67, 5, 2)]


def freq(pitch):
    return 440.0 * 2 ** ((pitch - 69) / 12.0)


def draw(ctx, colors, beat=None):
    ops = [["clear", colors["bg"]]]
    for i, p in enumerate(range(PITCH_HI, PITCH_LO - 1, -1)):
        y = i * ROW_H
        ops.append(["rect", 0, y, KEY_W, ROW_H, colors["fg"] if p % 12 in BLACK else colors["bg"]])
        ops.append(["line", KEY_W, y + ROW_H, KEY_W + BEATS * BEAT_W, y + ROW_H, colors["muted"]])
    for pitch, start, length in NOTES:
        y = (PITCH_HI - pitch) * ROW_H
        ops.append(["rect", int(KEY_W + start * BEAT_W), y + 1, int(length * BEAT_W) - 2, ROW_H - 2, colors["accent"]])
    if beat is not None:
        x = int(KEY_W + beat * BEAT_W)
        ops.append(["line", x, 0, x, (PITCH_HI - PITCH_LO + 1) * ROW_H, colors["danger"]])
    ctx.w.draw(ctx.id("roll"), ops)


def make_frame(colors):
    def on_frame(ctx):
        st = ctx.state
        if st.get("playing"):
            st["beat"] = st.get("beat", 0.0) + st["bpm"] / 60.0 / FPS
            while st["next"] < len(NOTES) and NOTES[st["next"]][1] <= st["beat"]:
                pitch, _start, length = NOTES[st["next"]]
                ctx.tone(freq(pitch), int(length * 60000.0 / st["bpm"]))
                st["next"] += 1
            if st["beat"] >= BEATS:
                st["playing"] = False
                st["dirty"] = True
                ctx.goto("stopped")
                ctx.set("status", text="播放完畢")
            else:
                draw(ctx, colors, st["beat"])
        elif st.get("dirty", True):
            st["dirty"] = False
            draw(ctx, colors)
    return on_frame


def build(win, spec, slots):
    pal = (spec.get("style") or {}).get("palette") or {}
    colors = {
        "bg": pal.get("bg", "#ffffff"), "fg": pal.get("fg", "#222222"), "accent": pal.get("accent", "#2563eb"),
        "danger": pal.get("danger", "#dc2626"), "muted": pal.get("muted", "#9ca3af"),
    }
    return {"handlers": {"frame:roll": make_frame(colors)}}
