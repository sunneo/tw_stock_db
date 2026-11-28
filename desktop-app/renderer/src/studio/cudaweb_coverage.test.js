'use strict';
// 全有或全無：dense-full-param 目前缺項必須被列出；未知種類必須不完整。
const C = require('./cudaweb_coverage.js');
let fail = 0; const ok = (c, n, extra) => { if (!c) fail++; console.log((c ? 'ok   ' : 'FAIL ') + n + (extra ? '  ' + extra : '')); };
const c = C.coverageFor('dense-full-param');
ok(c.complete === false, '全參數密集訓練目前不完整（缺反向逐元素等，不能假裝 GPU 全覆蓋）', 'missing=' + c.missing.length + '/' + c.total);
ok(c.missing.includes('RMSNorm 反向（含增益梯度）') && c.missing.includes('注意力 QKᵀ 與 PV 小矩陣乘'), '缺項逐一列出（含 RMSNorm 反向、注意力小矩陣乘）');
ok(C.reasonFor('dense-full-param').indexOf('全有或全無') >= 0, '原因文字說明全有或全無，不退回 CPU');
ok(C.coverageFor('no-such').complete === false, '未知種類不完整');
// 全部在 GPU 時才 complete（用假清單驗證判定規則）
const fake = C.DENSE_FULL_PARAM_OPS.map((o) => Object.assign({}, o, { gpu: true }));
const allGpu = { complete: fake.filter((o) => !o.gpu).length === 0 };
ok(allGpu.complete === true, '所有運算都在 GPU 時判定為完整（規則本身）');
console.log(fail === 0 ? '全部通過' : fail + ' 項失敗');
process.exit(fail === 0 ? 0 : 1);
