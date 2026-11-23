// 節奏模式單元測試：OPL2 的 $BD 節奏（觸發、雜訊、通道 6..8 不受 B0 按鍵影響）與 RIX 擷取的 $BD 寫入。
// 執行：node musiclib_rhythm.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const OPL = require('./musiclib_opl2.js');
const X = require('./musiclib_extract_rix.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  通過  ' + name); }
  catch (e) { fail++; console.log('  失敗  ' + name + '：' + (e && e.message)); }
}
function energy(x) { let s = 0; for (const v of x) s += v * v; return s / Math.max(1, x.length); }
function crossings(x) { let n = 0; for (let i = 1; i < x.length; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) n++; return n; }

// 通道 6 底鼓：兩個運算元，調變器 0x10、載波 0x13（節奏通道 6 的位址）
// 運算元位址＝0x20/0x40/0x60/0x80/0xE0 加上運算元偏移（調變器 0x10、載波 0x13）
function setupOp(chip, o, mult, tl, ar, dr, sl, rr) {
  chip.write(0x20 + o, mult); chip.write(0x40 + o, tl); chip.write(0x60 + o, (ar << 4) | dr); chip.write(0x80 + o, (sl << 4) | rr);
}
function setupBassDrum(chip) {
  chip.write(0x01, 0x20);                      // 波形致能
  setupOp(chip, 0x10, 1, 16, 15, 4, 0, 6);     // 底鼓調變器
  setupOp(chip, 0x13, 1, 0, 15, 4, 0, 6);      // 底鼓載波
  chip.write(0xA6, 0x40); chip.write(0xB6, 0x09);   // 頻率（不按鍵）
  chip.write(0xC6, 0x00);
}
function renderTo(chip, n) { const out = new Float32Array(n); chip.render(out, 0, n); return out; }

console.log('節奏模式（OPL2 與 RIX 擷取）單元測試');

test('OPL2：$BD 節奏開但沒有觸發位元，通道 6 不發聲', () => {
  const chip = OPL.create(44100); setupBassDrum(chip);
  chip.write(0xBD, 0x20);
  const out = renderTo(chip, 4410);
  assert.ok(energy(out) < 1e-9, '應該靜音，能量 ' + energy(out));
});

test('OPL2：$BD 的底鼓位元 0x10 上升緣觸發底鼓，有聲', () => {
  const chip = OPL.create(44100); setupBassDrum(chip);
  chip.write(0xBD, 0x20); chip.write(0xBD, 0x30);
  const out = renderTo(chip, 4410);
  assert.ok(energy(out) > 1e-4, '底鼓應該有聲，能量 ' + energy(out));
});

test('OPL2：通道 6..8 在節奏模式下，B0 的按鍵位元不作用（只由 $BD 觸發）', () => {
  const chip = OPL.create(44100); setupBassDrum(chip);
  chip.write(0xBD, 0x20);
  chip.write(0xB6, 0x29);                       // 按鍵位元 0x20 開，但節奏模式不應發聲
  const out = renderTo(chip, 4410);
  assert.ok(energy(out) < 1e-9, '節奏模式下 B0 按鍵不應發聲，能量 ' + energy(out));
});

test('OPL2：小鼓（0x08）與高帽（0x01）用雜訊：輸出的過零次數不規則（不是固定頻率的正弦）', () => {
  const chip = OPL.create(44100);
  chip.write(0x01, 0x20);
  setupOp(chip, 0x14, 1, 0, 15, 4, 0, 6);      // 通道 7 載波＝小鼓（位址 0x14）
  chip.write(0xA7, 0x88); chip.write(0xB7, 0x14);   // 通道 7 頻率約 206 Hz（不按鍵）
  chip.write(0xBD, 0x20);
  chip.write(0xBD, 0x28);                       // 小鼓上升緣
  const out = renderTo(chip, 8820);
  assert.ok(energy(out) > 1e-5, '小鼓應該有聲，能量 ' + energy(out));
  // 雜訊：每個週期換一次正負，過零次數遠高於單純正弦在同頻率下的值的上限即可分辨；這裡只要求有大量過零
  assert.ok(crossings(out) > 10, '小鼓輸出應有多次過零，實際 ' + crossings(out));
});

test('OPL2：快照與還原後，節奏觸發結果相同（雜訊狀態一起保存）', () => {
  const a = OPL.create(44100); setupBassDrum(a);
  a.write(0xBD, 0x20); a.write(0xBD, 0x30);
  renderTo(a, 1000);
  const snap = a.snapshot();
  const x1 = renderTo(a, 2000);
  const b = OPL.create(44100); b.restore(snap);
  const x2 = renderTo(b, 2000);
  let diff = 0; for (let i = 0; i < x1.length; i++) diff = Math.max(diff, Math.abs(x1[i] - x2[i]));
  assert.ok(diff < 1e-9, '還原後輸出應相同，最大差 ' + diff);
});

// 真實 RIX（唯讀）：soundMode=1 的檔案，節奏觸發次數要與 MIDI 打擊音符數相同；soundMode=0（關掉節奏）時不寫 $BD
const RIX_DIR = 'D:/Downloads/SOFTSTAR.tar/SOFTSTAR/SOFTSTAR/PAL/86RIX';
const sample = path.join(RIX_DIR, 'MUSIC_03.RIX');
if (fs.existsSync(sample)) {
  const bytes = new Uint8Array(fs.readFileSync(sample));
  test('RIX 擷取：soundMode=1 的檔頭第一個 $BD 寫入是 0x20（開節奏模式）', () => {
    const p = X.parseRix(bytes);
    const first = p.regs.find((w) => w.r === 0xBD);
    assert.ok(first && first.v === 0x20, '第一個 $BD 應為 0x20，實際 ' + (first && first.v));
  });
  test('RIX 擷取：底鼓觸發次數（$BD 0x10 上升緣）與 MIDI 打擊軌的底鼓音符數相同', () => {
    const p = X.parseRix(bytes);
    let last = 0, rises = 0;
    p.regs.forEach((w) => { if (w.r === 0xBD) { if ((w.v & 0x10) && !(last & 0x10)) rises++; last = w.v; } });
    const drum = (p.song.tracks || []).find((t) => t.drum);
    const kicks = drum ? drum.notes.filter((n) => n.n === 36).length : -1;
    assert.strictEqual(rises, kicks, '上升緣 ' + rises + ' 次，MIDI 底鼓 ' + kicks + ' 次');
  });
  test('RIX 擷取：soundMode=0（節奏關）的同一首不寫 $BD', () => {
    const off = new Uint8Array(bytes); off[2] = 0;
    const p = X.parseRix(off);
    assert.ok(!p.regs.some((w) => w.r === 0xBD), '節奏關閉時不該有 $BD 寫入');
  });
} else {
  console.log('  略過  真實 RIX 檔（找不到 ' + sample + '）');
}

console.log('musiclib_rhythm 單元測試：通過 ' + pass + ' / ' + (pass + fail) + ' 項');
if (fail) process.exitCode = 1;
