// 使用者說「主題不是／沒有 X」：X 不拿去搜尋、只講 X 的原文不算證據；使用者反駁上一個答案時回頭檢查、排除、用同一問題重答；提示詞帶「NOT use/have」限制。
const fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '../..'), C = require(path.join(root, 'renderer/src/knowledge/knowledge_core.js'));
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

// ---- 1. 核心（跟藏書閣 negation.test.js 同一組案例）
let n = C.negation('GB300 Galaxy的特色，說明它不使用AST2700');
check('zh: 說明它不使用X 剪掉並記下', n.positive === 'GB300 Galaxy的特色' && n.negated.join() === 'ast2700', n);
n = C.negation('GB300用的不是AST2700'); check('zh: 不是 X', n.negated.join() === 'ast2700', n);
n = C.negation('Does GB300 use AST2700? It does not use AST2700'); check('en: does not use X', n.negated.join() === 'ast2700', n);
n = C.negation('how to flash without ipmitool'); check('一般單字不是名字：不剪', n.negated.length === 0 && n.positive === 'how to flash without ipmitool', n);
check('沒有否定的問句不動', C.negation('GB300 Galaxy 有什麼特色').negated.length === 0);
check('只是更正的訊息認得出來', C.isCorrection('GB300用的不是AST2700') && C.isCorrection('不是AST2700') && C.isCorrection('它沒有使用AST2700'));
check('順便說主題不是什麼的新問題不是更正', !C.isCorrection('Redfish on GB300, 說明它不使用AST2700') && !C.isCorrection('GB300 Galaxy的特色，說明它不使用AST2700') && !C.isCorrection('GB300 Galaxy 有什麼特色'));
check('dropWords：整個名字才拿掉、不會變空', C.dropWords('GB300 Redfish AST2700', ['ast2700']) === 'GB300 Redfish' && C.dropWords('AST2700', ['ast2700']) === 'AST2700' && C.dropWords('AST27001 AST2700', ['ast2700']) === 'AST27001');
const P = [{ text: 'The GB300 has a Grace CPU', source_title: 'GB300 Overview', source_id: 1 }, { text: 'AST2700 supports Redfish', source_title: 'AST2700 Guide', source_id: 2 }, { text: 'GB300 fan control', source_title: 'Notes', source_id: 3 }, { text: 'unrelated cafeteria', source_title: 'Menu', source_id: 4 }, { text: 'GB300 Redfish', source_title: 'GB300 Redfish', source_id: 5 }];
let f = C.filterEvidence(P, ['gb300'], ['ast2700'], {});
check('filterEvidence：只留在講主題的', f.passages.length === 3 && f.dropped === 2 && !f.weak && f.passages.every((p) => /GB300/i.test(p.text + p.source_title)), f);
f = C.filterEvidence(P, [], ['ast2700'], {}); check('沒有主題名時，提到避開名字的丟掉', f.passages.length === 4 && f.passages.every((p) => !/AST2700/.test(p.text)));
f = C.filterEvidence(P.slice(0, 2), ['gb300'], ['ast2700'], {}); check('留下太少就不套用（weak）', f.weak && f.passages.length === 2);
const au = C.auditPassages(P, ['gb300'], ['ast2700'], {}); check('回頭檢查點名不是在講主題的', au.wrong.length === 2 && au.wrong.some((p) => p.source_id === 2) && au.right.length === 3);

