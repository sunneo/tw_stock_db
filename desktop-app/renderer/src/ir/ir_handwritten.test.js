'use strict';
// 手寫程式覆蓋率量測（2026-11-11）：「進」之前只用我們自己輸出的程式驗證。這裡每個語言寫一份「人會這樣寫」的慣用程式
// （讀 n 與 n 個整數，印平方和與最大值），量：剖得出來嗎、IR 驗證過嗎、原生區塊（認不得、整段原文保留）佔幾成、原生區塊有沒有丟原文。
// 這是量測不是目標：門檻只擋「退步到全是原生區塊」；實際比例印在輸出，並記在 DESIGN.core-ir.md §16。
// 需要 tree-sitter 文法快取（沒有的語言略過）；perl 用自己寫的剖析器。
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const IR = require('./ir_core.js'), OPS = require('./ir_ops_core.js'), INB = require('./ir_in_brace_core.js'), INT = require('./ir_in_typed_core.js'), INR = require('./ir_in_ruby_core.js'), INP = require('./ir_in_perl_core.js');
const DIR = process.env.FA_TS_DIR || [path.join(os.homedir(), '.cache', 'fa-ts'), path.join(os.tmpdir(), 'fa-ts-cache'), '/tmp/fa-ts-cache'].find((d) => fs.existsSync(path.join(d, 'tree-sitter-python.wasm')));
let pass = 0, fail = 0; const table = {};
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error('FAIL ' + name + '\n   ' + String(e.message).split('\n').slice(0, 12).join('\n   ')); } };

const PROGS = {
    nodejs: `// 讀 n 與 n 個整數，印平方和與最大值
const lines = require('fs').readFileSync(0, 'utf8').split('\\n');
const n = parseInt(lines[0]);
const nums = lines[1].split(' ').map(Number);
function sumSquares(a) {
  let s = 0;
  for (const x of a) { s += x * x; }
  return s;
}
function biggest(a) {
  let m = a[0];
  for (let i = 1; i < a.length; i++) { if (a[i] > m) m = a[i]; }
  return m;
}
console.log(sumSquares(nums));
console.log(biggest(nums));
console.log(\`n=\${n}\`);
`,
    java: `import java.util.*;

public class Main {
    // 平方和
    static long sumSquares(List<Long> a) {
        long s = 0;
        for (long x : a) { s += x * x; }
        return s;
    }
    static long biggest(List<Long> a) {
        long m = a.get(0);
        for (int i = 1; i < a.size(); i++) { if (a.get(i) > m) m = a.get(i); }
        return m;
    }
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        List<Long> nums = new ArrayList<>();
        for (int i = 0; i < n; i++) nums.add(sc.nextLong());
        System.out.println(sumSquares(nums));
        System.out.println(biggest(nums));
        System.out.printf("n=%d%n", n);
    }
}
`,
    c: `#include <stdio.h>

/* 平方和 */
long long sum_squares(long long *a, int n) {
    long long s = 0;
    for (int i = 0; i < n; i++) { s += a[i] * a[i]; }
    return s;
}

long long biggest(long long *a, int n) {
    long long m = a[0];
    for (int i = 1; i < n; i++) { if (a[i] > m) m = a[i]; }
    return m;
}

int main(void) {
    int n;
    long long a[100];
    scanf("%d", &n);
    for (int i = 0; i < n; i++) scanf("%lld", &a[i]);
    printf("%lld\\n", sum_squares(a, n));
    printf("%lld\\n", biggest(a, n));
    return 0;
}
`,
    cpp: `#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;

// 平方和
long long sumSquares(const vector<long long>& a) {
    long long s = 0;
    for (auto x : a) { s += x * x; }
    return s;
}

long long biggest(const vector<long long>& a) {
    return *max_element(a.begin(), a.end());
}

int main() {
    int n;
    cin >> n;
    vector<long long> nums(n);
    for (int i = 0; i < n; i++) cin >> nums[i];
    cout << sumSquares(nums) << endl;
    cout << biggest(nums) << endl;
    return 0;
}
`,
    csharp: `using System;
using System.Collections.Generic;
using System.Linq;

class Program {
    // 平方和
    static long SumSquares(List<long> a) {
        long s = 0;
        foreach (var x in a) { s += x * x; }
        return s;
    }
    static long Biggest(List<long> a) {
        return a.Max();
    }
    static void Main() {
        int n = int.Parse(Console.ReadLine());
        List<long> nums = Console.ReadLine().Split(' ').Select(long.Parse).ToList();
        Console.WriteLine(SumSquares(nums));
        Console.WriteLine(Biggest(nums));
        Console.WriteLine($"n={n}");
    }
}
`,
    ruby: `# 讀 n 與 n 個整數，印平方和與最大值
def sum_squares(a)
  s = 0
  a.each { |x| s += x * x }
  s
end

def biggest(a)
  a.max
end

n = gets.to_i
nums = gets.split.map(&:to_i)
puts sum_squares(nums)
puts biggest(nums)
puts "n=#{n}"
`,
    perl: `#!/usr/bin/perl
use strict;
use warnings;
# 讀 n 與 n 個整數，印平方和與最大值
sub sum_squares {
    my ($a) = @_;
    my $s = 0;
    foreach my $x (@$a) { $s += $x * $x; }
    return $s;
}
sub biggest {
    my ($a) = @_;
    my $m = $a->[0];
    foreach my $x (@$a) { $m = $x if $x > $m; }
    return $m;
}
my $n = <STDIN>;
chomp $n;
my @nums = split ' ', <STDIN>;
print sum_squares(\\@nums), "\\n";
print biggest(\\@nums), "\\n";
print "n=$n\\n";
`
};

