'use strict';
// 純 CPU GEMM 變體競賽：候選變體（SIMD 與否、MC/KC/NC）各量一次，勝者存進 IndexedDB（或注入的後端），鍵含 CPU 核心數與瀏覽器版本。
// 沒有好處的變體標「沒有好處」：比預設變體慢、或快不到 MIN_GAIN（5%，低於這個差距視為量測雜訊）。
// 微核心大小目前固定為 4×8（SIMD 微核心只組了這一種），所以競賽不含微核心大小——這點在文件中如實標註。
// 所有函式都是純函式或注入依賴，方便測試；實際的計時由呼叫端傳入 timeFn。

const DEFAULT_ID = 'simd-96-256-512';
const MIN_GAIN = 0.05;     // 相對預設快不到 5% 視為沒有好處（量測雜訊範圍）
const STORE_NAME = 'gemm-variants';

// 候選變體：SIMD 四種分塊 + 純 JS 預設（共 5 個）
function candidateVariants() {
  const simd = [[48, 128, 256], [96, 256, 512], [192, 256, 512], [96, 384, 512]]
    .map(([MC, KC, NC]) => ({ id: `simd-${MC}-${KC}-${NC}`, kernel: 'simd', MC, KC, NC }));
  const js = [{ id: 'js-96-256-512', kernel: 'js', MC: 96, KC: 256, NC: 512 }];
  return simd.concat(js);
}

// 競賽：timeFn(variant) → 毫秒（呼叫端負責預熱與重複，這裡只取最小值）。
// 回傳 { winnerId, rows:[{id, ms, gflops, verdict}], defaultId, reason }
// verdict：'勝者' | '有好處' | '沒有好處'
function raceVariants(variants, timeFn, flops, reps) {
  const R = reps || 2;
  const rows = variants.map((v) => {
    let best = Infinity;
    for (let r = 0; r < R; r++) { const ms = timeFn(v); if (ms < best) best = ms; }
    return { id: v.id, kernel: v.kernel, MC: v.MC, KC: v.KC, NC: v.NC, ms: best, gflops: flops / (best * 1e-3) / 1e9 };
  });
  rows.sort((a, b) => a.ms - b.ms);
  const def = rows.find((r) => r.id === DEFAULT_ID) || rows[rows.length - 1];
  const best = rows[0];
  // 只有比預設快超過 MIN_GAIN 才算勝者；否則維持預設（差距在雜訊內，沒有證據支持換）
  const beatsDefault = best.ms < def.ms * (1 - MIN_GAIN);
  const winner = beatsDefault ? best : def;
  for (const r of rows) {
    if (r === winner) r.verdict = '勝者';
    else if (r.ms < def.ms * (1 - MIN_GAIN)) r.verdict = '有好處';
    else r.verdict = '沒有好處';
  }
  const pct = ((1 - best.ms / def.ms) * 100).toFixed(1);
  return { winnerId: winner.id, defaultId: def.id, rows, reason: beatsDefault ? `勝者 ${winner.id} 比預設快 ${pct}%` : `最快的 ${best.id} 只快 ${pct}%（低於 ${MIN_GAIN * 100}% 門檻），維持預設 ${def.id}` };
}

// 從 userAgent 取瀏覽器名稱與主版本（沒有認得的回 unknown）
function browserVersion(ua) {
  const m = /(Edg|Chrome|Firefox|Version)\/(\d+)/.exec(String(ua || ''));
  if (!m) return 'unknown';
  return `${m[1] === 'Version' ? 'Safari' : m[1]}${m[2]}`;
}

// 鍵：核心數與瀏覽器版本（版本變了就重新競賽）
function raceKey(cores, ua) {
  return `gemm-race|cores=${Math.max(1, cores | 0)}|browser=${browserVersion(ua)}`;
}

// 讀取勝者：store 出錯或沒有紀錄時回預設（不拋錯，不阻塞計算）。store 形狀：{ get(key), set(key, value) }
async function loadWinner(store, key) {
  try {
    const rec = await store.get(key);
    if (rec && typeof rec.winnerId === 'string') return rec;
  } catch (_) { /* 後端失敗：退回預設 */ }
  return null;
}

async function saveWinner(store, key, result) {
  try {
    await store.set(key, { winnerId: result.winnerId, defaultId: result.defaultId, rows: result.rows.map((r) => ({ id: r.id, ms: r.ms, gflops: r.gflops, verdict: r.verdict })), savedAt: Date.now() });
    return true;
  } catch (_) { return false; }
}

// 選變體：先讀保存的勝者；沒有就用預設。回傳變體物件（從 candidateVariants 中找）。
async function chooseVariant(store, key, variants) {
  const rec = store ? await loadWinner(store, key) : null;
  const id = rec ? rec.winnerId : DEFAULT_ID;
  return variants.find((v) => v.id === id) || variants.find((v) => v.id === DEFAULT_ID) || variants[0];
}

module.exports = { candidateVariants, raceVariants, browserVersion, raceKey, loadWinner, saveWinner, chooseVariant, DEFAULT_ID, MIN_GAIN, STORE_NAME };
