// node scripts/deck-tests/deck_quiz_slide.test.js -- 問答頁的把關：標題不能洩漏答案、問「這個東西」的頁面一定要有畫面（工具端會退回重寫）。
const Core = require('../../renderer/src/deck/deck_core.js');
const Tools = require('../../renderer/src/deck/deck_tools.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const mk = (title, visual) => Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [{ title: '開場', narration: '大家好。' }, { title, narration: '請作答。', visual }] }] }), yaml);
const strict = (d) => (d.warnings || []).map((w) => (typeof w === 'string' ? w : (w.message || JSON.stringify(w)))).filter((w) => Tools.STRICT_WARNING.test(w));
const card = { kind: 'quiz', type: 'choice', question: '這個物品的注音是？', options: ['ㄅ', 'ㄆ', 'ㄇ'], answer: 0 };
const pic = { kind: 'svg', svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' };
check('title that contains the answer is refused', strict(mk('ㄅ - 蘋果', { kind: 'group', items: [{ box: [0, 0, 0.5, 1], ...pic }, { box: [0.55, 0, 0.45, 1], ...card }] })).length === 1);
check('a neutral title is fine', strict(mk('第 1 題', { kind: 'group', items: [{ box: [0, 0, 0.5, 1], ...pic }, { box: [0.55, 0, 0.45, 1], ...card }] })).length === 0);
check('a card alone asking about "this thing" is refused', strict(mk('第 1 題', card)).length === 1);
check('a question that needs no picture is fine alone', strict(mk('第 1 題', { kind: 'quiz', type: 'choice', question: '一年有幾個月？', options: ['十', '十二'], answer: 1 })).length === 0);
check('one-letter answers (A / 1) do not trip the title check', strict(mk('Plan A', { kind: 'group', items: [{ box: [0, 0, 0.5, 1], ...pic }, { box: [0.55, 0, 0.45, 1], kind: 'quiz', type: 'choice', question: 'Which is shown?', options: ['A', 'B'], answer: 0 }] })).length === 0);
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'deck_quiz_slide: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
