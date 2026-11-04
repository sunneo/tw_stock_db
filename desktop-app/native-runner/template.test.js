// 原生提示樣板與 run.template 協定的單元測試（node，不需要模型與分詞器檔）。
// 用法：node native-runner/template.test.js
'use strict';
const { applyTemplate, TEMPLATES } = require('./template.js');
const proto = require('./protocol.js');

let ok = 0; const bad = [];
const check = (name, c, x) => { if (c) ok++; else { bad.push(name); console.log('FAIL', name, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

check('登記了 qwen3-chatml', typeof TEMPLATES['qwen3-chatml'] === 'function');
const one = applyTemplate('qwen3-chatml', [{ role: 'user', content: '你好' }], { enable_thinking: false });
check('單輪、關閉思考：ChatML＋空思考區塊', one === '<|im_start|>user\n你好<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n', one);
const think = applyTemplate('qwen3-chatml', [{ role: 'user', content: '你好' }], { enable_thinking: true });
check('開啟思考：不補空思考區塊', think === '<|im_start|>user\n你好<|im_end|>\n<|im_start|>assistant\n', think);
const undef = applyTemplate('qwen3-chatml', [{ role: 'user', content: 'x' }]);
check('未指定 enable_thinking：與開啟思考相同（Qwen3 預設）', undef === '<|im_start|>user\nx<|im_end|>\n<|im_start|>assistant\n', undef);
const multi = applyTemplate('qwen3-chatml', [
    { role: 'system', content: '系統' }, { role: 'user', content: 'a' }, { role: 'assistant', content: '<think>內部</think>答' }, { role: 'user', content: 'b' },
], { enable_thinking: false });
check('多輪：歷史 assistant 去掉思考區塊', multi.indexOf('<think>內部') < 0 && multi.indexOf('<|im_start|>assistant\n答<|im_end|>') >= 0, multi);
const pre = applyTemplate('qwen3-chatml', [{ role: 'user', content: 'q' }], { enable_thinking: false, prefill: '好的：' });
check('prefill 接在生成提示之後', pre.endsWith('</think>\n\n好的：'), pre);
let threw = false; try { applyTemplate('no-such-template', []); } catch (e) { threw = /未知的提示樣板/.test(e.message); }
check('未知樣板名稱直接丟錯（不靜默退回）', threw);
threw = false; try { applyTemplate('qwen3-chatml', [{ content: 'x' }]); } catch (e) { threw = /缺少 role/.test(e.message); }
check('缺少 role 的訊息丟錯', threw);

// 協定：run.template 欄位
const v1 = proto.validate({ type: 'run', id: '1', messages: [], max_tokens: 1, timeout_ms: 0, stream: false, template: 'qwen3-chatml' });
check('run 帶 template 字串通過驗證', v1.ok, v1);
const v2 = proto.validate({ type: 'run', id: '1', messages: [], max_tokens: 1, timeout_ms: 0, stream: false });
check('run 不帶 template 也通過（預設 qwen3-chatml）', v2.ok, v2);
const v3 = proto.validate({ type: 'run', id: '1', messages: [], max_tokens: 1, timeout_ms: 0, stream: false, template: 7 });
check('run.template 不是字串時拒絕', !v3.ok, v3);

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
