# -*- coding: utf-8 -*-
# 文字編輯狀態列：內容一改動就顯示行數與字數。


def count_words(ctx):
    text = ctx.get("editor")
    ctx.set("status", text="%d 行，%d 字" % (text.count("\n") + 1, len(text)))


def build(win, spec, slots):
    return {"handlers": {"input:editor": count_words}}
