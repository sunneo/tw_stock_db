// gpu_fakes.js — 測試用的假 WebGPU 與假 WebGL2（只給 node 測試與離線 PoC 用，不進產品）。
// 假裝置依核心原始碼的 @kernel 標記，用 gpu_core.js 的 CPU 參考版與同一套演算法算結果，
// 所以它驗證的是：主機端的緩衝區配置、綁定順序、分派數量、降級與回報；不驗證 WGSL 或 GLSL 本身。
'use strict';
const core = require('./gpu_core.js');
const NN = require('./nn_ops.js');

// 用途旗標（與真實 GPUBufferUsage 相同的數值）。假裝置會檢查，缺旗標就丟錯，行為與真實 WebGPU 的驗證錯誤一致。
const USE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 };
const USE_NAME = { 0x1: 'MAP_READ', 0x4: 'COPY_SRC', 0x8: 'COPY_DST', 0x40: 'UNIFORM', 0x80: 'STORAGE' };
function needUse(buf, flag, what) {
  if (!((buf.usage || 0) & flag)) throw new Error('假裝置用途檢查失敗：' + what + ' 的緩衝區缺少 ' + USE_NAME[flag] + '（實際用途 ' + (buf.usage || 0) + '）');
}

// opts: { limits, features, isFallback, adapter: 'ok'|'null'|'throw', deviceError, kernelError }
function fakeNavigator(opts) {
  opts = opts || {};
  const limits = Object.assign({ maxStorageBufferBindingSize: 134217728, maxComputeWorkgroupStorageSize: 16384 }, opts.limits || {});
  let resolveLost = null;
  const lostPromise = new Promise((r) => { resolveLost = r; });
  const dev = {
    limits: limits,
    lost: lostPromise,
    __resolveLost: (info) => resolveLost(info),
    queue: {
      // 真實 WebGPU 接受 ArrayBuffer 與 TypedArray 兩種來源
      writeBuffer(buf, off, data) {
        needUse(buf, USE.COPY_DST, 'writeBuffer');
        const src = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        new Uint8Array(buf.data).set(src, off);
      },
      submit(cmds) { for (const ops of cmds) for (const op of ops) { if (op.copy) new Uint8Array(op.dst.data).set(new Uint8Array(op.src.data, op.so, op.n), op.dO); else runKernel(op); } }
    },
    createBuffer({ size, usage }) {
      const b = { size, usage, data: new ArrayBuffer(Math.max(4, size)), destroy() {}, unmap() {} };
      b.mapAsync = async () => { needUse(b, USE.MAP_READ, 'mapAsync'); };
      b.getMappedRange = () => b.data;
      return b;
    },
    createShaderModule({ code }) { return { code }; },
    createComputePipeline({ compute }) {
      const m = /@kernel\s+(\w+)/.exec(compute.module.code);
      return { kernel: m ? m[1] : 'unknown', getBindGroupLayout() { return {}; } };
    },
    createBindGroup({ entries }) {
      // 綁定：儲存緩衝區要 STORAGE，uniform 要 UNIFORM（兩者都不是就是驗證錯誤）
      for (const e of entries) {
        const b = e.resource.buffer;
        if (!((b.usage || 0) & (USE.STORAGE | USE.UNIFORM))) throw new Error('假裝置用途檢查失敗：binding ' + e.binding + ' 的緩衝區缺少 STORAGE 或 UNIFORM（實際用途 ' + (b.usage || 0) + '）');
      }
      return { entries };
    },
    createCommandEncoder() {
      const ops = [];
      return {
        beginComputePass() {
          let pipe = null, bg = null;
          return {
            setPipeline(p) { pipe = p; },
            setBindGroup(i, g) { bg = g; },
            dispatchWorkgroups(x, y) { ops.push({ pipe, bg, x, y }); },
            end() {}
          };
        },
        // 複製要排進佇列、在 submit 時依序執行（真實 WebGPU 也是這樣）；否則讀回會拿到核心執行前的舊資料
        copyBufferToBuffer(src, so, dst, dO, n) {
          needUse(src, USE.COPY_SRC, 'copyBufferToBuffer 的來源');
          needUse(dst, USE.COPY_DST, 'copyBufferToBuffer 的目的');
          ops.push({ copy: true, src: src, so: so, dst: dst, dO: dO, n: n });
        },
        finish() { return ops; }
      };
    },
    pushErrorScope() {},
    popErrorScope: async () => null
  };
  const f32 = (buf, n) => new Float32Array(buf.data, 0, n);
  const u32 = (buf) => new Uint32Array(buf.data);
  function runKernel(op) {
    if (opts.kernelError && op.pipe.kernel === opts.kernelError) throw new Error('假核心錯誤');
    const e = op.bg.entries.map((x) => x.resource.buffer);
    const k = op.pipe.kernel;
    if (k === 'vector_add') {
      const n = u32(e[3])[0];
      f32(e[2], n).set(core.vectorAddRef(f32(e[0], n), f32(e[1], n)));
    } else if (k === 'matmul') {
      const p = u32(e[3]); const m = p[0], kk = p[1], n = p[2];
      f32(e[2], m * n).set(core.matmulRef(f32(e[0], m * kk), f32(e[1], kk * n), m, kk, n));
    } else if (k === 'sum') {
      const n = u32(e[2])[0], inp = f32(e[0], n), groups = op.x, out = f32(e[1], groups), stride = 256 * groups;
      for (let g = 0; g < groups; g++) {
        let acc = 0;
        for (let i = g * 256; i < n; i += stride) for (let j = 0; j < 256 && i + j < n; j++) acc = Math.fround(acc + inp[i + j]);
        out[g] = acc;
      }
    } else if (k === 'sum_dd') {
      // 與 WGSL 相同的結構：每個 workgroup 以步進取數（dd 累加），再做 256 寬的樹狀 dd 歸約
      const n = u32(e[4])[0], inH = f32(e[0], n), inL = f32(e[1], n), groups = op.x;
      const oh = f32(e[2], groups), ol = f32(e[3], groups), stride = 256 * groups;
      for (let g = 0; g < groups; g++) {
        const sh = new Array(256), sl = new Array(256);
        for (let lid = 0; lid < 256; lid++) {
          let h = 0, l = 0;
          for (let i = g * 256 + lid; i < n; i += stride) { const r = core.ddAdd(h, l, inH[i], inL[i]); h = r[0]; l = r[1]; }
          sh[lid] = h; sl[lid] = l;
        }
        for (let s = 128; s > 0; s >>= 1) {
          for (let lid = 0; lid < s; lid++) { const r = core.ddAdd(sh[lid], sl[lid], sh[lid + s], sl[lid + s]); sh[lid] = r[0]; sl[lid] = r[1]; }
        }
        oh[g] = sh[0]; ol[g] = sl[0];
      }
    } else if (k === 'scatter_add') {
      // 依序執行（CAS 迴圈在假裝置上等價於依序的 f32 加法）
      const n = u32(e[3])[0], idx = u32(e[0]), vals = f32(e[1], n), out = f32(e[2], u32(e[3])[1]);
      for (let i = 0; i < n; i++) out[idx[i]] = Math.fround(out[idx[i]] + vals[i]);
    } else if (k === 'rmsnorm') {
      // 綁定順序：0 x、1 g、2 y、3 uniform（rows u32、d u32、eps f32）
      const rows = u32(e[3])[0], d = u32(e[3])[1], eps = new Float32Array(e[3].data, 8, 1)[0];
      f32(e[2], rows * d).set(NN.rmsnormRef(f32(e[0], rows * d), f32(e[1], d), rows, d, eps));
    } else if (k === 'softmax') {
      // 綁定順序：0 x、1 y、2 uniform（rows u32、cols u32）
      const rows = u32(e[2])[0], cols = u32(e[2])[1];
      f32(e[1], rows * cols).set(NN.softmaxRef(f32(e[0], rows * cols), rows, cols));
    } else if (k === 'silu') {
      // 綁定順序：0 x、1 y、2 uniform（n u32）
      const n = u32(e[2])[0];
      f32(e[1], n).set(NN.siluRef(f32(e[0], n)));
    } else if (k === 'rope') {
      // 綁定順序：0 x、1 y、2 uniform（T、H、hd 皆為 u32，dir 為 f32 位於位元組 12）
      const T = u32(e[2])[0], H = u32(e[2])[1], hd = u32(e[2])[2], dir = new Float32Array(e[2].data, 12, 1)[0];
      f32(e[1], T * H * hd).set(NN.ropeRef(f32(e[0], T * H * hd), T, H, hd, dir));
    } else if (k === 'adamw') {
      // 綁定順序：0 p(寫)、1 g、2 m(寫)、3 v(寫)、4 uniform（n u32、lr、b1、b2、eps、wd、c1、c2 皆 f32，從位元組 4 起）
      const n = u32(e[4])[0], fl = new Float32Array(e[4].data, 4, 7);
      const r = NN.adamwCore(f32(e[0], n), f32(e[1], n), f32(e[2], n), f32(e[3], n), fl[0], fl[1], fl[2], fl[3], fl[4], fl[5], fl[6]);
      f32(e[0], n).set(r.p); f32(e[2], n).set(r.m); f32(e[3], n).set(r.v);
    } else if (k === 'axpy' || k === 'scal') {
      const n = u32(e[e.length - 1])[0];
      const alpha = new Float32Array(e[e.length - 1].data, 4, 1)[0];
      if (k === 'axpy') f32(e[1], n).set(core.axpyRef(alpha, f32(e[0], n), f32(e[1], n)));
      else f32(e[0], n).set(core.scalRef(alpha, f32(e[0], n)));
    } else if (k === 'mul') {
      const n = u32(e[3])[0];
      f32(e[2], n).set(core.mulRef(f32(e[0], n), f32(e[1], n)));
    } else {
      throw new Error('假裝置不認得核心：' + k);
    }
  }
  const adapter = {
    features: new Set(opts.features || []),
    limits: limits,
    isFallbackAdapter: !!opts.isFallback,
    info: { vendor: 'fake' },
    requestDevice: async () => {
      if (opts.deviceError) throw new Error(opts.deviceError);
      return dev;
    }
  };
  const gpu = {
    requestAdapter: async () => {
      if (opts.adapter === 'throw') throw new Error('介面卡探測爆炸');
      if (opts.adapter === 'null') return null;
      return adapter;
    }
  };
  return { nav: { gpu: gpu }, dev: dev };
}

