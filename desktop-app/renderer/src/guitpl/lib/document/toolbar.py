# -*- coding: utf-8 -*-
# 文件工具列的行為：全部都是「在游標處」改編輯區的文字（Markdown 寫法），不會多出任何區塊：
#   標題 1 到 3（再按一次同級就取消）、粗體與斜體（包住選取的字；沒選就放一個預設字並選起來）、清單與引用（每行加前綴，再按一次取消）、
#   插入段落（在游標處切開，放一個空段落並選起來，直接打字就蓋掉預設字）、存檔。
# 文字處理都是純函式（輸入文字與選取範圍，回傳新文字與新的選取範圍），好測試；處理函式只負責讀游標、寫回、把游標放到新位置。


def line_start(text, pos):
    return text.rfind("\n", 0, pos) + 1


def line_end(text, pos):
    e = text.find("\n", pos)
    return len(text) if e < 0 else e


def heading_level(line):
    n = len(line) - len(line.lstrip("#"))
    if 1 <= n <= 6 and (len(line) == n or line[n] == " "):
        return n
    return 0


def apply_heading(text, a, b, level):
    """The line at the caret becomes a heading of this level (the same level again takes it back to a plain line). Returns (text, start, end)."""
    ls, le = line_start(text, a), line_end(text, a)
    line = text[ls:le]
    body = line.lstrip("#").lstrip() if heading_level(line) else line
    prefix = "" if heading_level(line) == level else "#" * level + " "
    new_line = prefix + body
    out = text[:ls] + new_line + text[le:]
    end = ls + len(new_line)
    return out, end, end


def apply_wrap(text, a, b, mark, placeholder):
    """Wraps the selection in mark (** for bold, * for italic); wrapped already takes it off again. No selection: the placeholder, selected."""
    m = len(mark)
    sel = text[a:b]
    if len(sel) >= 2 * m and sel.startswith(mark) and sel.endswith(mark):
        inner = sel[m:-m]
        return text[:a] + inner + text[b:], a, a + len(inner)
    if a >= m and text[a - m:a] == mark and text[b:b + m] == mark and sel:
        return text[:a - m] + sel + text[b + m:], a - m, a - m + len(sel)
    inner = sel or placeholder
    return text[:a] + mark + inner + mark + text[b:], a + m, a + m + len(inner)


def apply_prefix(text, a, b, prefix):
    """Puts prefix in front of every line the selection touches (all have it already: takes it off). Returns the changed block as the selection."""
    ls = line_start(text, a)
    le = line_end(text, b if b == a or text[b - 1:b] != "\n" else b - 1)
    lines = text[ls:le].split("\n")
    if all(l.startswith(prefix) for l in lines if l.strip() or len(lines) == 1):
        new = [l[len(prefix):] if l.startswith(prefix) else l for l in lines]
    else:
        new = [l if l.startswith(prefix) else prefix + l for l in lines]
    block = "\n".join(new)
    return text[:ls] + block + text[le:], ls, ls + len(block)


def apply_paragraph(text, a, b, placeholder="新段落"):
    """Inserts a new paragraph at the caret: the text is split there, one blank line on each side, the placeholder selected."""
    head = text[:b].rstrip(" \t\n")
    tail = text[b:].lstrip(" \t\n")
    before = "\n\n" if head else ""
    after = "\n\n" if tail else "\n"
    start = len(head) + len(before)
    return head + before + placeholder + after + tail, start, start + len(placeholder)


def _edit(ctx, fn):
    if ctx.state.get("preview"):
        return  # 預覽中不能改文字
    a, b = ctx.caret("body")
    text, s, e = fn(ctx.get("body"), a, b)
    ctx.set("body", value=text, caret=s, caret_to=e)


def heading(level):
    return lambda ctx: _edit(ctx, lambda t, a, b: apply_heading(t, a, b, level))


def bold(ctx):
    _edit(ctx, lambda t, a, b: apply_wrap(t, a, b, "**", "粗體文字"))


def italic(ctx):
    _edit(ctx, lambda t, a, b: apply_wrap(t, a, b, "*", "斜體文字"))


def bullet(ctx):
    _edit(ctx, lambda t, a, b: apply_prefix(t, a, b, "- "))


def quote(ctx):
    _edit(ctx, lambda t, a, b: apply_prefix(t, a, b, "> "))


def insert_para(ctx):
    _edit(ctx, apply_paragraph)
    ctx.set("msg", text="已在游標處插入新段落")


def toggle_preview(ctx):
    """編輯與預覽切換：預覽把 Markdown 畫成排版後的樣子（標題變大變粗、粗體變粗、清單有項目符號）。"""
    on = not ctx.state.get("preview", False)
    ctx.state["preview"] = on
    if on:
        ctx.set("view", value=ctx.get("body"))
        ctx.set("body", visible=False)
        ctx.set("view", visible=True)
        ctx.set("preview_btn", text="編輯", icon="✎")
        ctx.set("msg", text="預覽：排版後的樣子（按「編輯」回去改）")
    else:
        ctx.set("view", visible=False)
        ctx.set("body", visible=True)
        a, b = ctx.caret("body")
        ctx.set("body", caret=a, caret_to=b)
        ctx.set("preview_btn", text="預覽", icon="◉")
        ctx.set("msg", text="編輯")


def save(ctx):
    ctx.state["saved"] = ctx.state.get("saved", 0) + 1
    ctx.set("msg", text="已存 %d 次" % ctx.state["saved"])


def build(win, spec, slots):
    return {"handlers": {
        "click:h1": heading(1), "click:h2": heading(2), "click:h3": heading(3),
        "click:bold": bold, "click:italic": italic, "click:bullet": bullet, "click:quote": quote,
        "click:insert_para": insert_para, "click:save": save, "click:preview_btn": toggle_preview,
    }}
