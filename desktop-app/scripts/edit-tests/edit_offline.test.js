// node scripts/edit-tests/edit_offline.test.js -- 離線 AI 支援：程式讀出顏色／數字／物件，只在有歧義時問字母選擇題；組出的動作要能被各編輯器核心接受
const O = require('../../renderer/src/edit/edit_offline.js');
const S = require('../../renderer/src/edit/edit_svg_core.js');
const D = require('../../renderer/src/edit/edit3d_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
(async () => {
  // ---- 小零件
  check('colors: longest word wins and 色 is optional', O.colorsIn('把它變成天藍色')[0].hex === '#4fc3f7' && O.colorsIn('紅的')[0].hex === '#e53935' && O.colorsIn('#ff8800')[0].hex === '#ff8800');
  check('cnNum: arabic and chinese numerals', O.cnNum('12') === 12 && O.cnNum('兩') === 2 && O.cnNum('十二') === 12 && O.cnNum('二十') === 20 && O.cnNum('一百') === 100 && O.cnNum('abc') === null);
  check('factor: double, half, a bit bigger, smaller, n times', O.factorIn('放大一倍') === 2 && O.factorIn('縮小一半') === 0.5 && O.factorIn('大一點') === 1.25 && O.factorIn('小一點') === 0.8 && O.factorIn('放大 3 倍') === 3 && O.factorIn('放大兩倍') === 2 && O.factorIn('今天天氣') === null);
  check('letter prompt and answer parsing', /A\. x\nB\. y/.test(O.letterPrompt('q', ['x', 'y'])) && O.parseLetter('B', 3) === 1 && O.parseLetter('答案：C。因為…', 3) === 2 && O.parseLetter('D', 3) === null && O.parseLetter('', 3) === null && O.parseLetter('2', 3) === 1 && O.parseLetter('<think>a</think>A', 2) === 0);
  check('shape words', O.shapeIn('畫一個五角星').shape === 'star' && O.shapeIn('加一個圓形').shape === 'ellipse' && O.shapeIn('一個三角形').shape === 'triangle' && O.shapeIn('你好') === null);

  // ---- SVG 類
  const E = O.make(O.drawAdapter(S));
  const base = S.applyEdits(S.starter('blank'), [{ op: 'add_object', object: { type: 'shape', shape: 'rect', name: '藍色方塊', fill: '#1e88e5', w: 100, h: 80 }, place: { of: 'view', rel: 'center' } }, { op: 'add_object', object: { type: 'shape', shape: 'ellipse', name: '黃色圓形', fill: '#fdd835', w: 60, h: 60, x: 300, y: 50 } }]).spec;
  const apply = (spec, edits) => S.applyEdits(spec, edits);
  const T = async (text, spec, pick) => { const r = await E.run(text, spec || base, {}, pick); const a = apply(spec || base, r.edits); return { r, a, spec: a.spec }; };
  let t = await T('加一個紅色的圓形');
  check('svg add: a red circle appears', t.r.edits.length === 1 && t.a.rejected.length === 0 && t.spec.objects.length === 3 && t.spec.objects[2].shape === 'ellipse' && t.spec.objects[2].fill === '#e53935', t.r);
  t = await T('在藍色方塊右邊放一個綠色三角形');
  const tri = t.spec.objects[2], blue = t.spec.objects[0];
  check('svg add next to an object: the triangle sits to the right of the blue block', tri && tri.shape === 'triangle' && tri.fill === '#43a047' && tri.x >= blue.x + blue.w - 1, { tri, blue });
  t = await T('把藍色方塊變成紅色'); check('svg recolor: only the blue block changes, the new colour comes after the verb', t.spec.objects[0].fill === '#e53935' && t.spec.objects[1].fill === '#fdd835', t.spec.objects.map((o) => o.fill));
  t = await T('把藍色方塊放大一倍'); check('svg scale: width doubles', t.spec.objects[0].w === 200 || t.spec.objects[0].w > 150, t.spec.objects[0]);
  t = await T('把黃色圓形往右移 50'); check('svg move: x grows by 50', t.spec.objects[1].x === 350, t.spec.objects[1]);
  t = await T('畫一個五角星'); check('svg star', t.spec.objects[2] && t.spec.objects[2].shape === 'star' && t.a.rejected.length === 0);
  t = await T('加一段文字「你好世界」'); check('svg text with quotes', t.spec.objects[2] && t.spec.objects[2].shape === 'text' && t.spec.objects[2].text === '你好世界', t.spec.objects[2]);
  t = await T('把背景改成黑色'); check('svg background', t.spec.canvas.bg === '#212121', t.spec.canvas);
  t = await T('把藍色方塊縮小一半'); check('svg shrink to half', t.spec.objects[0].w <= 60, t.spec.objects[0]);
  t = await T('黃色圓形旋轉 30 度'); check('svg rotate 30', t.spec.objects[1].rotate === 30, t.spec.objects[1]);
  t = await T('刪掉黃色圓形，把藍色方塊改成粉紅色'); check('svg two clauses', t.spec.objects.length === 1 && t.spec.objects[0].fill === '#ec407a', t.spec.objects.map((o) => o.fill));
  t = await T('把黃色圓形鎖定'); check('svg lock', t.spec.objects[1].locked === true);
  t = await T('把黃色圓形改名叫「太陽」'); check('svg rename with quotes', t.spec.objects[1].name === '太陽', t.spec.objects[1]);
  t = await T('黃色圓形半透明'); check('svg opacity', t.spec.objects[1].opacity === 0.5, t.spec.objects[1]);
  t = await T('今天天氣很好'); check('svg nonsense with no picker: nothing is done and it is reported', t.r.edits.length === 0 && t.r.unmatched.length === 1);
  // 歧義：兩個「球」→ 問模型；模型答 B
  const two = apply(S.starter('blank'), [{ op: 'add_object', object: { type: 'shape', shape: 'ellipse', name: '紅色球', fill: '#e53935', w: 50, h: 50 } }, { op: 'add_object', object: { type: 'shape', shape: 'ellipse', name: '藍色球', fill: '#1e88e5', w: 50, h: 50, x: 200 } }]).spec;
  let asked = null;
  t = await T('把球變成綠色', two, async (q, opts) => { asked = [q, opts]; return 1; });
  check('svg ambiguity: asks which ball, the answer picks it', asked && asked[1].length === 2 && t.spec.objects[1].fill === '#43a047' && t.spec.objects[0].fill === '#e53935', asked);
  t = await T('把球變成綠色', two, async () => null); check('svg ambiguity with a picker that cannot answer: takes the default (first), still valid', t.spec.objects.filter((o) => o.fill === '#43a047').length === 1);
  t = await T('把紅色的球變成綠色', two); check('svg colour words in the name break the tie without asking', t.r.asked.length === 0 && t.spec.objects[0].fill === '#43a047' && t.spec.objects[1].fill === '#1e88e5', t.r.asked);
  let opts2 = null;
  t = await T('弄一下', base, async (q, opts) => { opts2 = opts; return opts.length - 1; }); check('svg unknown sentence asks which intent; "none of these" is respected', opts2 && /都不是/.test(opts2[opts2.length - 1]) && t.r.edits.length === 0);
  t = await T('弄一下', base, async (q, opts) => opts.findIndex((x) => /顏色/.test(x))); check('svg the model picked recolor but there is no colour: reported, not applied', t.r.edits.length === 0 && t.r.notes.length === 1, t.r);

  // ---- 3D
  const E3 = O.make(O.sceneAdapter(D));
  let sc = D.starter('room'); sc = D.applyEdits(sc, [{ op: 'add_object', object: { type: 'mesh', mesh: 'sphere', name: '紅色球', radius: 0.5, material: { color: '#e53935' } }, place: { of: 'me', rel: 'front' } }]).spec;
  const T3 = async (text, pick) => { const r = await E3.run(text, sc, {}, pick); const a = D.applyEdits(sc, r.edits, {}); return { r, a, spec: a.spec }; };
  let u = await T3('把紅色的球變成藍色'); const ball = (s) => s.objects.find((o) => o.name === '紅色球');
  check('3d recolor by name', u.a.rejected.length === 0 && ball(u.spec).material.color === '#1e88e5', u.r);
  u = await T3('把球放大一倍'); check('3d scale doubles the ball', u.a.rejected.length === 0 && JSON.stringify(ball(u.spec)) !== JSON.stringify(ball(sc)), ball(u.spec));
  u = await T3('把球轉 90 度'); check('3d turn', u.a.rejected.length === 0 && Math.abs(ball(u.spec).rotation[1] - Math.PI / 2) < 0.01, ball(u.spec).rotation);
  u = await T3('把球放到地上'); check('3d drop to the ground', u.a.rejected.length === 0 && Math.abs(ball(u.spec).position[1] - 0.5) < 0.05, ball(u.spec).position);
  u = await T3('把天空改成黑色'); check('3d background', u.spec.background === '#212121', u.spec.background);
  u = await T3('刪掉球'); check('3d remove', !ball(u.spec));
  u = await T3('把球隱藏'); check('3d hide', ball(u.spec).visible === false);
  // ---- 簡報
  const K = require('../../renderer/src/deck/deck_edit_core.js');
  const dk = K.fromDoc({ deck: { title: '韌體', lang: 'zh-TW', speed: 1 }, chapters: [{ title: '開場', slides: [{ layout: 'title', title: '韌體更新流程', narration: '大家好，今天要講的是韌體更新，包含準備、備份、刷新與驗證四個步驟。' }, { title: '為什麼要更新', bullets: ['修漏洞'], narration: '因為有漏洞' }] }, { title: '步驟', slides: [{ title: '備份', narration: '先備份' }, { title: '刷新', narration: '再刷新' }] }] });
  const ED = O.make(O.deckAdapter(K)), cur = K.slides(dk)[1].id;
  const TD = async (text, rewrite) => { const r = await ED.run(text, dk, { selection: cur }, null, rewrite); const a = K.applyEdits(dk, r.edits, { slide: cur }); return { r, a, spec: a.spec }; };
  let v = await TD('在第 2 頁後面加一頁講風險'); const pages = (sp) => K.slides(sp).map((o) => o.name);
  check('deck add a page about a topic after page 2', v.a.rejected.length === 0 && pages(v.spec)[2] === '風險' && pages(v.spec).length === 5, pages(v.spec));
  v = await TD('在最後加一頁「謝謝」'); check('deck add a quoted page at the end', pages(v.spec).pop() === '謝謝', pages(v.spec));
  v = await TD('這頁加一個重點「要先斷電」'); check('deck add a bullet to this page', K.slides(v.spec)[1].slide.bullets.join() === '修漏洞,要先斷電', K.slides(v.spec)[1].slide.bullets);
  v = await TD('這頁換成淡入轉場'); check('deck transition by word', v.a.rejected.length === 0 && K.slides(v.spec)[1].slide.transition && K.slides(v.spec)[1].slide.transition.type === 'fade', K.slides(v.spec)[1].slide);
  v = await TD('把語速調快一點'); check('deck speed up', v.spec.deck.speed > 1, v.spec.deck);
  v = await TD('把第 1 頁的旁白講短一點', async (text, how) => '大家好，今天講韌體更新。'); check('deck narration shortened by the model, the program only wires it', K.slides(v.spec)[0].slide.narration === '大家好，今天講韌體更新。', K.slides(v.spec)[0].slide.narration);
  v = await TD('把第 1 頁的旁白講短一點'); check('deck narration with no writer: reported, nothing changed', v.r.edits.length === 0 && v.r.notes.length === 1, v.r.notes);
  v = await TD('把第 3 頁隱藏'); check('deck hide page 3 by number: the third page leaves the visible list', pages(v.spec).length === 3 && pages(v.spec).indexOf('備份') < 0, pages(v.spec));

  // ---- 遊戲
  const Gm = require('../../renderer/src/game/game_core.js'); const gs = Gm.starter('platformer-side'), EG = O.make(O.gameAdapter(Gm));
  const TG = async (text) => { const r = await EG.run(text, gs, {}, null); const a = Gm.applyEdits(gs, r.edits, {}); return { r, a, spec: a.spec }; };
  let w = await TG('讓玩家跑快一點'); check('game faster player', w.a.rejected.length === 0 && w.spec.objects.find((o) => o.id === 'player').params.speed > 90, w.r);
  w = await TG('讓玩家跳高一倍'); check('game jump twice as high', w.spec.objects.find((o) => o.id === 'player').params.jump === 500, w.r);
  w = await TG('讓玩家跑慢一點'); check('game slower player', w.spec.objects.find((o) => o.id === 'player').params.speed < 90, w.r);
  w = await TG('把背景改成黑色'); check('game scene background', w.spec.objects.find((o) => o.type === 'scene').background === '#212121', w.r);
  w = await TG('這個場景放戰鬥的背景音樂'); check('game bgm style', w.a.rejected.length === 0 && w.r.edits[0].style === 'battle', w.r);
  w = await TG('把遊戲名稱改成「大冒險」'); check('game title', w.spec.game.title === '大冒險', w.r);
  w = await TG('刪掉史萊姆'); check('game remove: the slime in the level goes (the instance, not its prototype)', !w.spec.objects.some((o) => o.id === 'o2') && w.spec.objects.some((o) => o.id === 'enemy') && w.r.asked.length === 0, w.r);
  w = await TG('刪掉金幣'); check('game remove: copies with the same name all go without asking', w.spec.objects.filter((o) => o.type === 'object' && o.name === '金幣').length === 0 && w.r.edits.length > 3 && w.r.asked.length === 0, w.r.edits.length);
  console.log('edit_offline: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
})();
