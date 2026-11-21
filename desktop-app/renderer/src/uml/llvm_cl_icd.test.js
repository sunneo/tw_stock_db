// node renderer/src/uml/llvm_cl_icd.test.js — .ll 程式的 cl* 匯入接到 ICD 載入器（llvm_cl_icd.js）：同一份 IR 在 ICD 模式與預設墊片都跑得通，
// ICD 模式多了 __local＋barrier（舊墊片不支援）。沒有 JSPI（node），所以走同步路徑：clc 的主機路線同步完成。
const fs = require('fs'), path = require('path');
const L = require('./llvm_core.js'), H = require('./llvm_host.js'), X = require('./llvm_cl_icd.js');
const ICD = require('../gpu/cl_icd.js'), CLC = require('../gpu/clc_js.js'), SPV = require('../gpu/spv_js.js'), OPS = require('../gpu/cl_host_ops.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };
const ex = (n) => fs.readFileSync(path.join(__dirname, '../examples/llc/gpgpu', n), 'utf8');
const mkHost = (icd) => { const warns = []; const o = { gui: async () => null, warn: (t) => warns.push(t) }; if (icd) { const loader = ICD.createLoader(); loader.registerDriver(ICD.makeClcDriver({ mods: { FaClc: CLC, FaSpv: SPV } })); o.clIcd = { mod: X, ops: OPS.create(loader) }; } const h = H.create(o); h.install(L); return { h, warns }; };
const run = async (host, ir, args) => { const r = L.compileIr(ir, {}); if (!r.wasm) return { errors: r.errors }; const dec = {}; for (const d of L.parse(ir).mod.declares) dec[d.name] = d; return L.runHost(r.wasm, { args: args || ['prog'] }, host.h.impls, undefined, dec); };
(async () => {
  check('wantsIcd：註解啟用、沒註解不啟用', X.wantsIcd(ex('opencl_icd_reduce.ll')) && !X.wantsIcd(ex('opencl_vecadd.ll')) && !X.wantsIcd('; 不是 fa-opencl: icd 的註解行\n'));
  // 1. 既有範例 opencl_vecadd.ll：ICD 模式也要跑得通（裝置選擇 GPU 失敗後退回 CPU；clc 驅動的裝置是 CPU）
  { const host = mkHost(true); const o = await run(host, ex('opencl_vecadd.ll'), ['prog', '1000']); check('opencl_vecadd.ll（ICD 模式）：n=1000 c[999]=2997', o.stdout === 'vadd OK, n=1000 c=2997.000000\n' && o.exitCode === 0, [o.stdout, host.warns]); host.h.uninstall(L); }
  // 2. 預設墊片不認得 __local＋barrier，ICD 模式可以
  { const host = mkHost(false); const o = await run(host, ex('opencl_icd_reduce.ll')); check('預設墊片跑 __local 歸約會失敗（所以才需要 ICD 模式）', o.exitCode !== 0 || !/red OK/.test(o.stdout || ''), o); host.h.uninstall(L); }
  { const host = mkHost(true); const o = await run(host, ex('opencl_icd_reduce.ll')); check('opencl_icd_reduce.ll（ICD 模式）：__local＋barrier 歸約 sum=32640', o.stdout === 'red OK sum=32640.0\n' && o.exitCode === 0, [o, host.warns]); host.h.uninstall(L); }
  // 3. SPIR-V 版（clCreateProgramWithIL）：同一個歸約核心、不經 OpenCL C 前端
  { const host = mkHost(true); const o = await run(host, ex('opencl_spirv_reduce.ll')); check('opencl_spirv_reduce.ll（clCreateProgramWithIL）：sum=32640', o.stdout === 'red OK sum=32640.0\n' && o.exitCode === 0, [o, host.warns]); host.h.uninstall(L); }
  { const host = mkHost(false); const r = L.compileIr(ex('opencl_spirv_reduce.ll'), {}); check('預設墊片沒有 clCreateProgramWithIL（編譯期就明確拒絕）', !r.wasm && /clCreateProgramWithIL/.test(JSON.stringify(r.errors)), r.errors); host.h.uninstall(L); }
  // 4. IL 壞掉：build 回 CL_BUILD_PROGRAM_FAILURE（-11），log 說明原因
  { const host = mkHost(true); const bad = ex('opencl_spirv_reduce.ll').replace(/@il = private constant \[1464 x i8\] c"[^"]*"/, '@il = private constant [24 x i8] c"\\03\\02#\\07\\00\\00\\01\\00\\00\\00\\00\\00\\01\\00\\00\\00\\00\\00\\00\\00\\00\\00\\00\\00"').replace('i64 1464', 'i64 24'); const o = await run(host, bad); check('壞的 IL：回報建置失敗（-11）並說明原因', /err=-11/.test(o.stdout || '') && host.warns.some((w) => /SPIR-V 建置失敗/.test(w)), [o.stdout, host.warns]); host.h.uninstall(L); }
  // 5. binary 往返（clGetProgramInfo(BINARIES) → clCreateProgramWithBinary）：第二個程式不經任何前端
  { const mk = (ops) => X.build({ ops, asyncOk: false, warn: () => {} }).impls; const mkCtx = () => { const ab = new ArrayBuffer(1 << 16), u8 = new Uint8Array(ab), dv = new DataView(ab); return { u8: () => u8, dv: () => dv, mem: () => ({ buffer: ab }), _u8: u8 }; };
    const loader = ICD.createLoader({ cache: require('../gpu/cl_cache.js').createCache({}) }); loader.registerDriver(ICD.makeClcDriver({ mods: { FaClc: CLC, FaSpv: SPV } })); const ops = OPS.create(loader), I = mk(ops), m = mkCtx(), u8 = m._u8;
    const put = (str, at) => { const b = new TextEncoder().encode(str + '\0'); u8.set(b, at); return at; };
    I.clGetPlatformIDs(m, 1, 100, 0); const plat = m.dv().getUint32(100, true); I.clGetDeviceIDs(m, plat, 0xFFFFFFFF, 1, 104, 0); const ctxH = I.clCreateContext(m, 0, 1, 104, 0, 0, 108);
    const SRC = '__kernel void k(__global float* o) { o[get_global_id(0)] = 7.0f; }'; put(SRC, 2000); m.dv().setUint32(120, 2000, true); const prog = I.clCreateProgramWithSource(m, ctxH, 1, 120, 0, 108); put('', 3000);
    check('build（source）成功', I.clBuildProgram(m, prog, 1, 104, 3000) === 0);
    check('BINARY_SIZES 與 BINARIES 回傳真的 binary 容器', (() => { if (I.clGetProgramInfo(m, prog, 0x1165, 4, 200, 0) !== 0) return false; const n = m.dv().getUint32(200, true); m.dv().setUint32(210, 4000, true); const r = I.clGetProgramInfo(m, prog, 0x1166, 4, 210, 0); return r === 0 && n > 100 && new TextDecoder().decode(u8.subarray(4000, 4008)) === 'FAKIRBN1'; })());
    const n = m.dv().getUint32(200, true); m.dv().setUint32(220, n, true); m.dv().setUint32(224, 4000, true);   // lengths[0]、binaries[0]
    const loader2 = ICD.createLoader({ cache: require('../gpu/cl_cache.js').createCache({}) }); loader2.registerDriver(ICD.makeClcDriver({ mods: { FaClc: CLC, FaSpv: SPV } })); const I2 = mk(OPS.create(loader2)), m2 = mkCtx();
    I2.clGetPlatformIDs(m2, 1, 100, 0); const pl2 = m2.dv().getUint32(100, true); I2.clGetDeviceIDs(m2, pl2, 0xFFFFFFFF, 1, 104, 0); const c2 = I2.clCreateContext(m2, 0, 1, 104, 0, 0, 108);
    m2._u8.set ? 0 : 0; m2.u8().set(u8.subarray(4000, 4000 + n), 4000); m2.dv().setUint32(220, n, true); m2.dv().setUint32(224, 4000, true);
    let compiles = 0; const orig = CLC.compile; CLC.compile = (...a) => { compiles++; return orig.apply(CLC, a); };
    try { const p2 = I2.clCreateProgramWithBinary(m2, c2, 1, 104, 220, 224, 230, 108); check('clCreateProgramWithBinary 成功', p2 !== 0 && m2.dv().getInt32(108, true) === 0 && m2.dv().getInt32(230, true) === 0); m2.u8().set(new Uint8Array(4), 3000); check('build 不經 clc 前端', I2.clBuildProgram(m2, p2, 1, 104, 3000) === 0 && compiles === 0, compiles);
      m2.u8().set(new TextEncoder().encode('k\0'), 5000); const kn = I2.clCreateKernel(m2, p2, 5000, 108); check('核心可用', kn !== 0); } finally { CLC.compile = orig; }
    m2.u8().set(new Uint8Array(100), 6000); m2.dv().setUint32(220, 100, true); m2.dv().setUint32(224, 6000, true); I2.clCreateProgramWithBinary(m2, c2, 1, 104, 220, 224, 230, 108); check('壞的 binary 回 CL_INVALID_BINARY', m2.dv().getInt32(108, true) === -42, m2.dv().getInt32(108, true)); }
  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'llvm_cl_icd: ' + ok + ' passed');
  process.exit(bad.length ? 1 : 0);
})();
