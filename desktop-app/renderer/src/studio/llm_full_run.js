(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaLlmFullRun = factory()); })(typeof self !== 'undefined' ? self : this, function () {
'use strict';
// llm_full 的 cudaweb 訓練迴圈（純函式核心）：GPU 相關函式由呼叫端注入（fullParamStepDevice、makeResidentState、readResident、loadResident），
// 所以這個檔在 node 可測；真的 WebGPU 由 Electron 實測負責。
// 設計：與 cpu-py（llm_full_cpu.py）讀同一份工作檔（初始權重、資料列、超參數）；每步 {step, loss, ms}；檢查點 fa-ckpt（params／opt_m／opt_v 三個 fa-f32 檔＋ckpt.json）。
const CKPT_FORMAT = 'fa-ckpt', CKPT_VERSION = 1;

// 資料位置：第 k 步（從 1 起算）用列 (next_batch + k - 1) mod n
function batchIndex(nextBatch, k, n) { return (nextBatch + k - 1) % n; }

// 由 GPU 快照（{P,M,V}：名稱 → Float32Array）組出檢查點檔案與 ckpt.json（format 與 cpu-py 相同）
function packCheckpoint(o) {
  const { snap, encodeTensors, sha256, step, nextBatch, job, producedBy } = o;
  const toList = (m) => Object.keys(m).sort().map((k) => ({ name: k, shape: [m[k].length], data: m[k] }));
  const files = {
    'params.f32': encodeTensors(toList(snap.P)),
    'opt_m.f32': encodeTensors(toList(snap.M)),
    'opt_v.f32': encodeTensors(toList(snap.V)),
  };
  const sha = {}; Object.keys(files).forEach((f) => { sha[f] = sha256(files[f]); });
  const ckpt = {
    format: CKPT_FORMAT, version: CKPT_VERSION, step: step, next_batch: nextBatch, dtype: 'float32', cfg: job.cfg,
    optimizer: { name: 'adamw', lr: job.lr, b1: 0.9, b2: 0.999, eps: 1e-8, wd: job.wd, clip: job.clip },
    sha256: sha, produced_by: producedBy || 'llm_full_run.js(cudaweb)',
  };
  return { ckpt, files };
}

// 跑 steps 步（可續訓：resumeSnap 給定時先 loadResident，並從 nextBatch 接續）。
// 回傳 { records:[{step,loss,ms}], nextBatch, step, checkpoint? }
async function runCudaweb(o) {
  const { job, rows, nn, device, cfg, init, fullParamStep, makeResidentState, readResident, loadResident, onStep, resumeCkpt, saveCheckpoint, sha256, encodeTensors, decodeTensors } = o;
  if (!rows || !rows.length) throw new Error('llm_full：沒有資料列');
  const S = makeResidentState(device, cfg, resumeCkpt ? null : init);
  let startStep = 0, nextBatch = 0;
  if (resumeCkpt) {
    const v = validate(resumeCkpt, sha256);
    if (!v.ok) throw new Error('檢查點拒絕載入：' + v.errors.join('；'));
    const snap = { P: toMap(resumeCkpt.files['params.f32'], decodeTensors), M: toMap(resumeCkpt.files['opt_m.f32'], decodeTensors), V: toMap(resumeCkpt.files['opt_v.f32'], decodeTensors) };
    snap.t = resumeCkpt.ckpt.step; // Adam 的步數（偏差修正用），必須接續
    loadResident(device, S, snap);
    startStep = resumeCkpt.ckpt.step; nextBatch = resumeCkpt.ckpt.next_batch;
  }
  const records = [];
  for (let k = 1; k <= job.steps; k++) {
    const idx = batchIndex(nextBatch, k, rows.length);
    const r = await fullParamStep({ nn, device, state: S, seqs: [rows[idx]], lr: job.lr, wd: job.wd, clip: job.clip });
    const rec = { step: startStep + k, loss: r.loss, ms: Math.round(r.ms * 1000) / 1000 };
    records.push(rec);
    if (onStep) onStep(rec);
  }
  const outNext = nextBatch + job.steps;
  let checkpoint = null;
  if (saveCheckpoint) {
    const snap = await readResident(device, S);
    checkpoint = packCheckpoint({ snap, encodeTensors, sha256, step: startStep + job.steps, nextBatch: outNext, job });
  }
  return { records, step: startStep + job.steps, nextBatch: outNext, checkpoint };
}

function toMap(buf, decodeTensors) { const m = {}; decodeTensors(buf).forEach((t) => { m[t.name] = t.data; }); return m; }

// 續訓前的檢查：格式、版本、三個檔的 sha256
function validate(resumeCkpt, sha256) {
  const errors = [];
  const ck = resumeCkpt && resumeCkpt.ckpt;
  if (!ck || ck.format !== CKPT_FORMAT) errors.push('format 不是 ' + CKPT_FORMAT);
  else if (ck.version !== CKPT_VERSION) errors.push('version ' + ck.version + ' 不是 ' + CKPT_VERSION);
  ['params.f32', 'opt_m.f32', 'opt_v.f32'].forEach((f) => {
    if (!resumeCkpt.files || !resumeCkpt.files[f]) errors.push(f + '（檔案不見）');
    else if (sha256 && resumeCkpt.ckpt && resumeCkpt.ckpt.sha256 && sha256(resumeCkpt.files[f]) !== resumeCkpt.ckpt.sha256[f]) errors.push(f + '（sha256 不符）');
  });
  return { ok: errors.length === 0, errors };
}

return { CKPT_FORMAT, CKPT_VERSION, batchIndex, packCheckpoint, runCudaweb, validate, toMap };
});
