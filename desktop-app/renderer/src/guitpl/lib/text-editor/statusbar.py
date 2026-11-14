# -*- coding: utf-8 -*-
# 文字編輯狀態列：內容一改動就顯示字數（沿用舊檔的 count_words）。


def count_words(ctx):
    ctx.set("status", text="%d 字" % len(ctx.get("editor")))


def build(win, spec, slots):
    return {"handlers": {"input:editor": count_words}}
