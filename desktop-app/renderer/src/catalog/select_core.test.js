// node renderer/src/catalog/select_core.test.js
const S = require('./select_core.js'); const set = require('./eval/selection_set.json');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 斷詞
check('tokenize: latin words, snake/dot/camel split', eq(S.tokenize('statistics.mean get_close_matches b64Encode'), ['statistics', 'mean', 'get', 'close', 'matches', 'b64', 'encode']));
check('tokenize: CJK bigrams', eq(S.tokenize('平均值'), ['平均', '均值']) && eq(S.tokenize('平'), ['平']));
check('tokenize: mixed', S.tokenize('用 base64 編碼').includes('base64') && S.tokenize('用 base64 編碼').includes('編碼'));

// --- 檢索
const U = (id, summary, params, extra) => Object.assign({ id, name: id.replace(/^[a-z]+:/, ''), summary: summary || '', params: (params || ['x']).map((n) => ({ name: n, required: true, type: 'any' })) }, extra || {});
const units = [U('py:statistics.mean', 'Return the sample arithmetic mean of data.', ['data']), U('py:statistics.median', 'Return the median of numeric data.', ['data']), U('py:math.sqrt', 'Return the square root of x.'), U('tool:images_to_pdf', '把一堆圖片依指定順序合成PDF', ['files']), U('tool:merge_pdfs', '把多份 PDF 文件合併成一份', ['files']), U('tool:text_to_speech', '把一段文字念成語音MP3', ['text'])];
const idx = S.buildIndex(units, { intents: { 'py:statistics.mean': '計算平均值', 'py:math.sqrt': '計算平方根' } });
let r = S.retrieve(idx, '把這幾張圖片合成一個 PDF', 3); check('retrieval finds the Chinese-described tool first', r[0].id === 'tool:images_to_pdf', r.map((x) => x.id));
r = S.retrieve(idx, '算這串數字的平均值', 3); check('retrieval finds the python unit through its intent', r[0].id === 'py:statistics.mean', r.map((x) => x.id));
const idx2 = S.buildIndex(units, { intents: { 'py:statistics.mean': '計算平均值' }, useIntents: false }); r = S.retrieve(idx2, '算這串數字的平均值', 3); check('without intents a Chinese query cannot reach an English-only unit (the cross-language gap is real)', !r.some((x) => x.id === 'py:statistics.mean'), r.map((x) => x.id));
check('retrieval is deterministic', eq(S.retrieve(idx, '合併 PDF', 5).map((x) => x.id), S.retrieve(idx, '合併 PDF', 5).map((x) => x.id)));
check('retrieval returns nothing for an unrelated query', S.retrieve(idx, '訂高鐵票', 5).length === 0);
const cases = [{ kind: 'pos', query: '把這幾張圖片合成一個 PDF', truth: ['tool:images_to_pdf'] }, { kind: 'pos', query: '算平均值', truth: ['py:statistics.mean'] }, { kind: 'pos', query: '訂高鐵票', truth: ['py:math.sqrt'] }, { kind: 'neg', query: 'x', truth: [] }];
const rc = S.retrievalRecall(idx, cases, [1, 3]); check('retrieval recall counts only positives', rc['recall@1'] === 66.7 && rc['recall@3'] === 66.7, rc);

// --- 洗牌與候選
check('shuffle is reproducible and a permutation', eq(S.shuffle([1, 2, 3, 4, 5, 6], 7), S.shuffle([1, 2, 3, 4, 5, 6], 7)) && eq(S.shuffle([1, 2, 3, 4, 5, 6], 7).slice().sort(), [1, 2, 3, 4, 5, 6]) && !eq(S.shuffle([1, 2, 3, 4, 5, 6], 7), S.shuffle([1, 2, 3, 4, 5, 6], 8)));
check('hashStr is stable', S.hashStr('abc') === S.hashStr('abc') && S.hashStr('abc') !== S.hashStr('abd'));
const ranked = S.retrieve(idx, 'pdf 文件 圖片 合併 平均 平方 文字 語音 files data', 6);
let cl = S.buildCandidates(units, ['tool:merge_pdfs'], ranked, 3, 'oracle', 1); check('oracle: truth is always in the list, size k, no duplicates', cl.length === 3 && cl.some((u) => u.id === 'tool:merge_pdfs') && new Set(cl.map((u) => u.id)).size === 3, cl.map((u) => u.id));
cl = S.buildCandidates(units, ['tool:merge_pdfs'], ranked, 3, 'none', 1); check('none: truth is removed', cl.length <= 3 && !cl.some((u) => u.id === 'tool:merge_pdfs'));
cl = S.buildCandidates(units, ['tool:merge_pdfs'], ranked, 2, 'retrieval', 1); check('retrieval: just the top-k', cl.length === 2 && cl.every((u) => ranked.slice(0, 2).some((x) => x.id === u.id)));
cl = S.buildCandidates(units, ['tool:merge_pdfs'], [], 4, 'oracle', 3, units); check('short distractor lists are filled from the whole library (reproducibly), truth still included', cl.length === 4 && cl.some((u) => u.id === 'tool:merge_pdfs') && eq(cl.map((u) => u.id), S.buildCandidates(units, ['tool:merge_pdfs'], [], 4, 'oracle', 3, units).map((u) => u.id)), cl.map((u) => u.id));
cl = S.buildCandidates(units, [], [], 4, 'none', 3, units); check('negatives get k unrelated candidates', cl.length === 4);
check('candidate order is reproducible per seed', eq(S.buildCandidates(units, ['tool:merge_pdfs'], ranked, 4, 'oracle', 5).map((u) => u.id), S.buildCandidates(units, ['tool:merge_pdfs'], ranked, 4, 'oracle', 5).map((u) => u.id)));

