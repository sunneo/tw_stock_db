// 預填從產品端到原生子程序的轉傳（回歸測試）。
// 缺口（commander 探針 probe4，§32.7 之後）：main-ext.js 組 run 請求時沒有帶 prefill，子程序收不到，模型從頭生成，
// 產品端又把預填拼在前面 → 輸出重複（<tool_call>\n{<tool_call>…）。這裡鎖住三段轉傳：main-ext → nr-host → nr-child → nr-engine。
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : String(x).slice(0, 200)); } };

const mainExt = fs.readFileSync(path.join(root, 'main-ext.js'), 'utf8').replace(/\r\n/g, '\n');
check('main-ext：run 請求把產品端的 prefill 帶進子程序請求', /if \(typeof p\.prefill === "string" && p\.prefill\) req\.prefill = p\.prefill;/.test(mainExt));
check('main-ext：預填只在字串且非空時帶入（沒有就不加欄位，舊子程序不受影響）', /typeof p\.prefill === "string" && p\.prefill\)/.test(mainExt));
const hostSrc = fs.readFileSync(path.join(root, 'nr-host.js'), 'utf8');
check('nr-host：run 訊息轉傳 prefill', /if \(typeof req\.prefill === 'string' && req\.prefill\) msg\.prefill = req\.prefill;/.test(hostSrc));
const childSrc = fs.readFileSync(path.join(root, 'nr-child.js'), 'utf8');
check('nr-child：生成時把 msg.prefill 傳給引擎', /generate\([^)]*prefill: msg\.prefill/.test(childSrc) || /prefill: msg\.prefill/.test(childSrc), childSrc.slice(0, 0));
const engineSrc = fs.readFileSync(path.join(root, 'nr-engine.js'), 'utf8');
check('nr-engine：提示詞用 applyTemplate 並帶 prefill（接在生成提示之後）', /applyTemplate\([^)]*prefill: opts\.prefill/.test(engineSrc));

// 樣板：預填必須在生成提示（含空思考區塊）之後，且不加結束標記
const { applyTemplate } = require(path.join(root, 'nr-template.js'));
const p = applyTemplate('qwen3-chatml', [{ role: 'user', content: 'q' }], { enable_thinking: false, prefill: '{' });
check('樣板：預填接在空思考區塊之後', p.endsWith('</think>\n\n{'), p);
check('樣板：預填後沒有 <|im_end|>', p.indexOf('<|im_end|>', p.lastIndexOf('assistant')) < 0, p);

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
