// node renderer/src/gpu/spv_js_test.js — SPIR-V（OpenCL Kernel 風格）後端：用文字組譯器手寫模組（形狀仿 clang＋llvm-spirv 的輸出），
// 經 FaSpv.compile 轉成 JS 並以 clc 的工作群排程執行；結果與手算／JS 計算的期望值比對。沒有真 clang 的產物可驗證（見 DESIGN.pyopencl.md §13）。
const assert = require('assert');
const A = require('./spv_asm.js'), S = require('./spv_js.js');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.stack || e.message).split('\n').slice(0, 8).join('\n   ')); } };
const F = require('./spv_fixtures.js'), { HEAD, TYPES, BUILTIN_DECO, build, VADD, REDUCE } = F;
const compile = (text, opts) => { const r = S.compile(A.assemble(text), opts); assert.ok(r.ok, r.log); if (process.env.SPV_DEBUG) console.error(r.js); return r; };   // SPV_DEBUG=1：印出轉出的 JS
const run = (r, name, args, gs, ls) => r.run(name, args, gs, ls || null, null);
const mk = (r, arr) => r.mkptr(arr.buffer);

t('向量相加：參數描述與結果', () => {
  const r = compile(VADD);
  assert.deepStrictEqual(r.kernels.vadd.params.map((p) => [p.name, p.kind, p.type]), [['a', 'buf', 'float'], ['b', 'buf', 'float'], ['c', 'buf', 'float'], ['n', 'scalar', 'int']]);
  const a = new Float32Array(1000).map((_, i) => i), b = new Float32Array(1000).map((_, i) => i * 0.5), c = new Float32Array(1000);
  run(r, 'vadd', [mk(r, a), mk(r, b), mk(r, c), 1000], [1000]);
  for (let i = 0; i < 1000; i++) assert.strictEqual(c[i], Math.fround(a[i] + b[i]));
  const c2 = new Float32Array(10).fill(-1); run(r, 'vadd', [mk(r, a), mk(r, b), mk(r, c2), 4], [10]);   // n 之外不寫
  assert.deepStrictEqual(Array.from(c2), [0, 1.5, 3, 4.5, -1, -1, -1, -1, -1, -1]);
});

t('__local＋barrier 的樹狀歸約（phi 迴圈、工作群內共享記憶體）', () => {
  const r = compile(REDUCE);
  assert.deepStrictEqual(r.kernels.red.params.map((p) => [p.kind, p.type]), [['buf', 'float'], ['buf', 'float'], ['local', 'float']]);
  const x = new Float32Array(256).map((_, i) => i), out = new Float32Array(4);
  run(r, 'red', [mk(r, x), mk(r, out), 64 * 4], [256], [64]);
  assert.deepStrictEqual(Array.from(out), [0, 1, 2, 3].map((g) => { let s = 0; for (let i = 0; i < 64; i++) s += g * 64 + i; return s; }));
});

t('整數運算：逐項與 C 語意對照', () => {
  // 逐項小核心：每個運算一個核心太囉嗦——用一個核心的 18 個輸出，由 JS 端計算期望值
  const lines = []; const ops = [
    ['OpIMul %int %i6 %i7', 42], ['OpSDiv %int %m7 %p2', -3], ['OpSRem %int %m7 %p2', -1], ['OpSMod %int %m7 %p2', 1], ['OpSNegate %int %i7', -7], ['OpNot %int %i7', -8],
    ['OpIAdd %int %i7 %i7', 14], ['OpBitwiseXor %int %i6 %i7', 1], ['OpShiftLeftLogical %int %i7 %c2', 28], ['OpShiftRightArithmetic %int %m7 %c1', -4],
    ['OpExtInst %int %ocl s_abs %m7', 7], ['OpExtInst %int %ocl s_max %m7 %p2', 2],
  ];
  let body = `%int = OpTypeInt 32 1
%_ptr_CW_int = OpTypePointer CrossWorkgroup %int
%fn_ops = OpTypeFunction %void %_ptr_CW_int
%m7 = OpConstant %int -7
%p2 = OpConstant %int 2
%i6 = OpConstant %int 6
%i7 = OpConstant %int 7
%ops = OpFunction %void None %fn_ops
%out = OpFunctionParameter %_ptr_CW_int
%entry = OpLabel
`;
  ops.forEach(([e], i) => { body += `%r${i} = ${e}\n%q${i} = OpPtrAccessChain %_ptr_CW_int %out %k${i}\nOpStore %q${i} %r${i} Aligned 4\n`; });
  const consts = ops.map((_, i) => `%k${i} = OpConstant %ulong ${i}\n`).join('');
  body = body.replace('%ops = OpFunction', consts + '%ops = OpFunction') + 'OpReturn\nOpFunctionEnd\n';
  const r = compile(build('ops', body)); const out = new Int32Array(ops.length);
  run(r, 'ops', [mk(r, out)], [1]);
  assert.deepStrictEqual(Array.from(out), ops.map((o) => o[1]));
});

