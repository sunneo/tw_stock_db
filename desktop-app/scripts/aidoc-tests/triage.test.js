// node scripts/aidoc-tests/triage.test.js  — log triage recipe: the index is the judge, a model's letter is verified, never trusted
var TR = require('../../renderer/src/aidoc/triage.js');
var pass = 0, fail = 0;
function eq(a, b, name) { var x = JSON.stringify(a), y = JSON.stringify(b); if (x === y) { pass++; } else { fail++; console.log('FAIL ' + name + '\n  got  ' + x + '\n  want ' + y); } }

var LOGMSG = '無法連線到伺服器，請稍後再試';
var text = [
  '為什麼會出現這個錯誤？',
  'Oct 29 10:00:01 host app[12]: ' + LOGMSG,
  '#0  0x00007ffff7a2d1c9 in connect_server (a=1) at src/net.c:123',
  '今天的服務狀況看起來不太穩定',
  '',
].join('\n');
var hooks = { logHit: function (msg) { return Promise.resolve(msg.indexOf(LOGMSG) >= 0); } };

(async function () {
  var items = await TR.classify(text, hooks);
  eq(items.map(function (x) { return x.cls; }), ['A', 'B', 'C', '?'], 'question=A (rule), index-verified Chinese log=B, frame=C, an undecided Chinese sentence stays ?');
  eq(items[1].by, 'index', 'the log verdict comes from the index');

  eq(TR.letterOf('B'), 'B', 'letter: plain');
  eq(TR.letterOf('答：C.'), 'C', 'letter: inside a reply');
  eq(TR.letterOf('不知道'), '', 'letter: none');

  var q = items[3];
  var a = await TR.applyAnswer(q, 'B', hooks);
  eq([a.cls, a.by], ['A', 'overruled'], 'a model that says B for a line the index does not know is overruled');
  var b = await TR.applyAnswer(q, 'A', hooks);
  eq([b.cls, b.by], ['A', 'model'], 'A is accepted');
  var c = await TR.applyAnswer(q, 'C', hooks);
  eq([c.cls, c.by], ['A', 'overruled'], 'a model that says C for a non-frame is overruled');
  var d = await TR.applyAnswer(Object.assign({}, q, { msg: LOGMSG }), 'B', hooks);
  eq([d.cls, d.by], ['B', 'model'], 'B is accepted when the index knows the message');
  var e = await TR.applyAnswer(q, '不知道', hooks);
  eq(e.cls, '?', 'no letter -> still undecided');

  var seen = [];
  var run = await TR.run(text, hooks, function (p) { seen.push(p); return Promise.resolve('A'); });
  eq(run.map(function (x) { return x.cls; }), ['A', 'B', 'C', 'A'], 'run: only the undecided line goes to the model');
  eq(seen.length, 1, 'run: one question for one undecided line');
  eq(TR.summary(run), { A: 2, B: 1, C: 1, '?': 0, skip: 0 }, 'summary');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
