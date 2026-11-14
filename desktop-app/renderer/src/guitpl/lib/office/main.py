# -*- coding: utf-8 -*-
# 待辦清單的主畫面：「新增」與「清除已完成」由工具列負責；這裡把它們包一層，做完之後再更新件數與場景，
# 快捷鍵也接到同一組處理函式。


def build(win, spec, slots):
    tb = slots["toolbar"]["handlers"]
    refresh = slots["statusbar"]["refresh"]

    def add(ctx):
        tb["click:add"](ctx)
        refresh(ctx)

    def clear_done(ctx):
        tb["click:clear_done"](ctx)
        refresh(ctx)

    return {
        "handlers": {
            "click:add": add,
            "click:clear_done": clear_done,
            "shortcut:add_task": add,
            "shortcut:clear_done": clear_done,
        }
    }
