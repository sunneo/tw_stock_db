'use strict';
// cpu-py 全參數路徑（llm_full_cpu.py）對拍：用同一份工作檔（初始權重、資料列、超參數）跑 20 步，逐步比對 PyTorch 參考（fixture，fp64）的損失；
// 再驗證「存檔→續訓」：前 10 步存檔，載入後跑 10 步，須與不停的 11–20 步一致；存出的檔案用 JS 的 checkpoint_core 驗 sha256 並解碼。
// 需要本機的 Python 與 torch（與 full_param_cpu_py_check.py 相同）。用法：node renderer/src/studio/llm_full_cpu.test.js [python 路徑]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const CK = require('./checkpoint_core.js');
const D = require('./llm_full_data.js');

const PY = process.argv[2] || process.env.FA_PYTHON || 'python';
const HERE = __dirname;
const fx = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'full_param_parity_gqa_qkn_f64.json'), 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-llmfull-'));
let ok = 0, bad = 0;
const check = (name, c, d) => { if (c) { ok++; console.log('ok   ' + name); } else { bad++; console.log('FAIL ' + name + (d === undefined ? '' : ' ' + JSON.stringify(d).slice(0, 300))); } };

// 初始權重：fixture 的 init（JS 名稱：emb、nf、L<l>.<k>）→ fa-f32 params.f32
function initFile() {
  const list = [{ name: 'emb', shape: [fx.init.emb.length], data: Float64Array.from(fx.init.emb) }, { name: 'nf', shape: [fx.init.nf.length], data: Float64Array.from(fx.init.nf) }];
  fx.init.layers.forEach((Lw, l) => ['n1', 'n2', 'Wq', 'Wk', 'Wv', 'Wo', 'qn', 'kn', 'Wg', 'Wu', 'Wd'].forEach((k) => list.push({ name: 'L' + l + '.' + k, shape: [Lw[k].length], data: Float64Array.from(Lw[k]) })));
  const p = path.join(dir, 'params_init.f32'); fs.writeFileSync(p, CK.encodeTensors(list)); return p;
}
const rowsPath = path.join(dir, 'rows.json');
fs.writeFileSync(rowsPath, JSON.stringify(fx.batches));
const initPath = initFile();
const baseJob = D.makeJob({ cfg: fx.cfg, lr: fx.lr, wd: fx.wd, clip: fx.clip, steps: 20, dtype: 'float64' });

function runPy(job, tag) {
  const jp = path.join(dir, 'job_' + tag + '.json');
  fs.writeFileSync(jp, JSON.stringify(job));
  const r = spawnSync(PY, [path.join(HERE, 'llm_full_cpu.py'), '--job', jp], { encoding: 'utf8', timeout: 600000, windowsHide: true });
  if (r.error || r.status !== 0) throw new Error('python 失敗：' + (r.error ? r.error.message : (r.stderr || '').slice(-800)));
  return r.stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

let lines;
try { lines = runPy(Object.assign({}, baseJob, { rows_file: rowsPath, init_file: initPath, out_dir: null }), 'full'); }
catch (e) { console.log('FAIL 執行 cpu-py 腳本：' + e.message); process.exit(1); }
const steps = lines.filter((x) => x.event === undefined && x.step !== undefined);
check('20 步都有輸出（step、loss、ms）', steps.length === 20 && steps.every((s) => typeof s.loss === 'number' && typeof s.ms === 'number'), steps.length);
let worst = 0; steps.forEach((s, i) => { worst = Math.max(worst, Math.abs(s.loss - fx.perStep[i].loss)); });
check('逐步損失與 PyTorch 參考（fp64）差 < 1e-5（20 步）', worst < 1e-5, { worst });

// 存檔 → 續訓
const ckDir = path.join(dir, 'ck10');
const first = runPy(Object.assign({}, baseJob, { steps: 10, rows_file: rowsPath, init_file: initPath, out_dir: ckDir }), 'save10');
check('前 10 步存出檢查點', fs.existsSync(path.join(ckDir, 'ckpt.json')) && first.some((x) => x.event === 'done' && x.ok));
const resumed = runPy(Object.assign({}, baseJob, { steps: 10, rows_file: rowsPath, init_file: initPath, resume_dir: ckDir }), 'resume');
const rs = resumed.filter((x) => x.event === undefined && x.step !== undefined);
let worstR = 0; rs.forEach((s, i) => { worstR = Math.max(worstR, Math.abs(s.loss - fx.perStep[10 + i].loss)); });
check('續訓：第 11–20 步與不停的參考差 < 1e-5', rs.length === 10 && worstR < 1e-5, { worstR, n: rs.length });

// 檢查點格式：JS 的 checkpoint_core 驗 sha256 並解碼；步數與資料位置正確
const ck = JSON.parse(fs.readFileSync(path.join(ckDir, 'ckpt.json'), 'utf8'));
check('ckpt.json 格式 fa-ckpt v1、步數 10、資料位置 10、sha256 三個檔', ck.format === CK.FORMAT && ck.version === CK.VERSION && ck.step === 10 && ck.next_batch === 10 && Object.keys(ck.sha256).length === 3, ck);
const files = {}; ['params.f32', 'opt_m.f32', 'opt_v.f32'].forEach((f) => { files[f] = fs.readFileSync(path.join(ckDir, f)); });
const v = CK.verifyChecksums({ ckpt: ck, files });
check('JS checkpoint_core 驗證 sha256 通過', v.ok, v.bad);
const decoded = CK.decodeTensors(files['params.f32']);
check('params.f32 解碼：20 個參數群、名稱與 JS 一致', decoded.length === 2 + 2 * 11 && decoded.some((t) => t.name === 'emb') && decoded.some((t) => t.name === 'L1.Wd'), decoded.map((t) => t.name));

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + ' 項失敗，' + ok + ' 項通過' : '全部通過（' + ok + ' 項）');
process.exit(bad ? 1 : 0);
