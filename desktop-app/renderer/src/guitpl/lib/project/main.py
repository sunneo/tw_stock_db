# -*- coding: utf-8 -*-
# 專案任務板：任務表（任務、負責人、狀態、進度%）、選擇要操作的任務、設定進度、整體進度與文字報告。
# 任務資料放在 G（本函式的閉包）：{"rows": [[任務, 負責人, 狀態, 進度字串]], "cur": 目前所選任務的索引}。
# 起始資料要和 main.jsonl 的 layout（tasks、task_pick、overall）一致。
# 表格的文字是 gui 的 table：程式改內容用 set(value=...)，這樣 value() 也跟著更新，使用者編輯走 cell 事件。


def _pct(text):
    try:
        return max(0, min(100, int(str(text).strip())))
    except ValueError:
        return 0


def _status(p):
    return "未開始" if p == 0 else ("完成" if p == 100 else "進行中")


def _labels(G):
    return ["%d. %s" % (i + 1, r[0] or "（未命名）") for i, r in enumerate(G["rows"])]


def _overall(G):
    if not G["rows"]:
        return 0
    return sum(_pct(r[3]) for r in G["rows"]) // len(G["rows"])


def _sync(ctx, G):
    rows = [list(r) for r in G["rows"]]
    labels = _labels(G)
    ctx.set("tasks", value=rows, rows=rows)
    ctx.set("task_pick", items=labels, selected=labels[G["cur"]] if labels else "")
    avg = _overall(G)
    ctx.set("overall", value=avg)
    ctx.set("overall_text", text="整體進度 %d%%（%d 項任務）" % (avg, len(G["rows"])))
    ctx.set("count_text", text="任務 %d 項" % len(G["rows"]))


def build(win, spec, slots):
    G = {"rows": [["規劃需求", "小王", "進行中", "40"], ["設計畫面", "小李", "未開始", "0"]], "cur": 0}

    def set_pct(ctx, p):
        if not G["rows"]:
            return
        row = G["rows"][G["cur"]]
        row[3] = str(p)
        row[2] = _status(p)
        _sync(ctx, G)

    def add(ctx):
        name = str(ctx.get("task_name") or "").strip()
        if not name:
            ctx.set("add_hint", text="請先輸入任務名稱")
            return
        G["rows"].append([name, "未指派", "未開始", "0"])
        G["cur"] = len(G["rows"]) - 1
        ctx.set("task_name", value="")
        ctx.set("add_hint", text="已新增「%s」" % name)
        _sync(ctx, G)

    def done(ctx):
        set_pct(ctx, 100)

    def remove(ctx):
        if not G["rows"]:
            return
        del G["rows"][G["cur"]]
        G["cur"] = max(0, min(G["cur"], len(G["rows"]) - 1))
        _sync(ctx, G)

    def apply_pct(ctx):
        try:
            p = int(str(ctx.get("pct_input") or "").strip())
        except ValueError:
            ctx.set("add_hint", text="進度要填 0 到 100 的整數")
            return
        set_pct(ctx, max(0, min(100, p)))

    def select(ctx):
        try:
            i = int(str(ctx.get("task_pick") or "").split(".")[0]) - 1
        except ValueError:
            return
        if 0 <= i < len(G["rows"]):
            G["cur"] = i
            _sync(ctx, G)

    def cell_edited(ctx):
        # 使用者直接改表格：ctx.event["value"] 是 {"row","col","text"}
        cell = (ctx.event or {}).get("value") or {}
        try:
            r, c = int(cell["row"]), int(cell["col"])
            G["rows"][r][c] = str(cell.get("text") or "")
        except (KeyError, IndexError, TypeError, ValueError):
            return
        if c == 3:
            G["rows"][r][2] = _status(_pct(G["rows"][r][3]))
        _sync(ctx, G)

    def report(ctx):
        lines = ["%s｜%s｜%s%%" % (r[0], r[2], _pct(r[3])) for r in G["rows"]]
        ctx.set("report_text", text="專案進度報告：整體 %d%%\n" % _overall(G) + "\n".join(lines))

    return {"handlers": {
        "click:add": add,
        "shortcut:add": add,
        "click:done": done,
        "click:remove": remove,
        "click:set_pct": apply_pct,
        "select:task_pick": select,
        "cell:tasks": cell_edited,
        "click:report": report,
        "shortcut:report": report,
    }}