// --- 提示與解析
const msgs = S.selectionMessages('需求文字', units.slice(0, 3), { 'py:statistics.mean': '計算平均值' }); check('prompt lists numbered candidates with required params and the intent when present', msgs[1].content.includes('1. statistics.mean（data）：計算平均值') && msgs[1].content.includes('2. statistics.median（data）：Return the median') && msgs[1].content.endsWith('答案編號：') && !/回答 0/.test(msgs[0].content) && /回答 0/.test(S.selectionMessages('q', units.slice(0, 3), null, { allowNone: true })[0].content), msgs[1].content);
check('prompt does not leak the answer position or ids', !/truth|答案是/.test(msgs[1].content));
check('parseChoice allowZero', S.parseChoice('0', 5, true) === 0);
check('parseYesNo', S.parseYesNo('是') === true && S.parseYesNo('否，因為') === false && S.parseYesNo('嗯') === null);
check('verify prompt', S.verifyMessages('q', units[0], null)[1].content.includes('（是／否）'));
for (const [t, n, e] of [['3', 5, 3], ['答案：2', 5, 2], ['0', 5, null], ['7', 5, null], ['沒有', 5, null], ['', 5, null], ['  4\n因為…', 5, 4], ['-1', 5, null]]) check('parseChoice ' + JSON.stringify(t), S.parseChoice(t, n) === e, S.parseChoice(t, n));

// --- 選擇評分（用假的模型行為驗證評分邏輯）
const mkRows = (policy) => { const rows = []; set.cases.filter((c) => /^py:/.test(c.truth[0] || '')).slice(0, 10).concat(set.cases.filter((c) => /^tool:/.test(c.truth[0] || '')).slice(0, 6), set.cases.filter((c) => c.kind === 'neg').slice(0, 4)).forEach((c, i) => { const cands = [c.truth[0] || 'tool:x', 'tool:a', 'tool:b', 'tool:c', 'tool:d']; const truthPos = (i % 5) + 1; const arr = ['tool:a', 'tool:b', 'tool:c', 'tool:d']; arr.splice(truthPos - 1, 0, c.truth[0] || 'tool:x'); rows.push({ id: c.id, kind: c.kind === 'neg' ? 'neg' : 'pos', mode: c.kind === 'neg' ? 'none' : 'oracle', k: 5, cands: arr, truth: c.truth, choice: policy(arr, c, truthPos), ms: 100 }); }); return rows; };
let sc = S.scoreSelection(mkRows((arr, c, tp) => (c.kind === 'neg' ? 0 : tp))); check('perfect model: 100% correct, 100% rejection', sc['oracle@5'].correct_pct === 100 && sc['reject@5'].rejected_pct === 100 && sc['oracle@5'].truth_in_list_pct === 100, sc);
sc = S.scoreSelection(mkRows(() => 1)); check('always-pick-first model: shows position bias and rejects nothing', sc.chosen_position_counts['1'] > 0 && Object.keys(sc.chosen_position_counts).length === 1 && sc['reject@5'].wrongly_chose_pct === 100 && sc['oracle@5'].correct_pct < 40, sc);
sc = S.scoreSelection(mkRows(() => 0)); check('always-refuse model: scores 0 on positives, 100% rejection, and refusal is reported', sc['oracle@5'].correct_pct === 0 && sc['oracle@5'].refused_pct === 100 && sc['reject@5'].rejected_pct === 100);
sc = S.scoreSelection(mkRows(() => null)); check('unparseable answers are counted separately, not as wrong choices', sc['oracle@5'].unparsed_pct === 100 && sc['oracle@5'].correct_pct === 0);
sc = S.scoreSelection(mkRows((a, c, tp) => (c.kind === 'neg' ? 0 : tp)).map((r, i) => (i === 0 ? Object.assign({}, r, { mode: 'retrieval', cands: ['tool:q', 'tool:r'], truth: ['py:zzz'] }) : r))); check('retrieval mode where truth is not in the list is tracked (end-to-end failure is not the model’s fault)', sc['retrieval@5'].truth_in_list_pct === 0 && sc['retrieval@5'].correct_given_in_list_pct === null, sc['retrieval@5']);
check('by-runtime breakdown', sc.by_runtime_oracle.python && sc.by_runtime_oracle.tool);
check('mean latency', S.scoreSelection(mkRows((a, c, tp) => tp))['oracle@5'].mean_ms === 100);

