// node renderer/src/terminal/settings_narrow.test.js
// 設定頁的窄螢幕樣式（floating-assistant.js 的 _ensureAdvancedStyles 裡的 CSS 字串）：手機（≤600px）要有單欄規則，
// 外框不再有 480px 的最小寬度（那會超出 360–412px 的螢幕，分類點不到）。只檢查 CSS 文字（真的版面要在瀏覽器裡量，見 DESIGN）。
const fs = require('fs'); const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 200))); } };
const a = SRC.indexOf('        style.textContent = `\n            .ai-advanced-overlay');
const b = SRC.indexOf('`;', a);
const css = SRC.slice(a, b);
const m = css.indexOf('@media (max-width: 600px)');
check('1 有 600px 以下的媒體查詢', m > 0);
const media = m > 0 ? css.slice(m) : '';
check('2 窄螢幕：外框寬度 100vw、沒有 480px 最小寬度', /\.ai-advanced-dialog \{[^}]*min-width: 0;[^}]*width: 100vw;/.test(media), media.slice(0, 200));
check('3 窄螢幕：內容區單欄（body 改成直向）', /\.ai-advanced-body \{ flex-direction: column;/.test(media));
check('4 窄螢幕：分類列有高度上限且可捲動', /\.ai-advanced-sidebar \{[^}]*max-height: 34vh;/.test(media));
check('5 桌面的 min-width 480 仍在媒體查詢外面（桌面不變）', css.slice(0, m).includes('min-width: 480px;'));
console.log('settings_narrow.test.js: ' + ok + ' passed, ' + bad + ' failed');
if (bad) process.exit(1);
