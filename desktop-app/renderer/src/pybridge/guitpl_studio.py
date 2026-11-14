# -*- coding: utf-8 -*-
"""
guitpl_studio -- the GUI design studio, written with gui.Window itself.

    import guitpl
    guitpl.studio("office/main")        # a window to tweak the params, colors, font and size of a template, preview it live,
                                        # read its storyboard, and save the result as "my template" (user/<name>)

Preview opens (or reopens) the real window with the current settings; changing a field and pressing Preview again reruns it.
Save writes a new jsonl+py pair that extends the template and keeps only the changed lines (see guitpl.save_template);
the next guitpl.catalog() and the AI's template search list it, and it is a reference case for the next design.
"""
import re
import time

import gui
import guitpl

PALETTE_KEYS = (("bg", "背景"), ("fg", "文字"), ("accent", "強調"), ("danger", "警示"), ("muted", "次要"))
DEFAULT_PALETTE = {"bg": "#ffffff", "fg": "#222222", "accent": "#2563eb", "danger": "#dc2626", "muted": "#9ca3af"}
COLOR_RE = re.compile(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
FONTS = ("sans-serif", "serif", "monospace")


def _coerce(text, default):
    """The text of an entry as the same type as the param's default (numbers and booleans stay numbers and booleans)."""
    if isinstance(default, bool):
        return str(text).strip().lower() in ("1", "true", "yes", "是", "開")
    if isinstance(default, int):
        return int(str(text).strip())
    if isinstance(default, float):
        return float(str(text).strip())
    return str(text)


def studio(cid, params=None, roots=None, window=None):
    comp = guitpl.prepare(cid, params, roots)
    values = guitpl.bind_params(comp, params)
    style = guitpl.Library._merge_style({"palette": dict(DEFAULT_PALETTE)}, comp["style"] or {})
    palette = style.get("palette", {})
    w = window or gui.Window("設計工作室：" + comp["meta"].get("title", cid), width=520, resizable=True)
    w.label("範本：%s（%s）" % (comp["meta"].get("title", cid), cid))
    page = w.scroll(height=420)
    w.label("參數", parent=page)
    param_ids = {}
    for name, rec in comp["params"].items():
        w.label(rec.get("ask") or name, parent=page)
        param_ids[name] = w.entry(str(values[name]), parent=page)
    w.label("配色（#rrggbb）", parent=page)
    color_ids = {}
    grid = w.grid(columns=2, parent=page)
    for key, label in PALETTE_KEYS:
        w.label(label, parent=grid)
        color_ids[key] = w.entry(str(palette.get(key, DEFAULT_PALETTE[key])), parent=grid)
    w.label("字型（sans-serif、serif、monospace）、文字大小（10-24）、圓角（0-16）", parent=page)
    font_id = w.entry(str(style.get("font", "sans-serif")), parent=page)
    size_id = w.entry(str(style.get("size", 14)), parent=page)
    radius_id = w.entry(str(style.get("radius", 6)), parent=page)
    w.label("我的範本名稱（user/名稱）", parent=page)
    name_id = w.entry("user/my_" + cid.split("/")[-1].replace("-", "_"), parent=page)
    bar = w.row()
    preview_btn = w.button("預覽", parent=bar)
    story_btn = w.button("分鏡", parent=bar)
    save_btn = w.button("存成我的範本", parent=bar)
    status = w.label("改完按「預覽」看效果；滿意再按「存成我的範本」。")
    story = w.textarea("", rows=8, placeholder="分鏡會顯示在這裡")

    def settings():
        """The fields as (params, style, errors)."""
        errors = []
        given = {}
        for name, rec in comp["params"].items():
            try:
                given[name] = _coerce(w.value(param_ids[name]), rec["default"])
            except ValueError:
                errors.append("參數 %s 的格式不對" % name)
        pal = {}
        for key, _label in PALETTE_KEYS:
            c = str(w.value(color_ids[key])).strip()
            if not COLOR_RE.match(c):
                errors.append("配色 %s 要寫成 #rrggbb：%s" % (key, c))
            pal[key] = c
        font = str(w.value(font_id)).strip()
        if font not in FONTS:
            errors.append("字型要是 " + "、".join(FONTS))
        try:
            size = int(str(w.value(size_id)).strip())
            radius = int(str(w.value(radius_id)).strip())
            if not (10 <= size <= 24) or not (0 <= radius <= 16):
                errors.append("文字大小要在 10-24、圓角要在 0-16")
        except ValueError:
            errors.append("文字大小與圓角要是整數")
            size, radius = 14, 6
        return given, {"palette": pal, "font": font, "size": size, "radius": radius}, errors

    def say(text):
        w.set(status, text=text)

    pv = [None]

    def close_preview():
        if pv[0] is not None:
            try:
                pv[0]["win"].close()
            except Exception:  # the user already closed it
                pass
            pv[0] = None

    def preview():
        given, st, errors = settings()
        if errors:
            say("；".join(errors))
            return
        close_preview()
        try:
            pv[0] = guitpl.run(cid, given, roots, loop=False, style=st)
            say("預覽已開啟（再按一次「預覽」會用目前的設定重開）。")
        except guitpl.GuiTplError as e:
            say("預覽失敗：%s" % e)

    def pump_preview():
        """Dispatch the preview window's events with the template's own handlers (the same dispatch run() uses)."""
        p = pv[0]
        if p is None:
            return False
        ev = p["win"].poll()
        if ev is None:
            return False
        if ev.get("event") == "close":
            pv[0] = None
            return True
        key = guitpl._key_of(ev, p["by_id"])
        p["ctx"].event = ev
        try:
            guitpl._dispatch(p["ctx"], p["component"], key, p["handlers"], p["calls"])
        except Exception as e:  # one broken handler must not take the studio down
            if p["win"].closed:
                pv[0] = None
            else:
                p["ctx"].error("處理事件 %s 出錯：%s: %s" % (key, type(e).__name__, e))
        return True

    def save():
        given, st, errors = settings()
        if errors:
            say("；".join(errors))
            return
        changed = {n: v for n, v in given.items() if v != comp["params"][n]["default"]}
        base_pal = guitpl.Library._merge_style({"palette": dict(DEFAULT_PALETTE)}, comp["style"] or {})["palette"]
        pal = {k: v for k, v in st["palette"].items() if v.lower() != str(base_pal.get(k, "")).lower()}
        try:
            new_id = guitpl.save_template(cid, str(w.value(name_id)).strip(), params=changed, palette=pal or None,
                                          font=st["font"] if st["font"] != style.get("font", "sans-serif") else None,
                                          size=st["size"] if st["size"] != style.get("size", 14) else None,
                                          radius=st["radius"] if st["radius"] != style.get("radius", 6) else None, roots=roots)
            say("已存成我的範本：%s（下次找範本時會出現，也會當參考案例）" % new_id)
        except Exception as e:  # a name that is taken or malformed, or a full store
            say("存不了：%s" % e)

    while True:
        ev = w.poll()
        if ev is None:
            if not pump_preview():
                time.sleep(0.02)
            continue
        if ev.get("event") == "close":
            break
        if ev.get("event") == "click":
            if ev["node"] == preview_btn:
                preview()
            elif ev["node"] == story_btn:
                w.set(story, value=guitpl.storyboard_text(comp))
            elif ev["node"] == save_btn:
                save()
    close_preview()
    try:
        w.close()
    except Exception:  # already closed by the user
        pass
    return None
