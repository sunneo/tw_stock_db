// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄）。  2. 一次只跑一個評測。  3. 結束前確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 不需要 GPU、網路、模型。  5. 每個 Electron 實際執行最多兩次。
// 產生的 MIDI 檔交付後，斜線指令（/media-midi 等）的「對話中的檔案」清單要看得到它：
//  - 交付一個檔名重複副檔名的 MIDI（X.mid.mid）：檔名收成 X.mid。
//  - 對話裡多一個 MIDI 播放卡片（```fa-midi），FaFileSource.collect(messages, { midi: true }) 找得到這一首。
//  - 讀不懂的 .mid（內容不是 MIDI）只留下載連結、不丟例外。
const out = { checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
try {
  const fa = window.fa;
  check('app 與必要模組存在', !!fa && typeof FaMidi !== 'undefined' && typeof FaFileSource !== 'undefined' && typeof fa.generateAndDeliverFile === 'function', '');
  if (!out.checks.every((c) => c.ok)) throw new Error('前置條件不符，停止');
  // 造一首最小的 MIDI
  let s = FaMidi.emptySong(); s = FaMidi.addTrack(s, '旋律', 0, false);
  for (let i = 0; i < 8; i++) s = FaMidi.addNote(s, 0, { t: i * s.ppq / 2, d: s.ppq / 2, n: 60 + i, v: 90 });
  const bytes = FaMidi.write(s);
  const before = fa.messages.length;
  const r = await fa.generateAndDeliverFile(new Blob([bytes], { type: 'audio/midi' }), 'EVAL_SONG.mid.mid', 'audio/midi');
  check('檔名 X.mid.mid 收成 X.mid', r && r.filename === 'EVAL_SONG.mid', String(r && r.filename));
  const added = fa.messages.slice(before);
  check('交付後多了下載訊息', added.some((m) => /已產生檔案：EVAL_SONG\.mid（/.test(String(m.content || ''))), added.map((m) => String(m.content || '').slice(0, 40)).join(' | '));
  const items = FaFileSource.collect(fa.messages, { midi: true, attachRe: /\.midi?$/i });
  check('/media-midi 的「對話中的檔案」清單有這一首', items.some((x) => /EVAL_SONG/.test(x.label)), items.map((x) => x.label).join(' | '));
  // 內容不是 MIDI：不丟例外，只有下載連結
  let err = null; try { await fa.generateAndDeliverFile(new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/midi' }), 'BAD.mid', 'audio/midi'); } catch (e) { err = String(e && e.message || e); }
  check('讀不懂的 .mid 不丟例外', err === null, err || '');
  const items2 = FaFileSource.collect(fa.messages, { midi: true, attachRe: /\.midi?$/i });
  check('讀不懂的 .mid 不會出現在 MIDI 清單', !items2.some((x) => /BAD/.test(x.label)), items2.map((x) => x.label).join(' | '));
} catch (e) {
  out.error = String((e && e.stack) || e);
}
out.passed = out.checks.filter((c) => c.ok).length;
out.total = out.checks.length;
return out;
