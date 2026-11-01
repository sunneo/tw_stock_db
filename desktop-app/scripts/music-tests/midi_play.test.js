// node scripts/music-tests/midi_play.test.js -- playback scheduling (events, channel map, player with a fake synth and clock)
const M = require('../../renderer/src/music/midi_core.js');
const P = require('../../renderer/src/music/midi_play.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }

let s = M.emptySong(); s = M.setTempo(s, 120);
s = M.addTrack(s, '旋律', 0); s = M.addTrack(s, '鼓', 0, true); s = M.addTrack(s, '貝斯', 33);
[60, 62, 64, 65].forEach((n, i) => { s = M.addNote(s, 0, { t: i * 480, d: 480, n, v: 90 }); });
s = M.addNote(s, 1, { t: 0, d: 120, n: 36, v: 100 }); s = M.addNote(s, 2, { t: 0, d: 1920, n: 36, v: 100 });

const cm = P.channelMap(s);
check('channelMap: melodic tracks skip channel 9 and drums sit on 9', cm.map.join() === '0,9,1' && cm.dropped.length === 0);
check('channelMap: more than 15 melodic tracks drops the extra ones', (() => { let big = M.emptySong(); for (let i = 0; i < 17; i++) big = M.addTrack(big, 't' + i, 0, false); const c = P.channelMap(big); return c.dropped.length === 2 && c.map.filter((x) => x >= 0).length === 15 && !c.map.includes(9); })());

const ev = P.buildEvents(s);
check('events: sorted by time, program/cc first, off before on at the same instant', ev.every((e, i) => i === 0 || ev[i - 1].t <= e.t) && ev[0].type === 'prog' && (() => { const at = ev.filter((e) => e.t === 0.5 && e.ch === 0); return at[0].type === 'off' && at[1].type === 'on'; })());
check('events: times follow the tempo (480 ticks at 120 bpm = 0.5 s)', ev.find((e) => e.type === 'on' && e.ch === 0 && e.a === 62).t === 0.5);
check('events: a drum track sends no program change number other than 0', ev.filter((e) => e.type === 'prog' && e.ch === 9).every((e) => e.a === 0));
check('events: mute removes the notes but keeps setup; solo keeps only that track', (() => { const m = P.buildEvents(s, { mute: [0] }); const so = P.buildEvents(s, { solo: 2 }); return !m.some((e) => e.type === 'on' && e.ch === 0) && m.some((e) => e.type === 'prog' && e.ch === 0) && so.filter((e) => e.type === 'on').every((e) => e.ch === 1); })());

function fake() {
  const log = []; const now = { t: 10 };
  const synth = { noteOn: (c, n, v, o) => log.push(['on', c, n, v, o.time]), noteOff: (c, n, o) => log.push(['off', c, n, o.time]), programChange: (c, p, o) => log.push(['prog', c, p, o.time]), controllerChange: (c, cc, v, o) => log.push(['cc', c, cc, v, o.time]), stopAll: () => log.push(['stopAll']) };
  let cb = null;
  const pl = P.createPlayer(s, synth, { clock: () => now.t, setInterval: (f) => { cb = f; return 1; }, clearInterval: () => { cb = null; }, ahead: 0.25 });
  return { log, now, pl, tick: () => cb && cb() };
}

{
  const f = fake(); f.pl.play();
  check('play: events inside the look-ahead window are sent with absolute AudioContext times', f.log.some((l) => l[0] === 'on' && l[1] === 0 && l[2] === 60 && Math.abs(l[4] - 10.05) < 1e-9), f.log.filter((l) => l[0] === 'on'));
  check('play: events beyond the window are not sent yet', !f.log.some((l) => l[0] === 'on' && l[2] === 62));
  f.now.t = 10.4; f.tick();
  check('tick: the next note (0.5 s into the song) is scheduled once it enters the window', f.log.some((l) => l[0] === 'on' && l[2] === 62 && Math.abs(l[4] - 10.55) < 1e-9));
  f.now.t = 11.0; check('position follows the clock', Math.abs(f.pl.position() - 0.95) < 1e-9, f.pl.position());
  f.pl.pause();
  check('pause: stops all voices and freezes the position', f.log.some((l) => l[0] === 'stopAll') && Math.abs(f.pl.position() - 0.95) < 1e-9 && !f.pl.isPlaying());
  f.log.length = 0; f.now.t = 20; f.pl.play();
  check('resume: starts from the frozen position with setup events replayed and no old notes', f.log.some((l) => l[0] === 'prog' && l[1] === 1) && !f.log.some((l) => l[0] === 'on' && l[2] === 60));
}
{
  const f = fake(); f.pl.seek(1.5); f.pl.play();
  check('seek while stopped: playback begins at that point (the note at 1.5 s plays, earlier ones do not)', f.log.some((l) => l[0] === 'on' && l[2] === 65) && !f.log.some((l) => l[0] === 'on' && l[2] === 60), f.log.filter((l) => l[0] === 'on'));
}
{
  const f = fake(); let ended = 0; f.pl.onEnd(() => ended++); f.pl.play();
  for (let t = 10; t < 14; t += 0.2) { f.now.t = t; f.tick(); }
  check('end: after the last note the player stops by itself and calls onEnd once', ended === 1 && !f.pl.isPlaying() && f.pl.position() === 0, { ended, pos: f.pl.position() });
  check('end: every note-on has a matching note-off', f.log.filter((l) => l[0] === 'on').length === f.log.filter((l) => l[0] === 'off').length);
}
{
  const f = fake(); f.pl.play(); f.log.length = 0; f.pl.setMute(0, true);
  check('mute while playing restarts the schedule without that track', f.pl.isPlaying() && f.log.some((l) => l[0] === 'stopAll') && !f.log.some((l) => l[0] === 'on' && l[1] === 0));
  f.log.length = 0; f.pl.setTrackVolume(2, 0.5);
  check('track volume scales the volume controller on the track channel', f.log.length === 1 && f.log[0][0] === 'cc' && f.log[0][1] === 1 && f.log[0][2] === 7 && f.log[0][3] === 50, f.log);
}
{
  const f = fake(); f.pl.setLoop(true); f.pl.play();
  for (let t = 10; t < 13.4; t += 0.2) { f.now.t = t; f.tick(); }
  check('loop: the player keeps playing past the end instead of stopping', f.pl.isPlaying());
}

// 分片音色庫:每片核對長度與檢查碼,合併後核對總大小;壞片與缺片要報得出原因
(async () => {
  const crypto = require('crypto'); if (!global.crypto || !global.crypto.subtle) global.crypto = crypto.webcrypto;
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const data = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2500, 7)]), pb = 1000, parts = []; for (let o = 0; o < data.length; o += pb) parts.push(data.subarray(o, o + pb));
  const man = { files: [{ path: 'x.sf2', size: data.length, sha256: sha(data), parts: parts.length, partSize: parts.map((p) => p.length), partSha256: parts.map(sha) }] };
  const mkFetch = (over) => async (u) => { if (u.endsWith('manifest.json')) return { ok: true, json: async () => man }; const m = /\.part(\d+)$/.exec(u); if (!m) return { ok: false, status: 404 }; const i = Number(m[1]); const b = over && i in over ? over[i] : parts[i]; if (b === null) return { ok: false, status: 404 }; return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
  const msgs = []; const buf = await P.fetchParts({ base: 'https://h/x/', path: 'x.sf2' }, (m) => msgs.push(m), mkFetch());
  check('sharded bank: parts merge back to the original bytes', Buffer.from(buf).equals(data) && msgs.length === 3, msgs);
  let err = ''; try { await P.fetchParts({ base: 'https://h/x/', path: 'x.sf2' }, () => {}, mkFetch({ 1: Buffer.alloc(1000, 9) })); } catch (e) { err = e.message; } check('sharded bank: a corrupted part is rejected by its checksum', /第 2 片檢查碼不符/.test(err), err);
  err = ''; try { await P.fetchParts({ base: 'https://h/x/', path: 'x.sf2' }, () => {}, mkFetch({ 2: Buffer.alloc(400, 7) })); } catch (e) { err = e.message; } check('sharded bank: a short part is rejected by its length', /長度不符/.test(err), err);
  err = ''; try { await P.fetchParts({ base: 'https://h/x/', path: 'x.sf2' }, () => {}, mkFetch({ 0: null })); } catch (e) { err = e.message; } check('sharded bank: a missing part reports HTTP status', /HTTP 404/.test(err), err);
  const buf2 = await P.fetchBank([{ base: 'https://h/x/', path: 'nope.sf2' }, 'https://h/y.sf2'], () => {}, async (u) => (u.endsWith('manifest.json') ? { ok: true, json: async () => man } : { ok: true, headers: { get: () => String(data.length) }, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) }));
  check('sharded bank: falls back to the next source when the manifest lacks the file', Buffer.from(buf2).equals(data));
