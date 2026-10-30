// /edit-video: the "TTS dub" dialog -- a typing box (prefilled from a transcript line, or typed), the LANGUAGE, the voice SOURCE (this browser's Kokoro / the server's CJK relay) and the VOICE. Only the DOM lives here;
// the voices come from the host (the page's own list, data-tts-voices: [{id, name, lang, gender, engine: 'local' | 'relay'}]); synthesizing is the host's job.
//   TwVideoTtsDialog.open({ container, T, text, lang, voiceId, voices, pickVoice(text, lang) -> voice | null }) -> Promise<{ text, lang, voiceId } | null>
//   TwVideoTtsDialog.langsOf(voices) -> ['zh-TW', ...]    TwVideoTtsDialog.filter(voices, lang, source) -> voices    TwVideoTtsDialog.guessLang(text) -> 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR'
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(null); } else { root.TwVideoTtsDialog = factory(root); } }(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  var SOURCES = ['auto', 'local', 'relay'];
  function langsOf(voices) { var seen = {}, out = []; (voices || []).forEach(function (v) { if (v && v.lang && !seen[v.lang]) { seen[v.lang] = 1; out.push(v.lang); } }); return out; }
  // language ('' = any) and source ('auto' = any) narrow the voice list; the order of the host's list is kept
  function filter(voices, lang, source) { return (voices || []).filter(function (v) { return v && (!lang || v.lang === lang) && (!source || source === 'auto' || v.engine === source); }); }
  // what the text looks like: kana -> Japanese, hangul -> Korean, Han -> Chinese (Traditional by default), else English
  function guessLang(text) {
    var t = String(text || ''); if (/[぀-ヿ]/.test(t)) { return 'ja-JP'; } if (/[가-힣]/.test(t)) { return 'ko-KR'; } if (/[一-鿿㐀-䶿]/.test(t)) { return 'zh-TW'; } return 'en-US';
  }
  var NAMES = { 'zh-TW': '中文(台灣)', 'zh-CN': '中文(普通话)', 'zh-HK': '中文(香港)', 'en-US': 'English (US)', 'en-GB': 'English (UK)', 'ja-JP': '日本語', 'ko-KR': '한국어' };
  function el(tag, cls, text) { var e = root.document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  function css() {
    if (root.document.getElementById('tw-ve-tts-css')) { return; }
    var s = root.document.createElement('style'); s.id = 'tw-ve-tts-css';
    s.textContent = '.tw-ve-tts{position:absolute;inset:0;z-index:6;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}.tw-ve-tts-box{background:var(--ai-win-bg,#fff);color:var(--ai-win-fg,inherit);border:1px solid #888;border-radius:8px;width:min(480px,92%);max-height:90%;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px}' +
      '.tw-ve-tts-box textarea{width:100%;min-height:90px;box-sizing:border-box;font:inherit;padding:4px}.tw-ve-tts-box label{display:flex;gap:6px;align-items:center;font-size:12px}.tw-ve-tts-box label span{min-width:64px}.tw-ve-tts-box select{flex:1;padding:2px}.tw-ve-tts-box .bt{display:flex;gap:8px;justify-content:flex-end}.tw-ve-tts-box button{border:1px solid #8250df;border-radius:6px;background:transparent;color:inherit;padding:3px 12px;cursor:pointer}.tw-ve-tts-box button.go{background:#8250df;color:#fff}.tw-ve-tts-box button:disabled{opacity:.4}.tw-ve-tts-err{color:#cf222e;font-size:12px}';
    root.document.head.appendChild(s);
  }
  function open(o) {
    css(); var T = o.T || function (a) { return a; }, voices = o.voices || [];
    return new Promise(function (resolve) {
      var ov = el('div', 'tw-ve-tts'), box = el('div', 'tw-ve-tts-box'), ta = el('textarea'), err = el('div', 'tw-ve-tts-err');
      ov.setAttribute('data-ve', 'tts-dialog'); ta.setAttribute('data-f', 'tts-text'); ta.value = String(o.text || ''); ta.placeholder = T('輸入要配音的文字…', 'Type the text to speak…'); err.setAttribute('data-f', 'tts-err');
      box.appendChild(el('strong', '', '🔊 ' + T('TTS 配音', 'TTS dub'))); box.appendChild(ta);
      function row(label, sel, tag) { var l = el('label'); l.appendChild(el('span', '', label)); sel.setAttribute('data-f', tag); l.appendChild(sel); box.appendChild(l); }
      var sl = el('select'), ss = el('select'), sv = el('select');
      langsOf(voices).forEach(function (c) { var op = el('option', '', NAMES[c] || c); op.value = c; sl.appendChild(op); });
      [['auto', T('自動(全部來源)', 'Any source')], ['local', T('瀏覽器本機 (Kokoro)', 'This browser (Kokoro)')], ['relay', T('伺服器 relay (Microsoft)', 'Server relay (Microsoft)')]].forEach(function (p) { var op = el('option', '', p[1]); op.value = p[0]; ss.appendChild(op); });
      row(T('語言', 'Language'), sl, 'tts-lang'); row(T('聲音來源', 'Voice source'), ss, 'tts-source'); row(T('聲音', 'Voice'), sv, 'tts-voice'); box.appendChild(err);
      function fillVoices(keep) {
        var list = filter(voices, sl.value, ss.value); sv.textContent = '';
        list.forEach(function (v) { var op = el('option', '', v.name + ' · ' + (v.engine === 'relay' ? T('伺服器', 'server') : T('本機', 'local')) + (v.gender ? ' · ' + v.gender : '')); op.value = v.id; sv.appendChild(op); });
        if (keep && list.some(function (v) { return v.id === keep; })) { sv.value = keep; }
        err.textContent = list.length ? '' : T('這個語言在這個來源沒有可用的聲音,換一個來源', 'No voice for this language from this source: pick another source'); go.disabled = !list.length;
      }
      var go = el('button', 'go', T('合成並加入', 'Synthesize and add')), cancel = el('button', '', T('取消', 'Cancel')), bt = el('div', 'bt'); go.type = cancel.type = 'button'; go.setAttribute('data-f', 'tts-go'); cancel.setAttribute('data-f', 'tts-cancel'); bt.appendChild(cancel); bt.appendChild(go); box.appendChild(bt);
      // start: the language asked for, else what the text looks like; the voice asked for (its language wins), else the host's default for that text / language
      var pre = o.voiceId ? voices.filter(function (v) { return v.id === o.voiceId; })[0] : null, lang = pre ? pre.lang : (o.lang && langsOf(voices).indexOf(o.lang) >= 0 ? o.lang : null);
      if (!lang) { var fam = String(o.lang || '').slice(0, 2).toLowerCase(), g = o.text ? guessLang(o.text) : (root.document.documentElement.lang || 'zh-TW'); lang = langsOf(voices).filter(function (c) { return fam ? c.slice(0, 2).toLowerCase() === fam : c === g; })[0] || langsOf(voices).filter(function (c) { return c.slice(0, 2) === String(g).slice(0, 2); })[0] || langsOf(voices)[0] || ''; }
      sl.value = lang; var def = pre || (o.pickVoice ? o.pickVoice(ta.value, lang) : null); if (def && def.lang === lang && def.engine) { ss.value = 'auto'; }
      fillVoices(def && def.id);
      sl.addEventListener('change', function () { fillVoices(); }); ss.addEventListener('change', function () { fillVoices(sv.value); });
      function done(r) { ov.remove(); resolve(r || null); }
      cancel.addEventListener('click', function () { done(null); }); ov.addEventListener('click', function (e) { if (e.target === ov) { done(null); } });
      go.addEventListener('click', function () { var t = ta.value.trim(); if (!t) { err.textContent = T('請輸入文字', 'Type some text'); return; } if (!sv.value) { return; } done({ text: t, lang: sl.value, voiceId: sv.value }); });
      ov.appendChild(box); (o.container || root.document.body).appendChild(ov); ta.focus();
    });
  }
  return { open: open, langsOf: langsOf, filter: filter, guessLang: guessLang, SOURCES: SOURCES };
}));
