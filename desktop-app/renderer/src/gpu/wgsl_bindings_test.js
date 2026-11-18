// node renderer/src/gpu/wgsl_bindings_test.js
// 靜態檢查：每個匯出的 WGSL 核心，宣告的每個綁定都必須在本體被使用。
// 原因：pipeline 用 layout 'auto'，未使用的綁定不進 bind group layout；綁了它就是驗證錯誤，整個提交被拒、讀回全是 0。
// 假裝置不檢查這件事（所以這個測試要靠靜態掃描補上）。
'use strict';
const assert = require('assert');
const NN = require('./nn_ops.js');
const TF = require('./train_fused.js');
const TS = require('./train_step_device.js');

const kernels = {
  ATTN_FWD: TS.WGSL_ATTN_FWD, ATTN_BWD_KV: TS.WGSL_ATTN_BWD_KV, ATTN_BWD_Q: TS.WGSL_ATTN_BWD_Q,
  RMS_BWD: TS.WGSL_RMS_BWD, MLP_BWD: TS.WGSL_MLP_BWD, CAST16: TS.WGSL_CAST16,
  ADAMW_ACCUM: TF.WGSL_ADAMW_ACCUM, CE: NN.WGSL_CE, AXPY: NN.WGSL_AXPY_B, MUL: NN.WGSL_MUL_B, SCAL: NN.WGSL_SCAL_B,
  RMSNORM: NN.WGSL_RMSNORM, SILU: NN.WGSL_SILU, ROPE: NN.WGSL_ROPE, ADAMW: NN.WGSL_ADAMW,
};

let pass = 0, fail = 0;
for (const [name, code] of Object.entries(kernels)) {
  try {
    assert.ok(typeof code === 'string' && code.length > 0, '沒有匯出 WGSL');
    const decl = [...code.matchAll(/@binding\((\d+)\)\s+var(?:<[^>]*>)?\s+(\w+)\s*:/g)];
    assert.ok(decl.length > 0, '找不到綁定宣告');
    for (const m of decl) {
      const id = m[2];
      const uses = (code.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((w) => w === id).length;
      assert.ok(uses >= 2, '綁定 ' + m[1] + '（' + id + '）宣告了但本體沒用到');
    }
    // 綁定編號必須連續從 0 開始（auto layout 與派發順序都依賴這點）
    const ids = decl.map((m) => Number(m[1])).sort((a, b) => a - b);
    ids.forEach((v, i) => assert.strictEqual(v, i, '綁定編號不連續：' + ids.join(',')));
    pass++; console.log('ok   ' + name + '：' + decl.length + ' 個綁定皆被使用、編號連續');
  } catch (e) { fail++; console.log('FAIL ' + name + '：' + ((e && e.message) || e)); }
}
console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
process.exitCode = fail ? 1 : 0;
