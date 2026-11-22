/* 超任 65816＋匯流排＋聲音埠替身的單元測試（不讀真實 ROM）：node renderer/src/musiclib/musiclib_snes_test.js
 * 手組的 65816 程式直接放在 ROM 陣列裡（LoROM，重置向量 $FFFC 指向 $8000）。真實 ROM 的冒煙另見 musiclib_snes_smoke.js。 */
'use strict';
var assert = require('assert');
var CPU = require('./musiclib_snes_cpu.js');
var BUS = require('./musiclib_snes_bus.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// 32KB LoROM（銀行 00 的 $8000–$FFFF）：程式放在偏移 0（$8000），重置向量在偏移 $7FFC
function loromWith(code, opts) {
  opts = opts || {};
  var rom = new Uint8Array(0x8000);
  code.forEach(function (b, i) { rom[i] = b; });
  // 其他位址的程式（中斷處理等）也要在 ROM 裡（匯流排的 ROM 不能寫入）
  (opts.extra || []).forEach(function (e) { e[1].forEach(function (b, i) { rom[(e[0] - 0x8000) + i] = b; }); });
  rom[0x7FFC] = 0x00; rom[0x7FFD] = 0x80;          // RESET → $8000
  rom[0x7FEA] = opts.nmi & 0xFF; rom[0x7FEB] = opts.nmi >> 8;   // NMI（native）
  rom[0x7FFA] = opts.nmiE & 0xFF; rom[0x7FFB] = opts.nmiE >> 8; // NMI（emu）
  rom[0x7FEE] = opts.irq & 0xFF; rom[0x7FEF] = opts.irq >> 8;   // IRQ（native）
  rom[0x7FE6] = opts.brk & 0xFF; rom[0x7FE7] = opts.brk >> 8;   // BRK（native）
  // 內部標頭（LoROM $7FC0）：標題、模式、校驗和補數
  var title = 'TEST'; for (var i = 0; i < title.length; i++) rom[0x7FC0 + i] = title.charCodeAt(i);
  rom[0x7FD5] = 0x20; rom[0x7FD8] = 0x00;
  var sum = 0x1234, comp = sum ^ 0xFFFF;
  rom[0x7FDC] = comp & 0xFF; rom[0x7FDD] = comp >> 8; rom[0x7FDE] = sum & 0xFF; rom[0x7FDF] = sum >> 8;
  return rom;
}
// 把 ROM 接到匯流排並建立 CPU（不經過畫面迴圈）
function machine(rom, opts) {
  var bus = BUS.createBus(rom, opts || {});
  var cpu = new CPU.Cpu(bus);
  return { bus: bus, cpu: cpu, apu: bus.apu };
}
function runSteps(cpu, n) { var k = 0; while (k < n && cpu.step()) k++; return k; }

// ───── 指令與旗標 ─────
t('重置後 E=1、M=X=1、S=$01FF、PC 取自 $FFFC', function () {
  var m = machine(loromWith([0xDB]));
  assert.strictEqual(m.cpu.E, true);
  assert.strictEqual(m.cpu.PC, 0x8000);
  assert.strictEqual(m.cpu.S, 0x1FF);
  assert.ok(m.cpu.P & CPU.F.M && m.cpu.P & CPU.F.X && m.cpu.P & CPU.F.I);
});

t('XCE 切到原生、REP 取消 8 位元、16 位元算術與進位', function () {
  // CLC; XCE; REP #$30; LDA #$1234; CLC; ADC #$0001; STA $10; SEP #$20; LDA #$FF; XBA; STP
  var code = [0x18, 0xFB, 0xC2, 0x30, 0xA9, 0x34, 0x12, 0x18, 0x69, 0x01, 0x00, 0x85, 0x10, 0xE2, 0x20, 0xA9, 0xFF, 0xEB, 0xDB];
  var m = machine(loromWith(code));
  runSteps(m.cpu, 100);
  assert.strictEqual(m.cpu.E, false);
  assert.strictEqual(m.bus.read(0x10), 0x35);
  assert.strictEqual(m.bus.read(0x11), 0x12);
  assert.strictEqual(m.cpu.A, 0xFF12);            // XBA 把 $12FF 換成 $FF12
  assert.ok(m.cpu.stopped);
});

t('十進位 ADC／SBC（D 旗標）：19+28=47；10-1=09', function () {
  // SED; CLC; LDA #$19; ADC #$28; STA $10; SEC; LDA #$10; SBC #$01; STA $11; STP （E=1 時 8 位元）
  var code = [0xF8, 0x18, 0xA9, 0x19, 0x69, 0x28, 0x85, 0x10, 0x38, 0xA9, 0x10, 0xE9, 0x01, 0x85, 0x11, 0xDB];
  var m = machine(loromWith(code));
  runSteps(m.cpu, 100);
  assert.strictEqual(m.bus.read(0x10), 0x47);
  assert.strictEqual(m.bus.read(0x11), 0x09);
});

t('直接頁：E=1 且 DL=0 時 (dp,X) 在頁內回繞', function () {
  // LDA (dp,X) dp=$F5，X=$10：指標在 $0005（$F5+$10 在頁內回繞為 $05）→ 指向 $1234
  var m = machine(loromWith([0xA1, 0xF5]));
  m.cpu.X = 0x10; m.cpu.D = 0x0000;
  m.bus.write(0x0005, 0x34); m.bus.write(0x0006, 0x12);
  m.bus.write(0x001234, 0x5A);
  m.cpu.step();                                             // E=1，A 為 8 位元
  assert.strictEqual(m.cpu.A & 0xFF, 0x5A);
});

t('堆疊與 PEA／PLA：16 位元推入與拉出的順序', function () {
  // CLC; XCE（原生）; REP #$20（A 16 位元）; PEA $ABCD; PLA; STA $20; STP
  var code = [0x18, 0xFB, 0xC2, 0x20, 0xF4, 0xCD, 0xAB, 0x68, 0x85, 0x20, 0xDB];
  var m = machine(loromWith(code));
  runSteps(m.cpu, 50);
  assert.strictEqual(m.bus.read(0x20), 0xCD);
  assert.strictEqual(m.bus.read(0x21), 0xAB);
});

t('JSR／RTS 與 JSL／RTL 往返，PC 與銀行正確', function () {
  // CLC; XCE（原生，M=X=1）; JSR $8010; STP ; 副程式 $8010: LDA #$77; STA $30; RTS
  var code = [0x18, 0xFB, 0x20, 0x10, 0x80, 0xDB];
  var sub = [0xA9, 0x77, 0x85, 0x30, 0x60];
  var m = machine(loromWith(code, { extra: [[0x8010, sub]] }));
  runSteps(m.cpu, 50);
  assert.strictEqual(m.bus.read(0x30), 0x77);
  assert.ok(m.cpu.stopped);
});

t('MVN 區塊搬移：把 4 個位元組從 $7E:0100 搬到 $7E:0200', function () {
  // 原生模式、16 位元 A／X／Y：LDA #3; LDX #$0100; LDY #$0200; MVN $7E,$7E; STP
  var code = [0x18, 0xFB, 0xC2, 0x30, 0xA9, 0x03, 0x00, 0xA2, 0x00, 0x01, 0xA0, 0x00, 0x02, 0x54, 0x7E, 0x7E, 0xDB];
  var m = machine(loromWith(code));
  [0x11, 0x22, 0x33, 0x44].forEach(function (v, i) { m.bus.write(0x7E0100 + i, v); });
  runSteps(m.cpu, 100);
  assert.strictEqual(m.bus.read(0x7E0200), 0x11);
  assert.strictEqual(m.bus.read(0x7E0203), 0x44);
  assert.strictEqual(m.cpu.A, 0xFFFF);
});

t('BRK 與 COP 在原生模式走各自的向量並推入 PBR／PC／P', function () {
  // 原生模式；BRK #0 會跳到 $8100；那裡 STP
  // CLC; XCE；BRK 後面有一個記號位元組；BRK 向量指向 $8100，那裡是 STP
  var code = [0x18, 0xFB, 0x00, 0x00, 0xEA, 0xEA];
  var m = machine(loromWith(code, { brk: 0x8100, extra: [[0x8100, [0xDB]]] }));
  var sp = m.cpu.S;
  runSteps(m.cpu, 50);
  assert.ok(m.cpu.stopped);
  assert.strictEqual(m.cpu.S, sp - 4);       // 推入 PBR（1）＋PC（2）＋P（1）
  assert.strictEqual(m.cpu.PBR, 0);
  assert.strictEqual((m.cpu.P & CPU.F.I) !== 0, true);
});

t('NMI：邊緣請求進入 NMI 向量，RTI 回到原位', function () {
  // 主程式：$8000 的無窮迴圈 BRA -2；NMI 處理（$8100）：LDA #$AA; STA $40; RTI
  var m = machine(loromWith([0x80, 0xFE], { nmi: 0x8100, extra: [[0x8100, [0xA9, 0xAA, 0x85, 0x40, 0x40]]] }));
  m.cpu.E = false;                          // 原生，M=1（8 位元）
  m.cpu.nmiPending = true;
  runSteps(m.cpu, 30);
  assert.strictEqual(m.bus.read(0x40), 0xAA);
  assert.strictEqual(m.cpu.nmiPending, false);
});

t('IRQ：只有 I=0 時才進入；WAI 會被 IRQ 喚醒', function () {
  // CLC; XCE; CLI; WAI; STP
  var m = machine(loromWith([0x18, 0xFB, 0x58, 0xCB, 0xDB], { irq: 0x8100, extra: [[0x8100, [0xA9, 0xBB, 0x85, 0x41, 0x40]]] }));
  runSteps(m.cpu, 4);                       // CLC、XCE、CLI、WAI
  assert.ok(m.cpu.halted);                  // 停在 WAI
  m.cpu.irqLine = true;
  runSteps(m.cpu, 1);                       // 喚醒並進入 IRQ（I=0）
  m.cpu.irqLine = false;
  runSteps(m.cpu, 10);
  assert.strictEqual(m.bus.read(0x41), 0xBB);
});

t('全部 256 個運算碼都有實作（只會因非法記憶體操作而不同，不會丟出「未實作」）', function () {
  var missing = [];
  for (var op = 0; op < 256; op++) {
    var m = machine(loromWith([]));
    m.cpu.E = false; m.cpu.P &= ~(CPU.F.M | CPU.F.X);
    m.cpu.PBR = 0; m.cpu.PC = 0x0100;             // 程式放在 WRAM（ROM 不能寫）
    m.bus.write(0x0100, op); for (var k = 1; k < 8; k++) m.bus.write(0x0100 + k, 0x00);
    try { m.cpu.step(); } catch (e) { if (/未實作的運算碼/.test(String(e.message))) missing.push('$' + op.toString(16)); }
  }
  assert.deepStrictEqual(missing, []);
});

// ───── 匯流排：映射、DMA、硬體暫存器 ─────
t('LoROM 與 HiROM 映射：ROM 偏移正確，銀行鏡像', function () {
  var lo = loromWith([0xDB]);
  var m = machine(lo);
  assert.strictEqual(m.bus.read(0x008000), lo[0]);
  assert.strictEqual(m.bus.hirom, false);
  // HiROM：內部標頭在 $FFC0，模式位元 bit 0 = 1
  var hi = new Uint8Array(0x10000);
  hi[0xFFC0 + 0x15] = 0x21; hi[0xFFC0 + 0x1C] = 0xFF; hi[0xFFC0 + 0x1D] = 0xFF; hi[0xFFC0 + 0x1E] = 0; hi[0xFFC0 + 0x1F] = 0;
  hi[0x1234] = 0x5C;
  var mh = machine(hi);
  assert.strictEqual(mh.bus.hirom, true);
  assert.strictEqual(mh.bus.read(0xC01234), 0x5C);
});

t('512 位元組 copier 檔頭會被去掉（偏移 +512）', function () {
  var base = loromWith([0xDB]);
  var withHdr = new Uint8Array(base.length + 512);
  withHdr.set(base, 512);
  var m = machine(withHdr);
  assert.strictEqual(m.bus.copier, true);
  assert.strictEqual(m.bus.read(0x008000), base[0]);
});

t('一般 DMA（通道 0，A→WRAM 位址 $7E:0300，DMAP=$00 模式 0）搬 8 個位元組', function () {
  var m = machine(loromWith([0xDB]));
  for (var i = 0; i < 8; i++) m.bus.write(0x7F0000 + 0x1000 + i, 0xC0 + i);
  // 通道 0：DMAP=0（A→B、遞增、模式 0），B 位址 $80（WRAM 資料埠 $2180），A=$7F:1000，數量 8
  m.bus.write(0x4300, 0x00); m.bus.write(0x4301, 0x80);
  m.bus.write(0x4302, 0x00); m.bus.write(0x4303, 0x10); m.bus.write(0x4304, 0x7F);
  m.bus.write(0x4305, 0x08); m.bus.write(0x4306, 0x00);
  m.bus.write(0x2181, 0x00); m.bus.write(0x2182, 0x00); m.bus.write(0x2183, 0x00);   // WRAM 位址 = 0
  m.bus.write(0x420B, 0x01);
  for (i = 0; i < 8; i++) assert.strictEqual(m.bus.read(0x7E0000 + i), 0xC0 + i);
});

t('DMA 寫入聲音埠 $2140（上傳資料路徑）會傳到替身的埠', function () {
  var m = machine(loromWith([0xDB]));
  var seen = [];
  m.bus.apu.write = function (p, v) { seen.push([p, v]); };
  m.bus.write(0x7E2000, 0xAB); m.bus.write(0x7E2001, 0xCD);
  m.bus.write(0x4300, 0x00); m.bus.write(0x4301, 0x40);   // B 位址 $40 → $2140
  m.bus.write(0x4302, 0x00); m.bus.write(0x4303, 0x20); m.bus.write(0x4304, 0x7E);
  m.bus.write(0x4305, 0x02); m.bus.write(0x4306, 0x00);
  m.bus.write(0x420B, 0x01);
  assert.deepStrictEqual(seen, [[0, 0xAB], [0, 0xCD]]);
});

t('乘除法：$4202×$4203 與 $4204/$4205÷$4206；除以 0 的結果', function () {
  var m = machine(loromWith([0xDB]));
  m.bus.write(0x4202, 0x12); m.bus.write(0x4203, 0x34);      // 0x12 × 0x34 = 0x3A8
  assert.strictEqual(m.bus.read(0x4216), 0xA8); assert.strictEqual(m.bus.read(0x4217), 0x03);
  m.bus.write(0x4204, 0x64); m.bus.write(0x4205, 0x00); m.bus.write(0x4206, 0x07);   // 100 ÷ 7 = 14 餘 2
  assert.strictEqual(m.bus.read(0x4214), 14); assert.strictEqual(m.bus.read(0x4216), 2);
  m.bus.write(0x4206, 0x00);                                  // 除以 0
  assert.strictEqual(m.bus.read(0x4214), 0xFF); assert.strictEqual(m.bus.read(0x4215), 0xFF);
});

t('$4210 NMI 旗標與 $4212 垂直空白＋水平空白交替，讀後清 NMI', function () {
  var m = machine(loromWith([0xDB]));
  m.bus.setVblank(true);
  assert.strictEqual((m.bus.read(0x4212) & 0x80), 0x80);
  var a = m.bus.read(0x4210), b = m.bus.read(0x4210);
  assert.strictEqual(a & 0x80, 0x80); assert.strictEqual(b & 0x80, 0);
  var h1 = m.bus.read(0x4212) & 0x40, h2 = m.bus.read(0x4212) & 0x40;
  assert.notStrictEqual(h1, h2);                              // 水平空白交替
});

t('手把讀 0；WRAM 資料埠 $2180 自動遞增', function () {
  var m = machine(loromWith([0xDB]));
  assert.strictEqual(m.bus.read(0x4218), 0);
  m.bus.write(0x2181, 0x10); m.bus.write(0x2182, 0x00); m.bus.write(0x2183, 0x00);
  m.bus.write(0x2180, 0x5A); m.bus.write(0x2180, 0x6B);
  assert.strictEqual(m.bus.read(0x7E0010), 0x5A); assert.strictEqual(m.bus.read(0x7E0011), 0x6B);
});

// ───── 聲音埠替身：IPL 上傳協定 ─────
t('IPL 上傳協定：握手 $AA／$BB → $CC；區塊寫入；指令 0 跳轉後 state=running', function () {
  var apu = BUS.createIplStub();
  assert.strictEqual(apu.read(0), 0xAA); assert.strictEqual(apu.read(1), 0xBB);
  apu.write(0, 0xCC);
  assert.strictEqual(apu.state, 'xfer'); assert.strictEqual(apu.read(0), 0xCC);
  // 區塊：目的 $0200、命令非零（1）、計數器 0；資料 3 個位元組（每個：埠 1＝資料、埠 0＝計數器）
  apu.write(2, 0x00); apu.write(3, 0x02); apu.write(1, 0x01); apu.write(0, 0x00);
  apu.write(1, 0x11); apu.write(0, 0x00);
  apu.write(1, 0x22); apu.write(0, 0x01);
  apu.write(1, 0x33); apu.write(0, 0x02);
  assert.strictEqual(apu.ram[0x200], 0x11); assert.strictEqual(apu.ram[0x201], 0x22); assert.strictEqual(apu.ram[0x202], 0x33);
  assert.strictEqual(apu.blocks, 1); assert.strictEqual(apu.bytes, 3);
  // 跳轉：目的 $0200、命令 0、計數器
  apu.write(2, 0x00); apu.write(3, 0x02); apu.write(1, 0x00); apu.write(0, 0x03);
  assert.strictEqual(apu.state, 'running'); assert.strictEqual(apu.entry, 0x0200);
});

t('機器迴圈：上傳協定由主 CPU 的程式完成，偵測到 running', function () {
  // 主 CPU 程式：原生模式，依協定寫埠（握手、CC、一個位元組、跳轉到 $0200），最後 STP
  var code = [
    0x18, 0xFB,                         // CLC; XCE（原生）
    0xE2, 0x20,                         // SEP #$20（8 位元 A）
    0xA9, 0xCC, 0x8D, 0x40, 0x21,       // LDA #$CC; STA $2140（啟動）
    0xA9, 0x00, 0x8D, 0x42, 0x21,       // LDA #0; STA $2142（目的低）
    0xA9, 0x02, 0x8D, 0x43, 0x21,       // LDA #2; STA $2143（目的高）
    0xA9, 0x00, 0x8D, 0x41, 0x21,       // LDA #0; STA $2141（命令 0＝跳轉）
    0xA9, 0x03, 0x8D, 0x40, 0x21,       // LDA #3; STA $2140（計數器）
    0xDB                                // STP
  ];
  var rom = loromWith(code);
  var m = BUS.createMachine(rom, { Cpu: CPU });
  m.runFrame();
  assert.strictEqual(m.apu.state, 'running');
  assert.strictEqual(m.apu.entry, 0x0200);
});

t('runRom：上傳完成後拍快照；沒有上傳就回報具體原因', function () {
  // 主程式只是無窮迴圈（從不上傳）→ 回報失敗並含 PC
  var bad = BUS.runRom(loromWith([0x80, 0xFE]), { Cpu: CPU, maxFrames: 3 });
  assert.strictEqual(bad.ok, false);
  assert.ok(/上傳沒有完成/.test(bad.reason), bad.reason);
  assert.ok(/PC=\$00:8000/.test(bad.reason), bad.reason);
});

// ───── 執行 ─────
var fail = 0;
tests.forEach(function (x) {
  try { x.fn(); console.log('通過：' + x.name); }
  catch (e) { fail++; console.log('失敗：' + x.name + '\n  ' + (e && e.message)); }
});
console.log(fail ? ('有 ' + fail + ' 項失敗') : ('全部 ' + tests.length + ' 項通過'));
if (fail) process.exitCode = 1;
