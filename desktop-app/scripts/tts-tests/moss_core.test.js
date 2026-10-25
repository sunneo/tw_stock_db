// node scripts/tts-tests/moss_core.test.js -- MOSS-TTS-Nano 推論核心：切詞器（對照 python sentencepiece 的標準答案）、提示、生成迴圈（假 runners）、文字切段、重採樣
const fs = require('fs'), path = require('path');
const M = require('../../renderer/src/tts/moss_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const fx = path.join(__dirname, 'fixtures');
const model = M.parseModel(fs.readFileSync(path.join(fx, 'moss_tokenizer.model')));
const cases = JSON.parse(fs.readFileSync(path.join(fx, 'moss_tokenizer_cases.json'), 'utf8'));

// ---- 模型與切詞
check('model: 16384 pieces, <unk> is 0, 256 byte pieces, specials are in the vocabulary', model.pieces.length === 16384 && model.unk === 0 && model.byteId.filter((x) => x >= 0).length === 256 && model.map.get('<|im_start|>') === 4 && model.map.get('<|audio_start|>') === 6);
let same = 0; const diffs = [];
for (const c of cases) { const got = M.encode(model, c.text); if (JSON.stringify(got) === JSON.stringify(c.ids)) same++; else diffs.push({ text: c.text.slice(0, 40), got: got.slice(0, 12), want: c.ids.slice(0, 12) }); }
check('encode: matches the python sentencepiece on all ' + cases.length + ' cases (' + same + ' same)', same === cases.length, diffs.slice(0, 3));
check('encode: empty and blank text give no tokens', M.encode(model, '').length === 0 && M.encode(model, '   ').length === 0);
check('encode: the official sample sentences give the official token ids', (() => { const man = JSON.parse(fs.readFileSync(path.join(fx, 'moss_manifest_samples.json'), 'utf8')); return man.every((s) => JSON.stringify(M.encode(model, s.text)) === JSON.stringify(s.text_token_ids)); })());
check('normalize: fullwidth, newlines and runs of spaces are cleaned the way the model expects', M.normalize('ＡＢＣ １２３') === 'ABC 123' && M.normalize('a  b\nc') === 'a b c' && M.normalize('  x  ') === 'x');

// ---- 提示
const cfg = { audio_pad_token_id: 1024, im_start_token_id: 4, audio_start_token_id: 6, audio_end_token_id: 7, audio_user_slot_token_id: 8, audio_assistant_slot_token_id: 9 };
const tpl = { user_prompt_prefix_token_ids: [10, 11], user_prompt_after_reference_token_ids: [20, 21, 22], assistant_prompt_prefix_token_ids: [30, 31] };
const codes = [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]];
const pr = M.buildPrompt(cfg, tpl, codes, [100, 101]);
check('prompt: row count = im_start + prefix + audio_start + frames + audio_end + after + text + assistant + audio_start', pr.rows === 1 + 2 + 1 + 2 + 1 + 3 + 2 + 2 + 1 && pr.ids.length === pr.rows * 17);
check('prompt: text rows carry the token and pad the 16 audio channels', pr.ids[0] === 4 && pr.ids[1] === 1024 && pr.ids[16] === 1024 && pr.ids[17] === 10);
check('prompt: reference rows use the user slot token and the codes in order', (() => { const r = 1 + 2 + 1, o = r * 17; return pr.ids[o - 17] === 6 && pr.ids[o] === 8 && pr.ids[o + 1] === 1 && pr.ids[o + 16] === 16 && pr.ids[o + 17] === 8 && pr.ids[o + 18] === 17; })());
check('prompt: ends with the assistant prefix and an audio_start row', (() => { const n = pr.rows, g = (i, k) => pr.ids[i * 17 + k]; return g(n - 1, 0) === 6 && g(n - 2, 0) === 31 && g(n - 3, 0) === 30; })());
check('prompt: without a reference there is no audio block at all', (() => { const p2 = M.buildPrompt(cfg, tpl, null, [100]); return p2.rows === 1 + 2 + 3 + 1 + 2 + 1 && !Array.from(p2.ids).some((v, i) => i % 17 === 0 && (v === 8 || v === 7)); })());

