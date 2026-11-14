# -*- coding: utf-8 -*-
# guitpl.py（一對 jsonl＋py 的範本框架）：讀取與檢查、引用與循環、覆寫、相依檢查、外部呼叫、場景、事件迴圈。
# 用法：python -I renderer/src/guitpl/guitpl_test.py
import json
import os
import shutil
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'pybridge'))

usertpl_store = {}


def usertpl_op(args):
    if args['action'] == 'list':
        return dict(usertpl_store)
    if args['action'] == 'save':
        usertpl_store[args['id']] = {'jsonl': args['jsonl'], 'py': args['py']}
    return None


ops = []
pending = []


def fake_call(op, args=None, timeout=240.0):
    ops.append((op, args))
    if op == 'gui.usertpl':
        return usertpl_op(args)
    if op in ('gui.wait', 'gui.poll'):
        if pending:
            ev = dict(pending.pop(0))
            if '_text' in ev:  # a click on the button whose text is this (looked up in the nodes added so far)
                want = ev.pop('_text')
                ev['node'] = [o[1]['node']['id'] for o in ops if o[0] == 'gui.add' and o[1]['node'].get('text') == want][-1]
            ev.setdefault('event', 'click')
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

LIB = os.path.join(HERE, 'lib')
failures = []


def check(name, cond):
    if not cond:
        failures.append(name)
        print('FAIL', name)


def raises(fn, text):
    try:
        fn()
    except guitpl.GuiTplError as e:
        return text in str(e)
    return False


def write(root, cid, lines, py=None):
    base = os.path.join(root, *cid.split('/'))
    os.makedirs(os.path.dirname(base), exist_ok=True)
    with open(base + '.jsonl', 'w', encoding='utf-8') as f:
        f.write('\n'.join(json.dumps(l, ensure_ascii=False) if not isinstance(l, str) else l for l in lines) + '\n')
    if py is not None:
        with open(base + '.py', 'w', encoding='utf-8') as f:
            f.write(py)


# 1. 載入：引用、參數、覆寫
lib = guitpl.Library([LIB])
comp = lib.load('demo/notes')
check('meta id', comp['meta']['id'] == 'demo/notes')
check('slot child loaded', comp['children']['toolbar']['id'] == 'common/toolbar_basic')
check('params', comp['params']['title']['default'] == '我的筆記')
check('bind default', guitpl.bind_params(comp)['title'] == '我的筆記')
check('bind given', guitpl.bind_params(comp, {'title': 'X'})['title'] == 'X')
check('unknown param is an error', raises(lambda: guitpl.bind_params(comp, {'nope': 1}), '沒有這些參數'))
dark = lib.load('demo/notes_dark')
check('extends keeps base layout', dark['layout'] is not None and dark['children']['toolbar']['id'] == 'common/toolbar_basic')
check('extends overrides param default', dark['params']['title']['default'] == '夜間筆記')
check('style merges palette', dark['style']['palette']['bg'] == '#1e1e1e' and dark['style']['palette']['danger'] == '#dc2626')
check('style font override', dark['style']['font'] == 'monospace' and dark['style']['size'] == 14)
check('scenes inherited', [s['id'] for s in dark['scenes']] == ['edit', 'help'])
check('extends meta title', dark['meta']['title'] == '深色筆記')

# 2. 相依：收集與檢查
req = guitpl.collect_requires(comp)
check('requires dedupe', set(req) == {'gui', 'time'} and req['gui']['by'] == ['demo/notes', 'common/toolbar_basic'])
check('check is clean', guitpl.check(comp) == [])
check('check dark is clean', guitpl.check(dark) == [])

