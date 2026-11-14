# -*- coding: utf-8 -*-
# 外部呼叫範例：不是範本元件，只是被 jsonl 的 call 紀錄參考的函式。


def on_export(ctx, fmt="txt"):
    ctx.set("status", text="已匯出為 %s（%d 字）" % (fmt, len(ctx.get("editor"))))
