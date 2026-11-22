// 把 jsnes 的 ES 模組（src/，相對匯入）打成單一 UMD 檔 jsnes.umd.cjs，給桌面版的一般 <script>（嵌入式）用。
// 每個模組包在自己的函式裡，所以不同檔案的同名頂層變數不會互相衝突；匯入以第一次用到時才執行（有循環匯入也能跑）。
// 用法：node renderer/vendor/jsnes/build-umd.cjs   （產物：renderer/vendor/jsnes/jsnes.umd.cjs，全域名 FaJsnes，node 也可 require）
'use strict';
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'jsnes.umd.cjs');

function walk(dir, base, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name), rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(full, rel, acc);
    else if (e.name.endsWith('.js')) acc.push(rel);
  }
  return acc;
}
function resolveKey(fromKey, spec) {
  const parts = (fromKey.split('/').slice(0, -1)).concat(spec.split('/'));
  const out = [];
  for (const p of parts) { if (p === '.' || p === '') continue; if (p === '..') out.pop(); else out.push(p); }
  return out.join('/');
}

function transform(key, text) {
  const exportsNames = [];
  let defaultExpr = null;
  let body = text.replace(/\r\n/g, '\n');
  // 匯入
  body = body.replace(/^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?[ \t]*$/gm, (m, what, spec) => {
    const target = JSON.stringify(resolveKey(key, spec));
    what = what.trim();
    const brace = /^(\w+)?\s*,?\s*\{([\s\S]*)\}$/.exec(what);
    if (brace) {
      const def = brace[1] ? `const ${brace[1]} = __req(${target}).default;\n` : '';
      const named = brace[2].split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/\s+as\s+/, ': ')).join(', ');
      return `${def}const { ${named} } = __req(${target});`;
    }
    return `const ${what} = __req(${target}).default;`;
  });
  // 匯出
  body = body.replace(/^export\s*\{([^}]*)\};?[ \t]*$/gm, (m, list) => {
    list.split(',').map(s => s.trim()).filter(Boolean).forEach(s => exportsNames.push(s));
    return '';
  });
  body = body.replace(/^export\s+default\s+(class|function)\s+(\w+)/gm, (m, kw, name) => {
    defaultExpr = name;
    return `${kw} ${name}`;
  });
  body = body.replace(/^export\s+default\s+/gm, () => '__exp.default = ');
  body = body.replace(/^export\s+(const|let|var|function|class)\s+(\w+)/gm, (m, kw, name) => {
    exportsNames.push(name);
    return `${kw} ${name}`;
  });
  const tail = [];
  if (defaultExpr) tail.push(`__exp.default = ${defaultExpr};`);
  exportsNames.forEach(n => tail.push(`__exp.${n} = ${n};`));
  return `function __m_${key.replace(/\W/g, '_')}() {\nconst __exp = {};\n${body}\n${tail.join('\n')}\nreturn __exp;\n}`;
}

const keys = walk(SRC, '', []).sort();
const defs = keys.map(k => `__defs[${JSON.stringify(k)}] = __m_${k.replace(/\W/g, '_')};`);
const mods = keys.map(k => transform(k, fs.readFileSync(path.join(SRC, k), 'utf8')));
const umd = `/* jsnes（Apache-2.0，bfirsh/jsnes 1ead3beb）單檔 UMD 版：由 build-umd.cjs 從 src/ 產生，請勿手改。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaJsnes = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const __defs = {}, __cache = {};
  function __req(k) { if (!(k in __cache)) { if (!(k in __defs)) throw new Error('jsnes：找不到模組 ' + k); __cache[k] = __defs[k](); } return __cache[k]; }
${mods.join('\n')}
${defs.join('\n')}
  const __index = __req(${JSON.stringify('index.js')});
  // 擴充用：把 mapper 表與基底類別掛在 NES 上（只在 bundle 裡掛，不改上游 src）
  __index.NES.mappers = __req('mappers/index.js').default;
  __index.NES.Mapper0 = __req('mappers/mapper0.js').default;
  return { NES: __index.NES, Controller: __index.Controller, GameGenie: __index.GameGenie, Browser: __index.Browser };
}));
`;
fs.writeFileSync(OUT, umd, 'utf8');
console.log('已寫出 ' + path.relative(process.cwd(), OUT) + '（' + keys.length + ' 個模組，' + umd.length + ' 字元）');
