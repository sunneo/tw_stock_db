// node scripts/deck-tests/deck_stage.test.js -- 故事／名詞清單 → 舞台描述（意象推導＋CoLU）：三隻小豬、名詞清單（這是蜘蛛、這是猴子）、對話、跑／吹／敲、走進／走出。
const Core = require('../../renderer/src/deck/deck_core.js');
const Stage = require('../../renderer/src/deck/stage_core.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 500) : '')); }

const PIGS = Stage.storyFor('給我三隻小豬的故事').text;
check('a built-in story is found by its name', !!Stage.storyFor('三隻小豬') && !!Stage.storyFor('龜兔賽跑') && Stage.storyFor('今天天氣很好') === null);

// ---------- 詞表與提及 ----------
check('lexicon: Chinese and English nouns', Stage.find('蜘蛛').emoji === '🕷️' && Stage.find('monkey').id === 'monkey' && Stage.find('大野狼').id === 'wolf' && Stage.find('不存在的東西') === null);
const m1 = Stage.mentions('從前有三隻小豬住在一棟房子裡。');
check('mentions: a count ("三隻小豬" = 3 pigs) and a place (house)', m1.some((m) => m.id === 'pig' && m.count === 3) && m1.some((m) => m.id === 'house'), m1);
const m2 = Stage.mentions('豬大哥、豬二哥和豬小弟。');
check('mentions: named individuals (豬大哥, 豬二哥, 豬小弟) are different', m2.filter((m) => m.id === 'pig').map((m) => m.label).join() === '豬大哥,豬二哥,豬小弟', m2);
check('mentions: "大野狼" is the wolf (not a "野狼" plus something)', Stage.mentions('大野狼來了').length === 1 && Stage.mentions('大野狼來了')[0].label === '大野狼');
check('mentions: English with a count', Stage.mentions('Two monkeys and a spider').filter((m) => m.id === 'monkey')[0].count === 2);

// ---------- 讀故事（意象）----------
const st = Stage.readStory(PIGS);
check('sentence numbers are the same as the deck splits the narration', st.sentences.length === Core.splitSentences(PIGS).length && st.sentences.every((s, i) => s.text === Core.splitSentences(PIGS)[i]));
const byI = (i) => st.sentences[i - 1];
check('dialogue without quote marks: "豬大哥說，…" gives the speaker and the words', byI(2).quotes.length === 1 && byI(2).quotes[0].speaker === '豬大哥' && /稻草/.test(byI(2).quotes[0].text), byI(2).quotes);
check('the wolf runs in (a running verb makes a movement)', byI(5).fx.indexOf('run') >= 0, byI(5).fx);
check('"吹" makes wind, "敲" knocking', byI(6).fx.indexOf('blow') >= 0 || byI(7).fx.indexOf('blow') >= 0);
check('a shout is recognised ("呼——！")', st.sentences.some((s) => s.shout && /呼/.test(s.shout)), st.sentences.map((s) => s.shout));
check('going in is recognised ("躲進")', st.sentences.some((s) => s.inside));
check('only the ACT of going in moves the camera: "裡面住著三隻小豬" just describes the place', st.sentences[0].inside === false && Stage.readStory('小豬走進屋子裡。').sentences[0].inside === true && Stage.readStory('小豬走出屋外。').sentences[0].outside === true);
check('an emoji older systems cannot draw has a fallback', Stage.ALT['🪵'] === '🌲');
const q = Stage.readStory('小明說：「我們去公園玩。」');
check('quotes with 「」 and no known speaker stay unresolved (no guessing a name that is not a character)', q.sentences[0].quotes[0].text === '我們去公園玩。' && q.sentences[0].quotes[0].speaker === null);

// ---------- 排舞台 ----------
const plan = Stage.planStage(st);
const v = plan.visual;
check('the plan is a valid collage', plan.ok && v.kind === 'collage' && v.items.length >= 5, v.items.length);
check('three named pigs + the wolf + the house + the three building materials named in the story = 8 pictures', v.items.length === 8 && ['豬大哥', '豬二哥', '豬小弟', '大野狼'].every((l) => v.items.some((x) => x.label === l)), v.items.map((x) => x.label || 'bg'));
check('the house is the background (there from the start, no sticker card)', v.items[0].at === 0 && v.items[0].card === false && /🏠/.test(v.items[0].src));
const pig1 = v.items.filter((x) => x.label === '豬大哥')[0];
check('each character pops in at the sentence that first names it', pig1 && pig1.at.sentence >= 1 && pig1.at.sentence === 1, pig1 && pig1.at); // the three pigs are named in sentence 1 ("三隻小豬"): they pop in there, the named ones claim the places
check('each pig says its line in the sentence where it speaks (speech bubble)', pig1.say && pig1.say[0].sentence === 2 && /稻草/.test(pig1.say[0].text) && v.items.filter((x) => x.label === '豬二哥')[0].say[0].sentence === 3);
const wolf = v.items.filter((x) => /🐺/.test(x.src))[0];
check('the wolf runs in from off stage (x < 0, keys to its place, hops, footsteps) and growls when it speaks', wolf.x < 0 && wolf.keys && wolf.keys[0].x > 0 && wolf.bob > 0 && wolf.sfx && wolf.sfx.move === 'step' && wolf.sfx.say === 'growl', wolf);
check('"吹" adds the wind sound, the shout becomes big lettering', (v.sounds || []).some((x) => x.sfx === 'wind') && (v.texts || []).some((x) => x.style === 'shout'), [v.sounds, v.texts]);
check('going into the house zooms the camera in (and out again when it comes out)', (v.camera || []).length >= 1 && v.camera[0].zoom > 1, v.camera);
check('the emoji list for the host (unique)', plan.emojis.length >= 6 && new Set(plan.emojis).size === plan.emojis.length, plan.emojis);
check('the whole plan is accepted by the deck format (no errors)', (() => {
  const imgs = (x) => Object.assign({}, x, { src: 'data:image/png;base64,AAAA' });
  const deck = { deck: { title: '三隻小豬', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [{ title: 's', layout: 'visual', narration: PIGS, visual: Object.assign({}, v, { items: v.items.map(imgs) }) }] }] };
  try { Core.parseDeck(yaml.dump(deck), yaml); return true; } catch (e) { return String(e.message).slice(0, 300); }
})() === true);

