// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄），開始時佇列與對話狀態必須是空的。
//  2. 一次只跑一個評測；新評測開始前，先確認上一個 Electron 都已結束。
//  3. 評測結束前取消佇列與擷取工作，並確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 不需要 GPU、網路、模型。遊戲檔有版權：只把樣本複製到 scratchpad 的測試資料夾，不進 repo。
//  5. 每個 Electron 實際執行最多兩次。
// SFC（超任）擷取真桌面版評測：scratchpad 的 sfctest/lib 放 3 個真實 SFC ROM（唯讀複製）。
// 驗證：.nes 辨識為 nes、擷取結果逐個回報（nsf／midi／none 三種，none 必須附原因）、
// 至少一個產生子曲目；子曲目登記 derivedFrom；磁碟上檔案存在且大於 0；MIDI 可解析；音訊可解碼；第二次擷取全部沿用。
const ROOT = 'E:/Temp/claude/1845096e089295dd/e49cfb73-b239-407d-a0c7-0036bc8d60d4/scratchpad/sfctest';
const out = { steps: [], checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function decodeDuration(u8) {
  const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC();
  try { const buf = await ctx.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)); const ch = buf.getChannelData(0), n = Math.min(ch.length, buf.sampleRate * 20); let q = 0; for (let i = 0; i < n; i++) q += ch[i] * ch[i]; window.__lastRms = Math.sqrt(q / Math.max(1, n)); return buf.duration; }
  finally { try { ctx.close(); } catch (_) { /* */ } }
}
try {
  check('模組與宿主存在', typeof FaMusicLibHost !== 'undefined' && !!FaMusicLibHost.extract && typeof FaMusicLibSfc !== 'undefined' && typeof FaMusicLibSnesCpu !== 'undefined' && typeof FaMidi !== 'undefined', '');
  if (!out.checks.every((c) => c.ok)) throw new Error('前置條件不符，停止');
  const L = FaMusicLibHost.getLib(); await L.ready;
  const entries = await FaMusicLibHost.walkFolder(ROOT + '/lib');
  const readHead = (p, n) => a.rawfs.readHead(p, n).then((r) => (r && r.base64 != null ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : null));
  const sid = L.addSource('folder', 'sfcrom'); await L.scan(sid, entries, readHead); await L.save();
  const srcs = L.records.filter((r) => !r.derivedFrom);
  out.kinds = srcs.map((r) => r.name + ':' + r.kind);
  check('掃描到 3 個 SFC 並辨識種類', srcs.length === 3 && srcs.every((r) => r.kind === 'sfc'), out.kinds.join(', '));

  const t0 = Date.now();
  const r1 = await FaMusicLibHost.extract.run(srcs, { userRoot: ROOT + '/out', onEvent: () => {} });
  out.elapsedMs = Date.now() - t0;
  out.run1 = r1.results.map((x) => ({ name: x.name, status: x.status, reason: x.reason, stage: x.stage, method: x.method, children: x.children && x.children.length, ms: x.elapsedMs }));
  check('每個 ROM 都有明確結果（完成，或失敗且附原因）', r1.results.length === 3 && r1.results.every((x) => x.status === 'done' || (x.reason && String(x.reason).length > 3)), JSON.stringify(out.run1).slice(0, 700));
  const kids = L.records.filter((r) => r.derivedFrom);
  out.kids = kids.map((r) => ({ name: r.name, kind: r.kind, dur: r.durationSec, from: r.derivedFrom, method: r.derivedMethod }));
  check('至少一個 ROM 擷取出有聲音的子曲目，且標明來源', kids.length >= 1 && kids.every((k) => srcs.some((s) => s.key === k.derivedFrom)), String(kids.length));

  let allOk = true, detail = [];
  for (const k of kids) {
    const r = await a.rawfs.readFile(k.path, 'base64'); const u = b64ToBytes(r.base64);
    let good = u.length > 0, note = '';
    if (k.kind === 'mid') { const n = FaMidi.noteCount(FaMidi.parse(u)); good = good && n > 0; note = n + '音'; }
    else if (k.kind === 'wav' || k.kind === 'mp3') { let d = -1; try { d = await decodeDuration(u); } catch (e) { d = -1; } good = good && d > 1; note = d.toFixed(1) + 's/rms' + (window.__lastRms || 0).toFixed(4); (out.audRms = out.audRms || []).push({ name: k.name, rms: window.__lastRms || 0 }); }
    if (!good) allOk = false; detail.push(k.name + ':' + k.kind + ':' + u.length + 'B/' + note);
  }
  check('磁碟上子曲目檔案：存在、非空、可解析／可解碼', kids.length > 0 && allOk, detail.join(' | '));

  check('每個擷取出的 mp3 前 20 秒都有聲音（均方根大於 0.005）；靜音的不應被登記成子曲目', (out.audRms || []).length > 0 && out.audRms.every((x) => x.rms > 0.005), JSON.stringify((out.audRms || []).map((x) => x.name.slice(-22) + ':' + x.rms.toFixed(4))));
  const r2 = await FaMusicLibHost.extract.run(srcs, { userRoot: ROOT + '/out' });
  const doneBefore = r1.summary.done;
  check('第二次擷取：成功的來源全部沿用（不重做）', r2.summary.skipped === doneBefore && r2.summary.done === 0, JSON.stringify(r2.summary) + ' 第一次成功 ' + doneBefore);
} catch (e) {
  out.error = String((e && e.stack) || e);
}
try { FaMusicLibHost.extract && FaMusicLibHost.extract.cancel(); FaMusicLibHost.cancelTranscribe(); } catch (_) { /* */ }
out.passed = out.checks.filter((c) => c.ok).length;
out.total = out.checks.length;
return out;
