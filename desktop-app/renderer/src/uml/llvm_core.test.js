// node renderer/src/uml/llvm_core.test.js
const U = require('./uml_core.js'); const L = require('./llvm_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 600) : '')); };
const NL = String.fromCharCode(10);

// 把一段 IR 編成 wasm 並執行；回傳 { exit, out, err }
async function exec(src, withRuntime) {
    const g = fromParts(src, withRuntime); const p = L.parse(g); if (p.errors.length) return { err: 'parse:' + JSON.stringify(p.errors) };
    const e = L.check(p.mod); if (e.length) return { err: 'check:' + JSON.stringify(e) };
    let w; try { w = L.toWasm(p.mod); } catch (x) { return { err: 'wasm:' + x.message }; }
    if (!WebAssembly.validate(w)) return { err: 'invalid wasm' };
    const r = await L.run(w); return { exit: r.exitCode, out: r.stdout, trap: r.trap };
}
function fromParts(src, withRuntime) {
    if (!withRuntime) return src;
    const rt = L.fromModel(U.emptyModel()).ir; // 空模型：只有 runtime 與一個空的 _start
    const base = rt.slice(0, rt.indexOf('define void @_start()')); return base + src;
}

(async () => {
    // ---- 運算、迴圈、遞迴 ----
    let r = await exec('define i32 @main() {\nentry:\n  %a = mul i32 7, 6\n  %b = sub i32 %a, 2\n  %c = sdiv i32 %b, 4\n  %d = srem i32 10, 4\n  %e = add i32 %c, %d\n  %f = add nsw i32 %e, 0\n  ret i32 %f\n}');
    check('整數運算：(7*6-2)/4 + 10%4 = 12', r.exit === 12, r);
    r = await exec(['define i32 @main() {', 'entry:', '  %n = alloca i32', '  %acc = alloca i32', '  store i32 5, i32* %n', '  store i32 1, i32* %acc', '  br label %loop', 'loop:', '  %nv = load i32, i32* %n', '  %done = icmp sle i32 %nv, 1', '  br i1 %done, label %out, label %body', 'body:', '  %av = load i32, i32* %acc', '  %m = mul i32 %av, %nv', '  store i32 %m, i32* %acc', '  %n2 = sub i32 %nv, 1', '  store i32 %n2, i32* %n', '  br label %loop', 'out:', '  %res = load i32, i32* %acc', '  ret i32 %res', '}'].join(NL));
    check('迴圈：5! = 120', r.exit === 120, r);
    r = await exec(['define i32 @fib(i32 %n) {', 'entry:', '  %c = icmp slt i32 %n, 2', '  br i1 %c, label %base, label %rec', 'base:', '  ret i32 %n', 'rec:', '  %a = sub i32 %n, 1', '  %b = sub i32 %n, 2', '  %x = call i32 @fib(i32 %a)', '  %y = call i32 @fib(i32 %b)', '  %s = add i32 %x, %y', '  ret i32 %s', '}', 'define i32 @main() {', 'entry:', '  %r = call i32 @fib(i32 10)', '  ret i32 %r', '}'].join(NL));
    check('遞迴：fib(10) = 55', r.exit === 55, r);
    r = await exec(['define i32 @main() {', 'entry:', '  %i = alloca i32', '  %j = alloca i32', '  %s = alloca i32', '  store i32 0, i32* %s', '  store i32 1, i32* %i', '  br label %oc', 'oc:', '  %iv = load i32, i32* %i', '  %ic = icmp sle i32 %iv, 3', '  br i1 %ic, label %ob, label %end', 'ob:', '  store i32 1, i32* %j', '  br label %ic2', 'ic2:', '  %jv = load i32, i32* %j', '  %jc = icmp sle i32 %jv, 4', '  br i1 %jc, label %ib, label %inext', 'ib:', '  %p = mul i32 %iv, %jv', '  %sv = load i32, i32* %s', '  %s2 = add i32 %sv, %p', '  store i32 %s2, i32* %s', '  %j2 = add i32 %jv, 1', '  store i32 %j2, i32* %j', '  br label %ic2', 'inext:', '  %i2 = add i32 %iv, 1', '  store i32 %i2, i32* %i', '  br label %oc', 'end:', '  %res = load i32, i32* %s', '  ret i32 %res', '}'].join(NL));
    check('巢狀迴圈：sum(i*j) i≤3 j≤4 = 60', r.exit === 60, r);

    // ---- i64、浮點、型別轉換 ----
    r = await exec('define i32 @main() {\nentry:\n  %a = shl i64 1, 40\n  %b = shl i64 1, 38\n  %c = sdiv i64 %a, %b\n  %d = trunc i64 %c to i32\n  ret i32 %d\n}'); check('i64：2^40 / 2^38 = 4', r.exit === 4, r);
    r = await exec('define i32 @main() {\nentry:\n  %a = fmul double 1.5, 4.0\n  %b = fadd double %a, 0.5\n  %c = fptosi double %b to i32\n  ret i32 %c\n}'); check('浮點：1.5*4+0.5 → 6', r.exit === 6, r);
    r = await exec('define i32 @main() {\nentry:\n  %a = sitofp i32 7 to double\n  %b = fdiv double %a, 2.0\n  %c = fcmp ogt double %b, 3.4\n  %d = zext i1 %c to i32\n  ret i32 %d\n}'); check('fcmp／sitofp：7/2 > 3.4', r.exit === 1, r);
    r = await exec('define i32 @main() {\nentry:\n  %a = trunc i32 300 to i8\n  %b = zext i8 %a to i32\n  ret i32 %b\n}'); check('trunc i32→i8：300 → 44', r.exit === 44, r);
    r = await exec('define i32 @main() {\nentry:\n  %a = trunc i32 255 to i8\n  %b = sext i8 %a to i32\n  %c = add i32 %b, 10\n  ret i32 %c\n}'); check('sext i8：-1 + 10 = 9', r.exit === 9, r);
    r = await exec('define i32 @main() {\nentry:\n  %a = sext i32 -5 to i64\n  %b = add i64 %a, 8\n  %c = trunc i64 %b to i32\n  ret i32 %c\n}'); check('sext i32→i64', r.exit === 3, r);
    r = await exec('define i32 @main() {\nentry:\n  %a = icmp ugt i32 -1, 5\n  %b = icmp sgt i32 -1, 5\n  %x = zext i1 %a to i32\n  %y = zext i1 %b to i32\n  %z = shl i32 %x, 1\n  %w = or i32 %z, %y\n  ret i32 %w\n}'); check('無號與有號比較', r.exit === 2, r);
    r = await exec('define i32 @main() {\nentry:\n  %c = icmp sgt i32 5, 3\n  %v = select i1 %c, i32 10, i32 20\n  ret i32 %v\n}'); check('select', r.exit === 10, r);

    // ---- struct、全域、字串 ----
    r = await exec(['%P = type { i32, double, i32 }', 'define i32 @main() {', 'entry:', '  %p = alloca %P', '  %f0 = getelementptr %P, %P* %p, i32 0, i32 0', '  %f1 = getelementptr %P, %P* %p, i32 0, i32 1', '  %f2 = getelementptr %P, %P* %p, i32 0, i32 2', '  store i32 20, i32* %f0', '  store double 2.5, double* %f1', '  store i32 5, i32* %f2', '  %a = load i32, i32* %f0', '  %b = load double, double* %f1', '  %c = load i32, i32* %f2', '  %bi = fptosi double %b to i32', '  %s = add i32 %a, %c', '  %t = add i32 %s, %bi', '  ret i32 %t', '}'].join(NL));
    check('struct：欄位排版與讀寫（20 + 5 + 2）', r.exit === 27, r);
    r = await exec(['@g = global i32 5', '@k = constant [4 x i32] zeroinitializer', 'define i32 @main() {', 'entry:', '  %v = load i32, i32* @g', '  %w = add i32 %v, 37', '  store i32 %w, i32* @g', '  %x = load i32, i32* @g', '  %e = getelementptr [4 x i32], [4 x i32]* @k, i32 0, i32 2', '  %ev = load i32, i32* %e', '  %r = add i32 %x, %ev', '  ret i32 %r', '}'].join(NL)); check('全域變數與陣列', r.exit === 42, r);
    r = await exec(['define i32 @main() {', 'entry:', '  %a = alloca [4 x i32]', '  %i = alloca i32', '  store i32 0, i32* %i', '  br label %l', 'l:', '  %iv = load i32, i32* %i', '  %p = getelementptr [4 x i32], [4 x i32]* %a, i32 0, i32 %iv', '  %sq = mul i32 %iv, %iv', '  store i32 %sq, i32* %p', '  %n = add i32 %iv, 1', '  store i32 %n, i32* %i', '  %c = icmp slt i32 %n, 4', '  br i1 %c, label %l, label %d', 'd:', '  %q = getelementptr [4 x i32], [4 x i32]* %a, i32 0, i32 3', '  %v = load i32, i32* %q', '  ret i32 %v', '}'].join(NL)); check('動態索引的陣列：3*3 = 9', r.exit === 9, r);
    r = await exec(['@s = private constant [13 x i8] c"h\\C3\\A9llo \\E4\\B8\\AD\\E6\\96\\87\\0A\\00"', 'define void @_start() {', 'entry:', '  call void @rt_print(i8* getelementptr inbounds ([13 x i8], [13 x i8]* @s, i32 0, i32 0))', '  call void @rt_print_int(i32 -123)', '  call void @rt_print(i8* getelementptr inbounds ([13 x i8], [13 x i8]* @s, i32 0, i32 6))', '  call void @rt_print_int(i32 0)', '  call void @rt_print_int(i32 2147483647)', '  ret void', '}'].join(NL), true);
    check('字串（含非 ASCII）與整數輸出', r.out === 'héllo 中文' + NL + '-123' + ' 中文' + NL + '0' + '2147483647', r);
    r = await exec(['declare void @proc_exit(i32)', 'define void @_start() {', 'entry:', '  call void @proc_exit(i32 3)', '  unreachable', '}'].join(NL)); check('proc_exit 的結束碼', r.exit === 3, r);
    r = await exec(['define i32 @main() {', 'entry:', '  %p = call i8* @rt_alloc(i32 16)', '  %q = call i8* @rt_alloc(i32 16)', '  %a = ptrtoint i8* %p to i32', '  %b = ptrtoint i8* %q to i32', '  %d = sub i32 %b, %a', '  ret i32 %d', '}'].join(NL), true); check('alloc：每次 16 位元組、對齊 8', r.exit === 16, r);

    // ---- 檢查器：能擋的錯 ----
    const errOf = (src) => { const p = L.parse(src); if (p.errors.length) return 'P:' + p.errors.map((e) => e.msg).join('；'); return 'C:' + L.check(p.mod).map((e) => (e.line ? e.line + ':' : '') + e.msg).join('；'); };
    const E = (name, src, re) => { const m = errOf(src); check('檢查器：' + name, re.test(m), m); };
    E('使用沒定義的暫存器', 'define i32 @main() {\nentry:\n  %a = add i32 %x, 1\n  ret i32 %a\n}', /%x 沒有定義/);
    E('在定義之前使用', 'define i32 @main() {\nentry:\n  %a = add i32 %b, 1\n  %b = add i32 1, 1\n  ret i32 %a\n}', /在定義之前就使用/);
    E('型別不符的 store', 'define i32 @main() {\nentry:\n  %p = alloca i32\n  store double 1.0, i32* %p\n  ret i32 0\n}', /不能把 double 存到 i32\*/);
    E('二元運算兩邊型別不同', 'define i32 @main() {\nentry:\n  %a = alloca i32\n  %v = load i32, i32* %a\n  %w = add i64 %v, 1\n  ret i32 0\n}', /型別不符/);
    E('呼叫參數數量不對', 'define i32 @f(i32 %a) {\nentry:\n  ret i32 %a\n}\ndefine i32 @main() {\nentry:\n  %r = call i32 @f(i32 1, i32 2)\n  ret i32 %r\n}', /要 1 個參數，給了 2 個/);
    E('呼叫的參數型別不對', 'define i32 @f(i32 %a) {\nentry:\n  ret i32 %a\n}\ndefine i32 @main() {\nentry:\n  %r = call i32 @f(double 1.0)\n  ret i32 %r\n}', /第 1 個參數要 i32/);
    E('呼叫沒有定義的函式', 'define i32 @main() {\nentry:\n  %r = call i32 @nope()\n  ret i32 %r\n}', /沒有定義的函式 @nope/);
    E('缺少結尾', 'define i32 @main() {\nentry:\n  %a = add i32 1, 1\n}', /沒有結尾/);
    E('跳到不存在的標籤', 'define i32 @main() {\nentry:\n  br label %gone\n}', /沒有標籤 gone/);
    E('ret 型別不對', 'define i32 @main() {\nentry:\n  ret double 1.0\n}', /要回傳 i32/);
    E('void 函式的回傳值被指定', 'define void @f() {\nentry:\n  ret void\n}\ndefine i32 @main() {\nentry:\n  %r = call void @f()\n  ret i32 0\n}', /void 函式沒有回傳值/);
    E('結尾後面還有指令', 'define i32 @main() {\nentry:\n  ret i32 0\n  %a = add i32 1, 1\n}', /已經結束了/);
    E('暫存器定義兩次', 'define i32 @main() {\nentry:\n  %a = add i32 1, 1\n  %a = add i32 2, 2\n  ret i32 %a\n}', /定義了兩次/);
    E('struct 索引超出範圍', '%P = type { i32 }\ndefine i32 @main() {\nentry:\n  %p = alloca %P\n  %f = getelementptr %P, %P* %p, i32 0, i32 3\n  ret i32 0\n}', /只有 1 個欄位/);
    E('沒有進入點', 'define i32 @other() {\nentry:\n  ret i32 0\n}', /沒有進入點/);
    E('phi 第一版不支援', 'define i32 @main() {\nentry:\n  br label %a\na:\n  %x = phi i32 [ 0, %entry ]\n  ret i32 %x\n}', /不支援 phi/);
    E('不認得的指令', 'define i32 @main() {\nentry:\n  %x = frobnicate i32 1\n  ret i32 0\n}', /不支援的指令/);
    E('沒有實作的外部函式', 'declare i32 @printf(i8*)\ndefine i32 @main() {\nentry:\n  ret i32 0\n}', /沒有實作/);
    E('i8 的有號比較要先 sext', 'define i32 @main() {\nentry:\n  %c = icmp slt i8 1, 2\n  ret i32 0\n}', /有號比較/);
    E('load 的型別跟指標不合', 'define i32 @main() {\nentry:\n  %p = alloca i32\n  %v = load double, i32* %p\n  ret i32 0\n}', /載不出/);
    check('解析：錯誤帶行號', (() => { const p = L.parse('define i32 @main() {\nentry:\n  %x = frobnicate i32 1\n  ret i32 0\n}'); return p.errors.length === 1 && p.errors[0].line === 3; })());
    check('型別名稱與大小', L.typeStr(L.parseType('{ i32, [4 x i8], %P* }')) === '{ i32, [4 x i8], %P* }' && L.layout({ types: new Map() }, L.parseType('{ i8, i32, double }')).size === 16);

    // ---- UML → IR → wasm → 執行 → 跟預期軌跡一致 ----
    const models = {
        '商店': 'model: Shop\nactor: User\nclass Cart { +id:int; +name:str; +add(item:str):void; +total():float }\nclass Order { +id:int; +pay(amount:float):bool }\nusecase 下單: User -> Cart.add(i) -> Order.pay(p)\nusecase 查看: User -> Cart.total()',
        '沒有 id 的類別、靜態操作': 'model: M\nactor: A\nclass Util { +name:str; +hello(n:int):int }\nclass Svc { +id:int; +run(flag:bool, price:float, label:str):str }\nusecase go: A -> Svc.run(x) -> Util.hello(y)',
        '繼承': 'model: Z\nactor: A\nclass Base { +id:int; +ping():void }\nclass Child extends Base { +extra:float; +pong():void }\nusecase t: A -> Child.pong() -> Base.ping()',
        '容器型別（用空指標代替並警告）': 'model: C\nactor: A\nclass Box { +id:int; +items:List<str>; +put(x:str):void }\nusecase p: A -> Box.put(x) -> Box.put(y)',
        '列舉參數': 'model: E\nactor: A\nenum Color { RED, GREEN }\nclass Pen { +id:int; +paint(c:Color):void }\nusecase p: A -> Pen.paint(c)',
        '很多使用案例': 'model: K\nactor: A\nclass S { +id:int; +a():void; +b():void; +c():int }\n' + [1, 2, 3, 4, 5, 6].map((i) => 'usecase u' + i + ': A -> S.a() -> S.b() -> S.c()').join('\n')
    };
    for (const [name, dsl] of Object.entries(models)) {
        const parsed = U.parseDsl(dsl); if (parsed.errors.length) { check('前提：' + name + ' 的 UML 讀得進來', false, parsed.errors); continue; }
        const b = await L.build(parsed.model);
        check('UML→wasm：' + name + '（軌跡一致）', b.ok && b.stdout === b.expected && b.exitCode === 0, { stage: b.stage, errors: b.errors, out: b.stdout, exp: b.expected, trap: b.trap });
        if (b.wasm) check('wasm 是合法的：' + name, WebAssembly.validate(b.wasm));
        if (name.startsWith('容器')) check('容器型別有警告', b.warnings.some((w) => /沒有容器支援/.test(w)), b.warnings);
        if (name === '繼承') check('繼承有警告', b.warnings.some((w) => /沒有虛擬呼叫/.test(w)), b.warnings);
    }
    const emptyB = await L.build(U.emptyModel()); check('空的 UML：只有進入點，沒有輸出', emptyB.ok && emptyB.stdout === '', emptyB);
    const noRun = await L.build(U.parseDsl(models['商店']).model, { run: false }); check('只編譯不執行', noRun.ok && noRun.wasm.length > 100 && !('stdout' in noRun));
    const gen = L.fromModel(U.parseDsl(models['商店']).model);
    check('IR 長相：struct、函式、字串、_start', /%Cart = type \{ i32, ptr \}/.test(gen.ir) && /define void @Cart_add\(ptr %self, ptr %p0\)/.test(gen.ir) && /@_start/.test(gen.ir) && /wasm32/.test(gen.ir), gen.ir.slice(0, 400));
    check('IR 用不透明指標（沒有 i8* 這種舊寫法），LLVM 15 以後都吃得進去', !/\w\*[ ,)]/.test(gen.ir.split(NL).filter((l) => !/^;/.test(l)).join(NL)) && /"wasm-import-module"="wasi_snapshot_preview1"/.test(gen.ir) && /target datalayout/.test(gen.ir), gen.ir.match(/\w\*[ ,)]/));
    // 現代寫法的手寫 IR（ptr、常數 getelementptr 位移）
    r = await exec(['@s = private constant [6 x i8] c"abcde\\00"', 'define void @_start() {', 'entry:', '  call void @rt_print(ptr getelementptr inbounds (i8, ptr @s, i32 2))', '  %p = alloca i32', '  store i32 7, ptr %p', '  %v = load i32, ptr %p', '  call void @rt_print_int(i32 %v)', '  ret void', '}'].join(NL), true);
    check('不透明指標：常數位移與 alloca／load／store', r.out === 'cde' + '7', r);
    check('預期軌跡', gen.expected === '== 下單 ==' + NL + 'Cart#1.add' + NL + 'Order#1.pay' + NL + '== 查看 ==' + NL + 'Cart#1.total' + NL, gen.expected);
    // 軌跡不一致要抓得到：把預期的順序弄錯
    const tamper = await (async () => { const g = L.fromModel(U.parseDsl(models['商店']).model); const p = L.parse(g.ir); const w = L.toWasm(p.mod); const rr = await L.run(w); return rr.stdout !== g.expected.split(NL).reverse().join(NL); })(); check('順序不同的軌跡不會被當成一樣', tamper);

    console.log('llvm_core: ' + ok + ' passed, ' + bad.length + ' failed'); if (bad.length) { console.log(bad.join(NL)); process.exit(1); }
})();
