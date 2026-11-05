// 累積：使用者確認過的說法進記憶後，換個動詞再說一次，程式端直接命中；沒記憶時不命中。另外：只有一個詞結尾的字（簡報的「報」）不算類別字。
const G = require('../renderer/src/offline/intent_gate.js');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else fail++; console.log((c ? 'ok   ' : 'FAIL ') + m); };
const pk = (t, memory) => { const p = G.pickDerived(G.deriveTool(t, [], { memory })); return p && p.kind; };
const s = '叫出那份蓋章簿';
ok(pk('幫我打開蓋章簿', {}) === null, '前提：沒學過的詞程式端不亂猜');
const mem = { ['s:' + G.memKey(s)]: 'kind:xlsx' };
ok(pk('幫我打開蓋章簿', mem) === 'xlsx', '使用者確認過一次後，換個動詞再說也直接命中');
ok(pk('調出今天的天氣', mem) !== 'xlsx', '學到的詞不會把無關的句子帶過去');
ok(pk('把那份財報叫出來', {}) !== 'deck', '「財報」不會因為簡報的「報」被當成簡報');
console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
