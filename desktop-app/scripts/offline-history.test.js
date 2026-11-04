// 離線模式送出的句子要進輸入框歷史（commandHistory 與 localStorage）
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('ok   ' + n); } else { fail++; console.log('FAIL ' + n); } };
const a = src.indexOf('    _recordCommandHistory(text) {'), b = src.indexOf('    async _offlineRespond(userText, opts) {');
const body = src.slice(a, b);
const store = {};
global.localStorage = { setItem: (k, v) => { store[k] = v; } };
const o = new Function('return ({' + body.replace(/\}\s*$/, '}') + '\n});')();
const fa = Object.assign({ commandHistory: ['舊的'], HISTORY_KEY: 'k', historyIndex: 3 }, o);
fa._recordCommandHistory('瀏覽器打開 https://tw.yahoo.com 並找美國選舉新聞');
ok(fa.commandHistory[0] === '瀏覽器打開 https://tw.yahoo.com 並找美國選舉新聞' && fa.commandHistory.length === 2, '送出後 commandHistory[0] 是該句');
ok(JSON.parse(store.k)[0] === fa.commandHistory[0], '同步寫進 localStorage');
ok(fa.historyIndex === -1, 'historyIndex 歸位');
fa._recordCommandHistory('舊的'); ok(fa.commandHistory.length === 2, '重複的不再加');
fa._recordCommandHistory(''); ok(fa.commandHistory.length === 2, '空字串不記');
for (let i = 0; i < 60; i++) fa._recordCommandHistory('句' + i);
ok(fa.commandHistory.length === 50 && fa.commandHistory[0] === '句59', '上限 50');
// 接線：記錄呼叫在所有提前 return 之前
const iOff = src.indexOf('if (this.advancedSettings.offlineMode) { await this._offlineRespond(textToSend); return; }');
const iRec = src.indexOf('this._recordCommandHistory(textToSend); // 翻譯');
const iTr = src.indexOf('const tr = !hasAttachments ? FaTranslate.intent(textToSend)');
ok(iRec > 0 && iRec < iTr && iTr < iOff, '記錄在翻譯意圖、離線 return 之前');
console.log(`\n${pass} 過，${fail} 失敗`); process.exit(fail ? 1 : 0);
