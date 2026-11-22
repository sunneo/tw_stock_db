/* PC Engine（TurboGrafx-16）HuC6280 處理器與匯流排（UMD，純邏輯；不碰 DOM、不用網路）。
 * 本檔是自寫的：指令表依 HuC6280 規格（65C02 指令集加上 TAM／TMA、TST、TII／TDD／TIN／TIA／TAI、SAX／SAY／SXY、CLA／CLX／CLY、CSL／CSH、ST0／ST1／ST2、BSR、SMB／RMB、BBS／BBR）。
 *   createMachine(romBytes, opts)  → { cpu, bus, run(maxMasterTicks), psgWrites }
 *   stripHeader(bytes)             → 去掉 512 位元組的 ROM 檔頭（大小 % 8192 == 512 時）
 *
 * 記憶體對映（MPR 八個銀行，每個 8KB）：
 *   銀行 0x00–0x7F：ROM（超出 ROM 大小時取模，與真機鏡像相同）；0xF8–0xFB：8KB 工作 RAM；0xFF：硬體 I/O；其他：開放匯流排（0xFF）。
 *   重置後 MPR 為 FF F8 F9 FA FB FC FD 00。零頁固定在 $2000、堆疊在 $2100（PCE 的慣例，即 MPR1＝RAM 時的位址）。
 * I/O（銀行 0xFF 內的偏移）：$0000–$03FF VDC（只做狀態與暫存器，不畫面）；$0800–$0BFF PSG（回呼記錄）；$0C00–$0FFF 計時器；$1000–$13FF 搖桿（全部放開＝0xFF）；$1400–$17FF 中斷控制。
 * 時序：主時脈 7159090 Hz。CSH＝1 個 CPU 週期 1 個主時脈；CSL＝4 個主時脈。指令週期數是近似值（依定址方式估計，不逐指令對過真機）。
 * 中斷向量：RESET $FFFE、IRQ2／BRK $FFF6、IRQ1（VDC 垂直消隱）$FFF8、TIQ（計時器）$FFFA。
 * 限制（會寫進擷取報告）：T 旗標的記憶體對記憶體運算尚未實作（SET 只設旗標）；未文件化的操作碼當成單位元組空指令並計數。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibPceCpu = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MASTER_HZ = 7159090;         // 高速主時脈
  var LOW_DIV = 4;                 // 低速（CSL）時每個 CPU 週期佔的主時脈數
  var FRAME_TICKS = 119318;        // 一個畫面（約 60 Hz）的主時脈數
  var TIMER_TICKS = 1024;          // 計時器每跳一次的主時脈數（近似）
  var ZP = 0x2000, STK = 0x2100;
  var F_N = 0x80, F_V = 0x40, F_T = 0x20, F_B = 0x10, F_D = 0x08, F_I = 0x04, F_Z = 0x02, F_C = 0x01;

  function stripHeader(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return (b.length % 8192 === 512) ? b.subarray(512) : b;
  }

  // ───── 匯流排 ─────
  function Bus(rom, hooks) {
    this.rom = rom;
    this.pages = Math.floor(rom.length / 8192);
    this.ram = new Uint8Array(8192);
    this.mpr = [0xFF, 0xF8, 0xF9, 0xFA, 0xFB, 0xFC, 0xFD, 0x00];
    this.hooks = hooks || {};
    // VDC（只留狀態與暫存器）
    this.vdcSel = 0; this.vdcStatus = 0; this.vdcRegs = new Uint16Array(32);
    // 計時器與中斷
    this.timerReload = 0; this.timerCount = 0; this.timerOn = false; this.timerAcc = 0;
    this.irqDisable = 0; this.irqPend = 0;   // 位元：0＝IRQ2、1＝IRQ1、2＝TIQ
    this.ioUnknown = 0;
  }
  Bus.prototype.read = function (a) {
    a &= 0xFFFF;
    var bank = this.mpr[a >> 13], off = a & 0x1FFF;
    if (bank < 0x80) return this.pages ? this.rom[((bank % this.pages) << 13) | off] : 0xFF;
    if (bank >= 0xF8 && bank <= 0xFB) return this.ram[off];
    if (bank === 0xFF) return this.ioRead(off);
    return 0xFF;
  };
  Bus.prototype.write = function (a, v) {
    a &= 0xFFFF; v &= 0xFF;
    var bank = this.mpr[a >> 13], off = a & 0x1FFF;
    if (bank >= 0xF8 && bank <= 0xFB) this.ram[off] = v;
    else if (bank === 0xFF) this.ioWrite(off, v);
  };
  Bus.prototype.ioRead = function (off) {
    if (off < 0x0400) {
      if ((off & 3) === 0) { var s = this.vdcStatus; this.vdcStatus = 0; return s; }
      return 0;
    }
    if (off < 0x1000) {
      if (off >= 0x0C00) return this.timerCount & 0x7F;
      return 0xFF;
    }
    if (off < 0x1400) return 0xFF;               // 搖桿：全部放開
    if (off === 0x1402) return this.irqDisable;
    if (off === 0x1403) return this.irqPend;
    return 0xFF;
  };
  Bus.prototype.ioWrite = function (off, v) {
    if (off < 0x0400) {
      var p = off & 3;
      if (p === 0) this.vdcSel = v & 0x1F;
      else if (p === 2) this.vdcRegs[this.vdcSel] = (this.vdcRegs[this.vdcSel] & 0xFF00) | v;
      else if (p === 3) this.vdcRegs[this.vdcSel] = (this.vdcRegs[this.vdcSel] & 0x00FF) | (v << 8);
      return;
    }
    if (off < 0x0800) return;                    // CPU 速度暫存器：時脈由 CSL／CSH 指令決定，這裡不改
    if (off < 0x0C00) { if (this.hooks.psg) this.hooks.psg(off & 0x0F, v); return; }
    if (off < 0x1000) {
      if ((off & 1) === 0) this.timerReload = v & 0x7F;
      else { var on = !!(v & 1); if (on && !this.timerOn) { this.timerCount = this.timerReload; this.timerAcc = 0; } this.timerOn = on; }
      return;
    }
    if (off < 0x1400) return;                    // 搖桿選擇：忽略
    if (off === 0x1402) this.irqDisable = v & 7;
    else if (off === 0x1403) this.irqPend &= ~4; // 寫入清除 TIQ
  };
  Bus.prototype.vector = function (addr) { return this.read(addr) | (this.read(addr + 1) << 8); };

  // ───── 處理器 ─────
  function Cpu(bus) {
    this.bus = bus;
    this.A = 0; this.X = 0; this.Y = 0; this.S = 0xFF; this.P = F_I; this.PC = 0;
    this.div = 1;                   // 1 ＝高速，LOW_DIV ＝低速
    this.unknown = 0; this.unknownOps = {};
    this.halted = false;
  }
  Cpu.prototype.reset = function () { this.PC = this.bus.vector(0xFFFE); this.P = F_I; this.S = 0xFF; this.div = LOW_DIV; };
  Cpu.prototype.push = function (v) { this.bus.write(STK | this.S, v); this.S = (this.S - 1) & 0xFF; };
  Cpu.prototype.pull = function () { this.S = (this.S + 1) & 0xFF; return this.bus.read(STK | this.S); };
  Cpu.prototype.fetch = function () { var v = this.bus.read(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; };
  Cpu.prototype.fetch16 = function () { var lo = this.fetch(); return lo | (this.fetch() << 8); };
  Cpu.prototype.zpRead16 = function (zp) { return this.bus.read(ZP | (zp & 0xFF)) | (this.bus.read(ZP | ((zp + 1) & 0xFF)) << 8); };
  Cpu.prototype.setNZ = function (v) { this.P = (this.P & ~(F_N | F_Z)) | (v & F_N) | ((v & 0xFF) === 0 ? F_Z : 0); };
  Cpu.prototype.adcBin = function (v) {
    var c = this.P & F_C, a = this.A, sum = a + v + c;
    this.P = (this.P & ~(F_C | F_V)) | (sum > 0xFF ? F_C : 0) | ((~(a ^ v) & (a ^ sum) & 0x80) ? F_V : 0);
    this.A = sum & 0xFF; this.setNZ(this.A);
  };
  Cpu.prototype.adcDec = function (v) {
    var c = this.P & F_C;
    var lo = (this.A & 0x0F) + (v & 0x0F) + c, hi = (this.A >> 4) + (v >> 4);
    if (lo > 9) { lo += 6; hi++; }
    lo &= 0x0F;
    var carry = 0;
    if (hi > 9) { hi += 6; carry = 1; }
    this.A = ((hi & 0x0F) << 4) | lo;
    this.P = (this.P & ~F_C) | (carry ? F_C : 0);
    this.setNZ(this.A);
  };
  Cpu.prototype.sbcDec = function (v) {
    var borrow = (this.P & F_C) ? 0 : 1;
    var lo = (this.A & 0x0F) - (v & 0x0F) - borrow, hi = (this.A >> 4) - (v >> 4);
    if (lo < 0) { lo -= 6; hi--; }
    var carry = 1;
    if (hi < 0) { hi -= 6; carry = 0; }
    this.A = ((hi & 0x0F) << 4) | (lo & 0x0F);
    this.P = (this.P & ~F_C) | (carry ? F_C : 0);
    this.setNZ(this.A);
  };
  Cpu.prototype.adc = function (v) { if (this.P & F_D) this.adcDec(v); else this.adcBin(v); };
  Cpu.prototype.sbc = function (v) { if (this.P & F_D) this.sbcDec(v); else this.adcBin(v ^ 0xFF); };
  Cpu.prototype.cmp = function (r, v) { var t = r - v; this.P = (this.P & ~F_C) | (r >= v ? F_C : 0); this.setNZ(t & 0xFF); };
  Cpu.prototype.branch = function (cond) {
    var rel = this.fetch(); if (rel & 0x80) rel -= 256;
    if (cond) { this.PC = (this.PC + rel) & 0xFFFF; return 4; }
    return 2;
  };
  Cpu.prototype.asl = function (v) { this.P = (this.P & ~F_C) | (v >> 7); v = (v << 1) & 0xFF; this.setNZ(v); return v; };
  Cpu.prototype.lsr = function (v) { this.P = (this.P & ~F_C) | (v & 1); v >>= 1; this.setNZ(v); return v; };
  Cpu.prototype.rol = function (v) { var c = this.P & F_C; this.P = (this.P & ~F_C) | (v >> 7); v = ((v << 1) | c) & 0xFF; this.setNZ(v); return v; };
  Cpu.prototype.ror = function (v) { var c = this.P & F_C; this.P = (this.P & ~F_C) | (v & 1); v = (v >> 1) | (c << 7); this.setNZ(v); return v; };
  Cpu.prototype.irqVector = function () {
    var b = this.bus;
    if ((this.P & F_I) === 0) {
      if ((b.irqPend & 2) && !(b.irqDisable & 2)) { return 0xFFF8; }
      if ((b.irqPend & 4) && !(b.irqDisable & 4)) { return 0xFFFA; }
      if ((b.irqPend & 1) && !(b.irqDisable & 1)) { return 0xFFF6; }
    }
    return 0;
  };
  Cpu.prototype.takeIrq = function (vec) {
    var bitFor = { 0xFFF8: 2, 0xFFFA: 4, 0xFFF6: 1 }[vec];
    this.halted = false;
    this.push(this.PC >> 8); this.push(this.PC & 0xFF); this.push(this.P & ~F_B);
    this.P = (this.P | F_I) & ~(F_D | F_T);
    this.bus.irqPend &= ~bitFor;
    this.PC = this.bus.vector(vec);
    return 8;
  };

  // 單一指令；回傳主時脈數以外的 CPU 週期數（近似）
  Cpu.prototype.step = function () {
    var vec = this.irqVector();
    if (vec) return this.takeIrq(vec) * this.div;
    var op = this.fetch(), b = this.bus, c = 2, t, a, v;
    switch (op) {
      // —— 載入／儲存 ——
      case 0xA9: this.A = this.fetch(); this.setNZ(this.A); break;                                    // LDA #
      case 0xA5: this.A = b.read(ZP | this.fetch()); this.setNZ(this.A); c = 4; break;                 // LDA zp
      case 0xB5: this.A = b.read(ZP | ((this.fetch() + this.X) & 0xFF)); this.setNZ(this.A); c = 4; break;
      case 0xAD: this.A = b.read(this.fetch16()); this.setNZ(this.A); c = 5; break;                    // LDA abs
      case 0xBD: this.A = b.read((this.fetch16() + this.X) & 0xFFFF); this.setNZ(this.A); c = 5; break;
      case 0xB9: this.A = b.read((this.fetch16() + this.Y) & 0xFFFF); this.setNZ(this.A); c = 5; break;
      case 0xB2: this.A = b.read(this.zpRead16(this.fetch())); this.setNZ(this.A); c = 6; break;      // LDA (zp)
      case 0xA1: this.A = b.read(this.zpRead16((this.fetch() + this.X) & 0xFF)); this.setNZ(this.A); c = 7; break;
      case 0xB1: this.A = b.read((this.zpRead16(this.fetch()) + this.Y) & 0xFFFF); this.setNZ(this.A); c = 7; break;
      case 0xA2: this.X = this.fetch(); this.setNZ(this.X); break;                                    // LDX #
      case 0xA6: this.X = b.read(ZP | this.fetch()); this.setNZ(this.X); c = 4; break;
      case 0xB6: this.X = b.read(ZP | ((this.fetch() + this.Y) & 0xFF)); this.setNZ(this.X); c = 4; break;
      case 0xAE: this.X = b.read(this.fetch16()); this.setNZ(this.X); c = 5; break;
      case 0xBE: this.X = b.read((this.fetch16() + this.Y) & 0xFFFF); this.setNZ(this.X); c = 5; break;
      case 0xA0: this.Y = this.fetch(); this.setNZ(this.Y); break;                                    // LDY #
      case 0xA4: this.Y = b.read(ZP | this.fetch()); this.setNZ(this.Y); c = 4; break;
      case 0xB4: this.Y = b.read(ZP | ((this.fetch() + this.X) & 0xFF)); this.setNZ(this.Y); c = 4; break;
      case 0xAC: this.Y = b.read(this.fetch16()); this.setNZ(this.Y); c = 5; break;
      case 0xBC: this.Y = b.read((this.fetch16() + this.X) & 0xFFFF); this.setNZ(this.Y); c = 5; break;
      case 0x85: b.write(ZP | this.fetch(), this.A); c = 4; break;                                    // STA
      case 0x95: b.write(ZP | ((this.fetch() + this.X) & 0xFF), this.A); c = 4; break;
      case 0x8D: b.write(this.fetch16(), this.A); c = 5; break;
      case 0x9D: b.write((this.fetch16() + this.X) & 0xFFFF, this.A); c = 5; break;
      case 0x99: b.write((this.fetch16() + this.Y) & 0xFFFF, this.A); c = 5; break;
      case 0x92: b.write(this.zpRead16(this.fetch()), this.A); c = 6; break;
      case 0x81: b.write(this.zpRead16((this.fetch() + this.X) & 0xFF), this.A); c = 7; break;
      case 0x91: b.write((this.zpRead16(this.fetch()) + this.Y) & 0xFFFF, this.A); c = 7; break;
      case 0x86: b.write(ZP | this.fetch(), this.X); c = 4; break;                                    // STX
      case 0x96: b.write(ZP | ((this.fetch() + this.Y) & 0xFF), this.X); c = 4; break;
      case 0x8E: b.write(this.fetch16(), this.X); c = 5; break;
      case 0x84: b.write(ZP | this.fetch(), this.Y); c = 4; break;                                    // STY
      case 0x94: b.write(ZP | ((this.fetch() + this.X) & 0xFF), this.Y); c = 4; break;
      case 0x8C: b.write(this.fetch16(), this.Y); c = 5; break;
      case 0x64: b.write(ZP | this.fetch(), 0); c = 4; break;                                         // STZ
      case 0x74: b.write(ZP | ((this.fetch() + this.X) & 0xFF), 0); c = 4; break;
      case 0x9C: b.write(this.fetch16(), 0); c = 5; break;
      case 0x9E: b.write((this.fetch16() + this.X) & 0xFFFF, 0); c = 5; break;
      // —— 轉移 ——
      case 0xAA: this.X = this.A; this.setNZ(this.X); break;                                          // TAX
      case 0xA8: this.Y = this.A; this.setNZ(this.Y); break;
      case 0x8A: this.A = this.X; this.setNZ(this.A); break;
      case 0x98: this.A = this.Y; this.setNZ(this.A); break;
      case 0xBA: this.X = this.S; this.setNZ(this.X); break;
      case 0x9A: this.S = this.X; break;                                                              // TXS 不改旗標
      case 0x02: t = this.X; this.X = this.Y; this.Y = t; break;                                      // SXY
      case 0x22: t = this.A; this.A = this.X; this.X = t; break;                                      // SAX
      case 0x42: t = this.A; this.A = this.Y; this.Y = t; break;                                      // SAY
      case 0x62: this.A = 0; c = 2; break;                                                            // CLA
      case 0x82: this.X = 0; break;                                                                   // CLX
      case 0xC2: this.Y = 0; break;                                                                   // CLY
      // —— 堆疊 ——
      case 0x48: this.push(this.A); c = 3; break;                                                     // PHA
      case 0x68: this.A = this.pull(); this.setNZ(this.A); c = 4; break;                              // PLA
      case 0xDA: this.push(this.X); c = 3; break;                                                     // PHX
      case 0xFA: this.X = this.pull(); this.setNZ(this.X); c = 4; break;
      case 0x5A: this.push(this.Y); c = 3; break;                                                     // PHY
      case 0x7A: this.Y = this.pull(); this.setNZ(this.Y); c = 4; break;
      case 0x08: this.push(this.P | F_B); c = 3; break;                                               // PHP
      case 0x28: this.P = this.pull(); c = 4; break;                                                  // PLP
      // —— 算術與邏輯 ——
      case 0x69: this.adc(this.fetch()); break;                                                       // ADC #
      case 0x65: this.adc(b.read(ZP | this.fetch())); c = 4; break;
      case 0x75: this.adc(b.read(ZP | ((this.fetch() + this.X) & 0xFF))); c = 4; break;
      case 0x6D: this.adc(b.read(this.fetch16())); c = 5; break;
      case 0x7D: this.adc(b.read((this.fetch16() + this.X) & 0xFFFF)); c = 5; break;
      case 0x79: this.adc(b.read((this.fetch16() + this.Y) & 0xFFFF)); c = 5; break;
      case 0x72: this.adc(b.read(this.zpRead16(this.fetch()))); c = 6; break;
      case 0x61: this.adc(b.read(this.zpRead16((this.fetch() + this.X) & 0xFF))); c = 7; break;
      case 0x71: this.adc(b.read((this.zpRead16(this.fetch()) + this.Y) & 0xFFFF)); c = 7; break;
      case 0xE9: this.sbc(this.fetch()); break;                                                       // SBC #
      case 0xE5: this.sbc(b.read(ZP | this.fetch())); c = 4; break;
      case 0xF5: this.sbc(b.read(ZP | ((this.fetch() + this.X) & 0xFF))); c = 4; break;
      case 0xED: this.sbc(b.read(this.fetch16())); c = 5; break;
      case 0xFD: this.sbc(b.read((this.fetch16() + this.X) & 0xFFFF)); c = 5; break;
      case 0xF9: this.sbc(b.read((this.fetch16() + this.Y) & 0xFFFF)); c = 5; break;
      case 0xF2: this.sbc(b.read(this.zpRead16(this.fetch()))); c = 6; break;
      case 0xE1: this.sbc(b.read(this.zpRead16((this.fetch() + this.X) & 0xFF))); c = 7; break;
      case 0xF1: this.sbc(b.read((this.zpRead16(this.fetch()) + this.Y) & 0xFFFF)); c = 7; break;
      case 0x29: this.A &= this.fetch(); this.setNZ(this.A); break;                                   // AND #
      case 0x25: this.A &= b.read(ZP | this.fetch()); this.setNZ(this.A); c = 4; break;
      case 0x35: this.A &= b.read(ZP | ((this.fetch() + this.X) & 0xFF)); this.setNZ(this.A); c = 4; break;
      case 0x2D: this.A &= b.read(this.fetch16()); this.setNZ(this.A); c = 5; break;
      case 0x3D: this.A &= b.read((this.fetch16() + this.X) & 0xFFFF); this.setNZ(this.A); c = 5; break;
      case 0x39: this.A &= b.read((this.fetch16() + this.Y) & 0xFFFF); this.setNZ(this.A); c = 5; break;
      case 0x32: this.A &= b.read(this.zpRead16(this.fetch())); this.setNZ(this.A); c = 6; break;
      case 0x21: this.A &= b.read(this.zpRead16((this.fetch() + this.X) & 0xFF)); this.setNZ(this.A); c = 7; break;
      case 0x31: this.A &= b.read((this.zpRead16(this.fetch()) + this.Y) & 0xFFFF); this.setNZ(this.A); c = 7; break;
      case 0x09: this.A |= this.fetch(); this.setNZ(this.A); break;                                   // ORA #
      case 0x05: this.A |= b.read(ZP | this.fetch()); this.setNZ(this.A); c = 4; break;
      case 0x15: this.A |= b.read(ZP | ((this.fetch() + this.X) & 0xFF)); this.setNZ(this.A); c = 4; break;
      case 0x0D: this.A |= b.read(this.fetch16()); this.setNZ(this.A); c = 5; break;
      case 0x1D: this.A |= b.read((this.fetch16() + this.X) & 0xFFFF); this.setNZ(this.A); c = 5; break;
      case 0x19: this.A |= b.read((this.fetch16() + this.Y) & 0xFFFF); this.setNZ(this.A); c = 5; break;
      case 0x12: this.A |= b.read(this.zpRead16(this.fetch())); this.setNZ(this.A); c = 6; break;
      case 0x01: this.A |= b.read(this.zpRead16((this.fetch() + this.X) & 0xFF)); this.setNZ(this.A); c = 7; break;
      case 0x11: this.A |= b.read((this.zpRead16(this.fetch()) + this.Y) & 0xFFFF); this.setNZ(this.A); c = 7; break;
      case 0x49: this.A ^= this.fetch(); this.setNZ(this.A); break;                                   // EOR #
      case 0x45: this.A ^= b.read(ZP | this.fetch()); this.setNZ(this.A); c = 4; break;
      case 0x55: this.A ^= b.read(ZP | ((this.fetch() + this.X) & 0xFF)); this.setNZ(this.A); c = 4; break;
      case 0x4D: this.A ^= b.read(this.fetch16()); this.setNZ(this.A); c = 5; break;
      case 0x5D: this.A ^= b.read((this.fetch16() + this.X) & 0xFFFF); this.setNZ(this.A); c = 5; break;
      case 0x59: this.A ^= b.read((this.fetch16() + this.Y) & 0xFFFF); this.setNZ(this.A); c = 5; break;
      case 0x52: this.A ^= b.read(this.zpRead16(this.fetch())); this.setNZ(this.A); c = 6; break;
      case 0x41: this.A ^= b.read(this.zpRead16((this.fetch() + this.X) & 0xFF)); this.setNZ(this.A); c = 7; break;
      case 0x51: this.A ^= b.read((this.zpRead16(this.fetch()) + this.Y) & 0xFFFF); this.setNZ(this.A); c = 7; break;
      case 0xC9: this.cmp(this.A, this.fetch()); break;                                               // CMP
      case 0xC5: this.cmp(this.A, b.read(ZP | this.fetch())); c = 4; break;
      case 0xD5: this.cmp(this.A, b.read(ZP | ((this.fetch() + this.X) & 0xFF))); c = 4; break;
      case 0xCD: this.cmp(this.A, b.read(this.fetch16())); c = 5; break;
      case 0xDD: this.cmp(this.A, b.read((this.fetch16() + this.X) & 0xFFFF)); c = 5; break;
      case 0xD9: this.cmp(this.A, b.read((this.fetch16() + this.Y) & 0xFFFF)); c = 5; break;
      case 0xD2: this.cmp(this.A, b.read(this.zpRead16(this.fetch()))); c = 6; break;
      case 0xC1: this.cmp(this.A, b.read(this.zpRead16((this.fetch() + this.X) & 0xFF))); c = 7; break;
      case 0xD1: this.cmp(this.A, b.read((this.zpRead16(this.fetch()) + this.Y) & 0xFFFF)); c = 7; break;
      case 0xE0: this.cmp(this.X, this.fetch()); break;                                               // CPX
      case 0xE4: this.cmp(this.X, b.read(ZP | this.fetch())); c = 4; break;
      case 0xEC: this.cmp(this.X, b.read(this.fetch16())); c = 5; break;
      case 0xC0: this.cmp(this.Y, this.fetch()); break;                                               // CPY
      case 0xC4: this.cmp(this.Y, b.read(ZP | this.fetch())); c = 4; break;
      case 0xCC: this.cmp(this.Y, b.read(this.fetch16())); c = 5; break;
      case 0x89: v = this.fetch(); this.P = (this.P & ~F_Z) | ((this.A & v) === 0 ? F_Z : 0); break;   // BIT #（只影響 Z）
      case 0x24: v = b.read(ZP | this.fetch()); this.bitFlags(v); c = 4; break;
      case 0x34: v = b.read(ZP | ((this.fetch() + this.X) & 0xFF)); this.bitFlags(v); c = 4; break;
      case 0x2C: v = b.read(this.fetch16()); this.bitFlags(v); c = 5; break;
      case 0x3C: v = b.read((this.fetch16() + this.X) & 0xFFFF); this.bitFlags(v); c = 5; break;
      // —— 遞增、遞減、移位（累加器與記憶體）——
      case 0x1A: this.A = (this.A + 1) & 0xFF; this.setNZ(this.A); break;                             // INC A
      case 0x3A: this.A = (this.A - 1) & 0xFF; this.setNZ(this.A); break;                             // DEC A
      case 0xE8: this.X = (this.X + 1) & 0xFF; this.setNZ(this.X); break;
      case 0xCA: this.X = (this.X - 1) & 0xFF; this.setNZ(this.X); break;
      case 0xC8: this.Y = (this.Y + 1) & 0xFF; this.setNZ(this.Y); break;
      case 0x88: this.Y = (this.Y - 1) & 0xFF; this.setNZ(this.Y); break;
      case 0x0A: this.A = this.asl(this.A); break;
      case 0x4A: this.A = this.lsr(this.A); break;
      case 0x2A: this.A = this.rol(this.A); break;
      case 0x6A: this.A = this.ror(this.A); break;
      case 0xE6: a = ZP | this.fetch(); v = (b.read(a) + 1) & 0xFF; b.write(a, v); this.setNZ(v); c = 6; break;   // INC zp
      case 0xF6: a = ZP | ((this.fetch() + this.X) & 0xFF); v = (b.read(a) + 1) & 0xFF; b.write(a, v); this.setNZ(v); c = 6; break;
      case 0xEE: a = this.fetch16(); v = (b.read(a) + 1) & 0xFF; b.write(a, v); this.setNZ(v); c = 7; break;
      case 0xFE: a = (this.fetch16() + this.X) & 0xFFFF; v = (b.read(a) + 1) & 0xFF; b.write(a, v); this.setNZ(v); c = 7; break;
      case 0xC6: a = ZP | this.fetch(); v = (b.read(a) - 1) & 0xFF; b.write(a, v); this.setNZ(v); c = 6; break;   // DEC zp
      case 0xD6: a = ZP | ((this.fetch() + this.X) & 0xFF); v = (b.read(a) - 1) & 0xFF; b.write(a, v); this.setNZ(v); c = 6; break;
      case 0xCE: a = this.fetch16(); v = (b.read(a) - 1) & 0xFF; b.write(a, v); this.setNZ(v); c = 7; break;
      case 0xDE: a = (this.fetch16() + this.X) & 0xFFFF; v = (b.read(a) - 1) & 0xFF; b.write(a, v); this.setNZ(v); c = 7; break;
      case 0x06: this.rmw(ZP | this.fetch(), this.asl); c = 6; break;                               // ASL／LSR／ROL／ROR 記憶體
      case 0x16: this.rmw(ZP | ((this.fetch() + this.X) & 0xFF), this.asl); c = 6; break;
      case 0x0E: this.rmw(this.fetch16(), this.asl); c = 7; break;
      case 0x1E: this.rmw((this.fetch16() + this.X) & 0xFFFF, this.asl); c = 7; break;
      case 0x46: this.rmw(ZP | this.fetch(), this.lsr); c = 6; break;
      case 0x56: this.rmw(ZP | ((this.fetch() + this.X) & 0xFF), this.lsr); c = 6; break;
      case 0x4E: this.rmw(this.fetch16(), this.lsr); c = 7; break;
      case 0x5E: this.rmw((this.fetch16() + this.X) & 0xFFFF, this.lsr); c = 7; break;
      case 0x26: this.rmw(ZP | this.fetch(), this.rol); c = 6; break;
      case 0x36: this.rmw(ZP | ((this.fetch() + this.X) & 0xFF), this.rol); c = 6; break;
      case 0x2E: this.rmw(this.fetch16(), this.rol); c = 7; break;
      case 0x3E: this.rmw((this.fetch16() + this.X) & 0xFFFF, this.rol); c = 7; break;
      case 0x66: this.rmw(ZP | this.fetch(), this.ror); c = 6; break;
      case 0x76: this.rmw(ZP | ((this.fetch() + this.X) & 0xFF), this.ror); c = 6; break;
      case 0x6E: this.rmw(this.fetch16(), this.ror); c = 7; break;
      case 0x7E: this.rmw((this.fetch16() + this.X) & 0xFFFF, this.ror); c = 7; break;
      case 0x04: a = ZP | this.fetch(); v = b.read(a); this.P = (this.P & ~F_Z) | ((this.A & v) === 0 ? F_Z : 0); b.write(a, v | this.A); c = 6; break;   // TSB
      case 0x0C: a = this.fetch16(); v = b.read(a); this.P = (this.P & ~F_Z) | ((this.A & v) === 0 ? F_Z : 0); b.write(a, v | this.A); c = 7; break;
      case 0x14: a = ZP | this.fetch(); v = b.read(a); this.P = (this.P & ~F_Z) | ((this.A & v) === 0 ? F_Z : 0); b.write(a, v & ~this.A); c = 6; break;  // TRB
      case 0x1C: a = this.fetch16(); v = b.read(a); this.P = (this.P & ~F_Z) | ((this.A & v) === 0 ? F_Z : 0); b.write(a, v & ~this.A); c = 7; break;
      // —— 旗標 ——
      case 0x18: this.P &= ~F_C; break;                                                              // CLC
      case 0x38: this.P |= F_C; break;                                                               // SEC
      case 0x58: this.P &= ~F_I; break;                                                              // CLI
      case 0x78: this.P |= F_I; break;                                                               // SEI
      case 0xD8: this.P &= ~F_D; break;                                                              // CLD
      case 0xF8: this.P |= F_D; break;                                                               // SED
      case 0xB8: this.P &= ~F_V; break;                                                              // CLV
      case 0xF4: this.P |= F_T; break;                                                               // SET（T 旗標：見檔頭限制）
      case 0x54: this.div = 1; break;                                                                // CSL：低速
      case 0xD4: this.div = LOW_DIV; break;                                                          // CSH：高速（依 HuC6280 的對應）
      case 0xEA: break;                                                                              // NOP
      // —— 跳躍與分支 ——
      case 0x10: c = this.branch(!(this.P & F_N)); break;                                            // BPL
      case 0x30: c = this.branch(this.P & F_N); break;                                               // BMI
      case 0x50: c = this.branch(!(this.P & F_V)); break;                                            // BVC
      case 0x70: c = this.branch(this.P & F_V); break;                                               // BVS
      case 0x90: c = this.branch(!(this.P & F_C)); break;                                            // BCC
      case 0xB0: c = this.branch(this.P & F_C); break;                                               // BCS
      case 0xD0: c = this.branch(!(this.P & F_Z)); break;                                            // BNE
      case 0xF0: c = this.branch(this.P & F_Z); break;                                               // BEQ
      case 0x80: c = this.branch(true); break;                                                       // BRA
      case 0x44: { var rel = this.fetch(); if (rel & 0x80) rel -= 256; var ret = (this.PC - 1) & 0xFFFF; this.push(ret >> 8); this.push(ret & 0xFF); this.PC = (this.PC + rel) & 0xFFFF; c = 8; break; }   // BSR
      case 0x4C: this.PC = this.fetch16(); c = 3; break;                                             // JMP abs
      case 0x6C: this.PC = this.jmpInd(this.fetch16()); c = 6; break;                                // JMP (abs)
      case 0x7C: a = (this.fetch16() + this.X) & 0xFFFF; this.PC = b.read(a) | (b.read((a + 1) & 0xFFFF) << 8); c = 7; break;   // JMP (abs,X)
      case 0x20: a = this.fetch16(); this.push(((this.PC - 1) & 0xFFFF) >> 8); this.push((this.PC - 1) & 0xFF); this.PC = a; c = 7; break;   // JSR
      case 0x60: this.PC = ((this.pull() | (this.pull() << 8)) + 1) & 0xFFFF; c = 7; break;          // RTS
      case 0x40: this.P = this.pull() | 0; { var lo = this.pull(), hi = this.pull(); this.PC = lo | (hi << 8); } c = 7; break;   // RTI
      case 0x00: this.fetch(); this.push(this.PC >> 8); this.push(this.PC & 0xFF); this.push(this.P | F_B); this.P = (this.P | F_I) & ~(F_D | F_T); this.PC = b.vector(0xFFF6); c = 8; break;   // BRK
      // —— 位元與 TST、TAM、TMA、RMB／SMB、BBR／BBS ——
      case 0x43: { v = this.fetch(); for (t = 0; t < 8; t++) if (v & (1 << t)) this.A = b.mpr[t]; c = 4; break; }   // TMA
      case 0x53: { v = this.fetch(); for (t = 0; t < 8; t++) if (v & (1 << t)) b.mpr[t] = this.A; c = 5; break; }      // TAM
      case 0x83: case 0xA3: case 0x93: case 0xB3: {
        var mask = this.fetch(), addr = (op === 0x83) ? (ZP | this.fetch()) : (op === 0xA3) ? (ZP | ((this.fetch() + this.X) & 0xFF)) : (op === 0x93) ? this.fetch16() : (this.fetch16() + this.X) & 0xFFFF;
        v = b.read(addr); this.P = (this.P & ~(F_N | F_V | F_Z)) | (v & mask ? 0 : F_Z) | (v & 0xC0);
        c = 6; break;
      }
      case 0x73: case 0xC3: case 0xD3: case 0xE3: case 0xF3: c = this.blockTransfer(op); break;     // TII TDD TIN TIA TAI
      case 0x07: case 0x17: case 0x27: case 0x37: case 0x47: case 0x57: case 0x67: case 0x77:      // RMB0..7
        a = ZP | this.fetch(); b.write(a, b.read(a) & ~(1 << ((op >> 4) & 7))); c = 7; break;
      case 0x87: case 0x97: case 0xA7: case 0xB7: case 0xC7: case 0xD7: case 0xE7: case 0xF7:      // SMB0..7
        a = ZP | this.fetch(); b.write(a, b.read(a) | (1 << ((op >> 4) & 7))); c = 7; break;
      case 0x0F: case 0x1F: case 0x2F: case 0x3F: case 0x4F: case 0x5F: case 0x6F: case 0x7F:      // BBR0..7
        c = this.bitBranch(op, false, ZP | this.fetch(), 7); break;
      case 0x8F: case 0x9F: case 0xAF: case 0xBF: case 0xCF: case 0xDF: case 0xEF: case 0xFF:      // BBS0..7
        c = this.bitBranch(op, true, ZP | this.fetch(), 7); break;
      // —— ST0／ST1／ST2：寫 VDC 暫存器（I/O 銀行的 $0000、$0002、$0003）——
      case 0x03: this.bus.ioWrite(0, this.fetch()); c = 4; break;                                    // ST0
      case 0x13: this.bus.ioWrite(2, this.fetch()); c = 4; break;                                    // ST1
      case 0x23: this.bus.ioWrite(3, this.fetch()); c = 4; break;                                    // ST2
      default:
        // 未文件化或未實作的操作碼：當單位元組空指令，計數，不讓整個執行中斷
        this.unknown++; this.unknownOps[op] = (this.unknownOps[op] || 0) + 1;
        c = 2;
    }
    return c * this.div;
  };
  Cpu.prototype.bitFlags = function (v) { this.P = (this.P & ~(F_N | F_V | F_Z)) | (v & 0xC0) | ((this.A & v) === 0 ? F_Z : 0); };
  Cpu.prototype.rmw = function (addr, fn) { var b = this.bus; var v = fn.call(this, b.read(addr)); b.write(addr, v); };
  Cpu.prototype.jmpInd = function (addr) { return this.bus.read(addr) | (this.bus.read((addr + 1) & 0xFFFF) << 8); };
  Cpu.prototype.bitBranch = function (op, want, zpAddr, c0) {
    var bit = (op >> 4) & 7, v = this.bus.read(zpAddr), rel = this.fetch();
    if (rel & 0x80) rel -= 256;
    var set = !!(v & (1 << bit));
    if (set === want) { this.PC = (this.PC + rel) & 0xFFFF; return c0 + 2; }
    return c0;
  };
  // 區塊搬移：源與目的、長度（0 ＝ 65536）；TII 源遞增目的遞增、TDD 兩者遞減、TIN 源遞增目的固定、TIA 源遞增目的交替、TAI 源交替目的遞增
  Cpu.prototype.blockTransfer = function (op) {
    var src = this.fetch16(), dst = this.fetch16(), len = this.fetch16();
    if (len === 0) len = 0x10000;
    var b = this.bus;
    for (var i = 0; i < len; i++) {
      var sa = (op === 0xF3) ? ((src + (i & 1)) & 0xFFFF) : src;      // TAI：來源交替
      var da = (op === 0xE3) ? ((dst + (i & 1)) & 0xFFFF) : dst;      // TIA：目的交替
      b.write(da, b.read(sa));
      if (op === 0x73) { src = (src + 1) & 0xFFFF; dst = (dst + 1) & 0xFFFF; }        // TII
      else if (op === 0xC3) { src = (src - 1) & 0xFFFF; dst = (dst - 1) & 0xFFFF; }  // TDD
      else if (op === 0xD3) { src = (src + 1) & 0xFFFF; }                             // TIN：目的固定
      else if (op === 0xE3) { src = (src + 1) & 0xFFFF; }                             // TIA
      else if (op === 0xF3) { dst = (dst + 1) & 0xFFFF; }                             // TAI
    }
    return 6 + 6 * len;
  };

  // ───── 機器：處理器、匯流排、VDC 垂直消隱、計時器、IRQ ─────
  // 執行 maxTicks 個主時脈（或到 stop 回傳真）。回傳執行的畫面數與停止原因。
  function createMachine(romBytes, opts) {
    opts = opts || {};
    var rom = stripHeader(romBytes);
    var psgWrites = [];
    var masterNow = 0;
    var hooks = {
      psg: function (reg, v) { if (opts.onPsg) opts.onPsg(masterNow, reg, v); else psgWrites.push({ t: masterNow, r: reg, v: v }); }
    };
    var bus = new Bus(rom, hooks);
    var cpu = new Cpu(bus);
    cpu.reset();
    var nextVbl = FRAME_TICKS, frames = 0;
    var timerDue = TIMER_TICKS;
    function advance(ticks) {
      masterNow += ticks;
      if (masterNow >= nextVbl) {
        nextVbl += FRAME_TICKS; frames++;
        bus.vdcStatus |= 0x20;
        if (bus.vdcRegs[5] & 0x0008) bus.irqPend |= 2;
        if (opts.onFrame) opts.onFrame(frames);
      }
      if (bus.timerOn) {
        while (masterNow >= timerDue) {
          timerDue += TIMER_TICKS;
          if (bus.timerCount === 0) { bus.timerCount = bus.timerReload; bus.irqPend |= 4; }
          else bus.timerCount--;
        }
      } else timerDue = masterNow + TIMER_TICKS;
    }
    function run(maxFrames, shouldStop) {
      var stopAt = 0;
      while (frames < maxFrames) {
        if (shouldStop && shouldStop()) return { frames: frames, reason: 'cancelled', ticks: masterNow };
        var c = cpu.step();
        advance(c);
        if (cpu.unknown > 2000000) { return { frames: frames, reason: 'unknown-ops', ticks: masterNow }; }
      }
      return { frames: frames, reason: 'frames', ticks: masterNow };
    }
    return {
      cpu: cpu, bus: bus, run: run, psgWrites: psgWrites,
      frames: function () { return frames; }, ticks: function () { return masterNow; }
    };
  }

  return {
    stripHeader: stripHeader, Bus: Bus, Cpu: Cpu, createMachine: createMachine,
    MASTER_HZ: MASTER_HZ, FRAME_TICKS: FRAME_TICKS, LOW_DIV: LOW_DIV
  };
}));
