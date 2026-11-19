/* KIR：通用逐元素核心的中間表示（DESIGN.webgpu-cuda.md §13）。純模組，沒有 DOM。
 * 一個核心＝一維 gid 迴圈；參數：buffer（f32 或 f32x4）與純量（f32、i32）；緩衝區只讀（access 'in'）或只寫（'out'），不能同時。
 *   kernel = { name, params: [{ kind:'buf', name, elem:'f32'|'f32x4', access:'in'|'out' } | { kind:'scalar', name, type:'f32'|'i32' }], body: [stmt] }
 *   stmt = { k:'let', name, t, e } | { k:'set', name, e } | { k:'store', buf, idx, e }（e＝標量，或 {k:'vec', es:[4 個標量]}）| { k:'for', v, bound, body }（bound＝整數字面值或 i32 純量名）| { k:'if', c, body }（c＝比較式；沒有 else）
 *   expr = { k:'num', v, t } | { k:'var', name, t } | { k:'gid' } | { k:'bin', op, a, b, t } | { k:'cmp', op, a, b } | { k:'sel', c, a, b, t }
 *        | { k:'call', fn, args, t } | { k:'cast', to, a } | { k:'load', buf, idx, comp }（comp＝0..3，f32 緩衝區為 null）
 *   t：'f32' 或 'i32'。運算式的兩邊型別必須一致（前端負責插入 cast）。
 * 產生器：toJs（CPU 對照，本檔）；WGSL 與 GLSL 在後續階段。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaKir = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const F32_BIN = { '+': 1, '-': 1, '*': 1, '/': 1 };
    const CALLS = { floor: 1, sqrt: 1, rsqrt: 1, min: 2, max: 2, abs: 1, pow: 2, exp: 1, sin: 1, cos: 1 };
    const JS_CALL = { floor: 'Math.floor', sqrt: 'Math.sqrt', rsqrt: (a) => `(1/Math.sqrt(${a}))`, min: 'Math.min', max: 'Math.max', abs: 'Math.abs', pow: 'Math.pow', exp: 'Math.exp', sin: 'Math.sin', cos: 'Math.cos' };

    // 檢查：型別、buffer 的讀寫權限、名稱、迴圈上界。回傳 { ok, errors[] }
    function validate(kernel) {
        const errors = [], bufs = {}, scal = {};
        for (const p of kernel.params || []) {
            if (p.kind === 'buf') {
                if (p.elem !== 'f32' && p.elem !== 'f32x4') errors.push(`buffer ${p.name} 的元素型別 ${p.elem} 不支援`);
                if (p.access !== 'in' && p.access !== 'out') errors.push(`buffer ${p.name} 的 access 要是 in 或 out（不能讀寫同一個）`);
                bufs[p.name] = p;
            } else if (p.kind === 'scalar') {
                if (p.type !== 'f32' && p.type !== 'i32') errors.push(`純量 ${p.name} 的型別 ${p.type} 不支援`);
                scal[p.name] = p;
            } else errors.push(`參數 ${p.name} 的 kind 不明`);
        }
        const env = new Map();
        const expr = (e, scope) => {
            if (!e || typeof e !== 'object') { errors.push('運算式不是物件'); return null; }
            switch (e.k) {
                case 'num': return e.t === 'f32' || e.t === 'i32' ? e.t : (errors.push('數字字面值型別錯'), null);
                case 'var': { const t = scope.get(e.name) || (scal[e.name] && scal[e.name].type); if (!t) errors.push(`未宣告的變數 ${e.name}`); else if (t !== e.t) errors.push(`變數 ${e.name} 型別不符`); return t || null; }
                case 'gid': return 'i32';
                case 'bin': { const a = expr(e.a, scope), b = expr(e.b, scope); if (a && b && (a !== b || a !== e.t)) errors.push(`二元運算 ${e.op} 型別不一致（${a} 對 ${b}，宣告 ${e.t}）`); if (!(e.op in F32_BIN) && !['%', '&', '|', '^', '<<', '>>'].includes(e.op)) errors.push(`不支援的運算子 ${e.op}`); return e.t; }
                case 'cmp': { const a = expr(e.a, scope), b = expr(e.b, scope); if (a && b && a !== b) errors.push(`比較 ${e.op} 兩邊型別不一致`); return 'bool'; }
                case 'sel': { const c = expr(e.c, scope), a = expr(e.a, scope), b = expr(e.b, scope); if (c !== 'bool') errors.push('select 的條件要是比較式'); if (a !== b || a !== e.t) errors.push('select 的兩個分支型別要一致'); return e.t; }
                case 'call': {
                    if (!(e.fn in CALLS)) { errors.push(`不支援的函式 ${e.fn}`); return null; }
                    if (CALLS[e.fn] !== e.args.length) errors.push(`${e.fn} 的參數個數錯`);
                    for (const a of e.args) if (expr(a, scope) !== 'f32') errors.push(`${e.fn} 的參數要是 f32`);
                    return 'f32';
                }
                case 'cast': { const a = expr(e.a, scope); if (!a || (a !== 'f32' && a !== 'i32')) errors.push('cast 的來源型別錯'); if (e.to !== 'f32' && e.to !== 'i32') errors.push('cast 的目標型別錯'); return e.to; }
                case 'load': {
                    const b = bufs[e.buf]; if (!b) { errors.push(`未宣告的 buffer ${e.buf}`); return null; }
                    if (b.access !== 'in') errors.push(`不能從只寫的 buffer ${e.buf} 讀`);
                    if (expr(e.idx, scope) !== 'i32') errors.push(`buffer ${e.buf} 的索引要是 i32`);
                    if (b.elem === 'f32' && e.comp !== null && e.comp !== undefined) errors.push(`f32 buffer ${e.buf} 不能取分量`);
                    if (b.elem === 'f32x4' && (e.comp === null || e.comp === undefined)) errors.push(`f32x4 buffer ${e.buf} 讀取要指定分量 0..3`);
                    return 'f32';
                }
                default: errors.push(`不支援的運算式 ${e.k}`); return null;
            }
        };
        const block = (stmts, scope, loopVars) => {
            for (const s of stmts) {
                switch (s.k) {
                    case 'let': {
                        if (scope.has(s.name) || scal[s.name] || loopVars.has(s.name)) errors.push(`變數 ${s.name} 重複宣告`);
                        const t = expr(s.e, scope); if (t !== s.t) errors.push(`let ${s.name} 的型別與初值不符`);
                        scope.set(s.name, s.t); break;
                    }
                    case 'set': { const t = scope.get(s.name); if (!t) errors.push(`賦值到未宣告的變數 ${s.name}`); const et = expr(s.e, scope); if (t && et !== t) errors.push(`賦值 ${s.name} 型別不符`); break; }
                    case 'store': {
                        const b = bufs[s.buf]; if (!b) { errors.push(`未宣告的 buffer ${s.buf}`); break; }
                        if (b.access !== 'out') errors.push(`不能寫入只讀的 buffer ${s.buf}`);
                        if (expr(s.idx, scope) !== 'i32') errors.push(`buffer ${s.buf} 寫入的索引要是 i32`);
                        if (b.elem === 'f32') { if (s.e && s.e.k === 'vec') errors.push(`f32 buffer ${s.buf} 不能寫入 vec`); else if (expr(s.e, scope) !== 'f32') errors.push(`寫入 ${s.buf} 的值要是 f32`); }
                        else { if (!s.e || s.e.k !== 'vec' || s.e.es.length !== 4) errors.push(`f32x4 buffer ${s.buf} 寫入要給 4 個分量`); else for (const x of s.e.es) if (expr(x, scope) !== 'f32') errors.push(`寫入 ${s.buf} 的分量要是 f32`); }
                        break;
                    }
                    case 'for': {
                        if (typeof s.bound === 'number') { if (!Number.isInteger(s.bound) || s.bound < 0) errors.push('for 的上界要是非負整數'); }
                        else if (!(scal[s.bound] && scal[s.bound].type === 'i32')) errors.push(`for 的上界 ${s.bound} 要是 i32 純量`);
                        if (scope.has(s.v) || scal[s.v]) errors.push(`迴圈變數 ${s.v} 與既有名稱衝突`);
                        const inner = new Map(scope); inner.set(s.v, 'i32');
                        block(s.body, inner, new Set([...loopVars, s.v]));
                        break;
                    }
                    case 'if': {
                        if (expr(s.c, scope) !== 'bool') errors.push('if 的條件要是比較式');
                        block(s.body, new Map(scope), loopVars);
                        break;
                    }
                    default: errors.push(`不支援的語句 ${s.k}`);
                }
            }
        };
        if (!kernel || !kernel.name) errors.push('核心沒有名稱');
        block(kernel.body || [], env, new Set());
        return { ok: errors.length === 0, errors };
    }

    // KIR → JS 函式。f32 的每個運算都包 Math.fround，讓結果貼近 GPU 的單精度。
    function toJs(kernel) {
        const v = validate(kernel); if (!v.ok) throw new Error('KIR 不合法：' + v.errors.join('；'));
        const f = (x) => `Math.fround(${x})`;
        const scalarSet = new Set((kernel.params || []).filter((p) => p.kind === 'scalar').map((p) => p.name));
        const ex = (e) => {
            switch (e.k) {
                case 'num': return e.t === 'f32' ? `Math.fround(${Number(e.v)})` : `(${Number(e.v) | 0})`;
                case 'var': return scalarSet.has(e.name) ? `S.${e.name}` : `v_${e.name}`;
                case 'gid': return 'gid';
                case 'bin': {
                    if (e.t === 'f32') return f(`(${ex(e.a)} ${e.op} ${ex(e.b)})`);
                    if (e.op === '*') return `Math.imul(${ex(e.a)}, ${ex(e.b)})`;
                    if (e.op === '/') return `((${ex(e.a)} / ${ex(e.b)}) | 0)`;
                    return `((${ex(e.a)} ${e.op} ${ex(e.b)}) | 0)`;
                }
                case 'cmp': return `(${ex(e.a)} ${e.op === '==' ? '===' : e.op === '!=' ? '!==' : e.op} ${ex(e.b)})`;
                case 'sel': return `(${ex(e.c)} ? ${ex(e.a)} : ${ex(e.b)})`;
                case 'call': return f(`${typeof JS_CALL[e.fn] === 'function' ? JS_CALL[e.fn](ex(e.args[0])) : JS_CALL[e.fn] + '(' + e.args.map(ex).join(', ') + ')'}`);
                case 'cast': return e.to === 'f32' ? f(ex(e.a)) : `(Math.trunc(${ex(e.a)}) | 0)`;
                case 'load': { const p = kernel.params.find((q) => q.name === e.buf); return p.elem === 'f32x4' ? `B.${e.buf}[(${ex(e.idx)}) * 4 + ${e.comp}]` : `B.${e.buf}[${ex(e.idx)}]`; }
                default: throw new Error('unreachable ' + e.k);
            }
        };
        const st = (s, ind) => {
            switch (s.k) {
                case 'let': return `${ind}let v_${s.name} = ${ex(s.e)};\n`;
                case 'set': return `${ind}v_${s.name} = ${ex(s.e)};\n`;
                case 'store': {
                    const p = kernel.params.find((q) => q.name === s.buf);
                    if (p.elem === 'f32x4') return s.e.es.map((x, c) => `${ind}B.${s.buf}[(${ex(s.idx)}) * 4 + ${c}] = ${ex(x)};\n`).join('');
                    return `${ind}B.${s.buf}[${ex(s.idx)}] = ${ex(s.e)};\n`;
                }
                case 'for': return `${ind}for (let v_${s.v} = 0; v_${s.v} < ${typeof s.bound === 'number' ? s.bound : 'S.' + s.bound}; v_${s.v}++) {\n${s.body.map((x) => st(x, ind + '  ')).join('')}${ind}}\n`;
                case 'if': return `${ind}if (${ex(s.c)}) {\n${s.body.map((x) => st(x, ind + '  ')).join('')}${ind}}\n`;
                default: throw new Error('unreachable ' + s.k);
            }
        };
        const scalars = (kernel.params || []).filter((p) => p.kind === 'scalar').map((p) => p.name);
        const body = (kernel.body || []).map((s) => st(s, '    ')).join('');
        const src = `"use strict";\nfor (let gid = 0; gid < N; gid++) {\n${body}  }\n`;
        // 純量在 S 裡，緩衝區在 B 裡；名稱不要衝突（參數名就是 S.x／B.x）
        const fn = new Function('B', 'S', 'N', src.replace(/\bS\.(\w+)\b/g, 'S.$1'));
        fn.scalarNames = scalars;
        return fn;
    }

    // 執行 JS 後端：buffers（name → 型別化陣列，f32 長 N、f32x4 長 4N）、scalars（name → 數字）。out 緩衝區就地寫入。
    function runJs(kernel, buffers, scalars, N) {
        const fn = toJs(kernel);
        const B = {}; for (const p of kernel.params) if (p.kind === 'buf') { const a = buffers[p.name]; if (!a) throw new Error('缺少 buffer ' + p.name); B[p.name] = a; }
        const S = {}; for (const p of kernel.params) if (p.kind === 'scalar') { if (!(p.name in scalars)) throw new Error('缺少純量 ' + p.name); S[p.name] = p.type === 'i32' ? (scalars[p.name] | 0) : Math.fround(scalars[p.name]); }
        fn(B, S, N | 0);
        return B;
    }

    return { validate, toJs, runJs, CALLS };
});
