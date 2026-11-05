// node code-loop.test.js   整合測試：真的判題器（judge-runner）＋腳本化的假模型。
// 這**不是**小模型能力的證據：「模型」只是回放參考解，證明的是 (1) 種子題庫自洽 (2) 切割→寫→組裝→驗收的管線在各語言真的通 (3) 失敗回饋與重寫的流程。
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const R = require('./judge-runner.js'); const PRJ = require('./renderer/src/recipe/code_project_core.js'); const J = require('./renderer/src/recipe/judge_core.js'); const C = require('./renderer/src/recipe/code_loop_core.js'); const F = require('./renderer/src/recipe/code_loop_fake.js');
const PROBLEMS = fs.readFileSync(path.join(__dirname, 'renderer/src/recipe/seed/problems.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byId = (id) => PROBLEMS.find((p) => p.id === id);
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };
const judgeFor = (problem) => ({ lang, source }) => R.judge({ lang, source, problem });

// 兩個函式的 A+B：add 與入口，各語言各一份
const TWO = {
  python: { add: 'def add(a, b):\n    return a + b\n', main: 'import sys\ndef main():\n    a, b = map(int, sys.stdin.readline().split())\n    print(add(a, b))\n', sig: ['def add(a, b)', 'def main()'] },
  nodejs: { add: 'function add(a, b) { return a + b; }\n', main: "const fs = require('fs');\nfunction main() { const [a, b] = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number); console.log(add(a, b)); }\n", sig: ['function add(a, b)', 'function main()'] },
  c: { add: 'long long add(long long a, long long b) { return a + b; }\n', main: '#include <stdio.h>\nint main(void) { long long a, b; if (scanf("%lld %lld", &a, &b) != 2) return 1; printf("%lld\\n", add(a, b)); return 0; }\n', sig: ['long long add(long long a, long long b)', 'int main(void)'] },
  cpp: { add: 'long long add(long long a, long long b) { return a + b; }\n', main: '#include <iostream>\nint main() { long long a, b; std::cin >> a >> b; std::cout << add(a, b) << "\\n"; return 0; }\n', sig: ['long long add(long long a, long long b)', 'int main()'] },
  java: { add: 'public static long add(long a, long b) { return a + b; }\n', main: 'import java.util.*;\npublic static void main(String[] args) { Scanner s = new Scanner(System.in); long a = s.nextLong(), b = s.nextLong(); System.out.println(add(a, b)); }\n', sig: ['public static long add(long a, long b)', 'public static void main(String[] args)'] },
  ruby: { add: 'def add(a, b)\n  a + b\nend\n', main: 'def main\n  a, b = gets.split.map(&:to_i)\n  puts add(a, b)\nend\n', sig: ['def add(a, b)', 'def main'] },
  perl: { add: 'sub add { my ($x, $y) = @_; return $x + $y; }\n', main: 'sub main { my ($x, $y) = split " ", <STDIN>; print add($x, $y), "\\n"; }\n', sig: ['sub add', 'sub main'] },
  bash: { add: 'add() { echo $(( $1 + $2 )); }\n', main: 'main() { local a b; read -r a b; add "$a" "$b"; }\n', sig: ['add()', 'main()'] },
  csharp: { add: 'static long add(long a, long b) { return a + b; }\n', main: 'using System;\nstatic void Main() { var t = Console.ReadLine().Split(new[] { \' \' }, StringSplitOptions.RemoveEmptyEntries); Console.WriteLine(add(long.Parse(t[0]), long.Parse(t[1]))); }\n', sig: ['static long add(long a, long b)', 'static void Main()'] }
};

(async () => {
  await t('種子題庫：20 題以上、id 不重複、格式合法、每題有範例與 ≥3 筆 hidden、標籤涵蓋 ≥10 種、ref 不在給模型的提示裡', async () => {
    assert.ok(PROBLEMS.length >= 20, '題數 ' + PROBLEMS.length); assert.strictEqual(new Set(PROBLEMS.map((p) => p.id)).size, PROBLEMS.length);
    const tags = new Set(); for (const p of PROBLEMS) { const v = J.validateProblem(p); assert.ok(v.ok, p.id + ' ' + v.errors); assert.ok(p.hidden.length >= 3, p.id + ' hidden 太少'); assert.ok(p.ref && p.ref.python, p.id + ' 沒有參考解'); p.tags.forEach((x) => tags.add(x)); const spec = C.buildSpec(p); assert.ok(spec.indexOf('def main') < 0 && spec.length < 1200, p.id + ' 提示太長或洩漏參考解'); }
    assert.ok(tags.size >= 10, '標籤 ' + Array.from(tags).join());
  });

  if (!(await R.available('python')).ok) { console.log('skip - 沒有 python3，其餘整合測試略過'); return; }
  const rows = [];
  await t('20 題：回放參考解（單一函式）經 迴圈→組裝→真的判題器 全部 AC', async () => {
    for (const p of PROBLEMS) {
      const m = F.makeScriptedModel({ plan: { functions: [{ name: 'main', signature: 'def main()', purpose: '整個程式', calls: [] }] }, codes: { main: [p.ref.python] } });
      const r = await C.solve({ problem: p, lang: 'python', ask: m.ask, write: m.write, judge: judgeFor(p) });
      rows.push(p.id.padEnd(16) + r.verdict + '  ' + r.calls.write + ' 次寫  ' + (p.tags || []).join(','));
      assert.ok(r.ok, p.id + ' → ' + r.verdict + ' ' + r.gaps.join('|'));
    }
  });
  rows.forEach((r) => console.log('    ' + r));

  const AB = byId('a-plus-b');
  const only = process.argv.slice(2);
  for (const lang of Object.keys(TWO)) {
    if (only.length && !only.includes(lang)) continue;
    const av = await R.available(lang); if (!av.ok) { console.log('skip - ' + lang + '：' + av.reason); continue; }
    await t(lang + '：切成 add＋入口兩個函式，組裝後真的跑過 A+B（含 hidden）', async () => {
      const T = TWO[lang]; const entry = C.LANGS[lang].entry;
      const plan = { functions: [{ name: 'add', signature: T.sig[0], purpose: '兩數相加', calls: [] }, { name: entry, signature: T.sig[1], purpose: '讀輸入並輸出', calls: ['add'] }] };
      const m = F.makeScriptedModel({ plan, codes: { add: [T.add], [entry]: [T.main] } });
      const r = await C.solve({ problem: AB, lang, ask: m.ask, write: m.write, judge: judgeFor(AB) });
      assert.ok(r.ok, lang + ' → ' + r.verdict + ' ' + r.gaps.join('|') + '\n' + r.source); assert.deepStrictEqual(r.plan.map((x) => x.name), ['add', entry]);
    });
  }

  await t('真的判題器：第一版寫錯（a-b）→ 回饋帶失敗的範例輸入 → 選擇題挑 add → 重寫後 AC', async () => {
    const plan = { functions: [{ name: 'add', signature: 'def add(a, b)', purpose: '兩數相加', calls: [] }, { name: 'main', signature: 'def main()', purpose: '讀輸入並輸出', calls: ['add'] }] };
    const m = F.makeScriptedModel({ plan, fix: 'add', codes: { add: ['def add(a, b):\n    return a - b\n', TWO.python.add], main: [TWO.python.main] } });
    const r = await C.solve({ problem: AB, lang: 'python', ask: m.ask, write: m.write, judge: judgeFor(AB) });
    assert.ok(r.ok, r.verdict + r.gaps.join('|')); assert.strictEqual(r.rethinks, 1);
    const rw = m.log.find((e) => e.kind === 'write' && e.meta.kind === 'rewrite').messages.map((x) => x.content).join('\n');
    assert.ok(/範例測試 #1 判決 WA/.test(rw) && rw.indexOf('輸入：\n1 2') >= 0 && rw.indexOf('期望輸出：\n3') >= 0, rw);
  });
  await t('真的判題器：寫死範例答案（作弊）→ 範例過、hidden 沒過 → 回饋說「有隱藏測試沒過」且不洩漏內容；修成真解後 AC', async () => {
    const cheat = 'def main():\n    s = input().strip()\n    print({"1 2": 3, "-5 3": -2}.get(s, 0))\n';
    const m = F.makeScriptedModel({ plan: { functions: [{ name: 'main', signature: 'def main()', purpose: '整個程式', calls: [] }] }, codes: { main: [cheat, AB.ref.python] } });
    const r = await C.solve({ problem: AB, lang: 'python', ask: m.ask, write: m.write, judge: judgeFor(AB) });
    assert.ok(r.ok); assert.strictEqual(r.rethinks, 1); const rw = m.log.filter((e) => e.kind === 'write')[1].messages.map((x) => x.content).join('\n');
    assert.ok(rw.indexOf('隱藏測試') >= 0); for (const h of AB.hidden) { assert.ok(rw.indexOf(h.out.trim()) < 0 || h.out.trim().length < 3, '洩漏了 hidden 的期望：' + h.out); }
  });
  await t('真的判題器：C 編譯錯 → 回饋帶編譯器訊息；重寫後 AC', async () => {
    if (!(await R.available('c')).ok) return;
    const bad = '#include <stdio.h>\nint main(void) { long long a, b; scanf("%lld %lld", &a, &b) printf("%lld\\n", a + b); return 0; }\n';
    const m = F.makeScriptedModel({ plan: { functions: [{ name: 'main', signature: 'int main(void)', purpose: '整個程式', calls: [] }] }, codes: { main: [bad, TWO.c.main.replace('add(a, b)', 'a + b')] } });
    const r = await C.solve({ problem: AB, lang: 'c', ask: m.ask, write: m.write, judge: judgeFor(AB) });
    assert.ok(r.ok, r.verdict + r.gaps.join('|')); assert.ok(m.log.filter((e) => e.kind === 'write')[1].messages.map((x) => x.content).join('\n').indexOf('編譯失敗') >= 0);
  });
  // ---- 專案模式：UML 模型（Item、Cart）→ 逐類別寫 → 合成一個檔案 → 真的編譯檢查；有 driver 就真的跑出結果
  const CART = { name: 'Cart', classes: [{ name: 'Item', kind: 'class', attrs: [{ name: 'price', type: 'int' }], ops: [] }, { name: 'Cart', kind: 'class', attrs: [{ name: 'items', type: { base: 'List', args: [{ base: 'Item', args: [] }] } }], ops: [{ name: 'add', params: [{ name: 'item', type: 'Item' }], returns: 'void' }, { name: 'total', params: [], returns: 'int' }] }], relations: [{ from: 'Cart', to: 'Item', kind: 'compose' }], usecases: [], actors: [] };
  const CARTP = { id: 'cart', statement: '把兩個物品放進購物車，印出總價', tests: [{ in: '', out: '3\n' }] };
  const PR = {
    python: { Item: 'class Item:\n    def __init__(self, price):\n        self.price = price\n', Cart: 'class Cart:\n    def __init__(self):\n        self.items = []\n    def add(self, item):\n        self.items.append(item)\n    def total(self):\n        return sum(i.price for i in self.items)\n', driver: 'c = Cart()\nc.add(Item(1))\nc.add(Item(2))\nprint(c.total())\n' },
    nodejs: { Item: 'class Item { constructor(price) { this.price = price; } }\n', Cart: 'class Cart { constructor() { this.items = []; } add(item) { this.items.push(item); } total() { return this.items.reduce((s, i) => s + i.price, 0); } }\n', driver: 'const c = new Cart(); c.add(new Item(1)); c.add(new Item(2)); console.log(c.total());\n' },
    java: { Item: 'class Item { public int price; public Item(int p) { price = p; } }\n', Cart: 'import java.util.*;\nclass Cart { public List<Item> items = new ArrayList<>(); public void add(Item i) { items.add(i); } public int total() { int s = 0; for (Item i : items) s += i.price; return s; } }\n', driver: 'public class Main { public static void main(String[] a) { Cart c = new Cart(); c.add(new Item(1)); c.add(new Item(2)); System.out.println(c.total()); } }\n' },
    csharp: { Item: 'class Item { public int price; public Item(int p) { price = p; } }\n', Cart: 'using System.Collections.Generic;\nclass Cart { public List<Item> items = new List<Item>(); public void add(Item i) { items.Add(i); } public int total() { int s = 0; foreach (var i in items) s += i.price; return s; } }\n', driver: 'class Program { static void Main() { var c = new Cart(); c.add(new Item(1)); c.add(new Item(2)); System.Console.WriteLine(c.total()); } }\n' },
    cpp: { Item: '#include <iostream>\nclass Item { public: int price; Item(int p) : price(p) {} };\n', Cart: '#include <vector>\nclass Cart { public: std::vector<Item> items; void add(Item i) { items.push_back(i); } int total() { int s = 0; for (auto& i : items) s += i.price; return s; } };\n', driver: 'int main() { Cart c; c.add(Item(1)); c.add(Item(2)); std::cout << c.total() << "\\n"; return 0; }\n' },
    ruby: { Item: 'class Item\n  attr_reader :price\n  def initialize(price)\n    @price = price\n  end\nend\n', Cart: 'class Cart\n  def initialize\n    @items = []\n  end\n  def add(item)\n    @items << item\n  end\n  def total\n    @items.sum(&:price)\n  end\nend\n', driver: 'c = Cart.new\nc.add(Item.new(1))\nc.add(Item.new(2))\nputs c.total\n' },
    perl: { Item: 'use strict;\nuse warnings;\npackage Item;\nsub new { my ($c, $p) = @_; return bless { price => $p }, $c; }\nsub price { return $_[0]{price}; }\n1;\n', Cart: 'use strict;\nuse warnings;\npackage Cart;\nsub new { return bless { items => [] }, shift; }\nsub add { my ($s, $i) = @_; push @{$s->{items}}, $i; }\nsub total { my $s = shift; my $t = 0; $t += $_->price for @{$s->{items}}; return $t; }\n1;\n', driver: 'package main;\nmy $c = Cart->new;\n$c->add(Item->new(1));\n$c->add(Item->new(2));\nprint $c->total, "\\n";\n' }
  };
  for (const lang of Object.keys(PR)) {
    if (only.length && !only.includes(lang)) continue; const av = await R.available(lang); if (!av.ok) { console.log('skip - 專案模式 ' + lang + '：' + av.reason); continue; }
    await t('專案模式 ' + lang + '：Item＋Cart 合成一個檔案，真的編譯檢查 CHECKED；加 driver 真的跑出 3 → AC、verified:true', async () => {
      const codes = { Item: [PR[lang].Item], Cart: [PR[lang].Cart] };
      const r1 = await PRJ.solveProject({ model: CART, lang, ask: F.makeScriptedModel({ codes }).ask, write: F.makeScriptedModel({ codes }).write, judge: ({ lang: l, source }) => R.check({ lang: l, source }) });
      assert.ok(r1.ok, lang + ' check → ' + r1.verdict + ' ' + r1.gaps.join('|') + '\n' + r1.source); assert.strictEqual(r1.verdict, 'CHECKED'); assert.strictEqual(r1.verified, false);
      const r2 = await PRJ.solveProject({ model: CART, lang, write: F.makeScriptedModel({ codes }).write, judge: ({ lang: l, source }) => R.judge({ lang: l, source, problem: CARTP }), opts: { driver: PR[lang].driver } });
      assert.ok(r2.ok && r2.verified, lang + ' driver → ' + r2.verdict + ' ' + r2.gaps.join('|') + '\n' + r2.source); assert.deepStrictEqual(r2.order, ['Item', 'Cart']);
    });
  }
  if ((await R.available('java')).ok) await t('專案模式 java：Cart 有語法錯誤 → 真的 javac 報 CE → 重寫 Cart → CHECKED', async () => {
    const codes = { Item: [PR.java.Item], Cart: ['class Cart { public void add( { } public int total() { return 0; } }\n', PR.java.Cart] }; const m = F.makeScriptedModel({ names: ['Item', 'Cart'], fix: 'Cart', codes });
    const r = await PRJ.solveProject({ model: CART, lang: 'java', ask: m.ask, write: m.write, judge: ({ lang: l, source }) => R.check({ lang: l, source }) });
    assert.ok(r.ok, r.verdict + r.gaps.join('|')); assert.strictEqual(r.rethinks, 1); assert.ok(m.log.filter((e) => e.kind === 'write' && e.meta.kind === 'rewrite')[0].messages.map((x) => x.content).join('\n').indexOf('error') >= 0, '重寫提示帶了 javac 的錯誤訊息');
  });
  // ---- 語法修復接進迴圈（真的編譯器）：模型寫的函式缺 : 或 ;，程式自己修、不重寫，修補對應回函式
  await t('迴圈＋語法修復（python）：入口函式缺冒號 → 程式修 → AC；沒有重寫、模型沒有多叫；codes 裡是修好的', async () => {
    const FIX = require('./renderer/src/recipe/syntax_fix_core.js'); const plan = { functions: [{ name: 'add', signature: 'def add(a, b)', purpose: '相加', calls: [] }, { name: 'main', signature: 'def main()', purpose: '讀輸入並輸出', calls: ['add'] }] };
    const m = F.makeScriptedModel({ plan, codes: { add: [TWO.python.add], main: [TWO.python.main.replace('def main():', 'def main()')] } });
    const r = await C.solve({ problem: AB, lang: 'python', ask: m.ask, write: m.write, judge: judgeFor(AB), repair: ({ lang, source, ask }) => FIX.repairSyntax({ lang, source, ask, check: ({ lang: l, source: s2 }) => R.check({ lang: l, source: s2 }) }) });
    assert.ok(r.ok && r.verified, r.verdict + r.gaps.join('|')); assert.strictEqual(r.rethinks, 0); assert.strictEqual(r.calls.write, 2); assert.strictEqual(r.edits.length, 1); assert.ok(r.codes.main.indexOf('def main():') >= 0 && r.source.indexOf('def main():') >= 0);
  });
  await t('迴圈＋語法修復（C）：缺分號 → 程式修；修不了的語法（模型寫壞）才退回重寫', async () => {
    if (!(await R.available('c')).ok) return; const FIX = require('./renderer/src/recipe/syntax_fix_core.js'); const repair = ({ lang, source, ask }) => FIX.repairSyntax({ lang, source, ask, check: ({ lang: l, source: s2 }) => R.check({ lang: l, source: s2 }) });
    const m = F.makeScriptedModel({ plan: { functions: [{ name: 'main', signature: 'int main(void)', purpose: '整個程式', calls: [] }] }, codes: { main: [TWO.c.main.replace('add(a, b)', 'a + b').replace('return 0; }', 'return 0 }')] } });
    const r = await C.solve({ problem: AB, lang: 'c', ask: m.ask, write: m.write, judge: judgeFor(AB), repair }); assert.ok(r.ok && r.verified, r.verdict + r.gaps.join('|')); assert.strictEqual(r.rethinks, 0);
  });
  // ---- 從任意拿到的程式碼接續（edit 模式）：含語言偵測、真的編譯器與判題器
  await t('runCode edit 模式（真的 python）：拿到一份語法壞又行為錯的程式 → 程式修語法 → 判題不過 → 選擇題挑函式 → 模型只重寫那個函式 → AC', async () => {
    const A = require('./renderer/src/recipe/code_agent_core.js'); const src = 'def add(a, b)\n    return a - b\n\ndef main():\n    a, b = map(int, input().split())\n    print(add(a, b))\n\nmain()\n';
    const m = F.makeScriptedModel({ names: ['add', 'main'], fix: 'add', codes: { add: ['def add(a, b):\n    return a + b\n'] } });
    const r = await A.runCode({ source: src, problem: AB, check: ({ lang, source }) => R.check({ lang, source }), judge: ({ lang, source, problem }) => R.judge({ lang, source, problem }), backend: { ask: m.ask, write: m.write } });
    assert.ok(r.ok && r.verified && r.mode === 'edit' && r.lang === 'python', r.verdict + JSON.stringify(r.gaps)); assert.strictEqual(r.rethinks, 1); assert.deepStrictEqual(r.edits.map((e) => e.by), ['syntax', 'rewrite']);
  });
  console.log('\n' + n + ' passed');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
