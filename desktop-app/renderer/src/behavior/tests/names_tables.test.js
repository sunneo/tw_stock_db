// C++ 標準函式庫（STL）、Rust、Go 名稱表的結構檢查：純 Node，不需要剖析器。用法：node renderer/src/behavior/tests/names_tables.test.js
// （語法樹與實際分析的驗證要在真實環境跑，見 DESIGN.behavior-analyzer.md §12。）
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..');
const ext = JSON.parse(fs.readFileSync(path.join(dir, 'names_cpp_rust_go.json'), 'utf8'));
const base = JSON.parse(fs.readFileSync(path.join(dir, 'behavior_patterns.json'), 'utf8'));
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const LANGS = ['cpp', 'rust', 'go'];
// 數量（太少代表表被截斷或生成壞了）
const count = {}; for (const c of Object.values(ext.categories)) for (const [l, ns] of Object.entries(c.languages)) count[l] = (count[l] || 0) + ns.length;
check('cpp has >= 400 names', count.cpp >= 400, count); check('rust has >= 800 names', count.rust >= 800, count); check('go has >= 1300 names', count.go >= 1300, count);
// 類別存在：用到的類別要嘛是原本 47 類之一，要嘛這份自己帶了說明
for (const [cid, c] of Object.entries(ext.categories)) check('category known or described: ' + cid, !!base.categories[cid] || (c.label && c.description), cid);
// 同一語言裡一個名稱只能在一個類別（引擎查表是後蓋前）
const seen = {}; const dup = [];
for (const [cid, c] of Object.entries(ext.categories)) for (const [l, ns] of Object.entries(c.languages)) for (const n of ns) { const k = l + '|' + n; if (seen[k] && seen[k] !== cid) dup.push(k); seen[k] = cid; }
check('no name appears in two categories', dup.length === 0, dup.slice(0, 5));
// 名稱形狀：沒有空白、沒有空字串；方法名以 . 開頭、巨集以 ! 結尾，Rust 路徑用 ::，Go 套件函式用 .
const shape = [];
for (const c of Object.values(ext.categories)) for (const [l, ns] of Object.entries(c.languages)) for (const n of ns) { if (!n || /\s/.test(n)) shape.push(l + '|' + n); if (l === 'rust' && /^[A-Za-z_]\w*\.[A-Za-z_]/.test(n) && !n.startsWith('.')) shape.push('rust uses :: not . → ' + n); }
check('names are well-formed', shape.length === 0, shape.slice(0, 5));
// 太泛用的方法名不能被分類（f.Close() 不能變成「壓縮」）
const generic = { go: ['.Close', '.Open', '.Create', '.Get', '.Set', '.Add', '.Run', '.Next', '.Error', '.String'], rust: ['.get', '.insert', '.remove', '.join', '.map', '.iter', '.clone', '.len', '.push_str', '.contains'] };
const hit = []; for (const [l, ns] of Object.entries(generic)) for (const n of ns) if (seen[l + '|' + n]) hit.push(l + '|' + n);
check('overly generic method names are not classified', hit.length === 0, hit);
// 代表性的名稱要在對的類別（也當作「表沒有被改壞」的檢查）
const want = { 'go|os.Open': 'file_io', 'go|http.Get': 'network_io', 'go|exec.Command': 'process_exec', 'go|.Lock': 'concurrency', 'go|json.Unmarshal': 'structured_data_parsing', 'go|sql.Open': 'database_access', 'go|panic': 'nonlocal_control_flow',
    'rust|fs::read_to_string': 'file_io', 'rust|TcpStream::connect': 'network_io', 'rust|thread::spawn': 'concurrency', 'rust|Command::new': 'process_exec', 'rust|println!': 'logging_output', 'rust|env::var': 'env_config_access', 'rust|Box::new': 'memory_management', 'rust|panic!': 'nonlocal_control_flow', 'rust|serde_json::from_str': 'structured_data_parsing',
    'cpp|ifstream': 'file_io', 'cpp|make_shared': 'memory_management', 'cpp|lock_guard': 'concurrency', 'cpp|sort': 'data_structures_algorithms', 'cpp|stoi': 'string_formatting', 'cpp|create_directories': 'filesystem_management', 'cpp|regex_match': 'structured_data_parsing', 'cpp|terminate': 'nonlocal_control_flow' };
for (const [k, c] of Object.entries(want)) check('classified: ' + k, seen[k] === c, [k, seen[k]]);
// API 語意：格式
const apiBad = [];
for (const l of LANGS) for (const [fn, s] of Object.entries(ext.api[l] || {})) {
    if (typeof s.summary !== 'string' || !s.summary) apiBad.push(l + '|' + fn + ' summary');
    if (!Array.isArray(s.parameters) || s.parameters.some((p) => !p.name || !p.meaning)) apiBad.push(l + '|' + fn + ' parameters');
    if (s.return && (typeof s.return.meaning !== 'string' || (s.return.rules || []).some((r) => !['<', '<=', '>', '>=', '==', '!='].includes(r.when.op)))) apiBad.push(l + '|' + fn + ' return');
}
check('api semantics are well-formed', apiBad.length === 0, apiBad.slice(0, 5));
check('api has entries for each language', LANGS.every((l) => Object.keys(ext.api[l] || {}).length >= 30), Object.fromEntries(LANGS.map((l) => [l, Object.keys(ext.api[l] || {}).length])));
// 控制結構節點（複雜度計算用）
check('rust and go control-flow node lists exist', ext.control_flow_nodes.rust.branch.includes('if_expression') && ext.control_flow_nodes.go.loop.includes('for_statement'));
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
