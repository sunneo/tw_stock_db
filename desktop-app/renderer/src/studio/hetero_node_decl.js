(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaHeteroNodeDecl = factory(); })(typeof self !== 'undefined' ? self : this, function () {
'use strict';
// 群組訓練節點的資料結構與宣告格式（P8 的 8.1、8.2 的資料部分；不做 UI、不做派工、不做網路）。
// 一台機器「勾選分享為訓練節點」後，對群組廣播這份宣告；其他人據此知道它能接多少工作。
// 規則：每個能力數字都必須是實測值，並附量測時間（measuredAt，ISO 字串）；沒量到的欄位寫 null，不用規格推估。
// 過期（超過 maxAgeMs，預設 24 小時）的宣告不算可用節點，避免拿舊數字派工。
//
//   SCHEMA = 'fa.train-node/1'
//   makeDecl({ nodeId, label, capabilities, now }) → 宣告（enabled 預設 false：明確選擇加入）
//   validateDecl(decl) → [錯誤字串]（空陣列＝格式正確）
//   isEligible(decl, now, maxAgeMs?) → { ok, why }
//   setEnabled(decl, enabled, now, busy?) → 新宣告；停用時若正在做工作，狀態為 'stopping'（之後依 8.2 安全交還），否則 'off'
//   eligibleNodes(decls, now, maxAgeMs?) → 可派工的節點（依 nodeId 排序）
//   nodeRatios(decls, now) → { nodeId: 實測 cpu gflops }（可派工節點；hetero_resources.sharesFromRates 會正規化成比例）

const SCHEMA = 'fa.train-node/1';
const DEFAULT_MAX_AGE_MS = 24 * 3600 * 1000;
const isPos = (x) => typeof x === 'number' && isFinite(x) && x > 0;

function measuredField(v, label, errs) {
  // 欄位格式：null（沒量到）或 { value, measuredAt, source:'measured' }
  if (v === null || v === undefined) return;
  if (typeof v !== 'object' || !isPos(v.value)) { errs.push(label + '：數值不合理'); return; }
  if (v.source !== 'measured') errs.push(label + '：來源必須是 measured');
  if (typeof v.measuredAt !== 'string' || isNaN(Date.parse(v.measuredAt))) errs.push(label + '：缺少量測時間');
}

function makeDecl(o) {
  const c = o.capabilities || {};
  return {
    schema: SCHEMA,
    nodeId: String(o.nodeId || ''),
    label: o.label ? String(o.label) : null,
    enabled: false,
    status: 'off',
    announcedAt: o.now ? new Date(o.now).toISOString() : null,
    capabilities: {
      cpu: c.cpu === undefined ? null : c.cpu,           // { value: 實測 gflops, measuredAt, source:'measured' }
      cudaweb: c.cudaweb === undefined ? null : c.cudaweb, // { value: 實測 matmul gflops, ... }
      memGB: c.memGB === undefined ? null : c.memGB,
    },
  };
}

function validateDecl(d) {
  const errs = [];
  if (!d || typeof d !== 'object') return ['宣告不是物件'];
  if (d.schema !== SCHEMA) errs.push('schema 不符');
  if (!d.nodeId) errs.push('缺少 nodeId');
  if (typeof d.enabled !== 'boolean') errs.push('enabled 必須是布林');
  if (['off', 'on', 'stopping'].indexOf(d.status) < 0) errs.push('status 不合法');
  if (d.enabled && d.status === 'off') errs.push('已勾選但狀態為 off');
  if (!d.enabled && d.status === 'on') errs.push('未勾選但狀態為 on');
  const c = d.capabilities || {};
  measuredField(c.cpu, 'cpu', errs);
  measuredField(c.cudaweb, 'cudaweb', errs);
  measuredField(c.memGB, 'memGB', errs);
  return errs;
}

function isEligible(d, now, maxAgeMs) {
  const errs = validateDecl(d);
  if (errs.length) return { ok: false, why: errs[0] };
  if (!d.enabled || d.status !== 'on') return { ok: false, why: '未勾選分享' };
  const at = Date.parse(d.announcedAt || '');
  if (isNaN(at)) return { ok: false, why: '缺少宣告時間' };
  if ((now || Date.now()) - at > (maxAgeMs || DEFAULT_MAX_AGE_MS)) return { ok: false, why: '宣告過期' };
  const cap = d.capabilities || {};
  if (!cap.cpu && !cap.cudaweb) return { ok: false, why: '沒有可用的實測能力' };
  return { ok: true, why: null };
}

function setEnabled(d, enabled, now, busy) {
  const next = Object.assign({}, d, { enabled: !!enabled });
  if (enabled) { next.status = 'on'; next.announcedAt = new Date(now || Date.now()).toISOString(); }
  else next.status = busy ? 'stopping' : 'off';
  return next;
}

function eligibleNodes(decls, now, maxAgeMs) {
  return (decls || []).filter((d) => isEligible(d, now, maxAgeMs).ok).sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
}

function nodeRatios(decls, now, maxAgeMs) {
  const out = {};
  for (const d of eligibleNodes(decls, now, maxAgeMs)) {
    const g = d.capabilities.cpu ? d.capabilities.cpu.value : null;
    if (g) out[d.nodeId] = g;
  }
  return out;
}

return { SCHEMA, DEFAULT_MAX_AGE_MS, makeDecl, validateDecl, isEligible, setEnabled, eligibleNodes, nodeRatios };
});
