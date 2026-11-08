'use strict';
// 缺口 I：選工具路由（chooseTool）加思考堆疊標頭有沒有幫助。同一批題、同一個真模型，比較無堆疊／有堆疊（帶離線各層摘要）的正確率與呼叫數。
//   node scripts/eval/stack_route.js --url http://127.0.0.1:18099/v1/chat/completions [--reps 3] [--temp 0.7] [--out f.json]
// 沒給 --url 只印用法。題目是小而均衡的路由題（自己出的，不是 holdout）；結果的解讀見 DESIGN.think-stack.md。
const O = require('../../renderer/src/recipe/offline_stack_core.js');
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const url = opt('url'); if (!url) { console.log('用法：node scripts/eval/stack_route.js --url <OpenAI 相容 chat/completions> [--reps 3] [--temp 0.7] [--out f.json]'); process.exit(0); }
const reps = +opt('reps', 3), temp = +opt('temp', 0.7), outFile = opt('out');
const cands = [{ tool: 'calc', intent: '算數、單位換算' }, { tool: 'search', intent: '上網搜尋最新資訊' }, { tool: 'code', intent: '寫程式、修程式' }, { tool: 'file', intent: '讀寫、整理檔案' }, { tool: 'timer', intent: '設定提醒、計時' }];
const base = [['幫我算 123 乘 45', 'calc'], ['5 英里是幾公里', 'calc'], ['今天台積電股價多少', 'search'], ['最近有什麼新的顯示卡', 'search'], ['寫一個把清單排序的函式', 'code'], ['這段程式跑出 IndexError 幫我修', 'code'], ['把下載資料夾的圖片依日期分類', 'file'], ['讀一下 notes.txt 的內容', 'file'], ['十分鐘後提醒我關火', 'timer'], ['你覺得人生的意義是什麼', null]];
const cases = []; for (let i = 0; i < reps; i++) base.forEach(([q, w]) => cases.push({ question: q, cands, want: w }));
const post = (req) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: req.messages, max_tokens: req.maxTokens || 60, temperature: temp }) })
    .then((r) => (r.ok ? r.json() : r.text().then((t) => { throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 100)); }))).then((j) => j.choices[0].message.content || '');
(async () => {
    const r = await O.measureRoute({ cases, generate: post, variants: ['off', 'stack'], goal: '替使用者的話挑工具' });
    for (const v of Object.keys(r)) console.log(v + '：正確 ' + r[v].correct + '/' + r[v].n + '（' + (100 * r[v].accuracy).toFixed(1) + '%）；失敗（無有效回答）' + r[v].failed + '；呼叫 ' + r[v].calls);
    if (outFile) require('fs').writeFileSync(outFile, JSON.stringify(r, null, 1));
})().catch((e) => { console.error(e); process.exit(2); });
