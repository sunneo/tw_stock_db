/* KIR → WGSL（T1）與 KIR → GLSL ES 3.00 片段著色器（T3）。純模組（DESIGN.webgpu-cuda.md §13）。
 * 兩者都只吃通過 kir.js validate 的核心。
 *   toWgsl(kernel) → { code, workgroupSize:64, bindings:[{name,kind:'buf',binding,elem,access}|{name,kind:'uniform'}], uniformFields }
 *     緩衝區：in → var<storage, read>、out → var<storage, read_write>；純量與 _count 放在一個 uniform 結構。
 *     入口 main，每個 invocation 一個 gid；gid ≥ _count 直接 return。
 *   toGlsl(kernel) → { vs, fs, uniforms:[名字…] }：render-to-texture。緩衝區＝sampler2D（寬 uW、列數 ceil(N/uW)，一個 texel 一個元素）；
 *     只支援「恰好一個 out 緩衝區」（多個 out 需要 MRT，未做，回傳 error）。gid＝floor(y)*uW＋floor(x)。
 * 注意：WGSL 只做靜態結構檢查（本機沒有 naga／tint），未在真 GPU 驗證；GLSL 由真 Electron 的 WebGL2 編譯驗證。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaKirGen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const K = (typeof require === 'function') ? require('./kir.js') : root_KIR();
    function root_KIR() { return (typeof self !== 'undefined' ? self : this).FaKir; }

    // 浮點字面值：一定要有小數點（WGSL、GLSL 都是）
    const fl = (v) => { const s = String(Number(v)); return /[.eE]/.test(s) ? s : s + '.0'; };
    const SCALAR_MARK = (k) => k;

    // 共用：把運算式轉成 WGSL 字串
    function wgslExpr(kernel, e, tc) {
        const scal = new Set((kernel.params || []).filter((p) => p.kind === 'scalar').map((p) => p.name));
        const ex = (x) => {
            switch (x.k) {
                case 'num': return x.t === 'f32' ? fl(x.v) + 'f' : `${Number(x.v) | 0}i`;
                case 'var': return scal.has(x.name) ? `P.${x.name}` : `v_${x.name}`;
                case 'gid': return 'gid';
                case 'bin': return `(${ex(x.a)} ${x.op} ${ex(x.b)})`;
                case 'cmp': return `(${ex(x.a)} ${x.op} ${ex(x.b)})`;
                case 'sel': return `select(${ex(x.b)}, ${ex(x.a)}, ${ex(x.c)})`;
                case 'call': {
                    const map = { rsqrt: 'inverseSqrt' };
                    return `${map[x.fn] || x.fn}(${x.args.map(ex).join(', ')})`;
                }
                case 'cast': return x.to === 'f32' ? `f32(${ex(x.a)})` : `i32(${ex(x.a)})`;
                case 'load': {
                    // 分塊版（toWgslTiled）：tc.map 裡的緩衝區、索引就是迴圈變數 → 讀共享記憶體的 jj 槽
                    if (tc && tc.map.has(x.buf) && x.idx.k === 'var' && x.idx.name === tc.v) {
                        const arr = `${tc.map.get(x.buf)}[${tc.jj}]`;
                        const p0 = kernel.params.find((q) => q.name === x.buf);
                        return p0.elem === 'f32x4' ? `${arr}.${'xyzw'[x.comp]}` : arr;
                    }
                    const p = kernel.params.find((q) => q.name === x.buf);
                    return p.elem === 'f32x4' ? `${x.buf}[${ex(x.idx)}].${'xyzw'[x.comp]}` : `${x.buf}[${ex(x.idx)}]`;
                }
                default: throw new Error('wgsl：不支援的運算式 ' + x.k);
            }
        };
        return ex(e);
    }

    // 分塊（tile，DESIGN.webgpu-cuda.md §13 階段 6）：頂層的 for v in [0, bound)，若本體沒有寫入，
    // 而且有讀 in 緩衝區的 buf[v]，就把每 WG 個元素搬進 workgroup 共享記憶體，再用 WG 次迭代讀共享記憶體。
    // 所有執行緒都必須進入迴圈（barrier），所以分塊版不用 early return；寫入改用 in_range 守衛。
    // 沒有符合的迴圈回傳 null（呼叫端走一般版本）。
    function toWgslTiled(kernel, opts) {
        const v = K.validate(kernel); if (!v.ok) return { ok: false, error: 'KIR 不合法：' + v.errors.join('；') };
        const wg = opts.wg !== undefined ? opts.wg : 64;
        if (!Number.isInteger(wg) || wg < 1 || wg > 1024) return { ok: false, error: '工作群大小 ' + wg + ' 不合法' };
        const U = opts.unroll || 1;   // 內層迴圈展開次數（必須整除工作群大小）
        if (!Number.isInteger(U) || U < 1 || wg % U) return { ok: false, error: '展開次數 ' + U + ' 不合法（要整除工作群大小 ' + wg + '）' };
        const bufParam = (n) => kernel.params.find((q) => q.kind === 'buf' && q.name === n);
        const hasStore = (stmts) => stmts.some((s) => s.k === 'store' || (s.body && hasStore(s.body)));
        const walkLoads = (node, fn) => {
            if (Array.isArray(node)) { for (const n of node) walkLoads(n, fn); return; }
            if (!node || typeof node !== 'object') return;
            if (node.k === 'load') fn(node);
            for (const key of Object.keys(node)) if (key !== 'k') { const val = node[key]; if (val && typeof val === 'object') walkLoads(val, fn); }
        };
        // 候選：頂層 for、本體沒有寫入、有讀 in 緩衝區的 buf[v]
        const tiles = new Map();   // 頂層語句的索引 → { loop, bufs }
        kernel.body.forEach((s, i) => {
            if (s.k !== 'for' || hasStore(s.body)) return;
            const bufs = [];
            walkLoads(s.body, (n) => { const p = bufParam(n.buf); if (p && p.access === 'in' && n.idx.k === 'var' && n.idx.name === s.v && !bufs.includes(n.buf)) bufs.push(n.buf); });
            if (bufs.length) tiles.set(i, { loop: s, bufs });
        });
        if (tiles.size === 0) return null;
        const scal = new Set(kernel.params.filter((p) => p.kind === 'scalar').map((p) => p.name));
        const boundOf = (s) => (typeof s.bound === 'number' ? `${s.bound}i` : `P.${s.bound}`);
        const decls = [];
        for (const [i, t] of tiles) for (const b of t.bufs) {
            const ty = bufParam(b).elem === 'f32x4' ? 'vec4<f32>' : 'f32';
            decls.push(`var<workgroup> T${i}_${b}: array<${ty}, ${wg}>;`);
        }
        // 表達式與語句（tc：分塊迴圈的上下文；一般語句用 null）
        const stT = (s, ind, tc) => {
            switch (s.k) {
                case 'let': return `${ind}var v_${s.name}: ${s.t} = ${wgslExpr(kernel, s.e, tc)};\n`;
                case 'set': return `${ind}v_${s.name} = ${wgslExpr(kernel, s.e, tc)};\n`;
                case 'store': {
                    const p = bufParam(s.buf);
                    const line = p.elem === 'f32x4'
                        ? `${s.buf}[${wgslExpr(kernel, s.idx, tc)}] = vec4<f32>(${s.e.es.map((x) => wgslExpr(kernel, x, tc)).join(', ')});`
                        : `${s.buf}[${wgslExpr(kernel, s.idx, tc)}] = ${wgslExpr(kernel, s.e, tc)};`;
                    return `${ind}if (in_range) { ${line} }\n`;
                }
                case 'for': return `${ind}for (var v_${s.v}: i32 = 0i; v_${s.v} < ${boundOf(s)}; v_${s.v} = v_${s.v} + 1i) {\n${s.body.map((x) => stT(x, ind + '  ', tc)).join('')}${ind}}\n`;
                case 'if': return `${ind}if (${wgslExpr(kernel, s.c, tc)}) {\n${s.body.map((x) => stT(x, ind + '  ', tc)).join('')}${ind}}\n`;
                default: throw new Error('wgsl：不支援的語句 ' + s.k);
            }
        };
        const parts = [];
        kernel.body.forEach((s, i) => {
            const t = tiles.get(i);
            if (!t) { parts.push(stT(s, '  ', null)); return; }
            const map = new Map(t.bufs.map((b) => [b, `T${i}_${b}`]));
            const tc = { v: s.v, map, jj: `jj${i}` };
            let out = `  for (var t${i}: i32 = 0i; t${i} < ${boundOf(s)}; t${i} = t${i} + ${wg}i) {\n`;
            out += `    let src${i}: i32 = t${i} + li;\n`;
            for (const b of t.bufs) {
                const zero = bufParam(b).elem === 'f32x4' ? 'vec4<f32>(0.0, 0.0, 0.0, 0.0)' : '0.0';
                out += `    if (src${i} < ${boundOf(s)}) { T${i}_${b}[li] = ${b}[src${i}]; } else { T${i}_${b}[li] = ${zero}; }\n`;
            }
            out += `    workgroupBarrier();\n`;
            // 內層迴圈展開 U 次（每個副本一個區塊，各自的 let 不衝突）：副本 k 讀 jj＋k
            out += `    for (var ${tc.jj}: i32 = 0i; ${tc.jj} < ${wg}i; ${tc.jj} = ${tc.jj} + ${U}i) {\n`;
            for (let k = 0; k < U; k++) {
                const ex = U === 1 ? tc.jj : `(${tc.jj} + ${k}i)`;
                const tck = { v: s.v, map, jj: ex };
                out += `      {\n        var v_${s.v}: i32 = t${i} + ${ex};\n        if (v_${s.v} < ${boundOf(s)}) {\n`;
                out += s.body.map((x) => stT(x, '          ', tck)).join('');
                out += `        }\n      }\n`;
            }
            out += `    }\n`;
            out += `    workgroupBarrier();\n  }\n`;
            parts.push(out);
        });
        const bindings = []; let bi = 0; const bufLines = [];
        for (const p of kernel.params) if (p.kind === 'buf') {
            const ty = p.elem === 'f32x4' ? 'vec4<f32>' : 'f32';
            const acc = p.access === 'in' ? 'read' : 'read_write';
            bufLines.push(`@group(0) @binding(${bi}) var<storage, ${acc}> ${p.name}: array<${ty}>;`);
            bindings.push({ name: p.name, kind: 'buf', binding: bi, elem: p.elem, access: p.access }); bi++;
        }
        const uni = kernel.params.filter((p) => p.kind === 'scalar');
        const fields = uni.map((p) => `  ${p.name}: ${p.type === 'f32' ? 'f32' : 'i32'},`).concat(['  _count: i32,']);
        const uniLine = `struct Params {\n${fields.join('\n')}\n}\n@group(0) @binding(${bi}) var<uniform> P: Params;`;
        bindings.push({ name: 'P', kind: 'uniform', binding: bi });
        const code = `${bufLines.join('\n')}\n${uniLine}\n${decls.join('\n')}\n\n@compute @workgroup_size(${wg})\nfn main(@builtin(global_invocation_id) gid3: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {\n  let gid: i32 = i32(gid3.x) + i32(gid3.y) * ${65535 * wg};\n  let in_range: bool = gid < P._count;\n  let li: i32 = i32(lid3.x);\n${parts.join('')}}\n`;
        return { ok: true, code, workgroupSize: wg, bindings, uniformFields: uni.map((p) => ({ name: p.name, type: p.type })).concat([{ name: '_count', type: 'i32' }]), tiles: [...tiles.values()].reduce((n, t) => n + t.bufs.length, 0) };
    }

    function toWgsl(kernel, opts) {
        if (opts && opts.tile) { const t = toWgslTiled(kernel, opts); if (t) return t; }
        const v = K.validate(kernel); if (!v.ok) return { ok: false, error: 'KIR 不合法：' + v.errors.join('；') };
        const bindings = []; let bi = 0;
        const bufLines = [];
        for (const p of kernel.params) if (p.kind === 'buf') {
            const ty = p.elem === 'f32x4' ? 'vec4<f32>' : 'f32';
            const acc = p.access === 'in' ? 'read' : 'read_write';
            bufLines.push(`@group(0) @binding(${bi}) var<storage, ${acc}> ${p.name}: array<${ty}>;`);
            bindings.push({ name: p.name, kind: 'buf', binding: bi, elem: p.elem, access: p.access }); bi++;
        }
        const uni = (kernel.params || []).filter((p) => p.kind === 'scalar');
        const fields = uni.map((p) => `  ${p.name}: ${p.type === 'f32' ? 'f32' : 'i32'},`).concat(['  _count: i32,']);
        const uniLine = `struct Params {\n${fields.join('\n')}\n}\n@group(0) @binding(${bi}) var<uniform> P: Params;`;
        bindings.push({ name: 'P', kind: 'uniform', binding: bi });

        const st = (s, ind) => {
            switch (s.k) {
                case 'let': return `${ind}var v_${s.name}: ${s.t} = ${wgslExpr(kernel, s.e)};\n`;
                case 'set': return `${ind}v_${s.name} = ${wgslExpr(kernel, s.e)};\n`;
                case 'store': {
                    const p = kernel.params.find((q) => q.name === s.buf);
                    if (p.elem === 'f32x4') return `${ind}${s.buf}[${wgslExpr(kernel, s.idx)}] = vec4<f32>(${s.e.es.map((x) => wgslExpr(kernel, x)).join(', ')});\n`;
                    return `${ind}${s.buf}[${wgslExpr(kernel, s.idx)}] = ${wgslExpr(kernel, s.e)};\n`;
                }
                case 'for': {
                    const bound = typeof s.bound === 'number' ? `${s.bound}i` : `P.${s.bound}`;
                    return `${ind}for (var v_${s.v}: i32 = 0i; v_${s.v} < ${bound}; v_${s.v} = v_${s.v} + 1i) {\n${s.body.map((x) => st(x, ind + '  ')).join('')}${ind}}\n`;
                }
                case 'if': return `${ind}if (${wgslExpr(kernel, s.c)}) {\n${s.body.map((x) => st(x, ind + '  ')).join('')}${ind}}\n`;
                default: throw new Error('wgsl：不支援的語句 ' + s.k);
            }
        };
        const body = kernel.body.map((s) => st(s, '  ')).join('');
        // 工作群大小由呼叫端決定（自適應量測用）；超過一維上限 65535 個工作群時，派送改用 y 維，gid＝x＋y×(65535×wg)
        const wg = opts && opts.wg !== undefined ? opts.wg : 64;
        if (!Number.isInteger(wg) || wg < 1 || wg > 1024) return { ok: false, error: '工作群大小 ' + wg + ' 不合法' };
        const code = `${bufLines.join('\n')}\n${uniLine}\n\n@compute @workgroup_size(${wg})\nfn main(@builtin(global_invocation_id) gid3: vec3<u32>) {\n  let gid: i32 = i32(gid3.x) + i32(gid3.y) * ${65535 * wg};\n  if (gid >= P._count) { return; }\n${body}}\n`;
        return { ok: true, code, workgroupSize: wg, bindings, uniformFields: uni.map((p) => ({ name: p.name, type: p.type })).concat([{ name: '_count', type: 'i32' }]) };
    }

    function toGlsl(kernel) {
        const v = K.validate(kernel); if (!v.ok) return { ok: false, error: 'KIR 不合法：' + v.errors.join('；') };
        const outs = kernel.params.filter((p) => p.kind === 'buf' && p.access === 'out');
        if (outs.length !== 1) return { ok: false, error: 'GLSL（T3）目前只支援恰好一個輸出緩衝區（多個需要 MRT，未做）；這個核心有 ' + outs.length + ' 個' };
        const out = outs[0];
        const scal = new Set((kernel.params || []).filter((p) => p.kind === 'scalar').map((p) => p.name));
        const ex = (x) => {
            switch (x.k) {
                case 'num': return x.t === 'f32' ? fl(x.v) : `${Number(x.v) | 0}`;
                case 'var': return scal.has(x.name) ? `u_${x.name}` : `v_${x.name}`;
                case 'gid': return 'gid';
                case 'bin': return `(${ex(x.a)} ${x.op} ${ex(x.b)})`;
                case 'cmp': return `(${ex(x.a)} ${x.op} ${ex(x.b)})`;
                case 'sel': return `((${ex(x.c)}) ? ${ex(x.a)} : ${ex(x.b)})`;
                case 'call': { const map = { rsqrt: 'inversesqrt' }; return `${map[x.fn] || x.fn}(${x.args.map(ex).join(', ')})`; }
                case 'cast': return x.to === 'f32' ? `float(${ex(x.a)})` : `int(${ex(x.a)})`;
                case 'load': {
                    const p = kernel.params.find((q) => q.name === x.buf);
                    const idx = ex(x.idx);
                    const tex = `texelFetch(${x.buf}, ivec2((${idx}) % u_W, (${idx}) / u_W + u_off_${x.buf}), 0)`;
                    return p.elem === 'f32x4' ? `${tex}.${'xyzw'[x.comp]}` : `${tex}.r`;
                }
                default: throw new Error('glsl：不支援的運算式 ' + x.k);
            }
        };
        const hasStore = (stmts) => stmts.some((s) => s.k === 'store' || (s.body && hasStore(s.body)));
        const stLine = (s, ind) => {
            switch (s.k) {
                case 'let': return `${ind}${s.t === 'f32' ? 'float' : 'int'} v_${s.name} = ${ex(s.e)};\n`;
                case 'set': return `${ind}v_${s.name} = ${ex(s.e)};\n`;
                case 'for': {
                    if (hasStore(s.body)) throw new Error('GLSL：迴圈裡不能寫輸出（請把寫入放在迴圈外）');
                    const bound = typeof s.bound === 'number' ? `${s.bound}` : `u_${s.bound}`;
                    return `${ind}for (int v_${s.v} = 0; v_${s.v} < ${bound}; v_${s.v}++) {\n${s.body.map((x) => stLine(x, ind + '  ')).join('')}${ind}}\n`;
                }
                case 'if': {
                    if (hasStore(s.body)) throw new Error('GLSL：內部的 if 不能包著寫入（只支援「守邊界」的寫入形式）');
                    return `${ind}if (${ex(s.c)}) {\n${s.body.map((x) => stLine(x, ind + '  ')).join('')}${ind}}\n`;
                }
                default: throw new Error('glsl：不支援的語句 ' + s.k);
            }
        };
        // 最外層：允許 if(守邊界) { lets…; store }。守邊界的失敗＝discard（紋理保留原值）；寫入值是片段輸出。
        let outStore = null; const lines = [];
        const seenLet = new Set();
        const setTargets = new Set(); const collectSets = (stmts) => { for (const s of stmts) { if (s.k === 'set') setTargets.add(s.name); if (s.body) collectSets(s.body); } }; collectSets(kernel.body);
        const gidVars = new Set();   // 只賦值一次、初值是 gid 的區域變數（例如 int i = get_global_id(0)）視同 gid
        const walk = (stmts, ind, guarded) => {
            for (const s of stmts) {
                if (s.k === 'store') {
                    if (outStore) throw new Error('GLSL（T3）要求輸出只寫一次');
                    if (s.buf !== out.name) throw new Error('GLSL：寫入的緩衝區不是唯一的輸出');
                    outStore = s;
                    if (!(s.idx.k === 'gid' || (s.idx.k === 'var' && gidVars.has(s.idx.name)))) throw new Error('GLSL（T3）要求寫入位置就是 gid（每個片段寫自己的 texel）');
                    continue;
                }
                if (s.k === 'if' && hasStore(s.body)) {
                    lines.push(`${ind}if (!(${ex(s.c)})) { discard; }\n`);
                    walk(s.body, ind, true);
                    continue;
                }
                if (s.k === 'let') { if (seenLet.has(s.name)) throw new Error('GLSL：區域變數 ' + s.name + ' 在不同區塊重複宣告（請改名）'); seenLet.add(s.name); if (s.e.k === 'gid' && !setTargets.has(s.name)) gidVars.add(s.name); }
                lines.push(stLine(s, ind));
            }
        };
        try { walk(kernel.body, '  ', false); } catch (e) { return { ok: false, error: e.message }; }
        if (!outStore) return { ok: false, error: 'GLSL（T3）：核心沒有寫入輸出' };
        const vals = out.elem === 'f32x4' ? outStore.e.es.map(ex) : [ex(outStore.e), '0.0', '0.0', '0.0'];
        const uniforms = kernel.params.filter((p) => p.kind === 'scalar').map((p) => ({ name: 'u_' + p.name, type: p.type === 'f32' ? 'float' : 'int' }));
        const fs = `#version 300 es\nprecision highp float;\nprecision highp int;\nuniform int u_W;\nuniform int u_count;\nuniform int u_base;\n${uniforms.map((u) => `uniform ${u.type} ${u.name};`).join('\n')}\n${kernel.params.filter((p) => p.kind === 'buf' && p.access === 'in').map((p) => `uniform highp sampler2D ${p.name};\nuniform int u_off_${p.name};`).join('\n')}\nout vec4 fragColor;\nvoid main() {\n  int gid = int(floor(gl_FragCoord.y)) * u_W + int(floor(gl_FragCoord.x)) - u_base;\n  if (gid >= u_count) { discard; }\n${lines.join('')}  fragColor = vec4(${vals.join(', ')});\n}\n`;
        const vs = `#version 300 es\nconst vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));\nvoid main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }\n`;
        return { ok: true, vs, fs, uniforms: ['u_W', 'u_count', 'u_base'].concat(kernel.params.filter((p) => p.kind === 'buf' && p.access === 'in').map((p) => 'u_off_' + p.name), uniforms.map((u) => u.name)), samplers: kernel.params.filter((p) => p.kind === 'buf' && p.access === 'in').map((p) => ({ name: p.name, elem: p.elem })), out: { name: out.name, elem: out.elem } };
    }

    return { toWgsl, toGlsl, fl, SCALAR_MARK };
});
