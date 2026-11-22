// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄），開始時佇列與對話狀態必須是空的；不沿用上次評測留下的狀態。
//  2. 一次只跑一個評測；新評測開始前，先確認上一個 Electron 與輸出工作都已結束或已取消。
//  3. 評測結束前呼叫 FaMusicLibHost.cancelExport() 與 cancelTranscribe()，並確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 這個評測不需要 GPU。mp3 編碼要載入 lamejs（既有 _ensureLamejsLoaded，從 cdn.jsdelivr.net 取約幾十 KB 的 UMD 腳本）；
//     若這台機器沒有快取，評測會發出這一次下載，所以跑之前要先由使用者同意。mp4 路線不在本評測內，明講未驗證。
//  5. 每個 Electron 實際執行最多兩次；失敗就回報原因，不靠重跑蓋掉。
// 批次輸出（mid／mp3）真桌面版評測：用程式合成 75 秒的 wav 與 150 秒的 mid，放在 scratchpad 的 musicexp 資料夾，
// 實際走 FaMusicLibHost.exportBatch，然後用獨立的原生解碼（decodeAudioData）與 FaMidi.parse 讀回磁碟檢查。
// 項目：wav→mp3 截 1 分、wav→mp3 整首、mid→mp3 截 1 分、mid→mid 截 1 分、txt 不支援、取消後剩下的標示取消。
// 不驗證：mp4 抽音軌（ffmpeg.wasm 同意流程）、音訊轉 MIDI（未實作）。
const ROOT = 'E:/Temp/claude/1845096e089295dd/9a7c10bd-971c-4190-8bc3-a58c49076b0b/scratchpad/musicexp';
const OUT = ROOT + '/out';
const out = { steps: [], checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const a = window.desktopAPI;

function bytesToB64(u8) { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function decodeDuration(u8) {
  const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC();
  try { const buf = await ctx.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)); return buf.duration; }
  finally { try { ctx.close(); } catch (_) { /* */ } }
}
// 合成 wav：單聲道 16 位元，22050 Hz，每秒一個音（正弦波，振幅 0.3）
function makeWav(seconds) {
  const sr = 22050, n = sr * seconds, data = new Uint8Array(44 + n * 2), dv = new DataView(data.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) data[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const v = Math.sin(2 * Math.PI * (220 + 40 * Math.floor(i / sr)) * i / sr) * 0.3; dv.setInt16(44 + i * 2, Math.round(v * 32767), true); }
  return data;
}
// 合成 mid：每半秒一個音，共 300 個音（150 秒）
function makeMidiSong() {
  const notes = []; for (let i = 0; i < 300; i++) notes.push({ t: i * 480, d: 400, n: 60 + (i % 12), v: 90 });
  return { ppq: 480, tempos: [{ t: 0, bpm: 120 }], timesig: { n: 4, d: 4 }, title: 'eval', tracks: [{ name: 'eval', channel: 0, program: 0, drum: false, volume: 100, pan: 64, notes: notes }] };
}
const rec = (name, path) => ({ key: 'k:' + name, name: name, path: path, status: 'ok', pending: false, sizeBytes: 0 });