// --- 填參數
const au = { params: [{ name: 'data', required: true, type: 'list<number>' }, { name: 'n', required: false, type: 'int' }], name: 'py:m.f' };
check('parseArgs: plain, fenced, with chatter, truncated', eq(S.parseArgs('{"data":[1,2]}'), { data: [1, 2] }) && eq(S.parseArgs('```json\n{"data":[1]}\n```'), { data: [1] }) && eq(S.parseArgs('好的：{"data":[3]} 就這樣'), { data: [3] }) && eq(S.parseArgs('{"data":[4]'), { data: [4] }) && S.parseArgs('沒有 JSON') === null && S.parseArgs('[1,2]') === null);
check('parseArgs: nested braces', eq(S.parseArgs('{"a":{"b":1},"c":2}'), { a: { b: 1 }, c: 2 }));
let sa = S.scoreArgs({ data: [3, 5] }, { data: [3, 5] }, au); check('args: exact', sa.exact && sa.valid_json && sa.all_required && sa.fields === 1 && sa.extra_keys === 0, sa);
sa = S.scoreArgs({ data: [3, 5] }, { data: ['3', '5'] }, au); check('args: numeric strings count as equal numbers', sa.exact, sa);
sa = S.scoreArgs({ s: 'Hello  World' }, { s: ' hello world ' }, { params: [{ name: 's', required: true }] }); check('args: string comparison ignores case and extra whitespace', sa.exact);
sa = S.scoreArgs({ data: [3, 5] }, { data: [3, 6] }, au); check('args: wrong value', !sa.exact && sa.fields === 0 && sa.all_required);
sa = S.scoreArgs({ data: [3, 5] }, { data: [3, 5], bogus: 1 }, au); check('args: hallucinated keys are counted and spoil exactness', !sa.exact && sa.extra_keys === 1 && sa.fields === 1);
sa = S.scoreArgs({ data: [3, 5] }, {}, au); check('args: missing required key', !sa.all_required && sa.valid_json);
sa = S.scoreArgs({ data: [3, 5] }, null, au); check('args: not JSON at all', !sa.valid_json && !sa.exact);
const agg = S.scoreArgsRows([{ valid_json: true, all_required: true, exact: true, fields: 2, of: 2, extra_keys: 0, ms: 10 }, { valid_json: true, all_required: false, exact: false, fields: 0, of: 2, extra_keys: 1, ms: 30 }, { valid_json: false, all_required: false, exact: false, fields: 0, of: 1, extra_keys: 0, ms: 20 }]); check('args aggregate', agg.n === 3 && agg.valid_json_pct === 66.7 && agg.exact_pct === 33.3 && agg.field_correct_pct === 40 && agg.hallucinated_keys_pct === 33.3 && agg.mean_ms === 20, agg);
const am = S.argsMessages({ name: 'py:m.f', params: [{ name: 'data', type: 'list<number>', required: true, description: '一串數字' }] }, '算平均'); check('args prompt names the function, params, and the need', /f\n/.test(am[1].content) && /data（list<number>，必填）：一串數字/.test(am[1].content) && /算平均/.test(am[1].content) && /JSON/.test(am[0].content));

// --- 評測集本身
check('set: ids unique, every positive has exactly the truth shape, negatives have none', (() => { const ids = new Set(set.cases.map((c) => c.id)); return ids.size === set.cases.length && set.cases.every((c) => (c.kind === 'neg' ? c.truth.length === 0 : c.truth.length >= 1 && c.truth.every((t) => /^(py|tool):/.test(t))) && c.query.length >= 4); })());
check('set: size is meaningful', set.cases.filter((c) => c.kind !== 'neg').length >= 50 && set.cases.filter((c) => c.kind === 'neg').length >= 8 && set.args.length >= 15);
check('set: no query contains its own answer name (no label leakage)', set.cases.every((c) => c.truth.every((t) => !c.query.toLowerCase().includes(t.replace(/^[a-z]+:/, '').split('.').pop().toLowerCase().replace(/_/g, ' ')) || /sha|md5|base64|gif|pdf|json|youtube|git|html|url/i.test(c.query))));
check('set: every python module is listed for onboarding', set.cases.filter((c) => c.truth[0] && c.truth[0].startsWith('py:')).every((c) => { const mod = c.truth[0].slice(3).split('.').slice(0, -1).join('.'); return set.modules.includes(mod) || (mod === 'posixpath' && set.modules.includes('posixpath')); }));
check('set: intents are Chinese and short', Object.values(set.intents).every((v) => /[一-鿿]/.test(v) && v.length <= 24));
check('set: args expected values are non-empty objects', set.args.every((a) => a.unit && a.query && Object.keys(a.expected).length >= 1));
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'select_core: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
