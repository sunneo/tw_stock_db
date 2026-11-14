# -*- coding: utf-8 -*-
# 範本檢查工具：python -I renderer/src/guitpl/lint.py <範本根目錄> [範本代號 或 資料夾前綴 ...]
#   例：python -I renderer/src/guitpl/lint.py renderer/src/guitpl/lib office
# 對每個元件檢查：格式、引用與循環、相依宣告（py 用到的 import 都要在 jsonl 或 yaml 宣告；範本可以是 .jsonl 或 .yaml）、id 與路徑一致、每個參數有 ask、
# 場景與快捷鍵指到存在的節點與處理函式。meta 有 "standalone": true 的元件（整個領域的範本）還會用假橋接真的執行：
# 對每個按鈕與核取方塊送事件、對每個輸入框送文字、對每個快捷鍵送按鍵、走過每個場景，任何例外都算失敗。
# 結束碼 0＝全部通過，1＝有問題（問題逐行印出）。
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'pybridge'))

pending = []
ops = []


# 真橋接（renderer/src/gui/gui_bridge.js 的 KINDS）允許的屬性：假橋接也照這張表擋，不然本機通過、真橋接才報錯
PROPS = {
    'column': [], 'row': [], 'grid': ['columns'], 'scroll': ['height'], 'expander': ['text', 'expanded'], 'label': ['text'],
    'button': ['text', 'enabled', 'icon'], 'entry': ['value', 'placeholder', 'enabled', 'secret'],
    'textarea': ['value', 'placeholder', 'rows', 'enabled'], 'editor': ['value', 'lang', 'rows', 'enabled', 'numbers', 'prose', 'caret', 'caret_to'],
    'checkbox': ['text', 'checked', 'enabled'], 'progress': ['value', 'max'], 'list': ['items', 'selected', 'enabled'],
    'multilist': ['items', 'selected', 'enabled'], 'table': ['columns', 'rows', 'enabled'], 'canvas': ['width', 'height', 'fps', 'fit'],
    'tabs': ['selected'], 'tab': ['text'], 'split': ['direction', 'ratio'], 'menubar': [], 'menu': ['text'], 'menuitem': ['text', 'keys', 'enabled'],
}
COMMON = ('visible', 'grow', 'gap', 'pad', 'role')  # 任何節點都可以有的版面與外觀提示
ROLES = ('toolbar', 'sidebar', 'statusbar', 'card', 'panel', 'heading', 'title', 'muted', 'primary', 'danger', 'surface', 'group', 'divider', 'outline', 'page')
CONTAINERS = ('column', 'row', 'expander', 'grid', 'scroll', 'tabs', 'tab', 'split', 'menubar', 'menu')
import re
SHORTCUT_RE = re.compile(r'^(Ctrl\+)?(Shift\+)?(Alt\+)?([A-Z0-9]|F([1-9]|1[0-2])|Enter|Esc|Space|Up|Down|Left|Right|Delete|Backspace|Tab)$')
kinds_of = {}


