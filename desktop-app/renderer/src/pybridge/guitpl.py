# -*- coding: utf-8 -*-
"""
guitpl -- GUI design templates: one `<name>.jsonl` plus one `<name>.py` is a component (see DESIGN.gui-templates.md section 4).

    import guitpl
    guitpl.run("demo/hello", roots=["/templates"])           # load, resolve slots, check, build the window, run the events

A JSONL file has one record per line; the first field `kind` says what it is:
  meta     {"kind":"meta","id":"office/toolbar_basic","title":"..","keywords":[..],"entry":"build","extends":"other/id"}
  param    {"kind":"param","name":"title","default":"..","ask":"question to ask the user"}   {{name}} in text is replaced
  style    {"kind":"style","palette":{bg,fg,accent,danger,muted},"font":"..","size":14,"radius":4}
  layout   {"kind":"layout","window":{"title":"..","width":400,"resizable":true},"tree":[nodes]}   a node {"slot":"toolbar"} is a hole
  slot     {"kind":"slot","name":"toolbar","use":"office/toolbar_basic","params":{..}}          another component fills the hole
  scene    {"kind":"scene","id":"main","title":"..","show":[names],"hide":[names],"on":{"click:next":"second"}}
  shortcut {"kind":"shortcut","keys":"Ctrl+S","do":"save"}                                         handler key "shortcut:save"
  call     {"kind":"call","on":"click:export","file":"user_ext.py","function":"on_export","args":{}}   a foreign call into any .py
  require  {"kind":"require","module":"gui","source":"builtin|pyodide|micropip|file","version":"..","optional":false}
The `.py` of a component has `build(win, spec, slots)` (the name is meta.entry): it returns a dict, and a "handlers" entry
{"click:save": fn(ctx)} wires events. Customizing a component = a new pair whose meta has "extends" and only the lines to
change (a line with the same key replaces the base's line). Every error is a GuiTplError with a Chinese message.
"""
import ast
import importlib
import importlib.util
import json
import os
import sys
import time

KINDS = ("meta", "param", "style", "layout", "slot", "scene", "shortcut", "call", "require")
SOURCES = ("builtin", "pyodide", "micropip", "file")
# the key of a record: a line with the same (kind, key) in an extending component replaces the base's line
KEYS = {"param": "name", "slot": "name", "scene": "id", "shortcut": "keys", "require": "module", "call": "id"}
# node kind -> (gui.Window method, positional props in order, keyword props)
NODES = {
    "column": ("column", [], []), "row": ("row", [], []),
    "grid": ("grid", [], ["columns"]), "scroll": ("scroll", [], ["height"]),
    "expander": ("expander", ["text"], ["expanded"]), "label": ("label", ["text"], []), "button": ("button", ["text"], []),
    "entry": ("entry", ["value"], []), "textarea": ("textarea", ["value"], ["rows", "placeholder"]),
    "editor": ("editor", ["value"], ["lang", "rows"]), "checkbox": ("checkbox", ["text"], ["checked"]),
    "progress": ("progress", ["value"], ["max"]), "list": ("listbox", ["items"], ["selected"]),
    "multilist": ("multilist", ["items"], ["selected"]), "table": ("table", ["columns", "rows"], []),
    "canvas": ("canvas", [], ["width", "height", "fps"]),
}
DEFAULTS = {"text": "", "value": "", "items": [], "columns": [], "rows": []}
AFTER = ("enabled", "visible")
IGNORED_IMPORTS = ("__future__",)


class GuiTplError(Exception):
    pass


def _stdlib(name):
    names = getattr(sys, "stdlib_module_names", None)
    if names is not None:
        return name in names
    return name in sys.builtin_module_names


def _subst(value, params):
    """Replace {{name}} in every string of a JSON value."""
    if isinstance(value, str):
        for k, v in params.items():
            value = value.replace("{{%s}}" % k, str(v))
        return value
    if isinstance(value, list):
        return [_subst(v, params) for v in value]
    if isinstance(value, dict):
        return {k: _subst(v, params) for k, v in value.items()}
    return value


def default_roots():
    """The template library that ships with the app: the guitpl_lib folder next to this file (in the emulator, /fa_pybridge/guitpl_lib)."""
    return [os.path.join(os.path.dirname(os.path.abspath(__file__)), "guitpl_lib")]


