// node scripts/tts-tests/pronunciation.test.js -- 發音字典與行內讀法
const P = require('../../renderer/src/tts/pronunciation.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

check('normalize: an object or pairs become a clean map; empty, same-as-reading and duplicate entries are dropped, over-long ones are cut; braces and bars are removed', (() => {
  const a = P.normalize({ '長高高': '掌高高', '': 'x', '好': '好', '行': '航', 'a{b|c}': 'd' }), b = P.normalize([['長高高', '掌高高'], ['長高高', '別的'], ['x'.repeat(40), 'y']]);
  return a['長高高'] === '掌高高' && a['行'] === '航' && !('' in a) && !('好' in a) && a['a b c'] === 'd' && b['長高高'] === '掌高高' && Object.keys(b).length === 2 && Object.keys(b).some((k) => k === 'x'.repeat(20)) && Object.keys(P.normalize(null)).length === 0;
})());
check('normalize: at most 200 entries', Object.keys(P.normalize(Array.from({ length: 300 }, (_, i) => ['詞' + i, '讀' + i]))).length === 200);
const d = P.normalize({ '長高高': '掌高高', '長高': '掌高', '行長': '航長' });
check('applyDict: replaces the phrase; the longer phrase wins; a replaced text is not replaced again; no entries leaves the text alone', P.applyDict('小明長高高了，行長來了，長高了', d) === '小明掌高高了，航長來了，掌高了' && P.applyDict('abc', {}) === 'abc' && P.applyDict(null, d) === '' && P.applyDict('掌高高', { '掌高高': '長高高', '長高高': '掌高高' }) === '長高高');
check('applyDict: regular-expression characters in a phrase are taken literally', P.applyDict('a.b a+b', P.normalize({ 'a.b': 'X', 'a+b': 'Y' })) === 'X Y');
const il = P.inline('這個孩子{長|掌}高高了，真是{好|號}事');
check('inline: {shown|spoken} gives the subtitle text and the spoken text; text without marks is unchanged', il.shown === '這個孩子長高高了，真是好事' && il.spoken === '這個孩子掌高高了，真是號事' && il.changed && !P.inline('沒有標記').changed && P.inline('沒有標記').spoken === '沒有標記' && P.inline('{a}').changed === false);
check('inline: only short, single-line pairs count (code braces are left alone)', P.inline('var o = {a: 1};').changed === false && P.inline('x {a|b\nc}').changed === false);
check('parseCommand: list, delete, add with = or arrow or a space, and a usage error', P.parseCommand('').action === 'list' && P.parseCommand('list').action === 'list' && P.parseCommand('delete 長高高').phrase === '長高高' && P.parseCommand('刪除 長高高').action === 'delete'
  && P.parseCommand('長高高=掌高高').reading === '掌高高' && P.parseCommand('長高高 → 掌高高').phrase === '長高高' && P.parseCommand('長高高 掌高高').reading === '掌高高' && P.parseCommand('長=長').action === 'error' && P.parseCommand('只有一個詞很長很長很長').action === 'error');
console.log('pronunciation: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
