'use strict';
// JSON 型別 → C++ struct 與物件對應（json_struct_core.js）：由範例 JSON 推結構、產生 struct＋load／save，真 g++ 編譯執行，輸出與 Python 的 json.dumps(json.loads(s)) 逐字對照。
// 涵蓋：巢狀物件、陣列、空陣列、空物件、null（可空）、欄位缺少（可省略）、整數／浮點（含 Python 的浮點格式：1e-05、1e+16、-0.0）、大整數（超過 64 位元不失精度）、
// 字串跳脫與非 ASCII（\uXXXX、代理對）、重複的鍵、型別描述、鍵不固定的字典、根是陣列、格式錯誤兩邊都失敗。天真對照組：把大整數當 double、不逸出非 ASCII 會答錯。
// 工具鏈：g++＝mingw64（PATH 放最前面）、python；找不到就略過並印原因。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const JS = require('./json_struct_core.js');
const MING = process.env.FA_MINGW_BIN || 'J:\\msys64\\mingw64\\bin'; const GPP = path.join(MING, 'g++.exe'), GCC = path.join(MING, 'gcc.exe'); const ENVM = Object.assign({}, process.env, { PATH: MING + path.delimiter + (process.env.PATH || '') });
let pass = 0, fail = 0; const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 14).join('\n   ')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jst-'));
let PY = null; for (const c of ['python', 'python3']) { const r = cp.spawnSync(c, ['-I', '-c', 'print(1)'], { encoding: 'utf8' }); if (r.status === 0 && r.stdout.trim() === '1') { PY = c; break; } }
const pyRef = (text) => { const r = cp.spawnSync(PY, ['-I', '-X', 'utf8', '-c', 'import sys,json\ntry:\n    print(json.dumps(json.loads(sys.stdin.read())))\nexcept Exception:\n    print("ERROR")'], { input: text, encoding: 'utf8' }); return r.stdout.replace(/\r\n/g, '\n').trimEnd(); };
const build = (schema, tag) => { const gen = JS.genCpp(schema, { main: true }); const f = path.join(tmp, tag + '.cpp'), exe = path.join(tmp, tag + '.exe'); fs.writeFileSync(f, gen.code); const c = cp.spawnSync(GPP, ['-std=c++17', '-O0', '-Wall', '-o', exe, f], { encoding: 'utf8', env: ENVM, timeout: 120000 }); assert.strictEqual(c.status, 0, 'g++ 編譯失敗：\n' + String(c.stderr).split('\n').filter((l) => /error/.test(l)).slice(0, 6).join('\n') + '\n' + gen.code.split('\n').filter((l) => /^struct |^    [A-Za-z:<>_, ]+ [A-Za-z_0-9]+;$/.test(l)).slice(0, 14).join('\n')); return exe; };
const buildC = (schema, tag) => { const gen = JS.genC(schema, { main: true }); const f = path.join(tmp, tag + '.c'), exe = path.join(tmp, tag + '_c.exe'); fs.writeFileSync(f, gen.code); const c = cp.spawnSync(GCC, ['-std=gnu11', '-O0', '-Wall', '-Wextra', '-Wno-unused-parameter', '-o', exe, f], { encoding: 'utf8', env: ENVM, timeout: 120000 }); assert.strictEqual(c.status, 0, 'gcc 編譯失敗：\n' + String(c.stderr).split('\n').filter((l) => /error|warning/.test(l)).slice(0, 8).join('\n')); assert.ok(!/warning/.test(c.stderr), '產生的 C 有警告：' + String(c.stderr).slice(0, 600)); return exe; };
const runExe = (exe, input) => { const r = cp.spawnSync(exe, [], { input, encoding: 'utf8', env: ENVM, timeout: 20000 }); return r.stdout.replace(/\r\n/g, '\n').trimEnd(); };

