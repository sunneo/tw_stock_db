// node renderer/src/uml/llvm_host.test.js -- LLVM IR 的主機函式庫：簽名檢查、printf 家族、float／可變參數／函式指標的編譯、examples/llc 三個範例都能編成 wasm。
// （SDL_Delay、PollEvent、gtk_main 要 JSPI，node 沒有；它們在真 Electron 的 scripts/eval/llc_host.eval.js 驗證。）
const fs = require('fs'), path = require('path');
const L = require('./llvm_core.js'), H = require('./llvm_host.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 240) : '')); };
const host = H.create({ gui: async () => null }); host.install(L);
const run = async (ir) => { const r = L.compileIr(ir, {}); if (!r.wasm) return { errors: r.errors }; const o = await L.runHost(r.wasm, { args: ['prog', 'x'] }, host.impls); return o; };
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
  for (const f of ['game/sdl2_pong.ll', 'gui/gtk3_widgets.ll', 'gui/sdl2_gl_triangle.ll']) { const c = L.compileIr(fs.readFileSync(path.join(__dirname, '..', 'examples', 'llc', f), 'utf8'), {}); check('範例 ' + f + ' 編成 wasm', c.stage === 'ok' && !!WebAssembly.validate(c.wasm), c.errors); }
  // 鍵盤對照與格式化小單元
  check('scancode', H.scancodeOf('a') === 4 && H.scancodeOf('ArrowUp') === 82 && H.scancodeOf(' ') === 44 && H.scancodeOf('0') === 39 && H.scancodeOf('F1') === 58);
  // 登記是暫時的：uninstall 之後 printf 又是「沒有實作」
  host.uninstall(L); r = L.compileIr('declare i32 @printf(ptr, ...)\ndefine i32 @main() {\n  call i32 (ptr, ...) @printf(ptr null)\n  ret i32 0\n}\n', {});
  check('uninstall 後取消登記', r.stage === 'check' && !L.HOST.printf, r.errors);
  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'llvm_host: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
