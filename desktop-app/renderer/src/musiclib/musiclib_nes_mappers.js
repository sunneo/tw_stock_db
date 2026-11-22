/* 額外的 NES mapper（UMD）：補 jsnes 核心沒有的銀行切換與計時器。不改 vendor/jsnes 的原始碼，只在執行期把類別登記進 NES.mappers。
 *   install(NES)  → 把下面的 mapper 登記進 NES.mappers（NES 來自 jsnes.umd.cjs；bundle 會掛上 mappers 與 Mapper0）
 *   SUPPORTED     → 這個檔案補上的 mapper 編號
 *   APPROX        → 有近似的 mapper（寫在結果的附註裡）
 * 計時器：規格是逐 CPU 週期；jsnes 只在每條掃描線呼叫 clockIrqCounter，所以這裡每掃描線加減 114 個週期（近似）。
 * 依據：nesdev wiki 的公開規格（各類別註解列出頁面）。沒有寫的細節一律以近似處理，並列在 APPROX。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibNesMappers = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var LINE = 114;

  function makeMappers(NES) {
    var M0 = NES.Mapper0;
    var M4 = NES.mappers[4];
    var M9 = NES.mappers[9];

    function load16(self, bank, addr) { self.load8kRomBank(bank * 2, addr); self.load8kRomBank(bank * 2 + 1, addr + 0x2000); }

    // ───── 15：K-1029／K-1030P 多合一（nesdev INES_Mapper_015）─────
    // 唯一暫存器 $8000-$FFFF：A1-A0 選模式，資料 bit5-0 = PRG A19-A14，bit6 鏡像（1 水平），bit7 = PRG A13（模式 2）。
    class Mapper15 extends M0 {
      static mapperName = 'K-1029';
      constructor(nes) { super(nes); this.mode = 0; this.prgBits = 0; this.p = 0; }
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        this.mode = address & 3; this.prgBits = value & 0x3f; this.p = (value >> 7) & 1;
        this.nes.ppu.setMirroring((value >> 6) & 1 ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING);
        this.sync();
      }
      sync() {
        var b = this.prgBits;
        if (this.mode === 0) { // NROM-256：32K 銀行 b>>1 → 8K 銀行 ×4
          this.load8kRomBank((b >> 1) * 4, 0x8000); this.load8kRomBank((b >> 1) * 4 + 1, 0xa000);
          this.load8kRomBank((b >> 1) * 4 + 2, 0xc000); this.load8kRomBank((b >> 1) * 4 + 3, 0xe000);
        } else if (this.mode === 1) { // UNROM：$8000 = 16K，$C000 = A14..16 全 1
          load16(this, b, 0x8000); load16(this, b | 7, 0xc000);
        } else if (this.mode === 2) { // NROM-64：8K 鏡像，A13 = p
          var k = (b << 1) | this.p;
          this.load8kRomBank(k, 0x8000); this.load8kRomBank(k, 0xa000); this.load8kRomBank(k, 0xc000); this.load8kRomBank(k, 0xe000);
        } else { // NROM-128
          load16(this, b, 0x8000); load16(this, b, 0xc000);
        }
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('K-1029: Invalid ROM! Unable to load.');
        this.sync(); this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
    }

    // ───── 16：Bandai FCG／LZ93D50（nesdev INES_Mapper_016）─────
    // 暫存器 addr & $800F（$8000 以上；$6000 以上的 FCG 型用 $E00F）：0–7 CHR 1K、8 PRG 16K、9 鏡像、A IRQ 致能（同時把鎖存複製到計數器）、
    // B/C 16 位元鎖存低／高位元組。計數器每週期減一，歸零時發 IRQ。
    class Mapper16 extends M0 {
      static mapperName = 'Bandai-FCG';
      constructor(nes) { super(nes); this.chr = [0, 0, 0, 0, 0, 0, 0, 0]; this.prg = 0; this.irqEnable = 0; this.irqCounter = 0; this.irqLatch = 0; this.fired = false; }
      write(address, value) {
        if (address >= 0x6000 && address < 0x8000) { if ((address & 0xe00f) >= 0x6000 && (address & 0xe00f) <= 0x600d) this.reg(address & 0xf, value); else super.write(address, value); return; }
        if (address < 0x8000) { super.write(address, value); return; }
        this.reg(address & 0xf, value);
      }
      reg(r, value) {
        if (r <= 7) { this.chr[r] = value; this.load1kVromBank(value, r * 0x400); return; }
        switch (r) {
          case 8: this.prg = value & 0x0f; this.load16k(this.prg, 0x8000); break;
          case 9: this.nes.ppu.setMirroring((value & 3) === 0 ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING); break;
          case 0xa: this.nes.cpu.clearIrq(); this.irqEnable = value & 1; this.irqCounter = this.irqLatch; this.fired = false; break;
          case 0xb: this.irqLatch = (this.irqLatch & 0xff00) | (value & 0xff); break;
          case 0xc: this.irqLatch = (this.irqLatch & 0x00ff) | ((value & 0xff) << 8); break;
          default: break;
        }
      }
      load16k(bank, addr) { load16(this, bank, addr); }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('FCG: Invalid ROM! Unable to load.');
        this.load16k(0, 0x8000); this.load16k(this.nes.rom.romCount - 1, 0xc000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
      clockIrqCounter() {
        if (!this.irqEnable || this.fired) return;
        if (this.irqCounter - LINE <= 0) { this.irqCounter = 0; this.fired = true; this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL); }
        else this.irqCounter -= LINE;
      }
    }

    // ───── 18：Jaleco SS88006（nesdev INES_Mapper_018）─────
    // 每個 8K／1K 銀行由兩個位址拼起來：偶數位址給低 4 位元、奇數位址給高位元。$F000 重載、$F001 控制（E 致能）、$F003 回應。
    // 這裡計數器固定 16 位元（規格的寬度選項未實作，列為近似）。
    class Mapper18 extends M0 {
      static mapperName = 'Jaleco-SS88006';
      constructor(nes) { super(nes); this.prg = [0, 0, 0]; this.chrLo = [0, 0, 0, 0, 0, 0, 0, 0]; this.chrHi = [0, 0, 0, 0, 0, 0, 0, 0]; this.reload = 0; this.counter = 0; this.enable = 0; this.fired = false; }
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        var a = address & 0xf003, n = value & 0x0f, hi = (a & 1);
        if (a >= 0x8000 && a <= 0x8003) this.setPrg((a >> 1) & 1, hi, n, value);   // $8000/$8001 = 銀行 0，$8002/$8003 = 銀行 1
        else if (a >= 0x9000 && a <= 0x9001) this.setPrg(2, hi, n, value);
        else if (a >= 0xa000 && a <= 0xa003) this.setChr(0 + ((a & 2) ? 1 : 0), hi, n);
        else if (a >= 0xb000 && a <= 0xb003) this.setChr(2 + ((a & 2) ? 1 : 0), hi, n);
        else if (a >= 0xc000 && a <= 0xc003) this.setChr(4 + ((a & 2) ? 1 : 0), hi, n);
        else if (a >= 0xd000 && a <= 0xd003) this.setChr(6 + ((a & 2) ? 1 : 0), hi, n);
        else if (a === 0x9002) { /* PRG RAM 致能：不影響音樂 */ }
        else if (a >= 0xe000 && a <= 0xe003) { var sh = (a & 3) * 4; this.reload = (this.reload & ~(0xf << sh)) | (n << sh); }
        else if (a === 0xf000) { this.counter = this.reload; this.nes.cpu.clearIrq(); this.fired = false; }
        else if (a === 0xf001) { this.enable = value & 1; this.nes.cpu.clearIrq(); }
        else if (a === 0xf002) this.nes.ppu.setMirroring((value & 3) === 0 ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING);
      }
      setPrg(i, hi, n, value) {
        if (hi) this.prg[i] = (this.prg[i] & 0x0f) | (n << 4); else this.prg[i] = (this.prg[i] & 0xf0) | n;
        var b = this.prg[i], addr = [0x8000, 0xa000, 0xc000][i];
        this.load8kRomBank(b, addr);
      }
      setChr(i, hi, n) {
        if (hi) this.chrHi[i] = n; else this.chrLo[i] = n;
        this.load1kVromBank(this.chrLo[i] | (this.chrHi[i] << 4), i * 0x400);
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('SS88006: Invalid ROM! Unable to load.');
        this.load8kRomBank(0, 0x8000); this.load8kRomBank(1, 0xa000); this.load8kRomBank(this.nes.rom.romCount * 2 - 2, 0xc000); this.load8kRomBank(this.nes.rom.romCount * 2 - 1, 0xe000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
      clockIrqCounter() {
        if (!this.enable || this.fired) return;
        if (this.counter - LINE <= 0) { this.counter = 0; this.fired = true; this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL); }
        else this.counter -= LINE;
      }
    }

    // ───── 23／25：Konami VRC2／VRC4（nesdev VRC2_and_VRC4）─────
    // 兩組接線（A0/A1 或 A2/A3）用同一個解碼：低兩位元為 0 時看 A0/A1，否則看 A2/A3（一張板子只會用一組，所以不衝突）。
    // $8000／$A000 PRG 8K；$9000 鏡像；$9002 bit1 交換模式；$B000–$E003 CHR 1K（低 4 位元＋高 5 位元）；
    // $F000/$F001 IRQ 鎖存低／高；$F002 控制（bit1 致能、bit0 回應時致能、bit2 週期模式）；$F003 回應。
    class MapperVrc4 extends M0 {
      constructor(nes) {
        super(nes);
        this.prg0 = 0; this.prg1 = 0; this.swap = 0; this.chrLo = [0, 0, 0, 0, 0, 0, 0, 0]; this.chrHi = [0, 0, 0, 0, 0, 0, 0, 0];
        this.latch = 0; this.cnt = 0; this.irqEnable = 0; this.irqAfterAck = 0; this.irqCycle = 0; this.fired = false;
      }
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        var base = address & 0xf000;
        var sub = (address & 0x0c) === 0 ? (address & 3) : ((address >> 2) & 3);
        var n = value & 0x0f;
        switch (base) {
          case 0x8000: this.prg0 = value & 0x1f; this.syncPrg(); break;
          case 0xa000: this.prg1 = value & 0x1f; this.syncPrg(); break;
          case 0x9000:
            if (sub === 0) this.nes.ppu.setMirroring((value & 3) === 1 ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING);
            else if (sub === 2) { this.swap = (value >> 1) & 1; this.syncPrg(); }
            break;
          case 0xb000: case 0xc000: case 0xd000: case 0xe000: {
            var idx = ((base >> 12) - 0xb) * 2 + (sub >> 1);
            if (sub & 1) this.chrHi[idx] = value & 0x1f; else this.chrLo[idx] = n;
            this.load1kVromBank(this.chrLo[idx] | (this.chrHi[idx] << 4), idx * 0x400);
            break;
          }
          case 0xf000:
            if (sub === 0) this.latch = (this.latch & 0xf0) | n;
            else if (sub === 1) this.latch = (this.latch & 0x0f) | (n << 4);
            else if (sub === 2) { this.irqAfterAck = value & 1; this.irqEnable = (value >> 1) & 1; this.irqCycle = (value >> 2) & 1; this.nes.cpu.clearIrq(); this.fired = false; if (this.irqEnable) this.cnt = this.latch; }
            else if (sub === 3) { this.nes.cpu.clearIrq(); this.fired = false; this.irqEnable = this.irqAfterAck; }
            break;
          default: break;
        }
      }
      syncPrg() {
        var last = this.nes.rom.romCount * 2 - 1;
        this.load8kRomBank(this.swap ? last - 1 : this.prg0, 0x8000);
        this.load8kRomBank(this.prg1, 0xa000);
        this.load8kRomBank(this.swap ? this.prg0 : last - 1, 0xc000);
        this.load8kRomBank(last, 0xe000);
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('VRC4: Invalid ROM! Unable to load.');
        this.syncPrg(); this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
      clockIrqCounter() {
        if (!this.irqEnable || this.fired) return;
        var inc = this.irqCycle ? LINE : 1, next = this.cnt + inc;
        if (next > 0xff) { this.fired = true; this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL); this.cnt = this.latch; }
        else this.cnt = next;
      }
    }
    class Mapper23 extends MapperVrc4 { static mapperName = 'VRC4-23'; }
    class Mapper25 extends MapperVrc4 { static mapperName = 'VRC4-25'; }

    // ───── 33：Taito TC0190（nesdev INES_Mapper_033）─────
    // $8000 bit6 鏡像、P 為 8K PRG（$8000）；$8001 8K PRG（$A000）；$8002／$8003 2K CHR（$0000／$0800）；$A000–$A003 1K CHR（$1000–$1C00）。沒有 IRQ。
    class Mapper33 extends M0 {
      static mapperName = 'TC0190';
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        if (address >= 0xc000) return;
        switch (address & 0xa003) {
          case 0x8000: this.nes.ppu.setMirroring((value >> 6) & 1 ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING); this.load8kRomBank(value & 0x3f, 0x8000); break;
          case 0x8001: this.load8kRomBank(value & 0x3f, 0xa000); break;
          case 0x8002: this.load2kVromBank(value, 0x0000); break;
          case 0x8003: this.load2kVromBank(value, 0x0800); break;
          case 0xa000: this.load1kVromBank(value, 0x1000); break;
          case 0xa001: this.load1kVromBank(value, 0x1400); break;
          case 0xa002: this.load1kVromBank(value, 0x1800); break;
          case 0xa003: this.load1kVromBank(value, 0x1c00); break;
          default: break;
        }
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('TC0190: Invalid ROM! Unable to load.');
        var last = this.nes.rom.romCount * 2 - 1;
        this.load8kRomBank(0, 0x8000); this.load8kRomBank(1, 0xa000); this.load8kRomBank(last - 1, 0xc000); this.load8kRomBank(last, 0xe000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
    }

    // ───── 64：Tengen RAMBO-1（nesdev RAMBO-1）─────
    // $8000 偶數：R 索引（bit3-0）、bit6 PRG 模式、bit7 CHR 反轉、bit5 K（1K 模式）；$8001 寫入該暫存器。$A000 鏡像（bit0）。
    // $C000 鎖存、$C001 重載＋模式（bit0：1 = CPU 週期模式，這裡每掃描線近似為 28 次時脈）、$E000 停止並回應、$E001 致能。
    // K 模式（1K CHR）與 RF 的 PRG 位置依規格；細節以近似處理，列在 APPROX。
    class Mapper64 extends M0 {
      static mapperName = 'RAMBO-1';
      constructor(nes) { super(nes); this.idx = 0; this.r = new Array(16).fill(0); this.pmode = 0; this.cinv = 0; this.kmode = 0; this.latch = 0; this.counter = 0; this.reloadFlag = false; this.irqEnable = false; this.cycleMode = false; }
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        var even = (address & 1) === 0;
        switch (address & 0xe001) {
          case 0x8000: this.idx = value & 0x0f; this.pmode = (value >> 6) & 1; this.cinv = (value >> 7) & 1; this.kmode = (value >> 5) & 1; this.sync(); break;
          case 0x8001: this.r[this.idx] = value; this.sync(); break;
          case 0xa000: this.nes.ppu.setMirroring(value & 1 ? this.nes.rom.VERTICAL_MIRRORING : this.nes.rom.HORIZONTAL_MIRRORING); break;
          case 0xc000: this.latch = value; break;
          case 0xc001: this.cycleMode = (value & 1) === 1; this.counter = 0; this.reloadFlag = true; break;
          case 0xe000: this.nes.cpu.clearIrq(); this.irqEnable = false; break;
          case 0xe001: this.irqEnable = true; break;
          default: break;
        }
      }
      sync() {
        var last = this.nes.rom.romCount * 2 - 1, r = this.r;
        var p6 = r[6] & 0x3f, p7 = r[7] & 0x3f, pf = r[15] & 0x3f;
        if (this.pmode === 0) { this.load8kRomBank(p6, 0x8000); this.load8kRomBank(pf, 0xc000); }
        else { this.load8kRomBank(pf, 0x8000); this.load8kRomBank(p6, 0xc000); }
        this.load8kRomBank(p7, 0xa000); this.load8kRomBank(last, 0xe000);
        var c = this.cinv ? 4 : 0;
        // 2K 銀行 R0、R1；1K 銀行 R2–R5（K 模式時 R8、R9 補上 1K 位置，近似）
        this.load1kVromBank(r[0] & 0xfe, (0 ^ c) * 0x400); this.load1kVromBank((r[0] & 0xfe) | 1, ((0 ^ c) + 1) * 0x400);
        this.load1kVromBank(r[1] & 0xfe, ((2 ^ c)) * 0x400); this.load1kVromBank((r[1] & 0xfe) | 1, ((3 ^ c)) * 0x400);
        this.load1kVromBank(r[2], (4 ^ c) * 0x400); this.load1kVromBank(r[3], (5 ^ c) * 0x400);
        this.load1kVromBank(r[4], (6 ^ c) * 0x400); this.load1kVromBank(r[5], (7 ^ c) * 0x400);
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('RAMBO-1: Invalid ROM! Unable to load.');
        this.sync(); this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
      clockIrqCounter() {
        var n = this.cycleMode ? 28 : 1;
        for (var i = 0; i < n; i++) {
          if (this.reloadFlag) { this.counter = this.latch; this.reloadFlag = false; }
          else if (this.counter > 0) this.counter--;
          else this.counter = this.latch;
          if (this.counter === 0 && this.irqEnable) { this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL); break; }
        }
      }
    }

    // ───── 68：Sunsoft-4（nesdev INES_Mapper_068）─────
    // $8000–$BFFF 2K CHR（$0000–$1800）；$C000/$D000 名稱表 CHR（這裡不處理，近似）；$E000 鏡像（bit1-0）；$F000 16K PRG（bit3-0）。沒有 IRQ。
    class Mapper68 extends M0 {
      static mapperName = 'Sunsoft-4';
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        if (address < 0xc000) { this.load2kVromBank(value, ((address >> 12) - 8) * 0x800); return; }
        if (address < 0xd000 || address < 0xe000) return;
        if (address < 0xf000) { this.nes.ppu.setMirroring((value & 3) === 1 ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING); return; }
        load16(this, value & 0x0f, 0x8000);
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('Sunsoft-4: Invalid ROM! Unable to load.');
        load16(this, 0, 0x8000); load16(this, this.nes.rom.romCount - 1, 0xc000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
    }

    // ───── 69：Sunsoft FME-7（nesdev Sunsoft_FME-7）─────
    // $8000 指令（低 4 位元）、$A000 參數。0–7 CHR 1K；8 $6000 銀行；9/A/B PRG 8K（$8000/$A000/$C000）；C 鏡像；
    // D bit0 IRQ 致能、bit7 計數致能，寫入回應；E/F 計數器低／高（16 位元，每週期遞減，繞回時發 IRQ）。5B 音效未實作（見 APPROX）。
    class Mapper69 extends M0 {
      static mapperName = 'FME-7';
      constructor(nes) { super(nes); this.cmd = 0; this.counter = 0; this.irqEnable = 0; this.countEnable = 0; }
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        if (address < 0xa000) { this.cmd = value & 0x0f; return; }
        if (address >= 0xc000) return;   // 5B 音效暫存器（未實作）
        var c = this.cmd;
        if (c <= 7) this.load1kVromBank(value, c * 0x400);
        else if (c === 8) { if ((value & 0x40) === 0) this.load8kRomBank(value & 0x3f, 0x6000); }
        else if (c === 9) this.load8kRomBank(value & 0x3f, 0x8000);
        else if (c === 0xa) this.load8kRomBank(value & 0x3f, 0xa000);
        else if (c === 0xb) this.load8kRomBank(value & 0x3f, 0xc000);
        else if (c === 0xc) this.nes.ppu.setMirroring((value & 3) === 1 ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING);
        else if (c === 0xd) { this.irqEnable = value & 1; this.countEnable = (value >> 7) & 1; this.nes.cpu.clearIrq(); }
        else if (c === 0xe) this.counter = (this.counter & 0xff00) | value;
        else if (c === 0xf) this.counter = (this.counter & 0x00ff) | (value << 8);
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('FME-7: Invalid ROM! Unable to load.');
        var last = this.nes.rom.romCount * 2 - 1;
        this.load8kRomBank(0, 0x8000); this.load8kRomBank(1, 0xa000); this.load8kRomBank(2, 0xc000); this.load8kRomBank(last, 0xe000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
      clockIrqCounter() {
        if (!this.countEnable) return;
        var next = this.counter - LINE;
        if (next < 0) { next = (next + 0x10000) & 0xffff; if (this.irqEnable) this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL); }
        this.counter = next;
      }
    }

    // ───── 74：MMC3 相容、CHR-RAM 取代 CHR 銀行 8/9（nesdev INES_Mapper_074）─────
    // 近似：以 MMC3 處理，CHR 銀行 8/9 仍讀 CHR-ROM（圖形可能錯，音樂不受影響）。
    class Mapper74 extends M4 { static mapperName = 'MMC3-74'; }

    // ───── 112：Ascii 相容（nesdev INES_Mapper_112）─────
    // $8000 目標（低 3 位元）；$A000 資料；$E000 bit0 鏡像（0 水平、1 垂直）。$C000 與 $E000 固定為倒數第二、最後的 8K。沒有 IRQ。
    class Mapper112 extends M0 {
      static mapperName = 'Ascii-112';
      constructor(nes) { super(nes); this.target = 0; this.regs = new Array(8).fill(0); }
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        switch (address & 0xe001) {
          case 0x8000: this.target = value & 7; break;
          case 0xa000: this.regs[this.target] = value; this.sync(); break;
          case 0xe000: this.nes.ppu.setMirroring(value & 1 ? this.nes.rom.VERTICAL_MIRRORING : this.nes.rom.HORIZONTAL_MIRRORING); break;
          default: break;
        }
      }
      sync() {
        var r = this.regs, last = this.nes.rom.romCount * 2 - 1;
        this.load8kRomBank(r[0] & 0x3f, 0x8000); this.load8kRomBank(r[1] & 0x3f, 0xa000);
        this.load8kRomBank(last - 1, 0xc000); this.load8kRomBank(last, 0xe000);
        this.load2kVromBank(r[2], 0x0000); this.load2kVromBank(r[3], 0x0800);
        this.load1kVromBank(r[4], 0x1000); this.load1kVromBank(r[5], 0x1400); this.load1kVromBank(r[6], 0x1800); this.load1kVromBank(r[7], 0x1c00);
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('Ascii-112: Invalid ROM! Unable to load.');
        this.sync(); this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
    }

    // ───── 187：MMC3 加 $5000 的 NROM 覆寫（nesdev INES_Mapper_187）─────
    // $5000（遮罩 $F001）bit7 = 1 時忽略 MMC3 的 PRG，改用 16K 銀行（bit 欄位為近似：取 bit5-0）。
    class Mapper187 extends M4 {
      static mapperName = 'MMC3-187';
      write(address, value) {
        if (address >= 0x5000 && address < 0x6000 && (address & 0xf001) === 0x5000) {
          // 目前不套用 $5000 的 NROM 覆寫：實測（KOF96）套用後跳到 ROM 外的位址崩潰，而規格的銀行欄位還沒有確認。
          // 不套用時就是普通 MMC3 行為（600 幀不崩潰）；這是近似，列在 APPROX。
          this.nrom = false;
          return;
        }
        if (address >= 0x8000 && this.nrom) { super.write(address, value); return; }
        super.write(address, value);
      }
    }

    // ───── 189：MMC3 加 $4100 的 32K PRG 覆寫（nesdev INES_Mapper_189）─────
    // (addr & $E100) == $4100 寫入：資料 bit5-4 = 32K PRG 銀行。每次 MMC3 的 PRG 改寫後重新套用這個 32K 銀行（近似）。
    class Mapper189 extends M4 {
      static mapperName = 'MMC3-189';
      constructor(nes) { super(nes); this.bank32 = null; }
      write(address, value) {
        if (address >= 0x4100 && address < 0x8000 && (address & 0xe100) === 0x4100) { this.bank32 = (value >> 4) & 3; this.load32kRomBank(this.bank32, 0x8000); return; }
        super.write(address, value);
        if (address >= 0x8000 && this.bank32 !== null) this.load32kRomBank(this.bank32, 0x8000);
      }
    }

    // ───── 193：卡帶自製 CHR／PRG 暫存器（nesdev INES_Mapper_193）─────
    // $6000–$6003：CHR 0（4K）、CHR 1（2K，$1000）、CHR 2（2K，$1800）、$6003 低 4 位元 = 8K PRG（$8000）；$6004 bit0 鏡像（0 垂直、1 水平）。
    // 近似：CHR 0 的單位依 4K 處理。
    class Mapper193 extends M0 {
      static mapperName = 'Fighting-Hero';
      write(address, value) {
        if (address < 0x6000 || address >= 0x8000) { super.write(address, value); return; }
        switch (address & 0xe007) {
          case 0x6000: for (var i = 0; i < 4; i++) this.load1kVromBank(value * 4 + i, i * 0x400); break;
          case 0x6001: this.load1kVromBank(value * 2, 0x1000); this.load1kVromBank(value * 2 + 1, 0x1400); break;
          case 0x6002: this.load1kVromBank(value * 2, 0x1800); this.load1kVromBank(value * 2 + 1, 0x1c00); break;
          case 0x6003: this.load8kRomBank(value & 0x0f, 0x8000); break;
          case 0x6004: this.nes.ppu.setMirroring(value & 1 ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING); break;
          default: break;
        }
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('Fighting-Hero: Invalid ROM! Unable to load.');
        var last = this.nes.rom.romCount * 2 - 1;
        this.load8kRomBank(0, 0x8000); this.load8kRomBank(last - 2, 0xa000); this.load8kRomBank(last - 1, 0xc000); this.load8kRomBank(last, 0xe000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
    }

    // ───── 195：MMC3 相容的 GAL 板（nesdev INES_Mapper_195）─────
    // 近似：以 MMC3 處理；頁面沒有寫出 CPU 端暫存器位址，CHR-RAM／ROM 切換未實作（圖形可能錯）。
    class Mapper195 extends M4 { static mapperName = 'MMC3-195'; }

    // ───── 225：多合一 ET-4310／K-1010（nesdev INES_Mapper_225）─────
    // 暫存器由寫入位址決定（$8000–$FFFF）：A5–A0 = CHR 低 6 位元，A11–A6 = PRG 低 6 位元，A12 = PRG 模式（0 = 32K、1 = 16K），
    // A13 鏡像（0 垂直、1 水平），A14 = 高位元。
    class Mapper225 extends M0 {
      static mapperName = 'ET-4310';
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        var chr = (address & 0x3f) | (((address >> 14) & 1) << 6), prg = ((address >> 6) & 0x3f) | (((address >> 14) & 1) << 6);
        var mode = (address >> 12) & 1, mirror = (address >> 13) & 1, h = (address >> 14) & 1;
        this.nes.ppu.setMirroring(mirror ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING);
        if (mode === 0) { var b = prg >> 1; load16(this, b * 2, 0x8000); load16(this, b * 2 + 1, 0xc000); }   // 32K：兩個 16K 銀行
        else { load16(this, prg, 0x8000); load16(this, prg, 0xc000); }
        this.load8kRomBank(chr, 0x0000);
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('ET-4310: Invalid ROM! Unable to load.');
        // 上電：$8000 = 第 0 銀行，$C000 = 最後一個銀行（重置向量在最後的銀行，見 ROM 檔頭的 $FFFC）
        load16(this, 0, 0x8000); load16(this, this.nes.rom.romCount - 1, 0xc000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
    }

    // ───── 226：多合一 42/63/76-in-1（nesdev INES_Mapper_226）─────
    // $8000 寫入：bit0-4 與 bit7 = PRG 低 6 位元、bit5 = PRG 模式（0 = 32K、1 = 16K）、bit6 鏡像（0 水平、1 垂直）；
    // $8001 bit0 = PRG 高位元。兩個暫存器上電與軟重置都清 0。
    class Mapper226 extends M0 {
      static mapperName = 'Multi-226';
      constructor(nes) { super(nes); this.r0 = 0; this.r1 = 0; }
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        if ((address & 1) === 0) this.r0 = value; else this.r1 = value & 1;
        var prgLow = (this.r0 & 0x1f) | (((this.r0 >> 7) & 1) << 5), reg = prgLow | (this.r1 << 6);
        this.nes.ppu.setMirroring((this.r0 >> 6) & 1 ? this.nes.rom.VERTICAL_MIRRORING : this.nes.rom.HORIZONTAL_MIRRORING);
        if ((this.r0 >> 5) & 1) { load16(this, reg, 0x8000); load16(this, reg, 0xc000); }
        else { var b = reg >> 1; load16(this, b * 2, 0x8000); load16(this, b * 2 + 1, 0xc000); }
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('Multi-226: Invalid ROM! Unable to load.');
        load16(this, 0, 0x8000); load16(this, 0, 0xc000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
    }

    // ───── 246：G0151-1 封神榜（nesdev INES_Mapper_246）─────
    // $6000–$6003 PRG 8K（資料 bit5-0）：$6000 = $8000、$6001 = $A000、$6002 = $C000、$6003 = $E000；$6004–$6007 CHR 2K（$0000、$0800、$1000、$1800）。
    class Mapper246 extends M0 {
      static mapperName = 'G0151-1';
      write(address, value) {
        if (address >= 0x6000 && address < 0x6008) {
          var r = address & 3;
          if ((address & 4) === 0) this.load8kRomBank(value & 0x3f, [0x8000, 0xa000, 0xc000, 0xe000][r]);
          else this.load2kVromBank(value, [0x0000, 0x0800, 0x1000, 0x1800][r]);
          return;
        }
        super.write(address, value);
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('G0151-1: Invalid ROM! Unable to load.');
        this.load8kRomBank(0, 0x8000); this.load8kRomBank(1, 0xa000); this.load8kRomBank(2, 0xc000); this.load8kRomBank(3, 0xe000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
    }

    // ───── 10：MMC4（nesdev MMC4）─────
    class Mapper10 extends M9 {
      static mapperName = 'MMC4';
      write(address, value) {
        if (address >= 0xa000 && address <= 0xafff) { this.prgBank = value & 0x0f; load16(this, this.prgBank, 0x8000); return; }
        super.write(address, value);
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('MMC4: Invalid ROM! Unable to load.');
        load16(this, 0, 0x8000); load16(this, this.nes.rom.romCount - 1, 0xc000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
    }

    // ───── 65：Irem H3001（nesdev INES_Mapper_065）─────
    class Mapper65 extends M0 {
      static mapperName = 'Irem-H3001';
      constructor(nes) { super(nes); this.reg8 = 0; this.regA = 1; this.prgMode = 0; this.irqEnable = 0; this.irqCounter = 0; this.irqReload = 0; this.irqFired = false; }
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        var hi = address & 0xf000;
        if (hi === 0x8000) { this.reg8 = value; this.syncPrg(); return; }
        if (hi === 0xa000) { this.regA = value; this.syncPrg(); return; }
        if (hi === 0xb000) { this.load1kVromBank(value, (address & 7) * 0x400); return; }
        if (hi !== 0x9000) return;
        switch (address & 7) {
          case 0: this.prgMode = (value >> 7) & 1; this.syncPrg(); break;
          case 1: this.nes.ppu.setMirroring(((value >> 6) & 2) ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING); break;
          case 3: this.nes.cpu.clearIrq(); this.irqEnable = (value >> 7) & 1; break;
          case 4: this.nes.cpu.clearIrq(); this.irqCounter = this.irqReload; this.irqFired = false; break;
          case 5: this.irqReload = ((value & 0xff) << 8) | (this.irqReload & 0xff); break;
          case 6: this.irqReload = (this.irqReload & 0xff00) | (value & 0xff); break;
          default: break;
        }
      }
      syncPrg() {
        if (this.prgMode === 0) { this.load8kRomBank(this.reg8, 0x8000); this.load8kRomBank(0x3e, 0xc000); }
        else { this.load8kRomBank(0x3e, 0x8000); this.load8kRomBank(this.reg8, 0xc000); }
        this.load8kRomBank(this.regA, 0xa000); this.load8kRomBank(0x3f, 0xe000);
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('Irem-H3001: Invalid ROM! Unable to load.');
        this.reg8 = 0; this.regA = 1; this.syncPrg(); this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
      clockIrqCounter() {
        if (!this.irqEnable || this.irqFired || this.irqCounter === 0) return;
        if (this.irqCounter - LINE <= 0) { this.irqCounter = 0; this.irqFired = true; this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL); }
        else this.irqCounter -= LINE;
      }
    }

    // ───── 67：Sunsoft-3（nesdev INES_Mapper_067）─────
    class Mapper67 extends M0 {
      static mapperName = 'Sunsoft-3';
      constructor(nes) { super(nes); this.irqCounter = 0; this.irqEnable = 0; this.irqToggle = 0; this.irqFired = false; }
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        if ((address & 0x8800) === 0x8000) this.nes.cpu.clearIrq();
        switch (address & 0xf800) {
          case 0x8800: this.load2kVromBank(value, 0x0000); break;
          case 0x9800: this.load2kVromBank(value, 0x0800); break;
          case 0xa800: this.load2kVromBank(value, 0x1000); break;
          case 0xb800: this.load2kVromBank(value, 0x1800); break;
          case 0xc800:
            if (this.irqToggle === 0) this.irqCounter = ((value & 0xff) << 8) | (this.irqCounter & 0xff);
            else this.irqCounter = (this.irqCounter & 0xff00) | (value & 0xff);
            this.irqToggle ^= 1; break;
          case 0xd800: this.irqEnable = (value >> 4) & 1; this.irqToggle = 0; break;
          case 0xe800: this.nes.ppu.setMirroring((value & 3) === 0 ? this.nes.rom.VERTICAL_MIRRORING : this.nes.rom.HORIZONTAL_MIRRORING); break;
          case 0xf800: load16(this, value & 0x0f, 0x8000); break;
          default: break;
        }
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('Sunsoft-3: Invalid ROM! Unable to load.');
        load16(this, 0, 0x8000); load16(this, this.nes.rom.romCount - 1, 0xc000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
      clockIrqCounter() {
        if (!this.irqEnable || this.irqFired) return;
        if (this.irqCounter - LINE <= 0) { this.irqCounter = 0; this.irqEnable = 0; this.irqFired = true; this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL); }
        else this.irqCounter -= LINE;
      }
    }

    // ───── 73：VRC3（nesdev VRC3）─────
    class Mapper73 extends M0 {
      static mapperName = 'VRC3';
      constructor(nes) { super(nes); this.latch = 0; this.counter = 0; this.irqEnable = 0; this.ackEnable = 0; this.irq8 = 0; }
      write(address, value) {
        if (address < 0x8000) { super.write(address, value); return; }
        switch (address & 0xf000) {
          case 0x8000: this.latch = (this.latch & 0xfff0) | (value & 0x0f); break;
          case 0x9000: this.latch = (this.latch & 0xff0f) | ((value & 0x0f) << 4); break;
          case 0xa000: this.latch = (this.latch & 0xf0ff) | ((value & 0x0f) << 8); break;
          case 0xb000: this.latch = (this.latch & 0x0fff) | ((value & 0x0f) << 12); break;
          case 0xc000: this.nes.cpu.clearIrq(); this.irq8 = (value >> 2) & 1; this.irqEnable = (value >> 1) & 1; this.ackEnable = value & 1; if (this.irqEnable) this.counter = this.latch; break;
          case 0xd000: this.nes.cpu.clearIrq(); this.irqEnable = this.ackEnable; break;
          case 0xf000: load16(this, value & 7, 0x8000); break;
          default: break;
        }
      }
      loadROM() {
        if (!this.nes.rom.valid) throw new Error('VRC3: Invalid ROM! Unable to load.');
        load16(this, 0, 0x8000); load16(this, this.nes.rom.romCount - 1, 0xc000);
        this.loadCHRROM(); this.loadBatteryRam(); this.nes.cpu.requestIrq(this.nes.cpu.IRQ_RESET);
      }
      clockIrqCounter() {
        if (!this.irqEnable) return;
        var mask = this.irq8 ? 0xff : 0xffff, next = this.counter + LINE;
        if (next > mask) { this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL); this.counter = this.irq8 ? (this.latch & 0xff) : this.latch; }
        else this.counter = next;
      }
    }

    return {
      10: Mapper10, 15: Mapper15, 16: Mapper16, 18: Mapper18, 23: Mapper23, 25: Mapper25, 33: Mapper33, 64: Mapper64,
      65: Mapper65, 67: Mapper67, 68: Mapper68, 69: Mapper69, 73: Mapper73, 74: Mapper74, 112: Mapper112,
      187: Mapper187, 189: Mapper189, 193: Mapper193, 195: Mapper195, 225: Mapper225, 226: Mapper226, 246: Mapper246
    };
  }

  var SUPPORTED = [10, 15, 16, 18, 23, 25, 33, 64, 65, 67, 68, 69, 73, 74, 112, 187, 189, 193, 195, 225, 226, 246];
  var APPROX = {
    15: '多合一：模式依規格；銀行位址與 NSF 打包未逐一實機驗證', 16: 'IRQ 計數器固定 16 位元；EEPROM 不模擬',
    18: 'IRQ 計數器固定 16 位元（規格的寬度選項未實作）；ADPCM 不模擬', 23: 'VRC 接線以位址位元推斷（兩組接線共用）；IRQ 為掃描線近似',
    25: 'VRC 接線以位址位元推斷；IRQ 為掃描線近似', 33: '無 IRQ；名稱表鏡像僅水平／垂直',
    64: 'K 模式與 RF 位置為近似；IRQ 以掃描線時脈近似', 68: '名稱表 CHR（$C000/$D000）未處理，圖形可能錯',
    69: '5B 音效晶片未實作（使用 5B 的遊戲沒有擴充音樂）；計數器為掃描線近似',
    74: 'CHR-RAM 取代銀行 8/9 未實作（以 MMC3 處理）', 112: 'IRQ 無；名稱表與鎖定銀行依 MMC3 慣例',
    187: '未驗證：$5000 NROM 覆寫目前不套用（套用後 KOF96 跳到 ROM 外崩潰），只當普通 MMC3；APU 寫入偏少，音樂可能不完整', 189: '32K 銀行覆寫為近似（每次 MMC3 寫入後重套）',
    193: 'CHR 0 的 4K 單位以 1K 組合近似', 195: 'MMC3 相容近似；CHR-RAM／ROM 切換未實作',
    225: '暫存器位元對應依規格但 PRG 高位元位置為推斷；NSF 打包前須確認', 226: 'PRG 高位元（$8001）位置依規格推斷',
    246: '鎖存與讀取怪癖未實作（讀取 $FFE4 等會強制 PRG A17，這裡不處理）'
  };
  // 已知仍會崩潰的 mapper（抽不出來時會標明這裡的崩潰位置，不假裝成功）
  var CRASH_NOTES = {
    74: '早期崩潰：程式跳到 RAM $08EE（不是 ROM 位址）；原因未查明（非 PRG 銀行映射錯誤）',
    195: '早期崩潰：RTS 後跳到 $5462（展開區），疑似需要未實作的 GAL 外部銀行行為'
  };
  var NOT_IMPLEMENTED = {
    17: '頁面只有上電值與訓練器規則，沒有寫入解碼（需要 Super Magic Card 頁面）',
    83: '規格已取得但未實作（四合一與多種板子的 PRG 基底位元依板子不同）',
    85: 'VRC7 需要 FM 音效晶片（OPLL）才有音樂，未實作',
    91: '需要 MMC3 外部銀行與兩種 IRQ 模式的規格，未實作',
    163: '防拷保護暫存器（$5000–$5500）規格取得但未實作，錯誤的保護會讓遊戲不動',
    5: '（已由 jsnes 核心支援，不在此清單）'
  };

  // 登記：NES 是 jsnes 的類別（bundle 已掛上 mappers 與 Mapper0）；重複呼叫無妨
  function install(NES) {
    if (!NES || !NES.mappers) throw new Error('musiclib_nes_mappers：NES 沒有 mappers 表（請用 bundle 的 NES）');
    var list = makeMappers(NES);
    Object.keys(list).forEach(function (k) { NES.mappers[k] = list[k]; });
    return SUPPORTED.slice();
  }

  return { install: install, SUPPORTED: SUPPORTED, APPROX: APPROX, NOT_IMPLEMENTED: NOT_IMPLEMENTED, CRASH_NOTES: CRASH_NOTES };
}));
