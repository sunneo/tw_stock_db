// node renderer/src/guitpl/compose_core.test.js -- 組合器：規格＋動作表 → Python 程式；語法檢查與假橋接空跑（需要本機有 python）
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./compose_core.js');
let n = 0; const ok = () => { n++; };

const PAL = { bg: '#1e1e1e', fg: '#dddddd', accent: '#4aa3ff', danger: '#e5534b', muted: '#888888' };
const spec = () => ({
  format: 'guitpl/1', id: 'mini-editor', domain: 'text-editor', title: '小編輯器', source: 'builtin',
  layout: { window: { title: '小編輯器', width: 480, resizable: true }, tree: [
    { kind: 'column', children: [
      { kind: 'row', children: [{ id: 'save', kind: 'button', text: '存檔' }, { id: 'wrap', kind: 'checkbox', text: '自動換行', checked: true }] },
      { id: 'ed', kind: 'editor', value: 'hello "世界"\n', lang: 'text', rows: 10 },
      { id: 'status', kind: 'label', text: '就緒' },
      { id: 'bar', kind: 'progress', value: 0, max: 100, enabled: true }
    ] }] },
  behavior: { state: { saved: 0, flag: true, none: null }, handlers: [
    { on: 'click:save', do: 'save_file' }, { on: 'change:wrap', do: 'toggle_wrap' }] },
  palette: PAL, theme: { name: 'dark', font: 'monospace', size: 14, radius: 4 },
  shortcuts: [{ keys: 'Ctrl+S', do: 'save_file' }],
  sound: [{ on: 'save_file', tone: 'ok' }],
  scenes: [{ id: 'main', title: '主畫面' }]
});
const actions = () => ({
  save_file: { params: [], python: 'def save_file(ctx):\n    ctx.state["saved"] += 1\n    ctx.set("status", text="已存 %d 次" % ctx.state["saved"])\n    ctx.set("bar", value=100)\n' },
  toggle_wrap: { params: [], python: 'def toggle_wrap(ctx):\n    ctx.state["wrap"] = ctx.get("wrap")\n' }
});

