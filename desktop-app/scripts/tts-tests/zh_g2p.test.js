// node scripts/tts-tests/zh_g2p.test.js -- 本地中文語音的「文字 → 音素」：
//  1. 全部 1379 個拼音音節的轉換結果，跟 misaki（Kokoro 官方的中文 G2P，Python）逐字相同（misaki_syllables.json 是用 misaki 的 ZHG2P.py2ipa 對所有常用字的拼音產生的）
//  2. 數字、標點、英文字母、分段（每段不超過模型的上限）
const fs = require('fs');
const path = require('path');
const Z = require('../../renderer/src/tts/zh_g2p.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'misaki_syllables.json'), 'utf8')); let same = 0; const diffs = [];
for (const [py, ipa] of Object.entries(ref)) { const want = ipa.replace(/̯/g, ''); if (Z.syllableToIpa(py) === want) same++; else diffs.push([py, want, Z.syllableToIpa(py)]); }
check('all ' + Object.keys(ref).length + ' syllables equal misaki', same === Object.keys(ref).length, diffs.slice(0, 5));
check('a few spot checks (ni3 hao3)', Z.syllableToIpa('ni3') === 'ni↓' && Z.syllableToIpa('hao3') === 'xau↓' && Z.syllableToIpa('de0') === 'tɤ' && Z.syllableToIpa('zhi1') === Z.syllableToIpa('zhi1') && /^ꭧɨ→$/.test(Z.syllableToIpa('zhi1')));
check('lü / nv both read as ü', Z.syllableToIpa('lv4') === Z.syllableToIpa('lü4') && Z.syllableToIpa('lü4') === 'ly↘');
check('an unknown syllable is skipped, not thrown', Z.syllableToIpa('xyz9') === '' && Z.syllableToIpa('') === '');

// 數字
check('numbers: 2024年 is read digit by digit', Z.normalizeNumbers('2024年') === '二零二四年');
check('numbers: 12 / 105 / 20000 / 3.14 / 50%', Z.normalizeNumbers('12') === '十二' && Z.normalizeNumbers('105') === '一百零五' && Z.normalizeNumbers('20000') === '二万' && Z.normalizeNumbers('3.14') === '三点一四' && Z.normalizeNumbers('50%') === '百分之五十', [Z.normalizeNumbers('12'), Z.normalizeNumbers('105'), Z.normalizeNumbers('20000'), Z.normalizeNumbers('3.14'), Z.normalizeNumbers('50%')]);
check('numbers: a long digit string (phone number) is read digit by digit', Z.normalizeNumbers('0912345678') === '零九一二三四五六七八');
// 標點
check('punctuation is mapped to the half-width marks the model knows', Z.mapPunctuation('你好，世界。真的嗎？') === '你好, 世界. 真的嗎?');
// 英文字母
check('latin letters are spelled (not dropped)', Z.latinToIpa('AB').split(' ').length === 2 && Z.latinToIpa('AB').length > 4);
// 整句（注入假的拼音器）
const fake = { pinyin: (s) => Array.from(s).map((c) => ({ '你': 'ni3', '好': 'hao3', '嗎': 'ma0' }[c] || 'a1')), segment: (s) => [s] };
check('a sentence: tone arrows and punctuation come out', Z.textToPhonemes('你好，嗎？', fake) === 'ni↓xau↓, ma?', Z.textToPhonemes('你好，嗎？', fake));
const long = '你好。'.repeat(300); const chunks = Z.textToChunks(long, fake, 100);
check('long text is cut into chunks under the limit', chunks.length > 1 && chunks.every((c) => c.length <= 100), chunks.map((c) => c.length));
check('empty / unreadable text gives no chunks', Z.textToChunks('   ', fake).length === 0 && Z.textToChunks('★☆', fake).length === 0);
check('the 8 Mandarin voices of Kokoro v1.0 are listed', Z.VOICES.length === 8 && Z.VOICES.some((v) => v.id === 'zf_xiaoxiao') && Z.VOICES.some((v) => v.id === 'zm_yunxi'));
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'zh_g2p: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
