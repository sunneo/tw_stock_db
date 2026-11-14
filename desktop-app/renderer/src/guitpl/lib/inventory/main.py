# -*- coding: utf-8 -*-
# 進銷存主畫面：庫存記在 ctx.state["stock"]（第一次用到才建立），統計場景打開時重新整理表格與警示。
# 表格初始資料與 layout 裡的 stock_table 相同。

PRODUCTS = [("紙杯", 12), ("吸管", 30), ("湯匙", 8)]


def _to_int(text, default):
    try:
        return int(str(text).strip())
    except ValueError:
        return default


def _stock(ctx):
    if "stock" not in ctx.state:
        ctx.state["stock"] = dict(PRODUCTS)
    return ctx.state["stock"]


def _msg(ctx, text):
    ctx.set("msg", text=text)
    ctx.set("sb_text", text=text)


def _move(ctx, sign):
    # sign +1 是進貨，-1 是銷貨
    stock = _stock(ctx)
    name = ctx.get("prod_pick")
    qty = _to_int(ctx.get("qty"), 0)
    if name not in stock:
        _msg(ctx, "請先選一個商品")
        return
    if qty <= 0:
        _msg(ctx, "數量要是大於 0 的整數")
        return
    if sign < 0 and stock[name] < qty:
        _msg(ctx, "%s 庫存不足，只剩 %d 件" % (name, stock[name]))
        ctx.tone(220, 200, "square")
        return
    stock[name] += sign * qty
    _msg(ctx, "%s%s %d 件，現有 %d 件" % (name, "進貨" if sign > 0 else "銷貨", qty, stock[name]))


def build(win, spec, slots):
    low = _to_int(spec["params"].get("low"), 5)

    def show_stats(ctx):
        stock = _stock(ctx)
        ctx.set("stock_table", rows=[[k, str(v)] for k, v in sorted(stock.items())])
        ctx.set("stat_total", text="共 %d 件、%d 種商品" % (sum(stock.values()), len(stock)))
        names = [k for k, v in sorted(stock.items()) if v < low]
        ctx.set("stat_low", text="低於 %d 件的商品：%s" % (low, "、".join(names) or "無"))

    def stock_in(ctx):
        _move(ctx, 1)

    def stock_out(ctx):
        _move(ctx, -1)

    return {"handlers": {
        "click:stock_in": stock_in,
        "click:stock_out": stock_out,
        "shortcut:stock_in": stock_in,
        "shortcut:stock_out": stock_out,
        "click:stats_btn": show_stats,
        "click:tb_stats": show_stats,
    }}