const SAMPLES = [
    ['巢狀物件、陣列、null、布林', '{"name":"A","age":3,"score":1.5,"tags":["x","y"],"addr":{"city":"T","zip":null},"items":[{"id":1,"ok":true},{"id":2,"ok":false}]}'],
    ['空陣列與空物件', '{"a":[],"b":{},"c":[[],[1]]}'],
    ['字串跳脫與非 ASCII（代理對、控制字元）', '{"s":"line\\nTab\\t\\"q\\" \\\\ \\u00e9 \\u4e2d \\ud83d\\ude00 \\u0001 /","k\\u00e9y":1}'],
    ['大整數與 64 位元邊界', '{"n":123456789012345678901234567890,"lo":-9223372036854775808,"hi":9223372036854775807,"z":-0}'],
    ['浮點格式（與 Python repr 一致）', '{"a":1.0,"b":1e-05,"c":1e16,"d":0.1,"e":-0.0,"f":123456789.123,"g":1.5e300,"h":1E5,"i":0.30000000000000004,"j":5e-324}'],
    ['根是整數陣列', '[1,2,3]'],
    ['根是空陣列', '[]'],
    ['陣列元素欄位缺少與 null（合併成可省略／可空）', '[{"a":1},{"a":2,"b":null},{"a":3,"b":"x"}]'],
    ['整數與浮點混在同一欄位', '{"v":[1,2.5,3]}'],
    ['重複的鍵（後者蓋掉前者、位置不變）', '{"a":1,"b":2,"a":3}'],
    ['根是 null', 'null'],
    ['型別混雜的欄位（變 any）', '{"v":[1,"a",null,{"x":1},[2]]}'],
    ['空白與換行', ' \n {"a" : [ 1 , 2 ] ,\n "b":"x" }\n ']
];
(async () => {
    if (!PY || !fs.existsSync(GPP)) { console.log('略過：找不到 ' + (!PY ? 'python' : GPP) + '\n0 passed, 0 failed'); return; }
    SAMPLES.forEach(([name, text], idx) => {
        t(name + '：推結構→C++→load→save 與 Python 一致', () => {
            const schema = JS.inferSchema([text], { name: 'Root' }); const exe = build(schema, 'a' + idx); const want = pyRef(text); assert.notStrictEqual(want, 'ERROR');
            assert.strictEqual(runExe(exe, text), want, '輸入 ' + text);
            const exeC = buildC(schema, 'c' + idx); assert.strictEqual(runExe(exeC, text), want, 'C 版 輸入 ' + text);
            // 結構描述存檔再讀回，產生的程式一樣
            const back = JS.loadSchema(JS.saveSchema(schema)); assert.strictEqual(JS.genCpp(back, { main: true }).code, JS.genCpp(schema, { main: true }).code);
        });
    });
    t('格式錯誤：兩邊都失敗（C++ 印 ERROR 並以非 0 結束，Python 丟例外）', () => {
        const schema = JS.inferSchema(['{"a":1}']); const exe = build(schema, 'bad'); const exeC = buildC(schema, 'badc');
        for (const bad of ['{"a":1', '{"a":01}', '{"a":1,}', '{"a" 1}', '[1,2', '{"a":"x\ny"}', '{"a":1} x', '{"a":+1}', '']) { assert.strictEqual(pyRef(bad), 'ERROR', 'Python 竟然接受 ' + JSON.stringify(bad)); assert.strictEqual(runExe(exe, bad), 'ERROR', 'C++ 竟然接受 ' + JSON.stringify(bad)); assert.strictEqual(runExe(exeC, bad), 'ERROR', 'C 竟然接受 ' + JSON.stringify(bad)); }
    });
    t('C 的限制：JSON 字串含 \\u0000 會被拒絕（C 字串不能含 NUL）；C++ 照常接受', () => {
        const schema = JS.inferSchema(['{"s":"a"}']); const z = '{"s":"a\\u0000b"}'; assert.strictEqual(runExe(buildC(schema, 'nulc'), z), 'ERROR'); assert.strictEqual(runExe(build(schema, 'nulcpp'), z), pyRef(z));
    });
    t('型別描述：巢狀、可空、可省略、字典；缺必要欄位報錯、可省略欄位缺少時不輸出（欄位順序依宣告，所以比內容不比順序）', () => {
        const same = (a, b, m) => assert.deepStrictEqual(JSON.parse(a), JSON.parse(b), m);
        const schema = JS.parseTypeDesc({ id: 'int', 'nick?': 'str', tags: ['str'], extra: 'any', meta: { '*': 'float' }, parent: { name: 'str' }, 'maybe': 'int?' }, { name: 'User' });
        const exe = build(schema, 'desc'); const ok = '{"id":7,"tags":["a"],"extra":{"z":[1,null]},"meta":{"x":1.5,"y":2.0},"parent":{"name":"P"},"maybe":null}';
        const exeC = buildC(schema, 'descc'); same(runExe(exe, ok), pyRef(ok), '型別描述的程式'); same(runExe(exeC, ok), pyRef(ok), '型別描述的程式（C）'); assert.ok(!/nick/.test(runExe(exe, ok)), '可省略欄位缺少時不該輸出');
        assert.strictEqual(runExe(exe, '{"tags":[]}'), 'ERROR', '缺必要欄位 id 應報錯'); assert.strictEqual(runExe(exeC, '{"tags":[]}'), 'ERROR', 'C 缺必要欄位 id 應報錯');
        const full = '{"id":1,"tags":[],"extra":null,"meta":{},"parent":{"name":"x"},"maybe":3,"nick":"n"}'; same(runExe(exe, full), pyRef(full)); same(runExe(exeC, full), pyRef(full));
        assert.strictEqual(runExe(exe, '{"id":null,"tags":[],"extra":1,"meta":{},"parent":{"name":"x"},"maybe":1}'), 'ERROR', '必要欄位是 null 應報錯');
        assert.throws(() => JS.parseTypeDesc({ a: 'integer' }), /不認得的型別/); assert.throws(() => JS.parseTypeDesc({ a: [] }), /剛好一個元素/);
    });
    t('多個範例合併：欄位缺→可省略、出現 null→可空、int＋float→number（保留整數或浮點）、缺少與 null 分得開', () => {
        const s = JS.inferSchema(['{"a":1,"b":2}', '{"a":2.5,"c":"x"}', '{"a":3,"b":null}']); const f = Object.fromEntries(s.type.fields.map((x) => [x.name, x]));
        assert.strictEqual(f.a.ty.k, 'number'); assert.ok(f.b.opt && f.b.ty.nullable && f.b.ty.k === 'int'); assert.ok(f.c.opt && f.c.ty.k === 'str');
        const exe = build(s, 'merge'); const exeC = buildC(s, 'mergec'); for (const x of ['{"a":1,"b":2}', '{"a":2.5,"c":"x"}', '{"a":3,"b":null}', '{"a":4}']) assert.deepStrictEqual(JSON.parse(runExe(exe, x)), JSON.parse(pyRef(x)), x);
        assert.strictEqual(runExe(exeC, '{"a":4}'), '{"a": 4}', 'C 缺少的鍵不該變成 null'); assert.strictEqual(runExe(exeC, '{"a":4,"b":null}'), '{"a": 4, "b": null}'); assert.strictEqual(runExe(exe, '{"a":4}'), '{"a": 4}', '缺少的鍵不該變成 null'); assert.strictEqual(runExe(exe, '{"a":4,"b":null}'), '{"a": 4, "b": null}');
    });
    t('結構描述存檔格式：版本、未知版本與壞檔如實拒絕', () => {
        const s = JS.inferSchema(['{"a":[1]}']); const txt = JS.saveSchema(s); assert.strictEqual(JSON.parse(txt).fa_struct, 1); assert.deepStrictEqual(JS.loadSchema(txt), s);
        assert.throws(() => JS.loadSchema('{"fa_struct":99,"type":{"k":"int"}}'), /比這個程式新/); assert.throws(() => JS.loadSchema('{"type":{"k":"int"}}'), /不是 fa-struct/); assert.throws(() => JS.loadSchema('{"fa_struct":1,"type":{"k":"zzz"}}'), /不認得的型別/);
    });
    t('對照組：大整數當 double、不逸出非 ASCII 的天真寫法會答錯（證明樣本測得到差異）', () => {
        const big = '{"n":123456789012345678901234567890}'; assert.notStrictEqual(JSON.stringify(JSON.parse(big)), pyRef(big)); // JavaScript 的 JSON.parse 失精度
        const uni = '{"s":"é中"}'; assert.notStrictEqual(JSON.stringify(JSON.parse(uni)), pyRef(uni)); // 沒逸出非 ASCII，且分隔符沒有空白
        const gen = JS.genCpp(JS.inferSchema([big]), { main: true }).code; assert.ok(/BigInt/.test(gen), '大整數欄位應用 BigInt');
    });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
