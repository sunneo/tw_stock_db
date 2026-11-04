// CoLU+Thinking 階段 7 測試：思考逾時的硬性上限（guardedCall）與 jsonStep 逾時後的退路。假工作者，不載入任何真模型。
// 用法：node renderer/src/recipe/colu_think_timeout.test.js
const R = require('./recipe_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info))); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假工作者：仿照 floating-assistant.js 的 Worker 槽（pending 以 tid 對應，die 拒絕所有等待中的呼叫）。
// canInterrupt：收到中斷後是否很快停下（回覆 interruptedText）；hangForever：完全不回（像卡在一步計算裡）。
function fakeRec(opts) {
    opts = opts || {};
    const rec = { pending: new Map(), tid: 0, dead: false, interrupts: 0, dies: 0 };
    rec.rpc = (reply, delayMs) => {
        const tid = ++rec.tid;
        return new Promise((res, rej) => {
            rec.pending.set(tid, { res, rej });
            if (opts.hangForever) return;
            setTimeout(() => { if (rec.dead) return; const p = rec.pending.get(tid); if (!p) return; rec.pending.delete(tid); p.res(reply); }, delayMs);
        });
    };
    rec.interrupt = () => {
        rec.interrupts++;
        if (!opts.canInterrupt) return;
        // 可中斷：目前的呼叫很快回覆「已中斷」的結果（只回最早那一個）
        const first = rec.pending.keys().next(); if (first.done) return;
        const p = rec.pending.get(first.value); rec.pending.delete(first.value); setTimeout(() => p.res('已中斷'), 10);
    };
    rec.die = (msg) => { rec.dies++; rec.dead = true; for (const p of rec.pending.values()) p.rej(new Error(msg)); rec.pending.clear(); };
    return rec;
}

(async () => {
    // 1. 準時回覆：時限內回來，原樣給結果，不中斷、不終止
    let rec = fakeRec(); let t0 = Date.now();
    let v = await R.guardedCall(() => rec.rpc('準時', 20), { timeoutMs: 300, graceMs: 200, interrupt: () => rec.interrupt(), abandon: () => rec.die('x') });
    check('1 on-time reply is returned as is', v === '準時', v);
    check('1b on-time reply does not interrupt or kill', rec.interrupts === 0 && rec.dies === 0, { i: rec.interrupts, d: rec.dies });

    // 2. 超時、工作者可中斷：中斷後寬限內回來，拿到中斷後的結果，不終止工作者
    rec = fakeRec({ canInterrupt: true }); t0 = Date.now();
    v = await R.guardedCall(() => rec.rpc('完整', 5000), { timeoutMs: 100, graceMs: 300, interrupt: () => rec.interrupt(), abandon: () => rec.die('x') });
    check('2 interruptible worker returns its interrupted reply', v === '已中斷', v);
    check('2b interruptible worker is interrupted once and not killed', rec.interrupts === 1 && rec.dies === 0, { i: rec.interrupts, d: rec.dies });

    // 3. 超時、工作者卡住不回：寬限後放棄，錯誤帶 timeout，並且終止工作者
    rec = fakeRec({ hangForever: true }); t0 = Date.now();
    let err = null; try { await R.guardedCall(() => rec.rpc('永不', 0), { timeoutMs: 100, graceMs: 100, interrupt: () => rec.interrupt(), abandon: () => rec.die('已終止') }); } catch (e) { err = e; }
    check('3 stuck worker rejects with timeout flag', !!err && err.timeout === true, err && err.message);
    check('3b stuck worker is abandoned (killed) exactly once', rec.dies === 1 && rec.interrupts === 1, { i: rec.interrupts, d: rec.dies });

    // 4. 時限：超過 timeoutMs 加寬限，就必須回到呼叫端（允許 100 毫秒的計時誤差）
    const elapsed = Date.now() - t0;
    check('4 caller returns within timeoutMs + grace', elapsed >= 180 && elapsed < 100 + 100 + 150, elapsed);

    // 5. 舊結果晚到被丟棄：呼叫超時放棄後，原本的 Promise 才回來，呼叫端不會收到第二次結算
    let settles = 0; let lateVal = null;
    const slowStart = () => new Promise((res) => setTimeout(() => res('晚到的舊結果'), 250));
    try { await R.guardedCall(() => slowStart().then((x) => { settles++; lateVal = x; return x; }), { timeoutMs: 50, graceMs: 30, abandon: () => {} }); } catch (e) { err = e; }
    await sleep(300);
    check('5 late old result is discarded (caller got the timeout only)', !!err && err.timeout === true && settles === 1, { settles, lateVal });

    // 6. 連續呼叫不錯位：每次呼叫只拿到自己的結果（同一個工作者，順序與延遲都不同）
    rec = fakeRec(); const seq = [['甲', 60], ['乙', 10], ['丙', 30]]; const got = [];
    for (const [name, d] of seq) got.push(await R.guardedCall(() => rec.rpc(name, d), { timeoutMs: 500, graceMs: 100, interrupt: () => rec.interrupt(), abandon: () => rec.die('x') }));
    check('6 consecutive calls get their own results in order', got.join(',') === '甲,乙,丙', got);

    // 7. 超時後換一個新工作者，後續呼叫不被卡住
    const recA = fakeRec({ hangForever: true }); err = null;
    try { await R.guardedCall(() => recA.rpc('a', 0), { timeoutMs: 40, graceMs: 40, interrupt: () => recA.interrupt(), abandon: () => recA.die('終止') }); } catch (e) { err = e; }
    const recB = fakeRec(); const v7 = await R.guardedCall(() => recB.rpc('新工作者', 10), { timeoutMs: 200, graceMs: 50, abandon: () => recB.die('x') });
    check('7 after abandon the next call on a fresh worker is not stuck', !!err && v7 === '新工作者', { err: err && err.message, v7 });

    // 8. 沒給 timeoutMs：行為不變（不設計時器、不中斷、不終止）
    rec = fakeRec(); let calls = 0;
    v = await R.guardedCall(() => { calls++; return rec.rpc('慢但沒限時', 150); }, { interrupt: () => rec.interrupt(), abandon: () => rec.die('x') });
    check('8 no timeoutMs: slow reply still returned, no interrupt/abandon', v === '慢但沒限時' && rec.interrupts === 0 && rec.dies === 0 && calls === 1, { v, i: rec.interrupts, d: rec.dies });

    // 9. timeoutMs 為 0、負數、非數字：都當成沒給
    let same = true;
    for (const bad2 of [0, -5, 'abc', undefined]) { const r9 = await R.guardedCall(() => sleep(60).then(() => 'x'), { timeoutMs: bad2, interrupt: () => { same = false; }, abandon: () => { same = false; } }); if (r9 !== 'x') same = false; }
    check('9 timeoutMs 0/negative/non-number behaves as not given', same);

    // 10. start 同步丟錯：照原樣以錯誤結束，不是 timeout
    err = null; try { await R.guardedCall(() => { throw new Error('同步錯誤'); }, { timeoutMs: 100 }); } catch (e) { err = e; }
    check('10 synchronous throw rejects with that error (not timeout)', !!err && err.message === '同步錯誤' && !err.timeout, err && err.message);

    // 11. abandon 丟錯也照樣放棄：仍是 timeout 錯誤
    err = null; try { await R.guardedCall(() => new Promise(() => {}), { timeoutMs: 30, graceMs: 20, abandon: () => { throw new Error('壞掉'); } }); } catch (e) { err = e; }
    check('11 abandon throwing still rejects with timeout', !!err && err.timeout === true);

    // 12. 一般錯誤（工作者回報錯誤，不是逾時）：沒有 timeout 欄位
    err = null; try { await R.guardedCall(() => Promise.reject(new Error('工作者錯誤')), { timeoutMs: 100, graceMs: 10 }); } catch (e) { err = e; }
    check('12 ordinary worker error is not flagged as timeout', !!err && err.message === '工作者錯誤' && !err.timeout);

    // 13. jsonStep：思考那一輪逾時 → 關掉思考重問一次 → 答案合格就回 ok:true
    const calls13 = [];
    const gen13 = async (req) => { calls13.push(req); if (req.enableThinking === true) { const e = new Error('逾時（30 秒），已放棄這次回覆'); e.timeout = true; throw e; } return '{"gap":false,"note":""}'; };
    const r13 = await R.jsonStep({ generate: gen13, messages: [{ role: 'user', content: 'q' }], maxTries: 2, maxTokens: 160, prefill: '{"gap":', thinking: { enabled: true, timeoutMs: 30000, maxTokens: 400 }, validate: (o) => typeof o.gap === 'boolean' ? [] : ['gap 必須是布林'] });
    check('13 thinking timeout falls back to no-thinking retry', r13.ok === true && calls13.length === 2 && calls13[1].enableThinking === false, { ok: r13.ok, n: calls13.length });

    // 14. jsonStep：思考那一輪是一般錯誤（不是逾時）→ 維持原樣直接失敗，不退路
    const calls14 = [];
    const gen14 = async (req) => { calls14.push(req); throw new Error('連線失敗'); };
    const r14 = await R.jsonStep({ generate: gen14, messages: [{ role: 'user', content: 'q' }], maxTries: 2, maxTokens: 160, thinking: { enabled: true, timeoutMs: 30000, maxTokens: 400 }, validate: () => [] });
    check('14 ordinary thrown error is not retried (unchanged)', r14.ok === false && calls14.length === 1 && r14.error === '連線失敗', { ok: r14.ok, n: calls14.length });

    // 15. jsonStep：退路那一輪也逾時 → 最後 ok:false，錯誤是逾時
    const gen15 = async () => { const e = new Error('逾時'); e.timeout = true; throw e; };
    const r15 = await R.jsonStep({ generate: gen15, messages: [{ role: 'user', content: 'q' }], maxTries: 2, maxTokens: 160, thinking: { enabled: true, timeoutMs: 30000, maxTokens: 400 }, validate: () => [] });
    check('15 both thinking and fallback time out → ok:false', r15.ok === false && /逾時/.test(r15.error || ''), r15);

    // 16. jsonStep 沒有 thinking：拋錯照舊（只一次呼叫、不帶 timeoutMs）
    const calls16 = [];
    const r16 = await R.jsonStep({ generate: async (req) => { calls16.push(req); const e = new Error('逾時'); e.timeout = true; throw e; }, messages: [{ role: 'user', content: 'q' }], maxTries: 2, maxTokens: 160, validate: () => [] });
    check('16 no thinking: unchanged, single call, no timeoutMs field', r16.ok === false && calls16.length === 1 && !('timeoutMs' in calls16[0]));

    console.log(ok + ' passed, ' + bad.length + ' failed' + (bad.length ? ': ' + bad.join(', ') : ''));
    if (bad.length) process.exitCode = 1;
})();