t('無號運算與 popcount／clz（canonical 有號表示）', () => {
  const body = `%int = OpTypeInt 32 1
%_ptr_CW_int = OpTypePointer CrossWorkgroup %int
%fn_ops = OpTypeFunction %void %_ptr_CW_int
%big = OpConstant %uint 4294967295
%k1 = OpConstant %ulong 1
%k2 = OpConstant %ulong 2
%k3 = OpConstant %ulong 3
%k4 = OpConstant %ulong 4
%ops = OpFunction %void None %fn_ops
%out = OpFunctionParameter %_ptr_CW_int
%entry = OpLabel
%a = OpUDiv %uint %big %c2
%ai = OpBitcast %int %a
OpStore %out %ai Aligned 4
%b = OpExtInst %uint %ocl popcount %big
%bi = OpBitcast %int %b
%q1 = OpPtrAccessChain %_ptr_CW_int %out %k1
OpStore %q1 %bi Aligned 4
%c = OpExtInst %uint %ocl clz %c1
%ci = OpBitcast %int %c
%q2 = OpPtrAccessChain %_ptr_CW_int %out %k2
OpStore %q2 %ci Aligned 4
%d = OpULessThan %bool %c2 %big
%di = OpSelect %int %d %ci %bi
%q3 = OpPtrAccessChain %_ptr_CW_int %out %k3
OpStore %q3 %di Aligned 4
OpReturn
OpFunctionEnd
`;
  const r = compile(build('ops', body)); const out = new Int32Array(4); run(r, 'ops', [mk(r, out)], [1]);
  assert.deepStrictEqual(Array.from(out), [2147483647, 32, 31, 31]);
});

t('原子加：直方圖', () => {
  const body = `%int = OpTypeInt 32 1
%_ptr_CW_uint2 = OpTypePointer CrossWorkgroup %uint
%fn_h = OpTypeFunction %void %_ptr_CW_uint2
%h = OpFunction %void None %fn_h
%bins = OpFunctionParameter %_ptr_CW_uint2
%entry = OpLabel
%g3 = OpLoad %v3ulong %gid Aligned 32
%g = OpCompositeExtract %ulong %g3 0
%k4 = OpConstant %ulong 4
%bin = OpUMod %ulong %g %k4
%p = OpInBoundsPtrAccessChain %_ptr_CW_uint2 %bins %bin
%old = OpAtomicIAdd %uint %p %scope_wg %c0 %c1
OpReturn
OpFunctionEnd
`;
  const r = compile(build('h', body)); const bins = new Uint32Array(4); run(r, 'h', [mk(r, bins)], [100]);
  assert.deepStrictEqual(Array.from(bins), [25, 25, 25, 25]);
});


