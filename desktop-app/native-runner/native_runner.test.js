// 原生執行器階段 3 的單元測試（node 直接跑，不需要 Electron；子程序是真的 child.js，假推論引擎）。
// 用法：node native-runner/native_runner.test.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const proto = require('./protocol.js');
const { createNativeRunnerHost } = require('./host.js');

const CHILD = path.join(__dirname, 'child.js');
let ok = 0; const bad = [];
const check = (name, c, x) => { if (c) ok++; else { bad.push(name); console.log('FAIL', name, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-test-'));
const mkHost = (o) => createNativeRunnerHost(Object.assign({ childPath: CHILD, progressFile: path.join(tmpDir, 'progress-' + Math.random().toString(36).slice(2) + '.jsonl'), idleMs: 0, graceMs: 1000, handshakeMs: 5000 }, o || {}));
async function settle(p) { try { return { ok: true, v: await p }; } catch (e) { return { ok: false, code: e.code, msg: e.message, e }; } }

(async () => {
    // ---- 協定（純函式）----
    const enc = proto.encodeLine({ type: 'cancel', id: 'x' });
    check('encodeLine 結尾是換行', enc.endsWith('\n') && !enc.slice(0, -1).includes('\n'));
    const dec = proto.createLineDecoder();
    const got = dec.push('{"type":"cancel","id":"a"}\r\n{"type":"cancel"'); const got2 = dec.push(',"id":"b"}\n');
    check('LineDecoder 處理 \\r\\n 與分段到達', got.length === 1 && got2.length === 1 && proto.parseLine(got2[0]).ok, { got, got2 });
    check('validate 缺必填欄位', !proto.validate({ type: 'run', id: '1' }).ok);
    check('validate 未知種類', !proto.validate({ type: 'nope', id: '1' }).ok);
    check('validate error.code 不合法', !proto.validate({ type: 'error', id: '1', code: 'weird' }).ok);
    check('parseLine 非 JSON 不丟例外', proto.parseLine('{bad').ok === false);

    // ---- 1 lazy_start ----
    const h1 = mkHost();
    check('lazy_start：沒有 run 前子程序未啟動', h1.status().alive === false);
    const r1 = await settle(h1.run({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, fake: { reply: 'hello' } }));
    check('lazy_start：第一次 run 後子程序啟動並回傳結果', r1.ok && r1.v.text === 'hello' && h1.status().alive === true, r1);
    h1.dispose('測試結束');

    // ---- 2 idle_close ----
    const h2 = mkHost({ idleMs: 1500 });
    await settle(h2.run({ fake: { reply: 'x' } }));
    await sleep(2800);
    check('idle_close：閒置超過 idleMs 後子程序結束', h2.status().alive === false, h2.status());

    // ---- 3 stream ----
    const h3 = mkHost();
    const toks = [];
    const r3 = await settle(h3.run({ stream: true, onToken: (t) => toks.push(t), fake: { reply: 'abcdef' } }));
    check('stream：每個 token 都送達，完整文字正確', r3.ok && toks.join('') === 'abcdef' && toks.length === 6 && r3.v.text === 'abcdef', { toks, r3 });
    h3.dispose('測試');

    // ---- 4 crash_restart_once ----
    const h4 = mkHost();
    const r4a = await settle(h4.run({ fake: { crash: true } }));
    check('crash：崩潰時呼叫端收到 crashed', !r4a.ok && r4a.code === 'crashed', r4a);
    await sleep(600);
    const r4b = await settle(h4.run({ fake: { reply: 'after' } }));
    check('crash_restart_once：崩潰後自動重啟，下一次 run 成功', r4b.ok && r4b.v.text === 'after' && h4.status().consecutiveCrashes === 0 && h4.status().disabled === false, { r4b, s: h4.status() });
    h4.dispose('測試');

    // ---- 5 crash_twice_fallback ----
    const h5 = mkHost();
    await settle(h5.run({ fake: { crash: true } }));
    await sleep(600);
    await settle(h5.run({ fake: { crash: true } }));
    await sleep(600);
    const s5 = h5.status();
    const r5 = await settle(h5.run({ fake: { reply: 'x' } }));
    check('crash_twice_fallback：連續兩次崩潰後停用原生路徑', s5.disabled === true && !r5.ok && r5.code === 'native_disabled' && /連續崩潰 2 次/.test(r5.msg), { s5, r5 });

    // ---- 6 cancel ----
    const h6 = mkHost();
    let runId6 = null;
    const p6 = settle(h6.run({ stream: true, fake: { reply: 'x'.repeat(300), delay_ms: 20 }, onStart: (id) => { runId6 = id; } }));
    await sleep(300);
    const t6 = Date.now();
    const cancelled6 = runId6 !== null && h6.cancel(runId6);
    const r6 = await p6;
    check('cancel：取消後呼叫端在 3 秒內收到 cancelled', cancelled6 === true && !r6.ok && r6.code === 'cancelled' && Date.now() - t6 < 3000, { runId6, r6 });
    h6.dispose('測試');

    // ---- 7 timeout（子程序忽略取消，只能強制結束）----
    const h7 = mkHost({ graceMs: 1000 });
    const t7 = Date.now();
    const r7 = await settle(h7.run({ timeoutMs: 800, fake: { reply: 'y'.repeat(2000), delay_ms: 30, ignore_cancel: true } }));
    const dt7 = Date.now() - t7;
    check('timeout：逾時拋 code=timeout 且 timeout=true，約 timeoutMs+graceMs 內結束', !r7.ok && r7.code === 'timeout' && r7.e.timeout === true && dt7 < 4000, { r7, dt7 });
    check('timeout：強制結束後子程序不在（不計入崩潰）', h7.status().alive === false && h7.status().consecutiveCrashes === 0, h7.status());

    // ---- 8 progress_survives_kill ----
    const pf8 = path.join(tmpDir, 'progress-kill.jsonl');
    const h8 = mkHost({ progressFile: pf8 });
    const p8 = settle(h8.run({ stream: true, timeoutMs: 0, fake: { reply: 'abcdefghijkl', stuck: true } }));
    await sleep(1200);
    const pid8 = h8.status().pid;
    try { process.kill(pid8, 'SIGKILL'); } catch (_) {}
    const r8 = await p8;
    const lines8 = fs.existsSync(pf8) ? fs.readFileSync(pf8, 'utf8').split('\n').filter(Boolean) : [];
    check('progress_survives_kill：子程序被殺後，進度檔仍有崩潰前的紀錄', lines8.length >= 2 && lines8.some((l) => /"stage":"stuck"|"stage":"generate"/.test(l)), { lines8: lines8.length, r8 });

    // ---- 9 version_mismatch ----
    const h9 = mkHost({ env: { NATIVE_RUNNER_FAKE_VERSION: '2' } });
    const r9 = await settle(h9.run({ fake: { reply: 'z' } }));
    check('version_mismatch：協定版本不符時拒絕啟動並停用，回報原因', !r9.ok && r9.code === 'version_mismatch' && h9.status().disabled === true, { r9, s: h9.status() });

    // ---- 10 load_failed（假引擎的模型檔不存在）----
    const h10 = mkHost();
    const h10ensure = await settle(h10._ensureChild());
    check('握手成功（hello／hello_ack）', h10ensure.ok, h10ensure);
    h10.dispose('測試');

    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAIL 例外', e); process.exit(1); });