def fake_call(op, args=None, timeout=240.0):
    ops.append((op, args))
    if op == 'gui.open':
        kinds_of.clear()
        kinds_of['root'] = 'column'
    elif op == 'gui.add':
        node = args['node']
        if node['kind'] not in PROPS:
            raise ValueError('橋接不支援節點種類 %s' % node['kind'])
        for k in node:
            if k not in ('id', 'kind') and k not in COMMON and k not in PROPS[node['kind']]:
                raise ValueError('橋接不允許 %s 節點有屬性 %s' % (node['kind'], k))
        if kinds_of.get(args.get('parent', 'root')) not in CONTAINERS:
            raise ValueError('橋接：父節點不是容器')
        if 'grow' in node and not (isinstance(node['grow'], (int, float)) and 0 <= node['grow'] <= 10):
            raise ValueError('橋接：grow 要是 0 到 10 的數字')
        if 'role' in node and node['role'] not in ROLES:
            raise ValueError('橋接：role 要是 %s 其中之一' % '、'.join(ROLES))
        kinds_of[node['id']] = node['kind']
    elif op == 'gui.shortcut':
        if not SHORTCUT_RE.match(str(args['keys'])):
            raise ValueError('橋接不認得快捷鍵寫法 %s（要像 Ctrl+S、Ctrl+Shift+Z、F5、Esc、Delete；修飾鍵順序固定 Ctrl、Shift、Alt）' % args['keys'])
    elif op == 'gui.tone':
        if not (40 <= args['freq'] <= 8000 and 10 <= args['ms'] <= 2000):
            raise ValueError('橋接：音效 freq 要 40-8000、ms 要 10-2000')
    elif op == 'gui.set':
        kind = kinds_of.get(args['node'])
        if kind is None:
            raise ValueError('橋接：節點 %s 不存在' % args['node'])
        for k in args['props']:
            if k not in COMMON and k not in PROPS[kind]:
                raise ValueError('橋接不允許 %s 節點用 set 改屬性 %s' % (kind, k))
    if op in ('gui.wait', 'gui.poll'):
        if pending:
            ev = dict(pending.pop(0))
            ev.setdefault('v', 1)
            ev.setdefault('id', args['id'])
            ev.setdefault('node', 'root')
            return ev
        return {'v': 1, 'event': 'close', 'id': args['id'], 'node': 'root'}
    return None


stub = types.ModuleType('fa_bridge')
stub.call = fake_call
sys.modules['fa_bridge'] = stub

import guitpl  # noqa: E402


def ids_under(root):
    out = []
    for base, _dirs, files in os.walk(root):
        for f in sorted(files):
            if f.endswith(('.jsonl', '.yaml', '.yml')):
                rel = os.path.relpath(os.path.join(base, f), root).rsplit('.', 1)[0].replace(os.sep, '/')
                if rel not in out:
                    out.append(rel)
    return sorted(out)


def node_names(nodes, out=None):
    out = [] if out is None else out
    for n in nodes:
        if n.get('id'):
            out.append(n['id'])
        node_names(n.get('children', []), out)
    return out


def all_nodes(comp):
    names, kinds = [], {}
    grows = []
    def walk(c):
        if c['layout']:
            def go(nodes):
                for n in nodes:
                    if n.get('id'):
                        names.append(n['id'])
                        kinds[n['id']] = n.get('kind')
                    if n.get('grow'):
                        grows.append(n.get('id') or n.get('kind') or n.get('slot'))
                    go(n.get('children', []))
            go(c['layout']['tree'])
        for ch in c['children'].values():
            walk(ch)
    walk(comp)
    all_nodes.grows = grows
    return names, kinds


