/* profile_priors.js — 預先剖析表（G3，docs/TARGET.cudaweb-cublas.md「預先剖析表（priors）」）。
 * 鍵＝能力簽名（不看廠牌）＋運算＋形狀區間；值＝候選變體的優先順序。
 * 來源分三種，且必須明確標示，不得把推估當成量測：
 *   measured：真機量過（目前只有這張 GT 720）；heuristic：沒有機器可量，由屋頂模型與佔用率推估；local：使用者本機實測匯出後匯入。
 * 純函式：node 可直接 require 測試；UMD（瀏覽器掛在 self.FaProfilePriors）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.FaProfilePriors = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SOURCES = ['measured', 'heuristic', 'local'];

  // 能力簽名：只取會影響變體選擇的欄位（共用記憶體上限、每群組執行緒上限、f16、subgroups）
  function capSig(caps) {
    caps = caps || {};
    return 'wg' + (caps.maxWorkgroupStorage | 0) + '-inv' + (caps.maxInvocations | 0) +
      '-f16' + (caps.hasF16 ? 1 : 0) + '-sg' + (caps.hasSubgroups ? 1 : 0);
  }

  // 等級（與 kernel_select.tierOf 的定義一致：只看能力）
  function tierOf(caps) {
    caps = caps || {};
    if (caps.hasSubgroups && (caps.maxWorkgroupStorage | 0) >= 49152) return 'high';
    if (caps.hasF16 || (caps.maxWorkgroupStorage | 0) >= 32768) return 'mid';
    return 'low';
  }

  // 內建資料（與 profile_priors.json 相同內容，node 與瀏覽器都可直接用；JSON 檔供匯出入）
  var BUILTIN = {
    schema: 1,
    entries: [
      { sig: 'wg16384-inv256-f160-sg0', op: 'matmul', shape: '*', source: 'measured',
        hardware: 'NVIDIA GeForce GT 720（Kepler GK208，14 W）', evidence: 'scripts/eval/g1_gen_check.html、g2_ladder_compile.html；cudaweb_optimize.result.json',
        ranking: ['hand_v4', 'g_128x128_k8_t8x8_v4', 'g_64x64_k8_t4x4_v4', 'g_128x64_k8_t8x4_v4', 'g_64x128_k8_t4x8_v4'],
        note: '手寫 v4 同機 80.5% 峰值（512×1024×1024）；kernel_gen R8 46.6%。簽名的 sg 欄位改為 sg0：2026-11-18 真 Electron（G5 評估檔）實測這台 adapter 的 subgroups 不可用，簽名為 sg0；先前的 sg1 是 Chrome 獨立頁面的特徵回報，與應用程式的探測不同。' },
      { sig: '*', op: 'matmul', shape: '*', source: 'heuristic', tier: 'low',
        ranking: ['hand_v4', 'g_64x64_k8_t4x4_v4', 'g_64x64_k8_t4x4_s', 'g_32x32_k8_t2x2_s'],
        basis: '屋頂模型：低階 16 KiB 共用記憶體，64×64 塊（4×4 暫存器）是唯一能填滿群組又不超限的大塊；未實測其他低階卡' },
      { sig: '*', op: 'matmul', shape: '*', source: 'heuristic', tier: 'mid',
        ranking: ['g_64x128_k8_t4x8_v4', 'g_128x64_k8_t8x4_v4', 'g_64x64_k8_t4x4_v4', 'g_128x128_k8_t8x8_v4'],
        basis: '佔用率估算：中階共用記憶體 ≥32 KiB，64×128 與 128×64 能同時駐留更多群組；未實測' },
      { sig: '*', op: 'matmul', shape: '*', source: 'heuristic', tier: 'high',
        ranking: ['g_128x128_k8_t8x8_v4', 'g_128x128_k16_t8x8_v4', 'g_64x128_k8_t4x8_v4', 'g_64x64_k8_t4x4_v4'],
        basis: '屋頂模型：高階共用記憶體 ≥48 KiB、有 subgroups，大塊 8×8 暫存器分塊的算術強度最高；未實測' }
    ]
  };

  function validate(doc) {
    if (!doc || doc.schema !== 1 || !Array.isArray(doc.entries)) return { ok: false, reason: 'schema 必須是 1，且 entries 為陣列' };
    for (var i = 0; i < doc.entries.length; i++) {
      var e = doc.entries[i];
      if (SOURCES.indexOf(e.source) < 0) return { ok: false, reason: '第 ' + i + ' 筆 source 必須是 measured／heuristic／local' };
      if (!e.sig || !e.op || !Array.isArray(e.ranking) || !e.ranking.length) return { ok: false, reason: '第 ' + i + ' 筆缺 sig、op 或 ranking' };
      if (e.source === 'heuristic' && !e.basis) return { ok: false, reason: '第 ' + i + ' 筆 heuristic 必須寫 basis' };
      if (e.source === 'measured' && !e.evidence) return { ok: false, reason: '第 ' + i + ' 筆 measured 必須寫 evidence' };
    }
    return { ok: true, reason: '' };
  }

  // 查表：先找同簽名（measured／local 優先於 heuristic），找不到就用等級的 heuristic，最後才是 null
  function lookup(doc, caps, op) {
    doc = doc || BUILTIN;
    var sig = capSig(caps), tier = tierOf(caps);
    var exact = doc.entries.filter(function (e) { return e.op === op && e.sig === sig; });
    var order = { measured: 0, local: 1, heuristic: 2 };
    exact.sort(function (a, b) { return order[a.source] - order[b.source]; });
    if (exact.length) return { source: exact[0].source, ranking: exact[0].ranking, sig: sig, tier: tier, entry: exact[0] };
    var byTier = doc.entries.filter(function (e) { return e.op === op && e.source === 'heuristic' && e.tier === tier; });
    if (byTier.length) return { source: 'heuristic', ranking: byTier[0].ranking, sig: sig, tier: tier, entry: byTier[0] };
    return null;
  }

  // 匯出：只匯出指定來源（預設 measured 與 local），以便把本機量測貼回維護者
  function exportPriors(doc, sources) {
    var keep = sources || ['measured', 'local'];
    return { schema: 1, entries: (doc || BUILTIN).entries.filter(function (e) { return keep.indexOf(e.source) >= 0; }) };
  }
  // 匯入：驗證後併入（同 sig＋op＋shape＋source 的舊筆被取代）；heuristic 不接受匯入（避免把推估當量測）
  function importPriors(doc, incoming) {
    var v = validate(incoming);
    if (!v.ok) return { ok: false, reason: v.reason, doc: doc };
    var bad = incoming.entries.filter(function (e) { return e.source === 'heuristic'; });
    if (bad.length) return { ok: false, reason: '匯入不接受 heuristic 筆（推估不當量測）', doc: doc };
    var base = (doc || BUILTIN).entries.filter(function (e) {
      return !incoming.entries.some(function (n) { return n.sig === e.sig && n.op === e.op && n.shape === e.shape && n.source === e.source; });
    });
    return { ok: true, reason: '', doc: { schema: 1, entries: base.concat(incoming.entries) } };
  }

  return { capSig: capSig, tierOf: tierOf, BUILTIN: BUILTIN, validate: validate, lookup: lookup, exportPriors: exportPriors, importPriors: importPriors, SOURCES: SOURCES };
}));
