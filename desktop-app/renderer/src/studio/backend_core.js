'use strict';
// 運算後端統一介面與登錄表（DESIGN.TODO.offline-training-studio.md §5.3）。純核心、依賴注入、不碰 window。
const BACKEND_IDS = ['cpu-js', 'cpu-py', 'webgpu', 'directml', 'vulkan'];
const SYMBOLIC_KINDS = ['trainer', 'colu', 'uml', 'blockly', 'matrix'];
// 每個 kind 宣告支援的後端；lora 的清單是「可能」，實際是否點亮由 probe＋基準測試決定。符號式五類只有 cpu-js。
const KIND_BACKENDS = { trainer: ['cpu-js'], colu: ['cpu-js'], uml: ['cpu-js'], blockly: ['cpu-js'], matrix: ['cpu-js'], lora: ['cpu-py', 'webgpu', 'directml', 'vulkan'] };
// 「自動」同速（差 <10%）時偏好較成熟者：cpu-py > vulkan > directml > webgpu（cpu-js 只服務符號式，排最前）
const MATURITY = ['cpu-js', 'cpu-py', 'vulkan', 'directml', 'webgpu'];

const REQUIRED_METHODS = ['probe', 'benchmark', 'init', 'step', 'evalLoss', 'saveCheckpoint', 'loadCheckpoint', 'dispose'];

// probe 結果形狀：不丟例外；available 為 false 時 reason 必須是給使用者看的具體原因
function probeResult(available, reason, device, fingerprint) {
  const r = { available: !!available, device: device || { name: '' }, fingerprint: fingerprint || {} };
  if (reason) r.reason = String(reason);
  return r;
}
function validateProbeResult(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['probe 沒回物件'];
  if (typeof r.available !== 'boolean') errs.push('available 必須是 boolean');
  if (!r.available && (typeof r.reason !== 'string' || !r.reason)) errs.push('不可用時必須有 reason');
  if (!r.device || typeof r.device !== 'object') errs.push('缺 device');
  if (!r.fingerprint || typeof r.fingerprint !== 'object') errs.push('缺 fingerprint');
  return errs;
}
// 介面型別檢查：id 合法、方法齊全；capabilities 標明「逐步呼叫」或「整段子行程」
function validateBackend(b) {
  const errs = [];
  if (!b || typeof b !== 'object') return ['不是物件'];
  if (BACKEND_IDS.indexOf(b.id) < 0) errs.push('id 不在 ' + BACKEND_IDS.join('／'));
  REQUIRED_METHODS.forEach((m) => { if (typeof b[m] !== 'function') errs.push('缺方法 ' + m); });
  if (!b.capabilities || typeof b.capabilities.perStep !== 'boolean') errs.push('缺 capabilities.perStep');
  return errs;
}
// 保證 probe 不丟例外（後端自己寫壞時也不拖垮 UI）
async function safeProbe(b, ctx) {
  try { const r = await b.probe(ctx); const e = validateProbeResult(r); return e.length ? probeResult(false, '後端 ' + b.id + ' 的 probe 回傳格式不合：' + e.join('；')) : r; }
  catch (e) { return probeResult(false, '後端 ' + b.id + ' 的 probe 發生例外：' + (e && e.message || e)); }
}

class BackendRegistry {
  constructor() { this.map = new Map(); }
  register(b) { const e = validateBackend(b); if (e.length) throw new Error('後端不合介面：' + e.join('；')); this.map.set(b.id, b); return this; }
  get(id) { return this.map.get(id) || null; }
  ids() { return Array.from(this.map.keys()); }
  supportedFor(kind) { return (KIND_BACKENDS[kind] || []).slice(); }
  // 某 kind 的後端清單（含未登錄者的說明，供 UI 灰掉並顯示原因）
  async listFor(kind, ctx) {
    const out = [];
    for (const id of this.supportedFor(kind)) {
      const b = this.get(id);
      if (!b) { out.push({ id, available: false, reason: '後端 ' + id + ' 沒有登錄', probe: null }); continue; }
      const p = await safeProbe(b, ctx); out.push({ id, available: p.available, reason: p.reason || '', probe: p });
    }
    return out;
  }
}
const isSymbolicKind = (k) => SYMBOLIC_KINDS.indexOf(k) >= 0;
const maturityRank = (id) => { const i = MATURITY.indexOf(id); return i < 0 ? 99 : i; };

module.exports = { BACKEND_IDS, SYMBOLIC_KINDS, KIND_BACKENDS, MATURITY, REQUIRED_METHODS, probeResult, validateProbeResult, validateBackend, safeProbe, BackendRegistry, isSymbolicKind, maturityRank };
