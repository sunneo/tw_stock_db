'use strict';
// model_types_core 的 cudaweb 閘門：dense 覆蓋完整→列出；moe、推理缺項→不列出並寫出缺項；沒有 cudaweb 路徑的類型→不列出。
const M = require('./model_types_core.js');
const COV = require('./cudaweb_coverage.js');
let fail = 0; const ok = (c, n, extra) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };
const dense = M.cudawebGate('llm_scratch', 'dense', COV);
ok(dense.listed === true && dense.missing.length === 0, 'llm_scratch 密集 → cudaweb 列出（覆蓋完整）', 'kind=' + dense.kind);
const moe = M.cudawebGate('llm_scratch', 'moe', COV);
ok(moe.listed === false && moe.missing.length === 4, 'llm_scratch 專家混合 → 不列出，缺項逐一列出', 'missing=' + moe.missing.length);
ok(moe.reason.indexOf('全有或全無') >= 0, 'MoE 原因寫明全有或全無');
const rs = M.cudawebGate('llm_scratch', 'reasoning', COV);
ok(rs.listed === false && rs.missing.indexOf('自回歸取樣（sample_cached）') >= 0, '推理 → 不列出，缺取樣');
const music = M.cudawebGate('music', 'lora', COV);
ok(music.listed === false && /沒有 cudaweb 訓練路徑/.test(music.reason), '沒有 cudaweb 路徑的類型 → 不列出');
ok(M.cudawebGate('nope', 'dense', COV).listed === false, '未知類型 → 不列出');
console.log(fail === 0 ? '全部通過' : fail + ' 項失敗');
process.exit(fail === 0 ? 0 : 1);
