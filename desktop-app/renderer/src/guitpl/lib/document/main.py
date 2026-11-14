# -*- coding: utf-8 -*-
# 文件的主畫面：把工具列（標題、粗體、插入段落、存檔）、大綱側欄、狀態列接起來。
# 內容一改動（打字或工具列改了文字）就更新大綱與字數；快捷鍵接到同一組處理函式。


def build(win, spec, slots):
    tb = slots["toolbar"]["handlers"]
    refresh_outline = slots["sidebar"]["refresh"]
    refresh_count = slots["statusbar"]["refresh"]

    def refresh(ctx):
        refresh_outline(ctx)
        refresh_count(ctx)

    def after(fn):
        def run(ctx):
            fn(ctx)
            refresh(ctx)
        return run

    handlers = {"input:body": refresh, "start": refresh}
    for name in ("h1", "h2", "h3", "bold", "italic", "bullet", "quote", "insert_para"):
        handlers["click:" + name] = after(tb["click:" + name])
        handlers["shortcut:" + name] = handlers["click:" + name]
    handlers["click:preview_btn"] = tb["click:preview_btn"]
    handlers["shortcut:preview_btn"] = tb["click:preview_btn"]
    handlers["click:save"] = tb["click:save"]
    handlers["shortcut:save"] = tb["click:save"]
    return {"handlers": handlers}
