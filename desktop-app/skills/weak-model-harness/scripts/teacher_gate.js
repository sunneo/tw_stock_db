#!/usr/bin/env node
// 老師端程式輔助：派工時記下使用者原話與允許範圍，驗收時用程式核對，不靠老師的文字判斷。
// 子指令：
//   dispatch --task 名稱 --quote "原話" [--quote ...] --consensus 共識檔 --allow 檔案或資料夾/ [--allow ...] [--verify "指令"] [--dir .weak-harness]
//   verify   --task 名稱 --hash 提交 [--report 報告文字檔] [--confirm 對照檔.json] [--root 資料夾] [--dir .weak-harness]
//   observe  --task 名稱 --kind positive_path|branch|reflection --stage 階段 --lesson 教訓 --evidence 來源 [--dir]
// 結束碼：0 可接受；1 不可接受（驗收單列出原因）；2 參數或設定錯誤。
// 驗收單寫到 <dir>/dispatch/<任務>.verdict.md，同時印在畫面上。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const CC = require('./consensus_check.js');

const SKILL_DIR = path.resolve(__dirname, '..');
const EXP_FILE = path.join(SKILL_DIR, 'references', 'path-experiences.json');
// 宣稱詞：報告裡出現這些字，就必須附證據（指令輸出或提交 hash）。
const CLAIM_WORDS = ['沒有出入', '沒有什麼出入', '一致', '已完成', '全過', '全部通過', '都通過', '完全相同', '與先前一致', '無誤', '沒問題', '已驗證'];
const COMPARE_WORDS = ['沒有出入', '沒有什麼出入', '一致', '完全相同', '與先前一致'];

function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off'].concat(args), { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 失敗：' + (r.stderr || '').trim());
  return r.stdout;
}

function safeTask(name) {
  if (typeof name !== 'string' || !/^[\w一-鿿-]{1,60}$/.test(name)) throw new Error('任務名稱只能用字母、數字、中文、底線與連字號（1–60 字）：' + name);
  return name;
}

function dispatchFile(dir, task) { return path.join(dir, 'dispatch', safeTask(task) + '.json'); }

// ---- dispatch：寫派工紀錄 ----
function dispatchTask(o) {
  const spec = {
    task: safeTask(o.task),
    quotes: (o.quotes || []).map(String),
    consensus: o.consensus || null,
    allow: (o.allow || []).map(String),
    verify: (o.verify || []).map(String),
    created: new Date().toISOString(),
  };
  if (!spec.quotes.length) throw new Error('派工至少要有一句使用者原話（--quote）');
  if (!spec.allow.length) throw new Error('派工至少要列出允許修改的檔案（--allow）');
  const file = dispatchFile(o.dir, spec.task);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  return { file, spec };
}

// ---- verify：驗收 ----
function changedFiles(root, hash) {
  const prefix = git(['rev-parse', '--show-prefix'], root).trim();
  const names = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', hash], root).split(/\r?\n/).filter(Boolean);
  return names.map((n) => {
    const p = n.replace(/\\/g, '/');
    if (prefix && p.startsWith(prefix)) return { path: p.slice(prefix.length), outside: false };
    return { path: p, outside: !!prefix };
  });
}

function allowedBy(rel, allow) {
  return allow.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));
}

// 每一句含宣稱詞的句子，必須在同一句內附證據：可解析的提交 hash，或指令輸出（N passed／exit=N／結束碼 N）。
function claimRows(report, root) {
  const sentences = String(report).split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
  const rows = [];
  sentences.forEach((s, i) => {
    const word = CLAIM_WORDS.find((w) => s.includes(w));
    if (!word) return;
    const hashes = (s.match(/\b[0-9a-f]{7,40}\b/g) || []);
    const hashOk = hashes.some((h) => { try { git(['cat-file', '-e', h + '^{commit}'], root); return true; } catch (e) { return false; } });
    const cmdOut = /\d+ passed|exit=\d|結束碼\s*\d/.test(s);
    // 比較型宣稱（一致、沒有出入）：提交 hash 只證明提交存在，不證明內容相同；必須附指令輸出或逐條對照。
    const compare = COMPARE_WORDS.includes(word);
    const proven = compare ? (cmdOut || /已對照/.test(s)) : (hashOk || cmdOut);
    rows.push({ index: i + 1, word, text: s.slice(0, 80), proven, needs: compare ? '比對輸出或逐條對照' : '提交 hash 或指令輸出' });
  });
  return rows;
}

