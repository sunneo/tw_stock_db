# -*- coding: utf-8 -*-
"""
gui -- windows for skill scripts (the Python side of the skill GUI bridge).

A window is drawn in the terminal named in python_execute's "terminal" (the same window host that zenity and
`gui wait` use in the shell). The window does not block the script: open it, add nodes, then wait for an event.

    import gui
    w = gui.Window("Name", width=320)
    name = w.entry("")
    ok = w.button("OK")
    while True:
        ev = w.wait(timeout=120)          # {"event": "click", "node": ...}, or None on timeout
        if ev is None or ev["event"] == "close" or ev["node"] == ok:
            break
    print(w.value(name))
    w.close()

Events: "click" (buttons), "close" (the user closed the window). These update value() and do not return from wait():
"input" (entry, textarea or editor text), "cell" (a table cell), "toggle" (an expander), "select" (a multilist or
listbox selection), "change" (a checkbox).
Node kinds: label, button, entry, textarea, checkbox, progress, listbox, row, column, expander, editor, table, multilist,
canvas. Rows, columns and expanders take a parent=... argument to hold other nodes. set(node, text=..., enabled=...,
visible=..., value=...) changes a node that was already added.
Ready-made apps: before writing a window program from scratch, look for a template: `import guitpl; guitpl.catalog("what the
user asked for")` lists matching templates (id, title, params with the question to ask); `guitpl.run("office/main", params={...})`
builds and runs one (customize by passing params, or write a new .jsonl/.py pair that "extends" it).
Look and keys: theme(palette={...}, font=..., size=..., radius=...) colors and styles the window; shortcut("Ctrl+S", "save")
makes wait() and poll() return {"event": "shortcut", "value": "save"} when the key is pressed; tone(freq, ms, wave) beeps.
"""
import base64
import os

import fa_bridge


