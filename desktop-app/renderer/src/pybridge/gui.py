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
Node kinds: label, button, entry, textarea, checkbox, progress, listbox, row, column, expander, editor, table, multilist, tree,
canvas, tabs (with tab pages), split, menubar (menu, menuitem). Dialogs: message(text), confirm(text) -> bool, ask(text, default) -> str or None, pick_file(title, accept) -> file dict or None.
Rows, columns and expanders take a parent=... argument to hold other nodes. set(node, text=..., enabled=...,
visible=..., value=...) changes a node that was already added.
Ready-made apps: before writing a window program from scratch, look for a template: `import guitpl; guitpl.catalog("what the
user asked for")` lists matching templates (id, title, params with the question to ask); `guitpl.run("office/main", params={...})`
builds and runs one (customize by passing params, or write a new .jsonl/.py pair that "extends" it).
Look and keys: theme(palette={...}, font=..., size=..., radius=...) colors and styles the window; shortcut("Ctrl+S", "save")
makes wait() and poll() return {"event": "shortcut", "value": "save"} when the key is pressed; tone(freq, ms, wave) beeps.
"""
import array as array_mod
import base64
import json
import os

import fa_bridge


_IMAGE_PART = 3 * 1024 * 1024   # bytes of a picture sent in one message


class Window(object):
    def __init__(self, title, width=360, resizable=False, maximizable=False, height=None):
        # resizable: the user can drag the window's corner bigger or smaller; maximizable: a button fills the terminal's area.
        # A canvas in a resizable window reports its new size with a "resize" event.
        self.id = "w" + os.urandom(4).hex()
        self._nodes = 0
        self._values = {}
        self._images = 0
        self._tables = set()
        self._trees = set()
        self._docs = set()
        self._picks = {}
        self._carets = {}
        self.closed = False
        self._style = {}
        args = {"id": self.id, "title": str(title), "width": int(width), "resizable": bool(resizable), "maximizable": bool(maximizable)}
        if height:
            args["height"] = int(height)  # the window's first height; a resizable window's body fills it (see grow)
        fa_bridge.call("gui.open", args)

    def _node(self, kind, parent, **fields):
        self._nodes += 1
        node = {"id": "n%d" % self._nodes, "kind": kind}
        node.update(fields)
        node.update(self._style)
        fa_bridge.call("gui.add", {"id": self.id, "parent": parent or "root", "node": node})
        return node["id"]

    def label(self, text, parent=None):
        return self._node("label", parent, text=str(text))

    def button(self, text, parent=None, icon=""):
        """A push button. icon is a short symbol or emoji shown before the text (toolbar look)."""
        return self._node("button", parent, text=str(text), **({"icon": str(icon)} if icon else {}))

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

    def tabs(self, parent=None):
        """A container of tab pages: add pages with tab(title, parent=<its id>), put the page's content in with parent=<page id>.
        value() is the id of the page shown (the first one until the user clicks another); a click makes a "select" event."""
        nid = self._node("tabs", parent)
        self._values[nid] = None
        return nid

    def tab(self, title, parent):
        """One page of a tabs container (parent is the tabs id). Returns the page's id: children of the page take parent=<this id>."""
        nid = self._node("tab", parent, text=str(title))
        if self._values.get(parent) is None:
            self._values[parent] = nid
        return nid

    def split(self, direction="row", ratio=50, parent=None):
        """Two or more children side by side (direction "row") or stacked ("column"); the first one gets `ratio` percent (10-90).
        Several children with their own shares: split([22, 44, 34], parent=<id>) puts them side by side in those proportions
        (a list as the first argument is the weights; its direction is row)."""
        if isinstance(direction, (list, tuple)):
            weights = [int(x) for x in direction]
            if parent is None and isinstance(ratio, str):
                parent = ratio  # split([a, b, c], parent) passes the parent in the second place
            return self._node("split", parent, direction="row", weights=weights)
        return self._node("split", parent, direction=str(direction), ratio=int(ratio))

    def menubar(self, parent=None):
        """A bar of menus: add menu(title, parent=<its id>), then menuitem(text, parent=<menu id>)."""
        return self._node("menubar", parent)

    def menu(self, title, parent):
        return self._node("menu", parent, text=str(title))

    def menuitem(self, text, parent, keys=""):
        """An item of a menu; a click gives {"event": "click", "node": id}. keys is only the hint shown beside the text (for example
        "Ctrl+S"): register the real key with shortcut()."""
        fields = {"text": str(text)}
        if keys:
            fields["keys"] = str(keys)
        return self._node("menuitem", parent, **fields)

    def expander(self, text, expanded=False, parent=None):
        """A collapsible container: children take parent=<its id>. value() is True while it is open."""
        nid = self._node("expander", parent, text=str(text), expanded=bool(expanded))
        self._values[nid] = bool(expanded)
        return nid

    def editor(self, value="", lang="", rows=8, parent=None, numbers=True, prose=False, wrap=False):
        """A code and text editing surface: monospace, line numbers (numbers=False hides them), the current line highlighted, scrollbars,
        and syntax colors for lang "python", "javascript", "json", "markdown", "html" or "css" (anything else is plain). value() is its text.
        Give it grow=1 to fill its parent. prose=True uses a reading font and roomier lines (a document). caret(nid) is the user's caret or
        selection; set(nid, value=..., caret=a, caret_to=b) writes new text, moves the caret (selects a..b), focuses the editor and scrolls to it."""
        nid = self._node("editor", parent, value=str(value), lang=str(lang), rows=int(rows), numbers=bool(numbers), **({"prose": True} if prose else {}), **({"wrap": True} if wrap else {}))
        self._values[nid] = str(value)
        return nid

    def markdown(self, value="", parent=None):
        """A read-only view of Markdown text, drawn with real headings, bold, italic, lists, quotes, code and rules (the preview of a document).
        Change it with set(nid, value=...). Give it grow=1 to fill its parent."""
        return self._node("markdown", parent, value=str(value))

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

    def tree(self, columns, rows=(), selected="", parent=None):
        """A tree grid. columns: headings (text) or {"title", "width" (20-2000 px), "align" ("left", "right", "center")} dicts.
        rows: dicts in drawing order: {"id", "depth" (0-20), "cells" (one text per column), "tones" (per cell: "pass", "fail", "warn",
        "muted" or None), "bold", "expanded"}. A row with "expanded" (True or False) has children: a click on its arrow folds it (toggle
        event, value = the row id), and its deeper rows below are hidden while it is folded. A click on a row gives select (value() is
        the selected row id). At most 3000 rows. set(nid, rows=..., columns=..., selected=...) changes it."""
        nid = self._node("tree", parent, columns=_tree_cols(columns), rows=[_tree_row(r) for r in rows], selected=str(selected))
        self._values[nid] = str(selected)
        self._trees.add(nid)
        return nid

    def doc(self, blocks=(), parent=None):
        """A read-only page drawn as text. Blocks (dicts, in order):
        {"t": "title", "text", "badge", "tone"}, {"t": "p", "text", "tone"}, {"t": "h", "text"}, {"t": "pre", "text", "wrap"},
        {"t": "list", "items", "tone"}, {"t": "table", "columns", "rows"}, {"t": "kv", "rows": [[key, value, highlight, mono], ...]},
        {"t": "ref", "text", "ref"}. tone is "pass", "fail", "warn" or "muted". A click on a ref block gives a "ref" event (value = its ref).
        set(nid, blocks=...) replaces the page. One block up to 300000 characters, the whole page 400000."""
        nid = self._node("doc", parent, blocks=_doc_blocks(blocks))
        self._docs.add(nid)
        return nid

    def filepick(self, label, accept="", parent=None, multiple=False, directory=False):
        """A button that picks files: a click gives a "pick" event; then pick_files(ev) opens the chooser and returns the files.
        accept: as pick_file (".log,.txt" or "image/*"); multiple=True lets several files be chosen; directory=True picks a folder
        (every file in it that matches accept comes back)."""
        nid = self._node("filepick", parent, text=str(label))
        self._picks[nid] = {"label": str(label), "accept": str(accept), "multiple": bool(multiple), "directory": bool(directory)}
        return nid

    def pick_files(self, ev):
        """The files of a "pick" event from filepick(): (files, skipped), or None when the user cancels. files is a list of
        {"name", "path" (the name inside the folder, or the name), "size", "mime", "ref"}; ref is a path the file can be read from:
        the real path on the desktop app, and in the browser a temporary file written in the sandbox. skipped counts the files
        left out (more than 300, or bigger than 8 MB)."""
        opts = self._picks.get(ev.get("node"), {})
        r = fa_bridge.call("gui.pickmany", {"title": opts.get("label", "Files"), "accept": opts.get("accept", ""),
                                             "multiple": opts.get("multiple", False), "directory": opts.get("directory", False),
                                             "max_bytes": 8 * 1024 * 1024}, timeout=330)
        if not r:
            return None
        if r.get("error"):
            raise ValueError(r["error"])
        files = []
        for f in r.get("files", []):
            ref = f.get("realpath") or ""
            if not ref:
                ref = _write_pick(f["name"], base64.b64decode(f.get("data", "")))
            files.append({"name": f["name"], "path": f.get("rel") or f["name"], "size": int(f.get("size", 0)),
                          "mime": f.get("mime", ""), "ref": ref})
        return files, int(r.get("skipped", 0))

    def multilist(self, items, selected=(), parent=None, rows=0):
        """A list where several items can be selected. value() is the list of selected items. rows: lines shown (0 = by item count, at most 8)."""
        nid = self._node("multilist", parent, items=[str(i) for i in items], selected=[str(s) for s in selected], **({"rows": int(rows)} if rows else {}))
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

    def listbox(self, items, selected="", parent=None, rows=0):
        """A list where one item is selected. value() is the selected item's text ("" when none). rows: lines shown (0 = by item count, at most 8)."""
        return self._list_node(items, selected, parent, rows)

    def list(self, items, selected="", parent=None, rows=0):
        """The same list as listbox() (the name the Redmine template window uses): one selected item, value() is its text."""
        return self._list_node(items, selected, parent, rows)

    def _list_node(self, items, selected="", parent=None, rows=0):
        nid = self._node("list", parent, items=[str(i) for i in items], selected=str(selected), **({"rows": int(rows)} if rows else {}))
        self._values[nid] = str(selected)
        return nid

    def set(self, nid, **props):
        """Change properties of a node already added: set(btn, text="Save", enabled=False), set(box, visible=False),
        set(pb, value=40), set(lbl, text="..."). value() follows value / checked / selected."""
        if nid in self._docs and "blocks" in props:
            props["blocks"] = _doc_blocks(props["blocks"])
        if nid in self._trees:  # the same row and column shapes as tree() takes
            if "rows" in props:
                props["rows"] = [_tree_row(r) for r in props["rows"]]
            if "columns" in props:
                props["columns"] = _tree_cols(props["columns"])
            if "selected" in props:
                props["selected"] = str(props["selected"])
        fa_bridge.call("gui.set", {"id": self.id, "node": nid, "props": props})
        if "caret" in props:
            self._carets[nid] = (int(props["caret"]), int(props.get("caret_to", props["caret"])))
        for key in ("value", "checked", "selected"):
            if key in props and nid in self._values:
                self._values[nid] = props[key]
        if "rows" in props and nid in self._tables:
            self._values[nid] = [[str(c) for c in r] for r in props["rows"]]

    def theme(self, palette=None, font=None, size=None, radius=None, density=None):
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
        if density is not None:
            args["density"] = str(density)  # "compact", "normal" or "comfy": the spacing scale
        fa_bridge.call("gui.theme", args)

    def shortcut(self, keys, name):
        """Register a window shortcut. keys: "Ctrl+S", "Ctrl+Shift+Z", "Alt+Left", "F5", "Esc" (modifiers in the order Ctrl, Shift,
        Alt; a letter or digit, F1-F12, Enter, Esc, Space, Up, Down, Left or Right). When the user presses it, wait() and
        poll() return {"event": "shortcut", "value": name}. name None removes the shortcut. A key with no Ctrl or Alt is
        ignored while the user types in a text box."""
        fa_bridge.call("gui.shortcut", {"id": self.id, "keys": str(keys), "name": None if name is None else str(name)})

    def tone(self, freq=440, ms=120, wave="sine"):
        """Play a short beep in the page: freq 40-8000 Hz, ms 10-600000, wave "sine", "square", "triangle" or "sawtooth".
        It returns at once and stays silent if the page cannot play sound (nothing is raised)."""
        fa_bridge.call("gui.tone", {"id": self.id, "freq": float(freq), "ms": int(ms), "wave": str(wave)})

    def stack(self, parent=None):
        """A container whose children are drawn on top of each other in the same area (the later child on top), each filling it. Put a gl
        canvas and then a canvas(transparent=True) in it to draw a HUD (text, sliders) over a 3D view instead of beside it. The stack takes
        grow=1 like any other child to fill the window; clicks and keys go to the top canvas, so the program passes what the one below needs."""
        return self._node("stack", parent)

    def canvas(self, width=320, height=240, fps=0, parent=None, fit=False, gl=False, transparent=False):
        """A drawing area for frames (pygame uses this). draw(nid, ops) paints one whole frame. fps > 0 queues "frame" events for poll().
        fit=True keeps width x height as the drawing space and scales it (whole picture visible, centered) to fill the area the canvas is given
        (with grow=1): draw once in fixed coordinates and it fills any window size. Without fit, a canvas in a resizable window is resized to
        the window and reports "resize"."""
        extra = {}
        if transparent:
            extra["transparent"] = True   # a 2D canvas that starts every frame empty (not black), to draw over what is under it
        if fit:
            extra["fit"] = True
        if gl:
            # gl=True: a WebGL2 canvas. It is drawn with glbuf / glprog / glframe (see gl3d.py, which wraps them), not with draw().
            extra["gl"] = True
        return self._node("canvas", parent, width=int(width), height=int(height), fps=int(fps), **extra)

    def glbuf(self, nid, name, data, kind="f32"):
        """Upload (or replace) a named buffer on a gl canvas. data: bytes, array.array, a numpy array or a list of numbers; kind "f32"
        (vertex data), "u16" or "u32" (indices). At most 4 MB per buffer and 24 buffers per canvas. data=None removes the buffer."""
        if data is None:
            fa_bridge.call("gui.glbuf", {"id": self.id, "node": nid, "name": name, "data": None})
            return
        raw = _gl_bytes(data, kind)
        fa_bridge.call("gui.glbuf", {"id": self.id, "node": nid, "name": name, "type": kind, "data": base64.b64encode(raw).decode("ascii")})

    def glprog(self, nid, name, vs, fs):
        """Register a named GLSL ES 3.00 program (vertex and fragment source, each starting with "#version 300 es"; at most 12 per canvas).
        A compile or link error comes back later as a "glerror" event on the canvas (the page compiles it when it draws)."""
        fa_bridge.call("gui.glprog", {"id": self.id, "node": nid, "name": name, "vs": vs, "fs": fs})

    def glframe(self, nid, cmds):
        """Draw one frame on a gl canvas: a list of at most 256 commands, in order. ["clear", r, g, b, a] (0..1, clears color and depth),
        ["state", "depth"|"blend"|"additive"|"cull", 0|1] (blend: alpha blending; additive: glow, overlapping sprites add up), ["use", program], ["uf", uniform, v...] (1, 2, 3, 4, 9 or 16 floats: float, vec2, vec3,
        vec4, mat3, mat4), ["ui", uniform, int], ["attr", attribute, buffer, size, strideBytes, offsetBytes, divisor], ["index", buffer] (used by the next draw only),
        ["draw", "points"|"lines"|"line_strip"|"triangles"|"triangle_strip", first, count, instances]."""
        fa_bridge.call("gui.glframe", {"id": self.id, "node": nid, "cmds": cmds})

    def draw(self, nid, ops):
        """Paint one frame on a canvas. ops: lists such as ["rect", x, y, w, h, "#rrggbb"], ["circle", x, y, r, color],
        ["line", x1, y1, x2, y2, color], ["text", x, y, text, color], ["clear", color], ["image", name, x, y, w, h]. Any number of ops (up to 100000 in one frame); the page measures how long a frame takes and paints
        big frames at most once per screen refresh, so a program does not have to count its commands."""
        fa_bridge.call("gui.draw", {"id": self.id, "node": nid, "ops": ops})

    def image(self, nid, data, mime, name=None):
        """Register a picture (PNG, JPEG, GIF or WebP bytes, any size) on a canvas. Returns (name, w, h): draw it with
        ["image", name, x, y] or ["image", name, x, y, w, h] or ["image", name, x, y, w, h, flip_x, flip_y] (flip flags 0 or 1).
        name (optional, letters, digits, _ and -, at most 40): registering the same name again replaces the picture and does not count
        against the 16 pictures of a canvas, so a program can redraw a rendered picture every frame. The page decodes it; a picture it
        cannot decode raises an error."""
        if name is None:
            self._images += 1
            name = "i%d" % self._images
        name = str(name)
        if len(data) <= _IMAGE_PART:
            url = "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))
            size = fa_bridge.call("gui.image", {"id": self.id, "node": nid, "name": name, "data": url})
            return name, int(size["w"]), int(size["h"])
        # a big picture goes in parts of 3 MB (whole 3-byte groups, so each part is plain base64); the page puts them together
        kind = mime.split("/")[-1].lower()
        parts = (len(data) + _IMAGE_PART - 1) // _IMAGE_PART
        size = None
        for i in range(parts):
            piece = base64.b64encode(data[i * _IMAGE_PART:(i + 1) * _IMAGE_PART]).decode("ascii")
            size = fa_bridge.call("gui.image", {"id": self.id, "node": nid, "name": name, "mime": kind, "part": i, "parts": parts, "chunk": piece})
        return name, int(size["w"]), int(size["h"])

    def poll(self):
        """The next queued event now, or None. Never waits. Key events come as {"event": "key", "value": {"key", "down"}}."""
        ev = fa_bridge.call("gui.poll", {"id": self.id})
        if ev is None:
            return None
        if ev.get("event") == "caret":
            self._store_caret(ev)
        elif ev.get("event") in ("input", "cell", "toggle", "select", "change"):
            self._event_value(ev)
        if ev.get("event") == "close":
            self.closed = True
        return ev

    def value(self, nid):
        """The current value of a widget: entry text, editor text, table rows, expander open flag, multilist selection."""
        return self._values.get(nid)

    def _store_caret(self, ev):
        v = ev.get("value") or {}
        self._carets[ev.get("node")] = (int(v.get("start", 0)), int(v.get("end", 0)))

    def caret(self, nid):
        """The user's caret or selection in an editor as (start, end) character offsets into value(nid); both are the end of the text until the
        user has clicked into it. Reported by the page as "caret" events (poll() returns them, wait() takes them in)."""
        c = self._carets.get(nid)
        if c is None:
            n = len(self._values.get(nid) or "")
            return (n, n)
        n = len(self._values.get(nid) or "")
        return (min(c[0], n), min(c[1], n))

    def _event_value(self, ev):
        """Store a value-changing event (input, cell, toggle, select) in value()."""
        kind = ev.get("event")
        node = ev.get("node")
        if kind == "toggle" and node in self._trees:
            return  # folding a tree row does not change its value (the selected row is the value)
        if kind == "cell":
            cell = ev.get("value") or {}
            self._values[node][cell["row"]][cell["col"]] = cell.get("text")
        else:
            self._values[node] = ev.get("value")

    def wait(self, timeout=300, also=()):
        """Block until a button is clicked or the window is closed. Returns the event dict, or None on timeout.
        also: names of value events ("select", "change", "input", "cell", "toggle") that end the wait too (value() is updated either way).
        By default wait() only returns for clicks, shortcuts and the close."""
        import time
        end = time.time() + float(timeout)
        also = tuple(also or ())
        while True:
            left = end - time.time()
            if left <= 0:
                return None
            ev = fa_bridge.call("gui.wait", {"id": self.id, "timeout": left}, timeout=left + 15)
            if ev is None:
                return None
            kind = ev.get("event")
            if kind == "caret":
                self._store_caret(ev)
                continue
            if kind in ("input", "cell", "toggle", "select", "change"):
                self._event_value(ev)
                if kind in also:
                    return ev
                continue
            if kind == "close":
                self.closed = True
            return ev

    def close(self):
        if not self.closed:
            self.closed = True
            fa_bridge.call("gui.close", {"id": self.id})


