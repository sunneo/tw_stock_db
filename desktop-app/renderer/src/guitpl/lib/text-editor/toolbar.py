# -*- coding: utf-8 -*-
# 文字編輯工具列的行為：新增、存檔，以及「語法」按鈕（每按一次換下一種語法上色，文字不會丟）。
# 提示音由參數 sound 決定（yes 才響）；起始語法由參數 lang 決定。

LANGS = [("text", "純文字"), ("python", "Python"), ("javascript", "JavaScript"), ("json", "JSON"),
         ("markdown", "Markdown"), ("html", "HTML"), ("css", "CSS")]


def lang_label(code):
    for c, label in LANGS:
        if c == code:
            return label
    return "純文字"


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


def next_lang(ctx):
    codes = [c for c, _ in LANGS]
    now = ctx.state.get("lang", "text")
    nxt = codes[(codes.index(now) + 1) % len(codes)] if now in codes else codes[0]
    ctx.state["lang"] = nxt
    ctx.set("editor", lang=nxt)  # 版面重畫，輸入的文字會保留
    ctx.set("lang_btn", text="語法：" + lang_label(nxt))
    ctx.set("status", text="語法：" + lang_label(nxt))


def toggle_wrap(ctx):
    on = bool(ctx.get("wrap"))
    ctx.set("editor", wrap=on)  # 版面重畫，輸入的文字會保留
    ctx.set("status", text="自動換行：" + ("開" if on else "關"))


def build(win, spec, slots):
    sound = spec["params"].get("sound") == "yes"
    start_lang = spec["params"].get("lang") or "text"

    def start(ctx):
        ctx.state["lang"] = start_lang
        ctx.set("lang_btn", text="語法：" + lang_label(start_lang))

    return {
        "handlers": {
            "start": start,
            "click:save": lambda ctx: save_file(ctx, sound),
            "click:new": lambda ctx: new_file(ctx, sound),
            "click:lang_btn": next_lang,
            "change:wrap": toggle_wrap,
        }
    }
