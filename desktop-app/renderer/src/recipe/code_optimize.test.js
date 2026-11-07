'use strict';
// 程式優化對照表：每條規則「慢寫法 → 優化寫法」：①認得出來 ②改完輸出一致 ③大輸入實測不變慢（且多半明顯變快）④不安全的寫法不動 ⑤沒有執行器／輸入就不改。
const assert = require('assert'), cp = require('child_process'); const O = require('./code_optimize_core.js');
const run = async (src, input) => { const t0 = Date.now(); const r = cp.spawnSync('python3', ['-I', '-c', src + '\nimport resource as _r, sys as _s\n_s.stderr.write("\\nMEM " + str(_r.getrusage(_r.RUSAGE_SELF).ru_maxrss))\n'], { input, encoding: 'utf8', timeout: 30000 }); const mm = /MEM (\d+)/.exec(r.stderr); return { ok: r.status === 0, out: r.stdout, err: r.stderr.slice(-120), ms: Date.now() - t0, mem: mm ? Number(mm[1]) : null }; };
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1)); const ints = (n, lo, hi) => Array.from({ length: n }, () => rnd(lo, hi));
const C = [
    { id: 'list-as-set', src: 'n = int(input())\na = list(map(int, input().split()))\nseen = []\nfor x in a:\n    if x not in seen:\n        seen.append(x)\nprint(len(seen))\n', gen: (n) => n + '\n' + ints(n, 0, n).join(' ') + '\n', small: 30, big: 12000, speed: 3 },
    { id: 'queue-popleft', src: 'n = int(input())\nq = list(range(n))\ntot = 0\nwhile q:\n    x = q.pop(0)\n    tot += x % 7\nprint(tot)\n', gen: (n) => n + '\n', small: 20, big: 150000, speed: 3 },
    { id: 'recursion-memo', src: 'def f(n):\n    if n < 2:\n        return n\n    return f(n - 1) + f(n - 2)\n\nn = int(input())\nprint(f(n))\n', gen: (n) => n + '\n', small: 10, big: 32, speed: 8 },
    { id: 'str-join', src: 'n = int(input())\ns = ""\nfor i in range(n):\n    s += str(i % 10)\nprint(s)\n', gen: (n) => n + '\n', small: 12, big: 200000, speed: 0 },
    { id: 'sorted-extreme', src: 'n = int(input())\na = list(map(int, input().split()))\nprint(sorted(a)[-1], sorted(a)[0], sorted(a, reverse=True)[0])\n', gen: (n) => n + '\n' + ints(n, -50, 50).join(' ') + '\n', small: 9, big: 300000, speed: 0 },
    { id: 'readonly-in-set', src: 'n = int(input())\na = list(map(int, input().split()))\nb = list(map(int, input().split()))\nc = 0\nfor x in a:\n    if x in b:\n        c += 1\nprint(c)\n', gen: (n) => n + '\n' + ints(n, 0, 2 * n).join(' ') + '\n' + ints(n, 0, 2 * n).join(' ') + '\n', small: 25, big: 6000, speed: 3 },
    { id: 'count-counter', src: 'n = int(input())\na = list(map(int, input().split()))\nr = 0\nfor x in a:\n    if a.count(x) > 1:\n        r += 1\nprint(r)\n', gen: (n) => n + '\n' + ints(n, 0, n).join(' ') + '\n', small: 20, big: 8000, speed: 3 },
    { id: 'list-append', src: 'n = int(input())\nres = []\nfor i in range(n):\n    res = res + [i * i % 11]\nprint(sum(res))\n', gen: (n) => n + '\n', small: 15, big: 40000, speed: 3 },
    { id: 'prefix-sum', src: 'n, q = map(int, input().split())\na = list(map(int, input().split()))\nfor _ in range(q):\n    l, r = map(int, input().split())\n    print(sum(a[l:r]))\n', gen: (n) => { const q = n; return n + ' ' + q + '\n' + ints(n, -9, 9).join(' ') + '\n' + Array.from({ length: q }, () => { const l = rnd(0, n - 1); return l + ' ' + rnd(l, n); }).join('\n') + '\n'; }, small: 12, big: 6000, speed: 3 },
    { id: 'insert-front', src: 'n = int(input())\nq = []\nfor i in range(n):\n    q.insert(0, i % 9)\nprint(sum(q), q.pop(), len(q))\n', gen: (n) => n + '\n', small: 12, big: 120000, speed: 3 },
    { id: 'listcomp-genexp', src: 'n = int(input())\nprint(sum([i * i % 7 for i in range(n)]), max([i % 13 for i in range(n)]))\n', gen: (n) => n + '\n', small: 12, big: 3000000, speed: 0, mem: 1.5 },
    { id: 'keys-in', src: 'n = int(input())\nd = {i: i for i in range(n)}\nc = 0\nfor i in range(0, 2 * n, 2):\n    if i in d.keys():\n        c += 1\nprint(c)\n', gen: (n) => n + '\n', small: 12, big: 100000, speed: 0 },
];
(async () => {
    let ok = 0; const rows = [];
    for (const c of C) {
        const det = O.detectAll(c.src); assert.ok(det.some((d) => d.id === c.id), c.id + ' 要認得出來：' + JSON.stringify(det.map((d) => d.id)));
        if (c.id === 'str-join') { const rj = await O.optimize({ source: c.src, run, inputs: Array.from({ length: 4 }, (_, i) => c.gen(c.small + i)), bigInput: c.gen(c.big) }); assert.ok(!rj.applied.some((a) => a.id === 'str-join') && rj.skipped.some((s) => s.id === 'str-join' && /記憶體/.test(s.reason)), 'CPython 已優化 +=，實測記憶體變大要退回（誠實不硬換）：' + JSON.stringify(rj.skipped)); rows.push('str-join：認得，但實測記憶體變大 → 退回（不硬換）'); ok++; continue; }
        const inputs = Array.from({ length: 6 }, (_, i) => c.gen(c.small + i)); const r = await O.optimize({ source: c.src, run, inputs, bigInput: c.gen(c.big) });
        assert.ok(r.ok && r.applied.some((a) => a.id === c.id), c.id + ' 要套用：' + JSON.stringify(r.skipped) + ' ' + r.notes);
        const a = r.applied.find((x) => x.id === c.id); if (c.mem) assert.ok(a.mem && a.mem[0] / a.mem[1] >= c.mem, c.id + ' 峰值記憶體 ' + JSON.stringify(a.mem) + ' 要至少省 ' + c.mem + ' 倍'); if (c.speed) assert.ok(a.speedup >= c.speed, c.id + ' 實測加速 ' + a.speedup + ' 倍，要 ≥ ' + c.speed);
        const big = c.gen(Math.max(c.small + 3, Math.floor(c.big / 3))); const x = await run(c.src, big), y = await run(r.source, big); assert.strictEqual(y.out.trim(), x.out.trim(), c.id + ' 另一組大輸入輸出一致'); ok++; rows.push(c.id + ' ' + (a.ms ? a.ms[0] + '→' + a.ms[1] + 'ms ×' + a.speedup : '') + (a.mem ? '，記憶體 ' + Math.round(a.mem[0] / 1024) + '→' + Math.round(a.mem[1] / 1024) + 'MB' : ''));
    }
    console.log(rows.join('\n'));
    // 不安全的寫法不動：list 被拿來索引、佇列被索引、遞迴有副作用
    const unsafe = [
        'a = []\nfor x in [1, 2, 2]:\n    if x not in a:\n        a.append(x)\nprint(a[0], len(a), a)\n',
        'q = [1, 2, 3]\nwhile q:\n    print(q[-1])\n    q.pop(0)\n',
        'def f(n):\n    print(n)\n    if n < 2:\n        return n\n    return f(n - 1) + f(n - 2)\nprint(f(4))\n',
    ];
    for (const u of unsafe) { const r = await O.optimize({ source: u, run, inputs: ['\n'] }); assert.ok(r.ok && !r.applied.length && r.source === u, '不安全的不能動：' + u.split('\n')[0] + ' → ' + JSON.stringify(r.applied)); }
    // 沒執行器／沒輸入：不改
    const none = await O.optimize({ source: C[0].src }); assert.strictEqual(none.ok, false); assert.strictEqual(none.source, C[0].src);
    // 改完輸出不同要退回：偽造一條規則
    const fake = { id: 'fake', name: 'fake', before: '', after: '', memory: '', detect: () => ({}), rewrite: (s) => s.replace('print(1)', 'print(2)') }; O.RULES.push(fake); const rf = await O.optimize({ source: 'print(1)\n', run, inputs: ['\n'] }); O.RULES.pop(); assert.ok(rf.skipped.some((s) => s.id === 'fake') && rf.source === 'print(1)\n', '輸出不同要退回');
    // 報告要寫出驗證範圍
    const rep = O.report(await O.optimize({ source: C[7].src, run, inputs: [C[7].gen(10)] })); assert.ok(/輸出一致只在 1 組輸入上驗證/.test(rep) && /list\.append|append/.test(rep), rep);
    console.log(ok + ' passed, 0 failed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exit(1); });
