// node scripts/edit-tests/subject_research.test.js -- 不認識的東西先去查：問題與答案的驗證、維基摘要挑選、部位整理、給模型的一小段參考、快取淘汰
const R = require('../../renderer/src/edit/subject_research.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

const q = R.subjectsPrompt('畫一個茶壺和桌面，把雞翅放到盤子裡', ['茶壺', '花瓶'], 'edit-3d');
check('subjectsPrompt: names the request, the built-in things, the JSON shape; asks only for non-trivial real objects', /雞翅/.test(q.user) && /茶壺、花瓶/.test(q.user) && /"subjects"/.test(q.user) && /不要列/.test(q.user) && /JSON/.test(q.system));
check('parseSubjects: reads JSON inside chatter, keeps name/en, drops built-ins, duplicates, empties; at most 3', (() => {
  const r = R.parseSubjects('好的 {"subjects":[{"name":"雞翅","en":"chicken wing"},{"name":"茶壺","en":"teapot"},{"name":"雞翅"},{"name":""},{"name":"小提琴","en":"violin"},{"name":"水母","en":"jellyfish"},{"name":"消防栓"}]}', ['茶壺']);
  return r.length === 3 && r[0].name === '雞翅' && r[0].en === 'chicken wing' && r[1].name === '小提琴' && !r.some((x) => x.name === '茶壺');
})());
check('parseSubjects: bad replies give an empty list; a non-English "en" is dropped; plain strings are accepted', R.parseSubjects('不知道', []).length === 0 && R.parseSubjects('{"subjects":"x"}', []).length === 0 && R.parseSubjects('{"subjects":[{"name":"雞翅","en":"雞翅膀"}]}', [])[0].en === '' && R.parseSubjects('{"subjects":["雞翅"]}', [])[0].name === '雞翅');

check('wikiUrl: Chinese first, English second, query encoded', /^https:\/\/zh\.wikipedia\.org\/w\/api\.php\?/.test(R.wikiUrl('zh', '雞翅')) && /^https:\/\/en\.wikipedia\.org/.test(R.wikiUrl('en', 'chicken wing')) && /chicken%20wing/.test(R.wikiUrl('en', 'chicken wing')));
const wiki = { query: { pages: { 1: { title: '雞翅', index: 2, extract: '雞翅是雞的翅膀部分，通常切成翅尖、中翅與小腿三段，表面油亮呈金黃色，外皮酥脆，長約十公分左右，常用於炸雞與烤雞翅等料理。' }, 2: { title: '翅膀', index: 1, extract: '翅膀是鳥類與昆蟲用來飛行的器官，由骨骼、肌肉與羽毛組成，形狀扁平而修長。' } } } };
check('pickExtract: an English query needs the same title (not a longer one that merely contains it); plurals and brackets are ignored; Chinese allows two extra characters', (() => { const mk = (title) => ({ query: { pages: { 1: { title, index: 1, extract: 'x'.repeat(60) } } } }); return R.pickExtract(mk('Plate tectonics'), 'plate') === null && R.pickExtract(mk('Plate'), 'plate') && R.pickExtract(mk('Violins'), 'violin') && R.pickExtract(mk('Mercury (planet)'), 'mercury') && R.pickExtract(mk('炸雞翅'), '雞翅') && R.pickExtract(mk('雞翅料理大全集'), '雞翅') === null; })());
check('pickExtract: takes the best-ranked page whose title matches the query; ignores unrelated ones and empty answers', (() => { const a = R.pickExtract(wiki, '雞翅'), b = R.pickExtract(wiki, '輪船'), c = R.pickExtract({}, '雞翅'), d = R.pickExtract({ query: { pages: { 1: { title: '雞翅', index: 1, extract: '短' } } } }, '雞翅'); return a && a.title === '雞翅' && b === null && c === null && d === null; })());

const sub = { name: '雞翅', en: 'chicken wing' }, bp = R.briefPrompt(sub, wiki.query.pages[1].extract, 'edit-3d');
check('briefPrompt: has the subject, the evidence, the allowed shapes and the unit; says so when nothing was found', /雞翅/.test(bp.user) && /炸雞/.test(bp.user) && /ellipsoid/.test(bp.user) && /公分/.test(bp.user) && /沒有查到網路資料/.test(R.briefPrompt(sub, '', 'edit-3d').user));
const good = '{"name":"雞翅","look":"彎曲的三段式翅膀，金黃油亮","size_cm":[12,5,4],"parts":[{"name":"小腿","shape":"ellipsoid","size_cm":[6,3.5,3.5],"offset_cm":[-3,0,0],"color":"#c8872e"},{"name":"中翅","shape":"capsule","size_cm":[5,2.5,2],"offset_cm":[2.5,0.5,0],"color":"#d99a3c","rot_deg":[0,0,20]},{"name":"翅尖","shape":"cone","size_cm":[2,1,1],"offset_cm":[5.5,1,0],"color":"#b8702a"},{"name":"壞","shape":"teapot","size_cm":[1,1,1]},{"name":"缺尺寸","shape":"box"}],"notes":"表面要有光澤"}';
const br = R.parseBrief(good, sub, 'web');
check('parseBrief: keeps valid parts (shape in the list, 3 numbers), drops the others, keeps colours and rotation; fails when no part is usable', br && br.parts.length === 3 && br.parts[0].shape === 'ellipsoid' && br.parts[1].rot_deg[2] === 20 && br.size_cm.join() === '12,5,4' && br.source === 'web' && R.parseBrief('{"parts":[{"shape":"teapot"}]}', sub) === null && R.parseBrief('亂回', sub) === null);
check('parseBrief: clamps silly sizes and rejects non-numbers', (() => { const x = R.parseBrief('{"parts":[{"name":"a","shape":"box","size_cm":[99999,0,3],"offset_cm":["x",1,1]}]}', sub); return x && x.parts[0].size_cm[0] === 500 && x.parts[0].size_cm[1] === 0.1 && x.parts[0].offset_cm.join() === '0,0,0'; })());

const blk = R.refBlock([br], 800, 'edit-3d'), blk2 = R.refBlock([Object.assign({}, br, { source: 'model' })], 800, 'edit-svg');
check('refBlock: names the subject, its source, every part with size/place/colour; tells the model to use the parts; unit hint depends on the editor', /雞翅（網路資料整理）/.test(blk) && /小腿 ellipsoid 6×3.5×3.5cm/.test(blk) && /#c8872e/.test(blk) && /不要只放一兩個圓錐/.test(blk) && /公尺/.test(blk) && /沒查到網路資料/.test(blk2) && /等比例縮放/.test(blk2));
check('refBlock: respects the budget however many parts; the budget is split between subjects', (() => { const many = Object.assign({}, br, { parts: Array.from({ length: 12 }, (_, i) => Object.assign({}, br.parts[0], { name: 'p' + i })), notes: 'n'.repeat(190) }); const a = R.refBlock([many], 300), b = R.refBlock([many, many, many], 900); return a.length <= 300 + 120 && b.length <= 900 + 200 && R.refBlock([many], 99999).length < 2200; })());

check('cache: keys ignore case and spaces; eviction drops the oldest beyond the limit', R.cacheKey(' Chicken  Wing ') === 'chickenwing' && R.evictPlan([{ key: 'a', at: 3 }, { key: 'b', at: 1 }, { key: 'c', at: 2 }], 2).join() === 'b' && R.evictPlan([{ key: 'a', at: 1 }], 2).length === 0);
check('worthAsking: skips tiny or symbol-only texts', R.worthAsking('把雞翅放到盤子') && !R.worthAsking('好') && !R.worthAsking('1234 ,,, 56') );
console.log('subject_research: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
