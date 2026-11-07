/* 矩陣層 → code edit（DESIGN.matrix-fallback.md §11）：把矩陣層合成出來的程式整理成「人看得懂、能繼續用區塊／UML 編輯」的樣子。純函式 UMD。
 *   toEditable(res) → { source, explain, form, changed }
 *       dfa：轉移表拆成一列一個狀態，旁邊註明「狀態 q ＝ 讀過什麼之後」（取到達該狀態的最短字串）；
 *       recurrence：遞推式與初值寫成註解，矩陣乘法移到最上層的 mat_mul（區塊編輯器不能處理巢狀 def）；
 *       其他（公式／條件／格子／圖／方陣範本）：加一行說明註解，巢狀 def 一律搬到最上層（缺的外部變數改成參數）。
 *   extractForm(source) → 從（可能被使用者改過的）程式讀回矩陣型態 {kind:'dfa', delta, start, accept?}／{kind:'recurrence', coef, init, offset, mod}；讀不回來回 null＝已離開矩陣模式，降級成一般 Python 區塊。
 *   install(FaMatrixSynth)：註冊成 synth() 的編輯器——結果交 judge 再驗一次（含隱藏測資），過了才換成可編輯版，沒過就保留原樣（不靜默覆蓋）。
 * 往返要求：形態 → 可編輯程式 → 形態 相同；可編輯程式與原程式在同一組輸入上輸出相同（測試條件）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixEdit = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const lines = (s) => String(s).replace(/\n+$/, '').split('\n');
    // ---- 巢狀 def 搬到最上層：函式體用到 main 裡賦值過的名稱時，加成參數 ----
    function hoistNested(src) {
        const L = lines(src); if (!/^def main\(\):/.test(L[0])) return { source: src, hoisted: [] };
        const assigned = new Set(); for (const l of L.slice(1)) { const m = /^ {4}([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=[^=]/.exec(l); if (m) m[1].split(/\s*,\s*/).forEach((x) => assigned.add(x)); }
        const out = [L[0]]; const top = []; const hoisted = []; let i = 1;
        while (i < L.length) {
            const dm = /^ {4}def (\w+)\(([^)]*)\):\s*$/.exec(L[i]);
            if (!dm) { out.push(L[i]); i++; continue; }
            const body = []; i++; while (i < L.length && (/^ {8}/.test(L[i]) || L[i].trim() === '')) { body.push(L[i].replace(/^ {4}/, '')); i++; }
            const params = dm[2].split(',').map((x) => x.trim()).filter(Boolean); const txt = body.join('\n'); const free = [...assigned].filter((v) => new RegExp('(?<![\\w.])' + v + '(?!\\w)').test(txt) && !params.includes(v));
            top.push('def ' + dm[1] + '(' + params.concat(free).join(', ') + '):', ...body, ''); hoisted.push({ name: dm[1], extra: free });
        }
        let main = out.join('\n'); for (const h of hoisted) main = main.replace(new RegExp('(?<![\\w.])' + h.name + '\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)', 'g'), (m, a) => h.name + '(' + a + (h.extra.length ? ', ' + h.extra.join(', ') : '') + ')');
        return { source: (top.length ? top.join('\n') + '\n' : '') + main + '\n', hoisted };
    }
    // ---- DFA：每個狀態的代表字串（BFS 最短、字元由小到大） ----
    function stateNames(delta, start) { const rep = { [start]: '' }; const q = [start]; for (let i = 0; i < q.length; i++) { const s = q[i]; for (const ch of Object.keys(delta[s] || {}).sort()) { const t = delta[s][ch]; if (!(t in rep)) { rep[t] = rep[s] + ch; q.push(t); } } } return rep; }
    function dfaToEditable(res) {
        const f = res.matrixForm; const L = lines(res.source); const ti = L.findIndex((l) => /^ {4}T = \[/.test(l)); if (ti < 0) return null;
        const rep = stateNames(f.delta, f.start); const acc = new Set(f.accept || []);
        const tbl = f.delta.map((r, q) => '        {' + Object.keys(r).map((c) => JSON.stringify(c) + ': ' + r[c]).join(', ') + '},  # 狀態 ' + q + (q === f.start ? '：起點' : (q in rep ? '：讀過 "' + rep[q] + '" 之後' : '：（走不到）')) + (acc.has(q) ? '（接受）' : ''));
        const out = L.slice(0, ti).concat(['    # 轉移表：T[狀態][字元] ＝ 下一個狀態；一列一個狀態，要改規則就改這裡', '    T = ['].concat(tbl, ['    ]'], L.slice(ti + 1)));
        return out.join('\n') + '\n';
    }
    function recurrenceToEditable(res) {
        const f = res.matrixForm; let s = res.source; const h = hoistNested(s); s = h.source.replace(/(?<![\w.])mul\(/g, 'mat_mul(');
        const d = f.coef.length; const term = (c, i) => c + '×b(k−' + i + ')'; const rec = 'b(k) = ' + f.coef.map((c, i) => term(c, i + 1)).join(' + ') + '；初值 ' + f.init.map((x, i) => 'b(' + i + ')=' + x).join('、') + '；輸入 n 時輸出 b(n' + (f.offset ? '−' + f.offset : '') + (d > 1 ? '+' + (d - 1) : '') + ')' + (f.mod ? '，結果取模 ' + f.mod : '');
        return s.replace(/^(def main\(\):\n)/m, '$1    # 線性遞推（矩陣快速冪）：' + rec + '\n');
    }
    function toEditable(res) {
        if (!res || !res.ok || !res.source) return null; const f = res.matrixForm || {}; let src = null;
        try { if (f.kind === 'dfa') src = dfaToEditable(res); else if (f.kind === 'recurrence') src = recurrenceToEditable(res); } catch (e) { src = null; }
        if (!src) { const h = hoistNested(res.source); src = h.source; if (res.desc) src = src.replace(/^((?:def \w+\([^)]*\):\n(?:[ \t].*\n|\n)*)*def main\(\):\n)/m, '$1    # 矩陣層合成：' + String(res.desc).replace(/\n/g, ' ') + '\n'); }
        return { source: src, explain: res.desc || '', form: extractForm(src) || res.matrixForm || null, changed: src !== res.source };
    }
    // ---- 讀回形態 ----
    function extractForm(src) {
        const s = String(src); const mT = /^ {4}T = \[\n([\s\S]*?)^ {4}\]\n/m.exec(s);
        if (mT) { try { const body = mT[1].split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean).join(' ').replace(/,\s*$/, ''); const delta = JSON.parse('[' + body + ']'); const st = /^ {4}q = (\d+)$/m.exec(s); const ac = /print\([^\n]* if q in (\[[\d, ]*\])/.exec(s); if (!Array.isArray(delta) || !st) return null; const o = { kind: 'dfa', start: Number(st[1]), delta }; if (ac) o.accept = JSON.parse(ac[1]); return o; } catch (e) { return null; } }
        const c = /^ {4}coef = (\[[-\d, ]*\])$/m.exec(s), i = /^ {4}init = (\[[-\d, ]*\])$/m.exec(s); if (c && i) { try { const off = /int\(input\(\)\) - (\d+)/.exec(s); const m = /^ {4}M = (None|\d+)$/m.exec(s); return { kind: 'recurrence', coef: JSON.parse(c[1]), init: JSON.parse(i[1]), offset: off ? Number(off[1]) : 0, mod: m && m[1] !== 'None' ? Number(m[1]) : null }; } catch (e) { return null; } }
        return null;
    }
    // 使用者改了形態（轉移表、係數、初值）→ 直接改程式裡那幾行，不重新合成
    function applyForm(src, form) {
        let s = String(src);
        if (form.kind === 'dfa') { const rep = stateNames(form.delta, form.start); const tbl = form.delta.map((r, q) => '        {' + Object.keys(r).map((c) => JSON.stringify(c) + ': ' + r[c]).join(', ') + '},  # 狀態 ' + q + (q === form.start ? '：起點' : q in rep ? '：讀過 "' + rep[q] + '" 之後' : '：（走不到）')); s = s.replace(/^ {4}T = \[\n[\s\S]*?^ {4}\]\n/m, '    T = [\n' + tbl.join('\n') + '\n    ]\n').replace(/^ {4}q = \d+$/m, '    q = ' + form.start); if (form.accept) s = s.replace(/(if q in )\[[\d, ]*\]/, '$1' + JSON.stringify(form.accept)); }
        else if (form.kind === 'recurrence') s = s.replace(/^ {4}coef = .*$/m, '    coef = ' + JSON.stringify(form.coef).replace(/,/g, ', ')).replace(/^ {4}init = .*$/m, '    init = ' + JSON.stringify(form.init).replace(/,/g, ', ')).replace(/^ {4}d = \d+$/m, '    d = ' + form.coef.length);
        return s;
    }
    function install(M) {
        if (!M || !M.setEditor) return false;
        M.setEditor(async (res, judge) => { const e = toEditable(res); if (!e || !e.changed) return null; if (judge) { const v = await judge(e.source); if (v.verdict !== 'AC') return null; } return e; });
        return true;
    }
    return { toEditable, extractForm, applyForm, hoistNested, stateNames, install };
});
