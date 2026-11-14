# -*- coding: utf-8 -*-
# 文字編輯工具列的行為（沿用舊檔 text-editor.json 的動作：save_file、new_file、toggle_wrap）。
# 提示音由參數 sound 決定（yes 才響）。


def save_file(ctx, sound):
    ctx.state["saved"] = ctx.state.get("saved", 0) + 1
    text = ctx.get("editor")
    ctx.set("status", text="已存 %d 次，%d 字" % (ctx.state["saved"], len(text)))
    if sound:
        ctx.tone(880, 90, "sine")


def new_file(ctx, sound):
    ctx.set("editor", value="")
    ctx.set("status", text="新文件")
    if sound:
        ctx.tone(220, 60, "square")


def toggle_wrap(ctx):
    ctx.state["wrap"] = ctx.get("wrap")
    ctx.set("status", text="自動換行：" + ("開" if ctx.state["wrap"] else "關"))


def build(win, spec, slots):
    sound = spec["params"].get("sound") == "yes"
    return {
        "handlers": {
            "click:save": lambda ctx: save_file(ctx, sound),
            "click:new": lambda ctx: new_file(ctx, sound),
            "change:wrap": toggle_wrap,
        }
    }
