// 評測守則（使用者要求，2026-11-22；適用所有 scripts/eval/musiclib*.eval.js）：
//  1. 每次評測都用全新的 --user-data-dir（空目錄）。  2. 一次只跑一個評測。  3. 結束前確認沒有殘留行程（只停自己啟動的 PID）。
//  4. 不需要 GPU、網路、模型。  5. 每個 Electron 實際執行最多兩次。
// 使用者的原話：輸入 /media-midi 沒給參數時，要看得到剛產生的 MIDI（它在對話裡只是一個下載連結）。使用者不該需要知道「卡片」「附件」的差別。
//  - 交付一個檔名重複副檔名的 MIDI（X.mid.mid）：檔名收成 X.mid。
//  - 指令的「對話中的檔案」清單（FaFileSource.collect）看得到這個下載連結的檔案；對話裡不會多出多餘的訊息（只有一則下載訊息）。
//  - 清單項目能解析成檔案庫裡的檔案（檔案庫讀得到、位元組和交付的一致）。
//  - 不是 MIDI 副檔名的產生檔案（例如 .txt）不會出現在 MIDI 指令的清單。
const out = { checks: [] };
const check = (name, ok, detail) => { out.checks.push({ name: name, ok: !!ok, detail: detail || '' }); };
try {
  const fa = window.fa;
  check('app 與必要模組存在', !!fa && typeof FaMidi !== 'undefined' && typeof FaFileSource !== 'undefined' && typeof fa.generateAndDeliverFile === 'function' && typeof fa._fileSourceResolve === 'function', '');
  if (!out.checks.every((c) => c.ok)) throw new Error('前置條件不符，停止');
  let s = FaMidi.emptySong(); s = FaMidi.addTrack(s, '旋律', 0, false);
  for (let i = 0; i < 8; i++) s = FaMidi.addNote(s, 0, { t: i * s.ppq / 2, d: s.ppq / 2, n: 60 + i, v: 90 });
  const bytes = FaMidi.write(s);
  const before = fa.messages.length;
  const r = await fa.generateAndDeliverFile(new Blob([bytes], { type: 'audio/midi' }), 'EVAL_SONG.mid.mid', 'audio/midi');
  check('檔名 X.mid.mid 收成 X.mid', r && r.filename === 'EVAL_SONG.mid', String(r && r.filename));
  const added = fa.messages.slice(before);
  check('對話裡只多一則下載訊息（沒有多餘的卡片）', added.length === 1 && /已產生檔案：EVAL_SONG\.mid（/.test(String(added[0].content || '')), added.map((m) => String(m.content || '').slice(0, 40)).join(' | '));
  const items = FaFileSource.collect(fa.messages, { midi: true, attachRe: /\.midi?$/i });
  check('/media-midi 的「對話中的檔案」清單有這個產生的檔案', items.some((x) => /EVAL_SONG/.test(x.label)), items.map((x) => x.label).join(' | '));
  const hit = items.find((x) => /EVAL_SONG/.test(x.label));
  const res = hit ? fa._fileSourceResolve(hit.item) : null;
  check('清單項目解析成檔案庫的檔案', !!res && res.kind === 'file' && !!res.fileId, JSON.stringify(res));
  let back = null;
  try { const rec = await fa.fileCache.get(res.fileId); const blob = rec && (rec.blob || rec); back = new Uint8Array(await blob.arrayBuffer()); } catch (e) { back = null; out.getErr = String(e && e.message || e); }
  check('檔案庫讀回的位元組與交付的一致', !!back && back.length === bytes.length && back.every((v, i) => v === bytes[i]), back ? String(back.length) + ' 位元組' : String(out.getErr || '讀不到'));
  await fa.generateAndDeliverFile(new Blob(['hello'], { type: 'text/plain' }), 'note.txt', 'text/plain');
  const items2 = FaFileSource.collect(fa.messages, { midi: true, attachRe: /\.midi?$/i });
  check('非 MIDI 副檔名的產生檔案不會出現在 MIDI 指令清單', !items2.some((x) => /note\.txt/.test(x.label)), items2.map((x) => x.label).join(' | '));
  const items3 = FaFileSource.collect(fa.messages, { attachRe: /./ });
  check('其他指令（任何檔案）的清單看得到 note.txt', items3.some((x) => /note\.txt/.test(x.label)), items3.map((x) => x.label).join(' | '));
} catch (e) {
  out.error = String((e && e.stack) || e);
}
out.passed = out.checks.filter((c) => c.ok).length;
out.total = out.checks.length;
return out;
