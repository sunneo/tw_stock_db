// node renderer/src/recipe/code_slash.test.js   /code 指令的路由（純函式，不問模型）
const S = require('./code_slash_core.js'); const assert = require('assert'); const fs = require('fs'); const path = require('path');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const F = '```';
t('沒有內容或 help → 用法', () => { for (const x of ['', '  ', 'help', '?']) { const r = S.classify(x); assert.strictEqual(r.sub, 'help'); assert(r.usage.indexOf('/code') >= 0); } });
t('沒貼程式 → write_code，task 是需求文字，語言從 ``` 標記或留給工具判斷', () => {
    const r = S.classify('寫一個函式，輸入整數印出總和'); assert.strictEqual(r.tool, 'write_code'); assert.strictEqual(r.ok, true); assert(/總和/.test(r.args.task)); assert.strictEqual(r.args.language, undefined);
    const r2 = S.classify('用 C++ 寫排序\n' + F + 'cpp\nint x;\n' + F); assert.strictEqual(r2.args.language, 'cpp'); });
t('直接打需求（沒有動詞子指令）預設 write_code', () => { const r = S.classify('給一個字串，判斷是不是回文'); assert.strictEqual(r.tool, 'write_code'); assert(/預設/.test(r.why)); });
t('測資區塊 in／out 成對才抽，抽到就放進 tests', () => {
    const r = S.classify('寫 加法\n' + F + 'in\n1 2\n' + F + '\n' + F + 'out\n3\n' + F); assert.deepStrictEqual(r.args.tests, [{ in: '1 2\n', out: '3\n' }]); });
t('修：貼程式 → fix_code，source 與 goal 分開', () => {
    const r = S.classify('修 這段會當掉\n' + F + 'python\nprint(1\n' + F); assert.strictEqual(r.tool, 'fix_code'); assert.strictEqual(r.args.source, 'print(1'); assert.strictEqual(r.args.language, 'python'); assert(/當掉/.test(r.args.goal)); });
t('沒有子指令但貼了程式 → 當作修；說優化 → optimize；說解釋 → explain', () => {
    assert.strictEqual(S.classify(F + 'python\nprint(1)\n' + F).tool, 'fix_code');
    assert.strictEqual(S.classify('這個太慢了\n' + F + 'python\nprint(1)\n' + F).tool, 'optimize_code');
    assert.strictEqual(S.classify('這在做什麼\n' + F + 'python\nprint(1)\n' + F).tool, 'explain_code'); });
t('優化缺測資 → ok=false，missing 說明，不編造', () => { const r = S.classify('優化\n' + F + 'python\nprint(1)\n' + F); assert.strictEqual(r.tool, 'optimize_code'); assert.strictEqual(r.ok, false); assert(r.missing.some((m) => /測資/.test(m))); assert(r.usage); });
t('合併：程式＋diff → merge_patch；少 diff 要說', () => {
    const r = S.classify('合併\n' + F + 'python\nx = 1\n' + F + '\n' + F + 'diff\n--- a\n+++ b\n@@ -1 +1 @@\n-x = 1\n+x = 2\n' + F); assert.strictEqual(r.tool, 'merge_patch'); assert.strictEqual(r.ok, true); assert(/\+x = 2/.test(r.args.diff)); assert.strictEqual(r.args.source, 'x = 1');
    const r2 = S.classify('合併\n' + F + 'python\nx = 1\n' + F); assert.strictEqual(r2.ok, false); assert(r2.missing.some((m) => /diff/.test(m)));
    const r3 = S.classify(F + 'python\nx = 1\n' + F + '\n' + F + 'diff\n@@ -1 +1 @@\n-x = 1\n+x = 2\n' + F); assert.strictEqual(r3.tool, 'merge_patch'); assert(/diff 區塊/.test(r3.why)); });
t('設計：子指令或提到 UML → uml_design，scenario 是文字', () => {
    assert.strictEqual(S.classify('設計 顧客可以加入購物車並結帳').tool, 'uml_design');
    assert.strictEqual(S.classify('幫我畫 UML：顧客可以加入購物車').tool, 'uml_design');
    assert.strictEqual(S.classify('寫一個演算法，用 UML 的想法').tool, 'write_code'); });
