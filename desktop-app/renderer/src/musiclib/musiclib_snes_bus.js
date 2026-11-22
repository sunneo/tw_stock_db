/* 超任最小匯流排＋畫面迴圈＋聲音埠替身（UMD，純邏輯；不碰 DOM、不用網路）。
 *   createBus(rom, opts)            → { read(addr24), write(addr24, v), frameStart(), hdmaLine(), regs }
 *   createIplStub()                 → 聲音埠替身：只實作 IPL 上傳協定（$AA／$BB 握手、$CC 啟動、區塊寫入、跳轉），記下 64KB RAM
 *   createMachine(rom, opts)        → { cpu, bus, apu, runFrame(), frames }；opts.Cpu 需提供 create(bus)（即 musiclib_snes_cpu.js）
 *   runRom(rom, opts)               → Promise 不需要；同步回傳 { ok, uploaded, uploadFrame, entry, snapshots, reason, … }
 *   headerInfo(rom)                 → { ok, hirom, offset }（沒有 parseHeader 時的退路，與 musiclib_extract_sfc.js 同判準）
 *
 * 位址對應（簡化，寫明白）：
 *   · 銀行 00–3F／80–BF 的 $0000–$1FFF 是 WRAM 鏡像；$2100–$213F PPU：寫入吞掉，讀出給固定值；$2140–$217F 聲音埠（4 個埠，鏡像）；
 *     $2180–$2183 WRAM 資料埠；$4016–$4017 手把串列：讀 0；$4200–$43FF 內部暫存器與 DMA／HDMA 通道；$4210 NMI 旗標；$4212 垂直空白＋水平空白。
 *   · 銀行 7E／7F 是 128KB WRAM。
 *   · LoROM：ROM 在 $8000–$FFFF（銀行 00–7D／80–FF）；HiROM：ROM 是整個銀行（銀行 40–7D／C0–FF，00–3F 的 $8000 以上）。
 *     512 位元組 copier 檔頭會先去掉（與 musiclib_extract_sfc.js 的判斷一致）。
 *   · SRAM：LoROM 在銀行 70–7D 的 $0000–$7FFF；HiROM 在銀行 20–3F／A0–BF 的 $6000–$7FFF；大小取內部標頭 $18。
 *   · 手把讀 0（沒有按鍵）；乘除法暫存器完整（除以 0 的結果依硬體：商 $FFFF、餘數為被除數）。
 *   · 所有時序（水平掃描線 262 條、每條跑固定指令數）是粗估，不是真機時序。
 *   · HDMA 逐條掃描線執行（每條可見線一次），沒有 H-IRQ 與 HDMA 的精確時序。
 *   · DMA 一次跑完，不計時間。
 *
 * 聲音埠替身的限制（很重要）：它**不執行** SPC700 程式，只模擬 IPL 協定把 RAM 寫進去。
 * 所以替身能判斷「上傳完成」，但沒有 DSP 狀態、也不會產生聲音；要真的抽出音樂，需要 SPC700＋S-DSP 核心（ml-spcdsp 的 musiclib_spc_core.js）
 * 接在同一個 apu 介面上（apu.read(p)／apu.write(p, v)／apu.run(cycles)／apu.ram／apu.dsp／apu.entry）。
 *
 * 參考來源（自己從公開文件寫）：fullsnes（nocash，SNES 硬體文件：記憶體對應、DMA／HDMA 傳輸模式、乘除法、內部暫存器）、
 * SNES IPL 上傳協定（SPC700 boot ROM 的公開說明）。沒有抄任何程式。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibSnesBus = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var DMA_PAT = [[0], [0, 1], [0, 0], [0, 0, 1, 1], [0, 1, 2, 3], [0, 1, 0, 1], [0, 0], [0, 0, 1, 1]];
  var LINES = 262, VBLANK_LINE = 225, INSTR_PER_LINE = 60, SPC_CYCLES_PER_LINE = 65;
  var IPL_HANDSHAKE_A = 0xAA, IPL_HANDSHAKE_B = 0xBB, IPL_START = 0xCC;

  function u8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

  // 內部標頭（退路）：LoROM 在 $7FC0、HiROM 在 $FFC0；校驗和補數吻合者優先
  function headerInfo(rom) {
    var b = u8(rom), best = null;
    [[0x7FC0, false], [0xFFC0, true]].forEach(function (c) {
      var o = c[0];
      if (b.length < o + 0x20) return;
      var comp = b[o + 0x1C] | (b[o + 0x1D] << 8), sum = b[o + 0x1E] | (b[o + 0x1F] << 8);
      var ok = ((comp ^ sum) & 0xFFFF) === 0xFFFF;
      if (!best || (ok && !best.ok)) best = { ok: ok, hirom: c[1], offset: o };
    });
    return best || { ok: false, hirom: false, offset: 0x7FC0 };
  }

  // ───── 聲音埠替身（只跑 IPL 上傳協定，不執行 SPC700）─────
  function createIplStub() {
    var st = {
      state: 'ipl',                       // ipl → xfer → running
      echo0: IPL_HANDSHAKE_A,
      last: [0, 0, 0, 0],                 // CPU 最後寫入各埠的值
      dest: 0, hdrPending: false, pend1: 0, mode: 'none', base: 0, off: 0,
      entry: 0, blocks: 0, bytes: 0, portWrites: 0
    };
    var ram = new Uint8Array(0x10000), dsp = new Uint8Array(128);
    return {
      ram: ram, dsp: dsp,
      get state() { return st.state; },
      get entry() { return st.entry; },
      get blocks() { return st.blocks; },
      get bytes() { return st.bytes; },
      get portWrites() { return st.portWrites; },
      read: function (p) {
        p &= 3;
        if (st.state === 'ipl') return p === 0 ? IPL_HANDSHAKE_A : (p === 1 ? IPL_HANDSHAKE_B : 0);
        if (p === 0) return st.echo0;
        if (p === 1) return IPL_HANDSHAKE_B;
        return 0;
      },
      write: function (p, v) {
        p &= 3; v &= 0xFF; st.portWrites++; st.last[p] = v;
        if (st.state === 'ipl') { if (p === 0 && v === IPL_START) { st.state = 'xfer'; st.echo0 = v; } return; }
        if (st.state !== 'xfer') return;
        if (p === 2 || p === 3) { st.dest = p === 2 ? ((st.dest & 0xFF00) | v) : ((st.dest & 0xFF) | (v << 8)); st.hdrPending = true; return; }
        if (p === 1) { st.pend1 = v; return; }
        // p === 0：區塊標頭（剛寫完位址）或資料位元組的計數器
        st.echo0 = v;
        if (st.hdrPending) {
          st.hdrPending = false;
          if (st.pend1 === 0) { st.state = 'running'; st.entry = st.dest & 0xFFFF; return; }   // 指令 0＝跳到位址
          st.mode = 'data'; st.base = st.dest & 0xFFFF; st.off = 0; st.blocks++;
          return;
        }
        if (st.mode === 'data') { ram[(st.base + st.off) & 0xFFFF] = st.pend1; st.off++; st.bytes++; }
      },
      run: function () { /* 替身沒有 SPC700 可跑 */ },
      dumpSpc: function () {
        return { ram: ram.slice(), dsp: dsp.slice(), spc: { pc: st.entry, a: 0, x: 0, y: 0, psw: 0, sp: 0xEF }, placeholder: true };
      }
    };
  }

  // ───── 真的 SPC700＋S-DSP 核心的轉接層（musiclib_spc_core.js 的 createCore 物件）─────
  // 埠：65816 寫 $2140+p → core.setPortIn(p)；65816 讀 → core.portOut(p)（核心內建 IPL 負責上傳協定）。
  // 上傳完成：核心的 PC 從 IPL 區（$FFC0 以上）跳出去執行使用者程式 → state='running'，entry＝跳出去的位址。
  // run(cycles)：每條掃描線由畫面迴圈呼叫，讓 SPC 與主 CPU 大致同步（1.024 MHz ÷ 60 ÷ 262 ≈ 65 個週期／線）。
  function createSpcApu(core) {
    var st = { sawIpl: false, state: 'ipl', entry: 0, portWrites: 0 };
    function check() {
      var pc = core.cpu().pc;
      if (st.state !== 'ipl') return;
      if (pc >= 0xFFC0) st.sawIpl = true;
      else if (st.sawIpl) { st.state = 'running'; st.entry = pc; }
    }
    return {
      read: function (p) { return core.portOut(p & 3); },
      write: function (p, v) { st.portWrites++; core.setPortIn(p & 3, v & 0xFF); },
      run: function (cycles) { core.runCycles(cycles); check(); },
      get state() { return st.state; },
      get entry() { return st.entry; },
      get portWrites() { return st.portWrites; },
      get blocks() { return 0; },
      get bytes() { return 0; },
      dumpSpc: function () {
        var ram = new Uint8Array(0x10000), dsp = new Uint8Array(128), i;
        for (i = 0; i < 0x10000; i++) ram[i] = core.peek(i);
        for (i = 0; i < 128; i++) dsp[i] = core.dspRead(i);
        var c = core.cpu();
        return { ram: ram, dsp: dsp, spc: { pc: c.pc, a: c.a, x: c.x, y: c.y, psw: c.psw, sp: c.sp }, placeholder: false };
      }
    };
  }

  // ───── 匯流排 ─────
  function createBus(romBytes, opts) {
    opts = opts || {};
    var raw = u8(romBytes), copier = raw.length % 1024 === 512;
    var rom = copier ? raw.subarray(512) : raw;
    var hdr = opts.parseHeader ? opts.parseHeader(raw) : headerInfo(rom);
    var hirom = (opts.hirom !== undefined) ? !!opts.hirom : !!hdr.hirom;
    var sramCode = rom[(hdr.offset || 0) + 0x18] || 0;
    var sramBytes = sramCode ? Math.min(0x20000, 1024 << sramCode) : 0;
    var wram = new Uint8Array(0x20000), sram = new Uint8Array(sramBytes), R = new Uint8Array(0x200);
    var apu = opts.apu || createIplStub();
    var openBus = 0, wmadd = 0, hbAlt = 0, nmiFlag = false, vblank = false;
    var hd = [];
    for (var hc = 0; hc < 8; hc++) hd.push({ on: false, tbl: 0, cnt: 0, data: 0, done: false, first: false });

    function sramIndex(bank, off) {
      if (!sramBytes) return -1;
      if (!hirom) {
        if ((bank >= 0x70 && bank <= 0x7D) || (bank >= 0xF0 && bank <= 0xFF)) {
          if (off < 0x8000) return ((bank & 0x0F) * 0x8000 + off) % sramBytes;
        }
      } else if ((bank >= 0x20 && bank <= 0x3F) || (bank >= 0xA0 && bank <= 0xBF)) {
        if (off >= 0x6000 && off < 0x8000) return ((bank & 0x1F) * 0x2000 + (off - 0x6000)) % sramBytes;
      }
      return -1;
    }
    function romIndex(bank, off) {
      if (!hirom) {
        if (off < 0x8000) return -1;
        return ((bank & 0x7F) * 0x8000 + (off & 0x7FFF));
      }
      if (off >= 0x8000 || (bank >= 0x40 && bank < 0x80) || bank >= 0xC0) return (((bank & 0x3F) << 16) | off);
      return -1;
    }

    function sysRead(off) {
      if (off >= 0x2100 && off <= 0x213F) {
        if (off === 0x213E) return 0x01;          // PPU1 版本
        if (off === 0x213F) return 0x03;          // PPU2 版本
        return 0;
      }
      if (off >= 0x2140 && off <= 0x217F) return apu.read(off & 3);
      if (off === 0x2180) { var v = wram[wmadd]; wmadd = (wmadd + 1) & 0x1FFFF; return v; }
      if (off === 0x4016 || off === 0x4017) return 0;
      if (off >= 0x4200 && off <= 0x43FF) return regRead(off);
      return openBus;
    }
    function regRead(off) {
      var i = off - 0x4200;
      if (off === 0x4210) { var f = (nmiFlag ? 0x80 : 0) | 0x02; nmiFlag = false; return f; }
      if (off === 0x4211) return 0;
      if (off === 0x4212) { hbAlt ^= 1; return (vblank ? 0x80 : 0) | (hbAlt ? 0x40 : 0); }   // 水平空白交替，等待迴圈兩種寫法都能過
      if (off >= 0x4218 && off <= 0x421F) return 0;                                           // 自動讀手把：沒有按鍵
      return R[i];
    }
    function sysWrite(off, v) {
      if (off >= 0x2100 && off <= 0x213F) return;                 // PPU：吞掉
      if (off >= 0x2140 && off <= 0x217F) { apu.write(off & 3, v); return; }
      if (off === 0x2180) { wram[wmadd] = v; wmadd = (wmadd + 1) & 0x1FFFF; return; }
      if (off === 0x2181) { wmadd = (wmadd & 0x1FF00) | v; return; }
      if (off === 0x2182) { wmadd = (wmadd & 0x100FF) | (v << 8); return; }
      if (off === 0x2183) { wmadd = (wmadd & 0x0FFFF) | ((v & 1) << 16); return; }
      if (off >= 0x4200 && off <= 0x43FF) regWrite(off, v & 0xFF);
    }
    function regWrite(off, v) {
      var i = off - 0x4200;
      if (off >= 0x4210 && off <= 0x421F) return;                 // 唯讀
      R[i] = v;
      if (off === 0x4202) { return; }
      if (off === 0x4203) { var p = (R[0x02] * v) & 0xFFFF; R[0x16] = p & 0xFF; R[0x17] = p >> 8; return; }
      if (off === 0x4206) {
        var dvd = R[0x04] | (R[0x05] << 8), q, rem;
        if (v === 0) { q = 0xFFFF; rem = dvd; } else { q = Math.floor(dvd / v) & 0xFFFF; rem = dvd % v; }
        R[0x14] = q & 0xFF; R[0x15] = q >> 8; R[0x16] = rem & 0xFF; R[0x17] = rem >> 8;
        return;
      }
      if (off === 0x420B) {                                       // MDMAEN：一般 DMA
        for (var c = 0; c < 8; c++) if ((v >> c) & 1) dma(c);
        R[i] = 0; return;
      }
      if (off === 0x420C) return;                                 // HDMAEN：每張畫面開始時套用
    }

    function readMem(bank, off) {
      if (bank === 0x7E || bank === 0x7F) return wram[((bank & 1) << 16) | off];
      if (bank < 0x40 || (bank >= 0x80 && bank < 0xC0)) {
        if (off < 0x2000) return wram[off];
        if (off < 0x6000) return sysRead(off);
      }
      var si = sramIndex(bank, off);
      if (si >= 0) return sram[si];
      var ri = romIndex(bank, off);
      if (ri >= 0 && rom.length) return rom[ri % rom.length];
      return openBus;
    }
    function writeMem(bank, off, v) {
      if (bank === 0x7E || bank === 0x7F) { wram[((bank & 1) << 16) | off] = v; return; }
      if (bank < 0x40 || (bank >= 0x80 && bank < 0xC0)) {
        if (off < 0x2000) { wram[off] = v; return; }
        if (off < 0x6000) { sysWrite(off, v); return; }
      }
      var si = sramIndex(bank, off);
      if (si >= 0) sram[si] = v;
      // ROM 寫入忽略
    }

    function read(addr) { addr &= 0xFFFFFF; var v = readMem(addr >>> 16, addr & 0xFFFF); openBus = v; return v; }
    function write(addr, v) { addr &= 0xFFFFFF; writeMem(addr >>> 16, addr & 0xFFFF, v & 0xFF); }

    // 一般 DMA（通道 c）：一次跑完；A 位址遞增／遞減／固定由 DMAP 決定
    function dma(c) {
      var b = 0x100 + c * 0x10, dmap = R[b], bbad = R[b + 1];   // 通道 c 的暫存器在 $4300+c*$10（R 的索引＝位址－$4200）
      var a = ((R[b + 4] << 16) | (R[b + 3] << 8) | R[b + 2]) >>> 0;
      var cnt = (R[b + 5] | (R[b + 6] << 8)) || 0x10000;
      // DMAP：bit 7＝方向（1＝B→A）、bit 4＝A 位址固定、bit 3＝A 位址遞減（0＝遞增）、bits 2–0＝傳輸模式
      var pat = DMA_PAT[dmap & 7], toA = (dmap & 0x80) !== 0, fixed = (dmap & 0x10) !== 0, dec = (dmap & 0x08) !== 0;
      var n = 0;
      while (n < cnt) {
        for (var i = 0; i < pat.length && n < cnt; i++, n++) {
          var bAddr = 0x2100 + ((bbad + pat[i]) & 0xFF);
          if (toA) write(a, readB(bAddr));     // B→A：讀 B 寫 A
          else writeB(bAddr, read(a));         // A→B：讀 A 寫 B
          if (!fixed) a = (a & 0xFF0000) | (((a & 0xFFFF) + (dec ? -1 : 1)) & 0xFFFF);
        }
      }
      R[b + 2] = a & 0xFF; R[b + 3] = (a >> 8) & 0xFF; R[b + 4] = (a >> 16) & 0xFF;
      R[b + 5] = 0; R[b + 6] = 0;
    }
    function readB(addr) { return readMem(0, addr & 0xFFFF); }
    function writeB(addr, v) { writeMem(0, addr & 0xFFFF, v); }

    // HDMA：每張畫面開始時載入表格位址；每條可見掃描線執行一次
    function frameStart() {
      for (var c = 0; c < 8; c++) {
        var h = hd[c], b = 0x100 + c * 0x10;
        h.on = ((R[0x0C] >> c) & 1) !== 0;
        h.done = false; h.cnt = 0; h.first = false;
        h.tbl = ((R[b + 4] << 16) | R[b + 8] | (R[b + 9] << 8)) >>> 0;
      }
    }
    function hdmaLine() {
      for (var c = 0; c < 8; c++) {
        var h = hd[c];
        if (!h.on || h.done) continue;
        var b = 0x100 + c * 0x10, indirect = (R[b] & 0x40) !== 0;
        if ((h.cnt & 0x7F) === 0) {
          var k = read(h.tbl); h.tbl = (h.tbl + 1) & 0xFFFFFF;
          if (k === 0) { h.done = true; continue; }
          h.cnt = k; h.first = true;
          if (indirect) {
            h.data = ((R[b + 7] << 16) | read(h.tbl) | (read((h.tbl + 1) & 0xFFFFFF) << 8)) >>> 0;
            h.tbl = (h.tbl + 2) & 0xFFFFFF;
          }
        }
        if (h.first || (h.cnt & 0x80)) {
          var pat = DMA_PAT[R[b] & 7];
          for (var i = 0; i < pat.length; i++) {
            var v;
            if (indirect) { v = read(h.data); h.data = (h.data + 1) & 0xFFFFFF; }
            else { v = read(h.tbl); h.tbl = (h.tbl + 1) & 0xFFFFFF; }
            writeB(0x2100 + ((R[b + 1] + pat[i]) & 0xFF), v);
          }
        }
        h.first = false;
        h.cnt = (h.cnt & 0x80) | ((h.cnt & 0x7F) - 1);
      }
    }

    return {
      read: read, write: write, frameStart: frameStart, hdmaLine: hdmaLine,
      setVblank: function (on) { vblank = on; if (on) nmiFlag = true; },
      nmiEnabled: function () { return (R[0] & 0x80) !== 0; },
      apu: apu, hirom: hirom, copier: copier, sramBytes: sramBytes,
      mapMode: rom[(hdr.offset || 0) + 0x15] || 0, romBytes: rom.length
    };
  }

  // ───── 畫面迴圈（掃描線＝262 條；每條跑固定指令數）─────
  function createMachine(romBytes, opts) {
    opts = opts || {};
    if (!opts.Cpu || typeof opts.Cpu.create !== 'function') throw new Error('createMachine：需要 opts.Cpu（musiclib_snes_cpu.js）');
    var bus = createBus(romBytes, opts);
    var cpu = opts.Cpu.create(bus);
    var perLine = opts.instrPerLine || INSTR_PER_LINE;
    var m = { cpu: cpu, bus: bus, apu: bus.apu, frames: 0 };
    m.runFrame = function () {
      for (var line = 0; line < LINES; line++) {
        if (line === 0) { bus.setVblank(false); bus.frameStart(); }
        if (line === VBLANK_LINE) {
          bus.setVblank(true);
          if (bus.nmiEnabled()) cpu.nmiPending = true;
        }
        if (line > 0 && line < VBLANK_LINE) bus.hdmaLine();
        for (var k = 0; k < perLine; k++) { if (cpu.step() === 0 && cpu.halted && !cpu.nmiPending) break; }
        bus.apu.run(SPC_CYCLES_PER_LINE);
      }
      m.frames++;
    };
    return m;
  }

  // ───── 整體：跑 ROM 直到聲音程式上傳完成，之後每隔一段時間拍一次快照 ─────
  // opts: { Cpu, parseHeader?, hirom?, maxFrames?（預設 3600）, snapshotFrames?（上傳後的畫面數，預設 [120, 600, 1800]）,
  //         isCancelled?(), onProgress?(frame), apu? }
  // 注意：預設的替身 apu 不執行 SPC700，快照的 DSP 與 SPC700 暫存器只是占位，不能當成音樂用（呼叫端要自己判斷）。
  function runRom(romBytes, opts) {
    opts = opts || {};
    var maxFrames = opts.maxFrames || 3600;
    var offsets = opts.snapshotFrames || [120, 600, 1800];
    var m = createMachine(romBytes, opts);
    var res = { ok: false, uploaded: false, uploadFrame: null, entry: null, snapshots: [], cancelled: false, reason: '', boot: null, cpu: null, apu: null };
    res.boot = { hirom: m.bus.hirom, copier: m.bus.copier, mapMode: m.bus.mapMode, romBytes: m.bus.romBytes, sramBytes: m.bus.sramBytes };
    var upAt = -1, nextSnap = 0;
    while (m.frames < maxFrames) {
      if (opts.isCancelled && opts.isCancelled()) { res.cancelled = true; break; }
      m.runFrame();
      if (opts.onProgress && m.frames % 60 === 0) opts.onProgress(m.frames);
      if (upAt < 0 && m.apu.state === 'running') { upAt = m.frames; res.uploaded = true; res.uploadFrame = m.frames; res.entry = m.apu.entry; }
      if (upAt >= 0 && nextSnap < offsets.length && m.frames >= upAt + offsets[nextSnap]) {
        var d = m.apu.dumpSpc();
        res.snapshots.push({ frame: m.frames, ramCopy: d.ram, dsp: d.dsp, spc: d.spc, placeholder: d.placeholder });
        nextSnap++;
      }
      if (upAt >= 0 && nextSnap >= offsets.length) break;
    }
    res.cpu = { pc: m.cpu.PC, pbr: m.cpu.PBR, e: m.cpu.E, halted: m.cpu.halted, stopped: m.cpu.stopped, instructions: m.cpu.instructions };
    res.apu = { state: m.apu.state, portWrites: m.apu.portWrites, blocks: m.apu.blocks, bytes: m.apu.bytes };
    res.frames = m.frames;
    res.ok = res.uploaded && res.snapshots.length > 0;
    if (!res.uploaded && !res.cancelled) {
      res.reason = '聲音程式上傳沒有完成（跑了 ' + m.frames + ' 個畫面；主 CPU PC=$' + m.cpu.PBR.toString(16).padStart(2, '0') + ':' + m.cpu.PC.toString(16).padStart(4, '0') +
        '，SPC 埠狀態=' + m.apu.state + '，埠寫入 ' + m.apu.portWrites + ' 次）';
    }
    return res;
  }

  return { createBus: createBus, createIplStub: createIplStub, createSpcApu: createSpcApu, createMachine: createMachine, runRom: runRom, headerInfo: headerInfo, DMA_PAT: DMA_PAT };
}));