t('-O0 形狀：Function 變數（提升成區域變數）、迴圈、函式呼叫、struct 變數（記憶體）', () => {
  const body = `%_ptr_Fn_uint = OpTypePointer Function %uint
%_ptr_Fn_float = OpTypePointer Function %float
%S = OpTypeStruct %float %uint
%_ptr_Fn_S = OpTypePointer Function %S
%fn_h = OpTypeFunction %float %float
%fn_k = OpTypeFunction %void %_ptr_CW_float %_ptr_CW_float %uint
%f0 = OpConstant %float 0
%f2 = OpConstant %float 2
%f25 = OpConstant %float 2.5
%c7 = OpConstant %uint 7
%helper = OpFunction %float None %fn_h
%hx = OpFunctionParameter %float
%hl = OpLabel
%hr = OpFMul %float %hx %f2
OpReturnValue %hr
OpFunctionEnd
%k = OpFunction %void None %fn_k
%out = OpFunctionParameter %_ptr_CW_float
%in = OpFunctionParameter %_ptr_CW_float
%n = OpFunctionParameter %uint
%entry = OpLabel
%i = OpVariable %_ptr_Fn_uint Function
%acc = OpVariable %_ptr_Fn_float Function
%st = OpVariable %_ptr_Fn_S Function
OpStore %i %c0 Aligned 4
OpStore %acc %f0 Aligned 4
OpBranch %cond
%cond = OpLabel
%iv = OpLoad %uint %i Aligned 4
%lt = OpULessThan %bool %iv %n
OpBranchConditional %lt %body %done
%body = OpLabel
%iv2 = OpLoad %uint %i Aligned 4
%iv64 = OpUConvert %ulong %iv2
%pin = OpInBoundsPtrAccessChain %_ptr_CW_float %in %iv64
%x = OpLoad %float %pin Aligned 4
%hx2 = OpFunctionCall %float %helper %x
%a0 = OpLoad %float %acc Aligned 4
%a1 = OpFAdd %float %a0 %hx2
OpStore %acc %a1 Aligned 4
%iv3 = OpIAdd %uint %iv2 %c1
OpStore %i %iv3 Aligned 4
OpBranch %cond
%done = OpLabel
%pf = OpInBoundsAccessChain %_ptr_Fn_float %st %c0
OpStore %pf %f25 Aligned 4
%pu = OpInBoundsAccessChain %_ptr_Fn_uint %st %c1
OpStore %pu %c7 Aligned 4
%sv = OpLoad %S %st Aligned 4
%sf = OpCompositeExtract %float %sv 0
%su = OpCompositeExtract %uint %sv 1
%suf = OpConvertUToF %float %su
%tot0 = OpLoad %float %acc Aligned 4
%tot1 = OpFAdd %float %tot0 %sf
%tot2 = OpFAdd %float %tot1 %suf
OpStore %out %tot2 Aligned 4
OpReturn
OpFunctionEnd
`;
  const r = compile(build('k', body)); const out = new Float32Array(1), inp = new Float32Array([1, 2, 3, 4]);
  run(r, 'k', [mk(r, out), mk(r, inp), 4], [1]);
  assert.strictEqual(out[0], 2 * 10 + 2.5 + 7);
});

t('向量與 OpenCL.std：construct／shuffle／dot／length／fma／sqrt／mix、bitcast', () => {
  const body = `%fn_v = OpTypeFunction %void %_ptr_CW_float
%f1 = OpConstant %float 1
%f2 = OpConstant %float 2
%f3 = OpConstant %float 3
%f4 = OpConstant %float 4
%f05 = OpConstant %float 0.5
%k1 = OpConstant %ulong 1
%k2 = OpConstant %ulong 2
%k3 = OpConstant %ulong 3
%k4 = OpConstant %ulong 4
%k5 = OpConstant %ulong 5
%k6 = OpConstant %ulong 6
%vv = OpFunction %void None %fn_v
%out = OpFunctionParameter %_ptr_CW_float
%entry = OpLabel
%v = OpCompositeConstruct %v4float %f1 %f2 %f3 %f4
%w = OpVectorShuffle %v4float %v %v 3 2 1 0
%d = OpDot %float %v %w
OpStore %out %d Aligned 4
%l = OpExtInst %float %ocl length %v
%q1 = OpPtrAccessChain %_ptr_CW_float %out %k1
OpStore %q1 %l Aligned 4
%fm = OpExtInst %float %ocl fma %f2 %f3 %f4
%q2 = OpPtrAccessChain %_ptr_CW_float %out %k2
OpStore %q2 %fm Aligned 4
%sq = OpExtInst %float %ocl sqrt %f2
%q3 = OpPtrAccessChain %_ptr_CW_float %out %k3
OpStore %q3 %sq Aligned 4
%mx = OpExtInst %float %ocl mix %f1 %f3 %f05
%q4 = OpPtrAccessChain %_ptr_CW_float %out %k4
OpStore %q4 %mx Aligned 4
%bc = OpBitcast %uint %f1
%bcf = OpConvertUToF %float %bc
%q5 = OpPtrAccessChain %_ptr_CW_float %out %k5
OpStore %q5 %bcf Aligned 4
%vv4 = OpExtInst %v4float %ocl fabs %w
%vsum = OpCompositeExtract %float %vv4 0
%q6 = OpPtrAccessChain %_ptr_CW_float %out %k6
OpStore %q6 %vsum Aligned 4
OpReturn
OpFunctionEnd
`;
  const r = compile(build('vv', body)); const out = new Float32Array(7); run(r, 'vv', [mk(r, out)], [1]);
  const F = Math.fround;
  assert.deepStrictEqual(Array.from(out), [F(1 * 4 + 2 * 3 + 3 * 2 + 4 * 1), F(Math.sqrt(30)), 10, F(Math.sqrt(2)), 2, F(1065353216), 4]);
});

