'use strict';
// 規範化 float32 檢查點（DESIGN.TODO.offline-training-studio.md §3.1）：與後端無關的暫停／續訓格式。
// 純核心、不碰 window／檔案系統：檔案以 { 檔名: Buffer } 表示，由呼叫端決定存到記憶體或資料夾。
const crypto = require('crypto');

const FORMAT = 'fa-ckpt', VERSION = 1;
const TENSOR_FILES = ['lora_A.f32', 'lora_B.f32', 'opt_m.f32', 'opt_v.f32'];
// 續訓相容欄位：任一不符就拒絕續訓、提示以新資產 fork（後端與裝置不在其中，允許不同，只記錄）
const COMPAT_FIELDS = ['base', 'base_sha256', 'rank', 'alpha', 'target_modules', 'prompt_format_version', 'tool_catalog_sha256'];
const TOL = { sameBackend: 1e-5, crossBackend: 0.02, crossBackendFp16: 0.05 };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- 與後端無關的亂數：PCG32（標準 XSH-RR 輸出，64 位元狀態用 BigInt） ----
const M64 = (1n << 64n) - 1n, MULT = 6364136223846793005n;
class PCG32 {
  constructor(seed, seq) {
    this.inc = ((BigInt(seq === undefined ? 54 : seq) << 1n) | 1n) & M64; this.state = 0n; this._adv();
    this.state = (this.state + BigInt.asUintN(64, BigInt(seed))) & M64; this._adv();
  }
  _adv() { this.state = (this.state * MULT + this.inc) & M64; }
  nextU32() {
    const old = this.state; this._adv();
    const xs = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn), rot = Number(old >> 59n);
    return ((xs >>> rot) | (xs << ((32 - rot) & 31))) >>> 0;
  }
  nextFloat() { return this.nextU32() / 4294967296; }                       // [0,1)
  nextBelow(n) { const th = (4294967296 - n) % n; for (;;) { const r = this.nextU32(); if (r >= th) return r % n; } }   // 無偏差
  nextNormal() { const u = this.nextFloat() || 1e-12, v = this.nextFloat(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  snapshot() { return { algo: 'pcg32', state: this.state.toString(), inc: this.inc.toString() }; }
  static fromSnapshot(s) { const g = new PCG32(0, 0); g.state = BigInt(s.state); g.inc = BigInt(s.inc); return g; }
}
function shuffleIndices(n, seed) {
  const a = Array.from({ length: n }, (_, i) => i), g = new PCG32(seed, 7);
  for (let i = n - 1; i > 0; i--) { const j = g.nextBelow(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

// ---- 資料游標：順序由 order_seed＋epoch 決定，可重現 ----
function createCursor(orderSeed) { return { shard: 0, offset: 0, order_seed: orderSeed, epoch: 0, consumed_tokens: 0 }; }
function nextIndices(cursor, n, batchSize) {      // 回傳 {indices, cursor}（不改原物件）
  const c = Object.assign({}, cursor), out = [];
  let order = shuffleIndices(n, c.order_seed + c.epoch * 1000003);
  for (let k = 0; k < batchSize; k++) {
    if (c.offset >= n) { c.epoch++; c.offset = 0; order = shuffleIndices(n, c.order_seed + c.epoch * 1000003); }
    out.push(order[c.offset++]);
  }
  return { indices: out, cursor: c };
}

// ---- 張量檔：4 位元組小端檔頭長度＋JSON 檔頭（依名稱排序的 shape 表）＋小端 float32 資料 ----
function encodeTensors(list) {
  const sorted = list.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let off = 0;
  const meta = sorted.map((t) => { const len = t.data.length, m = { name: t.name, shape: t.shape || [len], offset: off, length: len }; off += len; return m; });
  const head = Buffer.from(JSON.stringify({ format: 'fa-f32', tensors: meta }), 'utf8');
  const out = Buffer.alloc(4 + head.length + off * 4); out.writeUInt32LE(head.length, 0); head.copy(out, 4);
  let p = 4 + head.length; sorted.forEach((t) => { for (let i = 0; i < t.data.length; i++) { out.writeFloatLE(t.data[i], p); p += 4; } });
  return out;
}
function decodeTensors(buf) {
  const hl = buf.readUInt32LE(0), head = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8')), base = 4 + hl;
  if (head.format !== 'fa-f32') throw new Error('不是 fa-f32 張量檔');
  return head.tensors.map((m) => { const d = new Float32Array(m.length); for (let i = 0; i < m.length; i++) d[i] = buf.readFloatLE(base + (m.offset + i) * 4); return { name: m.name, shape: m.shape, data: d }; });
}

// ---- 組裝／驗證 ----
// tensors: { 'lora_A.f32': [{name,shape,data}], ... }；缺的檔（例如 cpu-py 拿不到優化器張量）寫進 missing_files，不假裝有
function makeCheckpoint(o) {
  const files = {}, missing = [];
  TENSOR_FILES.forEach((f) => { const t = o.tensors && o.tensors[f]; if (t && t.length) files[f] = encodeTensors(t); else missing.push(f); });
  const sha = {}; Object.keys(files).forEach((f) => { sha[f] = sha256(files[f]); });
  const ckpt = {
    format: FORMAT, version: VERSION, step: o.step, epoch: o.epoch || 0, dtype: 'float32',
    cursor: o.cursor, rng: o.rng, optimizer: o.optimizer, data_sha256: o.data_sha256, compat: o.compat,
    produced_by: o.produced_by, loss_tail: (o.loss_tail || []).slice(-50), eval_check: o.eval_check || null, sha256: sha, missing_files: missing,
  };
  return { ckpt, files };
}
function verifyChecksums(cp) {
  const bad = [];
  Object.keys(cp.ckpt.sha256 || {}).forEach((f) => { if (!cp.files[f]) bad.push(f + '（檔案不見）'); else if (sha256(cp.files[f]) !== cp.ckpt.sha256[f]) bad.push(f + '（sha256 不符）'); });
  return { ok: bad.length === 0, bad };
}
function validateCkptJson(c) {
  const errs = [];
  if (!c || c.format !== FORMAT) errs.push('format 不是 ' + FORMAT);
  else if (c.version !== VERSION) errs.push('version ' + c.version + ' 不是 ' + VERSION + '（舊版要先遷移，目前沒有遷移器）');
  ['step', 'cursor', 'rng', 'optimizer', 'data_sha256', 'compat', 'produced_by'].forEach((k) => { if (c && c[k] === undefined) errs.push('缺欄位 ' + k); });
  if (c && c.dtype !== 'float32') errs.push('dtype 必須是 float32');
  if (c && c.rng && c.rng.algo !== 'pcg32') errs.push('rng.algo 必須是 pcg32');
  return { ok: errs.length === 0, errors: errs };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// 相容性：不符一律拒絕、提示 fork。cur = { compat, data_sha256, optimizer:{kind} }
function checkCompat(ckpt, cur) {
  const v = validateCkptJson(ckpt);
  if (!v.ok) return { ok: false, mismatches: v.errors.map((e) => ({ field: 'format', detail: e })), action: 'reject', message: '檢查點格式不合：' + v.errors.join('；') };
  const m = [];
  COMPAT_FIELDS.forEach((f) => { if (!same(ckpt.compat[f], (cur.compat || {})[f])) m.push({ field: 'compat.' + f, checkpoint: ckpt.compat[f], current: (cur.compat || {})[f] }); });
  if (ckpt.data_sha256 !== cur.data_sha256) m.push({ field: 'data_sha256', checkpoint: ckpt.data_sha256, current: cur.data_sha256 });
  if ((ckpt.optimizer && ckpt.optimizer.kind) !== (cur.optimizer && cur.optimizer.kind)) m.push({ field: 'optimizer.kind', checkpoint: ckpt.optimizer && ckpt.optimizer.kind, current: cur.optimizer && cur.optimizer.kind });
  return m.length
    ? { ok: false, mismatches: m, action: 'fork', message: '相容欄位不符（' + m.map((x) => x.field).join('、') + '）：不能續訓，請以新資產 fork（parent 記來源）' }
    : { ok: true, mismatches: [], action: 'resume' };
}

// ---- 數值比對 ----
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
function compareLoss(a, b, o) {                       // 跨後端：續訓前以 eval_batch 比對；半精度放寬到 5%
  o = o || {}; const tol = o.tol !== undefined ? o.tol : (o.fp16 ? TOL.crossBackendFp16 : TOL.crossBackend);
  const relErr = rel(a, b); return { ok: Number.isFinite(relErr) && relErr <= tol, relErr, tol };
}
function maxRelDiff(xs, ys) { if (xs.length !== ys.length) return Infinity; let m = 0; for (let i = 0; i < xs.length; i++) m = Math.max(m, rel(xs[i], ys[i])); return m; }
function compareSameBackendRun(xs, ys, tol) { tol = tol === undefined ? TOL.sameBackend : tol; const d = maxRelDiff(xs, ys); return { ok: d <= tol, maxRelErr: d, tol }; }
function trendWarning(lossTail, newLosses) {          // 只警示，不當拒絕條件
  if (!lossTail || !lossTail.length || !newLosses || !newLosses.length) return { warn: false };
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length, a = mean(lossTail), b = mean(newLosses);
  return { warn: !(b <= a * 1.5), tailMean: a, newMean: b };
}
// 續訓紀錄（§3.1 第 3 點）
function resumeRecord(ckpt, toBackend, evalResult) {
  return { at: 'resume', from: ckpt.produced_by.backend, to: toBackend, step: ckpt.step, sameBackend: ckpt.produced_by.backend === toBackend, evalCheck: evalResult || null,
    text: '由 ' + ckpt.produced_by.backend + ' 後端暫停、' + toBackend + ' 後端續訓（step=' + ckpt.step + '）' };
}

module.exports = { FORMAT, VERSION, TENSOR_FILES, COMPAT_FIELDS, TOL, sha256, PCG32, shuffleIndices, createCursor, nextIndices, encodeTensors, decodeTensors, makeCheckpoint, verifyChecksums, validateCkptJson, checkCompat, rel, compareLoss, maxRelDiff, compareSameBackendRun, trendWarning, resumeRecord };
