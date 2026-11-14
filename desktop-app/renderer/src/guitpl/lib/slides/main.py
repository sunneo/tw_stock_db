# -*- coding: utf-8 -*-
# 投影片編輯器：左邊是投影片清單，中間編輯這張的標題與內容，下方是講者備忘稿。
# 投影片資料放在 G（本函式的閉包）：{"slides": [{"title","body","notes"}], "cur": 目前張的索引}。
# 放映的切換在 jsonl 的場景（click:present、shortcut:present、click:back）；這裡只負責內容。


def _labels(G):
    return ["%d. %s" % (i + 1, s["title"] or "（未命名）") for i, s in enumerate(G["slides"])]


def _refresh(ctx, G):
    cur = G["slides"][G["cur"]]
    labels = _labels(G)
    ctx.set("slide_list", items=labels, selected=labels[G["cur"]])
    ctx.set("slide_title", value=cur["title"])
    ctx.set("slide_body", value=cur["body"])
    ctx.set("speaker_notes", value=cur["notes"])
    ctx.set("page_info", text="第 %d 張／共 %d 張" % (G["cur"] + 1, len(G["slides"])))


def build(win, spec, slots):
    G = {"slides": [{"title": spec["params"]["first_title"], "body": "在這裡寫投影片內容。", "notes": ""}], "cur": 0}

    def cur():
        return G["slides"][G["cur"]]

    def add(ctx):
        G["slides"].append({"title": "新投影片 %d" % (len(G["slides"]) + 1), "body": "", "notes": ""})
        G["cur"] = len(G["slides"]) - 1
        _refresh(ctx, G)

    def delete(ctx):
        if len(G["slides"]) <= 1:
            ctx.set("page_info", text="至少要留一張投影片")
            return
        del G["slides"][G["cur"]]
        G["cur"] = min(G["cur"], len(G["slides"]) - 1)
        _refresh(ctx, G)

    def present(ctx):
        s = cur()
        ctx.set("present_view", text="【%s】\n%s" % (s["title"], s["body"]))

    def back(ctx):
        _refresh(ctx, G)

    def select(ctx):
        # 清單的文字是「次序. 標題」，前面的次序就是索引
        try:
            i = int(str(ctx.get("slide_list") or "").split(".")[0]) - 1
        except ValueError:
            return
        if 0 <= i < len(G["slides"]) and i != G["cur"]:
            G["cur"] = i
            _refresh(ctx, G)

    def typed_title(ctx):
        cur()["title"] = str(ctx.get("slide_title") or "")
        labels = _labels(G)
        ctx.set("slide_list", items=labels, selected=labels[G["cur"]])

    def typed_body(ctx):
        cur()["body"] = str(ctx.get("slide_body") or "")

    def typed_notes(ctx):
        cur()["notes"] = str(ctx.get("speaker_notes") or "")

    return {"handlers": {
        "click:add": add,
        "shortcut:new": add,
        "click:del": delete,
        "click:present": present,
        "shortcut:present": present,
        "click:back": back,
        "select:slide_list": select,
        "input:slide_title": typed_title,
        "input:slide_body": typed_body,
        "input:speaker_notes": typed_notes,
    }}
