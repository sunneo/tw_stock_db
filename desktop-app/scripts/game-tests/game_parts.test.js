// node scripts/game-tests/game_parts.test.js -- renderer (fake canvas), audio synthesis, UML, game pack
const G = require('../../renderer/src/game/game_core.js');
const S = require('../../renderer/src/game/game_sim.js');
const R = require('../../renderer/src/game/game_render2d.js');
const A = require('../../renderer/src/game/game_audio.js');
const U = require('../../renderer/src/game/game_uml.js');
const PK = require('../../renderer/src/game/game_pack.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const rec = () => { const calls = []; const ctx = new Proxy({}, { get(t, k) { if (k === 'measureText') { return (s) => ({ width: String(s).length * 6 }); } if (k === 'calls') { return calls; } return (...a) => { calls.push(k + ':' + a.map((x) => (typeof x === 'number' ? Math.round(x) : x)).join(',')); }; }, set(t, k, v) { calls.push('set ' + String(k) + '=' + v); return true; } }); return ctx; };

// ── renderer
{
  const sp = G.starter('platformer-side'), game = G.compile(sp), sim = S.create(game, { seed: 1 }); const ctx = rec(); R.draw(ctx, sim.state, game, { width: 640, height: 360, debug: true, grid: true, selection: [sim.state.entities[0].id], time: 0.2 });
  const c = ctx.calls; check('render: the background, the tiles, every visible entity, the hud are drawn; debug adds boxes, zones and paths; the selection gets a dashed frame', c.some((x) => /^fillRect/.test(x)) && c.filter((x) => /^fillRect/.test(x)).length > 20 && c.some((x) => /^fillText:.*score/.test(x)) && c.some((x) => /^setLineDash/.test(x)) && c.some((x) => /^strokeRect/.test(x)));
  const w = R.worldToScreen(sim.state, { width: 640, height: 360 }, 100, 50), b = R.screenToWorld(sim.state, { width: 640, height: 360 }, w[0], w[1]);
  check('render: world ↔ screen conversion is exact in both directions', Math.abs(b[0] - 100) < 1e-6 && Math.abs(b[1] - 50) < 1e-6);
  sim.state.status = 'won'; const c2 = rec(); R.draw(c2, sim.state, game, { width: 640, height: 360 }); check('render: the won / lost overlay', c2.calls.some((x) => /fillText:過關/.test(x)));
  const rpg = G.compile(G.starter('rpg')), rs = S.create(rpg, { seed: 1 }); const e = rs.state.entities.find((x) => x.prefab === 'slime'); rs.player().pos = [e.pos[0] - 16, e.pos[1]]; for (let i = 0; i < 80 && !rs.state.battle; i++) { rs.step({ right: true }); } const c3 = rec(); R.draw(c3, rs.state, rpg, { width: 640, height: 360 }); check('render: a battle is drawn with the menu and the log', !!rs.state.battle && c3.calls.some((x) => /fillText:.*攻擊/.test(x)));
  const dl = G.compile(G.starter('topdown-free')), ds = S.create(dl, { seed: 1 }); ds.state.dialog = { id: 'elder-hi', i: 0, t: 1, style: 'box', lines: [{ who: '長老', text: '你好,旅人。' }], choices: null, choice: 0, phase: 'line' }; const c4 = rec(); R.draw(c4, ds.state, dl, { width: 640, height: 360, time: 0 }); check('render: the dialog box shows the name and the typed text', c4.calls.some((x) => /fillText:長老/.test(x)) && c4.calls.some((x) => /fillText:.*你好/.test(x)));
}
// ── audio
{
  const names = A.SFX_NAMES; const ok1 = names.every((n) => { const s = A.renderSfx(n, 22050); const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0); return s.length > 500 && peak > 0.05 && peak <= 1; });
  check('audio: every built-in sound renders to audible samples within range', ok1 && names.length >= 16, names.length);
  check('audio: sounds are deterministic (the same name and seed give the same samples)', JSON.stringify(Array.from(A.renderSfx('explosion', 22050, { seed: 3 }).slice(0, 50))) === JSON.stringify(Array.from(A.renderSfx('explosion', 22050, { seed: 3 }).slice(0, 50))) && JSON.stringify(Array.from(A.renderSfx('explosion', 22050, { seed: 3 }).slice(100, 140))) !== JSON.stringify(Array.from(A.renderSfx('explosion', 22050, { seed: 4 }).slice(100, 140))));
  const songs = A.STYLES.map((st) => A.renderSong({ style: st, tempo: 120, seed: 5, bars: 2 }, 11025)); check('audio: every song style renders (length = bars × 4 beats), is audible and loop-safe (starts and ends at zero)', songs.every((s) => Math.abs(s.length - 2 * 4 * 0.5 * 11025) < 3 && s.reduce((m, v) => Math.max(m, Math.abs(v)), 0) > 0.05 && Math.abs(s[0]) < 0.01 && Math.abs(s[s.length - 1]) < 0.01), songs.map((s) => s.length));
  check('audio: a song depends on its seed and style', JSON.stringify(Array.from(A.renderSong({ style: 'happy', seed: 1, bars: 2 }, 8000).slice(2000, 2100))) !== JSON.stringify(Array.from(A.renderSong({ style: 'happy', seed: 2, bars: 2 }, 8000).slice(2000, 2100))));
  const w = A.wavBytes(A.renderSfx('coin', 22050), 22050), dv = new DataView(w.buffer); check('audio: wav bytes are a valid 16-bit mono file (RIFF header, sizes)', String.fromCharCode(w[0], w[1], w[2], w[3]) === 'RIFF' && dv.getUint16(22, true) === 1 && dv.getUint16(34, true) === 16 && dv.getUint32(40, true) === w.length - 44);
  // the player with a fake AudioContext
  const log = []; const fakeCtx = { sampleRate: 44100, currentTime: 0, destination: {}, createGain() { return { gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} }; }, createBuffer(c, n, sr) { return { n, sr, getChannelData() { return new Float32Array(n); } }; }, createBufferSource() { return { buffer: null, loop: false, connect() {}, start() { log.push('start'); }, stop() { log.push('stop'); } }; }, resume() {} };
  const pl = A.createPlayer(fakeCtx, { assets: { s1: { kind: 'song', style: 'happy', bars: 2, seed: 1 }, c: { kind: 'sound', synth: 'coin' } } }); pl.play({ kind: 'play', id: 'coin' }); pl.play({ kind: 'bgm', id: 's1' }); pl.play({ kind: 'bgm', id: 's1' }); pl.play({ kind: 'voice', text: '你好', voice: 'elder' }); pl.play({ kind: 'stop_all' });
  check('audio player: plays a sound, starts the song once (a second request for the same song does nothing), mouth sounds for a voice line, stop_all stops the song', log.filter((x) => x === 'start').length >= 3 && log.indexOf('stop') >= 0, log.length);
}
// ── UML
{
  const sp = G.starter('platformer-side'); const cd = U.classDiagram(sp), sg = U.sceneGraph(G.starter('topdown-free')), sd = U.stateDiagram(sp, 'patrol'), sq = U.sequence(G.starter('topdown-free'), 'elder-hi');
  check('uml: class diagram lists prefabs with their body and behaviour link, and the scenes with counts', /^classDiagram/.test(cd) && /class n_enemy/.test(cd) && /n_enemy --> n_patrol : behavior/.test(cd) && /n_forest o-- "\d+" n_coin/.test(cd));
  check('uml: scene graph has a start node and the door edges (village → house → village)', /START\(\("開始"\)\) --> n_village/.test(sg) && /n_village -->\|房子的門\| n_house/.test(sg) && /n_house -->\|出口\| n_village/.test(sg), sg);
  check('uml: a behaviour state diagram has the start arrow, the states, and one arrow per "to" transition', /^stateDiagram-v2/.test(sd) && /\[\*\] --> walk/.test(sd));
  check('uml: a dialog becomes a sequence diagram (player talks to the speaker, lines come back)', /sequenceDiagram/.test(sq) && /participant n_長老|participant n_/.test(sq) && /->>玩家: 年輕人/.test(sq), sq);
  const spec = G.applyEdits(sp, [{ op: 'add_behavior', behavior: { name: '看守', states: { idle: { on: [{ event: 'tick', if: { left: 'self.dist_player', op: '<', right: 80 }, do: [{ to: 'alert' }] }] }, alert: {} }, start: 'idle' } }]).spec;
  const tr = U.transitions(spec, '看守'); check('uml: transitions are the rules with a "to" action (from, to, event, index)', tr.length === 1 && tr[0].from === 'idle' && tr[0].to === 'alert' && tr[0].event === 'tick');
  const ed = U.toEdits(spec, [{ kind: 'add_state', behavior: '看守', name: 'sleep' }, { kind: 'add_transition', behavior: '看守', from: 'alert', to: 'idle', event: 'timer', after: 3 }, { kind: 'remove_transition', behavior: '看守', from: 'idle', index: 0 }]); const r = G.applyEdits(spec, ed);
  check('uml editing: UML-level changes map to closed game actions and apply (state added, a timed return transition added, the old transition removed)', r.rejected.length === 0 && U.transitions(r.spec, '看守').length === 1 && U.transitions(r.spec, '看守')[0].from === 'alert' && Object.keys(G.find(r.spec, '看守', 'behavior') >= 0 ? r.spec.objects[G.find(r.spec, '看守', 'behavior')].states : {}).indexOf('sleep') >= 0, r.rejected);
  check('uml: all() gives one file per diagram for the pack', Object.keys(U.all(sp)).indexOf('classes.mmd') >= 0 && Object.keys(U.all(sp)).some((f) => /^state-/.test(f)));
}
// ── pack
(async () => {
  let JSZip = null; for (const p of [process.env.FA_JSZIP, 'jszip', '/var/www/html/sbom-tools/javascript/vendor/jszip.min.js', '/var/www/html/sbom-tools.remote/javascript/vendor/jszip.min.js']) { if (!p || JSZip) { continue; } try { JSZip = require(p); } catch (e) { /* try the next */ } }
  if (!JSZip) { check('pack: (skipped: jszip is not available in this node)', true); return finish(); }
  const P = PK.create(JSZip); const sp = G.starter('topdown-free'); const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const bytes = await P.pack(sp, { assets: { 'hero.png': png }, editor: { state: { ptr: 2 }, log: [{ role: 'user', text: 'hi' }], prompt: '做一個小村' }, modified: '2026-10-25' }); const back = await P.open(bytes);
  check('pack: the .fagame is a zip with the manifest, game, scenes, prefabs, behaviours, assets, uml, readme and prompt', await (async () => { const z = await JSZip.loadAsync(bytes); const n = Object.keys(z.files); return ['manifest.yaml', 'game.yaml', 'assets.yaml', 'README.md', 'PROMPT.md', 'editor/state.json'].every((f) => n.indexOf(f) >= 0) && n.some((f) => /^scenes\/village\.yaml$/.test(f)) && n.some((f) => /^prefabs\//.test(f)) && n.some((f) => /^uml\//.test(f)) && n.indexOf('assets/hero.png') >= 0; })());
  const norm = (x) => JSON.stringify(G.validate(x).spec.objects.map((o) => JSON.stringify(o)).sort());
  check('pack: opening it gives back the same game, the assets and the editor state (continue editing)', norm(back.spec) === norm(sp) && back.problems.length === 0 && back.assets['hero.png'].length === 7 && back.editor.state.ptr === 2 && back.editor.prompt === '做一個小村' && back.manifest.title === sp.game.title && back.manifest.files.length > 5);
  const lite = await P.open(await P.pack(sp, { lite: true })); check('pack: the lite export has no editor state', lite.editor === null && lite.manifest.lite === true);
  let err1 = null, err2 = null; try { await P.open(await new JSZip().file('x.txt', 'hi').generateAsync({ type: 'uint8array' })); } catch (e) { err1 = e.message; } try { const z = new JSZip(); z.file('manifest.yaml', 'kind: fagame\nformat: 99\n'); await P.open(await z.generateAsync({ type: 'uint8array' })); } catch (e) { err2 = e.message; }
  check('pack: a zip that is not a game pack, and a pack of a newer format, are refused with the reason', /不是遊戲包/.test(err1 || '') && /較新的格式/.test(err2 || ''), [err1, err2]);
  const z = await JSZip.loadAsync(bytes); const man = require('js-yaml').load(await z.file('manifest.yaml').async('string')); const f0 = man.files.find((f) => f.path === 'game.yaml'); const content = await z.file('game.yaml').async('uint8array'); check('pack: the manifest lists every file with its size and hash', f0 && f0.bytes === content.length && f0.hash === PK.fnv(content));
  finish();
})().catch((e) => { bad.push('pack threw ' + e.stack); finish(); });
function finish() { console.log('game_parts: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n  ' + bad.join('\n  ') : '')); process.exit(bad.length ? 1 : 0); }
