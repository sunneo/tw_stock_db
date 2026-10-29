'use strict';
// 專案索引的「定義抽取」（_faRepoExtract，正規表示式版）的純函式測試：node scripts/repo-extract.test.js
// 從 renderer/src/floating-assistant.js 的原始碼把函式本體切出來（它是 2MB 的單一檔案，沒辦法直接 require）。
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
function grab(re) { const m = re.exec(src); assert.ok(m, '找不到 ' + re); const eol = src.indexOf('\n', m.index), first = src.slice(m.index, eol); if (/\}\s*(\/\/.*)?$/.test(first)) return first; const e = src.indexOf('\n}\n', m.index); assert.ok(e > 0); return src.slice(m.index, e + 2); } // 一行的函式取那一行；多行的取到「第 0 欄的 }」
const lang = /^const FA_REPOMAP_LANG = .*$/m.exec(src)[0] + '\n' + /^const FA_CODE_STOP = .*$/m.exec(src)[0] + '\n' + /^const FA_LOC_LANGS = .*$/m.exec(src)[0] + '\n' + /^const FA_EXTRACT_SV = .*$/m.exec(src)[0];
const code = [lang, grab(/function _faRepoExt\(/), grab(/function _faRepoLang\(/), grab(/function _faRepoSvOf\(/), grab(/function _faRepoExtract\(/)].join('\n');
let pre = ''; for (const nm of ['_faRepoBasename', '_faRepoDocKind']) { const m = new RegExp('function ' + nm + '\\(').exec(src); if (m) pre += grab(new RegExp('function ' + nm + '\\(')) + '\n'; }
const ex = new Function(pre + code + '\nreturn _faRepoExtract;')();
let ok = 0; const bad = []; const t = (n, f) => { try { f(); ok++; } catch (e) { bad.push(n); console.log('FAIL', n, e.message.slice(0, 300)); } };
const syms = (text, p) => ex(p || 'a.cs', text, { tier: 0, unlimited: true }).symbols.map((s) => s.k + ':' + s.n);

t('C#：namespace、類別、方法、建構子、屬性、override、單行方法', () => {
  const r = syms(`namespace Demo.App
{
    /// <summary>Does things.</summary>
    partial class Form1
    {
        private void InitializeComponent() { this.SuspendLayout(); }
        protected override void Dispose(bool disposing) { base.Dispose(disposing); }
        public Form1() { InitializeComponent(); }
        public int Width { get; set; }
        public static float Lerp(float a, float b, float t) => a + (b - a) * t;
        public async Task<List<string>> LoadAsync(string path,
            int n)
        {
            return null;
        }
    }
}`);
  assert.deepStrictEqual(r, ['namespace:Demo.App', 'class:Form1', 'method:InitializeComponent', 'method:Dispose', 'constructor:Form1', 'property:Width', 'method:Lerp', 'method:LoadAsync']);
});
t('C#：參數的 object 不是定義；呼叫、控制敘述、欄位初始化不是方法', () => {
  const r = syms(`class A {
    private void OnKey(object sender, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape) this.Close();
        foreach (var x in items) { Foo(x); }
        var d = new Dictionary<string, int>();
        using (var s = new Stream()) { }
    }
    private Dictionary<string, int> map = new Dictionary<string, int>();
    public static readonly Foo X = Create(1);
}`);
  assert.deepStrictEqual(r, ['class:A', 'method:OnKey']);
});
t('C#：XML 文件註解拿掉標籤當說明', () => {
  const d = ex('a.cs', 'class A {\n    /// <summary>Draw the cube.</summary>\n    protected override void OnPaint(PaintEventArgs e) { }\n}', { tier: 0, unlimited: true }).symbols.find((s) => s.n === 'OnPaint');
  assert.ok(d && /Draw the cube/.test(d.d) && !/</.test(d.d), JSON.stringify(d));
});
t('抽取器版本：有行數統計的語言（含 C#、Java）共用目前的版本號，其他語言沒有（舊索引的檔案會被重新分析）', () => {
  const sv = ex('a.cs', 'class A {}', { tier: 0 }).sv; assert.ok(sv >= 5, String(sv));
  assert.strictEqual(ex('a.java', 'class A {}', { tier: 0 }).sv, sv); assert.strictEqual(ex('a.txt', 'hello', { tier: 0 }).sv, undefined);
});
t('Kotlin 的 object 關鍵字還是定義；Java 方法照舊', () => {
  assert.deepStrictEqual(syms('object Config {\n}\n', 'a.kt'), ['object:Config']);
  assert.deepStrictEqual(syms('public class A {\n    public static void main(String[] args) {\n    }\n}', 'A.java'), ['class:A', 'method:main']);
});
console.log(ok + ' passed, ' + bad.length + ' failed', bad); process.exit(bad.length ? 1 : 0);
