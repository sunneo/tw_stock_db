# -*- coding: utf-8 -*-
# YAML 待辦示範的行為：新增一項（按鈕或 Ctrl+Enter），清單與狀態列跟著更新。


def build(win, spec, slots):
    def add(ctx):
        text = str(ctx.get("item") or "").strip()
        if not text:
            ctx.set("status", text="先輸入要做的事")
            return
        items = ctx.state.setdefault("items", [])
        items.append(text)
        ctx.set("items", items=list(items))
        ctx.set("item", value="")
        ctx.set("status", text="共 %d 項" % len(items))

    return {"handlers": {"click:add": add, "shortcut:add": add}}
