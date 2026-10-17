/* UML → LLVM IR → WebAssembly（wasm32-wasi）（FaLlvm）。設計見 DESIGN.uml-framework.md 的「LLVM IR」一節。
 *
 * 範圍（第一版，刻意小）：結構、函式、i1／i8／i32／i64／double、指標、字串常數、全域變數、if／迴圈（br）、直接呼叫、記憶體讀寫、整數與浮點運算、型別轉換。
 *   不做：繼承的虛擬呼叫、例外、容器、浮點以外的 float、phi（產生器用 alloca／load／store，跟 clang -O0 一樣）。
 * 為什麼自己寫 IR → wasm：使用者的機器不一定有 clang／llc，網頁版更沒有。IR 是我們自己產生的、範圍很小，所以：
 *   ① fromModel：UML → IR 文字（類別→struct、操作→函式、使用案例→會依序呼叫的函式、_start）＋預期的輸出（執行軌跡）。
 *   ② parse／check：自己的 IR 解析與型別檢查（定義前使用、型別一致、標籤存在、每個區塊有結尾、呼叫參數對得上…），錯誤說明在哪一行。
 *   ③ toWasm：IR → wasm 二進位（區塊用「迴圈＋br_table 分派」處理任意跳轉；alloca 放在影子堆疊；全域與字串放在資料段）。
 *   ④ run：用瀏覽器內建的 WebAssembly＋最小的 WASI（fd_write、proc_exit）執行，收集輸出。
 *   ⑤ verify：執行輸出要跟 UML 預期的軌跡一致——這是程式能判定的對錯。
 * 純函式（UMD），沒有外部相依；只有 run 需要 WebAssembly（Node 16 和瀏覽器都有）。
 */