tmp = tempfile.mkdtemp()
try:
    # 循環
    write(tmp, 'a/x', [{'kind': 'meta', 'id': 'a/x'}, {'kind': 'slot', 'name': 's', 'use': 'a/y'}], 'def build(win, spec, slots):\n    return {}\n')
    write(tmp, 'a/y', [{'kind': 'meta', 'id': 'a/y'}, {'kind': 'slot', 'name': 's', 'use': 'a/x'}], 'def build(win, spec, slots):\n    return {}\n')
    check('slot cycle', raises(lambda: guitpl.Library([tmp]).load('a/x'), '循環引用：a/x → a/y → a/x'))
    write(tmp, 'b/p', [{'kind': 'meta', 'id': 'b/p', 'extends': 'b/q'}])
    write(tmp, 'b/q', [{'kind': 'meta', 'id': 'b/q', 'extends': 'b/p'}])
    check('extends cycle', raises(lambda: guitpl.Library([tmp]).load('b/p'), '循環引用'))
    # 格式錯誤
    write(tmp, 'c/bad', [{'kind': 'meta', 'id': 'c/bad'}, '{not json}'])
    check('bad json line', raises(lambda: guitpl.Library([tmp]).load('c/bad'), '第 2 行不是合法的 JSON'))
    write(tmp, 'c/kind', [{'kind': 'meta', 'id': 'c/kind'}, {'kind': 'weird'}])
    check('bad kind', raises(lambda: guitpl.Library([tmp]).load('c/kind'), 'kind 必須是'))
    write(tmp, 'c/field', [{'kind': 'meta', 'id': 'c/field'}, {'kind': 'param', 'name': 'x'}])
    check('missing field', raises(lambda: guitpl.Library([tmp]).load('c/field'), '缺少欄位 default'))
    write(tmp, 'c/src', [{'kind': 'meta', 'id': 'c/src'}, {'kind': 'require', 'module': 'x', 'source': 'pip'}])
    check('bad source', raises(lambda: guitpl.Library([tmp]).load('c/src'), 'require.source'))
    check('missing component', raises(lambda: guitpl.Library([tmp]).load('nope/zzz'), '找不到範本 nope/zzz'))
    write(tmp, 'c/nometa', ['{"kind":"param","name":"a","default":1}'])
    check('missing meta', raises(lambda: guitpl.Library([tmp]).load('c/nometa'), '缺少 meta'))
    # 相依檢查：.py import 了但沒宣告；宣告了但模擬器沒有；沒有 py
    write(tmp, 'd/undeclared', [{'kind': 'meta', 'id': 'd/undeclared'}, {'kind': 'require', 'module': 'gui', 'source': 'builtin'}],
          'import gui\nimport json\n\n\ndef build(win, spec, slots):\n    return {}\n')
    errs = guitpl.check(guitpl.Library([tmp]).load('d/undeclared'))
    check('undeclared import', len(errs) == 1 and 'json' in errs[0] and '沒有宣告' in errs[0])
    write(tmp, 'd/missing', [{'kind': 'meta', 'id': 'd/missing'}, {'kind': 'require', 'module': 'numpy_not_here', 'source': 'pyodide'}],
          'import numpy_not_here\n\n\ndef build(win, spec, slots):\n    return {}\n')
    errs = guitpl.check(guitpl.Library([tmp]).load('d/missing'))
    check('missing package', len(errs) == 1 and 'numpy_not_here' in errs[0] and 'd/missing' in errs[0] and '模擬器裡沒有' in errs[0])
    check('optional package is fine', guitpl.check(guitpl.Library([tmp]).load('d/missing'), available=lambda m, s: True) == [])
    write(tmp, 'd/nopy', [{'kind': 'meta', 'id': 'd/nopy'}])
    check('missing py', 'd/nopy' in guitpl.check(guitpl.Library([tmp]).load('d/nopy'))[0] and '.py' in guitpl.check(guitpl.Library([tmp]).load('d/nopy'))[0])
    write(tmp, 'd/optional', [{'kind': 'meta', 'id': 'd/optional'}, {'kind': 'require', 'module': 'zzz_none', 'source': 'micropip', 'optional': True}],
          'import zzz_none\n\n\ndef build(win, spec, slots):\n    return {}\n')
    check('optional require skipped', guitpl.check(guitpl.Library([tmp]).load('d/optional')) == [])
    write(tmp, 'd/file', [{'kind': 'meta', 'id': 'd/file'}, {'kind': 'require', 'module': 'helper.py', 'source': 'file'}],
          'import helper\n\n\ndef build(win, spec, slots):\n    return {}\n')
    errs = guitpl.check(guitpl.Library([tmp]).load('d/file'))
    check('file source missing', len(errs) == 1 and 'helper.py' in errs[0])
    with open(os.path.join(tmp, 'd', 'helper.py'), 'w') as f:
        f.write('X = 1\n')
    check('file source present', guitpl.check(guitpl.Library([tmp]).load('d/file')) == [])
    # prepare 把所有問題一次講完
    check('prepare lists problems', raises(lambda: guitpl.prepare('d/undeclared', roots=[tmp]), '沒有宣告'))
    # 外部呼叫：找不到檔案、找不到函式、函式丟例外，都不能讓整個程式掛掉
    write(tmp, 'e/calls', [{'kind': 'meta', 'id': 'e/calls'}, {'kind': 'require', 'module': 'gui', 'source': 'builtin'},
                           {'kind': 'layout', 'window': {'title': 'T'}, 'tree': [{'kind': 'button', 'id': 'go', 'text': 'Go'}, {'kind': 'label', 'id': 'status', 'text': ''}]},
                           {'kind': 'call', 'id': 'c1', 'on': 'click:go', 'file': 'nofile.py', 'function': 'f'},
                           {'kind': 'call', 'id': 'c2', 'on': 'click:go', 'file': 'ext.py', 'function': 'missing_fn'},
                           {'kind': 'call', 'id': 'c3', 'on': 'click:go', 'file': 'ext.py', 'function': 'boom'},
                           {'kind': 'call', 'id': 'c4', 'on': 'click:go', 'file': 'ext.py', 'function': 'fine', 'args': {'word': '好'}}],
          'import gui\n\n\ndef build(win, spec, slots):\n    return {}\n')
    with open(os.path.join(tmp, 'e', 'ext.py'), 'w', encoding='utf-8') as f:
        f.write('def boom(ctx):\n    raise ValueError("壞掉")\n\n\ndef fine(ctx, word):\n    ctx.set("status", text="ok " + word)\n')
    ops.clear()
    r = guitpl.run('e/calls', roots=[tmp], loop=False)
    errbuf = []
    r['ctx'].error = errbuf.append
    comp_e = r['component']
    calls = {}
    for c in comp_e['calls']:
        calls.setdefault(c['on'], []).append(c)
    guitpl._dispatch(r['ctx'], comp_e, 'click:go', r['handlers'], calls)
    check('missing file reported', any('找不到檔案 nofile.py' in e for e in errbuf))
    check('missing function reported', any('沒有函式 missing_fn' in e for e in errbuf))
    check('raising call reported, program lives', any('boom' in e and '壞掉' in e for e in errbuf))
    check('good call still runs after bad ones', ops[-1][0] == 'gui.set' and ops[-1][1]['props'] == {'text': 'ok 好'})
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# 3. 執行：視窗、主題、插槽、參數替換、場景、快捷鍵、外部呼叫（真的範本）
ops.clear()
r = guitpl.run('demo/notes', params={'title': '週記'}, roots=[LIB], loop=False)
check('window title substituted', ops[0][0] == 'gui.open' and ops[0][1]['title'] == '週記' and ops[0][1]['width'] == 560 and ops[0][1]['height'] == 460)
check('layout grow and role reach the bridge', any(o[0] == 'gui.add' and o[1]['node'].get('grow') == 1.0 and o[1]['node']['kind'] == 'editor' for o in ops) and any(o[0] == 'gui.add' and o[1]['node'].get('role') == 'page' for o in ops))
check('toolbar row has its role', any(o[0] == 'gui.add' and o[1]['node'].get('role') == 'toolbar' for o in ops))
check('theme applied', any(o[0] == 'gui.theme' and o[1]['palette']['accent'] == '#2563eb' and o[1]['size'] == 14 for o in ops))
check('named nodes', set(r['ids']) >= {'editor', 'status', 'save', 'clear', 'help', 'help_btn', 'back_btn', 'export'})
check('slot param substituted into child', any(o[0] == 'gui.add' and o[1]['node'].get('text') == '儲存「週記」' for o in ops))
check('shortcut registered', any(o[0] == 'gui.shortcut' and o[1]['keys'] == 'Ctrl+S' and o[1]['name'] == 'save' for o in ops))
check('first scene applied', r['scene'] == 'edit' and any(o[0] == 'gui.set' and o[1]['node'] == r['ids']['help'] and o[1]['props'] == {'visible': False} for o in ops))
ctx = r['ctx']
comp_n = r['component']
calls = {}
for c in comp_n['calls']:
    calls.setdefault(c['on'], []).append(c)
