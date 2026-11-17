// gpu_mem.js：設定解析、建議值分析、用假 WebGPU 測探測（容量上限、溢出偵測、裝置遺失、軟體 adapter、釋放）
const M = require('./gpu_mem.js');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log('FAIL ' + n); } };
const MiB = M.MiB, GiB = M.GiB;
ok(M.parseMB('2048') === 2048 && M.parseMB(0) === 0 && M.parseMB(-5) === 0 && M.parseMB('abc') === 0 && M.parseMB(12.9) === 12, 'parseMB');
let r = M.resolveBudget({ settingMB: 1500, probe: { ok: true, suggestBytes: 512 * MiB } });
ok(r.source === 'manual' && r.bytes === 1500 * MiB, '手動優先於探測');
r = M.resolveBudget({ settingMB: 0, probe: { ok: true, suggestBytes: 768 * MiB } }); ok(r.source === 'probe' && r.bytes === 768 * MiB, '0＝自動用探測');
r = M.resolveBudget({ settingMB: 0 }); ok(r.source === 'default' && r.bytes === GiB, '沒探測過用保守預設');
r = M.resolveBudget({ settingMB: 0, probe: { ok: false, suggestBytes: 0 } }); ok(r.source === 'default', '探測失敗不採用');

// 假 WebGPU：capBytes＝真實容量；bw(totalBytes)＝此時的寫入頻寬（MB/s）；lostAt＝配置到這麼多就裝置遺失
function fake(o) {
  let total = 0, clock = 0, scopes = [], destroyed = 0, created = 0, lostCb = null, devDestroyed = false;
  const dev = {
    limits: {}, lost: new Promise((res) => { lostCb = res; }),
    pushErrorScope() { scopes.push(null); },
    async popErrorScope() { return scopes.pop(); },
    createBuffer({ size }) {
      created++; total += size; const mark = () => { if (total > o.capBytes) for (let i = 0; i < scopes.length; i++) if (!scopes[i]) scopes[i] = { message: 'oom' }; if (o.lostAt && total > o.lostAt) lostCb({ reason: 'unknown', message: 'hung' }); };
      mark(); return { size, destroy() { destroyed++; total -= size; } };
    },
    queue: { writeBuffer(b, off, data, so, n) { clock += ((n == null ? data.length : n) / MiB) / o.bw(total) * 1000; }, async onSubmittedWorkDone() {} },
    destroy() { devDestroyed = true; },
  };
  const ad = { limits: { maxBufferSize: 4 * GiB, maxStorageBufferBindingSize: 2 * GiB }, info: o.info || { vendor: 'nvidia', architecture: 'kepler' }, async requestDevice() { return dev; } };
  return { nav: { gpu: { async requestAdapter() { return ad; } } }, now: () => clock, state: () => ({ total, destroyed, created, devDestroyed }) };
}
(async () => {
  // 容量 1.3 GiB、頻寬穩定：倍增到 1 GiB 成功、2 GiB 失敗，二分往 1.3 逼近
  let f = fake({ capBytes: 1.3 * GiB, bw: () => 3000 });
  r = await M.probe(f.nav, { now: f.now });
  ok(r.ok && r.hitFailure && r.usableBytes >= GiB && r.usableBytes <= 1.3 * GiB, '容量 1.3 GiB：可用 ' + (r.usableBytes / GiB));
  ok(r.suggestBytes === Math.floor(r.usableBytes * 0.75 / (64 * MiB)) * 64 * MiB, '建議值＝可用×0.75（64 MiB 對齊）');
  ok(f.state().total === 0 && f.state().devDestroyed, '結束後測試緩衝區與裝置都已釋放');
  ok(r.writeMBps > 0 && r.steps[0].bytes === 256 * MiB, '有寫入頻寬與起始步驟');
  // 溢出：容量很大（配置都成功）但超過 1 GiB 後頻寬掉到 10%
  f = fake({ capBytes: 64 * GiB, bw: (t) => (t > GiB ? 300 : 3000) });
  r = await M.probe(f.nav, { now: f.now });
  ok(r.spillSuspected && r.usableBytes === GiB && /溢出/.test(r.reason), '溢出偵測：停在 1 GiB（' + r.reason + '）');
  // 一路成功到上限
  f = fake({ capBytes: 64 * GiB, bw: () => 3000 });
  r = await M.probe(f.nav, { now: f.now, maxProbeBytes: 2 * GiB });
  ok(r.ok && r.hitCap && r.usableBytes === 2 * GiB, '到探測上限仍成功＝hitCap');
  // 裝置遺失：停止、標記、結果不可信
  f = fake({ capBytes: 64 * GiB, bw: () => 3000, lostAt: 600 * MiB });
  r = await M.probe(f.nav, { now: f.now });
  ok(r.lost && r.ok === false && /遺失/.test(r.reason) && f.state().total === 0, '裝置遺失：標記並釋放');
  // 逾時
  f = fake({ capBytes: 64 * GiB, bw: () => 5 });
  r = await M.probe(f.nav, { now: f.now, timeoutMs: 100 });
  ok(r.truncated, '逾時：截斷而不是卡死');
  // 軟體 adapter 不量；沒有 WebGPU
  f = fake({ capBytes: GiB, bw: () => 1, info: { vendor: 'google', architecture: 'swiftshader' } });
  r = await M.probe(f.nav, { now: f.now }); ok(r.soft && !r.ok && f.state().created === 0, '軟體 WebGPU 不量、不配置');
  r = await M.probe({}, {}); ok(!r.ok && /沒有 WebGPU/.test(r.reason), '沒有 WebGPU');
  // 連 256 MiB 都失敗
  f = fake({ capBytes: 100 * MiB, bw: () => 3000 });
  r = await M.probe(f.nav, { now: f.now }); ok(!r.ok && /256 MiB/.test(r.reason), '容量太小回報原因');
  console.log(pass + ' 通過 ' + fail + ' 失敗'); process.exit(fail ? 1 : 0);
})();
