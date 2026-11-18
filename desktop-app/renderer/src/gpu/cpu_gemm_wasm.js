'use strict';
// WASM SIMD（f32x4）微核心：沒有編譯器可用，所以直接在 JS 組出 wasm 二進位，再用 WebAssembly.validate 驗證。
// 微核心：4×8 累加器（每列兩個 v128），沿 kc 讀打包的 A 面板（每 p 4 個 f32）與 B 面板（每 p 8 個 f32），結束時寫出 32 個 f32 到 out。
// 乘與加分開做（不用 relaxed-simd 的 fma，因為這台 Sandy Bridge 沒有 FMA，且 node 16 預設沒開 relaxed）。
// 不支援 SIMD 時 simdSupported() 為 false，呼叫端退回純 JS 的 packed 核心。

function uleb(n) { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; }
function sleb(n) {
  const out = []; let more = true;
  while (more) { let b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) more = false; else b |= 0x80; out.push(b); }
  return out;
}
function str(s) { const b = Array.from(new TextEncoder().encode(s)); return uleb(b.length).concat(b); }   // 瀏覽器沒有 Buffer，用 TextEncoder
function section(id, bytes) { return [id].concat(uleb(bytes.length), bytes); }
const memarg = (off) => [0x00].concat(uleb(off)); // align 提示 0（一定合法），offset

// 區域變數：0..3 參數（kc, aOff, bOff, outOff，皆 i32）；4..6 i32（p, pa, pb）；7..14 八個累加器；15 b0；16 b1；17 av（v128）
const P = 4, PA = 5, PB = 6, ACC0 = 7, B0 = 15, B1 = 16, AV = 17;

function body() {
  const c = [];
  const get = (i) => c.push(0x20, i), set = (i) => c.push(0x21, i);
  // 累加器清零：f32.const 0 → f32x4.splat
  for (let j = 0; j < 8; j++) { c.push(0x43, 0, 0, 0, 0); c.push(0xfd, 0x13); set(ACC0 + j); }
  get(1); set(PA); get(2); set(PB);
  c.push(0x41, 0); set(P);                                  // p = 0
  c.push(0x02, 0x40, 0x03, 0x40);                           // block / loop
  get(P); get(0); c.push(0x4e, 0x0d, 1);                    // if p >= kc: br_if 1（跳出 block）
  get(PB); c.push(0xfd, 0x00, ...memarg(0)); set(B0);       // b0 = v128.load(pb)
  get(PB); c.push(0xfd, 0x00, ...memarg(16)); set(B1);      // b1 = v128.load(pb+16)
  for (let i = 0; i < 4; i++) {
    get(PA); c.push(0x2a, 0x00, ...uleb(4 * i));            // f32.load(pa + 4i)
    c.push(0xfd, 0x13); set(AV);                            // splat
    get(ACC0 + 2 * i); get(AV); get(B0); c.push(0xfd, 0xe6, 0x01, 0xfd, 0xe4, 0x01); set(ACC0 + 2 * i);
    get(ACC0 + 2 * i + 1); get(AV); get(B1); c.push(0xfd, 0xe6, 0x01, 0xfd, 0xe4, 0x01); set(ACC0 + 2 * i + 1);
  }
  get(PA); c.push(0x41, 16, 0x6a); set(PA);                 // pa += 16
  get(PB); c.push(0x41, 32, 0x6a); set(PB);                 // pb += 32
  get(P); c.push(0x41, 1, 0x6a); set(P);                    // p++
  c.push(0x0c, 0);                                          // br 0（回到 loop）
  c.push(0x0b, 0x0b);                                       // end loop, end block
  for (let j = 0; j < 8; j++) { get(3); get(ACC0 + j); c.push(0xfd, 0x0b, ...memarg(16 * j)); } // v128.store(out + 16j)
  return c;
}

function buildModule() {
  const type = section(1, [1, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 0]);
  const func = section(3, [1, 0]);
  const mem = section(5, [1, 0x00, 1]);                     // 1 頁起（呼叫端另外會設定大小，見 ensureMemory）
  const exp = section(7, [2].concat(str('mk'), [0, 0], str('mem'), [2, 0]));
  const code = body();
  const locals = [2, 3, 0x7f, 11, 0x7b];                    // 3 個 i32、11 個 v128
  const fbody = locals.concat(code, [0x0b]);
  const codeSec = section(10, [1].concat(uleb(fbody.length), fbody));
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0].concat(type, func, mem, exp, codeSec));
}

let inst = null, memory = null, simdOk = null;
function simdSupported() {
  if (simdOk !== null) return simdOk;
  try {
    simdOk = typeof WebAssembly === 'object' && WebAssembly.validate(buildModule());
  } catch (_) { simdOk = false; }
  return simdOk;
}

// 取得（必要時放大）線性記憶體，回傳 mk(kc, aOff, bOff, outOff) 與 memory
function getKernel(minBytes) {
  if (!simdSupported()) throw new Error('cpu_gemm_wasm：此環境不支援 WASM SIMD');
  if (!inst) {
    const mod = new WebAssembly.Module(buildModule());
    inst = new WebAssembly.Instance(mod, {});
    memory = inst.exports.mem;
  }
  const need = Math.ceil(minBytes / 65536);
  if (memory.buffer.byteLength < need * 65536) memory.grow(need - memory.buffer.byteLength / 65536);
  return { mk: inst.exports.mk, memory };
}

module.exports = { simdSupported, getKernel, buildModule };
