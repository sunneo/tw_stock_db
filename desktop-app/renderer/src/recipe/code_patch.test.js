'use strict';
// merge diff patcher：unified diff 解析、策略鏈、三方合併（對照 git merge-file）、合併後驗證與回滾。真的 python 當語法檢查與判題。
const assert = require('assert'), cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const P = require('./code_patch_core.js');
const hasPy = (() => { const r = cp.spawnSync('python', ['-c', '1']); return r.status === 0; })();
const hasGit = (() => { const r = cp.spawnSync('git', ['--version']); return r.status === 0; })();
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n++; };

const tmpf = path.join(os.tmpdir(), 'fa-patch-test-' + process.pid + '.py'); const wr = (src) => fs.writeFileSync(tmpf, src, 'utf8'); const PYENV = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
const check = async (src) => { if (!hasPy) return { ok: true }; wr(src); const r = cp.spawnSync('python', ['-I', '-c', 'import sys;compile(open(sys.argv[1],encoding="utf8").read(),"x","exec")', tmpf], { encoding: 'utf8', env: PYENV }); return r.status === 0 ? { ok: true } : { ok: false, detail: (r.stderr || '').trim().split(String.fromCharCode(10)).slice(-2).join(' ') }; };
const mkJudge = (tests) => async (src) => { let pass = 0; wr(src); for (const t of tests) { const r = cp.spawnSync('python', ['-I', tmpf], { input: t.in, encoding: 'utf8', timeout: 10000, env: PYENV }); if (r.status === 0 && r.stdout.split(String.fromCharCode(13)).join('').trim() === t.out.trim()) pass++; } return { verdict: pass === tests.length ? 'AC' : 'WA', passed: pass, total: tests.length, detail: pass === tests.length ? '' : '輸出不符' }; };

const SRC = `import sys

def add(a, b):
    return a + b

def mul(a, b):
    return a * b

def main():
    x, y = map(int, input().split())
    print(add(x, y))
    print(mul(x, y))

main()
`;
const fixed = SRC.replace('return a * b', 'return a * b + 0');
const tests = [{ in: '2 3\n', out: '5\n6\n' }, { in: '4 5\n', out: '9\n20\n' }];
const J = mkJudge(tests);