t('switch（含 default）與 phi 合流', () => {
  const body = `%int = OpTypeInt 32 1
%_ptr_CW_int = OpTypePointer CrossWorkgroup %int
%fn_s = OpTypeFunction %void %_ptr_CW_int %uint
%i10 = OpConstant %int 10
%i20 = OpConstant %int 20
%i30 = OpConstant %int 30
%sw = OpFunction %void None %fn_s
%out = OpFunctionParameter %_ptr_CW_int
%sel = OpFunctionParameter %uint
%entry = OpLabel
OpSelectionMerge %merge None
OpSwitch %sel %dflt 0 %case0 1 %case1
%case0 = OpLabel
OpBranch %merge
%case1 = OpLabel
OpBranch %merge
%dflt = OpLabel
OpBranch %merge
%merge = OpLabel
%res = OpPhi %int %i10 %case0 %i20 %case1 %i30 %dflt
OpStore %out %res Aligned 4
OpReturn
OpFunctionEnd
`;
  const r = compile(build('sw', body)); const res = [0, 1, 5].map((sel) => { const o = new Int32Array(1); run(r, 'sw', [mk(r, o), sel], [1]); return o[0]; });
  assert.deepStrictEqual(res, [10, 20, 30]);
});

t('圖像：取樣器常數＋OpImageSampleExplicitLod＋OpImageWrite、OpImageQuerySize', () => {
  const body = `%int = OpTypeInt 32 1
%v2int = OpTypeVector %int 2
%img_t = OpTypeImage %float 2D 0 0 0 0 Unknown ReadOnly
%wimg_t = OpTypeImage %float 2D 0 0 0 0 Unknown WriteOnly
%smp_t = OpTypeSampler
%simg_t = OpTypeSampledImage %img_t
%smp = OpConstantSampler %smp_t None 0 Nearest
%fn_i = OpTypeFunction %void %img_t %wimg_t %_ptr_CW_int
%_ptr_CW_int = OpTypePointer CrossWorkgroup %int
%f0 = OpConstant %float 0
%f2 = OpConstant %float 2
%i0 = OpConstant %int 0
%img_k = OpFunction %void None %fn_i
%src = OpFunctionParameter %img_t
%dst = OpFunctionParameter %wimg_t
%sz = OpFunctionParameter %_ptr_CW_int
%entry = OpLabel
%g3 = OpLoad %v3ulong %gid Aligned 32
%gx = OpCompositeExtract %ulong %g3 0
%gy = OpCompositeExtract %ulong %g3 1
%xi = OpUConvert %int %gx
%yi = OpUConvert %int %gy
%co = OpCompositeConstruct %v2int %xi %yi
%si = OpSampledImage %simg_t %src %smp
%px = OpImageSampleExplicitLod %v4float %si %co Lod %f0
%px2 = OpVectorTimesScalar %v4float %px %f2
OpImageWrite %dst %co %px2
%size = OpImageQuerySize %v2int %src
%w = OpCompositeExtract %int %size 0
OpStore %sz %w Aligned 4
OpReturn
OpFunctionEnd
`.replace('%fn_i = OpTypeFunction %void %img_t %wimg_t %_ptr_CW_int\n%_ptr_CW_int = OpTypePointer CrossWorkgroup %int', '%_ptr_CW_int = OpTypePointer CrossWorkgroup %int\n%fn_i = OpTypeFunction %void %img_t %wimg_t %_ptr_CW_int');
  const r = compile(build('img_k', body));
  assert.deepStrictEqual(r.kernels.img_k.params.map((p) => [p.kind, p.type, p.access]), [['image', 'image2d', 'in'], ['image', 'image2d', 'out'], ['buf', 'int', 'rw']]);
  const A = new Float32Array([0.25, 0.5, 0.125, 0.0625]), B = new Float32Array(4), sz = new Int32Array(1);
  const mkI = (arr) => { const p = r.mkptr(arr.buffer); p.img = { type: 'image2d', w: 2, h: 2, d: 1, order: 'R', chType: 'FLOAT', elem: 4 }; return p; };
  run(r, 'img_k', [mkI(A), mkI(B), mk(r, sz)], [2, 2]);
  assert.deepStrictEqual(Array.from(B), [0.5, 1, 0.25, 0.125]); assert.strictEqual(sz[0], 2);
});

