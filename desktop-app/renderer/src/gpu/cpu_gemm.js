'use strict';
// 純 CPU GEMM（GotoBLAS 風格）：外層分塊（NC×KC×MC）、把 A 與 B 打包成連續的小面板、內層 MR×NR 微核心。
// 轉置在打包時處理（不整個矩陣轉置、不改輸入）。累加用 double（JS number），最後才寫成 Float32，誤差比逐步寫入 Float32 小。
// 介面：gemmPacked(A, B, m, k, n, opts)；opts 可以是布林（視為 transB）或 {transA, transB, MC, KC, NC}。
// 邏輯 shape：A 是 m×k、B 是 k×n、C 是 m×n。transA：A 以 k×m 儲存；transB：B 以 n×k 儲存。
const MR = 4, NR = 8;
const DEF_MC = 96, DEF_KC = 256, DEF_NC = 512;

function gemmPacked(A, B, m, k, n, opts) {
  const o = typeof opts === 'boolean' ? { transB: opts } : (opts || {});
  const transA = !!o.transA, transB = !!o.transB;
  const MC = o.MC || DEF_MC, KC = o.KC || DEF_KC, NC = o.NC || DEF_NC;
  const C = new Float32Array(m * n);
  if (m === 0 || n === 0 || k === 0) return C;
  const acc = new Float64Array(MR * NR);
  const Ap = new Float32Array(Math.ceil(MC / MR) * MR * KC);
  const Bp = new Float32Array(Math.ceil(NC / NR) * NR * KC);
  for (let jc = 0; jc < n; jc += NC) {
    const nc = Math.min(NC, n - jc);
    for (let pc = 0; pc < k; pc += KC) {
      const kc = Math.min(KC, k - pc);
      packB(B, transB, n, k, pc, kc, jc, nc, Bp);
      for (let ic = 0; ic < m; ic += MC) {
        const mc = Math.min(MC, m - ic);
        packA(A, transA, m, k, ic, mc, pc, kc, Ap);
        macro(Ap, Bp, C, n, ic, jc, mc, nc, kc, acc);
      }
    }
  }
  return C;
}

// 打包 A 的 mc×kc 區塊：面板 ir（MR 列）內依 p 連續存放 MR 個值；不足 MR 的列補 0。
function packA(A, transA, m, k, ic, mc, pc, kc, Ap) {
  let w = 0;
  for (let ir = 0; ir < mc; ir += MR) {
    const mr = Math.min(MR, mc - ir);
    for (let p = 0; p < kc; p++) {
      for (let i = 0; i < MR; i++) {
        if (i < mr) {
          const row = ic + ir + i, col = pc + p;
          Ap[w++] = transA ? A[col * m + row] : A[row * k + col];
        } else Ap[w++] = 0;
      }
    }
  }
}

// 打包 B 的 kc×nc 區塊：面板 jr（NR 欄）內依 p 連續存放 NR 個值；不足 NR 的欄補 0。
function packB(B, transB, n, k, pc, kc, jc, nc, Bp) {
  let w = 0;
  for (let jr = 0; jr < nc; jr += NR) {
    const nr = Math.min(NR, nc - jr);
    for (let p = 0; p < kc; p++) {
      for (let j = 0; j < NR; j++) {
        if (j < nr) {
          const col = jc + jr + j, row = pc + p;
          Bp[w++] = transB ? B[col * k + row] : B[row * n + col];
        } else Bp[w++] = 0;
      }
    }
  }
}

function macro(Ap, Bp, C, ldc, ic, jc, mc, nc, kc, acc) {
  for (let jr = 0; jr < nc; jr += NR) {
    const nr = Math.min(NR, nc - jr);
    const bOff = (jr / NR) * NR * kc;
    for (let ir = 0; ir < mc; ir += MR) {
      const mr = Math.min(MR, mc - ir);
      const aOff = (ir / MR) * MR * kc;
      micro(kc, Ap, aOff, Bp, bOff, acc);
      const cBase = (ic + ir) * ldc + (jc + jr);
      for (let i = 0; i < mr; i++) {
        for (let j = 0; j < nr; j++) C[cBase + i * ldc + j] += acc[i * NR + j];
      }
    }
  }
}

// 微核心：MR×NR 個 double 累加器，沿 kc 連續讀兩個打包面板。
function micro(kc, Ap, aOff, Bp, bOff, acc) {
  for (let t = 0; t < MR * NR; t++) acc[t] = 0;
  for (let p = 0; p < kc; p++) {
    const a = aOff + p * MR, b = bOff + p * NR;
    for (let i = 0; i < MR; i++) {
      const av = Ap[a + i];
      const r = i * NR;
      for (let j = 0; j < NR; j++) acc[r + j] += av * Bp[b + j];
    }
  }
}

// 參考：朴素三重迴圈，雙精度累加（只用於交叉驗證）
function gemmNaive(A, B, m, k, n, opts) {
  const o = typeof opts === 'boolean' ? { transB: opts } : (opts || {});
  const transA = !!o.transA, transB = !!o.transB;
  const C = new Float64Array(m * n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
    let s = 0;
    for (let p = 0; p < k; p++) {
      const av = transA ? A[p * m + i] : A[i * k + p];
      const bv = transB ? B[j * k + p] : B[p * n + j];
      s += av * bv;
    }
    C[i * n + j] = s;
  }
  return C;
}