guitpl._dispatch(ctx, comp_n, 'click:save', r['handlers'], calls)
guitpl._dispatch(ctx, comp_n, 'shortcut:save', r['handlers'], calls)
check('toolbar handler and shortcut share state', r['state']['saved'] == 2 and ops[-1][1]['props'] == {'text': '已存 2 次'})
guitpl._dispatch(ctx, comp_n, 'click:help_btn', r['handlers'], calls)
check('scene switch by trigger', ctx.scene == 'help')
guitpl._dispatch(ctx, comp_n, 'click:back_btn', r['handlers'], calls)
check('scene switch back', ctx.scene == 'edit')
ctx.w.set(r['ids']['editor'], value='abc')
guitpl._dispatch(ctx, comp_n, 'click:export', r['handlers'], calls)
check('foreign call from the real template', ops[-1][1]['props']['text'] == '已匯出為 txt（3 字）')
check('storyboard data', [s['id'] for s in guitpl.storyboard(comp_n)] == ['edit', 'help'] and guitpl.storyboard(comp_n)[0]['on'] == {'click:help_btn': 'help'})
check('goto unknown scene', raises(lambda: ctx.goto('zzz'), '沒有這個場景'))

# 4. 事件迴圈：同樣的節點代號再跑一次，事件走輪詢，最後關閉
ids = r['ids']
pending[:] = [{'event': 'click', 'node': ids['save']}, {'event': 'shortcut', 'value': 'save'}, {'event': 'click', 'node': ids['help_btn']},
              {'event': 'click', 'node': ids['back_btn']}]
