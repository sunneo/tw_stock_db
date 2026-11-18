'use strict';
// 多核 GEMM：沿 M 方向把列區塊分給工作者。工作者內的核心 gemmRowsSimdKernel 是「自給自足」的函式（所有輔助函式都在裡面），
// 所以可以用 fn.toString() 放進 Blob Worker 或 worker_threads 的 eval 字串，和 cpu_share 的做法一樣。
// 輸入 A、B 若在 SharedArrayBuffer 裡就直接讀（零複製）；否則主執行緒先複製一份進 SAB（或用 postMessage 拷貝，見 transferMode）。
// 輸出：每個工作者寫進自己的列區塊；SAB 可用時直接寫進共享的 C（零複製回傳），否則回傳區塊後由主執行緒拼接。

// 自給自足的 SIMD 列區塊核心：計算 C[rowStart..rowEnd) = A·B（旗標 transA／transB 與 cpu_gemm.js 同義）。
// 回傳 Float32Array（長度 (rowEnd-rowStart)·n）；若傳入 Cout（同長度）則直接寫進 Cout 並回傳它。
function gemmRowsSimdKernel(A, B, m, k, n, transA, transB, rowStart, rowEnd, wasmBytes, MC, KC, NC, Cout) {
  const MR = 4, NR = 8;
  const rows = rowEnd - rowStart;
  const C = Cout || new Float32Array(rows * n);
  if (rows <= 0 || n === 0 || k === 0) return C;
  const apBytes = Math.ceil(MC / MR) * MR * KC * 4;
  const bpBytes = Math.ceil(NC / NR) * NR * KC * 4;
  const outOff = apBytes + bpBytes;
  // 編譯與實例化只做一次（工作者的全域快取，以位元組長度與總和為鍵）。每次呼叫都重新編譯會吃掉約 25 ms，這是小尺寸工作者比主執行緒慢的主因。
  const gl = typeof globalThis !== 'undefined' ? globalThis : self;
  let sum = 0; for (let i = 0; i < wasmBytes.length; i++) sum = (sum * 31 + wasmBytes[i]) | 0;
  const cacheKey = wasmBytes.length + ':' + sum;
  if (!gl.__faGemmInst || gl.__faGemmKey !== cacheKey) {
    gl.__faGemmInst = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
    gl.__faGemmKey = cacheKey;
  }
  const inst = gl.__faGemmInst;
  const need = Math.ceil((outOff + 128) / 65536);
  const memory = inst.exports.mem;
  if (memory.buffer.byteLength < need * 65536) memory.grow(need - memory.buffer.byteLength / 65536);
  const mk = inst.exports.mk;
  const f32 = new Float32Array(memory.buffer);
  const Ap = f32.subarray(0, apBytes / 4);
  const Bp = f32.subarray(apBytes / 4, (apBytes + bpBytes) / 4);
  const out = f32.subarray(outOff / 4, outOff / 4 + 32);
  const packA = (ic, mc, pc, kc) => {
    let w = 0;
    for (let ir = 0; ir < mc; ir += MR) {
      const mr = Math.min(MR, mc - ir);
      for (let p = 0; p < kc; p++) for (let i = 0; i < MR; i++) {
        if (i < mr) { const row = ic + ir + i, col = pc + p; Ap[w++] = transA ? A[col * m + row] : A[row * k + col]; }
        else Ap[w++] = 0;
      }
    }
  };
  const packB = (jc, nc, pc, kc) => {
    let w = 0;
    for (let jr = 0; jr < nc; jr += NR) {
      const nr = Math.min(NR, nc - jr);
      for (let p = 0; p < kc; p++) for (let j = 0; j < NR; j++) {
        if (j < nr) { const col = jc + jr + j, row = pc + p; Bp[w++] = transB ? B[col * k + row] : B[row * n + col]; }
        else Bp[w++] = 0;
      }
    }
  };
  // 列區塊內的 C 是 C[(i-rowStart)·n + j]，所以 C 用相對列號寫入；累加到 C（先清零）
  C.fill(0);
  for (let jc = 0; jc < n; jc += NC) {
    const nc = Math.min(NC, n - jc);
    for (let pc = 0; pc < k; pc += KC) {
      const kc = Math.min(KC, k - pc);
      packB(jc, nc, pc, kc);
      for (let ic = rowStart; ic < rowEnd; ic += MC) {
        const mc = Math.min(MC, rowEnd - ic);
        packA(ic, mc, pc, kc);
        for (let jr = 0; jr < nc; jr += NR) {
          const nr = Math.min(NR, nc - jr);
          const bOff = apBytes + (jr / NR) * NR * kc * 4;
          for (let ir = 0; ir < mc; ir += MR) {
            const mr = Math.min(MR, mc - ir);
            const aOff = (ir / MR) * MR * kc * 4;
            mk(kc, aOff, bOff, outOff);
            const cBase = (ic + ir - rowStart) * n + (jc + jr);
            for (let i = 0; i < mr; i++) for (let j = 0; j < nr; j++) C[cBase + i * n + j] += out[i * NR + j];
          }
        }
      }
    }
  }
  return C;
}

