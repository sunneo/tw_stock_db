/* OpenCL C 前端（CPU 驅動用）：OpenCL C（最小檔）→ JavaScript（FaClc，UMD，純邏輯、不碰 DOM）。設計見 DESIGN.pyopencl.md §8。
 *   compile(src, options) → { ok, log, kernels:{ 名: { params:[{name, kind:'buf'|'scalar', type, access}] } }, run(kernelName, args, gs, ls, off) }
 *   run 的 args：緩衝區參數是 mkptr(ArrayBuffer)，純量是數字；gs／ls／off 是長度 1–3 的陣列（ls 可為 null：自動選一個整除 gs 的工作群大小）。
 *
 * 範圍（最小檔，超出就報「第 N 行：…不支援」，不亂翻）：
 *   前置處理：#define（物件式與函式式，含 ##）、#undef、#if／#ifdef／#ifndef／#elif／#else／#endif（整數運算式、defined）、#pragma 與 #line 忽略、
 *            預定義 __OPENCL_C_VERSION__＝120、CLK_LOCAL_MEM_FENCE、CLK_GLOBAL_MEM_FENCE、
 *            選項裡的 -DNAME／-DNAME=值（其餘選項忽略）；#include 不支援。
 *   型別：char uchar short ushort int uint long ulong float double size_t ptrdiff_t bool void、unsigned／signed 組合、簡單 typedef、
 *        指標（__global／__constant／__private 限定詞被忽略）、區域陣列 T a[N]（含 {…} 初值）。long／ulong 用 JS 數字（精確到 2^53）。
 *   __local 與 barrier：核心範圍的 __local 陣列與 __local 指標參數（主機用 LocalMemory 指定大小）是工作群共享的；程式用到 barrier 時，核心與所有
 *            函式編成產生器（generator），barrier＝yield，執行器逐工作群、讓群內每個工作項跑到下一個 barrier 再一起繼續（群內有人結束、有人還在 barrier
 *            ＝發散，報錯）。沒有 barrier 的程式不付這個成本。
 *   struct：成員（純量、巢狀 struct、陣列）、結構陣列、`.`／`->`、傳值（複製）、指定、&、struct 指標當核心的緩衝區參數、放進 __local。
 *   switch、原子操作（atomic_／atom_ 的 add sub inc dec xchg cmpxchg min max and or xor；工作項循序執行，所以就是讀改寫）也支援。
 *   向量型別：float2/3/4/8/16 等（char…double）：建構 (float4)(…)／{…}、廣播、分量與 swizzle（.xy／.s01／.lo／.hi／.even／.odd，可當左值）、逐分量運算與比較（結果 -1／0）、
 *            記憶體載入存儲（float3 佔 4 個元素）、vloadN／vstoreN、convert_*（含 _sat 與捨入）、as_*、dot／length／distance／normalize／cross／any／all／select／shuffle、
 *            數學內建函式逐分量套用；向量可以當核心的緩衝區或純量參數、struct 的成員。
 *   union（匿名成員、aligned 屬性）、enum、`&局部變數`（引用指標，例如 sincos(x, &c)）、sincos／modf／fract 也支援。
 *   不支援：half、圖像、goto、函式指標、指標的指標、printf。
 *   寬容：頂層的「非核心」項目（輔助函式、typedef、全域變數）若含不支援的寫法，只記下原因、略過；**被用到的時候才報錯**（例如 #include 進來的
 *        pyopencl-complex.h 整份用向量型別，但沒用到複數的核心不受影響）。核心本身一律嚴格。
 *   語意：整數運算照 C（int 32 位元回繞、uint、整數除法向零取整、% 的正負號、移位）；float 運算每步 fround；double 直接用 JS；
 *        隱含轉換依 C 的一般算術轉換；指標是 {v:各型別視圖, o:位元組偏移}，支援位元組偏移的指標轉型與運算（pyopencl.array 的核心要用）。
 *   工作項循序執行：get_global_id／get_local_id／get_group_id／get_global_size／get_local_size／get_num_groups／get_work_dim／get_global_offset。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaClc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    class CErr extends Error { constructor(msg, line) { super(line ? '第 ' + line + ' 行：' + msg : msg); this.line = line; } }
    const fail = (m, l) => { throw new CErr(m, l); };

    // ======================================================================================
    // 型別
    // ======================================================================================
    const SCALARS = ['char', 'uchar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double'];
    const SIZE = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, long: 8, ulong: 8, float: 4, double: 8 };
    const VIEW = { char: 'i8', uchar: 'u8', short: 'i16', ushort: 'u16', int: 'i32', uint: 'u32', long: 'i64', ulong: 'u64', float: 'f32', double: 'f64' };
    const SHIFT = { 1: 0, 2: 1, 4: 2, 8: 3 };
    const isPtr = (t) => t && typeof t === 'object' && t.p !== undefined;
    const isStruct = (t) => t && typeof t === 'object' && t.s !== undefined;
    const isVec = (t) => t && typeof t === 'object' && t.v !== undefined;                 // 向量型別 {v: 純量名, n: 2|3|4|8|16}
    const vstride = (n) => (n === 3 ? 4 : n);                                              // float3 在記憶體裡佔 4 個元素（OpenCL 規定）
    const cmpBase = (b) => (b === 'double' || b === 'long' || b === 'ulong' ? 'long' : 'int');   // 向量比較的結果型別（同寬的有號整數）
    const SHIFT_OF_VIEW = { i8: 0, u8: 0, i16: 1, u16: 1, i32: 2, u32: 2, f32: 2, f64: 3, i64: 3, u64: 3 };
    const isInt = (t) => typeof t === 'string' && SCALARS.indexOf(t) >= 0 && t !== 'float' && t !== 'double';
    const isFloat = (t) => t === 'float' || t === 'double';
    const tstr = (t) => (isPtr(t) ? tstr(t.p) + '*' : isStruct(t) ? 'struct ' + t.s : isVec(t) ? t.v + t.n : isImg(t) ? t.im + '_t' : isPipe(t) ? 'pipe ' + tstr(t.pipe) : String(t));
    const TYPE_WORDS = new Set(['void', 'char', 'uchar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double', 'half', 'size_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t', 'bool', 'unsigned', 'signed']);
    const QUALS = new Set(['const', 'volatile', 'restrict', '__restrict', '__global', 'global', '__local', 'local', '__constant', 'constant', '__private', 'private', 'static', 'inline', '__attribute__']);
    const VECTOR_RE = /^(char|uchar|short|ushort|int|uint|long|ulong|float|double|half)(2|3|4|8|16)$/;

    // 通常算術轉換
    function common(a, b) {
        if (a === 'double' || b === 'double') return 'double';
        if (a === 'float' || b === 'float') return 'float';
        if (a === 'ulong' || b === 'ulong') return 'ulong';
        if (a === 'long' || b === 'long') return 'long';
        if (a === 'uint' || b === 'uint') return 'uint';
        return 'int';
    }
    const promote = (t) => (t === 'char' || t === 'uchar' || t === 'short' || t === 'ushort' ? 'int' : t);

    // 轉換：code（型別 from）→ 型別 to 的程式碼
    function conv(code, from, to) {
        if (from === to) return code;
        if (isVec(from) || isVec(to)) {
            if (isVec(from) && isVec(to)) { if (from.n !== to.n) fail('向量長度不同（' + tstr(from) + ' → ' + tstr(to) + '）'); return from.v === to.v ? code : '$rt.vm(' + code + ',($x)=>' + conv('$x', from.v, to.v) + ')'; }
            if (isVec(to) && !isPtr(from) && !isStruct(from)) return '$rt.vbc(' + conv(code, from, to.v) + ',' + to.n + ')';   // 純量 → 向量：廣播
            fail('向量不能隱含轉成純量或指標（' + tstr(from) + ' → ' + tstr(to) + '）');
        }
        if (isPtr(from) || isPtr(to)) fail('指標與數值之間的轉換不支援（' + tstr(from) + ' → ' + tstr(to) + '）');
        switch (to) {
            case 'double': return code;
            case 'float': return from === 'float' ? code : 'Math.fround(' + code + ')';
            case 'int': return '(' + code + '|0)';
            case 'uint': return '(' + code + '>>>0)';
            case 'long': return isFloat(from) ? 'Math.trunc(' + code + ')' : code;
            case 'ulong': return isFloat(from) ? 'Math.trunc(' + code + ')' : (from === 'int' || from === 'long' || from === 'short' || from === 'char' ? '$u64(' + code + ')' : code);
            case 'short': return '(' + code + '<<16>>16)';
            case 'ushort': return '(' + code + '&65535)';
            case 'char': return '(' + code + '<<24>>24)';
            case 'uchar': return '(' + code + '&255)';
            default: return fail('不支援的型別轉換 → ' + tstr(to));
        }
    }

    // ======================================================================================
    // 前置處理＋詞法
    // ======================================================================================
    const PUNCT = ['<<=', '>>=', '...', '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##'];
    function lexLine(s, line) {
        const out = []; let i = 0;
        while (i < s.length) {
            const c = s[i];
            if (/\s/.test(c)) { i++; continue; }
            if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < s.length && /\w/.test(s[j])) j++; out.push({ t: 'id', v: s.slice(i, j), line }); i = j; continue; }
            if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
                let j = i; if (c === '0' && /[xX]/.test(s[i + 1] || '')) { j += 2; while (j < s.length && /[0-9a-fA-F]/.test(s[j])) j++; }
                else { while (j < s.length && /[0-9.]/.test(s[j])) j++; if (/[eE]/.test(s[j] || '') && /[-+0-9]/.test(s[j + 1] || '')) { j += 2; while (j < s.length && /[0-9]/.test(s[j])) j++; } }
                while (j < s.length && /[uUlLfF]/.test(s[j])) j++;
                out.push({ t: 'num', v: s.slice(i, j), line }); i = j; continue;
            }
            if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; } out.push({ t: c === '"' ? 'str' : 'chr', v: s.slice(i + 1, j), line }); i = j + 1; continue; }
            const p = PUNCT.find((x) => s.startsWith(x, i)); if (p) { out.push({ t: 'p', v: p, line }); i += p.length; continue; }
            out.push({ t: 'p', v: c, line }); i++;
        }
        return out;
    }

    function preprocess(src, defs0) {
        const text = String(src).replace(/\r\n?/g, '\n').replace(/\\\n/g, ' ').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
        const macros = new Map(); const cond = []; const out = []; const lines = text.split('\n');
        const active = () => cond.every((c) => c.on);
        for (const k of Object.keys(defs0 || {})) macros.set(k, { params: null, body: lexLine(String(defs0[k]), 0) });

        function expand(toks, hide, depth) {
            if (depth > 64) fail('巨集展開太深（遞迴？）', toks[0] && toks[0].line);
            const res = [];
            for (let i = 0; i < toks.length; i++) {
                const tk = toks[i];
                if (tk.t !== 'id' || !macros.has(tk.v) || hide.has(tk.v)) { res.push(tk); continue; }
                const m = macros.get(tk.v);
                if (m.params === null) { res.push(...expand(m.body.map((b) => Object.assign({}, b, { line: tk.line })), new Set([...hide, tk.v]), depth + 1)); continue; }
                if (!(toks[i + 1] && toks[i + 1].v === '(' && toks[i + 1].t === 'p')) { res.push(tk); continue; }
                let d = 0, j = i + 1; const args = [[]];
                for (; j < toks.length; j++) {
                    const x = toks[j];
                    if (x.t === 'p' && x.v === '(') { d++; if (d === 1) continue; } else if (x.t === 'p' && x.v === ')') { d--; if (d === 0) break; } else if (x.t === 'p' && x.v === ',' && d === 1) { args.push([]); continue; }
                    args[args.length - 1].push(x);
                }
                if (d !== 0) fail('巨集 ' + tk.v + ' 的引數括號不成對', tk.line);
                if (m.params.length === 0 && args.length === 1 && args[0].length === 0) args.length = 0;
                if (args.length !== m.params.length) fail('巨集 ' + tk.v + ' 需要 ' + m.params.length + ' 個引數，得到 ' + args.length, tk.line);
                const exArgs = args.map((a) => expand(a, hide, depth + 1));
                let body = [];
                for (let b = 0; b < m.body.length; b++) {
                    const bt = m.body[b], pi = bt.t === 'id' ? m.params.indexOf(bt.v) : -1;
                    if (pi >= 0) body.push(...(m.body[b + 1] && m.body[b + 1].v === '##' || (m.body[b - 1] && m.body[b - 1].v === '##') ? args[pi] : exArgs[pi])); else body.push(bt);
                }
                const pasted = [];   // 處理 ##：把前後兩個記號接成一個
                for (let b = 0; b < body.length; b++) { if (body[b].t === 'p' && body[b].v === '##' && pasted.length && body[b + 1]) { const l = pasted.pop(), r = body[++b]; pasted.push(lexLine(l.v + r.v, tk.line)[0] || l); } else pasted.push(body[b]); }
                res.push(...expand(pasted.map((b) => Object.assign({}, b, { line: tk.line })), new Set([...hide, tk.v]), depth + 1)); i = j;
            }
            return res;
        }
        function evalIf(rest, line) {
            let toks = rest.slice(); const pre = [];
            for (let i = 0; i < toks.length; i++) {   // defined X／defined(X) 先處理，免得被巨集展開
                if (toks[i].t === 'id' && toks[i].v === 'defined') { let n = toks[i + 1]; let k = i + 1; if (n && n.v === '(') { n = toks[i + 2]; k = i + 3; } pre.push({ t: 'num', v: macros.has(n && n.v) ? '1' : '0', line }); i = k; } else pre.push(toks[i]);
            }
            toks = expand(pre, new Set(), 0).map((x) => (x.t === 'id' ? { t: 'num', v: '0', line } : x));
            const js = toks.map((x) => (x.t === 'num' ? String(parseInt(x.v.replace(/[uUlL]+$/, ''), x.v.startsWith('0x') || x.v.startsWith('0X') ? 16 : 10)) : x.v)).join(' ');
            if (!/^[\d\s+\-*/%()<>=!&|^~?:]*$/.test(js)) fail('#if 運算式不支援：' + js, line);
            try { return !!Function('return (' + (js || '0') + ')')(); } catch (e) { return fail('#if 運算式錯誤：' + js, line); }
        }
        for (let ln = 0; ln < lines.length; ln++) {
            const raw = lines[ln], line = ln + 1, m = /^\s*#\s*(\w*)\s*(.*)$/.exec(raw);
            if (!m) {
                if (active()) {
                    let tk = lexLine(raw, line);
                    // 函式式巨集的呼叫可以跨行（括號沒配平就繼續吃下一行）
                    const unbalanced = (ts) => { for (let i = 0; i < ts.length; i++) { const x = ts[i], mc = x.t === 'id' && macros.get(x.v); if (mc && mc.params !== null && ts[i + 1] && ts[i + 1].v === '(' && ts[i + 1].t === 'p') { let d = 0; for (let j = i + 1; j < ts.length; j++) { if (ts[j].t === 'p' && ts[j].v === '(') d++; else if (ts[j].t === 'p' && ts[j].v === ')') d--; } if (d > 0) return true; } } return false; };
                    while (unbalanced(tk) && ln + 1 < lines.length) { ln++; tk = tk.concat(lexLine(lines[ln], ln + 1)); }
                    if (tk.length) out.push(...expand(tk, new Set(), 0));
                }
                continue;
            }
            const dir = m[1], rest = m[2];
            if (dir === 'ifdef' || dir === 'ifndef') { const has = macros.has(rest.trim()); const on = active() && (dir === 'ifdef' ? has : !has); cond.push({ on, taken: on, parentOn: active() }); continue; }
            if (dir === 'if') { const on = active() && evalIf(lexLine(rest, line), line); cond.push({ on, taken: on, parentOn: active() }); continue; }
            if (dir === 'elif') { const c = cond[cond.length - 1]; if (!c) fail('#elif 沒有對應的 #if', line); const on = c.parentOn && !c.taken && evalIf(lexLine(rest, line), line); c.on = on; c.taken = c.taken || on; continue; }
            if (dir === 'else') { const c = cond[cond.length - 1]; if (!c) fail('#else 沒有對應的 #if', line); c.on = c.parentOn && !c.taken; c.taken = true; continue; }
            if (dir === 'endif') { if (!cond.length) fail('#endif 沒有對應的 #if', line); cond.pop(); continue; }
            if (!active()) continue;
            if (dir === 'define') {
                const dm = /^(\w+)(\(([^)]*)\))?\s*(.*)$/.exec(rest); if (!dm) fail('#define 格式不對', line);
                macros.set(dm[1], { params: dm[2] !== undefined ? dm[3].split(',').map((x) => x.trim()).filter(Boolean) : null, body: lexLine(dm[4], line) }); continue;
            }
            if (dir === 'undef') { macros.delete(rest.trim()); continue; }
            if (dir === 'pragma' || dir === 'line' || dir === '') continue;
            if (dir === 'error') fail('#error ' + rest, line);
            if (dir === 'include') fail('#include 不支援（本前端沒有標頭檔）', line);
            fail('不認得的前置處理指令 #' + dir, line);
        }
        if (cond.length) fail('#if 沒有對應的 #endif');
        return out;
    }

    // ======================================================================================
    // 語法分析＋產生 JS（一遍）
    // ======================================================================================
    const FLOAT_FN1 = { recip: '$recip', sqrt: 'Math.sqrt', cbrt: 'Math.cbrt', fabs: 'Math.abs', floor: 'Math.floor', ceil: 'Math.ceil', trunc: 'Math.trunc', exp: 'Math.exp', exp2: '$exp2', exp10: '$exp10', log: 'Math.log', log2: 'Math.log2', log10: 'Math.log10', sin: 'Math.sin', cos: 'Math.cos', tan: 'Math.tan', asin: 'Math.asin', acos: 'Math.acos', atan: 'Math.atan', sinh: 'Math.sinh', cosh: 'Math.cosh', tanh: 'Math.tanh', asinh: 'Math.asinh', acosh: 'Math.acosh', atanh: 'Math.atanh', round: '$round', rint: '$rint', rsqrt: '$rsqrt', sign: 'Math.sign', expm1: 'Math.expm1', log1p: 'Math.log1p', fract: '$fract', radians: '$rad', degrees: '$deg' };
    const FLOAT_FN2 = { divide: '$div', pow: 'Math.pow', powr: 'Math.pow', fmod: '$fmod', atan2: 'Math.atan2', fmin: 'Math.min', fmax: 'Math.max', hypot: 'Math.hypot', copysign: '$copysign', fdim: '$fdim', step: '$step', remainder: '$remainder' };
    const WI = { get_global_id: 'g', get_local_id: 'l', get_group_id: 'grp', get_global_size: 'gs', get_local_size: 'ls', get_num_groups: 'ng', get_global_offset: 'off' };
    const NATIVE = /^(native|half)_(.*)$/;

    // 圖像／取樣器常數（值照 OpenCL 標頭）：取樣器是 uint 位元欄位＝ 正規化座標 | 定址模式 | 過濾模式
    const ORDERS = ['R', 'A', 'RG', 'RA', 'RGB', 'RGBA', 'BGRA', 'ARGB', 'INTENSITY', 'LUMINANCE', 'Rx', 'RGx', 'RGBx'];
    const CTYPES = ['SNORM_INT8', 'SNORM_INT16', 'UNORM_INT8', 'UNORM_INT16', 'UNORM_SHORT_565', 'UNORM_SHORT_555', 'UNORM_INT_101010', 'SIGNED_INT8', 'SIGNED_INT16', 'SIGNED_INT32', 'UNSIGNED_INT8', 'UNSIGNED_INT16', 'UNSIGNED_INT32', 'HALF_FLOAT', 'FLOAT'];
    const IMG_DEFS = { CLK_NORMALIZED_COORDS_FALSE: '0', CLK_NORMALIZED_COORDS_TRUE: '1', CLK_ADDRESS_NONE: '0', CLK_ADDRESS_CLAMP_TO_EDGE: '2', CLK_ADDRESS_CLAMP: '4', CLK_ADDRESS_REPEAT: '6', CLK_ADDRESS_MIRRORED_REPEAT: '8', CLK_FILTER_NEAREST: '16', CLK_FILTER_LINEAR: '32' };
    ORDERS.forEach((n, i) => { IMG_DEFS['CLK_' + n] = String(0x10B0 + i); });
    CTYPES.forEach((n, i) => { IMG_DEFS['CLK_' + n] = String(0x10D0 + i); });
    const IMG_TYPES = { image1d_t: 'image1d', image2d_t: 'image2d', image3d_t: 'image3d', image1d_array_t: 'image1d_array', image2d_array_t: 'image2d_array', image1d_buffer_t: 'image1d_buffer' };
    const isImg = (t) => t && typeof t === 'object' && t.im !== undefined;
    const isPipe = (t) => t && typeof t === 'object' && t.pipe !== undefined;   // OpenCL 2.0 的 pipe 型別：{pipe: 封包型別}

    // 預定義巨集與 -D 選項（compile 與 source→SPIR-V 前端 clc_spv.js 共用）
    function buildDefs(options) {
        const defs = { __OPENCL_C_VERSION__: '120', __OPENCL_VERSION__: '120', __ENDIAN_LITTLE__: '1', CLK_LOCAL_MEM_FENCE: '1', CLK_GLOBAL_MEM_FENCE: '2' }; Object.assign(defs, IMG_DEFS, { CLK_NULL_RESERVE_ID: '0' });
        String(options || '').split(/\s+/).forEach((o) => { const m = /^-D(\w+)(?:=(.*))?$/.exec(o); if (m) defs[m[1]] = m[2] === undefined ? '1' : m[2]; });
        return defs;
    }
    // 前處理後的記號（{t:'id'|'num'|'str'|'chr'|'p', v, line}）；錯誤丟 CErr
    const tokensOf = (src, options) => preprocess(src, buildDefs(options));
    function compile(src, options) {
        const log = [];
        try {
            const toks = preprocess(src, buildDefs(options));
            const kernels = {}, order = [];
            const rt = runtime(); Object.assign(rt, imageRuntime());
            // 序言：把執行期的 $ 開頭輔助函式（$W、$u64、$rsqrt…）取成區域常數，生成的程式直接用
            const prologue = Object.keys(rt).filter((k) => k[0] === '$').map((k) => 'const ' + k + '=$rt.' + k + ';').join('') + '\n';
            const cg = new Codegen(toks, kernels, order);
            const body = prologue + cg.program();
            const mk = new Function('$rt', body);
            const mod = mk(rt);
            return { ok: true, kind: 'clc', log: log.join('\n'), kernels, mkptr: rt.mkptr, run: (name, args, gs, ls, off) => runKernel(rt, mod, kernels, name, args, gs, ls, off, cg.gen), js: body, gen: cg.gen };   // js／gen：可快取的「產物」（instantiate 用它重建，不經前端）
        } catch (e) {
            if (e instanceof CErr) return { ok: false, log: e.message, kernels: {} };
            throw e;
        }
    }

    class Codegen {
        constructor(toks, kernels, order) {
            this.t = toks; this.i = 0; this.kernels = kernels; this.order = order;
            this.scopes = [new Map()]; this.typedefs = new Map(); for (const k of Object.keys(IMG_TYPES)) this.typedefs.set(k, { im: IMG_TYPES[k] }); this.typedefs.set('sampler_t', 'uint'); this.typedefs.set('reserve_id_t', 'uint'); this.funcs = new Map(); this.tmp = 0; this.curRet = 'void'; this.out = [];
            this.enums = new Map(); this.badTypes = new Map(); this.badGlobals = new Map(); this.lkey = 0; this.inKernel = false; this.structs = new Map(); this.anon = 0;
            this.gen = toks.some((x) => x.t === 'id' && x.v === 'barrier');   // 用到 barrier：所有函式編成產生器
        }
        // 型別的位元組數（純量、struct、指標；其他回 0）
        sz(t) { if (isVec(t)) return SIZE[t.v] * vstride(t.n); if (typeof t === 'string') return SIZE[t] || 0; if (isStruct(t)) { const d = this.structs.get(t.s); return d ? d.size : 0; } return isPtr(t) ? 8 : 0; }
        al(t) { if (isVec(t)) return SIZE[t.v] * vstride(t.n); if (isStruct(t)) { const d = this.structs.get(t.s); return d ? d.align : 1; } return Math.max(1, this.sz(t)); }
        // __attribute__((…))：解析並略過；aligned(N) 回傳 N（其他回傳 0）
        parseAttrs() {
            let aligned = 0;
            while (this.is('__attribute__')) {
                this.i++; this.need('('); this.need('(');
                for (;;) {
                    const n = this.tk; if (!n || n.t !== 'id') this.err('__attribute__ 需要名稱'); this.i++;
                    if (this.is('(')) { if (n.v === 'aligned' || n.v === '__aligned__') { this.i++; const e = this.expr(); this.need(')'); const v = constInt(e.c); if (v) aligned = Math.max(aligned, v); } else { let d = 0; do { if (this.is('(')) d++; else if (this.is(')')) d--; this.i++; } while (d > 0 && this.tk); } }
                    if (!this.eat(',')) break;
                }
                this.need(')'); this.need(')');
            }
            return aligned;
        }
        // struct／union 定義：struct [tag] { 欄位; … }（欄位可以是純量、向量、巢狀 struct、陣列、匿名 struct／union 成員）。回傳 tag
        // union：所有成員的偏移都是 0，大小是最大成員；匿名成員的欄位直接成為外層的成員（C11）（欄位可以是純量、巢狀 struct、陣列）。回傳 tag
        structDef(tag, isUnion) {
            this.need('{'); const fields = new Map(); let cur = 0, align = 1, maxSize = 0;
            while (!this.is('}')) {
                if (!this.tk) this.err('struct 缺少 }');
                const b = this.parseBase(); this.parseAttrs();
                if (isStruct(b.t) && this.is(';') && /^__anon/.test(b.t.s)) {   // 匿名 struct／union 成員：欄位攤平進外層
                    this.i++; const d = this.structs.get(b.t.s), base = isUnion ? 0 : Math.ceil(cur / d.align) * d.align;
                    for (const [fname, f] of d.fields) fields.set(fname, Object.assign({}, f, { off: f.off + base }));
                    if (isUnion) maxSize = Math.max(maxSize, d.size); else cur = base + d.size; align = Math.max(align, d.align); continue;
                }
                for (;;) {
                    const t = this.parsePtrs(b.t); if (isPtr(t)) this.err('struct 的指標成員不支援');
                    const n = this.tk; if (!n || n.t !== 'id') this.err('struct 成員需要名稱'); this.i++;
                    const dims = []; while (this.eat('[')) { const sz = this.expr(); this.need(']'); const cn = constInt(sz.c); if (cn === null) this.err('struct 陣列成員的大小要是常數'); dims.push(cn); }
                    const count = dims.reduce((x, y) => x * y, 1), a = this.al(t), es = this.sz(t); if (!es) this.err('struct 成員 ' + n.v + ' 的型別不支援');
                    if (isUnion) { fields.set(n.v, { t, off: 0, array: dims.length > 0, dims }); maxSize = Math.max(maxSize, es * count); }
                    else { cur = Math.ceil(cur / a) * a; fields.set(n.v, { t, off: cur, array: dims.length > 0, dims }); cur += es * count; }
                    align = Math.max(align, a);
                    if (!this.eat(',')) break;
                }
                this.need(';');
            }
            this.i++; const name = tag || ('__anon' + (++this.anon)), at = this.parseAttrs(); align = Math.max(align, at);   // } __attribute__((aligned(N)))
            const raw = isUnion ? maxSize : cur;
            this.structs.set(name, { fields, size: Math.ceil(raw / align) * align || align, align }); return name;
        }
        // 成員存取：e.f（e 是 struct）或 e->f（e 是 struct 指標）
        member(e, name, arrow) {
            if (isVec(e.t) && !arrow) return this.vcomp(e, name);
            if (arrow && isPtr(e.t) && isVec(e.t.p)) return this.vcomp({ c: this.ldc(e.t.p, e.c, '0'), t: e.t.p, lv: { kind: 'mem', p: e.c, i: '0', et: e.t.p } }, name);
            let st;
            if (arrow) { if (!(isPtr(e.t) && isStruct(e.t.p))) this.err('-> 的左邊要是 struct 指標'); st = e.t.p; } else { if (!isStruct(e.t)) this.err('. 的左邊要是 struct（向量型別的分量存取尚未支援）'); st = e.t; }
            const d = this.structs.get(st.s), f = d && d.fields.get(name); if (!f) this.err('struct ' + st.s + ' 沒有成員 ' + name);
            const addr = f.off ? '$rt.padd(' + e.c + ',' + f.off + ',1)' : e.c;
            if (f.array) return { c: addr, t: f.dims.length > 1 ? { p: f.t, dims: f.dims } : { p: f.t } };   // 陣列成員：指向第一個元素
            if (isStruct(f.t)) return { c: addr, t: f.t, lv: { kind: 'struct', ptr: addr } };
            return { c: this.ldc(f.t, addr, '0'), t: f.t, lv: { kind: 'mem', p: addr, i: '0', et: f.t } };
        }
        // 載入／存儲的程式碼：et 是純量（VIEW）或向量（$rt.vld／vst，float3 步幅 4）
        ldc(et, p, i) { return isVec(et) ? '$rt.vld(' + p + ',' + i + ',' + JSON.stringify(VIEW[et.v]) + ',' + et.n + ')' : '$rt.ld_' + VIEW[et] + '(' + p + ',' + i + ')'; }
        stc(et, p, i, v) { return isVec(et) ? '$rt.vst(' + p + ',' + i + ',' + JSON.stringify(VIEW[et.v]) + ',' + et.n + ',' + v + ')' : '$rt.st_' + VIEW[et] + '(' + p + ',' + i + ',' + v + ')'; }
        // 向量分量：x y z w、s0…sF（十六進位）、lo／hi／even／odd；回傳索引陣列
        swizzle(name, n) {
            let idx;
            if (name === 'lo') idx = Array.from({ length: n / 2 }, (_, k) => k); else if (name === 'hi') idx = Array.from({ length: n / 2 }, (_, k) => k + n / 2);
            else if (name === 'even') idx = Array.from({ length: n / 2 }, (_, k) => 2 * k); else if (name === 'odd') idx = Array.from({ length: n / 2 }, (_, k) => 2 * k + 1);
            else if (/^[sS][0-9a-fA-F]+$/.test(name)) idx = name.slice(1).split('').map((c) => parseInt(c, 16));
            else if (/^[xyzw]+$/.test(name)) idx = name.split('').map((c) => 'xyzw'.indexOf(c));
            else this.err('向量沒有分量 ' + name);
            if (idx.some((k) => k >= n)) this.err('分量 ' + name + ' 超出 ' + n + ' 個元素的向量'); return idx;
        }
        // 分量讀寫：e.xy、e.s0、e.lo…；e 是向量。單一分量回純量，多個分量回向量；e 是左值時結果也是左值
        vcomp(e, name) {
            const idx = this.swizzle(name, e.t.n), pre = []; let A = e.c;
            if (!/^[\w$.]+$/.test(A)) { const t = this.newTmp(); pre.push(t + '=' + A); A = t; }
            const one = idx.length === 1; if (!one && ![2, 3, 4, 8, 16].includes(idx.length)) this.err('分量數 ' + idx.length + ' 不是合法的向量長度');
            const sel = one ? A + '[' + idx[0] + ']' : '[' + idx.map((k) => A + '[' + k + ']').join(',') + ']';
            const r = { c: pre.length ? '(' + pre.concat([sel]).join(',') + ')' : sel, t: one ? e.t.v : { v: e.t.v, n: idx.length } };
            if (e.lv) r.lv = { kind: 'vcomp', parent: e, idx, one };
            return r;
        }
        // 向量建構：(float4)(a, b, c, d)、(float4)(v2, v2)、(float4)(1.0f)（廣播）、{1,2,3,4}
        vecCtor(t, args) {
            if (args.length === 1 && !isVec(args[0].t)) return { c: conv(args[0].c, args[0].t, t), t };
            const parts = []; let count = 0;
            for (const a of args) {
                if (isVec(a.t)) { parts.push('...' + conv(a.c, a.t, { v: t.v, n: a.t.n })); count += a.t.n; }
                else { if (isPtr(a.t) || isStruct(a.t)) this.err('向量的元素不能是指標或 struct'); parts.push(conv(a.c, a.t, t.v)); count++; }
            }
            if (count !== t.n) this.err('向量 ' + tstr(t) + ' 需要 ' + t.n + ' 個元素，得到 ' + count);
            return { c: '[' + parts.join(',') + ']', t };
        }
        // 向量二元運算：逐分量；純量運算元廣播；比較回 -1／0 的整數向量
        vbinop(op, a, b) {
            const va = isVec(a.t), vb = isVec(b.t); if (va && vb && a.t.n !== b.t.n) this.err('向量長度不同（' + tstr(a.t) + ' 與 ' + tstr(b.t) + '）');
            if (isPtr(a.t) || isPtr(b.t) || isStruct(a.t) || isStruct(b.t)) this.err('向量不能和指標或 struct 運算');
            const n = va ? a.t.n : b.t.n, base = va && vb ? common(promote(a.t.v), promote(b.t.v)) : va ? a.t.v : b.t.v;
            const isCmp = ['==', '!=', '<', '>', '<=', '>='].includes(op);
            const sc = this.binop(op, { c: '$x', t: base }, { c: '$y', t: base });
            const code = isCmp ? '-' + sc.c : sc.c, rt = isCmp ? { v: cmpBase(base), n } : { v: sc.t, n };
            const A = va ? conv(a.c, a.t, { v: base, n }) : conv(a.c, a.t, base), B = vb ? conv(b.c, b.t, { v: base, n }) : conv(b.c, b.t, base);
            return { c: '$rt.' + (va && vb ? 'vz' : va ? 'vzr' : 'vzl') + '(' + A + ',' + B + ',($x,$y)=>' + code + ')', t: rt };
        }
        // ---- 記號工具
        get tk() { return this.t[this.i]; }
        line() { const x = this.t[this.i] || this.t[this.t.length - 1]; return x ? x.line : 0; }
        err(m) { fail(m, this.line()); }
        is(v) { const x = this.t[this.i]; return !!x && x.v === v && (x.t === 'p' || x.t === 'id'); }
        eat(v) { if (this.is(v)) { this.i++; return true; } return false; }
        need(v) { if (!this.eat(v)) this.err('這裡需要「' + v + '」，得到「' + (this.tk ? this.tk.v : '檔案結尾') + '」'); }
        isTypeStart(k) {
            const x = this.t[this.i + (k || 0)]; if (!x || x.t !== 'id') return false;
            if ((x.v === 'pipe' || x.v === '__pipe') && this.isTypeStart((k || 0) + 1)) return true;
            return TYPE_WORDS.has(x.v) || QUALS.has(x.v) || this.typedefs.has(x.v) || this.badTypes.has(x.v) || VECTOR_RE.test(x.v) || x.v === 'struct' || x.v === 'union' || x.v === 'enum' || x.v === 'typedef';
        }
        // ---- 範圍
        push() { this.scopes.push(new Map()); } pop() { this.scopes.pop(); }
        declare(name, type, js) { this.scopes[this.scopes.length - 1].set(name, { type, js: js || 'v_' + name }); return js || 'v_' + name; }
        look(name) { for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].has(name)) return this.scopes[i].get(name); return null; }
        newTmp() { return '$' + (++this.tmp); }

        // ---- 型別
        parseBase() {
            let sign = null, base = null, longs = 0, any = false, isConst = false, isLocal = false;
            for (;;) {
                const x = this.tk; if (!x || x.t !== 'id') break;
                const v = x.v;
                if (v === 'const' || v === 'constant' || v === '__constant') { isConst = true; this.i++; any = true; continue; }
                if (v === '__local' || v === 'local') isLocal = true;
                if (v === '__attribute__') { this.parseAttrs(); any = true; continue; }
                if (/^(__)?(read_only|write_only|read_write)$/.test(v)) { this.acc = v.replace(/^__/, ''); this.i++; any = true; continue; }
                if (QUALS.has(v)) { this.i++; any = true; continue; }
                if (v === 'unsigned' || v === 'signed') { sign = v; this.i++; any = true; continue; }
                if (v === 'long') { longs++; this.i++; any = true; base = base || 'long'; continue; }
                if (VECTOR_RE.test(v)) {
                    if (base) break; const vm = VECTOR_RE.exec(v); if (vm[1] === 'half') this.err('half 向量不支援'); this.i++;
                    return { t: { v: vm[1], n: Number(vm[2]) }, isConst, isLocal };
                }
                if (v === 'enum') {   // enum [tag] { A, B = 5, … }：常數是 int，型別當 int
                    if (base) break; this.i++; const tk = this.tk; if (tk && tk.t === 'id' && !this.is('{')) this.i++;
                    if (this.is('{')) {
                        this.i++; let cur = 0;
                        while (!this.is('}')) { const n = this.tk; if (!n || n.t !== 'id') this.err('enum 成員需要名稱'); this.i++; if (this.eat('=')) { const e = this.ternary(), c = constInt(e.c); if (c === null && !/^-?\d+$/.test(e.c.replace(/[()]/g, ''))) this.err('enum 的值要是常數'); cur = c === null ? Number(e.c.replace(/[()]/g, '')) : c; } this.enums.set(n.v, cur++); if (!this.eat(',')) break; }
                        this.need('}');
                    }
                    return { t: 'int', isConst, isLocal };
                }
                if (v === 'struct' || v === 'union') {
                    if (base) break; this.i++; this.parseAttrs(); const tk = this.tk; let tag = null;
                    if (tk && tk.t === 'id') { tag = tk.v; this.i++; }
                    if (this.is('{')) tag = this.structDef(tag, v === 'union'); else if (!tag || !this.structs.has(tag)) this.err(v + ' ' + tag + ' 沒有定義');
                    return { t: { s: tag }, isConst, isLocal };
                }
                if ((v === 'pipe' || v === '__pipe') && !base) { this.i++; const el = this.parseBase(); if (isPipe(el.t) || isImg(el.t)) this.err('pipe 的封包型別不合法'); return { t: { pipe: el.t }, isConst, isLocal }; }
                if (v === 'half') this.err('half 不支援');
                if (TYPE_WORDS.has(v) && v !== 'unsigned' && v !== 'signed') { if (base && !(base === 'long' && v === 'int')) { if (base === 'long' && v === 'long') { this.i++; continue; } break; } base = v === 'int' && base === 'long' ? 'long' : v; this.i++; any = true; continue; }
                if (this.badTypes.has(v) && !base) this.err('型別 ' + v + ' 不能用（它的定義不支援：' + this.badTypes.get(v) + '）');
                if (this.typedefs.has(v) && !base) { const td = this.typedefs.get(v); this.i++; any = true; return { t: td, isConst, isLocal }; }
                break;
            }
            if (!any) this.err('這裡需要型別');
            if (!base) base = 'int';
            const map = { size_t: 'ulong', ptrdiff_t: 'long', intptr_t: 'long', uintptr_t: 'ulong', bool: 'int' };
            if (map[base]) base = map[base];
            if (sign === 'unsigned') base = { char: 'uchar', short: 'ushort', int: 'uint', long: 'ulong' }[base] || this.err('unsigned ' + base + ' 不合法');
            return { t: base, isConst, isLocal };
        }
        // 解析 * 與其後的限定詞；回傳型別
        parsePtrs(t) {
            while (this.is('*')) {
                this.i++; if (isPtr(t)) this.err('指標的指標不支援');
                t = { p: t };
                while (this.tk && this.tk.t === 'id' && QUALS.has(this.tk.v)) this.i++;
            }
            return t;
        }
        parseTypeName() { const b = this.parseBase(); return this.parsePtrs(b.t); }

        // ---- 轉換成條件
        truth(x) { if (isVec(x.t)) this.err('向量不能當條件（用 any／all）'); return isPtr(x.t) ? '(' + x.c + '!==null)' : '(' + x.c + '!==0)'; }

        // ======================================================================================
        program() {
            const out = [];
            while (this.i < this.t.length) {
                if (this.eat(';')) continue;
                const start = this.i; let isKernel = false, isTypedef = this.is('typedef');
                try {
                    if (isTypedef) { this.i++; const b = this.parseBase(); const t = this.parsePtrs(b.t); const n = this.tk; if (!n || n.t !== 'id') this.err('typedef 需要名稱'); this.i++; this.need(';'); this.typedefs.set(n.v, t); continue; }
                    while (this.tk && (this.tk.v === '__kernel' || this.tk.v === 'kernel')) { isKernel = true; this.i++; }
                    const b = this.parseBase(); if (this.eat(';')) continue;   // 只有 struct 定義
                    const rt = this.parsePtrs(b.t);
                    const nameTok = this.tk; if (!nameTok || nameTok.t !== 'id') this.err('這裡需要函式名稱');
                    this.i++;
                    if (!this.is('(')) { out.push(this.globalVar(nameTok.v, rt, b.isConst)); continue; }
                    out.push(this.func(nameTok.v, rt, isKernel));
                } catch (e) {
                    if (!(e instanceof CErr) || isKernel || (this.t[start] && /^(__kernel|kernel)$/.test(this.t[start].v))) throw e;
                    // 非核心的項目含不支援的寫法：記下原因、略過整個項目；被用到時才報錯
                    while (this.scopes.length > 1) this.pop();
                    const name = this.skipItem(start, isTypedef); const ent = { bad: e.message };
                    if (name) { if (name.kind === 'func') this.funcs.set(name.v, ent); else if (name.kind === 'type') this.badTypes.set(name.v, e.message); else this.badGlobals.set(name.v, e.message); }
                }
            }
            const names = Object.keys(this.kernels);
            if (!names.length) fail('原始碼裡沒有 __kernel 函式');
            return out.join('\n') + '\nreturn {' + names.map((n) => JSON.stringify(n) + ':k_' + n).join(',') + '};';
        }
        // 從 start 起略過一個頂層項目（到對應的 } 或 ;）；回傳 {kind, v}（函式／型別／全域變數的名字，找不到回 null）
        skipItem(start, isTypedef) {
            const T = this.t; let i = start, d = 0, name = null, firstParen = -1;
            for (; i < T.length; i++) {
                const x = T[i];
                if (x.t === 'p' && x.v === '(') { if (d === 0 && firstParen < 0) firstParen = i; d++; } else if (x.t === 'p' && x.v === ')') d--;
                else if (d === 0 && x.t === 'p' && x.v === '{') {
                    let b = 1; i++; while (i < T.length && b) { if (T[i].v === '{' && T[i].t === 'p') b++; else if (T[i].v === '}' && T[i].t === 'p') b--; i++; }
                    if (firstParen < 0) { while (i < T.length && !(T[i].t === 'p' && T[i].v === ';')) i++; i++; }   // struct／enum 的 {…} 後面到 ;
                    break;
                } else if (d === 0 && x.t === 'p' && x.v === ';') { i++; break; }
            }
            if (firstParen > start && T[firstParen - 1].t === 'id' && !isTypedef) name = { kind: 'func', v: T[firstParen - 1].v };
            else { for (let k = i - 1; k >= start; k--) if (T[k].t === 'id' && !TYPE_WORDS.has(T[k].v) && !QUALS.has(T[k].v)) { name = { kind: isTypedef ? 'type' : 'var', v: T[k].v }; break; } }
            this.i = i; return name;
        }

        // 全域變數：只支援 __constant（唯讀）純量與陣列，初值要是常數運算式（可含巨集）。生成模組層級的變數，所有函式共用。
        globalVar(name, t, isConst) {
            if (!isConst) this.err('全域變數 ' + name + ' 不是 __constant（OpenCL 只允許 __constant 的全域變數）');
            if (isPtr(t)) this.err('全域指標變數不支援');
            let init;
            if (this.is('[')) {
                this.i++; const sz = this.expr(); this.need(']'); const cn = constInt(sz.c), m = cn === null ? null : [0, String(cn)]; if (!m) this.err('全域陣列的大小要是常數');
                const vals = []; this.need('='); this.need('{'); while (!this.is('}')) { vals.push(this.coerce(this.assign(), t)); if (!this.eat(',')) break; } this.need('}');
                init = '$rt.arr(' + JSON.stringify(VIEW[t]) + ',' + this.sz(t) * Number(m[1]) + ',[' + vals.join(',') + '])'; t = { p: t };
            } else { this.need('='); init = this.coerce(this.assign(), t); }
            this.need(';'); const js = this.declare(name, t);
            return 'let ' + js + '=' + init + ';';
        }

        func(name, retType, isKernel) {
            this.need('('); this.push(); const params = []; const pdesc = [];
            if (!this.is(')')) {
                if (this.is('void') && this.t[this.i + 1] && this.t[this.i + 1].v === ')') this.i++;
                else for (;;) {
                    this.acc = null; const startLine = this.line(); const sawLocal = this.tk && (this.tk.v === '__local' || this.tk.v === 'local');
                    const pb = this.parseBase(); const pt = this.parsePtrs(pb.t);
                    const pn = this.tk; if (!pn || pn.t !== 'id') this.err('參數需要名稱'); this.i++;
                    const js = this.declare(pn.v, pt); params.push(js);
                    if (isKernel) {
                        if (isPipe(pt)) pdesc.push({ name: pn.v, kind: 'pipe', type: tstr(pt.pipe), access: 'rw', size: this.sz(pt.pipe) });
                        else if (isImg(pt)) pdesc.push({ name: pn.v, kind: 'image', type: pt.im, access: this.acc === 'write_only' ? 'out' : this.acc === 'read_write' ? 'rw' : 'in' });
                        else if (isPtr(pt)) { if (!SCALARS.includes(pt.p) && !isStruct(pt.p) && !isVec(pt.p)) fail('核心的緩衝區參數 ' + pn.v + ' 型別 ' + tstr(pt) + ' 不支援（要是純量、向量或 struct 的指標）', startLine); const et = isStruct(pt.p) ? 'struct' : isVec(pt.p) ? tstr(pt.p) : pt.p; pdesc.push(sawLocal || pb.isLocal ? { name: pn.v, kind: 'local', type: et } : { name: pn.v, kind: 'buf', type: et, access: pb.isConst ? 'in' : 'rw' }); }
                        else if (isStruct(pt)) pdesc.push({ name: pn.v, kind: 'scalar', type: 'struct', size: this.sz(pt) });   // 主機傳位元組（例如複數 cfloat_t）
                        else pdesc.push({ name: pn.v, kind: 'scalar', type: isVec(pt) ? tstr(pt) : pt });
                    } else if (isPtr(pt) && pt.p === 'void') this.err('void* 參數不支援');
                    if (!this.eat(',')) break;
                }
            }
            this.need(')');
            if (isKernel && retType !== 'void') this.err('核心要回傳 void');
            let code;
            if (this.eat(';')) { code = ''; this.funcs.set(name, { ret: retType, params: pdesc.length ? pdesc : null }); }   // 前向宣告
            else {
                const sig = { ret: retType, ptypes: [] }; this.funcs.set(name, Object.assign(this.funcs.get(name) || {}, sig));
                const saveRet = this.curRet, saveTmp = this.tmp, saveK = this.inKernel; this.curRet = retType; this.tmp = 0; this.inKernel = isKernel;
                const ptypes = []; for (const [, v] of this.scopes[this.scopes.length - 1]) ptypes.push(v.type); this.funcs.get(name).ptypes = ptypes;
                const body = this.block(); const temps = []; for (let k = 1; k <= this.tmp; k++) temps.push('$' + k);
                code = 'function' + (this.gen ? '*' : '') + ' ' + (isKernel ? 'k_' : 'f_') + name + '(' + params.join(',') + ') {' + (temps.length ? 'let ' + temps.join(',') + ';' : '') + body + '}';
                this.curRet = saveRet; this.tmp = saveTmp; this.inKernel = saveK;
                if (isKernel) this.kernels[name] = { params: pdesc };
            }
            this.pop(); return code;
        }

        // ---- 敘述
        block() {
            this.need('{'); this.push(); const out = [];
            while (!this.is('}')) { if (!this.tk) this.err('缺少 }'); out.push(this.stmt()); }
            this.i++; this.pop(); return out.join('');
        }
        stmt() {
            if (this.is('{')) return '{' + this.block() + '}';
            if (this.eat(';')) return ';';
            const x = this.tk;
            if (x.t === 'id') {
                switch (x.v) {
                    case 'if': { this.i++; this.need('('); const c = this.expr(); this.need(')'); let s = 'if (' + this.truth(c) + ') ' + this.sub(); if (this.eat('else')) s += ' else ' + this.sub(); return s; }
                    case 'while': { this.i++; this.need('('); const c = this.expr(); this.need(')'); return 'while (' + this.truth(c) + ') ' + this.sub(); }
                    case 'do': { this.i++; const b = this.sub(); this.need('while'); this.need('('); const c = this.expr(); this.need(')'); this.need(';'); return 'do ' + b + ' while (' + this.truth(c) + ');'; }
                    case 'for': return this.forStmt();
                    case 'break': this.i++; this.need(';'); return 'break;';
                    case 'continue': this.i++; this.need(';'); return 'continue;';
                    case 'return': {
                        this.i++; if (this.eat(';')) { if (this.curRet !== 'void') this.err('這個函式要回傳值'); return 'return;'; }
                        const e = this.expr(); this.need(';'); if (this.curRet === 'void') this.err('void 函式不能回傳值'); const rc = this.coerce(e, this.curRet); return 'return ' + (isStruct(this.curRet) ? '$rt.clone(' + rc + ',' + this.sz(this.curRet) + ')' : rc) + ';';
                    }
                    case 'switch': {
                        this.i++; this.need('('); const e = this.expr(); this.need(')'); this.need('{'); this.push(); const out = [];
                        if (isFloat(e.t) || isPtr(e.t)) this.err('switch 的運算式要是整數');
                        while (!this.is('}')) {
                            if (!this.tk) this.err('switch 缺少 }');
                            if (this.is('case')) { this.i++; const c = this.ternary(); this.need(':'); if (isFloat(c.t)) this.err('case 的值要是整數'); out.push('case ' + c.c + ':'); }
                            else if (this.is('default')) { this.i++; this.need(':'); out.push('default:'); }
                            else out.push(this.stmt());
                        }
                        this.i++; this.pop(); return 'switch (' + conv(e.c, e.t, promote(e.t) === 'uint' || promote(e.t) === 'ulong' ? promote(e.t) : 'int') + ') {' + out.join('') + '}';
                    }
                    case 'goto': this.err('goto 不支援'); break;
                    case 'barrier': { this.i++; this.need('('); this.expr(); this.need(')'); this.need(';'); return 'yield 0;'; }
                    case 'mem_fence': case 'read_mem_fence': case 'write_mem_fence': { this.i++; this.need('('); this.expr(); this.need(')'); this.need(';'); return ';'; }   // 工作項在 barrier 之間循序執行，記憶體順序天然一致
                    default: break;
                }
                if (this.isTypeStart()) return this.declStmt();
            }
            const e = this.expr(); this.need(';'); return e.c + ';';
        }
        sub() { this.push(); const s = this.is('{') ? '{' + this.block() + '}' : this.stmt(); this.pop(); return s; }
        forStmt() {
            this.i++; this.need('('); this.push(); let init = '';
            if (this.eat(';')) init = ''; else if (this.isTypeStart()) init = this.declStmt(true); else { init = this.expr().c; this.need(';'); }
            let cond = ''; if (!this.is(';')) cond = this.truth(this.expr()); this.need(';');
            let step = ''; if (!this.is(')')) step = this.expr().c; this.need(')');
            const body = this.sub(); this.pop();
            return 'for (' + init.replace(/;$/, '') + ';' + cond + ';' + step + ') ' + body;
        }
        declStmt(noSemiEnd) {
            const b = this.parseBase(); const parts = []; if (this.eat(';')) return ';';   // 只有 struct 定義
            for (;;) {
                const t = this.parsePtrs(b.t); const n = this.tk; if (!n || n.t !== 'id') this.err('這裡需要變數名稱'); this.i++;
                if (this.is('[')) {   // 區域陣列（可多維：T a[N][M]，連續排列，a[i] 是第 i 列的指標）
                    const dims = []; while (this.eat('[')) { const sz = this.expr(); this.need(']'); const cn = constInt(sz.c); if (cn === null) this.err('區域陣列的大小要是常數'); dims.push(cn); }
                    if (isPtr(t)) this.err('指標陣列不支援');
                    const total = dims.reduce((x, y) => x * y, 1), m = [0, String(total)];
                    const js = this.declare(n.v, dims.length > 1 ? { p: t, dims } : { p: t }); let init = '$rt.alloc(' + this.sz(t) * total + ')';
                    if (b.isLocal) {
                        if (!this.inKernel) this.err('__local 陣列只能宣告在核心的最外層函式裡（輔助函式要用的話，從核心傳指標進去）');
                        if (this.is('=')) this.err('__local 陣列不能有初值（OpenCL 規定）');
                        parts.push(js + '=$rt.lmem(' + (++this.lkey) + ',' + this.sz(t) * Number(m[1]) + ')'); if (!this.eat(',')) break; continue;
                    }
                    if (this.eat('=')) { if (isStruct(t)) this.err('struct 陣列不支援初值'); this.need('{'); const vals = []; while (!this.is('}')) { vals.push(this.coerce(this.assign(), t)); if (!this.eat(',')) break; } this.need('}'); init = '$rt.arr(' + JSON.stringify(VIEW[t]) + ',' + this.sz(t) * Number(m[1]) + ',[' + vals.join(',') + '])'; }
                    parts.push(js + '=' + init);
                } else {
                    if (b.isLocal) this.err('__local 純量變數不支援（請宣告成長度 1 的陣列）');
                    const js = this.declare(n.v, t); let init = isPtr(t) ? 'null' : isStruct(t) ? '$rt.alloc(' + this.sz(t) + ')' : '0';
                    if (isVec(t)) init = '$rt.vbc(0,' + t.n + ')';
                    if (isVec(t) && this.is('=') && this.t[this.i + 1] && this.t[this.i + 1].v === '{') { this.i += 2; const as = []; while (!this.is('}')) { as.push(this.assign()); if (!this.eat(',')) break; } this.need('}'); init = this.vecCtor(t, as).c; }
                    else if (this.eat('=')) { const e = this.assign(); init = isStruct(t) ? '$rt.clone(' + this.coerce(e, t) + ',' + this.sz(t) + ')' : this.coerce(e, t); }
                    parts.push(js + '=' + init);
                }
                if (!this.eat(',')) break;
            }
            this.need(';');
            return 'let ' + parts.join(',') + ';';
        }

        // ---- 運算式
        expr() { let e = this.assign(); while (this.is(',')) { this.i++; const r = this.assign(); e = { c: '(' + e.c + ',' + r.c + ')', t: r.t }; } return e; }
        coerce(e, to) {
            if (isStruct(to) || isStruct(e.t)) { if (isStruct(to) && isStruct(e.t) && to.s === e.t.s) return e.c; this.err('struct 型別不符（' + tstr(e.t) + ' → ' + tstr(to) + '）'); }
            if (isVec(to) || isVec(e.t)) return conv(e.c, e.t, to);
            if (isPtr(to) || isPtr(e.t)) {
                if (isPtr(to) && isPtr(e.t)) return e.c;
                if (isPtr(to) && e.c === '0') return 'null';
                this.err('指標與數值不能互相指定（' + tstr(e.t) + ' → ' + tstr(to) + '）');
            }
            return conv(e.c, e.t, to);
        }
        assign() {
            const lhs = this.ternary();
            const x = this.tk;
            if (x && x.t === 'p' && ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='].includes(x.v)) {
                this.i++; const op = x.v; const rhs = this.assign();
                if (!lhs.lv) this.err('= 的左邊不是可指定的對象');
                if (op === '=') return { c: this.write(lhs, this.coerce(rhs, lhs.t)), t: lhs.t };   // struct：write 走 $rt.copy
                const pre = [], lv = this.stable(lhs, pre);
                const cur = this.read(lv); const bin = this.binop(op.slice(0, -1), cur, rhs);
                const val = isPtr(lv.t) ? bin.c : conv(bin.c, bin.t, lv.t);
                return { c: '(' + pre.concat([this.write(lv, val)]).join(',') + ')', t: lv.t };
            }
            return lhs;
        }
        // 讓左值的位址運算式只求值一次（記憶體左值的指標與索引放進暫存變數）
        stable(lv, pre) {
            if (lv.lv.kind === 'var' || lv.lv.kind === 'struct' || lv.lv.kind === 'vcomp') return lv;
            const simple = (c) => /^[\w$.]+$/.test(c);
            let p = lv.lv.p, i = lv.lv.i;
            if (!simple(p)) { const t = this.newTmp(); pre.push(t + '=' + p); p = t; }
            if (!simple(i)) { const t = this.newTmp(); pre.push(t + '=' + i); i = t; }
            return { c: lv.c, t: lv.t, lv: { kind: 'mem', p, i, et: lv.lv.et } };
        }
        read(lv) {
            if (lv.lv.kind === 'struct') return { c: lv.lv.ptr, t: lv.t };
            if (lv.lv.kind === 'var') return { c: lv.lv.js, t: lv.t };
            if (lv.lv.kind === 'vcomp') return { c: lv.c, t: lv.t };
            const { p, i, et } = lv.lv; return { c: this.ldc(et, p, i), t: et };
        }
        write(lv, valCode) {
            if (lv.lv.kind === 'struct') return '$rt.copy(' + lv.lv.ptr + ',' + valCode + ',' + this.sz(lv.t) + ')';
            if (lv.lv.kind === 'var') return '(' + lv.lv.js + '=' + valCode + ')';
            if (lv.lv.kind === 'vcomp') {   // 讀整個向量、換掉分量、整個寫回
                const { parent, idx, one } = lv.lv, tmp = this.newTmp(), vt = this.newTmp(), pr = this.read(parent);
                const sets = one ? [tmp + '[' + idx[0] + ']=' + vt] : idx.map((k, j) => tmp + '[' + k + ']=' + vt + '[' + j + ']');
                return '(' + [vt + '=' + conv(valCode, lv.t, lv.t), tmp + '=' + pr.c + '.slice()'].concat(sets, [this.write(parent, tmp), vt]).join(',') + ')';
            }
            const { p, i, et } = lv.lv; return this.stc(et, p, i, valCode);
        }
        ternary() {
            const c = this.logOr();
            if (!this.eat('?')) return c;
            const a = this.expr(); this.need(':'); const b = this.ternary();
            if (isVec(c.t)) { const vt = isVec(a.t) ? a.t : b.t; if (!isVec(vt)) this.err('向量條件的兩個分支要有一個是向量'); return { c: '$rt.vsel(' + c.c + ',' + conv(a.c, a.t, vt) + ',' + conv(b.c, b.t, vt) + ')', t: vt }; }
            if (isVec(a.t) || isVec(b.t)) { const vt = isVec(a.t) ? a.t : b.t; return { c: '(' + this.truth(c) + '?' + conv(a.c, a.t, vt) + ':' + conv(b.c, b.t, vt) + ')', t: vt }; }
            if (isPtr(a.t) || isPtr(b.t)) return { c: '(' + this.truth(c) + '?' + a.c + ':' + b.c + ')', t: a.t };
            const t = common(promote(a.t), promote(b.t));
            return { c: '(' + this.truth(c) + '?' + conv(a.c, a.t, t) + ':' + conv(b.c, b.t, t) + ')', t };
        }
        logOr() { let l = this.logAnd(); while (this.is('||')) { this.i++; const r = this.logAnd(); if (isVec(l.t) || isVec(r.t)) { l = this.vlogic(l, r, '||'); continue; } l = { c: '((' + this.truth(l) + '||' + this.truth(r) + ')?1:0)', t: 'int' }; } return l; }
        logAnd() { let l = this.bitOr(); while (this.is('&&')) { this.i++; const r = this.bitOr(); if (isVec(l.t) || isVec(r.t)) { l = this.vlogic(l, r, '&&'); continue; } l = { c: '((' + this.truth(l) + '&&' + this.truth(r) + ')?1:0)', t: 'int' }; } return l; }
        bitOr() { let l = this.bitXor(); while (this.is('|')) { this.i++; l = this.binop('|', l, this.bitXor()); } return l; }
        bitXor() { let l = this.bitAnd(); while (this.is('^')) { this.i++; l = this.binop('^', l, this.bitAnd()); } return l; }
        bitAnd() { let l = this.eq(); while (this.is('&')) { this.i++; l = this.binop('&', l, this.eq()); } return l; }
        eq() { let l = this.rel(); while (this.is('==') || this.is('!=')) { const o = this.tk.v; this.i++; l = this.binop(o, l, this.rel()); } return l; }
        rel() { let l = this.shift(); while (this.is('<') || this.is('>') || this.is('<=') || this.is('>=')) { const o = this.tk.v; this.i++; l = this.binop(o, l, this.shift()); } return l; }
        shift() { let l = this.add(); while (this.is('<<') || this.is('>>')) { const o = this.tk.v; this.i++; l = this.binop(o, l, this.add()); } return l; }
        add() { let l = this.mul(); while (this.is('+') || this.is('-')) { const o = this.tk.v; this.i++; l = this.binop(o, l, this.mul()); } return l; }
        mul() { let l = this.unary(); while (this.is('*') || this.is('/') || this.is('%')) { const o = this.tk.v; this.i++; l = this.binop(o, l, this.unary()); } return l; }

        vlogic(a, b, op) {
            const vt = isVec(a.t) ? a.t : b.t, n = vt.n;
            return { c: '$rt.' + (isVec(a.t) && isVec(b.t) ? 'vz' : isVec(a.t) ? 'vzr' : 'vzl') + '(' + conv(a.c, a.t, isVec(a.t) ? a.t : a.t) + ',' + conv(b.c, b.t, isVec(b.t) ? b.t : b.t) + ',($x,$y)=>(($x!==0' + op + '$y!==0)?-1:0))', t: { v: cmpBase(vt.v), n } };
        }
        binop(op, a, b) {
            if (isVec(a.t) || isVec(b.t)) return this.vbinop(op, a, b);
            // 指標運算
            if (isPtr(a.t) || isPtr(b.t)) {
                if (op === '+' || op === '-') {
                    if (isPtr(a.t) && isInt(b.t)) return { c: '$rt.padd(' + a.c + ',' + (op === '-' ? '-' : '') + '(' + b.c + '),' + (a.t.p === 'void' ? 1 : this.sz(a.t.p)) + ')', t: a.t };
                    if (op === '+' && isInt(a.t) && isPtr(b.t)) return { c: '$rt.padd(' + b.c + ',(' + a.c + '),' + this.sz(b.t.p) + ')', t: b.t };
                    if (op === '-' && isPtr(a.t) && isPtr(b.t)) return { c: '$rt.pdiff(' + a.c + ',' + b.c + ',' + this.sz(a.t.p) + ')', t: 'long' };
                }
                if (['==', '!=', '<', '>', '<=', '>='].includes(op) && isPtr(a.t) && isPtr(b.t)) return { c: '$rt.pcmp(' + a.c + ',' + b.c + ',' + JSON.stringify(op) + ')', t: 'int' };
                this.err('指標不支援這個運算：' + op);
            }
            if (['<<', '>>'].includes(op)) {   // 移位：結果型別是提升後的左運算元型別
                const lt = promote(a.t); if (isFloat(lt) || isFloat(b.t)) this.err('浮點數不能移位');
                const bc = conv(b.c, b.t, 'int'), ac = conv(a.c, a.t, lt);
                if (lt === 'int') return { c: '(' + ac + (op === '<<' ? '<<' : '>>') + '(' + bc + '&31))', t: 'int' };
                if (lt === 'uint') return { c: '(' + (op === '<<' ? '((' + ac + '<<(' + bc + '&31))>>>0)' : '(' + ac + '>>>(' + bc + '&31))') + ')', t: 'uint' };
                return { c: '$rt.' + (op === '<<' ? 'shl64' : 'shr64') + '(' + ac + ',' + bc + ',' + (lt === 'ulong' ? 1 : 0) + ')', t: lt };
            }
            const t = common(promote(a.t), promote(b.t)); const ac = conv(a.c, a.t, t), bc = conv(b.c, b.t, t);
            if (['==', '!=', '<', '>', '<=', '>='].includes(op)) return { c: '((' + ac + (op === '==' ? '===' : op === '!=' ? '!==' : op) + bc + ')?1:0)', t: 'int' };
            if (['&', '|', '^'].includes(op)) {
                if (isFloat(t)) this.err('浮點數不能做位元運算');
                if (t === 'int') return { c: '(' + ac + op + bc + ')', t };
                if (t === 'uint') return { c: '((' + ac + op + bc + ')>>>0)', t };
                return { c: '$rt.bit64(' + ac + ',' + bc + ',' + JSON.stringify(op) + ',' + (t === 'ulong' ? 1 : 0) + ')', t };
            }
            if (op === '%' && isFloat(t)) this.err('% 不能用在浮點數（用 fmod）');
            const F = t === 'float';
            switch (op) {
                case '+': case '-':
                    if (t === 'int') return { c: '((' + ac + op + bc + ')|0)', t };
                    if (t === 'uint') return { c: '((' + ac + op + bc + ')>>>0)', t };
                    if (F) return { c: 'Math.fround(' + ac + op + bc + ')', t };
                    return { c: '(' + ac + op + bc + ')', t };
                case '*':
                    if (t === 'int') return { c: 'Math.imul(' + ac + ',' + bc + ')', t };
                    if (t === 'uint') return { c: '(Math.imul(' + ac + ',' + bc + ')>>>0)', t };
                    if (F) return { c: 'Math.fround(' + ac + '*' + bc + ')', t };
                    return { c: '(' + ac + '*' + bc + ')', t };
                case '/':
                    if (t === 'int') return { c: '$rt.idiv(' + ac + ',' + bc + ')', t };
                    if (t === 'uint') return { c: '($rt.idiv(' + ac + ',' + bc + ')>>>0)', t };
                    if (t === 'long' || t === 'ulong') return { c: '$rt.ldiv(' + ac + ',' + bc + ')', t };
                    if (F) return { c: 'Math.fround(' + ac + '/' + bc + ')', t };
                    return { c: '(' + ac + '/' + bc + ')', t };
                case '%':
                    if (t === 'int') return { c: '$rt.imod(' + ac + ',' + bc + ')', t };
                    if (t === 'uint') return { c: '($rt.imod(' + ac + ',' + bc + ')>>>0)', t };
                    return { c: '$rt.lmod(' + ac + ',' + bc + ')', t };
                default: return this.err('不支援的運算子 ' + op);
            }
        }

        unary() {
            const x = this.tk;
            if (!x) this.err('運算式不完整');
            if (x.t === 'p') {
                switch (x.v) {
                    case '+': { this.i++; const e = this.unary(); if (isVec(e.t)) return e; const t = promote(e.t); return { c: conv(e.c, e.t, t), t }; }
                    case '-': {
                        this.i++; const e = this.unary(); if (isVec(e.t)) { const b = promote(e.t.v), neg = b === 'int' ? '((-$x)|0)' : b === 'uint' ? '((-$x)>>>0)' : '(-$x)'; return { c: '$rt.vm(' + conv(e.c, e.t, { v: b, n: e.t.n }) + ',($x)=>' + neg + ')', t: { v: b, n: e.t.n } }; }
                        const t = promote(e.t);
                        if (isPtr(t)) this.err('指標不能取負');
                        const c = conv(e.c, e.t, t); return { c: t === 'int' ? '((-' + c + ')|0)' : t === 'uint' ? '((-' + c + ')>>>0)' : '(-' + c + ')', t };
                    }
                    case '!': { this.i++; const e = this.unary(); if (isVec(e.t)) return { c: '$rt.vm(' + e.c + ',($x)=>($x===0?-1:0))', t: { v: cmpBase(e.t.v), n: e.t.n } }; return { c: '(' + this.truth(e) + '?0:1)', t: 'int' }; }
                    case '~': { this.i++; const e = this.unary(); if (isVec(e.t)) { const b = promote(e.t.v); if (isFloat(b)) this.err('~ 只能用在整數向量'); const bn = b === 'int' ? '(~$x)' : b === 'uint' ? '((~$x)>>>0)' : '$rt.bit64($x,0,"~",' + (b === 'ulong' ? 1 : 0) + ')'; return { c: '$rt.vm(' + conv(e.c, e.t, { v: b, n: e.t.n }) + ',($x)=>' + bn + ')', t: { v: b, n: e.t.n } }; } const t = promote(e.t); if (isFloat(t) || isPtr(t)) this.err('~ 只能用在整數'); const c = conv(e.c, e.t, t); return { c: t === 'int' ? '(~' + c + ')' : t === 'uint' ? '((~' + c + ')>>>0)' : '$rt.bit64(' + c + ',0,"~",' + (t === 'ulong' ? 1 : 0) + ')', t }; }
                    case '*': { this.i++; const e = this.unary(); if (!isPtr(e.t)) this.err('* 的運算對象不是指標'); if (e.t.p === 'void') this.err('不能取 void* 的內容'); if (isStruct(e.t.p)) return { c: e.c, t: e.t.p, lv: { kind: 'struct', ptr: e.c } }; return { c: this.ldc(e.t.p, e.c, '0'), t: e.t.p, lv: { kind: 'mem', p: e.c, i: '0', et: e.t.p } }; }
                    case '&': {
                        this.i++; const e = this.unary(); if (e.lv && e.lv.kind === 'struct') return { c: e.lv.ptr, t: { p: e.t } };
                        if (e.lv && e.lv.kind === 'var' && (typeof e.t === 'string' || isVec(e.t))) return { c: '{r:()=>' + e.lv.js + ',w:($v)=>(' + e.lv.js + '=$v)}', t: { p: e.t, ref: true } };   // 局部純量／向量的位址：用閉包當「引用指標」
                        if (!e.lv || e.lv.kind !== 'mem') this.err('& 只能取緩衝區元素或 struct 的位址（不支援取純量區域變數的位址）');
                        return { c: '$rt.padd(' + e.lv.p + ',' + e.lv.i + ',' + this.sz(e.lv.et) + ')', t: { p: e.lv.et } };
                    }
                    case '++': case '--': {
                        this.i++; const e = this.unary(); if (!e.lv) this.err(x.v + ' 的對象不可指定');
                        const pre = [], lv = this.stable(e, pre); const cur = this.read(lv);
                        const nv = isPtr(lv.t) ? '$rt.padd(' + cur.c + ',' + (x.v === '++' ? '1' : '-1') + ',' + this.sz(lv.t.p) + ')' : conv(this.binop(x.v === '++' ? '+' : '-', cur, { c: '1', t: 'int' }).c, common(promote(lv.t), 'int'), lv.t);
                        return { c: '(' + pre.concat([this.write(lv, nv)]).join(',') + ')', t: lv.t };
                    }
                    case '(':
                        if (this.isTypeStart(1)) {   // 轉型
                            this.i++; const t = this.parseTypeName(); this.need(')');
                            if (this.is('{')) this.err('複合字面值不支援');
                            if (isVec(t) && this.is('(')) {   // (float4)(a, b, c, d)
                                this.i++; const as = []; if (!this.is(')')) for (;;) { as.push(this.assign()); if (!this.eat(',')) break; } this.need(')'); return this.vecCtor(t, as);
                            }
                            const e = this.unary(); return this.cast(e, t);
                        }
                        break;
                    default: break;
                }
            }
            if (x.t === 'id' && x.v === 'sizeof') {
                this.i++; let t;
                if (this.is('(') && this.isTypeStart(1)) { this.i++; t = this.parseTypeName(); this.need(')'); } else { const e = this.unary(); t = e.t; }
                return { c: String(isPtr(t) ? 8 : this.sz(t) || this.err('sizeof 的型別不支援')), t: 'ulong' };
            }
            return this.postfix();
        }
        cast(e, t) {
            if (isPtr(t)) {
                if (isPtr(e.t)) { const sz = t.p === 'void' ? 1 : isVec(t.p) ? SIZE[t.p.v] : this.sz(t.p); return { c: sz > 1 ? '$rt.pchk(' + e.c + ',' + sz + ')' : e.c, t }; }
                if (e.c === '0') return { c: 'null', t };
                this.err('數值不能轉成指標');
            }
            if (isPtr(e.t)) this.err('指標不能轉成數值');
            if (t === 'void') return { c: '(' + e.c + ',0)', t: 'void' };
            return { c: conv(e.c, e.t, t), t };
        }
        postfix() {
            let e = this.primary();
            for (;;) {
                if (this.is('[')) {
                    this.i++; const idx = this.expr(); this.need(']'); if (!isPtr(e.t)) this.err('[] 的對象不是指標或陣列'); if (!isInt(promote(idx.t))) this.err('索引要是整數');
                    if (e.t.dims && e.t.dims.length > 1) {   // 多維陣列：先取列（指標運算），型別少一維
                        const stride = e.t.dims.slice(1).reduce((x, y) => x * y, 1), rest = e.t.dims.slice(1);
                        e = { c: '$rt.padd(' + e.c + ',' + conv(idx.c, idx.t, 'long') + '*' + stride + ',' + this.sz(e.t.p) + ')', t: rest.length > 1 ? { p: e.t.p, dims: rest } : { p: e.t.p } }; continue;
                    }
                    if (e.t.p === 'void') this.err('不能對 void* 取索引');
                    if (isStruct(e.t.p)) { const ptr = '$rt.padd(' + e.c + ',' + conv(idx.c, idx.t, 'long') + ',' + this.sz(e.t.p) + ')'; e = { c: ptr, t: e.t.p, lv: { kind: 'struct', ptr } }; continue; }
                    e = { c: this.ldc(e.t.p, e.c, conv(idx.c, idx.t, 'long')), t: e.t.p, lv: { kind: 'mem', p: e.c, i: conv(idx.c, idx.t, 'long'), et: e.t.p } };
                } else if (this.is('++') || this.is('--')) {
                    const op = this.tk.v; this.i++; if (!e.lv) this.err(op + ' 的對象不可指定');
                    const pre = [], lv = this.stable(e, pre), tmp = this.newTmp(); const cur = this.read(lv);
                    const nv = isPtr(lv.t) ? '$rt.padd(' + tmp + ',' + (op === '++' ? '1' : '-1') + ',' + this.sz(lv.t.p) + ')' : conv(this.binop(op === '++' ? '+' : '-', { c: tmp, t: lv.t }, { c: '1', t: 'int' }).c, common(promote(lv.t), 'int'), lv.t);
                    e = { c: '(' + pre.concat([tmp + '=' + cur.c, this.write(lv, nv), tmp]).join(',') + ')', t: lv.t };
                } else if (this.is('.') || this.is('->')) { const arrow = this.tk.v === '->'; this.i++; const f = this.tk; if (!f || f.t !== 'id') this.err('這裡需要成員名稱'); this.i++; e = this.member(e, f.v, arrow); }
                else break;
            }
            return e;
        }
        primary() {
            const x = this.tk; if (!x) this.err('運算式不完整');
            if (x.t === 'num') { this.i++; return this.number(x); }
            if (x.t === 'chr') { this.i++; const s = x.v.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\0/g, '\0').replace(/\\(.)/g, '$1'); return { c: String(s.charCodeAt(0) | 0), t: 'int' }; }
            if (x.t === 'str') this.err('字串不支援');
            if (x.t === 'p' && x.v === '(') { this.i++; const e = this.expr(); this.need(')'); return e.lv ? { c: '(' + e.c + ')', t: e.t, lv: e.lv } : { c: '(' + e.c + ')', t: e.t }; }
            if (x.t === 'id') {
                this.i++;
                if (this.is('(')) return this.callExpr(x);
                if (this.enums.has(x.v) && !this.look(x.v)) return { c: String(this.enums.get(x.v)), t: 'int' };
                const v = this.look(x.v); if (!v) fail(this.badGlobals.has(x.v) ? '全域變數 ' + x.v + ' 不能用（它的定義不支援：' + this.badGlobals.get(x.v) + '）' : '未宣告的名稱 ' + x.v, x.line);
                if (isStruct(v.type)) return { c: v.js, t: v.type, lv: { kind: 'struct', ptr: v.js } };
                return { c: v.js, t: v.type, lv: { kind: 'var', js: v.js } };
            }
            return this.err('不認得的運算式「' + x.v + '」');
        }
        number(x) {
            const s = x.v; let m;
            if ((m = /^(0[xX][0-9a-fA-F]+)([uUlL]*)$/.exec(s)) || (m = /^(\d+)([uUlL]*)$/.exec(s))) {
                const v = Number(/^0[xX]/.test(m[1]) ? BigInt(m[1]) : BigInt(m[1])); const suf = m[2].toLowerCase(); const u = suf.includes('u'), l = suf.includes('l');
                const t = l ? (u ? 'ulong' : 'long') : u ? (v > 0xFFFFFFFF ? 'ulong' : 'uint') : v > 0x7FFFFFFF ? (v > 0xFFFFFFFF || !/^0[xX]/.test(m[1]) ? 'long' : 'uint') : 'int';
                return { c: String(v), t };
            }
            if ((m = /^((?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)([fF]?)$/.exec(s))) {
                const v = Number(m[1]); if (m[2]) return { c: String(Math.fround(v)), t: 'float' };
                return { c: String(v), t: 'double' };
            }
            return this.err('數字格式不支援：' + s);
        }

        callExpr(nameTok) {
            const name = nameTok.v; this.need('('); const args = [];
            if (!this.is(')')) for (;;) { args.push(this.assign()); if (!this.eat(',')) break; }
            this.need(')');
            return this.builtinCall(name, args, nameTok.line);
        }
        // 向量相關的內建函式：vloadN／vstoreN、convert_*、as_*、dot／length／distance／normalize／cross、any／all、select、shuffle、逐分量的數學函式
        vecBuiltin(name, args, line) {
            let m; const vec = args.some((a) => isVec(a.t));
            if ((m = /^vload(2|3|4|8|16)$/.exec(name))) {
                const n = Number(m[1]), pt = args[1] && args[1].t; if (args.length !== 2 || !isPtr(pt) || !SCALARS.includes(pt.p)) fail(name + '(offset, 純量指標)', line);
                return { c: '$rt.vloadn(' + args[1].c + ',' + conv(args[0].c, args[0].t, 'long') + ',' + n + ',' + JSON.stringify(VIEW[pt.p]) + ')', t: { v: pt.p, n } };
            }
            if ((m = /^vstore(2|3|4|8|16)$/.exec(name))) {
                const n = Number(m[1]), pt = args[2] && args[2].t; if (args.length !== 3 || !isPtr(pt) || !SCALARS.includes(pt.p) || !isVec(args[0].t) || args[0].t.n !== n) fail(name + '(資料向量, offset, 純量指標)', line);
                return { c: '$rt.vstoren(' + conv(args[0].c, args[0].t, { v: pt.p, n }) + ',' + conv(args[1].c, args[1].t, 'long') + ',' + args[2].c + ',' + n + ',' + JSON.stringify(VIEW[pt.p]) + ')', t: 'void' };
            }
            if ((m = /^convert_(char|uchar|short|ushort|int|uint|long|ulong|float|double)(2|3|4|8|16)?((?:_(?:sat|rte|rtz|rtp|rtn))*)$/.exec(name))) {
                const to = m[1], n = m[2] ? Number(m[2]) : 0, mods = m[3], a = args[0]; if (args.length !== 1) fail(name + ' 需要 1 個引數', line);
                const RANGE = { char: [-128, 127], uchar: [0, 255], short: [-32768, 32767], ushort: [0, 65535], int: [-2147483648, 2147483647], uint: [0, 4294967295], long: [-9223372036854775808, 9223372036854775807], ulong: [0, 18446744073709551615] };
                const f = (x, from) => {
                    let c = x, ft = from;
                    if (isFloat(from) && isInt(to)) { c = mods.includes('rte') ? '$rint(' + c + ')' : mods.includes('rtp') ? 'Math.ceil(' + c + ')' : mods.includes('rtn') ? 'Math.floor(' + c + ')' : 'Math.trunc(' + c + ')'; ft = 'double'; }
                    if (mods.includes('sat') && isInt(to) && RANGE[to]) c = '$rt.sat(' + c + ',' + RANGE[to][0] + ',' + RANGE[to][1] + ')';
                    return conv(c, ft, to);
                };
                if (n) { if (!isVec(a.t) || a.t.n !== n) fail(name + ' 的引數要是 ' + n + ' 個元素的向量', line); return { c: '$rt.vm(' + a.c + ',($x)=>' + f('$x', a.t.v) + ')', t: { v: to, n } }; }
                if (isVec(a.t)) fail(name + ' 的結果是純量，引數不能是向量（用 convert_' + to + a.t.n + '）', line);
                return { c: f(a.c, a.t), t: to };
            }
            if ((m = /^as_(char|uchar|short|ushort|int|uint|long|ulong|float|double)(2|3|4|8|16)?$/.exec(name))) {
                const to = m[1], n = m[2] ? Number(m[2]) : 0, a = args[0], ft = isVec(a.t) ? a.t.v : a.t, fn = isVec(a.t) ? a.t.n : 0;
                if (!SCALARS.includes(ft)) fail(name + ' 的引數要是數值或向量', line);
                if (SIZE[ft] * vstride(fn || 1) !== SIZE[to] * vstride(n || 1)) fail(name + '：來源（' + tstr(a.t) + '）與目標的位元組數不同', line);
                return { c: '$rt.vas(' + a.c + ',' + JSON.stringify(VIEW[ft]) + ',' + fn + ',' + JSON.stringify(VIEW[to]) + ',' + n + ')', t: n ? { v: to, n } : to };
            }
            if (!vec) return null;
            const V = args.find((a) => isVec(a.t)).t, fl = (t) => (isFloat(t) ? t : 'float');
            if (name === 'dot' && args.length === 2 && isVec(args[0].t) && isVec(args[1].t)) { const b = fl(V.v); return { c: '$rt.vdot(' + conv(args[0].c, args[0].t, { v: b, n: V.n }) + ',' + conv(args[1].c, args[1].t, { v: b, n: V.n }) + ',' + (b === 'float' ? 1 : 0) + ')', t: b }; }
            if ((name === 'length' || name === 'fast_length') && args.length === 1) { const b = fl(V.v); return { c: '$rt.vlen(' + conv(args[0].c, args[0].t, { v: b, n: V.n }) + ',' + (b === 'float' ? 1 : 0) + ')', t: b }; }
            if ((name === 'distance' || name === 'fast_distance') && args.length === 2) { const b = fl(V.v), vt = { v: b, n: V.n }; return { c: '$rt.vlen($rt.vz(' + conv(args[0].c, args[0].t, vt) + ',' + conv(args[1].c, args[1].t, vt) + ',($x,$y)=>$x-$y),' + (b === 'float' ? 1 : 0) + ')', t: b }; }
            if ((name === 'normalize' || name === 'fast_normalize') && args.length === 1) { const b = fl(V.v); return { c: '$rt.vnorm(' + conv(args[0].c, args[0].t, { v: b, n: V.n }) + ',' + (b === 'float' ? 1 : 0) + ')', t: { v: b, n: V.n } }; }
            if (name === 'cross' && args.length === 2) { if (V.n !== 3 && V.n !== 4) fail('cross 只有 3 或 4 個元素的向量', line); const b = fl(V.v), vt = { v: b, n: V.n }; return { c: '$rt.vcross(' + conv(args[0].c, args[0].t, vt) + ',' + conv(args[1].c, args[1].t, vt) + ',' + (b === 'float' ? 1 : 0) + ')', t: vt }; }
            if ((name === 'any' || name === 'all') && args.length === 1) return { c: '$rt.v' + name + '(' + args[0].c + ')', t: 'int' };
            if (name === 'select' && args.length === 3) { const vt = isVec(args[0].t) ? args[0].t : args[1].t; return { c: '$rt.vselect(' + conv(args[0].c, args[0].t, vt) + ',' + conv(args[1].c, args[1].t, vt) + ',' + args[2].c + ')', t: vt }; }
            if ((name === 'shuffle' && args.length === 2) || (name === 'shuffle2' && args.length === 3)) {
                const mk = args[args.length - 1].t; if (!isVec(mk) || ![2, 3, 4, 8, 16].includes(mk.n)) fail(name + ' 的遮罩要是整數向量', line);
                return { c: '$rt.vshuffle([' + args.slice(0, -1).map((a) => a.c).join(',') + '],' + args[args.length - 1].c + ',' + V.n + ')', t: { v: V.v, n: mk.n } };
            }
            if (['isnan', 'isinf', 'isfinite', 'signbit'].includes(name)) { const f = { isnan: 'Number.isNaN', isinf: '$isinf', isfinite: 'Number.isFinite', signbit: '$signbit' }[name]; return { c: '$rt.vm(' + args[0].c + ',($x)=>-(' + f + '($x)?1:0))', t: { v: cmpBase(V.v), n: V.n } }; }
            const base = NATIVE.exec(name) ? NATIVE.exec(name)[2] : name;
            const comp = FLOAT_FN1[base] || FLOAT_FN2[base] || ['min', 'max', 'clamp', 'mix', 'fma', 'mad', 'abs', 'fabs', 'step', 'pown', 'rootn', 'ldexp', 'sign'].includes(base);
            if (!comp) { if (this.funcs.has(name)) return null; fail('內建函式 ' + name + ' 不支援向量引數', line); }
            for (const a of args) if (isVec(a.t) && a.t.n !== V.n) fail(name + ' 的向量引數長度要一致', line);
            const sc = args.map((a, k) => ({ c: '$a' + k, t: isVec(a.t) ? a.t.v : a.t })), r = this.builtinCall(name, sc, line);
            return { c: '$rt.vmapN((' + args.map((a, k) => '$a' + k).join(',') + ')=>' + r.c + ',[' + args.map((a) => a.c).join(',') + '],' + V.n + ')', t: { v: r.t, n: V.n } };
        }
        // 呼叫（內建函式或使用者函式）；args 已解析成 {c, t}。向量版的內建函式逐分量遞迴到這裡（引數換成純量）。
        builtinCall(name, args, line) {
            const vb = /^(?:read|write)_image|^get_image_/.test(name) ? null : this.vecBuiltin(name, args, line); if (vb) return vb;
            const W = (d) => '$W.' + WI[name] + '[' + d + ']';
            if (WI[name]) { if (args.length !== 1) fail(name + ' 需要 1 個引數', line); return { c: W(conv(args[0].c, args[0].t, 'int')), t: 'ulong' }; }
            if (name === 'get_work_dim') return { c: '$W.dim', t: 'uint' };
            if (name === 'barrier') fail('barrier 只能當成獨立的敘述（不能放在運算式裡）', line);
            const am = /^(?:atomic|atom)_(add|sub|inc|dec|xchg|cmpxchg|min|max|and|or|xor)$/.exec(name);
            if (am) {   // 工作項循序執行，所以原子操作就是「讀、改、寫，回傳舊值」
                const pt = args[0] && args[0].t; if (!isPtr(pt) || !['int', 'uint', 'long', 'ulong', 'float'].includes(pt.p)) fail(name + ' 的第一個引數要是 int／uint／long／ulong（float 只有 xchg）的指標', line);
                if (pt.p === 'float' && am[1] !== 'xchg') fail(name + ' 不支援 float（只有 atomic_xchg）', line);
                const rest = args.slice(1).map((a) => conv(a.c, a.t, pt.p));
                return { c: '$rt.atomic(' + JSON.stringify(am[1]) + ',' + args[0].c + ',' + JSON.stringify(pt.p) + ',' + (rest[0] || '0') + ',' + (rest[1] || '0') + ')', t: pt.p };
            }
            { const im = /^(read|write)_image(f|i|ui|h)$/.exec(name);
              if (im) {
                if (!args.length || !isImg(args[0].t)) fail(name + ' 的第一個引數要是圖像（image2d_t 等）', line);
                if (im[2] === 'h') fail(name + '（half）不支援', line);
                const K = JSON.stringify(im[2]), cd = (a) => (isVec(a.t) ? a.c : '[' + a.c + ']'), cf = (a) => (isVec(a.t) ? isFloat(a.t.v) : isFloat(a.t));
                if (im[1] === 'read') {
                    if (args.length === 3) { if (isPtr(args[2].t) || isStruct(args[2].t)) fail(name + ' 的座標要是整數或浮點數（向量）', line); return { c: '$rt.rimg(' + args[0].c + ',' + conv(args[1].c, args[1].t, 'uint') + ',' + cd(args[2]) + ',' + K + ',' + (cf(args[2]) ? 1 : 0) + ')', t: { v: im[2] === 'f' ? 'float' : im[2] === 'i' ? 'int' : 'uint', n: 4 } }; }
                    if (args.length === 2) return { c: '$rt.rimg(' + args[0].c + ',-1,' + cd(args[1]) + ',' + K + ',0)', t: { v: im[2] === 'f' ? 'float' : im[2] === 'i' ? 'int' : 'uint', n: 4 } };
                    fail(name + ' 需要 2 或 3 個引數', line);
                }
                if (args.length !== 3) fail(name + ' 需要 3 個引數（image, coord, value）', line);
                if (!isVec(args[2].t) || args[2].t.n !== 4) fail(name + ' 的值要是四分量向量（float4／int4／uint4）', line);
                return { c: '$rt.wimg(' + args[0].c + ',' + cd(args[1]) + ',' + args[2].c + ',' + K + ')', t: 'void' };
              }
              const gi = /^get_image_(width|height|depth|array_size|channel_data_type|channel_order|dim)$/.exec(name);
              if (gi) { if (args.length !== 1 || !isImg(args[0].t)) fail(name + ' 需要一個圖像引數', line); return { c: '$rt.gimg(' + args[0].c + ',' + JSON.stringify(gi[1]) + ')', t: gi[1] === 'dim' ? { v: 'int', n: args[0].t.im.indexOf('3d') >= 0 ? 4 : 2 } : 'int' }; } }
            { const pm = /^(?:(work_group_)?(?:reserve_)?)?(read|write)_pipe$|^(commit_(?:read|write)_pipe|reserve_(?:read|write)_pipe|get_pipe_num_packets|get_pipe_max_packets|is_valid_reserve_id)$/.exec(name);
              if (pm || /^work_group_(reserve|commit)_/.test(name) || /^sub_group_(reserve|commit)_/.test(name)) {
                if (/^(work|sub)_group_/.test(name)) fail(name + '（群組版 pipe 函式）不支援；用逐工作項的 reserve_*／read_pipe／write_pipe', line);
                if (name === 'is_valid_reserve_id') return { c: '((' + args[0].c + ')!==0?1:0)', t: 'int' };
                if (!args.length || !isPipe(args[0].t)) fail(name + ' 的第一個引數要是 pipe', line);
                const et = args[0].t.pipe, P = args[0].c, sz = this.sz(et);
                if (name === 'get_pipe_num_packets' || name === 'get_pipe_max_packets') return { c: '$rt.pipeinfo(' + P + ',' + (name === 'get_pipe_max_packets' ? 1 : 0) + ')', t: 'uint' };
                if (/^commit_/.test(name)) return { c: '(0)', t: 'void' };
                if (/^reserve_/.test(name)) return { c: '$rt.pipereserve(' + P + ',' + conv(args[1].c, args[1].t, 'uint') + ',' + (name === 'reserve_read_pipe' ? 0 : 1) + ')', t: 'uint' };
                const isRead = name === 'read_pipe';   // read_pipe(p, ptr) 或 read_pipe(p, reserve_id, index, ptr)
                if (args.length !== 2 && args.length !== 4) fail(name + ' 需要 2 或 4 個引數', line);
                const ptr = args[args.length - 1]; if (!isPtr(ptr.t)) fail(name + ' 的最後一個引數要是指標（例如 &v）', line);
                const cp = isStruct(et) ? (isRead ? '$rt.cpy(' + ptr.c + ',$q,' + sz + ')' : '$rt.cpy($q,' + ptr.c + ',' + sz + ')') : (isRead ? this.stc(et, ptr.c, '0', this.ldc(et, '$q', '0')) : this.stc(et, '$q', '0', this.ldc(et, ptr.c, '0')));
                const rid = args.length === 4 ? conv(args[1].c, args[1].t, 'uint') + ',' + conv(args[2].c, args[2].t, 'uint') : '0,0';
                return { c: '$rt.pipeop(' + P + ',' + sz + ',' + (isRead ? 0 : 1) + ',' + rid + ',' + (args.length === 4 ? 1 : 0) + ',($q)=>{' + cp + '})', t: 'int' };
              } }
            if (name === 'printf') fail('printf 不支援', line);
            { const m2 = /^(?:native_|half_)?(sincos|modf|fract)$/.exec(name);   // 第二個引數是輸出指標（常見：sincos(x, &c)）
              if (m2 && args.length === 2) { const pt = args[1].t; if (!isPtr(pt) || !isFloat(pt.p)) fail(name + ' 的第二個引數要是 float／double 指標（例如 &c）', line); const t = pt.p; return { c: '$rt.' + (m2[1] === 'fract' ? 'fract2' : m2[1]) + '(' + conv(args[0].c, args[0].t, t) + ',' + args[1].c + ',' + (t === 'float' ? 1 : 0) + ',' + JSON.stringify(VIEW[t]) + ')', t }; } }
            let base = name; const nm = NATIVE.exec(name); if (nm) base = nm[2];
            const genT = (xs) => (xs.some((a) => a.t === 'double') ? 'double' : 'float');
            const wrapF = (t, c) => (t === 'float' ? 'Math.fround(' + c + ')' : c);
            if (FLOAT_FN1[base] && args.length === 1) {
                if (isPtr(args[0].t)) fail(base + ' 的引數不能是指標', line);
                const t = isFloat(args[0].t) ? args[0].t : 'float'; return { c: wrapF(t, FLOAT_FN1[base] + '(' + conv(args[0].c, args[0].t, t) + ')'), t };
            }
            if (base === 'fabs' || base === 'abs') {
                const t = args[0].t; if (isFloat(t)) return { c: 'Math.abs(' + args[0].c + ')', t };
                const ut = { char: 'uchar', short: 'ushort', int: 'uint', long: 'ulong' }[promote(t)] || promote(t); return { c: conv('Math.abs(' + args[0].c + ')', promote(t), ut), t: ut };
            }
            if (FLOAT_FN2[base] && args.length === 2) { const t = genT(args); return { c: wrapF(t, FLOAT_FN2[base] + '(' + conv(args[0].c, args[0].t, t) + ',' + conv(args[1].c, args[1].t, t) + ')'), t }; }
            if (base === 'pown' || base === 'rootn') { const t = genT([args[0]]); return { c: wrapF(t, (base === 'pown' ? 'Math.pow(' : '$rootn(') + conv(args[0].c, args[0].t, t) + ',' + args[1].c + ')'), t }; }
            if (base === 'fma' || base === 'mad') { const t = genT(args); const [a, b, c] = args.map((x) => conv(x.c, x.t, t)); return { c: wrapF(t, '(' + a + '*' + b + '+' + c + ')'), t }; }
            if (base === 'min' || base === 'max') {
                if (args.length !== 2) fail(name + ' 需要 2 個引數', line); const t = common(promote(args[0].t), promote(args[1].t));
                return { c: wrapF(t, 'Math.' + base + '(' + conv(args[0].c, args[0].t, t) + ',' + conv(args[1].c, args[1].t, t) + ')'), t };
            }
            if (base === 'clamp') { const t = common(promote(args[0].t), common(promote(args[1].t), promote(args[2].t))); const [x, lo, hi] = args.map((a) => conv(a.c, a.t, t)); return { c: wrapF(t, 'Math.min(Math.max(' + x + ',' + lo + '),' + hi + ')'), t }; }
            if (base === 'mix') { const t = genT(args); const [x, y, a] = args.map((p) => conv(p.c, p.t, t)); return { c: wrapF(t, '(' + x + '+(' + y + '-' + x + ')*' + a + ')'), t }; }
            if (base === 'select') { const t = common(promote(args[0].t), promote(args[1].t)); return { c: '(' + this.truth(args[2]) + '?' + conv(args[1].c, args[1].t, t) + ':' + conv(args[0].c, args[0].t, t) + ')', t }; }
            if (base === 'isnan' || base === 'isinf' || base === 'isfinite') { const f = { isnan: 'Number.isNaN', isinf: '$isinf', isfinite: 'Number.isFinite' }[base]; return { c: '(' + f + '(' + args[0].c + ')?1:0)', t: 'int' }; }
            if (base === 'ldexp') { const t = genT([args[0]]); return { c: wrapF(t, '(' + conv(args[0].c, args[0].t, t) + '*Math.pow(2,' + args[1].c + '))'), t }; }
            if (base === 'mad24' || base === 'mul24') fail(name + ' 不支援', line);
            // 使用者函式
            const f = this.funcs.get(name); if (!f) fail('未宣告的函式 ' + name + '（不支援的內建函式，或需要先定義）', line);
            if (f.bad) fail('函式 ' + name + ' 不能用（它的定義不支援：' + f.bad + '）', line);
            if (f.ptypes && args.length !== f.ptypes.length) fail('函式 ' + name + ' 需要 ' + f.ptypes.length + ' 個引數，得到 ' + args.length, line);
            const cargs = args.map((a, k) => { if (!f.ptypes) return a.c; const c = this.coerce(a, f.ptypes[k]); return isStruct(f.ptypes[k]) ? '$rt.clone(' + c + ',' + this.sz(f.ptypes[k]) + ')' : c; });
            return { c: this.gen ? '(yield* f_' + name + '(' + cargs.join(',') + '))' : 'f_' + name + '(' + cargs.join(',') + ')', t: f.ret };
        }
    }

    // ======================================================================================
    // 執行期（生成的程式用的輔助函式與記憶體模型）
    // ======================================================================================
    function runtime() {
        const viewCache = new WeakMap();
        function views(ab) {
            let v = viewCache.get(ab); if (v) return v;
            const n = ab.byteLength;
            v = { ab, i8: new Int8Array(ab, 0, n), u8: new Uint8Array(ab, 0, n), i16: new Int16Array(ab, 0, n >> 1), u16: new Uint16Array(ab, 0, n >> 1), i32: new Int32Array(ab, 0, n >> 2), u32: new Uint32Array(ab, 0, n >> 2), f32: new Float32Array(ab, 0, n >> 2), f64: new Float64Array(ab, 0, n >> 3), i64: new BigInt64Array(ab, 0, n >> 3), u64: new BigUint64Array(ab, 0, n >> 3) };
            viewCache.set(ab, v); return v;
        }
        const rt = {
            mkptr: (ab) => ({ v: views(ab), o: 0 }),
            alloc: (n) => rt.mkptr(new ArrayBuffer(Math.max(8, (n + 7) & ~7))),
            atomic: (op, p, ty, a, b) => {
                const V = p.v[VIEW[ty]], i = p.o >> SHIFT[SIZE[ty]]; p.v.w = true;
                if (ty === 'long' || ty === 'ulong') {   // 64 位元：BigInt
                    const old = V[i], x = BigInt(Math.trunc(a)), y = BigInt(Math.trunc(b)); let nv;
                    switch (op) { case 'add': nv = old + x; break; case 'sub': nv = old - x; break; case 'inc': nv = old + 1n; break; case 'dec': nv = old - 1n; break; case 'xchg': nv = x; break; case 'cmpxchg': nv = old === x ? y : old; break; case 'min': nv = old < x ? old : x; break; case 'max': nv = old > x ? old : x; break; case 'and': nv = old & x; break; case 'or': nv = old | x; break; default: nv = old ^ x; }
                    V[i] = ty === 'long' ? BigInt.asIntN(64, nv) : BigInt.asUintN(64, nv); return Number(old);
                }
                const old = V[i]; let nv;
                switch (op) { case 'add': nv = old + a; break; case 'sub': nv = old - a; break; case 'inc': nv = old + 1; break; case 'dec': nv = old - 1; break; case 'xchg': nv = a; break; case 'cmpxchg': nv = old === a ? b : old; break; case 'min': nv = Math.min(old, a); break; case 'max': nv = Math.max(old, a); break; case 'and': nv = old & a; break; case 'or': nv = old | a; break; default: nv = old ^ a; }
                V[i] = nv; return old;
            },
            copy: (dst, src, n) => { dst.v.u8.copyWithin !== undefined && dst.v.u8.set(src.v.u8.slice(src.o, src.o + n), dst.o); dst.v.w = true; return dst; },
            clone: (p, n) => { const q = rt.alloc(n); q.v.u8.set(p.v.u8.slice(p.o, p.o + n), 0); return q; },
            // ---- 向量（值是 JS 陣列，運算不就地修改，所以共用同一個陣列是安全的）
            vm: (a, f) => a.map((x) => f(x)), vbc: (x, n) => new Array(n).fill(x),
            vz: (a, b, f) => a.map((x, i) => f(x, b[i])), vzr: (a, s, f) => a.map((x) => f(x, s)), vzl: (s, a, f) => a.map((x) => f(s, x)),
            vmapN: (f, args, n) => { const r = new Array(n); for (let i = 0; i < n; i++) r[i] = f(...args.map((a) => (Array.isArray(a) ? a[i] : a))); return r; },
            vsel: (c, a, b) => c.map((x, i) => (x < 0 ? a[i] : b[i])),
            vld: (p, i, view, n) => { if (p.r) return p.r(); const V = p.v[view], b = (p.o >> SHIFT_OF_VIEW[view]) + i * (n === 3 ? 4 : n), big = view === 'i64' || view === 'u64', r = new Array(n); for (let k = 0; k < n; k++) r[k] = big ? Number(V[b + k]) : V[b + k]; return r; },
            vst: (p, i, view, n, a) => { if (p.w) { p.w(a); return a; } const V = p.v[view], b = (p.o >> SHIFT_OF_VIEW[view]) + i * (n === 3 ? 4 : n), big = view === 'i64' || view === 'u64'; p.v.w = true; for (let k = 0; k < n; k++) V[b + k] = big ? BigInt(Math.trunc(a[k])) : a[k]; return a; },
            vloadn: (p, off, n, view) => { const V = p.v[view], b = (p.o >> SHIFT_OF_VIEW[view]) + off * n, big = view === 'i64' || view === 'u64', r = new Array(n); for (let k = 0; k < n; k++) r[k] = big ? Number(V[b + k]) : V[b + k]; return r; },
            vstoren: (a, off, p, n, view) => { const V = p.v[view], b = (p.o >> SHIFT_OF_VIEW[view]) + off * n, big = view === 'i64' || view === 'u64'; p.v.w = true; for (let k = 0; k < n; k++) V[b + k] = big ? BigInt(Math.trunc(a[k])) : a[k]; return 0; },
            vas: (x, fromView, fromN, toView, toN) => {   // 位元重新解讀（as_floatN 等）
                const C = { i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array, f32: Float32Array, f64: Float64Array, i64: BigInt64Array, u64: BigUint64Array };
                const buf = new ArrayBuffer(128), F = new C[fromView](buf), T = new C[toView](buf), bigF = fromView === 'i64' || fromView === 'u64', bigT = toView === 'i64' || toView === 'u64';
                (fromN ? x : [x]).forEach((v, k) => { F[k] = bigF ? BigInt(Math.trunc(v)) : v; });
                const out = Array.from(T.subarray(0, toN || 1), (v) => (bigT ? Number(v) : v)); return toN ? out : out[0];
            },
            vdot: (a, b, f) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return f ? Math.fround(s) : s; },
            vlen: (a, f) => { let s = 0; for (const x of a) s += x * x; return f ? Math.fround(Math.sqrt(s)) : Math.sqrt(s); },
            vnorm: (a, f) => { let s = 0; for (const x of a) s += x * x; const l = Math.sqrt(s); return a.map((x) => (l === 0 ? x : f ? Math.fround(x / l) : x / l)); },
            vcross: (a, b, f) => { const r = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; if (a.length === 4) r.push(0); return f ? r.map(Math.fround) : r; },
            vany: (a) => ((Array.isArray(a) ? a.some((x) => x < 0) : a < 0) ? 1 : 0), vall: (a) => ((Array.isArray(a) ? a.every((x) => x < 0) : a < 0) ? 1 : 0),
            vselect: (a, b, c) => (Array.isArray(c) ? a.map((x, i) => (c[i] < 0 ? b[i] : x)) : (c !== 0 ? b : a)),
            vshuffle: (vs, mask, n) => { const all = [].concat(...vs.map((v) => v.slice(0, n))); return mask.map((k) => all[k & (vs.length * n - 1)]); },
            sincos: (x, p, f, view) => { const c = Math.cos(x); rt['st_' + view](p, 0, f ? Math.fround(c) : c); const sn = Math.sin(x); return f ? Math.fround(sn) : sn; },
            modf: (x, p, f, view) => { const ip = Math.trunc(x); rt['st_' + view](p, 0, ip); const fr = x - ip; return f ? Math.fround(fr) : fr; },
            fract2: (x, p, f, view) => { const fl = Math.floor(x); rt['st_' + view](p, 0, fl); const fr = Math.min(x - fl, f ? 0.99999994 : 0.9999999999999999); return f ? Math.fround(fr) : fr; },
            $div: (a, b) => a / b, $recip: (x) => 1 / x,
            sat: (x, lo, hi) => (Number.isNaN(x) ? 0 : Math.min(Math.max(x, lo), hi)),
            $signbit: (x) => (x < 0 || Object.is(x, -0)),
            lmem: (key, bytes) => { const m = rt.$W.lm; let p = m.get(key); if (!p) { p = rt.alloc(bytes); m.set(key, p); } return p; },   // 工作群共享：同一個群的每個工作項拿到同一塊
            arr: (view, n, vals) => { const p = rt.alloc(n); for (let i = 0; i < vals.length; i++) rt['st_' + view](p, i, vals[i]); return p; },
            padd: (p, n, sz) => (p === null ? fail('空指標運算') : { v: p.v, o: p.o + n * sz }),
            pdiff: (a, b, sz) => (a.o - b.o) / sz,
            pcmp: (a, b, op) => { const x = a.o, y = b.o; return (op === '==' ? x === y : op === '!=' ? x !== y : op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y) ? 1 : 0; },
            pchk: (p, sz) => { if (p !== null && p.o % sz) throw new Error('指標轉型後位址未對齊（位元組偏移 ' + p.o + '，需要 ' + sz + ' 的倍數）'); return p; },
            idiv: (a, b) => (b === 0 ? 0 : (a / b) | 0),
            imod: (a, b) => (b === 0 ? 0 : (a % b) | 0),
            ldiv: (a, b) => (b === 0 ? 0 : Math.trunc(a / b)),
            lmod: (a, b) => (b === 0 ? 0 : a % b),
            $u64: (x) => (x < 0 ? x + 18446744073709551616 : x),
            shl64: (a, b, u) => { const r = BigInt.asUintN(64, BigInt(Math.trunc(a)) << BigInt(b & 63)); return Number(u ? r : BigInt.asIntN(64, r)); },
            shr64: (a, b, u) => Number(BigInt(Math.trunc(a)) >> BigInt(b & 63)),
            bit64: (a, b, op, u) => { const x = BigInt(Math.trunc(a)), y = BigInt(Math.trunc(b)); const r = op === '&' ? x & y : op === '|' ? x | y : op === '^' ? x ^ y : ~x; return Number(u ? BigInt.asUintN(64, r) : BigInt.asIntN(64, r)); },
            $exp2: (x) => Math.pow(2, x), $exp10: (x) => Math.pow(10, x), $rsqrt: (x) => 1 / Math.sqrt(x), $fmod: (a, b) => a % b, $rootn: (x, n) => Math.pow(x, 1 / n),
            $round: (x) => (x < 0 ? -Math.round(-x) : Math.round(x)), $rint: (x) => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; },
            $fract: (x) => x - Math.floor(x), $rad: (x) => x * Math.PI / 180, $deg: (x) => x * 180 / Math.PI, $copysign: (a, b) => (Math.sign(b) < 0 || Object.is(b, -0) ? -Math.abs(a) : Math.abs(a)),
            $fdim: (a, b) => (a > b ? a - b : 0), $step: (e, x) => (x < e ? 0 : 1), $remainder: (a, b) => a - b * rt.$rint(a / b), $isinf: (x) => x === Infinity || x === -Infinity
        };
        for (const [k, sh] of [['i8', 0], ['u8', 0], ['i16', 1], ['u16', 1], ['i32', 2], ['u32', 2], ['f32', 2], ['f64', 3]]) {
            rt['ld_' + k] = (p, i) => (p.r ? p.r() : p.v[k][(p.o >> sh) + i]);   // p.r：局部變數的引用指標（&x）
            rt['st_' + k] = (p, i, x) => { if (p.w) { p.w(x); return x; } p.v.w = true; p.v[k][(p.o >> sh) + i] = x; return x; };   // v.w：這個緩衝區被寫過（驅動據此只把真的被改的緩衝區標成已修改）
        }
        rt.ld_i64 = (p, i) => (p.r ? p.r() : Number(p.v.i64[(p.o >> 3) + i])); rt.st_i64 = (p, i, x) => { if (p.w) { p.w(x); return x; } p.v.w = true; p.v.i64[(p.o >> 3) + i] = BigInt(Math.trunc(x)); return x; };
        rt.ld_u64 = (p, i) => (p.r ? p.r() : Number(p.v.u64[(p.o >> 3) + i])); rt.st_u64 = (p, i, x) => { if (p.w) { p.w(x); return x; } p.v.w = true; p.v.u64[(p.o >> 3) + i] = BigInt.asUintN(64, BigInt(Math.trunc(x))); return x; };
        rt.$W = { lm: new Map(), g: [0, 0, 0], l: [0, 0, 0], grp: [0, 0, 0], gs: [1, 1, 1], ls: [1, 1, 1], ng: [1, 1, 1], off: [0, 0, 0], dim: 1 };
        return rt;
    }

    // 陣列大小等必須是編譯期常數的運算式：生成的程式碼只含數字與運算子（可帶 Math.imul 之類）才求值，否則回 null
    function constInt(code) {
        if (!/^[\w\s+\-*/%()<>|&^~,.]+$/.test(code)) return null;
        const bare = code.replace(/Math\.(imul|trunc|fround)/g, '');
        if (/[A-Za-z_$]/.test(bare)) return null;
        try { const v = Function('Math', 'return (' + code + ')')(Math); return Number.isInteger(v) && v >= 0 ? v : null; } catch (e) { return null; }
    }
    function bestDivisor(n, cap) { for (let d = Math.min(n, cap); d >= 1; d--) if (n % d === 0) return d; return 1; }

    // ---- 圖像執行期：meta＝{ type, w, h, d, order, chType, elem }（儲存是緊密排列：x 最快、其次 y、最後 z／層）
    function imageRuntime() {
        const f16 = new Float32Array(1), u32 = new Uint32Array(f16.buffer);
        const h2f = (h) => { const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? s * m * Math.pow(2, -24) : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * Math.pow(2, e - 15); };
        const f2h = (x) => { if (Number.isNaN(x)) return 0x7e00; f16[0] = x; const b = u32[0], s = (b >>> 16) & 0x8000; let e = ((b >>> 23) & 255) - 127 + 15, m = b & 0x7fffff; if (e >= 31) return s | 0x7c00; if (e <= 0) { if (e < -10) return s; m |= 0x800000; const sh = 14 - e; let r = m >> sh; if ((m >> (sh - 1)) & 1) r++; return s | r; } let r = (e << 10) | (m >> 13); if (m & 0x1000) r++; return s | r; };
        const CH = { R: 1, A: 1, RG: 2, RA: 2, RGB: 3, RGBA: 4, BGRA: 4, ARGB: 4, INTENSITY: 1, LUMINANCE: 1, Rx: 2, RGx: 3, RGBx: 4 };
        const HAS_A = new Set(['A', 'RA', 'RGBA', 'BGRA', 'ARGB', 'INTENSITY']);
        const info = (img) => { const m = img.img, ct = m.chType; return { m, nch: CH[m.order], isF: ct === 'FLOAT' || ct === 'HALF_FLOAT' || /^[SU]NORM/.test(ct), bits: /8$/.test(ct) ? 8 : /16$/.test(ct) ? 16 : 32 }; };
        // 解出一個像素 → [r,g,b,a]（浮點：UNORM／SNORM 換算成 [0,1]／[-1,1]；整數型別原值）
        const PACKED = { UNORM_SHORT_565: 1, UNORM_SHORT_555: 1, UNORM_INT_101010: 1 };
        function fetch(img, idx) {
            const { m, nch } = info(img), ct = m.chType, v = img.v, b = img.o + idx * m.elem, s = new Array(nch);
            if (PACKED[ct]) {   // 打包：565／555 佔 16 位元（r 在高位）；101010 佔 32 位元（高 2 位元填充，r 次高）
                if (ct === 'UNORM_INT_101010') { const x = rd32(v, b, 'u32'); return [((x >>> 20) & 1023) / 1023, ((x >>> 10) & 1023) / 1023, (x & 1023) / 1023, 1]; }
                const x = rd16(v, b, false); return ct === 'UNORM_SHORT_565' ? [(x >> 11) / 31, ((x >> 5) & 63) / 63, (x & 31) / 31, 1] : [((x >> 10) & 31) / 31, ((x >> 5) & 31) / 31, (x & 31) / 31, 1];
            }
            for (let c = 0; c < nch; c++) {
                switch (ct) {
                    case 'UNORM_INT8': s[c] = v.u8[b + c] / 255; break;
                    case 'SNORM_INT8': s[c] = Math.max(v.i8[b + c] / 127, -1); break;
                    case 'SIGNED_INT8': s[c] = v.i8[b + c]; break; case 'UNSIGNED_INT8': s[c] = v.u8[b + c]; break;
                    case 'UNORM_INT16': s[c] = rd16(v, b + 2 * c, false) / 65535; break;
                    case 'SNORM_INT16': s[c] = Math.max(rd16(v, b + 2 * c, true) / 32767, -1); break;
                    case 'SIGNED_INT16': s[c] = rd16(v, b + 2 * c, true); break; case 'UNSIGNED_INT16': s[c] = rd16(v, b + 2 * c, false); break;
                    case 'HALF_FLOAT': s[c] = h2f(rd16(v, b + 2 * c, false)); break;
                    case 'SIGNED_INT32': s[c] = rd32(v, b + 4 * c, 'i32'); break; case 'UNSIGNED_INT32': s[c] = rd32(v, b + 4 * c, 'u32'); break; case 'FLOAT': s[c] = rd32(v, b + 4 * c, 'f32'); break;
                    default: throw new Error('圖像通道型別 ' + ct + ' 不支援');
                }
            }
            switch (m.order) {
                case 'R': case 'Rx': return [s[0], 0, 0, 1]; case 'A': return [0, 0, 0, s[0]]; case 'RG': case 'RGx': return [s[0], s[1], 0, 1]; case 'RA': return [s[0], 0, 0, s[1]];
                case 'RGB': return [s[0], s[1], s[2], 1]; case 'RGBA': return [s[0], s[1], s[2], s[3]]; case 'BGRA': return [s[2], s[1], s[0], s[3]]; case 'ARGB': return [s[1], s[2], s[3], s[0]];
                case 'INTENSITY': return [s[0], s[0], s[0], s[0]]; case 'LUMINANCE': return [s[0], s[0], s[0], 1]; case 'RGBx': return [s[0], s[1], s[2], 1];
            }
            throw new Error('圖像通道順序 ' + m.order + ' 不支援');
        }
        const rd16 = (v, b, signed) => { const x = v.u8[b] | (v.u8[b + 1] << 8); return signed ? (x << 16) >> 16 : x; };
        const rd32 = (v, b, k) => { if ((b & 3) === 0) return v[k][b >> 2]; const t = new DataView(v.ab, b, 4); return k === 'i32' ? t.getInt32(0, true) : k === 'u32' ? t.getUint32(0, true) : t.getFloat32(0, true); };
        const wr16 = (v, b, x) => { v.u8[b] = x & 255; v.u8[b + 1] = (x >> 8) & 255; };
        const wr32 = (v, b, k, x) => { if ((b & 3) === 0) { v[k][b >> 2] = x; return; } const t = new DataView(v.ab, b, 4); if (k === 'i32') t.setInt32(0, x, true); else if (k === 'u32') t.setUint32(0, x >>> 0, true); else t.setFloat32(0, x, true); };
        const clampI = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
        const rnd = (x) => Math.round(x);   // 數值轉型用「四捨五入到最近偶數」更準；這裡取 JS 的 round（差在 .5 的負數），規格對 write_imagef 允許 ≤0.6 ULP
        function store(img, idx, px, kind) {
            const { m, nch } = info(img), ct = m.chType, v = img.v, b = img.o + idx * m.elem;
            if (PACKED[ct]) {
                const q = (x, n) => rnd(clampI(x, 0, 1) * n);
                if (ct === 'UNORM_INT_101010') wr32(v, b, 'u32', ((q(px[0], 1023) << 20) | (q(px[1], 1023) << 10) | q(px[2], 1023)) >>> 0);
                else wr16(v, b, ct === 'UNORM_SHORT_565' ? (q(px[0], 31) << 11) | (q(px[1], 63) << 5) | q(px[2], 31) : (q(px[0], 31) << 10) | (q(px[1], 31) << 5) | q(px[2], 31));
                v.w = true; return;
            }
            let s;
            switch (m.order) {
                case 'R': case 'Rx': s = [px[0], 0]; break; case 'A': s = [px[3]]; break; case 'RG': case 'RGx': s = [px[0], px[1], 0]; break; case 'RA': s = [px[0], px[3]]; break;
                case 'RGB': s = [px[0], px[1], px[2]]; break; case 'RGBA': s = px.slice(); break; case 'BGRA': s = [px[2], px[1], px[0], px[3]]; break; case 'ARGB': s = [px[3], px[0], px[1], px[2]]; break;
                case 'INTENSITY': s = [px[0]]; break; case 'LUMINANCE': s = [px[0]]; break; case 'RGBx': s = [px[0], px[1], px[2], 0]; break;
                default: throw new Error('圖像通道順序 ' + m.order + ' 不支援');
            }
            for (let c = 0; c < nch; c++) {
                const x = s[c];
                switch (ct) {
                    case 'UNORM_INT8': v.u8[b + c] = rnd(clampI(x, 0, 1) * 255); break; case 'SNORM_INT8': v.i8[b + c] = rnd(clampI(x, -1, 1) * 127); break;
                    case 'SIGNED_INT8': v.i8[b + c] = clampI(x, -128, 127); break; case 'UNSIGNED_INT8': v.u8[b + c] = clampI(x, 0, 255); break;
                    case 'UNORM_INT16': wr16(v, b + 2 * c, rnd(clampI(x, 0, 1) * 65535)); break; case 'SNORM_INT16': wr16(v, b + 2 * c, rnd(clampI(x, -1, 1) * 32767)); break;
                    case 'SIGNED_INT16': wr16(v, b + 2 * c, clampI(x, -32768, 32767)); break; case 'UNSIGNED_INT16': wr16(v, b + 2 * c, clampI(x, 0, 65535)); break;
                    case 'HALF_FLOAT': wr16(v, b + 2 * c, f2h(x)); break;
                    case 'SIGNED_INT32': wr32(v, b + 4 * c, 'i32', clampI(x, -2147483648, 2147483647)); break; case 'UNSIGNED_INT32': wr32(v, b + 4 * c, 'u32', clampI(x, 0, 4294967295)); break; case 'FLOAT': wr32(v, b + 4 * c, 'f32', x); break;
                    default: throw new Error('圖像通道型別 ' + ct + ' 不支援');
                }
            }
            v.w = true;
        }
        const geom = (m) => { const t = m.type, arr = /array/.test(t), dim = /3d/.test(t) ? 3 : /2d/.test(t) ? 2 : 1; return { arr, dim }; };
        const pix = (m, g, c, l) => (g.dim === 3 ? (c[2] * m.h + c[1]) * m.w + c[0] : g.dim === 2 ? ((g.arr ? l : 0) * m.h + c[1]) * m.w + c[0] : (g.arr ? l : 0) * m.w + c[0]);
        const sizeOf = (m, g, d) => (d === 0 ? m.w : d === 1 ? m.h : m.d);
        function addr(n, i, mode) {   // 回傳 -1＝邊界色
            switch (mode) {
                case 4: return i < 0 || i >= n ? -1 : i;
                case 6: return ((i % n) + n) % n;
                case 8: { const q = ((i % (2 * n)) + 2 * n) % (2 * n); return q < n ? q : 2 * n - 1 - q; }
                default: return clampI(i, 0, n - 1);
            }
        }
        function sample(img, smp, co, kind, isFC) {
            const { m } = info(img), g = geom(m), norm = smp & 1, mode = smp & 14, lin = (smp & 48) === 32 && isFC;
            const layer = g.arr ? clampI(Math.floor((isFC ? co[g.dim] : co[g.dim]) + (isFC ? 0.5 : 0)), 0, (g.dim === 1 ? m.h : m.d) - 1) : 0;
            const border = () => (HAS_A.has(m.order) ? [0, 0, 0, 0] : [0, 0, 0, 1]);
            const at = (ix) => { const c = new Array(3).fill(0); for (let d = 0; d < g.dim; d++) { if (ix[d] < 0) return border(); c[d] = ix[d]; } return fetch(img, pix(m, g, c, layer)); };
            const u = []; for (let d = 0; d < g.dim; d++) { const n = sizeOf(m, g, d); let x = isFC ? co[d] : co[d]; if (norm) x *= n; u.push(x); }
            if (!lin) { const ix = u.map((x, d) => addr(sizeOf(m, g, d), Math.floor(x), mode)); return at(ix); }
            const i0 = [], fr = []; for (let d = 0; d < g.dim; d++) { const x = u[d] - 0.5, f = Math.floor(x); i0.push(f); fr.push(x - f); }
            const acc = [0, 0, 0, 0];
            for (let corner = 0; corner < (1 << g.dim); corner++) {
                let w = 1; const ix = [];
                for (let d = 0; d < g.dim; d++) { const hi = (corner >> d) & 1; w *= hi ? fr[d] : 1 - fr[d]; ix.push(addr(sizeOf(m, g, d), i0[d] + hi, mode)); }
                if (w === 0) continue; const px = at(ix); for (let k = 0; k < 4; k++) acc[k] += w * px[k];
            }
            return acc;
        }
        const as = (px, kind, m) => {
            if (kind === 'f') return px.map((x) => Math.fround(x));
            return px.map((x) => (kind === 'i' ? (x | 0) : (x >>> 0)));
        };
        // ---- pipe：記憶體＝ [讀計數 u32][寫計數 u32] 後面接環狀的封包；工作項循序執行，所以不需要同步。回傳 0＝成功、-1＝空／滿／無效
        const hdr = (p) => ({ u: p.v.u32, h: (p.o >> 2) });
        return {
            pipeinfo(p, wantMax) { const { u, h } = hdr(p), max = p.pipe.max; return wantMax ? max : ((u[h + 1] - u[h]) >>> 0); },
            pipereserve(p, n, forWrite) {
                const { u, h } = hdr(p), max = p.pipe.max; n = n >>> 0; p.v.w = true;
                if (forWrite) { if (n === 0 || max - ((u[h + 1] - u[h]) >>> 0) < n) return 0; const s = u[h + 1]; u[h + 1] = (s + n) >>> 0; return (s + 1) >>> 0; }
                if (n === 0 || ((u[h + 1] - u[h]) >>> 0) < n) return 0; const s = u[h]; u[h] = (s + n) >>> 0; return (s + 1) >>> 0;
            },
            pipeop(p, sz, isWrite, rid, idx, hasRes, cb) {
                const { u, h } = hdr(p), max = p.pipe.max; p.v.w = true; let slot;
                if (hasRes) { if (!rid) return -1; slot = ((rid - 1) + idx) % max; }
                else if (isWrite) { if (max - ((u[h + 1] - u[h]) >>> 0) <= 0) return -1; slot = u[h + 1] % max; u[h + 1] = (u[h + 1] + 1) >>> 0; }
                else { if (((u[h + 1] - u[h]) >>> 0) === 0) return -1; slot = u[h] % max; u[h] = (u[h] + 1) >>> 0; }
                cb({ v: p.v, o: p.o + 8 + slot * sz }); return 0;
            },
            cpy(d, s, n) { d.v.w = true; d.v.u8.set(s.v.u8.subarray(s.o, s.o + n), d.o); },
            rimg(img, smp, co, kind, isFC) {
                if (!img || !img.img) throw new Error('read_image：引數不是圖像');
                const { m } = info(img), g = geom(m);
                let px;
                if (smp < 0) { const c = new Array(3).fill(0); for (let d = 0; d < g.dim; d++) c[d] = clampI(Math.floor(co[d]), 0, sizeOf(m, g, d) - 1); px = fetch(img, pix(m, g, c, g.arr ? clampI(Math.floor(co[g.dim]), 0, (g.dim === 1 ? m.h : m.d) - 1) : 0)); }
                else px = sample(img, smp >>> 0, co, kind, isFC);
                return as(px, kind, m);
            },
            wimg(img, co, val, kind) {
                if (!img || !img.img) throw new Error('write_image：引數不是圖像');
                const { m } = info(img), g = geom(m), c = new Array(3).fill(0);
                for (let d = 0; d < g.dim; d++) { c[d] = Math.floor(co[d]); if (c[d] < 0 || c[d] >= sizeOf(m, g, d)) return 0; }
                const l = g.arr ? Math.floor(co[g.dim]) : 0; if (g.arr && (l < 0 || l >= (g.dim === 1 ? m.h : m.d))) return 0;
                store(img, pix(m, g, c, l), val, kind); return 0;
            },
            gimg(img, what) {
                const m = img.img, g = geom(m);
                switch (what) {
                    case 'width': return m.w; case 'height': return g.dim >= 2 ? m.h : 1; case 'depth': return g.dim === 3 ? m.d : 1;
                    case 'array_size': return g.arr ? (g.dim === 1 ? m.h : m.d) : 0;
                    case 'channel_data_type': return 0x10D0 + CTYPES.indexOf(m.chType); case 'channel_order': return 0x10B0 + ORDERS.indexOf(m.order);
                    case 'dim': return g.dim === 3 ? [m.w, m.h, m.d, 0] : [m.w, g.dim >= 2 ? m.h : 1];
                }
            }
        };
    }

    function runKernel(rt, mod, kernels, name, args, gs, ls, off, gen) {
        const k = mod[name]; if (!k) throw new CErr('沒有核心 ' + name);
        const dim = gs.length; if (dim < 1 || dim > 3) throw new CErr('NDRange 維度要是 1–3');
        const G = [1, 1, 1], L = [1, 1, 1], O = [0, 0, 0];
        for (let d = 0; d < dim; d++) { G[d] = gs[d]; O[d] = (off && off[d]) || 0; L[d] = ls && ls[d] ? ls[d] : (d === 0 ? bestDivisor(G[0], 256) : 1); if (G[d] % L[d]) throw new CErr('global size ' + G[d] + ' 不是 local size ' + L[d] + ' 的整數倍'); }
        const W = rt.$W; W.gs = G.slice(); W.ls = L.slice(); W.off = O.slice(); W.dim = dim; W.ng = [G[0] / L[0], G[1] / L[1], G[2] / L[2]];
        const params = kernels[name].params, localIdx = []; params.forEach((p, i) => { if (p.kind === 'local') localIdx.push(i); });
        const nItems = L[0] * L[1] * L[2], set = (x, y, z, gx, gy, gz) => { W.l[0] = x; W.l[1] = y; W.l[2] = z; W.grp[0] = gx; W.grp[1] = gy; W.grp[2] = gz; W.g[0] = gx * L[0] + x + O[0]; W.g[1] = gy * L[1] + y + O[1]; W.g[2] = gz * L[2] + z + O[2]; };
        for (let gz = 0; gz < W.ng[2]; gz++) for (let gy = 0; gy < W.ng[1]; gy++) for (let gx = 0; gx < W.ng[0]; gx++) {
            W.lm = new Map();   // 每個工作群自己的區域記憶體
            const a = args.slice(); for (const i of localIdx) a[i] = rt.alloc(Math.max(1, args[i]));   // __local 指標參數：args[i] 是位元組數
            for (let i = 0; i < params.length; i++) if (params[i].kind === 'scalar' && params[i].type === 'struct') a[i] = rt.mkptr(Uint8Array.from(args[i]).buffer);   // struct 傳值：位元組 → 每個工作項看到的是同一份唯讀內容（被呼叫端會複製）
            if (!gen) {
                for (let z = 0; z < L[2]; z++) for (let y = 0; y < L[1]; y++) for (let x = 0; x < L[0]; x++) { set(x, y, z, gx, gy, gz); k.apply(null, a); }
                continue;
            }
            // 有 barrier：每個工作項一個產生器，一輪＝每個還沒結束的工作項跑到下一個 barrier（或結束）。群內有人結束、有人停在 barrier ＝發散
            const gens = [], coords = []; for (let z = 0; z < L[2]; z++) for (let y = 0; y < L[1]; y++) for (let x = 0; x < L[0]; x++) { coords.push([x, y, z]); gens.push(k.apply(null, a)); }
            const done = new Array(nItems).fill(false); let nDone = 0;
            while (nDone < nItems) {
                let finished = 0, waiting = 0;
                for (let i = 0; i < nItems; i++) {
                    if (done[i]) continue; const c = coords[i]; set(c[0], c[1], c[2], gx, gy, gz);
                    const r = gens[i].next(); if (r.done) { done[i] = true; nDone++; finished++; } else waiting++;
                }
                if (finished && waiting) throw new CErr('barrier 發散：工作群 (' + gx + ',' + gy + ',' + gz + ') 內有 ' + finished + ' 個工作項已結束，另有 ' + waiting + ' 個還停在 barrier（同一個工作群的所有工作項必須走到同一個 barrier）');
            }
        }
    }

    // 純量參數轉成核心型別（給驅動的 coerceScalar 用）
    function coerceScalar(type, v) {
        if (type === 'struct') return Array.from(v);   // struct 傳值參數：位元組
        const vm = VECTOR_RE.exec(type); if (vm) return Array.from(v, (x) => coerceScalar(vm[1], x));   // 向量純量參數：[元素, …]
        v = Number(v);
        switch (type) {
            case 'int': return v | 0; case 'uint': return v >>> 0; case 'short': return (v << 16) >> 16; case 'ushort': return v & 65535; case 'char': return (v << 24) >> 24; case 'uchar': return v & 255;
            case 'long': case 'ulong': return Math.trunc(v); case 'float': return Math.fround(v); default: return v;
        }
    }

    // 從快取的產物重建（跳過前處理／詞法／語法／型別檢查）：art＝{ js, kernels:{名:{params}}, gen }。js 的前導 const 依 rt 的 $ 開頭成員產生，所以 VERSION 變了就不能重用（快取鍵含 VERSION）。
    const VERSION = 1;
    function instantiate(art) {
        const rt = runtime(); Object.assign(rt, imageRuntime());
        const mod = new Function('$rt', art.js)(rt);
        return { ok: true, kind: 'clc', log: '', kernels: art.kernels, mkptr: rt.mkptr, run: (name, args, gs, ls, off) => runKernel(rt, mod, art.kernels, name, args, gs, ls, off, art.gen), js: art.js, gen: art.gen };
    }
    return { VERSION, instantiate, tokensOf, compile, coerceScalar, SIZE, CErr, runtime, runKernel, imageRuntime, IMG_ORDERS: ORDERS, IMG_TYPES_LIST: CTYPES };
});
