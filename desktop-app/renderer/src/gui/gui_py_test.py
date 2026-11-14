# -*- coding: utf-8 -*-
# Python side of the GUI bridge (assets/pybridge/gui.py) against a stubbed fa_bridge: the op sequence, node ids,
# entry values from input events, click / close / timeout results. Run: python3 test/gui_bridge/gui_py_test.py
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'pybridge'))

calls = []
replies = []


def fake_call(op, args=None, timeout=240.0):
    calls.append((op, args))
    return replies.pop(0) if replies else None


stub = types.ModuleType('fa_bridge')
stub.call = fake_call
sys.modules['fa_bridge'] = stub

import gui  # noqa: E402

failures = []


def check(name, cond):
    if not cond:
        failures.append(name)
        print('FAIL', name)


w = gui.Window('Name', width=320)
check('open op', calls[0][0] == 'gui.open' and calls[0][1]['title'] == 'Name' and calls[0][1]['width'] == 320)
check('window id is w + hex', w.id.startswith('w') and len(w.id) == 9)
e = w.entry('hi')
b = w.button('OK')
check('node ids', (e, b) == ('n1', 'n2'))
check('entry add', calls[1][1]['node'] == {'id': 'n1', 'kind': 'entry', 'value': 'hi'} and calls[1][1]['parent'] == 'root')
check('initial entry value', w.value(e) == 'hi')

replies[:] = [{'v': 1, 'event': 'input', 'id': w.id, 'node': e, 'value': 'Ann'},
              {'v': 1, 'event': 'click', 'id': w.id, 'node': b}]
ev = w.wait(timeout=30)
check('click after input', ev is not None and ev['node'] == b and ev['event'] == 'click')
check('input kept as value', w.value(e) == 'Ann')

replies[:] = [None]
check('timeout returns None', w.wait(timeout=5) is None)

replies[:] = [{'v': 1, 'event': 'close', 'id': w.id, 'node': 'root'}]
ev = w.wait(timeout=30)
check('close event', ev['event'] == 'close' and w.closed)

n = len(calls)
w.close()
check('no close op after closed', len(calls) == n)

w2 = gui.Window('Second')
w2.close()
check('close op sent', calls[-1] == ('gui.close', {'id': w2.id}))

# expander: a container, open flag is the value
w3 = gui.Window('Widgets')
calls.clear()
x = w3.expander('More', expanded=True)
check('expander add', calls[-1][1]['node'] == {'id': x, 'kind': 'expander', 'text': 'More', 'expanded': True})
check('expander initial value', w3.value(x) is True)
inner = w3.label('inside', parent=x)
check('expander child parent', calls[-1][1]['parent'] == x and inner != x)

# editor: text value, input event updates it
ed = w3.editor('print(1)', lang='python', rows=4)
check('editor add', calls[-1][1]['node'] == {'id': ed, 'kind': 'editor', 'value': 'print(1)', 'lang': 'python', 'rows': 4, 'numbers': True})
check('editor initial value', w3.value(ed) == 'print(1)')

# table: columns and rows, cell events update the grid
tb = w3.table(['name', 'qty'], [['a', '1'], ['b', '2']])
check('table add', calls[-1][1]['node'] == {'id': tb, 'kind': 'table', 'columns': ['name', 'qty'], 'rows': [['a', '1'], ['b', '2']]})
check('table initial value', w3.value(tb) == [['a', '1'], ['b', '2']])
bad = False
try:
    w3.table(['x', 'y'], [['only one']])
except ValueError:
    bad = True
check('table row length checked', bad)

# multilist: selected items as a list
ml = w3.multilist(['red', 'green', 'blue'], selected=['green'])
check('multilist add', calls[-1][1]['node'] == {'id': ml, 'kind': 'multilist', 'items': ['red', 'green', 'blue'], 'selected': ['green']})
check('multilist initial value', w3.value(ml) == ['green'])

# wait(): value events do not return, click does
replies[:] = [{'v': 1, 'event': 'cell', 'id': w3.id, 'node': tb, 'value': {'row': 1, 'col': 1, 'text': '9'}},
              {'v': 1, 'event': 'toggle', 'id': w3.id, 'node': x, 'value': False},
              {'v': 1, 'event': 'input', 'id': w3.id, 'node': ed, 'value': 'x = 2'},
              {'v': 1, 'event': 'select', 'id': w3.id, 'node': ml, 'value': ['red', 'blue']},
              {'v': 1, 'event': 'click', 'id': w3.id, 'node': 'b9'}]
