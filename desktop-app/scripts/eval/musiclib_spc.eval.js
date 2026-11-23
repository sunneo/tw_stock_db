// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄），開始時佇列與對話狀態必須是空的。
//  2. 一次只跑一個評測；新評測開始前，先確認上一個 Electron 都已結束。
//  3. 評測結束前取消佇列與擷取工作，並確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 不需要 GPU、網路、模型。遊戲檔有版權：只把樣本複製到 scratchpad 的測試資料夾，不進 repo。
//  5. 每個 Electron 實際執行最多兩次。
//
// SPC（SNES 音效檔）晶片播放真桌面版評測（ml-spcdsp 分支；尚未由工作者執行，交給管理者跑）。
// 樣本：scratchpad 的 sfctest/out 底下擷取出的 .spc（唯讀，只讀取）。
// 驗證：
//  - 晶片播放器有 spc 後端（FaChipPlayer）與 mp3 編碼（window.fa._encodeMp3）。
//  - 每個 .spc 都能渲染 60 秒（晶片播放器 mp3 按鈕的預設一分鐘），輸出音量與靜音比例逐個回報。
//  - 每個 .spc 都能 toMidi，回報音符數。
//  - 每個 .spc 的 mp3（160 kbps，60 秒）非空、可解碼、解碼長度約 60 秒、解碼後音量回報。
// 回傳值是一個 JSON 物件，管理者讀 checks 與 perFile 即可判定。
const ROOT = 'E:/Temp/claude/1845096e089295dd/e49cfb73-b239-407d-a0c7-0036bc8d60d4/scratchpad/sfctest';
const out = { steps: [], checks: [], perFile: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function decodeInfo(u8) {
  const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    const ch = buf.getChannelData(0); let q = 0; for (let i = 0; i < ch.length; i++) q += ch[i] * ch[i];
    return { duration: buf.duration, rms: Math.sqrt(q / Math.max(1, ch.length)) };
  } finally { try { ctx.close(); } catch (_) { /* */ } }
}
function measure(pcm, sr) {
  let sum = 0, quiet = 0; const n = pcm.length;
  for (let i = 0; i < n; i++) { const v = pcm[i]; sum += v * v; if (Math.abs(v) < 1e-4) quiet++; }
  return { rms: Math.sqrt(sum / Math.max(1, n)), silentRatio: quiet / Math.max(1, n), seconds: n / sr };
}

try {
  check('晶片播放器有 spc 後端', typeof FaChipPlayer !== 'undefined' && (() => { try { FaChipPlayer.getBackend('spc'); return true; } catch (_) { return false; } })(), '');
  check('mp3 編碼與 MIDI 函式存在', !!(window.fa && window.fa._encodeMp3) && typeof FaMidi !== 'undefined', '');
  if (!out.checks.every((c) => c.ok)) throw new Error('前置條件不符，停止');

  const entries = await FaMusicLibHost.walkFolder(ROOT + '/out');
  const spcs = entries.filter((e) => /\.spc$/i.test(e.path || e.name || ''));
  check('找到 8 個擷取出的 .spc', spcs.length === 8, String(spcs.length));

  for (const e of spcs) {
    const p = e.path;
    const r = await a.rawfs.readFile(p, 'base64'); const u = b64ToBytes(r.base64);
    const row = { name: (e.name || p).slice(-40), bytes: u.length };
    try {
      const player = FaChipPlayer.createPlayer('spc', u, { sampleRate: 44100 });
      const pcm = player.render(player.currentTrack(), 0, 60);
      const m = measure(pcm, 44100);
      row.rms = +m.rms.toFixed(4); row.silentRatio = +m.silentRatio.toFixed(3); row.renderSec = +m.seconds.toFixed(2);
      const song = player.toMidi(player.currentTrack());
      row.midiNotes = song.tracks.reduce((n, tr) => n + tr.notes.length, 0);
      const view = { numberOfChannels: 1, sampleRate: 44100, length: pcm.length, duration: pcm.length / 44100, getChannelData: () => pcm };
      const blob = await window.fa._encodeMp3(view, 160);
      const mp3 = new Uint8Array(await blob.arrayBuffer());
      row.mp3Bytes = mp3.length;
      const info = await decodeInfo(mp3);
      row.mp3Sec = +info.duration.toFixed(2); row.mp3Rms = +info.rms.toFixed(4);
      row.ok = mp3.length > 0 && Math.abs(info.duration - 60) < 0.5 && info.rms > 0.001;
    } catch (err) { row.ok = false; row.error = String((err && err.message) || err); }
    out.perFile.push(row);
  }
  check('每個 .spc 都能渲染、MIDI、mp3 並可解碼（60 秒）', out.perFile.length === 8 && out.perFile.every((r) => r.ok), out.perFile.map((r) => (r.ok ? 'ok' : 'FAIL:' + (r.error || 'rms')) + ' mp3=' + r.mp3Bytes + 'B').join(' | '));
  check('至少一個 .spc 的解碼音量不是靜音', out.perFile.some((r) => r.mp3Rms > 0.001), '');
} catch (e) {
  out.error = String((e && e.stack) || e);
}
out.passed = out.checks.filter((c) => c.ok).length;
out.total = out.checks.length;
return out;
