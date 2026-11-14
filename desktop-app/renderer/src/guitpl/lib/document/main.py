# -*- coding: utf-8 -*-
# 文件的主畫面：把工具列（新增章節、存檔）、大綱側欄、狀態列接起來。
# 內容一改動就同時更新大綱與字數；新增章節後也一樣。快捷鍵接到同一組處理函式。


def build(win, spec, slots):
    tb = slots["toolbar"]["handlers"]
    refresh_outline = slots["sidebar"]["refresh"]
    refresh_count = slots["statusbar"]["refresh"]

    def edited(ctx):
        refresh_outline(ctx)
        refresh_count(ctx)

    def add_heading(ctx):
        tb["click:add_heading"](ctx)
        refresh_outline(ctx)
        refresh_count(ctx)

    return {
        "handlers": {
            "input:body": edited,
            "click:add_heading": add_heading,
            "shortcut:save": tb["click:save"],
            "shortcut:add_heading": add_heading,
        }
    }