t('「寫」子指令不吃掉像「寫字板」這種詞（要接空白或標點）', () => { const r = S.classify('寫字板程式'); assert.strictEqual(r.tool, 'write_code'); assert(/預設/.test(r.why)); });
t('所有會用到的工具，真的註冊在 floating-assistant.js，而且都列在 coding 領域的 toolNames', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
    const dom = /coding: \{\s*enabled: true,[\s\S]*?toolNames: \[([^\]]*)\]/.exec(src)[1];
    for (const tn of S.TOOLS) { assert(new RegExp("registerOptional\\('" + tn + "'").test(src), tn + ' 沒註冊'); assert(dom.indexOf("'" + tn + "'") >= 0, tn + ' 不在 coding 領域'); } });
t('每個工具描述都講得出何時用（description 長度與關鍵詞），AI 才選得到', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
    const key = { write_code: /寫出程式/, fix_code: /修一份/, optimize_code: /更有效率/, merge_patch: /合併進使用者/, convert_code: /轉成 nodejs／java／c/, uml_design: /設計成 UML/, explain_code: /解釋原始碼/ };
    for (const tn of S.TOOLS) { const i = src.indexOf("registerOptional('" + tn + "',"); assert(i > 0); assert(key[tn].test(src.slice(i, i + 600)), tn + ' 描述缺關鍵詞'); } });
t('轉換：子指令或「貼程式＋轉成 X」→ convert_code，目標語言只認有輸出器的；其他語言缺什麼說什麼，不亂猜', () => {
    const r = S.classify('轉成 nodejs\n' + F + 'python\nprint(1)\n' + F); assert.strictEqual(r.tool, 'convert_code'); assert.strictEqual(r.ok, true); assert.strictEqual(r.args.target, 'nodejs'); assert.strictEqual(r.args.source, 'print(1)');
    const r2 = S.classify(F + 'python\nx = 1\n' + F + '\n請轉成 Java'); assert.strictEqual(r2.tool, 'convert_code'); assert.strictEqual(r2.args.target, 'java'); assert(/轉成別的語言/.test(r2.why));
    assert.strictEqual(S.classify('轉成 C\n' + F + 'python\nx = 1\n' + F).args.target, 'c');
    const r3 = S.classify('轉成 c++\n' + F + 'python\nx = 1\n' + F); assert.strictEqual(r3.ok, false); assert(r3.missing.some((m) => /c\+\+/.test(m) && /沒有輸出器/.test(m)));
    const r4 = S.classify('轉成 java\n' + F + 'js\nlet x = 1;\n' + F); assert.strictEqual(r4.ok, false); assert(r4.missing.some((m) => /只支援 Python/.test(m)));
    const r5 = S.classify('轉成 nodejs\n' + F + 'python\nprint(input())\n' + F + '\n' + F + 'in\nhi\n' + F + '\n' + F + 'out\nhi\n' + F); assert.deepStrictEqual(r5.args.tests, [{ in: 'hi\n', out: 'hi\n' }]);
    assert.strictEqual(S.classify('寫一個 c 語言的函式，輸入整數印出總和').tool, 'write_code'); });
t('離線訓練器規則 code_write：該中的中、不該中的不中（音樂、教學、網頁、已貼程式）', () => {
    const p = S.trainerPatterns()[0]; assert.strictEqual(p.tool, 'write_code'); const re = new RegExp(p.expr, 'i');
    for (const y of ['寫一個函式，輸入兩個整數印出總和', '幫我用python寫程式計算費氏數列', '請產生一個排序演算法', '幫我做一個計算質數的程式', 'write a function that sorts numbers，寫個函式']) assert(re.test(y), '應該中：' + y);
    for (const x of ['怎麼寫程式', '寫一首曲子', '幫我寫一個網頁程式', '寫一篇文章介紹程式', '修一下 ```python print(1```', '寫報告', '你好']) assert(!re.test(x), '不該中：' + x); });
console.log(n + ' passed, 0 failed');
