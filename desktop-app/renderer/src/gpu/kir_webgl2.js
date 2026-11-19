/* KIR 的 WebGL2 執行層（DESIGN.webgpu-cuda.md §13，階段 4）。UMD，瀏覽器掛 FaKirWebGL2，node 用 require。
 * 呼叫端給一個 WebGL2RenderingContext；本檔不建立畫布。核心由 kir_gen.toGlsl 產生（render-to-texture）：
 *   輸入緩衝區 → RGBA32F 紋理（寬 uW、高 ceil(N/uW)，一個 texel 一個元素；f32x4 的 texel 就是那 4 個分量）
 *   輸出緩衝區 → 掛在 framebuffer 上的 RGBA32F 紋理；全螢幕三角形，每個片段寫自己的 texel。
 * 需要 EXT_color_buffer_float（沒有就 supportsWebGL2 回 false，呼叫端退回 JS 後端）。
 * 只有 runGl 會讀回（readPixels）；runGl 的 keep 參數可以不讀回（之後階段用來保留 GPU 紋理）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./kir_gen.js'));
    else root.FaKirWebGL2 = factory(root.FaKirGen);
})(typeof self !== 'undefined' ? self : this, function (GEN) {
    'use strict';

    function compile(gl, type, src) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(sh) || '(無記錄)';
            gl.deleteShader(sh);
            throw new Error('GLSL 編譯失敗：' + log);
        }
        return sh;
    }

    // 能不能用：WebGL2 + EXT_color_buffer_float，而且能建立可渲染的 RGBA32F framebuffer
    function supportsWebGL2(gl) {
        if (!gl || typeof gl.getExtension !== 'function' || typeof WebGL2RenderingContext === 'undefined') return false;
        if (!(gl instanceof WebGL2RenderingContext)) return false;
        if (!gl.getExtension('EXT_color_buffer_float')) return false;
        const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteTexture(tex);
        return ok;
    }

    // 執行一個核心。buffers：name → 型別化陣列（f32 長 N、f32x4 長 4N；輸出可以省略，會自動配置）；scalars：name → 數字。
    // 回傳 { out: { 名字: Float32Array }, uW, rows, program 快取 }。失敗就丟例外（呼叫端據此退回 JS）。
    function runGl(gl, kernel, buffers, scalars, N) {
        const g = GEN.toGlsl(kernel);
        if (!g.ok) throw new Error(g.error);
        if (!supportsWebGL2(gl)) throw new Error('WebGL2 不可用（需要 EXT_color_buffer_float）');
        const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const uW = Math.max(1, Math.min(N, maxTex)), rows = Math.ceil(N / uW);
        if (rows > maxTex) throw new Error('N 太大，超過紋理上限');
        const prog = gl.createProgram();
        const vs = compile(gl, gl.VERTEX_SHADER, g.vs), fs = compile(gl, gl.FRAGMENT_SHADER, g.fs);
        gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
        gl.deleteShader(vs); gl.deleteShader(fs);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { const log = gl.getProgramInfoLog(prog); gl.deleteProgram(prog); throw new Error('GLSL 連結失敗：' + log); }
        const texes = [], fb = gl.createFramebuffer(); const out = {};
        try {
            gl.useProgram(prog);
            // 輸入紋理
            let unit = 0;
            for (const s of g.samplers) {
                const src = buffers[s.name]; if (!src) throw new Error('缺少 buffer ' + s.name);
                const data = new Float32Array(uW * rows * 4);
                const comps = s.elem === 'f32x4' ? 4 : 1;
                for (let i = 0; i < N; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = comps === 4 ? src[i * 4 + c] : (c === 0 ? src[i] : 0);
                const tex = gl.createTexture(); texes.push(tex);
                gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, uW, rows, 0, gl.RGBA, gl.FLOAT, data);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.uniform1i(gl.getUniformLocation(prog, s.name), unit);
                gl.uniform1i(gl.getUniformLocation(prog, 'u_W_' + s.name), uW);   // 輸入自己的紋理寬（kir_gen 的 load 用 u_W_<名字>）
                unit++;
            }
            // 輸出紋理（掛在 framebuffer）
            // 輸出紋理用自己的紋理單元（不能跟任何輸入共用，否則是 feedback loop，繪圖會失敗）
            const outTex = gl.createTexture(); texes.push(outTex);
            gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, outTex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, uW, rows, 0, gl.RGBA, gl.FLOAT, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer 不完整');
            gl.viewport(0, 0, uW, rows);
            // 一般 uniform
            gl.uniform1i(gl.getUniformLocation(prog, 'u_W'), uW);
            gl.uniform1i(gl.getUniformLocation(prog, 'u_count'), N);
            for (const p of kernelScalars(kernel)) {
                if (!(p.name in scalars)) throw new Error('缺少純量 ' + p.name);
                const loc = gl.getUniformLocation(prog, 'u_' + p.name);
                if (p.type === 'i32') gl.uniform1i(loc, scalars[p.name] | 0); else gl.uniform1f(loc, Math.fround(scalars[p.name]));
            }
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            // 讀回（只在這裡讀；GPU 紋理保留給之後的階段）
            const px = new Float32Array(uW * rows * 4);
            gl.readPixels(0, 0, uW, rows, gl.RGBA, gl.FLOAT, px);
            const outP = kernelOut(kernel);
            const res = new Float32Array(outP.elem === 'f32x4' ? N * 4 : N);
            for (let i = 0; i < N; i++) {
                if (outP.elem === 'f32x4') for (let c = 0; c < 4; c++) res[i * 4 + c] = px[i * 4 + c];
                else res[i] = px[i * 4];
            }
            out[outP.name] = res;
            return { out, uW, rows, backend: 'webgl2' };
        } finally {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            for (const t of texes) gl.deleteTexture(t);
            gl.deleteFramebuffer(fb);
            gl.deleteProgram(prog);
        }
    }

    function kernelScalars(kernel) { return (kernel.params || []).filter((p) => p.kind === 'scalar'); }
    function kernelOut(kernel) { return (kernel.params || []).find((p) => p.kind === 'buf' && p.access === 'out'); }

    // ---- 步驟 1（DESIGN.webgpu-cuda.md §13 階段 6）：裝置層，緩衝區常駐 GPU 紋理，跨多次派送保留。
    // createDevice(gl) → { alloc(N, elem), upload(buf, arr), download(buf), dispatch(kernel, binds, out, scalars, N), free(buf), stats }
    //   alloc：配置 RGBA32F 紋理（寬 uW、高 rows，與 runGl 同一個配置）；upload／download 只在呼叫時做，dispatch 不讀回。
    //   dispatch：輸入紋理 binds（名字 → 緩衝區）、輸出 out；out 不能同時是輸入（feedback loop）。程式（GLSL）依核心物件快取。
    function createDevice(gl) {
        if (!supportsWebGL2(gl)) throw new Error('WebGL2 不可用（需要 EXT_color_buffer_float）');
        const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const fb = gl.createFramebuffer();
        const progs = new WeakMap();
        // context 遺失（webglcontextlost）後，之後的 GL 呼叫會變成空操作，讀回會拿到 0（靜默錯誤）。
        // 這裡改成明確丟例外：呼叫端記下原因並退回 JS（llvm_host 裝置路徑的 catch 會 warn 這句話）。
        let ctxLost = false;
        if (gl.canvas && gl.canvas.addEventListener) gl.canvas.addEventListener('webglcontextlost', () => { ctxLost = true; });
        const live = () => { if (ctxLost || (gl.isContextLost && gl.isContextLost())) throw new Error('WebGL2 context 已遺失（webglcontextlost），之後的派送改退回 JS'); };
        const stats = { allocs: 0, uploads: 0, downloads: 0, dispatches: 0 };
        const dims = (N) => { const uW = Math.max(1, Math.min(N, maxTex)), rows = Math.ceil(N / uW); if (rows > maxTex) throw new Error('N 太大，超過紋理上限'); return { uW, rows }; };
        const mkTex = (uW, rows) => {
            live();
            const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, uW, rows, 0, gl.RGBA, gl.FLOAT, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            stats.allocs++;
            return tex;
        };
        // 一般緩衝區：一張紋理、一個部分。
        // 打包緩衝區（allocPacked）：一張紋理裝 parts 個長度 Npart 的部分，每部分佔 rowsPer 列；N＝Npart×parts。
        // view(打包, k)：第 k 個部分，寫入時用列偏移（viewport＋u_base），讀寫都在同一張紋理上。
        const alloc = (N, elem) => {
            const { uW, rows } = dims(N);
            return { N, Npart: N, parts: 1, elem, uW, rows, rowsPer: rows, rowOffset: 0, tex: mkTex(uW, rows), freed: false, packed: false, parent: null };
        };
        const allocPacked = (Npart, parts) => {
            const { uW, rows: rowsPer } = dims(Npart);
            const rows = rowsPer * parts;
            if (rows > maxTex) throw new Error('打包後的列數超過紋理上限');
            return { N: Npart * parts, Npart, parts, elem: 'f32', uW, rows, rowsPer, rowOffset: 0, tex: mkTex(uW, rows), freed: false, packed: true, parent: null };
        };
        const view = (parent, k) => {
            if (!parent.packed || k < 0 || k >= parent.parts) throw new Error('view：不是打包緩衝區或部分編號超出');
            return { N: parent.Npart, Npart: parent.Npart, parts: 1, elem: 'f32', uW: parent.uW, rows: parent.rowsPer, rowsPer: parent.rowsPer, rowOffset: k * parent.rowsPer, tex: parent.tex, freed: false, packed: false, parent };
        };
        // 元素 e 在紋理上的 (列, 欄)：部分 k＝floor(e/Npart)，第 i＝e−k·Npart 個元素在部分內的列＝k·rowsPer＋floor(i/uW)
        const texelOf = (b, e) => { const k = Math.floor(e / b.Npart), i = e - k * b.Npart; return ((k * b.rowsPer + Math.floor(i / b.uW)) * b.uW + (i % b.uW)) * 4; };
        const upload = (b, src) => {
            live();
            if (b.freed) throw new Error('緩衝區已釋放');
            const comps = b.elem === 'f32x4' ? 4 : 1;
            // 寫入的範圍：整個緩衝區（一般或打包）或 view（只有它的部分；列偏移 rowOffset）
            const rowLo = b.parent ? b.rowOffset : 0, rowsW = b.parent ? b.rowsPer : b.rows;
            const data = new Float32Array(b.uW * rowsW * 4);
            if (b.parent) {
                for (let i = 0; i < b.Npart; i++) data[(Math.floor(i / b.uW) * b.uW + (i % b.uW)) * 4] = src[i];
            } else {
                for (let e = 0; e < b.N; e++) {
                    const t = texelOf(b, e);
                    if (comps === 4) for (let c = 0; c < 4; c++) data[t + c] = src[e * 4 + c];
                    else data[t] = src[e];
                }
            }
            gl.bindTexture(gl.TEXTURE_2D, b.tex);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rowLo, b.uW, rowsW, gl.RGBA, gl.FLOAT, data);
            stats.uploads++;
        };
        // 讀回：整張紋理（打包緩衝區＝一次 readPixels 讀全部部分）；一般緩衝區與 view 讀它自己的列
        const download = (b) => {
            live();
            if (b.freed) throw new Error('緩衝區已釋放');
            const rowLo = b.parent ? b.rowOffset : 0, rowsR = b.parent ? b.rowsPer : b.rows;
            const px = new Float32Array(b.uW * rowsR * 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b.tex, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); throw new Error('framebuffer 不完整'); }
            gl.readPixels(0, rowLo, b.uW, rowsR, gl.RGBA, gl.FLOAT, px);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            stats.downloads++;
            const n = b.parent ? b.Npart : b.N;
            const res = new Float32Array(n * (b.elem === 'f32x4' ? 4 : 1));
            const comps = b.elem === 'f32x4' ? 4 : 1;
            for (let e = 0; e < n; e++) {
                // view：px 從它自己的第一列開始（列偏移已扣掉）；一般與打包：px 從第 0 列開始
                const t = b.parent ? (Math.floor(e / b.uW) * b.uW + (e % b.uW)) * 4 : texelOf(b, e);
                if (comps === 4) for (let c = 0; c < 4; c++) res[e * 4 + c] = px[t + c]; else res[e] = px[t];
            }
            return res;
        };
        const program = (kernel) => {
            let p = progs.get(kernel);
            if (p) return p;
            const g = GEN.toGlsl(kernel);
            if (!g.ok) throw new Error(g.error);
            const prog = gl.createProgram();
            const vs = compile(gl, gl.VERTEX_SHADER, g.vs), fs = compile(gl, gl.FRAGMENT_SHADER, g.fs);
            gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
            gl.deleteShader(vs); gl.deleteShader(fs);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { const log = gl.getProgramInfoLog(prog); gl.deleteProgram(prog); throw new Error('GLSL 連結失敗：' + log); }
            p = { prog, g, loc: {} };
            for (const u of g.uniforms) p.loc[u] = gl.getUniformLocation(prog, u);
            for (const s of g.samplers) p.loc[s.name] = gl.getUniformLocation(prog, s.name);
            progs.set(kernel, p);
            return p;
        };
        // 派送：輸入 binds（名字 → 緩衝區）、輸出 out（一般緩衝區或 view）。輸出的紋理不能是任何輸入的紋理（feedback）。不讀回。
        // 多個輸出：每個輸出拆成一個單一輸出的核心依序派送（GLSL 沒有 MRT；拆法見 kir_gen.singleOutKernels）。N＝0 不派送。
        const splitCache = new WeakMap();
        const splitOf = (kernel) => { if (!splitCache.has(kernel)) splitCache.set(kernel, GEN.singleOutKernels(kernel)); return splitCache.get(kernel); };
        const dispatch = (kernel, binds, out, scalars, N) => {
            if (!(N >= 1)) return;
            const subs = splitOf(kernel);
            if (subs.length === 1) { dispatchOne(kernel, binds, out, scalars, N); return; }
            for (const sk of subs) {
                const on = sk.params.find((q) => q.kind === 'buf' && q.access === 'out').name;
                dispatchOne(sk, binds, binds[on], scalars, N);
            }
        };
        const dispatchOne = (kernel, binds, out, scalars, N) => {
            live();
            const p = program(kernel);
            if (out.freed || out.Npart !== N) throw new Error('輸出緩衝區大小不符或已釋放');
            if (out.elem !== p.g.out.elem) throw new Error('輸出型別不符');
            gl.useProgram(p.prog);
            p.g.samplers.forEach((s, unit) => {
                const b = binds[s.name];
                if (!b || b.freed) throw new Error('缺少輸入緩衝區 ' + s.name);
                if (b.tex === out.tex) throw new Error('輸出不能同時是輸入（feedback loop）：' + s.name);
                if (b.Npart < N || b.elem !== s.elem) throw new Error('輸入 ' + s.name + ' 的大小不足或型別不符');   // 輸入可以比輸出長（例如 a[i*k+j]），與 WebGPU 一致
                gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, b.tex);
                gl.uniform1i(p.loc[s.name], unit);
                // 輸入是打包的 view：它的資料從紋理的第 rowOffset 列開始
                gl.uniform1i(p.loc['u_off_' + s.name], b.rowOffset || 0);
                gl.uniform1i(p.loc['u_W_' + s.name], b.uW);   // 輸入自己的紋理寬（輸入長度可以和輸出 N 不同）
            });
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.tex, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); throw new Error('framebuffer 不完整'); }
            const rowOff = out.rowOffset || 0;
            gl.viewport(0, rowOff, out.uW, out.rows);
            gl.uniform1i(p.loc.u_W, out.uW);
            gl.uniform1i(p.loc.u_count, N);
            gl.uniform1i(p.loc.u_base, rowOff * out.uW);
            for (const pr of (kernel.params || []).filter((q) => q.kind === 'scalar')) {
                if (!(pr.name in scalars)) throw new Error('缺少純量 ' + pr.name);
                if (pr.type === 'i32') gl.uniform1i(p.loc['u_' + pr.name], scalars[pr.name] | 0); else gl.uniform1f(p.loc['u_' + pr.name], Math.fround(scalars[pr.name]));
            }
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            stats.dispatches++;
        };
        const free = (b) => { if (!b.freed && !b.parent) { gl.deleteTexture(b.tex); } b.freed = true; };
        return { alloc, allocPacked, view, upload, download, dispatch, free, stats, maxTex };
    }

    return { supportsWebGL2, runGl, compile, createDevice };
});
