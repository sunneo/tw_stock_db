# -*- coding: utf-8 -*-
# 網頁版面設計器主元件：預覽畫布、屬性編輯與選取。工具列的新增／刪除／匯出由子元件處理，
# 這裡包住它們的處理函式，每次動作後重畫預覽與元件清單。

TYPE_H = 40


def valid_color(s):
    if not isinstance(s, str) or len(s) != 7 or s[0] != "#":
        return False
    return all(ch in "0123456789abcdefABCDEF" for ch in s[1:])


def labels(cs):
    return ["%d. %s：%s" % (i + 1, c["type"], c["text"]) for i, c in enumerate(cs)]


def draw(ctx, colors):
    cs = ctx.state.get("comps", [])
    sel = ctx.state.get("sel")
    ops = [["clear", colors["bg"]]]
    for i, c in enumerate(cs[:6]):
        y = i * TYPE_H + 4
        custom = c.get("color") if valid_color(c.get("color")) else None
        if c["type"] == "按鈕":
            ops.append(["rect", 10, y, 140, 28, custom or colors["accent"]])
            ops.append(["text", 20, y + 8, c["text"], colors["bg"]])
        else:
            ops.append(["text", 10, y + 8, c["text"], custom or colors["fg"]])
        if i == sel:
            ops.append(["line", 0, y + TYPE_H - 4, 320, y + TYPE_H - 4, colors["danger"]])
    ctx.w.draw(ctx.id("preview"), ops)
    ctx.set("comp_list", items=labels(cs))


def make(colors, toolbar):
    def redraw_after(fn):
        def handler(ctx):
            fn(ctx)
            draw(ctx, colors)
        return handler

    def on_select(ctx):
        cs = ctx.state.get("comps", [])
        try:
            i = int(str(ctx.get("comp_list")).split(".")[0]) - 1
        except ValueError:
            i = None
        ctx.state["sel"] = i if i is not None and 0 <= i < len(cs) else None
        if ctx.state["sel"] is not None:
            c = cs[ctx.state["sel"]]
            ctx.set("attr_text", value=c["text"])
            ctx.set("attr_color", value=c.get("color", ""))
        draw(ctx, colors)

    def apply(ctx):
        cs = ctx.state.get("comps", [])
        i = ctx.state.get("sel")
        if i is None or i >= len(cs):
            ctx.set("status", text="請先在清單選一個元件")
            return
        text = ctx.get("attr_text")
        if text:
            cs[i]["text"] = str(text)[:40]
        col = ctx.get("attr_color") or ""
        if col and not valid_color(col):
            ctx.set("status", text="顏色格式錯誤，要像 #2563eb")
            return
        cs[i]["color"] = col
        draw(ctx, colors)
        ctx.set("status", text="已套用到第 %d 個元件" % (i + 1))

    handlers = {key: redraw_after(fn) for key, fn in toolbar.items()}
    handlers["select:comp_list"] = on_select
    handlers["click:apply"] = apply
    return handlers


def build(win, spec, slots):
    pal = (spec.get("style") or {}).get("palette") or {}
    colors = {
        "bg": pal.get("bg", "#ffffff"), "fg": pal.get("fg", "#1f2937"), "accent": pal.get("accent", "#2563eb"),
        "danger": pal.get("danger", "#dc2626"), "muted": pal.get("muted", "#6b7280"),
    }
    return {"handlers": make(colors, slots["toolbar"]["handlers"])}