ops.clear()
r2 = guitpl.run('demo/notes_dark', roots=[LIB])
check('loop ran every event', r2['state']['saved'] == 2 and r2['scene'] == 'edit')
check('dark theme applied', any(o[0] == 'gui.theme' and o[1]['palette']['bg'] == '#1e1e1e' and o[1]['font'] == 'monospace' for o in ops))
check('dark default title', ops[0][1]['title'] == '夜間筆記')
check('loop ends on close', ops[-1][0] == 'gui.poll')

# 5. 範本目錄與預設根目錄
cat = guitpl.catalog([LIB])
check('catalog lists entries and parts', {'demo/notes', 'common/toolbar_basic'} <= {e['id'] for e in cat})
notes = [e for e in cat if e['id'] == 'demo/notes'][0]
check('catalog entry fields', notes['standalone'] is True and notes['params'][0]['ask'] and notes['scenes'] == ['edit', 'help'])
found = guitpl.catalog([LIB], query='我想做一個筆記')
check('catalog query', found and found[0]['id'] == 'demo/notes')
check('catalog query no match', guitpl.catalog([LIB], query='完全不相干xyz') == [])
check('default roots', guitpl.default_roots()[0].endswith('guitpl_lib'))

# 6. 我的範本與設計工作室
check('user_root none at first', guitpl.user_root() is None)
guitpl._USER_ROOT[1] = False
new_id = guitpl.save_template('demo/notes', 'user/my_notes', params={'title': '我的筆記本'}, palette={'bg': '#101010'}, roots=[LIB])
check('saved id', new_id == 'user/my_notes' and 'user/my_notes' in usertpl_store)
check('saved jsonl extends base', '"extends": "demo/notes"' in usertpl_store['user/my_notes']['jsonl'] and '#101010' in usertpl_store['user/my_notes']['jsonl'])
check('bad user id', raises(lambda: guitpl.save_template('demo/notes', 'demo/x', roots=[LIB]), 'user/'))
check('unknown param on save', raises(lambda: guitpl.save_template('demo/notes', 'user/x', params={'zz': 1}, roots=[LIB]), '沒有參數'))
guitpl._USER_ROOT[1] = False
real_default_roots = guitpl.default_roots
guitpl.default_roots = lambda: [LIB] + [u for u in [guitpl.user_root()] if u]  # the shipped lib is a sibling folder only in the emulator
roots = guitpl.default_roots()
check('default roots include the user folder', len(roots) == 2 and os.path.isfile(os.path.join(roots[1], 'user', 'my_notes.jsonl')))
cat2 = guitpl.catalog()
mine = [e for e in cat2 if e['id'] == 'user/my_notes']
check('catalog lists my template', mine and mine[0]['params'][0]['default'] == '我的筆記本')
ops.clear()
pending[:] = [{'event': 'click', 'node': 'x'}]
r3 = guitpl.run('user/my_notes', roots=roots, loop=False)
check('my template runs through the base build', ops[0][1]['title'] == '我的筆記本' and any(o[0] == 'gui.theme' and o[1]['palette']['bg'] == '#101010' for o in ops))
check('storyboard text', '分鏡：' in guitpl.storyboard_text(r3['component']) and '換到 help' in guitpl.storyboard_text(r3['component']))
pending.clear()

