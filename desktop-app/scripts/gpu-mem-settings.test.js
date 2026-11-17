// GPU 記憶體上限接線：設定預設與白名單、Qwen3 GPU 解碼配置前的預算檢查、介面欄位與偵測按鈕、嵌入模組
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const gpu = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/gpu/qwen_gpu.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
ok(/gpuMemMB: 0,/.test(src), '預設 gpuMemMB＝0（自動）');
ok(/gpuMemMB: \(\(\) => \{ const n = Math\.floor\(Number\(raw\.gpuMemMB\)\)/.test(src), '_normalizeAdvancedSettings 白名單有 gpuMemMB');
const m = /gpuMemMB: \(\(\) => \{ (const n = [^}]*?)\}\)\(\),/.exec(src);
const norm = (v) => new Function('raw', m[1].replace(/return /, 'return ') )({ gpuMemMB: v });
ok(m && norm('2048') === 2048 && norm(-1) === 0 && norm('x') === 0 && norm(undefined) === 0, '白名單正規化：字串轉數字、負數與亂碼歸 0');
ok(/id|createElement\('button'\)/.test(src) && /偵測／基準/.test(src) && /GPU 記憶體上限（MB，0＝自動）/.test(src), '介面有數字欄位與「偵測／基準」按鈕');
ok(/_gpuMemProbeRun\(/.test(src) && /fa_gpu_mem_probe/.test(src), '探測結果存 localStorage 快取');
ok(/budgetBytes: bud\.bytes/.test(src) && /e\.code === 'GPU_BUDGET'/.test(src), 'Qwen3 GPU 解碼帶預算，GPU_BUDGET 不標記為壞掉');
ok(/maxT: 1024, maxM: 128/.test(src) && /maxT: 512, maxM: 64/.test(src), '放不下先縮小序列上限');
ok(/code = 'GPU_BUDGET'/.test(gpu) && /estimateEngineBytes\(W, \{ maxT, maxM \}\)/.test(gpu), 'createGpuEngine 配置前先估算並丟 GPU_BUDGET');
ok(/mem: req\('gpu_mem'\)/.test(src) && /MODS\[\\"gpu_mem\\"\]/.test(src), 'gpu_mem 已嵌入 FA_QWEN_SRC');
ok(/budgetBytes: this\.advancedSettings\.gpuMemMB > 0/.test(src), '手動上限也傳給 cudaweb 執行期的緩衝區預算');
console.log(pass + ' 通過 ' + fail + ' 失敗'); process.exit(fail ? 1 : 0);
