// node renderer/src/uml/llvm_cl_icd.test.js — .ll 程式的 cl* 匯入接到 ICD 載入器（llvm_cl_icd.js）：同一份 IR 在 ICD 模式與預設墊片都跑得通，
// ICD 模式多了 __local＋barrier（舊墊片不支援）。沒有 JSPI（node），所以走同步路徑：clc 的主機路線同步完成。
const fs = require('fs'), path = require('path');
const L = require('./llvm_core.js'), H = require('./llvm_host.js'), X = require('./llvm_cl_icd.js');
const ICD = require('../gpu/cl_icd.js'), CLC = require('../gpu/clc_js.js'), OPS = require('../gpu/cl_host_ops.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };
const ex = (n) => fs.readFileSync(path.join(__dirname, '../examples/llc/gpgpu', n), 'utf8');
const mkHost = (icd) => { const warns = []; const o = { gui: async () => null, warn: (t) => warns.push(t) }; if (icd) { const loader = ICD.createLoader(); loader.registerDriver(ICD.makeClcDriver({ mods: { FaClc: CLC } })); o.clIcd = { mod: X, ops: OPS.create(loader) }; } const h = H.create(o); h.install(L); return { h, warns }; };
const run = async (host, ir, args) => { const r = L.compileIr(ir, {}); if (!r.wasm) return { errors: r.errors }; const dec = {}; for (const d of L.parse(ir).mod.declares) dec[d.name] = d; return L.runHost(r.wasm, { args: args || ['prog'] }, host.h.impls, undefined, dec); };
(async () => {
  check('wantsIcd：註解啟用、沒註解不啟用', X.wantsIcd(ex('opencl_icd_reduce.ll')) && !X.wantsIcd(ex('opencl_vecadd.ll')) && !X.wantsIcd('; 不是 fa-opencl: icd 的註解行\n'));
  // 1. 既有範例 opencl_vecadd.ll：ICD 模式也要跑得通（裝置選擇 GPU 失敗後退回 CPU；clc 驅動的裝置是 CPU）
  { const host = mkHost(true); const o = await run(host, ex('opencl_vecadd.ll'), ['prog', '1000']); check('opencl_vecadd.ll（ICD 模式）：n=1000 c[999]=2997', o.stdout === 'vadd OK, n=1000 c=2997.000000\n' && o.exitCode === 0, [o.stdout, host.warns]); host.h.uninstall(L); }
  // 2. 預設墊片不認得 __local＋barrier，ICD 模式可以
  { const host = mkHost(false); const o = await run(host, ex('opencl_icd_reduce.ll')); check('預設墊片跑 __local 歸約會失敗（所以才需要 ICD 模式）', o.exitCode !== 0 || !/red OK/.test(o.stdout || ''), o); host.h.uninstall(L); }
  { const host = mkHost(true); const o = await run(host, ex('opencl_icd_reduce.ll')); check('opencl_icd_reduce.ll（ICD 模式）：__local＋barrier 歸約 sum=32640', o.stdout === 'red OK sum=32640.0\n' && o.exitCode === 0, [o, host.warns]); host.h.uninstall(L); }
  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'llvm_cl_icd: ' + ok + ' passed');
  process.exit(bad.length ? 1 : 0);
})();