class Library(object):
    def __init__(self, roots=None):
        if not roots:
            roots = default_roots()
        if isinstance(roots, str):
            roots = [roots]
        self.roots = [str(r) for r in roots]

    def path(self, cid, ext):
        for r in self.roots:
            p = os.path.join(r, *cid.split("/")) + ext
            if os.path.isfile(p):
                return p
        return None

    def read(self, cid):
        """The checked records of a component's JSONL file (list of dicts)."""
        p = self.path(cid, ".jsonl")
        if p is None:
            raise GuiTplError("找不到範本 %s（找過：%s）" % (cid, "、".join(self.roots)))
        records = []
        with open(p, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                s = line.strip()
                if not s or s.startswith("#"):
                    continue
                try:
                    rec = json.loads(s)
                except ValueError as e:
                    raise GuiTplError("%s 第 %d 行不是合法的 JSON：%s" % (cid, n, e))
                if not isinstance(rec, dict) or rec.get("kind") not in KINDS:
                    raise GuiTplError("%s 第 %d 行的 kind 必須是 %s 之一" % (cid, n, "、".join(KINDS)))
                rec["_line"] = n
                self._check(cid, n, rec)
                records.append(rec)
        if not any(r["kind"] == "meta" for r in records):
            raise GuiTplError("%s 缺少 meta 紀錄" % cid)
        return records

    def _check(self, cid, n, rec):
        k = rec["kind"]
        def need(*fields):
            for f in fields:
                if f not in rec:
                    raise GuiTplError("%s 第 %d 行（%s）缺少欄位 %s" % (cid, n, k, f))
        if k == "meta":
            need("id")
        elif k == "param":
            need("name", "default")
        elif k == "slot":
            need("name", "use")
        elif k == "scene":
            need("id", "title")
        elif k == "shortcut":
            need("keys", "do")
        elif k == "call":
            need("on", "file", "function")
        elif k == "layout":
            need("tree")
            if not isinstance(rec["tree"], list):
                raise GuiTplError("%s 第 %d 行 layout.tree 必須是陣列" % (cid, n))
        elif k == "require":
            need("module", "source")
            if rec["source"] not in SOURCES:
                raise GuiTplError("%s 第 %d 行 require.source 必須是 %s 之一" % (cid, n, "、".join(SOURCES)))

    def load(self, cid, _stack=()):
        """A component: its records with `extends` applied and every slot loaded (recursively, cycles refused)."""
        if cid in _stack:
            raise GuiTplError("循環引用：" + " → ".join(list(_stack) + [cid]))
        stack = _stack + (cid,)
        records = self.read(cid)
        meta = [r for r in records if r["kind"] == "meta"][0]
        if meta.get("extends"):
            base = self.load_records(meta["extends"], stack)
            records = self._override(base, records)
            meta = dict(base["meta"], **{k: v for k, v in meta.items() if k != "_line"})
        comp = {"id": cid, "meta": meta, "dir": os.path.dirname(self.path(cid, ".jsonl")), "pyfile": self.path(cid, ".py"),
                "params": {}, "style": {}, "layout": None, "slots": {}, "scenes": [], "shortcuts": [], "calls": [], "requires": [],
                "records": records}
        for r in records:
            k = r["kind"]
            if k == "param":
                comp["params"][r["name"]] = r
            elif k == "style":
                comp["style"] = self._merge_style(comp["style"], r)
            elif k == "layout":
                comp["layout"] = r
            elif k == "slot":
                comp["slots"][r["name"]] = r
            elif k == "scene":
                comp["scenes"].append(r)
            elif k == "shortcut":
                comp["shortcuts"].append(r)
            elif k == "call":
                comp["calls"].append(r)
            elif k == "require":
                comp["requires"].append(r)
        comp["children"] = {name: self.load(r["use"], stack) for name, r in comp["slots"].items()}
        return comp

    def load_records(self, cid, stack):
        if cid in stack:
            raise GuiTplError("循環引用（extends）：" + " → ".join(list(stack) + [cid]))
        records = self.read(cid)
        meta = [r for r in records if r["kind"] == "meta"][0]
        if meta.get("extends"):
            base = self.load_records(meta["extends"], stack + (cid,))
            records = self._override(base, records)
            meta = dict(base["meta"], **{k: v for k, v in meta.items() if k != "_line"})
        return {"records": records, "meta": meta}

    @staticmethod
    def _merge_style(a, b):
        out = dict(a)
        for k, v in b.items():
            if k in ("kind", "_line"):
                continue
            if k == "palette" and isinstance(v, dict):
                out["palette"] = dict(out.get("palette", {}), **v)
            else:
                out[k] = v
        return out

    @staticmethod
    def _override(base, own):
        """base: {"records"}; own: records of the extending file. Same (kind, key) replaces; singular kinds (layout, style, meta) replace."""
        def key(r):
            k = r["kind"]
            if k in KEYS:
                v = r.get(KEYS[k])
                return (k, v if v is not None else "#%d" % r["_line"])
            return (k, None)
        out = []
        index = {}
        for r in base["records"]:
            if r["kind"] == "meta":
                continue
            index[key(r)] = len(out)
            out.append(r)
        for r in own:
            if r["kind"] == "meta":
                continue
            kk = key(r)
            if kk in index and r["kind"] != "style":
                out[index[kk]] = r
            elif kk in index:  # style: merge instead of replace
                out[index[kk]] = dict(out[index[kk]], **{k: v for k, v in r.items() if k != "palette"})
                if "palette" in r:
                    out[index[kk]]["palette"] = dict(out[index[kk]].get("palette", {}), **r["palette"])
            else:
                index[kk] = len(out)
                out.append(r)
        meta = [r for r in own if r["kind"] == "meta"][0]
        return [meta] + out


# ---------- parameters, requirements, checks ----------

def bind_params(comp, given=None):
    """The component's parameter values: defaults, overridden by `given` (unknown names are an error)."""
    given = dict(given or {})
    values = {}
    for name, rec in comp["params"].items():
        values[name] = given.pop(name, rec["default"])
    if given:
        raise GuiTplError("範本 %s 沒有這些參數：%s（有的參數：%s）" % (comp["id"], "、".join(sorted(given)), "、".join(comp["params"]) or "無"))
    return values


def collect_requires(comp, seen=None):
    """Every require of the component tree, one entry per module: {module: {"source","version","optional","by":[ids]}}."""
    out = {} if seen is None else seen
    for r in comp["requires"]:
        m = r["module"]
        cur = out.get(m)
        if cur is None:
            out[m] = {"source": r["source"], "version": r.get("version", ""), "optional": bool(r.get("optional", False)), "by": [comp["id"]]}
        else:
            cur["by"].append(comp["id"])
            cur["optional"] = cur["optional"] and bool(r.get("optional", False))
    for child in comp["children"].values():
        collect_requires(child, out)
    return out


def _imports_of(pyfile):
    with open(pyfile, encoding="utf-8") as f:
        tree = ast.parse(f.read(), pyfile)
    mods = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                mods.add(a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            mods.add(node.module.split(".")[0])
    return mods - set(IGNORED_IMPORTS)


def check(comp, available=None):
    """Chinese error messages (empty when fine): a .py that imports what its JSONL does not declare, a declared module the
    emulator does not have, a missing .py, a missing file-source module. `available(module, source)` may replace the default test."""
    errors = []
    def have(module, source):
        if available is not None:
            return available(module, source)
        if module in sys.modules:
            return True
        try:
            return importlib.util.find_spec(module) is not None
        except (ImportError, ValueError):
            return False
    def walk(c):
        if not c["pyfile"]:
            errors.append("範本 %s 缺少同名的 .py 檔（一個 jsonl 要配一個 py）" % c["id"])
        else:
            try:
                declared = set(r["module"] for r in c["requires"])
                files = set(os.path.splitext(r["module"])[0] for r in c["requires"] if r["source"] == "file")
                for m in sorted(_imports_of(c["pyfile"])):
                    if m not in declared and m not in files:
                        errors.append("範本 %s 的 %s 用了 %s，但 jsonl 沒有宣告（要加 require 紀錄）" % (c["id"], os.path.basename(c["pyfile"]), m))
            except SyntaxError as e:
                errors.append("範本 %s 的 .py 有語法錯誤：%s" % (c["id"], e))
        for r in c["requires"]:
            m, src = r["module"], r["source"]
            if r.get("optional"):
                continue
            if src == "file":
                f = os.path.join(c["dir"], m if m.endswith(".py") else m + ".py")
                if not os.path.isfile(f):
                    errors.append("範本 %s 需要自己的檔案 %s，但找不到" % (c["id"], os.path.basename(f)))
            elif src == "builtin":
                if not (_stdlib(m) or have(m, src)):
                    errors.append("範本 %s 需要 %s（內建），但模擬器裡沒有" % (c["id"], m))
            elif not have(m, src):
                errors.append("範本 %s 需要套件 %s（來源 %s），目前模擬器裡沒有" % (c["id"], m, src))
        for child in c["children"].values():
            walk(child)
    walk(comp)
    return errors


# ---------- run ----------

class Ctx(object):
    def __init__(self, win, ids, state, scenes):
        self.w = win
        self.ids = ids
        self.state = state
        self.event = None
        self.running = True
        self._scenes = scenes
        self.scene = None

    def id(self, name):
        return self.ids[name]

    def get(self, name):
        return self.w.value(self.ids[name])

    def set(self, name, **props):
        self.w.set(self.ids[name], **props)

    def tone(self, freq=440, ms=120, wave="sine"):
        self.w.tone(freq, ms, wave)

    def quit(self):
        self.running = False

    def goto(self, scene_id):
        for s in self._scenes:
            if s["id"] == scene_id:
                self.scene = scene_id
                for name in s.get("show", []):
                    self.set(name, visible=True)
                for name in s.get("hide", []):
                    self.set(name, visible=False)
                return
        raise GuiTplError("沒有這個場景：%s" % scene_id)

    def error(self, message):
        sys.stderr.write("[guitpl] %s\n" % message)


def _build_nodes(win, nodes, parent, ids, children, comp_params, slot_results, lib_children, builders):
    for n in nodes:
        if "slot" in n:
            name = n["slot"]
            holder = win.column(parent=parent)
            if name in lib_children:
                builders.append((name, lib_children[name], holder))
            continue
        spec = NODES.get(n.get("kind"))
        if spec is None:
            raise GuiTplError("不認得的節點種類 %s" % n.get("kind"))
        method, positional, keywords = spec
        args = [n[p] if p in n else DEFAULTS.get(p, "") for p in positional]
        kwargs = {k: n[k] for k in keywords if k in n}
        if parent:
            kwargs["parent"] = parent
        nid = getattr(win, method)(*args, **kwargs)
        if n.get("id"):
            if n["id"] in ids:
                raise GuiTplError("節點名稱重複：%s" % n["id"])
            ids[n["id"]] = nid
        extra = {k: n[k] for k in AFTER if k in n}
        if extra:
            win.set(nid, **extra)
        if n.get("children"):
            _build_nodes(win, n["children"], nid, ids, children, comp_params, slot_results, lib_children, builders)


def _entry(comp):
    import_name = "guitpl_comp_" + comp["id"].replace("/", "_").replace("-", "_")
    spec = importlib.util.spec_from_file_location(import_name, comp["pyfile"])
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fn = getattr(mod, comp["meta"].get("entry", "build"), None)
    if fn is None:
        raise GuiTplError("範本 %s 的 %s 裡沒有進入函式 %s" % (comp["id"], os.path.basename(comp["pyfile"]), comp["meta"].get("entry", "build")))
    return fn


def prepare(cid, params=None, roots=None, available=None):
    """Load, bind parameters, and check. Returns the component (raises GuiTplError with every problem listed)."""
    lib = Library(roots)
    comp = lib.load(cid)
    errors = check(comp, available)
    if errors:
        raise GuiTplError("；".join(errors))
    return comp


def catalog(roots=None, query=None):
    """The ready-made templates: [{"id","title","keywords","standalone","params":[{"name","default","ask"}],"scenes":[ids]}] (standalone
    ones are whole apps; the others are parts). With query, only those whose title, keywords or id share a word with it, best first."""
    lib = Library(roots)
    ids = []
    for root in lib.roots:
        for base, _dirs, files in os.walk(root):
            for f in sorted(files):
                if f.endswith(".jsonl"):
                    ids.append(os.path.relpath(os.path.join(base, f), root)[:-6].replace(os.sep, "/"))
    out = []
    for cid in sorted(set(ids)):
        try:
            comp = lib.load(cid)
        except GuiTplError:
            continue
        out.append({"id": cid, "title": comp["meta"].get("title", cid), "keywords": comp["meta"].get("keywords", []),
                    "standalone": bool(comp["meta"].get("standalone")),
                    "params": [{"name": n, "default": r["default"], "ask": r.get("ask", "")} for n, r in comp["params"].items()],
                    "scenes": [s["id"] for s in comp["scenes"]]})
    if query:
        q = str(query).lower()
        scored = []
        for e in out:
            score = sum(1 for w in list(e["keywords"]) + [e["title"], e["id"].split("/")[0]] if str(w).lower() and str(w).lower() in q)
            if score:
                scored.append((-score, e["id"], e))
        out = [e for _s, _i, e in sorted(scored)]
    return out


def storyboard(comp):
    """The scenes of a component as plain data: [{"id","title","note","show","hide","on"}]."""
    return [{"id": s["id"], "title": s["title"], "note": s.get("note", ""), "show": s.get("show", []), "hide": s.get("hide", []),
             "on": s.get("on", {})} for s in comp["scenes"]]


def run(cid, params=None, roots=None, available=None, loop=True, window=None):
    """Load a component, check it, build its window, wire shortcuts, scenes and handlers, and run the event loop.
    Returns {"win","ids","state","component","scene"} when the window closes (or at once with loop=False)."""
    comp = prepare(cid, params, roots, available)
    import gui
    values = bind_params(comp, params)
    layout = comp["layout"]
    if layout is None:
        raise GuiTplError("範本 %s 沒有 layout 紀錄，不能執行" % cid)
    layout = _subst(layout, values)
    style = _subst(comp["style"], values)
    window_spec = layout.get("window", {})
    win = window or gui.Window(window_spec.get("title", comp["meta"].get("title", cid)), width=window_spec.get("width", 360),
                               resizable=bool(window_spec.get("resizable", False)), maximizable=bool(window_spec.get("maximizable", False)))
    if style:
        win.theme(palette=style.get("palette"), font=style.get("font"), size=style.get("size"), radius=style.get("radius"))
    ids = {}
    builders = []
    slot_names = {name: child for name, child in comp["children"].items()}
    _build_nodes(win, layout["tree"], None, ids, None, values, None, slot_names, builders)
    state = {}
    handlers = {}
    scenes = [dict(s) for s in comp["scenes"]]

    # children: build their layout into the holders (recursively), then call every entry bottom-up
    results = {}
    def mount(c, c_values, parent_holder, c_builders):
        child_results = {}
        for (name, child, holder) in c_builders:
            slot_rec = c["slots"][name]
            child_values = bind_params(child, _subst(slot_rec.get("params", {}), c_values))
            child_layout = _subst(child["layout"], child_values) if child["layout"] else {"tree": []}
            sub = []
            _build_nodes(win, child_layout["tree"], holder, ids, None, child_values, None, child["children"], sub)
            child_results[name] = mount(child, child_values, holder, sub)
        spec = {"id": c["id"], "params": c_values, "style": c["style"], "meta": c["meta"], "scenes": c["scenes"]}
        for sc in c["shortcuts"]:
            win.shortcut(sc["keys"], sc["do"])
        out = {}
        if c["pyfile"]:
            out = _entry(c)(win, spec, child_results) or {}
        for key, fn in (out.get("handlers") or {}).items():
            handlers[key] = fn
        return out
    mount(comp, values, None, builders)
    ctx = Ctx(win, ids, state, scenes)
    if scenes:
        ctx.goto(scenes[0]["id"])
    if not loop:
        return {"win": win, "ids": ids, "state": state, "component": comp, "scene": ctx.scene, "ctx": ctx, "handlers": handlers}
    by_id = {v: k for k, v in ids.items()}
    calls = {}
    for c in comp["calls"]:
        calls.setdefault(c["on"], []).append(c)
    while ctx.running:
        ev = win.poll()
        if ev is None:
            time.sleep(0.02)
            continue
        if ev.get("event") == "close":
            break
        key = ("shortcut:%s" % ev.get("value")) if ev.get("event") == "shortcut" else "%s:%s" % (ev.get("event"), by_id.get(ev.get("node"), ev.get("node")))
        ctx.event = ev
        _dispatch(ctx, comp, key, handlers, calls)
    win.close()
    return {"win": win, "ids": ids, "state": state, "component": comp, "scene": ctx.scene}


def _dispatch(ctx, comp, key, handlers, calls):
    for s in ctx._scenes:
        if s["id"] == ctx.scene and key in s.get("on", {}):
            ctx.goto(s["on"][key])
    fn = handlers.get(key)
    if fn is not None:
        fn(ctx)
    for c in calls.get(key, []):
        path = os.path.join(comp["dir"], c["file"])
        if not os.path.isfile(path):
            ctx.error("外部呼叫找不到檔案 %s（範本 %s）" % (c["file"], comp["id"]))
            continue
        try:
            spec = importlib.util.spec_from_file_location("guitpl_call_" + os.path.splitext(os.path.basename(path))[0], path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            target = getattr(mod, c["function"], None)
            if target is None:
                ctx.error("外部呼叫的檔案 %s 裡沒有函式 %s" % (c["file"], c["function"]))
                continue
            target(ctx, **c.get("args", {}))
        except Exception as e:  # 外部程式出錯不能讓整個程式掛掉
            ctx.error("外部呼叫 %s:%s 出錯：%s: %s" % (c["file"], c["function"], type(e).__name__, e))
