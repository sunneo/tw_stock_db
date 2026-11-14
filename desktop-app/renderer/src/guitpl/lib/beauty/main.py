# -*- coding: utf-8 -*-
# 美顏拍貼（簡化版）：用色塊與符號示意濾鏡、強度與貼紙，不做真的影像處理。
# 畫布一幀最多 200 道繪圖指令，這裡每次約 15 道。

FILTERS = {"原圖": ("#f2c7a5", "#555555"), "柔焦": ("#f7dcc9", "#e9d5e0"), "暖色": ("#f7b267", "#7a3e12"),
           "冷色": ("#9bc4e2", "#1d3b57"), "黑白": ("#8a8a8a", "#222222")}
FILTER_ORDER = ["原圖", "柔焦", "暖色", "冷色", "黑白"]
STICKERS = [("星星", "★", "#ffd700", (30, 40)), ("愛心", "♥", "#ff3b6b", (236, 40)),
            ("皇冠", "♛", "#ffcc00", (140, 22)), ("貓", "貓", "#333333", (236, 250))]


def _strength(ctx):
    return ctx.state.get("strength", 50)


def _redraw(ctx):
    name = ctx.get("filter_list") or "原圖"
    skin, bgc = FILTERS.get(name, FILTERS["原圖"])
    ops = [
        ["clear", bgc],
        ["circle", 150, 150, 90, skin],
        ["circle", 120, 130, 9, "#222222"],
        ["circle", 180, 130, 9, "#222222"],
        ["line", 125, 190, 175, 190, "#b03a48"],
        ["text", 10, 290, "濾鏡 %s　美顏 %d" % (name, _strength(ctx)), "#ffffff"],
    ]
    chosen = ctx.get("sticker_list") or []
    for label, sym, color, pos in STICKERS:
        if label in chosen:
            ops.append(["text", pos[0], pos[1], sym, color])
    ctx.w.draw(ctx.id("view"), ops)


def build(win, spec, slots):
    def set_strength(ctx):
        text = ctx.get("strength_in")
        try:
            v = int(str(text).strip())
        except ValueError:
            v = -1
        if not 0 <= v <= 100:
            ctx.set("sb_text", text="美顏強度要是 0 到 100 的整數")
            return
        ctx.state["strength"] = v
        ctx.set("strength_bar", value=v)
        ctx.set("sb_text", text="美顏強度設為 %d" % v)
        _redraw(ctx)

    def next_filter(ctx):
        cur = ctx.get("filter_list") or "原圖"
        nxt = FILTER_ORDER[(FILTER_ORDER.index(cur) + 1) % len(FILTER_ORDER)] if cur in FILTER_ORDER else "原圖"
        ctx.set("filter_list", selected=nxt)
        _redraw(ctx)

    def snap(ctx):
        _redraw(ctx)
        ctx.set("sb_text", text="已拍照（簡化版，未儲存）")

    def reset(ctx):
        ctx.set("filter_list", selected="原圖")
        ctx.set("sticker_list", selected=[])
        ctx.set("strength_in", value="50")
        ctx.set("strength_bar", value=50)
        ctx.state["strength"] = 50
        ctx.set("sb_text", text="已重設")
        _redraw(ctx)

    return {"handlers": {
        "input:strength_in": set_strength,
        "select:filter_list": _redraw,
        "select:sticker_list": _redraw,
        "click:apply_btn": _redraw,
        "shortcut:redraw": _redraw,
        "shortcut:next_filter": next_filter,
        "click:snap_btn": snap,
        "shortcut:snap": snap,
        "click:tb_reset": reset,
    }}
