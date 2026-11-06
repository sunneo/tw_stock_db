/* Python：讓模型用「程式區塊」（受控自然語言，一行一個區塊）寫 body，再轉成程式。純函式 UMD，Python 專屬。
 * 提示裡放區塊目錄（每種區塊一行的寫法）與示範；模型接著寫下一行；縮排（每層兩格）就是區塊的結構。
 * 每一行都用 B.parseCNL 驗證（要是已知的區塊、槽位要是合法的 Python 運算式），再用 namesOf 檢查名稱已經定義；不合格連同原因再問。
 *
 *   catalog(B) → 區塊目錄文字
 *   writeCNLBody({op, ops, problem, complete, B, namesOf, examples, before}) → {ok, cnl, lines, steps, retries, reason}
 *   writeProgramCNL({problem, ask, complete, B, FaPyBody, C2U, parseTree, examples}) → {ok, source, model, cnl, ops, ...}
 * complete(messages, prefill, maxTokens) → Promise<續寫的部分> */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyCnlWrite = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const SIB_RE = /^(否則如果 .+ 就：|否則：)$/;
    function catalog(B) { return B.TEMPLATES.map((t) => '- ' + t.line.replace(/\{(\w+)(?::\w+)?\}/g, '{$1}')).join('\n') + '\n- 如果 {c} 就：（下面縮排寫成立時的區塊；可接 否則如果 {c} 就：／否則：）\n- 程式：{一行 Python}（以上都不合適時才用）'; }
    // 回傳 {user, prefill}：目錄放 user；示範與目標題目放在助手回覆的開頭，讓模型照同樣的格式續寫「區塊：」後面的行（小模型吃文件續寫，不吃指令）
    function promptFor(o, lines, err) {
        const ex = (o.examples || []).map((e, i) => '範例' + (i + 1) + '\n題目：' + e.statement + '\n區塊：\n' + e.cnl).join('\n\n');
        const fns = (o.ops || []).length > 1 ? '（這個程式有函式：' + o.ops.map((x) => x.sig.replace(/:$/, '')).join('、') + '；現在寫 ' + o.op.name + '）' : '';
        const user = '請把題目寫成「區塊」，格式照範例：每個區塊一行中文，{} 是要填的 Python 運算式，縮排兩格表示區塊裡面的內容。可用的區塊：\n' + catalog(o.B) + (err ? '\n\n（上一行不合格：' + err + '，請改寫那一行）' : '');
        const prefill = ex + '\n\n範例' + ((o.examples || []).length + 1) + fns + '\n題目：' + String(o.problem.statement || '').slice(0, 700) + '\n區塊：\n' + (lines.length ? lines.map((l) => '  '.repeat(l.d) + l.t).join('\n') + '\n' : '');
        return { user, prefill };
    }
    async function writeCNLBody(o) {
        const B = o.B, maxStmts = o.maxStmts || 40, maxTry = o.maxTry || 3, maxDepth = o.maxDepth || 5;
        const lines = []; const stack = []; const scope = new Set(o.op.params); for (const x of o.ops || []) scope.add(x.name);
        const builtins = o.builtins || new Set(); let steps = 0, retries = 0, last = '', same = 0, sibOK = null;
        const render = () => lines.map((l) => '  '.repeat(l.d) + l.t).join('\n');
        for (;;) {
            if (steps >= maxStmts) return { ok: false, lines, steps, retries, reason: '區塊太多（上限 ' + maxStmts + '）' };
            let err = '', got = null;
            for (let k = 0; k < maxTry; k++) {
                const depth = stack.length;
                const pf = promptFor(o, lines, err); const cont = String(await o.complete([{ role: 'system', content: '你是 Python 程式設計助手。' }, { role: 'user', content: pf.user }], pf.prefill, o.maxTokens || 40) || ''); steps++;
                const first = cont.split('\n').find((l) => l.trim().length) || ''; const text = first.trim(); const lead = first.length - first.trimStart().length;
                if (!text || /^(```|題目：|範例\d)/.test(text)) { if (!lines.length) { err = '還沒有任何區塊'; retries++; continue; } if (stack.some((b) => !b.count)) { err = '還有空的區塊'; retries++; continue; } got = { kind: 'done' }; break; }
                let want = Math.floor(lead / 2); if (want > depth) want = depth;
                if (want < depth) { if (stack.slice(want).some((b) => !b.count)) { err = '區塊裡面不能是空的'; retries++; continue; } got = { kind: 'dedent', to: want }; break; }
                const sib = SIB_RE.test(text); if (sib && !(sibOK && sibOK.depth === depth)) { err = '「' + text.slice(0, 6) + '…」要接在「如果…就：」區塊後面'; retries++; continue; }
                const header = /：$/.test(text); if (header && depth + 1 > maxDepth) { err = '區塊太深'; retries++; continue; }
                const src = (sib ? '如果 True 就：\n  什麼都不做\n' : '') + text + (header ? '\n  什麼都不做' : '');
                const pr = B.parseCNL(src); if (!pr.ok) { err = pr.errors[0].msg; retries++; continue; }
                if (pr.blocks.length !== 1) { err = '一行只能是一個區塊'; retries++; continue; }
                let ir; try { ir = B.toIR(pr.blocks); } catch (e) { err = '轉不成程式：' + e.message; retries++; continue; }
                let nm; if (sib) { const b = pr.blocks[0]; const lastBr = b.branches[b.branches.length - 1]; nm = o.namesOf([{ k: 'expr', e: lastBr.c }]); if (sib && !/^否則如果/.test(text)) nm = { used: new Set(), defined: new Set() }; } else nm = o.namesOf(ir);
                const bad = [...nm.used].filter((n) => !scope.has(n) && !nm.defined.has(n) && !builtins.has(n) && !n.startsWith('__')); if (bad.length) { err = '名稱 ' + bad.slice(0, 3).join('、') + ' 還沒有定義'; retries++; continue; }
                if (text === last && ++same >= 2) { err = '和上一行一樣'; retries++; continue; }
                got = { kind: 'line', text, header, defined: nm.defined }; break;
            }
            if (!got) return { ok: false, lines, steps, retries, reason: '連續 ' + maxTry + ' 次寫不出合格的下一行：' + err };
            if (got.kind === 'done') return { ok: true, lines, cnl: render(), steps, retries };
            if (got.kind === 'dedent') { while (stack.length > got.to) { const c = stack.pop(); sibOK = /^如果 /.test(c.header) || /^否則如果/.test(c.header) ? { depth: stack.length } : null; } continue; }
            const depth = stack.length; lines.push({ d: depth, t: got.text }); last = got.text; same = 0; if (depth > 0) stack[stack.length - 1].count++; sibOK = null;
            for (const n of got.defined) scope.add(n); if (got.header) stack.push({ header: got.text, count: 0 });
        }
    }
    async function writeProgramCNL(o) {
        const P = o.FaPyBody; const ops = await P.designOps(o); const parts = []; let steps = 0, retries = 0; const cnls = {};
        for (const op of ops) {
            const r = await writeCNLBody({ op, ops, problem: o.problem, complete: o.complete, B: o.B, namesOf: P.namesOf, examples: o.examples, builtins: P.BUILTINS, maxStmts: o.maxStmts, maxTry: o.maxTry });
            steps += r.steps; retries += r.retries; if (o.onOp) o.onOp(op, r);
            if (!r.ok) return { ok: false, ops, steps, retries, reason: op.name + '：' + r.reason, partial: r.lines.map((l) => '  '.repeat(l.d) + l.t).join('\n') };
            const pr = o.B.parseCNL(r.cnl); if (!pr.ok) return { ok: false, ops, steps, retries, reason: op.name + '：組起來的區塊解析失敗' };
            cnls[op.name] = r.cnl; parts.push({ op, body: o.B.toIR(pr.blocks) });
        }
        const model = { name: 'Module', actors: ['User'], relations: [], usecases: [], prelude: [], order: [], classes: [{ name: 'Module', kind: 'class', attrs: [], values: [], ops: parts.map((p) => ({ name: p.op.name, params: p.op.params.map((n) => ({ name: n, type: { base: 'any', args: [] } })), returns: { base: 'any', args: [] }, visibility: '+', static: true, body: p.body })) }] };
        model.order = model.classes[0].ops.map((o2) => ({ t: 'f', o: o2 }));
        return { ok: true, source: o.C2U.toPython(model), model, cnl: cnls, ops, steps, retries };
    }
    return { catalog, writeCNLBody, writeProgramCNL, promptFor };
});
