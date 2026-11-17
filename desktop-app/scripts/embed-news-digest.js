// 把 renderer/src/recipe/web_news_core.js 與 news_digest_core.js 嵌進 renderer/src/floating-assistant.js 的 NEWSDIGEST 標記之間。
// 只改這一段（不動其他嵌入，也不跑 embed-code-ui.js 的全部重產），所以可以單獨執行、重複執行結果相同。
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
// 可選參數：<輸入> <輸出>（預設就地改 renderer/src/floating-assistant.js；提交時用來從 HEAD 版本產生只含自己改動的檔）
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'renderer/src/floating-assistant.js');
const outFile = process.argv[3] ? path.resolve(process.argv[3]) : file;
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
let src = fs.readFileSync(file, 'utf8');
const a = src.indexOf('/* NEWSDIGEST-BEGIN */'), b = src.indexOf('/* NEWSDIGEST-END */');
if (a < 0 || b < 0 || b < a) throw new Error('找不到 NEWSDIGEST 標記');
const web = read('renderer/src/recipe/web_news_core.js');
const news = read('renderer/src/recipe/news_digest_core.js');
const block = '/* NEWSDIGEST-BEGIN */\n' +
    'const FaWebNews = (function () {\nconst holder = {};\n(function (module, self) {\n' + web + '\n}).call(null, undefined, holder);\nreturn holder.FaWebNews;\n})();\n' +
    'const FaNewsDigest = (function () {\nconst holder = {};\nholder.FaWebNews = FaWebNews;\n(function (module, self) {\n' + news + '\n}).call(null, undefined, holder);\nreturn holder.FaNewsDigest;\n})();\n';
src = src.slice(0, a) + block + src.slice(b + '/* NEWSDIGEST-END */'.length).replace(/^/, '/* NEWSDIGEST-END */');
fs.writeFileSync(outFile, src);
console.log('已更新 FaWebNews、FaNewsDigest（' + web.length + ' + ' + news.length + ' 字元）');
