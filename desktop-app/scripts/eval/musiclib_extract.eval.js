// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄），開始時佇列與對話狀態必須是空的。
//  2. 一次只跑一個評測；新評測開始前，先確認上一個 Electron 都已結束。
//  3. 評測結束前取消佇列與擷取工作，並確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 不需要 GPU、網路、模型。遊戲檔有版權：只把樣本複製到 scratchpad 的測試資料夾，不進 repo。
//  5. 每個 Electron 實際執行最多兩次。
// RIX 擷取真桌面版評測：scratchpad 的 rixtest/lib 放 3 個真實 RIX（MUSIC_01..03），掃描後擷取到 rixtest/out（userRoot），
// 驗證：種類辨識為 rix、擷取完成、子曲目登記（derivedFrom）、磁碟上的輸出檔存在且大於 0、MIDI 可解析且有音符、
// 音訊可獨立解碼且長度合理、第二次擷取全部沿用（不重做）、擷取出來的 MIDI 建旋律索引後，用其中一段旋律能找回對應的子曲目
// （證明辨識端完全不需要認識 RIX）。
const ROOT = 'E:/Temp/claude/1845096e089295dd/e49cfb73-b239-407d-a0c7-0036bc8d60d4/scratchpad/rixtest';
const out = { steps: [], checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function decodeDuration(u8) {
  const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC();
  try { const buf = await ctx.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)); return buf.duration; }
  finally { try { ctx.close(); } catch (_) { /* */ } }
}
try {
  check('模組與宿主存在', typeof FaMusicLibHost !== 'undefined' && !!FaMusicLibHost.extract && !!FaMusicLibHost.melody && typeof FaMidi !== 'undefined', '');
  if (!out.checks.every((c) => c.ok)) throw new Error('前置條件不符，停止');
  const L = FaMusicLibHost.getLib(); await L.ready;
  const entries = await FaMusicLibHost.walkFolder(ROOT + '/lib');
  const readHead = (p, n) => a.rawfs.readHead(p, n).then((r) => (r && r.base64 != null ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : null));
  const sid = L.addSource('folder', 'rixlib'); await L.scan(sid, entries, readHead); await L.save();
  const srcs = L.records.filter((r) => !r.derivedFrom);
  out.kinds = srcs.map((r) => r.name + ':' + r.kind);
  check('掃描到 3 個 RIX 並辨識種類', srcs.length === 3 && srcs.every((r) => r.kind === 'rix'), out.kinds.join(', '));

  // 第一次擷取
  const stages = [];
  const r1 = await FaMusicLibHost.extract.run(srcs, { userRoot: ROOT + '/out', onEvent: (ev) => { if (ev && ev.stage && stages.length < 12) stages.push(ev.stage); } });
  out.run1 = r1.results.map((x) => ({ name: x.name, status: x.status, reason: x.reason, stage: x.stage, children: x.children, ms: x.elapsedMs }));
  check('擷取：3 個都完成', r1.summary.done === 3, JSON.stringify(r1.summary) + ' ' + JSON.stringify(out.run1).slice(0, 300));
  const kids = L.records.filter((r) => r.derivedFrom);
  out.kids = kids.map((r) => ({ name: r.name, kind: r.kind, dur: r.durationSec, from: r.derivedFrom, method: r.derivedMethod }));
  check('子曲目已登記（每個來源至少一個，標明來源）', kids.length >= 3 && srcs.every((s) => kids.some((k) => k.derivedFrom === s.key)), String(kids.length));
  const mids = kids.filter((k) => k.kind === 'mid'), auds = kids.filter((k) => k.kind !== 'mid');
  check('有 MIDI 子曲目', mids.length >= 3, mids.length + ' 個，音訊類 ' + auds.length + ' 個');

  // 磁碟檢查
  let allOk = true, detail = [];
  for (const k of mids) {
    const r = await a.rawfs.readFile(k.path, 'base64'); const u = b64ToBytes(r.base64);
    const song = FaMidi.parse(u); const n = FaMidi.noteCount(song);
    if (!(u.length > 0 && n > 0)) allOk = false; detail.push(k.name + ':' + u.length + 'B/' + n + '音');
  }
  check('磁碟上 MIDI：存在、可解析、有音符', allOk, detail.join(' | '));
  let audOk = true, audDetail = [];
  for (const k of auds) {
    const r = await a.rawfs.readFile(k.path, 'base64'); const u = b64ToBytes(r.base64);
    let d = -1; try { d = await decodeDuration(u); } catch (e) { d = -1; }
    if (!(u.length > 0 && d > 1)) audOk = false; audDetail.push(k.name + ':' + u.length + 'B/' + d.toFixed(1) + 's');
  }
  check('磁碟上音訊：存在、可獨立解碼、長度大於 1 秒', auds.length === 0 ? true : audOk, auds.length ? audDetail.join(' | ') : '（本次沒有音訊衍生檔）');

  // 第二次：全部沿用
  const r2 = await FaMusicLibHost.extract.run(srcs, { userRoot: ROOT + '/out' });
  check('第二次擷取：全部沿用上次結果（不重做）', r2.summary.skipped === 3 && r2.summary.done === 0, JSON.stringify(r2.summary));

  // 辨識端不需要認識 RIX：對 MIDI 子曲目建旋律索引，用其中一段旋律找回
  const H = FaMusicLibHost.melody;
  await H.buildIndex(() => {});
  const ents = H.entries();
  check('旋律索引含 RIX 擷取出的 MIDI', mids.every((m) => ents.some((e) => e.key === m.key)), ents.length + ' 筆');
  const target = mids[1], rr = await a.rawfs.readFile(target.path, 'base64');
  const mel = FaMusicLibMelody.melodyFromSong(FaMidi.parse(b64ToBytes(rr.base64)));
  const q = mel.slice(8, 8 + 18);
  const hit = await H.search(q, { limit: 5 });
  out.hit = (hit.results || []).map((x) => ({ name: x.name, score: Math.round(x.score * 1000) / 1000 }));
  check('用擷取出的旋律片段找回該子曲目（第一名）', hit.ok && hit.results.length > 0 && hit.results[0].key === target.key, JSON.stringify(out.hit) + ' 目標 ' + target.name);
} catch (e) {
  out.error = String((e && e.stack) || e);
}
try { FaMusicLibHost.extract && FaMusicLibHost.extract.cancel(); FaMusicLibHost.melody && FaMusicLibHost.melody.cancelIndex(); FaMusicLibHost.cancelTranscribe(); } catch (_) { /* */ }
out.passed = out.checks.filter((c) => c.ok).length;
out.total = out.checks.length;
return out;
