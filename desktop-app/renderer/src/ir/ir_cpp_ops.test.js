'use strict';
// C++ 補齊的標準操作（2026-11-10）：每個操作一段 Python → IR（確認真的認成該操作）→ C++ → 真 g++ 編譯執行，輸出與 Python 逐字一致。
// 另有「天真對照組」：把輸出裡的處理換成看起來對的寫法，必須有輸入答錯，證明樣本測得到語意差異。
// 工具鏈：g++＝J:\msys64\mingw64\bin（PATH 放最前面）；找不到就略過並印原因，不算失敗。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const IR = require('./ir_core.js'), PREP = require('./ir_prep_core.js'), INPY = require('./ir_in_python_core.js'), OPS = require('./ir_ops_core.js'), CPP = require('./ir_out_cpp_core.js');
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
const MING = process.env.FA_MINGW_BIN || 'J:\\msys64\\mingw64\\bin';
const ENVM = Object.assign({}, process.env, { PATH: MING + path.delimiter + (process.env.PATH || '') });
const GPP = path.join(MING, 'g++.exe');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; return true; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 30).join('\n   ')); return false; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'irc-'));
const run = (cmd, args, input, env) => { const r = cp.spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 30000, env: env || process.env }); return r.status === 0 ? r.stdout.replace(/\r\n/g, '\n') : 'ERR(' + r.status + '):' + String(r.stderr).slice(-300); };
let PY = null; for (const c of ['python', 'python3']) { const r = cp.spawnSync(c, ['-I', '-c', 'print(1)'], { encoding: 'utf8' }); if (r.status === 0 && r.stdout.trim() === '1') { PY = c; break; } }

// 每個樣本：ops＝IR 裡必須出現的標準操作；inputs＝測試輸入
const CASES = [
    { id: 'split-sep-join-lower', ops: ['str.split_sep', 'str.join', 'str.lower', 'str.endswith'], inputs: ['a,B,,c\n', ',x,\n', 'Hello,World\n'], py: `from typing import List


def main():
    s: str = input()
    parts: List[str] = s.split(",")
    out: List[str] = []
    for p in parts:
        out.append(p.lower())
    print("|".join(out))
    print(len(parts))
    print(s.endswith("c"))
    print(s.endswith(""))


main()
` },
    { id: 'replace-repeat-digit', ops: ['str.replace', 'str.repeat', 'str.is_digit'], inputs: ['a-b-c\n', '12345\n', '\n', 'aaa\n'], py: `def main():
    s: str = input()
    print(s.replace("a", "XY"))
    print(s.replace("", "-"))
    print(s * 3)
    print(s.isdigit())


main()
` },
    { id: 'ord-chr', ops: ['str.char_code', 'str.from_code'], inputs: ['A\n', 'z\n', '~\n'], py: `def main():
    s: str = input()
    c: int = ord(s)
    print(c)
    print(chr(c + 1))
    print(chr(233) + chr(8364) + chr(128512))
    print(ord("é") + ord("€") + ord("😀"))


main()
` },
    { id: 'index-slice-keys', ops: ['list.index_of', 'list.slice', 'dict.keys'], inputs: ['5\n3 9 2 7 1\n', '3\n4 4 8\n'], py: `from typing import List, Dict


def main():
    n: int = int(input())
    a: List[int] = list(map(int, input().split()))
    print(a.index(a[n - 1]))
    b: List[int] = a[1:3]
    print(len(b))
    c: List[int] = a[-3:100]
    print(c[0])
    print(len(a[2:1]))
    d: Dict[int, int] = {}
    for x in a:
        d[x] = x * 2
    ks: List[int] = list(d.keys())
    print(len(ks))
    print(sum(ks))


main()
` },
    { id: 'read-all', ops: ['io.read_all'], inputs: ['3\n1 2 3\n', 'x y\nz\n'], py: `import sys


def main():
    data: str = sys.stdin.read()
    print(len(data))
    print(data.strip())


main()
` },
    { id: 'randint-time', ops: ['rand.randint', 'time.now_seconds'], inputs: ['\n'], py: `import random
import time


def main():
    t0: float = time.time()
    ok: bool = True
    for i in range(200):
        v: int = random.randint(3, 7)
        if v < 3 or v > 7:
            ok = False
    print(ok)
    t1: float = time.time()
    print(t1 >= t0)
    print(t0 > 1000000000.0)


main()
` },
    { id: 'file-roundtrip', ops: ['file.write_all', 'file.read_all'], inputs: ['hello\n'], py: `def main():
    s: str = input()
    path: str = "fa_cpp_ops_tmp.txt"
    open(path, "w", encoding="utf-8").write(s + "!")
    print(open(path, encoding="utf-8").read())


main()
` },
    { id: 'json-dumps', ops: ['json.dumps'], inputs: ['\n'], py: `import json
from typing import List, Dict


def main():
    a: List[int] = [1, -2, 30]
    d: Dict[str, int] = {"a": 1, "b": 2}
    s: List[str] = ["x\\"y", "n\\nt"]
    print(json.dumps(a))
    print(json.dumps(d))
    print(json.dumps(s))
    print(json.dumps("q"))
    print(json.dumps(True))
    print(json.dumps(2.5))


main()
` }
];

