/* 虛擬機（VM）程式 → 結構化（DESIGN.matrix-fallback.md §4.4／§11.6、DESIGN.matrix-algorithms.md §14.8）。
 * 以前 vmToCnl 只能「一條指令一行」；這裡把標籤＋跳轉還原成 while／if／else／break／continue，再往下產生：
 *   ① 結構化中文受控自然語言（有縮排、有說明註解）   vmToStructuredCnl(prog, opts)
 *   ② Python 原始碼（能整個還原成結構時用 while／if；有還原不了的跳轉時改用「狀態分派」形式，一樣正確但比較不好讀）   vmToPython(prog, opts)
 *   ③ 有意義的暫存器／標籤名稱與註解   renameVM(prog)、commentVM(prog)
 * Python 版的語意要和 matrix_vm_core.run 一致（測試用真 python 對照 VM 在隨機輸入上的輸出）。
 * 暫存器在 VM 裡一律是矩陣（純量＝1×1）；這裡推論哪些暫存器只當純量用，純量直接用 Python 整數，矩陣用 list of list。
 * 純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMatrixStructure = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const JUMPS = new Set(['jlt', 'jeq', 'jmp', 'jqe']);
    const isNum = (x) => typeof x === 'number';
    // ---------- 結構還原 ----------
    // 節點：{t:'op',i}｛t:'read',dst｝｛t:'if',cond,then,else｝｛t:'while',cond,body｝｛t:'break'｝｛t:'continue'｝｛t:'goto',to｝｛t:'halt',src｝｛t:'label',name｝
    // cond：{op:'lt'|'eq'|'noinput'|'qempty', a, b, not}
    const negate = (c) => Object.assign({}, c, { not: !c.not });
    function structurize(prog) {
        const c = prog.code, pos = new Map(); c.forEach((i, k) => { if (i.op === 'label') pos.set(i.name, k); });
        const tgt = (i) => (i.op === 'read' ? i.eof : i.to);
        const condOf = (i) => (i.op === 'jlt' ? { op: 'lt', a: i.a, b: i.b, not: false } : i.op === 'jeq' ? { op: 'eq', a: i.a, b: i.b, not: false } : i.op === 'jqe' ? { op: 'qempty', not: false } : { op: 'noinput', not: false });
        const isJump = (i) => JUMPS.has(i.op) || (i.op === 'read' && i.eof);
        let hasGoto = false; const gotos = new Set();
        const jumpsTo = new Map(); c.forEach((i, k) => { if (isJump(i)) { const t = tgt(i); if (!jumpsTo.has(t)) jumpsTo.set(t, []); jumpsTo.get(t).push(k); } });
        // [lo,hi) 裡的標籤，是否被這個區間外（扣掉 allowJump 那條）的跳轉打進來
        const entered = (lo, hi, allowJump, allowLabel) => { for (let k = lo; k < hi; k++) if (c[k].op === 'label' && c[k].name !== allowLabel) for (const j of jumpsTo.get(c[k].name) || []) if ((j < lo || j >= hi) && j !== allowJump) return true; return false; };
        const labelsAt = (k) => { const s = new Set(); while (k < c.length && c[k].op === 'label') s.add(c[k++].name); return s; };
        // 目標標籤後面若是「幾個簡單敘述接 halt」，就地展開（例如 bad: halt 0）
        const tail = (T) => { let k = pos.get(T) + 1; const out = []; while (k < c.length && c[k].op === 'label') k++; for (let n = 0; n < 4 && k < c.length; n++, k++) { const i = c[k]; if (i.op === 'halt') { out.push({ t: 'halt', src: i.src }); return out; } if (isJump(i) || i.op === 'label') return null; out.push(simple(i)); } return null; };
        const simple = (i) => (i.op === 'halt' ? { t: 'halt', src: i.src } : i.op === 'read' ? { t: 'read', dst: i.dst } : { t: 'op', i });
        const jumpTo = (T, ctx) => {
            if (ctx.head === T) return [{ t: 'continue' }]; if (ctx.exits && ctx.exits.has(T)) return [{ t: 'break' }];
            const tl = tail(T); if (tl) return tl; hasGoto = true; gotos.add(T); return [{ t: 'goto', to: T }];
        };
        function build(lo, hi, ctx) {
            const out = []; let i = lo;
            while (i < hi) {
                const ins = c[i];
                if (ins.op === 'label') {
                    const backs = (jumpsTo.get(ins.name) || []).filter((j) => j > i && j < hi);
                    if (backs.length && ctx.head !== ins.name) {
                        const q = Math.max(...backs);
                        if (c[q].op === 'jmp' && !entered(i + 1, q + 1, -1, null)) {
                            const exits = labelsAt(q + 1); const body = build(i + 1, q, { head: ins.name, exits });
                            let cond = null; if (body.length && body[0].t === 'if' && !body[0].else && body[0].then.length === 1 && body[0].then[0].t === 'break') { cond = negate(body[0].cond); body.shift(); }
                            while (body.length && body[body.length - 1].t === 'continue') body.pop();
                            out.push({ t: 'while', cond, body, head: ins.name }); i = q + 1; continue;
                        }
                    }
                    out.push({ t: 'label', name: ins.name }); i++; continue;
                }
                if (ins.op === 'jmp') {
                    const T = ins.to; const nxt = labelsAt(i + 1); if (nxt.has(T)) { i++; continue; } out.push(...jumpTo(T, ctx)); i++; continue;
                }
                if (isJump(ins)) {
                    const T = tgt(ins), cond = condOf(ins); const isRead = ins.op === 'read';
                    const readNode = isRead ? [{ t: 'read', dst: ins.dst }] : [];
                    if (ctx.head === T || (ctx.exits && ctx.exits.has(T))) { out.push({ t: 'if', cond, then: jumpTo(T, ctx), else: null }, ...readNode); i++; continue; }
                    const pt = pos.get(T);
                    if (pt > i && pt <= hi) {
                        const lastIdx = pt - 1; let last = lastIdx; while (last > i && c[last].op === 'label') last--; // 跳過緊貼在目標前的其他標籤
                        const R_last = c[last];
                        const E = R_last.op === 'jmp' && last > i ? R_last.to : null; const pe = E != null ? pos.get(E) : -1;
                        if (E != null && !(ctx.head === E || (ctx.exits && ctx.exits.has(E))) && pe > pt && pe <= hi && !entered(i + 1, pe, i, T) ) {
                            const thenB = (isRead ? readNode : []).concat(build(i + 1, last, ctx)); const elseB = build(pt + 1, pe, ctx);
                            out.push({ t: 'if', cond: negate(cond), then: isRead ? thenB : thenB, else: elseB.length ? elseB : null }); i = pe; continue;
                        }
                        if (!entered(i + 1, pt, i, T)) { const thenB = (isRead ? readNode : []).concat(build(i + 1, pt, ctx)); out.push({ t: 'if', cond: negate(cond), then: thenB, else: null }); i = pt; continue; }
                    }
                    out.push({ t: 'if', cond, then: jumpTo(T, ctx), else: null }, ...readNode); i++; continue;
                }
                out.push(simple(ins)); i++;
            }
            return out;
        }
        const tree = build(0, c.length, { head: null, exits: null });
        // 清掉沒有被 goto 用到的標籤
        const prune = (ns) => { const r = []; for (const n of ns) { if (n.t === 'label') { if (gotos.has(n.name)) r.push(n); continue; } if (n.t === 'if') { n.then = prune(n.then); if (n.else) n.else = prune(n.else); } if (n.t === 'while') n.body = prune(n.body); r.push(n); } return r; };
        return { tree: prune(tree), hasGoto };
    }
    // ---------- 名稱與註解 ----------
    const PY_RESERVED = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield print input len range min max sum list int str map open sys stack queue tok ip st main cp zeros ident mmul madd mpow INF MOD ZERO ONE'.split(' '));
    const GENERIC = /^([A-Za-z]{1,2}\d*|[sSLlrRtT]\d+|tmp\d*|lbl\d*|label\d*)$/;
    // 給暫存器與標籤有意義的名字（只改看起來是預設名／單字母的，編譯器已取好的名字不動）；回傳新程式＋對照表。執行結果不變（測試保證）
    function renameVM(prog) {
        const c = prog.code, regMap = {}, labelMap = {};
        const regs = []; const noteReg = (r) => { if (typeof r === 'string' && !regs.includes(r)) regs.push(r); };
        const FIELDS = ['dst', 'a', 'b', 'src', 'i', 'j', 'r', 'c', 'e', 'n'];
        for (const i of c) for (const f of FIELDS) if (i.op !== 'const' && !(i.op === 'iarith' && f === 'f')) noteReg(i[f]);
        for (const i of c) if (i.op === 'const') noteReg(i.dst);
        const writers = {}; for (const i of c) if (i.dst !== undefined) (writers[i.dst] = writers[i.dst] || []).push(i);
        const usedNames = new Set(regs.filter((r) => !GENERIC.test(r)));
        const halts = c.filter((i) => i.op === 'halt').map((i) => i.src); const prints = c.filter((i) => i.op === 'print').map((i) => i.src);
        const counters = {}; const take = (base) => { counters[base] = (counters[base] || 0) + 1; let nm = counters[base] === 1 ? base : base + '_' + counters[base]; while (usedNames.has(nm) || PY_RESERVED.has(nm)) { counters[base]++; nm = base + '_' + counters[base]; } usedNames.add(nm); return nm; };
        let nRead = 0;
        for (const r of regs) {
            if (!GENERIC.test(r) && !PY_RESERVED.has(r)) continue; const w = writers[r] || []; const f = w[0]; let base;
            if (f && f.op === 'read') base = 'number_in'; else if (halts.includes(r)) base = 'answer'; else if (prints.includes(r)) base = 'output';
            else if (!f) base = 'value'; else if (w.some((x) => x.op === 'iarith' && x.a === r && x.f === '+' && (x.b === 'one' || x.b === 1))) base = 'counter';
            else base = { read: 'number_in', const: isNum(f.value) ? 'const' : 'matrix', mov: 'copy', zeros: 'table', id: 'identity', mul: 'product', add: 'summed', pow: 'power', get: 'item', iarith: 'number', pop: 'popped', deq: 'dequeued', tr: 'transposed', onehot: 'one_hot', set: 'table' }[f.op] || 'tmp';
            regMap[r] = take(base);
        }
        const labels = c.filter((i) => i.op === 'label').map((i) => i.name); const lpos = new Map(); c.forEach((i, k) => { if (i.op === 'label') lpos.set(i.name, k); });
        const { tree } = structurize(prog); const heads = new Set(); const afters = new Set();
        const walk = (ns) => { for (const n of ns) { if (n.t === 'while') { heads.add(n.head); walk(n.body); } else if (n.t === 'if') { walk(n.then); if (n.else) walk(n.else); } } }; walk(tree);
        for (const l of labels) { // 迴圈起點後面最近的「離開」標籤
            if (!heads.has(l)) continue; const backs = c.map((x, k) => ((x.op === 'jmp' && x.to === l && k > lpos.get(l)) ? k : -1)).filter((k) => k >= 0); const q = Math.max(...backs); let k = q + 1; while (k < c.length && c[k].op === 'label') { afters.add(c[k].name); k++; }
        }
        const lnames = new Set(labels.filter((l) => !GENERIC.test(l))); const lc = {};
        const ltake = (base) => { lc[base] = (lc[base] || 0) + 1; let nm = lc[base] === 1 ? base : base + '_' + lc[base]; while (lnames.has(nm)) { lc[base]++; nm = base + '_' + lc[base]; } lnames.add(nm); return nm; };
        for (const l of labels) {
            if (!GENERIC.test(l)) continue; const k = lpos.get(l); let kk = k + 1; while (kk < c.length && c[kk].op === 'label') kk++;
            labelMap[l] = heads.has(l) ? ltake('loop') : afters.has(l) ? ltake('after_loop') : (kk < c.length && c[kk].op === 'halt') ? ltake('finish') : ltake('branch');
        }
        const rn = (x) => (typeof x === 'string' && regMap[x] ? regMap[x] : x), ln = (x) => (labelMap[x] || x);
        const code = c.map((i) => { const o = Object.assign({}, i); if (i.op === 'label') { o.name = ln(i.name); return o; } for (const f of FIELDS) if (o[f] !== undefined && !(i.op === 'const' && f === 'value')) o[f] = rn(o[f]); if (o.to !== undefined) o.to = ln(o.to); if (o.eof !== undefined) o.eof = ln(o.eof); if (i.op === 'const') o.dst = rn(i.dst); return o; });
        return { prog: { sr: prog.sr, code }, regMap, labelMap };
    }
    // 每條指令的說明（依指令與周圍的角色；回傳與 code 等長的字串陣列，沒話說的給 ''）
    function commentVM(prog) {
        const c = prog.code; const heads = new Set(structurize(prog).tree.length ? [] : []); void heads;
        return c.map((i, k) => {
            switch (i.op) {
                case 'read': return i.eof ? '一個一個讀輸入，讀完就離開' : '讀入下一個數';
                case 'const': return isNum(i.value) ? '常數' : '常數矩陣 ' + i.value.length + '×' + i.value[0].length;
                case 'mul': return '矩陣乘法（照程式選的半環）'; case 'pow': return '矩陣快速冪：用 ' + 'log(次方)' + ' 次乘法算出多步的結果';
                case 'iarith': return i.f === '+' && (i.b === 'one' || i.b === 1) && i.a === i.dst ? '計數加一' : i.f === '>>1' ? '除以二（向下取整）' : '整數加減';
                case 'push': return '放進堆疊'; case 'pop': return '從堆疊取出（堆疊空了會出錯）'; case 'enq': return '排進佇列'; case 'deq': return '從佇列取出'; case 'jqe': return '佇列空了就離開迴圈';
                case 'jlt': case 'jeq': return '比較後分支'; case 'get': return '讀出矩陣的一格'; case 'set': return '寫入矩陣的一格'; case 'halt': return '答案'; case 'print': return '輸出'; case 'onehot': return '位址向量（只有第 i 格是 1）';
                default: return '';
            }
        });
    }
    // ---------- 結構化中文受控自然語言 ----------
    const condText = (c) => {
        const v = (x) => String(x);
        if (c.op === 'noinput') return c.not ? '還有輸入' : '輸入用完了'; if (c.op === 'qempty') return c.not ? '佇列不是空的' : '佇列是空的';
        return v(c.a) + (c.op === 'lt' ? (c.not ? ' ≥ ' : ' < ') : (c.not ? ' ≠ ' : ' = ')) + v(c.b);
    };
    function vmToStructuredCnl(prog, opts) {
        opts = opts || {}; const ren = opts.rename === false ? { prog } : renameVM(prog); const p = ren.prog; const { tree, hasGoto } = structurize(p); const notes = opts.comments === false ? null : commentVM(p);
        const srName = { count: '計數（＋、×）', bool: '布林（或、且）', minplus: '最短路（取小、＋）', maxplus: '取大（取大、＋）' };
        const out = ['使用半環：' + (srName[p.sr.name] || p.sr.name) + (p.sr.mod ? '，取模 ' + p.sr.mod : '')]; const idx = new Map(); p.code.forEach((i, k) => idx.set(i, k));
        const say = (i) => {
            const f = (k) => i[k], d = (v) => (typeof v === 'number' ? String(v) : Array.isArray(v) ? v.length + '×' + v[0].length + ' 矩陣' : JSON.stringify(v));
            switch (i.op) {
                case 'const': return i.dst + ' 設成常數（' + d(i.value) + '）'; case 'mov': return i.dst + ' ← ' + i.src; case 'zeros': return i.dst + ' ← ' + f('r') + '×' + f('c') + ' 的零矩陣'; case 'id': return i.dst + ' ← ' + i.n + ' 階單位矩陣';
                case 'mul': return i.dst + ' ← ' + i.a + ' × ' + i.b + '（矩陣乘法）'; case 'add': return i.dst + ' ← ' + i.a + ' ⊕ ' + i.b + '（逐格相加／取小）'; case 'pow': return i.dst + ' ← ' + i.a + ' 的 ' + i.e + ' 次方（矩陣快速冪）';
                case 'get': return i.dst + ' ← ' + i.a + '[' + i.i + '][' + i.j + ']'; case 'set': return i.dst + '[' + i.i + '][' + i.j + '] ← ' + i.src;
                case 'iarith': return i.dst + ' ← ' + (i.f === '>>1' ? i.a + ' 除以 2（向下取整）' : i.a + ' ' + (i.f === '+' ? '＋' : '－') + ' ' + i.b);
                case 'push': return '把 ' + i.src + ' 推進堆疊'; case 'pop': return '從堆疊取出一個放進 ' + i.dst; case 'enq': return '把 ' + i.src + ' 排進佇列'; case 'deq': return '從佇列取出一個放進 ' + i.dst;
                case 'tr': return i.dst + ' ← ' + i.a + ' 的轉置'; case 'onehot': return i.dst + ' ← 長度 ' + i.n + '、第 ' + i.i + ' 格是 1 的 one-hot 向量'; case 'print': return '輸出 ' + i.src; default: return '（未知指令 ' + i.op + '）';
            }
        };
        const emit = (ns, d) => {
            const pad = '  '.repeat(d); const line = (s, ins) => { const n = ins && notes ? notes[idx.get(ins)] : ''; out.push(pad + s + (n ? '　（' + n + '）' : '')); };
            for (const n of ns) {
                if (n.t === 'op') line(say(n.i), n.i); else if (n.t === 'read') line('從輸入讀一個數放進 ' + n.dst); else if (n.t === 'halt') line('停機，答案是 ' + n.src);
                else if (n.t === 'break') line('離開迴圈'); else if (n.t === 'continue') line('回到迴圈開頭'); else if (n.t === 'goto') line('跳到 ' + n.to); else if (n.t === 'label') out.push(pad + '標籤 ' + n.name + '：');
                else if (n.t === 'while') { out.push(pad + (n.cond ? '當 ' + condText(n.cond) + ' 時重複：' : '一直重複（用「離開迴圈」跳出）：')); emit(n.body, d + 1); }
                else if (n.t === 'if') { out.push(pad + '如果 ' + condText(n.cond) + '：'); emit(n.then, d + 1); if (n.else) { out.push(pad + '否則：'); emit(n.else, d + 1); } }
            }
        };
        emit(tree, 0); out.hasGoto = hasGoto; return out;
    }
    // ---------- Python ----------
    function inferKinds(prog) {
        const kinds = {}; const M = (r) => { kinds[r] = 'M'; }; const S = (r) => { if (!kinds[r]) kinds[r] = 'S'; };
        let stackM = false, queueM = false; const kindOf = (x) => (isNum(x) ? 'S' : kinds[x] || 'S');
        for (let round = 0; round < 6; round++) {
            for (const i of prog.code) {
                switch (i.op) {
                    case 'read': case 'get': case 'iarith': S(i.dst); break; case 'const': if (isNum(i.value)) S(i.dst); else M(i.dst); break;
                    case 'mov': if (kindOf(i.src) === 'M') M(i.dst); else S(i.dst); break;
                    case 'zeros': case 'id': case 'mul': case 'add': case 'pow': case 'tr': case 'onehot': M(i.dst); break;
                    case 'set': M(i.dst); break; case 'push': if (kindOf(i.src) === 'M') stackM = true; break; case 'enq': if (kindOf(i.src) === 'M') queueM = true; break;
                    case 'pop': if (stackM) M(i.dst); else S(i.dst); break; case 'deq': if (queueM) M(i.dst); else S(i.dst); break;
                }
            }
        }
        return { kinds, stackM, queueM };
    }
    function vmToPython(prog, opts) {
        opts = opts || {}; const ren = opts.rename === false ? { prog } : renameVM(prog); const p = ren.prog;
        for (const i of p.code) for (const f of ['dst', 'a', 'b', 'src', 'i', 'j', 'r', 'c', 'e', 'n']) if (typeof i[f] === 'string' && PY_RESERVED.has(i[f]) && i.op !== 'label') return { ok: false, reason: '暫存器名稱與 Python 保留字衝突：' + i[f] };
        const { kinds, stackM, queueM } = inferKinds(p); const sr = p.sr, mod = sr.mod || 0; const usesInf = sr.name === 'minplus' || sr.name === 'maxplus' || p.code.some((i) => i.op === 'const' && Array.isArray(i.value) && JSON.stringify(i.value).includes('inf'));
        const kd = (x) => (isNum(x) ? 'S' : kinds[x] || 'S');
        const sc = (x) => (isNum(x) ? String(x) : kd(x) === 'M' ? x + '[0][0]' : x); const mt = (x) => (isNum(x) ? '[[' + x + ']]' : kd(x) === 'M' ? x : '[[' + x + ']]');
        const asg = (dst, expr) => (kd(dst) === 'M' ? dst + ' = [[' + expr + ']]' : dst + ' = ' + expr);
        const lit = (v) => (isNum(v) ? String(v) : v === 'inf' ? 'INF' : v === '-inf' ? '-INF' : JSON.stringify(v));
        const mlit = (v) => '[' + v.map((r) => '[' + r.map(lit).join(', ') + ']').join(', ') + ']';
        const used = new Set(p.code.map((i) => i.op)); const hasPrint = used.has('print');
        const needMat = ['mul', 'add', 'pow', 'id', 'zeros', 'onehot', 'mov', 'push', 'enq', 'tr'].some((o) => used.has(o)) || p.code.some((i) => i.op === 'const' && !isNum(i.value));
        const ADD = { count: (x, y) => (mod ? '(' + x + ' + ' + y + ') % MOD' : x + ' + ' + y), bool: (x, y) => '(1 if (' + x + ' or ' + y + ') else 0)', minplus: (x, y) => 'min(' + x + ', ' + y + ')', maxplus: (x, y) => 'max(' + x + ', ' + y + ')' }[sr.name];
        const MUL = { count: (x, y) => (mod ? '(' + x + ' * ' + y + ') % MOD' : x + ' * ' + y), bool: (x, y) => '(1 if (' + x + ' and ' + y + ') else 0)', minplus: (x, y) => x + ' + ' + y, maxplus: (x, y) => x + ' + ' + y }[sr.name];
        const ZERO = { count: '0', bool: '0', minplus: 'INF', maxplus: '-INF' }[sr.name], ONE = { count: '1', bool: '1', minplus: '0', maxplus: '0' }[sr.name]; if (!ADD) return { ok: false, reason: '半環不認得：' + sr.name };
        const head = ['import sys']; if (usesInf) head.push("INF = float('inf')"); if (mod) head.push('MOD = ' + mod); if (needMat) head.push('ZERO = ' + ZERO, 'ONE = ' + ONE);
        const helpers = [];
        if (needMat) {
            helpers.push('def cp(A):', '    return [row[:] for row in A]', '', 'def zeros(r, c):', '    return [[ZERO] * c for _ in range(r)]', '', 'def ident(n):', '    R = zeros(n, n)', '    for i in range(n):', '        R[i][i] = ONE', '    return R', '');
            helpers.push('def madd(A, B):', '    return [[' + ADD('A[i][j]', 'B[i][j]') + ' for j in range(len(A[0]))] for i in range(len(A))]', '');
            helpers.push('def mmul(A, B):', '    C = zeros(len(A), len(B[0]))', '    for i in range(len(A)):', '        for j in range(len(B[0])):', '            acc = ZERO', '            for t in range(len(B)):', '                acc = ' + ADD('acc', MUL('A[i][t]', 'B[t][j]')), '            C[i][j] = acc', '    return C', '');
            helpers.push('def mpow(A, e):', '    R = ident(len(A))', '    while e > 0:', '        if e % 2 == 1:', '            R = mmul(R, A)', '        A = mmul(A, A)', '        e = e // 2', '    return R', '');
        }
        const stmt = (i) => {
            switch (i.op) {
                case 'const': return kd(i.dst) === 'M' ? i.dst + ' = ' + (isNum(i.value) ? '[[' + i.value + ']]' : mlit(i.value)) : i.dst + ' = ' + i.value;
                case 'mov': return kd(i.dst) === 'M' ? i.dst + ' = cp(' + mt(i.src) + ')' : i.dst + ' = ' + sc(i.src);
                case 'zeros': return i.dst + ' = zeros(' + sc(i.r) + ', ' + sc(i.c) + ')'; case 'id': return i.dst + ' = ident(' + sc(i.n) + ')';
                case 'mul': return i.dst + ' = mmul(' + mt(i.a) + ', ' + mt(i.b) + ')'; case 'add': return i.dst + ' = madd(' + mt(i.a) + ', ' + mt(i.b) + ')'; case 'pow': return i.dst + ' = mpow(' + mt(i.a) + ', ' + sc(i.e) + ')';
                case 'get': return asg(i.dst, mt(i.a) + '[' + sc(i.i) + '][' + sc(i.j) + ']'); case 'set': return i.dst + '[' + sc(i.i) + '][' + sc(i.j) + '] = ' + sc(i.src);
                case 'iarith': return asg(i.dst, i.f === '>>1' ? sc(i.a) + ' >> 1' : sc(i.a) + ' ' + i.f + ' ' + sc(i.b));
                case 'push': return 'stack.append(' + (stackM ? 'cp(' + mt(i.src) + ')' : sc(i.src)) + ')'; case 'enq': return 'queue.append(' + (queueM ? 'cp(' + mt(i.src) + ')' : sc(i.src)) + ')';
                case 'pop': return i.dst + ' = ' + (kd(i.dst) === 'M' && !stackM ? '[[stack.pop()]]' : 'stack.pop()'); case 'deq': return i.dst + ' = ' + (kd(i.dst) === 'M' && !queueM ? '[[queue.pop(0)]]' : 'queue.pop(0)');
                case 'tr': return i.dst + ' = [list(r) for r in zip(*' + mt(i.a) + ')]';
                case 'onehot': return i.dst + ' = [[ONE if k == ' + sc(i.i) + ' else ZERO for k in range(' + sc(i.n) + ')]]';
                case 'print': return 'print(' + sc(i.src) + ')'; default: return null;
            }
        };
        const readStmts = (i) => [kd(i.dst) === 'M' ? i.dst + ' = [[tok[ip]]]' : i.dst + ' = tok[ip]', 'ip = ip + 1'];
        const cond = (c) => { if (c.op === 'noinput') return c.not ? 'ip < len(tok)' : 'ip >= len(tok)'; if (c.op === 'qempty') return c.not ? 'len(queue) > 0' : 'len(queue) == 0'; return sc(c.a) + (c.op === 'lt' ? (c.not ? ' >= ' : ' < ') : (c.not ? ' != ' : ' == ')) + sc(c.b); };
        const haltStmts = (src) => (hasPrint ? ['return'] : ['print(' + sc(src) + ')', 'return']);
        const body = []; const pre = ['tok = [int(x) for x in sys.stdin.read().split()]', 'ip = 0']; if (used.has('push') || used.has('pop')) pre.push('stack = []'); if (used.has('enq') || used.has('deq')) pre.push('queue = []');
        // 變數先宣告成預設值，避免 while 內才第一次賦值、離開後讀到未定義（VM 會報「暫存器沒有值」，這裡不模擬錯誤）
        const { tree, hasGoto } = structurize(p);
        let readable = !hasGoto;
        if (!hasGoto) {
            const emit = (ns, d) => {
                const pad = '    '.repeat(d); let any = false;
                for (const n of ns) {
                    any = true;
                    if (n.t === 'op') body.push(pad + stmt(n.i)); else if (n.t === 'read') readStmts(n).forEach((s) => body.push(pad + s)); else if (n.t === 'halt') haltStmts(n.src).forEach((s) => body.push(pad + s));
                    else if (n.t === 'break') body.push(pad + 'break'); else if (n.t === 'continue') body.push(pad + 'continue');
                    else if (n.t === 'while') { body.push(pad + 'while ' + (n.cond ? cond(n.cond) : 'True') + ':'); if (!emit(n.body, d + 1)) body.push(pad + '    pass'); }
                    else if (n.t === 'if') { body.push(pad + 'if ' + cond(n.cond) + ':'); if (!emit(n.then, d + 1)) body.push(pad + '    pass'); if (n.else) { body.push(pad + 'else:'); emit(n.else, d + 1); } }
                }
                return any;
            };
            emit(tree, 1); body.push('    return');
        } else { // 狀態分派：每個基本區塊一段，標籤＝狀態名
            const c = p.code, leaders = new Set([0]); c.forEach((i, k) => { if (i.op === 'label') leaders.add(k); if ((JUMPS.has(i.op) || i.op === 'halt' || (i.op === 'read' && i.eof)) && k + 1 < c.length) leaders.add(k + 1); });
            const starts = [...leaders].sort((a, b) => a - b); const nameAt = new Map(); let nb = 0; const names = starts.map((s) => { const nm = c[s].op === 'label' ? c[s].name : 'block_' + (++nb); nameAt.set(s, nm); return nm; });
            const lp = new Map(); c.forEach((i, k) => { if (i.op === 'label') lp.set(i.name, k); });
            const nextOf = (k) => { let q = k; while (q < c.length && c[q].op === 'label') { /* 標籤本身屬於區塊開頭 */ q++; break; } return q; }; void nextOf;
            body.push('    state = ' + JSON.stringify(names[0]), '    while True:');
            starts.forEach((s, bi) => {
                const e = bi + 1 < starts.length ? starts[bi + 1] : c.length; body.push('        ' + (bi ? 'elif' : 'if') + ' state == ' + JSON.stringify(names[bi]) + ':'); let ended = false; const b0 = body.length;
                for (let k = s; k < e; k++) {
                    const i = c[k]; if (i.op === 'label') continue;
                    if (i.op === 'jmp') { body.push('            state = ' + JSON.stringify(i.to), '            continue'); ended = true; break; }
                    if (i.op === 'halt') { haltStmts(i.src).forEach((x) => body.push('            ' + x)); ended = true; break; }
                    if (i.op === 'read' && i.eof) { body.push('            if ip >= len(tok):', '                state = ' + JSON.stringify(i.eof), '                continue'); readStmts(i).forEach((x) => body.push('            ' + x)); continue; }
                    if (i.op === 'jlt' || i.op === 'jeq' || i.op === 'jqe') { const cd = i.op === 'jqe' ? 'len(queue) == 0' : sc(i.a) + (i.op === 'jlt' ? ' < ' : ' == ') + sc(i.b); body.push('            if ' + cd + ':', '                state = ' + JSON.stringify(i.to), '                continue'); continue; }
                    if (i.op === 'read') { readStmts(i).forEach((x) => body.push('            ' + x)); continue; }
                    body.push('            ' + stmt(i));
                }
                if (!ended) { if (e < c.length) body.push('            state = ' + JSON.stringify(nameAt.get(e)), '            continue'); else body.push('            return'); }
                if (body.length === b0) body.push('            pass');
            });
            body.push('        else:', '            return');
        }
        const src = head.concat([''], helpers, ['def main():'], pre.map((x) => '    ' + x), body, ['', 'main()', '']).join('\n');
        return { ok: true, source: src, readable, hasGoto, renamed: ren.regMap || {}, labelMap: ren.labelMap || {} };
    }
    return { structurize, renameVM, commentVM, vmToStructuredCnl, vmToPython, inferKinds };
});