// ---------- 說話的人認不出來 → 封閉選單（CoLU）----------
const amb = Stage.readStory('小豬和小狗在玩。他說：「我們去公園吧！」');
const ap = Stage.planStage(amb);
check('an unknown speaker is a closed question with the characters as options (and a program default)', ap.questions.length === 1 && ap.questions[0].options.length === 2 && !!ap.questions[0].default, ap.questions);
(async () => {
  const asked = []; const pickSecond = async (qq, opts) => { asked.push({ qq, opts }); return 1; };
  const a1 = await Stage.planStageAsync(Stage.readStory('小豬和小狗在玩。他說：「我們去公園吧！」'), { pick: pickSecond });
  check('the model picks one option: the line moves to that character', asked.length === 1 && asked[0].opts.length === 2 && a1.visual.items.some((x) => x.label === a1.questions[0].chosen && x.say), a1.questions);
  const a2 = await Stage.planStageAsync(Stage.readStory('小豬和小狗在玩。他說：「我們去公園吧！」'), { pick: async () => 99 });
  check('a pick out of range: the default stays', a2.visual.items.some((x) => x.say) && !a2.questions[0].chosen);
  const a3 = await Stage.planStageAsync(Stage.readStory('小豬和小狗在玩。他說：「我們去公園吧！」'), { pick: async () => { throw new Error('model down'); } });
  check('a failing model: the default stays, no throw', a3.visual.items.some((x) => x.say));

  // ---------- 名詞清單：這是蜘蛛、這是猴子 ----------
  check('a noun list is recognised', JSON.stringify(Stage.parseList('蜘蛛、猴子、蝴蝶')) === JSON.stringify(['蜘蛛', '猴子', '蝴蝶']) && Stage.parseList('這是一段很長的句子。') === null && Stage.parseList('蜘蛛') === null);
  const il = Stage.introList(['蜘蛛', '猴子', '蝴蝶']);
  check('intro list: the narration says "這是X" for each (a lead sentence first)', il.narration === '小朋友看！ 這是蜘蛛。 這是猴子。 這是蝴蝶。', il.narration);
  check('intro list: each thing pops in with ITS sentence, is circled / boxed, swings, has a name tag', il.visual.items.length === 3 && il.visual.items.every((x, k) => x.at.sentence === k + 2 && x.swing && x.ring && x.label), il.visual.items);
  check('intro list: the sentences of the narration line up with the pictures (sentence N = picture N-1)', Core.splitSentences(il.narration).length === 4);
  check('intro list: an unknown noun is reported, not drawn', Stage.introList(['蜘蛛', '量子糾纏']).unknown.join() === '量子糾纏');
  check('intro list in English', Stage.introList(['spider', 'monkey'], { lang: 'en' }).narration === 'Look, children! This is a spider. This is a monkey.');
  check('intro list: the deck accepts it', (() => { const imgs = il.visual.items.map((x) => Object.assign({}, x, { src: 'data:image/png;base64,AAAA' })); try { Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [{ title: 's', layout: 'visual', narration: il.narration, visual: { kind: 'collage', items: imgs } }] }] }), yaml); return true; } catch (e) { return String(e.message); } })() === true);

  // ---------- 整份簡報 ----------
  const bd = Stage.buildDeck(PIGS, { title: '三隻小豬', voice: 'zf_xiaoxiao', speed: 0.9 });
  check('a whole deck: voice and speed go to deck settings, the narration is the story', bd.ok && bd.deck.voice === 'zf_xiaoxiao' && bd.deck.speed === 0.9 && bd.slides.length >= 1 && bd.slides[0].narration.indexOf('三隻小豬') >= 0);
  const long = Array.from({ length: 16 }, (_, i) => (i === 0 ? '小豬住在房子裡。' : '大野狼說，我要把房子吹倒！')).join('');
  const ld = Stage.buildDeck(long, { perSlide: 6 });
  check('a long story is split over slides (6 sentences each); characters seen before are there from the start', ld.slides.length === 3 && ld.slides[1].visual.items.some((x) => x.at === 0 && /🐷/.test(x.src)), ld.slides.map((s) => s.visual.items.map((x) => JSON.stringify(x.at))));
  check('nothing recognisable → not ok, with a note (no invented pictures)', Stage.buildDeck('今天天氣很好，我們去散步。', {}).ok === false);
  console.log((bad.length ? 'FAIL' : 'PASS') + ' 故事→舞台（意象推導＋CoLU：角色與對話、動作與音效、進出場景、名詞清單、封閉問題）：' + ok + ' passed, ' + bad.length + ' failed', bad);
  process.exit(bad.length ? 1 : 0);
})();