// 假的 WebGL2：只重現 gpu_core.js 的紋理配置、單元綁定、幀緩衝與讀回流程；片段著色器語意用 JS 重現（與 GLSL 同一公式）
function fakeGl(opts) {
  opts = opts || {};
  const maxTex = opts.maxTex || 4096;
  const gl = {
    units: {}, activeUnit: 0, bound: null, fbo: null, uniforms: {}, prog: null,
    getExtension(name) { if (name === 'EXT_color_buffer_float') return opts.noFloat ? null : {}; return null; },
    getParameter(p) { return p === 0x0D33 ? maxTex : 0; },
    createShader(t) { return { t: t, src: '', ok: true }; },
    shaderSource(s, src) { s.src = src; },
    compileShader(s) { s.ok = !/#FAILCOMPILE/.test(s.src); },
    getShaderParameter(s) { return s.ok; },
    getShaderInfoLog() { return 'fake shader log'; },
    createProgram() { return { shaders: [], kernel: null, ok: false }; },
    attachShader(p, s) { p.shaders.push(s); },
    linkProgram(p) {
      const fs = p.shaders.find((s) => s.t === 0x8B30);
      const m = /@kernel\s+(\w+)/.exec(fs.src);
      p.kernel = m ? m[1] : null;
      p.ok = !!p.kernel;
    },
    getProgramParameter(p) { return p.ok; },
    getProgramInfoLog() { return 'fake program log'; },
    createTexture() { return { w: 0, h: 0, data: null }; },
    bindTexture(target, tex) { gl.bound = tex; gl.units[gl.activeUnit] = tex; },
    texParameteri() {},
    texStorage2D(t, l, f, w, h) { gl.bound.w = w; gl.bound.h = h; gl.bound.data = new Float32Array(w * h * 4); },
    texSubImage2D(t, l, x, y, w, h, f, ty, px) { gl.bound.data.set(px.subarray(0, w * h * 4)); },
    createFramebuffer() { return { tex: null }; },
    bindFramebuffer(t, f) { gl.fbo = f; },
    framebufferTexture2D(t, a, tg, tex) { gl.fbo.tex = tex; },
    checkFramebufferStatus() { return 0x8CD5; },
    useProgram(p) { gl.prog = p; },
    getUniformLocation(p, name) { return name; },
    uniform1i(loc, v) { gl.uniforms[loc] = v; },
    uniform1f(loc, v) { gl.uniforms[loc] = Math.fround(v); },
    activeTexture(u) { gl.activeUnit = u - 0x84C0; },
    viewport() {},
    drawArrays() {
      if (opts.drawFail && gl.prog.kernel === opts.drawFail) throw new Error('假繪製錯誤');
      const out = gl.fbo.tex, ow = out.w, oh = out.h;
      const tex = (name) => gl.units[gl.uniforms[name]];
      const at = (t, x, y) => t.data[(y * t.w + x) * 4];
      out.data.fill(0);
      const k = gl.prog.kernel;
      for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        let v = 0;
        if (k === 'vector_add') {
          const e = y * gl.uniforms.uW + x;
          v = e >= gl.uniforms.uN ? 0 : at(tex('uA'), x, y) + at(tex('uB'), x, y);
        } else if (k === 'matmul') {
          for (let t = 0; t < gl.uniforms.uK; t++) v = Math.fround(v + Math.fround(at(tex('uA'), t, y) * at(tex('uB'), x, t)));
        } else if (k === 'rmsnorm') {
          // 逐像素重現 FS_RMSNORM：fetch(i) 在紋理的 (i % W, floor(i / W))，與 GLSL 的索引一致
          const W = gl.uniforms.uW, rows = gl.uniforms.uRows, D = gl.uniforms.uD, eps = gl.uniforms.uEps;
          const X = tex('uX'), G = tex('uG'), idx = y * ow + x;
          if (idx < rows * D) {
            const row = Math.floor(idx / D), i = idx - row * D;
            const fx = (j) => at(X, j % W, Math.floor(j / W));
            let s = 0; for (let j = 0; j < D; j++) { const q = fx(row * D + j); s += q * q; }
            const inv = 1 / Math.sqrt(s / D + eps);
            v = fx(idx) * inv * at(G, i % W, Math.floor(i / W));
          }
        } else if (k === 'softmax') {
          // 逐像素重現 FS_SOFTMAX（fetch 與 GLSL 同一索引）
          const W = gl.uniforms.uW, rows = gl.uniforms.uRows, C = gl.uniforms.uCols, X = tex('uX');
          const idx = y * ow + x;
          if (idx < rows * C) {
            const row = Math.floor(idx / C);
            const fx = (j) => at(X, j % W, Math.floor(j / W));
            let mx = fx(row * C); for (let c = 1; c < C; c++) mx = Math.max(mx, fx(row * C + c));
            let s = 0; for (let c = 0; c < C; c++) s += Math.exp(fx(row * C + c) - mx);
            v = Math.exp(fx(idx) - mx) / s;
          }
        } else if (k === 'silu') {
          // 逐像素重現 FS_SILU
          const W = gl.uniforms.uW, N = gl.uniforms.uN, X = tex('uX'), idx = y * ow + x;
          if (idx < N) { const q = at(X, idx % W, Math.floor(idx / W)); v = q / (1 + Math.exp(-q)); }
        } else if (k === 'rope') {
          // 逐像素重現 FS_ROPE（與 GLSL 同一組索引：t、rem、r2、i、o）
          const W = gl.uniforms.uW, T = gl.uniforms.uT, H = gl.uniforms.uH, hd = gl.uniforms.uHd, dir = gl.uniforms.uDir, X = tex('uX');
          const d = H * hd, idx = y * ow + x;
          if (idx < T * d) {
            const t = Math.floor(idx / d), rem = idx - t * d, r2 = rem % hd, i = Math.floor(r2 / 2), o = idx - (r2 - 2 * i);
            const th = t * Math.pow(10000, -2 * i / hd), c = Math.cos(th), s = dir * Math.sin(th);
            const a = at(X, o % W, Math.floor(o / W)), b = at(X, (o + 1) % W, Math.floor((o + 1) / W));
            v = (r2 === 2 * i) ? (a * c - b * s) : (a * s + b * c);
          }
        } else if (k === 'adamw_p' || k === 'adamw_m' || k === 'adamw_v') {
          // 逐像素重現 fsAdamw 的三個輸出（同一組公式）
          const W = gl.uniforms.uW, N = gl.uniforms.uN, idx = y * ow + x;
          if (idx < N) {
            const at2 = (t) => at(t, idx % W, Math.floor(idx / W));
            const p0 = at2(tex('uP')), g = at2(tex('uG')), m0 = at2(tex('uM')), v0 = at2(tex('uV'));
            const m2 = gl.uniforms.uB1 * m0 + (1 - gl.uniforms.uB1) * g;
            const v2 = gl.uniforms.uB2 * v0 + (1 - gl.uniforms.uB2) * g * g;
            if (k === 'adamw_p') v = p0 - gl.uniforms.uLr * gl.uniforms.uWd * p0 - gl.uniforms.uLr * (m2 / gl.uniforms.uC1) / (Math.sqrt(v2 / gl.uniforms.uC2) + gl.uniforms.uEps);
            else if (k === 'adamw_m') v = m2;
            else v = v2;
          }
        } else if (k === 'sum') {
          const W = gl.uniforms.uW, N = gl.uniforms.uN, j = y * gl.uniforms.uOW + x;
          if (j * 4 < N) for (let q = 0; q < 4; q++) { const e = j * 4 + q; if (e < N) v += at(tex('uA'), e % W, Math.floor(e / W)); }
        }
        out.data[(y * ow + x) * 4] = v;
      }
    },
    readPixels(x, y, w, h, f, ty, px) { px.set(gl.fbo.tex.data.subarray(0, w * h * 4)); },
    deleteTexture() {},
    deleteFramebuffer() {}
  };
  return gl;
}

module.exports = { fakeNavigator, fakeGl };
