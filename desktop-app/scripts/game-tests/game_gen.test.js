// node scripts/game-tests/game_gen.test.js -- the game's final output: web / electron / nodejs files (deterministic), the AI plan for the other targets, the fit check for old consoles, program-first words
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const D = path.join(__dirname, '../../renderer/src/game/');
const G = require(D + 'game_core.js'), Gen = require(D + 'game_gen.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const src = { vocab: fs.readFileSync(D + 'game_vocab.js', 'utf8'), sim: fs.readFileSync(D + 'game_sim.js', 'utf8'), render2d: fs.readFileSync(D + 'game_render2d.js', 'utf8'), audio: fs.readFileSync(D + 'game_audio.js', 'utf8') };
const sp = G.starter('platformer-side', { name: '測試遊戲' }), sp3 = G.starter('walker-3rd', { name: '3D 測試' });

// ── targets
{
  const t2 = Gen.targets(sp).map((t) => t.id), t3 = Gen.targets(sp3).map((t) => t.id);
  check('targets: 2D lists every target; 3D lists the ones that can do 3D (web, electron, nodejs, three.js, python)', ['web', 'electron', 'nodejs', 'python', 'sdl2', 'sdl3', 'qt', 'csharp-winforms', 'java-swing', 'java-awt', 'java-swt', 'android', 'fc', 'sfc', 'x68000', 'xbox', 'pc'].every((x) => t2.indexOf(x) >= 0) && t3.indexOf('threejs') >= 0 && t3.indexOf('sdl2') < 0 && t2.indexOf('threejs') < 0, { t2, t3 });
  check('targets: tiers are honest (A = produced by the program or easy to check, C = old consoles)', Gen.TARGETS.find((t) => t.id === 'web').tier === 'A' && Gen.TARGETS.find((t) => t.id === 'fc').tier === 'C' && Gen.TARGETS.filter((t) => t.kind === 'deterministic').map((t) => t.id).sort().join() === 'electron,nodejs,threejs,web');
}
// ── the web page
{
  const w = Gen.build('web', sp, { src }), html = w.files[0].content;
  check('web: one html file, title, the game data, the engine, the runtime; no network needed', w.files.length === 1 && /\.html$/.test(w.files[0].path) && /<title>測試遊戲<\/title>/.test(html) && /window\.__GAME__=/.test(html) && /FaGameSim/.test(html) && /FaGameRender2d/.test(html) && !/src="http/.test(html), w.files[0].path);
  check('web: no script tag can end early (</script> inside the code is escaped)', (html.match(/<\/script>/g) || []).length === (html.match(/<script/g) || []).length);
  const m = /window\.__GAME__=(.*?);window\.__TESTVECTOR__=/s.exec(html); check('web: the embedded game is the compiled game', !!m && JSON.stringify(JSON.parse(m[1])) === JSON.stringify(G.compile(sp)));
  const w3 = Gen.build('threejs', sp3, { src }); check('three.js: a 3D page loading three from a CDN and a 3D renderer', /three@/.test(w3.files[0].content) && /__RENDER3D__/.test(w3.files[0].content) && !/FaGameRender2d\s*=/.test(w3.files[0].content));
  let threw = false; try { Gen.build('web', sp, { src: {} }); } catch (e) { threw = true; } check('web: missing engine source is an error, not an empty page', threw);
  // the runtime page, run in a minimal DOM: it must step the same simulation (same hash as the test vector after the same inputs)
  const vm = require('vm'); const hooks = {}; const ctx2d = new Proxy({}, { get(t, k) { if (k === 'measureText') return (s) => ({ width: String(s).length * 6 }); if (k === 'canvas') return {}; return typeof k === 'string' ? function () {} : undefined; }, set() { return true; } });
  const el = () => ({ width: 640, height: 360, style: {}, textContent: '', getContext: () => ctx2d, addEventListener: (n, f) => { hooks['c:' + n] = f; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }), focus() {} });
  const nodes = { c: el(), note: el() }; const win = { addEventListener: (n, f) => { hooks['w:' + n] = f; }, innerWidth: 640, innerHeight: 360, performance: { now: () => 0 }, AudioContext: undefined }; win.window = win; win.document = { getElementById: (id) => nodes[id] }; win.requestAnimationFrame = () => 0; win.performance = { now: () => 0 }; win.setTimeout = setTimeout;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((x) => x[1].replace(/<\\\//g, '</')); const sb = vm.createContext(win); let err = null; try { scripts.forEach((c) => vm.runInContext(c, sb)); } catch (e) { err = String(e && e.stack || e).slice(0, 300); }
  check('web: the page scripts run (engine + runtime) and expose window.FAGAME', !err && !!win.FAGAME && typeof win.FAGAME.step === 'function', err);
  if (win.FAGAME) { const vec = Gen.vectors(sp, { frames: 90, every: 30 }); vec.frames.forEach((h) => win.FAGAME.step(h)); check('web: the page simulation gives the same hash as the test vector for the same inputs', win.FAGAME.hash() === vec.hashes[vec.hashes.length - 1], [win.FAGAME.hash(), vec.hashes]); }
}
// ── electron / nodejs
{
  const e = Gen.build('electron', sp, { src }), names = e.files.map((f) => f.path.split('/').pop()).sort().join();
  check('electron: package.json, main.js, index.html, README', names === 'README.md,index.html,main.js,package.json', names); const pkg = JSON.parse(e.files.find((f) => /package\.json$/.test(f.path)).content); check('electron: package.json starts it', pkg.main === 'main.js' && /electron/.test(pkg.scripts.start) && !!pkg.devDependencies.electron);
  const n = Gen.build('nodejs', sp, { src }), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fagen-')); n.files.forEach((f) => { const p = path.join(dir, f.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.content); }); const run = path.join(dir, Gen.safe(sp.game.title), 'run.js');
  const r = cp.spawnSync(process.execPath, [run, '--check'], { encoding: 'utf8' }); check('nodejs: the generated headless runner replays the test vector and matches', r.status === 0 && /重播吻合/.test(r.stdout), r.stdout + r.stderr);
  const r2 = cp.spawnSync(process.execPath, [run, '90'], { encoding: 'utf8' }); check('nodejs: it also runs and prints hashes and a final state', r2.status === 0 && /"scene":"forest"/.test(r2.stdout) && /^30 /m.test(r2.stdout), r2.stdout.slice(0, 200));
}
// ── test vectors
{
  const v1 = Gen.vectors(sp), v2 = Gen.vectors(sp);
  check('vectors: deterministic (same game, same inputs → same hashes and checkpoints)', JSON.stringify(v1.hashes) === JSON.stringify(v2.hashes) && JSON.stringify(v1.checkpoints) === JSON.stringify(v2.checkpoints) && v1.hashes.length >= 8);
  check('vectors: checkpoints are readable summaries (scene, vars, player position) for ports in other languages', v1.checkpoints[0].scene === 'forest' && v1.checkpoints[0].player.pos.length === 2 && 'score' in v1.checkpoints[0].vars);
  const vv3 = Gen.vectors(sp3, { frames: 120 }); check('vectors: also for a 3D game (the player moves in x and z)', vv3.checkpoints.length >= 3 && vv3.checkpoints[0].player.pos.length === 3);
}
// ── fit check for old consoles
{
  const f = Gen.fitness('fc', sp); check('fit: FC says plainly that a 320×180 picture does not fit and what to do', !f.ok && f.problems.some((p) => /320×180/.test(p)) && f.advice.some((a) => /256/.test(a)));
  const small = G.applyEdits(sp, [{ op: 'set_game', props: { view: { width: 256, height: 192 } } }], {}); const f2 = Gen.fitness('fc', small.applied.length ? small.spec : sp); check('fit: after shrinking the picture that problem goes away (other advice stays: fixed point, 5 channels)', !f2.problems.some((p) => /超過/.test(p) && /×/.test(p) && /FC/.test(p)) || !small.applied.length, f2.problems);
  const f3 = Gen.fitness('sfc', sp3); check('fit: no 3D on the 2D-only consoles', !f3.ok && /3D/.test(f3.problems[0]));
  check('fit: targets without a profile are fine', Gen.fitness('sdl2', sp).ok);
}
// ── the AI plan
{
  const p = Gen.aiPlan('sdl2', sp, { simSource: src.sim }); check('plan: a file list for the target, with CMake and the simulation', p.files.some((f) => f.path === 'CMakeLists.txt') && p.files.some((f) => /sim\.c$/.test(f.path)) && /SDL2/.test(p.lang));
  const u = p.user(1, [{ path: 'CMakeLists.txt', content: 'cmake_minimum_required(VERSION 3.10)' }]); check('plan: each prompt has the file wanted, the game JSON, the vocabulary, the step order, the test vector, the files already written', /src\/main\.c/.test(u) && u.indexOf('"scenes"') > 0 && /碰撞/.test(u) && /checkpoints/.test(u) && /cmake_minimum_required/.test(u) && /JS 參考模擬/.test(u), u.length);
  check('plan: the system prompt demands one file at a time, no fences, honest limits', /一次只寫一個檔案/.test(p.system) && /已知限制/.test(p.system));
  const pf = Gen.aiPlan('fc', sp, {}); check('plan: FC puts the fit problems in the prompt so the model knows what to cut', /放不下/.test(pf.system) && /256/.test(pf.system) && pf.files.some((f) => /nes\.cfg/.test(f.path)));
  let threw = false; try { Gen.aiPlan('nope', sp); } catch (e) { threw = true; } check('plan: unknown target is an error', threw);
  check('clean: fences and chatter around a file are removed', Gen.cleanFile('好的,這是檔案:\n```c\nint main(){return 0;}\n```\n希望有幫助') === 'int main(){return 0;}\n' && Gen.cleanFile('plain text') === 'plain text\n');
}
(async () => {
  // aiBuild with a fake model
  const asked = []; const res = await Gen.aiBuild('python', sp, { simSource: src.sim }, async (system, user) => { asked.push(user.length); return '```python\nprint("hi %d")\n```'.replace('%d', String(asked.length)); }, () => {});
  check('aiBuild: one call per planned file, the files are cleaned and placed in a folder with the test vector and the game data', asked.length === 6 && res.files.some((f) => /\/main\.py$/.test(f.path) && /^print\("hi 1"\)/.test(f.content)) && res.files.some((f) => /TESTVECTOR\.json$/.test(f.path)) && res.files.some((f) => /GAME\.json$/.test(f.path)), res.files.map((f) => f.path));
  check('aiBuild: the notes say the code was not compiled here', res.notes.some((n) => /沒有在這裡編譯/.test(n)));
  const res2 = await Gen.aiBuild('python', sp, {}, async () => '', () => {}); check('aiBuild: an empty answer is reported, not hidden', res2.notes.some((n) => /空的/.test(n)));
  // program-first words added for the editor
  const P = (t) => G.parseCommands(t, sp);
  check('words: 新增一個洞穴場景 / 互動方式改成滑鼠 / 把玩家改成紅色 / 把背景改成黑色 are read by the program', P('新增一個洞穴場景').edits[0].op === 'add_scene' && P('新增一個洞穴場景').edits[0].name === '洞穴' && P('把互動方式改成滑鼠').edits[0].mode === 'mouse' && P('把玩家改成紅色').edits[0].props.sprite.color === '#e53935' && P('把背景改成黑色').edits[0].props.background === '#212121', [P('把背景改成黑色')]);
  const added = G.applyEdits(sp, P('新增一個洞穴場景').edits, {}); check('words: the new scene is really added', G.of(added.spec, 'scene').length === 2);
  console.log('game_gen: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED:\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
})();