ev = w3.wait(timeout=30)
check('value events do not return', ev is not None and ev['event'] == 'click')
check('cell updates table', w3.value(tb) == [['a', '1'], ['b', '9']])
check('toggle updates expander', w3.value(x) is False)
check('input updates editor', w3.value(ed) == 'x = 2')
check('select updates multilist', w3.value(ml) == ['red', 'blue'])

# textarea, checkbox, progress, listbox and set()
w4 = gui.Window('More widgets')
calls.clear()
ta = w4.textarea('note', rows=3, placeholder='say')
check('textarea add', calls[-1][1]['node'] == {'id': ta, 'kind': 'textarea', 'value': 'note', 'rows': 3, 'placeholder': 'say'})
cb = w4.checkbox('Keep', checked=True)
check('checkbox add', calls[-1][1]['node'] == {'id': cb, 'kind': 'checkbox', 'text': 'Keep', 'checked': True})
check('checkbox initial value', w4.value(cb) is True)
pb = w4.progress(10, max=50)
check('progress add', calls[-1][1]['node'] == {'id': pb, 'kind': 'progress', 'value': 10.0, 'max': 50.0})
lb = w4.listbox(['a', 'b'], selected='b')
check('listbox add', calls[-1][1]['node'] == {'id': lb, 'kind': 'list', 'items': ['a', 'b'], 'selected': 'b'})
check('listbox initial value', w4.value(lb) == 'b')
btn = w4.button('Go')
w4.set(btn, text='Stop', enabled=False)
check('set op', calls[-1] == ('gui.set', {'id': w4.id, 'node': btn, 'props': {'text': 'Stop', 'enabled': False}}))
w4.set(cb, checked=False)
check('set checked updates value', w4.value(cb) is False)
w4.set(ta, value='x')
check('set value updates textarea', w4.value(ta) == 'x')
w4.set(pb, value=40)
check('set on node without value keeps no value', w4.value(pb) is None)
replies[:] = [{'v': 1, 'event': 'change', 'id': w4.id, 'node': cb, 'value': True},
              {'v': 1, 'event': 'select', 'id': w4.id, 'node': lb, 'value': 'a'},
              {'v': 1, 'event': 'click', 'id': w4.id, 'node': btn}]
ev = w4.wait(timeout=30)
check('change and select do not return', ev is not None and ev['event'] == 'click')
check('change updates checkbox', w4.value(cb) is True)
check('select updates listbox', w4.value(lb) == 'a')
replies[:] = [{'v': 1, 'event': 'change', 'id': w4.id, 'node': cb, 'value': False}]
ev = w4.poll()
check('poll returns change and stores it', ev['event'] == 'change' and w4.value(cb) is False)

# grid and scroll containers
calls.clear()
g = w4.grid(3)
check('grid add', calls[-1][1]['node'] == {'id': g, 'kind': 'grid', 'columns': 3})
s = w4.scroll(150)
check('scroll add', calls[-1][1]['node'] == {'id': s, 'kind': 'scroll', 'height': 150})
lab = w4.label('in grid', parent=g)
check('grid child parent', calls[-1][1]['parent'] == g)

# theme, shortcut, tone
calls.clear()
w4.theme(palette={'bg': '#111111'}, font='monospace', size=14, radius=4)
check('theme op', calls[-1] == ('gui.theme', {'id': w4.id, 'palette': {'bg': '#111111'}, 'font': 'monospace', 'size': 14, 'radius': 4}))
w4.theme(size=16)
check('theme sends only what is given', calls[-1] == ('gui.theme', {'id': w4.id, 'size': 16}))
w4.shortcut('Ctrl+S', 'save')
check('shortcut op', calls[-1] == ('gui.shortcut', {'id': w4.id, 'keys': 'Ctrl+S', 'name': 'save'}))
w4.shortcut('Ctrl+S', None)
check('shortcut remove', calls[-1] == ('gui.shortcut', {'id': w4.id, 'keys': 'Ctrl+S', 'name': None}))
w4.tone(880, 50, 'square')
check('tone op', calls[-1] == ('gui.tone', {'id': w4.id, 'freq': 880.0, 'ms': 50, 'wave': 'square'}))
w4.tone()
check('tone defaults', calls[-1][1]['freq'] == 440.0 and calls[-1][1]['ms'] == 120 and calls[-1][1]['wave'] == 'sine')
replies[:] = [{'v': 1, 'event': 'shortcut', 'id': w4.id, 'node': 'root', 'value': 'save'}]
ev = w4.wait(timeout=30)
check('shortcut event is returned', ev is not None and ev['event'] == 'shortcut' and ev['value'] == 'save')

