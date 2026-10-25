// node scripts/tts-tests/voice_sample.test.js -- 聲音樣本（Kokoro 語音向量）：混合、可重現的隨機配方、代號、匯出入、斜線指令參數
const V = require('../../renderer/src/tts/voice_sample.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const vec = (f) => { const v = new Float32Array(V.FLOATS); for (let i = 0; i < v.length; i++) v[i] = f(i); return v; };
const A = vec((i) => Math.sin(i * 0.01)), B = vec((i) => Math.cos(i * 0.013)), C = vec((i) => (i % 7) / 7 - 0.5);

// ---- 大小與位元組
check('size: a voice is 510 x 256 float32 = 522240 bytes', V.BYTES === 522240 && V.FLOATS === 130560);
check('bytes: round trip keeps every float', (() => { const r = V.fromBytes(V.toBytes(A)); return r.ok && r.vec.length === V.FLOATS && r.vec[1234] === A[1234] && r.vec[V.FLOATS - 1] === A[V.FLOATS - 1]; })());
check('bytes: a wrong-sized file is rejected with the real size in the message', (() => { const r = V.fromBytes(new Uint8Array(1000)); return !r.ok && /522240/.test(r.error) && /1000/.test(r.error); })());
check('bytes: nonsense numbers are rejected', (() => { const b = V.toBytes(A); new DataView(b.buffer).setFloat32(8, NaN, true); return !V.fromBytes(b).ok; })());
check('base64: bytes round trip', (() => { const b = V.toBytes(B); const d = V.b64Decode(V.b64Encode(b)); return d.length === b.length && d[5] === b[5] && d[b.length - 1] === b[b.length - 1]; })());

// ---- 混合
check('mix: equal weights is the average', (() => { const r = V.mix([{ id: 'a', vec: A, weight: 1 }, { id: 'b', vec: B, weight: 1 }]); return r.ok && Math.abs(r.vec[100] - (A[100] + B[100]) / 2) < 1e-6; })());
check('mix: weights are normalized (2:1 equals 0.667:0.333)', (() => { const r = V.mix([{ id: 'a', vec: A, weight: 2 }, { id: 'b', vec: B, weight: 1 }]); return Math.abs(r.vec[100] - (A[100] * 2 / 3 + B[100] / 3)) < 1e-6 && r.parts[0].weight === 0.667; })());
check('mix: a single voice stays itself', (() => { const r = V.mix([{ id: 'a', vec: A, weight: 5 }]); return r.vec[77] === A[77]; })());
check('mix: spread above 1 pushes away from the average, below 1 pulls toward it', (() => { const base = V.mix([{ vec: A, weight: 3 }, { vec: B, weight: 1 }]).vec[300], avg = (A[300] + B[300]) / 2, out = V.mix([{ vec: A, weight: 3 }, { vec: B, weight: 1 }], 1.5).vec[300], inn = V.mix([{ vec: A, weight: 3 }, { vec: B, weight: 1 }], 0.5).vec[300]; return Math.abs(out - avg) > Math.abs(base - avg) && Math.abs(inn - avg) < Math.abs(base - avg); })());
check('mix: no usable voice or a silly spread is an error', !V.mix([]).ok && !V.mix([{ vec: A, weight: 0 }]).ok && !V.mix([{ vec: A, weight: 1 }], 9).ok);
check('mix: a vector of the wrong length is ignored, not crashed on', (() => { const r = V.mix([{ id: 'x', vec: new Float32Array(10), weight: 1 }, { id: 'a', vec: A, weight: 1 }]); return r.ok && r.vec[5] === A[5]; })());

// ---- 隨機配方：同一個種子同一個結果
const IDS = ['af_heart', 'af_sky', 'af_bella', 'am_adam', 'am_echo', 'bf_emma'];
check('random: the same seed gives the same recipe, a different seed a different one', (() => { const a = V.randomRecipe(42, IDS, 3), b = V.randomRecipe(42, IDS, 3), c = V.randomRecipe(43, IDS, 3); return JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(a) !== JSON.stringify(c); })());
check('random: picks distinct voices, weights sum to about 1 and none is tiny', (() => { const r = V.randomRecipe(7, IDS, 4); const sum = r.parts.reduce((s, p) => s + p.weight, 0); return new Set(r.parts.map((p) => p.id)).size === 4 && Math.abs(sum - 1) < 0.01 && r.parts.every((p) => p.weight >= 0.04); })());
check('random: asking for more than there are gives all of them; an empty list is an error', V.randomRecipe(1, ['a', 'b'], 5).parts.length === 2 && !V.randomRecipe(1, [], 3).ok);

// ---- 代號
check('id: english female starts with af_my, chinese male with zm_my, only lowercase letters', V.makeId('en', 'f', 'Cool Voice') === 'af_mycoolvoice' && V.makeId('zh', 'm', '老師', []) === 'zm_myvoice' && V.idOk(V.makeId('zh', 'f', 'Xiao-Ming 99')));
check('id: a clash with an existing id gets a letter suffix, never a digit', (() => { const a = V.makeId('en', 'f', 'mine', ['af_mymine']), b = V.makeId('en', 'f', 'mine', ['af_mymine', 'af_myminea']); return a === 'af_myminea' && /^af_mymine[a-z]+$/.test(b) && b !== a && b !== 'af_mymine'; })());
check('id: custom ids are recognised, built-in ones are not', V.isCustomId('af_mylaoshi') && V.isCustomId('zf_myvoice') && !V.isCustomId('af_heart') && !V.isCustomId('zf_xiaoxiao') && !V.isCustomId('bf_emma'));
check('id: language and gender words are understood in chinese and english', V.langOf('中文') === 'zh' && V.langOf('zh-TW') === 'zh' && V.langOf('english') === 'en' && V.genderOf('男') === 'm' && V.genderOf('female') === 'f' && V.genderOf('') === 'f');

// ---- 匯出入
check('package: export then import gives back the same vector and details', (() => { const p = V.makePackage({ name: '我的聲音', lang: 'zh', gender: 'm', vec: C, recipe: { parts: [{ id: 'zm_yunxi', weight: 1 }] } }); const r = V.readPackage(JSON.parse(JSON.stringify(p))); return r.ok && r.name === '我的聲音' && r.lang === 'zh' && r.gender === 'm' && r.vec[999] === C[999] && r.recipe.parts[0].id === 'zm_yunxi' && p.bytes === 522240; })());
check('package: wrong format, wrong model, broken data each get a clear error', !V.readPackage({}).ok && !V.readPackage({ format: V.FORMAT, model: 'chattts' }).ok && !V.readPackage({ format: V.FORMAT, vector_b64: 'AAAA' }).ok);
check('package: the vector inside is exactly the .bin you would export', (() => { const p = V.makePackage({ name: 'x', vec: A }); const raw = V.b64Decode(p.vector_b64); const b = V.toBytes(A); return raw.length === b.length && raw[1000] === b[1000]; })());

// ---- 試聽與 WAV
check('sample text: one sentence for each language', /你好/.test(V.sampleText('zh')) && /Hello/.test(V.sampleText('en')));
check('wav: header and length are right', (() => { const w = V.wav(new Float32Array([0, 0.5, -0.5, 1]), 24000); const dv = new DataView(w.buffer); return String.fromCharCode(w[0], w[1], w[2], w[3]) === 'RIFF' && w.length === 44 + 8 && dv.getUint32(24, true) === 24000 && dv.getInt16(46, true) === 16383; })());

// ---- 斜線指令參數
check('args: name words, lang, gender and a mix with weights', (() => { const a = V.parseCreateArgs('我的老師 lang=zh gender=男 mix=zf_xiaoxiao:0.7,zf_xiaoyi:0.3 seed=42 spread=1.2'); return a.name === '我的老師' && a.lang === 'zh' && a.gender === 'm' && a.mix.length === 2 && a.mix[0].weight === 0.7 && a.seed === 42 && a.spread === 1.2 && !a.errors.length; })());
check('args: random with a count and a quoted name', (() => { const a = V.parseCreateArgs('"My Voice" random lang=en count=4'); return a.name === 'My Voice' && a.random && a.count === 4 && a.lang === 'en'; })());
check('args: a bad mix, bad number or unknown key is reported, not ignored', (() => { const a = V.parseCreateArgs('x mix=hello seed=abc color=red'); return a.errors.length === 3; })());
check('args: play=0 turns the preview off; the default is to play it', V.parseCreateArgs('x play=0').play === false && V.parseCreateArgs('x').play === true);

console.log('voice_sample: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : ''));
process.exit(bad.length ? 1 : 0);