# Every node method also takes these look and layout keywords: grow (0-10, the share of the free space in the parent: a row grows sideways,
# a column downwards; the window body fills a resizable window), gap and pad (0-32 pixels, space between the children and inside), and role
# (the design system's look: toolbar, sidebar, statusbar, card, panel, heading, title, muted, primary, danger, surface, group, divider, outline, page).
# Example: w.editor(parent=col, grow=1); bar = w.row(role="toolbar").
_STYLE_KEYS = ("grow", "gap", "pad", "role")


def _gl_bytes(data, kind):
    """Bytes for a gl buffer from bytes, array.array, a numpy array or a list (float32 for f32, uint16 for u16, uint32 for u32)."""
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    code = {"f32": "f", "u16": "H", "u32": "I"}.get(kind)
    if code is None:
        raise ValueError("kind must be f32, u16 or u32")
    tobytes = getattr(data, "tobytes", None)
    if tobytes is not None and not isinstance(data, array_mod.array):
        # numpy: make sure the dtype is the one the buffer wants
        want = {"f32": "float32", "u16": "uint16", "u32": "uint32"}[kind]
        if getattr(data, "dtype", None) is not None and str(data.dtype) != want:
            data = data.astype(want)
        return data.tobytes()
    if isinstance(data, array_mod.array):
        if data.typecode == code:
            return data.tobytes()
        return array_mod.array(code, list(data)).tobytes()
    return array_mod.array(code, [float(v) if code == "f" else int(v) for v in data]).tobytes()


