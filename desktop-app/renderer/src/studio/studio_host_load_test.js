'use strict';
// 主行程工作室宿主的載入測試：模擬 embed-code-ui.js 的 HOST 扁平打包（只有 renderer/src/studio 的檔案、沒有 ../gpu/），
// 載入 studio_host 相依的 backend_cudaweb.js 與其相依，不得丟 Cannot find module。
// 回歸來源：46e9a8918 把 backend_cudaweb 放進 HOST，3a9ba1d14 在檔頭 require('../gpu/nn_ops.js')，主行程扁平套件找不到。
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname);
// 與 scripts/embed-code-ui.js 的 HOST 清單一致（主行程端扁平打包的檔案）
const HOST = ['backend_core', 'bench_core', 'backend_cpu_js', 'backend_cpu_py', 'backend_planned', 'backend_cudaweb', 'cudaweb_coverage', 'checkpoint_core', 'studio_config_core', 'llm_export_core', 'asset_core', 'ext_job_core', 'llm_scratch_core', 'studio_host'];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-host-load-'));
let fails = 0;
const check = (name, ok, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); if (!ok) fails++; };
try {
  for (const n of HOST) fs.copyFileSync(path.join(SRC, n + '.js'), path.join(dir, n + '.js'));
  // 扁平打包：沒有 ../gpu 目錄（與正式主行程套件一樣）
  let loaded = null, err = null;
  try { loaded = require(path.join(dir, 'backend_cudaweb.js')); } catch (e) { err = e; }
  check('主行程扁平套件載入 backend_cudaweb.js 不丟 module not found', !!loaded && !err, err && String(err.message).split('\n')[0]);
  if (loaded) {
    const be = loaded.createCudawebBackend({});
    check('建立 cudaweb 後端物件', !!be && be.id === 'cudaweb');
    const p = be.probe({ kind: 'lora' });
    check('probe 不因缺少 GPU 模組失敗（回傳 Promise）', p && typeof p.then === 'function');
    p.then((r) => {
      check('主行程 probe 回傳格式（available 布林、有 reason）', r && typeof r.available === 'boolean' && typeof r.reason === 'string', r);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(fails ? fails + ' 項失敗' : '全部通過');
      process.exit(fails ? 1 : 0);
    }, (e) => { check('probe 不丟例外', false, String(e && e.message)); process.exit(1); });
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(fails + ' 項失敗');
    process.exit(1);
  }
} catch (e) { console.log('FAIL ' + String(e && e.message)); process.exit(1); }
