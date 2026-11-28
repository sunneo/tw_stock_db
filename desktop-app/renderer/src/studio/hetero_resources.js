(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaHeteroResources = factory(); })(typeof self !== 'undefined' ? self : this, function () {
'use strict';
// 異質訓練的資源模型（P1c-2 第二半、P8 的基礎）。純核心：不碰 Worker、不碰 WebGPU、不碰網路。
// 協調端只看「資源清單＋份額」：每個資源有 id、類型、實測速率、在線狀態、份額。
// 加入遠端節點只要 add({kind:'remote', impl})，切分、合併、更新都不用改。
//
//   createResourceSet() → set
//     set.add({ id, kind, rate?, impl })   kind：'cpu-py' | 'cudaweb' | 'remote'
//                                          rate：樣本數／毫秒（可省略；能力檔給比例時用 profileRatios）
//                                          impl.gradient({ params, seqs }) → Promise<{ loss, n, grads, ms }>
//     set.remove(id) / set.markOffline(id, reason) / set.markOnline(id)
//     set.get(id) / set.alive() / set.snapshot()（純資料，不含 impl）
//   splitCounts(n, shares) → [{ id, count }]   最大餘數法；總和恆等於 n；份額為正的資源在 n ≥ 其數量時至少分到 1 筆
//   normalizeShares(items) → [{ id, share }]   總和為 1（份額全為 0 時回傳等分）
//   sharesFromRates(items) → [{ id, share }] | null   依速率比例；任一筆沒有速率 → null（呼叫端改用等分）
//   profileRatios(profile) → { cpu, cudaweb }   依能力檔：cpu.best.gflops 與 gpu.matmulGflops；缺值為 null

const KINDS = ['cpu-py', 'cudaweb', 'remote'];

const isNum = (x) => typeof x === 'number' && isFinite(x);

function createResourceSet() {
  const order = [];
  const map = new Map();
  const set = {
    add(res) {
      if (!res || typeof res.id !== 'string' || !res.id) throw new Error('資源需要非空字串 id');
      if (KINDS.indexOf(res.kind) < 0) throw new Error('未知的資源類型：' + res.kind);
      if (map.has(res.id)) throw new Error('資源 id 重複：' + res.id);
      if (!res.impl || typeof res.impl.gradient !== 'function') throw new Error('資源 ' + res.id + ' 缺少 impl.gradient');
      if (res.rate !== undefined && res.rate !== null && !(isNum(res.rate) && res.rate > 0)) throw new Error('資源 ' + res.id + ' 的速率不合理');
      const e = { id: res.id, kind: res.kind, rate: isNum(res.rate) ? res.rate : null, impl: res.impl, online: true, reason: null };
      map.set(res.id, e); order.push(res.id);
      return e;
    },
    remove(id) {
      if (!map.has(id)) return false;
      map.delete(id); order.splice(order.indexOf(id), 1);
      return true;
    },
    markOffline(id, reason) {
      const e = map.get(id); if (!e) return false;
      e.online = false; e.reason = reason ? String(reason) : 'offline';
      return true;
    },
    markOnline(id) {
      const e = map.get(id); if (!e) return false;
      e.online = true; e.reason = null;
      return true;
    },
    get(id) { return map.get(id) || null; },
    alive() { return order.map((id) => map.get(id)).filter((e) => e.online); },
    snapshot() {
      return order.map((id) => { const e = map.get(id); return { id: e.id, kind: e.kind, rate: e.rate, online: e.online, reason: e.reason }; });
    },
  };
  return set;
}

function splitCounts(n, shares) {
  if (!Number.isInteger(n) || n < 0) throw new Error('樣本數必須是非負整數');
  const pos = shares.filter((s) => s.share > 0);
  const out = new Map(shares.map((s) => [s.id, 0]));
  if (pos.length === 0 || n === 0) return shares.map((s) => ({ id: s.id, count: 0 }));
  const total = pos.reduce((a, s) => a + s.share, 0);
  const raw = pos.map((s) => n * s.share / total);
  const cnt = raw.map(Math.floor);
  let rem = n - cnt.reduce((a, b) => a + b, 0);
  const byFrac = raw.map((x, i) => i).sort((i, j) => (raw[j] - cnt[j]) - (raw[i] - cnt[i]) || i - j);
  for (let k = 0; k < rem; k++) cnt[byFrac[k % byFrac.length]] += 1;
  // 至少一筆：份額為正的資源，若被取整到 0，從目前最多的那個資源挪一筆（樣本數夠時才做）
  if (n >= pos.length) {
    for (let i = 0; i < cnt.length; i++) {
      if (cnt[i] > 0) continue;
      let big = 0; for (let j = 1; j < cnt.length; j++) if (cnt[j] > cnt[big]) big = j;
      if (cnt[big] > 1) { cnt[big] -= 1; cnt[i] += 1; }
    }
  }
  pos.forEach((s, i) => out.set(s.id, cnt[i]));
  return shares.map((s) => ({ id: s.id, count: out.get(s.id) }));
}

function normalizeShares(items) {
  const total = items.reduce((a, s) => a + (s.share > 0 ? s.share : 0), 0);
  if (!(total > 0)) return items.map((s) => ({ id: s.id, share: 1 / items.length }));
  return items.map((s) => ({ id: s.id, share: (s.share > 0 ? s.share : 0) / total }));
}

function sharesFromRates(items) {
  if (!items.length) return [];
  if (items.some((s) => !(isNum(s.rate) && s.rate > 0))) return null;
  const total = items.reduce((a, s) => a + s.rate, 0);
  return items.map((s) => ({ id: s.id, share: s.rate / total }));
}

function profileRatios(profile) {
  const cpu = profile && profile.cpu && profile.cpu.best && isNum(profile.cpu.best.gflops) && profile.cpu.best.gflops > 0 ? profile.cpu.best.gflops : null;
  const gpu = profile && profile.gpu && isNum(profile.gpu.matmulGflops) && profile.gpu.matmulGflops > 0 ? profile.gpu.matmulGflops : null;
  return { cpu, cudaweb: gpu };
}

return { createResourceSet, splitCounts, normalizeShares, sharesFromRates, profileRatios, KINDS };
});
