// C#／Ruby／Lua 名稱表與 Python／Java／JavaScript 補強表（names_more_langs.json）的結構檢查：純 Node，不需要剖析器。
// 用法：node renderer/src/behavior/tests/names_more_langs.test.js（真實語法樹的驗證在 langs.itest.js）。
const fs = require('fs'), path = require('path');
const { load } = require('../../../../scripts/behavior-data.js');
const root = path.join(__dirname, '..', '..', '..', '..');
const ext = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'names_more_langs.json'), 'utf8'));
const merged = load(root);
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const LANGS = ['csharp', 'ruby', 'lua', 'python', 'java', 'javascript'];
const count = {}; for (const c of Object.values(ext.categories)) for (const [l, ns] of Object.entries(c.languages)) count[l] = (count[l] || 0) + ns.length;
check('csharp >= 1000, ruby >= 1000, lua >= 1000 names', count.csharp >= 1000 && count.ruby >= 1000 && count.lua >= 1000, count);
check('python/java/javascript >= 500 names', count.python >= 500 && count.java >= 500 && count.javascript >= 500, count);
// 合併後：每個分類都有標籤（新分類要自己帶說明）
for (const [cid, c] of Object.entries(merged.patterns.categories)) check('category has a label: ' + cid, !!c.label, cid);
// 合併後同一語言一個名稱只能在一個分類
const mineSet = new Set(); for (const c of Object.values(ext.categories)) for (const [l, ns] of Object.entries(c.languages)) for (const n of ns) mineSet.add(l + '|' + n);
const seen = {}, dup = [];
for (const [cid, c] of Object.entries(merged.patterns.categories)) for (const [l, ns] of Object.entries(c.languages || {})) for (const n of ns) { const k = l + '|' + n; if (seen[k] && seen[k] !== cid) dup.push(k + ' ' + seen[k] + '/' + cid); seen[k] = cid; }
check('no name appears in two categories (all languages in the new file)', dup.filter((d) => mineSet.has(d.split(' ')[0])).length === 0, dup.filter((d) => mineSet.has(d.split(' ')[0])).slice(0, 5));
// 名稱形狀
const shape = [];
for (const c of Object.values(ext.categories)) for (const [l, ns] of Object.entries(c.languages)) for (const n of ns) if (!n || /\s/.test(n)) shape.push(l + '|' + n);
check('names are well-formed', shape.length === 0, shape.slice(0, 5));
// 太泛用的名稱不能被分類
const generic = { csharp: ['.Add', '.Contains', '.Count', '.ToString', '.Dispose', '.Equals'], ruby: ['.each', '.map', '.new', '.to_s', '.length', '.first'], lua: ['pairs', 'ipairs', 'next', 'select', 'type', '.insert', '.find'], java: ['get', 'put', 'size', 'toString', 'equals'], python: ['len', 'range', 'append', 'get', 'items'], javascript: ['push', 'map', 'filter', 'forEach', 'toString'] };
const hit = []; for (const [l, ns] of Object.entries(generic)) for (const n of ns) if (mineSet.has(l + '|' + n)) hit.push(l + '|' + n + ' → ' + seen[l + '|' + n]);
check('overly generic names are not classified', hit.length === 0, hit);
// 代表性的名稱要在對的分類
const want = {
  'csharp|File.ReadAllText': 'file_io', 'csharp|HttpClient': 'network_io', 'csharp|Process.Start': 'process_exec', 'csharp|Task.Run': 'concurrency', 'csharp|JsonSerializer.Deserialize': 'structured_data_parsing', 'csharp|GL.Clear': 'graphics_rendering', 'csharp|SDL.SDL_PollEvent': 'event_handling', 'csharp|Matrix4x4.CreateLookAt': 'linear_algebra', 'csharp|Marshal.AllocHGlobal': 'memory_management',
  'ruby|File.read': 'file_io', 'ruby|Net::HTTP.get': 'network_io', 'ruby|system': 'process_exec', 'ruby|Thread.new': 'concurrency', 'ruby|JSON.parse': 'structured_data_parsing', 'ruby|puts': 'logging_output', 'ruby|ENV.fetch': 'env_config_access', 'ruby|send': 'reflection_metaprogramming',
  'lua|io.open': 'file_io', 'lua|socket.tcp': 'network_io', 'lua|os.execute': 'process_exec', 'lua|coroutine.wrap': 'concurrency', 'lua|json.decode': 'structured_data_parsing', 'lua|print': 'logging_output', 'lua|os.getenv': 'env_config_access', 'lua|pcall': 'nonlocal_control_flow',
  'python|json.loads': 'structured_data_parsing', 'python|subprocess.run': 'process_exec', 'python|time.time': 'time_date', 'python|logger.info': 'logging_output', 'python|hashlib.sha256': 'crypto_security',
  'java|LOG.info': 'logging_output', 'java|Thread.sleep': 'concurrency', 'java|System.currentTimeMillis': 'time_date', 'java|DriverManager.getConnection': 'database_access',
  'javascript|fs.readFileSync': 'file_io', 'javascript|fetch': 'network_io', 'javascript|crypto.createHash': 'crypto_security', 'javascript|console.log': 'logging_output',
};
for (const [k, c] of Object.entries(want)) check('classified: ' + k, seen[k] === c, [k, seen[k]]);
// API 語意：格式
const apiBad = [];
for (const l of LANGS) for (const [fn, s] of Object.entries(ext.api[l] || {})) {
  if (typeof s.summary !== 'string' || !s.summary) apiBad.push(l + '|' + fn + ' summary');
  if (!Array.isArray(s.parameters) || s.parameters.some((p) => !p.name || !p.meaning)) apiBad.push(l + '|' + fn + ' parameters');
  if (s.return && (typeof s.return.meaning !== 'string' || (s.return.rules || []).some((r) => !['<', '<=', '>', '>=', '==', '!='].includes(r.when.op)))) apiBad.push(l + '|' + fn + ' return');
}
check('api semantics are well-formed', apiBad.length === 0, apiBad.slice(0, 5));
check('api has >= 20 entries per language', LANGS.every((l) => Object.keys(ext.api[l] || {}).length >= 20), Object.fromEntries(LANGS.map((l) => [l, Object.keys(ext.api[l] || {}).length])));
// 控制結構節點
check('csharp/ruby/lua control-flow nodes exist', ext.control_flow_nodes.csharp.loop.includes('for_each_statement') && ext.control_flow_nodes.ruby.branch.includes('unless') && ext.control_flow_nodes.lua.loop.includes('repeat_statement'));
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
