'use strict';
// 模型不停重複呼叫同一個工具的通用防護（2026-11-28，見 docs/AUDIT.repeat-calls.md）。
// 不複製邏輯：直接從 renderer/src/floating-assistant.js 抽出真正的方法原始碼來跑。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC_PATH = path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

// 從 class 本體抽出一個方法（4 格縮排的 name(...) {...}），把它變成可獨立呼叫的 function
// 模組層級的常數（去重集合）也從原始碼抽出來，讓方法拿得到
const CONSTS = {};
for (const k of ['FA_DEDUP_TOOLS', 'FA_DEDUP_EXACT_TOOLS']) {
  const m = new RegExp('const ' + k + ' = (new Set\\([^;]*\\));').exec(src);
  if (!m) throw new Error('找不到常數 ' + k);
  CONSTS[k] = new Function('return ' + m[1])();
}
function extractMethod(name) {
  const re = new RegExp('\\n    (async\\s+)?' + name + '\\(');
  const m = re.exec(src);
  if (!m) throw new Error('找不到方法 ' + name);
  const start = m.index + 1;
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  let text = src.slice(start, i + 1).replace(/^\s+/, '');
  text = text.replace(/^(async\s+)?(\w+)\(/, (all, a, n) => (a ? 'async ' : '') + 'function ' + n + '(');
  return new Function('FA_DEDUP_TOOLS', 'FA_DEDUP_EXACT_TOOLS', 'return (' + text + ')')(CONSTS.FA_DEDUP_TOOLS, CONSTS.FA_DEDUP_EXACT_TOOLS);
}

const NEEDED = [
  '_callToolGuarded', '_findDuplicateToolCall', '_dedupText', '_dedupTokens', '_isAutoAgentMode',
  '_repeatGuardOn', '_repeatKey', '_findConsecutiveRepeat', '_promoteMentionedTools', '_appendUnavailableToolNotice',
];
const methods = {};
for (const n of NEEDED) methods[n] = extractMethod(n);

function makeThis(opts) {
  const logs = [];
  const obj = Object.assign({
    tools: {},
    advancedSettings: { customTools: [] },
    multiSubAgentMode: 'delegate',
    _forceNoTools: false,
    _compactWiden: false,
    _compactExtra: new Set(),
    _toolCallLog: null,
    _intentPlanCache: null,
    _log(m) { logs.push(m); },
    _compactIxOn() { return false; },
    _intentOn() { return false; },
    _intentAll: [],
    _intentAdmit() {},
    _intentRefreshPrompt() {},
    _getRootToolNames() { return opts.root || Object.keys(this.tools); },
    _toolResultBudgetChars() { return 20000; },
    _unitCatalogObserve() {},
    _otScalarFields() { return undefined; },
    _truncate() {},
    _turnToolSuccess: null,
    options: { platform: opts.auto === false ? 'web' : 'desktop' }, // 真的 _isAutoAgentMode 讀這個
    _logs: logs,
  }, methods);
  return obj;
}

// 1) 通用連續重複：同名同參數連續成功 → 桌面版第 4 次起攔、網頁版第 3 次起攔
(async () => {
  const ok = (n) => JSON.stringify({ ok: true, n });
  let self = makeThis({ auto: true });
  self.tools = { fs_list_demo: { callback: async () => ok(1) } };
  let log = { calls: [], blocked: 0 };
  self._toolCallLog = log;
  const runs = [];
  for (let i = 0; i < 4; i++) runs.push(JSON.parse(await self._callToolGuarded(log, 'fs_list_demo', '{"path":"a"}', () => { return Promise.resolve(ok(i)); })));
  assert.strictEqual(runs.slice(0, 3).filter((r) => r.duplicate_call_blocked).length, 0, '前三次要正常執行：' + JSON.stringify(runs));
  assert.strictEqual(runs[3].duplicate_call_blocked, true, '桌面版第四次連續相同應被攔');
  assert.strictEqual(runs[3].repeat_run, 3, '攔阻時要告訴模型連續幾次');
  assert.ok(/連續 3 次/.test(runs[3].message), '提示要具體');
  console.log('通過  行為：桌面版連續 3 次成功後第 4 次攔下（附次數與上一次結果）');

  self = makeThis({ auto: false });
  self.tools = { fs_list_demo: {} };
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  const webRuns = [];
  for (let i = 0; i < 3; i++) webRuns.push(JSON.parse(await self._callToolGuarded(log, 'fs_list_demo', '{"path":"a"}', () => Promise.resolve(ok(i)))));
  assert.strictEqual(webRuns[1].duplicate_call_blocked, undefined, '網頁版第二次還放行');
  assert.strictEqual(webRuns[2].duplicate_call_blocked, true, '網頁版第三次攔下');
  console.log('通過  行為：網頁版門檻較嚴（連續 2 次成功後第 3 次攔下）');

  // 2) 合理的重複不擋：中間有別的工具、參數不同（分頁 cursor）、有一次失敗
  self = makeThis({ auto: true }); self.tools = { t: {}, u: {} };
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  const seq = [['t', '{"a":1}'], ['u', '{}'], ['t', '{"a":1}'], ['t', '{"a":1}']];
  for (const [n, a] of seq) await self._callToolGuarded(log, n, a, () => Promise.resolve(ok('x')));
  const afterBreak = JSON.parse(await self._callToolGuarded(log, 't', '{"a":1}', () => Promise.resolve(ok('y'))));
  assert.strictEqual(afterBreak.duplicate_call_blocked, undefined, '中間隔了別的工具，連續計數要重算（讀→改→再讀）');
  console.log('通過  行為：中間有別的工具呼叫，連續計數重算、不誤擋');

  self = makeThis({ auto: true }); self.tools = { t: {} };
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  for (const cur of [1, 2, 3, 4, 5]) {
    const r = JSON.parse(await self._callToolGuarded(log, 't', JSON.stringify({ cursor: 'c' + cur }), () => Promise.resolve(ok(cur))));
    assert.strictEqual(r.duplicate_call_blocked, undefined, '不同 cursor 是不同呼叫，不擋（分頁讀取）');
  }
  console.log('通過  行為：分頁讀取（cursor 不同）不擋');

  self = makeThis({ auto: true }); self.tools = { t: {} };
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  let fails = 0;
  for (let i = 0; i < 5; i++) {
    const r = JSON.parse(await self._callToolGuarded(log, 't', '{"a":1}', () => Promise.resolve(i < 3 ? JSON.stringify({ ok: false, error: 'x' }) : ok(i))));
    if (r.duplicate_call_blocked) fails++;
  }
  assert.strictEqual(fails, 0, '失敗的結果不計入連續成功，不擋重試');
  console.log('通過  行為：失敗的呼叫不計入連續成功，重試不擋');

  // 3) 有狀態／輪詢／寫入／執行的工具不擋
  for (const name of ['terminal_get_text', 'job_list', 'get_viewer_state', 'fs_write_file', 'python_execute', 'mcp_call', 'browser_get_page_text']) {
    self = makeThis({ auto: true }); self.tools = { [name]: {} };
    log = { calls: [], blocked: 0 }; self._toolCallLog = log;
    for (let i = 0; i < 6; i++) {
      const r = JSON.parse(await self._callToolGuarded(log, name, '{"a":1}', () => Promise.resolve(ok(i))));
      assert.strictEqual(r.duplicate_call_blocked, undefined, name + ' 不該被通用防護攔');
    }
  }
  console.log('通過  行為：輪詢、狀態、寫入、執行、委派類工具不被通用防護攔');

  // 4) 有讀取的工具（fs_read_file）仍會攔
  self = makeThis({ auto: true }); self.tools = { fs_read_file: {} };
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  let blocked = 0;
  for (let i = 0; i < 5; i++) { const r = JSON.parse(await self._callToolGuarded(log, 'fs_read_file', '{"path":"p"}', () => Promise.resolve(ok('same')))); if (r.duplicate_call_blocked) blocked++; }
  assert.strictEqual(blocked, 2, 'fs_read_file 連續相同參數第 4、5 次攔下');
  console.log('通過  行為：唯讀工具 fs_read_file 連續相同參數會攔');

  // 4b) 分頁讀取 big_content：同一頁（相同 cursor）連續重打要攔，換頁（cursor 不同）不攔
  self = makeThis({ auto: true }); self.tools = { big_content: {} };
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  const pageRes = [];
  for (const cur of ['c1', 'c2', 'c3', 'c3', 'c3', 'c3']) pageRes.push(JSON.parse(await self._callToolGuarded(log, 'big_content', JSON.stringify({ id: 'bc_1', action: 'page', cursor: cur }), () => Promise.resolve(ok(cur)))));
  assert.strictEqual(pageRes.slice(0, 5).filter((r) => r.duplicate_call_blocked).length, 0, '換頁（不同 cursor）不擋');
  assert.strictEqual(pageRes[5].duplicate_call_blocked, true, '同一頁連續重打要攔');
  console.log('通過  分頁：big_content 換頁不擋，同一頁連續重打才攔');

  // 5) 開關：localStorage fa.genericRepeatGuard='0' 關掉通用防護（回到舊行為）
  global.localStorage = { getItem: (k) => (k === 'fa.genericRepeatGuard' ? '0' : null) };
  self = makeThis({ auto: true }); self.tools = { fs_read_file: {} };
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  let offBlocked = 0;
  for (let i = 0; i < 5; i++) { const r = JSON.parse(await self._callToolGuarded(log, 'fs_read_file', '{"path":"p"}', () => Promise.resolve(ok('same')))); if (r.duplicate_call_blocked) offBlocked++; }
  assert.strictEqual(offBlocked, 0, '關閉後不攔');
  delete global.localStorage;
  console.log('通過  開關：fa.genericRepeatGuard=0 時完全不攔');

  // 6) 子agent路徑也受保護（log 不是 _toolCallLog）
  self = makeThis({ auto: true }); self.tools = { fs_read_file: {} };
  const sub = { calls: [], blocked: 0 };
  let subBlocked = 0;
  for (let i = 0; i < 5; i++) { const r = JSON.parse(await self._callToolGuarded(sub, 'fs_read_file', '{"path":"p"}', () => Promise.resolve(ok('same')))); if (r.duplicate_call_blocked) subBlocked++; }
  assert.strictEqual(subBlocked, 2, '子agent的連續重複也要攔');
  console.log('通過  子agent：連續重複同樣被攔');

  // 7) 結果提到沒送進清單的工具（1c 缺口）：根層級、各模式
  // 7a 壓縮索引（根層級沒有 big_content）→ 補進 _compactExtra
  self = makeThis({ auto: true, root: ['fetch_web_page'] });
  self.tools = { fetch_web_page: {}, big_content: {}, parse_uploaded_file: {}, unrelated_tool_x: {} };
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  const idxText = '[章節索引] 三層：要讀某章的區塊，用 big_content({"id":"bc_1"}) 分段讀；原文用 parse_uploaded_file。';
  await self._callToolGuarded(log, 'fetch_web_page', '{"url":"https://x"}', () => Promise.resolve(idxText));
  assert.ok(self._compactExtra.has('big_content') && self._compactExtra.has('parse_uploaded_file'), '結果提到的隱藏工具要補進清單');
  assert.ok(!self._compactExtra.has('unrelated_tool_x'), '沒被提到的不補');
  console.log('通過  1c 根層級：結果提到被收起來的 big_content／parse_uploaded_file 會補進清單');

  // 7b 意圖過濾模式（_intentOn）也要補（以前只有壓縮索引會補）
  self = makeThis({ auto: true, root: ['fetch_web_page'] });
  self.tools = { fetch_web_page: {}, big_content: {} };
  self._intentOn = () => true;
  const admitted = [];
  self._intentAdmit = (names) => admitted.push(...names);
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  await self._callToolGuarded(log, 'fetch_web_page', '{"url":"https://x"}', () => Promise.resolve(idxText));
  assert.ok(admitted.indexOf('big_content') >= 0, '意圖過濾模式：提到的工具要 _intentAdmit');
  console.log('通過  1c 意圖模式：結果提到的隱藏工具會 _intentAdmit');

  // 7c 子agent：唯讀工具或根層級能用的才補進 allowedToolNames；其他只在結果裡告知，不擴權
  self = makeThis({ auto: true, root: ['fetch_web_page', 'article_section'] });
  self.tools = { fetch_web_page: {}, big_content: {}, article_section: {}, fs_write_file: {}, parse_uploaded_file: {} };
  const allowed = ['fetch_web_page'];
  const subLog = { calls: [], blocked: 0, allowedNow: () => allowed, grantMention: (ns) => { for (const n of ns) if (!allowed.includes(n)) allowed.push(n); } };
  const subText = '提示：用 big_content 分段讀；寫檔請用 fs_write_file；另外 article_section 可讀章節。';
  const subRes = await self._callToolGuarded(subLog, 'fetch_web_page', '{"url":"https://x"}', () => Promise.resolve(subText));
  assert.ok(allowed.includes('big_content'), '子agent：唯讀的 big_content 要補進');
  assert.ok(allowed.includes('article_section'), '子agent：根層級能用的 article_section 要補進');
  assert.ok(!allowed.includes('fs_write_file'), '子agent：寫入工具不可因為結果提到就擴權');
  assert.ok(/系統提示/.test(subRes) && /fs_write_file/.test(subRes), '子agent：不能用的工具要在結果裡明講');
  console.log('通過  1c 子agent：唯讀或根層級能用的才補進；寫入類只告知、不擴權');

  // 7d 子agent 不能擴權（canRequestMore 為 false）：連根層級能用的也只告知
  const noGrantAllowed = ['fetch_web_page'];
  const noGrantLog = { calls: [], blocked: 0, allowedNow: () => noGrantAllowed, grantMention: null };
  const noGrantRes = await self._callToolGuarded(noGrantLog, 'fetch_web_page', '{"url":"https://y"}', () => Promise.resolve('請用 article_section 讀章節'));
  assert.ok(!noGrantAllowed.includes('article_section'), '不能擴權時清單不變');
  assert.ok(/系統提示/.test(noGrantRes) && /article_section/.test(noGrantRes), '不能擴權時要告知');
  console.log('通過  1c 子agent 不能擴權時：只告知，清單不變');

  // 7e 不是 JSON 的結果：附在後面
  const plain = self._appendUnavailableToolNotice('純文字結果', ['fs_write_file']);
  assert.ok(/系統提示/.test(plain) && /fs_write_file/.test(plain), '純文字結果附上提示');
  console.log('通過  1c 結果不是 JSON 時附在文字後面');

  // 8) 行為不變：原本的 fetch_web_page 精確重複攔阻仍在（第二次相同網址同格式就攔）
  self = makeThis({ auto: true }); self.tools = { fetch_web_page: {} };
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  const fw1 = JSON.parse(await self._callToolGuarded(log, 'fetch_web_page', '{"url":"https://a/","output":"jsonl"}', () => Promise.resolve(ok('first'))));
  const fw2 = JSON.parse(await self._callToolGuarded(log, 'fetch_web_page', '{"url":"https://a/","output":"jsonl"}', () => Promise.resolve(ok('second'))));
  assert.strictEqual(fw1.duplicate_call_blocked, undefined);
  assert.strictEqual(fw2.duplicate_call_blocked, true, '既有的 fetch_web_page 精確攔阻仍然有效');
  assert.ok(/網址/.test(fw2.message), '仍是專用提示');
  console.log('通過  既有行為：fetch_web_page 精確重複攔阻與專用提示不變');

  // 9) 模擬序列（替代真 Electron 重現，見 AUDIT 第 9 節）：抓文章 → 章節索引叫用 big_content → 模型重打 fetch → 攔下，並且 big_content 補進清單
  self = makeThis({ auto: true, root: ['fetch_web_page'] });
  self.tools = { fetch_web_page: {}, big_content: {}, article_section: {} };
  log = { calls: [], blocked: 0 }; self._toolCallLog = log;
  const index = '章節索引（一章一行）。要讀某章的區塊，用該行的 read_blocks（big_content({"id":"bc_7","action":"page","cursor":"x"}) 一頁頁讀）。';
  const fetchArgs = '{"url":"https://www.aiposthub.com/nemotron-parse-open-datasets-document-adaptation-recipe/"}';
  let fileNo = 0;
  const scenario = [];
  for (let i = 0; i < 5; i++) {
    const r = await self._callToolGuarded(log, 'fetch_web_page', fetchArgs, () => Promise.resolve(JSON.stringify({ ok: true, file_id: 'f' + (++fileNo), text: index })));
    scenario.push(r.indexOf('duplicate_call_blocked') >= 0 ? 'blocked' : 'ran');
  }
  assert.deepStrictEqual(scenario, ['ran', 'blocked', 'blocked', 'blocked', 'blocked'], '重打同一網址同一格式要攔（第二次起）');
  assert.ok(self._compactExtra && self._compactExtra.has('big_content'), '章節索引提到 big_content，要補進清單（模型才叫得到）');
  console.log('通過  模擬序列：抓文章→章節索引補 big_content→重打 fetch 被攔');

  console.log('repeat-guard 測試：全部通過');
})().catch((e) => { console.error('失敗', e && e.stack || e); process.exit(1); });
