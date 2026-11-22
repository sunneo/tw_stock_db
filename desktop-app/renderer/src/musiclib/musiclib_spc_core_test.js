/* SPC700＋S-DSP 核心單元測試：node renderer/src/musiclib/musiclib_spc_core_test.js
 * 用手組的 SPC700 機器碼與 BRR 樣本驗證：IPL 握手、全部 256 個運算碼都有實作、算術旗標、堆疊與呼叫、
 * 計時器、通訊埠、DSP 的 BRR 正弦（音高換算成頻率）、包絡斜率（GAIN 線性增加、ADSR 攻擊）、BRR 結束旗標與釋放靜音、
 * 噪音、音高調變、回音寫入、快照與還原的一致性、由 .spc 檔（packSpc／parseSpc）載入後執行。
 * 不需要真 ROM；真實 .spc 冒煙由播放器後端的測試另外做。 */
'use strict';
var assert = require('assert');
var CORE = require('./musiclib_spc_core.js');
var SFC = require('./musiclib_extract_sfc.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// 在 RAM 的 $0400 放一段機器碼，從那裡開始執行
function progCore(bytes, extra) {
  var c = CORE.createCore(extra || {});
  c.poke(0x0400, bytes);
  c.setPc = null;
  c.runCycles(0);
  return c;
}
// 直接設定程式計數器（透過 spc 初始化最簡單）
function coreAt(pc, bytes, extra) {
  var ram = new Uint8Array(65536);
  ram.set(bytes, pc);
  var init = { ram: ram, pc: pc, a: (extra && extra.a) || 0, x: (extra && extra.x) || 0, y: (extra && extra.y) || 0, sp: 0xEF, psw: (extra && extra.psw) || 0, dsp: new Uint8Array(128) };
  // 沒有 DSP 初值時的 FLG 由 dsp 陣列決定：這裡給 0（不靜音、不停回音）
  init.dsp[0x6C] = 0x00;
  return CORE.createCore(init);
}
function stepN(c, n) { for (var i = 0; i < n; i++) c.runCycles(1); }

// BRR：一個 16 取樣的區塊，range 12、filter 0；flags：1 結束、2 循環
function brrBlock(nibbles, flags) {
  var out = [((12 << 4) | (flags & 3))];
  for (var i = 0; i < 8; i++) out.push(((nibbles[2 * i] & 15) << 4) | (nibbles[2 * i + 1] & 15));
  return out;
}
var SINE16 = [0, 3, 5, 7, 7, 7, 5, 3, 0, -3, -5, -7, -7, -7, -5, -3];

// 設定聲道 0 播放位於 $0300 的一個 BRR 區塊（循環到自己），pitch 0x1000 ＝ 32000÷16 ＝ 2000 Hz
function setupSine(c, pitch, flags, nibbles) {
  c.poke(0x0200, [0x00, 0x03, 0x00, 0x03]);            // 來源目錄 $0200：SRCN 0 的起點與循環點都是 $0300
  c.poke(0x0300, brrBlock(nibbles || SINE16, flags == null ? 2 : flags));
  c.dspWrite(0x5D, 0x02);
  c.dspWrite(0x0C, 0x7F); c.dspWrite(0x1C, 0x7F);
  c.dspWrite(0x00, 0x7F); c.dspWrite(0x01, 0x7F);
  c.dspWrite(0x02, pitch & 0xFF); c.dspWrite(0x03, (pitch >> 8) & 0x3F);
  c.dspWrite(0x04, 0x00);
  c.dspWrite(0x05, 0x00); c.dspWrite(0x07, 0x7F);        // ADSR 關閉 → GAIN 直接值 $7F（約 0x7F0）
  c.dspWrite(0x6C, 0x20);                                // 不靜音、回音停止
}
function crossings(buf) {
  var n = 0;
  for (var i = 1; i < buf.length; i++) if (buf[i - 1] <= 0 && buf[i] > 0) n++;
  return n;
}
function renderMono(c, n) {
  var L = new Float32Array(n), R = new Float32Array(n);
  c.renderStereo(L, R, 0, n);
  return { L: L, R: R };
}

// ───── 1. IPL 開機握手 ─────
t('IPL 啟動程式送出 AA、BB 握手，並等待主 CPU 送 CC', function () {
  var c = CORE.createCore({});
  var n = 0;
  while (c.portOut(1) !== 0xBB && n < 200000) { c.runCycles(1); n++; }
  assert.strictEqual(c.portOut(0), 0xAA);
  assert.strictEqual(c.portOut(1), 0xBB);
  // 主 CPU 送 CC：IPL 會接著清空 ＄F4 迴圈（只驗證它沒有崩潰、沒有未知運算碼）
  c.setPortIn(0, 0xCC);
  for (var i = 0; i < 5000; i++) c.runCycles(1);
  assert.strictEqual(c.unknownOps(), 0);
});

// ───── 2. 全部運算碼都有實作（不可能在執行時遇到未知運算碼）─────
t('256 個運算碼全部有實作（沒有未知運算碼）', function () {
  for (var op = 0; op < 256; op++) {
    if (op === 0xEF || op === 0xFF) continue;            // SLEEP／STOP 會停住，另外測
    var c = coreAt(0x0400, [op, 0x10, 0x20, 0x30, 0x40, 0x50], { a: 1, x: 2, y: 3 });
    c.runCycles(1);
    assert.strictEqual(c.unknownOps(), 0, '運算碼 ' + op.toString(16) + ' 沒有實作');
  }
});

// ───── 3. 算術與旗標 ─────
t('ADC：0x7F + 1 得 0x80，V=1、N=1、C=0', function () {
  var c = coreAt(0x0400, [0x88, 0x01], { a: 0x7F });    // ADC A,#$01
  c.runCycles(1);
  var s = c.cpu();
  assert.strictEqual(s.a, 0x80);
  assert.strictEqual((s.psw >> 6) & 1, 1, 'V');
  assert.strictEqual((s.psw >> 7) & 1, 1, 'N');
  assert.strictEqual(s.psw & 1, 0, 'C');
});
t('SBC：SETC 後 5 − 3 得 2，C 保持 1（沒有借位）', function () {
  var c = coreAt(0x0400, [0x80, 0xA8, 0x03], { a: 5 });  // SETC; SBC A,#$03
  c.runCycles(1); c.runCycles(1);
  var s = c.cpu();
  assert.strictEqual(s.a, 2);
  assert.strictEqual(s.psw & 1, 1);
});
t('CMP：0x10 比 0x20 小，C=0、N=1', function () {
  var c = coreAt(0x0400, [0x68, 0x20], { a: 0x10 });    // CMP A,#$20
  c.runCycles(1);
  var s = c.cpu();
  assert.strictEqual(s.psw & 1, 0);
  assert.strictEqual((s.psw >> 7) & 1, 1);
  assert.strictEqual(s.a, 0x10, 'CMP 不寫回 A');
});
t('MUL：Y×A（$10×$10 ＝ $0100）得 YA，A=0、Y=1', function () {
  var c = coreAt(0x0400, [0xCF], { a: 0x10, y: 0x10 });
  c.runCycles(1);
  assert.strictEqual(c.cpu().a, 0x00);
  assert.strictEqual(c.cpu().y, 0x01);
});
t('DIV：YA÷X（$0010÷$03）得商 5、餘數 1', function () {
  var c = coreAt(0x0400, [0x9E], { a: 0x10, y: 0x00, x: 0x03 });
  c.runCycles(1);
  assert.strictEqual(c.cpu().a, 5);
  assert.strictEqual(c.cpu().y, 1);
});
t('ADDW：YA＝$01FF 加上 dp 的 $0001 得 $0200', function () {
  var c = coreAt(0x0400, [0x60, 0x7A, 0x10], { a: 0xFF, y: 0x01 });   // CLRC; ADDW YA,$10
  c.poke(0x0010, [0x01, 0x00]);
  c.runCycles(1); c.runCycles(1);
  assert.strictEqual(c.cpu().a, 0x00);
  assert.strictEqual(c.cpu().y, 0x02);
});
t('DAA：$19 加 1 得 $1A，十進位調整後為 $20', function () {
  var c = coreAt(0x0400, [0x60, 0x88, 0x01, 0xDF], { a: 0x19 });   // CLRC; ADC A,#1; DAA
  c.runCycles(1); c.runCycles(1); c.runCycles(1);
  assert.strictEqual(c.cpu().a, 0x20);
});
t('XCN：交換高低半位元組（$AB 得 $BA）', function () {
  var c = coreAt(0x0400, [0x9F], { a: 0xAB });
  c.runCycles(1);
  assert.strictEqual(c.cpu().a, 0xBA);
});
t('MOV A,#imm 與 MOV dp,A 寫入直接頁，並讀回', function () {
  var c = coreAt(0x0400, [0xE8, 0x5A, 0xC4, 0x30], {});
  c.runCycles(1); c.runCycles(1);
  assert.strictEqual(c.peek(0x0030), 0x5A);
});

// ───── 4. 堆疊、呼叫與分支 ─────
t('CALL 與 RET：呼叫子程式後回到正確位置', function () {
  // $0400: CALL $0410 ; MOV A,#$77 ; (停在這裡) ... $0410: MOV A,#$33 ; RET
  var code = new Array(0x20).fill(0);
  code[0] = 0x3F; code[1] = 0x10; code[2] = 0x04;        // CALL $0410
  code[3] = 0xE8; code[4] = 0x77;                         // MOV A,#$77
  code[0x10] = 0xE8; code[0x11] = 0x33; code[0x12] = 0x6F;  // MOV A,#$33; RET
  var c = coreAt(0x0400, [], {});
  c.poke(0x0400, code);
  c.runCycles(1); c.runCycles(1); c.runCycles(1);        // CALL、MOV A,#$33、RET
  assert.strictEqual(c.cpu().a, 0x33);
  assert.strictEqual(c.cpu().pc, 0x0403);
  c.runCycles(1);
  assert.strictEqual(c.cpu().a, 0x77);
});
t('BNE：Z=0 時分支成立，成立時多 2 週期', function () {
  var c = coreAt(0x0400, [0xD0, 0x02, 0x00, 0x00, 0xE8, 0x42], { psw: 0x00 });   // BNE +2 跳過兩個 NOP
  var cyc = c.runCycles(1);
  assert.strictEqual(cyc, 2 + 2, 'BNE 成立：基本 2＋成立 2');
  assert.strictEqual(c.cpu().pc, 0x0406);
});
t('CBNE：A 不等於 dp 時分支', function () {
  var c = coreAt(0x0400, [0x2E, 0x20, 0x02, 0x00, 0x00, 0xE8, 0x11], { a: 0x05 });
  c.poke(0x0020, 0x09);
  c.runCycles(1);
  assert.strictEqual(c.cpu().pc, 0x0405);
});
t('DBNZ Y：Y 減到 0 時不分支', function () {
  var c = coreAt(0x0400, [0xFE, 0x02, 0x00, 0x00, 0xE8, 0x11], { y: 1 });
  c.runCycles(1);
  assert.strictEqual(c.cpu().y, 0);
  assert.strictEqual(c.cpu().pc, 0x0402);
});

// ───── 5. 計時器與通訊埠 ─────
t('計時器 T0：除數 1 時每 8 kHz 加一，讀取後清除', function () {
  var c = coreAt(0x0400, [0x8F, 0x01, 0xFA, 0x8F, 0x01, 0xF1, 0x00, 0x00, 0x00, 0x00], {});
  c.runCycles(1); c.runCycles(1);                        // 設定除數、啟用 T0（之後 CPU 再跑 NOP）
  var before = c.cpu();
  assert.strictEqual(before.pc, 0x0406);
  c.runCycles(128 * 5);                                  // 約 5 個 8 kHz 週期
  var ticks = c.timerCount(0);
  assert.ok(ticks >= 4 && ticks <= 5, '計時器計數 ' + ticks);
  c.dspWrite(0x00, 0);                                   // 不影響計時器，只確認 DSP 寫入不崩
  c.runCycles(128 * 20);
  assert.ok(c.timerCount(0) <= 15);
});
t('計時器讀 $FD 會回傳計數並清零', function () {
  var c = coreAt(0x0400, [0x8F, 0x01, 0xFA, 0x8F, 0x01, 0xF1, 0xE4, 0xFD], {});  // ...; MOV A,$FD
  c.runCycles(1); c.runCycles(1);
  c.runCycles(128 * 3);
  c.runCycles(1);                                        // MOV A,$FD（讀取）
  assert.ok(c.cpu().a >= 2 && c.cpu().a <= 4, '讀到 ' + c.cpu().a);
  assert.strictEqual(c.timerCount(0), 0, '讀取後應清零');
});
t('通訊埠：SPC 寫 $F4 送到輸出；主 CPU 送來的值由 SPC 讀 $F5', function () {
  var c = coreAt(0x0400, [0x8F, 0x55, 0xF4, 0xE4, 0xF5], {});   // MOV $F4,#$55; MOV A,$F5
  c.setPortIn(1, 0x77);
  c.runCycles(1); c.runCycles(1);
  assert.strictEqual(c.portOut(0), 0x55);
  assert.strictEqual(c.cpu().a, 0x77);
});

// ───── 6. S-DSP：BRR 取樣、頻率、包絡、結束旗標 ─────
t('DSP：BRR 正弦（16 取樣一週期）、音高 $1000 ＝ 2000 Hz', function () {
  var c = CORE.createCore({});
  setupSine(c, 0x1000, 2, SINE16);
  c.dspWrite(0x4C, 0x01);                                // KON 聲道 0
  var N = 32000, buf = renderMono(c, N).L;
  var cx = crossings(buf);
  assert.ok(Math.abs(cx - 2000) <= 20, '每秒過零 ' + cx + '，應約為 2000');
  var peak = 0; for (var i = 0; i < N; i++) peak = Math.max(peak, Math.abs(buf[i]));
  assert.ok(peak > 0.5, '峰值 ' + peak.toFixed(3));
});
t('DSP：音高 $2000 ＝ 4000 Hz（頻率與音高成正比）', function () {
  var c = CORE.createCore({});
  setupSine(c, 0x2000, 2, SINE16);
  c.dspWrite(0x4C, 0x01);
  var buf = renderMono(c, 32000).L;
  var cx = crossings(buf);
  assert.ok(Math.abs(cx - 4000) <= 40, '每秒過零 ' + cx + '，應約為 4000');
});
t('DSP：GAIN 線性增加（每取樣 +32）的包絡斜率', function () {
  var c = CORE.createCore({});
  setupSine(c, 0x1000, 2, SINE16);
  c.dspWrite(0x07, 0xDF);                                // GAIN：線性增加（模式 2），速率 31 ＝ 每取樣一次
  c.dspWrite(0x4C, 0x01);
  renderMono(c, 10);
  assert.strictEqual(c.dspRead(0x08), 20, 'ENVX 應為 (32×10)>>4 ＝ 20，實際 ' + c.dspRead(0x08));
  renderMono(c, 10);
  assert.strictEqual(c.dspRead(0x08), 40, '再 10 取樣後應為 40，實際 ' + c.dspRead(0x08));
});
t('DSP：ADSR 攻擊 AR＝15 兩個取樣內到達最大（ENVX＝127）', function () {
  var c = CORE.createCore({});
  setupSine(c, 0x1000, 2, SINE16);
  c.dspWrite(0x05, 0x8F);                                // ADSR 開啟，AR＝15
  c.dspWrite(0x06, 0xFF);
  c.dspWrite(0x4C, 0x01);
  renderMono(c, 2);
  assert.strictEqual(c.dspRead(0x08), 127);
});
t('DSP：BRR 結束且不循環時釋放並歸零，ENDX 位元被設定', function () {
  var c = CORE.createCore({});
  setupSine(c, 0x1000, 1, SINE16);                       // flags 1：結束、不循環
  c.dspWrite(0x4C, 0x01);
  var buf = renderMono(c, 2000).L;
  var tail = 0; for (var i = 1900; i < 2000; i++) tail = Math.max(tail, Math.abs(buf[i]));
  assert.strictEqual(tail, 0, '釋放後應靜音，尾端峰值 ' + tail);
  assert.strictEqual(c.dspRead(0x7C) & 1, 1, 'ENDX 聲道 0 應被設定');
});
t('DSP：KOFF 後包絡釋放並靜音（不是立刻切斷）', function () {
  var c = CORE.createCore({});
  setupSine(c, 0x1000, 2, SINE16);
  c.dspWrite(0x4C, 0x01);
  renderMono(c, 100);
  c.dspWrite(0x5C, 0x01);
  var buf = renderMono(c, 400).L;
  var late = 0; for (var i = 300; i < 400; i++) late = Math.max(late, Math.abs(buf[i]));
  assert.strictEqual(late, 0, 'KOFF 後約 300 取樣內應靜音');
});

// ───── 7. 噪音、音高調變、回音 ─────
t('DSP：噪音（NON）的輸出不是 16 取樣的週期（與音高無關）', function () {
  var c = CORE.createCore({});
  setupSine(c, 0x1000, 2, SINE16);
  c.dspWrite(0x3D, 0x01);                                // 聲道 0 改用噪音
  c.dspWrite(0x6C, 0x20 | 0x10);                         // 噪音速率 16
  c.dspWrite(0x4C, 0x01);
  var buf = renderMono(c, 4000).L, diff = 0, n = 0;
  for (var i = 16; i < 3000; i++) { diff += Math.abs(buf[i] - buf[i - 16]); n++; }
  assert.ok(diff / n > 0.01, '噪音應該不週期，平均差 ' + (diff / n).toFixed(4));
});
t('DSP：音高調變（PMON）改變第二聲道的頻率', function () {
  function run(pmon) {
    var c = CORE.createCore({});
    setupSine(c, 0x1000, 2, SINE16);
    c.dspWrite(0x00, 0x7F); c.dspWrite(0x01, 0x7F);
    // 聲道 1 使用同一個樣本，音高相同
    c.dspWrite(0x10 + 0x02, 0x00); c.dspWrite(0x10 + 0x03, 0x10);
    c.dspWrite(0x10 + 0x04, 0x00); c.dspWrite(0x10 + 0x05, 0x00); c.dspWrite(0x10 + 0x07, 0x7F);
    c.dspWrite(0x10 + 0x00, 0x7F); c.dspWrite(0x10 + 0x01, 0x7F);
    c.dspWrite(0x2D, pmon);
    c.dspWrite(0x4C, 0x03);
    var L = renderMono(c, 32000).L;
    return crossings(L);
  }
  var base = run(0x00), mod = run(0x02);
  assert.notStrictEqual(base, mod, '調變前後過零數相同（' + base + '）');
});
t('DSP：回音啟用時把聲音寫入回音緩衝區（ESA 區段有非零資料）', function () {
  var c = CORE.createCore({});
  setupSine(c, 0x1000, 2, SINE16);
  c.dspWrite(0x6D, 0x40);                                // ESA ＝ $4000
  c.dspWrite(0x7D, 0x01);                                // EDL ＝ 1（2048 位元組）
  c.dspWrite(0x4D, 0x01);                                // EON：聲道 0 進入回音
  c.dspWrite(0x2C, 0x7F); c.dspWrite(0x3C, 0x7F);
  c.dspWrite(0x0D, 0x40);                                // 回授 0x40
  c.dspWrite(0x4C, 0x01);
  renderMono(c, 2000);
  var nz = 0; for (var i = 0x4000; i < 0x4000 + 2048; i++) if (c.peek(i)) nz++;
  assert.ok(nz > 100, '回音緩衝區非零位元組 ' + nz);
});

// ───── 8. 快照與還原 ─────
t('快照與還原：從中途還原後，再渲染的結果逐位元一致', function () {
  var c = CORE.createCore({});
  setupSine(c, 0x1100, 2, SINE16);
  c.dspWrite(0x4D, 0x01); c.dspWrite(0x6D, 0x50); c.dspWrite(0x7D, 0x02); c.dspWrite(0x2C, 0x40); c.dspWrite(0x3C, 0x40); c.dspWrite(0x0D, 0x20);
  c.dspWrite(0x4C, 0x01);
  renderMono(c, 3000);
  var snap = c.snapshot();
  var a = renderMono(c, 3000).L;
  c.restore(snap);
  var b = renderMono(c, 3000).L;
  var same = true; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
  assert.ok(same, '還原後渲染應與原本逐位元相同');
});

// ───── 9. 由 .spc 檔載入 ─────
t('由 .spc 檔載入：程式寫 $F4＝$5A 並停在迴圈，DSP 暫存器被還原', function () {
  var ram = new Uint8Array(65536);
  // $0400: MOV $F4,#$5A ; BRA $FE（停在這裡）
  ram.set([0x8F, 0x5A, 0xF4, 0x2F, 0xFE], 0x0400);
  var dsp = new Uint8Array(128); dsp[0x0C] = 0x7F; dsp[0x1C] = 0x7F; dsp[0x6C] = 0x20;
  var bytes = SFC.packSpc({ ram: ram, dsp: dsp, pc: 0x0400, a: 1, x: 2, y: 3, psw: 0, sp: 0x01EF, title: 'T', game: 'G', artist: 'A', lengthSec: 42 });
  var spc = SFC.parseSpc(bytes);
  assert.ok(spc.ok);
  var c = CORE.fromSpc(spc);
  assert.strictEqual(c.dspRead(0x0C), 0x7F);
  for (var i = 0; i < 50; i++) c.runCycles(1);
  assert.strictEqual(c.portOut(0), 0x5A);
  assert.strictEqual(c.cpu().x, 2);
});
t('由 .spc 檔載入：ENVX 或 KON 位元的聲道會重新起音', function () {
  var ram = new Uint8Array(65536);
  ram.set([0x2F, 0xFE], 0x0400);
  var dsp = new Uint8Array(128);
  dsp[0x6C] = 0x20; dsp[0x5D] = 0x02;
  dsp[0x00] = 0x7F; dsp[0x01] = 0x7F; dsp[0x02] = 0x00; dsp[0x03] = 0x10;
  dsp[0x07] = 0x7F;
  dsp[0x4C] = 0x01;                                      // 檔案的 KON：聲道 0
  ram.set([0x00, 0x03, 0x00, 0x03], 0x0200);
  ram.set(brrBlock(SINE16, 2), 0x0300);
  var spc = SFC.parseSpc(SFC.packSpc({ ram: ram, dsp: dsp, pc: 0x0400 }));
  var c = CORE.fromSpc(spc);
  renderMono(c, 1000);
  assert.ok(c.dspRead(0x08) > 0, 'ENVX 應 > 0（聲道已起音）');
});

function runAll() {
  var fail = 0;
  tests.forEach(function (x) {
    try { x.fn(); console.log('ok   - ' + x.name); }
    catch (e) { fail++; console.log('FAIL - ' + x.name + '\n       ' + (e && e.message || e)); }
  });
  console.log(tests.length - fail + ' / ' + tests.length + ' 通過');
  if (fail) process.exitCode = 1;
}
runAll();