// ---- 生成迴圈（假的 runners）
(async () => {
  const calls = { prefill: 0, decode: 0, sample: 0 }; const lens = [];
  const runners = {
    prefill: async (ids, rows) => { calls.prefill++; return { hidden: new Float32Array(768).fill(0.5), past: { n: rows } }; },
    decode: async (row, len, past) => { calls.decode++; lens.push(len); return { hidden: new Float32Array(768).fill(row[1] / 1000), past: { n: len + 1 } }; },
    sample: async (h, seen, u1, u2) => { calls.sample++; const n = calls.sample; return { cont: n <= 5, frame: Int32Array.from({ length: 16 }, (_, i) => (n * 10 + i) % 1024) }; },
  };
  const g = await M.generate(runners, cfg, pr, { maxFrames: 100, seed: 7 });
  check('generate: stops when the model says stop; five frames of sixteen codes in order', g.stopped === 'end' && g.count === 5 && g.frames.length === 80 && g.frames[0] === 10 && g.frames[16] === 20, { stopped: g.stopped, count: g.count });
  check('generate: one prefill, a decode step after every frame but the last one asked for, with the growing length', calls.prefill === 1 && calls.decode === 5 && lens[0] === pr.rows && lens[4] === pr.rows + 4, { calls, lens });
  const g2 = await M.generate({ prefill: runners.prefill, decode: runners.decode, sample: async () => ({ cont: true, frame: new Int32Array(16) }) }, cfg, pr, { maxFrames: 7 });
  check('generate: a model that never stops is cut at maxFrames', g2.stopped === 'max' && g2.count === 7);
  let seenAfter = null; await M.generate({ prefill: runners.prefill, decode: runners.decode, sample: async (h, seen) => { seenAfter = Int32Array.from(seen); return { cont: calls.sample++ % 3 !== 2, frame: Int32Array.from({ length: 16 }, (_, i) => i + 1) }; } }, cfg, pr, { maxFrames: 5 });
  check('generate: tokens already produced are marked per codebook for the repetition penalty', seenAfter && seenAfter[0 * 1024 + 1] === 1 && seenAfter[3 * 1024 + 4] === 1 && seenAfter[0 * 1024 + 2] === 0);
  let cancelAt = 0; const g3 = await M.generate({ prefill: runners.prefill, decode: runners.decode, sample: async () => ({ cont: true, frame: new Int32Array(16) }) }, cfg, pr, { maxFrames: 100, isCancelled: () => cancelAt++ >= 2 });
  check('generate: cancelling stops early', g3.stopped === 'cancel' && g3.count === 2);
  const u = []; await M.generate({ prefill: runners.prefill, decode: runners.decode, sample: async (h, s, u1, u2) => { u.push(u1[0], u2[0]); return { cont: u.length < 6, frame: new Int32Array(16) }; } }, cfg, pr, { seed: 99, maxFrames: 5 });
  const u_ = []; await M.generate({ prefill: runners.prefill, decode: runners.decode, sample: async (h, s, u1, u2) => { u_.push(u1[0], u2[0]); return { cont: u_.length < 6, frame: new Int32Array(16) }; } }, cfg, pr, { seed: 99, maxFrames: 5 });
  check('generate: the same seed gives the same random numbers', JSON.stringify(u) === JSON.stringify(u_) && u.every((x) => x >= 0 && x < 1));

  // ---- 文字切段
  check('split: short text stays one piece', JSON.stringify(M.splitText('Hello there. How are you?', 220, 70)) === JSON.stringify(['Hello there. How are you?']));
  const long = Array.from({ length: 40 }, (_, i) => 'This is sentence number ' + i + ' of a long text.').join(' ');
  const parts = M.splitText(long, 220, 70);
  check('split: long english text is cut at sentence ends into pieces under the limit, nothing lost', parts.length > 3 && parts.every((p) => p.length <= 224) && parts.join(' ').replace(/\s+/g, ' ') === long, { n: parts.length, max: Math.max(...parts.map((p) => p.length)) });
  const zh = Array.from({ length: 30 }, (_, i) => '这是第' + i + '句很长的中文句子，用来测试切段。').join('');
  const zp = M.splitText(zh, 220, 70); check('split: chinese is cut by the smaller chinese limit and nothing is lost', zp.length > 3 && zp.every((p) => p.length <= 72) && zp.join('') === zh, { n: zp.length, max: Math.max(...zp.map((p) => p.length)) });
  check('split: empty text gives nothing', M.splitText('   ', 220, 70).length === 0);
  check('split: one huge word with no spaces is still cut', M.splitText('x'.repeat(500), 220, 70).every((p) => p.length <= 221));

  // ---- 重採樣與波形
  const sine = (hz, rate, sec) => Float32Array.from({ length: Math.round(rate * sec) }, (_, i) => Math.sin(2 * Math.PI * hz * i / rate));
  const up = M.resample(sine(440, 24000, 1), 24000, 48000), dn = M.resample(sine(440, 48000, 1), 48000, 24000);
  check('resample: lengths follow the ratio and a sine keeps its shape', up.length === 48000 && dn.length === 24000 && Math.abs(up[10000] - Math.sin(2 * Math.PI * 440 * 10000 / 48000)) < 0.01 && Math.abs(dn[5000] - Math.sin(2 * Math.PI * 440 * 5000 / 24000)) < 0.01);
  check('resample: going down removes frequencies above the new Nyquist instead of folding them back', (() => { const hi = M.resample(sine(20000, 48000, 0.5), 48000, 24000); let m = 0; for (let i = 1000; i < hi.length - 1000; i++) m = Math.max(m, Math.abs(hi[i])); return m < 0.05; })());
  const ci = M.toCodecInput(sine(300, 24000, 0.5), 24000);
  check('codec input: 48kHz, the same signal in both channels', ci.length === 24000 && ci.data.length === 48000 && ci.data[5] === ci.data[24000 + 5]);
  const co = new Float32Array(2 * 100); co.fill(0.25, 0, 100); co.fill(0.75, 100); const mono = M.fromCodecOutput(co, 100, 0);
  check('codec output: the two channels are averaged, and it can be brought to another rate', mono.length === 100 && Math.abs(mono[3] - 0.5) < 1e-6 && M.fromCodecOutput(co, 100, 24000).length === 50);
  check('trim codes: long references are cut to 250 frames (20 seconds)', M.trimPromptCodes(new Array(400).fill([0]), 250).length === 250 && M.trimPromptCodes([[1]], 250).length === 1);

  console.log('moss_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : ''));
  process.exit(bad.length ? 1 : 0);
})();