(async () => {
    if (!DIR || !PY) { console.log('略過：找不到 tree-sitter 快取或 python\n0 passed, 0 failed'); return; }
    if (!fs.existsSync(GPP)) { console.log('略過：找不到 g++（' + GPP + '）\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') }); const P = new Parser(); P.setLanguage(await Parser.Language.load(path.join(DIR, 'tree-sitter-python.wasm')));
    const cov = OPS.ids().filter((id) => { const c = OPS.get(id).cells.cpp; return c != null && !(typeof c === 'object' && Object.keys(c).every((k) => c[k] == null)); }).length;
    t('覆蓋：C++ 有樣板的操作數至少 71／' + OPS.ids().length + '（只剩 json.loads）', () => { const miss = OPS.ids().filter((id) => OPS.get(id).cells.cpp == null); assert.deepStrictEqual(miss, ['json.loads'], '缺：' + miss.join(',') + '（共 ' + cov + '）'); });
    for (const c of CASES) {
        t('C++／' + c.id, () => {
            const ir = PREP.prepare(INPY.fromTree(P.parse(c.py).rootNode, { source: c.py }).ir).ir; const found = new Set(); IR.walkStmts(ir.body, (s) => { for (const f of ['to', 'val', 'e', 'cond']) if (s[f]) IR.walkExpr(s[f], (x) => { if (x.k === 'call' && x.op) found.add(x.op); }); });
            c.ops.forEach((o) => assert.ok(found.has(o), '來源沒被認成標準操作 ' + o + '（實際：' + [...found].join(',') + '）'));
            const em = CPP.emit(ir); assert.ok(!em.diags.some((d) => d.level === 'error'), 'error：' + em.diags.filter((d) => d.level === 'error').map((d) => d.msg).join(';'));
            const dir = path.join(tmp, c.id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'o.py'), c.py); const f = path.join(dir, 'o.cpp'), exe = path.join(dir, 'o.exe'); fs.writeFileSync(f, em.code);
            const cc = cp.spawnSync(GPP, ['-std=c++17', '-O0', '-o', exe, f], { encoding: 'utf8', env: ENVM, timeout: 90000 }); assert.strictEqual(cc.status, 0, 'g++ 編譯失敗：\n' + String(cc.stderr).slice(0, 1500));
            c.inputs.forEach((inp) => { const want = run(PY, ['-I', '-X', 'utf8', path.join(dir, 'o.py')], inp); const got = run(exe, [], inp, Object.assign({}, ENVM)); const w = want.replace(/\r\n/g, '\n');
                // 時間與亂數的輸出是 True/False，非 ASCII 的 ord/chr 兩邊都是 UTF-8 位元組
                assert.strictEqual(got, w, c.id + ' 輸入 ' + JSON.stringify(inp) + '\n期望 ' + JSON.stringify(w) + '\n實際 ' + JSON.stringify(got)); });
        });
    }
    // 天真對照組：str.replace 的空字串、list.slice 的負索引，天真寫法會答錯
    // 天真對照組：把輔助函式換成「看起來對」的寫法，必須有輸入答錯（replace 不處理空字串；index_of 找不到回 -1 而不是丟錯）
    const naive = (id, from, to, input) => {
        const c = CASES.find((x) => x.id === id); const ir = PREP.prepare(INPY.fromTree(P.parse(c.py).rootNode, { source: c.py }).ir).ir; const em = CPP.emit(ir); assert.ok(em.code.indexOf(from) >= 0, '找不到要替換的輔助函式片段');
        const dir = path.join(tmp, 'naive_' + id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'o.py'), c.py); const f = path.join(dir, 'o.cpp'), exe = path.join(dir, 'o.exe'); fs.writeFileSync(f, em.code.replace(from, to));
        const cc = cp.spawnSync(GPP, ['-std=c++17', '-O0', '-o', exe, f], { encoding: 'utf8', env: ENVM, timeout: 90000 }); assert.strictEqual(cc.status, 0, '天真版編譯失敗：' + String(cc.stderr).slice(0, 600));
        return { want: run(PY, ['-I', '-X', 'utf8', path.join(dir, 'o.py')], input), got: run(exe, [], input, ENVM) };
    };
    t('對照組：replace 不處理空字串的天真版會答錯', () => { const r = naive('replace-repeat-digit', 'if (a.empty()) { for (char c : s) { r += b; r += c; } r += b; return r; }', 'if (a.empty()) return s;', 'a-b-c\n'); assert.notStrictEqual(r.got, r.want); });
    t('對照組：切片不夾邊界的天真版（直接用迭代器位移）對越界輸入出錯或答錯', () => { const r = naive('index-slice-keys', 'if (i < 0) i = std::max(0LL, i + n); if (j < 0) j = std::max(0LL, j + n); i = std::min(i, n); j = std::min(j, n); return i >= j ? std::vector<T>() : std::vector<T>(a.begin() + i, a.begin() + j);', 'return std::vector<T>(a.begin() + i, a.begin() + j);', '5\n3 9 2 7 1\n'); assert.notStrictEqual(r.got, r.want); });
    console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
