// computer-use-atspi.js —— Linux 的「Spy++」：用 AT-SPI（python3 的 gi.repository.Atspi）讀取 GTK／Qt／Electron（要 --force-renderer-accessibility）／Java 應用程式的元件樹。
// 做法：把一支 python 小程式（下面的 PY_HELPER）用 `python3 -c` 執行，請求用 stdin 傳 JSON、結果從 stdout 讀 JSON。
// 能做的事：apps／windows／tree（角色、名稱、說明、狀態、螢幕座標、動作、文字／值、子節點）／find／elementAt／focused／act（invoke、toggle、select、focus、set_value）。
// 元件 id＝"atspi:<pid>:<從應用程式往下的 child 索引路徑>:<role|name 指紋>"：同一次快照內穩定、之後可以靠路徑＋指紋重新解析（指紋對不上就依 role＋name 在子樹裡重找）。
"use strict";
const E = require("./computer-use-elements.js");

// 這個 python 在請求裡的 op 有：probe／apps／windows／tree／find／at／focused／act
const PY_HELPER = String.raw`
import sys, json, time
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception as e:
    sys.stdout.write(json.dumps({"ok": False, "error": "import: " + str(e)}))
    sys.exit(0)

req = json.loads(sys.stdin.read() or '{}')
op = req.get('op')
DEADLINE = time.time() + float(req.get('deadline_s', 8))
MAXN = int(req.get('max_nodes', 800))
SCREEN = Atspi.CoordType.SCREEN
STATE_NAMES = {}
try:
    for st in Atspi.StateType.__enum_values__.values():
        STATE_NAMES[int(st)] = st.value_nick.replace('-', '_')
except Exception:
    pass

def fp_of(role, name):
    h = 2166136261
    for b in (str(role) + '|' + str(name or '')).encode('utf-8')[:120]:
        h ^= b
        h = (h * 16777619) & 0xffffffff
    return ('%08x' % h)[:6]

def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default

def role_of(a):
    return safe(lambda: a.get_role_name(), '') or ''

def states_of(a):
    ss = safe(lambda: a.get_state_set())
    out = []
    if ss is None:
        return out
    for i, nm in STATE_NAMES.items():
        if nm in ('invalid', 'last_defined'):
            continue
        if safe(lambda: ss.contains(Atspi.StateType(i)), False):
            out.append(nm)
    return out

def rect_of(a):
    r = safe(lambda: Atspi.Component.get_extents(a, SCREEN))
    if r is None:
        return None
    return {"x": r.x, "y": r.y, "w": r.width, "h": r.height}

def ifaces_of(a):
    return safe(lambda: list(Atspi.Accessible.get_interfaces(a)), []) or []

def actions_of(a, ifs):
    if 'Action' not in ifs:
        return []
    n = safe(lambda: Atspi.Action.get_n_actions(a), 0) or 0
    return [safe(lambda i=i: Atspi.Action.get_action_name(a, i), '') for i in range(min(n, 8))]

def text_of(a, ifs):
    if 'Text' not in ifs:
        return None
    n = safe(lambda: Atspi.Text.get_character_count(a), 0) or 0
    if n <= 0:
        return ''
    return safe(lambda: Atspi.Text.get_text(a, 0, min(n, 400)), None)

def value_of(a, ifs):
    if 'Value' not in ifs:
        return None
    return safe(lambda: Atspi.Value.get_current_value(a), None)

def node_of(a, path, with_detail=True):
    ifs = ifaces_of(a)
    role = role_of(a)
    sts = states_of(a)
    n = {"path": path, "role": role, "name": safe(lambda: a.get_name(), '') or '', "description": safe(lambda: a.get_description(), '') or '',
         "states": sts, "rect": rect_of(a) if 'Component' in ifs else None, "ifaces": ifs, "childCount": safe(lambda: a.get_child_count(), 0) or 0}
    if with_detail:
        n["actions"] = actions_of(a, ifs)
        n["text"] = text_of(a, ifs) if role not in ('password text',) else None
        v = value_of(a, ifs)
        if v is not None:
            n["value"] = v
        attrs = safe(lambda: a.get_attributes(), None)
        if attrs:
            n["id"] = attrs.get('id') or attrs.get('xml-roles') and None
            if attrs.get('class'):
                n["className"] = attrs.get('class')
    return n

def children_of(a):
    cnt = safe(lambda: a.get_child_count(), 0) or 0
    for i in range(cnt):
        c = safe(lambda: a.get_child_at_index(i))
        if c is not None:
            yield i, c

def apps():
    d = Atspi.get_desktop(0)
    for i in range(safe(lambda: d.get_child_count(), 0) or 0):
        a = safe(lambda: d.get_child_at_index(i))
        if a is not None:
            yield i, a

def app_match(a, spec):
    if spec is None:
        return True
    pid = safe(lambda: a.get_process_id(), None)
    if isinstance(spec, int) or (isinstance(spec, str) and spec.isdigit()):
        return pid == int(spec)
    return str(spec).lower() in (safe(lambda: a.get_name(), '') or '').lower()

def window_match(w, spec):
    if spec is None:
        return True
    return str(spec).lower() in (safe(lambda: w.get_name(), '') or '').lower()

class Budget(object):
    def __init__(self, n):
        self.n = n
        self.truncated = False
    def take(self):
        if self.n <= 0 or time.time() > DEADLINE:
            self.truncated = True
            return False
        self.n -= 1
        return True

def build_tree(a, path, depth, only_visible, budget, with_detail=True):
    if not budget.take():
        return None
    n = node_of(a, path, with_detail)
    if only_visible and path and ('showing' not in n["states"]):
        return None
    if depth > 0 and n["childCount"]:
        kids = []
        for i, c in children_of(a):
            k = build_tree(c, path + [i], depth - 1, only_visible, budget, with_detail)
            if k is not None:
                kids.append(k)
        n["children"] = kids
    return n

def app_info(a, idx):
    return {"index": idx, "name": safe(lambda: a.get_name(), '') or '', "pid": safe(lambda: a.get_process_id(), None), "toolkit": safe(lambda: a.get_toolkit_name(), '') or '', "toolkitVersion": safe(lambda: a.get_toolkit_version(), '') or '', "childCount": safe(lambda: a.get_child_count(), 0) or 0}

def resolve(ref):
    # ref: {pid, path, fp(role|name), role, name}
    target = None
    for i, a in apps():
        if safe(lambda: a.get_process_id(), None) == ref.get('pid'):
            target = a
            break
    if target is None:
        return None, "找不到 pid=%s 的應用程式（已關閉？）" % ref.get('pid')
    cur = target
    ok = True
    for idx in ref.get('path', []):
        nxt = safe(lambda: cur.get_child_at_index(idx))
        if nxt is None:
            ok = False
            break
        cur = nxt
    want = ref.get('fp', '')
    def fp_node(n):
        return fp_of(role_of(n), safe(lambda: n.get_name(), '') or '')
    if ok and fp_node(cur) == want:
        return cur, None
    # 路徑對不上：在整棵子樹找指紋相同、離原本位置最近的
    best = [None, 1e18]
    budget = Budget(6000)
    rr = ref.get('rect')
    def walk(a):
        if not budget.take():
            return
        if fp_node(a) == want:
            r = rect_of(a)
            dist = 0
            if rr and r:
                dist = abs(r['x'] - rr['x']) + abs(r['y'] - rr['y'])
            if dist < best[1]:
                best[0], best[1] = a, dist
        for i, c in children_of(a):
            walk(c)
    walk(target)
    if best[0] is not None:
        return best[0], None
    return None, "元件已經不在了（路徑與名稱都對不上）"

def deepest_at(a, x, y, depth=0):
    best = a
    for _ in range(40):
        nxt = safe(lambda: Atspi.Component.get_accessible_at_point(best, x, y, SCREEN))
        if nxt is None or nxt == best:
            break
        best = nxt
    return best

def path_of(node, app):
    # 從 node 往上走到 app，回傳 child 索引路徑
    idxs = []
    cur = node
    for _ in range(80):
        par = safe(lambda: cur.get_parent())
        if par is None:
            return None
        idx = safe(lambda: cur.get_index_in_parent(), None)
        if idx is None or idx < 0:
            return None
        idxs.append(idx)
        if safe(lambda: par.get_role_name(), '') == 'application':
            idxs.reverse()
            return idxs
        cur = par
    return None

def app_of(node):
    cur = node
    for _ in range(80):
        if role_of(cur) == 'application':
            return cur
        par = safe(lambda: cur.get_parent())
        if par is None:
            return None
        cur = par
    return None

def result(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))

if op == 'probe':
    cnt = 0
    names = []
    for i, a in apps():
        cnt += 1
        names.append(safe(lambda: a.get_name(), ''))
    result({"ok": True, "apps": cnt, "names": names[:20]})

elif op == 'apps':
    out = []
    for i, a in apps():
        info = app_info(a, i)
        wins = []
        for j, w in children_of(a):
            wins.append({"index": j, "title": safe(lambda: w.get_name(), '') or '', "role": role_of(w), "rect": rect_of(w), "states": states_of(w)})
        info["windows"] = wins
        out.append(info)
    result({"ok": True, "apps": out})

elif op == 'tree':
    depth = int(req.get('depth', 6))
    budget = Budget(MAXN)
    roots = []
    for i, a in apps():
        if not app_match(a, req.get('app')):
            continue
        pid = safe(lambda: a.get_process_id(), None)
        for j, w in children_of(a):
            if not window_match(w, req.get('window')):
                continue
            t = build_tree(w, [j], depth, bool(req.get('only_visible')), budget)
            if t is not None:
                t["app"] = safe(lambda: a.get_name(), '') or ''
                t["pid"] = pid
                roots.append(t)
    result({"ok": True, "roots": roots, "truncated": budget.truncated})

elif op == 'find':
    q = req.get('query', {})
    limit = int(q.get('limit', 20))
    budget = Budget(MAXN * 8)
    hits = []
    want_text = (q.get('text') or '').lower()
    want_name = (q.get('name') or '').lower()
    want_role = (q.get('role') or '').lower()
    def walk(a, path, pid, appname, depth):
        if len(hits) >= limit or not budget.take():
            return
        role = role_of(a)
        nm = safe(lambda: a.get_name(), '') or ''
        ok = True
        if want_role and role.lower() != want_role:
            ok = False
        if ok and want_name and want_name not in nm.lower():
            ok = False
        if ok and want_text:
            ifs = ifaces_of(a)
            blob = (nm + ' ' + (safe(lambda: a.get_description(), '') or '') + ' ' + (text_of(a, ifs) or '')).lower()
            if want_text not in blob:
                ok = False
        if ok and (want_role or want_name or want_text):
            n = node_of(a, path)
            n["app"] = appname
            n["pid"] = pid
            hits.append(n)
        if depth > 0:
            for i, c in children_of(a):
                walk(c, path + [i], pid, appname, depth - 1)
    for i, a in apps():
        if not app_match(a, req.get('app')):
            continue
        pid = safe(lambda: a.get_process_id(), None)
        appname = safe(lambda: a.get_name(), '') or ''
        for j, w in children_of(a):
            if window_match(w, req.get('window')):
                walk(w, [j], pid, appname, int(req.get('depth', 30)))
    result({"ok": True, "hits": hits, "truncated": budget.truncated})

elif op == 'at':
    x, y = int(req['x']), int(req['y'])
    found = None
    for i, a in apps():
        if not app_match(a, req.get('app')):
            continue
        pid = safe(lambda: a.get_process_id(), None)
        for j, w in children_of(a):
            r = rect_of(w)
            if r is None or not (r['x'] <= x < r['x'] + r['w'] and r['y'] <= y < r['y'] + r['h']):
                continue
            if 'showing' not in states_of(w):
                continue
            d = deepest_at(w, x, y)
            p = path_of(d, a) if d is not None else None
            if p is not None:
                n = node_of(d, p)
                n["app"] = safe(lambda: a.get_name(), '') or ''
                n["pid"] = pid
                n["windowTitle"] = safe(lambda: w.get_name(), '') or ''
                found = n
    result({"ok": True, "element": found})

elif op == 'focused':
    budget = Budget(4000)
    res = {"known": False, "element": None}
    def walk(a, path, depth):
        if not budget.take():
            return None
        sts = states_of(a)
        if 'focused' in sts and path:
            return a, path
        if depth <= 0:
            return None
        for i, c in children_of(a):
            r = walk(c, path + [i], depth - 1)
            if r:
                return r
        return None
    for i, a in apps():
        pid = safe(lambda: a.get_process_id(), None)
        for j, w in children_of(a):
            sts = states_of(w)
            if 'active' not in sts:
                continue
            r = walk(w, [j], 40)
            if r:
                n = node_of(r[0], r[1])
                n["app"] = safe(lambda: a.get_name(), '') or ''
                n["pid"] = pid
                n["windowTitle"] = safe(lambda: w.get_name(), '') or ''
                res = {"known": True, "element": n}
            else:
                res = {"known": False, "element": None, "activeWindow": safe(lambda: w.get_name(), ''), "pid": pid, "reason": "作用中視窗的無障礙樹裡沒有任何元件帶 focused 狀態（應用程式可能沒有啟用無障礙）"}
    result(dict(ok=True, **res))

elif op == 'act':
    ref = req['ref']
    action = req['action']
    node, err = resolve(ref)
    if node is None:
        result({"ok": False, "error": err})
    else:
        ifs = ifaces_of(node)
        role = role_of(node)
        sts = states_of(node)
        if 'sensitive' not in sts and 'enabled' not in sts:
            result({"ok": False, "error": "元件目前是停用的（disabled）"})
        elif action in ('invoke', 'toggle'):
            names = [safe(lambda i=i: Atspi.Action.get_action_name(node, i), '') for i in range(safe(lambda: Atspi.Action.get_n_actions(node), 0) or 0)] if 'Action' in ifs else []
            prefer = ['click', 'press', 'activate', 'invoke', 'open', 'jump', 'toggle', 'check', 'uncheck'] if action == 'invoke' else ['toggle', 'click', 'press', 'check', 'uncheck']
            idx = None
            for p in prefer:
                for k, nm in enumerate(names):
                    if (nm or '').lower() == p:
                        idx = k
                        break
                if idx is not None:
                    break
            if idx is None and names:
                idx = 0
            if idx is None:
                result({"ok": False, "error": "這個元件沒有可執行的動作（Action 介面）", "ifaces": ifs})
            else:
                okk = safe(lambda: Atspi.Action.do_action(node, idx), False)
                result({"ok": bool(okk), "did": names[idx], "actions": names})
        elif action == 'focus':
            okk = safe(lambda: Atspi.Component.grab_focus(node), False)
            result({"ok": bool(okk), "did": "grab_focus"})
        elif action == 'select':
            par = safe(lambda: node.get_parent())
            idx = safe(lambda: node.get_index_in_parent(), -1)
            okk = False
            if par is not None and 'Selection' in ifaces_of(par):
                okk = safe(lambda: Atspi.Selection.select_child(par, idx), False)
            if not okk and 'Action' in ifs:
                okk = safe(lambda: Atspi.Action.do_action(node, 0), False)
            result({"ok": bool(okk), "did": "select"})
        elif action == 'set_value':
            val = req.get('value')
            if role == 'password text' or 'password' in role:
                result({"ok": False, "error": "不在密碼欄輸入文字"})
            elif 'EditableText' in ifs:
                okk = safe(lambda: Atspi.EditableText.set_text_contents(node, str(val)), False)
                result({"ok": bool(okk), "did": "set_text_contents"})
            elif 'Value' in ifs:
                try:
                    okk = Atspi.Value.set_current_value(node, float(val))
                    result({"ok": bool(okk), "did": "set_current_value"})
                except Exception as e:
                    result({"ok": False, "error": "不是數字：" + str(e)})
            else:
                result({"ok": False, "error": "這個元件不能設值（沒有 EditableText／Value 介面）", "ifaces": ifs})
        else:
            result({"ok": False, "error": "不認得的動作 " + str(action)})
else:
    result({"ok": False, "error": "unknown op " + str(op)})
`;

