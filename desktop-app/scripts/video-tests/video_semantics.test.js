// node scripts/video-tests/video_semantics.test.js -- the video DOMAIN of the offline harness: decomposition, semantic derivation, the UML for the CoLU wiring
const FH = require('../../renderer/src/harness/intent_harness.js'), S = require('../../renderer/src/video/video_semantics.js'); let fail = 0; const eq = (n, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL', n, JSON.stringify(a), '!=', JSON.stringify(b)); } else console.log('ok  ', n); };
const st = { duration: 60, now: 12, cues: [{ start: 5, end: 10, text: 'a' }, { start: 12, end: 20, text: 'b' }, { start: 40, end: 50, text: 'c' }], clips: [{ in: 0, out: 20, name: 'x' }, { in: 0, out: 40, name: 'y' }] };
const d = (t, s) => S.decompose(t, s || st), a = (t) => d(t).intents.map((x) => [x.op, x.args]);
eq('first half', a('把前半段刪掉'), [['removeSegment', { start: 0, end: 30 }]]);
eq('last N seconds', a('剪掉最後 10 秒'), [['removeSegment', { start: 50, end: 60 }]]);
eq('head N seconds', a('去掉前 5 秒'), [['removeSegment', { start: 0, end: 5 }]]);
eq('middle', a('刪掉中間的部分'), [['removeSegment', { start: 20, end: 40 }]]);
eq('line range', a('刪除第 2 句那一段'), [['removeSegment', { start: 12, end: 20 }]]);
eq('gaps between lines', a('刪掉沒有字幕的地方').map((x) => x[1].start), [50, 20, 10, 0]);
eq('keep range', a('只保留 0:10 到 0:40'), [['removeSegment', { start: 40, end: 60 }], ['removeSegment', { start: 0, end: 10 }]]);
eq('keep first half', a('只留前半段'), [['removeSegment', { start: 30, end: 60 }]]);
eq('remove clip', a('刪掉第 2 個片段'), [['removeClip', { n: 2 }]]);
eq('remove line', a('刪掉第 3 句'), [['removeLine', { n: 3 }]]);
eq('split middle', a('在正中間切一刀'), [['splitClip', { at: 30 }]]);
eq('split at line start', a('在第 3 句開始處分割'), [['splitClip', { at: 40 }]]);
eq('transition', a('第 2 個片段加圓圈展開轉場 1.5 秒'), [['setTransition', { type: 'circle-open', n: 2, dur: 1.5 }]]);
eq('transcribe range every', a('從 0:10 到 0:40 每 10 秒辨識一次'), [['transcribeAudio', { start: 10, end: 40, every: 10 }]]);
eq('dub range', a('把 0:10 到 0:30 的逐字稿用英文配音'), [['dubLine', { n: 2, lang: 'en-US' }]]);
eq('dub quoted', a('在 0:05 用日文配音「你好」'), [['speakText', { text: '你好', start: 5, lang: 'ja-JP' }]]);
eq('several clauses', a('先在 0:30 分割，然後刪掉第 1 個片段，再加淡入淡出轉場').map((x) => x[0]), ['splitClip', 'removeClip', 'setTransition']);
eq('gap: no transition type', d('加個轉場').gaps.length, 1);
eq('gap: nothing said', d('刪掉').gaps.length, 1);
eq('derived is explained', d('刪除後半段').derived[0].indexOf('後半段') >= 0, true);
eq('unknown clause', d('今天天氣真好').intents.length, 0);
const u = S.toUml(d('在 0:30 分割，然後刪除 0:10 到 0:20').intents); eq('uml', u.split('\n').slice(2).map((x) => x.replace(/ \{.*/, '')), ['class VideoEditor', 'usecase Request: User -> VideoEditor.splitClip(at) -> VideoEditor.removeSegment(start,end)']);
// the extension point: another reasoner (e.g. NLP intent reasoning) goes in front of the frames
FH.registerReasoner('video', { id: 'nlp-test', priority: 50, decompose: (t) => /^NLP:/.test(t) ? { intents: [{ op: 'splitClip', args: { at: 1 }, derived: ['by nlp'], gaps: [] }] } : null });
eq('reasoner first', [d('NLP: whatever').via, d('NLP: whatever').intents[0].by], [['nlp-test'], 'nlp-test']); eq('frames still work', d('在 0:30 分割').via, ['frames']); FH.removeReasoner('video', 'nlp-test');
// calls from a (fake) binder answer: parameters are filled by NAME; a step the catalog could not wire falls back to the op's own tool
const dm = S.DOMAIN, r = d('在 0:30 分割，然後刪除 0:10 到 0:20'), cat = { units: [{ id: 'tool:video_split', name: 'video_split', params: [{ name: 'at', required: false }] }, { id: 'tool:video_cut_range', name: 'video_cut_range', params: [{ name: 'start', required: true }, { name: 'end', required: true }] }] };
let c = FH.callsOf(dm, r.intents, { results: [{ steps: [{ unit: 'tool:video_split', by: 'retrieval+contract' }, { unit: 'tool:video_cut_range', by: 'semantic+contract' }] }] }, cat); eq('calls wired', [c.wired, c.total, c.calls.map((x) => [x.tool, x.args])], [2, 2, [['video_split', { at: 30 }], ['video_cut_range', { start: 10, end: 20 }]]]);
c = FH.callsOf(dm, r.intents, { results: [{ steps: [{ unit: 'tool:video_split' }, { unit: null }] }] }, cat); eq('calls fallback', [c.wired, c.calls[1].by, c.calls[1].tool], [1, 'fallback', 'video_cut_range']);
console.log(fail ? fail + ' failed' : 'all passed'); process.exit(fail ? 1 : 0);
