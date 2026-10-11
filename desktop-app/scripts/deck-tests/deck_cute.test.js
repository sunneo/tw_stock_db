// node scripts/deck-tests/deck_cute.test.js -- 內建可愛插圖：每項都有名稱、注音、能畫出來的 svg；注音的第一個符號要對得上（教注音的簡報靠它不出錯）。
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../../renderer/src/deck/deck_tools.js', 'utf8');
const a = src.indexOf('const CUTE = (function'), b = src.indexOf('// ---------------------------------------------------------------- 掛到');
const CUTE = eval('(() => {' + src.slice(a, b) + '; return CUTE; })()');
let ok = 0; const bad = [];
function check(n, c, x) { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 200) : '')); }
const cat = CUTE.catalog();
check('at least 18 pictures', cat.length >= 18, cat.length);
const FIRST = { 蘋果: 'ㄆ', 香蕉: 'ㄒ', 草莓: 'ㄘ', 西瓜: 'ㄒ', 橘子: 'ㄐ', 貓咪: 'ㄇ', 小狗: 'ㄒ', 小魚: 'ㄒ', 兔子: 'ㄊ', 小鴨: 'ㄒ', 太陽: 'ㄊ', 月亮: 'ㄩ', 星星: 'ㄒ', 花: 'ㄏ', 房子: 'ㄈ', 汽車: 'ㄑ', 球: 'ㄑ', 杯子: 'ㄅ', 書: 'ㄕ', 雞蛋: 'ㄐ' };
cat.forEach((c) => { check(c.name + ': first sound is right', FIRST[c.name] === c.first_sound, [c.name, c.zhuyin]); const f = CUTE.find(c.name); check(c.name + ': svg is a closed svg with a face or shapes', /^<svg [^>]*viewBox="0 0 200 200"/.test(f.svg) && /<\/svg>$/.test(f.svg) && (f.svg.match(/<(circle|ellipse|path|rect|polygon)/g) || []).length >= 4, f.svg.length); });
check('find by part of a name ("蘋")', CUTE.find('蘋') && CUTE.find('蘋').name === '蘋果');
check('unknown name gives null', CUTE.find('恐龍') === null);
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'deck_cute: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