# the studio: preview, storyboard, save, close
usertpl_store.clear()
guitpl._USER_ROOT[1] = False
ops.clear()
pending[:] = [{'_text': '預覽'}, {'_text': '分鏡'}, {'_text': '存成我的範本'}]
guitpl.studio('demo/notes', roots=[LIB])
check('studio opened a preview window', sum(1 for o in ops if o[0] == 'gui.open') == 2)
check('studio saved nothing changed as a plain extension', 'user/my_notes' in usertpl_store)
check('studio showed the storyboard', any(o[0] == 'gui.set' and '分鏡：' in str(o[1]['props'].get('value', '')) for o in ops))
check('studio status after save', any(o[0] == 'gui.set' and '已存成我的範本' in str(o[1]['props'].get('text', '')) for o in ops))
usertpl_store.clear()
guitpl._USER_ROOT[1] = False
ops.clear()
pending[:] = []
guitpl.studio('demo/notes', roots=[LIB])  # closes at once
check('studio closes cleanly', ops[-1][0] in ('gui.close', 'gui.poll'))

# 7. tabs, split, menus and dialogs as template nodes; a menu item's keys is a real shortcut that clicks it
tmp = tempfile.mkdtemp()
write(tmp, 'demo/shell', [
    {"kind": "meta", "id": "demo/shell", "title": "shell", "standalone": True},
    {"kind": "require", "module": "gui", "source": "builtin"},
    {"kind": "layout", "window": {"title": "shell", "width": 400}, "tree": [
        {"kind": "menubar", "children": [{"kind": "menu", "title": "File", "children": [
            {"id": "save", "kind": "menuitem", "text": "Save", "keys": "Ctrl+S"}]}]},
        {"kind": "split", "direction": "row", "ratio": 30, "children": [{"kind": "label", "text": "left"}, {"kind": "label", "text": "right"}]},
        {"id": "pages", "kind": "tabs", "children": [
            {"kind": "tab", "title": "One", "children": [{"id": "status", "kind": "label", "text": "ready"}]},
            {"kind": "tab", "title": "Two", "children": [{"kind": "label", "text": "two"}]}]}]},
], py="""def build(win, spec, slots):
    def save(ctx):
        ctx.state["n"] = ctx.state.get("n", 0) + 1
        ctx.set("status", text="saved %d" % ctx.state["n"])
    return {"handlers": {"click:save": save}}
""")
ops.clear()
pending[:] = [{'event': 'shortcut', 'value': 'menu_save'}, {'event': 'click', '_text': 'Save'}]
r7 = guitpl.run('demo/shell', roots=[tmp])
kinds = [o[1]['node']['kind'] for o in ops if o[0] == 'gui.add']
check('shell nodes added', kinds[:3] == ['menubar', 'menu', 'menuitem'] and 'tabs' in kinds and kinds.count('tab') == 2 and 'split' in kinds)
check('menuitem keys is registered as a shortcut', any(o[0] == 'gui.shortcut' and o[1]['keys'] == 'Ctrl+S' and o[1]['name'] == 'menu_save' for o in ops))
check('shortcut and click both reach the click handler', r7['state']['n'] == 2)
msgs = []


class FakeGui(object):
    @staticmethod
    def message(text, title='', ok=''):
        msgs.append(('message', text))

    @staticmethod
    def confirm(text, title='', yes='', no=''):
        msgs.append(('confirm', text))
        return True

    @staticmethod
    def ask(text, default='', title='', ok='', cancel=''):
        return default + '!'


real_gui = sys.modules.get('gui')
sys.modules['gui'] = FakeGui
c7 = guitpl.Ctx(None, {}, {}, [])
c7.message('hi')
check('ctx dialogs', c7.confirm('sure') is True and c7.ask('q', 'a') == 'a!' and msgs[0] == ('message', 'hi'))
sys.modules['gui'] = real_gui
shutil.rmtree(tmp)

# 8. compile_standalone: one file with everything inside; same operations as guitpl.run
def shape(op_list):
    out = []
    for o in op_list:
        a = dict(o[1] or {})
        a.pop('id', None)
        out.append((o[0], json.dumps(a, sort_keys=True, ensure_ascii=False)))
    return out


for cid in ('demo/notes_dark', 'office/main_warm', 'text-editor/main'):
    ops.clear()
    pending[:] = []
    guitpl.run(cid, roots=[LIB])
    expect = shape(ops)
    text = guitpl.compile_standalone(cid, roots=[LIB])
    check('standalone has no jsonl dependency on disk', 'tempfile.mkdtemp' in text and '__main__' in text)
    ops.clear()
    pending[:] = []
    real_guitpl = sys.modules['guitpl']
    try:
        exec(compile(text, 'standalone_%s.py' % cid.replace('/', '_'), 'exec'), {'__name__': '__main__'})
    finally:
        sys.modules['guitpl'] = real_guitpl
    check('standalone %s does what run() does' % cid, shape(ops) == expect and len(expect) > 5)

