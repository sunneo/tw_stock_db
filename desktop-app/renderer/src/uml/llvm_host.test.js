// node renderer/src/uml/llvm_host.test.js -- LLVM IR 的主機函式庫：簽名檢查、printf 家族、float／可變參數／函式指標的編譯、examples/llc 三個範例都能編成 wasm。
// （SDL_Delay、PollEvent、gtk_main 要 JSPI，node 沒有；它們在真 Electron 的 scripts/eval/llc_host.eval.js 驗證。）
const fs = require('fs'), path = require('path');
const L = require('./llvm_core.js'), H = require('./llvm_host.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 240) : '')); };
const memfs = new Map(); const fsx = { read: (p) => (memfs.has(p) ? memfs.get(p) : null), write: (p, b) => { memfs.set(p, new Uint8Array(b)); }, exists: (p) => memfs.has(p), remove: (p) => memfs.delete(p) };
const host = H.create({ gui: async () => null, fs: fsx }); host.install(L);
const run = async (ir) => { const r = L.compileIr(ir, {}); if (!r.wasm) return { errors: r.errors }; const dec = {}; for (const d of L.parse(ir).mod.declares) dec[d.name] = d; const o = await L.runHost(r.wasm, { args: ['prog', 'x'] }, host.impls, undefined, dec); return o; };
(async () => {
  // 簽名要跟內建函式庫一致
  let r = L.compileIr('declare i32 @SDL_Init(i64)\ndefine i32 @main() {\n  call i32 @SDL_Init(i64 1)\n  ret i32 0\n}\n', {});
  check('簽名不符有明確錯誤', r.stage === 'check' && /SDL_Init 的宣告跟內建函式庫不符/.test(JSON.stringify(r.errors)), r.errors);
  r = L.compileIr('declare void @SDL_NoSuchThing()\ndefine i32 @main() {\n  call void @SDL_NoSuchThing()\n  ret i32 0\n}\n', {});
  check('沒有實作的函式', r.stage === 'check' && /沒有實作/.test(JSON.stringify(r.errors)), r.errors);
  // printf／snprintf／atoi、float、fpext／fptrunc、可變參數
  let o = await run(`@f = private constant [40 x i8] c"n=%d s=%s f=%.2f x=%x c=%c l=%ld %5d|\\0A\\00"
@s = private constant [3 x i8] c"hi\\00"
@a = private constant [4 x i8] c"123\\00"
declare i32 @printf(ptr, ...)
declare i32 @atoi(ptr)
define i32 @main(i32 %argc, ptr %argv) {
  %n = call i32 @atoi(ptr @a)
  %fl = fpext float 0x3FF8000000000000 to double
  %ff = fadd double %fl, 1.0
  %fp = fptrunc double %ff to float
  %back = fpext float %fp to double
  %c = fcmp ogt float %fp, 0x3FF0000000000000
  %r = call i32 (ptr, ...) @printf(ptr @f, i32 %n, ptr @s, double %back, i32 255, i32 65, i64 5000000000, i32 42)
  %ok = zext i1 %c to i32
  ret i32 %ok
}`);
  check('printf 的格式化（%d %s %.2f %x %c %ld 寬度）', o.stdout === 'n=123 s=hi f=2.50 x=ff c=A l=5000000000    42|\n' && o.exitCode === 1, o);
  // main(argc, argv)：參數傳得進去
  o = await run(`@f = private constant [12 x i8] c"%d %s %s\\0A\\00\\00"
declare i32 @printf(ptr, ...)
define i32 @main(i32 %argc, ptr %argv) {
  %p0 = getelementptr ptr, ptr %argv, i32 0
  %a0 = load ptr, ptr %p0
  %p1 = getelementptr ptr, ptr %argv, i32 1
  %a1 = load ptr, ptr %p1
  call i32 (ptr, ...) @printf(ptr @f, i32 %argc, ptr %a0, ptr %a1)
  ret i32 0
}`);
  check('main(argc, argv)', o.stdout === '2 prog x\n', o);
  // snprintf 進緩衝區（size_t 是 i64）
  o = await run(`@f = private constant [8 x i8] c"[%5.1f]\\00"
@g = private constant [4 x i8] c"%s\\0A\\00"
declare i32 @snprintf(ptr, i64, ptr, ...)
declare i32 @printf(ptr, ...)
define i32 @main() {
  %buf = alloca [32 x i8]
  call i32 (ptr, i64, ptr, ...) @snprintf(ptr %buf, i64 32, ptr @f, double 3.14159)
  call i32 (ptr, ...) @printf(ptr @g, ptr %buf)
  ret i32 0
}`);
  check('snprintf', o.stdout === '[  3.1]\n', o);
  // 函式指標當值（給主機函式回呼用）：表格索引從 1 起，函式表格有匯出
  r = L.compileIr(`define i32 @cb(ptr %a) {\n  ret i32 7\n}\ndeclare i32 @g_timeout_add(i32, ptr, ptr)\ndefine i32 @main() {\n  call i32 @g_timeout_add(i32 10, ptr @cb, ptr null)\n  ret i32 0\n}\n`, {});
  check('函式指標：編得出來且匯出 table', r.stage === 'ok' && WebAssembly.Module.exports(new WebAssembly.Module(r.wasm)).some((e) => e.name === 'table' && e.kind === 'table'), r.errors);
  // 沒有 JSPI 的環境：用到 async 主機函式要給明確錯誤；沒用到就不需要
  const hasJspi = typeof WebAssembly.Suspending === 'function';
  if (!hasJspi) { const c = L.compileIr('declare void @SDL_Delay(i32)\ndefine i32 @main() {\n  call void @SDL_Delay(i32 1)\n  ret i32 0\n}\n', {}); let msg = ''; try { await L.runHost(c.wasm, {}, host.impls); } catch (e) { msg = e.message; } check('沒有 JSPI 的錯誤說明', /JSPI/.test(msg), msg); }
  // 範例（sdl2_pong／gtk3_widgets／sdl2_gl_triangle）都能編成 wasm
  for (const f of ['game/sdl2_pong.ll', 'game/sdl2_piano.ll', 'gui/gtk3_widgets.ll', 'gui/sdl2_gl_triangle.ll', 'gpgpu/nbody3d.ll', 'gpgpu/fluid3d.ll', 'gui/music_player.ll', 'gui/midi_player.ll']) { const c = L.compileIr(fs.readFileSync(path.join(__dirname, '..', 'examples', 'llc', f), 'utf8'), {}); check('範例 ' + f + ' 編成 wasm', c.stage === 'ok' && !!WebAssembly.validate(c.wasm), c.errors); }
  // 鍵盤對照與格式化小單元
  check('scancode', H.scancodeOf('a') === 4 && H.scancodeOf('ArrowUp') === 82 && H.scancodeOf(' ') === 44 && H.scancodeOf('0') === 39 && H.scancodeOf('F1') === 58);
  // 檔案（stdio；x86_64 的宣告：size_t／long 是 i64）
  o = await run(`@path = private constant [6 x i8] c"t.txt\\00"
@w = private constant [2 x i8] c"w\\00"
@r = private constant [2 x i8] c"r\\00"
@data = private constant [13 x i8] c"hello\\0Aworld\\0A\\00"
@out = private constant [22 x i8] c"%ld %ld %s%d %d %d\\0A\\00"
declare ptr @fopen(ptr, ptr)
declare i32 @fclose(ptr)
declare i64 @fwrite(ptr, i64, i64, ptr)
declare ptr @fgets(ptr, i32, ptr)
declare i32 @fseek(ptr, i64, i32)
declare i64 @ftell(ptr)
declare i32 @remove(ptr)
declare i32 @access(ptr, i32)
declare i32 @printf(ptr, ...)
define i32 @main() {
  %buf = alloca [32 x i8]
  %f = call ptr @fopen(ptr @path, ptr @w)
  %n = call i64 @fwrite(ptr @data, i64 1, i64 12, ptr %f)
  call i32 @fclose(ptr %f)
  %g = call ptr @fopen(ptr @path, ptr @r)
  call i32 @fseek(ptr %g, i64 6, i32 0)
  %t = call i64 @ftell(ptr %g)
  call ptr @fgets(ptr %buf, i32 32, ptr %g)
  call i32 @fclose(ptr %g)
  %a1 = call i32 @access(ptr @path, i32 0)
  call i32 @remove(ptr @path)
  %a2 = call i32 @access(ptr @path, i32 0)
  call i32 (ptr, ...) @printf(ptr @out, i64 %n, i64 %t, ptr %buf, i32 %a1, i32 %a2, i32 0)
  ret i32 0
}`);
  check('fopen／fwrite／fseek／ftell／fgets／fclose／access／remove（i64 的 size_t 與 long）', o.stdout === '12 6 world\n0 -1 0\n' && !memfs.has('t.txt'), o);
  const r0 = fsx.write('in.txt', new Uint8Array([1, 2, 3])); void r0;
  o = await run(`@p = private constant [7 x i8] c"in.txt\\00"
@m = private constant [3 x i8] c"rb\\00"
@s = private constant [8 x i8] c"%d %d\\0A\\00"
@x = private constant [8 x i8] c"nope.x\\00\\00"
declare ptr @fopen(ptr, ptr)
declare i64 @fread(ptr, i64, i64, ptr)
declare i32 @fgetc(ptr)
declare i32 @feof(ptr)
declare i32 @printf(ptr, ...)
define i32 @main() {
  %buf = alloca [8 x i8]
  %f = call ptr @fopen(ptr @p, ptr @m)
  %n = call i64 @fread(ptr %buf, i64 1, i64 8, ptr %f)
  %e = call i32 @feof(ptr %f)
  %n32 = trunc i64 %n to i32
  call i32 (ptr, ...) @printf(ptr @s, i32 %n32, i32 %e)
  %z = call ptr @fopen(ptr @x, ptr @m)
  %isnull = icmp eq ptr %z, null
  %zz = zext i1 %isnull to i32
  ret i32 %zz
}`);
  check('fread 讀到檔尾（3 個、feof）；開不存在的檔回 NULL', o.stdout === '3 1\n' && o.exitCode === 1, o);
  // 全域陣列的初始值
  o = await run(`@a = private constant [3 x i32] [i32 7, i32 -2, i32 300]
@s = private constant [9 x i8] c"%d %d %d\\0A\\00"
declare i32 @printf(ptr, ...)
define i32 @main() {
  %p0 = getelementptr [3 x i32], ptr @a, i32 0, i32 0
  %v0 = load i32, ptr %p0
  %p1 = getelementptr [3 x i32], ptr @a, i32 0, i32 1
  %v1 = load i32, ptr %p1
  %p2 = getelementptr [3 x i32], ptr @a, i32 0, i32 2
  %v2 = load i32, ptr %p2
  call i32 (ptr, ...) @printf(ptr @s, i32 %v0, i32 %v1, i32 %v2)
  ret i32 0
}`);
  check('全域陣列的初始值 [i32 …]', o.stdout === '7 -2 300\n', o);
  // SDL 音訊的取樣格式轉換（→ 16 位元有號小端）
  const f32 = new Float32Array([0, 1, -1, 0.5]), s16 = host.toS16(new Uint8Array(f32.buffer), 0x8120);
  check('F32 → S16', Array.from(new Int16Array(s16.buffer, s16.byteOffset, 4)).join() === '0,32767,-32767,16384', Array.from(new Int16Array(s16.buffer)));
  check('U8 → S16（128＝0）', Array.from(new Int16Array(host.toS16(new Uint8Array([128, 255, 0]), 0x0008).buffer)).join() === '0,32512,-32768');
  check('U16 → S16', Array.from(new Int16Array(host.toS16(new Uint8Array(new Uint16Array([32768, 65535, 0]).buffer), 0x0010).buffer)).join() === '0,32767,-32768');
  check('S16 原樣', Array.from(host.toS16(new Uint8Array([1, 2, 3, 4]), 0x8010)).join() === '1,2,3,4');
  // OpenCL 墊片（CPU 後備）：opencl_vecadd.ll 真的跑——核心字串在執行時翻成 JS，buffer／NDRange／讀回
  { const ir = fs.readFileSync(path.join(__dirname, '../examples/llc/gpgpu/opencl_vecadd.ll'), 'utf8'); const c = L.compileIr(ir, {}); check('opencl_vecadd.ll 編得出來', !!c.wasm, c.errors);
    if (c.wasm) { const dec = {}; for (const d of L.parse(ir).mod.declares) dec[d.name] = d; const o2 = await L.runHost(c.wasm, { args: ['prog', '1000'] }, host.impls, undefined, dec);
      check('opencl_vecadd.ll 真輸出：n=1000 c[999]=2997', o2.stdout === 'vadd OK, n=1000 c=2997.000000\n' && o2.exitCode === 0, o2);
      const o3 = await L.runHost(c.wasm, { args: ['prog'] }, host.impls, undefined, dec); check('opencl_vecadd.ll 預設 n=1048576', /^vadd OK, n=1048576 c=3145725\.000000\n$/.test(o3.stdout) && o3.exitCode === 0, o3); } }
  // OpenCL → KIR 接線（階段 4）：同一份 opencl_vecadd.ll 改走 kirRun（這裡用 KIR 的 JS 後端當假的 GPU），結果要跟 JS 後備一樣，且 kirRun 真的被呼叫
  { const CF = require('../gpu/cl_front.js'), KIR = require('../gpu/kir.js'); let kirCalls = 0;
    const kh = H.create({ gui: async () => null, fs: fsx, kirTranslate: (src) => { const r = CF.parseKernels(src); if (!r.ok) return null; const m = {}; for (const k of r.kernels) { if (!KIR.validate(k).ok) return null; m[k.name] = k; } return m; },
      kirRun: (k, bufs, scal, N) => { kirCalls++; const out = {}; const B = {}; for (const p of k.params) if (p.kind === 'buf') B[p.name] = p.access === 'out' ? (out[p.name] = new Float32Array(N)) : bufs[p.name]; KIR.runJs(k, B, scal, N); return { out }; } });
    kh.install(L);
    const ir = fs.readFileSync(path.join(__dirname, '../examples/llc/gpgpu/opencl_vecadd.ll'), 'utf8'); const c = L.compileIr(ir, {});
    if (c.wasm) { const dec = {}; for (const d of L.parse(ir).mod.declares) dec[d.name] = d; const o = await L.runHost(c.wasm, { args: ['prog', '1000'] }, kh.impls, undefined, dec);
      check('opencl_vecadd.ll 走 KIR：輸出同 JS 後備，kirRun 被呼叫', o.stdout === 'vadd OK, n=1000 c=2997.000000\n' && o.exitCode === 0 && kirCalls === 1, { o, kirCalls }); }
    kh.uninstall(L); }
  // 常駐裝置（階段 6 步驟 1b）：同一份 opencl_vecadd.ll 改走 kirDev（假的裝置＝KIR 的 JS 後端，記錄上傳／讀回／派送次數）。
  // 要的：輸出與 JS 後備一樣；只有一次派送；讀回只發生在 clEnqueueReadBuffer（沒有多餘的上傳）。
  { const CF = require('../gpu/cl_front.js'), KIR = require('../gpu/kir.js'); const st = { alloc: 0, upload: 0, download: 0, dispatch: 0 };
    const fakeDev = { alloc: (N, elem) => { st.alloc++; return { N, elem, v: new Float32Array(N * (elem === 'f32x4' ? 4 : 1)) }; },
      upload: (b, arr) => { st.upload++; b.v.set(arr.subarray(0, b.v.length)); }, download: (b) => { st.download++; return b.v.slice(); },
      dispatch: (k, binds, out, scal, N) => { st.dispatch++; const B = {}; for (const p of k.params) if (p.kind === 'buf') B[p.name] = p.access === 'out' ? out.v : binds[p.name].v; KIR.runJs(k, B, scal, N); },
      free: () => {} };
    const dh = H.create({ gui: async () => null, fs: fsx, kirTranslate: (src) => { const r = CF.parseKernels(src); if (!r.ok) return null; const m = {}; for (const k of r.kernels) { if (!KIR.validate(k).ok) return null; m[k.name] = k; } return m; },
      kirRun: () => { throw new Error('不應該走 kirRun'); }, kirDev: fakeDev });
    dh.install(L);
    const ir = fs.readFileSync(path.join(__dirname, '../examples/llc/gpgpu/opencl_vecadd.ll'), 'utf8'); const c = L.compileIr(ir, {});
    if (c.wasm) { const dec = {}; for (const d of L.parse(ir).mod.declares) dec[d.name] = d; const o = await L.runHost(c.wasm, { args: ['prog', '1000'] }, dh.impls, undefined, dec);
      check('opencl_vecadd.ll 常駐裝置：輸出正確', o.stdout === 'vadd OK, n=1000 c=2997.000000\n' && o.exitCode === 0, { o: o.stdout, st });
      check('常駐裝置：一次派送、讀回只有 c（不多做）', st.dispatch === 1 && st.download === 1 && st.upload === 2, st);
      check('fa_cl_backend：裝置派送後回報 1（WebGL2）', dh.impls.fa_cl_backend() === 1, dh.impls.fa_cl_backend()); }
    dh.uninstall(L); }
  // 打包與 view（階段 6 步驟 1c）：vecadd 的輸出是一個兩部分打包緩衝區的第 1 部分（view）；讀回 view。
  // JS 路徑與假的打包裝置（allocPacked／view）都要得到 vadd OK，且裝置路徑只有一次派送、沒有多餘的上傳。
  { const CF = require('../gpu/cl_front.js'), KIR = require('../gpu/kir.js');
    const src = fs.readFileSync(path.join(__dirname, '../examples/llc/gpgpu/opencl_vecadd.ll'), 'utf8');
    const rep = (t, a, b) => { if (t.split(a).length !== 2) throw new Error('測試替換失敗：' + a); return t.replace(a, b); };
    let ir = rep(src, 'declare ptr @malloc(i32)', 'declare ptr @malloc(i32)\ndeclare i32 @fa_cl_pack(ptr, i32)\ndeclare ptr @fa_cl_view(ptr, i32)');
    ir = rep(ir, '  %bc = call ptr @clCreateBuffer(ptr %c, i64 2, i64 %bytes, ptr null, ptr %rc)    ; WRITE_ONLY',
      '  %bytes2 = mul i64 %bytes, 2\n  %bc = call ptr @clCreateBuffer(ptr %c, i64 2, i64 %bytes2, ptr null, ptr %rc)    ; WRITE_ONLY\n  %pk = call i32 @fa_cl_pack(ptr %bc, i32 2)\n  %vc = call ptr @fa_cl_view(ptr %bc, i32 1)');
    ir = rep(ir, '  store ptr %bc, ptr %dc', '  store ptr %vc, ptr %dc');
    ir = rep(ir, 'call i32 @clEnqueueReadBuffer(ptr %q, ptr %bc,', 'call i32 @clEnqueueReadBuffer(ptr %q, ptr %vc,');
    const cc = L.compileIr(ir, {});
    check('打包 view 的 vecadd 編得出來', !!cc.wasm, cc.errors);
    const mkPackDev = () => { const st = { packed: 0, view: 0, dispatch: 0, upload: 0, download: 0 };
      const dev = { st, alloc: (N) => ({ N, Npart: N, parts: 1, v: new Float32Array(N) }),
        allocPacked: (Npart, parts) => { st.packed++; return { N: Npart * parts, Npart, parts, packed: true, v: new Float32Array(Npart * parts) }; },
        view: (p, k) => { st.view++; return { N: p.Npart, Npart: p.Npart, parts: 1, v: p.v.subarray(k * p.Npart, (k + 1) * p.Npart) }; },
        upload: (b, arr) => { st.upload++; b.v.set(arr.subarray(0, b.v.length)); }, download: (b) => { st.download++; return b.v.slice(); },
        dispatch: (k, binds, out, scal, N) => { st.dispatch++; const B = {}; for (const p of k.params) if (p.kind === 'buf') B[p.name] = p.access === 'out' ? out.v : binds[p.name].v; KIR.runJs(k, B, scal, N); },
        free: () => {} };
      return dev; };
    const warnsDbg = []; const mkHost = (dev) => H.create({ gui: async () => null, fs: fsx, warn: (t) => warnsDbg.push(String(t)),
      kirTranslate: (src2) => { const r = CF.parseKernels(src2); if (!r.ok) return null; const m = {}; for (const k of r.kernels) { if (!KIR.validate(k).ok) return null; m[k.name] = k; } return m; },
      kirRun: () => { throw new Error('不應該走 kirRun'); }, kirDev: dev });
    const dec = {}; for (const d of L.parse(ir).mod.declares) dec[d.name] = d;
    // JS 路徑（沒有裝置）
    if (cc.wasm) {
      const jh = mkHost(null); jh.install(L);
      const o = await L.runHost(cc.wasm, { args: ['prog', '1000'] }, jh.impls, undefined, dec);
      check('打包 view：JS 路徑輸出正確', o.stdout === 'vadd OK, n=1000 c=2997.000000\n' && o.exitCode === 0, o.stdout);
      jh.uninstall(L);
      // 假的打包裝置
      const dev = mkPackDev(); const ph = mkHost(dev); ph.install(L);
      const o2 = await L.runHost(cc.wasm, { args: ['prog', '1000'] }, ph.impls, undefined, dec);
      check('打包 view：裝置路徑輸出正確', o2.stdout === 'vadd OK, n=1000 c=2997.000000\n' && o2.exitCode === 0, { out: o2.stdout, st: dev.st });
      check('打包 view：裝置路徑一次派送、打包配置一次、view 切出 1 個、輸入上傳 2 次加上打包 root 1 次（輸出 view 要求整張紋理同步）、讀回只有 view（1 次）', dev.st.dispatch === 1 && dev.st.packed === 1 && dev.st.view === 1 && dev.st.upload === 3 && dev.st.download === 1, { st: dev.st, warns: warnsDbg });
      ph.uninstall(L);
    }
  }
  { const k = H.clCompile('__kernel void f(__global const float*a,__global float*c,int n,float s){int i=get_global_id(0);if(i>=n)return;float t=0.0f;for(int j=0;j<3;j++)t+=a[i]*s;c[i]=sqrt(t)+(float)(n/2)+fabs(-1.0f)+(i%2);}');
    check('clCompile：多語句核心（for、return、型別轉換、整數除法）', !!k.kernels && !!k.kernels.f, k);
    if (k.kernels) { const a = new Float32Array([1, 4, 9]), cc = new Float32Array(3); k.kernels.f.run([3, 1, 1], [0, 0, 0], 1, [a, cc, 3, 3]); check('clCompile 執行結果（t＝9a，sqrt(9a)+1+1+(i%2)：5, 9, 11）', Array.from(cc).join() === '5,9,11', Array.from(cc)); } }
  for (const [why, src, re] of [['__local', '__kernel void f(__global float*a){__local float t[4];a[0]=1;}', /__local/], ['向量型別', '__kernel void f(__global float4*a){a[0]=a[0];}', /不支援的參數|沒有的功能/], ['輔助函式', 'float h(float x){return x;}\n__kernel void f(__global float*a){a[0]=h(1.0f);}', /輔助函式/], ['沒有核心', 'int x;', /除了 __kernel/]]) { const k = H.clCompile(src); check('clCompile 拒絕 ' + why + ' 並說明原因', !!k.error && re.test(k.error), k); }
  // 登記是暫時的：uninstall 之後 printf 又是「沒有實作」
  host.uninstall(L); r = L.compileIr('declare i32 @printf(ptr, ...)\ndefine i32 @main() {\n  call i32 (ptr, ...) @printf(ptr null)\n  ret i32 0\n}\n', {});
  check('uninstall 後取消登記', r.stage === 'check' && !L.HOST.printf, r.errors);
  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'llvm_host: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