// 1. 產生的程式：結構與內容
const r = C.compose(spec(), actions());
assert.ok(r.ok, r.errors.join('；')); ok();
assert.strictEqual(r.loop, 'poll', 'change 事件要用輪詢'); ok();
assert.deepStrictEqual(r.usedActions.sort(), ['save_file', 'toggle_wrap']); ok();
assert.ok(/^import gui$/m.test(r.code)); ok();
assert.ok(r.code.includes('w = gui.Window("小編輯器", width=480, resizable=True, maximizable=False)')); ok();
assert.ok(r.code.includes('w.theme(palette={"bg": "#1e1e1e"')); ok();
assert.ok(r.code.includes('font="monospace", size=14, radius=4')); ok();
assert.ok(r.code.includes('ids["ed"] = w.editor("hello \\"世界\\"\\n", lang="text", rows=10, parent=ids["auto_1"])') || /ids\["ed"\] = w\.editor\("hello \\"世界\\"\\n", lang="text", rows=10, parent=/.test(r.code)); ok();
assert.ok(r.code.includes('w.shortcut("Ctrl+S", "save_file")')); ok();
assert.ok(r.code.includes('state = {"saved": 0, "flag": True, "none": None}'), 'Python 字面值'); ok();
assert.ok(/ROUTES = \{[^}]*\("click", ids\["save"\]\): save_file/.test(r.code)); ok();
assert.ok(r.code.includes('("shortcut", "save_file"): save_file'), '快捷鍵自動進路由'); ok();
assert.ok(r.code.includes('w.set(ids["bar"], enabled=True)'), '通用屬性用 set'); ok();
assert.strictEqual(C.compose(spec(), actions()).code, r.code, '確定性：同樣輸入同樣輸出'); ok();

// 2. 只有 click 與快捷鍵時用 wait 迴圈
{
  const s = spec(); s.behavior.handlers = [{ on: 'click:save', do: 'save_file' }];
  const a = actions(); delete a.toggle_wrap;
  const r2 = C.compose(s, a);
  assert.ok(r2.ok, r2.errors.join('；')); assert.strictEqual(r2.loop, 'wait'); assert.ok(r2.code.includes('w.wait(timeout=3600)')); ok();
}

// 3. 拒絕的情況
{
  let s = spec(); s.layout.tree[0].children.push({ id: 'g', kind: 'grid' });
  let x = C.compose(s, actions()); assert.strictEqual(x.ok, false); assert.ok(x.errors.some((e) => /不支援的節點種類 grid/.test(e))); ok();
  s = spec(); x = C.compose(s, { save_file: actions().save_file });
  assert.ok(!x.ok && x.errors.some((e) => /動作不存在：toggle_wrap/.test(e))); ok();
  s = spec(); const a = actions(); a.save_file.python = 'def other(ctx):\n    pass';
  x = C.compose(s, a); assert.ok(!x.ok && x.errors.some((e) => /必須以 def save_file\(ctx\)/.test(e))); ok();
  s = spec(); s.layout.tree[0].children[2].color = 'red';
  x = C.compose(s, actions()); assert.ok(!x.ok && x.errors.some((e) => /不支援屬性 color/.test(e))); ok();
  s = spec(); s.layout.tree[0].children[2].children = [{ kind: 'label', text: 'x' }];
  x = C.compose(s, actions()); assert.ok(!x.ok && x.errors.some((e) => /不是容器/.test(e))); ok();
  assert.ok(!C.compose({ format: 'guitpl/1' }, {}).ok); ok();
}

// 4. python 語法檢查與假橋接空跑（沒有 python 就跳過這一組並印出來）
const py = spawnSync('python', ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
if (py.status !== 0 || py.stdout.trim() !== '3') {
  console.log('（沒有可用的 python，跳過語法檢查與空跑）');
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guitpl-'));
  const prog = path.join(dir, 'prog.py');
  const evs = path.join(dir, 'events.json');
  fs.writeFileSync(prog, r.code, 'utf8');
  const events = [{ event: 'click', name: 'save' }, { event: 'shortcut', value: 'save_file' }, { event: 'change', name: 'wrap', value: false },
    { event: 'click', name: 'save' }];
  fs.writeFileSync(evs, JSON.stringify(events), 'utf8');
  const run = spawnSync('python', ['-I', path.join(__dirname, 'fake_run.py'), prog, evs], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  const out = JSON.parse(run.stdout.trim().split(/\r?\n/).pop());
  assert.strictEqual(out.ok, true, out.error); ok();
  assert.strictEqual(out.state.saved, 3, '三次存檔（兩次點擊、一次快捷鍵）'); ok();
  assert.strictEqual(out.state.wrap, false, 'change 事件經輪詢進動作，值被 gui.py 記下'); ok();
  const names = out.ops.map((o) => o[0]);
  assert.strictEqual(names[0], 'gui.open'); assert.ok(names.indexOf('gui.theme') > 0 && names.indexOf('gui.shortcut') > 0); ok();
  assert.strictEqual(names.filter((x) => x === 'gui.tone').length, 3, '每次存檔響一聲'); ok();
  assert.strictEqual(names[names.length - 1], 'gui.poll', '關閉事件結束迴圈；視窗已被使用者關掉，不再送關閉'); ok();
  const statusSets = out.ops.filter((o) => o[0] === 'gui.set' && o[1].node === out.ids.status);
  assert.strictEqual(statusSets[statusSets.length - 1][1].props.text, '已存 3 次'); ok();
  // 動作丟例外 → 空跑回報失敗（驗收第三關）
  const bad = r.code.replace('ctx.state["saved"] += 1', 'ctx.state["nope"] += 1');
  fs.writeFileSync(prog, bad, 'utf8');
  const run2 = spawnSync('python', ['-I', path.join(__dirname, 'fake_run.py'), prog, evs], { encoding: 'utf8' });
  assert.strictEqual(run2.status, 1); assert.ok(/KeyError/.test(JSON.parse(run2.stdout.trim().split(/\r?\n/).pop()).error)); ok();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('compose_core.test.js: ' + n + ' groups OK');