# params are baked in, and a template with a foreign call keeps its file
text = guitpl.compile_standalone('demo/notes', params={'title': 'Baked'}, roots=[LIB])
check('params baked in', 'Baked' in text)
check('foreign call file inside', 'ext_export.py' in text)
check('bad param refused', raises(lambda: guitpl.compile_standalone('demo/notes', params={'zzz': 1}, roots=[LIB]), '沒有這些參數'))

# 9. pick_file in templates: image and idphoto open a picture the user chose
class PickGui(object):
    """Stands in for gui.pick_file / Window.image behind ctx.pick_file."""
    answers = []

    @staticmethod
    def pick_file(title='', accept='', max_bytes=0):
        a = PickGui.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


real_gui2 = sys.modules.get('gui')
for cid, btn, canvas_text in (('image/main', '開啟圖片', 'preview'), ('idphoto/main', '開啟照片', 'view')):
    ops.clear()
    PickGui.answers[:] = [{'name': 'p.png', 'size': 4, 'mime': 'image/png', 'data': b'\x89PNG', 'path': ''}]
    pending[:] = [{'_text': btn}]
    real_pick = guitpl.Ctx.pick_file

    def patched(self, title='', accept='', max_bytes=0):
        return PickGui.pick_file(title, accept, max_bytes)
    guitpl.Ctx.pick_file = patched
    # Window.image goes through fa_bridge: answer it with a size
    base_call = stub.call

    def image_aware(op, args=None, timeout=240.0, _b=base_call):
        if op == 'gui.image':
            ops.append((op, args))
            return {'w': 40, 'h': 30}
        return _b(op, args, timeout)
    stub.call = image_aware
    try:
        guitpl.run(cid, roots=[LIB])
    finally:
        stub.call = base_call
        guitpl.Ctx.pick_file = real_pick
    check('%s registers the chosen picture' % cid, any(o[0] == 'gui.image' for o in ops))
    check('%s draws it with an image op' % cid, any(o[0] == 'gui.draw' and any(op_[0] == 'image' for op_ in o[1]['ops']) for o in ops))
    pending.clear()

# 10. YAML templates: same records, same checks, same run; errors are Chinese GuiTplError
ops.clear()
pending[:] = []
r10 = guitpl.run('demo/todo_yaml', roots=[LIB])
check('yaml template runs', r10['component']['meta']['title'] == 'YAML 待辦示範' and any(o[0] == 'gui.open' and o[1]['title'] == 'YAML 待辦' for o in ops))
check('yaml params and scenes', [s['id'] for s in r10['component']['scenes']] == ['main'])
check('yaml in the catalog', any(e['id'] == 'demo/todo_yaml' and e['standalone'] for e in guitpl.catalog([LIB])))
tmp2 = tempfile.mkdtemp()
write(tmp2, 'bad/tab', ['x'], py='def build(win, spec, slots):\n    return {}\n')
os.remove(os.path.join(tmp2, 'bad', 'tab.jsonl'))
with open(os.path.join(tmp2, 'bad', 'tab.yaml'), 'w', encoding='utf-8') as f:
    f.write('kind: meta\nid: bad/tab\ntitle: x\n---\nkind: layout\ntree:\n\t- kind: label\n')
check('yaml error is a Chinese GuiTplError', raises(lambda: guitpl.Library([tmp2]).load('bad/tab'), 'YAML 寫法有問題'))
shutil.rmtree(tmp2)
text = guitpl.compile_standalone('demo/todo_yaml', roots=[LIB])
check('standalone carries the yaml file and its parser', 'todo_yaml.yaml' in text and 'guitpl_yaml.py' in text)
ops.clear()
pending[:] = []
real_guitpl3 = sys.modules['guitpl']
real_yaml = sys.modules.get('guitpl_yaml')
try:
    exec(compile(text, 'standalone_yaml.py', 'exec'), {'__name__': '__main__'})
finally:
    sys.modules['guitpl'] = real_guitpl3
    if real_yaml is not None:
        sys.modules['guitpl_yaml'] = real_yaml
check('standalone yaml opens the window', any(o[0] == 'gui.open' and o[1]['title'] == 'YAML 待辦' for o in ops))

if failures:
    print('%d failure(s)' % len(failures))
    sys.exit(1)
print('guitpl: all checks passed')
