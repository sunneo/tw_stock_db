// 回答被輸出上限截斷（finish_reason=length 且有部分文字）：_callSimpleCompletion(strictLength) 丟帶 partial 的錯誤、_kiLlm 不換模型、
// _kiLlmGrow 加倍重問（最多 2 次、上限 12000、g.exact 精確使用）、仍截斷就回 partial 並標 truncated／maxTokens；搬家進度的數字顯示（MB／段，不出現 n/0）。
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '../..'), K = require(path.join(root, 'renderer/src/knowledge/knowledge_core.js'));
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

// ---- 1. 進度數字
check('syncCount: bytes -> MB, never raw bytes', K.syncCount({ unit: 'bytes', done: 528482304, total: 601141248 }) === '504.0 / 573.3 MB', K.syncCount({ unit: 'bytes', done: 528482304, total: 601141248 }));
check('syncCount: bytes with unknown total shows only MB (no n/0)', K.syncCount({ unit: 'bytes', done: 5242880, total: 0 }) === '5.0 MB');
check('syncCount: chunks -> "3 / 9 段"', K.syncCount({ unit: 'chunks', done: 3, total: 9 }) === '3 / 9 段');
check('syncCount: chunks with unknown total -> 已傳 N 段, no "/0"', K.syncCount({ unit: 'chunks', done: 4, total: 0 }) === '已傳 4 段' && !/\/\s*0/.test(K.syncCount({ unit: 'chunks', done: 4, total: 0, raw: 1048576 })));
check('syncCount: chunks with raw size appends it', K.syncCount({ unit: 'chunks', done: 4, total: 0, raw: 10485760 }) === '已傳 4 段（10.0 MB）');
check('syncCount: no 8-digit numbers for big bytes', !/\d{7,}/.test(K.syncCount({ unit: 'bytes', done: 123456789, total: 987654321 })));

