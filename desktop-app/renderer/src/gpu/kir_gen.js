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
    function wgslExpr(kernel, e) {
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
                    const p = kernel.params.find((q) => q.name === x.buf);
                    return p.elem === 'f32x4' ? `${x.buf}[${ex(x.idx)}].${'xyzw'[x.comp]}` : `${x.buf}[${ex(x.idx)}]`;
                }
                default: throw new Error('wgsl：不支援的運算式 ' + x.k);
            }
        };
        return ex(e);
    }

    function toWgsl(kernel) {
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
        const code = `${bufLines.join('\n')}\n${uniLine}\n\n@compute @workgroup_size(64)\nfn main(@builtin(global_invocation_id) gid3: vec3<u32>) {\n  let gid: i32 = i32(gid3.x);\n  if (gid >= P._count) { return; }\n${body}}\n`;
        return { ok: true, code, workgroupSize: 64, bindings, uniformFields: uni.map((p) => ({ name: p.name, type: p.type })).concat([{ name: '_count', type: 'i32' }]) };
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
                    const tex = `texelFetch(${x.buf}, ivec2((${idx}) % u_W, (${idx}) / u_W), 0)`;
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
        const fs = `#version 300 es\nprecision highp float;\nprecision highp int;\nuniform int u_W;\nuniform int u_count;\nuniform int u_base;\n${uniforms.map((u) => `uniform ${u.type} ${u.name};`).join('\n')}\n${kernel.params.filter((p) => p.kind === 'buf' && p.access === 'in').map((p) => `uniform highp sampler2D ${p.name};`).join('\n')}\nout vec4 fragColor;\nvoid main() {\n  int gid = int(floor(gl_FragCoord.y)) * u_W + int(floor(gl_FragCoord.x)) - u_base;\n  if (gid >= u_count) { discard; }\n${lines.join('')}  fragColor = vec4(${vals.join(', ')});\n}\n`;
        const vs = `#version 300 es\nconst vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));\nvoid main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }\n`;
        return { ok: true, vs, fs, uniforms: ['u_W', 'u_count', 'u_base'].concat(uniforms.map((u) => u.name)), samplers: kernel.params.filter((p) => p.kind === 'buf' && p.access === 'in').map((p) => ({ name: p.name, elem: p.elem })), out: { name: out.name, elem: out.elem } };
    }

    return { toWgsl, toGlsl, fl, SCALAR_MARK };
});
