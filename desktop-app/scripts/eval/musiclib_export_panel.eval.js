// 評測守則（使用者要求，2026-11-22）：全新 --user-data-dir、一次一個、結束前確認無殘留行程、最多跑兩次。
// 批次輸出經「面板」的真桌面版評測（舊的 musiclib_export 評測直接呼叫 FaMusicLibHost.exportBatch，繞過面板，所以漏掉面板 host 沒接上的毛病）：
// 1. 面板上的「批次輸出」按鈕不是停用、沒有顯示「不可用（需要桌面版）」；
// 2. mp3 → mid：用桌面上的真實 mp3 樣本，走 exportBatch 的 audio>mid 路線，讀回的 mid 要有音符。
// 不需要網路（mp3 編碼的 lamejs 只有輸出 mp3 才用）。
const out = { checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = window.desktopAPI;
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
const SAMPLE = 'C:/Users/sunneo/Desktop/midi音樂/GrandfatherClock.mp3', OUT = 'E:/Temp/exp_panel_out';
try {
  window.fa._mlOpen(); await sleep(2500);
  const panels = document.querySelectorAll('.fml'), p = panels[panels.length - 1];
  check('音樂庫面板存在', !!p);
  const btn = (t) => Array.from(p.querySelectorAll('button')).filter((b) => b.textContent === t)[0];
  const bExp = btn('批次輸出');
  check('面板有「批次輸出」按鈕', !!bExp);
  check('「批次輸出」按鈕可按（沒有被停用）', bExp && !bExp.disabled, bExp ? String(bExp.disabled) : '');
  const sts = Array.from(p.querySelectorAll('.fml-st')).map((x) => x.textContent).join('|');
  check('面板上沒有「批次輸出不可用」', sts.indexOf('批次輸出不可用') < 0, sts.slice(0, 200));
  check('有「＋加入來源」下拉與「對勾選的曲目」', !!btn('＋加入來源 ▾') && !!btn('對勾選的曲目 ▾'));
  check('桌面版通道與 exportBatch 存在', !!(a && a.rawfs) && typeof FaMusicLibHost.exportBatch === 'function');

  const rec = { key: 'k:s4', name: 'GrandfatherClock.mp3', path: SAMPLE, status: 'ok', pending: false, sizeBytes: 0 };
  const r = await FaMusicLibHost.exportBatch([rec], { format: 'mid', minutes: 1, outDir: OUT });
  const b = r.results[0];
  out.result = { status: b.status, reason: b.reason, stage: b.stage, route: b.route, out: b.output && b.output.path, verify: b.verify && b.verify.detail, method: b.output && b.output.method };
  check('mp3→mid：走 audio>mid 路線並完成', b.route === 'audio>mid' && b.status === 'done', JSON.stringify(out.result));
  if (b.status === 'done') {
    const song = FaMidi.parse(b64ToBytes((await a.rawfs.readFile(b.output.path, 'base64')).base64));
    const ns = FaMidi.noteCount(song);
    out.notes = ns;
    check('讀回的 mid 有音符（不是空的）', ns > 5, String(ns));
  }
} catch (e) { out.error = String((e && e.stack) || e); check('評測本身沒出錯', false, out.error); }
try { FaMusicLibHost.cancelExport(); } catch (_) { /* */ }
out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
return out;
