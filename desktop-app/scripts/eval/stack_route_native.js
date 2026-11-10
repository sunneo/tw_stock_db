'use strict';
// 缺口 I（真模型版）：用桌面版原生執行器的引擎（onnxruntime-node，CPU）直接跑 Qwen3-0.6B，不開網路服務、不下載。
//   node scripts/eval/stack_route_native.js --runtime <原生執行包資料夾> --model <model_quantized.onnx> --tok <tokenizer.json> [--reps 3] [--temp 0.7] [--seed 1] [--out f.json] [--fake]
// --runtime 例：%APPDATA%\floating-assistant-desktop\native-runtime\1.22.0-1（只讀它的程式與 onnxruntime-node，不寫入）
// --fake：不載入模型，用確定性假模型驗證腳本本身（含 prefill、堆疊標頭有沒有送進提示）。
// 做法：題目與評分跟 stack_route.js 共用（scripts/eval/stack_route_cases.js），只是 generate 換成原生引擎；
//   chooseTool 走 jsonStep 的封閉題做法（prefill {"choice":、最多重試 2 次），所以模型每次只答一題。
const path = require('path');
const O = require('../../renderer/src/recipe/offline_stack_core.js');
const { buildCases } = require('./stack_route_cases.js');
const args = process.argv.slice(2); const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const fake = args.includes('--fake');
const reps = +opt('reps', 3), temp = +opt('temp', 0.7), seed0 = +opt('seed', 1), outFile = opt('out');
const runtime = opt('runtime'), modelPath = opt('model'), tokPath = opt('tok');
if (!fake && !(runtime && modelPath && tokPath)) { console.log('用法：node scripts/eval/stack_route_native.js --runtime <原生執行包資料夾> --model <onnx> --tok <tokenizer.json> [--reps 3] [--temp 0.7] [--seed 1] [--out f.json]\n或加 --fake 只驗證腳本'); process.exit(0); }

let generate;
if (fake) {
    // 假模型：看提示裡的使用者問題用關鍵字回答；若有堆疊標頭記錄起來，讓測試能確認標頭真的送進去
    globalThis.__fakeSawHeader = 0;
    generate = async (req) => {
        const txt = req.messages.map((m) => m.content).join('\n'); if (/【目標】/.test(txt)) globalThis.__fakeSawHeader++;
        const q = String(((req.messages.filter((m) => m.role === 'user').pop() || {}).content || '').split('使用者的話：\n').pop());
        const pick = /乘|公里|英里/.test(q) ? 1 : /股價|顯示卡/.test(q) ? 2 : /函式|IndexError|程式/.test(q) ? 3 : /資料夾|notes/.test(q) ? 4 : /提醒/.test(q) ? 5 : 0;
        return (req.prefill || '') + ' ' + pick + '}';
    };
} else {
    const eng = require(path.join(path.resolve(runtime), 'nr-engine.js'));
    const tpl = require(path.join(path.resolve(runtime), 'nr-template.js'));
    // nr-engine 的 applyTemplate 不傳 prefill：在這裡包一層，讓 prefill 接在助理回覆開頭（不改產品檔）
    const orig = tpl.TEMPLATES['qwen3-chatml']; let curPrefill = '';
    tpl.TEMPLATES['qwen3-chatml'] = (m, o) => orig(m, Object.assign({}, o, { prefill: curPrefill }));
    let n = 0;
    generate = async (req) => {
        curPrefill = req.prefill || '';
        const r = await eng.generate({ modelPath: path.resolve(modelPath), tokenizerPath: path.resolve(tokPath), messages: req.messages, maxTokens: req.maxTokens || 60, threads: 4, seed: seed0 + (n++),
            gen: temp > 0 ? { do_sample: true, temperature: temp, top_p: 0.9, repetition_penalty: 1.08 } : { do_sample: false } });
        return curPrefill + r.text;
    };
}
(async () => {
    const cases = buildCases(reps), t0 = Date.now();
    const r = await O.measureRoute({ cases, generate, variants: ['off', 'stack'], goal: '替使用者的話挑工具' });
    for (const v of Object.keys(r)) console.log(v + '：正確 ' + r[v].correct + '/' + r[v].n + '（' + (100 * r[v].accuracy).toFixed(1) + '%）；失敗（無有效回答）' + r[v].failed + '；呼叫 ' + r[v].calls);
    // 成對比較（同一題同一次重複，兩邊都有結果）與逐題表
    const a = r.off.rows, b = r.stack.rows; let better = 0, worse = 0, same = 0;
    a.forEach((x, i) => { const y = b[i]; if (x.hit === y.hit) same++; else if (y.hit) better++; else worse++; });
    console.log('成對（同題同次）：堆疊較好 ' + better + '、較差 ' + worse + '、持平 ' + same);
    const byQ = {}; a.forEach((x, i) => { const k = x.q; (byQ[k] = byQ[k] || { want: x.want, off: 0, stack: 0, n: 0, offGot: [], stackGot: [] }); byQ[k].n++; byQ[k].off += x.hit ? 1 : 0; byQ[k].stack += b[i].hit ? 1 : 0; if (!x.hit) byQ[k].offGot.push(x.got); if (!b[i].hit) byQ[k].stackGot.push(b[i].got); });
    Object.keys(byQ).forEach((k) => console.log('  ' + k + '（應為 ' + byQ[k].want + '）：無堆疊 ' + byQ[k].off + '/' + byQ[k].n + ' 有堆疊 ' + byQ[k].stack + '/' + byQ[k].n + (byQ[k].offGot.length ? ' 無堆疊錯選 ' + JSON.stringify(byQ[k].offGot) : '') + (byQ[k].stackGot.length ? ' 有堆疊錯選 ' + JSON.stringify(byQ[k].stackGot) : '')));
    const retry = (rows) => rows.filter((x) => x.tries > 1).length; console.log('需要重試的題數：無堆疊 ' + retry(a) + '、有堆疊 ' + retry(b) + '；總秒數 ' + Math.round((Date.now() - t0) / 1000));
    if (fake) console.log('假模型看到標頭的次數：' + globalThis.__fakeSawHeader);
    if (outFile) require('fs').writeFileSync(outFile, JSON.stringify({ params: { reps, temp, seed: seed0, fake }, paired: { better, worse, same }, byQ, result: r }, null, 1));
})().catch((e) => { console.error(e); process.exit(2); });
