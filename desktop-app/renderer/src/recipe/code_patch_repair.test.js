'use strict';
// merge diff patcher 第二批：4.2 衝突階梯、亂序片段、語法樹函式邊界（Python）、接進 editCode。真的 python 當語法檢查與判題；語法樹用 renderer/vendor/tree-sitter（沒有就略過那部分）。
const assert = require('assert'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const P = require('./code_patch_core.js');
const Edit = require('./code_edit_core.js');
const hasPy = (() => { const r = cp.spawnSync('python', ['-c', '1']); return r.status === 0; })();
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };
const L = (s) => s.split('\n');

const tmpf = path.join(os.tmpdir(), 'fa-patch2-test-' + process.pid + '.py'); const wr = (src) => fs.writeFileSync(tmpf, src, 'utf8'); const PYENV = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
const check = async (src) => { if (!hasPy) return { ok: true }; wr(src); const r = cp.spawnSync('python', ['-I', '-c', 'import sys;compile(open(sys.argv[1],encoding="utf8").read(),"x","exec")', tmpf], { encoding: 'utf8', env: PYENV }); return r.status === 0 ? { ok: true } : { ok: false, verdict: 'CE', detail: (r.stderr || '').split('\n').filter(Boolean).pop() }; };
const runPy = (src, input) => { wr(src); const r = cp.spawnSync('python', ['-I', tmpf], { input: input || '', encoding: 'utf8', timeout: 10000, env: PYENV }); return { code: r.status, out: String(r.stdout || '').replace(/\r/g, '') }; };
const judgeExact = (expected) => async (src) => { const r = runPy(src); const good = r.code === 0 && r.out === expected; return { verdict: good ? 'AC' : 'WA', passed: good ? 1 : 0, total: 1, detail: good ? '' : '輸出：' + JSON.stringify(r.out) }; };
const judgeLastLine = (last) => async (src) => { const r = runPy(src); const ls = r.out.trim().split('\n'); const good = r.code === 0 && ls[ls.length - 1] === last; return { verdict: good ? 'AC' : 'WA', passed: good ? 1 : 0, total: 1 }; };