class Window(object):
    def __init__(self, title, width=360, resizable=False, maximizable=False):
        # resizable: the user can drag the window's corner bigger or smaller; maximizable: a button fills the terminal's area.
        # A canvas in a resizable window reports its new size with a "resize" event.
        self.id = "w" + os.urandom(4).hex()
        self._nodes = 0
        self._values = {}
        self._images = 0
        self._tables = set()
        self.closed = False
        fa_bridge.call("gui.open", {"id": self.id, "title": str(title), "width": int(width),
                                    "resizable": bool(resizable), "maximizable": bool(maximizable)})

    def _node(self, kind, parent, **fields):
        self._nodes += 1
        node = {"id": "n%d" % self._nodes, "kind": kind}
        node.update(fields)
        fa_bridge.call("gui.add", {"id": self.id, "parent": parent or "root", "node": node})
        return node["id"]

    def label(self, text, parent=None):
        return self._node("label", parent, text=str(text))

    def button(self, text, parent=None):
        return self._node("button", parent, text=str(text))

    def entry(self, value="", parent=None):
        nid = self._node("entry", parent, value=str(value))
        self._values[nid] = str(value)
        return nid

    def row(self, parent=None):
        return self._node("row", parent)

    def column(self, parent=None):
        return self._node("column", parent)

    def grid(self, columns=2, parent=None):
        """A container that lays its children out in `columns` equal columns, row by row (1-12)."""
        return self._node("grid", parent, columns=int(columns))

    def scroll(self, height=200, parent=None):
        """A column at most `height` pixels high (40-1200); what does not fit scrolls."""
        return self._node("scroll", parent, height=int(height))

    def expander(self, text, expanded=False, parent=None):
        """A collapsible container: children take parent=<its id>. value() is True while it is open."""
        nid = self._node("expander", parent, text=str(text), expanded=bool(expanded))
        self._values[nid] = bool(expanded)
        return nid

    def editor(self, value="", lang="", rows=8, parent=None):
        """A multi-line monospace text box. value() is its text."""
        nid = self._node("editor", parent, value=str(value), lang=str(lang), rows=int(rows))
        self._values[nid] = str(value)
        return nid

    def table(self, columns, rows=(), parent=None):
        """A grid of text cells: columns is a list of headings, rows a list of lists (one text per column).
        value() is the current list of rows and changes as the user edits cells."""
        cols = [str(c) for c in columns]
        data = [[str(c) for c in r] for r in rows]
        for i, r in enumerate(data):
            if len(r) != len(cols):
                raise ValueError("table row %d has %d cells, the table has %d columns" % (i, len(r), len(cols)))
        nid = self._node("table", parent, columns=cols, rows=data)
        self._values[nid] = [list(r) for r in data]
        self._tables.add(nid)
        return nid

    def multilist(self, items, selected=(), parent=None):
        """A list where several items can be selected. value() is the list of selected items."""
        nid = self._node("multilist", parent, items=[str(i) for i in items], selected=[str(s) for s in selected])
        self._values[nid] = [str(s) for s in selected]
        return nid

    def textarea(self, value="", rows=4, placeholder="", parent=None):
        """A multi-line text box (not monospace, no language). value() is its text."""
        nid = self._node("textarea", parent, value=str(value), rows=int(rows), placeholder=str(placeholder))
        self._values[nid] = str(value)
        return nid

    def checkbox(self, text, checked=False, parent=None):
        """A tick box with a label. value() is True while ticked; a "change" event is queued for poll()."""
        nid = self._node("checkbox", parent, text=str(text), checked=bool(checked))
        self._values[nid] = bool(checked)
        return nid

    def progress(self, value=0, max=100, parent=None):
        """A progress bar. Change it with set(nid, value=...)."""
        return self._node("progress", parent, value=float(value), max=float(max))

    def listbox(self, items, selected="", parent=None):
        """A list where one item is selected. value() is the selected item's text ("" when none)."""
        nid = self._node("list", parent, items=[str(i) for i in items], selected=str(selected))
        self._values[nid] = str(selected)
        return nid

    def set(self, nid, **props):
        """Change properties of a node already added: set(btn, text="Save", enabled=False), set(box, visible=False),
        set(pb, value=40), set(lbl, text="..."). value() follows value / checked / selected."""
        fa_bridge.call("gui.set", {"id": self.id, "node": nid, "props": props})
        for key in ("value", "checked", "selected"):
            if key in props and nid in self._values:
                self._values[nid] = props[key]
        if "rows" in props and nid in self._tables:
            self._values[nid] = [[str(c) for c in r] for r in props["rows"]]

    def theme(self, palette=None, font=None, size=None, radius=None):
        """The window's look. palette: a dict with any of bg, fg, accent, danger, muted ("#rgb" or "#rrggbb"; the ones not given
        keep their value). font: "sans-serif", "serif" or "monospace". size: text size 10-24. radius: corner radius 0-16.
        Only what is given changes, so it can be called again later (for example to switch dark and light)."""
        args = {"id": self.id}
        if palette is not None:
            args["palette"] = dict(palette)
        if font is not None:
            args["font"] = str(font)
        if size is not None:
            args["size"] = int(size)
        if radius is not None:
            args["radius"] = int(radius)
        fa_bridge.call("gui.theme", args)

    def shortcut(self, keys, name):
        """Register a window shortcut. keys: "Ctrl+S", "Ctrl+Shift+Z", "Alt+Left", "F5", "Esc" (modifiers in the order Ctrl, Shift,
        Alt; a letter or digit, F1-F12, Enter, Esc, Space, Up, Down, Left or Right). When the user presses it, wait() and
        poll() return {"event": "shortcut", "value": name}. name None removes the shortcut. A key with no Ctrl or Alt is
        ignored while the user types in a text box."""
        fa_bridge.call("gui.shortcut", {"id": self.id, "keys": str(keys), "name": None if name is None else str(name)})

    def tone(self, freq=440, ms=120, wave="sine"):
        """Play a short beep in the page: freq 40-8000 Hz, ms 10-2000, wave "sine", "square", "triangle" or "sawtooth".
        It returns at once and stays silent if the page cannot play sound (nothing is raised)."""
        fa_bridge.call("gui.tone", {"id": self.id, "freq": float(freq), "ms": int(ms), "wave": str(wave)})

    def canvas(self, width=320, height=240, fps=0, parent=None):
        """A drawing area for frames (pygame uses this). draw(nid, ops) paints one whole frame. fps > 0 queues "frame" events for poll()."""
        return self._node("canvas", parent, width=int(width), height=int(height), fps=int(fps))

    def draw(self, nid, ops):
        """Paint one frame on a canvas. ops: lists such as ["rect", x, y, w, h, "#rrggbb"], ["circle", x, y, r, color],
        ["line", x1, y1, x2, y2, color], ["text", x, y, text, color], ["clear", color], ["image", name, x, y, w, h]. At most 200 ops."""
        fa_bridge.call("gui.draw", {"id": self.id, "node": nid, "ops": ops})

    def image(self, nid, data, mime):
        """Register a picture (PNG, JPEG, GIF or WebP bytes, at most 256 KB) on a canvas. Returns (name, w, h): draw it with
        ["image", name, x, y] or ["image", name, x, y, w, h]. The page decodes it; a picture it cannot decode raises an error."""
        self._images += 1
        name = "i%d" % self._images
        url = "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))
        size = fa_bridge.call("gui.image", {"id": self.id, "node": nid, "name": name, "data": url})
        return name, int(size["w"]), int(size["h"])

    def poll(self):
        """The next queued event now, or None. Never waits. Key events come as {"event": "key", "value": {"key", "down"}}."""
        ev = fa_bridge.call("gui.poll", {"id": self.id})
        if ev is None:
            return None
        if ev.get("event") in ("input", "cell", "toggle", "select", "change"):
            self._event_value(ev)
        if ev.get("event") == "close":
            self.closed = True
        return ev

    def value(self, nid):
        """The current value of a widget: entry text, editor text, table rows, expander open flag, multilist selection."""
        return self._values.get(nid)

    def _event_value(self, ev):
        """Store a value-changing event (input, cell, toggle, select) in value()."""
        kind = ev.get("event")
        node = ev.get("node")
        if kind == "cell":
            cell = ev.get("value") or {}
            self._values[node][cell["row"]][cell["col"]] = cell.get("text")
        else:
            self._values[node] = ev.get("value")

    def wait(self, timeout=300):
        """Block until a button is clicked or the window is closed. Returns the event dict, or None on timeout."""
        import time
        end = time.time() + float(timeout)
        while True:
            left = end - time.time()
            if left <= 0:
                return None
            ev = fa_bridge.call("gui.wait", {"id": self.id, "timeout": left}, timeout=left + 15)
            if ev is None:
                return None
            kind = ev.get("event")
            if kind in ("input", "cell", "toggle", "select", "change"):
                self._event_value(ev)
                continue
            if kind == "close":
                self.closed = True
            return ev

    def close(self):
        if not self.closed:
            self.closed = True
            fa_bridge.call("gui.close", {"id": self.id})


def usertpl(action, id=None, jsonl=None, py=None):
    """The user's own GUI templates kept by the page. "list" -> {id: {"jsonl", "py"}}; "save" stores one pair (id must be user/...);
    "delete" removes one. Used by guitpl (catalog, run) and the design studio; there is no page behind a plain python run (it raises)."""
    return fa_bridge.call("gui.usertpl", {"action": str(action), "id": id, "jsonl": jsonl, "py": py})
