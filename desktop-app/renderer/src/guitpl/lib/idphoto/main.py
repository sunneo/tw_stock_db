# -*- coding: utf-8 -*-
# 證件照（簡化版）：只畫尺寸與背景色的示意圖與裁切線，不做人臉偵測與真的裁切。
# 畫布一幀最多 200 道繪圖指令，這裡每次約 15 道。

SIZE_ORDER = ["一吋 2.5×3.5 公分", "二吋 3.5×5.3 公分", "護照 3.3×4.8 公分"]
SIZE_CM = {"一吋 2.5×3.5 公分": (2.5, 3.5), "二吋 3.5×5.3 公分": (3.5, 5.3), "護照 3.3×4.8 公分": (3.3, 4.8)}
BG = {"白": "#ffffff", "淺藍": "#9ec9ff", "淺灰": "#d9d9d9", "紅": "#e0343a"}
CW, CH = 240, 300  # 要和 jsonl 裡 view 畫布的寬高一致


def _redraw(ctx):
    size = ctx.get("size_list") or SIZE_ORDER[0]
    bg = ctx.get("bg_list") or "白"
    guide = ctx.state.get("guide", True)
    w_cm, h_cm = SIZE_CM.get(size, SIZE_CM[SIZE_ORDER[0]])
    # 等比例縮放：寬不超過 200、高不超過 280
    scale = min(200.0 / w_cm, 280.0 / h_cm)
    bw, bh = w_cm * scale, h_cm * scale
    x0, y0 = (CW - bw) / 2.0, (CH - bh) / 2.0
    cx = CW / 2.0
    x1, y1 = x0 + bw, y0 + bh
    ops = [
        ["clear", "#444444"],
        ["rect", int(x0), int(y0), int(bw), int(bh), BG.get(bg, "#ffffff")],
        ["circle", int(cx), int(y0 + bh * 0.35), int(bh * 0.14), "#e8b48a"],
        ["rect", int(cx - bw * 0.3), int(y0 + bh * 0.52), int(bw * 0.6), int(bh * 0.4), "#3b4a6b"],
        ["text", 8, 16, size, "#ffffff"],
    ]
    if guide:
        eye = int(y0 + bh * 0.3)
        ops += [
            ["line", int(x0), eye, int(x1), eye, "#00c853"],
            ["line", int(cx), int(y0), int(cx), int(y1), "#00c853"],
            ["line", int(x0), int(y0), int(x1), int(y0), "#ff3b30"],
            ["line", int(x0), int(y1), int(x1), int(y1), "#ff3b30"],
            ["line", int(x0), int(y0), int(x0), int(y1), "#ff3b30"],
            ["line", int(x1), int(y0), int(x1), int(y1), "#ff3b30"],
        ]
    ctx.w.draw(ctx.id("view"), ops)
    ctx.set("info", text="尺寸 %s、背景%s%s" % (size, bg, "（顯示裁切線）" if guide else ""))


def build(win, spec, slots):
    def reset(ctx):
        ctx.set("size_list", selected=SIZE_ORDER[0])
        ctx.set("bg_list", selected="白")
        ctx.state["guide"] = True
        _redraw(ctx)

    def toggle_guide(ctx):
        ctx.state["guide"] = not ctx.state.get("guide", True)
        _redraw(ctx)

    def finish(ctx):
        size = ctx.get("size_list") or SIZE_ORDER[0]
        ctx.set("done_txt", text="已輸出 %s（簡化版：只示意，未存檔）" % size)
        _redraw(ctx)

    return {"handlers": {
        "select:size_list": _redraw,
        "select:bg_list": _redraw,
        "click:preview_btn": _redraw,
        "shortcut:redraw": _redraw,
        "click:tb_guide": toggle_guide,
        "click:tb_reset": reset,
        "click:finish_btn": finish,
        "shortcut:finish": finish,
    }}
