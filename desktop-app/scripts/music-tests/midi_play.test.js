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

console.log(ok + ' passed, ' + bad.length + ' failed'); bad.forEach((b) => console.log('FAIL: ' + b)); process.exit(bad.length ? 1 : 0);
