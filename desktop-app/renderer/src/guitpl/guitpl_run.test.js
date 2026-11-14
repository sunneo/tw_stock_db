// node renderer/src/guitpl/guitpl_run.test.js -- 範本庫（data/*.json）載入、檢索、逐步詢問到組合出程式、假橋接空跑
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Run = require('./guitpl_run.js');
let n = 0; const ok = () => { n++; };

const dataDir = path.join(__dirname, 'data');
const files = {};
fs.readdirSync(dataDir).filter((f) => /\.json$/.test(f)).forEach((f) => { files[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); });
const lib = Run.buildLibrary(files);
assert.deepStrictEqual(lib.errors, [], lib.errors.join('；')); ok();
assert.ok(lib.byId['text-editor']); ok();

// 1. 領域不明
let r = Run.design(lib, '今天天氣真好');
assert.strictEqual(r.status, 'need_domain'); ok();

// 2. 需求含部分關鍵字：已命中的步驟不問，其餘依序問
r = Run.design(lib, '幫我做一個記事本，要多檔，淺色');
assert.strictEqual(r.status, 'need_answer'); assert.deepStrictEqual(r.auto.sort(), ['layout', 'palette']); ok();
assert.strictEqual(r.picks.layout, 'side-list'); assert.strictEqual(r.picks.palette, 'light'); ok();
assert.strictEqual(r.step.id, 'behavior'); assert.ok(/A\. 基本/.test(r.menu.text)); ok();

// 3. 逐題回答（離線字母選擇題的結果）直到組合
const T = require('./guitpl_core.js');
let answers = {};
for (let guard = 0; guard < 10; guard++) {
  r = Run.design(lib, '幫我做一個記事本，要多檔，淺色', { answers });
  if (r.status !== 'need_answer') { break; }
  const id = T.letterToOption(r.step, 'A');
  assert.ok(id); answers[r.step.id] = id;
}
assert.strictEqual(r.status, 'ok', JSON.stringify(r.errors)); ok();
assert.strictEqual(r.picks.layout, 'side-list'); assert.strictEqual(r.picks.shortcuts, 'editor'); ok();
assert.ok(r.code.includes('ids["files"] = w.listbox(["未命名 1"]')); ok();
assert.ok(r.code.includes('"bg": "#ffffff"')); ok();
assert.strictEqual(r.spec.source, 'builtin'); assert.strictEqual(r.spec.domain, 'text-editor'); ok();
assert.strictEqual(T.validateSpec(r.spec).ok, true); ok();

// 4. 「你決定」：全走預設；預設組整組套用；指定領域
r = Run.design(lib, '做個記事本', { defaults: true });
assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.picks.layout, 'toolbar-top'); assert.strictEqual(r.picks.palette, 'dark'); ok();
r = Run.design(lib, '簡單記事本', { defaults: true });
assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.preset, 'simple-notepad'); assert.strictEqual(r.picks.palette, 'light'); ok();
r = Run.design(lib, 'zzz', { domain: 'text-editor', defaults: true });
assert.strictEqual(r.status, 'ok'); ok();
assert.strictEqual(Run.design(lib, 'x', { domain: 'nope' }).status, 'error'); ok();

// 5. 領域檔壞掉會被擋在載入
const broken = JSON.parse(JSON.stringify(files)); broken['text-editor'].steps[0].options[0].default = false;
assert.ok(Run.buildLibrary(broken).errors.some((e) => /剛好一個 default/.test(e))); ok();
const broken2 = JSON.parse(JSON.stringify(files)); broken2['text-editor'].presets[0].picks.palette = 'nope';
assert.ok(Run.buildLibrary(broken2).errors.some((e) => /沒有選項 nope/.test(e))); ok();
const broken3 = JSON.parse(JSON.stringify(files)); delete broken3._common.theme;
assert.ok(Run.buildLibrary(broken3).errors.some((e) => /找不到共用步驟/.test(e))); ok();

// 6. 每個預設組合都能組合成程式（所有版面×行為×快捷鍵×音效），並通過假橋接空跑
const py = spawnSync('python', ['-I', '-c', 'print(3)'], { encoding: 'utf8' });
const havePython = py.status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guitpl-run-'));
let combos = 0;
lib.domains.forEach((d) => {
  const opt = (id) => d.steps.filter((s) => s.id === id)[0].options.map((o) => o.id).concat(d.steps.filter((s) => s.id === id)[0].optional ? [null] : []);
  const stepIds = d.steps.map((s) => s.id);
  // 每一步各自把每個選項試一次（其餘走預設），共 Σ 選項數 次
  stepIds.forEach((sid) => {
    opt(sid).forEach((choice) => {
      const ans = {}; ans[sid] = choice;
      const x = Run.design(lib, '', { domain: d.domain, answers: ans, defaults: true });
      assert.strictEqual(x.status, 'ok', d.domain + ' ' + sid + '=' + choice + ' ' + JSON.stringify(x.errors));
      combos++;
      if (havePython) {
        const prog = path.join(dir, 'p.py'), evs = path.join(dir, 'e.json');
        fs.writeFileSync(prog, x.code, 'utf8');
        // 事件：點每個按鈕一次、各種快捷鍵各按一次、對編輯區輸入、勾選取消
        const events = [];
        const walk = (nodes) => nodes.forEach((nd) => {
          if (nd.id && nd.kind === 'button') { events.push({ event: 'click', name: nd.id }); }
          if (nd.id && nd.kind === 'checkbox') { events.push({ event: 'change', name: nd.id, value: false }); }
          if (nd.id && (nd.kind === 'editor' || nd.kind === 'entry' || nd.kind === 'textarea')) { events.push({ event: 'input', name: nd.id, value: 'abc' }); }
          if (nd.children) { walk(nd.children); }
        });
        walk(x.spec.layout.tree);
        (x.spec.shortcuts || []).forEach((s) => events.push({ event: 'shortcut', value: s.do }));
        fs.writeFileSync(evs, JSON.stringify(events), 'utf8');
        const run = spawnSync('python', ['-I', path.join(__dirname, 'fake_run.py'), prog, evs], { encoding: 'utf8' });
        const line = (run.stdout || '').trim().split(/\r?\n/).pop();
        assert.strictEqual(run.status, 0, d.domain + ' ' + sid + '=' + choice + '\n' + line + run.stderr);
        assert.strictEqual(JSON.parse(line).ok, true);
      }
    });
  });
});
fs.rmSync(dir, { recursive: true, force: true });
assert.ok(combos >= 10); ok();
if (!havePython) { console.log('（沒有可用的 python，跳過假橋接空跑）'); }

console.log('guitpl_run.test.js: ' + n + ' groups OK，' + combos + ' 個組合' + (havePython ? '（含空跑）' : ''));
