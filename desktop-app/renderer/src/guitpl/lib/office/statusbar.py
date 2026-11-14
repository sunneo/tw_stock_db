# -*- coding: utf-8 -*-
# 待辦狀態列：顯示未完成與已完成件數；清單有內容時切到「有待辦」場景，清空後切回「沒有待辦」場景。


def counts(text):
    lines = [ln for ln in text.split("\n") if ln.strip()]
    done = len([ln for ln in lines if ln.startswith("[x] ")])
    return len(lines) - done, done


def refresh(ctx):
    text = ctx.get("tasks")
    open_n, done_n = counts(text)
    ctx.set("count", text="%d 件未完成，%d 件已完成" % (open_n, done_n))
    ctx.goto("list" if open_n + done_n else "empty")


def build(win, spec, slots):
    return {"handlers": {"input:tasks": refresh}, "refresh": refresh}
