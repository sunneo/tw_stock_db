'use strict';
// 多語言行為描述整合測試：真的 FaBeh2 引擎＋真的 web-tree-sitter 語法樹（跟 app 同一組版本）。
// 用法：node renderer/src/behavior/tests/langs.itest.js [語言…] [--show]   （--show 把每個函式的分析結果印出來，調整 profile／名稱表時用）
// 語法樹與 wasm 第一次從 CDN 下載到 $FA_TS_DIR（預設系統暫存資料夾 fa-ts-cache）；沒有網路又沒有快取就略過。
const fs = require('fs'), path = require('path'), os = require('os'), https = require('https');
const root = path.join(__dirname, '../../../..');
const dir = process.env.FA_TS_DIR || path.join(os.tmpdir(), 'fa-ts-cache');
const TSV = 'https://cdn.jsdelivr.net/npm/web-tree-sitter@0.20.8/', WV = 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.11/out/';
// Ruby：0.1.8 之後的 grammar 在 web-tree-sitter 0.20.8 上會在 parse 時當掉（外部掃描器的匯入缺失），0.1.6 可用——跟 floating-assistant.js 的 _behTsHost 同一份對照
const WV_OVERRIDE = { ruby: 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.6/out/' };
const WASM_NAME = { c: 'c', cpp: 'cpp', rust: 'rust', go: 'go', java: 'java', python: 'python', javascript: 'javascript', shell: 'bash', csharp: 'c_sharp', ruby: 'ruby', lua: 'lua' };
function get(url) { return new Promise((res, rej) => { https.get(url, (r) => { if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return get(new URL(r.headers.location, url).href).then(res, rej); if (r.statusCode !== 200) return rej(new Error('HTTP ' + r.statusCode + ' ' + url)); const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res(Buffer.concat(c))); }).on('error', rej); }); }
async function cached(name, url) { const f = path.join(dir, name); if (!fs.existsSync(f)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, await get(url)); } return f; }

const data = require('../../../../scripts/behavior-data.js').load(root);
const parts = ['engine_1_core.js', 'engine_2_scan.js', 'engine_3_narrative.js', 'engine_4_analyze.js', 'engine_5_api.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
const FaBeh2 = new Function("'use strict';\n" + parts)();
const host = {
  async loadTreeSitter() { const js = await cached('tree-sitter.js', TSV + 'tree-sitter.js'); const wasm = await cached('tree-sitter.wasm', TSV + 'tree-sitter.wasm'); const Parser = require(js); await Parser.init({ locateFile: () => wasm }); return Parser; },
  async loadLanguageWasm(name) { const base = WV_OVERRIDE[name] || WV; return new Uint8Array(fs.readFileSync(await cached('tree-sitter-' + name + (WV_OVERRIDE[name] ? '-v06' : '') + '.wasm', base + 'tree-sitter-' + name + '.wasm'))); },
};
const eng = FaBeh2.create({ patterns: data.patterns, api: data.api }, host, { categories: {}, api: {}, idioms: {}, notes: {}, mnemonics: {} });

// 每個語言：樣本檔、每個函式「至少要有」的行為分類、要出現在敘事裡的片語
const EXPECT = require('./langs.expect.js');
const show = process.argv.includes('--show'); const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };
(async () => {
  for (const [lang, spec] of Object.entries(EXPECT)) {
    if (only.length && !only.includes(lang)) continue;
    const file = path.join(__dirname, 'samples', spec.file); const text = fs.readFileSync(file, 'utf8');
    let r; try { r = await eng.explain(spec.file, text, { notes: {} }); } catch (e) { check(lang + ': explain 不能丟錯', false, String(e && e.stack || e).slice(0, 300)); continue; }
    const fns = {}; for (const f of r.functions) fns[f.name] = f;
    check(lang + ': 語言判斷', r.meta.language === (spec.language || lang), r.meta.language);
    check(lang + ': 找到的函式數 >= ' + spec.minFunctions, r.functions.length >= spec.minFunctions, r.functions.map((f) => f.name));
    for (const [name, want] of Object.entries(spec.functions)) {
      const f = fns[name]; check(lang + ': 找到函式 ' + name, !!f, Object.keys(fns)); if (!f) continue;
      for (const cat of want.categories || []) check(lang + ': ' + name + ' 的行為包含 ' + cat, !!f.behaviors[cat], f.behaviors);
      for (const m of want.notCategories || []) check(lang + ': ' + name + ' 的行為不含 ' + m, !f.behaviors[m], f.behaviors);
      if (want.branches != null) check(lang + ': ' + name + ' 分支數 >= ' + want.branches, f.branch_count >= want.branches, f.branch_count);
      if (want.loops != null) check(lang + ': ' + name + ' 迴圈數 >= ' + want.loops, f.loop_count >= want.loops, f.loop_count);
      if (want.doc) check(lang + ': ' + name + ' 有文件註解', !!f.leading_comment_text && new RegExp(want.doc, 'i').test(f.leading_comment_text), f.leading_comment_text);
    }
    for (const ph of spec.narrative || []) check(lang + ': 敘事包含「' + ph + '」', r.markdown.includes(ph), null);
    check(lang + ': 未分類的呼叫不超過 ' + spec.maxUnclassified, (r.meta.unclassified || []).length <= spec.maxUnclassified, r.meta.unclassified);
    if (show) { console.log('\n===== ' + lang + ' =====\n' + r.functions.map((f) => f.name + '  [' + Object.entries(f.behaviors).map(([k, v]) => k + ':' + v.join(',')).join(' | ') + ']  br=' + f.branch_count + ' lp=' + f.loop_count + (f.leading_comment_text ? '  doc="' + f.leading_comment_text.slice(0, 40) + '"' : '')).join('\n') + '\nUNCLASSIFIED: ' + JSON.stringify(r.meta.unclassified)); if (process.argv.includes('--md')) console.log(r.markdown.slice(0, 3000)); }
  }
  console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('離線或載入失敗，略過：', String(e && e.message || e)); process.exit(0); });
