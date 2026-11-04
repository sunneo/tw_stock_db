#!/usr/bin/env node
// 共識閘門：把「已經定案的共識」寫成機器可查的條款（必須出現／禁止出現），對目標檔逐條檢查。
// 用法：node consensus_check.js <共識檔.json> [--root 資料夾] [--target 檔案] [--json]
// 結束碼：0 全部通過；1 有違反；2 共識檔或參數錯誤。
//
// 共識檔格式（JSON）：
// {
//   "name": "說明名稱",
//   "scope": ["要檢查的檔案（相對於 --root）"],
//   "must":   [條款, ...],   // 每條都必須在目標檔出現至少一次
//   "forbid": [條款, ...],   // 每條都不可出現（allow 遮掉的片段不算）
//   "allow":  [條款, ...]    // 例外：這些片段先從每一行遮掉，再檢查 forbid（例如 CDN 網址、註明禁止的句子）
// }
// 條款寫法：字串 → 字面比對（英文不分大小寫）；{"re":"正規表達式","flags":"i"} → 正規表達式（flags 預設 "i"）。
// 限制：只逐行比對，跨行的片語不會命中。
'use strict';
const fs = require('fs');
const path = require('path');

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 條款轉成 RegExp（全域旗標，逐行使用）。
function toRegExp(item) {
  if (typeof item === 'string') {
    if (!item) throw new Error('空字串條款');
    return { label: item, re: new RegExp(escapeRe(item), 'gi') };
  }
  if (item && typeof item === 'object' && typeof item.re === 'string') {
    const flags = (typeof item.flags === 'string' ? item.flags.replace(/[gy]/g, '') : 'i') + 'g';
    let re;
    try { re = new RegExp(item.re, flags); } catch (e) { throw new Error('正規表達式錯誤：' + item.re + '（' + e.message + '）'); }
    return { label: '/' + item.re + '/' + flags.replace('g', ''), re };
  }
  throw new Error('條款格式錯誤：' + JSON.stringify(item));
}

function validateConsensus(c) {
  if (!c || typeof c !== 'object') throw new Error('共識檔必須是 JSON 物件');
  for (const k of ['must', 'forbid', 'allow']) {
    if (c[k] !== undefined && !Array.isArray(c[k])) throw new Error(k + ' 必須是陣列');
  }
  if (!Array.isArray(c.must || []) || !(c.must || []).length && !(c.forbid || []).length) {
    throw new Error('共識檔至少要有一條 must 或 forbid');
  }
  return c;
}

// 逐行找出所有命中，回傳 { line, text }。allow 片段先遮掉（換成等長空白）。
function findHits(lines, re, allowRes) {
  const hits = [];
  lines.forEach((ln, i) => {
    let masked = ln;
    for (const a of allowRes) {
      masked = masked.replace(new RegExp(a.re.source, a.re.flags.replace('g', '') + 'g'), (m) => ' '.repeat(m.length));
    }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) {
      hits.push({ line: i + 1, text: m[0] });
      if (m[0].length === 0) re.lastIndex++;
    }
  });
  return hits;
}

// 主函式：c 是共識物件，text 是目標檔內容。回傳 { results:[...], violations:n }。
function checkConsensus(consensusIn, text) {
  const c = validateConsensus(consensusIn);
  const lines = String(text).split(/\r?\n/);
  const allowRes = (c.allow || []).map(toRegExp);
  const results = [];
  for (const item of c.must || []) {
    const r = toRegExp(item);
    const hits = findHits(lines, r.re, []);
    results.push({ kind: 'must', label: r.label, ok: hits.length > 0, lines: hits.map((h) => h.line), sample: hits.length ? hits[0].text : '' });
  }
  for (const item of c.forbid || []) {
    const r = toRegExp(item);
    const hits = findHits(lines, r.re, allowRes);
    results.push({ kind: 'forbid', label: r.label, ok: hits.length === 0, lines: [...new Set(hits.map((h) => h.line))], sample: hits.length ? hits[0].text : '' });
  }
  return { results, violations: results.filter((r) => !r.ok).length };
}

function formatResult(r) {
  const head = r.ok ? '[通過]' : '[違反]';
  const kind = r.kind === 'must' ? '必須出現' : '禁止出現';
  let tail;
  if (r.kind === 'must') tail = r.ok ? '（第 ' + r.lines.join(', ') + ' 行）' : '（全文找不到）';
  else tail = r.ok ? '' : '（第 ' + r.lines.join(', ') + ' 行，命中：' + r.sample + '）';
  return head + ' ' + kind + '：' + r.label + tail;
}

function runFile(consensusPath, opts) {
  const root = opts.root || process.cwd();
  let c;
  try { c = JSON.parse(fs.readFileSync(consensusPath, 'utf8')); } catch (e) { throw new Error('讀不到或解析失敗的共識檔：' + consensusPath + '（' + e.message + '）'); }
  validateConsensus(c);
  const targets = opts.target ? [opts.target] : (c.scope || []);
  if (!targets.length) throw new Error('沒有要檢查的檔案（共識檔 scope 為空，且沒有 --target）');
  const out = [];
  for (const t of targets) {
    const full = path.resolve(root, t);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch (e) { throw new Error('讀不到目標檔：' + full); }
    const res = checkConsensus(c, text);
    out.push({ target: t, results: res.results, violations: res.violations });
  }
  return { name: c.name || '', files: out, violations: out.reduce((s, f) => s + f.violations, 0) };
}

module.exports = { checkConsensus, validateConsensus, runFile, formatResult, toRegExp };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = { json: false, root: null, target: null };
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opt.json = true;
    else if (a === '--root') opt.root = args[++i];
    else if (a === '--target') opt.target = args[++i];
    else pos.push(a);
  }
  if (!pos.length) { console.error('用法：node consensus_check.js <共識檔.json> [--root 資料夾] [--target 檔案] [--json]'); process.exit(2); }
  let rep;
  try { rep = runFile(path.resolve(pos[0]), opt); } catch (e) { console.error(e.message); process.exit(2); }
  if (opt.json) { console.log(JSON.stringify(rep, null, 2)); }
  else {
    console.log('共識閘門：' + (rep.name || pos[0]));
    for (const f of rep.files) {
      console.log('== ' + f.target);
      for (const r of f.results) console.log(formatResult(r));
      console.log(f.violations ? '違反 ' + f.violations + ' 條' : '全部通過');
    }
  }
  process.exit(rep.violations ? 1 : 0);
}