// ---- 2. 主機端（假的 this）
const hostSrc = fs.readFileSync(path.join(root, 'renderer/src/knowledge/knowledge_host.js'), 'utf8');
const H = vm.runInNewContext(hostSrc + '\n;FaKnowledgeHost', { window: {}, FaKnowledge: C, console, setTimeout, clearTimeout, Date, JSON, Math, Promise, Error, String, Number, Object, Array, Set, Map, RegExp }).methods;
(async () => {
  // _kiAsk：搜尋的問句不含被否定的名字，片段不是在講主題的丟掉
  const asked = [];
  const t = Object.assign({}, H);
  t.advancedSettings = {}; t._kiSettings = () => ({ embedConsent: false, location: { kind: 'idb', ref: 'x' } }); t._kiModelId = () => 'm';
  t._kiQueryVec = async () => ({ vec: null, why: 'x' });
  const hits = P.map((p, i) => ({ label: 'L' + i, source: p.source_title, source_id: p.source_id, line_start: 1, line_end: 1, quote: p.text, found_by: '關鍵字＋語意', score: 1 - i / 10 }));
  t._kiRun = async (fn) => fn({ answer: async (q) => { asked.push(q); return { ok: true, found: true, hits: hits.slice() }; }, relatedOf: async () => [] });
  const steps = []; const r = await t._kiAsk({ question: 'GB300 Redfish，說明它不使用AST2700', onStep: (x) => steps.push(x), no_expand: true });
  check('ask: AST2700 沒進搜尋', asked.length === 1 && !/ast2700/i.test(asked[0]) && /GB300/.test(asked[0]), asked);
  check('ask: 講 AST2700 又沒提 GB300 的片段不當證據', r.hits.length === 3 && r.hits.every((h) => /GB300/i.test(h.quote + h.source)) && r.dropped_off_topic === 2 && r.avoid.join() === 'ast2700', { n: r.hits.length, d: r.dropped_off_topic });
  check('ask: 步驟提到排除了幾段', steps.some((x) => /2 段原文不是在講你問的對象/.test(x)), steps);
  asked.length = 0; const r2 = await t._kiAsk({ question: 'GB300 Redfish', no_expand: true });
  check('ask: 沒有否定時不動（5 筆全留、不帶 avoid）', r2.hits.length === 5 && r2.avoid === undefined && asked[0] === 'GB300 Redfish');

  // 更正：回頭檢查、排除、用同一問題重答
  const t2 = Object.assign({}, H); t2.advancedSettings = {}; t2._kiRef = () => 'idb:x';
  check('correct: 還沒有上一輪就不算更正', t2._kiCanCorrect('GB300用的不是AST2700') === false);
  t2._kiLastTurn = { ref: 'idb:x', question: 'GB300 的 BMC 晶片是什麼', passages: [{ source_id: 1, source_title: 'GB300 Overview', text: 'GB300 BMC' }, { source_id: 2, source_title: 'AST2700 Guide', text: 'AST2700 spec' }] };
  check('correct: 有上一輪、訊息只是更正才算', t2._kiCanCorrect('GB300用的不是AST2700') === true && t2._kiCanCorrect('GB300 Galaxy 有什麼特色') === false);
  let call = null; const st2 = [];
  t2._kiRespond = async (q, hist, onStep, ctl, src, ro) => { call = { q, ro }; return { ok: true, text: 'new answer' }; };
  const res = await t2._kiCorrectLast('GB300用的不是AST2700', [], (x) => st2.push(x), null, undefined, {});
  check('correct: 用上一個問題重答、帶 avoid、不再當更正', call.q === 'GB300 的 BMC 晶片是什麼' && call.ro.avoid.join() === 'ast2700' && call.ro.noCorrect === true, call);
  check('correct: 回頭檢查列出引用了 2 段、1 段是 AST2700 的', res.corrected && res.corrected.checked === 2 && res.corrected.wrong.length === 1 && res.corrected.wrong[0].title === 'AST2700 Guide' && st2.some((x) => /回頭檢查上一個答案：它引用了 2 段原文，其中 1 段/.test(x)), { c: res.corrected, st2 });

  // 提示詞：整理回答帶「NOT use/have」限制
  const t3 = Object.assign({}, H); t3.advancedSettings = {}; let prompt = null;
  t3._callSimpleCompletion = async () => ''; t3._kiRun = async (fn) => fn({ detail: async () => ({ lines: [] }) });
  t3._kiLlm = async (p) => { prompt = p; return 'GB300 有 Grace CPU [1]'; };
  await t3._kiAnswerAI('GB300 的特色', [{ source: 'GB300 Overview', source_id: 1, quote: 'The GB300 has a Grace CPU', label: 'x', line_start: 1, line_end: 1 }], null, null, { avoid: ['ast2700'] });
  check('prompt: 帶 NOT use/have 限制', /NOT use\/have：ast2700/.test(prompt), prompt && prompt.slice(-200));
  prompt = null; await t3._kiAnswerAI('GB300 的特色', [{ source: 'GB300 Overview', source_id: 1, quote: 'The GB300 has a Grace CPU', label: 'x', line_start: 1, line_end: 1 }], null, null);
  check('prompt: 沒有否定就沒有限制', prompt && !/NOT use/.test(prompt));

  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'knowledge_negation: ' + ok + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((x) => { console.error(x); process.exit(1); });
