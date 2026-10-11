// node scripts/deck-tests/deck_language.test.js -- 一頁只用一種語言的語音：格式檢查（英文頁含中文、中文頁整段英文）、每頁 lang 的保留、
// 工具端對這兩種警告是「退回重寫」（STRICT_WARNING）、以及念之前的把關（翻成英文／翻不出來退回中文／中文一律用中文語音）。
const Core = require('../../renderer/src/deck/deck_core.js');
const Tools = require('../../renderer/src/deck/deck_tools.js');
const Host = require('../../renderer/src/deck/deck_host.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const deck = (narration, slide, deckLang) => Core.parseDeck(yaml.dump({ deck: { title: 't', lang: deckLang || 'zh-TW' }, chapters: [{ title: 'c', slides: [Object.assign({ title: 's', narration }, slide || {})] }] }), yaml);
const warns = (d) => (d.warnings || []).map((w) => (typeof w === 'string' ? w : (w.message || w.msg || JSON.stringify(w))));
const strict = (d) => warns(d).filter((w) => Tools.STRICT_WARNING.test(w));

// ---- 格式檢查
check('a Chinese slide with a few English terms is fine', strict(deck('這一頁介紹 Release Note Generator 的進度，目前完成度約八成。')).length === 0);
check('an English slide with only English is fine', strict(deck('This week we finished the remote group feature.', { lang: 'en' })).length === 0);
check('an English slide with Chinese is refused (strict)', strict(deck('This week 我們完成了 the remote group feature.', { lang: 'en' })).length === 1);
check('a whole English deck (deck.lang en) with Chinese is refused too', strict(deck('Here is the plan. 這是計畫。', {}, 'en')).length === 1);
check('a Chinese slide that is a long English passage is refused (strict)', strict(deck('This week we finished the remote group feature and the video player, and next week we start on the weekly report skill.')).length === 1);
check('...unless the slide says lang: en', strict(deck('This week we finished the remote group feature and the video player, and next week we start on the weekly report skill.', { lang: 'en' })).length === 0);
check('a short English phrase in a Chinese slide is fine', strict(deck('我們使用 Supabase 和 Cloudflare Worker 來傳遞訊息，速度很快而且穩定。')).length === 0);
check('a deck whose slide has no narration raises nothing', strict(deck('')).length === 0);
let badLang = ''; try { deck('hello there', { lang: 'xx yy' }); } catch (e) { badLang = String(e.message); } check('a bad lang code is an error', /lang/.test(badLang), badLang);
check('slide.lang and slide.voice survive normalisation', (() => { const d = deck('Hello.', { lang: 'en', voice: 'af_heart' }); return d.slides[0].lang === 'en' && d.slides[0].voice === 'af_heart'; })());
check('a normal deck has empty lang / voice', (() => { const d = deck('你好。'); return d.slides[0].lang === '' && d.slides[0].voice === ''; })());

// ---- 念之前的把關
global.TTS_VOICES = [{ id: 'af_heart', engine: 'local' }]; global.TTS_API_VOICES = [{ id: 'zh-TW-HsiaoChenNeural', engine: 'api' }, { id: 'zh-TW-YunJheNeural', engine: 'api' }];
function host(translate) { const logs = []; return Object.assign({ advancedSettings: { ttsDefaultApiVoice: 'zh-TW-YunJheNeural' }, _log: (m) => logs.push(m), logs, _callSimpleCompletion: async (u, o) => translate(u, o) }, Host.methods); }
(async () => {
    const h1 = host(async () => 'This week we finished the remote group feature.');
    let r = await h1._deckPrepareSpeech('This week 我們完成了遠端群組。', 'af_heart', 'zh-TW');
    check('English voice + Chinese text: the whole slide is translated and the English voice kept', r.text === 'This week we finished the remote group feature.' && r.voice === 'af_heart', r);
    r = await h1._deckPrepareSpeech('我們完成了遠端群組。', null, 'en');
    check('slide lang en (no voice) + Chinese text: translated', /^This week/.test(r.text) && r.voice === null, r);
    const h2 = host(async () => '我也不會翻'); // 翻譯結果還是中文 → 不能用
    r = await h2._deckPrepareSpeech('Release 的進度很好。', 'af_heart', 'en');
    check('cannot translate (result still Chinese): the whole slide falls back to the Chinese voice with the original text', r.text === 'Release 的進度很好。' && r.voice === 'zh-TW-YunJheNeural', r);
    const h3 = host(async () => { throw new Error('model down'); });
    r = await h3._deckPrepareSpeech('進度很好。', 'af_heart', 'en');
    check('translation throws: same fallback', r.voice === 'zh-TW-YunJheNeural' && r.text === '進度很好。', r);
    r = await h1._deckPrepareSpeech('Release Note Generator 的進度約八成，SupervyseIDE 也完成了。', null, 'zh-TW');
    check('Chinese text with many English words (CJK ratio < 20%) is forced onto the Chinese voice', r.voice === 'zh-TW-YunJheNeural' && /Release/.test(r.text), r);
    r = await h1._deckPrepareSpeech('進度很好。', 'zh-TW-HsiaoChenNeural', 'zh-TW');
    check('a Chinese voice the author chose is kept', r.voice === 'zh-TW-HsiaoChenNeural', r);
    r = await h1._deckPrepareSpeech('All English text here.', null, 'zh-TW');
    check('English-only text is left alone (the default picker chooses the English voice)', r.text === 'All English text here.' && r.voice === null, r);
    let calls = 0; const h4 = host(async () => { calls++; return 'Translated once.'; }); await h4._deckPrepareSpeech('中文', 'af_heart', 'en'); await h4._deckPrepareSpeech('中文', 'af_heart', 'en');
    check('translations are cached (one model call for the same text)', calls === 1, calls);
    console.log(ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : ''));
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