def _styled(fn):
    def wrapper(self, *args, **kwargs):
        style = {}
        for k in _STYLE_KEYS:
            if k in kwargs:
                v = kwargs.pop(k)
                if v is not None:
                    style[k] = v if k == "role" else float(v)
                    if k == "role":
                        style[k] = str(v)
        self._style = style
        try:
            return fn(self, *args, **kwargs)
        finally:
            self._style = {}
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


for _name in ("label", "button", "entry", "row", "column", "grid", "scroll", "tabs", "tab", "split", "menubar", "menu", "menuitem", "expander",
              "editor", "table", "multilist", "textarea", "checkbox", "progress", "listbox", "list", "tree", "doc", "filepick", "canvas", "markdown", "stack"):
    setattr(Window, _name, _styled(getattr(Window, _name)))


_PICK_DIR = []


def _write_pick(name, data):
    """A picked file's bytes in a temporary file of this sandbox (the browser has no real path); returns its path."""
    import tempfile
    if not _PICK_DIR:
        _PICK_DIR.append(tempfile.mkdtemp(prefix="fa_pick_"))
    safe = [p for p in str(name).replace("\\", "/").split("/") if p not in ("", ".", "..")]
    path = os.path.join(_PICK_DIR[0], "%d_%s" % (len(os.listdir(_PICK_DIR[0])), "_".join(safe) or "file"))
    with open(path, "wb") as f:
        f.write(data)
    return path


