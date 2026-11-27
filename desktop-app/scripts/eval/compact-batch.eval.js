// 批次大小（預設 0.25、上限 0.4，按 contextWindowTokens 比例）：藏書閣第 1 層視窗、summarize_large_text 分段、big_content 分頁，在不同視窗大小下的實際數字（真實 Electron）。
const fa = window.fa; const R = {};
const orig = fa._getGenerationSettings.bind(fa); const set = (ctx) => { fa._getGenerationSettings = () => Object.assign({}, orig(), { contextWindowTokens: ctx }); };
R.sites = {};
for (const ctx of [4096, 8192, 32768, 131072, 1000000]) {
  set(ctx); const ps = fa._pagerBudgetChars(); const po = fa._pagerBudgetOpts();
  R.sites[ctx] = { ki_window: fa._kiWindowChars(), summarize_chunk: fa._summarizeChunkSize(), pager_chars: ps, pager_opts: po.maxTokens != null ? { maxTokens: po.maxTokens } : po, limit_chars_0_4: Math.round(ctx * 0.4 * 3) };
  R.sites[ctx].allWithinCap = [R.sites[ctx].ki_window, R.sites[ctx].summarize_chunk].every((v) => v <= Math.max(6000, R.sites[ctx].limit_chars_0_4)) && ps <= R.sites[ctx].limit_chars_0_4 + 1;
}
// 估算節省：同一份文件（60 萬字元）在 131072 視窗下的分段數：舊（固定 2400／6000）vs 新
set(131072); const DOC = 600000; R.savings = { doc_chars: DOC, ki_level1_windows_old: Math.ceil(DOC / 2400), ki_level1_windows_new: Math.ceil(DOC / fa._kiWindowChars()), summarize_chunks_old: Math.ceil(DOC / 6000), summarize_chunks_new: Math.ceil(DOC / fa._summarizeChunkSize()) };
// 藏書閣第 1 層視窗實際切法：用假來源跑 _kiBuildDigest 的切窗（把 LLM 換成假的，量呼叫次數與每次輸入大小）
const lines = []; for (let i = 0; i < 4000; i++) lines.push('第' + i + '行：' + '這是一行測試文字，用來模擬一份很長的文件內容。'.repeat(3));
const calls = []; const store = { getSource: async () => ({ id: 's1', name: '測試文件', lines, sections: [] }), getDigests: async () => [], putDigest: async () => ({}) };
fa._kiRun = async (fn) => fn(store); fa._kiSummarize = async (text) => { calls.push(String(text).length); return '摘要。'; };
for (const ctx of [8192, 131072]) { set(ctx); calls.length = 0; const r = await fa._kiBuildDigest('s1', null, null); R['ki_' + ctx] = { ok: r.ok, made: r.made, level1Calls: calls.length, maxInputChars: Math.max(...calls), docChars: lines.join('\n').length }; }
set(131072); fa._getGenerationSettings = orig;
return R;