function verifyTask(o) {
  const file = dispatchFile(o.dir, o.task);
  if (!fs.existsSync(file)) throw new Error('找不到派工紀錄：' + file + '（先執行 dispatch）');
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const root = path.resolve(o.root || process.cwd());
  const hash = o.hash;
  if (!hash) throw new Error('verify 需要 --hash');
  git(['cat-file', '-e', hash + '^{commit}'], root);
  const sec = {};

  // 1 檔案範圍
  const files = changedFiles(root, hash);
  const badFiles = files.filter((f) => f.outside || !allowedBy(f.path, spec.allow)).map((f) => f.path);
  sec.files = { ok: badFiles.length === 0, changed: files.map((f) => f.path), bad: badFiles };

  // 2 共識（讀提交內的檔案內容，不是工作目錄）
  if (spec.consensus) {
    const cons = JSON.parse(fs.readFileSync(path.resolve(root, spec.consensus), 'utf8'));
    const prefix = git(['rev-parse', '--show-prefix'], root).trim();
    const items = [];
    for (const sc of cons.scope || []) {
      let text;
      try { text = git(['show', hash + ':' + prefix + sc], root); } catch (e) { items.push({ scope: sc, error: '提交內找不到此檔' }); continue; }
      const res = CC.checkConsensus(cons, text);
      items.push({ scope: sc, results: res.results, violations: res.violations });
    }
    const v = items.reduce((s, it) => s + (it.error ? 1 : it.violations), 0);
    sec.consensus = { ok: v === 0, name: cons.name || spec.consensus, items };
  } else {
    sec.consensus = { ok: true, name: '未設定共識檔', items: [] };
  }

  // 3 驗收指令
  sec.commands = spec.verify.map((cmd) => {
    const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', timeout: 600000 });
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    return { cmd, exit: r.status === null ? -1 : r.status, tail: out.slice(-200) };
  });
  sec.commands_ok = sec.commands.every((c) => c.exit === 0);

  // 4 宣稱檢查
  if (typeof o.report !== 'string') {
    sec.claims = { ok: false, missing: true, rows: [] };
  } else {
    const rows = claimRows(o.report, root);
    sec.claims = { ok: rows.every((r) => r.proven), missing: false, rows };
  }

  // 5 原話逐條對照（預設「否」，必須老師填「是」）
  const confirm = o.confirm || {};
  sec.quotes = spec.quotes.map((q, i) => {
    const v = confirm[String(i + 1)] || '否';
    return { id: i + 1, quote: q, status: v };
  });
  sec.quotes_ok = sec.quotes.every((q) => q.status === '是');

  const pass = sec.files.ok && sec.consensus.ok && sec.commands_ok && sec.claims.ok && sec.quotes_ok;
  const md = renderVerdict(spec, hash, sec, pass);
  const outFile = path.join(path.dirname(file), spec.task + '.verdict.md');
  fs.writeFileSync(outFile, md, 'utf8');
  return { pass, sec, md, file: outFile };
}

function renderVerdict(spec, hash, sec, pass) {
  const L = [];
  L.push('# 驗收單：' + spec.task, '', '提交：' + hash + '　結論：' + (pass ? '可接受' : '不可接受'), '');
  L.push('## 通過項與違反項', '');
  L.push('- [' + (sec.files.ok ? '通過' : '違反') + '] 檔案範圍：' + (sec.files.ok ? '只動了允許的檔案' : '允許之外被改動：' + sec.files.bad.join(', ')));
  L.push('- [' + (sec.consensus.ok ? '通過' : '違反') + '] 共識檢查（' + sec.consensus.name + '）');
  for (const it of sec.consensus.items) {
    if (it.error) { L.push('  - ' + it.scope + '：' + it.error); continue; }
    for (const r of it.results) if (!r.ok) L.push('  - ' + it.scope + '：' + CC.formatResult(r));
  }
  for (const c of sec.commands) L.push('- [' + (c.exit === 0 ? '通過' : '違反') + '] 驗收指令 `' + c.cmd + '` 結束碼 ' + c.exit);
  L.push('- [' + (sec.claims.ok ? '通過' : '違反') + '] 宣稱檢查' + (sec.claims.missing ? '：沒有提供報告文字' : ''));
  for (const r of sec.claims.rows) L.push('  - ' + (r.proven ? '[已證]' : '[宣稱未證，需要' + r.needs + ']') + ' 第 ' + r.index + ' 句（' + r.word + '）：' + r.text);
  L.push('', '## 與使用者原話逐條對照', '', '| 編號 | 使用者原話 | 已對照 |', '|---|---|---|');
  for (const q of sec.quotes) L.push('| ' + q.id + ' | ' + q.quote.replace(/\|/g, '/') + ' | ' + q.status + ' |');
  L.push('', '（只有老師填「是」才算通過；預設「否」。）', '');
  L.push('## 請補老師觀察', '', '驗收完成後，請用 `observe` 追加一筆老師視角的正路、分支或反思，例如：', '```', 'node skills/weak-model-harness/scripts/teacher_gate.js observe --task ' + spec.task + ' --kind branch --stage 階段 --lesson "…" --evidence "…"', '```', '');
  return L.join('\n');
}

