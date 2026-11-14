# -*- coding: utf-8 -*-
# 文字編輯器的主畫面：存檔與新增由工具列負責，字數由狀態列負責；這裡只把快捷鍵接到工具列的同一組處理函式
# （Ctrl+S 與存檔按鈕、Ctrl+N 與新增按鈕，行為完全一樣）。


def build(win, spec, slots):
    tb = slots["toolbar"]["handlers"]
    return {
        "handlers": {
            "shortcut:save_file": tb["click:save"],
            "shortcut:new_file": tb["click:new"],
        }
    }
