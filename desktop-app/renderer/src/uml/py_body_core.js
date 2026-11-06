/* Python：用 UML 遞迴切割讓模型寫 body（指令層級）。純函式 UMD，Python 專屬。
 * 切割的層次：題目 → 函式簽名（UML 的操作，輔助函式先、main 最後）→ 每個操作的 body → 一次一個敘述；
 * 敘述若是區塊標頭（for／if／while／try／with／else…，以冒號結尾）就往下一層區塊遞迴；縮排變淺 = 結束區塊。
 * 補全式：把「已經寫好的程式」當成助手回覆的開頭請模型續寫，只取第一行（0.5B 的 coder 聽不懂「只輸出下一行」這種指令，但會續寫程式）。
 * 每個敘述都用 tree-sitter 解析（不能有 ERROR、剛好一個敘述）並檢查用到的名稱已經定義，不合格就連同原因再問（有次數上限）。
 * 最後把所有函式組起來，交給 py_code2uml_core.fromTree 變成帶 body 的 UML 模型（toPython 可以再輸出）。
 *
 *   designOps({problem, ask}) → [{name, params, sig}]
 *   writeBody({op, ops, problem, complete, validate, before, plan}) → {ok, lines, steps, retries, reason}
 *   writeProgram({problem, ask, complete, validate, parseTree, C2U, plan, onOp}) → {ok, source, model, ops, steps, retries, reason}
 *   namesOf(body) → {used, defined}；makeValidator({parseTree, C2U}) → validate({text, isHeader, sibling})
 * ask(messages, maxTokens) → Promise<string>；complete(messages, prefill, maxTokens) → Promise<續寫的部分> */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyBody = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const BUILTINS = new Set('abs all any bin bool chr dict divmod enumerate filter float frozenset hex input int isinstance len list map max min next oct open ord pow print range reversed round set sorted str sum tuple type zip iter repr id hash format callable getattr hasattr setattr super object Exception ValueError KeyError IndexError StopIteration True False None self cls __name__'.split(' '));
    const clean = (t) => String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```[a-zA-Z]*/g, '').trim();
    const SIB = /^(elif\b|else\s*:|except\b|finally\s*:)/;

    async function designOps(o) {
        const user = '題目：' + String(o.problem.statement || o.problem.title || '').slice(0, 700) + '\n\n列出完成這題需要的 Python 函式簽名，每行一個，格式 def 名稱(參數):。一定要有 def main():（從標準輸入讀資料、用 print 輸出答案），可以另外有 0 到 3 個輔助函式。只輸出簽名行。';
        const text = clean(await o.ask([{ role: 'system', content: '你是 Python 程式設計助手。' }, { role: 'user', content: user }], 120));
        const ops = []; const seen = new Set();
        for (const l of text.split('\n')) {
            const m = /^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*[^:]+)?:?\s*$/.exec(l.trim()); if (!m || seen.has(m[1])) continue; seen.add(m[1]);
            const params = m[2].split(',').map((x) => x.trim().split(':')[0].split('=')[0].trim()).filter(Boolean); ops.push({ name: m[1], params, sig: 'def ' + m[1] + '(' + params.join(', ') + '):' });
        }
        if (!seen.has('main')) ops.push({ name: 'main', params: [], sig: 'def main():' });
        const main = ops.find((x) => x.name === 'main'); main.params = []; main.sig = 'def main():';
        return ops.filter((x) => x.name !== 'main').slice(0, 3).concat([main]);
    }

    async function writeBody(o) {
        const maxStmts = o.maxStmts || 60, maxTry = o.maxTry || 3, maxDepth = o.maxDepth || 5;
        const lines = []; const stack = []; const scope = new Set(o.op.params); for (const x of o.ops || []) scope.add(x.name);
        let steps = 0, retries = 0, lastLine = '', same = 0, allowSibling = null;
        const render = () => lines.map((l) => '    '.repeat(l.d + 1) + l.t).join('\n');
        for (;;) {
            if (steps >= maxStmts) return { ok: false, lines, steps, retries, reason: '敘述太多（上限 ' + maxStmts + '）' };
            let err = '', got = null;
            for (let k = 0; k < maxTry; k++) {
                const depth = stack.length;
                const user = '題目：' + String(o.problem.statement || o.problem.title || '').slice(0, 700) + (o.plan ? '\n\n解法想法：\n' + o.plan : '') + '\n\n請寫出完整的 Python 程式：要有 def main()（從標準輸入讀資料、用 print 輸出答案）' + ((o.ops || []).length > 1 ? '，函式有：' + o.ops.map((x) => x.sig.replace(/:$/, '')).join('、') : '') + '。只輸出程式碼。' + (err ? '\n\n（上一行不合格：' + err + '，請改寫那一行。）' : '');
                const prefill = '```python\n' + (o.before ? o.before + '\n\n' : '') + o.op.sig + '\n' + (lines.length ? render() + '\n' : '');
                const cont = String(await o.complete([{ role: 'system', content: '你是 Python 程式設計助手。' }, { role: 'user', content: user }], prefill, o.maxTokens || 48) || '').replace(/<think>[\s\S]*?<\/think>/g, ''); steps++;
                const first = cont.split('\n').find((l) => l.trim().length) || ''; const trimmed = first.replace(/\t/g, '    '); const text = trimmed.trim();
                const lead = trimmed.length - trimmed.trimStart().length;
                if (!text || /^```/.test(text) || lead < 4) { // 函式寫完（圍欄、空白、或回到頂層）
                    if (!lines.length) { err = '函式還沒有任何內容'; retries++; continue; } if (stack.some((b) => !b.count)) { err = '還有空的區塊'; retries++; continue; } got = { kind: 'done' }; break;
                }
                let want = Math.floor(lead / 4) - 1; if (want > depth) want = depth; if (want < 0) want = 0;
                if (want < depth) { if (stack.slice(want).some((b) => !b.count)) { err = '區塊不能是空的'; retries++; continue; } got = { kind: 'dedent', to: want }; break; }
                if (/^(def|class|async\s+def)\b/.test(text)) { err = '函式的簽名已經寫好了，不要再寫 def 或 class'; retries++; continue; }
                const isHeader = /:\s*$/.test(text); if (isHeader && depth + 1 > maxDepth) { err = '區塊太深（上限 ' + maxDepth + ' 層）'; retries++; continue; }
                const sib = SIB.test(text); if (sib && !(allowSibling && allowSibling.depth === depth)) { err = text.split(/\s|:/)[0] + ' 要接在對應的 if／try 區塊之後'; retries++; continue; }
                const v = o.validate({ text, isHeader, sibling: sib ? allowSibling.header : null }); if (!v.ok) { err = v.error; retries++; continue; }
                const bad = [...v.names.used].filter((n) => !scope.has(n) && !v.names.defined.has(n) && !BUILTINS.has(n)); if (bad.length) { err = '名稱 ' + bad.slice(0, 3).join('、') + ' 還沒有定義'; retries++; continue; }
                if (text === lastLine && ++same >= 2) { err = '和上一行一樣，請寫下一件事'; retries++; continue; }
                got = { kind: 'line', text, isHeader, defined: v.names.defined }; break;
            }
            if (!got) return { ok: false, lines, steps, retries, reason: '連續 ' + maxTry + ' 次寫不出合格的下一行：' + err };
            if (got.kind === 'done') return { ok: true, lines, steps, retries };
            if (got.kind === 'dedent') { while (stack.length > got.to) { const c = stack.pop(); allowSibling = { depth: stack.length, header: c.header }; } continue; }
            const depth = stack.length; lines.push({ d: depth, t: got.text }); lastLine = got.text; same = 0; if (depth > 0) stack[stack.length - 1].count++; allowSibling = null;
            for (const n of got.defined) scope.add(n); if (got.isHeader) stack.push({ header: got.text, count: 0 });
        }
    }

    // 從敘述樹算出用到與定義的名稱（指派目標、for 目標、生成式變數、lambda 參數、with／except 的 as、import、def 都算定義）
    function namesOf(list) {
        const used = new Set(), defined = new Set();
        const target = (e) => { if (!e) return; if (e.n === 'name') defined.add(e.v); else if (e.n === 'tuple' || e.n === 'list') (e.xs || []).forEach(target); else if (e.n === 'star') target(e.e); else expr(e); };
        const expr = (e) => {
            if (!e || typeof e !== 'object') return; if (Array.isArray(e)) { e.forEach(expr); return; }
            if (e.n === 'name') { used.add(e.v); return; }
            if (e.n === 'comp') { for (const c of e.cl || []) { if (c.t) target(c.t); if (c.i) expr(c.i); if (c.if) expr(c.if); } expr(e.e); expr(e.k); expr(e.v); return; }
            if (e.n === 'lambda') { for (const p of e.ps || []) defined.add(p.name); expr(e.e); return; }
            if (e.n === 'walrus') { defined.add(e.t); expr(e.v); return; }
            if (e.n === 'kw') { expr(e.v); return; }
            for (const k of Object.keys(e)) { const v = e[k]; if (v && typeof v === 'object') { if (Array.isArray(v)) v.forEach((x) => (x && x.k !== undefined && x.v !== undefined && !x.n ? (expr(x.k), expr(x.v)) : expr(x))); else expr(v); } }
        };
        for (const s of list || []) {
            switch (s.k) {
                case 'assign': expr(s.v); (s.ts || [s.t]).forEach(target); break;
                case 'aug': expr(s.t); expr(s.v); break;
                case 'ann': target(s.t); expr(s.v); break;
                case 'for': target(s.t); expr(s.i); break;
                case 'with': for (const it of s.items) { expr(it.e); if (it.as) target(it.as); } break;
                case 'try': for (const h of s.h || []) { if (h.ty) expr(h.ty); if (h.as) defined.add(h.as); } break;
                case 'def': defined.add(s.name); for (const p of s.ps || []) defined.add(p.name); break;
                case 'import': for (const n of s.names) defined.add(n.as || String(n.name).split('.')[0]); break;
                case 'del': (s.es || []).forEach(expr); break;
                default: expr(s.e); expr(s.c); expr(s.m); expr(s.cause);
            }
        }
        return { used, defined };
    }

    // 逐行驗證器：tree-sitter 要解析得過、剛好一個敘述，並算出名稱。else／elif／except／finally 前面墊一個假的 if／try 讓它能單獨解析。
    function makeValidator(o) {
        return ({ text, isHeader, sibling }) => {
            const pre = [];
            if (sibling) { if (/^(elif\b|else\s*:)/.test(text)) pre.push('    if 1:', '        pass'); else pre.push('    try:', '        pass'); }
            const src = ['def f():'].concat(pre, ['    ' + text], isHeader ? ['        pass'] : []).join('\n') + '\n';
            const tree = o.parseTree(src); if (!tree) return { ok: false, error: '無法解析' };
            if (tree.rootNode.hasError()) { let at = ''; const find = (n) => { if (n.type === 'ERROR' || n.isMissing()) { at = n.isMissing() ? '缺少 ' + n.type : '看不懂「' + String(n.text || '').slice(0, 30) + '」'; return true; } for (let i = 0; i < n.childCount; i++) if (find(n.child(i))) return true; return false; }; find(tree.rootNode); return { ok: false, error: '語法錯誤（' + (at || '無法解析') + '）' }; }
            const u = o.C2U.fromTree(tree.rootNode, { source: src }); const op = u.model.classes[0] && u.model.classes[0].ops[0]; const body = op ? op.body : [];
            if (body.length !== 1) return { ok: false, error: '一行只能有一個敘述（有 ' + body.length + ' 個）' };
            if (u.coverage.raws) return { ok: false, error: '這種寫法目前不支援' };
            if (sibling) { // 只檢查它自己帶的運算式（elif 的條件、except 的型別與 as）
                const st = body[0]; const none = { ok: true, names: { used: new Set(), defined: new Set() } };
                if (/^elif\b/.test(text)) return st.k === 'if' && st.b[0] && st.b[0].k === 'if' ? { ok: true, names: namesOf([{ k: 'expr', e: st.b[0].c }]) } : none;
                if (/^except\b/.test(text)) return st.k === 'try' && st.h[0] ? { ok: true, names: namesOf([{ k: 'try', h: [st.h[0]] }]) } : none;
                return none;
            }
            return { ok: true, names: namesOf(body) };
        };
    }

    async function writeProgram(o) {
        const ops = await designOps(o); const bodies = []; let steps = 0, retries = 0;
        for (const op of ops) {
            const r = await writeBody({ op, ops, problem: o.problem, complete: o.complete, validate: o.validate, plan: o.plan, maxStmts: o.maxStmts, maxTry: o.maxTry, before: bodies.join('\n\n') });
            steps += r.steps; retries += r.retries; if (o.onOp) o.onOp(op, r);
            if (!r.ok) return { ok: false, ops, steps, retries, reason: op.name + '：' + r.reason, partial: r.lines.map((l) => '    '.repeat(l.d + 1) + l.t).join('\n') };
            bodies.push([op.sig].concat(r.lines.map((l) => '    '.repeat(l.d + 1) + l.t)).join('\n'));
        }
        const source = bodies.join('\n\n') + '\n'; const tree = o.parseTree(source);
        if (!tree || tree.rootNode.hasError()) return { ok: false, ops, steps, retries, reason: '組起來的程式有語法錯誤', source };
        const u = o.C2U.fromTree(tree.rootNode, { source }); return { ok: true, source: o.C2U.toPython(u.model), model: u.model, ops, steps, retries };
    }
    return { designOps, writeBody, writeProgram, namesOf, makeValidator, BUILTINS };
});