// 把 m 列切成 parts 段，每段列數為 MR 的倍數（最後一段可以不是），回傳 [[rowStart,rowEnd],...]
function splitRowsAligned(m, parts, MR = 4) {
  if (m <= 0) return [];
  const per = Math.max(MR, Math.ceil(Math.ceil(m / parts) / MR) * MR);
  const out = [];
  for (let s = 0; s < m; s += per) out.push([s, Math.min(m, s + per)]);
  return out;
}

// 節點驗證／量測用的工作者驅動：每個工作者以 eval 字串載入 gemmRowsSimdKernel，回傳自己的列區塊。
// 用 SAB 時 A、B、C 都放 SAB（零複製回傳）；否則用 postMessage 複製。
function gemmParallelNode(A, B, m, k, n, opts, workerCount) {
  const { Worker } = require('worker_threads');
  const W = require('./cpu_gemm_wasm.js');
  const o = opts || {};
  const MC = o.MC || 96, KC = o.KC || 256, NC = o.NC || 512;
  const transA = !!o.transA, transB = !!o.transB;
  const wasmBytes = W.buildModule();
  const useSab = typeof SharedArrayBuffer === 'function';
  const parts = splitRowsAligned(m, workerCount);
  const kernelSrc = gemmRowsSimdKernel.toString();
  const src = `const { parentPort, workerData } = require('worker_threads');
const gemmRowsSimdKernel = (${kernelSrc});
parentPort.on('message', (d) => {
  const { A, B, m, k, n, transA, transB, rowStart, rowEnd, wasmBytes, MC, KC, NC, C } = d;
  const Cv = C ? new Float32Array(C.buffer || C, C.byteOffset || 0, (rowEnd - rowStart) * n) : null;
  const res = gemmRowsSimdKernel(A, B, m, k, n, transA, transB, rowStart, rowEnd, wasmBytes, MC, KC, NC, Cv);
  parentPort.postMessage(Cv ? null : res, Cv ? undefined : [res.buffer]);
});`;
  let Aw = A, Bw = B, Cshared = null;
  if (useSab) {
    const sa = new Float32Array(new SharedArrayBuffer(A.length * 4)); sa.set(A); Aw = sa;
    const sb = new Float32Array(new SharedArrayBuffer(B.length * 4)); sb.set(B); Bw = sb;
    Cshared = new Float32Array(new SharedArrayBuffer(m * n * 4));
  }
  return new Promise((resolve, reject) => {
    const C = useSab ? Cshared : new Float32Array(m * n);
    let pending = parts.length;
    const workers = parts.map(([rs, re]) => {
      const w = new Worker(src, { eval: true });
      w.on('message', (res) => {
        if (res) C.set(res, rs * n);
        if (--pending === 0) { workers.forEach((x) => x.terminate()); resolve(C); }
      });
      w.on('error', (e) => { workers.forEach((x) => x.terminate()); reject(e); });
      const payload = { A: Aw, B: Bw, m, k, n, transA, transB, rowStart: rs, rowEnd: re, wasmBytes, MC, KC, NC };
      if (useSab) payload.C = Cshared.subarray(rs * n, re * n);
      w.postMessage(payload);
      return w;
    });
  });
}

