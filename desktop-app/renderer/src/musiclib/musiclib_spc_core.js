/* SPC700 處理器＋S-DSP 渲染核心（UMD，純邏輯；不碰 DOM、不用網路、不碰音訊裝置）。
 *   createCore(init) → core：init 可給 { ram(65536), dsp(128), pc, a, x, y, psw, sp, ports(4), control, extraRam(64) }（與 .spc 檔同義）。
 *   core.renderStereo(L, R, off, n)：產生 n 個 32000 Hz 立體聲樣本（Float32，約 −1..1）寫入 L、R。
 *   core.snapshot() ／ core.restore(s)：保存與還原完整狀態（給播放器的檢查點 seek 用）。
 *   其他：core.peek(a)、core.poke(a, bytes)、core.dspRead(r)、core.dspWrite(r, v)、core.portOut(i)、core.setPortIn(i, v)、core.runCycles(n)、core.cpu()、core.unknownOps()。
 *
 * 規格來源（全部自寫，沒有抄任何程式碼；未參考任何 GPL 或授權不明的實作）：
 *   - fullsnes（Martin Korth）SNES 硬體文件：SPC700 指令表、旗標、定址模式、計時器、$F0–$FF 的 I/O 暫存器、S-DSP 暫存器表、
 *     BRR 格式、ADSR／GAIN 速率表、音高調變、噪音、回音與 FIR。
 *   - anomie 的 SNES 文件：SPC700 指令週期與 S-DSP 取樣時序（每 32 個 SPC 時脈產生一個取樣，1.024 MHz ÷ 32 = 32000 Hz）。
 *   - IPL ROM（64 位元組啟動程式）：與公開文件的反組譯一致；測試會驗證它的 AA／BB 握手。
 *
 * 已知近似（寫進報告，不假裝與硬體逐位元相同）：
 *   1) 高斯插值表用公式產生（σ = 0.6、四點、歸一化），不是硬體的 512 項逐點表，音色細節會有差異。
 *   2) BRR 範圍 13–15（非法值）的輸出是近似；DAS 的進位細節與 DIV 溢位時的怪異結果只做近似。
 *   3) KON 立即生效（硬體約延遲 5 個取樣）；SPC 檔不含 DSP 內部包絡狀態，載入時以 KON 位元與 ENVX 決定要不要重新起音。
 *   4) 主 CPU 的通訊埠沒有另一端：輸入埠讀回的是 SPC 檔內的值（或 setPortIn 設定的值）。
 *   5) SLEEP／STOP 指令會讓 CPU 停住，DSP 仍照常產生取樣（包絡會自然衰減）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibSpcCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───── 常數表 ─────
  // IPL ROM（$FFC0–$FFFF）：啟動握手、等待 $F4=$CC、接收資料的標準啟動程式（64 位元組）。
  var IPL = [
    0xCD, 0xEF, 0xBD, 0xE8, 0x00, 0xC6, 0x1D, 0xD0, 0xFC, 0x8F, 0xAA, 0xF4, 0x8F, 0xBB, 0xF5, 0x78,
    0xCC, 0xF4, 0xD0, 0xFB, 0x2F, 0x19, 0xEB, 0xF4, 0xD0, 0xFC, 0x7E, 0xF4, 0xD0, 0x0B, 0xE4, 0xF5,
    0xCB, 0xF4, 0xD7, 0x00, 0xFC, 0xD0, 0xF3, 0xAB, 0x01, 0x10, 0xEF, 0x7E, 0xF4, 0x10, 0xEB, 0xBA,
    0xF6, 0xDA, 0x00, 0xBA, 0xF4, 0xC4, 0xF4, 0xDD, 0x5D, 0xD0, 0xDB, 0x1F, 0x00, 0x00, 0xC0, 0xFF
  ];
  // 每個運算碼的基本週期（SPC 時脈，1.024 MHz）。分支成立時另外加 2。
  var CYC = [
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 6, 8,
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 4, 6,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 4, 5, 4,
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 6, 5, 2, 2, 3, 8,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 6, 6,
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 4, 5, 2, 2, 4, 3,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 4, 5, 5,
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 6,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 6, 5, 4, 5, 2, 4, 5,
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 12, 5,
    3, 8, 4, 5, 3, 4, 3, 6, 2, 6, 4, 4, 5, 2, 4, 4,
    2, 8, 4, 5, 4, 5, 5, 6, 5, 5, 5, 5, 2, 2, 3, 4,
    3, 8, 4, 5, 4, 5, 4, 7, 2, 5, 6, 4, 5, 2, 4, 9,
    2, 8, 4, 5, 5, 6, 6, 7, 4, 5, 5, 5, 2, 2, 6, 3,
    2, 8, 4, 5, 3, 4, 3, 6, 2, 4, 5, 3, 4, 3, 4, 3,
    2, 8, 4, 5, 4, 5, 5, 6, 3, 4, 5, 4, 2, 2, 4, 3
  ];
  // 長度計數的速率表（32 項；0 表示不動）。週期的單位是 DSP 取樣（32 kHz）。
  var RATE = [0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80,
    64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1];
  var CTR_PERIOD = 30720;     // 所有速率週期的最小公倍數（2^11 × 3 × 5），計數器在這裡迴圈
  var ENV_MAX = 0x7FF;
  var M_OFF = 0, M_ATT = 1, M_DEC = 2, M_SUS = 3, M_REL = 4, M_GAIN = 5;

  // 高斯插值：256 個分數位置 × 4 個取樣點（最舊到最新的 s[-3..0]）；公式產生的近似，已歸一化
  var GAUSS = (function () {
    var t = new Float64Array(1024), sig = 0.6, i, k;
    for (i = 0; i < 256; i++) {
      var c = -1 + i / 256, w = [], sum = 0;
      for (k = 0; k < 4; k++) { var d = (k - 3) - c; w[k] = Math.exp(-d * d / (2 * sig * sig)); sum += w[k]; }
      for (k = 0; k < 4; k++) t[i * 4 + k] = w[k] / sum;
    }
    return t;
  })();

  function clamp16(x) { return x > 32767 ? 32767 : x < -32768 ? -32768 : x; }
  function sg8(x) { return (x << 24) >> 24; }

  function createCore(init) {
    init = init || {};
    var ram = new Uint8Array(65536);
    var dspRegs = new Uint8Array(128);
    var unknown = 0;
    var r = { a: 0, x: 0, y: 0, sp: 0xEF, pc: 0xFFC0, n: 0, v: 0, p: 0, b: 0, h: 0, i: 0, z: 0, c: 0, halted: 0 };
    var io = { control: 0x80, dspAddr: 0, out: [0, 0, 0, 0], inp: [0, 0, 0, 0], div: [0, 0, 0], stage: [0, 0, 0], cnt: [0, 0, 0], acc: [0, 0, 0] };
    var voices = [], v;
    for (v = 0; v < 8; v++) voices.push(newVoice());
    var st = { ctr: 0, lfsr: 0x4000, echoOff: 0, echoHL: new Int32Array(8), echoHR: new Int32Array(8), pendKon: 0, pendKoff: 0, dspAcc: 0, outL: 0, outR: 0 };

    function newVoice() {
      return { mode: M_OFF, env: 0, frac: 0, hist: new Int32Array(4), block: new Int32Array(16), idx: 16, addr: 0, loopAddr: 0,
        endAfter: false, endLoop: false, stop: false, p1: 0, p2: 0, out: 0 };
    }

    // ───── 記憶體與 I/O ─────
    function rd(a) {
      a &= 0xFFFF;
      if (a >= 0xF0 && a <= 0xFF) {
        switch (a) {
          case 0xF2: return io.dspAddr;
          case 0xF3: return dspRegs[io.dspAddr & 0x7F];
          case 0xF4: case 0xF5: case 0xF6: case 0xF7: return io.inp[a - 0xF4];
          case 0xFD: case 0xFE: case 0xFF: { var k = a - 0xFD, c = io.cnt[k]; io.cnt[k] = 0; return c; }
          default: break;
        }
      }
      if (a >= 0xFFC0 && (io.control & 0x80)) return IPL[a - 0xFFC0];
      return ram[a];
    }
    function wr(a, val) {
      a &= 0xFFFF; val &= 0xFF;
      ram[a] = val;                                       // 底下的 RAM 一律寫入（$FFC0 的 IPL 是唯讀，但底下仍是 RAM）
      if (a < 0xF0 || a > 0xFF) return;
      switch (a) {
        case 0xF1: writeControl(val); break;
        case 0xF2: io.dspAddr = val; break;
        case 0xF3: if (!(io.dspAddr & 0x80)) dspWrite(io.dspAddr & 0x7F, val); break;
        case 0xF4: case 0xF5: case 0xF6: case 0xF7: io.out[a - 0xF4] = val; break;
        case 0xFA: io.div[0] = val; break;
        case 0xFB: io.div[1] = val; break;
        case 0xFC: io.div[2] = val; break;
        default: break;
      }
    }
    function writeControl(val) {
      for (var k = 0; k < 3; k++) {
        if (((val >> k) & 1) && !((io.control >> k) & 1)) { io.stage[k] = 0; io.cnt[k] = 0; io.acc[k] = 0; }
      }
      if (val & 0x10) { io.inp[0] = 0; io.inp[1] = 0; }
      if (val & 0x20) { io.inp[2] = 0; io.inp[3] = 0; }
      io.control = val;
    }
    function tickClock(c) {
      for (var k = 0; k < 3; k++) {
        var period = k < 2 ? 128 : 16;                    // T0、T1：8 kHz；T2：64 kHz
        io.acc[k] += c;
        while (io.acc[k] >= period) {
          io.acc[k] -= period;
          if ((io.control >> k) & 1) {
            io.stage[k]++;
            if (io.stage[k] >= (io.div[k] || 256)) { io.stage[k] = 0; io.cnt[k] = (io.cnt[k] + 1) & 15; }
          }
        }
      }
    }

    // ───── 堆疊與定址 ─────
    function push(x) { ram[0x100 | r.sp] = x & 0xFF; r.sp = (r.sp - 1) & 0xFF; }
    function pop() { r.sp = (r.sp + 1) & 0xFF; return ram[0x100 | r.sp]; }
    function fetch() { var x = rd(r.pc); r.pc = (r.pc + 1) & 0xFFFF; return x; }
    function fetch16() { var lo = fetch(); return lo | (fetch() << 8); }
    function dpA(o) { return (r.p ? 0x100 : 0) | (o & 0xFF); }
    function ptrDp(o) { return rd(dpA(o)) | (rd(dpA(o + 1)) << 8); }
    function getPSW() { return (r.n << 7) | (r.v << 6) | (r.p << 5) | (r.b << 4) | (r.h << 3) | (r.i << 2) | (r.z << 1) | r.c; }
    function setPSW(x) { r.n = (x >> 7) & 1; r.v = (x >> 6) & 1; r.p = (x >> 5) & 1; r.b = (x >> 4) & 1; r.h = (x >> 3) & 1; r.i = (x >> 2) & 1; r.z = (x >> 1) & 1; r.c = x & 1; }
    function nz(x) { x &= 0xFF; r.n = x >> 7; r.z = x ? 0 : 1; return x; }

    // ───── 算術與邏輯 ─────
    function adc(a, b) {
      var c = r.c, s = a + b + c;
      r.h = ((a & 15) + (b & 15) + c) > 15 ? 1 : 0;
      r.v = ((a ^ s) & (b ^ s) & 0x80) ? 1 : 0;
      r.c = s > 255 ? 1 : 0;
      return nz(s);
    }
    function cmp(a, b) {
      var s = (a - b) & 0xFF;
      r.c = a >= b ? 1 : 0;
      r.v = ((a ^ b) & (a ^ s) & 0x80) ? 1 : 0;
      nz(s);
    }
    // k：0 OR、1 AND、2 EOR、3 CMP（不寫回）、4 ADC、5 SBC
    function alu(k, a, b) {
      switch (k) {
        case 0: return nz(a | b);
        case 1: return nz(a & b);
        case 2: return nz(a ^ b);
        case 3: cmp(a, b); return a;
        case 4: return adc(a, b);
        default: return adc(a, b ^ 0xFF);
      }
    }
    // 移位與加減 1：k 0 ASL、1 ROL、2 LSR、3 ROR、4 DEC、5 INC（DEC／INC 不動 C）
    function unop(k, x) {
      switch (k) {
        case 0: r.c = x >> 7; return nz((x << 1) & 0xFF);
        case 1: { var cin = r.c; r.c = x >> 7; return nz(((x << 1) | cin) & 0xFF); }
        case 2: r.c = x & 1; return nz(x >> 1);
        case 3: { var cin2 = r.c; r.c = x & 1; return nz((x >> 1) | (cin2 << 7)); }
        case 4: return nz((x - 1) & 0xFF);
        default: return nz((x + 1) & 0xFF);
      }
    }
    // 16 位元加減：ya 與 m；sub 時用補數加上進位 1
    function word(ya, m, sub) {
      var yalo = ya & 0xFF, yahi = (ya >> 8) & 0xFF, mlo = m & 0xFF, mhi = (m >> 8) & 0xFF;
      var bl = sub ? (mlo ^ 0xFF) : mlo, bh = sub ? (mhi ^ 0xFF) : mhi;
      var s0 = yalo + bl + (sub ? 1 : 0), c0 = (s0 >> 8) & 1, lo = s0 & 0xFF;
      var s1 = yahi + bh + c0, hi = s1 & 0xFF;
      r.h = ((yahi & 15) + (bh & 15) + c0) > 15 ? 1 : 0;
      r.v = ((yahi ^ hi) & (bh ^ hi) & 0x80) ? 1 : 0;
      r.c = s1 > 0xFF ? 1 : 0;
      var res = (hi << 8) | lo;
      r.n = (res >> 15) & 1; r.z = res ? 0 : 1;
      return res;
    }
    function branch(cond) {
      var rel = fetch();
      if (cond) { r.pc = (r.pc + sg8(rel)) & 0xFFFF; return 2; }
      return 0;
    }
    function tcall(n) {
      push(r.pc >> 8); push(r.pc & 0xFF);
      var a = 0xFFDE - 2 * n;
      r.pc = rd(a) | (rd(a + 1) << 8);
    }
    // 讀取一個「記憶體.位元」運算元：16 位元，低 13 位是位址，高 3 位是位元號
    function bitOp() { var w = fetch16(); return { a: w & 0x1FFF, b: w >> 13 }; }

    // A 為目標的 ALU 運算元（hi 0..0xB、lo 4..8 的各種定址）
    function operandA(odd, lo) {
      if (!odd) {
        switch (lo) {
          case 4: return rd(dpA(fetch()));
          case 5: return rd(fetch16());
          case 6: return rd(dpA(r.x));
          case 7: return rd(ptrDp((fetch() + r.x) & 0xFF));
          default: return fetch();                        // 8：#imm
        }
      }
      switch (lo) {
        case 4: return rd(dpA((fetch() + r.x) & 0xFF));
        case 5: return rd((fetch16() + r.x) & 0xFFFF);
        case 6: return rd((fetch16() + r.y) & 0xFFFF);
        default: return rd((ptrDp(fetch()) + r.y) & 0xFFFF);   // 7：[dp]+Y
      }
    }

    // ───── 指令執行（回傳額外週期，分支成立時為 2）─────
    function exec(op) {
      var hi = op >> 4, lo = op & 15, odd = hi & 1, k, addr, val, t, res, extra = 0;
      // 規則族：TCALL、SET1／CLR1、BBS／BBC、條件分支
      if (lo === 1) { tcall(hi); return 0; }
      if (lo === 2) { var bitS = hi >> 1, dA = dpA(fetch()); val = rd(dA); wr(dA, odd ? (val & ~(1 << bitS)) : (val | (1 << bitS))); return 0; }
      if (lo === 3) { var bitB = hi >> 1, dB = dpA(fetch()), relB = fetch(), setB = (rd(dB) >> bitB) & 1; var takeB = odd ? !setB : !!setB; if (takeB) { r.pc = (r.pc + sg8(relB)) & 0xFFFF; return 2; } return 0; }
      if (lo === 0 && hi) {
        switch (hi) {
          case 1: return branch(!r.n);                    // BPL
          case 3: return branch(!!r.n);                   // BMI
          case 5: return branch(!r.v);                    // BVC
          case 7: return branch(!!r.v);                   // BVS
          case 9: return branch(!r.c);                    // BCC
          case 0xB: return branch(!!r.c);                 // BCS
          case 0xD: return branch(!r.z);                  // BNE
          case 0xF: return branch(!!r.z);                 // BEQ
          default: break;
        }
      }
      // 算術邏輯族（OR、AND、EOR、CMP、ADC、SBC）：hi 0..0xB、lo 4..9
      if (hi <= 0x0B && lo >= 4 && lo <= 9) {
        k = hi >> 1;
        if (lo === 9 && !odd) { var sv = rd(dpA(fetch())), da = dpA(fetch()); res = alu(k, rd(da), sv); if (k !== 3) wr(da, res); return 0; }
        if (lo === 9 && odd) { var sy = rd(dpA(r.y)), dx = dpA(r.x); res = alu(k, rd(dx), sy); if (k !== 3) wr(dx, res); return 0; }
        if (lo === 8 && odd) { var im = fetch(), dd = dpA(fetch()); res = alu(k, rd(dd), im); if (k !== 3) wr(dd, res); return 0; }
        res = alu(k, r.a, operandA(odd, lo));
        if (k !== 3) r.a = res;
        return 0;
      }
      // 移位與加減 1 的 dp／abs／A 形式（lo 0xB、0xC，hi 0..0xB）
      if (hi <= 0x0B && (lo === 0x0B || lo === 0x0C)) {
        k = hi >> 1;
        if (lo === 0x0B) { addr = odd ? dpA((fetch() + r.x) & 0xFF) : dpA(fetch()); wr(addr, unop(k, rd(addr))); return 0; }
        if (odd) { r.a = unop(k, r.a); return 0; }
        addr = fetch16(); wr(addr, unop(k, rd(addr))); return 0;
      }
      switch (op) {
        case 0x00: return 0;                                      // NOP
        case 0x0A: t = bitOp(); r.c |= (rd(t.a) >> t.b) & 1; return 0;     // OR1 C,m.b
        case 0x2A: t = bitOp(); r.c |= ((rd(t.a) >> t.b) & 1) ^ 1; return 0;   // OR1 C,/m.b
        case 0x4A: t = bitOp(); r.c &= (rd(t.a) >> t.b) & 1; return 0;     // AND1 C,m.b
        case 0x6A: t = bitOp(); r.c &= ((rd(t.a) >> t.b) & 1) ^ 1; return 0;   // AND1 C,/m.b
        case 0x8A: t = bitOp(); r.c ^= (rd(t.a) >> t.b) & 1; return 0;     // EOR1 C,m.b
        case 0xAA: t = bitOp(); r.c = (rd(t.a) >> t.b) & 1; return 0;      // MOV1 C,m.b
        case 0xCA: t = bitOp(); val = rd(t.a); val = (val & ~(1 << t.b)) | (r.c << t.b); wr(t.a, val); return 0;   // MOV1 m.b,C
        case 0xEA: t = bitOp(); wr(t.a, rd(t.a) ^ (1 << t.b)); return 0;  // NOT1 m.b
        case 0x0D: push(getPSW()); return 0;                      // PUSH PSW
        case 0x2D: push(r.a); return 0;
        case 0x4D: push(r.x); return 0;
        case 0x6D: push(r.y); return 0;
        case 0x8E: setPSW(pop()); return 0;                       // POP PSW
        case 0xAE: r.a = pop(); return 0;
        case 0xCE: r.x = pop(); return 0;
        case 0xEE: r.y = pop(); return 0;
        case 0x0E: addr = fetch16(); val = rd(addr); nz((r.a - val) & 0xFF); wr(addr, val | r.a); return 0;   // TSET1
        case 0x4E: addr = fetch16(); val = rd(addr); nz((r.a - val) & 0xFF); wr(addr, val & ~r.a); return 0;  // TCLR1
        case 0x0F: push(r.pc >> 8); push(r.pc & 0xFF); push(getPSW()); r.b = 1; r.i = 0; r.pc = rd(0xFFDE) | (rd(0xFFDF) << 8); return 0;   // BRK
        case 0x1D: r.x = nz(r.x - 1); return 0;                   // DEC X
        case 0x3D: r.x = nz(r.x + 1); return 0;                   // INC X
        case 0xDC: r.y = nz(r.y - 1); return 0;                   // DEC Y
        case 0xFC: r.y = nz(r.y + 1); return 0;                   // INC Y
        case 0x5D: r.x = nz(r.a); return 0;                       // MOV X,A
        case 0x7D: r.a = nz(r.x); return 0;                       // MOV A,X
        case 0xDD: r.a = nz(r.y); return 0;                       // MOV A,Y
        case 0xFD: r.y = nz(r.a); return 0;                       // MOV Y,A
        case 0x9D: r.x = nz(r.sp); return 0;                      // MOV X,SP
        case 0xBD: r.sp = r.x; return 0;                          // MOV SP,X
        case 0x1F: addr = (fetch16() + r.x) & 0xFFFF; r.pc = rd(addr) | (rd((addr + 1) & 0xFFFF) << 8); return 0;   // JMP [!abs+X]
        case 0x2F: { var rel2F = fetch(); r.pc = (r.pc + sg8(rel2F)) & 0xFFFF; return 0; }  // BRA（先取運算元，再加到取完後的 PC）
        case 0x3F: addr = fetch16(); push(r.pc >> 8); push(r.pc & 0xFF); r.pc = addr; return 0;   // CALL
        case 0x4F: addr = fetch(); push(r.pc >> 8); push(r.pc & 0xFF); r.pc = 0xFF00 | addr; return 0;  // PCALL
        case 0x5F: r.pc = fetch16(); return 0;                    // JMP !abs
        case 0x6F: res = pop(); r.pc = res | (pop() << 8); return 0;          // RET
        case 0x7F: setPSW(pop()); res = pop(); r.pc = res | (pop() << 8); return 0;   // RETI
        case 0x20: r.p = 0; return 0;                             // CLRP
        case 0x40: r.p = 1; return 0;                             // SETP
        case 0x60: r.c = 0; return 0;                             // CLRC
        case 0x80: r.c = 1; return 0;                             // SETC
        case 0xA0: r.i = 1; return 0;                             // EI
        case 0xC0: r.i = 0; return 0;                             // DI
        case 0xE0: r.v = 0; r.h = 0; return 0;                    // CLRV
        case 0xED: r.c ^= 1; return 0;                            // NOTC
        case 0xE8: r.a = nz(fetch()); return 0;                   // MOV A,#imm
        case 0xCD: r.x = nz(fetch()); return 0;                   // MOV X,#imm
        case 0x8D: r.y = nz(fetch()); return 0;                   // MOV Y,#imm
        case 0x8F: val = fetch(); addr = dpA(fetch()); wr(addr, val); return 0;   // MOV dp,#imm（不影響旗標）
        case 0x9F: r.a = nz((r.a >> 4) | ((r.a << 4) & 0xF0)); return 0;   // XCN
        case 0xDF: {                                              // DAA
          var av = r.a;
          if (r.c || av > 0x99) { av = (av + 0x60) & 0xFF; r.c = 1; }
          if (r.h || (av & 15) > 9) av = (av + 6) & 0xFF;
          r.a = nz(av); return 0;
        }
        case 0xBE: {                                              // DAS（近似）
          var as = r.a;
          if (!r.c || as > 0x99) { as = (as - 0x60) & 0xFF; r.c = 0; }
          if (!r.h || (as & 15) > 9) as = (as - 6) & 0xFF;
          r.a = nz(as); return 0;
        }
        case 0xCF: { var m = r.y * r.a; r.a = m & 0xFF; r.y = nz((m >> 8) & 0xFF); return 0; }   // MUL YA（N、Z 看 Y）
        case 0x9E: {                                              // DIV YA,X（溢位時結果近似）
          var yav = (r.y << 8) | r.a, xv = r.x;
          r.v = r.y >= xv ? 1 : 0;
          r.h = (r.y & 15) >= (xv & 15) ? 1 : 0;
          if (xv === 0) { r.a = 0xFF; r.y = 0xFF; }
          else { r.a = Math.floor(yav / xv) & 0xFF; r.y = (yav % xv) & 0xFF; }
          nz(r.a); return 0;
        }
        case 0x5A: { addr = fetch(); m = rd(dpA(addr)) | (rd(dpA(addr + 1)) << 8); var yaC = (r.y << 8) | r.a, dC = (yaC - m) & 0xFFFF; r.c = yaC >= m ? 1 : 0; r.n = (dC >> 15) & 1; r.z = dC ? 0 : 1; return 0; }   // CMPW YA,dp
        case 0x7A: { addr = fetch(); m = rd(dpA(addr)) | (rd(dpA(addr + 1)) << 8); res = word((r.y << 8) | r.a, m, false); r.a = res & 0xFF; r.y = res >> 8; return 0; }   // ADDW
        case 0x9A: { addr = fetch(); m = rd(dpA(addr)) | (rd(dpA(addr + 1)) << 8); res = word((r.y << 8) | r.a, m, true); r.a = res & 0xFF; r.y = res >> 8; return 0; }    // SUBW
        case 0xBA: { addr = fetch(); r.a = rd(dpA(addr)); r.y = rd(dpA(addr + 1)); r.n = r.y >> 7; r.z = (r.a | r.y) ? 0 : 1; return 0; }   // MOVW YA,dp
        case 0xDA: { addr = fetch(); wr(dpA(addr), r.a); wr(dpA(addr + 1), r.y); return 0; }   // MOVW dp,YA
        case 0x1A: case 0x3A: {                                   // DECW／INCW dp
          addr = fetch(); var p0 = dpA(addr), p1 = dpA(addr + 1);
          var wv = (rd(p0) | (rd(p1) << 8)) + (op === 0x3A ? 1 : -1); wv &= 0xFFFF;
          wr(p0, wv & 0xFF); wr(p1, wv >> 8); r.n = (wv >> 15) & 1; r.z = wv ? 0 : 1; return 0;
        }
        case 0xCB: wr(dpA(fetch()), r.y); return 0;               // MOV dp,Y
        case 0xCC: wr(fetch16(), r.y); return 0;                  // MOV !abs,Y
        case 0xD8: wr(dpA(fetch()), r.x); return 0;               // MOV dp,X
        case 0xD9: wr(dpA((fetch() + r.y) & 0xFF), r.x); return 0;   // MOV dp+Y,X
        case 0xDB: wr(dpA((fetch() + r.x) & 0xFF), r.y); return 0;   // MOV dp+X,Y
        case 0xC9: wr(fetch16(), r.x); return 0;                  // MOV !abs,X
        case 0xC4: wr(dpA(fetch()), r.a); return 0;               // MOV dp,A
        case 0xC5: wr(fetch16(), r.a); return 0;                  // MOV !abs,A
        case 0xC6: wr(dpA(r.x), r.a); return 0;                   // MOV (X),A
        case 0xC7: wr(ptrDp((fetch() + r.x) & 0xFF), r.a); return 0;   // MOV [dp+X],A
        case 0xD4: wr(dpA((fetch() + r.x) & 0xFF), r.a); return 0;   // MOV dp+X,A
        case 0xD5: wr((fetch16() + r.x) & 0xFFFF, r.a); return 0;    // MOV !abs+X,A
        case 0xD6: wr((fetch16() + r.y) & 0xFFFF, r.a); return 0;    // MOV !abs+Y,A
        case 0xD7: wr((ptrDp(fetch()) + r.y) & 0xFFFF, r.a); return 0;   // MOV [dp]+Y,A
        case 0xAF: wr(dpA(r.x), r.a); r.x = (r.x + 1) & 0xFF; return 0;  // MOV (X)+,A
        case 0xBF: r.a = nz(rd(dpA(r.x))); r.x = (r.x + 1) & 0xFF; return 0;   // MOV A,(X)+
        case 0xE4: r.a = nz(rd(dpA(fetch()))); return 0;          // MOV A,dp
        case 0xE5: r.a = nz(rd(fetch16())); return 0;             // MOV A,!abs
        case 0xE6: r.a = nz(rd(dpA(r.x))); return 0;              // MOV A,(X)
        case 0xE7: r.a = nz(rd(ptrDp((fetch() + r.x) & 0xFF))); return 0;   // MOV A,[dp+X]
        case 0xF4: r.a = nz(rd(dpA((fetch() + r.x) & 0xFF))); return 0;     // MOV A,dp+X
        case 0xF5: r.a = nz(rd((fetch16() + r.x) & 0xFFFF)); return 0;      // MOV A,!abs+X
        case 0xF6: r.a = nz(rd((fetch16() + r.y) & 0xFFFF)); return 0;      // MOV A,!abs+Y
        case 0xF7: r.a = nz(rd((ptrDp(fetch()) + r.y) & 0xFFFF)); return 0; // MOV A,[dp]+Y
        case 0xE9: r.x = nz(rd(fetch16())); return 0;             // MOV X,!abs
        case 0xEB: r.y = nz(rd(dpA(fetch()))); return 0;          // MOV Y,dp
        case 0xEC: r.y = nz(rd(fetch16())); return 0;             // MOV Y,!abs
        case 0xF8: r.x = nz(rd(dpA(fetch()))); return 0;          // MOV X,dp
        case 0xF9: r.x = nz(rd(dpA((fetch() + r.y) & 0xFF))); return 0;     // MOV X,dp+Y
        case 0xFB: r.y = nz(rd(dpA((fetch() + r.x) & 0xFF))); return 0;     // MOV Y,dp+X
        case 0xFA: { val = rd(dpA(fetch())); wr(dpA(fetch()), val); return 0; }   // MOV dp,dp（來源在前）
        case 0x2E: { addr = dpA(fetch()); var relA = fetch(); if (r.a !== rd(addr)) { r.pc = (r.pc + sg8(relA)) & 0xFFFF; return 2; } return 0; }   // CBNE dp,rel
        case 0xDE: { addr = dpA((fetch() + r.x) & 0xFF); var relD = fetch(); if (r.a !== rd(addr)) { r.pc = (r.pc + sg8(relD)) & 0xFFFF; return 2; } return 0; }   // CBNE dp+X,rel
        case 0x6E: { addr = dpA(fetch()); var relE = fetch(); val = (rd(addr) - 1) & 0xFF; wr(addr, val); if (val) { r.pc = (r.pc + sg8(relE)) & 0xFFFF; return 2; } return 0; }   // DBNZ dp,rel
        case 0xFE: { var relF = fetch(); r.y = (r.y - 1) & 0xFF; if (r.y) { r.pc = (r.pc + sg8(relF)) & 0xFFFF; return 2; } return 0; }   // DBNZ Y,rel
        case 0x3E: cmp(r.x, rd(dpA(fetch()))); return 0;          // CMP X,dp
        case 0x1E: cmp(r.x, rd(fetch16())); return 0;             // CMP X,!abs
        case 0x5E: cmp(r.y, rd(fetch16())); return 0;             // CMP Y,!abs
        case 0x7E: cmp(r.y, rd(dpA(fetch()))); return 0;          // CMP Y,dp
        case 0xC8: cmp(r.x, fetch()); return 0;                   // CMP X,#imm
        case 0xAD: cmp(r.y, fetch()); return 0;                   // CMP Y,#imm
        case 0xEF: case 0xFF: r.halted = 1; return 0;             // SLEEP／STOP
        default: unknown++; return 0;
      }
    }
    // 外部取出的變數 m（給上面的 case 共用的暫存）
    var m;

    function step() {
      if (r.halted) return 2;
      var op = fetch();
      return CYC[op] + exec(op);
    }

    // ───── S-DSP ─────
    function dspWrite(a, val) {
      dspRegs[a] = val;
      switch (a) {
        case 0x4C: st.pendKon |= val; break;
        case 0x5C: st.pendKoff |= val; break;
        case 0x7C: dspRegs[0x7C] = 0; break;                   // ENDX：寫入即清除
        case 0x6C: if (val & 0x80) for (var q = 0; q < 8; q++) keyOff(q); break;   // 軟重設：全部釋放
        default: break;
      }
    }
    function dspRead(a) { return dspRegs[a & 0x7F]; }
    function keyOn(q) {
      var vo = voices[q], base = q * 16;
      var d = ((dspRegs[0x5D] << 8) + dspRegs[base + 4] * 4) & 0xFFFF;
      vo.addr = rd(d) | (rd(d + 1) << 8);
      vo.loopAddr = rd(d + 2) | (rd(d + 3) << 8);
      vo.frac = 0; vo.hist.fill(0); vo.block.fill(0); vo.idx = 16; vo.endAfter = false; vo.endLoop = false; vo.stop = false;
      vo.p1 = 0; vo.p2 = 0; vo.env = 0; vo.out = 0;
      vo.mode = (dspRegs[base + 5] & 0x80) ? M_ATT : M_GAIN;
      dspRegs[0x7C] &= ~(1 << q) & 0xFF;
    }
    function keyOff(q) { if (voices[q].mode !== M_OFF) voices[q].mode = M_REL; }
    function stepOK(rate) { return rate !== 0 && (st.ctr % rate) === 0; }
    function decodeBlock(vo) {
      var a = vo.addr, h = ram[a], range = h >> 4, filt = (h >> 2) & 3, p1 = vo.p1, p2 = vo.p2, i, k;
      vo.endAfter = (h & 1) === 1; vo.endLoop = (h & 2) === 2;
      for (i = 0; i < 8; i++) {
        var by = ram[(a + 1 + i) & 0xFFFF];
        for (k = 0; k < 2; k++) {
          var nib = k === 0 ? (by >> 4) : (by & 15);
          if (nib > 7) nib -= 16;
          var s = range <= 12 ? (nib << range) : (nib < 0 ? -0x800 : 0);
          if (filt === 1) s += p1 + ((-p1) >> 4);
          else if (filt === 2) s += (p1 << 1) + ((-(p1 * 3)) >> 5) - p2 + (p2 >> 4);
          else if (filt === 3) s += (p1 << 1) + ((-(p1 * 13)) >> 6) - p2 + ((p2 * 3) >> 4);
          s = clamp16(s);
          vo.block[i * 2 + k] = s;
          p2 = p1; p1 = s;
        }
      }
      vo.p1 = p1; vo.p2 = p2;
      vo.addr = (a + 9) & 0xFFFF; vo.idx = 0;
    }
    // 下一個 BRR 取樣；區塊播完時處理結束旗標（循環跳到迴圈位址，否則釋放並靜音）
    function srcNext(vo, q) {
      if (vo.idx >= 16) {
        if (vo.endAfter) {
          dspRegs[0x7C] |= (1 << q);
          if (vo.endLoop) vo.addr = vo.loopAddr;
          else { vo.stop = true; if (vo.mode !== M_OFF) vo.mode = M_REL; }
          vo.endAfter = false;
        }
        if (vo.stop) return 0;
        decodeBlock(vo);
      }
      return vo.block[vo.idx++];
    }
    function interp(vo) {
      var g = (vo.frac >> 4) * 4, h = vo.hist;
      return clamp16(Math.round(GAUSS[g] * h[0] + GAUSS[g + 1] * h[1] + GAUSS[g + 2] * h[2] + GAUSS[g + 3] * h[3]));
    }
    function envTick(vo, q) {
      if (vo.mode === M_OFF) return;
      var base = q * 16, adsr1 = dspRegs[base + 5], adsr2 = dspRegs[base + 6], gain = dspRegs[base + 7], e;
      if (vo.mode === M_REL) {
        vo.env -= 8;
        if (vo.env <= 0) { vo.env = 0; vo.mode = M_OFF; }
        return;
      }
      if (vo.mode === M_GAIN) {
        if (gain & 0x80) {
          var kind = (gain >> 5) & 3, rate = RATE[gain & 31];
          if (stepOK(rate)) {
            e = vo.env;
            if (kind === 0) e -= 32;
            else if (kind === 1) e -= ((e - 1) >> 8) + 1;
            else if (kind === 2) e += 32;
            else e += e < 0x600 ? 32 : 8;
            vo.env = e;
          }
        } else vo.env = (gain & 0x7F) << 4;
      } else if (vo.mode === M_ATT) {
        if (stepOK(RATE[((adsr1 & 15) * 2) + 1])) vo.env += (adsr1 & 15) === 15 ? 0x400 : 0x20;
        if (vo.env >= ENV_MAX) { vo.env = ENV_MAX; vo.mode = M_DEC; }
      } else if (vo.mode === M_DEC) {
        if (stepOK(RATE[(((adsr1 >> 4) & 7) * 2) + 16])) vo.env -= ((vo.env - 1) >> 8) + 1;
        if (vo.env <= ((adsr2 >> 5) + 1) * 0x100) vo.mode = M_SUS;
      } else if (vo.mode === M_SUS) {
        if (stepOK(RATE[adsr2 & 31])) vo.env -= ((vo.env - 1) >> 8) + 1;
      }
      if (vo.env < 0) vo.env = 0;
      if (vo.env > ENV_MAX) vo.env = ENV_MAX;
    }
    // 產生一個 DSP 取樣（32 kHz）
    function dspTick() {
      var flg = dspRegs[0x6C], q, pendK, pmon = dspRegs[0x2D], non = dspRegs[0x3D], eon = dspRegs[0x4C] && 0;
      eon = dspRegs[0x4D];
      if (st.pendKon) { for (q = 0; q < 8; q++) if ((st.pendKon >> q) & 1) keyOn(q); st.pendKon = 0; }
      if (st.pendKoff) { for (q = 0; q < 8; q++) if ((st.pendKoff >> q) & 1) keyOff(q); st.pendKoff = 0; }
      pendK = 0;
      var nRate = RATE[flg & 31];
      if (stepOK(nRate)) { var fb = (st.lfsr ^ (st.lfsr >> 1)) & 1; st.lfsr = (st.lfsr >> 1) | (fb << 14); }
      var noiseS = (st.lfsr << 17) >> 16;
      var mixL = 0, mixR = 0, eL = 0, eR = 0, prev = 0;
      for (q = 0; q < 8; q++) {
        var vo = voices[q], base = q * 16;
        var pitch = dspRegs[base + 2] | ((dspRegs[base + 3] & 0x3F) << 8);
        if (q > 0 && ((pmon >> q) & 1)) pitch += ((prev >> 5) * pitch) >> 10;
        if (pitch < 0) pitch = 0;
        if (pitch > 0x3FFF) pitch = 0x3FFF;
        envTick(vo, q);
        var s = 0;
        if (vo.mode !== M_OFF) {
          vo.frac += pitch;
          while (vo.frac >= 4096) {
            vo.frac -= 4096;
            var ns = srcNext(vo, q);
            vo.hist[0] = vo.hist[1]; vo.hist[1] = vo.hist[2]; vo.hist[2] = vo.hist[3]; vo.hist[3] = ns;
          }
          s = ((non >> q) & 1) ? noiseS : interp(vo);
        }
        var out = (s * vo.env) >> 11;
        var vL = (out * sg8(dspRegs[base])) >> 7, vR = (out * sg8(dspRegs[base + 1])) >> 7;
        vo.out = out;
        dspRegs[base + 8] = vo.env >> 4;
        dspRegs[base + 9] = (out >> 8) & 0xFF;
        prev = out;
        mixL += vL; mixR += vR;
        if ((eon >> q) & 1) { eL += vL; eR += vR; }
      }
      // 回音：讀出延遲的兩個取樣，FIR 濾波，寫回（FLG 的回音寫入位元可停止寫入）
      var esa = dspRegs[0x6D] << 8, edl = dspRegs[0x7D] & 15, elen = edl ? edl * 2048 : 4;
      var ea = (esa + st.echoOff) & 0xFFFF;
      var inL = ram[ea] | (((ram[(ea + 1) & 0xFFFF] << 24) >> 16)), inR = ram[(ea + 2) & 0xFFFF] | (((ram[(ea + 3) & 0xFFFF] << 24) >> 16));
      var j, firL = 0, firR = 0;
      for (j = 7; j > 0; j--) { st.echoHL[j] = st.echoHL[j - 1]; st.echoHR[j] = st.echoHR[j - 1]; }
      st.echoHL[0] = inL; st.echoHR[0] = inR;
      for (j = 0; j < 8; j++) { var cf = sg8(dspRegs[0x0F + j * 16]); firL += cf * st.echoHL[j]; firR += cf * st.echoHR[j]; }
      firL = clamp16(firL >> 7); firR = clamp16(firR >> 7);
      if (!(flg & 0x20)) {
        var efb = sg8(dspRegs[0x0D]);
        var wL = clamp16(clamp16(eL) + ((firL * efb) >> 7)), wR = clamp16(clamp16(eR) + ((firR * efb) >> 7));
        ram[ea] = wL & 0xFF; ram[(ea + 1) & 0xFFFF] = (wL >> 8) & 0xFF;
        ram[(ea + 2) & 0xFFFF] = wR & 0xFF; ram[(ea + 3) & 0xFFFF] = (wR >> 8) & 0xFF;
      }
      st.echoOff = (st.echoOff + 4) % elen;
      var oL = clamp16(((clamp16(mixL) * sg8(dspRegs[0x0C])) >> 7) + ((firL * sg8(dspRegs[0x2C])) >> 7));
      var oR = clamp16(((clamp16(mixR) * sg8(dspRegs[0x1C])) >> 7) + ((firR * sg8(dspRegs[0x3C])) >> 7));
      if (flg & 0x40) { oL = 0; oR = 0; }
      st.ctr = (st.ctr + 1) % CTR_PERIOD;
      st.outL = oL / 32768; st.outR = oR / 32768;
    }

    // 執行 CPU、計時器與 DSP，直到 DSP 產生一個取樣
    function runSample() {
      for (;;) {
        var c = step();
        tickClock(c);
        st.dspAcc += c;
        if (st.dspAcc >= 32) { st.dspAcc -= 32; break; }
      }
      dspTick();
    }

    // ───── 初始化（SPC 檔或 IPL 開機）─────
    function loadInit() {
      if (init.ram) ram.set(init.ram.subarray(0, 65536));
      if (init.extraRam && init.extraRam.length) ram.set(init.extraRam.subarray(0, 64), 0xFFC0);
      if (init.dsp) dspRegs.set(init.dsp.subarray(0, 128));
      r.a = init.a || 0; r.x = init.x || 0; r.y = init.y || 0;
      r.sp = init.sp != null ? init.sp & 0xFF : 0xEF;
      r.pc = init.pc != null ? init.pc & 0xFFFF : 0xFFC0;
      setPSW(init.psw || 0);
      if (init.ram) {
        io.control = init.ram[0xF1] | 0;
        if (init.ram) for (var p = 0; p < 4; p++) { io.out[p] = init.ram[0xF4 + p]; io.inp[p] = init.ram[0xF4 + p]; }
        io.dspAddr = init.ram[0xF2];
        io.div[0] = init.ram[0xFA]; io.div[1] = init.ram[0xFB]; io.div[2] = init.ram[0xFC];
      } else {
        io.control = 0x80;
      }
      if (init.ports) for (var pi = 0; pi < 4; pi++) io.inp[pi] = init.ports[pi] & 0xFF;
      if (!init.dsp) dspRegs[0x6C] = 0xE0;                    // 開機的 FLG（靜音、停止回音）
      // 依 SPC 檔的 DSP 暫存器重新起音：KON 位元或 ENVX > 0 的聲道重新 KON
      if (init.dsp) {
        for (var qv = 0; qv < 8; qv++) {
          var kon = (dspRegs[0x4C] >> qv) & 1, envx = dspRegs[qv * 16 + 8];
          if (kon || envx > 0) { st.pendKon |= (1 << qv); }
        }
        dspRegs[0x4C] = 0;
        // 等 dspTick 第一次執行時才真正 KON（需要 DIR 與 ram 都就緒，這裡已就緒）
        for (qv = 0; qv < 8; qv++) if ((st.pendKon >> qv) & 1) keyOn(qv);
        st.pendKon = 0;
      }
    }
    loadInit();

    return {
      renderStereo: function (L, R, off, n) {
        off = off || 0;
        for (var i = 0; i < n; i++) { runSample(); L[off + i] = st.outL; R[off + i] = st.outR; }
        return n;
      },
      runCycles: function (n) { var done = 0; while (done < n) { var c = step(); tickClock(c); done += c; } return done; },
      runSamples: function (n) { for (var i = 0; i < n; i++) runSample(); return n; },
      snapshot: function () {
        return {
          ram: ram.slice(), dsp: dspRegs.slice(), r: JSON.stringify(r),
          io: { control: io.control, dspAddr: io.dspAddr, out: io.out.slice(), inp: io.inp.slice(), div: io.div.slice(), stage: io.stage.slice(), cnt: io.cnt.slice(), acc: io.acc.slice() },
          voices: voices.map(function (vo) {
            return { mode: vo.mode, env: vo.env, frac: vo.frac, hist: vo.hist.slice(), block: vo.block.slice(), idx: vo.idx, addr: vo.addr, loopAddr: vo.loopAddr,
              endAfter: vo.endAfter, endLoop: vo.endLoop, stop: vo.stop, p1: vo.p1, p2: vo.p2, out: vo.out };
          }),
          st: { ctr: st.ctr, lfsr: st.lfsr, echoOff: st.echoOff, echoHL: st.echoHL.slice(), echoHR: st.echoHR.slice(), pendKon: st.pendKon, pendKoff: st.pendKoff, dspAcc: st.dspAcc, outL: st.outL, outR: st.outR }
        };
      },
      restore: function (s) {
        ram.set(s.ram); dspRegs.set(s.dsp); Object.assign(r, JSON.parse(s.r));
        io.control = s.io.control; io.dspAddr = s.io.dspAddr; io.out = s.io.out.slice(); io.inp = s.io.inp.slice(); io.div = s.io.div.slice();
        io.stage = s.io.stage.slice(); io.cnt = s.io.cnt.slice(); io.acc = s.io.acc.slice();
        for (var q = 0; q < 8; q++) {
          var vs = s.voices[q], vo = voices[q];
          vo.mode = vs.mode; vo.env = vs.env; vo.frac = vs.frac; vo.hist = vs.hist.slice(); vo.block = vs.block.slice(); vo.idx = vs.idx;
          vo.addr = vs.addr; vo.loopAddr = vs.loopAddr; vo.endAfter = vs.endAfter; vo.endLoop = vs.endLoop; vo.stop = vs.stop; vo.p1 = vs.p1; vo.p2 = vs.p2; vo.out = vs.out;
        }
        st.ctr = s.st.ctr; st.lfsr = s.st.lfsr; st.echoOff = s.st.echoOff; st.echoHL = s.st.echoHL.slice(); st.echoHR = s.st.echoHR.slice();
        st.pendKon = s.st.pendKon; st.pendKoff = s.st.pendKoff; st.dspAcc = s.st.dspAcc; st.outL = s.st.outL; st.outR = s.st.outR;
      },
      peek: function (a) { return ram[a & 0xFFFF]; },
      poke: function (a, bytes) { if (typeof bytes === 'number') { ram[a & 0xFFFF] = bytes & 0xFF; return; } for (var i = 0; i < bytes.length; i++) ram[(a + i) & 0xFFFF] = bytes[i] & 0xFF; },
      dspRead: dspRead, dspWrite: dspWrite,
      portOut: function (i) { return io.out[i & 3]; },
      setPortIn: function (i, val) { io.inp[i & 3] = val & 0xFF; },
      cpu: function () { return { a: r.a, x: r.x, y: r.y, sp: r.sp, pc: r.pc, psw: getPSW(), halted: r.halted }; },
      unknownOps: function () { return unknown; },
      timerCount: function (i) { return io.cnt[i]; },
      voiceMode: function (q) { return voices[q].mode; }
    };
  }

  // 由 .spc 檔的解析結果（musiclib_extract_sfc.js 的 parseSpc）建立核心
  function fromSpc(spc) {
    return createCore({ ram: spc.ram, dsp: spc.dsp, extraRam: spc.extraRam, pc: spc.pc, a: spc.a, x: spc.x, y: spc.y, psw: spc.psw, sp: spc.sp });
  }

  return {
    createCore: createCore, fromSpc: fromSpc, IPL: IPL, CYC: CYC, RATE: RATE, GAUSS: GAUSS, CTR_PERIOD: CTR_PERIOD
  };
}));