(async () => {
    // ---------- 解析 ----------
    {
        const d = P.makeDiff(SRC, SRC.replace('a + b', 'b + a'), { oldName: 'a/x.py', newName: 'b/x.py' });
        const p = P.parseDiff(d); ok(p.ok && p.files.length === 1 && p.files[0].hunks.length === 1, '基本解析'); eq(p.files[0].newName, 'x.py', '去掉 b/');
        const pc = P.parseDiff(d.replace(/\n/g, '\r\n')); ok(pc.ok && pc.files[0].hunks[0].ops.every((o) => !o.s.includes('\r')), 'CRLF 的 diff');
        const bad = P.parseDiff(d.replace(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/, '@@ -$1,99 +$3,99 @@')); ok(bad.ok && bad.warnings.length && bad.files[0].hunks[0].oldCount < 99, '標頭行數錯：用實際內容重算並警告');
        const fenced = P.parseDiff('這是修補：\n```diff\n' + d + '```\n'); ok(fenced.ok && fenced.files[0].hunks.length === 1, '程式碼圍欄');
        const bare = P.parseDiff(d.split('\n').slice(2).join('\n')); ok(bare.ok && bare.files[0].hunks.length === 1, '沒有檔頭');
        ok(P.parseDiff('').empty && P.parseDiff('隨便一段文字\n沒有 hunk\n').empty, '空 diff／沒有 hunk');
        ok(!P.parseDiff('diff --git a/x b/x\nGIT binary patch\nliteral 3\n').ok, '二進位 diff 拒絕');
        ok(!P.parseDiff('x\0y').ok, '含 NUL 拒絕');
        const big = P.parseDiff('@@ -1 +1 @@\n' + '-a\n+b\n'.repeat(500000)); ok(!big.ok && big.tooLarge, '超大輸入拒絕');
    }
    // ---------- 策略鏈 ----------
    const mod = (s) => s.replace('return a * b', 'return a * b + 0');
    const patch = P.makeDiff(SRC, fixed, { oldName: 'a/m.py', newName: 'b/m.py' });
    const run = (source, diff, extra) => P.applyPatch(Object.assign({ source, diff: diff || patch, lang: 'python', check, judge: J }, extra));
    {
        const r = await run(SRC); ok(r.ok && r.source === fixed && r.hunks[0].status === 'applied' && r.verified.syntax === true && r.verified.tests === 'AC', '原位置精確：' + P.report(r));
        const again = await run(r.source); ok(again.ok && again.noop && again.status === 'already_applied' && again.source === r.source, '重複套用是 no-op');
    }
    { // 行號位移：使用者在上面加了 6 行
        const user = '# 使用者加的\n# a\n# b\n# c\n# d\n# e\n' + SRC; const r = await run(user); ok(r.ok && r.hunks[0].status === 'relocated' && r.hunks[0].offset === 6 && r.source === '# 使用者加的\n# a\n# b\n# c\n# d\n# e\n' + fixed, '行號位移：' + P.report(r));
    }
    { // 空白差異（使用者格式化過）
        const user = SRC.replace('return a * b', 'return  a  *  b'); const r = await run(user); ok(!r.ok || r.source.includes('+ 0'), '空白差異不崩');
        const user2 = SRC.replace('def mul(a, b):\n    return a * b', 'def mul(a, b):\n    return a  *  b'); const r2 = await run(user2);
        ok(r2.ok && r2.hunks[0].status === 'fuzzy' && r2.source.includes('return a * b + 0'), '忽略空白：' + P.report(r2));
    }
    { // 整段縮排位移（python 包進 class）：新增的行要跟著縮排
        const user = 'class K:\n' + SRC.split('\n').map((l) => (l ? '    ' + l : l)).join('\n');
        const r = await P.applyPatch({ source: user, diff: patch, lang: 'python', check }); ok(r.ok && r.source.includes('        return a * b + 0'), '縮排位移後新增行對齊：' + P.report(r));
    }
    { // python 相對縮排不同＝結構不同，不能硬套
        const user = SRC.replace('def mul(a, b):\n    return a * b', 'def mul(a, b):\n    if a:\n        return a * b');
        const r = await run(user); ok(!r.ok && r.rolledBack, '結構不同不硬套：' + r.status);
    }
    { // CRLF 原始碼：保留 CRLF
        const user = SRC.replace(/\n/g, '\r\n'); const r = await run(user); ok(r.ok && r.source === fixed.replace(/\n/g, '\r\n'), 'CRLF 原始碼保持 CRLF');
        const mixed = SRC.replace('import sys\n', 'import sys\r\n'); const r2 = await run(mixed); ok(r2.ok && r2.source.startsWith('import sys\r\n\ndef') && r2.source.includes('+ 0\n'), '混合行尾：沒動到的行原樣');
    }
    { // 使用者改過上下文（脈絡 fuzz）
        const user = SRC.replace('def main():', 'def main():  # 入口').replace('def add(a, b):\n    return a + b', 'def add(a, b):\n    return a + b  # 加法');
        const r = await run(user); ok(r.ok && r.source.includes('a * b + 0') && r.source.includes('# 加法') && r.source.includes('# 入口'), '使用者註解保留：' + P.report(r));
    }
    { // 使用者改了「同一個函式的另一行」＋修補改這個函式的某一行：函式邊界三方合併
        const src2 = 'def f(x):\n    a = x + 1\n    b = a * 2\n    c = b - 3\n    return c\n\nprint(f(int(input())))\n';
        const theirs = src2.replace('b = a * 2', 'b = a * 3'); const d2 = P.makeDiff(src2, theirs, { oldName: 'a/f.py', newName: 'b/f.py' });
        const user = src2.replace('a = x + 1', 'a = x + 100').replace('return c', 'return c  # 結果');
        const r = await P.applyPatch({ source: user, diff: d2, lang: 'python', check, judge: mkJudge([{ in: '1\n', out: String((1 + 100) * 3 - 3) + '\n' }]) });
        ok(r.ok && r.source.includes('a = x + 100') && r.source.includes('b = a * 3') && r.source.includes('# 結果'), '使用者改同函式另一行：保留並合入：' + P.report(r));
        ok(['merged', 'unit', 'fuzzy'].includes(r.hunks[0].status), '策略 ' + r.hunks[0].status);
    }
    { // 真衝突：使用者與修補改同一行 → 整份不動
        const src2 = 'def f(x):\n    a = x + 1\n    b = a * 2\n    c = b - 3\n    return c\n';
        const theirs = src2.replace('b = a * 2', 'b = a * 3'); const d2 = P.makeDiff(src2, theirs); const user = src2.replace('b = a * 2', 'b = a * 5 + 1');
        const r = await P.applyPatch({ source: user, diff: d2, lang: 'python', check }); ok(!r.ok && r.rolledBack && r.source === user && ['conflict', 'locate_failed'].includes(r.status), '真衝突回滾：' + r.status + ' ' + r.reason);
        ok(!r.ok && r.hunks.some((h) => h.status === 'conflict' && /a \* 5/.test(h.conflictText || '')) || r.status === 'locate_failed', '衝突回報內含雙方版本');
    }
    { // 合併後語法壞掉 → 回滾（修補本身引入語法錯誤）
        const broken = SRC.replace('return a * b', 'return a * (b'); const d = P.makeDiff(SRC, broken);
        const r = await run(SRC, d); ok(!r.ok && r.rolledBack && r.source === SRC && r.status === 'verify_failed' && /語法/.test(r.reason), '語法壞 → 回滾：' + r.reason);
    }
    { // 判題沒過 → 回滾
        const wrong = SRC.replace('return a * b', 'return a - b'); const r = await run(SRC, P.makeDiff(SRC, wrong)); ok(!r.ok && r.source === SRC && /判題沒過/.test(r.reason), '判題沒過 → 回滾：' + r.reason);
        const r2 = await run(SRC, P.makeDiff(SRC, wrong), { opts: { judgeMode: 'noworse' } }); ok(!r2.ok, 'noworse：從 AC 變差也不收');
    }
    { // 重複片段 + 行號錯：沒驗證器 → 拒絕；有判題器 → 只有一處可行才採用
        const dup = 'def a(x):\n    y = x + 1\n    return y\n\ndef b(x):\n    y = x + 1\n    return y\n\nprint(a(int(input())))\n';
        const target = dup.replace('def a(x):\n    y = x + 1', 'def a(x):\n    y = x + 2'); // 想改 a
        const dd = P.makeDiff(dup, target, { context: 0 }).replace(/@@ -\d+(,\d+)? /, '@@ -40$1 '); // 行號錯
        const r0 = await P.applyPatch({ source: dup, diff: dd, lang: 'python' }); ok(!r0.ok && r0.status === 'ambiguous' && r0.source === dup, '重複片段、無驗證器：拒絕並說有歧義：' + r0.status);
        // a 的輸出會受影響、b 不會（沒被呼叫）→ 判題只有改 a 的那處通過 AC（輸入 1 → 期望 3）
        const r1 = await P.applyPatch({ source: dup, diff: dd, lang: 'python', check, judge: mkJudge([{ in: '1\n', out: '3\n' }]) });
        ok(r1.ok && r1.source === target, '重複片段、判題只有一處可行：採用：' + P.report(r1));
        // 兩處都能過（b 沒被呼叫的版本也通過）→ 無法分辨，拒絕
        const r2 = await P.applyPatch({ source: dup, diff: dd, lang: 'python', check, judge: async () => ({ verdict: 'AC', passed: 1, total: 1 }) }); ok(!r2.ok && r2.source === dup, '判題分不出來：拒絕：' + r2.status);
    }
    { // 沒有結尾換行
        const s = 'a = 1\nb = 2'; const d = '--- a\n+++ b\n@@ -1,2 +1,2 @@\n a = 1\n-b = 2\n\\ No newline at end of file\n+b = 3\n\\ No newline at end of file\n';
        const r = await P.applyPatch({ source: s, diff: d, lang: 'python' }); ok(r.ok && r.source === 'a = 1\nb = 3', '沒有結尾換行：' + JSON.stringify(r.source));
    }
    { // 輸入防呆
        eq((await P.applyPatch({ source: 5, diff: patch })).status, 'bad_input', 'source 不是字串');
        eq((await P.applyPatch({ source: SRC, diff: '' , lang: 'python' })).status, 'empty', '空 diff');
        eq((await P.applyPatch({ source: SRC, diff: 'GIT binary patch\nliteral 1\n', lang: 'python' })).status, 'binary', '二進位修補');
        eq((await P.applyPatch({ source: 'a\0b', diff: patch, lang: 'python' })).status, 'binary', '二進位內容');
        eq((await P.applyPatch({ source: 'x\n'.repeat(1200000), diff: patch, lang: 'python' })).status, 'too_large', '超大輸入');
        const two = patch + patch.replace(/m\.py/g, 'n.py'); eq((await run(SRC, two)).status, 'multi_file', '多檔要指定');
        eq((await P.applyPatch({ source: SRC, diff: patch, lang: 'python', opts: { requireVerify: true } })).status, 'no_verifier', '要求驗證但沒有驗證器');
        const nov = await P.applyPatch({ source: SRC, diff: patch, lang: 'python' }); ok(nov.ok && nov.verifiedAny === false && nov.gaps.some((g) => /沒有驗證/.test(g)), '沒驗證器就誠實標 unverified');
    }
    { // 其他語言各自一份（c：縮排無意義、空白差異可吃；括號壞掉回滾）
        const csrc = 'int add(int a, int b) {\n    return a + b;\n}\nint main(void) {\n    int x = add(1, 2);\n    return x - 3;\n}\n';
        const cfix = csrc.replace('return a + b;', 'return a + b + 0;'); const cd = P.makeDiff(csrc, cfix);
        const gcc = cp.spawnSync('gcc', ['--version']); const ccheck = async (s) => { if (gcc.status !== 0) return { ok: true }; const r = cp.spawnSync('gcc', ['-fsyntax-only', '-xc', '-'], { input: s, encoding: 'utf8' }); return r.status === 0 ? { ok: true } : { ok: false, detail: r.stderr.split('\n')[0] }; };
        const user = csrc.replace('return a + b;', 'return   a+b;'); const r = await P.applyPatch({ source: user, diff: cd, lang: 'c', check: ccheck }); ok(r.ok && r.source.includes('return a + b + 0;'), 'C：忽略空白：' + P.report(r));
        const r2 = await P.applyPatch({ source: csrc, diff: P.makeDiff(csrc, csrc.replace('return a + b;', 'return a + b')), lang: 'c', check: ccheck }); if (gcc.status === 0) ok(!r2.ok && r2.source === csrc, 'C：缺分號 → 回滾'); else n++;
    }
    { // 多檔全部或全不
        const dA = P.makeDiff('x = 1\n', 'x = 2\n', { oldName: 'a/a.py', newName: 'b/a.py' }), dB = P.makeDiff('y = 1\n', 'y = (\n', { oldName: 'a/b.py', newName: 'b/b.py' });
        const r = await P.applyPatchFiles({ diff: dA + dB, files: { 'a.py': { source: 'x = 1\n', lang: 'python' }, 'b.py': { source: 'y = 1\n', lang: 'python' } }, check: (s) => check(s) });
        ok(!r.ok && r.files.every((f) => f.source === undefined), '多檔任一失敗整批不動');
        const r2 = await P.applyPatchFiles({ diff: dA, files: { 'a.py': { source: 'x = 1\n', lang: 'python' } }, check: (s) => check(s) }); ok(r2.ok && r2.files[0].source === 'x = 2\n', '多檔全過');
    }
    // ---------- 三方合併：對照 git merge-file ----------
    let gitStats = null;
    if (hasGit) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-m3-')); const w = (f, ls) => { const p = path.join(dir, f); fs.writeFileSync(p, ls.join('\n') + '\n'); return p; };
        const git = (base, ours, theirs, style) => { const args = ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs']; if (style === 'diff3') args.push('--diff3'); args.push(w('o', ours), w('b', base), w('t', theirs)); const r = cp.spawnSync('git', args, { encoding: 'utf8' }); return { out: r.stdout, conflicts: r.status }; };
        const mine = (base, ours, theirs, style) => { const r = P.merge3(base, ours, theirs, { style, labels: { ours: 'ours', base: 'base', theirs: 'theirs' } }); return { out: r.lines.join('\n') + '\n', conflicts: r.conflicts.length }; };
        // 手選案例必須完全一致
        const B = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        const cases = [
            ['只有一邊改', B, B, B.map((x) => (x === 'c' ? 'C' : x))],
            ['兩邊改不同處', B, B.map((x) => (x === 'b' ? 'B' : x)), B.map((x) => (x === 'g' ? 'G' : x))],
            ['兩邊改成一樣', B, B.map((x) => (x === 'c' ? 'X' : x)), B.map((x) => (x === 'c' ? 'X' : x))],
            ['真衝突', B, B.map((x) => (x === 'c' ? 'X' : x)), B.map((x) => (x === 'c' ? 'Y' : x))],
            ['ours 插入 theirs 改旁邊', B, ['a', 'b', 'new1', 'new2', 'c', 'd', 'e', 'f', 'g', 'h'], B.map((x) => (x === 'g' ? 'G' : x))],
            ['一邊刪一邊改同行', B, B.filter((x) => x !== 'c'), B.map((x) => (x === 'c' ? 'Y' : x))],
            ['同處插入不同內容', B, ['a', 'b', 'p', 'c', 'd', 'e', 'f', 'g', 'h'], ['a', 'b', 'q', 'c', 'd', 'e', 'f', 'g', 'h']],
        ];
        let strict = 0; for (const [name, b, o, t] of cases) for (const style of ['merge', 'diff3']) { const g = git(b, o, t, style), m = mine(b, o, t, style); eq(m.conflicts > 0, g.conflicts > 0, name + '／' + style + '：衝突與否一致'); if (m.out === g.out) strict++; else console.log('  [差異] ' + name + '／' + style + '\n  git:\n' + g.out + '  mine:\n' + m.out); }
        // 隨機：種子固定
        let seed = 12345; const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
        const mut = (arr, tag) => { const a = arr.slice(); const k = 1 + rnd(3); for (let i = 0; i < k; i++) { const op = rnd(3), p = rnd(a.length + 1); if (op === 0) a.splice(p, 0, tag + rnd(50)); else if (op === 1 && a.length > 4) a.splice(Math.min(p, a.length - 1), 1); else if (a.length) a[Math.min(p, a.length - 1)] = tag + rnd(50); } return a; };
        const stats = { merge: { total: 0, decision: 0, text: 0, clean: 0, cleanText: 0 }, diff3: { total: 0, decision: 0, text: 0, clean: 0, cleanText: 0 } };
        for (let it = 0; it < 400; it++) {
            const base = Array.from({ length: 14 }, (_, i) => 'L' + i + '_' + rnd(4)); const o = mut(base, 'o'), t = mut(base, 't');
            for (const style of ['merge', 'diff3']) { const g = git(base, o, t, style), m = mine(base, o, t, style), s = stats[style]; s.total++; if ((m.conflicts > 0) === (g.conflicts > 0)) s.decision++; if (m.out === g.out) s.text++; if (g.conflicts === 0) { s.clean++; if (m.out === g.out) s.cleanText++; } }
        }
        gitStats = stats; for (const style of ['merge', 'diff3']) { const s = stats[style]; console.log('  git merge-file 對照 (' + style + ')：隨機 ' + s.total + ' 組；衝突與否一致 ' + s.decision + '；全文逐字一致 ' + s.text + '；git 判乾淨的 ' + s.clean + ' 組中結果一致 ' + s.cleanText); ok(s.decision / s.total >= 0.97, style + '：衝突與否一致率 ≥ 97%'); ok(s.cleanText === s.clean, style + '：乾淨合併的結果必須與 git 完全一致'); }
        { // 重複行很多的基底（Myers 有多個等價最長共同子序列，比較容易和 git 分歧）：只量測，下限放寬
            const st = { total: 0, decision: 0, text: 0, clean: 0, cleanText: 0 };
            for (let it = 0; it < 400; it++) {
                const base = Array.from({ length: 14 }, () => 'x' + rnd(3)); const o = mut(base, 'x'), t = mut(base, 'x'); const g = git(base, o, t, 'merge'), m = mine(base, o, t, 'merge');
                st.total++; if ((m.conflicts > 0) === (g.conflicts > 0)) st.decision++; if (m.out === g.out) st.text++; if (g.conflicts === 0) { st.clean++; if (m.out === g.out) st.cleanText++; }
            }
            console.log('  git merge-file 對照（大量重複行的基底，只量測）：' + st.total + ' 組；衝突與否一致 ' + st.decision + '；全文逐字一致 ' + st.text + '；git 判乾淨的 ' + st.clean + ' 組中一致 ' + st.cleanText); ok(st.decision / st.total >= 0.85, '重複行基底：衝突與否一致率 ≥ 85%'); gitStats.repeat = st;
        }
        ok(stats.merge.text === stats.merge.total && stats.diff3.text === stats.diff3.total, '無重複行的隨機案例必須逐字與 git 一致');
        console.log('  手選 ' + cases.length * 2 + ' 組中逐字一致 ' + strict);
        fs.rmSync(dir, { recursive: true, force: true });
    } else { console.log('  （沒有 git，略過對照）'); }
    console.log('code_patch.test.js 通過（' + n + ' 項；python ' + (hasPy ? '有' : '沒有') + '、git ' + (hasGit ? '有' : '沒有') + '）');
})().catch((e) => { console.error(e); process.exit(1); });
