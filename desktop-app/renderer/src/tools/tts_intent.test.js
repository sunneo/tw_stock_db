// node renderer/src/tools/tts_intent.test.js
const I = require('./tts_intent.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };
const p = (s) => I.parse(s);

// ---- 要認得的命令 ----
const yes = [
    ['用英文語音說Goodnight sleepy head', 'Goodnight sleepy head', 'en'],
    ['用英文語音說 Goodnight sleepy head', 'Goodnight sleepy head', 'en'],
    ['請用語音念：今天天氣很好', '今天天氣很好', null],
    ['請用中文語音說：今天天氣很好', '今天天氣很好', 'zh'],
    ['幫我把這句念出來：Hello world', 'Hello world', null],
    ['把「晚安，好夢」念出來', '晚安，好夢', null],
    ['把"Good night"唸出來', 'Good night', null],
    ['tts: hello there', 'hello there', null],
    ['TTS hello there', 'hello there', null],
    ['朗讀 Good morning everyone', 'Good morning everyone', null],
    ['朗讀：早安', '早安', null],
    ['念出來：I love you', 'I love you', null],
    ['用粵語語音說 早唞', '早唞', 'yue'],
    ['用日文語音說 おやすみなさい', 'おやすみなさい', 'ja'],
    ['read aloud: See you tomorrow', 'See you tomorrow', null],
    ['please say out loud hello', 'hello', null],
    ['麻煩用英語聲音說 thank you', 'thank you', 'en'],
    ['語音念 晚安', '晚安', null],
];
for (const [msg, text, lang] of yes) { const r = p(msg); check('認得：' + msg, r && r.text === text && r.lang === lang, r); }
check('念的字原樣保留（大小寫、連在一起的字都不改）', p('用英文語音說Goodnight sleepy head').text === 'Goodnight sleepy head');

// ---- 不能誤判的 ----
const no = [
    '怎麼用語音合成？', '你有語音功能嗎', '語音合成要怎麼設定', '可以用語音念給我聽嗎', '為什麼語音念不出來', '語音合成失敗了', '支援哪些語音',
    '說明一下這個函式', '說說看你的想法', '講個笑話', '讀一下這個檔案', '念書的時候要注意什麼', '我想學英文語音', '語音', '語音合成', 'tts', 'TTS 怎麼用？',
    '請幫我把這份文件整理成表格', '把這個PDF轉成圖片', '幫我把程式碼念一遍給同事聽嗎？', '/media-text-to-speech hi', '', '   ',
    '朗讀' , '用英文語音說', 'a'.repeat(500),
];
for (const msg of no) check('不誤判：' + String(msg).slice(0, 30), p(msg) === null, p(msg));
check('提問裡有引號的指令（使用者明確框出要念的字）仍可認得', (() => { const r = p('把「你好嗎」念出來'); return r && r.text === '你好嗎'; })());
check('「把這句念出來」本身沒有內容就不是命令', p('把這句念出來') === null && p('把這個唸出來') === null);

// ---- unquote ----
check('去掉成對的引號', I.unquote('「晚安」') === '晚安' && I.unquote('"hi"') === 'hi' && I.unquote('“hi”') === 'hi' && I.unquote(' hi ') === 'hi' && I.unquote('「晚安') === '「晚安');

console.log('tts_intent: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' failed ' + JSON.stringify(bad) : ''));
if (bad.length) process.exit(1);
