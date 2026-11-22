// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄）。 2. 一次只跑一個評測。 3. 結束前取消工作並確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 不需要 GPU、網路、模型。遊戲檔有版權：只把樣本複製到 scratchpad 的測試資料夾，不進 repo。 5. 每個 Electron 實際執行最多兩次。
// 通用播放、樹狀清單、移除、/media-play、旋律索引 真桌面版評測（使用者 2026-11-23 的需求）：
// playtest/lib 放 1 個真實 RIX、1 個真實 FC ROM；評測內再產生 1 個 mid、1 個 wav。
const ROOT = 'E:/Temp/claude/1845096e089295dd/e49cfb73-b239-407d-a0c7-0036bc8d60d4/scratchpad/playtest';
const out = { checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const a = window.desktopAPI;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
window.confirm = () => true;
function bytesToB64(u8) { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
function midiBytes() {
  const notes = []; [60, 62, 64, 65, 67, 69, 71, 72].forEach((n, i) => notes.push({ t: i * 480, d: 400, n: n, v: 90 }));
  return FaMidi.write({ ppq: 480, tempos: [{ t: 0, bpm: 120 }], timesig: { n: 4, d: 4 }, title: 't', tracks: [{ name: 'm', channel: 0, program: 0, drum: false, volume: 100, pan: 64, notes: notes }] });
}
function wavBytes() {
  const sr = 16000, n = sr * 3, d = new Uint8Array(44 + n * 2), dv = new DataView(d.buffer), w = (o, s) => { for (let i = 0; i < s.length; i++) d[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 12000), true);
  return d;
}
const exists = async (p) => { try { const r = await a.rawfs.readHead(p, 4); return !!(r && r.base64 != null); } catch (_) { return false; } };
const panelEl = () => Array.from(document.querySelectorAll('.fml')).pop();
const rowsOf = (p) => Array.from(p.querySelectorAll('tbody tr'));
try {
  check('模組存在', typeof FaMediaPlay !== 'undefined' && typeof FaMusicLibHost !== 'undefined' && typeof window.fa._mpOpen === 'function', typeof FaMediaPlay + '/' + typeof window.fa._mpOpen);
  if (!out.checks.every((c) => c.ok)) throw new Error('前置條件不符，停止');
  await a.rawfs.writeFile(ROOT + '/lib/a_song.mid', { base64: bytesToB64(midiBytes()) });
  await a.rawfs.writeFile(ROOT + '/lib/b_tone.wav', { base64: bytesToB64(wavBytes()) });
  localStorage.setItem('fa.musiclib.derivedDir', ROOT + '/out');
  const L = FaMusicLibHost.getLib(); await L.ready;
  const entries = await FaMusicLibHost.walkFolder(ROOT + '/lib');
  const readHead = (p, n) => a.rawfs.readHead(p, n).then((r) => (r && r.base64 != null ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : null));
  const sid = L.addSource('folder', 'playlib'); await L.scan(sid, entries, readHead); await L.save();
  const srcs = L.records.filter((r) => !r.derivedFrom);
  check('掃到 4 個來源檔（mid、wav、rix、nes）', srcs.length === 4, srcs.map((r) => r.name + ':' + r.kind).join(', '));
  const ext = srcs.filter((r) => r.kind === 'rix' || r.kind === 'nes');
  const rr = await FaMusicLibHost.extract.run(ext, { userRoot: ROOT + '/out' });
  check('RIX 與 NES 擷取完成', rr.summary.done === 2, JSON.stringify(rr.summary));
  const kids = L.records.filter((r) => r.derivedFrom);
  check('有擷取產物（樹狀的子列）', kids.length >= 4, String(kids.length));

  window.fa._mlOpen(); await sleep(1800);
  let p = panelEl();
  check('面板開得起來', !!p, p ? '' : '無面板');
  // 展開全部
  p.querySelectorAll('button.tg').forEach((b) => { if (b.textContent.trim() === '▸') b.click(); }); await sleep(400);
  let rows = rowsOf(p);
  const withPlay = rows.filter((tr) => Array.from(tr.querySelectorAll('button')).some((b) => /▶ 播放/.test(b.textContent)));
  out.rowCount = rows.length;
  check('每一列（來源與擷取產物）都有「▶ 播放」', rows.length >= 8 && withPlay.length === rows.length, withPlay.length + '/' + rows.length);
  check('子列標明「擷取產物（不是檔案系統上的檔案）」', /擷取產物（不是檔案系統上的檔案）/.test(p.textContent), '');
  check('介面沒有列出「支援哪些格式」', !/支援.{0,12}(mid|mp3|wav|rix)/i.test(p.textContent), '');

  // 逐種點播放
  const clickPlay = async (pred, label) => {
    p = panelEl(); const tr = rowsOf(p).find(pred);
    if (!tr) { check('播放：' + label, false, '找不到那一列'); return; }
    const before = p.querySelectorAll('audio,video,canvas,input[type=range]').length, snap0 = p.innerHTML.length + '|' + p.querySelectorAll('button').length;
    Array.from(tr.querySelectorAll('button')).find((b) => /▶ 播放/.test(b.textContent)).click();
    await sleep(3000);
    p = panelEl();
    const warn = (p.textContent.match(/⚠️[^\n]{0,100}/) || [''])[0];
    const after = p.querySelectorAll('audio,video,canvas,input[type=range]').length;
    const snap1 = p.innerHTML.length + '|' + p.querySelectorAll('button').length; check('播放：' + label, !warn && (after > before || snap0 !== snap1 || after > 0), (warn || '') + ' 控制項 ' + before + '→' + after + ' 面板 ' + snap0 + '→' + snap1);
    try { document.querySelectorAll('audio,video').forEach((x) => x.pause()); } catch (_) { /* */ }
  };
  const nameHas = (re, notKid) => (tr) => re.test(tr.textContent) && (!notKid || !/擷取產物（不是/.test(tr.textContent));
  await clickPlay(nameHas(/a_song\.mid/, true), 'mid（原始檔）');
  await clickPlay(nameHas(/b_tone\.wav/, true), 'wav（原始檔）');
  await clickPlay(nameHas(/MUSIC_01\.RIX/i, true), 'RIX（來源）');
  await clickPlay((tr) => /\.mp3/.test(tr.textContent) && /擷取產物（不是/.test(tr.textContent), '擷取產物 mp3');
  await clickPlay((tr) => /\.mid/.test(tr.textContent) && /擷取產物（不是/.test(tr.textContent), '擷取產物 mid');

  // /media-play
  const before = document.querySelectorAll('.language-fa-mediaplay, [data-fa-mediaplay]').length;
  window.fa._mpOpen('"' + ROOT + '/lib/b_tone.wav" "' + ROOT + '/lib/MUSIC_01.RIX" "' + ROOT + '/lib/a_song.mid"'); await sleep(3500);
  const msgs = (document.body.innerText.match(/🎵 播放：/g) || []).length;
  check('/media-play 三個檔案掛出三則播放訊息', msgs >= 3, String(msgs));
  const warnMp = (document.body.innerText.match(/⚠️[^\n]{0,100}/g) || []).filter((t) => /播放|卡片|無法/.test(t));
  check('/media-play 沒有錯誤訊息', warnMp.length === 0, warnMp.join(' | '));
  try { document.querySelectorAll('audio,video').forEach((x) => x.pause()); } catch (_) { /* */ }

  // 旋律索引：來源 rix／nes 跳過，不再整批失敗
  const sum = await FaMusicLibHost.melody.buildIndex(() => {});
  out.melodySum = sum;
  const failedRecs = L.records.filter((r) => r.melody && r.melody.status && r.melody.status !== 'ok' && r.melody.status !== 'skipped'); out.melodyFailed = failedRecs.map((r) => r.name + ':' + r.kind + ':' + JSON.stringify(r.melody).slice(0, 160)); check('旋律索引：來源 rix／nes 不再被拿去建索引（只允許一般音訊失敗且附原因）', sum && failedRecs.every((r) => r.kind !== 'rix' && r.kind !== 'nes' && !r.derivedFrom) && (sum.done || 0) >= 2, JSON.stringify(out.melodyFailed));

  // 移除：擷取產物（刪衍生檔）
  window.fa._mlOpen(); await sleep(1500); p = panelEl();
  p.querySelectorAll('button.tg').forEach((b) => { if (b.textContent.trim() === '▸') b.click(); }); await sleep(300);
  const kid = L.records.find((r) => r.derivedFrom && r.kind === 'mp3');
  const kidPath = kid.path, kidKey = kid.key;
  check('移除前衍生 mp3 檔存在', await exists(kidPath), kidPath);
  const trK = rowsOf(p).find((tr) => tr.textContent.indexOf(kid.name) >= 0 && /擷取產物（不是/.test(tr.textContent));
  Array.from(trK.querySelectorAll('button')).find((b) => /^移除$/.test(b.textContent.trim())).click(); for (let i = 0; i < 16 && L.records.some((r) => r.key === kidKey); i++) await sleep(500); out.diagKid = { stillThere: L.records.some((r) => r.key === kidKey), foot: (panelEl().querySelector('.fml-foot') || {}).textContent };
  check('移除擷取產物：記錄消失、衍生檔被刪', !L.records.some((r) => r.key === kidKey) && !(await exists(kidPath)), '');
  // 移除來源（RIX，連同擷取產物）；原始檔不能被刪
  const rixSrc = L.records.find((r) => !r.derivedFrom && r.kind === 'rix'), rixPath = rixSrc.path;
  const rixKids = L.records.filter((r) => r.derivedFrom === rixSrc.key).map((r) => r.path);
  window.fa._mlOpen(); await sleep(1500); p = panelEl();
  const trR = rowsOf(p).find((tr) => tr.textContent.indexOf(rixSrc.name) >= 0 && !/擷取產物（不是/.test(tr.textContent));
  Array.from(trR.querySelectorAll('button')).find((b) => /^移除$/.test(b.textContent.trim())).click(); for (let i = 0; i < 16 && L.records.some((r) => r.key === rixSrc.key); i++) await sleep(500); out.diagSrc = { stillThere: L.records.some((r) => r.key === rixSrc.key), foot: (panelEl().querySelector('.fml-foot') || {}).textContent };
  const kidsGone = []; for (const kp of rixKids) kidsGone.push(!(await exists(kp)));
  check('移除來源：記錄與其擷取產物都消失、衍生檔被刪', !L.records.some((r) => r.key === rixSrc.key) && !L.records.some((r) => r.derivedFrom === rixSrc.key) && kidsGone.every(Boolean), kidsGone.join(','));
  check('原始檔絕對還在磁碟上', await exists(rixPath), rixPath);
  // 重載後資料仍正確
  await L.save();
  check('其餘原始檔都還在', (await exists(ROOT + '/lib/a_song.mid')) && (await exists(ROOT + '/lib/b_tone.wav')), '');
} catch (e) { out.error = String((e && e.stack) || e); }
try { FaMusicLibHost.extract && FaMusicLibHost.extract.cancel(); FaMusicLibHost.melody && FaMusicLibHost.melody.cancelIndex(); document.querySelectorAll('audio,video').forEach((x) => x.pause()); } catch (_) { /* */ }
out.passed = out.checks.filter((c) => c.ok).length; out.total = out.checks.length;
return out;
