// node renderer/src/studio/studio_howto_deck.test.js —— 內建「如何使用離線訓練器」簡報：能被簡報核心驗證、每頁有圖與旁白、破音詞都換成行內讀法
const H = require('./studio_howto_deck.js'), Core = require('../deck/deck_core.js'), Pron = require('../tts/pronunciation.js');
let ok = 0, bad = 0; const check = (n, c, d) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, d === undefined ? '' : JSON.stringify(d).slice(0, 400)); } };
['simple', 'adv'].forEach((mode) => {
  const d = H.buildDeck(mode), v = Core.validate(d);
  check(mode + '：簡報驗證沒有錯誤', v.errors.length === 0, v.errors);
  const slides = d.chapters.reduce((a, c) => a.concat(c.slides), []);
  check(mode + '：至少 8 頁，每頁有旁白與 svg 圖', slides.length >= 8 && slides.every((s) => s.narration && s.visual && s.visual.kind === 'svg' && /^<svg/.test(s.visual.svg)));
  check(mode + '：圖是內嵌 SVG、沒有腳本也沒有外部網址', slides.every((s) => !/<script|on\w+\s*=|https?:\/\//i.test(s.visual.svg.replace('http://www.w3.org/2000/svg', ''))));
  const spoken = slides.map((s) => Pron.inline(s.narration).spoken).join('');
  H.PRON.forEach((p) => { if (slides.some((s) => /\{/.test(s.narration)) && spoken.indexOf(p[0]) >= 0 && !/^[A-Za-z.]+$/.test(p[0])) check(mode + '：破音詞「' + p[0] + '」有換成行內讀法', false, p); });
  check(mode + '：字幕寫對的字、念的是同音字', slides.some((s) => { const r = Pron.inline(s.narration); return r.changed && r.shown !== r.spoken; }));
  check(mode + '：YAML 文字就是 JSON，可以還原', JSON.stringify(JSON.parse(H.buildYaml(mode))) === JSON.stringify(d));
});
check('重新／更新／處理器 都有轉換', /\{重\|蟲\}新/.test(H.pr('重新')) && /\{更\|耕\}新/.test(H.pr('更新')) && /\{處\|楚\}理器/.test(H.pr('處理器')));
check('長詞優先：處理器不會被「處理」拆開', H.pr('處理器') === '{處|楚}理器');
const fs = require('fs'), path = require('path'); const FA = fs.readFileSync(path.join(__dirname, '../floating-assistant.js'), 'utf8'), EM = fs.readFileSync(path.join(__dirname, '../../../scripts/embed-code-ui.js'), 'utf8');
check('設定頁下方有三顆按鈕（開啟／簡單模式教學／進階模式教學）', /開啟離線訓練器/.test(FA) && /如何使用離線訓練器\(簡單模式\)/.test(FA) && /如何使用離線訓練器\(進階模式\)/.test(FA));
check('教學簡報走 deckview 視窗與簡報播放器', /deckview: \(r\) => this\._wgBuildDeckView\(r\)/.test(FA) && /_deckMount\(body, saved\.url\)/.test(FA));
check('教學簡報模組有嵌進 FaStudio', /'studio_howto_deck'/.test(EM));
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
