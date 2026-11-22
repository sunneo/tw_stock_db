/* 超任主處理器 65816（UMD，純邏輯；不碰 DOM、不用網路）。
 *   new Cpu(bus)         bus 需提供 read(addr24) → 0–255、write(addr24, v)
 *   cpu.reset()          E=1、I=1、M=X=1、S=$01FF，PC 取自 $FFFC
 *   cpu.step()           執行一道指令（或一次中斷進入）；回傳實際執行的步數（停住時為 0）
 *   cpu.nmiPending = true  請求 NMI（邊緣觸發，執行一次後自動清除）；cpu.irqLine = true 為電位式 IRQ
 *
 * 參考來源（自己從公開文件寫，沒有抄任何程式）：WDC W65C816 資料手冊的指令表與旗標定義、
 * fullsnes（nocash，SNES 硬體文件）的 65816 章節（中斷向量、模式切換、堆疊與直接頁行為）。
 *
 * 範圍與限制（會在報告裡一併寫）：
 *   · 256 個運算碼全部實作（含 WAI、STP、WDM、MVN／MVP 區塊搬移、COP、BRK、RTI、XCE 模式切換）。
 *   · 沒有逐週期計時；step() 每次回傳 1，時序由宿主（musiclib_snes_bus.js）依指令數粗估。
 *   · 十進位（D 旗標）模式的 ADC／SBC 結果與 C 旗標正確；V 旗標用二進位算法，這是近似（真機的 V 在十進位下也不同）。
 *   · 直接頁在 E=1 且 DL=0 時的頁內回繞有處理；其餘硬體的時序邊界（跨頁多一週期）不模擬。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibSnesCpu = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var F_C = 0x01, F_Z = 0x02, F_I = 0x04, F_D = 0x08, F_X = 0x10, F_M = 0x20, F_V = 0x40, F_N = 0x80;
  // ALU 群組（運算碼高 3 位元）：0x0_ ORA、0x2_ AND、0x4_ EOR、0x6_ ADC、0x8_ STA、0xA_ LDA、0xC_ CMP、0xE_ SBC
  var ALU = ['ORA', 'AND', 'EOR', 'ADC', 'STA', 'LDA', 'CMP', 'SBC'];

  function Cpu(bus) {
    this.bus = bus;
    this.A = 0; this.X = 0; this.Y = 0; this.S = 0x1FF; this.D = 0;
    this.DBR = 0; this.PBR = 0; this.PC = 0; this.P = F_I | F_M | F_X; this.E = true;
    this.halted = false; this.stopped = false; this.nmiPending = false; this.irqLine = false;
    this.instructions = 0;
    this.reset();
  }

  // ───── 匯流排存取（位址一律 24 位元）─────
  Cpu.prototype.r8 = function (a) { return this.bus.read(a & 0xFFFFFF) & 0xFF; };
  Cpu.prototype.w8 = function (a, v) { this.bus.write(a & 0xFFFFFF, v & 0xFF); };
  Cpu.prototype.rw = function (a, w) { return w === 1 ? this.r8(a) : (this.r8(a) | (this.r8(a + 1) << 8)); };
  Cpu.prototype.ww = function (a, v, w) { this.w8(a, v); if (w === 2) this.w8(a + 1, v >> 8); };

  Cpu.prototype.fetch8 = function () { var v = this.r8((this.PBR << 16) | this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; };
  Cpu.prototype.fetch16 = function () { var lo = this.fetch8(); return lo | (this.fetch8() << 8); };
  Cpu.prototype.fetch24 = function () { var lo = this.fetch16(); return (lo | (this.fetch8() << 16)) >>> 0; };
  Cpu.prototype.fetchW = function (w) { return w === 1 ? this.fetch8() : this.fetch16(); };

  // ───── 寬度與旗標 ─────
  Cpu.prototype.mw = function () { return (this.P & F_M) ? 1 : 2; };
  Cpu.prototype.xw = function () { return (this.P & F_X) ? 1 : 2; };
  Cpu.prototype.nz = function (v, w) {
    var m = w === 1 ? 0xFF : 0xFFFF, msb = w === 1 ? 0x80 : 0x8000;
    this.P = (this.P & ~(F_N | F_Z)) | ((v & msb) ? F_N : 0) | (((v & m) === 0) ? F_Z : 0);
  };
  Cpu.prototype.getA = function (w) { return w === 1 ? (this.A & 0xFF) : (this.A & 0xFFFF); };
  Cpu.prototype.setA = function (v, w) { this.A = w === 1 ? ((this.A & 0xFF00) | (v & 0xFF)) : (v & 0xFFFF); };
  Cpu.prototype.setX = function (v, w) { this.X = w === 1 ? (v & 0xFF) : (v & 0xFFFF); };
  Cpu.prototype.setY = function (v, w) { this.Y = w === 1 ? (v & 0xFF) : (v & 0xFFFF); };
  // 模式切換後的固定規則：E=1 時 M、X 固定為 1、S 高位元組固定為 1、X／Y 高位元組清零
  Cpu.prototype.fixup = function () {
    if (this.E) { this.P |= F_M | F_X; this.S = 0x100 | (this.S & 0xFF); this.X &= 0xFF; this.Y &= 0xFF; }
    else if (this.P & F_X) { this.X &= 0xFF; this.Y &= 0xFF; }
  };

  // ───── 堆疊（E=1 時堆疊固定在第一頁）─────
  Cpu.prototype.push8 = function (v) {
    this.w8(this.S, v);
    this.S = this.E ? (0x100 | ((this.S - 1) & 0xFF)) : ((this.S - 1) & 0xFFFF);
  };
  Cpu.prototype.pull8 = function () {
    this.S = this.E ? (0x100 | ((this.S + 1) & 0xFF)) : ((this.S + 1) & 0xFFFF);
    return this.r8(this.S);
  };
  Cpu.prototype.push = function (v, w) { if (w === 2) this.push8(v >> 8); this.push8(v & 0xFF); };
  Cpu.prototype.pull = function (w) { var lo = this.pull8(); return w === 1 ? lo : (lo | (this.pull8() << 8)); };

  // ───── 直接頁與指標 ─────
  Cpu.prototype.wrapPtr = function () { return this.E && (this.D & 0xFF) === 0; };
  Cpu.prototype.dpAddr = function (off) { return (this.D + off) & 0xFFFF; };
  Cpu.prototype.dpIdx = function (off, idx) {
    if (this.wrapPtr()) return this.D | ((off + idx) & 0xFF);   // E=1 且 DL=0：頁內回繞
    return (this.D + off + idx) & 0xFFFF;
  };
  // 指標（bank 0 內的 16 位元）；wrap 為真時第二個位元組也在同一頁內取
  Cpu.prototype.ptr16 = function (a, wrap) {
    var hi = wrap ? ((a & 0xFF00) | ((a + 1) & 0xFF)) : ((a + 1) & 0xFFFF);
    return this.r8(a) | (this.r8(hi) << 8);
  };
  Cpu.prototype.ptr24 = function (a) {
    return (this.r8(a) | (this.r8((a + 1) & 0xFFFF) << 8) | (this.r8((a + 2) & 0xFFFF) << 16)) >>> 0;
  };

  // 取出有效位址（會前進 PC）。模式名稱見 aluMode／exec 的呼叫點
  Cpu.prototype.ea = function (mode) {
    var t;
    switch (mode) {
      case 'dp': return this.dpAddr(this.fetch8());
      case 'dpx': return this.dpIdx(this.fetch8(), this.X);
      case 'dpy': return this.dpIdx(this.fetch8(), this.Y);
      case 'abs': return ((this.DBR << 16) | this.fetch16()) & 0xFFFFFF;
      case 'absx': return ((this.DBR << 16) + this.fetch16() + this.X) & 0xFFFFFF;
      case 'absy': return ((this.DBR << 16) + this.fetch16() + this.Y) & 0xFFFFFF;
      case 'long': return this.fetch24();
      case 'longx': return (this.fetch24() + this.X) & 0xFFFFFF;
      case 'sr': return (this.S + this.fetch8()) & 0xFFFF;
      case 'sry': t = (this.S + this.fetch8()) & 0xFFFF; return ((this.DBR << 16) + this.ptr16(t, false) + this.Y) & 0xFFFFFF;
      case 'idp': t = this.dpAddr(this.fetch8()); return ((this.DBR << 16) | this.ptr16(t, this.wrapPtr())) & 0xFFFFFF;
      case 'idpy': t = this.dpAddr(this.fetch8()); return ((this.DBR << 16) + this.ptr16(t, this.wrapPtr()) + this.Y) & 0xFFFFFF;
      case 'idl': return this.ptr24(this.dpAddr(this.fetch8()));
      case 'idly': return (this.ptr24(this.dpAddr(this.fetch8())) + this.Y) & 0xFFFFFF;
      case 'idx': t = this.dpIdx(this.fetch8(), this.X); return ((this.DBR << 16) | this.ptr16(t, this.wrapPtr())) & 0xFFFFFF;
      default: throw new Error('未知定址模式：' + mode);
    }
  };
  // 運算碼低 4 位元與高 4 位元的奇偶，決定 ALU 群組的定址模式（見 fullsnes 的指令表排列）
  function aluMode(L, odd) {
    switch (L) {
      case 0x1: return odd ? 'idpy' : 'idx';
      case 0x2: return 'idp';
      case 0x3: return odd ? 'sry' : 'sr';
      case 0x5: return odd ? 'dpx' : 'dp';
      case 0x7: return odd ? 'idly' : 'idl';
      case 0x9: return odd ? 'absy' : 'imm';
      case 0xD: return odd ? 'absx' : 'abs';
      case 0xF: return odd ? 'longx' : 'long';
      default: return null;
    }
  }

  // ───── 算術與邏輯 ─────
  Cpu.prototype.adc = function (v, w) {
    var m = w === 1 ? 0xFF : 0xFFFF, msb = w === 1 ? 0x80 : 0x8000;
    var a = this.getA(w), c = (this.P & F_C) ? 1 : 0, res, carry, bin, ov;
    v &= m;
    bin = a + v + c;                                   // 二進位結果：V 旗標用它算
    ov = ((~(a ^ v)) & (a ^ bin) & msb) ? F_V : 0;
    if (this.P & F_D) {
      var nibs = w === 1 ? 2 : 4, cn = c, out = 0;
      for (var k = 0; k < nibs; k++) {
        var d = ((a >> (4 * k)) & 0xF) + ((v >> (4 * k)) & 0xF) + cn;
        cn = 0;
        if (d > 9) d += 6;
        if (d > 15) cn = 1;
        out |= (d & 0xF) << (4 * k);
      }
      res = out; carry = cn;
    } else {
      res = bin & m; carry = bin > m ? 1 : 0;
    }
    this.P = (this.P & ~(F_C | F_V)) | (carry ? F_C : 0) | ov;
    this.nz(res, w);
    this.setA(res, w);
  };
  Cpu.prototype.sbc = function (v, w) {
    var m = w === 1 ? 0xFF : 0xFFFF;
    if (!(this.P & F_D)) { this.adc((v & m) ^ m, w); return; }
    var nibs = w === 1 ? 2 : 4, a = this.getA(w), borrow = (this.P & F_C) ? 0 : 1, out = 0;
    // V 旗標（二進位近似）：與二進位 SBC 同算法
    var bin = a - (v & m) - borrow, msb = w === 1 ? 0x80 : 0x8000;
    var ovFlag = ((a ^ (v & m)) & (a ^ bin) & msb) ? F_V : 0;
    for (var k = 0; k < nibs; k++) {
      var d = ((a >> (4 * k)) & 0xF) - ((v >> (4 * k)) & 0xF) - borrow;
      if (d < 0) { d -= 6; borrow = 1; } else borrow = 0;
      out |= (d & 0xF) << (4 * k);
    }
    this.P = (this.P & ~(F_C | F_V)) | (borrow ? 0 : F_C) | ovFlag;
    this.nz(out, w);
    this.setA(out, w);
  };
  Cpu.prototype.cmp = function (reg, v, w) {
    var m = w === 1 ? 0xFF : 0xFFFF;
    var r = (reg & m) - (v & m);
    this.P = (this.P & ~F_C) | (((reg & m) >= (v & m)) ? F_C : 0);
    this.nz(r & m, w);
  };
  Cpu.prototype.shift = function (kind, v, w) {
    var m = w === 1 ? 0xFF : 0xFFFF, msb = w === 1 ? 0x80 : 0x8000, cin = (this.P & F_C) ? 1 : 0, r, c;
    switch (kind) {
      case 'asl': c = (v & msb) ? 1 : 0; r = (v << 1) & m; break;
      case 'lsr': c = v & 1; r = (v >> 1) & m; break;
      case 'rol': c = (v & msb) ? 1 : 0; r = ((v << 1) | cin) & m; break;
      default:    c = v & 1; r = ((v >> 1) | (cin ? msb : 0)) & m; break; // ror
    }
    this.P = (this.P & ~F_C) | (c ? F_C : 0);
    this.nz(r, w);
    return r;
  };
  Cpu.prototype.rmw = function (kind, mode) {
    var w = this.mw(), a = this.ea(mode);
    this.ww(a, this.shift(kind, this.rw(a, w), w), w);
  };
  Cpu.prototype.alu = function (name, v, w) {
    var a;
    switch (name) {
      case 'ORA': this.setA(this.getA(w) | v, w); this.nz(this.getA(w), w); break;
      case 'AND': this.setA(this.getA(w) & v, w); this.nz(this.getA(w), w); break;
      case 'EOR': this.setA(this.getA(w) ^ v, w); this.nz(this.getA(w), w); break;
      case 'ADC': this.adc(v, w); break;
      case 'SBC': this.sbc(v, w); break;
      case 'CMP': this.cmp(this.getA(w), v, w); break;
      case 'LDA': this.setA(v, w); this.nz(v, w); break;
      default: throw new Error('未知 ALU：' + name);
    }
  };

  // ───── 分支與中斷 ─────
  Cpu.prototype.branch = function (cond) {
    var rel = this.fetch8(); if (rel & 0x80) rel -= 256;
    if (cond) this.PC = (this.PC + rel) & 0xFFFF;
  };
  // 硬體中斷與 BRK／COP 共用：E=0 推 PBR、PC、P；E=1 推 PC、P（BRK／COP 的 B 位元為 1，硬體中斷為 0）
  Cpu.prototype.interrupt = function (vecNative, vecEmu, soft) {
    if (!this.E) { this.push8(this.PBR); this.push(this.PC, 2); this.push8(this.P); }
    else { this.push(this.PC, 2); this.push8(soft ? (this.P | F_X) : (this.P & ~F_X)); }
    this.P |= F_I; this.P &= ~F_D;
    this.PBR = 0;
    this.PC = this.rw(this.E ? vecEmu : vecNative, 2);
  };
  Cpu.prototype.reset = function () {
    this.E = true; this.P = F_I | F_M | F_X; this.D = 0; this.DBR = 0; this.PBR = 0; this.S = 0x1FF;
    this.halted = false; this.stopped = false; this.nmiPending = false; this.irqLine = false;
    this.X &= 0xFF; this.Y &= 0xFF;
    this.PC = this.rw(0xFFFC, 2);
  };

  // ───── 單步 ─────
  Cpu.prototype.step = function () {
    if (this.stopped) return 0;
    if (this.halted && (this.nmiPending || this.irqLine)) this.halted = false;
    if (this.nmiPending) {
      this.nmiPending = false;
      this.interrupt(0xFFEA, 0xFFFA, false);
      this.instructions++;
      return 1;
    }
    if (this.irqLine && !(this.P & F_I)) {
      this.interrupt(0xFFEE, 0xFFFE, false);
      this.instructions++;
      return 1;
    }
    if (this.halted) return 0;
    var op = this.fetch8();
    this.exec(op);
    this.instructions++;
    return 1;
  };

  Cpu.prototype.exec = function (op) {
    var L = op & 0xF, hi = op >> 4, mw, xw, a, v, t;
    // 1) ALU 群組（ORA／AND／EOR／ADC／STA／LDA／CMP／SBC 的各種定址）；0x89 是 BIT 立即，不在群組內
    if (op !== 0x89 && ((L === 1 || L === 3 || L === 5 || L === 7 || L === 9 || L === 0xD || L === 0xF) || (L === 2 && (hi & 1)))) {
      var name = ALU[op >> 5], mode = aluMode(L, hi & 1);
      mw = this.mw();
      if (name === 'STA') { a = this.ea(mode); this.ww(a, this.getA(mw), mw); return; }
      if (mode === 'imm') v = this.fetchW(mw);
      else { a = this.ea(mode); v = this.rw(a, mw); }
      this.alu(name, v, mw);
      return;
    }
    mw = this.mw(); xw = this.xw();
    switch (op) {
      // 控制與中斷
      case 0x00: this.fetch8(); this.interrupt(0xFFE6, 0xFFFE, true); return;   // BRK（後面還有一個記號位元組）
      case 0x02: this.fetch8(); this.interrupt(0xFFE4, 0xFFF4, true); return;   // COP
      case 0x40:                                                                 // RTI
        this.P = this.pull8(); this.fixup(); this.PC = this.pull(2);
        if (!this.E) this.PBR = this.pull8();
        return;
      case 0x60: this.PC = (this.pull(2) + 1) & 0xFFFF; return;                 // RTS
      case 0x6B: t = this.pull(2); this.PBR = this.pull8(); this.PC = (t + 1) & 0xFFFF; return; // RTL
      case 0xCB: this.halted = true; return;                                    // WAI
      case 0xDB: this.stopped = true; return;                                   // STP
      case 0xEA: return;                                                        // NOP
      case 0x42: this.fetch8(); return;                                         // WDM（保留）
      case 0x18: this.P &= ~F_C; return;                                        // CLC
      case 0x38: this.P |= F_C; return;                                         // SEC
      case 0x58: this.P &= ~F_I; return;                                        // CLI
      case 0x78: this.P |= F_I; return;                                         // SEI
      case 0xD8: this.P &= ~F_D; return;                                        // CLD
      case 0xF8: this.P |= F_D; return;                                         // SED
      case 0xB8: this.P &= ~F_V; return;                                        // CLV
      case 0xFB: // XCE：C 與 E 互換
        t = this.E ? 1 : 0; this.E = !!(this.P & F_C);
        this.P = (this.P & ~F_C) | (t ? F_C : 0);
        this.fixup(); return;
      case 0xC2: this.P &= ~this.fetch8(); this.fixup(); return;               // REP
      case 0xE2: this.P |= this.fetch8(); this.fixup(); return;                // SEP

      // 分支與跳躍
      case 0x10: this.branch(!(this.P & F_N)); return;                         // BPL
      case 0x30: this.branch(this.P & F_N); return;                            // BMI
      case 0x50: this.branch(!(this.P & F_V)); return;                         // BVC
      case 0x70: this.branch(this.P & F_V); return;                            // BVS
      case 0x90: this.branch(!(this.P & F_C)); return;                         // BCC
      case 0xB0: this.branch(this.P & F_C); return;                            // BCS
      case 0xD0: this.branch(!(this.P & F_Z)); return;                         // BNE
      case 0xF0: this.branch(this.P & F_Z); return;                            // BEQ
      case 0x80: this.branch(true); return;                                    // BRA
      case 0x82: t = this.fetch16(); if (t & 0x8000) t -= 0x10000; this.PC = (this.PC + t) & 0xFFFF; return; // BRL
      case 0x4C: this.PC = this.fetch16(); return;                             // JMP abs
      case 0x5C: t = this.fetch24(); this.PBR = t >>> 16; this.PC = t & 0xFFFF; return; // JML long
      case 0x6C: this.PC = this.rw(this.fetch16(), 2); return;                 // JMP (abs)
      case 0x7C: t = (this.PBR << 16) | ((this.fetch16() + this.X) & 0xFFFF); this.PC = this.rw(t, 2); return; // JMP (abs,X)
      case 0xDC: t = this.ptr24(this.fetch16()); this.PBR = t >>> 16; this.PC = t & 0xFFFF; return; // JML [abs]
      case 0x20: t = this.fetch16(); this.push((this.PC - 1) & 0xFFFF, 2); this.PC = t; return; // JSR abs
      case 0xFC: t = this.fetch16(); this.push((this.PC - 1) & 0xFFFF, 2); this.PC = this.rw((this.PBR << 16) | ((t + this.X) & 0xFFFF), 2); return; // JSR (abs,X)
      case 0x22: t = this.fetch24(); this.push8(this.PBR); this.push((this.PC - 1) & 0xFFFF, 2); this.PBR = t >>> 16; this.PC = t & 0xFFFF; return; // JSL

      // 堆疊
      case 0x08: this.push8(this.P); return;                                   // PHP
      case 0x28: this.P = this.pull8(); this.fixup(); return;                  // PLP
      case 0x48: this.push(this.getA(mw), mw); return;                         // PHA
      case 0x68: v = this.pull(mw); this.setA(v, mw); this.nz(v, mw); return;  // PLA
      case 0xDA: this.push(this.X, xw); return;                                // PHX
      case 0xFA: v = this.pull(xw); this.setX(v, xw); this.nz(v, xw); return;  // PLX
      case 0x5A: this.push(this.Y, xw); return;                                // PHY
      case 0x7A: v = this.pull(xw); this.setY(v, xw); this.nz(v, xw); return;  // PLY
      case 0x0B: this.push(this.D, 2); return;                                 // PHD
      case 0x2B: this.D = this.pull(2); this.nz(this.D, 2); return;            // PLD
      case 0x4B: this.push8(this.PBR); return;                                 // PHK
      case 0x8B: this.push8(this.DBR); return;                                 // PHB
      case 0xAB: this.DBR = this.pull8(); this.nz(this.DBR, 1); return;        // PLB
      case 0xF4: this.push(this.fetch16(), 2); return;                         // PEA
      case 0xD4: this.push(this.ptr16(this.dpAddr(this.fetch8()), this.wrapPtr()), 2); return; // PEI
      case 0x62: t = this.fetch16(); if (t & 0x8000) t -= 0x10000; this.push((this.PC + t) & 0xFFFF, 2); return; // PER

      // 暫存器傳送
      case 0xAA: this.setX(this.getA(xw), xw); this.nz(this.X, xw); return;    // TAX
      case 0xA8: this.setY(this.getA(xw), xw); this.nz(this.Y, xw); return;    // TAY
      case 0x8A: this.setA(this.X, mw); this.nz(this.getA(mw), mw); return;    // TXA
      case 0x98: this.setA(this.Y, mw); this.nz(this.getA(mw), mw); return;    // TYA
      case 0xBA: this.setX(this.S, xw); this.nz(this.X, xw); return;           // TSX
      case 0x9A: this.S = this.E ? (0x100 | (this.X & 0xFF)) : (this.X & 0xFFFF); return; // TXS
      case 0x9B: this.setY(this.X, xw); this.nz(this.Y, xw); return;           // TXY
      case 0xBB: this.setX(this.Y, xw); this.nz(this.X, xw); return;           // TYX
      case 0x1B: this.S = this.E ? (0x100 | (this.A & 0xFF)) : (this.A & 0xFFFF); return; // TCS
      case 0x3B: this.A = this.S; this.nz(this.A, 2); return;                  // TSC
      case 0x5B: this.D = this.A & 0xFFFF; this.nz(this.D, 2); return;         // TCD
      case 0x7B: this.A = this.D; this.nz(this.A, 2); return;                  // TDC
      case 0xEB: t = this.A & 0xFFFF; this.A = ((t & 0xFF) << 8) | (t >> 8); this.nz(this.A & 0xFF, 1); return; // XBA

      // 遞增、遞減（暫存器）
      case 0xE8: this.setX(this.X + 1, xw); this.nz(this.X, xw); return;       // INX
      case 0xC8: this.setY(this.Y + 1, xw); this.nz(this.Y, xw); return;       // INY
      case 0xCA: this.setX(this.X - 1, xw); this.nz(this.X, xw); return;       // DEX
      case 0x88: this.setY(this.Y - 1, xw); this.nz(this.Y, xw); return;       // DEY
      case 0x1A: this.setA(this.getA(mw) + 1, mw); this.nz(this.getA(mw), mw); return; // INC A
      case 0x3A: this.setA(this.getA(mw) - 1, mw); this.nz(this.getA(mw), mw); return; // DEC A

      // 移位（累加器）
      case 0x0A: this.setA(this.shift('asl', this.getA(mw), mw), mw); return;
      case 0x4A: this.setA(this.shift('lsr', this.getA(mw), mw), mw); return;
      case 0x2A: this.setA(this.shift('rol', this.getA(mw), mw), mw); return;
      case 0x6A: this.setA(this.shift('ror', this.getA(mw), mw), mw); return;

      // 移位與遞增、遞減（記憶體）
      case 0x06: this.rmw('asl', 'dp'); return;   case 0x16: this.rmw('asl', 'dpx'); return;
      case 0x0E: this.rmw('asl', 'abs'); return;  case 0x1E: this.rmw('asl', 'absx'); return;
      case 0x46: this.rmw('lsr', 'dp'); return;   case 0x56: this.rmw('lsr', 'dpx'); return;
      case 0x4E: this.rmw('lsr', 'abs'); return;  case 0x5E: this.rmw('lsr', 'absx'); return;
      case 0x26: this.rmw('rol', 'dp'); return;   case 0x36: this.rmw('rol', 'dpx'); return;
      case 0x2E: this.rmw('rol', 'abs'); return;  case 0x3E: this.rmw('rol', 'absx'); return;
      case 0x66: this.rmw('ror', 'dp'); return;   case 0x76: this.rmw('ror', 'dpx'); return;
      case 0x6E: this.rmw('ror', 'abs'); return;  case 0x7E: this.rmw('ror', 'absx'); return;
      case 0xE6: this.incMem('dp', 1); return;    case 0xF6: this.incMem('dpx', 1); return;
      case 0xEE: this.incMem('abs', 1); return;   case 0xFE: this.incMem('absx', 1); return;
      case 0xC6: this.incMem('dp', -1); return;   case 0xD6: this.incMem('dpx', -1); return;
      case 0xCE: this.incMem('abs', -1); return;  case 0xDE: this.incMem('absx', -1); return;

      // 位元測試與設定／清除
      case 0x04: this.tsbtrb('dp', true); return;   case 0x0C: this.tsbtrb('abs', true); return;
      case 0x14: this.tsbtrb('dp', false); return;  case 0x1C: this.tsbtrb('abs', false); return;
      case 0x89: v = this.fetchW(mw); this.P = (this.P & ~F_Z) | (((this.getA(mw) & v) === 0) ? F_Z : 0); return; // BIT #
      case 0x24: this.bit('dp'); return;   case 0x2C: this.bit('abs'); return;
      case 0x34: this.bit('dpx'); return;  case 0x3C: this.bit('absx'); return;

      // 比較（X、Y）
      case 0xE0: this.cmp(this.X, this.fetchW(xw), xw); return;                  // CPX #
      case 0xE4: this.cmp(this.X, this.rw(this.ea('dp'), xw), xw); return;
      case 0xEC: this.cmp(this.X, this.rw(this.ea('abs'), xw), xw); return;
      case 0xC0: this.cmp(this.Y, this.fetchW(xw), xw); return;                  // CPY #
      case 0xC4: this.cmp(this.Y, this.rw(this.ea('dp'), xw), xw); return;
      case 0xCC: this.cmp(this.Y, this.rw(this.ea('abs'), xw), xw); return;

      // 載入（X、Y）
      case 0xA2: v = this.fetchW(xw); this.setX(v, xw); this.nz(v, xw); return; // LDX #
      case 0xA0: v = this.fetchW(xw); this.setY(v, xw); this.nz(v, xw); return; // LDY #
      case 0xA6: this.loadXY('X', 'dp', xw); return;   case 0xB6: this.loadXY('X', 'dpy', xw); return;
      case 0xAE: this.loadXY('X', 'abs', xw); return;  case 0xBE: this.loadXY('X', 'absy', xw); return;
      case 0xA4: this.loadXY('Y', 'dp', xw); return;   case 0xB4: this.loadXY('Y', 'dpx', xw); return;
      case 0xAC: this.loadXY('Y', 'abs', xw); return;  case 0xBC: this.loadXY('Y', 'absx', xw); return;

      // 儲存（X、Y、零）
      case 0x86: this.ww(this.ea('dp'), this.X, xw); return;   case 0x96: this.ww(this.ea('dpy'), this.X, xw); return;
      case 0x8E: this.ww(this.ea('abs'), this.X, xw); return;
      case 0x84: this.ww(this.ea('dp'), this.Y, xw); return;   case 0x94: this.ww(this.ea('dpx'), this.Y, xw); return;
      case 0x8C: this.ww(this.ea('abs'), this.Y, xw); return;
      case 0x64: this.ww(this.ea('dp'), 0, mw); return;        case 0x74: this.ww(this.ea('dpx'), 0, mw); return;
      case 0x9C: this.ww(this.ea('abs'), 0, mw); return;       case 0x9E: this.ww(this.ea('absx'), 0, mw); return;

      // 區塊搬移
      case 0x44: this.blockMove(-1); return;   // MVP
      case 0x54: this.blockMove(1); return;    // MVN

      default:
        throw new Error('未實作的運算碼 $' + op.toString(16).toUpperCase());
    }
  };

  Cpu.prototype.incMem = function (mode, d) {
    var w = this.mw(), a = this.ea(mode), v = (this.rw(a, w) + d) & (w === 1 ? 0xFF : 0xFFFF);
    this.ww(a, v, w); this.nz(v, w);
  };
  Cpu.prototype.tsbtrb = function (mode, set) {
    var w = this.mw(), a = this.ea(mode), v = this.rw(a, w), acc = this.getA(w), m = w === 1 ? 0xFF : 0xFFFF;
    this.P = (this.P & ~F_Z) | (((acc & v) & m) === 0 ? F_Z : 0);
    this.ww(a, set ? (v | acc) : (v & ~acc), w);
  };
  Cpu.prototype.bit = function (mode) {
    var w = this.mw(), a = this.ea(mode), v = this.rw(a, w), acc = this.getA(w), m = w === 1 ? 0xFF : 0xFFFF;
    var msb = w === 1 ? 0x80 : 0x8000, ov = w === 1 ? 0x40 : 0x4000;
    this.P = (this.P & ~(F_Z | F_N | F_V)) | (((acc & v) & m) === 0 ? F_Z : 0) | ((v & msb) ? F_N : 0) | ((v & ov) ? F_V : 0);
  };
  Cpu.prototype.loadXY = function (reg, mode, xw) {
    var v = this.rw(this.ea(mode), xw);
    if (reg === 'X') this.setX(v, xw); else this.setY(v, xw);
    this.nz(v, xw);
  };
  // MVN（dir=1，往上）與 MVP（dir=-1，往下）：一次跑完 C+1 個位元組；operand 為 目的銀行、來源銀行
  Cpu.prototype.blockMove = function (dir) {
    var dst = this.fetch8(), src = this.fetch8(), n = (this.A & 0xFFFF) + 1, xm = (this.P & F_X) ? 0xFF : 0xFFFF;
    while (n-- > 0) {
      this.w8((dst << 16) | this.Y, this.r8((src << 16) | this.X));
      this.X = (this.X + dir) & xm;
      this.Y = (this.Y + dir) & xm;
    }
    this.A = 0xFFFF;
    this.DBR = dst;
  };

  Cpu.F = { C: F_C, Z: F_Z, I: F_I, D: F_D, X: F_X, M: F_M, V: F_V, N: F_N };
  return { Cpu: Cpu, create: function (bus) { return new Cpu(bus); }, F: Cpu.F };
}));