// ---------- id ----------
const fnv = (bytes) => { let h = 2166136261; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, "0").slice(0, 6); };
const fingerprint = (role, name) => fnv(Buffer.from(String(role) + "|" + String(name || ""), "utf8").subarray(0, 120));
function buildId(pid, pathArr, role, name) { return "atspi:" + pid + ":" + pathArr.join(".") + ":" + fingerprint(role, name); }
function parseId(id) {
  const m = /^atspi:(\d+):([\d.]*):([0-9a-f]{6})$/.exec(String(id || "")); if (!m) return null;
  return { pid: Number(m[1]), path: m[2] ? m[2].split(".").map(Number) : [], fp: m[3] };
}

// ---------- python 節點 → element ----------
function toElement(n, ctx) {
  ctx = ctx || {};
  const states = n.states || [], role = E.normalizeRole("atspi", n.role);
  const rect = n.rect && n.rect.w > 0 && n.rect.h > 0 && n.rect.x > -30000 ? n.rect : null;
  const el = E.makeElement({
    id: buildId(n.pid != null ? n.pid : ctx.pid, n.path || [], n.role, n.name), source: "atspi", role, rawRole: n.role, name: n.name || "", description: n.description || "",
    value: n.value != null ? n.value : null, text: n.text != null ? n.text : null, automationId: n.id || "", className: n.className || "", rect,
    enabled: states.includes("sensitive") || states.includes("enabled"), visible: states.includes("showing") || states.includes("visible") && !states.includes("offscreen"), focused: states.includes("focused"), selected: states.includes("selected"),
    checked: states.includes("checked") ? true : states.includes("checkable") ? false : null, isPassword: n.role === "password text",
    states, actions: mapActions(n), window: ctx.window || null, app: n.app || ctx.app || "", pid: n.pid != null ? n.pid : ctx.pid || null,
  });
  if (n.windowTitle) el.windowTitle = n.windowTitle;
  if (n.children) el.children = n.children.map((c) => toElement(c, Object.assign({}, ctx, { pid: n.pid != null ? n.pid : ctx.pid, app: n.app || ctx.app })));
  else if (n.childCount) el.childCount = n.childCount;
  return el;
}
function mapActions(n) {
  const acts = new Set(), names = (n.actions || []).map((a) => String(a).toLowerCase());
  if (names.some((a) => /^(click|press|activate|invoke|open|jump)$/.test(a))) acts.add("invoke");
  if (names.some((a) => /^(toggle|check|uncheck)$/.test(a))) acts.add("toggle");
  const ifs = n.ifaces || [];
  if (ifs.includes("EditableText") && n.role !== "password text") acts.add("set_value");
  if (ifs.includes("Value")) acts.add("set_value");
  if ((n.states || []).includes("focusable")) acts.add("focus");
  if (/^(list item|tree item|page tab|table cell|menu item|radio button)$/.test(n.role || "")) acts.add("select");
  return Array.from(acts);
}

