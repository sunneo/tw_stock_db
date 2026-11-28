'use strict';
// 「小型語言模型（全參數訓練）」的共用工作檔（llm_full）：兩條後端（cudaweb、cpu-py）讀同一份。
//   · 詞元：位元組級（UTF-8 位元組 0–255）＋ BOS=256、EOS=257；cfg.V 至少要 258。
//   · 資料列：每行一筆 {"messages":[{role,content}…]} 或 {"text":"…"}，攤平成文字後切成長度 T+1 的不重疊窗口；尾端不足以 EOS 補齊。
//   · 損失遮罩：目前每個位置都計損失（與 JS 的全參數步一致）。只計助理回答的遮罩尚未實作（見 PLAN，列為缺項）。
// 純函式（不碰檔案系統；寫檔由呼叫端做）。檢查點與初始權重格式與 full_param_train.js／checkpoint_core.js 相同（fa-f32、fa-ckpt）。
const BOS = 256, EOS = 257;

function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
  return Array.from(Buffer.from(str, 'utf8'));
}

// 一筆原始資料 → 攤平文字
function flattenRow(obj) {
  if (obj && Array.isArray(obj.messages)) return obj.messages.map((m) => String(m.role || 'user') + ': ' + String(m.content == null ? '' : m.content) + '\n').join('');
  if (obj && typeof obj.text === 'string') return obj.text;
  return null;
}

// 整段 jsonl 文字 → 詞元列（窗口長 T+1）。回傳 { rows, skipped, lines }；skipped＝無法解析或沒有 messages／text 的行數。
function rowsFromJsonl(jsonlText, T, V) {
  if (V < 258) throw new Error('llm_full：cfg.V 至少要 258（256 個位元組＋BOS／EOS）');
  const rows = []; let skipped = 0, lines = 0;
  String(jsonlText || '').split(/\r?\n/).forEach((ln) => {
    if (!ln.trim()) return;
    lines++;
    let obj = null; try { obj = JSON.parse(ln); } catch (e) { obj = null; }
    const txt = flattenRow(obj);
    if (txt == null || !txt.length) { skipped++; return; }
    const ids = [BOS].concat(utf8Bytes(txt), [EOS]);
    for (let i = 0; i < ids.length; i += T + 1) {
      const w = ids.slice(i, i + T + 1);
      while (w.length < T + 1) w.push(EOS);
      rows.push(w);
    }
  });
  return { rows, skipped, lines };
}

// 工作檔的 job.json 內容（不含檔案路徑以外的細節；路徑由 writeJob 填）
function makeJob(o) {
  const cfg = Object.assign({ V: 258, d: 32, L: 2, H: 4, kvH: 2, F: 64, T: 12, qkNorm: true }, o.cfg || {});
  if (cfg.qkNorm !== true) throw new Error('llm_full：目前只支援 qk-norm（與 llm_scratch 的密集區塊一致）');
  return {
    cfg, lr: Number(o.lr) || 0.001, wd: o.wd == null ? 0.01 : Number(o.wd), clip: o.clip == null ? 1.0 : Number(o.clip),
    steps: Number(o.steps) || 1, dtype: o.dtype === 'float64' ? 'float64' : 'float32', seed: o.seed == null ? 1 : o.seed,
  };
}

// 資料列的指紋（續訓相容欄位 data_sha256）：對 rows JSON 字串做 sha256（呼叫端注入雜湊函式）
function dataSha256(rows, sha256Fn) { return sha256Fn(JSON.stringify(rows)); }

module.exports = { BOS, EOS, utf8Bytes, flattenRow, rowsFromJsonl, makeJob, dataSha256 };
