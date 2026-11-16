// 桌面版 lm_head 實機量測（在真 Electron 的渲染程序裡跑，FA_DEBUG_EVAL_FILE 注入）。
// 同一個 App 工作階段內：nrGpuHead 關→暖機→量測；開→暖機→量測。逐詞元記時（onToken 的間隔），回報中位數與 p90、
// 有沒有走到 head 服務（渲染端 served 次數）、子程序回報的 gpu_head（used／fallback）與渲染端的錯誤與層別。
// 每跑完一段就把目前結果寫到 RESULT（經 rawfs），不等全部跑完才寫，避免中途結束時什麼都沒有。
// 這個檔只在 run 腳本裡當成 async 函式本體執行。
const fa = window.fa;
const RESULT = 'E:\\Temp\\claude\\1845096e089295dd\\f6658848-23ac-48c5-b44a-6a66f75a6f0e\\scratchpad\\head_desktop_result.json';
const PROMPT = '請用中文，詳細介紹台北市的歷史、地理與文化，寫成一段連貫的文字。';
const MAXN = 48;
const gen = FaVlm.textGenParams({}, { deterministic: true });
const statsOf = () => (fa._nrHeadSvc ? { served: fa._nrHeadSvc.stats.served, errors: fa._nrHeadSvc.stats.errors, lastLayer: fa._nrHeadSvc.stats.lastLayer, lastError: fa._nrHeadSvc.stats.lastError, layers: Object.assign({}, fa._nrHeadSvc.stats.layers) } : null);
const pct = (arr, p) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10 : null; };
async function save(obj) {
  const txt = JSON.stringify(obj, null, 1);
  try { await window.desktopAPI.rawfs.writeFile(RESULT, { text: txt }); obj.savedTo = RESULT; } catch (e) { obj.saveError = String((e && e.message) || e).slice(0, 200); }
  return obj;
}
async function runOnce(mode, maxTokens) {
  fa.advancedSettings.nrGpuHead = mode;
  const before = statsOf();
  const times = []; let last = 0; let t0 = 0; let accText = '';
  const cb = { onToken: (acc) => { const now = performance.now(); if (!t0) { t0 = now; last = now; } else { times.push(now - last); last = now; } accText = acc; }, log: () => {} };
  const start = performance.now();
  const r = await fa._nrRunNative({ messages: [{ role: 'user', content: PROMPT }], maxTokens: maxTokens, timeoutMs: 600000, strict: true }, cb, gen);
  const after = statsOf();
  const wall = performance.now() - start;
  return {
    mode: mode, maxTokens: maxTokens, ok: !!(r && r.ok), why: r && r.why ? r.why : '', wallMs: Math.round(wall),
    tokens: times.length + (t0 ? 1 : 0), firstTokenMs: t0 ? Math.round(t0 - start) : null,
    deltaMedianMs: pct(times, 0.5), deltaP90Ms: pct(times, 0.9), deltaMeanMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length * 10) / 10 : null,
    headUsedBy: fa._nrLastHead || '', headWhy: fa._nrLastHeadWhy || '',
    rendererServedDelta: after && before ? after.served - before.served : (after ? after.served : 0),
    rendererErrorsDelta: after && before ? after.errors - before.errors : (after ? after.errors : 0),
    rendererLastLayer: after ? after.lastLayer : null, rendererLastError: after ? after.lastError : '',
    fullText: String((r && r.text) || accText),
  };
}
const out = { env: { ua: navigator.userAgent.slice(0, 120), hasWebGPU: !!navigator.gpu }, steps: [] };
const step = async (name, fn) => { const v = await fn(); out.steps.push(name); out[name] = v; await save(out); return v; };
try {
  await save(out);
  await step('warmOff', () => runOnce('off', 8));
  await step('off', () => runOnce('off', MAXN));
  await step('warmOn', () => runOnce('on', 8));
  await step('on', () => runOnce('on', MAXN));
  out.sameText = out.on.fullText === out.off.fullText;
  out.off.text = out.off.fullText.slice(0, 200); out.on.text = out.on.fullText.slice(0, 200);
  delete out.off.fullText; delete out.on.fullText;
  out.serviceStats = statsOf();
} catch (e) {
  out.error = String((e && e.stack) || e).slice(0, 800);
}
fa.advancedSettings.nrGpuHead = 'off';
out.done = true;
await save(out);
return out;
