# -*- coding: utf-8 -*-
# 影像處理（簡化版）：畫布用 12x8 的小方格當作一張小圖，每個方格的顏色依序套用圖層的效果。
# 撤銷與清空由工具列子元件處理；這裡包住它們的處理函式並重畫。

W = 12
H = 8
CELL = 26


def clamp(v):
    return max(0, min(255, int(v)))


def gray(c):
    g = int(0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2])
    return (g, g, g)


EFFECTS = {
    "反相": lambda c: (255 - c[0], 255 - c[1], 255 - c[2]),
    "灰階": gray,
    "提亮": lambda c: (clamp(c[0] + 40), clamp(c[1] + 40), clamp(c[2] + 40)),
    "變暗": lambda c: (clamp(c[0] - 40), clamp(c[1] - 40), clamp(c[2] - 40)),
    "紅色通道": lambda c: (c[0], 0, 0),
}


def base(x, y):
    return (x * 255 // (W - 1), y * 255 // (H - 1), 128)


def pixel(x, y, layers):
    c = base(x, y)
    for name in layers:
        c = EFFECTS[name](c)
    return c


def hexcolor(c):
    return "#%02x%02x%02x" % c


def draw(ctx, colors):
    layers = ctx.state.get("layers", [])
    original = ctx.scene == "compare"
    ops = [["clear", colors["bg"]]]
    for y in range(H):
        for x in range(W):
            c = base(x, y) if original else pixel(x, y, layers)
            ops.append(["rect", x * CELL, y * CELL, CELL, CELL, hexcolor(c)])
    ctx.w.draw(ctx.id("preview"), ops)
    ctx.set("layers", items=["%d. %s" % (i + 1, n) for i, n in enumerate(layers)])


def int_param(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def build(win, spec, slots):
    pal = (spec.get("style") or {}).get("palette") or {}
    colors = {
        "bg": pal.get("bg", "#ffffff"), "fg": pal.get("fg", "#1f2937"), "accent": pal.get("accent", "#2563eb"),
        "danger": pal.get("danger", "#dc2626"), "muted": pal.get("muted", "#6b7280"),
    }
    max_layers = max(1, min(32, int_param(spec["params"].get("layer_max"), 8)))
    tb = slots["toolbar"]["handlers"]

    def add(ctx):
        layers = ctx.state.setdefault("layers", [])
        name = ctx.get("tools")
        if name not in EFFECTS:
            name = next(iter(EFFECTS))
        if len(layers) >= max_layers:
            ctx.set("status", text="圖層已達上限 %d 層" % max_layers)
            return
        layers.append(name)
        ctx.set("status", text="已加入「%s」" % name)
        draw(ctx, colors)

    def redraw_after(fn):
        def handler(ctx):
            fn(ctx)
            draw(ctx, colors)
        return handler

    handlers = {key: redraw_after(fn) for key, fn in tb.items()}
    handlers["click:add"] = add
    handlers["shortcut:add"] = add
    handlers["click:orig"] = redraw_after(lambda ctx: None)
    handlers["click:back"] = redraw_after(lambda ctx: None)
    return {"handlers": handlers}
