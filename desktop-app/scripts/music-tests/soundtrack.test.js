// node scripts/music-tests/soundtrack.test.js -- 配樂共用介面(規格整理、淡入淡出、循環鋪滿、解析快取與失敗重試、播放控制)
const S = require('../../renderer/src/music/soundtrack.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const B64 = 'TVRoZAAAAAYAAQABAeBNVHJrAAAABAD/LwA=';
check('normalize: rejects empty and incomplete specs', S.normalize(null) === null && S.normalize({}) === null && S.normalize({ kind: 'midi' }) === null && S.normalize({ kind: 'audio' }) === null);
const n = S.normalize({ kind: 'midi', midiB64: B64, volume: 9, fadeIn: -3 });
check('normalize: clamps volume and fades, defaults loop on', n && n.volume === 1 && n.fadeIn === 0 && n.loop === true && n.fadeOut === 2, n);
check('normalize: infers kind from fileId', S.normalize({ fileId: 'f1' }).kind === 'audio');
const sp = S.normalize({ kind: 'audio', fileId: 'f1', volume: 0.5, fadeIn: 2, fadeOut: 4 });
check('gainAt: fade in ramps from zero', S.gainAt(sp, 0, 20) === 0 && Math.abs(S.gainAt(sp, 1, 20) - 0.25) < 1e-9 && S.gainAt(sp, 2, 20) === 0.5);
check('gainAt: fade out ramps to zero at the end, none without a total', Math.abs(S.gainAt(sp, 18, 20) - 0.25) < 1e-9 && S.gainAt(sp, 20, 20) === 0 && S.gainAt(sp, 100, 0) === 0.5);
const src = [Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10))];
const spl = S.normalize({ kind: 'audio', fileId: 'f', volume: 1, fadeIn: 0, fadeOut: 0 });
const out = S.fill(src, 1000, 1000, 3, spl);
check('fill: loops to the full length and gives two channels', out.length === 2 && out[0].length === 3000 && Math.abs(out[0][1500]) > 0);
let maxJump = 0; for (let i = 1; i < 3000; i++) maxJump = Math.max(maxJump, Math.abs(out[0][i] - out[0][i - 1])); check('fill: no click at the loop seam', maxJump < 0.2, maxJump);
const once = S.fill(src, 1000, 1000, 3, S.normalize({ kind: 'audio', fileId: 'f', loop: false, fadeIn: 0, fadeOut: 0, volume: 1 }));
check('fill: without loop it plays once then silence', once[0][500] !== 0 && once[0][2000] === 0);
const rs = S.fill(src, 1000, 2000, 1, spl); check('fill: resamples to the output rate', rs[0].length === 2000);
const wv = S.wavBytes([Float32Array.of(0, 1, -1), Float32Array.of(0.5, 0, 0)], 8000), dvw = new DataView(wv.buffer);
check('wavBytes: header, stereo, 16-bit and length', String.fromCharCode(wv[0], wv[1], wv[2], wv[3]) === 'RIFF' && dvw.getUint16(22, true) === 2 && dvw.getUint32(24, true) === 8000 && wv.length === 44 + 12 && dvw.getInt16(44 + 2, true) === 16384 && dvw.getInt16(44 + 4, true) === 32767);
(async () => {
  let calls = 0, fail = true; const deps = { renderMidi: async () => { calls++; if (fail) { fail = false; throw new Error('boom'); } return { channels: [new Float32Array(2000), new Float32Array(2000)], sr: 1000 }; }, decodeAudio: async () => ({ channels: [new Float32Array(500)], sr: 500 }) };
  let err = null; try { await S.resolve({ kind: 'midi', midiB64: B64 }, deps); } catch (e) { err = e; }
  check('resolve: failure is not cached, a retry succeeds', err && (await S.resolve({ kind: 'midi', midiB64: B64 }, deps)).duration === 2 && calls === 2);
  await S.resolve({ kind: 'midi', midiB64: B64 }, deps); check('resolve: second call uses the cache', calls === 2);
  check('resolve: audio goes through decodeAudio', (await S.resolve({ kind: 'audio', fileId: 'x' }, deps)).duration === 1);
  const log = []; const ctx = { currentTime: 5, createBuffer: (c, l, r) => ({ getChannelData: () => ({ set() {} }), c, l, r }), createGain: () => ({ gain: { value: 1, setValueAtTime: (v, t) => log.push(['set', v, t]), linearRampToValueAtTime: (v, t) => log.push(['ramp', v, t]), cancelScheduledValues() {} }, connect() {} }), createBufferSource: () => ({ connect() {}, start: (t, o) => log.push(['start', t, o]), stop: (t) => log.push(['stop', t]) }) };
  const h = await S.start(ctx, {}, { kind: 'midi', midiB64: B64, volume: 0.4, fadeIn: 1 }, deps); h.stop(2);
  check('start: fades in from silence to the volume and stop ramps down then stops', log.some((l) => l[0] === 'ramp' && l[1] === 0.4 && l[2] === 6) && log.some((l) => l[0] === 'ramp' && l[1] === 0.0001 && l[2] === 7) && log.some((l) => l[0] === 'stop'), log);
  console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'OK'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
})();
