// node scripts/tts-tests/voice_recording.test.js -- 錄音聲音樣本：念稿、品質檢查、修剪、重採樣、WAV、匯出說明
const R = require('../../renderer/src/tts/voice_recording.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
// 假的「講話」：不同頻率疊起來、有起伏；噪音用固定亂數
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
function speech(sec, sr, amp, noise) { const n = Math.round(sec * sr), a = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / sr, env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t); a[i] = amp * env * (Math.sin(2 * Math.PI * 180 * t) * 0.6 + Math.sin(2 * Math.PI * 540 * t) * 0.3 + Math.sin(2 * Math.PI * 1500 * t) * 0.1) + (noise || 0) * rnd(); } return a; }
function pad(a, sr, head, tail) { const o = new Float32Array(a.length + Math.round((head + tail) * sr)); o.set(a, Math.round(head * sr)); return o; }
const SR = 48000;

// ---- 念稿與語言
check('script: three sentences for each language, chinese ones contain chinese', R.script('zh').length === 3 && R.script('en').length === 3 && /[一-鿿]/.test(R.script('zh').join('')) && !/[一-鿿]/.test(R.script('en').join('')));
check('script: language words are understood', R.langOf('中文') === 'zh' && R.langOf('zh-TW') === 'zh' && R.langOf('English') === 'en' && R.langOf('') === 'en');

// ---- 取樣處理
check('mono: channels are averaged', (() => { const m = R.toMono([new Float32Array([1, 0]), new Float32Array([0, 1])]); return m[0] === 0.5 && m[1] === 0.5; })());
check('resample: 48k to 24k halves the length and keeps a slow sine', (() => { const a = new Float32Array(48000); for (let i = 0; i < a.length; i++) a[i] = Math.sin(2 * Math.PI * 100 * i / 48000); const b = R.resample(a, 48000, 24000); return b.length === 24000 && Math.abs(b[600] - Math.sin(2 * Math.PI * 100 * 600 / 24000)) < 0.02; })());
check('resample: same rate returns the same array', (() => { const a = new Float32Array(10); return R.resample(a, 24000, 24000) === a; })());
check('trim: silence at both ends is cut but 0.15s is kept', (() => { const a = pad(speech(3, SR, 0.5, 0), SR, 2, 2), t = R.trim(a, SR); return t.length < a.length * 0.6 && t.length > 3 * SR && t.length < 3.6 * SR; })());
check('trim: an all-zero recording is left alone', (() => { const a = new Float32Array(1000); return R.trim(a, SR).length === 1000; })());
check('normalize: peak goes to about 0.89 and a very quiet one is limited to 12x', (() => { const a = speech(1, SR, 0.2, 0), n = R.normalize(a); const q = R.normalize(new Float32Array([0.001, -0.001])); return Math.abs(R.peakOf(n) - 0.89) < 0.01 && Math.abs(q[0] - 0.012) < 1e-6; })());

// ---- 品質檢查
const good = R.analyze(R.trim(pad(speech(14, SR, 0.5, 0.004), SR, 0.5, 0.5), SR), SR);
check('analyze: a clean 14 second recording is fine', good.ok && good.issues.length === 0 && good.durationSec > 13, good);
check('analyze: under 5 seconds is a bad recording, 5 to 10 is a warning', !R.analyze(speech(3, SR, 0.5, 0.004), SR).ok && (() => { const r = R.analyze(speech(7, SR, 0.5, 0.004), SR); return r.ok && r.issues.some((x) => x.level === 'warn' && /偏短/.test(x.text)); })());
check('analyze: clipping is detected', (() => { const a = speech(12, SR, 3, 0.004).map((x) => Math.max(-1, Math.min(1, x))); const r = R.analyze(a, SR); return !r.ok && r.issues.some((x) => /爆/.test(x.text)) && r.clippedPct > 0.5; })());
check('analyze: lots of noise is a bad recording', (() => { const r = R.analyze(speech(12, SR, 0.2, 0.5), SR); return !r.ok && r.issues.some((x) => /噪音/.test(x.text)); })());
check('analyze: a very quiet voice gets a warning about volume', (() => { const r = R.analyze(speech(12, SR, 0.01, 0.00002), SR); return r.issues.some((x) => /音量偏小/.test(x.text)); })());
check('analyze: nothing but silence is a bad recording', (() => { const a = new Float32Array(SR * 12); a[100] = 0.4; const r = R.analyze(a, SR); return !r.ok; })());
check('analyze: very long gets a trim suggestion', R.analyze(speech(130, 8000, 0.5, 0.004), 8000).issues.some((x) => /很長/.test(x.text)));

// ---- 總流程
check('prepare: output is 24kHz, normalized, and trimmed shorter than the input', (() => { const inp = pad(speech(10, SR, 0.3, 0.004), SR, 1.5, 1.5), p = R.prepare(inp, SR); return p.rate === 24000 && p.samples.length < inp.length / 2 && Math.abs(R.peakOf(p.samples) - 0.89) < 0.02 && p.report.durationSec > 9; })());

// ---- WAV
check('wav: header fields and size', (() => { const w = R.wav(new Float32Array([0, 0.5, -0.5, 1]), 24000), dv = new DataView(w.buffer); return String.fromCharCode(w[0], w[1], w[2], w[3]) === 'RIFF' && w.length === 52 && dv.getUint32(24, true) === 24000 && dv.getUint16(22, true) === 1 && dv.getUint16(34, true) === 16; })());
check('wav: write then read gives back the samples within 16-bit precision', (() => { const a = speech(1, 24000, 0.5, 0.01), r = R.parseWav(R.wav(a, 24000)); return r.ok && r.rate === 24000 && r.channels.length === 1 && r.channels[0].length === a.length && Math.abs(r.channels[0][5000] - a[5000]) < 0.001; })());
check('wav: garbage and unsupported formats are refused with a reason', !R.parseWav(new Uint8Array(100)).ok && (() => { const w = R.wav(new Float32Array(10), 24000); new DataView(w.buffer).setUint16(20, 6, true); const r = R.parseWav(w); return !r.ok && /不支援/.test(r.error); })());

// ---- 匯出說明
check('meta: carries the transcript and usage hints for the common engines', (() => { const m = R.meta({ name: '我的聲音', lang: 'zh', transcript: '你好', durationSec: 12, file: 'a.wav' }); return m.format === 'fa-voice-recording' && m.sampleRate === 24000 && m.transcript === '你好' && /sample_audio_speaker/.test(m.usage.ChatTTS) && /speaker_wav/.test(m.usage.XTTS) && m.file === 'a.wav'; })());
check('filename: unsafe characters are replaced and it is never empty', R.safeFilename('我的/聲音: x?') === '我的_聲音_x' && R.safeFilename('///') === 'voice');

console.log('voice_recording: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : ''));
process.exit(bad.length ? 1 : 0);