// ---- 2. _callSimpleCompletion(strictLength)
const fa = fs.readFileSync(path.join(root, 'renderer/src/floating-assistant.js'), 'utf8');
const i0 = fa.indexOf('    async _callSimpleCompletion('), i1 = fa.indexOf('\n    }\n', i0);
const methodSrc = fa.slice(i0, i1 + 6);
function makeCompletion(replies, calls) {
  const FaLlm = { fetch: async (url, o) => { const b = JSON.parse(o.body); calls.push(b.max_tokens); const r = replies.shift(); return { ok: true, json: async () => ({ choices: [{ message: { content: r[0] }, finish_reason: r[1] }] }) }; } };
  const obj = vm.runInNewContext('({' + methodSrc + '})', { FaLlm, JSON, Math, Error, String, Number });
  obj._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'u', apiModel: 'm' }); return obj;
}
(async () => {
  let calls = [], o = makeCompletion([['cut off mid-sen', 'length']], calls), e = null;
  try { await o._callSimpleCompletion('q', { maxTokens: 100, strictLength: true }); } catch (x) { e = x; }
  check('strictLength: truncated text throws finish_reason=length with partial', e && /finish_reason=length/.test(e.message) && e.partial === 'cut off mid-sen' && e.maxTokens === 100, e && e.message);
  calls = []; o = makeCompletion([['cut off', 'length']], calls);
  check('default (no strictLength): truncated text is still returned as before', (await o._callSimpleCompletion('q', { maxTokens: 100 })) === 'cut off');
  calls = []; o = makeCompletion([['whole', 'stop']], calls);
  check('strictLength: a finished answer passes', (await o._callSimpleCompletion('q', { maxTokens: 100, strictLength: true })) === 'whole');

  // ---- 3. _kiLlm / _kiLlmGrow（host 方法，用假的 this）
  const hostSrc = fs.readFileSync(path.join(root, 'renderer/src/knowledge/knowledge_host.js'), 'utf8');
  const H = vm.runInNewContext(hostSrc + '\n;FaKnowledgeHost', { window: {}, FaKnowledge: K, console, setTimeout, clearTimeout, Date, JSON, Math, Promise, Error, String, Number, Object, Array, Set, Map, RegExp }).methods;
  function makeThis(replies, seen) {
    const t = Object.assign({}, H);
    t.advancedSettings = {};
    t._kiOnlineAcrossRows = async (prompt, opts) => { seen.push(opts.maxTokens); const r = replies.shift(); if (r[1] === 'length') { const te = new Error('finish_reason=length（回答被輸出上限截斷了）'); te.partial = r[0]; throw te; } return r[0]; };
    t._kiOfflineComplete = async () => { seen.push('offline'); return 'offline answer'; };
    return t;
  }
  let seen = [], t = makeThis([['cut', 'length'], ['whole answer', 'stop']], seen), r = await t._kiLlmGrow('p', { maxTokens: 3500 }, { onStep() {} }, {});
  check('grow: truncated once -> asked again with 2x, then complete', r.text === 'whole answer' && r.truncated === false && r.maxTokens === 7000 && seen.join() === '3500,7000', { r, seen });
  seen = []; t = makeThis([['a', 'length'], ['ab', 'length'], ['abc', 'length']], seen); r = await t._kiLlmGrow('p', { maxTokens: 3500 }, {}, {});
  check('grow: still cut at the end -> partial, truncated:true, maxTokens (ceiling 12000, 2 retries)', r.text === 'abc' && r.truncated === true && r.maxTokens === 12000 && seen.join() === '3500,7000,12000', { r, seen });
  seen = []; t = makeThis([['a', 'length'], ['ab', 'length'], ['abc', 'length']], seen); r = await t._kiLlmGrow('p', { maxTokens: 1000 }, {}, {});
  check('grow: at most 2 retries even under the ceiling', r.truncated === true && seen.join() === '1000,2000,4000', { r, seen });
  seen = []; t = makeThis([['a', 'length'], ['ab', 'length']], seen); r = await t._kiLlmGrow('p', { maxTokens: 1000 }, {}, { ceiling: 1500 });
  check('grow: g.ceiling overrides the 12000 cap', r.text === 'ab' && r.truncated && seen.join() === '1000,1500', { r, seen });
  seen = []; t = makeThis([['cut', 'length']], seen); r = await t._kiLlmGrow('p', { maxTokens: 3500 }, {}, { exact: 9000 });
  check('grow: exact N is used as-is, no automatic doubling, partial flagged', r.text === 'cut' && r.truncated && r.maxTokens === 9000 && seen.join() === '9000', { r, seen });
  seen = []; t = makeThis([['fine', 'stop']], seen); r = await t._kiLlmGrow('p', { maxTokens: 3500 }, {}, {});
  check('grow: a normal answer is one call, not truncated', r.text === 'fine' && !r.truncated && seen.join() === '3500');
  seen = []; t = makeThis([['cut', 'length'], ['cut2', 'length'], ['x', 'length']], seen); r = await t._kiLlmGrow('p', { maxTokens: 3500 }, {}, {});
  check('_kiLlm: a length cut-off never falls through to the offline model', seen.indexOf('offline') < 0, seen);
  // 非截斷的錯誤照舊（會走原本的換模型流程；這裡只確認錯誤原樣丟出來而不是被吞掉）
  seen = []; t = makeThis([], seen); t._kiOnlineAcrossRows = async () => { throw new Error('API錯誤(401): bad key'); }; t._kiOfflineComplete = async () => { throw new Error('還沒下載離線文字模型'); };
  e = null; try { await t._kiLlmGrow('p', { maxTokens: 100 }, { noOffline: true }, {}); } catch (x) { e = x; }
  check('grow: other errors are rethrown unchanged', e && /401|還沒下載/.test(e.message), e && e.message);

  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'knowledge_truncation: ' + ok + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((x) => { console.error(x); process.exit(1); });