function createAtspi(opts) {
  opts = opts || {}; const run = opts.run, env = opts.env;
  async function call(req, o) {
    o = o || {};
    const r = await run("python3", ["-c", PY_HELPER], { input: JSON.stringify(req), timeout: o.timeout || 20000, env });
    if (!r.ok && !r.stdout) return { ok: false, error: "python3 失敗：" + (r.stderr || r.error || "").toString().trim().split("\n").slice(-2).join(" ").slice(0, 300) };
    let j; try { j = JSON.parse(String(r.stdout || "").trim()); } catch (_) { return { ok: false, error: "AT-SPI helper 的輸出不是 JSON：" + String(r.stdout || r.stderr || "").slice(0, 200) }; }
    return j;
  }
  const api = {
    call,
    async probe() { return call({ op: "probe", deadline_s: 6 }, { timeout: 12000 }); },
    async apps() { const j = await call({ op: "apps" }); return j; },
    // 回傳 { ok, roots:[element 樹], truncated }；opts：{ app(pid|名稱), window(標題片段), depth, onlyVisible, maxNodes }
    async tree(o) {
      o = o || {}; const j = await call({ op: "tree", app: o.app == null ? null : o.app, window: o.window == null ? null : o.window, depth: o.depth == null ? 6 : o.depth, only_visible: !!o.onlyVisible, max_nodes: o.maxNodes || 600, deadline_s: o.deadlineS || 10 }, { timeout: 30000 });
      if (!j.ok) return j; return { ok: true, roots: j.roots.map((r) => toElement(r, { pid: r.pid, app: r.app })), truncated: !!j.truncated, coords: "screen" };
    },
    async find(o) {
      o = o || {}; const j = await call({ op: "find", app: o.app == null ? null : o.app, window: o.window == null ? null : o.window, query: { text: o.text, name: o.name, role: o.rawRole, limit: o.limit || 20 }, max_nodes: 400, depth: o.depth || 30 }, { timeout: 30000 });
      if (!j.ok) return j; return { ok: true, elements: j.hits.map((h) => toElement(h, { pid: h.pid, app: h.app })), truncated: !!j.truncated };
    },
    async elementAt(x, y, o) { const j = await call({ op: "at", x: Math.round(x), y: Math.round(y), app: o && o.app }); if (!j.ok) return j; return { ok: true, element: j.element ? toElement(j.element, { pid: j.element.pid, app: j.element.app }) : null }; },
    // 焦點元件（檢查是不是密碼欄用）。known:false＝無從判斷
    async focused() { const j = await call({ op: "focused", deadline_s: 5 }, { timeout: 15000 }); if (!j.ok) return { ok: false, known: false, error: j.error }; return { ok: true, known: !!j.known, element: j.element ? toElement(j.element, { pid: j.element.pid, app: j.element.app }) : null, isPassword: !!(j.element && j.element.role === "password text"), reason: j.reason, activeWindow: j.activeWindow }; },
    // action：invoke／toggle／select／focus／set_value
    async act(id, action, value, hint) {
      const ref = parseId(id); if (!ref) return { ok: false, error: "不是 AT-SPI 元件 id：" + id };
      const j = await call({ op: "act", ref: Object.assign({}, ref, hint || {}), action, value });
      return j;
    },
  };
  return api;
}

module.exports = { PY_HELPER, createAtspi, toElement, buildId, parseId, fingerprint, mapActions };
