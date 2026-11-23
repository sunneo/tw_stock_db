// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄），開始時佇列與對話狀態必須是空的。
//  2. 一次只跑一個評測；新評測開始前，先確認上一個 Electron 都已結束。
//  3. 評測結束前取消佇列與旋律索引工作，並確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 這個評測不需要 GPU、不需要網路、不需要模型：哼歌用程式合成的正弦波音訊，曲庫用程式產生的 mid 與 wav。
//  5. 每個 Electron 實際執行最多兩次。
// 哼歌找歌真桌面版評測：曲庫有 3 首不同旋律的 mid（A、B、C）加 1 個旋律 A 的 wav（走單音音高追蹤的「簡易轉譜」），
// 建旋律索引後，用「旋律 A 升 5 個半音、速度快 1.25 倍、錯 2 個音、加一點顫音」的合成哼歌去找，要找到 A；
// 用無關旋律 D 去找，不能把 A、B、C 當高分命中；另檢查面板有「哼歌找歌」區塊。
const ROOT = 'E:/Temp/claude/1845096e089295dd/e49cfb73-b239-407d-a0c7-0036bc8d60d4/scratchpad/humtest';
const out = { steps: [], checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
const a = window.desktopAPI;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function bytesToB64(u8) { let s = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }

// 旋律：[半音編號, 拍數]，每拍 0.5 秒（120 bpm）
const MEL_A = [[60,1],[62,1],[64,1],[60,1],[64,1],[67,2],[65,1],[64,1],[62,1],[60,2],[62,1],[64,1],[67,1],[69,2],[67,1],[64,1],[62,1],[60,1],[59,1],[60,1],[62,1],[64,1],[62,1],[60,2]];
const MEL_B = [[60,1],[60,1],[67,1],[67,1],[69,1],[69,1],[67,2],[65,1],[65,1],[64,1],[64,1],[62,1],[62,1],[60,2],[67,1],[67,1],[65,1],[65,1],[64,1],[64,1],[62,2],[67,1],[67,1],[65,1],[65,1],[64,1],[64,1],[62,2]];
const MEL_C = [[60,2],[72,1],[55,1],[66,2],[48,1],[70,1],[61,2],[75,1],[52,1],[68,2],[58,1],[73,1],[50,2],[64,1],[71,1],[57,2],[74,1],[53,1],[62,2],[69,1],[49,1],[67,2],[76,1],[56,1]];
const MEL_D = [[65,1],[65,1],[72,2],[71,1],[69,1],[67,1],[65,2],[64,1],[62,1],[64,1],[65,1],[69,2],[67,1],[65,1],[64,1],[62,2],[60,1],[62,1],[64,1],[65,2],[67,1],[69,1],[71,2],[72,2]];

function midiBytes(mel) {
  const notes = []; let t = 0;
  mel.forEach((m) => { notes.push({ t: t * 480, d: Math.round(m[1] * 480 * 0.9), n: m[0], v: 90 }); t += m[1]; });
  const song = { ppq: 480, tempos: [{ t: 0, bpm: 120 }], timesig: { n: 4, d: 4 }, title: 'hum', tracks: [{ name: 'm', channel: 0, program: 0, drum: false, volume: 100, pan: 64, notes: notes }] };
  return FaMidi.write(song);
}
// 把旋律合成成單聲道 16 位元 wav：shift 半音、speed 倍速、wrong＝{索引: 偏移半音}、vib＝顫音深度（半音）
function synthWav(mel, shift, speed, wrong, vib) {
  const sr = 16000; let total = 0; mel.forEach((m) => { total += m[1] * 0.5 / speed; });
  const n = Math.ceil((total + 0.3) * sr), x = new Float32Array(n); let tcur = 0.1;
  mel.forEach((m, i) => {
    const midi = m[0] + shift + ((wrong && wrong[i]) || 0), f0 = 440 * Math.pow(2, (midi - 69) / 12), dur = m[1] * 0.5 / speed * 0.92;
    const s0 = Math.floor(tcur * sr), len = Math.floor(dur * sr); let ph = 0;
    for (let k = 0; k < len; k++) {
      const tt = k / sr, f = f0 * Math.pow(2, ((vib || 0) * Math.sin(2 * Math.PI * 5 * tt)) / 12);
      ph += 2 * Math.PI * f / sr; const env = Math.min(1, k / 300, (len - k) / 300);
      x[s0 + k] += 0.4 * env * Math.sin(ph);
    }
    tcur += m[1] * 0.5 / speed;
  });
  const data = new Uint8Array(44 + n * 2), dv = new DataView(data.buffer), w = (o, s) => { for (let i = 0; i < s.length; i++) data[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
  return data;
}

try {
  check('旋律模組與主機存在', typeof FaMusicLibMelody !== 'undefined' && typeof FaMusicLibHost !== 'undefined' && !!FaMusicLibHost.melody, '');
  if (!out.checks.every((c) => c.ok)) throw new Error('前置條件不符，停止');
  const H = FaMusicLibHost.melody;
  const L = FaMusicLibHost.getLib(); await L.ready;
  out.beforeCount = L.records.length;

  // 1. 寫曲庫檔案
  const files = { 'song_a.mid': midiBytes(MEL_A), 'song_b.mid': midiBytes(MEL_B), 'song_c.mid': midiBytes(MEL_C), 'song_a_audio.wav': synthWav(MEL_A, 0, 1, null, 0) };
  for (const k of Object.keys(files)) await a.rawfs.writeFile(ROOT + '/lib/' + k, { base64: bytesToB64(files[k]) });
  out.steps.push('曲庫檔案已寫入：' + Object.keys(files).join('、'));

  // 2. 掃描（同其他評測：直接走訪）
  const entries = await FaMusicLibHost.walkFolder(ROOT + '/lib');
  const readHead = (p, n) => a.rawfs.readHead(p, n).then((r) => (r && r.base64 != null ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : null));
  const sid = L.addSource('folder', 'humlib'); await L.scan(sid, entries, readHead); await L.save();
  check('掃描到 4 首', L.records.length - out.beforeCount === 4, String(L.records.length - out.beforeCount));

  // 3. 建旋律索引
  const events = []; await H.buildIndex((ev) => events.push(ev && (ev.stage || ev.status || ev.type)));
  const ents = H.entries();
  out.entries = ents.map((e) => ({ name: e.name, method: e.method, n: e.contour && (e.contour.intervals ? e.contour.intervals.length : null) }));
  check('旋律索引：4 首都建好', ents.length === 4, JSON.stringify(out.entries));
  const wavEnt = ents.find((e) => /audio\.wav/.test(e.name));
  check('wav 走簡易轉譜並標明', !!wavEnt && /簡易轉譜/.test(wavEnt.method), wavEnt && wavEnt.method);

  // 4. 哼歌：旋律 A，升 5 半音、快 1.25 倍、錯 2 個音（第 6、14 個音偏 1 半音）、顫音 0.15 半音
  const humA = synthWav(MEL_A, 5, 1.25, { 5: 1, 13: -1 }, 0.15);
  const hnA = await H.notesFromHum(new Blob([humA], { type: 'audio/wav' })); const notesA = hnA.notes; out.humAMethod = hnA.method;
  out.humANotes = notesA.length;
  const rA = await H.search(notesA, { limit: 10 });
  out.rA = (rA.results || []).map((r) => ({ name: r.name, score: Math.round(r.score * 1000) / 1000, at: r.startSec }));
  check('哼歌 A：有結果且第一名是旋律 A（mid 或 wav）', rA.ok && rA.results.length > 0 && /song_a/.test(rA.results[0].name), JSON.stringify(out.rA));
  const best = (rA.results || []).find((r) => /song_a/.test(r.name)), other = (rA.results || []).filter((r) => /song_[bc]\.mid/.test(r.name)).map((r) => r.score);
  check('哼歌 A：A 的分數高於 B、C', !!best && other.every((s) => best.score > s), JSON.stringify(out.rA));

  // 5. 無關旋律 D：不能把 A、B、C 當高分命中（門檻由程式預設）
  const humD = synthWav(MEL_D, 0, 1, null, 0.1);
  const notesD = (await H.notesFromHum(new Blob([humD], { type: 'audio/wav' }))).notes;
  const rD = await H.search(notesD, { limit: 10 });
  out.rD = (rD.results || []).map((r) => ({ name: r.name, score: Math.round(r.score * 1000) / 1000 }));
  check('無關旋律 D：沒有高分命中（沒結果或分數低於 A 的命中）', !rD.ok || rD.results.length === 0 || !best || rD.results.every((r) => r.score < best.score), JSON.stringify(out.rD) + ' 對照 A 命中 ' + (best ? best.score : null));

  check('試聽函式存在（playClip）', typeof H.playClip === 'function', typeof H.playClip);
  // 6. 面板有「哼歌找歌」
  window.fa._mlOpen(); await sleep(1200);
  const panels = document.querySelectorAll('.fml'), p = panels[panels.length - 1];
  // 哼歌找歌是主畫面的區塊：工具列的「🎤 哼歌找歌」展開（已展開就不動），再確認區塊存在；旋律索引在「⚙ 設定」的「旋律索引」分頁
  const hb = p && p.querySelector('.fml-hum');
  if (p && hb && hb.style.display === 'none') Array.from(p.querySelectorAll('button')).find((b) => b.textContent === '🎤 哼歌找歌').click();
  check('面板有哼歌找歌區塊（主畫面）', !!p && !!hb && /哼歌/.test(p.textContent), p ? p.textContent.slice(0, 80) : '無面板');
  // 7. 找不到時演奏：humAsMidi 不丟例外（會開 MIDI 編輯器卡片）
  // humAsMidi 現在回傳 { node }（MIDI 播放卡片，畫面把它插在按鈕下面）；舊版是塞一則編輯器訊息到對話最下面
  let playErr = null, playRes = null; try { playRes = await H.humAsMidi(notesD, '評測哼歌'); } catch (e) { playErr = String(e && e.message || e); }
  check('找不到時：把哼歌旋律用 MIDI 演奏，回傳播放卡片節點、不出錯', playErr === null && !!(playRes && playRes.node && playRes.node.nodeType === 1), playErr || (playRes && playRes.node ? '' : '沒有回傳節點'));
} catch (e) {
  out.error = String((e && e.stack) || e);
}
try { FaMusicLibHost.melody && FaMusicLibHost.melody.cancelIndex(); FaMusicLibHost.cancelTranscribe(); } catch (_) { /* */ }
out.passed = out.checks.filter((c) => c.ok).length;
out.total = out.checks.length;
return out;
