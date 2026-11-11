// node renderer/src/studio/dsl_expr_core.test.js
const X = require('./dsl_expr_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 300) : '')); } };
const ev = (s, env) => X.evaluate(s, env || {});
const val = (s, env) => { const r = ev(s, env); return r.ok ? r.value : 'ERR:' + r.error; };

// 算術與 Python 語意
check('加減乘', val('2 + 3 * 4 - 1') === 13n);
check('// 向負無窮', val('-7 // 2') === -4n && val('7 // -2') === -4n && val('7 // 2') === 3n);
check('% 與除數同號', val('-7 % 3') === 2n && val('7 % -3') === -2n);
check('乘冪右結合與大整數', val('2 ** 3 ** 2') === 512n && val('2 ** 100') === 2n ** 100n);
check('-2 ** 2 是 -4', val('-2 ** 2') === -4n);
check('位元運算', val('(5 & 3) | (1 << 4) ^ 2') === ((5n & 3n) | ((1n << 4n) ^ 2n)));
check('比較鏈', val('1 < 2 < 3') === true && val('1 < 3 < 2') === false);
check('and/or 回傳運算元', val('0 or 5') === 5n && val('3 and 4') === 4n && val('"" or "x"') === 'x');
check('三元', val('1 if n > 2 else 0', { n: 5 }) === 1n && val('1 if n > 2 else 0', { n: 1 }) === 0n);
check('變數用 number 也行', val('n * 2', { n: 21 }) === 42n);
// 字串與清單
check('字串運算', val('"ab" * 3 + "c"') === 'abababc' && val('s[1:3]', { s: 'hello' }) === 'el' && val('s[-1]', { s: 'hello' }) === 'o');
check('方法', val('s.count("a")', { s: 'banana' }) === 3n && val('s.upper()', { s: 'ab' }) === 'AB' && val('",".join(["a","b"])') === 'a,b');
check('清單函式', JSON.stringify(val('sorted(a)', { a: [3n, 1n, 2n] }), (k, v) => (typeof v === 'bigint' ? Number(v) : v)) === '[1,2,3]');
check('sum/min/max/len', val('sum(a)', { a: [1n, 2n, 3n] }) === 6n && val('max(a)', { a: [1n, 9n, 3n] }) === 9n && val('len(a)', { a: [1n, 2n] }) === 2n && val('min(4, 2, 8)') === 2n);
check('推導式', val('sum([x * x for x in range(1, 5)])') === 30n && val('len([x for x in a if x % 2 == 0])', { a: [1n, 2n, 3n, 4n] }) === 2n);
check('in / not in', val('"a" in "cat"') === true && val('3 not in [1,2]') === true);
check('int/str 轉換', val('int("42") + 1') === 43n && val('str(12) + "x"') === '12x');
check('pow 取模', val('pow(3, 200, 1000007)') === 3n ** 200n % 1000007n);
check('反轉與回文', val('s == "".join(reversed(s))', { s: 'abcba' }) === true);
// 格式化輸出
check('format int', X.format(5n, 'int') === '5'); check('format bool 自訂字樣', X.format(true, 'bool', { yes: 'YES', no: 'NO' }) === 'YES' && X.format(false, 'bool', {}) === 'no');
check('format ints', X.format([1n, 2n, 3n], 'ints') === '1 2 3'); check('format 型別不符丟錯', (() => { try { X.format('a', 'int'); return false; } catch (_) { return true; } })());
// 自由變數
const p = X.parse('a * n + k + sum([x for x in b])'); check('自由變數不含綁定變數與函式', p.ok && p.vars.sort().join() === 'a,b,k,n', p.vars);
// 安全：這些都必須被拒絕（解析階段）
for (const s of ['__import__("os")', 'open("x")', 'eval("1")', 'x.__class__', 'a.b', 'lambda: 1', '(1, 2)', '1.5 + 1', '1e3', '7 / 2', 'x = 1', 'print(1)', 'import os', '[].append(1)', 's.format(1)', 'a[1:2:3]', '~1', 'None', 'f(x)', '__builtins__', 'x if', '1 +', '', '   ', '1 2', '{}', 'a;b', 'getattr(a, "b")', '$x'])
    check('拒絕：' + JSON.stringify(s), !X.parse(s).ok && true, X.parse(s));
check('exec 當變數名不是危險（會在執行時因沒有此變數失敗）', X.parse('exec').ok === true && ev('exec').ok === false);
check('__builtins__ 被拒', !X.parse('__builtins__').ok);
// 資源上限
check('range 太大被擋', !ev('len(range(10 ** 9))').ok && /範圍/.test(ev('len(range(10 ** 9))').error));
check('乘冪太大被擋', !ev('9 ** 9 ** 9').ok);
check('字串重複太大被擋', !ev('"abc" * 10 ** 9').ok);
check('位移太大被擋', !ev('1 << 10 ** 6').ok);
check('步數上限', !X.evaluate('sum([x for x in range(100000)])', {}, { maxSteps: 1000 }).ok);
check('字串 % 格式化在執行時拒絕（不丟例外）', !ev('"%s" % 1').ok && ev('"%s" % 1').ok === false);
check('除以零回錯誤不丟例外', !ev('1 // 0').ok && !ev('1 % 0').ok);
check('索引超出回錯誤', !ev('a[5]', { a: [1n] }).ok);
check('缺變數回錯誤', /沒有這個變數/.test(ev('zz + 1').error));
check('型別錯誤回錯誤', !ev('"a" + 1').ok && !ev('"a" < 1').ok);
check('浮點變數被拒', !ev('x', { x: 1.5 }).ok);
check('過長運算式被拒', !X.parse('1+' .repeat(400) + '1').ok);
// 與 Python 對拍（有 python 才跑）
try {
    const cp = require('child_process'); const cases = [['-7 // 2', {}], ['(n * 3 + 7) % 11', { n: 25 }], ['sum([x * x for x in range(1, n + 1)])', { n: 12 }], ['s[::1]'.replace('[::1]', '[1:4]'), { s: 'abcdefg' }], ['2 ** 70 // 3', {}], ['max(a) - min(a)', { a: [4, -2, 9] }], ['"".join(reversed(s)) == s', { s: 'noon' }], ['sorted(a)[1]', { a: [5, 1, 3] }], ['-7 % 3', {}], ['len("hello") if n > 1 else 0', { n: 3 }]];
    const probe = cp.spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' });
    if (probe.status === 0) for (const [src, env] of cases) {
        const pre = Object.keys(env).map((k) => k + ' = ' + JSON.stringify(env[k])).join('; ');
        const r = cp.spawnSync('python3', ['-I', '-c', (pre ? pre + '\n' : '') + 'r = ' + src + '\nprint(r)'], { encoding: 'utf8' });
        const mine = ev(src, Object.fromEntries(Object.entries(env).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => BigInt(x)) : v])));
        check('對拍 Python：' + src, r.status === 0 && mine.ok && (typeof mine.value === 'string' ? mine.value : X.toPy(mine.value)) === r.stdout.trim(), { py: r.stdout, mine });
    } else console.log('略過對拍：找不到 python');
} catch (_) { console.log('略過對拍'); }
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