t('Pipe：OpWritePipe／OpReadPipe 與 reserve', () => {
  const body = `%int = OpTypeInt 32 1
%wp_t = OpTypePipe WriteOnly
%rp_t = OpTypePipe ReadOnly
%_ptr_Fn_float = OpTypePointer Function %float
%_ptr_CW_int = OpTypePointer CrossWorkgroup %int
%fn_w = OpTypeFunction %void %wp_t %_ptr_CW_int
%fn_r = OpTypeFunction %void %rp_t %_ptr_CW_float
%f15 = OpConstant %float 1.5
%c4 = OpConstant %int 4
%prod = OpFunction %void None %fn_w
%p = OpFunctionParameter %wp_t
%st = OpFunctionParameter %_ptr_CW_int
%e1 = OpLabel
%v = OpVariable %_ptr_Fn_float Function
OpStore %v %f15 Aligned 4
%vp = OpBitcast %_ptr_CW_float %v
%rc = OpWritePipe %int %p %v %c4 %c4
%g3 = OpLoad %v3ulong %gid Aligned 32
%g = OpCompositeExtract %ulong %g3 0
%q = OpInBoundsPtrAccessChain %_ptr_CW_int %st %g
OpStore %q %rc Aligned 4
OpReturn
OpFunctionEnd
%cons = OpFunction %void None %fn_r
%p2 = OpFunctionParameter %rp_t
%o = OpFunctionParameter %_ptr_CW_float
%e2 = OpLabel
%v2 = OpVariable %_ptr_Fn_float Function
%rc2 = OpReadPipe %int %p2 %v2 %c4 %c4
%x = OpLoad %float %v2 Aligned 4
OpStore %o %x Aligned 4
OpReturn
OpFunctionEnd
`.replace('%vp = OpBitcast %_ptr_CW_float %v\n', '');
  const text = HEAD + 'OpEntryPoint Kernel %prod "prod"\nOpEntryPoint Kernel %cons "cons"\n' + BUILTIN_DECO + TYPES + body;
  const r = compile(text); assert.deepStrictEqual(r.kernels.prod.params.map((p) => p.kind), ['pipe', 'buf']);
  const pipeMem = new Uint8Array(8 + 4 * 2), mkPipe = () => { const p = r.mkptr(pipeMem.buffer); p.pipe = { ps: 4, max: 2 }; return p; };
  const st = new Int32Array(3); run(r, 'prod', [mkPipe(), mk(r, st)], [3]);
  assert.deepStrictEqual(Array.from(st), [0, 0, -1]);   // 容量 2：第三個寫入失敗
  const o = new Float32Array(1); run(r, 'cons', [mkPipe(), mk(r, o)], [1]); assert.strictEqual(o[0], 1.5);
});

t('規格常數：預設值與 options.spec 覆寫', () => {
  const body = `%int = OpTypeInt 32 1
%_ptr_CW_int = OpTypePointer CrossWorkgroup %int
%fn_s = OpTypeFunction %void %_ptr_CW_int
%sc = OpSpecConstant %int 5
OpDecorate %sc SpecId 7
%sp = OpFunction %void None %fn_s
%out = OpFunctionParameter %_ptr_CW_int
%entry = OpLabel
OpStore %out %sc Aligned 4
OpReturn
OpFunctionEnd
`;
  for (const [spec, want] of [[undefined, 5], [{ 7: [9, 0, 0, 0] }, 9]]) { const r = compile(build('sp', body), { spec }); const o = new Int32Array(1); run(r, 'sp', [mk(r, o)], [1]); assert.strictEqual(o[0], want); }
});

t('明確的錯誤：Shader 風格的模組、沒有本體的函式、magic number', () => {
  let r = S.compile(A.assemble('OpCapability Shader\nOpMemoryModel Logical GLSL450\n')); assert.ok(!r.ok && /Shader|Vulkan/.test(r.log), r.log);
  r = S.compile(new Uint8Array(20)); assert.ok(!r.ok && /magic/.test(r.log), r.log);
  const body = `%fn_x = OpTypeFunction %void
%imp = OpFunction %void None %fn_x
OpFunctionEnd
%k = OpFunction %void None %fn_x
%e = OpLabel
%c = OpFunctionCall %void %imp
OpReturn
OpFunctionEnd
`;
  r = S.compile(A.assemble(build('k', body))); assert.ok(!r.ok && /沒有本體/.test(r.log), r.log);
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