(async () => {
    if (!DIR) { console.log('略過：找不到 tree-sitter 快取\n0 passed, 0 failed'); return; }
    const Parser = require(path.join(DIR, 'tree-sitter.js')); await Parser.init({ locateFile: () => path.join(DIR, 'tree-sitter.wasm') });
    const W = { nodejs: 'javascript', java: 'java', c: 'c', cpp: 'cpp', csharp: 'c_sharp', ruby: 'ruby' };
    for (const lang of Object.keys(PROGS)) {
        let P = null;
        if (lang !== 'perl') { const f = path.join(DIR, 'tree-sitter-' + W[lang] + '.wasm'); if (!fs.existsSync(f)) { table[lang] = '略過（沒有文法 ' + W[lang] + '）'; continue; } P = new Parser(); P.setLanguage(await Parser.Language.load(f)); }
        const src = PROGS[lang];
        t(lang + '：手寫程式可剖析、IR 通過驗證、原生區塊保留原文', () => {
            let r;
            if (lang === 'perl') r = INP.fromSource(src, { patterns: INP.buildPatterns(), name: 'hand' });
            else if (lang === 'ruby') r = INR.fromTree(P.parse(src).rootNode, { source: src, patterns: INR.buildPatterns((s) => P.parse(s).rootNode) });
            else if (lang === 'cpp' || lang === 'csharp') { const L2 = lang === 'csharp' ? 'cs' : 'cpp'; r = INT.fromTree(P.parse(src).rootNode, { lang: L2, source: src, patterns: INT.buildPatterns(L2, (s) => P.parse(s).rootNode) }); }
            else r = INB.fromTree(P.parse(src).rootNode, { lang, source: src, patterns: INB.buildPatterns(lang, (s) => P.parse(s).rootNode) });
            const v = IR.validate(r.ir, { ops: { has: OPS.has } }); assert.ok(v.ok, '驗證：' + v.errors.slice(0, 3).join(';'));
            const funcs = IR.funcs(r.ir).map((f) => f.name); assert.ok(funcs.length >= 2, '函式數 ' + funcs.join(','));
            const natives = []; IR.walkStmts(r.ir.body, (s) => { if (s.k === 'native') natives.push(s); }); IR.eachExpr(r.ir.body, (e) => { if (e.k === 'native') natives.push(e); });
            natives.forEach((n) => assert.ok(n.src && n.src.length > 0, '原生區塊沒有保留原文'));
            const cov = r.coverage || {}; const stmts = cov.stmts || 0, nat = cov.natives != null ? cov.natives : natives.length;
            assert.ok(stmts === 0 || nat < stmts, '全部都是原生區塊（退步）：' + nat + '/' + stmts);
            table[lang] = { 函式: funcs.join('、'), 敘述: stmts, 原生: nat, 原生佔比: stmts ? Math.round((100 * nat) / stmts) + '%' : '?', 例: natives.slice(0, 4).map((n) => String(n.src).split('\n')[0].slice(0, 40)) };
        });
    }
    // 回歸（2026-11-11）：java 的 a.size()（目錄樣板是 (long)a.size()，手寫沒有轉型）與 cpp 的 *max_element(…)（手寫用 using namespace std，沒有 std::）原本是原生區塊；樣式變體補上後應為 0
    t('回歸：java 的 a.size() 與 cpp 的 max_element 不再是原生區塊', () => {
        if (table.java) assert.strictEqual(table.java.原生, 0, 'java 原生區塊 ' + table.java.原生 + '：' + JSON.stringify(table.java.例));
        if (table.cpp) assert.strictEqual(table.cpp.原生, 0, 'cpp 原生區塊 ' + table.cpp.原生 + '：' + JSON.stringify(table.cpp.例));
    });
    console.log(JSON.stringify(table, null, 1)); console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
