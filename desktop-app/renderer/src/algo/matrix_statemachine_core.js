/* 狀態機圖種（DESIGN.matrix-fallback.md §11.6、DESIGN.matrix-algorithms.md §14.8）：有限自動機（DFA）⇄ 狀態機圖 ⇄ 轉移矩陣的往返。
 * 為什麼不放進 uml_core：uml_core 的模型只有 classes／relations／usecases（類別、關係、使用案例），沒有「起點」「接受集」「轉移字母」，
 * 硬用「列舉＋帶標籤的關聯」只能畫出邊，起點與接受集會丟，決定性與完整性也沒法檢查；所以狀態機是獨立圖種，沿用 uml_core 的設計（一行一件事的文字 DSL、
 * 程式產生 Mermaid／PlantUML、解析後逐項驗證），之後 uml_core 要收編時只要把這個模組的 DSL 當第四種區塊。
 *
 *   模型 sm = { name, alphabet:[符號…], states:[{name, start, accept}], transitions:[{from, to, symbols:[符號…]}] }
 *   dfaToMachine(d, {names, name}) → sm        d＝{n, alphabet, start, accept:[bool…], delta:[[下一個狀態…]…]}（與 matrix_decompile_core 的 DFA 同形）
 *   machineToDfa(sm, {complete}) → { ok, dfa } | { ok:false, errors }   檢查：起點恰一個、決定性（同狀態同符號只能一條邊）、完整性（缺邊時 complete:true 補一個失敗狀態）
 *   stateNames(d) → 有意義的狀態名（起點／失敗／成功／「讀過 ab」＝最短到達路徑）
 *   toDsl(sm)／parseDsl(text)；toMermaid(sm)；toPlantUml(sm)
 *   matricesToMachine(Ms, alphabet, startVec, acceptVec)／machineToMatrices(sm, semiring) 走 matrix_decompile_core／matrix_forms_core 的現成函式
 * 純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(typeof require === 'function' ? { D: require('./matrix_decompile_core.js'), MF: require('./matrix_forms_core.js') } : {});
    else root.FaMatrixStateMachine = factory({ D: root.FaMatrixDecompile, MF: root.FaMatrixForms });
})(typeof self !== 'undefined' ? self : this, function (deps) {
    'use strict';
    const { D, MF } = deps;
    // ---------- 有意義的狀態名 ----------
    // BFS 求每個狀態的最短到達字串；起點叫「起點」；所有出邊回自己且不是接受的叫「失敗」；所有出邊回自己且是接受的叫「成功」；其餘叫「讀過 xyz」
    function stateNames(d) {
        const via = new Array(d.n).fill(null); via[d.start] = ''; const q = [d.start];
        while (q.length) { const s = q.shift(); for (let a = 0; a < d.alphabet.length; a++) { const t = d.delta[s][a]; if (via[t] === null) { via[t] = via[s] + d.alphabet[a]; q.push(t); } } }
        const used = new Set(); const names = [];
        for (let i = 0; i < d.n; i++) {
            const sink = d.delta[i].every((t) => t === i); let nm;
            if (i === d.start) nm = '起點'; else if (via[i] === null) nm = '不可達' + i; else if (sink) nm = d.accept[i] ? '成功' : '失敗'; else nm = '讀過' + via[i];
            if (used.has(nm)) { let k = 2; while (used.has(nm + '_' + k)) k++; nm = nm + '_' + k; } used.add(nm); names.push(nm);
        }
        return names;
    }
    // ---------- DFA ⇄ 模型 ----------
    function dfaToMachine(d, opts) {
        opts = opts || {}; const names = opts.names || stateNames(d);
        const states = names.map((nm, i) => ({ name: nm, start: i === d.start, accept: !!d.accept[i] }));
        const transitions = []; for (let i = 0; i < d.n; i++) { const by = new Map(); d.alphabet.forEach((ch, a) => { const j = d.delta[i][a]; if (!by.has(j)) by.set(j, []); by.get(j).push(ch); }); for (const [j, syms] of by) transitions.push({ from: names[i], to: names[j], symbols: syms }); }
        return { name: opts.name || 'machine', alphabet: d.alphabet.slice(), states, transitions };
    }
    function machineToDfa(sm, opts) {
        opts = opts || {}; const errors = []; const idx = new Map(); sm.states.forEach((s, i) => { if (idx.has(s.name)) errors.push('狀態重複：' + s.name); idx.set(s.name, i); });
        const starts = sm.states.filter((s) => s.start); if (starts.length !== 1) errors.push('起點要恰好一個（現在 ' + starts.length + ' 個）');
        const k = sm.alphabet.length; const delta = sm.states.map(() => new Array(k).fill(-1));
        for (const t of sm.transitions) {
            if (!idx.has(t.from)) { errors.push('轉移來源不存在：' + t.from); continue; } if (!idx.has(t.to)) { errors.push('轉移目標不存在：' + t.to); continue; }
            for (const ch of t.symbols) { const a = sm.alphabet.indexOf(ch); if (a < 0) { errors.push('符號不在字母表：' + ch); continue; } const i = idx.get(t.from); if (delta[i][a] !== -1 && delta[i][a] !== idx.get(t.to)) errors.push(t.from + ' 讀到 ' + ch + ' 有兩個去向（不是決定性）'); delta[i][a] = idx.get(t.to); }
        }
        const missing = []; delta.forEach((r, i) => r.forEach((x, a) => { if (x === -1) missing.push(sm.states[i].name + ' 讀到 ' + sm.alphabet[a]); }));
        let states = sm.states.slice(); const accept = sm.states.map((s) => !!s.accept);
        if (missing.length) {
            if (!opts.complete) errors.push('缺少轉移：' + missing.slice(0, 6).join('、') + (missing.length > 6 ? '…' : '') + '（可用 complete 補一個失敗狀態）');
            else { let nm = '失敗'; while (idx.has(nm)) nm += '_'; const f = states.length; states = states.concat([{ name: nm, start: false, accept: false }]); accept.push(false); delta.forEach((r) => r.forEach((x, a) => { if (x === -1) r[a] = f; })); delta.push(new Array(k).fill(f)); }
        }
        if (errors.length) return { ok: false, errors };
        return { ok: true, dfa: { n: states.length, alphabet: sm.alphabet.slice(), start: states.findIndex((s) => s.start), accept, delta }, names: states.map((s) => s.name) };
    }
    // ---------- 文字 DSL ----------
    // machine: 名稱 ／ alphabet: ["0","1"] ／ start: 狀態 ／ accept: 狀態, 狀態 ／ state: 狀態（沒有邊也要列時才用）／ A -> B : ["0","1"]
    function toDsl(sm) {
        const L = ['machine: ' + sm.name, 'alphabet: ' + JSON.stringify(sm.alphabet)]; const st = sm.states.find((s) => s.start); if (st) L.push('start: ' + st.name);
        L.push('accept: ' + sm.states.filter((s) => s.accept).map((s) => s.name).join(', ')); for (const t of sm.transitions) L.push(t.from + ' -> ' + t.to + ' : ' + JSON.stringify(t.symbols)); return L.join('\n');
    }
    function parseDsl(text) {
        const sm = { name: 'machine', alphabet: [], states: [], transitions: [] }; const errors = []; let startName = null, acc = [];
        const ensure = (nm) => { if (!sm.states.some((s) => s.name === nm)) sm.states.push({ name: nm, start: false, accept: false }); };
        String(text).split(/\r?\n/).forEach((raw, no) => {
            const l = raw.trim(); if (!l || l.startsWith('#')) return; let m;
            if ((m = /^machine\s*:\s*(.*)$/.exec(l))) sm.name = m[1].trim(); else if ((m = /^alphabet\s*:\s*(.*)$/.exec(l))) { try { const a = JSON.parse(m[1]); if (!Array.isArray(a) || a.some((x) => typeof x !== 'string')) throw new Error('x'); sm.alphabet = a; } catch (e) { errors.push((no + 1) + '：alphabet 要是字串的 JSON 陣列'); } }
            else if ((m = /^start\s*:\s*(.+)$/.exec(l))) startName = m[1].trim(); else if ((m = /^accept\s*:\s*(.*)$/.exec(l))) acc = m[1].split(',').map((x) => x.trim()).filter(Boolean); else if ((m = /^state\s*:\s*(.+)$/.exec(l))) ensure(m[1].trim());
            else if ((m = /^(.+?)\s*->\s*(.+?)\s*:\s*(\[.*\])$/.exec(l))) { let syms; try { syms = JSON.parse(m[3]); if (!Array.isArray(syms)) throw new Error('x'); } catch (e) { errors.push((no + 1) + '：轉移符號要是 JSON 陣列'); return; } const f = m[1].trim(), t = m[2].trim(); ensure(f); ensure(t); sm.transitions.push({ from: f, to: t, symbols: syms }); }
            else errors.push((no + 1) + '：看不懂這一行：' + l);
        });
        if (startName) { ensure(startName); sm.states.find((s) => s.name === startName).start = true; } for (const a of acc) { ensure(a); sm.states.find((s) => s.name === a).accept = true; }
        return errors.length ? { ok: false, errors } : { ok: true, machine: sm };
    }
    // ---------- 圖 ----------
    const idOf = (sm, nm) => 'S' + sm.states.findIndex((s) => s.name === nm); const lab = (t) => t.symbols.join(',');
    function toMermaid(sm) {
        const L = ['stateDiagram-v2']; sm.states.forEach((s, i) => L.push('    state "' + s.name + '" as S' + i));
        const st = sm.states.find((s) => s.start); if (st) L.push('    [*] --> ' + idOf(sm, st.name));
        for (const t of sm.transitions) L.push('    ' + idOf(sm, t.from) + ' --> ' + idOf(sm, t.to) + ' : ' + lab(t)); sm.states.forEach((s, i) => { if (s.accept) L.push('    S' + i + ' --> [*]'); }); return L.join('\n');
    }
    function toPlantUml(sm) {
        const L = ['@startuml']; sm.states.forEach((s, i) => L.push('state "' + s.name + '" as S' + i)); const st = sm.states.find((s) => s.start); if (st) L.push('[*] --> ' + idOf(sm, st.name));
        for (const t of sm.transitions) L.push(idOf(sm, t.from) + ' --> ' + idOf(sm, t.to) + ' : ' + lab(t)); sm.states.forEach((s, i) => { if (s.accept) L.push('S' + i + ' --> [*]'); }); L.push('@enduml'); return L.join('\n');
    }
    // ---------- 轉移矩陣 ----------
    function matricesToMachine(Ms, alphabet, startVec, acceptVec, opts) { const d = D.matricesToDfa(Ms, alphabet, startVec, acceptVec); return d ? dfaToMachine(d, opts) : null; }
    function machineToMatrices(sm, sr) { const r = machineToDfa(sm, { complete: true }); if (!r.ok) return r; const d = r.dfa; return { ok: true, dfa: d, Ms: MF.dfaMatrices(d, sr || MF.SR.count(0)), startVec: d.accept.map((_, i) => (i === d.start ? 1 : 0)), acceptVec: d.accept.map((x) => (x ? 1 : 0)), names: r.names }; }
    return { stateNames, dfaToMachine, machineToDfa, toDsl, parseDsl, toMermaid, toPlantUml, matricesToMachine, machineToMatrices };
});