// ---- observe：老師視角記錄 ----
const KINDS = ['positive_path', 'branch', 'reflection'];
function observeRecord(o, expFile) {
  const task = safeTask(o.task);
  if (!KINDS.includes(o.kind)) throw new Error('kind 只能是 ' + KINDS.join(' / '));
  for (const k of ['stage', 'lesson', 'evidence']) if (!o[k] || !String(o[k]).trim()) throw new Error('observe 必填欄位空白：' + k);
  const data = JSON.parse(fs.readFileSync(expFile, 'utf8'));
  const n = data.records.filter((r) => r.observer === 'teacher' && r.kind === o.kind && r.task === task).length + 1;
  const rec = { id: 'T-' + task + '-' + o.kind + '-' + n, observer: 'teacher', task, kind: o.kind, stage: String(o.stage), steps: [], alternatives: [], lesson: String(o.lesson), evidence: String(o.evidence), verified: false };
  if (data.records.some((r) => r.id === rec.id)) throw new Error('id 已存在：' + rec.id);
  data.records.push(rec);
  fs.writeFileSync(expFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return rec;
}

module.exports = { dispatchTask, verifyTask, observeRecord, renderVerdict, claimRows, CLAIM_WORDS, EXP_FILE };

// ---- 命令列 ----
function parseArgs(argv) {
  const o = { quote: [], allow: [], verify: [] }; const cmd = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]; const nx = () => argv[++i];
    if (a === '--task') o.task = nx(); else if (a === '--quote') o.quote.push(nx()); else if (a === '--consensus') o.consensus = nx();
    else if (a === '--allow') o.allow.push(nx()); else if (a === '--verify') o.verify.push(nx()); else if (a === '--hash') o.hash = nx();
    else if (a === '--report') o.reportFile = nx(); else if (a === '--confirm') o.confirmFile = nx(); else if (a === '--root') o.root = nx();
    else if (a === '--dir') o.dir = nx(); else if (a === '--kind') o.kind = nx(); else if (a === '--stage') o.stage = nx();
    else if (a === '--lesson') o.lesson = nx(); else if (a === '--evidence') o.evidence = nx();
    else throw new Error('不認得的參數：' + a);
  }
  return { cmd, o };
}

if (require.main === module) {
  let parsed;
  try { parsed = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const { cmd, o } = parsed;
  const dir = path.resolve(o.dir || '.weak-harness');
  try {
    if (cmd === 'dispatch') {
      const r = dispatchTask({ dir, task: o.task, quotes: o.quote, consensus: o.consensus, allow: o.allow, verify: o.verify });
      console.log('已寫入派工紀錄：' + r.file);
      process.exit(0);
    } else if (cmd === 'verify') {
      const report = o.reportFile ? fs.readFileSync(o.reportFile, 'utf8') : undefined;
      const confirm = o.confirmFile ? JSON.parse(fs.readFileSync(o.confirmFile, 'utf8')) : {};
      const r = verifyTask({ dir, task: o.task, hash: o.hash, root: o.root, report, confirm });
      console.log(r.md);
      console.log('驗收單：' + r.file);
      process.exit(r.pass ? 0 : 1);
    } else if (cmd === 'observe') {
      const rec = observeRecord(o, EXP_FILE);
      console.log('已追加老師觀察：' + rec.id);
      process.exit(0);
    } else {
      console.error('用法：teacher_gate.js dispatch|verify|observe ...'); process.exit(2);
    }
  } catch (e) { console.error(e.message); process.exit(2); }
}