def _doc_blocks(blocks):
    # plain JSON data (tuples become lists), so the page gets exactly what it would from a JSON message
    return json.loads(json.dumps(list(blocks)))


def _tree_cols(columns):
    return [c if isinstance(c, dict) else {"title": str(c)} for c in columns]


def _tree_row(r):
    out = {"id": str(r["id"]), "depth": int(r.get("depth", 0)), "cells": [str(c) for c in r.get("cells", [])]}
    if "tones" in r:
        out["tones"] = [None if t is None else str(t) for t in r["tones"]]
    if r.get("bold"):
        out["bold"] = True
    if "expanded" in r:
        out["expanded"] = bool(r["expanded"])
    return out


def pick_file(title="Choose a file", accept="", max_bytes=None):
    """Ask the user to choose a file. The page shows a small panel with a button (the browser or desktop file chooser opens when the user
    presses it). Returns None when the user cancels, else {"name", "size", "mime", "data" (bytes), "path"} - path is the real path on the
    desktop app and "" in the browser. accept is an html accept text such as "image/*" or ".txt,.md"; max_bytes (default None = no limit)
    is only for a program that wants to refuse a bigger file: a file bigger than it raises ValueError. To show a picture on a canvas use
    Window.image(canvas, data, mime) (any size)."""
    r = fa_bridge.call("gui.pickfile", {"title": str(title), "accept": str(accept), "max_bytes": int(max_bytes) if max_bytes else 0}, timeout=330)
    if not r:
        return None
    if r.get("error"):
        raise ValueError(r["error"])
    return {"name": r["name"], "size": int(r["size"]), "mime": r["mime"], "data": base64.b64decode(r["data"]), "path": r.get("path", "")}