(async () => {
    // ================= 4.2 衝突階梯：候選產生（純函式） =================
    {
        const cases = {
            adjacent: [L('a\nb\nc\nd'), L('a\nb\nX\nc\nd'), L('a\nB\nc\nd')],
            token: [L('f(a, b, c)'), L('f(A, b, c)'), L('f(a, b, C)')],
            sameline: [L('f(a, b, c)'), L('f(A, b, c)'), L('f(Z, b, c)')],
            bothins: [L('a\nb'), L('a\nX\nb'), L('a\nY\nb')],
            delmod: [L('a\nb\nc'), L('a\nc'), L('a\nB\nc')],
        };
        const cand = (k, canJudge) => P.conflictCandidates(cases[k][0], cases[k][1], cases[k][2], { cr: '', canJudge });
        for (const k of Object.keys(cases)) ok(!P.merge3(cases[k][0], cases[k][1], cases[k][2], { style: 'diff3', key: P.norm }).clean, k + '：一般三方合併（同 git）確實是衝突');
        let c = cand('adjacent', false); eq(c.length, 1, '相鄰但不重疊：有一個候選'); eq(c[0].id, 'shrink', '縮小衝突'); eq(c[0].lines.join('|'), 'a|B|X|c|d', '兩邊的改動都在，順序是改的行在前、插入的在後');
        c = cand('token', false); eq(c.length, 1, '同一行改不同的詞：一個候選'); eq(c[0].id, 'token', '詞元層級'); eq(c[0].lines.join('|'), 'f(A, b, C)', '兩個詞都換了');
        eq(cand('sameline', true).length, 0, '同一行同一個詞兩邊都改：不自動解（不取一邊、不兩個都留）');
        eq(cand('delmod', true).length, 0, '一邊刪掉、一邊改：不自動解');
        eq(cand('bothins', false).length, 0, '兩邊插在同一處、沒有判題器：不給候選（順序只有測試能分辨）');
        c = cand('bothins', true); eq(c.map((x) => x.id).join(','), 'ours+theirs,theirs+ours', '有判題器：兩種順序都是候選'); ok(c.every((x) => x.needsTests), '標明需要判題器'); eq(c[0].lines.join('|'), 'a|X|Y|b', '先你的後修補的'); eq(c[1].lines.join('|'), 'a|Y|X|b', '先修補的後你的');
        ok(P.merge3(L('a\nb'), L('a\nX\nb'), L('a\nX\nb'), { style: 'diff3', key: P.norm }).clean, '兩邊改成一樣：不是衝突，本來就合併得掉（不會進階梯）');
        // 縮小後的衝突仍然只有一部分：只有真的重疊的那段留著，其他照樣合併
        const mix = P.conflictCandidates(L('p\nq\nr\ns\nt'), L('p\nQ1\nr\ns\nT1'), L('p\nQ2\nr\ns\nt'), { cr: '', canJudge: true }); eq(mix.length, 0, '部分衝突、部分可合併，但衝突那段解不開：整個不給候選');
    }

    // ================= 4.2 衝突階梯：整條流程（真 python 當裁判） =================
    if (hasPy) {
        const SRC = `def area(w, h):
    base = w * h
    border = 2 * (w + h)
    print("area", base)
    return base + border

print(area(2, 3))
`;
        const PATCHED = SRC.replace('border = 2 * (w + h)', 'border = 3 * (w + h)').replace('    print("area", base)\n', '    print("area", base)\n    print("done")\n');
        const diff = P.makeDiff(SRC, PATCHED, { context: 1, oldName: 'a/x.py', newName: 'b/x.py' });
        // 使用者在同一行的別處改（+ 0），而且在同一個位置也插了一行
        const USER = SRC.replace('border = 2 * (w + h)', 'border = 2 * (w + h) + 0').replace('    print("area", base)\n', '    print("area", base)\n    print("user")\n');
        const exact = 'area 6\nuser\ndone\n21\n';

        // 詞元層級＋插入順序：判題器分得出順序 → 恰好一種通過
        let r = await P.applyPatch({ source: USER, diff, lang: 'python', check, judge: judgeExact(exact) });
        ok(r.ok, '衝突階梯解開了：' + r.reason); eq(r.status, 'merged', '狀態 merged'); ok(r.resolved, '標明有衝突被解決'); eq(r.hunks[0].status, 'resolved', 'hunk 狀態是 resolved');
        ok(r.source.includes('border = 3 * (w + h) + 0'), '同一行的兩個改動都在（詞元層級）'); ok(r.source.indexOf('print("user")') < r.source.indexOf('print("done")'), '插入順序由判題器決定：先你的後修補的');
        eq(r.verified.tests, 'AC', '判題通過'); ok(r.attempts.length === 2 && r.attempts.filter((x) => x.passed).length === 1, '兩個候選各驗證一次，只有一個過：' + JSON.stringify(r.attempts.map((x) => [x.id, x.passed])));
        const bad = r.attempts.find((x) => !x.passed); ok(bad && bad.why && /判題/.test(bad.why), '沒過的候選附原因：' + (bad && bad.why));
        // 判題器要的是另一種順序
        r = await P.applyPatch({ source: USER, diff, lang: 'python', check, judge: judgeExact('area 6\ndone\nuser\n21\n') });
        ok(r.ok && r.source.indexOf('print("done")') < r.source.indexOf('print("user")'), '判題器要另一種順序：就選另一個候選');
        // 兩種順序都通過（測試只看最後一行）：不假裝有唯一解，程式選成本最低的並寫明
        r = await P.applyPatch({ source: USER, diff, lang: 'python', check, judge: judgeLastLine('21') });
        ok(r.ok, '兩種都通過時仍可合併'); eq(r.chosenBy, 'program', '標明是程式選的'); ok(r.gaps.some((g) => /兩種|2 種|解法都通過/.test(g)), '寫進注意事項：' + r.gaps.join('；'));
        // 有模型可問時：問模型
        let asked = 0; r = await P.applyPatch({ source: USER, diff, lang: 'python', check, judge: judgeLastLine('21'), ask: async (m, v) => { asked++; ok(v({ pick: 'B' }).length === 0 && v({ pick: 'Z' }).length > 0, '選擇題驗證器'); return { pick: 'B' }; } });
        eq(asked, 1, '平手時問一次'); eq(r.chosenBy, 'model', '標明是模型選的'); ok(r.source.indexOf('print("done")') < r.source.indexOf('print("user")'), '照模型選的 B（先修補的）');
        // 沒有判題器：插入順序只有測試分得出來 → 不猜，保留衝突、整份回滾
        r = await P.applyPatch({ source: USER, diff, lang: 'python', check });
        ok(!r.ok && r.rolledBack && r.status === 'conflict', '沒有判題器：順序沒辦法驗證，不猜，回滾：' + r.status); eq(r.source, USER, '原程式沒動'); ok(r.conflictText && r.conflictText.includes('<<<<<<<'), '附標準衝突標記');
        // 關閉階梯 → 回到只回報衝突
        r = await P.applyPatch({ source: USER, diff, lang: 'python', check, judge: judgeExact(exact), opts: { resolve: false } }); ok(!r.ok && r.status === 'conflict', 'resolve:false 時只回報衝突');
        // 所有候選都沒過驗證 → 回滾、列出每個候選為什麼沒過
        r = await P.applyPatch({ source: USER, diff, lang: 'python', check, judge: judgeExact('完全不對\n') });
        ok(!r.ok && r.rolledBack, '候選都沒過：回滾'); eq(r.source, USER, '原程式沒動'); ok(r.attempts.length === 2 && r.attempts.every((x) => !x.passed), '每個候選的結果都列出來');

        // 同一行同一處兩邊都改：不自動解，不丟任何一邊
        const USER2 = SRC.replace('border = 2 * (w + h)', 'border = 5 * (w + h)');
        r = await P.applyPatch({ source: USER2, diff: P.makeDiff(SRC, SRC.replace('border = 2 * (w + h)', 'border = 3 * (w + h)'), { context: 1 }), lang: 'python', check, judge: judgeExact('area 6\n45\n') });
        ok(!r.ok && r.status === 'conflict' && r.rolledBack, '同一處兩邊都改：衝突、回滾'); eq(r.source, USER2, '使用者的改動沒被蓋掉'); ok(r.conflictText.includes('5 * (w + h)') && r.conflictText.includes('3 * (w + h)'), '兩邊的版本都在標記裡'); eq((r.attempts || []).length, 0, '沒有可試的候選');
        // 縮小衝突：相鄰但不重疊
        const S2 = `def f(x):
    a = x + 1
    b = a * 2
    c = b - 3
    return c

print(f(4))
`;
        const patch2 = P.makeDiff(S2, S2.replace('b = a * 2', 'b = a * 20').replace('    return c', '    return c + 0'), { context: 0 });
        const USER3 = S2.replace('    a = x + 1\n', '    a = x + 1\n    a2 = a\n').replace('c = b - 3', 'c = b - 4');
        // USER3 把 c 那行也改了，patch 沒改 c；patch 改 b 與 return（和使用者的改動相鄰但不重疊）
        r = await P.applyPatch({ source: USER3, diff: patch2, lang: 'python', check, judge: judgeExact('96\n') });
        ok(r.ok, '相鄰改動：' + r.reason); ok(r.source.includes('a2 = a') && r.source.includes('b = a * 20') && r.source.includes('c = b - 4') && r.source.includes('return c + 0'), '使用者與修補的改動都在');
    } else { console.log('  （沒有 python，略過衝突階梯的整條流程）'); }

    // ================= 亂序片段 =================
    if (hasPy) {
        const SRC = `import sys

def add(a, b):
    return a + b

def mul(a, b):
    return a * b

def sub(a, b):
    return a - b

def main():
    x, y = map(int, input().split())
    print(add(x, y))
    print(mul(x, y))
    print(sub(x, y))

main()
`;
        const NEW = SRC.replace('    return a + b\n', '    # 加法\n    total = a + b\n    return total\n').replace('    return a * b', '    return a * b + 0').replace('    print(sub(x, y))\n', '    print(sub(x, y))\n    print("end")\n');
        const d = P.makeDiff(SRC, NEW, { context: 0, oldName: 'a/x.py', newName: 'b/x.py' });
        const parts = d.split(/^(?=@@ )/m); const header = parts.shift(); ok(parts.length === 3, '三個 hunk（' + parts.length + '）');
        const inOrder = await P.applyPatch({ source: SRC, diff: d, lang: 'python', check });
        ok(inOrder.ok && inOrder.source === NEW, '依序：基準結果');
        for (const [name, order] of [['倒過來', [2, 1, 0]], ['中間先', [1, 0, 2]], ['最後先', [2, 0, 1]]]) {
            const shuffled = header + order.map((i) => parts[i]).join('');
            const r = await P.applyPatch({ source: SRC, diff: shuffled, lang: 'python', check });
            ok(r.ok, name + '：' + r.reason); eq(r.source, NEW, name + '：結果和依序一樣（位移正確傳遞）');
            ok(r.hunks.every((h) => h.status === 'applied' || h.status === 'relocated'), name + '：每個 hunk 都回報位置與狀態：' + r.hunks.map((h) => h.status).join(','));
        }
        // 使用者在最上面加了 6 行，再加上亂序：位移（行數改變＋使用者位移）都要對
        const USER = '# 使用者的檔頭\n# 第二行\n# 第三行\n# 第四行\n# 第五行\n# 第六行\n' + SRC;
        const shuffled = header + [2, 0, 1].map((i) => parts[i]).join('');
        let r = await P.applyPatch({ source: USER, diff: shuffled, lang: 'python', check });
        ok(r.ok, '使用者位移＋亂序：' + r.reason); eq(r.source, '# 使用者的檔頭\n# 第二行\n# 第三行\n# 第四行\n# 第五行\n# 第六行\n' + NEW, '使用者位移＋亂序的結果正確');
        ok(r.hunks.filter((h) => h.status === 'relocated').length === 2 && r.hunks[0].status === 'applied' && r.hunks[0].offset === 6, '有脈絡的兩段是「行號位移後找到」，沒有脈絡的純插入靠它們校準到位移 6：' + r.hunks.map((h) => h.status + '@' + h.line).join(','));
        // 亂序、而且兩個 hunk 的內容會搶同一個位置（重複片段）：不能蓋到彼此
        const DUP = 'x = 1\nprint(x)\nx = 1\nprint(x)\n';
        const dupNew = 'x = 2\nprint(x)\nx = 3\nprint(x)\n';
        const dd = P.makeDiff(DUP, dupNew, { context: 0 }); const dp = dd.split(/^(?=@@ )/m); const dh = dp.shift(); ok(dp.length === 2, '重複片段兩個 hunk');
        r = await P.applyPatch({ source: DUP, diff: dh + dp[1] + dp[0], lang: 'python', check });
        ok(r.ok, '重複片段亂序：' + r.reason); eq(r.source, dupNew, '亂序但行號可信，兩個 hunk 各改各的（不會互相蓋掉）');
        // 同一個 hunk 重複出現（被當成亂序）：第二次視為已套用，不重複改
        r = await P.applyPatch({ source: SRC, diff: header + parts[0] + parts[1] + parts[2] + parts[0], lang: 'python', check });
        ok(r.ok && r.source === NEW, '同一個 hunk 重複出現不會改兩次：' + (r.reason || '') + r.hunks.map((h) => h.status).join(','));
    }

    // ================= 語法樹的函式邊界（Python） =================
    const TSDIR = path.join(__dirname, '..', '..', 'vendor', 'tree-sitter');
    let parser = null;
    if (fs.existsSync(path.join(TSDIR, 'tree-sitter-python.wasm'))) {
        const Parser = require(path.join(TSDIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(TSDIR, 'tree-sitter.wasm') });
        const lang = await Parser.Language.load(path.join(TSDIR, 'tree-sitter-python.wasm')); parser = new Parser(); parser.setLanguage(lang);
    }
    if (parser) {
        const SRC = `import functools

def outer_a():
    def helper(x):
        return x + 1
    return helper(1)

def outer_b():
    def helper(x):
        return x * 2
    return helper(2)

class K:
    @staticmethod
    def make(a,
             b=2):
        async def inner():
            pass
        return a + b

    def other(self):
        return 0

@functools.lru_cache
async def fetch(u):
    return u
`;
        const us = P.treeUnits(parser, SRC);
        eq(us.map((u) => u.qual).join(','), 'outer_a,outer_a.helper,outer_b,outer_b.helper,K.make,K.make.inner,K.other,fetch', '巢狀函式、類別方法、非同步、裝飾器都認得，qual 是完整路徑');
        const mk = us.find((u) => u.qual === 'K.make'); eq(mk.startLine, 14, '裝飾器算在單元裡'); eq(mk.endLine, 19, '跨行簽名的函式結尾');
        const ft = us.find((u) => u.name === 'fetch'); eq(ft.startLine, 24, '模組層裝飾器'); eq(ft.endLine, 26, '最後一個函式結尾');
        const hp = us.filter((u) => u.name === 'helper'); eq(hp.length, 2, '兩個同名巢狀函式'); ok(hp[0].endLine < hp[1].startLine, '兩個範圍不重疊');
        // 字串裡長得像函式的文字：詞法切分會誤判，語法樹不會
        const DOC = 'def doc():\n    """範例：\n    def helper(x):\n        y = x * 2\n        return y + 1\n    """\n    return 0\n\ndef helper(x):\n    y = x * 2\n    return y + 1\n';
        eq(P.treeUnits(parser, DOC).filter((u) => u.name === 'helper').length, 1, '語法樹：docstring 裡的 def 不是函式');
        eq(Edit.splitUnits('python', DOC).filter((u) => u.name === 'helper').length, 2, '（對照）詞法切分把 docstring 裡的 def 當成函式');
        // 有語法錯誤的程式碼也要能切（盡量切）
        { const bad = 'def a():\n    return (1\n\ndef b():\n    return 2\n'; ok(P.treeUnits(parser, bad).hasError === true && P.treeUnits(parser, SRC).hasError === false, '標明語法樹有沒有錯誤（沒收的括號會吞掉後面的函式，這時 applyPatch 改用詞法切分）'); ok(Edit.splitUnits('python', bad).some((u) => u.name === 'b'), '（詞法切分仍找得到 b）'); }
        ok(P.treeUnits(parser, '').length === 0, '空檔案');

        if (hasPy) {
            // 端到端：docstring 裡有一模一樣的範例碼。詞法切分會找到兩個 helper 而且位置被使用者位移弄糊塗；語法樹只有一個
            const BASE = 'def doc():\n    """範例：\n    def helper(x):\n        y = x * 2\n        return y + 1\n    """\n    return 0\n\ndef helper(x):\n    y = x * 2\n    return y + 1\n\nprint(helper(3))\n';
            const patchTo = BASE.replace('    return y + 1\n\nprint', '    return y + 100\n\nprint').replace('    y = x * 2\n    return y + 100', '    y = x * 3\n    return y + 100');
            const ptxt = P.makeDiff(BASE.split('\n').slice(8).join('\n'), patchTo.split('\n').slice(8).join('\n'), { context: 3, oldName: 'a/x.py', newName: 'b/x.py' }).replace(/@@ -1/, '@@ -9').replace(/\+1,/, '+9,');
            // 使用者在 helper 裡加了註解（讓精確比對失敗）並在上面加了很多行（讓行號失準）
            const USER = '# a\n# b\n# c\n# d\n# e\n# f\n# g\n# h\n# i\n# j\n' + BASE.replace('    y = x * 2\n    return y + 1\n\nprint', '    y = x * 2  # 使用者註解\n    return y + 1  # 使用者註解\n\nprint');
            const r = await P.applyPatch({ source: USER, diff: ptxt, lang: 'python', check, parser });
            ok(r.ok, '有語法樹：' + r.reason + '／' + (r.hunks[0] && r.hunks[0].reason)); ok(r.source.includes('y = x * 3  # 使用者註解') || r.source.includes('y = x * 3'), '改到真的 helper');
            console.log(r.source, r.hunks); eq(r.source.split('x * 3').length - 1, 1, '只改了一處（docstring 裡的範例沒被動到）'); ok(r.source.includes('        y = x * 2\n        return y + 1\n    """'), 'docstring 的範例原封不動');
            eq(runPy(r.source).out, '109\n', '改完能跑、答案是 109');
            // 對照：沒給語法樹（詞法切分）時，這個情況是否仍然安全——結果可以成功，但不能改錯地方
            const r2 = await P.applyPatch({ source: USER, diff: ptxt, lang: 'python', check });
            ok(!r2.ok || (r2.source.split('x * 3').length - 1 === 1 && r2.source.includes('        y = x * 2\n        return y + 1\n    """')), '沒有語法樹時：成功也只改對地方，不然就回滾（' + r2.status + '）');
        }
    } else { console.log('  （沒有 tree-sitter 的 Python 文法檔，略過語法樹部分）'); }

    // ================= 接進 editCode：修補當候選編輯 =================
    if (hasPy) {
        const SRC = 'def add(a, b):\n    return a - b\n\nprint(add(2, 3))\n';
        const FIXED = 'def add(a, b):\n    return a + b\n\nprint(add(2, 3))\n';
        const diff = P.makeDiff(SRC, FIXED, { oldName: 'a/x.py', newName: 'b/x.py' });
        const problem = { statement: '加法', tests: [{ in: '', out: '5\n' }], hidden: [] };
        const jd = async ({ source }) => { const r = runPy(source); const good = r.code === 0 && r.out === '5\n'; return { verdict: good ? 'AC' : 'WA', passed: good ? 1 : 0, total: 1, detail: good ? '' : '輸出 ' + JSON.stringify(r.out) }; };
        const ck = async ({ source }) => check(source);
        const wrote = []; const write = async () => { wrote.push(1); return '```python\ndef add(a, b):\n    return 0\n```'; };
        let e = await Edit.editCode({ source: SRC, lang: 'python', problem, check: ck, judge: jd, write, patch: diff });
        ok(e.ok && e.verified && e.source === FIXED, 'editCode：修補通過 → 直接 AC：' + e.verdict + ' ' + e.gaps.join('；')); eq(wrote.length, 0, '修補夠了就不叫模型重寫'); ok(e.edits.length === 1 && e.edits[0].by === 'patch', 'edits 用同一種格式，來源標 patch：' + JSON.stringify(e.edits.map((x) => x.by)));
        ok(typeof e.edits[0].startLine === 'number' && typeof e.edits[0].desc === 'string' && 'removed' in e.edits[0], 'patch 的 edit 欄位和單元重寫一致（startLine／desc／removed）'); ok(/^---/m.test(e.diff) || e.diff.includes('+    return a + b'), '共用同一個 diff 欄位'); ok(e.patch && e.patch.ok, '附修補的合併報告');
        // 修補是錯的（答案不對）：被驗證擋下，原程式不動，改走原本的流程（這裡模型也只會寫出錯的，所以最後 WA，但修補沒有留下任何痕跡）
        const wrong = P.makeDiff(SRC, SRC.replace('a - b', 'a * b'), { oldName: 'a/x.py', newName: 'b/x.py' });
        e = await Edit.editCode({ source: SRC, lang: 'python', problem, check: ck, judge: jd, write, patch: wrong, opts: { maxRethink: 0 } });
        ok(e.source === SRC && !e.edits.some((x) => x.by === 'patch'), '錯的修補不會留下：' + JSON.stringify(e.edits.map((x) => x.by))); ok(e.gaps.some((g) => /修補/.test(g)), '原因寫進 gaps：' + e.gaps.join('；')); ok(e.patch && !e.patch.ok && e.patch.rolledBack, '附回滾的報告');
        // 修補套不上（脈絡完全不同）：誠實說，繼續原本的流程
        e = await Edit.editCode({ source: SRC, lang: 'python', problem, check: ck, judge: jd, write, patch: '--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n def nothing(q):\n-    return 1\n+    return 2\n', opts: { maxRethink: 0 } });
        ok(e.gaps.some((g) => /修補/.test(g)) && e.source === SRC, '套不上：寫進 gaps，原程式不動');
        // 沒有 patch 欄位：行為完全不變
        e = await Edit.editCode({ source: FIXED, lang: 'python', problem, check: ck, judge: jd }); ok(e.ok && e.verified && e.edits.length === 0 && !e.patch, '沒給修補：和以前一樣');
    }

    console.log('code_patch_repair.test.js（python ' + (hasPy ? '有' : '沒有') + '、語法樹 ' + (parser ? '有' : '沒有') + '）：' + n + ' passed, 0 failed');
})().catch((e) => { console.error(e); process.exit(1); });
