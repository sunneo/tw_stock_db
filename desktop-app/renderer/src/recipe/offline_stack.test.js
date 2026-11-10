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
    await t('CoLU 式推取：寬鬆解析（字母／數字／引號／答案：B／前後有字）、解析不出來才算格式錯誤', () => {
        const p = (s) => O.parseLetter(s, 6, '答案：');
        assert.strictEqual(p('答案：B'), 1); assert.strictEqual(p('答案：c.'), 2); assert.strictEqual(p('答案： "3"'), 2); assert.strictEqual(p('<think>\n\n</think>\nF'), 5);
        assert.strictEqual(p('答案：「A」我覺得'), 0); assert.strictEqual(p('答案：Z'), -1); assert.strictEqual(p('答案：G'), -1, '超出選項數'); assert.strictEqual(p('答案：我不知道'), -1); assert.strictEqual(p(''), -1);
    });
    await t('CoLU 式推取：推入框架、標頭送進提示、取出摘要成上層已定；壞回答→全新重試（不把壞回答餵回去）→預設退路，不丟例外', async () => {
        const opts = [{ text: '算數' }, { text: '搜尋' }, { text: '都不是', isDefault: true }]; const seen = [];
        const st = O.fromRounds('目標X', [{ by: 'recipe', ok: false, reason: '沒有' }]);
        let n = 0; const gen = async (req) => { seen.push(req); n++; return n === 1 ? '我覺得是搜尋吧' : '答案：B'; };
        const r = await O.coluChoose({ stack: st, stackMod: T, generate: gen, options: opts, text: '查天氣' });
        assert.strictEqual(r.index, 1); assert.strictEqual(r.ok, true); assert.strictEqual(r.tries, 2); assert.strictEqual(r.badReplies.length, 1);
        assert.ok(/【目標】/.test(seen[0].messages[1].content)); assert.ok(!/我覺得是搜尋吧/.test(JSON.stringify(seen[1].messages)), '重試是全新一次，不餵壞回答');
        assert.strictEqual(seen[0].prefill, '答案：'); assert.ok(/選了 搜尋/.test(JSON.stringify(T.toJsonl(st))), '取出：摘要進堆疊');
        const bad = await O.coluChoose({ generate: async () => '???', options: opts, text: 'x' }); assert.strictEqual(bad.fallback, true); assert.strictEqual(bad.index, 2); assert.strictEqual(bad.ok, false);
        const thr = await O.coluChoose({ generate: async () => { throw new Error('壞了'); }, options: opts, text: 'x' }); assert.strictEqual(thr.fallback, true);
    });
    await t('CoLU 式推取：routeColu 與 measureRoute 的 colu 變體（假模型，只驗骨架）', async () => {
        const cands = [{ tool: 'calc', intent: '算數' }, { tool: 'search', intent: '搜尋' }];
        const generate = async (req) => { const q = req.messages[1].content.split('使用者的話：\n').pop(); return '答案：' + (/算/.test(q) ? 'A' : /查/.test(q) ? 'B' : 'C'); };
        const r = await O.routeColu({ cands, question: '幫我算', generate }); assert.strictEqual(r.index, 0); assert.strictEqual((await O.routeColu({ cands, question: '你好', generate })).none, true);
        const m = await O.measureRoute({ cases: [{ question: '算 1+1', cands, want: 'calc' }, { question: '查雨', cands, want: 'search' }, { question: '你好', cands, want: null }], generate, variants: ['colu'] });
        assert.strictEqual(m.colu.correct, 3); assert.strictEqual(m.colu.fmtErrReplies, 0); assert.strictEqual(m.colu.avgCalls, 1);
    });
    await t('CoLU 式逐項是非 routeColuYN：一個是→選它；零個是→都不是；多個是→再挑一次（順序反過來）', async () => {
        const cands = [{ tool: 'calc', intent: '算數' }, { tool: 'search', intent: '搜尋' }, { tool: 'code', intent: '寫程式' }];
        const mk = (yesFor) => async (req) => { const sys = req.messages[0].content; const m = /工具「(.+?)」/.exec(sys); if (m) return '答案：' + (yesFor.includes(m[1]) ? 'A' : 'B'); return '答案：A'; };
        const one = await O.routeColuYN({ cands, question: 'q', generate: mk(['搜尋']) }); assert.strictEqual(one.index, 1);
        const zero = await O.routeColuYN({ cands, question: 'q', generate: mk([]) }); assert.strictEqual(zero.none, true);
        const many = await O.routeColuYN({ cands, question: 'q', generate: mk(['算數', '寫程式']) }); assert.strictEqual(many.index, 2, '反過來排後第一項是「寫程式」');
    });
    await t('去位置偏誤：多排列投票／亂序附定義／都不是放最前／複述工具名，字母都正確對回原選項（假模型看選單文字作答）', async () => {
        const cands = [{ tool: 'calc', intent: '算數', def: '做計算' }, { tool: 'search', intent: '搜尋', def: '上網查' }, { tool: 'code', intent: '寫程式', def: '寫碼' }];
        const KEY = { 算: '算數', 查: '搜尋', 程: '寫程式' };
        const generate = async (req) => { const user = req.messages[req.messages.length - 1].content; const q = user.split('使用者的話：\n').pop(); const k = Object.keys(KEY).find((x) => q.indexOf(x) >= 0); const want = k ? KEY[k] : '都不是';
            const line = user.split('\n').find((l) => /^[A-J]\. /.test(l) && l.indexOf(want) >= 0); const L = line ? line[0] : 'A'; if (req.prefill === '工具：') { const tool = want === '算數' ? 'calc' : want === '搜尋' ? 'search' : want === '寫程式' ? 'code' : '都不是'; return '工具：' + tool + '，答案：' + L; } return '答案：' + L; };
        const mk = () => O.fromRounds('g', []);
        const R6 = { vote: O.makeRouteColu({ orders: [[0, 1, 2, 3], [3, 2, 1, 0], [2, 3, 0, 1]] }), def: O.makeRouteColu({ orders: [[2, 0, 3, 1]], defs: true }), nf: O.makeRouteColu({ noneFirst: true }), re: O.makeRouteColu({ restate: true }) };
        for (const k of Object.keys(R6)) for (const [q, w] of [['幫我算', 0], ['查一下', 1], ['寫程式', 2], ['你好', -1]]) { const r = await R6[k]({ cands, question: q, generate, stack: mk(), stackMod: T, mkStack: mk }); assert.strictEqual(r.index, w, k + ' ' + q); assert.strictEqual(r.none, w === -1); }
        // 投票：三票裡兩票同意就贏；三票都不同→預設都不是
        let c = 0; const votes = ['A', 'A', 'B']; const g2 = async () => '答案：' + votes[c++ % 3];
        const r2 = await O.makeRouteColu({ orders: [[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]] })({ cands, question: 'x', generate: g2 }); assert.strictEqual(r2.index, 0);
        let d = 0; const g3 = async () => '答案：' + 'ABC'[d++ % 3]; const r3 = await O.makeRouteColu({ orders: [[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]] })({ cands, question: 'x', generate: g3 }); assert.strictEqual(r3.none, true, '平手→都不是');
        const bad = await O.makeRouteColu({ restate: true })({ cands, question: 'x', generate: async () => '工具：calc，答案：B' }); assert.strictEqual(bad.fallback, true, '名稱與字母不一致 → 格式錯誤 → 預設'); assert.ok(/不一致/.test(bad.badReplies[0]));
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
