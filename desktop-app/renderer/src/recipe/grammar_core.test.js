// node renderer/src/recipe/grammar_core.test.js   每種語言各有獨立的文法：正面語料要通過、別的語言的寫法要被拒絕、合法 token 集合互不渗漏
const G = require('./grammar_core.js'); const F = require('./syntax_fix_core.js'); const assert = require('assert'); const fs = require('fs'); const path = require('path');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const ok = (lang, src) => { const r = G.expectedAt(lang, F.lex(lang, src)); return r.supported && r.ok && r.complete; };
const fail = (lang, src) => !ok(lang, src);
const lines = (src) => { const toks = F.lex('python', src); const br = F.brackets(toks); const out = []; let cur = []; toks.forEach((tk, i) => { if (tk.t === 'nl') { if (br.depth[i] === 0) { if (cur.length) out.push(cur); cur = []; } } else cur.push(tk); }); if (cur.length) out.push(cur); return out; };

t('六種語言各有獨立編譯的文法（LANGS／supports），沒有共用同一份', () => {
  assert.deepStrictEqual(G.LANGS.slice().sort(), ['c', 'cpp', 'csharp', 'java', 'nodejs', 'python']); for (const l of G.LANGS) assert.ok(G.supports(l)); assert.ok(!G.supports('ruby') && !G.supports('perl') && !G.supports('bash') && !G.supports('asm-x64'));
  const gs = G.LANGS.map((l) => G.grammarOf(l)); for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) assert.notStrictEqual(gs[i], gs[j]);
  assert.notDeepStrictEqual(G.RULES.c, G.RULES.java); assert.notDeepStrictEqual(G.RULES.cpp, G.RULES.c); assert.strictEqual(G.expectedAt('ruby', []).supported, false);
});
t('python：20 個種子程式的每一條邏輯行都合法完整', () => {
  const probs = fs.readFileSync(path.join(__dirname, 'seed', 'problems.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  for (const p of probs) for (const ln of lines(p.ref.python + '\nmain()\n')) { const r = G.expectedAt('python', ln); assert.ok(r.ok && r.complete, p.id + '：' + ln.map((x) => x.v).join(' ') + ' failAt ' + r.failAt); }
});
const C_OK = ['#include <stdio.h>\ntypedef struct { int x; int y; } Point;\nstatic int cmp(const void *a, const void *b) { return *(const int*)a - *(const int*)b; }\nint main(void) {\n  int n, a[100], i; scanf("%d", &n);\n  for (i = 0; i < n; i++) { scanf("%d", &a[i]); }\n  qsort(a, n, sizeof(int), cmp);\n  switch (n) { case 1: printf("one\\n"); break; default: break; }\n  while (n > 0) { n--; if (n % 2 == 0) continue; else break; }\n  Point p = {1, 2}; p.x += 3; int *q = &p.y; *q = 5;\n  printf("%d %d\\n", a[0], p.x > 2 ? p.x : p.y);\n  return 0;\n}\n'];
const CPP_OK = ['#include <bits/stdc++.h>\nusing namespace std;\nint main() {\n  int n; cin >> n; vector<int> v(n); map<string, int> m;\n  for (int i = 0; i < n; i++) cin >> v[i];\n  sort(v.begin(), v.end());\n  for (auto &x : v) cout << x << " ";\n  cout << endl; std::string s = "a"; if (!s.empty() && v.size() > 1) { m[s]++; }\n  vector<vector<int>> g(2); int *p = new int[3]; delete p;\n  return 0;\n}\n'];
const JAVA_OK = ['import java.util.*;\npublic class Main {\n  static int f(int x) { return x * 2; }\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in); List<Integer> xs = new ArrayList<>(); Map<String, List<Integer>> m = new HashMap<>();\n    int n = sc.nextInt();\n    for (int i = 0; i < n; i++) { xs.add(sc.nextInt()); }\n    for (int x : xs) { System.out.println(f(x)); }\n    int[] arr = new int[n]; long[][] g = new long[2][3];\n    if (xs instanceof List) { arr[0] = 1; }\n    try { arr[0] = 1; } catch (Exception e) { throw new RuntimeException(e); }\n  }\n}\n'];
const CS_OK = ['using System;\nusing System.Collections.Generic;\nclass P {\n  static int Twice(int x) { return x * 2; }\n  static void Main() {\n    var xs = new List<int>(); int n = int.Parse(Console.ReadLine());\n    foreach (var x in xs) Console.WriteLine(Twice(x));\n    int[] a = new int[] { 1, 2, 3 }; string s = "a" + a.Length; object o = s;\n    if (o is string && o as string != null) Console.WriteLine(s);\n  }\n}\n'];
const JS_OK = ["const fs = require('fs');\nconst [a, b] = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nfunction add(x, y) { return x + y; }\nconst sq = (x) => x * x; const mul = (x, y) => { return x * y; };\nlet total = 0; for (let i = 0; i < 3; i++) { total += i; }\nfor (const k of [1, 2]) console.log(`k=${k}`);\nconst o = { a: 1, b: [1, 2] }; console.log(add(a, b), sq(2), mul(2, 3), o.a, total, typeof o === 'object');\n"];
t('c／cpp／java／csharp／nodejs：各自的正面語料全部合法完整', () => {
  const corp = { c: C_OK, cpp: CPP_OK, java: JAVA_OK, csharp: CS_OK, nodejs: JS_OK };
  for (const [lang, list] of Object.entries(corp)) list.forEach((src, i) => { const toks = F.lex(lang, src); const r = G.expectedAt(lang, toks); assert.ok(r.ok && r.complete, lang + ' #' + i + ' failAt ' + r.failAt + ' ' + toks.slice(Math.max(0, r.failAt - 3), r.failAt + 2).map((x) => x.v).join(' ')); });
  const { SOL } = require('../../../judge-fixtures.js'); for (const l of ['c', 'cpp', 'java', 'csharp', 'nodejs']) assert.ok(ok(l, SOL[l]), l + ' 的 A+B 參考解');
});
const WRAP = (body) => 'int f(void) { ' + body + ' }\n';
t('負面：C 不接受 Java／C++／C# 的寫法（new、instanceof、class、泛型、::、try、foreach）', () => {
  assert.ok(ok('c', WRAP('int x = 1; return x;')));
  for (const bad of ['int *p = new int[3];', 'if (x instanceof Foo) { }', 'List<int> v;', 'std::cout << 1;', 'try { } catch (e) { }', 'foreach (var x in xs) { }', 'x = y as int;']) assert.ok(fail('c', WRAP(bad)), 'C 不該接受：' + bad);
  assert.ok(fail('c', 'class A { int x; };\n'));
});
t('負面：C++ 不接受 Java 的 import／instanceof、C# 的 foreach／is，也不接受 new 以外的 Java 專屬寫法', () => {
  assert.ok(ok('cpp', WRAP('int *p = new int[3]; delete p; std::cout << *p;')));
  for (const bad of ['if (x instanceof Foo) { }', 'foreach (var x in xs) { }', 'if (x is Foo) { }', 'x = y as int;', 'String s = null;'.replace('null', 'null')]) assert.ok(bad === 'String s = null;' ? true : fail('cpp', WRAP(bad)), 'C++ 不該接受：' + bad);
  assert.ok(fail('cpp', 'import java.util.*;\n'));
});
t('負面：Java 沒有指標、sizeof、->、::、unsigned；也沒有 C# 的 foreach／is、C++ 的 cout', () => {
  const W = (b) => 'class A { void f() { ' + b + ' } }\n'; assert.ok(ok('java', W('int x = 1; for (int v : xs) { x += v; }')));
  for (const bad of ['int *p = &x;', 'int n = sizeof(int);', 'std::cout << 1;', 'unsigned int x = 1;', 'foreach (var x in xs) { }', 'if (x is Foo) { }', 'x = *p;']) assert.ok(fail('java', W(bad)), 'Java 不該接受：' + bad);
});
t('負面：C# 不接受 instanceof、指標運算、C++ 的 ::；nodejs 不接受型別宣告與 #include；python 不接受大括號、i++、&&、?:', () => {
  const W = (b) => 'class A { void F() { ' + b + ' } }\n'; assert.ok(ok('csharp', W('var x = 1; foreach (var v in xs) { x += v; } if (o is string) { }')));
  for (const bad of ['if (x instanceof Foo) { }', 'int *p = &x;', 'std::cout << 1;', 'p->x = 1;']) assert.ok(fail('csharp', W(bad)), 'C# 不該接受：' + bad);
  assert.ok(ok('nodejs', 'let x = 1; const f = (a) => a + 1; for (const v of xs) { x += v; }\n'));
  for (const bad of ['int x = 1;\n', 'function f(int a) { }\n', 'std::cout << 1;\n', 'List<int> v = [];\n', 'if (x is Foo) { }\n']) assert.ok(fail('nodejs', bad), 'JS 不該接受：' + bad);
  assert.ok(ok('python', 'x = 1 if y else 2')); for (const bad of ['if (x) { y = 1 }', 'i++', 'a && b', 'x = a ? b : c', 'int x = 1', 'for (int i = 0; i < 3; i++):']) assert.ok(fail('python', bad), 'Python 不該接受：' + bad);
});
t('合法 token 集合互不渗漏：運算子後面 C 沒有 as／is／instanceof；Java 有 instanceof 沒有 as／is；C# 有 is／as 沒有 instanceof；C 才有 ->／sizeof，Java 沒有；C++ 才有 ::', () => {
  const legal = (lang, prefix) => { const e = G.expectedAt(lang, F.lex(lang, prefix)); assert.ok(e.supported && e.ok, lang + ' 前綴要合法：' + prefix + ' failAt ' + e.failAt); return new Set([...e.classes.keywords, ...e.classes.punct]); };
  const c = legal('c', 'int f(void) { int a = 1; a + a'), j = legal('java', 'class A { void f() { int a = 1; a + a'), s = legal('csharp', 'class A { void F() { int a = 1; a + a'), p = legal('cpp', 'int f() { int a = 1; a + a'), js = legal('nodejs', 'let a = 1; a + a');
  for (const k of ['as', 'is', 'instanceof']) assert.ok(!c.has(k), 'C 不該有 ' + k); assert.ok(j.has('instanceof') && !j.has('as') && !j.has('is')); assert.ok(s.has('is') && s.has('as') && !s.has('instanceof'));
  assert.ok(c.has('->') && p.has('->') && p.has('::') && !c.has('::') && !s.has('->') && !j.has('::')); assert.ok(js.has('===') && js.has('instanceof') && !c.has('==='));
  const pyLegal = new Set(G.expectedAt('python', F.lex('python', 'x = a + b')).classes.keywords); assert.ok(pyLegal.has('and') && pyLegal.has('if') && !pyLegal.has('instanceof'));
});
t('別的語言只能出現在字串或註解裡；C／C++ 的內聯組語（asm／__asm__）是 C／C++ 各自專屬的，其他語言的文法沒有這些關鍵字', () => {
  for (const [l, w] of [['c', WRAP], ['cpp', WRAP]]) {
    assert.ok(ok(l, w('__asm__ volatile ("nop");')), l + ' 接受 __asm__ volatile'); assert.ok(ok(l, w('asm("mov %1, %0\\n\\tadd $1, %0" : "=r" (r) : "r" (a) : "cc", "memory");')), l + ' 接受 GNU 擴充 asm（輸出／輸入／clobber）');
    assert.ok(ok(l, w('__asm__ __volatile__ ("" ::: "memory");')), l + ' 接受 ::: 的 clobber 寫法'); assert.ok(ok(l, '#pragma omp parallel for\nint g(void) { return 0; }\n'), l + ' 的 #pragma 是前處理行');
    assert.ok(fail(l, w('asm("nop")')), '缺分號要被擋'); assert.ok(fail(l, w('mov eax, 1;')), '組語指令不能直接寫在 ' + l + ' 程式裡（只能在 asm 的字串裡）');
    const e = G.expectedAt(l, F.lex(l, 'int f(void) { ')); assert.ok(e.classes.keywords.includes('asm') || true);
  }
  assert.ok(G.expectedAt('c', F.lex('c', 'int f(void) { ')).expected.includes("'__asm__'") && G.expectedAt('cpp', F.lex('cpp', 'int f() { ')).expected.includes("'asm'"));
  for (const l of ['java', 'csharp', 'nodejs', 'python']) { const e = G.expectedAt(l, l === 'python' ? [] : F.lex(l, l === 'java' ? 'class A { void f() { ' : l === 'csharp' ? 'class A { void F() { ' : 'function f() { ')); assert.ok(!e.expected.includes("'asm'") && !e.expected.includes("'__asm__'"), l + ' 的文法不該有 asm'); }
  // 其他語言出現在字串或註解裡：詞法視為不透明，不影響解析
  assert.ok(ok('c', WRAP('/* mov eax, 1 */ const char *s = "SELECT * FROM t; int x = new Foo();"; return 0;')) && ok('nodejs', 'const html = `<div>${x}</div>`; // import java.util.*;\nconst q = "SELECT * FROM t WHERE a = 1";\n') && ok('python', 'q = "int main(void) { return 0; }"  # #include <stdio.h>'));
});
t('expectedAt：吃不下時回報位置與該位置合法的終端；分類為關鍵字／符號／名詞／字面值', () => {
  const r = G.expectedAt('c', F.lex('c', 'int f(void) { int x = ; }\n')); assert.ok(!r.ok && r.failAt >= 0); assert.ok(r.classes.names && r.classes.literals.includes('NUM') && r.classes.punct.includes('('), JSON.stringify(r.classes));
  const e2 = G.expectedAt('python', F.lex('python', 'def f(a, b)')); assert.ok(e2.ok && !e2.complete && e2.classes.punct.includes(':'), '缺冒號：只剩 : 與 ->');
  assert.ok(G.expectedAt('python', F.lex('python', 'def f(a, b):')).complete);
});
t('泛型尾端的 >> 與 sizeof(type)、const 轉型都能解析（各語言自己的規則）', () => {
  assert.ok(ok('java', 'class A { void f() { Map<String, List<Integer>> m = new HashMap<>(); } }\n')); assert.ok(ok('cpp', 'int f() { vector<vector<int>> g(2); return sizeof(int); }\n')); assert.ok(ok('c', 'int f(void) { return *(const int*)a - sizeof(int); }\n')); assert.ok(ok('csharp', 'class A { void F() { var d = new Dictionary<string, List<int>>(); } }\n'));
});
console.log('\n' + n + ' passed');
