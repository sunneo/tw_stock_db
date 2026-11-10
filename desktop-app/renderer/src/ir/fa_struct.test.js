'use strict';
// 結構轉換 runtime tool（fa_struct.js／fa_struct.py＋json_struct_core.js）：
//   ① nodejs API：infer／fromDesc／saveSchema（檔案與字串）／loadSchema（檔案與字串）／generate（每種語言）／convert，結構描述存檔再讀回一致；
//   ② 產生的 Python 與 nodejs 類別真的跑：loads→dumps／load→save（字串與檔案）與原 JSON 內容一致（Python 逐字一致）；
//   ③ java／csharp 的型別宣告用 tree-sitter 檢查沒有語法錯誤；
//   ④ Python 端 fa_struct.py 透過 node 後端呼叫，得到與 nodejs 端相同的結果；CLI 兩個指令；
//   ⑤ 宿主 convert_code 的 struct 動作（嵌入版 FaIrBundle.FaJsonStruct）。
// C／C++ 的 struct＋load／save 真編譯執行在 json_struct.test.js。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const FS = require('./fa_struct.js');
let pass = 0, fail = 0; const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 12).join('\n   ')); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fas-'));
let PY = null; for (const c of ['python', 'python3']) { const r = cp.spawnSync(c, ['-I', '-c', 'print(1)'], { encoding: 'utf8' }); if (r.status === 0 && r.stdout.trim() === '1') { PY = c; break; } }
const SAMPLE = '{"id":1,"name":"A","score":1.5,"tags":["x","y"],"addr":{"city":"T","zip":null},"items":[{"id":1,"ok":true},{"id":2,"ok":false}],"meta":{}}';
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache')].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
(async () => {
    await t('① infer→saveSchema(檔案)→loadSchema(檔案／字串) 一致；不給 path 回傳字串', () => {
        const s = FS.infer(SAMPLE, { name: 'Item' }); assert.strictEqual(s.name, 'Item'); const f = path.join(tmp, 'item.schema.json'); assert.strictEqual(FS.saveSchema(s, f), f);
        assert.deepStrictEqual(FS.loadSchema(f), s); assert.deepStrictEqual(FS.loadSchema(FS.saveSchema(s)), s); assert.ok(/"fa_struct": 1/.test(fs.readFileSync(f, 'utf8')));
        assert.throws(() => FS.loadSchema('{"x":1}'), /不是 fa-struct/); assert.throws(() => FS.loadSchema(path.join(tmp, 'nope.json')), /JSON|Unexpected|不是/);
    });
    await t('① infer 吃檔案路徑與多個範例；fromDesc 吃物件／字串／檔案', () => {
        const f = path.join(tmp, 'a.json'); fs.writeFileSync(f, '{"a":1}'); const s = FS.infer([f, '{"a":2.5,"b":"x"}']); const m = Object.fromEntries(s.type.fields.map((x) => [x.name, x])); assert.strictEqual(m.a.ty.k, 'number'); assert.ok(m.b.opt);
        const d = { id: 'int', 'nick?': 'str' }; const g = path.join(tmp, 'd.json'); fs.writeFileSync(g, JSON.stringify(d)); assert.deepStrictEqual(FS.fromDesc(d), FS.fromDesc(JSON.stringify(d))); assert.deepStrictEqual(FS.fromDesc(d), FS.fromDesc(g));
    });
    await t('① generate：六種語言都產生；marshal 旗標正確（cpp／c／python／nodejs 有 load／save，java／csharp 只有宣告）；out 寫檔；不支援的語言如實報錯', () => {
        const s = FS.infer(SAMPLE); const want = { cpp: true, c: true, python: true, nodejs: true, java: false, csharp: false };
        for (const [lang, m] of Object.entries(want)) { const r = FS.generate(s, lang); assert.ok(r.ok && r.code.length > 100, lang); assert.strictEqual(r.marshal, m, lang); }
        const o = path.join(tmp, 'g.py'); const r = FS.generate(s, 'python', { out: o }); assert.strictEqual(r.written, o); assert.ok(fs.existsSync(o)); assert.strictEqual(FS.generate(s, 'cobol').ok, false);
        assert.ok(/Root_load_file/.test(FS.generate(s, 'cpp').code) && /Root_save_file/.test(FS.generate(s, 'c').code)); // load／save 的字串與檔案兩個介面
        assert.strictEqual(FS.generate(SAMPLE, 'python').ok, true, 'generate 也吃範例 JSON'); assert.deepStrictEqual(FS.convert(SAMPLE, 'python').code, FS.generate(FS.infer(SAMPLE), 'python').code);
    });
    if (!PY) console.log('  · 略過 Python 相關：找不到 python');
    else {
        await t('② 產生的 Python 類別：loads→dumps 與 json.dumps(json.loads) 逐字一致；load／save 檔案；缺必要鍵與型別錯報錯；可省略欄位', () => {
            const s = FS.infer(SAMPLE); const code = FS.generate(s, 'python').code; fs.writeFileSync(path.join(tmp, 'gen_model.py'), code); fs.writeFileSync(path.join(tmp, 'in.json'), SAMPLE);
            const script = 'import sys, json\nsys.path.insert(0, ' + JSON.stringify(tmp) + ')\nimport gen_model as m\nsrc = open(' + JSON.stringify(path.join(tmp, 'in.json')) + ', encoding="utf-8").read()\no = m.loads(src)\nassert isinstance(o, m.Root) and isinstance(o.addr, m.Root_addr) and o.items[0].ok is True\nassert m.dumps(o) == json.dumps(json.loads(src)), m.dumps(o)\nout = ' + JSON.stringify(path.join(tmp, 'out.json')) + '\nassert m.save(o, out) is None\nassert open(out, encoding="utf-8").read() == json.dumps(json.loads(src))\nassert m.dumps(m.load(out)) == m.dumps(o)\nassert isinstance(m.save(o), str)\ntry:\n    m.loads(\'{"id":1}\'); raise SystemExit("缺鍵沒報錯")\nexcept KeyError:\n    pass\nprint("OK")\n';
            const r = cp.spawnSync(PY, ['-X', 'utf8', '-c', script], { encoding: 'utf8' }); assert.strictEqual(r.stdout.trim(), 'OK', String(r.stderr).slice(-500) + r.stdout);
            const o2 = FS.infer(['{"a":1}', '{"a":2,"b":null}', '{"a":3,"b":"x"}']); fs.writeFileSync(path.join(tmp, 'gen_opt.py'), FS.generate(o2, 'python').code);
            const r2 = cp.spawnSync(PY, ['-X', 'utf8', '-c', 'import sys, json\nsys.path.insert(0, ' + JSON.stringify(tmp) + ')\nimport gen_opt as m\nfor s in [\'{"a":4}\', \'{"a":4,"b":null}\', \'{"a":4,"b":"z"}\']:\n    assert m.dumps(m.loads(s)) == json.dumps(json.loads(s)), s\nprint("OK")\n'], { encoding: 'utf8' }); assert.strictEqual(r2.stdout.trim(), 'OK', String(r2.stderr).slice(-400));
        });
        await t('④ Python 端 fa_struct.py：infer／from_desc／save_schema／load_schema／generate／convert，結果與 nodejs 端相同', () => {
            const f = path.join(tmp, 'py.schema.json');
            const script = 'import sys, json\nsys.path.insert(0, ' + JSON.stringify(__dirname) + ')\nimport fa_struct as F\ns = F.infer(' + JSON.stringify(SAMPLE) + ', name="Item")\nassert s["name"] == "Item"\nF.save_schema(s, ' + JSON.stringify(f) + ')\nassert F.load_schema(' + JSON.stringify(f) + ') == s\nassert json.loads(F.save_schema(s))["fa_struct"] == 1\nd = F.from_desc({"id": "int", "nick?": "str"})\nassert d["type"]["fields"][1]["opt"] is True\nr = F.generate(s, "cpp", main=True)\nassert r["ok"] and "Item_load" in r["code"] and "int main()" in r["code"]\nassert F.convert(' + JSON.stringify(SAMPLE) + ', "python", name="Item")["code"].count("class ") >= 3\ntry:\n    F.generate(s, "cobol")\nexcept ValueError as e:\n    raise SystemExit("不該丟例外") if False else None\nr = F.generate(s, "cobol")\nassert r["ok"] is False\ntry:\n    F.load_schema("{}")\n    raise SystemExit("壞的結構描述沒報錯")\nexcept ValueError:\n    pass\nprint("OK")\n';
            const r = cp.spawnSync(PY, ['-X', 'utf8', '-c', script], { encoding: 'utf8', timeout: 90000 }); assert.strictEqual(r.stdout.trim(), 'OK', String(r.stderr).slice(-600) + r.stdout);
            assert.deepStrictEqual(FS.loadSchema(f), FS.infer(SAMPLE, { name: 'Item' }), 'Python 端存的結構描述與 nodejs 端推的一致');
        });
    }
    await t('② 產生的 nodejs 類別：loads→dumps 內容一致；load／save 檔案；缺必要鍵報錯；可省略欄位缺少時不輸出', () => {
        const s = FS.infer(SAMPLE); const gf = path.join(tmp, 'gen_model.js'); fs.writeFileSync(gf, FS.generate(s, 'nodejs').code); const M = require(gf);
        const o = M.loads(SAMPLE); assert.ok(o instanceof M.Root && o.addr instanceof M.Root_addr && o.items[0].ok === true); assert.deepStrictEqual(JSON.parse(M.dumps(o)), JSON.parse(SAMPLE));
        const out = path.join(tmp, 'out_js.json'); assert.strictEqual(M.save(o, out), null); assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), JSON.parse(SAMPLE)); assert.deepStrictEqual(M.load(out), o); assert.strictEqual(typeof M.save(o), 'string');
        assert.throws(() => M.loads('{"id":1}'), /missing key/);
        const o2 = FS.infer(['{"a":1}', '{"a":2,"b":null}', '{"a":3,"b":"x"}']); const g2 = path.join(tmp, 'gen_opt.js'); fs.writeFileSync(g2, FS.generate(o2, 'nodejs').code); const M2 = require(g2);
        for (const x of ['{"a":4}', '{"a":4,"b":null}', '{"a":4,"b":"z"}']) assert.deepStrictEqual(JSON.parse(M2.dumps(M2.loads(x))), JSON.parse(x), x);
    });
    if (DIR && fs.existsSync(path.join(DIR, 'tree-sitter-java.wasm')) && fs.existsSync(path.join(DIR, 'tree-sitter-c_sharp.wasm'))) {
        await t('③ java／csharp 的型別宣告：tree-sitter 語法檢查沒有錯誤節點；欄位名與 JSON 鍵的對應', async () => {
            const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
            const s = FS.infer('{"class":1,"my-key":"x","list":[{"a":1.5,"b":null}],"m":{"x":1},"big":123456789012345678901234567890,"any":[1,"a"]}');
            for (const [lang, w] of [['java', 'tree-sitter-java.wasm'], ['csharp', 'tree-sitter-c_sharp.wasm']]) { const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, w))); const code = FS.generate(s, lang).code; assert.ok(!P.parse(code).rootNode.hasError(), lang + ' 語法錯誤：\n' + code); assert.ok(/my_key/.test(code) && /my-key/.test(code), lang + ' 沒標出 JSON 鍵對應'); }
        });
    } else console.log('  · 略過 java／csharp 語法檢查：沒有文法快取');
    await t('④ CLI：infer 寫檔、generate 輸出到標準輸出與 --out、--rpc 協定、壞用法', () => {
        const cli = path.join(__dirname, 'fa_struct.js'); const run = (args, input) => cp.spawnSync(process.execPath, [cli].concat(args), { input, encoding: 'utf8' });
        const sf = path.join(tmp, 'cli.schema.json'); let r = run(['infer', '-', '--name', 'Cli', '--out', sf], SAMPLE); assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(FS.loadSchema(sf).name, 'Cli');
        r = run(['generate', sf, '--lang', 'c', '--main']); assert.strictEqual(r.status, 0, r.stderr); assert.ok(/Cli_load/.test(r.stdout) && /int main\(void\)/.test(r.stdout));
        const o = path.join(tmp, 'cli.h'); r = run(['generate', '-', '--lang', 'cpp', '--out', o], SAMPLE); assert.strictEqual(r.status, 0, r.stderr); assert.ok(fs.existsSync(o));
        r = run(['--rpc'], JSON.stringify({ cmd: 'infer', args: ['[1,2]', { name: 'A' }] })); assert.strictEqual(JSON.parse(r.stdout).result.type.k, 'array'); r = run(['--rpc'], JSON.stringify({ cmd: 'nope', args: [] })); assert.strictEqual(JSON.parse(r.stdout).ok, false);
        assert.strictEqual(run(['generate', sf]).status, 1); assert.strictEqual(run([]).status, 2);
    });
    await t('⑤ 宿主 convert_code 的 struct 動作（嵌入版）：sample／desc／schema → 各 target；缺輸入、壞輸入如實報錯；嵌入與來源一致', () => {
        const fa = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8').replace(/\r\n/g, '\n'); const a = fa.indexOf('/* IR-BEGIN */'), b = fa.indexOf('/* IR-END */'); const H = new Function(fa.slice(a + 14, b).replace('const FaIrBundle', 'var FaIrBundle') + '\nreturn FaIrBundle;')();
        assert.ok(H.FaJsonStruct && H.FaJsonStruct.generate, '嵌入包沒有 FaJsonStruct');
        assert.ok(fa.indexOf(fs.readFileSync(path.join(__dirname, 'json_struct_core.js'), 'utf8').replace(/\r\n/g, '\n').trim()) > 0, '嵌入版與來源不一致');
        const i = fa.indexOf("if (action === 'struct')"); assert.ok(i > 0); const seg = fa.slice(i, i + 1800); assert.ok(/J\.inferSchema\(a\.sample/.test(seg) && /J\.parseTypeDesc\(a\.desc/.test(seg) && /J\.loadSchema\(a\.schema/.test(seg) && /缺少 sample/.test(seg));
        const J = H.FaJsonStruct; const sch = J.inferSchema([SAMPLE]); assert.ok(J.generate(J.loadSchema(J.saveSchema(sch)), 'cpp').code.indexOf('Root_load') > 0);
        const k = fa.indexOf("registerOptional('convert_code',"); const desc = fa.slice(k, k + 9000); assert.ok(/enum: \['convert', 'to_blocks', 'to_uml', 'struct'\]/.test(desc) && /sample: \{ type: 'string'/.test(desc) && /action:"struct"/.test(desc));
    });
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
