// node scripts/deck-tests/deck_topic.test.js -- 主題簡報食譜：解析需求、規劃、樣板、旁白驗收、組簡報、修復
const T = require('../../renderer/src/deck/deck_topic.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 500) : '')); }
const TASK = '/media-presentation 用幼兒教育的方式，介紹飛機怎麼飛，要圖文並茂，介紹像是從機場出發，以飛到日本北海道，飛到中國為例子，可以上網找照片，飛上去後會有什麼要注意，飛機會在雲層什麼地方，像是平流層。飛機上有什麼服務，有什麼可以吃，例如華航，下飛機後要注意什麼，像是行李要去哪裡拿。繁體中文，語速1.0。';

const req = T.parseRequest(TASK);
check('request: kids, photos, language, speed are read; the command word is gone', req.kids && req.wantPhotos && req.lang === 'zh-TW' && req.speed === 1 && !/^\/media/.test(req.body), req);
check('request: english and a named voice', (() => { const r = T.parseRequest('做一份簡報，英文，聲音 af_heart，語速 1.5'); return r.lang === 'en' && r.voice === 'af_heart' && r.speed === 1.5; })());
check('request: attachments markers are removed', !/附件/.test(T.parseRequest('[附件：a.png（file_id=1）] 做簡報').body));

// ---- 模型規劃
check('outline prompt: closed format, asks for one page per named thing', /頁標題｜/.test(T.outlinePrompt(req)) && /點名的每一件事都要有一頁/.test(T.outlinePrompt(req)));
const good = '飛機怎麼飛｜一起來認識飛機｜airplane flying\n機場出發｜在機場報到和登機｜airport terminal\n飛到北海道｜看看日本北海道｜Hokkaido Japan\n飛到中國｜看看中國的城市｜China skyline\n雲層和平流層｜飛機飛在雲的上面｜clouds stratosphere\n機上服務｜空服員會幫忙｜flight attendant\n機上餐點｜華航有好吃的｜China Airlines meal\n拿行李｜降落後去領行李｜baggage claim\n總結｜再說一次今天學到的｜none';
const o1 = T.parseOutline(good);
check('outline: a good answer gives pages with title, point and keywords; none means no photo', o1 && o1.length === 9 && o1[0].kw === 'airplane flying' && o1[8].kw === '', o1);
check('outline: numbering and bullets are tolerated; non-ascii keywords are cleaned', (() => { const o = T.parseOutline(good.split('\n').map((l, i) => (i + 1) + '. ' + l).join('\n').replace('airplane flying', '飛機 airplane')); return o && o[0].title === '飛機怎麼飛' && !/[^\x00-\x7f]/.test(o[0].kw); })());
check('outline: too few lines or junk is refused', T.parseOutline('好的，我來做') === null && T.parseOutline('a｜b\nc｜d') === null);

// ---- 樣板（沒有模型）
const tpl = T.templateOutline(req);
check('template: the request clauses become pages: cover first, summary last', tpl.length >= 7 && tpl.length <= 14 && /飛機/.test(tpl[0].title) && tpl[tpl.length - 1].title === '總結', tpl.map((x) => x.title));
check('template: every thing the user named gets a page (airport, Hokkaido, China, clouds, stratosphere, service, food, baggage)', ['機場', '北海道', '中國', '雲層', '平流層', '服務', '華航', '行李'].every((w) => tpl.some((p) => p.point.indexOf(w) >= 0 || p.title.indexOf(w) >= 0)), tpl.map((x) => x.title + '|' + x.point));
check('template: the table gives photo keywords for the travel words; meta words never become a page', tpl.some((p) => /Hokkaido/.test(p.kw)) && tpl.some((p) => /baggage/.test(p.kw)) && tpl.some((p) => /airport/.test(p.kw)) && !tpl.some((p) => /繁體中文|語速/.test(p.title + p.point)), tpl.map((x) => x.kw));
check('template: an extra keyword function fills the gaps', T.templateOutline(T.parseRequest('介紹貓咪怎麼玩，狗狗怎麼散步'), (t) => (/貓/.test(t) ? 'cat playing' : '')).some((p) => p.kw === 'cat playing'));

// ---- 旁白
check('narration: a good short narration passes; chatter prefix is removed; too short/too long/english-heavy/too many sentences are refused', T.acceptNarration('飛機在天上飛。它靠翅膀的力量。', { title: 'x' }, req) !== null && T.acceptNarration('好的，飛機在天上飛喔。', { title: 'x' }, req) === '飛機在天上飛喔。' && T.acceptNarration('嗯', {}, req) === null && T.acceptNarration('a'.repeat(300), {}, req) === null && T.acceptNarration('The plane flies high in the sky above', {}, req) === null && T.acceptNarration('一。二。三。四。五。六。七。八。', {}, req) === null);
check('narration prompt: kids get the kids wording', /幼兒/.test(T.narrationPrompt({ title: 't', point: 'p' }, req)) && !/幼兒/.test(T.narrationPrompt({ title: 't', point: 'p' }, T.parseRequest('介紹股票'))));

// ---- 組簡報
const photos = tpl.map((p, i) => (i % 2 === 0 ? { ref: '@img' + (i + 1), credit: 'Someone', license: 'CC BY-SA 4.0', source: 'Wikimedia Commons' } : null));
const doc = T.buildDeck(req, tpl, null, photos);
check('deck: deck mapping has title, lang and speed; chapters hold the slides; the first slide is a title slide', doc.deck.title && doc.deck.lang === 'zh-TW' && doc.deck.speed === 1 && doc.chapters.length >= 2 && doc.chapters[0].slides[0].layout === 'title', doc.deck);
check('deck: a slide with a photo has a visual mapping with kind (collage for kids) and the credit in the notes; a slide without has no visual', (() => { const s = doc.chapters[0].slides[2]; const none = doc.chapters[0].slides[1]; return s.visual && s.visual.kind === 'collage' && s.visual.items[0].src === '@img3' && /Wikimedia Commons/.test(s.notes) && !none.visual; })(), doc.chapters[0].slides.map((s) => s.visual && s.visual.kind));
check('deck: non-kids requests use the image kind', (() => { const r = T.parseRequest('介紹股票'); const d = T.buildDeck(r, [{ title: 'a1', point: 'bb' }, { title: 'b2', point: 'cc' }], null, [null, { ref: '@img1' }]); return d.chapters[0].slides[1].visual.kind === 'image'; })());
check('deck: bullets are short fragments (max 3, each short); every slide has narration', doc.chapters.every((c) => c.slides.every((s) => s.narration && (!s.bullets || (s.bullets.length <= 3 && s.bullets.every((b) => b.length <= 18))))));

// ---- 修復
const bad1 = T.buildDeck(req, tpl, null, photos); const err = '- chapters[0].slides[2].visual.kind: must be one of shapes, anim2d\n- chapters[0].slides[1].bullets[0]: too long\n- chapters[9].slides[9].visual: must be a mapping';
const rp = T.repair(bad1, err);
check('repair: only the slide named by the error loses its visual; unknown paths are ignored; nothing else changes', !rp.doc.chapters[0].slides[2].visual && rp.doc.chapters[0].slides[0].layout === 'title' && rp.changes.length === 2 && rp.doc.chapters[1].slides[0] && T.dropAllVisuals(T.buildDeck(req, tpl, null, photos)) === photos.filter(Boolean).length, rp.changes);

// ---- 圖示模式
const ireq = T.parseRequest('用幼兒教育的方式，介紹飛機怎麼飛，圖示就好，字可以少一點，加上動畫。繁體中文，語速1.0。');
check('icons: asked by wording (圖示、字少、動畫); a request that wants photos is not icon mode by itself', ireq.icons && !ireq.wantPhotos && !T.parseRequest('介紹股票，要上網找照片').icons && T.parseRequest('介紹股票，要上網找照片').wantPhotos);
check('icons: a page gets up to 4 icons in the order they appear in its text; labels are short names', (() => { const ic = T.iconsFor('在機場 先拿出護照，行李交給櫃台，換登機證'); return ic.length === 3 && ic[0].emoji === '🏢' || ic.map((x) => x.emoji).join('') === '🏢🛂🧳🎫'.replace(/(.)(?=.)/gu, '$1'); })(), T.iconsFor('在機場 先拿出護照，行李交給櫃台，換登機證'));
check('icons: the lookup function fills pages the table does not know; unknown with no lookup gives none', T.iconsFor('貓咪玩毛線', (t) => ({ emoji: '🐱', zh: '貓' }))[0].emoji === '🐱' && T.iconsFor('貓咪玩毛線').length === 0);
const refs = {}; ['✈️', '🏢', '🛂', '🧳', '🎫', '🗾', '☁️', '☀️', '🍱', '🍎', '🧃', '🚗', '🏠', '⭐', '🛄', '🚶'].forEach((e, i) => { refs[e] = '@img' + (i + 1); });
const full = T.parseRequest(TASK + '圖示就好，字可以少一點，加上動畫。'); const tpl2 = T.templateOutline(full); const idoc = T.buildIconDeck(full, tpl2, null, refs);
check('icon deck: deck mapping with colours that the validator accepts (rgba with the fixed regex), lang and speed', idoc.deck.lang === 'zh-TW' && idoc.deck.speed === 1 && /^rgba\(\d+,\d+,\d+,0\.\d+\)$/.test(idoc.deck.colors.subtitleBar) && idoc.chapters.length >= 2);
check('icon deck: every slide is a collage with at least one item that has a picture handle; items pop by sentence number within the narration', idoc.chapters.every((c) => c.slides.every((s) => s.visual.kind === 'collage' && s.visual.items.length >= 1 && s.visual.items.every((it) => /^@img\d+$/.test(it.src) && it.at.sentence >= 1 && it.at.sentence <= Math.max(1, (s.narration.match(/[。！？]/g) || []).length || 1)))), idoc.chapters[0].slides[1]);
check('icon deck: pages that talk about flying get a plane that moves (keys) and a whoosh; pages about a car move the car; the cover has a big title text', (() => { const all = idoc.chapters.flatMap((c) => c.slides); const fly = all.find((s) => /起飛|飛到/.test(s.title + s.narration)); const mv = fly && fly.visual.items.find((it) => it.keys && it.src === refs['✈️']); return mv && fly.visual.sounds && all[0].visual.texts[0].style === 'title'; })());
check('icon deck: text is minimal — no bullets, titles up to 12 characters', idoc.chapters.every((c) => c.slides.every((s) => !s.bullets && s.title.length <= 12)));
check('icon list: unique emoji for the whole deck, with the defaults included', (() => { const l = T.iconList(tpl2); return new Set(l).size === l.length && l.indexOf('✈️') >= 0 && l.indexOf('⭐') >= 0; })());
check('template: the user's own style instructions (圖示就好、字可以少一點、加上動畫) never become pages', !T.templateOutline(T.parseRequest(TASK + '我覺得直接用圖示就好，字可以少一點，加上動畫。')).some((p) => /圖示|字可以|動畫|我覺得/.test(p.title + p.point)) && T.templateOutline(T.parseRequest(TASK + '我覺得直接用圖示就好，字可以少一點，加上動畫。')).slice(-1)[0].title === '總結');
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'deck_topic: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
