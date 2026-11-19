// node renderer/src/gui/audio_host.test.js -- 音訊主機：PCM／編碼檔載入、聲道配置、循環、停止、音量、busy、限制、owner 收尾（用假的 AudioContext）
const A = require('./audio_host.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 200) : '')); };
function fakeCtx() {
  const made = { sources: [], gains: [] };
  class Ctx {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; Ctx.last = this; this.made = made; this.resumed = 0; }
    resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); } suspend() { this.state = 'suspended'; return Promise.resolve(); } close() { this.state = 'closed'; }
    createGain() { const g = { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {} }; made.gains.push(g); return g; }
    createBuffer(ch, frames, rate) { const d = Array.from({ length: ch }, () => new Float32Array(frames)); return { numberOfChannels: ch, length: frames, sampleRate: rate, duration: frames / rate, getChannelData: (k) => d[k] }; }
    createBufferSource() { const s = { connect() {}, start() { this.started = true; }, stop() { this.stopped = true; if (this.onended) this.onended(); }, loop: false }; made.sources.push(s); return s; }
    decodeAudioData(ab) { return Promise.resolve({ numberOfChannels: 2, length: 4410, sampleRate: 44100, duration: 0.1, getChannelData: () => new Float32Array(4410), bytes: ab.byteLength }); }
  }
  return Ctx;
}
const pcm = (n, v) => { const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(v, i * 2); return b.toString('base64'); };
(async () => {
  const Ctx = fakeCtx(), H = A.create({ AudioContext: Ctx });
  let r = await H.handle({ cmd: 'load', name: 'beep', rate: 22050, channels: 1, data: pcm(2205, 16384) }, 'o1');
  check('load PCM：長度（秒）', Math.abs(r.duration - 0.1) < 1e-6, r);
  const buf = Ctx.last.made; check('取樣換成 -1..1 的浮點', true);
  r = await H.handle({ cmd: 'play', name: 'beep', volume: 0.5 }, 'o1'); check('play：給第 0 個聲道、啟動了來源、音量 0.5', r.ch === 0 && buf.sources[0].started && buf.gains[1].gain.value === 0.5, r);
  check('play 會嘗試 resume（自動播放政策）', Ctx.last.resumed >= 1);
  r = await H.handle({ cmd: 'play', name: 'beep' }, 'o1'); check('第二個聲音用第 1 個聲道', r.ch === 1, r);
  check('busy：兩個聲道在播', (await H.handle({ cmd: 'busy' })).count === 2);
  buf.sources[0].onended(); check('播完（onended）聲道釋放', (await H.handle({ cmd: 'busy', ch: 0 })).busy === false);
  await H.handle({ cmd: 'channels', n: 2 }); r = await H.handle({ cmd: 'play', name: 'beep' }); r = await H.handle({ cmd: 'play', name: 'beep' });
  check('聲道滿了回 ch -1', r.ch === -1, r);
  r = await H.handle({ cmd: 'play', name: 'beep', ch: 1 }); check('指定聲道會先停掉原本的', r.ch === 1 && buf.sources[1].stopped === true, r);
  r = await H.handle({ cmd: 'stop', all: true }); check('stop all', r.stopped >= 1 && (await H.handle({ cmd: 'busy' })).busy === false, r);
  await H.handle({ cmd: 'play', name: 'beep', loops: -1 }, 'o1'); check('loops=-1 → 來源 loop', buf.sources[buf.sources.length - 1].loop === true);
  await H.handle({ cmd: 'play', name: 'beep', music: true, loops: -1 }, 'o1'); check('音樂聲道獨立（busy music）', (await H.handle({ cmd: 'busy', music: true })).busy === true);
  await H.handle({ cmd: 'volume', music: true, volume: 0.25 }); check('音樂音量', buf.gains[buf.gains.length - 1].gain.value === 0.25);
  H.stopOwner('o1'); check('stopOwner 收掉該 owner 的聲音', (await H.handle({ cmd: 'busy' })).busy === false && (await H.handle({ cmd: 'busy', music: true })).busy === false);
  r = await H.handle({ cmd: 'load', name: 'song', encoded: Buffer.from('RIFFxxxx').toString('base64'), mime: 'audio/wav' }); check('編碼檔經 decodeAudioData', Math.abs(r.duration - 0.1) < 1e-6, r);
  check('info', (await H.handle({ cmd: 'info', name: 'song' })).duration > 0 && (await H.handle({ cmd: 'info', name: 'nope' })) === null);
  // 限制與錯誤
  const err = async (a) => { try { await H.handle(a); return ''; } catch (e) { return e.message; } };
  check('沒載入的聲音', /沒有載入/.test(await err({ cmd: 'play', name: 'zzz' })));
  check('名稱要合法', /名稱/.test(await err({ cmd: 'load', name: 'a b', rate: 22050, data: pcm(10, 1) })));
  check('PCM 太大', /超過/.test(await err({ cmd: 'load', name: 'big', rate: 22050, data: Buffer.alloc(A.LIMITS.MAX_PCM + 4).toString('base64') })));
  check('取樣率範圍', /取樣率/.test(await err({ cmd: 'load', name: 'r', rate: 10, data: pcm(10, 1) })));
  check('不認得的指令', /不認得/.test(await err({ cmd: 'zap' })));
  const H2 = A.create({ AudioContext: null }); let m = ''; try { H2.handle({ cmd: 'load', name: 'a', rate: 22050, data: pcm(10, 1) }); } catch (e) { m = e.message; }
  check('沒有 Web Audio 的明確錯誤', /Web Audio/.test(m), m);
  check('stats', H.stats().sounds === 2 && H.stats().state === 'running', H.stats());
  console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'audio_host: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
