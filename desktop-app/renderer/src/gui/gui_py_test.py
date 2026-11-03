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
check('editor add', calls[-1][1]['node'] == {'id': ed, 'kind': 'editor', 'value': 'print(1)', 'lang': 'python', 'rows': 4})
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

if failures:
    print('%d failure(s)' % len(failures))
    sys.exit(1)
print('gui_py: all checks passed (%d calls)' % len(calls))
