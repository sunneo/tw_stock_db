#!/usr/bin/env node
/* 閱讀理解（第五類 adapter，DESIGN.lora-training.md §27.9）資料產生器。
 *
 * 來源：repo 內既有的設計文件（desktop-app/DESIGN.*.md），每份當一篇文章。
 * 題目：程式從文章的「- **名詞**：說明」條列句生成，答案一律是文中逐字找得到的字串（防幻覺）。
 *   rc_extract       ：文中「X」指的是什麼？        → 答案＝說明原文（逐字）
 *   rc_quote         ：請引用文中一句說明「X」的原文 → 答案＝那一句原文（逐字）
 *   rc_unanswerable  ：文中「Y」指的是什麼？（Y 取自別篇、本篇沒有出現）→ 答案＝「文中沒寫」
 * 長文分塊：文章超過 MAX_CHARS 時只取包含目標句的視窗（視窗內才算「文中」），答案必須落在視窗內才收。
 * 切分：以文件檔名的 sha256 決定 train／heldout（約 25% 的文章進留出集，文章層級切分，不會同一篇兩邊都有）。
 *
 * 誠實說明：這是模板題（程式生成），不是自然語言題；它量的是「依文章作答、逐字引用、沒寫就說沒寫」的做法，
 * 不代表真實的閱讀理解能力。題目與答案都可由程式逐項驗證（verified_by: program_ground_truth）。
 *
 * 輸出：data/reading_train.jsonl、data/reading_heldout.jsonl（不併入 train.jsonl，這一顆獨立訓練）。
 * 用法：node gen/gen_reading.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 來源目錄：預設 desktop-app；FA_READING_SRC 可指定凍結的副本（重現既有訓練檔用）
const ROOT = process.env.FA_READING_SRC || path.join(__dirname, '..', '..');           // desktop-app
const DATA = path.join(__dirname, '..', 'data');
const MAX_CHARS = 1200;
const SYSTEM = '你是閱讀理解助理。只根據使用者給的文章作答，答案必須是文中逐字找得到的文字；文中沒有的，回答「文中沒寫」。';
const NONE = '文中沒寫';

function split(name) {
  const h = crypto.createHash('sha256').update(name).digest();
  return h[0] % 4 === 0 ? 'heldout' : 'train';          // 約 25% 的文章進留出集
}

// 目標句：「- **名詞**：說明」，說明 10～160 字，且不含換行
const LINE = /^- \*\*([^*\n]{2,30})\*\*[:：]\s*(.{10,160})$/gm;

function windowFor(text, lineText) {
  if (text.length <= MAX_CHARS) return text;
  const at = text.indexOf(lineText);
  const start = Math.max(0, Math.min(at - Math.floor(MAX_CHARS / 2), text.length - MAX_CHARS));
  return text.slice(start, start + MAX_CHARS);
}

function main() {
  const files = fs.readdirSync(ROOT).filter((f) => /^DESIGN\..*\.md$/.test(f)).sort();
  const docs = files.map((f) => ({ file: f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
  // 所有文章的名詞（用來取「本篇沒有、別篇有」的未知名詞）
  const allTerms = [];
  for (const d of docs) for (const m of d.text.matchAll(LINE)) allTerms.push({ term: m[1].trim(), file: d.file });
  const out = { train: [], heldout: [] };
  const stats = { docs: docs.length, items: 0, rejected: 0 };
  let seq = 0;
  for (const d of docs) {
    const sp = split(d.file);
    // 孤立代理字元（來源檔損毀）會讓分詞器拒絕：整份文章保留，只把這些字元換成 U+FFFD（文章與答案用同一份文字，驗證仍是逐字）
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
    if (LONE.test(d.text)) { LONE.lastIndex = 0; d.text = d.text.replace(LONE, '\uFFFD'); stats.sanitized_docs = (stats.sanitized_docs || 0) + 1; }
    const items = [...d.text.matchAll(LINE)].map((m) => ({ term: m[1].trim(), expl: m[2].trim(), line: m[0] }));
    for (const it of items) {
      // 驗證：說明與整句都要逐字在文中
      if (!d.text.includes(it.expl) || !d.text.includes(it.line)) { stats.rejected++; continue; }
      const ctx = windowFor(d.text, it.line);
      if (!ctx.includes(it.expl)) { stats.rejected++; continue; }
      const base = { domain: 'reading', split: sp, source_file: 'desktop-app/' + d.file, verified_by: 'program_ground_truth' };
      const mk = (stage, q, completion, extra) => {
        seq++;
        return Object.assign({ id: `reading:${d.file}:${seq}:${stage}`, stage, messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `【文章】\n${ctx}\n\n【問題】${q}` }], completion, meta: { term: it.term, chunked: ctx.length < d.text.length } }, base, extra || {});
      };
      out[sp].push(mk('rc_extract', `文中「${it.term}」指的是什麼？`, it.expl));
      out[sp].push(mk('rc_quote', `請引用文中一句說明「${it.term}」的原文，只輸出那一句。`, it.expl));
      // 無答案：取別篇的名詞，且本文（整份，不是視窗）沒有這個名詞、也沒有它的說明
      const foreign = allTerms.filter((t) => t.file !== d.file && !d.text.includes(t.term));
      if (foreign.length) {
        const pick = foreign[(seq * 7919) % foreign.length];
        out[sp].push(mk('rc_unanswerable', `文中「${pick.term}」指的是什麼？`, NONE, { unanswerable: true }));
      }
      stats.items++;
    }
  }
  fs.mkdirSync(DATA, { recursive: true });
  for (const sp of ['train', 'heldout']) {
    fs.writeFileSync(path.join(DATA, `reading_${sp}.jsonl`), out[sp].map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  const count = (arr) => arr.reduce((m, r) => ((m[r.stage] = (m[r.stage] || 0) + 1), m), {});
  console.log(JSON.stringify({ ...stats, train: out.train.length, heldout: out.heldout.length, train_by_stage: count(out.train), heldout_by_stage: count(out.heldout) }));
}

if (require.main === module) main();
module.exports = { split, windowFor };