def usertpl(action, id=None, jsonl=None, py=None):
    """The user's own GUI templates kept by the page. "list" -> {id: {"jsonl", "py"}}; "save" stores one pair (id must be user/...);
    "delete" removes one. Used by guitpl (catalog, run) and the design studio; there is no page behind a plain python run (it raises)."""
    return fa_bridge.call("gui.usertpl", {"action": str(action), "id": id, "jsonl": jsonl, "py": py})


def _dialog(title, text, buttons, entry=None, width=340):
    """A small modal window: shows text (and an entry when entry is a string), waits for one of the buttons. Returns (button index, entry text)
    or (None, None) when the user closed the window."""
    w = Window(title, width=width)
    w.label(text)
    box = w.entry(entry) if entry is not None else None
    row = w.row()
    ids = [w.button(b, parent=row) for b in buttons]
    result = (None, None)
    while True:
        ev = w.wait(timeout=300)
        if ev is None:
            continue
        if ev.get("event") == "close":
            break
        if ev.get("event") == "click" and ev.get("node") in ids:
            result = (ids.index(ev["node"]), w.value(box) if box else None)
            break
    w.close()
    return result


def message(text, title="Message", ok="OK"):
    """Show a message in a small window and wait until the user presses the button (or closes it)."""
    _dialog(title, text, [ok])


def confirm(text, title="Confirm", yes="Yes", no="No"):
    """Ask a yes/no question in a small window. True for the first button; False for the second button or closing the window."""
    return _dialog(title, text, [yes, no])[0] == 0


def ask(text, default="", title="Input", ok="OK", cancel="Cancel"):
    """Ask for one line of text in a small window. Returns the text, or None when the user cancels or closes the window."""
    index, value = _dialog(title, text, [ok, cancel], entry=str(default))
    return value if index == 0 else None
