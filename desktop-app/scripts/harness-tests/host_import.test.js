// node scripts/harness-tests/host_import.test.js
// harness 經驗匯入訓練器（_hxImport）：用假的訓練器主機驗證——只收 harness 的 pattern、拒絕含路徑金鑰的、預設停用、重複匯入只更新、不寫工具。
const X = require('../../renderer/src/harness/experience_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };
global.window = { FaHarnessExp: X };
require('../../renderer/src/harness/harness_host.js');
const M = window.FaHarnessHost.methods;
const host = Object.assign({ domains: new Map(), synced: 0 }, M, {
    _otLoad: async function () { return { domains: this.domains }; },
    _otSaveDomain: async function (d) { this.domains.set(d.name, d); },
    _otSyncPatternExamples: async function () { this.synced++; }
});
const rec = (task) => X.makeRecord({ task, template: 'convert_units', verdict: 'ok', slots: { value: 1 }, missing: [], steps: [{ id: 'fields', kind: 'fill', by: 'model', tries: 1, ok: true }] });
const good = X.toTrainer(rec('把 12 公里換算成英里')).pattern;
const payload = (ps) => JSON.stringify({ v: 1, source: 'harness', patterns: ps });
(async () => {
    let r = await host._hxImport(payload([good]));
    const d = host.domains.get('harness_experience');
    check('匯入成功並建立獨立領域', r.ok && r.added === 1 && d && d.source === 'harness', r);
    check('領域預設停用（使用者自己決定要不要打開）', d.enabled === false && r.enabled === false);
    check('匯入的 pattern 沒有可執行的工具', d.patterns[0].tool === '' && d.patterns[0].source === 'harness');
    r = await host._hxImport(payload([good])); check('重複匯入只更新、不重複加', r.updated === 1 && r.added === 0 && d.patterns.length === 1, r);
    const evil = Object.assign({}, good, { id: 'hx_evil', examples: ['讀 C:\\Users\\bob\\secret.txt'] });
    const notHx = { id: 'x1', type: 'semantic', examples: ['a'], source: 'user' };
    r = await host._hxImport(payload([evil, notHx])); check('含路徑的、非 harness 來源的都被拒絕並附原因', r.rejected.length === 2 && r.added === 0 && /路徑|不是/.test(r.rejected[0].why + r.rejected[1].why), r.rejected);
    check('壞 JSON 與錯格式回錯誤', (await host._hxImport('{')).ok === false && (await host._hxImport('{"a":1}')).ok === false);
    check('有同步範例句向量', host.synced >= 2);
    console.log(ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '\n' + bad.join('\n') : '')); process.exit(bad.length ? 1 : 0);
})();
