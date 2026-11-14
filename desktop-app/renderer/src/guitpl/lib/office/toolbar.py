# -*- coding: utf-8 -*-
# 待辦工具列的行為。清單一行一筆：未完成是「[ ] 內容」，已完成是「[x] 內容」。
# 件數與場景由狀態列的 refresh 更新（主畫面包住這兩個動作）。


def add(ctx):
    text = ctx.get("task").strip()
    if not text:
        ctx.set("msg", text="請先輸入待辦內容")
        return
    body = ctx.get("tasks").rstrip("\n")
    body = (body + "\n" if body else "") + "[ ] " + text
    ctx.set("tasks", value=body)
    ctx.set("task", value="")
    ctx.set("msg", text="已新增")


def clear_done(ctx):
    lines = ctx.get("tasks").split("\n")
    kept = [ln for ln in lines if not ln.startswith("[x] ")]
    removed = len(lines) - len(kept)
    ctx.set("tasks", value="\n".join(kept).strip("\n"))
    ctx.set("msg", text="已清除 %d 件" % removed)


def build(win, spec, slots):
    return {"handlers": {"click:add": add, "click:clear_done": clear_done}}