# tabs, split, menus, dialogs
w5 = gui.Window('Tabs')
tb = w5.tabs()
p1 = w5.tab('One', tb)
p2 = w5.tab('Two', tb)
check('tabs value is the first page', w5.value(tb) == p1)
check('tab op', calls[-1] == ('gui.add', {'id': w5.id, 'parent': tb, 'node': {'id': p2, 'kind': 'tab', 'text': 'Two'}}))
replies[:] = [{'v': 1, 'event': 'select', 'id': w5.id, 'node': tb, 'value': p2}, {'v': 1, 'event': 'click', 'id': w5.id, 'node': 'x'}]
w5.wait(timeout=30)
check('select event stores the page', w5.value(tb) == p2)
sp = w5.split('column', 40)
check('split op', calls[-1][1]['node']['kind'] == 'split' and calls[-1][1]['node']['ratio'] == 40 and calls[-1][1]['node']['direction'] == 'column')
mb = w5.menubar()
mn = w5.menu('File', mb)
mi = w5.menuitem('Save', mn, keys='Ctrl+S')
check('menuitem op', calls[-1][1]['node'] == {'id': mi, 'kind': 'menuitem', 'text': 'Save', 'keys': 'Ctrl+S'} and calls[-1][1]['parent'] == mn)
def wait_only(op, args=None, timeout=240.0):
    calls.append((op, args))
    if op == 'gui.wait':
        return replies.pop(0) if replies else {'v': 1, 'event': 'close', 'id': args['id'], 'node': 'root'}
    return None


stub.call = wait_only
# dialogs: the label is n1, the row is n2, the buttons follow (n3, n4); answered by a click on one of them
replies[:] = [{'v': 1, 'event': 'click', 'id': 'x', 'node': 'n3'}]
check('confirm yes', gui.confirm('sure?') is True)
replies[:] = [{'v': 1, 'event': 'click', 'id': 'x', 'node': 'n4'}]
check('confirm no', gui.confirm('sure?') is False)
replies[:] = [{'v': 1, 'event': 'close', 'id': 'x', 'node': 'root'}]
check('confirm closed is no', gui.confirm('sure?') is False)
replies[:] = [{'v': 1, 'event': 'click', 'id': 'x', 'node': 'n3'}]
gui.message('hello')
check('message closes its window', calls[-1][0] == 'gui.close')

# pick_file
import base64
picked = []


def pick_stub(op, args=None, timeout=240.0):
    calls.append((op, args))
    if op == 'gui.pickfile':
        return picked.pop(0) if picked else None
    return None


stub.call = pick_stub
picked[:] = [{'name': 'a.png', 'size': 3, 'mime': 'image/png', 'data': base64.b64encode(b'abc').decode(), 'path': 'C:/a.png'}]
f = gui.pick_file('Open', accept='image/*', max_bytes=1000)
check('pick_file op', calls[-1] == ('gui.pickfile', {'title': 'Open', 'accept': 'image/*', 'max_bytes': 1000}))
check('pick_file result', f == {'name': 'a.png', 'size': 3, 'mime': 'image/png', 'data': b'abc', 'path': 'C:/a.png'})
check('pick_file cancel is None', gui.pick_file() is None)
picked[:] = [{'error': 'too big'}]
try:
    gui.pick_file()
    check('pick_file error raises', False)
except ValueError as e:
    check('pick_file error raises', 'too big' in str(e))

# look and layout hints on any node: grow, gap, pad, role (and the window's first height)
wl = gui.Window("L", width=300, resizable=True, height=420)
check('open height', calls[-1][1].get('height') == 420)
col = wl.column(role="page", gap=0)
check('column role gap', calls[-1][1]['node'].get('role') == 'page' and calls[-1][1]['node'].get('gap') == 0.0)
ed2 = wl.editor("", parent=col, grow=1)
check('editor grow', calls[-1][1]['node'].get('grow') == 1.0 and calls[-1][1]['parent'] == col)
wl.label("x", parent=col)
check('no style leaks to the next node', 'grow' not in calls[-1][1]['node'] and 'role' not in calls[-1][1]['node'])
wl.set(ed2, grow=2)
check('set grow', calls[-1][1]['props'] == {'grow': 2})
wl.theme(density="compact")
check('theme density', calls[-1][1].get('density') == 'compact')

if failures:
    print('%d failure(s)' % len(failures))
    sys.exit(1)
print('gui_py: all checks passed (%d calls)' % len(calls))
