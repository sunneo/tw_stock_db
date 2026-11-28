'use strict';
// 全有或全無（§4f）：dense 與 gqa_qkn 全參數訓練在 GPU 覆蓋完整；MoE、推理／GRPO 缺項必須逐一列出；未知種類不完整。
const C = require('./cudaweb_coverage.js');
let fail = 0; const ok = (c, n, extra) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };

const dense = C.coverageFor('dense-full-param');
ok(dense.complete === true && dense.missing.length === 0, 'dense 全參數：GPU 覆蓋完整（真機對拍已通過）', 'onGpu=' + dense.onGpu + '/' + dense.total);
ok(C.reasonFor('dense-full-param') === '', 'dense 覆蓋完整時沒有缺項原因');

const moe = C.coverageFor('moe-full-param');
ok(moe.complete === false && moe.missing.length === 4, 'MoE 缺項逐一列出（路由、稀疏分派、專家矩陣乘、輔助損失）', 'missing=' + moe.missing.join('、'));
ok(C.reasonFor('moe-full-param').indexOf('全有或全無') >= 0, 'MoE 原因說明全有或全無，不退回 CPU');

const grpo = C.coverageFor('reasoning-grpo');
ok(grpo.complete === false && grpo.missing.indexOf('自回歸取樣（sample_cached）') >= 0, '推理／GRPO 缺取樣與策略梯度');

ok(C.coverageFor('no-such').complete === false, '未知種類不完整');
// 判定規則：只有全部 gpu 為 true 才完整（用假清單）
const allGpu = C.DENSE_FULL_PARAM_OPS.every((o) => o.gpu === true);
ok(allGpu === true, '判定規則：dense 清單每一項都標 gpu:true');
console.log(fail === 0 ? '全部通過' : fail + ' 項失敗');
process.exit(fail === 0 ? 0 : 1);
