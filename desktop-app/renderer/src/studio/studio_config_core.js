'use strict';
// Studio 的 Configure 設定模型（純核心，不碰 window）：GUI 依 SCHEMA 畫欄位、存取由呼叫端負責，這裡只負責正規化、驗證與換算。
// 目前欄位：訓練／基準使用的處理器核心數（自動＝總核心數−1，至少 1）、是否降低優先權。
const SCHEMA = [
  { key: 'cpuCores', type: 'int|auto', default: 'auto', label: '訓練使用的處理器核心數', help: '自動＝總核心數−1（留一個給你用電腦）。設成全部核心訓練會比較快，但電腦會明顯變卡。', min: 1, appliesTo: ['cpu-py', 'cpu-js'] },
  { key: 'lowPriority', type: 'bool', default: true, label: '以較低優先權執行訓練', help: '讓你操作其他程式時訓練自動讓路。' },
  { key: 'benchmarkCoresCap', type: 'bool', default: true, label: '基準測試也遵守核心數上限', help: '關閉後基準測試可用到上面設定以外的核心（不建議）。' },
];
const DEFAULTS = SCHEMA.reduce((o, s) => { o[s.key] = s.default; return o; }, {});

// 正規化＋驗證：回 { config, errors[], warnings[] }；錯誤欄位退回預設並說明，不丟例外
function normalize(input, totalCores) {
  const cfg = Object.assign({}, DEFAULTS), errors = [], warnings = [], n = Math.max(1, totalCores | 0 || 1); input = input || {};
  if (input.cpuCores !== undefined && input.cpuCores !== 'auto') {
    const v = typeof input.cpuCores === 'string' && /^\s*\d+\s*$/.test(input.cpuCores) ? parseInt(input.cpuCores, 10) : input.cpuCores;
    if (!Number.isInteger(v) || v < 1) errors.push('cpuCores 必須是 1 以上的整數或 auto，收到 ' + JSON.stringify(input.cpuCores) + '，已改用 auto');
    else if (v > n) { cfg.cpuCores = n; warnings.push('設定的核心數 ' + v + ' 超過這台電腦的 ' + n + ' 個，已改成 ' + n); }
    else cfg.cpuCores = v;
  }
  if (cfg.cpuCores !== 'auto' && cfg.cpuCores >= n && n > 1) warnings.push('用掉全部 ' + n + ' 個核心：訓練時電腦會明顯變卡，建議至少留 1 個');
  ['lowPriority', 'benchmarkCoresCap'].forEach((k) => { if (input[k] !== undefined) { if (typeof input[k] === 'boolean') cfg[k] = input[k]; else errors.push(k + ' 必須是 true／false，已用預設值'); } });
  return { config: cfg, errors, warnings };
}
// 換算實際執行緒數：auto＝N−1（至少 1）；基準測試若啟用上限，不超過 N−1 與使用者設定兩者中較小者
function resolveThreads(config, totalCores, purpose) {
  const n = Math.max(1, totalCores | 0 || 1), auto = Math.max(1, n - 1), c = Object.assign({}, DEFAULTS, config || {});
  const want = c.cpuCores === 'auto' ? auto : Math.min(n, Math.max(1, c.cpuCores | 0));
  return purpose === 'benchmark' && c.benchmarkCoresCap ? Math.min(want, auto) : want;
}

module.exports = { SCHEMA, DEFAULTS, normalize, resolveThreads };
