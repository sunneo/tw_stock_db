// 擴展回合（真實 Electron、假 LLM）：子任務回合用完還沒做完 → 放卡片問使用者（允許＋N／改數字／不要／以後都不要問）；
// 模型自己呼叫 extend_rounds 也走同一張卡；auto 用總上限擋、用光誠實失敗；批次平行的子任務不問。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/extend-rounds.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {};
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
fa.advancedSettings.offlineMode = false;
fa._resolveModelRowConfig = () => ({ apiModel: 'm', apiUrl: 'http://fake.local/v1', apiKey: 'k', samplingOverrides: null, maxOutputTokens: 512 });
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' }); fa._shouldUseNativeToolCalls = () => true; fa._ensureNativeToolSupportProbed = async () => true;
let n = 0;
fa.register_openai_tool('wiki_read_page', '讀一頁 wiki。參數: {"page":"頁碼"}', async (raw) => JSON.stringify({ ok: true, page: String(raw).slice(0, 40) }), { type: 'object', properties: { page: { type: 'string' } } });
const realFetch = window.fetch.bind(window); let finishAt = 99, calls = 0, mode = 'loop', extendedByModel = false;
window.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake.local/')) return realFetch(url, init);
  const body = JSON.parse(init.body); const tnames = (body.tools || []).map((t) => t.function.name);
  const mk = (msg) => new Response(JSON.stringify({ choices: [{ message: Object.assign({ role: 'assistant', content: '' }, msg), finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (!body.tools) return mk({ content: '已讀了前幾頁，還沒讀完。' }); // 回合用完後不帶工具的整理（進度回報），不算回合
  calls++; R._tools = tnames;
  if (mode === 'model_extend' && !extendedByModel && calls === 2) { extendedByModel = true; return mk({ tool_calls: [{ id: 'x' + calls, type: 'function', function: { name: 'extend_rounds', arguments: JSON.stringify({ estimate: 7, reason: '讀完大綱，還有 20 頁沒讀' }) } }] }); }
  if (calls >= finishAt) return mk({ content: '全部讀完，整理好了。' });
  return mk({ tool_calls: [{ id: 'c' + calls, type: 'function', function: { name: 'wiki_read_page', arguments: JSON.stringify({ page: 'p' + calls }) } }] });
};
let asked = []; let answer = (spec) => ({ ok: true, confirmed: true, flat: { choice: 'allow' } });
fa.askCard = async (spec) => { asked.push(spec); return answer(spec); };
const run = async (maxRounds, opts) => { calls = 0; asked = []; const r = await fa._runSubAgentTask('把 wiki 讀完並整理', maxRounds, Object.assign({ allowedToolNames: ['wiki_read_page'], noMoreTools: true }, opts || {})); return r; };

// 0) 卡片規格合法
fa.advancedSettings.roundExtend = { mode: 'ask', cap: 60 };
finishAt = 99; mode = 'loop'; answer = () => ({ ok: true, confirmed: true, flat: { choice: 'deny' } }); let r0 = await run(3);
R.spec_valid = asked.length === 1 && FaCard.validateSpec(asked[0]).length === 0; R.spec_title = asked[0] && asked[0].title; R.spec_desc = asked[0] && asked[0].description;
R.spec_options = asked[0] && asked[0].questions[0].options.map((o) => o.id);
// 1) 不要：誠實失敗，只問一次
R.deny = { asks: asked.length, calls, fail: /這個請求沒有完成/.test(r0.text), reason: r0.extendFailed, hasReport: /已讀了前幾頁/.test(r0.text) };
// 2) 允許：從原來的回合接著做，做完
finishAt = 9; answer = () => ({ ok: true, confirmed: true, flat: { choice: 'allow' } }); let r2 = await run(3);
R.allow = { asks: asked.length, calls, done: /全部讀完/.test(r2.text), notFailed: !r2.extendFailed };
// 3) 改成其他數字：數字由程式重新限制範圍（0、負數、亂寫 → 當不要）
finishAt = 8; answer = () => ({ ok: true, confirmed: true, flat: { choice: 'other', 'choice.other': '9' } }); let r3 = await run(3); R.other = { calls, done: /全部讀完/.test(r3.text) };
answer = () => ({ ok: true, confirmed: true, flat: { choice: 'other', 'choice.other': 'abc' } }); finishAt = 99; let r3b = await run(3); R.other_bad = { fail: /這個請求沒有完成/.test(r3b.text), calls };
// 4) 以後都不要問：存成 auto＋總上限，之後不再放卡片；用光就失敗
answer = () => ({ ok: true, confirmed: true, flat: { choice: 'never', 'choice.never': '12' } }); finishAt = 99; let r4 = await run(3);
R.never = { saved: JSON.stringify(fa.advancedSettings.roundExtend), asks: asked.length, calls, fail: /這個請求沒有完成/.test(r4.text), reason: r4.extendFailed };
finishAt = 99; let r5 = await run(3); R.auto_after = { asks: asked.length, calls, reason: r5.extendFailed, cappedAtTotal: calls <= 12 };
// 5) auto 在總上限內做完：不問
fa.advancedSettings.roundExtend = { mode: 'auto', cap: 30 }; finishAt = 10; let r6 = await run(3); R.auto_done = { asks: asked.length, done: /全部讀完/.test(r6.text) };
// 6) 模型自己呼叫 extend_rounds：也走同一張卡，然後繼續做完
fa.advancedSettings.roundExtend = { mode: 'ask', cap: 60 }; answer = () => ({ ok: true, confirmed: true, flat: { choice: 'allow' } }); mode = 'model_extend'; finishAt = 9; let r7 = await run(3);
R.model_extend = { hasTool: (R._tools || []).includes('extend_rounds'), asks: asked.length, byModelReason: asked[0] && /讀完大綱/.test(asked[0].description), done: /全部讀完/.test(r7.text) };
// 7) 批次平行的子任務不問、也不給這個工具
mode = 'loop'; finishAt = 99; let r8 = await run(3, { rateLimitPerMinute: 600 }); R.batch = { asks: asked.length, noTool: !(R._tools || []).includes('extend_rounds'), notFailCard: !r8.extendFailed };
// 8) 使用者在卡片上取消：當不要
fa.advancedSettings.roundExtend = { mode: 'ask', cap: 60 }; answer = () => ({ ok: true, confirmed: false, flat: {} }); let r9 = await run(3); R.cancel = { fail: /這個請求沒有完成/.test(r9.text) };
// 9) 設定驗證
R.policy = fa._roundsPolicy(); fa.advancedSettings.roundExtend = { mode: 'auto', cap: 9999 }; R.policy_clamped = fa._roundsPolicy().cap;
// 10) 模型卡決定送法：卡片說文字比較穩 → 自動模式用文字；沒有卡片 → 維持
delete fa._shouldUseNativeToolCalls; fa.advancedSettings.toolCallMode = 'auto'; fa._nativeToolCallsAuto = () => true;
const cards0 = fa._getModelCards(); const saved = JSON.stringify(cards0); const cfg = fa._getApiConfig();
fa._getApiConfig = () => ({ apiKey: 'k', apiUrl: 'http://fake.local/v1', apiModel: 'm' });
fa._getModelCards = () => ({ m: { model: 'm', apiUrl: 'http://fake.local/v1', toolMode: 'text' } }); R.card_text = fa._shouldUseNativeToolCalls('m') === false;
fa._getModelCards = () => ({ m: { model: 'm', apiUrl: 'http://fake.local/v1', toolMode: 'native' } }); R.card_native = fa._shouldUseNativeToolCalls('m') === true;
fa._getModelCards = () => ({ m: { model: 'm', apiUrl: 'http://other/v1', toolMode: 'text' } }); R.card_other_url = fa._shouldUseNativeToolCalls('m') === true;
fa._getModelCards = () => ({}); R.no_card = fa._shouldUseNativeToolCalls('m') === true;
fa._nativeToolCallsAuto = () => false; fa._getModelCards = () => ({ m: { toolMode: 'native' } }); R.endpoint_no_native = fa._shouldUseNativeToolCalls('m') === false;
window.fetch = realFetch; return R;