def lint_one(lib_root, cid):
    problems = []
    lib = guitpl.Library([lib_root])
    try:
        comp = lib.load(cid)
    except guitpl.GuiTplError as e:
        return [str(e)]
    if comp['meta'].get('id') != cid:
        problems.append('%s：meta.id 是 %s，要和路徑一致' % (cid, comp['meta'].get('id')))
    for name, rec in comp['params'].items():
        if not rec.get('ask'):
            problems.append('%s：參數 %s 缺少 ask（逐步詢問要問的話）' % (cid, name))
    if not comp['meta'].get('title') or not comp['meta'].get('keywords'):
        problems.append('%s：meta 需要 title 與 keywords（檢索用）' % cid)
    problems.extend(guitpl.check(comp))
    names, kinds = all_nodes(comp)
    if comp['meta'].get('standalone') and comp['meta'].get('main', True):
        # 主範本：視窗要能縮放、有起始高度，而且至少有一個會填滿的主要區域（grow），不然視窗放大時內容只會停在左上角
        win = (comp['layout'] or {}).get('window', {})
        if not win.get('resizable'):
            problems.append('%s：主範本的視窗要 resizable，放大視窗時內容才會跟著變' % cid)
        if not win.get('height'):
            problems.append('%s：主範本的 window 要有起始高度 height（填滿要有高度可填）' % cid)
        if not all_nodes.grows:
            problems.append('%s：主範本必須有一個填滿的主要區域（節點加 "grow":1，例如編輯區、畫布或清單）' % cid)
    for s in comp['scenes']:
        for n in list(s.get('show', [])) + list(s.get('hide', [])):
            if n not in names:
                problems.append('%s：場景 %s 指到不存在的節點 %s' % (cid, s['id'], n))
        for trigger, target in s.get('on', {}).items():
            if target not in [x['id'] for x in comp['scenes']]:
                problems.append('%s：場景 %s 的切換指到不存在的場景 %s' % (cid, s['id'], target))
    if problems or not comp['meta'].get('standalone'):
        return problems
    # 假橋接執行
    ops.clear()
    del pending[:]
    try:
        r = guitpl.run(cid, roots=[lib_root], loop=False)
    except Exception as e:  # noqa: B902
        return ['%s：執行失敗：%s: %s' % (cid, type(e).__name__, e)]
    ctx, handlers = r['ctx'], r['handlers']
    errbuf = []
    ctx.error = errbuf.append
    calls = {}
    for c in comp['calls']:
        calls.setdefault(c['on'], []).append(c)
    ids = r['ids']
    keys = []
    for name, kind in kinds.items():
        if kind == 'button':
            keys.append('click:%s' % name)
        elif kind == 'checkbox':
            keys.append('change:%s' % name)
        elif kind in ('editor', 'entry', 'textarea'):
            keys.append('input:%s' % name)
        elif kind in ('list', 'multilist'):
            keys.append('select:%s' % name)
    for sc in comp['shortcuts']:
        keys.append('shortcut:%s' % sc['do'])
    for sc in comp['shortcuts']:
        if 'shortcut:%s' % sc['do'] not in handlers and 'shortcut:%s' % sc['do'] not in calls:
            problems.append('%s：快捷鍵 %s 的動作 %s 沒有處理函式（build 要回傳 handlers 的 "shortcut:%s"）' % (cid, sc['keys'], sc['do'], sc['do']))
    for s in comp['scenes']:
        keys.append('scene:' + s['id'])
    for key in keys:
        try:
            if key.startswith('scene:'):
                ctx.goto(key[6:])
            else:
                kind, _, name = key.partition(':')
                if kind == 'input':
                    ctx.w._values[ids[name]] = 'abc'
                ctx.event = {'event': kind, 'node': ids.get(name), 'value': 'abc'}
                guitpl._dispatch(ctx, comp, key, handlers, calls)
        except Exception as e:  # noqa: B902
            problems.append('%s：事件 %s 丟出例外 %s: %s' % (cid, key, type(e).__name__, e))
    for e in errbuf:
        problems.append('%s：外部呼叫出錯：%s' % (cid, e))
    return problems


def main(argv):
    try:
        sys.stdout.reconfigure(encoding='utf-8')  # Windows 管道預設不是 UTF-8
    except AttributeError:
        pass
    if len(argv) < 2:
        print('用法：python -I lint.py <範本根目錄> [範本代號或資料夾前綴 ...]')
        return 2
    root = argv[1]
    wanted = argv[2:]
    ids = ids_under(root)
    if wanted:
        ids = [i for i in ids if any(i == w or i.startswith(w.rstrip('/') + '/') for w in wanted)]
    if not ids:
        print('沒有找到任何範本')
        return 1
    bad = 0
    for cid in ids:
        problems = lint_one(root, cid)
        if problems:
            bad += 1
            for p in problems:
                print('壞：' + p)
        else:
            print('好：' + cid)
    print('%d 個元件，%d 個有問題' % (len(ids), bad))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
