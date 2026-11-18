// cudaweb O10：node 假裝置檢查（只檢查「變體選擇」邏輯，不執行任何 WGSL、不計時）。
// 假能力表四組（數字是假設值，不是真實量測）：min／low（對應 Kepler 那台的保守值）／mid（假設有 f16）／high（假設有 subgroups）。
// 對覆蓋表（kernel_select.VARIANTS）每個變體做一次「強制指定」，記錄：能不能選到、被什麼能力擋下、退回哪個。
// 用法：node scripts/eval/cudaweb_o10_fake_check.js   （結果寫到 stdout，JSON）
'use strict';
const path = require('path');
const KS = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'gpu', 'kernel_select.js'));

const KIB = 1024;
const CAPS = {
  fake_min: { probed: true, software: true, maxWorkgroupStorage: 16 * KIB, maxInvocations: 256, maxWorkgroupSizeX: 256, maxStorageBinding: 128 * 1024 * 1024, maxUniformBinding: 64 * KIB, maxTextureDim: 8192, hasF16: false, hasSubgroups: false, hasTimestamp: false, hasPackedDot: false },
  fake_low: { probed: true, software: false, maxWorkgroupStorage: 16 * KIB, maxInvocations: 256, maxWorkgroupSizeX: 256, maxStorageBinding: 128 * 1024 * 1024, maxUniformBinding: 64 * KIB, maxTextureDim: 8192, hasF16: false, hasSubgroups: false, hasTimestamp: false, hasPackedDot: false },
  fake_mid: { probed: true, software: false, maxWorkgroupStorage: 32 * KIB, maxInvocations: 256, maxWorkgroupSizeX: 256, maxStorageBinding: 128 * 1024 * 1024, maxUniformBinding: 64 * KIB, maxTextureDim: 8192, hasF16: true, hasSubgroups: false, hasTimestamp: false, hasPackedDot: false },
  fake_high: { probed: true, software: false, maxWorkgroupStorage: 48 * KIB, maxInvocations: 1024, maxWorkgroupSizeX: 1024, maxStorageBinding: 512 * 1024 * 1024, maxUniformBinding: 64 * KIB, maxTextureDim: 16384, hasF16: true, hasSubgroups: true, hasTimestamp: true, hasPackedDot: true },
};
// 形狀：matmul 用 64×1024×1024（K、N 為 4 的倍數）；q8mm 用 M=64（預填門檻）與 N=1024
const SHAPES = {
  matmul: { M: 64, K: 1024, N: 1024 },
  q8mm: { M: 64, K: 1024, N: 1024 },
};
const out = { note: '假裝置（node）：只驗證選擇邏輯；能力表是假設值；未執行 WGSL，無任何時間或誤差數字', tiers: {}, forced: [] };
for (const [name, caps] of Object.entries(CAPS)) {
  out.tiers[name] = KS.tierOf(caps);
  for (const op of Object.keys(KS.VARIANTS)) {
    for (const v of KS.VARIANTS[op]) {
      const r = KS.pickVariant(op, SHAPES[op], caps, { [op]: v.id });
      out.forced.push({ caps: name, op: op, variant: v.id, chosen: r.id, forced: r.forced, tier: r.tier, note: r.reason || '' });
    }
  }
}
// 檢查：每個 (能力表, 運算) 的自動選擇都必須是可跑的變體（meets 為 null）且不會丟出例外（保底一定存在）
const autoRows = [];
for (const [name, caps] of Object.entries(CAPS)) {
  for (const op of Object.keys(KS.VARIANTS)) {
    const r = KS.pickVariant(op, SHAPES[op], caps, null);
    autoRows.push({ caps: name, op: op, chosen: r.id, tier: r.tier });
  }
}
out.auto = autoRows;
const bad = out.forced.filter((x) => !x.forced && x.chosen !== x.variant);
out.summary = { forcedCases: out.forced.length, forcedHonored: out.forced.filter((x) => x.forced).length, fallbackCases: out.forced.filter((x) => !x.forced).length, autoCases: autoRows.length, unexpected: bad.length };
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
