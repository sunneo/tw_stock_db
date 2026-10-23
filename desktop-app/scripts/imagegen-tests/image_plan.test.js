// node scripts/imagegen-tests/image_plan.test.js -- /image 的規劃：由上而下細切、樣板、接線
const P = require('../../renderer/src/imagegen/image_plan.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const declared = () => P.UNITS.map((u) => ({ id: 'tool:' + u.name, runtime: 'app', name: u.name, summary: u.hint, params: u.needs.concat(u.opt || []).map((f) => ({ name: f, kind: 'named', type: f === 'request' ? 'text' : 'dict', type_src: 'schema', required: u.needs.indexOf(f) >= 0 })), returns: { type: 'object{ok:bool,' + u.gives + ':dict}', type_src: 'doc' }, effects: ['state.write'], pure: false, avail: { state: 'builtin' }, tier: 1 }));
const run = async () => {
  // ---- 單元與樣板
  check('units: every unit has a chinese label, needs and gives; render does not need a scene', P.UNITS.length === 9 && P.UNITS.every((u) => u.label && u.needs.length && u.gives) && P.UNITS.find((u) => u.name === 'image_render').needs.join() === 'request');
  check('template: a simple request is just render + retouch; a complex one gets the whole chain', P.chooseTemplate({}).units.join() === 'image_render,image_retouch' && P.chooseTemplate({ complex: true }).units.length === 9, P.chooseTemplate({}));
  check('template: options remove stages (and what depends on them)', P.chooseTemplate({ complex: true, draft: false }).units.indexOf('image_draft') < 0 && P.chooseTemplate({ complex: true, check: false }).units.every((u) => u !== 'image_check' && u !== 'image_improve') && P.chooseTemplate({ complex: true, retouch: false }).units.indexOf('image_retouch') < 0);
  // ---- 整理
  check('normalize: missing prerequisites are added in wiring order and render is always there', (() => { const n = P.normalize(['image_improve', 'image_draft']); return n.units.join() === 'image_scene,image_draft,image_render,image_check,image_improve' && n.added.indexOf('image_render') >= 0 && n.added.indexOf('image_check') >= 0; })(), P.normalize(['image_improve', 'image_draft']));
  check('normalize: unknown names are dropped and reported; duplicates collapse', (() => { const n = P.normalize(['image_render', 'image_render', 'nope']); return n.units.join() === 'image_render' && n.dropped.join() === 'nope'; })());
  // ---- 一句話對到單元
  check('pickUnit: chinese wording finds the unit; ambiguous or unknown gives none', P.pickUnit('畫構圖草稿').unit.name === 'image_draft' && P.pickUnit('生成圖片').unit.name === 'image_render' && P.pickUnit('後製微調').unit.name === 'image_retouch' && P.pickUnit('吃早餐').unit === null);
  // ---- 接線
  const prog = P.toProgram(P.TEMPLATES.scene.units);
  check('wire: request goes to every step that needs it; each later step takes the earlier output with the same field name', (() => { const s = (id) => prog.steps.find((x) => x.id === id); return prog.inputs.request && s('s1').args.request.$in === 'request' && s('s4').args.scene.$ref === 's3.scene' && s('s5').args.image.$ref === 's4.image' && s('s6').args.verdict.$ref === 's5.verdict' && s('s6').args.image.$ref === 's4.image' && s('s7').args.image.$ref === 's6.image' && s('s8').args.image.$ref === 's7.image' && s('s9').args.image.$ref === 's8.image'; })(), prog);
  check('wire: a direct plan has no scene argument at all', (() => { const d = P.toProgram(['image_render', 'image_retouch']); return !d.steps[0].args.scene && d.steps[1].args.image.$ref === 's1.image'; })());
  const IR = require('../../renderer/src/catalog/ir_core.js');
  check('wire: both programs pass the real IR checker once the units are declared', IR.validate(prog, { units: declared() }).ok && IR.validate(P.toProgram(['image_render', 'image_retouch']), { units: declared() }).ok, [IR.validate(prog, { units: declared() }).errors, IR.validate(P.toProgram(['image_render', 'image_retouch']), { units: declared() }).errors]);
  // ---- 細切（模型是注入的，這裡用假的）
  const mkAsk = (answers) => { const log = []; const f = async (prompt) => { log.push(prompt); const a = answers.shift(); if (a instanceof Error) throw a; return a; }; f.log = log; return f; };
  const a1 = mkAsk(['場景：想要有哪些主體與道具\n草稿：畫構圖\n細節：決定風格\n生成：畫出來\n修圖：調一調']);
  const r1 = await P.cut({ request: '音樂會的場景', ask: a1 });
  check('cut: one question is enough when every line names a unit; the tree records each leaf', r1.ok && a1.log.length === 1 && r1.units.join() === 'image_scene,image_draft,image_details,image_render,image_retouch' && r1.tree.length === 5 && r1.calls === 1, r1);
  const a2 = mkAsk(['場景：想想\n準備舞台燈光與觀眾席\n生成：畫', '場景，草稿']);
  const r2 = await P.cut({ request: '音樂會', ask: a2 });
  check('cut: a line that is not one unit is cut again into smaller steps (second question), then wired', r2.ok && a2.log.length === 2 && /準備舞台燈光與觀眾席/.test(a2.log[1]) && r2.tree[1].children && r2.units.indexOf('image_draft') >= 0, r2);
  const a3 = mkAsk(['隨便聊聊\n吃個飯', '', '']);
  const r3 = await P.cut({ request: 'x', ask: a3 });
  check('cut: lines that cannot be cut into units are gaps; all gaps means the plan fails (caller falls back to a template)', r3.ok === false && r3.gaps.length === 2, r3);
  const r4 = await P.cut({ request: 'x', ask: mkAsk([new Error('逾時')]) });
  check('cut: a model error fails the plan with the reason', r4.ok === false && /逾時/.test(r4.error), r4);
  const r5 = await P.cut({ request: 'x', ask: mkAsk(['']) });
  check('cut: an empty answer fails the plan', r5.ok === false && /空的/.test(r5.error), r5);
  const many = []; for (let i = 0; i < 8; i++) many.push('做第' + i + '件怪事'); const a6 = mkAsk([many.join('\n')].concat(new Array(20).fill('')));
  await P.cut({ request: 'x', ask: a6, maxCalls: 4 });
  check('cut: the number of questions is capped', a6.log.length <= 4, a6.log.length);
  check('cut: the first question is closed — lists the units and asks for lines of unit:what', /場景：/.test(P.rootPrompt('x')) && /單元名稱只能是上面列的/.test(P.rootPrompt('x')));
  check('toText: shows each unit and the cutting', /1\. 場景/.test(P.toText(r1.units, r1.tree)) && /細切的過程/.test(P.toText(r2.units, r2.tree)));
  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'image_plan: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
};
run();
