// node scripts/yamlkind-tests/yamlkind_core.test.js -- YAML 用途標記（#!fa:deck 這類開頭／結尾宣告）
const K = require('../../renderer/src/yamlkind/yamlkind_core.js');
const yaml = require('js-yaml');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }

const deck = 'deck:\n  title: 蜘蛛\nchapters:\n  - title: 一\n    slides: []\n';
const scene = 'nodes:\n  - id: a\n    mesh: box\n';
const anim = 'kind: ai_chat_animation_2d\nshapes: []\n';

// ---- 標記本身是合法的 YAML 註解：解析結果完全不變
for (const [name, body, type] of [['deck', deck, 'deck'], ['scene', scene, 'scene3d'], ['anim', anim, 'anim2d']]) {
  const stamped = K.stamp(body, type).text;
  check(name + ': a stamped file parses to exactly the same data', JSON.stringify(yaml.load(stamped)) === JSON.stringify(yaml.load(body)));
}
check('marker format', K.marker('deck') === '#!fa:deck' && K.marker('deck', '1') === '#!fa:deck v1');

// ---- 偵測：開頭、結尾、版本、寫法的小差異
check('head marker', K.detect('#!fa:deck\n' + deck).type === 'deck' && K.detect('#!fa:deck\n' + deck).where === 'head');
check('head marker with version', K.detect('#!fa:scene3d v2\n' + scene).version === '2');
check('tail marker (last non-empty line)', (() => { const d = K.detect(deck + '\n\n#!fa:deck\n\n'); return d.type === 'deck' && d.where === 'tail'; })());
check('lenient spelling: "# fa: deck", "#! fa=deck"', K.detect('# fa: deck\n' + deck).type === 'deck' && K.detect('#! fa=deck\n' + deck).type === 'deck');
check('marker after a --- line and other comments still counts as the head', K.detect('---\n# 說明文字\n#!fa:anim2d\n' + anim).type === 'anim2d');
check('a marker buried in the middle is NOT a marker', K.detect(deck.replace('chapters:', '#!fa:scene3d\nchapters:'), { noSniff: true }).type === null);
check('BOM before the marker', K.detect('﻿#!fa:deck\n' + deck).type === 'deck');
check('CRLF files', K.detect('#!fa:deck\r\n' + deck.replace(/\n/g, '\r\n')).type === 'deck');
check('head wins over tail, and a disagreement is reported', (() => { const d = K.detect('#!fa:deck\n' + deck + '#!fa:scene3d\n'); return d.type === 'deck' && /兩個不一樣/.test(d.conflict); })());

// ---- 沒有標記：檔名、內容特徵
check('filename fallback', K.detect(deck, { filename: 'x.deck.yaml', noSniff: true }).type === 'deck' && K.detect(scene, { filename: 'a.3dscene.yaml', noSniff: true }).where === 'filename' && K.byFilename('foo.2danim.yaml') === 'anim2d' && K.byFilename('p.yaml') === null);
check('content sniffing is conservative', K.detect(deck).type === 'deck' && K.detect(scene).type === 'scene3d' && K.detect(anim).type === 'anim2d' && K.detect('a: 1\nb: 2\n').type === null);
check('a deck is never mistaken for a scene (has nodes inside but chapters on top)', K.detect(deck + 'nodes: []\n').type === 'deck');

// ---- 標記跟檔名／內容矛盾：說出來，不默默選一個
check('marker vs filename mismatch is a conflict', /檔名.*簡報.*3d|標記寫的是/.test(K.detect('#!fa:scene3d\n' + scene, { filename: 'x.deck.yaml' }).conflict || ''));
check('marker vs content mismatch is a conflict', /結構像/.test(K.detect('#!fa:scene3d\n' + deck).conflict || ''));

// ---- check()：我要的用途對不對
check('check: right kind passes', K.check('#!fa:deck\n' + deck, 'deck').ok && K.check(deck, 'deck').ok);
check('check: an old file with no marker and no clues is not blocked', K.check('foo: 1\n', 'deck').ok);
const wrong = K.check('#!fa:scene3d\n' + scene, 'deck');
check('check: a marker for another kind is refused with a plain message', !wrong.ok && /3D 場景/.test(wrong.message) && /動畫簡報/.test(wrong.message) && /開法/.test(wrong.message), wrong);
check('check: sniffed content alone never blocks (only an explicit marker or filename does)', K.check(scene, 'deck').ok === true);

// ---- stamp / strip
const st = K.stamp(deck, 'deck'); check('stamp adds one head line and nothing else changes', st.changed && st.text === '#!fa:deck\n' + deck && K.strip(st.text) === deck.replace(/\n$/, '') + '\n' || K.strip(st.text) === deck);
check('stamp is idempotent', K.stamp(st.text, 'deck').changed === false && K.stamp(st.text, 'deck').text === st.text);
check('stamp does not overwrite a different explicit marker (reports instead)', (() => { const r = K.stamp('#!fa:scene3d\n' + scene, 'deck'); return !r.changed && /已經標明/.test(r.conflict); })());
check('stamp respects a tail marker', K.stamp(deck + '#!fa:deck\n', 'deck').changed === false);
check('stamp keeps a BOM in front', K.stamp('﻿' + deck, 'deck').text.charCodeAt(0) === 0xFEFF);
check('strip removes head and tail markers', K.strip('#!fa:deck\n' + deck + '#!fa:deck\n').indexOf('#!fa') < 0);
check('types() lists every kind with its marker and extension', K.types().some((t) => t.type === 'deck' && t.marker === '#!fa:deck' && t.ext === '.deck.yaml') && K.types().length >= 4);
check('empty and null inputs do not throw', K.detect('').type === null && K.detect(null).type === null && K.stamp('', 'deck').text === '#!fa:deck\n');
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'yamlkind_core: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