// ── 清掉混音(使用者回報:播完、暫停、清除對話後音符會卡住變無窮迴圈) ──
// 模擬 SpessaSynth:帶時間的 noteOn／noteOff 先排進佇列,時間到了才生效;stopAll(true) 只關掉「當下正在響」的音,取消不了佇列裡還沒到時間的事件
function sim() {
  const q = [], voices = new Map(), now = { t: 10 }; let seq = 0;
  const key = (c, n) => c + ':' + n;
  const apply = (e) => { if (e.k === 'on') voices.set(key(e.c, e.n), (voices.get(key(e.c, e.n)) || 0) + 1); else if (e.k === 'off') { const v = voices.get(key(e.c, e.n)); if (v) { if (v <= 1) voices.delete(key(e.c, e.n)); else voices.set(key(e.c, e.n), v - 1); } } else if (e.k === 'allOff') { for (const k of Array.from(voices.keys())) if (k.startsWith(e.c + ':')) voices.delete(k); } };
  const push = (e, time) => { e.time = time == null ? now.t : time; e.seq = seq++; q.push(e); };
  const synth = {
    noteOn: (c, n, v, o) => push({ k: 'on', c, n }, o && o.time), noteOff: (c, n, o) => push({ k: 'off', c, n }, o && o.time), programChange() {},
    controllerChange: (c, cc, v, o) => { if (cc === 120 || cc === 123) push({ k: 'allOff', c }, o && o.time); },
    stopAll: () => { voices.clear(); stops++; }
  };
  let stops = 0;
  // 時間往前走到 t:處理佇列裡 time<=t 的事件
  const advance = (t) => { now.t = t; q.sort((a, b) => a.time - b.time || a.seq - b.seq); while (q.length && q[0].time <= t) apply(q.shift()); };
  return { synth, now, advance, sounding: () => Array.from(voices.values()).reduce((a, b) => a + b, 0), queued: () => q.length, stops: () => stops };
}
function mk(song, o) {
  const sm = sim(); let timers = [], cb = null, guards = [];
  const group = o && o.group;
  const pl = P.createPlayer(song, sm.synth, { clock: () => sm.now.t, setInterval: (f) => { cb = f; return 1; }, clearInterval: () => { cb = null; }, ahead: 0.25, group, setTimeout: (f) => { guards.push(f); return guards.length; }, clearTimeout: () => {} });
  return { sm, pl, tick: () => cb && cb(), runGuards: () => { const g = guards; guards = []; g.forEach((f) => f()); }, hasTimer: () => !!cb };
}
function songWith(notes) { let sg = M.emptySong(); sg.tempos = [{ t: 0, bpm: 120 }]; sg = M.addTrack(sg, 'p', 0); notes.forEach((n) => { sg = M.addNote(sg, 0, n); }); return sg; }
{
  const long = songWith([{ t: 0, d: 480 * 40, n: 60, v: 100 }, { t: 480, d: 480 * 40, n: 64, v: 100 }]); // 40 拍的長音:noteOff 遠在前瞻視窗之外
  const a = mk(long); a.pl.play(); a.sm.advance(10.1); a.tick(); a.sm.advance(10.6); a.tick(); a.sm.advance(10.6);
  check('clear: long notes are sounding while playing', a.sm.sounding() === 2, a.sm.sounding());
  a.pl.pause(); a.sm.advance(10.7);
  check('pause: nothing keeps sounding right after', a.sm.sounding() === 0, a.sm.sounding());
  a.sm.advance(40); check('pause: nothing sounds later either (queued noteOns are paired with a noteOff)', a.sm.sounding() === 0 && a.sm.queued() === 0, [a.sm.sounding(), a.sm.queued()]);
  check('pause: the schedule timer is gone and the held notes are cleared', !a.hasTimer() && a.pl.state.held.size === 0);
  // 暫停當下還有「已排進佇列但時間還沒到」的 noteOn
  const b = mk(long); b.pl.play(); b.sm.advance(10.1); b.tick(); b.sm.advance(10.3); b.tick(); // 第二個音 0.5 s 在前瞻視窗裡,已排進佇列、尚未響
  b.pl.pause(); b.sm.advance(10.4); b.sm.advance(11); b.sm.advance(60);
  check('pause with a note queued but not yet started: it never sounds forever', b.sm.sounding() === 0, b.sm.sounding());
  // 只有 noteOn、沒有 noteOff 的 MIDI(音符長度到曲子盡頭以外)
  const never = songWith([{ t: 0, d: 480 * 1000, n: 62, v: 100 }]);
  const c = mk(never); c.pl.play(); c.sm.advance(10.2); c.tick(); c.pl.stop(); c.sm.advance(20); c.sm.advance(1000);
  check('stop: a note with no noteOff in sight is closed', c.sm.sounding() === 0 && c.pl.position() === 0 && !c.pl.isPlaying(), c.sm.sounding());
  // 播完自然結束
  const short = songWith([{ t: 0, d: 480, n: 60, v: 100 }]); const d = mk(short); let ended = 0; d.pl.onEnd(() => { ended++; }); d.pl.play();
  for (let t = 10.1; t < 12; t += 0.05) { d.sm.advance(t); d.tick(); }
  d.sm.advance(30); check('end: finishing naturally silences everything and fires onEnd once', ended === 1 && d.sm.sounding() === 0 && !d.pl.isPlaying() && !d.hasTimer(), { ended, s: d.sm.sounding() });
  // 結束時有一個永遠不放開的音
  const e = mk(never); e.pl.play(); e.pl.seek(0.4); e.sm.advance(10.5); e.tick(); e.pl.pause(); e.sm.advance(500);
  check('seek then pause: still nothing hanging', e.sm.sounding() === 0, e.sm.sounding());
  // 安全閥:前瞻時間過後再關一次
  const g = mk(long); g.pl.play(); g.sm.advance(10.2); g.tick(); g.pl.pause(); const stops0 = g.sm.stops(); g.runGuards(); check('pause: a second stopAll runs after the look-ahead window as a safety net', g.sm.stops() === stops0 + 1);
  // 重複按
  let threw = false; try { const h = mk(long); h.pl.pause(); h.pl.stop(); h.pl.stop(); h.pl.play(); h.pl.pause(); h.pl.pause(); h.pl.dispose(); h.pl.dispose(); h.pl.stop(); h.pl.play(); } catch (err) { threw = String(err); }
  check('repeated pause / stop / dispose never throws, and a disposed player stays silent', !threw, threw);
  const di = mk(long); di.pl.play(); di.sm.advance(10.2); di.tick(); di.pl.dispose(); di.sm.advance(100); di.pl.play(); di.sm.advance(200);
  check('dispose: silent afterwards and play() is ignored', di.sm.sounding() === 0 && !di.pl.isPlaying() && di.pl.isDisposed(), di.sm.sounding());
  // 暫停的踏板
  const pedalLog = []; const sy = { noteOn() {}, noteOff() {}, programChange() {}, controllerChange: (c, cc, v) => pedalLog.push([c, cc, v]), stopAll() {} };
  const pp = P.createPlayer(long, sy, { clock: () => 10, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {} }); pp.play(); pp.pause();
  check('pause releases the sustain pedal and sends all-sound-off / all-notes-off on all 16 channels', [64, 120, 123].every((cc) => Array.from({ length: 16 }, (_, ch) => pedalLog.some((l) => l[0] === ch && l[1] === cc)).every(Boolean)));
  // 換曲
  const sw = mk(long); sw.pl.play(); sw.sm.advance(10.2); sw.tick(); sw.pl.setSong(songWith([{ t: 0, d: 480, n: 70, v: 100 }])); sw.sm.advance(10.3); sw.pl.pause(); sw.sm.advance(500);
  check('setSong while playing leaves nothing hanging', sw.sm.sounding() === 0, sw.sm.sounding());
  // 多張卡片共用一個合成器
  const group = { active: null }; const sm2 = sim(); let cbA = null, cbB = null;
  const mkp = (song, set) => P.createPlayer(song, sm2.synth, { clock: () => sm2.now.t, setInterval: (f) => { set(f); return 1; }, clearInterval: () => {}, ahead: 0.25, group, setTimeout: () => 1, clearTimeout() {} });
  const pa = mkp(long, (f) => { cbA = f; }), pb = mkp(songWith([{ t: 0, d: 480 * 30, n: 72, v: 100 }]), (f) => { cbB = f; }); let aEnded = 0; pa.onEnd(() => { aEnded++; });
  pa.play(); sm2.advance(10.2); cbA(); pb.play(); sm2.advance(10.3); sm2.advance(60);
  check('two cards on one synth: starting the second silences the first and tells its screen (onEnd)', !pa.isPlaying() && pb.isPlaying() && aEnded === 1 && group.active === pb, { a: pa.isPlaying(), b: pb.isPlaying(), aEnded });
  pb.dispose(); sm2.advance(1000); check('two cards: removing the active one frees the group and leaves nothing sounding', group.active === null && sm2.sounding() === 0, sm2.sounding());
  pa.stop(); check('two cards: stopping an already-stopped card does not disturb the group', group.active === null);
}
  // ── 音色庫大小從清單算、本機快取狀態、整份存好後不再多留分片(離線模型管理頁、播放卡片訊息用)
  check('fmtMB: sizes come out as 6.3 MB / 31 MB (MiB) (never hard-coded)', P.fmtMB(6614304) === '6.3 MB' && P.fmtMB(32319396) === '31 MB' && P.fmtMB(1048576) === '1 MB', [P.fmtMB(6614304), P.fmtMB(32319396)]);
  const bi = await P.bankInfo({ base: 'https://h/x/', path: 'x.sf2' }, async () => ({ ok: true, json: async () => man }));
  check('bankInfo: size, parts and label come from the manifest', bi.size === data.length && bi.parts === parts.length && bi.label === '約 ' + P.fmtMB(data.length), bi);
  let bierr = ''; try { await P.bankInfo({ base: 'https://h/x/', path: 'nope.sf2' }, async () => ({ ok: true, json: async () => man })); } catch (e) { bierr = e.message; } check('bankInfo: a manifest without the file is reported', /nope\.sf2/.test(bierr), bierr);
  const store = new Map(); const fakeCaches = { async open() { return { async put(k, r) { store.set(typeof k === 'string' ? k : k.url, Buffer.from(await r.arrayBuffer())); }, async match(k) { const v = store.get(typeof k === 'string' ? k : k.url); return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.length), clone() { return this; } } : undefined; }, async delete(k) { return store.delete(typeof k === 'string' ? k : k.url); }, async keys() { return Array.from(store.keys()).map((u) => ({ url: u })); } }; }, async delete() { const had = store.size > 0; store.clear(); return had; } };
  global.caches = fakeCaches; global.Response = global.Response || class { constructor(b) { this._b = b; } async arrayBuffer() { return this._b; } };
  await P.fetchParts({ base: 'https://h/x/', path: 'x.sf2' }, () => {}, mkFetch());
  check('fetchParts: after the whole bank is cached the part entries are dropped (no double storage)', Array.from(store.keys()).length === 1 && Array.from(store.keys())[0].indexOf('#') >= 0, Array.from(store.keys()));
  const cs = await P.bankCacheStatus(fakeCaches); check('bankCacheStatus: reports bytes and that the whole bank is there', cs.whole && cs.bytes === data.length && cs.entries === 1, cs);
  check('bankCacheClear: empties the cache', (await P.bankCacheClear(fakeCaches)) === true && (await P.bankCacheStatus(fakeCaches)).entries === 0);
  delete global.caches;
  console.log(ok + ' passed, ' + bad.length + ' failed'); bad.forEach((b) => console.log('FAIL: ' + b)); process.exit(bad.length ? 1 : 0);
})();
