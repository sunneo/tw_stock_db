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

    return { supportsWebGL2, runGl, compile };
});
