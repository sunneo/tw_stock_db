# -*- coding: utf-8 -*-
# python -I renderer/src/guitpl/document_test.py -- the document template: text edits at the caret (pure functions) and the outline
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, 'lib', 'document')
failures = []
count = [0]


def check(name, cond):
    count[0] += 1
    if not cond:
        failures.append(name)
        print('FAIL', name)


def load(name):
    spec = importlib.util.spec_from_file_location('doc_' + name, os.path.join(LIB, name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


tb = load('toolbar')
sb = load('sidebar')

# heading: the caret's line, same level again takes it back, another level replaces
t, a, b = tb.apply_heading('hello\nworld', 2, 2, 1)
check('h1 on first line', t == '# hello\nworld' and a == b == 7)
t2, _, _ = tb.apply_heading(t, 3, 3, 1)
check('same level again removes it', t2 == 'hello\nworld')
t3, _, _ = tb.apply_heading('# hello', 0, 0, 2)
check('other level replaces', t3 == '## hello')
check('heading in the middle of the text', tb.apply_heading('a\nb\nc', 2, 2, 3)[0] == 'a\n### b\nc')
check('hashtag without space is not a heading', tb.apply_heading('#tag', 0, 0, 1)[0] == '# #tag')

# bold and italic
t, a, b = tb.apply_wrap('say hello now', 4, 9, '**', '粗體文字')
check('bold wraps the selection', t == 'say **hello** now' and t[a:b] == 'hello')
t, a, b = tb.apply_wrap('say **hello** now', 6, 11, '**', 'x')
check('bold on a wrapped selection takes it off', t == 'say hello now' and t[a:b] == 'hello')
t, a, b = tb.apply_wrap('ab', 1, 1, '*', '斜體文字')
check('no selection inserts the placeholder, selected', t == 'a*斜體文字*b' and t[a:b] == '斜體文字')
t, a, b = tb.apply_wrap('say hello', 4, 9, '**', 'x')
t, a, b = tb.apply_wrap(t, a, b, '**', 'x')
check('bold twice is a round trip', t == 'say hello')

# list and quote prefix over the lines the selection touches
t, a, b = tb.apply_prefix('one\ntwo\nthree', 0, 7, '- ')
check('bullets on two lines', t == '- one\n- two\nthree' and t[a:b] == '- one\n- two')
t, a, b = tb.apply_prefix(t, a, b, '- ')
check('bullets again take them off', t == 'one\ntwo\nthree')
check('quote on the caret line', tb.apply_prefix('a\nb', 2, 2, '> ')[0] == 'a\n> b')
check('prefix on an empty text', tb.apply_prefix('', 0, 0, '- ')[0] == '- ')

# insert paragraph: split at the caret, one blank line each side, placeholder selected
t, a, b = tb.apply_paragraph('first\n\nsecond', 5, 5)
check('paragraph inserted at the caret', t == 'first\n\n新段落\n\nsecond' and t[a:b] == '新段落')
t, a, b = tb.apply_paragraph('', 0, 0)
check('paragraph in an empty document', t == '新段落\n' and t[a:b] == '新段落')
t, a, b = tb.apply_paragraph('abc def', 3, 3)
check('paragraph in the middle of a line splits it', t == 'abc\n\n新段落\n\ndef')
t, a, b = tb.apply_paragraph('end', 3, 3)
check('paragraph at the end', t == 'end\n\n新段落\n' and t[a:b] == '新段落')

# outline
hs = sb.headings('# A\ntext\n## B\n```\n# not a heading\n```\n### C\n#tag\n####### seven')
check('outline levels and titles', [(h[0], h[1]) for h in hs] == [(1, 'A'), (2, 'B'), (3, 'C')])
check('outline offsets point at the line', all('# A\ntext\n## B\n```\n# not a heading\n```\n### C'[h[2]:h[2] + h[3]].lstrip('#').strip() == h[1] for h in hs))
check('outline labels are indented by level', sb.labels(hs) == ['A', '  B', '    C'])

# wired into the template with the fake bridge: caret, insert, outline jump
sys.path.insert(0, HERE)
import lint  # noqa: E402  (installs the fake bridge)
import guitpl  # noqa: E402

lint.ops.clear()
del lint.pending[:]
r = guitpl.run('document/main', roots=[os.path.join(HERE, 'lib')], loop=False)
ctx, handlers, ids = r['ctx'], r['handlers'], r['ids']
errs = []
ctx.error = errs.append
handlers['start'](ctx)
check('outline from the starting text', ctx.state['outline_names'][:2] == ['未命名文件', '  第一節'])
ctx.w._carets[ids['body']] = (5, 5)
lint.ops.clear()
handlers['click:insert_para'](ctx)
sets = [a for o, a in lint.ops if o == 'gui.set' and a['node'] == ids['body']]
check('insert sends value and caret in one set', len(sets) == 1 and 'caret' in sets[0]['props'] and '新段落' in sets[0]['props']['value'])
check('the editor value is tracked', '新段落' in ctx.get('body'))
ctx.event = {'event': 'select', 'node': ids['outline'], 'value': ctx.state['outline_names'][1]}
lint.ops.clear()
handlers['select:outline'](ctx)
sets = [a for o, a in lint.ops if o == 'gui.set' and a['node'] == ids['body']]
check('outline click moves the caret to the heading', len(sets) == 1 and sets[0]['props']['caret'] == ctx.state['outline'][1][2])
lint.ops.clear()
handlers['click:preview_btn'](ctx)
sets = [(a['node'], a['props']) for o, a in lint.ops if o == 'gui.set']
check('preview shows the rendered view and hides the editor', (ids['view'], {'visible': True}) in sets and (ids['body'], {'visible': False}) in sets
      and any(n == ids['view'] and 'value' in p for n, p in sets))
before = ctx.get('body')
handlers['click:bold'](ctx)
check('no editing while previewing', ctx.get('body') == before)
handlers['click:preview_btn'](ctx)
check('back to editing', ctx.state['preview'] is False)
check('no errors', not errs)

if failures:
    print('%d failure(s)' % len(failures))
    sys.exit(1)
print('document: %d checks passed' % count[0])