(function (root, factory) {
    const U = (typeof FaUml !== 'undefined' && FaUml) || (root && root.FaUml) || (typeof require === 'function' ? (function () { try { return require('./uml_core.js'); } catch (_) { return null; } })() : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(U);
    else root.FaLlvm = factory(U);
})(typeof self !== 'undefined' ? self : this, function (U) {
    'use strict';

    // =====================================================================
    // 型別
    // =====================================================================
    const T = {
        i1: { k: 'int', bits: 1 }, i8: { k: 'int', bits: 8 }, i32: { k: 'int', bits: 32 }, i64: { k: 'int', bits: 64 }, double: { k: 'double' }, void: { k: 'void' }, ptr: { k: 'ptr', to: null }
    };
    const ptrTo = (to) => ({ k: 'ptr', to });
    function typeStr(t) {
        if (!t) return '?';
        switch (t.k) { case 'int': return 'i' + t.bits; case 'double': return 'double'; case 'void': return 'void'; case 'ptr': return t.to ? typeStr(t.to) + '*' : 'ptr'; case 'named': return '%' + t.name; case 'array': return '[' + t.n + ' x ' + typeStr(t.of) + ']'; case 'struct': return '{ ' + t.fields.map(typeStr).join(', ') + ' }'; }
        return '?';
    }
    const sameType = (a, b) => { if (a && b && a.k === 'ptr' && b.k === 'ptr') return !a.to || !b.to || sameType(a.to, b.to); return typeStr(a) === typeStr(b); };
    function parseTypeAt(s, i) {
        while (s[i] === ' ') i++;
        let t;
        if (s[i] === '{') {
            i++; const fields = []; for (;;) { while (s[i] === ' ') i++; if (s[i] === '}') { i++; break; } const r = parseTypeAt(s, i); fields.push(r.ty); i = r.end; while (s[i] === ' ') i++; if (s[i] === ',') i++; else if (s[i] !== '}') throw new Error('struct 型別格式錯誤：' + s); }
            t = { k: 'struct', fields };
        } else if (s[i] === '[') {
            i++; let m = /^\s*(\d+)\s*x\s*/.exec(s.slice(i)); if (!m) throw new Error('陣列型別格式錯誤：' + s); i += m[0].length; const r = parseTypeAt(s, i); i = r.end; while (s[i] === ' ') i++; if (s[i] !== ']') throw new Error('陣列型別少了 ]：' + s); i++; t = { k: 'array', n: Number(m[1]), of: r.ty };
        } else if (s[i] === '%') {
            const m = /^%([\w.$-]+)/.exec(s.slice(i)); if (!m) throw new Error('型別名稱格式錯誤：' + s); i += m[0].length; t = { k: 'named', name: m[1] };
        } else {
            const m = /^(i1|i8|i32|i64|double|void|ptr)\b/.exec(s.slice(i)); if (!m) throw new Error('不支援的型別：' + s.slice(i, i + 12)); i += m[0].length; t = T[m[1]];
        }
        for (;;) { let j = i; while (s[j] === ' ') j++; if (s[j] === '*') { t = ptrTo(t); i = j + 1; } else break; }
        return { ty: t, end: i };
    }
    const parseType = (s) => { const r = parseTypeAt(s, 0); if (s.slice(r.end).trim()) throw new Error('型別後面多了東西：' + s.slice(r.end)); return r.ty; };

    // =====================================================================
    // 解析
    // =====================================================================
    function stripComment(line) { let q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ';' && !q) return line.slice(0, i); } return line; }
    function splitTop(s) { const out = []; let d = 0, cur = '', q = false; for (const c of s) { if (c === '"') q = !q; if (!q) { if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; continue; } } cur += c; } if (cur.trim()) out.push(cur.trim()); return out; }
    // 屬性字（不能誤刪名字裡的：@tail、%nuw 這種前面有 % @ 的是名字）
    const ATTRS = /(?<![%@\w.$-])(noalias|nounwind|noinline|optnone|uwtable|readnone|readonly|local_unnamed_addr|unnamed_addr|dso_local|nsw|nuw|inbounds|tail|noundef|nonnull|signext|zeroext)(?![\w.$-])|#\d+|align\s+\d+/g;
    function decodeCString(body) {
        const out = []; for (let i = 0; i < body.length; i++) { const c = body[i]; if (c === String.fromCharCode(92)) { const h = body.slice(i + 1, i + 3); if (/^[0-9A-Fa-f]{2}$/.test(h)) { out.push(parseInt(h, 16)); i += 2; } else if (body[i + 1] === String.fromCharCode(92)) { out.push(92); i++; } else throw new Error('c"…" 裡的跳脫不認得：' + body.slice(i, i + 3)); } else { const cp = c.codePointAt(0); if (cp < 128) out.push(cp); else { const bytes = typeof TextEncoder !== 'undefined' ? Array.from(new TextEncoder().encode(String.fromCodePoint(cp))) : [63]; out.push.apply(out, bytes); if (cp > 0xffff) i++; } } }
        return out;
    }
    // 運算元：%x、@g、整數、小數、null、true／false、undef／zeroinitializer、常數 getelementptr
    function parseValue(s, ty) {
        s = s.trim();
        let m;
        if ((m = /^%([\w.$-]+)$/.exec(s))) return { k: 'reg', name: m[1] };
        if ((m = /^@([\w.$-]+)$/.exec(s))) return { k: 'global', name: m[1] };
        if (s === 'null') return { k: 'null' };
        if (s === 'true') return { k: 'int', v: 1n }; if (s === 'false') return { k: 'int', v: 0n };
        if (s === 'undef' || s === 'zeroinitializer' || s === 'poison') return { k: 'zero' };
        if (/^-?\d+$/.test(s)) return { k: 'int', v: BigInt(s) };
        if (/^-?\d+\.\d*(?:e[+-]?\d+)?$/i.test(s) || /^-?\d+e[+-]?\d+$/i.test(s)) return { k: 'float', v: Number(s) };
        if (/^0x[0-9a-f]{16}$/i.test(s)) { const b = new DataView(new ArrayBuffer(8)); b.setBigUint64(0, BigInt(s)); return { k: 'float', v: b.getFloat64(0) }; }
        if ((m = /^getelementptr\s*(?:inbounds\s*)?\((.*)\)$/.exec(s))) { const parts = splitTop(m[1]); const base = parseTyped(parts[1]); return { k: 'cgep', ty: parseType(parts[0]), base: base.v, baseTy: base.ty, idx: parts.slice(2).map((p) => parseTyped(p)) }; }
        if ((m = /^bitcast\s*\((.*)\s+to\s+(.*)\)$/.exec(s))) { const v = parseTyped(m[1]); return { k: 'cbitcast', v: v.v, from: v.ty, to: parseType(m[2]) }; }
        throw new Error('看不懂的值：' + s);
    }
    function parseTyped(s) { const r = parseTypeAt(s, 0); return { ty: r.ty, v: parseValue(s.slice(r.end), r.ty) }; }

    function parse(text) {
        const mod = { types: new Map(), globals: [], funcs: [], declares: [], triple: '' }; const errors = [];
        const lines = String(text).split(/\r?\n/); let f = null, blk = null;
        const err = (n, m) => errors.push({ line: n + 1, msg: m });
        for (let n = 0; n < lines.length; n++) {
            let raw = stripComment(lines[n]).trim(); if (!raw) continue; let m;
            try {
                if (f) {
                    if (raw === '}') { if (blk && !blk.insts.length && !blk.term) err(n, '區塊 ' + blk.label + ' 是空的'); mod.funcs.push(f); f = null; blk = null; continue; }
                    if ((m = /^([\w.$-]+):$/.exec(raw))) { if (blk && !blk.term && blk.insts.length) { /* 沒有結尾的區塊由 check 回報 */ } blk = { label: m[1], insts: [], term: null, line: n + 1 }; f.blocks.push(blk); continue; }
                    if (!blk) { blk = { label: 'entry', insts: [], term: null, line: n + 1 }; f.blocks.push(blk); }
                    const inst = parseInst(raw.replace(ATTRS, ' ').replace(/\s+/g, ' ').trim()); inst.line = n + 1;
                    if (blk.term) { err(n, '區塊 ' + blk.label + ' 已經結束了，後面不能再有指令'); }
                    if (['br', 'ret', 'unreachable'].includes(inst.op)) blk.term = inst; else blk.insts.push(inst);
                    continue;
                }
                if ((m = /^target\s+triple\s*=\s*"([^"]*)"/.exec(raw))) { mod.triple = m[1]; continue; }
                if (/^target\s+datalayout/.test(raw) || /^source_filename/.test(raw) || /^attributes\s+#/.test(raw) || /^!/.test(raw)) continue;
                if ((m = /^%([\w.$-]+)\s*=\s*type\s+(.*)$/.exec(raw))) { mod.types.set(m[1], parseType(m[2].trim())); continue; }
                if ((m = /^@([\w.$-]+)\s*=\s*(.*)$/.exec(raw))) {
                    let rest = m[2].replace(/\b(private|internal|external|common|linkonce_odr|weak|dso_local|unnamed_addr|local_unnamed_addr|hidden)\b/g, ' ').replace(/,\s*align\s+\d+/g, '').replace(/\s+/g, ' ').trim();
                    const isConst = /^constant\b/.test(rest); rest = rest.replace(/^(constant|global)\s+/, '');
                    const r = parseTypeAt(rest, 0); const init = rest.slice(r.end).trim(); let g = { name: m[1], ty: r.ty, isConst, bytes: null, line: n + 1, init: null, external: /\bexternal\b/.test(m[2]) };
                    if ((m = /^c"(.*)"$/.exec(init))) g.bytes = decodeCString(m[1]); else if (init) g.init = parseValue(init, r.ty);
                    mod.globals.push(g); continue;
                }
                if ((m = /^declare\s+(.*)$/.exec(raw))) { const h = parseHeader(m[1].replace(ATTRS, ' ')); mod.declares.push({ name: h.name, ret: h.ret, params: h.params.map((p) => p.ty), line: n + 1 }); continue; }
                if ((m = /^define\s+(.*)\{$/.exec(raw))) { const h = parseHeader(m[1].replace(ATTRS, ' ')); f = { name: h.name, ret: h.ret, params: h.params, blocks: [], line: n + 1 }; blk = null; continue; }
                err(n, '看不懂這一行：' + raw.slice(0, 60));
            } catch (e) { err(n, String((e && e.message) || e)); }
        }
        if (f) errors.push({ line: f.line, msg: '函式 ' + f.name + ' 沒有結束的 }' });
        return { mod, errors };
    }
    function parseHeader(s) {
        s = s.trim(); const r = parseTypeAt(s, 0); const rest = s.slice(r.end).trim(); const m = /^@([\w.$-]+)\s*\((.*)\)\s*$/.exec(rest); if (!m) throw new Error('函式標頭格式錯誤：' + s.slice(0, 60));
        const params = splitTop(m[2]).filter((x) => x && x !== '...').map((p, i) => { const pr = parseTypeAt(p, 0); const nm = /^\s*%([\w.$-]+)/.exec(p.slice(pr.end)); return { ty: pr.ty, name: nm ? nm[1] : null }; });
        if (/\.\.\./.test(m[2])) throw new Error('不支援可變參數函式：' + m[1]);
        return { ret: r.ty, name: m[1], params };
    }
    function parseInst(s) {
        let m, res = null;
        if ((m = /^%([\w.$-]+)\s*=\s*(.*)$/.exec(s))) { res = m[1]; s = m[2]; }
        const opM = /^([a-z_]+)\s*(.*)$/.exec(s); if (!opM) throw new Error('看不懂的指令：' + s.slice(0, 50));
        const op = opM[1]; const rest = opM[2];
        switch (op) {
            case 'alloca': { const parts = splitTop(rest); return { op, res, ty: parseType(parts[0]) }; }
            case 'load': { const p = splitTop(rest); const ty = parseType(p[0]); const ptr = parseTyped(p[1]); return { op, res, ty, ptr: ptr.v, ptrTy: ptr.ty }; }
            case 'store': { const p = splitTop(rest); const v = parseTyped(p[0]); const ptr = parseTyped(p[1]); return { op, ty: v.ty, val: v.v, ptr: ptr.v, ptrTy: ptr.ty }; }
            case 'getelementptr': { const p = splitTop(rest); const ty = parseType(p[0]); const base = parseTyped(p[1]); return { op, res, ty, base: base.v, baseTy: base.ty, idx: p.slice(2).map(parseTyped) }; }
            case 'add': case 'sub': case 'mul': case 'sdiv': case 'udiv': case 'srem': case 'urem': case 'and': case 'or': case 'xor': case 'shl': case 'ashr': case 'lshr':
            case 'fadd': case 'fsub': case 'fmul': case 'fdiv': { const r = parseTypeAt(rest, 0); const p = splitTop(rest.slice(r.end)); return { op, res, ty: r.ty, a: parseValue(p[0], r.ty), b: parseValue(p[1], r.ty) }; }
            case 'icmp': case 'fcmp': { const pm = /^([a-z]+)\s+(.*)$/.exec(rest); const r = parseTypeAt(pm[2], 0); const p = splitTop(pm[2].slice(r.end)); return { op, res, pred: pm[1], ty: r.ty, a: parseValue(p[0], r.ty), b: parseValue(p[1], r.ty) }; }
            case 'bitcast': case 'zext': case 'sext': case 'trunc': case 'sitofp': case 'uitofp': case 'fptosi': case 'ptrtoint': case 'inttoptr': { const cm = /^(.*)\s+to\s+(.*)$/.exec(rest); const v = parseTyped(cm[1]); return { op, res, from: v.ty, v: v.v, to: parseType(cm[2]) }; }
            case 'select': { const p = splitTop(rest); const c = parseTyped(p[0]); const a = parseTyped(p[1]); const b = parseTyped(p[2]); return { op, res, cond: c.v, ty: a.ty, a: a.v, b: b.v }; }
            case 'call': { const r = parseTypeAt(rest, 0); const cm = /^\s*@([\w.$-]+)\s*\((.*)\)\s*$/.exec(rest.slice(r.end)); if (!cm) throw new Error('只支援直接呼叫 @函式(...)：' + rest.slice(0, 50)); return { op, res, ret: r.ty, callee: cm[1], args: splitTop(cm[2]).map(parseTyped) }; }
            case 'br': { let bm; if ((bm = /^label\s+%([\w.$-]+)$/.exec(rest))) return { op, to: bm[1] }; bm = /^i1\s+(.*?),\s*label\s+%([\w.$-]+),\s*label\s+%([\w.$-]+)$/.exec(rest); if (!bm) throw new Error('br 格式錯誤：' + rest); return { op, cond: parseValue(bm[1]), then: bm[2], else: bm[3] }; }
            case 'ret': { if (rest.trim() === 'void') return { op, ty: T.void }; const v = parseTyped(rest); return { op, ty: v.ty, val: v.v }; }
            case 'unreachable': return { op };
            case 'phi': throw new Error('第一版不支援 phi（用 alloca／load／store 代替）');
        }
        throw new Error('不支援的指令：' + op);
    }

    // =====================================================================
    // 型別大小與排版
    // =====================================================================
    function resolve(mod, t) { let n = 0; while (t && t.k === 'named') { const r = mod.types.get(t.name); if (!r) throw new Error('沒有這個型別：%' + t.name); t = r; if (++n > 50) throw new Error('型別循環'); } return t; }
    function layout(mod, t) {
        t = resolve(mod, t);
        switch (t.k) {
            case 'int': return t.bits <= 8 ? { size: 1, align: 1 } : t.bits === 32 ? { size: 4, align: 4 } : { size: 8, align: 8 };
            case 'double': return { size: 8, align: 8 };
            case 'ptr': return { size: 4, align: 4 };
            case 'array': { const e = layout(mod, t.of); return { size: e.size * t.n, align: e.align }; }
            case 'struct': { let off = 0, al = 1; const offs = []; for (const f of t.fields) { const l = layout(mod, f); off = Math.ceil(off / l.align) * l.align; offs.push(off); off += l.size; al = Math.max(al, l.align); } return { size: Math.ceil(off / al) * al || 0, align: al, offsets: offs }; }
        }
        throw new Error('沒有大小的型別：' + typeStr(t));
    }

    // =====================================================================
    // 檢查（型別、定義前使用、標籤、呼叫）
    // =====================================================================
    const WASI = {
        fd_write: { params: [T.i32, T.i32, T.i32, T.i32], ret: T.i32 }, fd_read: { params: [T.i32, T.i32, T.i32, T.i32], ret: T.i32 }, proc_exit: { params: [T.i32], ret: T.void },
        args_sizes_get: { params: [T.i32, T.i32], ret: T.i32 }, args_get: { params: [T.i32, T.i32], ret: T.i32 }, environ_sizes_get: { params: [T.i32, T.i32], ret: T.i32 }, environ_get: { params: [T.i32, T.i32], ret: T.i32 },
        clock_time_get: { params: [T.i32, T.i64, T.i32], ret: T.i32 }, random_get: { params: [T.i32, T.i32], ret: T.i32 }
    };
    const INTRINSICS = { 'llvm.wasm.memory.grow.i32': { params: [T.i32, T.i32], ret: T.i32 }, 'llvm.wasm.memory.size.i32': { params: [T.i32], ret: T.i32 } };
    const INT_BIN = new Set(['add', 'sub', 'mul', 'sdiv', 'udiv', 'srem', 'urem', 'and', 'or', 'xor', 'shl', 'ashr', 'lshr']);
    const F_BIN = new Set(['fadd', 'fsub', 'fmul', 'fdiv']);
    const ICMP = new Set(['eq', 'ne', 'slt', 'sle', 'sgt', 'sge', 'ult', 'ule', 'ugt', 'uge']);
    const FCMP = new Set(['oeq', 'one', 'olt', 'ogt', 'ole', 'oge', 'une', 'ueq']);
    const isInt = (t) => t && t.k === 'int'; const isPtr = (t) => t && t.k === 'ptr';
    // copts.partial：檢查「物件檔」——還沒連結，所以允許宣告了但沒有實作的函式、沒有進入點
    function check(mod, copts) {
        const partial = !!(copts && copts.partial);
        const errors = []; const E = (line, msg) => errors.push({ line, msg });
        const globals = new Map(mod.globals.map((g) => [g.name, g])); const funcs = new Map();
        for (const d of mod.declares) { funcs.set(d.name, { ret: d.ret, params: d.params, declared: true }); if (INTRINSICS[d.name]) { if (d.params.map(typeStr).join() !== INTRINSICS[d.name].params.map(typeStr).join() || typeStr(d.ret) !== typeStr(INTRINSICS[d.name].ret)) E(d.line, '@' + d.name + ' 的簽名不對'); } else if (!WASI[d.name]) E(d.line, '宣告的函式 @' + d.name + ' 沒有實作（支援的 WASI：' + Object.keys(WASI).join('、') + '；內建的 libc：puts、putchar、malloc、calloc、free、strlen、memcpy、memset、memcmp、strcmp、abs、exit、getchar；printf 這類可變參數函式不支援）'); else if (!INTRINSICS[d.name] && typeStr(WASI[d.name].ret) !== typeStr(d.ret) || d.params.map(typeStr).join() !== WASI[d.name].params.map(typeStr).join()) E(d.line, '@' + d.name + ' 的簽名要是 ' + typeStr(WASI[d.name].ret) + ' (' + WASI[d.name].params.map(typeStr).join(', ') + ')'); }
        for (const f of mod.funcs) { if (funcs.has(f.name) && !funcs.get(f.name).declared) E(f.line, '函式 @' + f.name + ' 定義了兩次'); funcs.set(f.name, { ret: f.ret, params: f.params.map((p) => p.ty) }); }
        for (const [name, t] of mod.types) { try { layout(mod, t); } catch (e) { E(0, '型別 %' + name + '：' + e.message); } }
        for (const g of mod.globals) { try { layout(mod, g.ty); } catch (e) { E(g.line, '全域 @' + g.name + '：' + e.message); } }
        const tyOfConst = (v, ty, line) => v; void tyOfConst;
        for (const f of mod.funcs) {
            const regs = new Map(); const labels = new Set(f.blocks.map((b) => b.label)); f.regTypes = regs;
            f.params.forEach((p, i) => { const nm = p.name || String(i); if (regs.has(nm)) E(f.line, '參數名稱重複：%' + nm); regs.set(nm, p.ty); });
            if (!f.blocks.length) E(f.line, '函式 @' + f.name + ' 沒有內容');
            const defined = new Set(f.params.map((p, i) => p.name || String(i)));
            // 先收集所有結果型別（讓跨區塊的使用查得到），再檢查
            const typeOfRes = (i) => { switch (i.op) { case 'alloca': return ptrTo(i.ty); case 'load': return i.ty; case 'getelementptr': return gepResult(i); case 'icmp': case 'fcmp': return T.i1; case 'bitcast': case 'zext': case 'sext': case 'trunc': case 'sitofp': case 'uitofp': case 'fptosi': case 'ptrtoint': case 'inttoptr': return i.to; case 'select': return i.ty; case 'call': return i.ret; default: return i.ty; } };
            const gepResult = (i) => { try { const r = gepType(mod, i.ty, i.idx, (m) => E(i.line, m)); return i.baseTy && !i.baseTy.to ? T.ptr : r; } catch (_) { return null; } };
            for (const b of f.blocks) for (const i of b.insts) if (i.res) { if (regs.has(i.res)) E(i.line, '%' + i.res + ' 定義了兩次'); regs.set(i.res, typeOfRes(i)); }
            for (const b of f.blocks) {
                const seenHere = new Set();
                const val = (v, want, line, what) => {
                    if (!v) return; let have = null;
                    switch (v.k) {
                        case 'reg': if (!regs.has(v.name)) { E(line, what + '：%' + v.name + ' 沒有定義'); return; } have = regs.get(v.name); if (!defined.has(v.name) && !seenHere.has(v.name) && !f.blocks.some((bb) => bb !== b && bb.insts.some((x) => x.res === v.name))) E(line, what + '：%' + v.name + ' 在定義之前就使用了'); break;
                        case 'global': { const g = globals.get(v.name); if (!g) { if (funcs.has(v.name)) { E(line, what + '：第一版不支援函式指標 @' + v.name); return; } E(line, what + '：沒有全域 @' + v.name); return; } have = ptrTo(g.ty); break; }
                        case 'int': if (want && !isInt(resolve(mod, want)) && !isPtr(resolve(mod, want))) E(line, what + '：整數常數不能當 ' + typeStr(want)); return;
                        case 'float': if (want && want.k !== 'double') E(line, what + '：小數常數不能當 ' + typeStr(want)); return;
                        case 'null': if (want && !isPtr(resolve(mod, want))) E(line, what + '：null 不能當 ' + typeStr(want)); return;
                        case 'zero': return;
                        case 'cgep': { const g = v.base && v.base.k === 'global' && globals.get(v.base.name); if (!g) { E(line, what + '：常數 getelementptr 的底必須是全域'); return; } try { have = gepType(mod, v.ty, v.idx, (m) => E(line, m)); } catch (e) { E(line, what + '：' + e.message); return; } break; }
                        case 'cbitcast': have = v.to; break;
                    }
                    if (want && have && !sameType(resolveShallow(mod, want), resolveShallow(mod, have))) E(line, what + '：型別不符，要 ' + typeStr(want) + '，實際是 ' + typeStr(have));
                };
                for (const i of b.insts.concat(b.term ? [b.term] : [])) {
                    const L = i.line; const need = (cond, msg) => { if (!cond) E(L, msg); };
                    switch (i.op) {
                        case 'alloca': try { layout(mod, i.ty); } catch (e) { E(L, 'alloca：' + e.message); } break;
                        case 'load': val(i.ptr, null, L, 'load'); need(isPtr(i.ptrTy) && (!i.ptrTy.to || sameType(resolveShallow(mod, i.ptrTy.to), resolveShallow(mod, i.ty))), 'load：指標型別 ' + typeStr(i.ptrTy) + ' 載不出 ' + typeStr(i.ty)); val(i.ptr, i.ptrTy, L, 'load 的指標'); break;
                        case 'store': val(i.val, i.ty, L, 'store 的值'); val(i.ptr, i.ptrTy, L, 'store 的指標'); need(isPtr(i.ptrTy) && (!i.ptrTy.to || sameType(resolveShallow(mod, i.ptrTy.to), resolveShallow(mod, i.ty))), 'store：不能把 ' + typeStr(i.ty) + ' 存到 ' + typeStr(i.ptrTy)); break;
                        case 'getelementptr': val(i.base, i.baseTy, L, 'gep 的底'); need(isPtr(i.baseTy) && (!i.baseTy.to || sameType(resolveShallow(mod, i.baseTy.to), resolveShallow(mod, i.ty))), 'getelementptr：底的型別 ' + typeStr(i.baseTy) + ' 跟 ' + typeStr(i.ty) + ' 不合'); i.idx.forEach((x) => val(x.v, x.ty, L, 'gep 的索引')); gepResult(i); break;
                        case 'icmp': val(i.a, i.ty, L, 'icmp'); val(i.b, i.ty, L, 'icmp'); need(ICMP.has(i.pred), '不認得的 icmp 條件：' + i.pred); need(isInt(i.ty) || isPtr(i.ty), 'icmp 只能比整數或指標'); if (isInt(i.ty) && i.ty.bits < 32 && /^s(lt|le|gt|ge)$/.test(i.pred)) E(L, '第一版不支援 ' + typeStr(i.ty) + ' 的有號比較（先 sext 成 i32）'); break;
                        case 'fcmp': val(i.a, i.ty, L, 'fcmp'); val(i.b, i.ty, L, 'fcmp'); need(FCMP.has(i.pred), '不認得的 fcmp 條件：' + i.pred); need(i.ty.k === 'double', 'fcmp 只支援 double'); break;
                        case 'select': val(i.cond, T.i1, L, 'select 的條件'); val(i.a, i.ty, L, 'select'); val(i.b, i.ty, L, 'select'); break;
                        case 'bitcast': val(i.v, i.from, L, 'bitcast'); need(isPtr(i.from) && isPtr(i.to), 'bitcast 第一版只支援指標轉指標'); break;
                        case 'zext': case 'sext': val(i.v, i.from, L, i.op); need(isInt(i.from) && isInt(i.to) && i.from.bits < i.to.bits, i.op + '：要從小的整數到大的整數'); break;
                        case 'trunc': val(i.v, i.from, L, 'trunc'); need(isInt(i.from) && isInt(i.to) && i.from.bits > i.to.bits, 'trunc：要從大的整數到小的整數'); break;
                        case 'sitofp': case 'uitofp': val(i.v, i.from, L, i.op); need(isInt(i.from) && i.to.k === 'double' && i.from.bits >= 32, i.op + '：要從 i32／i64 到 double'); break;
                        case 'fptosi': val(i.v, i.from, L, 'fptosi'); need(i.from.k === 'double' && isInt(i.to) && i.to.bits >= 32, 'fptosi：要從 double 到 i32／i64'); break;
                        case 'ptrtoint': val(i.v, i.from, L, 'ptrtoint'); need(isPtr(i.from) && isInt(i.to) && i.to.bits >= 32, 'ptrtoint：要從指標到 i32／i64'); break;
                        case 'inttoptr': val(i.v, i.from, L, 'inttoptr'); need(isInt(i.from) && i.from.bits >= 32 && isPtr(i.to), 'inttoptr：要從 i32／i64 到指標'); break;
                        case 'call': { const fn = funcs.get(i.callee); if (!fn) { E(L, '呼叫沒有定義的函式 @' + i.callee); break; } if (i.args.length !== fn.params.length) { E(L, '@' + i.callee + ' 要 ' + fn.params.length + ' 個參數，給了 ' + i.args.length + ' 個'); break; } need(sameType(resolveShallow(mod, fn.ret), resolveShallow(mod, i.ret)), '@' + i.callee + ' 回傳 ' + typeStr(fn.ret) + '，不是 ' + typeStr(i.ret)); i.args.forEach((a, k) => { need(sameType(resolveShallow(mod, a.ty), resolveShallow(mod, fn.params[k])), '@' + i.callee + ' 的第 ' + (k + 1) + ' 個參數要 ' + typeStr(fn.params[k]) + '，給的是 ' + typeStr(a.ty)); val(a.v, a.ty, L, '@' + i.callee + ' 的參數 ' + (k + 1)); }); need(!(i.res && i.ret.k === 'void'), 'void 函式沒有回傳值可以指定給 %' + i.res); break; }
                        case 'br': if (i.cond) { val(i.cond, T.i1, L, 'br 的條件'); need(labels.has(i.then), 'br：沒有標籤 ' + i.then); need(labels.has(i.else), 'br：沒有標籤 ' + i.else); } else need(labels.has(i.to), 'br：沒有標籤 ' + i.to); break;
                        case 'ret': need(sameType(resolveShallow(mod, i.ty), resolveShallow(mod, f.ret)), '函式 @' + f.name + ' 要回傳 ' + typeStr(f.ret) + '，ret 給的是 ' + typeStr(i.ty)); if (i.val) val(i.val, i.ty, L, 'ret'); break;
                        case 'unreachable': break;
                        default:
                            if (INT_BIN.has(i.op)) { val(i.a, i.ty, L, i.op); val(i.b, i.ty, L, i.op); need(isInt(i.ty) && i.ty.bits >= 1, i.op + ' 只能用在整數'); }
                            else if (F_BIN.has(i.op)) { val(i.a, i.ty, L, i.op); val(i.b, i.ty, L, i.op); need(i.ty.k === 'double', i.op + ' 只支援 double'); }
                    }
                    if (i.res) seenHere.add(i.res);
                }
                if (!b.term) E(b.line, '區塊 ' + b.label + ' 沒有結尾（br、ret 或 unreachable）');
            }
        }
        if (!mod.funcs.some((f) => f.name === '_start' || f.name === 'main')) errors.push({ line: 0, msg: '沒有進入點 @_start（或 @main）' });
        return partial ? errors.filter((e) => !/沒有實作|沒有進入點/.test(e.msg)) : errors;
    }
    function resolveShallow(mod, t) { try { return resolve(mod, t); } catch (_) { return t; } }
    // getelementptr 的結果型別（索引第一個走過指標、之後進入 struct 或 array）
    function gepType(mod, ty, idx, onErr) {
        let cur = ty; for (let k = 1; k < idx.length; k++) { const r = resolve(mod, cur); const ix = idx[k].v;
            if (r.k === 'struct') { if (ix.k !== 'int') throw new Error('struct 的索引必須是常數'); const n = Number(ix.v); if (n < 0 || n >= r.fields.length) { onErr && onErr('struct 只有 ' + r.fields.length + ' 個欄位，索引 ' + n + ' 超出'); throw new Error('struct 索引超出範圍'); } cur = r.fields[n]; }
            else if (r.k === 'array') cur = r.of; else { onErr && onErr('getelementptr 不能再往 ' + typeStr(r) + ' 裡面走'); throw new Error('不能再往裡面走'); } }
        return ptrTo(cur);
    }

    // =====================================================================
    // wasm 二進位
    // =====================================================================
    const VT = { i32: 0x7f, i64: 0x7e, f64: 0x7c };
    function wtype(mod, t) { t = resolve(mod, t); if (t.k === 'int') return t.bits === 64 ? 'i64' : 'i32'; if (t.k === 'double') return 'f64'; if (t.k === 'ptr') return 'i32'; if (t.k === 'void') return null; throw new Error('不能放進暫存器的型別：' + typeStr(t)); }
    function uleb(n) { n = Number(n); const o = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b); } while (n); return o; }
    function sleb(n) { n = BigInt(n); const o = []; for (;;) { const b = Number(n & 0x7fn); n >>= 7n; if ((n === 0n && !(b & 0x40)) || (n === -1n && (b & 0x40))) { o.push(b); return o; } o.push(b | 0x80); } }
    const wrap32 = (v) => Number(BigInt.asIntN(32, BigInt(v)));
    function f64bytes(x) { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, x, true); return Array.from(new Uint8Array(dv.buffer)); }
    const str = (s) => { const b = Array.from(new TextEncoder().encode(s)); return uleb(b.length).concat(b); };
    const section = (id, body) => [id].concat(uleb(body.length), body);
    const vec = (items) => uleb(items.length).concat([].concat.apply([], items));
    const OP = { unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, br_table: 0x0e, return: 0x0f, call: 0x10, drop: 0x1a, select: 0x1b, local_get: 0x20, local_set: 0x21, local_tee: 0x22, global_get: 0x23, global_set: 0x24, i32_const: 0x41, i64_const: 0x42, f64_const: 0x44 };
    const BIN = {
        i32: { add: 0x6a, sub: 0x6b, mul: 0x6c, sdiv: 0x6d, udiv: 0x6e, srem: 0x6f, urem: 0x70, and: 0x71, or: 0x72, xor: 0x73, shl: 0x74, ashr: 0x75, lshr: 0x76 },
        i64: { add: 0x7c, sub: 0x7d, mul: 0x7e, sdiv: 0x7f, udiv: 0x80, srem: 0x81, urem: 0x82, and: 0x83, or: 0x84, xor: 0x85, shl: 0x86, ashr: 0x87, lshr: 0x88 },
        f64: { fadd: 0xa0, fsub: 0xa1, fmul: 0xa2, fdiv: 0xa3 }
    };
    const CMP = { i32: { eq: 0x46, ne: 0x47, slt: 0x48, ult: 0x49, sgt: 0x4a, ugt: 0x4b, sle: 0x4c, ule: 0x4d, sge: 0x4e, uge: 0x4f }, i64: { eq: 0x51, ne: 0x52, slt: 0x53, ult: 0x54, sgt: 0x55, ugt: 0x56, sle: 0x57, ule: 0x58, sge: 0x59, uge: 0x5a }, f64: { oeq: 0x61, ueq: 0x61, one: 0x62, une: 0x62, olt: 0x63, ogt: 0x64, ole: 0x65, oge: 0x66 } };
    const DATA_BASE = 1024, STACK_TOP = 65536, PAGES = 16;

    function toWasm(mod, opts) {
        opts = opts || {}; const errs = check(mod); if (errs.length) throw new Error('IR 沒有通過檢查：' + errs.slice(0, 5).map((e) => (e.line ? '第 ' + e.line + ' 行：' : '') + e.msg).join('；'));
        // 全域變數的位址
        const addr = new Map(); let off = DATA_BASE; const segs = [];
        for (const g of mod.globals) {
            if (g.name === '__heap_base') continue; // 由後端決定（跟 wasm-ld 一樣：堆積的起點）
            const l = layout(mod, g.ty); off = Math.ceil(off / l.align) * l.align; addr.set(g.name, off); let bytes = null;
            if (g.bytes) { bytes = g.bytes.slice(); while (bytes.length < l.size) bytes.push(0); }
            else if (g.init && g.init.k === 'int') { bytes = []; let v = BigInt.asUintN(l.size * 8, g.init.v); for (let k = 0; k < l.size; k++) { bytes.push(Number(v & 0xffn)); v >>= 8n; } }
            else if (g.init && g.init.k === 'float') bytes = f64bytes(g.init.v);
            if (bytes && bytes.some((x) => x)) segs.push({ at: off, bytes });
            off += l.size;
        }
        // 記憶體配置：[保留 0..1024) [資料（多大都行）] [影子堆疊（往下長，預設 1MB，可用 opts.stackSize 調）] [堆積：malloc 不夠會 memory.grow]
        const stackSize = Math.max(4096, Math.floor(opts.stackSize || 1048576)); const stackStart = Math.ceil(off / 16) * 16; const stackTop = stackStart + stackSize; const heapBase = stackTop;
        addr.set('__heap_base', heapBase); const initPages = Math.ceil((heapBase + 65536) / 65536); if (initPages >= 65536) throw new Error('全域資料加堆疊太大，超過 wasm32 的 4GB 上限');
        // 函式索引：匯入在前
        const imports = mod.declares.filter((d) => WASI[d.name]); const fidx = new Map(); imports.forEach((d, i) => fidx.set(d.name, i)); mod.funcs.forEach((f, i) => fidx.set(f.name, imports.length + i));
        const sigs = []; const sigOf = (params, ret) => { const key = params.map((p) => wtype(mod, p)).join() + '>' + (wtype(mod, ret) || ''); let i = sigs.findIndex((s) => s.key === key); if (i < 0) { sigs.push({ key, params: params.map((p) => wtype(mod, p)), ret: wtype(mod, ret) }); i = sigs.length - 1; } return i; };
        const impSig = imports.map((d) => sigOf(d.params, d.ret)); const fnSig = mod.funcs.map((f) => sigOf(f.params.map((p) => p.ty), f.ret));
        const bodies = mod.funcs.map((f) => emitFunction(mod, f, addr, fidx, !!(opts.fuel), stackStart));
        const typeSec = section(1, vec(sigs.map((s) => [0x60].concat(vec(s.params.map((p) => [VT[p]])), s.ret ? vec([[VT[s.ret]]]) : [0]))));
        const impSec = section(2, vec(imports.map((d, i) => str('wasi_snapshot_preview1').concat(str(d.name), [0x00], uleb(impSig[i])))));
        const funcSec = section(3, vec(fnSig.map((i) => uleb(i))));
        const memSec = section(5, vec([[0x00].concat(uleb(initPages))]));
        const fuel = opts.fuel ? Math.min(Math.floor(opts.fuel), 2147483000) : 0;
        const globSec = section(6, vec([[VT.i32, 0x01, OP.i32_const].concat(sleb(stackTop), [OP.end]), [VT.i32, 0x00, OP.i32_const].concat(sleb(stackStart), [OP.end])].concat(fuel ? [[VT.i32, 0x01, OP.i32_const].concat(sleb(fuel), [OP.end])] : [])));
        const entry = mod.funcs.find((f) => f.name === (opts.entry || '_start')) || mod.funcs.find((f) => f.name === 'main');
        const expSec = section(7, vec([str('memory').concat([0x02], uleb(0)), str(entry.name === 'main' ? 'main' : '_start').concat([0x00], uleb(fidx.get(entry.name))), str('__sp').concat([0x03], uleb(0)), str('__stack_limit').concat([0x03], uleb(1))].concat(fuel ? [str('__fuel').concat([0x03], uleb(2))] : [])));
        const codeSec = section(10, vec(bodies.map((b) => uleb(b.length).concat(b))));
        const dataSec = section(11, vec(segs.map((s) => [0x00, OP.i32_const].concat(sleb(s.at), [OP.end], uleb(s.bytes.length), s.bytes))));
        const bytes = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00].concat(typeSec, impSec, funcSec, memSec, globSec, expSec, codeSec, segs.length ? dataSec : []);
        return new Uint8Array(bytes);
    }

    function emitFunction(mod, f, addr, fidx, fuel, stackStart) {
        const code = []; const emit = (...b) => { for (const x of b) { if (Array.isArray(x)) code.push.apply(code, x); else code.push(x); } };
        const localTypes = []; const regIdx = new Map();
        f.params.forEach((p, i) => { regIdx.set(p.name || String(i), i); });
        let nParams = f.params.length; const newLocal = (wt) => { localTypes.push(wt); return nParams + localTypes.length - 1; };
        // 影子堆疊：每個 alloca 一個固定位置
        const allocas = []; let frame = 0;
        for (const b of f.blocks) for (const i of b.insts) if (i.op === 'alloca') { const l = layout(mod, i.ty); frame = Math.ceil(frame / Math.max(l.align, 1)) * Math.max(l.align, 1); allocas.push({ res: i.res, off: frame }); frame += Math.max(l.size, 1); }
        frame = Math.ceil(frame / 8) * 8;
        const fp = frame ? newLocal('i32') : -1; const pc = newLocal('i32');
        for (const b of f.blocks) for (const i of b.insts) if (i.res) regIdx.set(i.res, newLocal(i.op === 'alloca' ? 'i32' : (wtype(mod, f.regTypes.get(i.res)) || 'i32')));
        const wt = (t) => wtype(mod, t);
        const constAddr = (v) => { if (v.k === 'global') return addr.get(v.name); if (v.k === 'cgep') { const g = addr.get(v.base.name); let o = 0; let cur = v.ty; const idx = v.idx; if (idx[0].v.k !== 'int') throw new Error('常數 getelementptr 的索引必須是整數'); o += Number(idx[0].v.v) * layout(mod, cur).size; for (let k = 1; k < idx.length; k++) { const r = resolve(mod, cur); const n = Number(idx[k].v.v); if (r.k === 'struct') { o += layout(mod, r).offsets[n]; cur = r.fields[n]; } else { o += n * layout(mod, r.of).size; cur = r.of; } } return g + o; } if (v.k === 'cbitcast') return constAddr(v.v); throw new Error('不是常數位址'); };
        const push = (v, ty) => {
            const w = wt(ty);
            switch (v.k) {
                case 'reg': emit(OP.local_get, uleb(regIdx.get(v.name))); return;
                case 'int': if (w === 'i64') emit(OP.i64_const, sleb(v.v)); else emit(OP.i32_const, sleb(wrap32(v.v))); return;
                case 'float': emit(OP.f64_const, f64bytes(v.v)); return;
                case 'null': emit(OP.i32_const, sleb(0)); return;
                case 'zero': if (w === 'i64') emit(OP.i64_const, 0); else if (w === 'f64') emit(OP.f64_const, f64bytes(0)); else emit(OP.i32_const, 0); return;
                default: emit(OP.i32_const, sleb(constAddr(v))); return;
            }
        };
        const setRes = (i) => emit(OP.local_set, uleb(regIdx.get(i.res)));
        // 區塊分派
        const n = f.blocks.length; const labelIdx = new Map(f.blocks.map((b, k) => [b.label, k]));
        if (frame) { emit(OP.global_get, 0, OP.i32_const, sleb(frame), 0x6b, OP.local_tee, uleb(fp), OP.global_set, 0, OP.local_get, uleb(fp), OP.i32_const, sleb(stackStart), 0x49, OP.if, 0x40, OP.unreachable, OP.end); for (const a of allocas) { emit(OP.local_get, uleb(fp), OP.i32_const, sleb(a.off), 0x6a, OP.local_set, uleb(regIdx.get(a.res))); } }
        emit(OP.loop, 0x40); for (let k = 0; k < n; k++) emit(OP.block, 0x40);
        emit(OP.local_get, uleb(pc), OP.br_table, uleb(n)); for (let k = 0; k < n; k++) emit(uleb(k)); emit(uleb(n - 1));
        for (let k = 0; k < n; k++) {
            emit(OP.end); const b = f.blocks[k]; const back = n - 1 - k; // 回到分派迴圈的深度
            for (const i of b.insts) emitInst(i);
            const t = b.term; emitTerm(t, back);
        }
        emit(OP.end, OP.unreachable, OP.end);
        function restoreSp() { if (frame) emit(OP.local_get, uleb(fp), OP.i32_const, sleb(frame), 0x6a, OP.global_set, 0); }
        function jump(label, back, extra) { if (fuel) emit(OP.global_get, 2, OP.i32_const, 1, 0x6b, OP.global_set, 2, OP.global_get, 2, 0x45, OP.if, 0x40, OP.unreachable, OP.end); emit(OP.i32_const, sleb(labelIdx.get(label)), OP.local_set, uleb(pc), OP.br, uleb(back)); void extra; }
        function emitTerm(t, back) {
            if (t.op === 'br') { if (t.cond) { push(t.cond, T.i1); emit(OP.if, 0x40); jump(t.then, back + 1); emit(OP.else); jump(t.else, back + 1); emit(OP.end); emit(OP.unreachable); } else jump(t.to, back); }
            else if (t.op === 'ret') { if (t.val) { push(t.val, t.ty); restoreSp(); emit(OP.return); } else { restoreSp(); emit(OP.return); } }
            else emit(OP.unreachable);
        }
        function emitInst(i) {
            switch (i.op) {
                case 'alloca': return;
                case 'load': { push(i.ptr, i.ptrTy); const r = resolve(mod, i.ty); const w = wt(i.ty); if (r.k === 'int' && r.bits <= 8) emit(0x2d, 0, 0); else if (w === 'i32') emit(0x28, 0, 0); else if (w === 'i64') emit(0x29, 0, 0); else emit(0x2b, 0, 0); setRes(i); return; }
                case 'store': { push(i.ptr, i.ptrTy); push(i.val, i.ty); const r = resolve(mod, i.ty); const w = wt(i.ty); if (r.k === 'int' && r.bits <= 8) emit(0x3a, 0, 0); else if (w === 'i32') emit(0x36, 0, 0); else if (w === 'i64') emit(0x37, 0, 0); else emit(0x39, 0, 0); return; }
                case 'getelementptr': {
                    push(i.base, i.baseTy); let cur = i.ty; let cst = 0; const dyn = [];
                    const step = (ix, size) => { if (ix.v.k === 'int') cst += Number(ix.v.v) * size; else dyn.push([ix, size]); };
                    step(i.idx[0], layout(mod, cur).size);
                    for (let k = 1; k < i.idx.length; k++) { const r = resolve(mod, cur); if (r.k === 'struct') { const nn = Number(i.idx[k].v.v); cst += layout(mod, r).offsets[nn]; cur = r.fields[nn]; } else { step(i.idx[k], layout(mod, r.of).size); cur = r.of; } }
                    for (const [ix, size] of dyn) { push(ix.v, ix.ty); if (wt(ix.ty) === 'i64') emit(0xa7); emit(OP.i32_const, sleb(size), 0x6c, 0x6a); }
                    if (cst) emit(OP.i32_const, sleb(cst), 0x6a); setRes(i); return;
                }
                case 'icmp': { push(i.a, i.ty); push(i.b, i.ty); emit(CMP[wt(i.ty) === 'i64' ? 'i64' : 'i32'][i.pred]); setRes(i); return; }
                case 'fcmp': { push(i.a, i.ty); push(i.b, i.ty); emit(CMP.f64[i.pred]); setRes(i); return; }
                case 'select': { push(i.a, i.ty); push(i.b, i.ty); push(i.cond, T.i1); emit(OP.select); setRes(i); return; }
                case 'bitcast': push(i.v, i.from); setRes(i); return;
                case 'zext': { push(i.v, i.from); if (wt(i.to) === 'i64') emit(0xad); setRes(i); return; }
                case 'sext': { push(i.v, i.from); const fb = resolve(mod, i.from).bits; if (fb < 32) emit(OP.i32_const, sleb(32 - fb), 0x74, OP.i32_const, sleb(32 - fb), 0x75); if (wt(i.to) === 'i64') emit(0xac); setRes(i); return; }
                case 'trunc': { push(i.v, i.from); if (wt(i.from) === 'i64') emit(0xa7); const tb = resolve(mod, i.to).bits; if (tb < 32) emit(OP.i32_const, sleb((1 << tb) - 1), 0x71); setRes(i); return; }
                case 'sitofp': { push(i.v, i.from); emit(wt(i.from) === 'i64' ? 0xb9 : 0xb7); setRes(i); return; }
                case 'uitofp': { push(i.v, i.from); emit(wt(i.from) === 'i64' ? 0xba : 0xb8); setRes(i); return; }
                case 'fptosi': { push(i.v, i.from); emit(wt(i.to) === 'i64' ? 0xb0 : 0xaa); setRes(i); return; }
                case 'ptrtoint': { push(i.v, i.from); if (wt(i.to) === 'i64') emit(0xad); setRes(i); return; }
                case 'inttoptr': { push(i.v, i.from); if (wt(i.from) === 'i64') emit(0xa7); setRes(i); return; }
                case 'call': { if (i.callee === 'llvm.wasm.memory.grow.i32') { push(i.args[1].v, i.args[1].ty); emit(0x40, 0x00); if (i.res) setRes(i); else emit(OP.drop); return; } if (i.callee === 'llvm.wasm.memory.size.i32') { emit(0x3f, 0x00); if (i.res) setRes(i); else emit(OP.drop); return; } for (const a of i.args) push(a.v, a.ty); emit(OP.call, uleb(fidx.get(i.callee))); if (i.ret.k !== 'void') { if (i.res) setRes(i); else emit(OP.drop); } return; }
                default:
                    if (INT_BIN.has(i.op)) { push(i.a, i.ty); push(i.b, i.ty); emit(BIN[wt(i.ty) === 'i64' ? 'i64' : 'i32'][i.op]); const bits = resolve(mod, i.ty).bits; if (bits < 32 && !['and', 'or', 'xor'].includes(i.op)) emit(OP.i32_const, sleb((1 << bits) - 1), 0x71); setRes(i); return; }
                    if (F_BIN.has(i.op)) { push(i.a, i.ty); push(i.b, i.ty); emit(BIN.f64[i.op]); setRes(i); return; }
                    throw new Error('emit：不支援 ' + i.op);
            }
        }
        // 區域變數宣告：參數之後的所有區域變數，連續同型別壓成一組
        const groups = []; for (const wtp of localTypes) { const last = groups[groups.length - 1]; if (last && last[1] === wtp) last[0]++; else groups.push([1, wtp]); }
        return vec(groups.map((g) => uleb(g[0]).concat([VT[g[1]]]))).concat(code);
    }

    // =====================================================================
    // 執行（WebAssembly＋最小 WASI）
    // =====================================================================
    // 最小的 WASI：輸出（1、2）、輸入（0）、參數、環境變數、時間、亂數、結束碼。io：{ args:[], env:{}, stdin:Uint8Array }
    function makeWasi(io, getMem) {
        io = io || {}; const out = [], err = []; let stdinPos = 0; const stdin = io.stdin || new Uint8Array(0); const enc = new TextEncoder();
        const args = (io.args || []).map((a) => enc.encode(String(a) + String.fromCharCode(0))); const envs = Object.keys(io.env || {}).map((k) => enc.encode(k + '=' + io.env[k] + String.fromCharCode(0)));
        const dvOf = () => new DataView(getMem().buffer); const u8 = () => new Uint8Array(getMem().buffer);
        const sizes = (list, pc, ps) => { const dv = dvOf(); dv.setUint32(pc, list.length, true); dv.setUint32(ps, list.reduce((a, b) => a + b.length, 0), true); return 0; };
        const fill = (list, ptrs, buf) => { const dv = dvOf(), m = u8(); let o = buf; list.forEach((b, i) => { dv.setUint32(ptrs + i * 4, o, true); m.set(b, o); o += b.length; }); return 0; };
        const W = {
            fd_write(fd, iovs, n, nw) { const dv = dvOf(); let total = 0; for (let k = 0; k < n; k++) { const p = dv.getUint32(iovs + k * 8, true), l = dv.getUint32(iovs + k * 8 + 4, true); if (fd === 1) out.push(u8().slice(p, p + l)); else if (fd === 2) err.push(u8().slice(p, p + l)); else return 8; total += l; } dv.setUint32(nw, total, true); return 0; },
            fd_read(fd, iovs, n, nr) { if (fd !== 0) return 8; const dv = dvOf(), m = u8(); let total = 0; for (let k = 0; k < n; k++) { const p = dv.getUint32(iovs + k * 8, true), l = dv.getUint32(iovs + k * 8 + 4, true); const take = Math.min(l, stdin.length - stdinPos); if (take > 0) { m.set(stdin.subarray(stdinPos, stdinPos + take), p); stdinPos += take; total += take; } if (take < l) break; } dv.setUint32(nr, total, true); return 0; },
            args_sizes_get(pc, ps) { return sizes(args, pc, ps); }, args_get(argv, buf) { return fill(args, argv, buf); },
            environ_sizes_get(pc, ps) { return sizes(envs, pc, ps); }, environ_get(e, buf) { return fill(envs, e, buf); },
            clock_time_get(id, prec, outp) { const ns = id === 1 ? BigInt(Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1e6)) : BigInt(Date.now()) * 1000000n; dvOf().setBigUint64(outp, ns, true); return 0; },
            random_get(buf, len) { const m = u8(); for (let i = 0; i < len; i++) m[buf + i] = Math.floor(Math.random() * 256); return 0; },
            proc_exit(code) { throw { wasiExit: code }; }
        };
        const cat = (list) => { let t = 0; for (const c of list) t += c.length; const all = new Uint8Array(t); let o = 0; for (const c of list) { all.set(c, o); o += c.length; } return all; };
        return { imports: { wasi_snapshot_preview1: W }, stdout: () => cat(out), stderr: () => cat(err) };
    }
    function finishRun(instance, wasi, args0) {
        let exitCode = null, trap = null;
        try { const fn = instance.exports._start || instance.exports.main; if (!fn) throw new Error('wasm 沒有匯出 _start 或 main'); const r = fn(); if (typeof r === 'number') exitCode = r; if (exitCode === null) exitCode = 0; }
        catch (e) { if (e && e.wasiExit !== undefined) exitCode = e.wasiExit; else { trap = String((e && e.message) || e); const f = instance.exports.__fuel; const spg = instance.exports.__sp, lim = instance.exports.__stack_limit; if (f && f.value === 0) trap = '步數用完了（可能是無窮迴圈）'; else if (spg && lim && spg.value < lim.value) trap = '堆疊溢位（影子堆疊 1MB 用完，遞迴太深或區域陣列太大）'; else if (/call stack|Maximum call/i.test(trap)) trap = '堆疊溢位（遞迴太深）'; else if (/unreachable/i.test(trap)) trap = '執行到不可能到的地方（unreachable）'; else if (/out of bounds/i.test(trap)) trap = '記憶體存取超出範圍'; else if (/divide by zero|integer overflow/i.test(trap)) trap = '整數除以零或溢位'; } }
        void args0; const dec = new TextDecoder();
        return { stdout: dec.decode(wasi.stdout()), stderr: dec.decode(wasi.stderr()), stdoutBytes: wasi.stdout(), stderrBytes: wasi.stderr(), exitCode, trap };
    }
    async function run(bytes, io) {
        let mem = null; const wasi = makeWasi(io, () => mem); const { instance } = await WebAssembly.instantiate(bytes, wasi.imports); mem = instance.exports.memory; return finishRun(instance, wasi);
    }
    // 同步版（終端機的指令必須同步）：編譯與執行都同步。瀏覽器主執行緒對較大的 wasm 會拒絕同步編譯，這時丟出說明清楚的錯誤
    function runSync(bytes, io) {
        let mem = null; const wasi = makeWasi(io, () => mem); let instance;
        try { instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), wasi.imports); }
        catch (e) { const msg = String((e && e.message) || e); if (/main thread|compile|RangeError/i.test(msg) && bytes.length > 4096) throw new Error('這個瀏覽器不允許在主執行緒同步編譯這麼大的 wasm（' + bytes.length + ' 位元組）：' + msg + '。請改用 llvm_execute 工具（非同步編譯，不受這個限制）'); throw e; }
        mem = instance.exports.memory; return finishRun(instance, wasi);
    }

    // =====================================================================
    // 最小的 libc（用 IR 寫，連結時才加進來）：IR 宣告了這些函式、又沒有自己定義，就補上實作
    // =====================================================================
    const LIBC_DEPS = { __w: [], __alloc: [], puts: ['__w', 'strlen'], putchar: ['__w'], malloc: ['__alloc'], calloc: ['malloc', 'memset'], free: ['__alloc'], realloc: ['malloc', 'free', 'memcpy'], strlen: [], memcpy: [], memset: [], memcmp: [], strcmp: [], abs: [], exit: [], getchar: [] };
    const LIBC_IR = {
        __w: ['@__libc_nl = private constant [2 x i8] c"' + String.fromCharCode(92) + '0A' + String.fromCharCode(92) + '00"', '@__libc_ch = global [4 x i8] zeroinitializer', 'define void @__libc_write(ptr %p, i32 %n) {', 'entry:', '  %pi = ptrtoint ptr %p to i32', '  store i32 %pi, ptr @scratch', '  %lp = getelementptr i32, ptr @scratch, i32 1', '  store i32 %n, ptr %lp', '  %nw = getelementptr i32, ptr @scratch, i32 4', '  %iov = ptrtoint ptr @scratch to i32', '  %nwi = ptrtoint ptr %nw to i32', '  %r = call i32 @fd_write(i32 1, i32 %iov, i32 1, i32 %nwi)', '  ret void', '}'],
        __alloc: ["@heap_ptr = global i32 0", "@__free_lists = global [32 x i32] zeroinitializer", "@__heap_base = external global i8", "declare i32 @llvm.wasm.memory.grow.i32(i32, i32)", "declare i32 @llvm.wasm.memory.size.i32(i32)", "define i32 @__bump(i32 %total) {", "entry:", "  %hp = load i32, ptr @heap_ptr", "  %uninit = icmp eq i32 %hp, 0", "  %hb = ptrtoint ptr @__heap_base to i32", "  %cur = select i1 %uninit, i32 %hb, i32 %hp", "  %c1 = add i32 %cur, 7", "  %p = and i32 %c1, -8", "  %q = add i32 %p, %total", "  %wrap = icmp ult i32 %q, %p", "  br i1 %wrap, label %oom, label %chk", "chk:", "  %pg = call i32 @llvm.wasm.memory.size.i32(i32 0)", "  %lim = mul i32 %pg, 65536", "  %over = icmp ugt i32 %q, %lim", "  br i1 %over, label %grow, label %ok", "grow:", "  %diff = sub i32 %q, %lim", "  %d1 = add i32 %diff, 65535", "  %need = lshr i32 %d1, 16", "  %r = call i32 @llvm.wasm.memory.grow.i32(i32 0, i32 %need)", "  %fail = icmp slt i32 %r, 0", "  br i1 %fail, label %oom, label %ok", "ok:", "  store i32 %q, ptr @heap_ptr", "  ret i32 %p", "oom:", "  ret i32 0", "}"],
        malloc: ["define ptr @malloc(i32 %n) {", "entry:", "  %cap = alloca i32", "  %cls = alloca i32", "  %small = icmp ult i32 %n, 16", "  %m = select i1 %small, i32 16, i32 %n", "  store i32 16, ptr %cap", "  store i32 0, ptr %cls", "  br label %loop", "loop:", "  %cv = load i32, ptr %cap", "  %lt = icmp ult i32 %cv, %m", "  br i1 %lt, label %grow, label %found", "grow:", "  %kv = load i32, ptr %cls", "  %toobig = icmp uge i32 %kv, 27", "  br i1 %toobig, label %fail, label %dbl", "dbl:", "  %c2 = shl i32 %cv, 1", "  store i32 %c2, ptr %cap", "  %k2 = add i32 %kv, 1", "  store i32 %k2, ptr %cls", "  br label %loop", "found:", "  %capv = load i32, ptr %cap", "  %clsv = load i32, ptr %cls", "  %lp = getelementptr [32 x i32], ptr @__free_lists, i32 0, i32 %clsv", "  %head = load i32, ptr %lp", "  %has = icmp ne i32 %head, 0", "  br i1 %has, label %reuse, label %fresh", "reuse:", "  %hptr = inttoptr i32 %head to ptr", "  %next = load i32, ptr %hptr", "  store i32 %next, ptr %lp", "  ret ptr %hptr", "fresh:", "  %total = add i32 %capv, 8", "  %raw = call i32 @__bump(i32 %total)", "  %bad = icmp eq i32 %raw, 0", "  br i1 %bad, label %fail, label %okk", "okk:", "  %hdr = inttoptr i32 %raw to ptr", "  store i32 %clsv, ptr %hdr", "  %pay = add i32 %raw, 8", "  %pp = inttoptr i32 %pay to ptr", "  ret ptr %pp", "fail:", "  ret ptr null", "}"],
        free: ["define void @free(ptr %p) {", "entry:", "  %isnull = icmp eq ptr %p, null", "  br i1 %isnull, label %done, label %do", "do:", "  %pi = ptrtoint ptr %p to i32", "  %hi = sub i32 %pi, 8", "  %hp = inttoptr i32 %hi to ptr", "  %cls = load i32, ptr %hp", "  %lp = getelementptr [32 x i32], ptr @__free_lists, i32 0, i32 %cls", "  %head = load i32, ptr %lp", "  store i32 %head, ptr %p", "  store i32 %pi, ptr %lp", "  br label %done", "done:", "  ret void", "}"],
        calloc: ["define ptr @calloc(i32 %a, i32 %b) {", "entry:", "  %n = mul i32 %a, %b", "  %r = call ptr @malloc(i32 %n)", "  %isnull = icmp eq ptr %r, null", "  br i1 %isnull, label %done, label %zero", "zero:", "  %z = call ptr @memset(ptr %r, i32 0, i32 %n)", "  br label %done", "done:", "  ret ptr %r", "}"],
        realloc: ["define ptr @realloc(ptr %p, i32 %n) {", "entry:", "  %isnull = icmp eq ptr %p, null", "  br i1 %isnull, label %alloc, label %have", "alloc:", "  %a = call ptr @malloc(i32 %n)", "  ret ptr %a", "have:", "  %pi = ptrtoint ptr %p to i32", "  %hi = sub i32 %pi, 8", "  %hp = inttoptr i32 %hi to ptr", "  %cls = load i32, ptr %hp", "  %cap = shl i32 16, %cls", "  %fits = icmp ule i32 %n, %cap", "  br i1 %fits, label %same, label %move", "same:", "  ret ptr %p", "move:", "  %np = call ptr @malloc(i32 %n)", "  %isn = icmp eq ptr %np, null", "  br i1 %isn, label %fail, label %copy", "copy:", "  %r = call ptr @memcpy(ptr %np, ptr %p, i32 %cap)", "  call void @free(ptr %p)", "  ret ptr %np", "fail:", "  ret ptr null", "}"],
        strlen: ['define i32 @strlen(ptr %s) {', 'entry:', '  %i = alloca i32', '  store i32 0, ptr %i', '  br label %loop', 'loop:', '  %iv = load i32, ptr %i', '  %cp = getelementptr i8, ptr %s, i32 %iv', '  %c = load i8, ptr %cp', '  %z = icmp eq i8 %c, 0', '  br i1 %z, label %done, label %next', 'next:', '  %n = add i32 %iv, 1', '  store i32 %n, ptr %i', '  br label %loop', 'done:', '  ret i32 %iv', '}'],
        puts: ['define i32 @puts(ptr %s) {', 'entry:', '  %n = call i32 @strlen(ptr %s)', '  call void @__libc_write(ptr %s, i32 %n)', '  call void @__libc_write(ptr @__libc_nl, i32 1)', '  ret i32 1', '}'],
        putchar: ['define i32 @putchar(i32 %c) {', 'entry:', '  %b = trunc i32 %c to i8', '  store i8 %b, ptr @__libc_ch', '  call void @__libc_write(ptr @__libc_ch, i32 1)', '  ret i32 %c', '}'],
        memcpy: ['define ptr @memcpy(ptr %d, ptr %s, i32 %n) {', 'entry:', '  %i = alloca i32', '  store i32 0, ptr %i', '  br label %loop', 'loop:', '  %iv = load i32, ptr %i', '  %c = icmp slt i32 %iv, %n', '  br i1 %c, label %body, label %done', 'body:', '  %sp = getelementptr i8, ptr %s, i32 %iv', '  %v = load i8, ptr %sp', '  %dp = getelementptr i8, ptr %d, i32 %iv', '  store i8 %v, ptr %dp', '  %n2 = add i32 %iv, 1', '  store i32 %n2, ptr %i', '  br label %loop', 'done:', '  ret ptr %d', '}'],
        memset: ['define ptr @memset(ptr %d, i32 %v, i32 %n) {', 'entry:', '  %b = trunc i32 %v to i8', '  %i = alloca i32', '  store i32 0, ptr %i', '  br label %loop', 'loop:', '  %iv = load i32, ptr %i', '  %c = icmp slt i32 %iv, %n', '  br i1 %c, label %body, label %done', 'body:', '  %dp = getelementptr i8, ptr %d, i32 %iv', '  store i8 %b, ptr %dp', '  %n2 = add i32 %iv, 1', '  store i32 %n2, ptr %i', '  br label %loop', 'done:', '  ret ptr %d', '}'],
        memcmp: ['define i32 @memcmp(ptr %a, ptr %b, i32 %n) {', 'entry:', '  %i = alloca i32', '  store i32 0, ptr %i', '  br label %loop', 'loop:', '  %iv = load i32, ptr %i', '  %c = icmp slt i32 %iv, %n', '  br i1 %c, label %body, label %same', 'body:', '  %ap = getelementptr i8, ptr %a, i32 %iv', '  %bp = getelementptr i8, ptr %b, i32 %iv', '  %x = load i8, ptr %ap', '  %y = load i8, ptr %bp', '  %xi = zext i8 %x to i32', '  %yi = zext i8 %y to i32', '  %ne = icmp ne i32 %xi, %yi', '  br i1 %ne, label %diff, label %next', 'next:', '  %n2 = add i32 %iv, 1', '  store i32 %n2, ptr %i', '  br label %loop', 'diff:', '  %d = sub i32 %xi, %yi', '  ret i32 %d', 'same:', '  ret i32 0', '}'],
        strcmp: ['define i32 @strcmp(ptr %a, ptr %b) {', 'entry:', '  %i = alloca i32', '  store i32 0, ptr %i', '  br label %loop', 'loop:', '  %iv = load i32, ptr %i', '  %ap = getelementptr i8, ptr %a, i32 %iv', '  %bp = getelementptr i8, ptr %b, i32 %iv', '  %x = load i8, ptr %ap', '  %y = load i8, ptr %bp', '  %xi = zext i8 %x to i32', '  %yi = zext i8 %y to i32', '  %ne = icmp ne i32 %xi, %yi', '  br i1 %ne, label %diff, label %chk', 'chk:', '  %z = icmp eq i32 %xi, 0', '  br i1 %z, label %same, label %next', 'next:', '  %n2 = add i32 %iv, 1', '  store i32 %n2, ptr %i', '  br label %loop', 'diff:', '  %d = sub i32 %xi, %yi', '  ret i32 %d', 'same:', '  ret i32 0', '}'],
        abs: ['define i32 @abs(i32 %x) {', 'entry:', '  %n = icmp slt i32 %x, 0', '  %m = sub i32 0, %x', '  %r = select i1 %n, i32 %m, i32 %x', '  ret i32 %r', '}'],
        exit: ['define void @exit(i32 %c) {', 'entry:', '  call void @proc_exit(i32 %c)', '  unreachable', '}'],
        getchar: ['define i32 @getchar() {', 'entry:', '  %sc = ptrtoint ptr @scratch to i32', '  %iovp = getelementptr i32, ptr @scratch, i32 4', '  %buf = getelementptr i8, ptr @scratch, i32 40', '  %bi = ptrtoint ptr %buf to i32', '  store i32 %bi, ptr %iovp', '  %lp = getelementptr i32, ptr @scratch, i32 5', '  store i32 1, ptr %lp', '  %iov = ptrtoint ptr %iovp to i32', '  %nrp = getelementptr i32, ptr @scratch, i32 6', '  %nri = ptrtoint ptr %nrp to i32', '  %r = call i32 @fd_read(i32 0, i32 %iov, i32 1, i32 %nri)', '  %n = load i32, ptr %nrp', '  %z = icmp eq i32 %n, 0', '  br i1 %z, label %eof, label %ok', 'ok:', '  %c = load i8, ptr %buf', '  %ci = zext i8 %c to i32', '  ret i32 %ci', 'eof:', '  ret i32 -1', '}']
    };
    const LIBC_NAMES = Object.keys(LIBC_IR).filter((k) => k !== '__w' && k !== '__alloc');
    // 把「宣告了、但沒有定義」的 libc 函式補上實作（直接改 mod）。回傳補了哪些
    function linkLibc(mod) {
        const defined = new Set(mod.funcs.map((f) => f.name)); const want = new Set();
        const add = (n) => { if (want.has(n) || defined.has(n) || !LIBC_IR[n]) return; want.add(n); (LIBC_DEPS[n] || []).forEach(add); };
        for (const d of mod.declares) if (LIBC_NAMES.includes(d.name) && !defined.has(d.name)) add(d.name);
        if (!want.size) return [];
        const parts = ['@scratch = global [48 x i8] zeroinitializer'].filter((l) => !mod.globals.some((g) => g.name === l.slice(1, l.indexOf(' '))));
        const needExit = want.has('exit'), needRead = want.has('getchar');
        const have = new Set(mod.declares.map((d) => d.name));
        if (!have.has('fd_write')) parts.push('declare i32 @fd_write(i32, i32, i32, i32)'); if (needExit && !have.has('proc_exit')) parts.push('declare void @proc_exit(i32)'); if (needRead && !have.has('fd_read')) parts.push('declare i32 @fd_read(i32, i32, i32, i32)');
        for (const n of want) parts.push(LIBC_IR[n].join(String.fromCharCode(10)));
        const extra = parse(parts.join(String.fromCharCode(10)));
        if (extra.errors.length) throw new Error('內建 libc 解析失敗：' + extra.errors[0].msg);
        mod.declares = mod.declares.filter((d) => !want.has(d.name)); const names = new Set(mod.declares.map((d) => d.name));
        for (const d of extra.mod.declares) if (!names.has(d.name)) mod.declares.push(d);
        for (const g of extra.mod.globals) if (!mod.globals.some((x) => x.name === g.name)) mod.globals.push(g);
        for (const [k, v] of extra.mod.types) if (!mod.types.has(k)) mod.types.set(k, v);
        for (const f of extra.mod.funcs) if (!mod.funcs.some((x) => x.name === f.name)) mod.funcs.push(f);
        return [...want].filter((n) => n !== '__w' && n !== '__alloc');
    }
    // =====================================================================
    // 物件檔與連結器：llc -c 把每個 .ll 編成 .o（解析＋檢查後的模組，存成文字；放在沙盒檔案系統就會跟著持久化，放 /mnt 就是存進 File Access Point），
    // llink 把好幾個 .o（或 .ll）合併成一個程式——解決符號、檢查重複與型別衝突，再連結 libc、編成 wasm。分開編譯、只重連結。
    // =====================================================================
    function serializeModule(mod) {
        return JSON.stringify({ fmt: 'fa-llvm-obj', v: 1, mod }, (k, v) => (k === 'regTypes' ? undefined : typeof v === 'bigint' ? { $big: v.toString() } : v instanceof Map ? { $map: Array.from(v.entries()) } : v));
    }
    function deserializeModule(text) {
        let o; try { o = JSON.parse(text, (k, v) => (v && typeof v === 'object' && v.$big !== undefined ? BigInt(v.$big) : v && typeof v === 'object' && Array.isArray(v.$map) ? new Map(v.$map) : v)); } catch (e) { throw new Error('不是 LLVM 物件檔（.o）：' + e.message); }
        if (!o || o.fmt !== 'fa-llvm-obj' || !o.mod) throw new Error('不是 LLVM 物件檔（.o）'); return o.mod;
    }
    const isObjectText = (t) => String(t).slice(0, 40).indexOf('"fmt":"fa-llvm-obj"') >= 0;
    // 解析並檢查一份 .ll，回傳物件檔文字（allowUndefined：允許外部符號）
    function compileObject(text) {
        const p = parse(text); if (p.errors.length) return { errors: p.errors, stage: 'parse' };
        const errs = check(p.mod, { partial: true }); if (errs.length) return { errors: errs, stage: 'check' };
        return { obj: serializeModule(p.mod), mod: p.mod, stage: 'ok', undefinedSymbols: p.mod.declares.filter((d) => !WASI[d.name] && !INTRINSICS[d.name] && !LIBC_NAMES.includes(d.name) && !p.mod.funcs.some((f) => f.name === d.name)).map((d) => d.name) };
    }
    function linkModules(mods) {
        const out = { types: new Map(), globals: [], funcs: [], declares: [], triple: '' }; const errors = []; const E = (line, msg) => errors.push({ line, msg });
        const fdef = new Map(), gdef = new Map();
        for (const m of mods) {
            if (m.triple && !out.triple) out.triple = m.triple;
            for (const [k, v] of m.types) { const have = out.types.get(k); if (have && typeStr(have) !== typeStr(v)) E(0, '型別 %' + k + ' 在不同檔案裡的定義不一樣'); else out.types.set(k, v); }
            for (const g of m.globals) { const have = gdef.get(g.name); if (!have) { gdef.set(g.name, g); out.globals.push(g); } else if (have.external && !g.external) { out.globals[out.globals.indexOf(have)] = g; gdef.set(g.name, g); } else if (!have.external && !g.external) E(g.line, '全域 @' + g.name + ' 在多個檔案裡都有定義'); else if (!sameType(have.ty, g.ty)) E(g.line, '全域 @' + g.name + ' 在不同檔案裡的型別不一樣'); }
            for (const f of m.funcs) { if (fdef.has(f.name)) E(f.line, '函式 @' + f.name + ' 在多個檔案裡都有定義'); else { fdef.set(f.name, f); out.funcs.push(f); } }
        }
        const seen = new Set();
        for (const m of mods) for (const d of m.declares) {
            const f = fdef.get(d.name);
            if (f) { if (!sameType(f.ret, d.ret) || f.params.length !== d.params.length || f.params.some((p, i) => !sameType(p.ty, d.params[i]))) E(d.line, '@' + d.name + ' 的宣告跟定義的簽名不一致'); continue; }
            if (!seen.has(d.name)) { seen.add(d.name); out.declares.push(d); }
        }
        for (const d of out.declares) if (!WASI[d.name] && !INTRINSICS[d.name] && !LIBC_NAMES.includes(d.name)) E(d.line, '未定義的符號 @' + d.name + '（沒有任何檔案定義它，也不是內建的 libc 或 WASI 函式）');
        for (const g of out.globals) if (g.external && g.name !== '__heap_base') E(g.line, '全域 @' + g.name + ' 宣告成 external，但沒有任何檔案定義它');
        return { mod: out, errors };
    }
    // 輸入是「文字」陣列（.ll 或 .o 混合都行）。回傳 { mod } 或 { errors, stage }
    function loadAndLink(texts) {
        const mods = []; for (let i = 0; i < texts.length; i++) { const t = texts[i].text; const name = texts[i].name || ('#' + (i + 1)); if (isObjectText(t)) { try { mods.push(deserializeModule(t)); } catch (e) { return { errors: [{ line: 0, msg: name + '：' + e.message }], stage: 'load' }; } } else { const p = parse(t); if (p.errors.length) return { errors: p.errors.map((e) => ({ line: e.line, msg: (texts.length > 1 ? name + ':' : '') + e.msg })), stage: 'parse' }; mods.push(p.mod); } }
        const l = linkModules(mods); if (l.errors.length) return { errors: l.errors, stage: 'link' }; return { mod: l.mod, stage: 'ok' };
    }
    // 連結好的模組 → wasm（連結 libc、檢查、輸出）
    function compileModule(mod, opts) {
        opts = opts || {}; let linked = []; try { linked = linkLibc(mod); } catch (e) { return { errors: [{ line: 0, msg: e.message }], stage: 'link' }; }
        const errs = check(mod); if (errs.length) return { errors: errs, stage: 'check' };
        try { return { wasm: toWasm(mod, { fuel: opts.fuel, entry: opts.entry }), linked, stage: 'ok' }; } catch (e) { return { errors: [{ line: 0, msg: String((e && e.message) || e) }], stage: 'wasm' }; }
    }
    // 多個檔案一次：連結＋編譯。texts：[{ name, text }]
    function compileMany(texts, opts) { const l = loadAndLink(texts); if (!l.mod) return l; return compileModule(l.mod, opts); }

    // 給終端機指令用：IR 文字（或 wasm 位元組）→ 連結 libc → 檢查 → wasm。回傳 { wasm } 或 { errors }
    function compileIr(text, opts) {
        opts = opts || {}; const p = parse(text); if (p.errors.length) return { errors: p.errors, stage: 'parse' };
        let linked = []; try { linked = linkLibc(p.mod); } catch (e) { return { errors: [{ line: 0, msg: e.message }], stage: 'link' }; }
        const errs = check(p.mod); if (errs.length) return { errors: errs, stage: 'check' };
        try { return { wasm: toWasm(p.mod, { fuel: opts.fuel, entry: opts.entry }), linked, stage: 'ok' }; } catch (e) { return { errors: [{ line: 0, msg: String((e && e.message) || e) }], stage: 'wasm' }; }
    }

    // =====================================================================
    // UML → IR
    // =====================================================================
    function llType(m, t, warn) {
        if (!t) return 'void'; const b = t.base;
        if (b === 'void') return 'void'; if (b === 'int' || b === 'bool') return 'i32'; if (b === 'float' || b === 'decimal') return 'double';
        if (b === 'str' || b === 'date' || b === 'datetime' || b === 'bytes' || b === 'any') return 'ptr';
        const c = m.classes.find((x) => x.name === b); if (c) { if (c.kind === 'enum') return 'i32'; return 'ptr'; }
        if (warn) warn('型別 ' + U.typeToString(t) + ' 第一版用 ptr（空指標）表示，沒有容器支援'); return 'ptr';
    }
    const zeroOf = (ty) => (ty === 'void' ? '' : ty === 'double' ? '0.0' : ty === 'i32' ? '0' : 'null');
    function escBytes(s) { const bytes = Array.from(new TextEncoder().encode(s)); return bytes.map((b) => (b >= 32 && b < 127 && b !== 34 && b !== 92 ? String.fromCharCode(b) : String.fromCharCode(92) + b.toString(16).toUpperCase().padStart(2, '0'))).join(''); }
    const NL = String.fromCharCode(10);
    // 回傳 { ir, expected, warnings }。IR 用「不透明指標」（ptr）寫法，LLVM 15 以後的 clang／llc 都吃得進去
    function fromModel(model, opts) {
        opts = opts || {}; const m = JSON.parse(JSON.stringify(model)); U.ensureOps(m); const warnings = []; const warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };
        const L = []; const strs = new Map(); let sid = 0;
        const strRef = (s) => { let e = strs.get(s); if (!e) { e = { id: sid++, len: new TextEncoder().encode(s).length + 1 }; strs.set(s, e); } return '@.s' + e.id; };
        const classes = m.classes.filter((c) => c.kind === 'class' || c.kind === 'abstract');
        const parentOf = (c) => { const r = m.relations.find((x) => x.kind === 'inherit' && x.from === c.name); return r ? m.classes.find((x) => x.name === r.to) : null; };
        const attrsOf = (c) => { const seen = new Set(); const out = []; const chain = []; for (let k = c, n = 0; k && n < 20; k = parentOf(k), n++) chain.unshift(k); for (const k of chain) for (const a of k.attrs) if (!seen.has(a.name)) { seen.add(a.name); out.push(a); } return out; };
        if (m.relations.some((r) => r.kind === 'inherit')) warn('繼承：只把父類別的欄位放進子類別，沒有虛擬呼叫');
        const body = [];
        for (const c of classes) { const fields = attrsOf(c).map((a) => llType(m, a.type, warn)); body.push('%' + c.name + ' = type { ' + (fields.length ? fields.join(', ') : 'i8') + ' }'); }
        const idField = (c) => attrsOf(c).findIndex((a) => a.name === 'id' && a.type.base === 'int');
        const funcs = []; const fnName = (c, o) => c.name + '_' + o.name;
        for (const c of classes) for (const o of c.ops) {
            const ret = llType(m, o.returns, warn); const ps = o.params.map((p) => llType(m, p.type, warn)); const self = o.static ? [] : ['ptr %self']; const params = self.concat(ps.map((t, k) => t + ' %p' + k));
            const f = ['define ' + ret + ' @' + fnName(c, o) + '(' + params.join(', ') + ') {', 'entry:']; const idx = idField(c);
            if (!o.static && idx >= 0) { f.push('  %idp = getelementptr %' + c.name + ', ptr %self, i32 0, i32 ' + idx, '  %idv = load i32, ptr %idp', '  call void @rt_print(ptr ' + strRef(c.name + '#') + ')', '  call void @rt_print_int(i32 %idv)', '  call void @rt_print(ptr ' + strRef('.' + o.name + NL) + ')'); }
            else f.push('  call void @rt_print(ptr ' + strRef(c.name + '.' + o.name + NL) + ')');
            f.push(ret === 'void' ? '  ret void' : '  ret ' + ret + ' ' + zeroOf(ret), '}'); funcs.push(f.join(NL));
        }
        const expected = []; const ucs = [];
        m.usecases.forEach((u, ui) => {
            const used = []; for (const s of u.steps) { const c = classes.find((x) => x.name === s.to); if (c && !used.includes(c)) used.push(c); }
            const f = ['define void @uc_' + ui + '() {', 'entry:', '  call void @rt_print(ptr ' + strRef('== ' + u.name + ' ==' + NL) + ')']; expected.push('== ' + u.name + ' ==');
            used.forEach((c, k) => {
                const sz = Math.max(1, structSize(m, c, attrsOf, warn)); f.push('  %o' + k + ' = call ptr @malloc(i32 ' + sz + ')');
                attrsOf(c).forEach((a, ai) => { const ty = llType(m, a.type); const v = a.name === 'id' && ty === 'i32' ? '1' : (ty === 'ptr' && a.type.base === 'str' ? strRef(a.name) : null); if (v !== null) f.push('  %f' + k + '_' + ai + ' = getelementptr %' + c.name + ', ptr %o' + k + ', i32 0, i32 ' + ai, '  store ' + ty + ' ' + v + ', ptr %f' + k + '_' + ai); });
            });
            u.steps.forEach((s, si) => {
                const c = classes.find((x) => x.name === s.to); if (!c) return; const o = c.ops.find((x) => x.name === s.msg); if (!o) return; const k = used.indexOf(c);
                const ps = o.params.map((p) => llType(m, p.type)); const args = (o.static ? [] : ['ptr %o' + k]).concat(ps.map((t) => t + ' ' + zeroOf(t))); const ret = llType(m, o.returns);
                f.push('  ' + (ret === 'void' ? '' : '%r' + si + ' = ') + 'call ' + ret + ' @' + fnName(c, o) + '(' + args.join(', ') + ')');
                expected.push(!o.static && idField(c) >= 0 ? c.name + '#1.' + o.name : c.name + '.' + o.name);
            });
            f.push('  ret void', '}'); ucs.push(f.join(NL));
        });
        const start = ['define void @_start() {', 'entry:'].concat(m.usecases.map((_, i) => '  call void @uc_' + i + '()'), ['  ret void', '}']).join(NL);
        L.push('; 由 UML 設計產生（模型 ' + (m.name || 'Model') + '）。目標：wasm32-wasi', '; 用 clang 編譯：clang --target=wasm32-wasi -nostdlib -Wl,--no-entry -Wl,--export=_start model.ll -o model.wasm', '; （也可以直接用附的 model.wasm，或用 node run.js 執行）', 'target datalayout = "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-n32:64-S128-ni:1:10:20"', 'target triple = "wasm32-unknown-wasi"', '',
            'declare i32 @fd_write(i32, i32, i32, i32) #0', 'attributes #0 = { "wasm-import-module"="wasi_snapshot_preview1" "wasm-import-name"="fd_write" }', '', '@scratch = global [48 x i8] zeroinitializer', '');
        L.push(LIBC_IR.__alloc.concat(LIBC_IR.malloc).join(NL), '', RUNTIME_IR, '');
        if (body.length) L.push(body.join(NL), '');
        const strDefs = [...strs.entries()].map(([s, e]) => '@.s' + e.id + ' = private constant [' + e.len + ' x i8] c"' + escBytes(s) + String.fromCharCode(92) + '00"'); if (strDefs.length) L.push(strDefs.join(NL), '');
        L.push(funcs.concat(ucs, [start]).join(NL + NL), '');
        return { ir: L.join(NL), expected: expected.join(NL) + (expected.length ? NL : ''), warnings };
    }
    function structSize(m, c, attrsOf, warn) { let off = 0, al = 1; for (const a of attrsOf(c)) { const t = llType(m, a.type, warn); const sz = t === 'double' ? 8 : 4; off = Math.ceil(off / sz) * sz + sz; al = Math.max(al, sz); } return Math.ceil(off / al) * al || 1; }
    // 固定的 runtime：記憶體配置、字串輸出、整數輸出（名字都加 rt_，避免跟 libc 撞名）
    const RUNTIME_IR = [
        'define i32 @rt_strlen(ptr %s) {', 'entry:', '  %i = alloca i32', '  store i32 0, ptr %i', '  br label %loop', 'loop:', '  %iv = load i32, ptr %i', '  %cp = getelementptr i8, ptr %s, i32 %iv', '  %c = load i8, ptr %cp', '  %z = icmp eq i8 %c, 0', '  br i1 %z, label %done, label %next', 'next:', '  %n = add i32 %iv, 1', '  store i32 %n, ptr %i', '  br label %loop', 'done:', '  ret i32 %iv', '}', '',
        'define void @rt_print(ptr %s) {', 'entry:', '  %len = call i32 @rt_strlen(ptr %s)', '  %sp = ptrtoint ptr %s to i32', '  store i32 %sp, ptr @scratch', '  %lenp = getelementptr i32, ptr @scratch, i32 1', '  store i32 %len, ptr %lenp', '  %nw = getelementptr i32, ptr @scratch, i32 4', '  %iovi = ptrtoint ptr @scratch to i32', '  %nwi = ptrtoint ptr %nw to i32', '  %r = call i32 @fd_write(i32 1, i32 %iovi, i32 1, i32 %nwi)', '  ret void', '}', '',
        'define void @rt_print_int(i32 %v) {', 'entry:', '  %buf = alloca [16 x i8]', '  %pos = alloca i32', '  %n = alloca i32', '  store i32 15, ptr %pos', '  store i32 %v, ptr %n', '  %b0 = getelementptr [16 x i8], ptr %buf, i32 0, i32 15', '  store i8 0, ptr %b0', '  %neg = icmp slt i32 %v, 0', '  br i1 %neg, label %negate, label %digits', 'negate:', '  %nv = sub i32 0, %v', '  store i32 %nv, ptr %n', '  br label %digits', 'digits:', '  %cur = load i32, ptr %n', '  %d = srem i32 %cur, 10', '  %q = sdiv i32 %cur, 10', '  store i32 %q, ptr %n', '  %p = load i32, ptr %pos', '  %p1 = sub i32 %p, 1', '  store i32 %p1, ptr %pos', '  %dc = trunc i32 %d to i8', '  %ch = add i8 %dc, 48', '  %cp = getelementptr [16 x i8], ptr %buf, i32 0, i32 %p1', '  store i8 %ch, ptr %cp', '  %more = icmp ne i32 %q, 0', '  br i1 %more, label %digits, label %sign', 'sign:', '  br i1 %neg, label %minus, label %out', 'minus:', '  %p2 = load i32, ptr %pos', '  %p3 = sub i32 %p2, 1', '  store i32 %p3, ptr %pos', '  %mp = getelementptr [16 x i8], ptr %buf, i32 0, i32 %p3', '  store i8 45, ptr %mp', '  br label %out', 'out:', '  %pf = load i32, ptr %pos', '  %sp = getelementptr [16 x i8], ptr %buf, i32 0, i32 %pf', '  call void @rt_print(ptr %sp)', '  ret void', '}'
    ].join(NL);

    // 一條龍：UML → IR → 檢查 → wasm → 執行 → 跟預期的軌跡比對
    async function build(model, opts) {
        opts = opts || {}; const g = fromModel(model, opts); const p = parse(g.ir); if (p.errors.length) return { ok: false, stage: 'parse', errors: p.errors, ir: g.ir, warnings: g.warnings };
        const errs = check(p.mod); if (errs.length) return { ok: false, stage: 'check', errors: errs, ir: g.ir, warnings: g.warnings };
        let wasm; try { wasm = toWasm(p.mod); } catch (e) { return { ok: false, stage: 'wasm', errors: [{ line: 0, msg: String((e && e.message) || e) }], ir: g.ir, warnings: g.warnings }; }
        if (opts.run === false) return { ok: true, ir: g.ir, wasm, warnings: g.warnings, expected: g.expected };
        const r = await run(wasm); const match = !r.trap && r.exitCode === 0 && r.stdout === g.expected;
        return { ok: match, stage: match ? 'done' : 'verify', ir: g.ir, wasm, warnings: g.warnings, expected: g.expected, stdout: r.stdout, exitCode: r.exitCode, trap: r.trap, bytes: wasm.length };
    }

    return { parse, check, toWasm, run, runSync, serializeModule, deserializeModule, isObjectText, compileObject, linkModules, loadAndLink, compileModule, compileMany, makeWasi, linkLibc, compileIr, LIBC_NAMES, WASI_NAMES: Object.keys(WASI), fromModel, build, parseType, typeStr, layout, DATA_BASE, STACK_TOP, RUNTIME_IR };
});
