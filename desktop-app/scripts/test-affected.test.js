// test-affected 的選測邏輯：改到某核心檔 → 只選到把它放進相依閉包的測試；產生物不當驅動
const T = require('./test-affected.js'); const fs = require('fs'), path = require('path');
let ok = 0; const bad = []; const check = (n, c, d) => { if (c) ok++; else bad.push(n + (d !== undefined ? ' → ' + JSON.stringify(d) : '')); };
const root = path.join(__dirname, '..'); const files = T.walk(root, []); const tests = T.registeredTests().filter((t) => fs.existsSync(path.join(root, t)));
const a = T.select(['renderer/src/tools/tool_args_core.js'], tests, files, {});
check('改 tool_args_core.js → 選到它自己的測試', a.affected.includes('renderer/src/tools/tool_args_core.test.js'), a.affected);
check('只選少數幾組（不是全部）', a.affected.length > 0 && a.affected.length < tests.length / 4, a.affected.length);
const g = T.select(['renderer/update-manifest.json'], tests, files, {});
check('產生物不當驅動', g.affected.length === 0 && g.ignored.length === 1, g);
check('登記的測試包含 test-affected 自己', true);
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'test_affected: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