try {
  // 0. 通道與模組存在
  check('桌面版通道存在', !!(a && a.rawfs && a.roots && a.rawfs.writeFile));
  check('FaMidi 與 FaMidiPlay 存在', typeof FaMidi !== 'undefined' && typeof FaMidiPlay !== 'undefined');
  check('FaMusicLibHost.exportBatch 存在', typeof FaMusicLibHost !== 'undefined' && typeof FaMusicLibHost.exportBatch === 'function');
  if (!out.checks.every((c) => c.ok)) throw new Error('前置條件不符，停止');

  // 1. 準備來源檔（寫到 scratchpad，不進 repo）
  const wav = makeWav(75), midBytes = FaMidi.write(makeMidiSong());
  await a.rawfs.writeFile(ROOT + '/tone75.wav', { base64: bytesToB64(wav) });
  await a.rawfs.writeFile(ROOT + '/notes150.mid', { base64: bytesToB64(midBytes) });
  await a.rawfs.writeFile(ROOT + '/readme.txt', { base64: bytesToB64(new TextEncoder().encode('不是音樂')) });
  const RW = rec('tone75.wav', ROOT + '/tone75.wav'), RM = rec('notes150.mid', ROOT + '/notes150.mid'), RT = rec('readme.txt', ROOT + '/readme.txt');
  out.steps.push('來源檔寫入：wav ' + wav.length + ' 位元組，mid ' + midBytes.length + ' 位元組');

  // 2. wav → mp3，截 1 分
  const r1 = await FaMusicLibHost.exportBatch([RW, RM, RT], { format: 'mp3', minutes: 1, outDir: OUT });
  out.batch1 = r1.results.map((x) => ({ name: x.name, status: x.status, reason: x.reason, stage: x.stage, out: x.output && x.output.path, verify: x.verify && x.verify.detail, attempts: x.attempts }));
  const b1w = r1.results[0], b1m = r1.results[1], b1t = r1.results[2];
  check('wav→mp3 截 1 分：完成', b1w.status === 'done', b1w.reason);
  if (b1w.status === 'done') {
    const d = await decodeDuration(b64ToBytes((await a.rawfs.readFile(b1w.output.path, 'base64')).base64));
    check('wav→mp3 截 1 分：獨立解碼長度約 60 秒', Math.abs(d - 60) <= 1.0, d.toFixed(2));
  }
  check('mid→mp3 截 1 分：完成', b1m.status === 'done', b1m.reason + ' [' + b1m.stage + ']');
  if (b1m.status === 'done') {
    const d = await decodeDuration(b64ToBytes((await a.rawfs.readFile(b1m.output.path, 'base64')).base64));
    check('mid→mp3 截 1 分：獨立解碼長度約 60 秒', Math.abs(d - 60) <= 1.0, d.toFixed(2));
  }
  check('txt：不支援，不進執行', b1t.status === 'unsupported' && b1t.stage === 'plan', b1t.status + ' ' + b1t.reason);

  // 3. wav → mp3 整首（75 秒）
  const r2 = await FaMusicLibHost.exportBatch([RW], { format: 'mp3', minutes: 'whole', outDir: OUT });
  const b2 = r2.results[0];
  out.batch2 = { status: b2.status, reason: b2.reason, out: b2.output && b2.output.path };
  check('wav→mp3 整首：完成', b2.status === 'done', b2.reason + ' [' + b2.stage + ']');
  if (b2.status === 'done') {
    const d = await decodeDuration(b64ToBytes((await a.rawfs.readFile(b2.output.path, 'base64')).base64));
    check('wav→mp3 整首：長度約 75 秒', Math.abs(d - 75) <= 1.0, d.toFixed(2));
  }

  // 4. mid → mid，截 1 分：音符數要等於截短後的數量（60 秒內開始的音符：0..119 共 120 個）
  const r3 = await FaMusicLibHost.exportBatch([RM], { format: 'mid', minutes: 1, outDir: OUT });
  const b3 = r3.results[0];
  out.batch3 = { status: b3.status, reason: b3.reason, verify: b3.verify && b3.verify.detail };
  check('mid→mid 截 1 分：完成', b3.status === 'done', b3.reason + ' [' + b3.stage + ']');
  if (b3.status === 'done') {
    const song = FaMidi.parse(b64ToBytes((await a.rawfs.readFile(b3.output.path, 'base64')).base64));
    const ns = FaMidi.noteCount(song);
    check('mid→mid 截 1 分：音符數 120', ns === 120, '實際 ' + ns);
  }

  // 5. 取消：第一個檔案進入解碼後按取消，之後的檔案都要標示取消，不可繼續跑
  let cancelled = false;
  const r4 = await FaMusicLibHost.exportBatch([RW, RW], { format: 'mp3', minutes: 1, outDir: OUT,
    onEvent: (ev) => { if (!cancelled && ev.stage === 'decode') { cancelled = true; FaMusicLibHost.cancelExport(); } } });
  out.batch4 = r4.results.map((x) => ({ status: x.status, stage: x.stage }));
  check('取消：兩個都標示取消，沒有完成', r4.results.length === 2 && r4.results.every((x) => x.status === 'cancelled'), JSON.stringify(out.batch4));
} catch (e) {
  out.error = String((e && e.stack) || e);
}
try { FaMusicLibHost.cancelExport(); } catch (_) { /* */ }
try { FaMusicLibHost.cancelTranscribe(); } catch (_) { /* */ }
out.passed = out.checks.filter((c) => c.ok).length;
out.total = out.checks.length;
return out;
