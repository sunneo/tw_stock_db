// node scripts/deck-tests/deck_voice.test.js -- 簡報的字幕與配音：
//  · 字幕可以跟念的不一樣（slide.caption／deck.captions）：中文字幕、英文發音；
//  · 配音失敗／逾時的備援（中文→離線中文、英文→離線英文）、逾時從拿到語音引擎才算、說明（fa_note）、聲音清單。
const Core = require('../../renderer/src/deck/deck_core.js');
const Host = require('../../renderer/src/deck/deck_host.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const deck = (slide, deckExtra) => Core.parseDeck(yaml.dump({ deck: Object.assign({ title: 't', lang: 'en' }, deckExtra || {}), chapters: [{ title: 'c', slides: [Object.assign({ title: 's' }, slide)] }] }), yaml);

// ---------- 字幕（caption）----------
const d1 = deck({ narration: 'It is Halloween! Trick or treat!', caption: '今天是萬聖節！不給糖就搗蛋！' });
check('caption survives normalisation', d1.slides[0].caption === '今天是萬聖節！不給糖就搗蛋！', d1.slides[0].caption);
const t1 = Core.timingFor(d1.slides[0], 6, 0);
check('captions: same sentence count → one-to-one with the spoken sentences (same times)', t1.captions && t1.captions.length === t1.sentences.length && t1.captions[0].text === '今天是萬聖節！' && t1.captions[0].start === t1.sentences[0].start && t1.captions[1].end === t1.sentences[1].end, t1);
check('the spoken sentences are untouched (cues and camera still use them)', t1.sentences[0].text === 'It is Halloween!');
const d2 = deck({ narration: 'It is Halloween. Trick or treat. Kids get candy.', caption: '今天是萬聖節，不給糖就搗蛋，小朋友可以拿到糖果。' });
const t2 = Core.timingFor(d2.slides[0], 9, 0);
check('captions: different sentence count → spread over the same narration window', t2.captions.length === 1 && t2.captions[0].start <= t2.sentences[0].start + 0.01 && t2.captions[0].end >= t2.sentences[2].end - 0.01, t2.captions);
const d3 = deck({ narration: 'Hello there.' });
check('no caption → no captions array (old behaviour)', Core.timingFor(d3.slides[0], 3, 0).captions === null);
check('a silent slide with a caption stays silent', Core.timingFor(deck({ caption: 'x。', duration: 3 }).slides[0], 0, 0).silent === true);
// 字幕檔用字幕的文字、時間用念的
const dd = deck({ narration: 'It is Halloween! Trick or treat!', caption: '今天是萬聖節！不給糖就搗蛋！' });
const tl = Core.buildTimeline(dd, [Core.timingFor(dd.slides[0], 6, 0)]);
const srt = Core.buildSubtitleFile(dd, tl, [Core.timingFor(dd.slides[0], 6, 0)], 'srt');
check('the subtitle file (srt) carries the caption text', /今天是萬聖節！/.test(srt) && !/Halloween/.test(srt), srt);
// deck.captions 檢查
let bad1 = ''; try { deck({ narration: 'Hi there.' }, { captions: 'nope' }); } catch (e) { bad1 = String(e.message || e); }
check('deck.captions must be original or spoken', /captions/.test(bad1), bad1);
check('deck.captions: spoken is accepted', (() => { try { return deck({ narration: 'Hi there.' }, { captions: 'spoken' }).deck.captions === 'spoken'; } catch (e) { return false; } })());
let bad2 = ''; try { deck({ narration: 'Hi.', caption: 5 }); } catch (e) { bad2 = String(e.message || e); }
check('caption must be a string', /caption/.test(bad2), bad2);

// ---------- 配音備援 ----------
global.TTS_VOICES = [{ id: 'af_heart', name: 'Heart', gender: '女', engine: 'local' }, { id: 'af_alloy', name: 'Alloy', gender: '女', engine: 'local' }];
global.TTS_ZH_VOICES = [{ id: 'zf_xiaoxiao', name: '曉曉', gender: '女', engine: 'local-zh' }];
global.TTS_API_VOICES = [{ id: 'zh-TW-HsiaoChenNeural', name: '曉臻', gender: '女', engine: 'api' }];
const M = Host.methods; const logs = [];
function fake(overrides) {
    const f = Object.assign({ advancedSettings: { ttsDefaultVoice: 'af_heart', ttsApiEnabled: true }, calls: [], order: [], _log: (x) => logs.push(x),
        _looksLikeCjkText: (t) => /[㐀-鿿]/.test(t), _pickZhLocalVoice: () => global.TTS_ZH_VOICES[0],
        _deckFallbackVoice: M._deckFallbackVoice, _deckVoiceList: M._deckVoiceList,
        _deckTtsGate: async function (kind) { this.order.push('gate:' + kind); return () => this.order.push('release:' + kind); },
        _deckSynthesizeNow: async function (text, voice) { this.order.push('synth:' + (voice || '')); this.calls.push(voice || ''); return new ArrayBuffer(8); } }, overrides || {});
    return f;
}
(async () => {
    // 正常：不備援、沒有說明；而且是「拿到引擎之後」才合成
    const f1 = fake(); const b1 = await M._deckSynthesize.call(f1, '你好', 'zh-TW-HsiaoChenNeural', 1, 'zh-TW');
    check('ok: no fallback, no note', b1.fa_note === undefined && f1.calls.length === 1);
    check('the synthesis starts only after the engine slot is taken (queue wait is not part of the timeout)', f1.order.join() === 'gate:api,synth:zh-TW-HsiaoChenNeural,release:api', f1.order);
    // 線上中文失敗 → 離線中文
    const f2 = fake({ _deckSynthesizeNow: async function (t, v) { this.calls.push(v || ''); if (v === 'zh-TW-HsiaoChenNeural') throw new Error('HTTP 502'); return new ArrayBuffer(8); } });
    const b2 = await M._deckSynthesize.call(f2, '你好', 'zh-TW-HsiaoChenNeural', 1, 'zh-TW');
    check('online Chinese fails → offline Chinese voice used', f2.calls.join() === 'zh-TW-HsiaoChenNeural,zf_xiaoxiao', f2.calls);
    check('the fallback leaves a note (what failed, what was used, how to change it)', /HTTP 502/.test(b2.fa_note) && /離線中文語音「曉曉」/.test(b2.fa_note) && /🎙/.test(b2.fa_note), b2.fa_note);
    check('the fallback is logged', logs.some((x) => /改用離線中文語音/.test(x)));
    // 沒指定聲音的中文（自動走線上中文）失敗 → 離線中文
    const f3 = fake({ _deckSynthesizeNow: async function (t, v) { this.calls.push(v || ''); if (!v) throw new Error('語音合成失敗'); return new ArrayBuffer(8); } });
    await M._deckSynthesize.call(f3, '中文旁白', undefined, 1, 'zh-TW'); check('auto voice for Chinese text falls back to the offline Chinese voice', f3.calls.join() === ',zf_xiaoxiao', f3.calls);
    // 英文失敗 → 離線英文（預設聲音）
    const f4 = fake({ _deckSynthesizeNow: async function (t, v) { this.calls.push(v || ''); if (v === 'af_alloy') throw new Error('worker crashed'); return new ArrayBuffer(8); } });
    const b4 = await M._deckSynthesize.call(f4, 'Hello there', 'af_alloy', 1, 'en'); check('English failure falls back to the default offline English voice', f4.calls.join() === 'af_alloy,af_heart' && /離線英文語音「Heart」/.test(b4.fa_note), [f4.calls, b4.fa_note]);
    // 本來就是備援的那個聲音失敗：不重複試同一個
    const f5 = fake({ _deckSynthesizeNow: async function (t, v) { this.calls.push(v || ''); throw new Error('boom'); } });
    let e5 = ''; try { await M._deckSynthesize.call(f5, '你好', 'zf_xiaoxiao', 1, 'zh-TW'); } catch (e) { e5 = String(e.message); } check('no pointless retry with the same voice', f5.calls.length === 1 && /boom/.test(e5), [f5.calls, e5]);
    // 兩個都失敗：兩邊的原因都寫
    const f6 = fake({ _deckSynthesizeNow: async function (t, v) { throw new Error(v === 'zf_xiaoxiao' ? 'model missing' : 'HTTP 502'); } });
    let e6 = ''; try { await M._deckSynthesize.call(f6, '你好', 'zh-TW-HsiaoChenNeural', 1, 'zh-TW'); } catch (e) { e6 = String(e.message); }
    check('both fail: the error names both reasons', /HTTP 502/.test(e6) && /model missing/.test(e6) && /離線中文語音/.test(e6), e6);
    // 引擎插槽一定釋放（失敗也是）
    check('the engine slot is released after a failed attempt too', f6.order.filter((x) => /^release/.test(x)).length === 2 && f6.order.filter((x) => /^gate/.test(x)).length === 2, f6.order);
    // 備援聲音與聲音清單
    check('fallback voice: CJK → local Chinese, English → local English, same voice → none', M._deckFallbackVoice.call(fake(), '你好', 'x').id === 'zf_xiaoxiao' && M._deckFallbackVoice.call(fake(), 'hi', 'x').id === 'af_heart' && M._deckFallbackVoice.call(fake(), 'hi', 'af_heart') === null && M._deckFallbackVoice.call(fake(), '你好', 'zf_xiaoxiao') === null);
    const list = M._deckVoiceList.call(fake());
    check('voice list: offline English + offline Chinese + online Chinese (when enabled)', list.length === 4 && list.some((v) => /離線英文/.test(v.label)) && list.some((v) => /離線中文/.test(v.label)) && list.some((v) => /線上中文/.test(v.label)), list);
    check('voice list: online Chinese is hidden when the service is not enabled', M._deckVoiceList.call(fake({ advancedSettings: { ttsApiEnabled: false } })).length === 3);
    // 複製引擎的聲音（我的錄音樣本、官方內建示範聲音）：自己的排隊類別、中英文都能念所以不翻譯、聲音清單標得出來
    global.TTS_VOICES.push({ id: 'vs_abc', name: '我的聲音', lang: '我的錄音樣本（英文）', gender: '', engine: 'clone', clone: true, sample: true });
    global.TTS_ZH_VOICES.push({ id: 'moss_junhao', name: 'Junhao', lang: '複製引擎內建聲音（中文）', gender: '男', engine: 'clone', clone: true, sample: false });
    const cl = fake({ _ttsGateOf: (v) => (v === 'vs_abc' ? 'clone' : null), _ttsFindVoice: (id) => global.TTS_VOICES.concat(global.TTS_ZH_VOICES).find((x) => x.id === id) || null });
    await M._deckSynthesize.call(cl, 'Hello there', 'vs_abc', 1, 'en');
    check('clone voice: has its own gate class (one at a time, it is heavy)', cl.order.join() === 'gate:clone,synth:vs_abc,release:clone', cl.order);
    check('clone voice: other voices keep their own gate classes', await (async () => { const o = fake({ _ttsGateOf: () => null }); await M._deckSynthesize.call(o, 'Hi', 'af_heart', 1, 'en'); return o.order[0] === 'gate:local'; })());
    const pr = await M._deckPrepareSpeech.call(cl, '這是中文旁白 with English', 'vs_abc', 'en');
    check('clone voice: a Chinese narration is not translated to English or moved to a Chinese voice (it reads both languages)', pr.text === '這是中文旁白 with English' && pr.voice === 'vs_abc', pr);
    const lst = M._deckVoiceList.call(cl);
    check('voice list: recorded samples and built-in clone voices are labelled', lst.some((v) => v.id === 'vs_abc' && /我的錄音樣本/.test(v.label)) && lst.some((v) => v.id === 'moss_junhao' && /複製引擎內建/.test(v.label) && /男/.test(v.label)), lst.map((v) => v.label));
    check('no gate helper on the host (old hosts): falls back to the api/local classes', await (async () => { const o = fake({ _ttsGateOf: undefined }); await M._deckSynthesize.call(o, 'Hi', 'af_heart', 1, 'en'); return o.order[0] === 'gate:local'; })());
    console.log((bad.length ? 'FAIL' : 'PASS') + ' 簡報字幕與配音備援：' + ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})();