// WASM SIMD 版：同樣的分塊與打包，但面板直接寫在 wasm 線性記憶體裡，微核心由 cpu_gemm_wasm.js 提供（沒有每次呼叫的拷貝）。
// 不支援 SIMD 時拋錯；呼叫端應先用 simdSupported() 判斷。
function simdSupported() { return require('./cpu_gemm_wasm.js').simdSupported(); }
function gemmPackedSimd(A, B, m, k, n, opts) {
  const W = require('./cpu_gemm_wasm.js');
  const o = typeof opts === 'boolean' ? { transB: opts } : (opts || {});
  const transA = !!o.transA, transB = !!o.transB;
  const MC = o.MC || DEF_MC, KC = o.KC || DEF_KC, NC = o.NC || DEF_NC;
  const C = new Float32Array(m * n);
  if (m === 0 || n === 0 || k === 0) return C;
  const apBytes = Math.ceil(MC / MR) * MR * KC * 4;
  const bpBytes = Math.ceil(NC / NR) * NR * KC * 4;
  const outOff = apBytes + bpBytes;
  const { mk, memory } = W.getKernel(outOff + 128);
  const f32 = new Float32Array(memory.buffer);               // 在 getKernel 之後才取，記憶體可能已放大
  const Ap = f32.subarray(0, apBytes / 4);
  const Bp = f32.subarray(apBytes / 4, (apBytes + bpBytes) / 4);
  const out = f32.subarray(outOff / 4, outOff / 4 + 32);
  for (let jc = 0; jc < n; jc += NC) {
    const nc = Math.min(NC, n - jc);
    for (let pc = 0; pc < k; pc += KC) {
      const kc = Math.min(KC, k - pc);
      packB(B, transB, n, k, pc, kc, jc, nc, Bp);
      for (let ic = 0; ic < m; ic += MC) {
        const mc = Math.min(MC, m - ic);
        packA(A, transA, m, k, ic, mc, pc, kc, Ap);
        for (let jr = 0; jr < nc; jr += NR) {
          const nr = Math.min(NR, nc - jr);
          const bOff = apBytes + (jr / NR) * NR * kc * 4;
          for (let ir = 0; ir < mc; ir += MR) {
            const mr = Math.min(MR, mc - ir);
            const aOff = (ir / MR) * MR * kc * 4;
            mk(kc, aOff, bOff, outOff);
            const cBase = (ic + ir) * n + (jc + jr);
            for (let i = 0; i < mr; i++) for (let j = 0; j < nr; j++) C[cBase + i * n + j] += out[i * NR + j];
          }
        }
      }
    }
  }
  return C;
}

// 原地轉置（只在 opts.inplace === true 時使用；預設絕不改動呼叫端輸入）。
// X 是 rows×cols 的行主序陣列；轉置後 X 變成 cols×rows 的行主序（同一塊記憶體）。
// 方陣：兩兩交換（對稱位置），不需額外記憶體。非方陣：循環跟隨（元素 i 去 i·rows mod (N−1)），
// 用位元組陣列記錄已搬過的位置，額外記憶體約 N/8 位元組（N = rows·cols），時間 O(N)。
function transposeInPlace(X, rows, cols) {
  if (X.length < rows * cols) throw new Error('transposeInPlace：陣列長度不足');
  if (rows === cols) {
    for (let i = 0; i < rows; i++) for (let j = i + 1; j < cols; j++) {
      const t = X[i * cols + j]; X[i * cols + j] = X[j * cols + i]; X[j * cols + i] = t;
    }
    return X;
  }
  const N = rows * cols;
  if (N <= 1) return X;
  const seen = new Uint8Array(Math.ceil(N / 8));
  const mark = (p) => { seen[p >> 3] |= (1 << (p & 7)); };
  const isMarked = (p) => (seen[p >> 3] & (1 << (p & 7))) !== 0;
  for (let start = 1; start < N - 1; start++) {
    if (isMarked(start)) continue;
    let cur = start, carry = X[start];
    do {
      const next = (cur * rows) % (N - 1);
      const tmp = X[next]; X[next] = carry; carry = tmp;
      mark(cur);
      cur = next;
    } while (cur !== start);
    mark(start);
  }
  return X;
}

// 含 inplace 選項的 GEMM：inplace 為 true 且 transA／transB 時，先在呼叫端的陣列上原地轉置，再用不轉置的核心算。
// 注意：這會「改動」呼叫端的 A／B（轉置後的內容），呼叫端必須接受這點；預設（沒給 inplace）完全不改動輸入，走打包時轉置。
function gemmWithOptions(A, B, m, k, n, opts) {
  const o = opts || {};
  if (o.inplace === true) {
    let Aw = A, Bw = B, tA = !!o.transA, tB = !!o.transB;
    if (tA) { transposeInPlace(A, k, m); tA = false; }   // A 以 k×m 儲存 → 轉成 m×k
    if (tB) { transposeInPlace(B, n, k); tB = false; }   // B 以 n×k 儲存 → 轉成 k×n
    return gemmPacked(Aw, Bw, m, k, n, Object.assign({}, o, { transA: tA, transB: tB, inplace: false }));
  }
  return gemmPacked(A, B, m, k, n, o);
}

module.exports = { gemmPacked, gemmPackedSimd, simdSupported, gemmNaive, packA, packB, transposeInPlace, gemmWithOptions, MR, NR, DEF_MC, DEF_KC, DEF_NC };