// 持久工作者池（節點版）：工作者只建立一次，之後每次呼叫只送資料與列區塊，量到的是計算時間而不是啟動時間。
// 瀏覽器版（Blob Worker）的做法相同，見 cpu_share.js 的 workerSource 模式。
function createRowPool(workerCount) {
  const { Worker } = require('worker_threads');
  const kernelSrc = gemmRowsSimdKernel.toString();
  const src = `const { parentPort } = require('worker_threads');
const gemmRowsSimdKernel = (${kernelSrc});
parentPort.on('message', (d) => {
  const { A, B, m, k, n, transA, transB, rowStart, rowEnd, wasmBytes, MC, KC, NC, C, id } = d;
  const Cv = C ? new Float32Array(C.buffer, C.byteOffset, (rowEnd - rowStart) * n) : null;
  const res = gemmRowsSimdKernel(A, B, m, k, n, transA, transB, rowStart, rowEnd, wasmBytes, MC, KC, NC, Cv);
  if (Cv) parentPort.postMessage({ id, done: true });
  else parentPort.postMessage({ id, C: res }, [res.buffer]);
});`;
  const ws = [];
  for (let i = 0; i < workerCount; i++) ws.push(new Worker(src, { eval: true }));
  let seq = 0;
  const useSab = typeof SharedArrayBuffer === 'function';
  return {
    workers: ws.length,
    shared: useSab,
    run(A, B, m, k, n, opts) {
      const o = opts || {};
      const MC = o.MC || 96, KC = o.KC || 256, NC = o.NC || 512;
      const transA = !!o.transA, transB = !!o.transB;
      const wasmBytes = require('./cpu_gemm_wasm.js').buildModule();
      const parts = splitRowsAligned(m, ws.length);
      let Aw = A, Bw = B, C;
      if (useSab) {
        const sa = new Float32Array(new SharedArrayBuffer(A.length * 4)); sa.set(A); Aw = sa;
        const sb = new Float32Array(new SharedArrayBuffer(B.length * 4)); sb.set(B); Bw = sb;
        C = new Float32Array(new SharedArrayBuffer(m * n * 4));
      } else C = new Float32Array(m * n);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        let pending = parts.length;
        const listeners = [];
        parts.forEach(([rs, re], idx) => {
          const w = ws[idx];
          const onMsg = (msg) => {
            if (msg.id !== id) return;
            if (msg.C) C.set(msg.C, rs * n);
            if (--pending === 0) { cleanup(); resolve(C); }
          };
          const onErr = (e) => { cleanup(); reject(e); };
          const cleanup = () => { listeners.forEach(([x, f, g]) => { x.off('message', f); x.off('error', g); }); };
          w.on('message', onMsg); w.on('error', onErr);
          listeners.push([w, onMsg, onErr]);
          const payload = { A: Aw, B: Bw, m, k, n, transA, transB, rowStart: rs, rowEnd: re, wasmBytes, MC, KC, NC, id };
          if (useSab) payload.C = C.subarray(rs * n, re * n);
          w.postMessage(payload);
        });
        if (parts.length === 0) resolve(C);
      });
    },
    close() { ws.forEach((w) => w.terminate()); },
  };
}

module.exports = { gemmRowsSimdKernel, splitRowsAligned, gemmParallelNode, createRowPool };
