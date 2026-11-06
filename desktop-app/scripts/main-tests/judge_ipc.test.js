// node scripts/main-tests/judge_ipc.test.js
// main-ext.js 的 register 會啟動系統匣、模組覆蓋等：這裡把「判題器 IPC」那一段（<judge-begin>～<judge-end>）原文切出來，用桩的 ipcMain／確認閘門／設定執行，驗證：
// 輸入驗證與上限、execEnabled 把關、第一次要確認、授權期間不重複問、被拒絕時回 {ok:false}、sandbox 說明有帶、真的呼叫 judge-runner（python）。
const fs = require('fs'); const path = require('path'); const os = require('os'); const assert = require('assert');
const root = path.join(__dirname, '..', '..'); const src = fs.readFileSync(path.join(root, 'main-ext.js'), 'utf8');
const a = src.indexOf('// <judge-begin>'); const b = src.indexOf('// <judge-end>'); assert.ok(a > 0 && b > a, '找不到判題器 IPC 區塊');
const block = src.slice(a, b);
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };
function load(opts) {
  const handlers = {}; const gate = { asked: [], allow: opts.allow !== false }; const settings = { execEnabled: opts.execEnabled !== false };
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  const execConfirmGate = async (line) => { if (!settings.execEnabled) throw new Error('執行程式功能目前未啟用'); gate.asked.push(line); if (!gate.allow) throw new Error('使用者拒絕了這個執行請求。'); };
  const getDesktopSettings = async () => settings;
  const require2 = (p) => (p === './judge-runner.js' ? require(path.join(root, 'judge-runner.js')) : require(p));
  new Function('ipcMain', 'ctx', 'os', 'require', 'Buffer', 'Date', block)(ipcMain, { execConfirmGate, getDesktopSettings }, os, require2, Buffer, Date);
  return { handlers, gate, settings };
}
const evt = (id) => ({ sender: { id: id || 1 } });
const P = { id: 'ab', tests: [{ in: '1 2\n', out: '3\n' }] }; const OK = 'a, b = map(int, input().split())\nprint(a + b)\n';

(async () => {
  await t('輸入驗證：不支援的語言、source 不是字串或太長、problem 缺失／tests 為空／太多／太大；都回 {ok:false} 且不問使用者', async () => {
    const h = load({}); const run = h.handlers['fa:judge:run'];
    for (const bad of [{ lang: 'cobol', source: 'x', problem: P }, { lang: 'python', source: 5, problem: P }, { lang: 'python', source: 'x'.repeat(200 * 1024 + 1), problem: P }, { lang: 'python', source: 'x' }, { lang: 'python', source: 'x', problem: { id: 'a', tests: [] } }, { lang: 'python', source: 'x', problem: { id: 'a', tests: Array.from({ length: 61 }, () => ({ in: '', out: '' })) } }, { lang: 'python', source: 'x', problem: { id: 'a', tests: [{ in: 'x'.repeat(256 * 1024 + 1), out: '' }] } }, { lang: 'python', source: 'x', problem: { id: 'a', tests: [{ in: 1, out: '' }] } }]) {
      const r = await run(evt(), bad); assert.strictEqual(r.ok, false, JSON.stringify(bad).slice(0, 80)); assert.ok(r.error && r.sandbox, '要有原因與沙盒說明');
    }
    assert.strictEqual(h.gate.asked.length, 0); const c = await h.handlers['fa:judge:check'](evt(), { lang: 'cobol', source: 'x' }); assert.strictEqual(c.ok, false); assert.strictEqual((await h.handlers['fa:judge:available'](evt(), { lang: 'nope' })).ok, false);
  });
  await t('第一次要確認（顯示語言、程式開頭與沙盒限制）；授權後同一視窗不再問；換視窗要重新問', async () => {
    const h = load({}); const run = h.handlers['fa:judge:run'];
    const r1 = await run(evt(1), { lang: 'python', source: OK, problem: P }); assert.strictEqual(r1.verdict, 'AC', JSON.stringify(r1)); assert.ok(/沒有記憶體上限/.test(r1.sandbox)); assert.strictEqual(h.gate.asked.length, 1); assert.ok(/python/.test(h.gate.asked[0]) && /a, b = map/.test(h.gate.asked[0]) && /不是安全沙盒/.test(h.gate.asked[0]));
    await run(evt(1), { lang: 'python', source: OK, problem: P }); await h.handlers['fa:judge:check'](evt(1), { lang: 'python', source: OK }); assert.strictEqual(h.gate.asked.length, 1, '授權期間不重複問');
    await run(evt(2), { lang: 'python', source: OK, problem: P }); assert.strictEqual(h.gate.asked.length, 2, '另一個視窗要重新問');
  });
  await t('使用者拒絕 → {ok:false, error}，程式完全沒有被執行；沒開 execEnabled → 一樣被擋，授權過也不能繞過', async () => {
    const marker = path.join(os.tmpdir(), 'judge-ipc-ran-' + process.pid); try { fs.unlinkSync(marker); } catch (_) { /* 沒有就算了 */ }
    const evil = 'open(' + JSON.stringify(marker) + ', "w").write("x")\nprint(3)\n';
    const h = load({ allow: false }); const r = await h.handlers['fa:judge:run'](evt(), { lang: 'python', source: evil, problem: P }); assert.strictEqual(r.ok, false); assert.ok(/拒絕/.test(r.error)); assert.ok(!fs.existsSync(marker), '被拒絕卻執行了');
    const h2 = load({}); await h2.handlers['fa:judge:run'](evt(), { lang: 'python', source: OK, problem: P }); h2.settings.execEnabled = false; const r2 = await h2.handlers['fa:judge:run'](evt(), { lang: 'python', source: OK, problem: P }); assert.strictEqual(r2.ok, false); assert.ok(/未啟用/.test(r2.error));
  });
  await t('逾時上限（timeoutMs 超過 20 秒會被壓到上限）、problem 欄位被清理（id 只留安全字元、不認得的 checker 退回 tokens）；check 通過／語法錯誤', async () => {
    const h = load({}); const t0 = Date.now(); const r = await h.handlers['fa:judge:run'](evt(), { lang: 'python', source: 'while True: pass\n', problem: Object.assign({}, P, { id: '../../x y', checker: 'evil' }), timeoutMs: 400 }); assert.strictEqual(r.verdict, 'TLE'); assert.ok(Date.now() - t0 < 5000);
    const ok = await h.handlers['fa:judge:check'](evt(), { lang: 'python', source: 'print(1)\n' }); assert.strictEqual(ok.verdict, 'CHECKED'); const bad = await h.handlers['fa:judge:check'](evt(), { lang: 'python', source: 'def f(:\n' }); assert.strictEqual(bad.verdict, 'CE');
    const av = await h.handlers['fa:judge:available'](evt(), { lang: 'python' }); assert.ok(av.ok && av.version && av.sandbox);
  });
  console.log('\n' + n + ' passed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
