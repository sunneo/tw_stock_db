'use strict';
// 離線思考堆疊（缺口 C、E、I 的純程式部分）：層框、卡在哪、模型標頭、成品檢查、路由量測骨架（用確定性的假模型，不代表真模型的效果）。
const assert = require('assert'); const T = require('./think_stack.js'); const O = require('./offline_stack_core.js');
let pass = 0, fail = 0; const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 6).join('\n   ')); } };
const ROUNDS = [{ by: 'recipe', ok: false, reason: '沒有配方' }, { by: 'lesson', ok: false, reason: '沒教過', tried: 0 }, { by: 'paradigm', ok: false, tried: 12, reason: '12 個骨架都沒過沙盒' }, { by: 'matrix', ok: false, reason: '不是矩陣題' }];
(async () => {
    await t('C：每一層一個框，失敗層為 failed，根框架開著並記下各層沒解出來', () => {
        const st = O.fromRounds('求陣列最大值', ROUNDS); assert.strictEqual(st.frames.length, 1); assert.strictEqual(st.frames[0].path, '離線寫程式');
        assert.deepStrictEqual(st.done.map((f) => f.path + ':' + f.state), ['配方:failed', '課:failed', '範式:failed', '矩陣:failed']);
        assert.strictEqual(O.stuckAt(st), '矩陣'); assert.ok(st.frames[0].decisions.length >= 1);
        const ok = O.fromRounds('x', [{ by: 'recipe', ok: false, reason: 'a' }, { by: 'paradigm', ok: true, tried: 3 }]); assert.strictEqual(O.stuckAt(ok), null);
    });
    await t('C：標頭帶各層摘要與「不要重複失敗的路」，有字元上限', () => {
        const st = O.fromRounds('求陣列最大值', ROUNDS); const h = O.modelHeader(st);
        assert.ok(/【目標】求陣列最大值/.test(h) && /範式✘（試 12 個）/.test(h) && /不要重複/.test(h), h); assert.ok(T.header(st).length <= st.opts.maxHeaderChars);
        assert.strictEqual(O.modelHeader(O.fromRounds('x', [])), '');
    });
    await t('C：JSONL 往返還原同一個堆疊', () => {
        const st = O.fromRounds('求陣列最大值', ROUNDS); const back = T.fromJsonl(T.toJsonl(st));
        assert.ok(back); assert.strictEqual(back.done.length, st.done.length); assert.strictEqual(O.stuckAt(back), '矩陣');
    });
    await t('E：程式檢查永遠跑；自問預設不跑，開了才跑且寫進堆疊', async () => {
        const checks = [{ name: '不空', run: (r) => ({ ok: r.length > 0, msg: '空' }) }, { name: '有 print', run: (r) => ({ ok: /print/.test(r), msg: '沒輸出' }) }];
        const st = O.fromRounds('x', ROUNDS.slice(0, 1)); let asked = 0; const ask = async () => { asked++; return { ok: false, missing: '沒處理空輸入' }; };
        const a = await O.selfCheck(st, { result: 'x = 1', progChecks: checks, ask }); assert.strictEqual(asked, 0, '預設不問模型'); assert.strictEqual(a.ok, false); assert.strictEqual(a.problems[0].check, '有 print');
        const b = await O.selfCheck(st, { result: 'print(1)', progChecks: checks, ask, enabled: true }); assert.strictEqual(asked, 1); assert.strictEqual(b.ok, false); assert.strictEqual(b.problems[0].by, 'model'); assert.ok(st.done.some((f) => f.path === '成品自問' && f.state === 'failed'));
        const c = await O.selfCheck(O.fromRounds('x', []), { result: 'print(1)', progChecks: checks, ask: async () => ({ ok: true, missing: '' }), enabled: true }); assert.strictEqual(c.ok, true);
        const d = await O.selfCheck(O.fromRounds('x', []), { result: 'print(1)', progChecks: [], ask: async () => { throw new Error('壞了'); }, enabled: true }); assert.strictEqual(d.ok, true, '問不出來不阻擋'); assert.strictEqual(d.asked, false);
    });
    await t('I：路由量測骨架跑得動，兩種變體都有數字、堆疊版的提示帶標頭（假模型只驗骨架，不是效果）', async () => {
        const cands = [{ tool: 'calc', intent: '算數' }, { tool: 'search', intent: '搜尋網頁' }, { tool: 'code', intent: '寫程式' }];
        const cases = [{ question: '幫我算 3+4', cands, want: 'calc' }, { question: '查一下天氣', cands, want: 'search' }, { question: '寫一個排序', cands, want: 'code' }, { question: '你好', cands, want: null }];
        const seen = []; const generate = async (req) => { const txt = req.messages.map((m) => m.content).join(' '); seen.push(txt); const q = (/使用者[^]*?(3\+4|天氣|排序|你好)/.exec(txt) || [])[1]; const n = { '3+4': 1, '天氣': 2, '排序': 3, '你好': 0 }[q]; return '{"choice": ' + (n == null ? 0 : n) + '}'; };
        const r = await O.measureRoute({ cases, generate, variants: ['off', 'stack'] });
        assert.strictEqual(r.off.n, 4); assert.strictEqual(r.stack.n, 4); assert.ok(r.off.calls >= 4 && r.stack.calls >= 4); assert.ok(typeof r.off.accuracy === 'number');
        assert.ok(seen.some((s) => /【目標】/.test(s)), '堆疊版提示應帶焦點標頭');
    });
    await t('接線入口 wireOffline：失敗只做 C（標頭、卡在哪）；成功做 E（風格提醒）；出錯不丟例外', async () => {
        const f = await O.wireOffline({ goal: 'g', result: { ok: false, rounds: ROUNDS } }); assert.strictEqual(f.stuckAt, '矩陣'); assert.ok(/不要重複/.test(f.header)); assert.strictEqual(f.check, null); assert.ok(Array.isArray(f.stack) && f.stack.length >= 5);
        const styleFn = () => ({ ok: false, functions: { mixed: ['getX'] }, variables: { mixed: [] } });
        const s = await O.wireOffline({ goal: 'g', result: { ok: true, source: 'def getX(): pass', rounds: [{ by: 'paradigm', ok: true, tried: 2 }] }, styleFn }); assert.strictEqual(s.header, ''); assert.strictEqual(s.stuckAt, null); assert.strictEqual(s.check.ok, false); assert.ok(/命名風格混用：getX/.test(s.note));
        const s2 = await O.wireOffline({ goal: 'g', result: { ok: true, source: 'x', rounds: [] }, styleFn: () => ({ ok: true }) }); assert.strictEqual(s2.check.ok, true); assert.strictEqual(s2.note, '');
        const s3 = await O.wireOffline({ goal: 'g', result: { ok: true, source: 'x', rounds: [] }, styleFn: () => { throw new Error('壞'); } }); assert.strictEqual(s3.check.ok, false, '檢查器自己壞了記成問題但不丟例外');
        const n = await O.wireOffline(null); assert.strictEqual(n.stack.length >= 1, true);
    });
    await t('整體成功時 stuckAt 為 null（即使有層記 ✘，實機遇過矩陣層成功但 rounds 只有 matrix✘）', async () => { const w = await O.wireOffline({ goal: 'g', result: { ok: true, source: 'x', rounds: [{ by: 'matrix', ok: false }] } }); assert.strictEqual(w.stuckAt, null); });
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
