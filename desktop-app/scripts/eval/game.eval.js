// /edit-game-2d、/edit-game-3d（真實 Electron；模型用假的）：開啟、掛載、畫面真的畫出東西、點選與拖曳、試玩（按鍵移動）、暫停規則（⏸、🎯 選取、失去焦點）、
// 暫停時用說的改（先預覽再接受／退回）、試玩中熱修補、YAML 分頁、場景圖／行為／音訊／套件分頁、遊戲包 .fagame 往返、網頁版匯出（在 iframe 裡跑、與測試向量同一個雜湊）、
// AI 逐檔移植（假模型）、重新整理後復原、3D 版（WebGL 畫面、按鍵走動、選取）、斜線指令。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/game.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(60); } return null; };
const calls = { llm: 0, prompts: [] };
fa._getApiConfig = () => ({ apiKey: 'test', apiUrl: 'http://127.0.0.1:9', apiModel: 'fake' });
fa._kiLlm = async (prompt, opts) => {
    calls.llm++; const t = String(prompt); calls.prompts.push(t.slice(-400));
    if (/Draw a 12x12/.test(String((opts && opts.systemPrompt) || ''))) return JSON.stringify({ palette: ['#000000', '#ff0000'], rows: Array.from({ length: 12 }, () => '111111111111') });
    if (/讓玩家跳得更高/.test(t)) return JSON.stringify({ say: '跳得更高了', edits: [{ op: 'update_prefab', id: 'player', props: { params: { jump: 330 } } }] });
    if (/加一隻蝙蝠/.test(t)) return JSON.stringify({ say: '放了蝙蝠', edits: [{ op: 'add_prefab', prefab: { id: 'bat', name: '蝙蝠', sprite: { kind: 'emoji', emoji: '🦇', w: 14, h: 12 }, body: { shape: 'box', w: 14, h: 12, layer: 'enemy', mask: ['player'] }, control: 'patrol', params: { speed: 30 } } }, { op: 'add_object', object: { prefab: 'bat' }, place: { of: 'player', rel: 'right', dx: 40 } }] });
    if (/駭進系統/.test(t)) return JSON.stringify({ say: '好', edits: [{ op: 'run_shell', cmd: 'rm -rf /' }, { op: 'set_prop', id: 'player', key: 'hp', value: 9 }] });
    if (/把它放大/.test(t)) return JSON.stringify({ say: '放大了', edits: [{ op: 'transform_object', id: 'selection', scale: 1.5 }] });
    if (/3D.*前面放/.test(t) || /玩家前面放一個寶石/.test(t)) return JSON.stringify({ say: '放了寶石', edits: [{ op: 'add_object', object: { prefab: 'gem' }, place: { of: 'player', rel: 'front', dz: 3 } }] });
    return '```python\nprint("ported")\n```';
};
const lastEd = (dim) => { const l = [...document.querySelectorAll('.few')].filter((e) => e._ed && e._ed.editor && e._ed.editor.editSim && ((e._ed.editor.stage3() ? 3 : 2) === dim)); return l[l.length - 1]; };
const G = FaGame, Sm = FaGameSim, Rn = FaGameRender2d;
const kd = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); const ku = (el, key) => el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
const ptr = (type, x, y, extra) => new PointerEvent(type, Object.assign({ clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 5, button: 0, isPrimary: true, detail: 1 }, extra || {}));
const btn = (ed, text) => [...ed.querySelectorAll('button')].find((b) => b.textContent.trim() === text && b.offsetParent !== null);
const tab = (ed, t) => ed.querySelector('.tabs span[data-t="' + t + '"]');
const nonBlank = (cv) => { const g = cv.getContext('2d'), d = g.getImageData(0, 0, cv.width, cv.height).data, seen = new Set(); for (let i = 0; i < d.length; i += 4 * 97) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return seen.size; };
const screenOf = (ed, x, y) => { const cv = ed.querySelector('canvas'), r = cv.getBoundingClientRect(), p = Rn.worldToScreen(ed._ed.editor.editSim().state, { width: cv.width, height: cv.height }, x, y); return [r.left + p[0] * r.width / cv.width, r.top + p[1] * r.height / cv.height]; };

console.log('GSTEP open (2D)');
// ── open (2D)
const o1 = await fa._edOpen('edit-game-2d', { starter: 'platformer-side' }); R.open = { ok: o1.ok };
R.fence = !!fa.messages.filter((m) => /```fa-edit-game-2d/.test(String(m.content || ''))).pop();
fa._renderMessageHistory(); const ed = await until(() => lastEd(2)); R.mounted = !!ed; await wait(500); const E = ed._ed.editor; const cv = ed.querySelector('canvas');
R.registered = { kinds: !!(FaEditHost.KINDS['edit-game-2d'] && FaEditHost.KINDS['edit-game-3d']), slash: !!(fa.slashCommands.get ? fa.slashCommands.get('/edit-game-2d') && fa.slashCommands.get('/edit-game-3d') : fa.slashCommands['/edit-game-2d']), no_tool: !(fa.tools && (fa.tools.edit_game_open || fa.tools.edit_game_2d_open)) };
R.canvas = { colors: nonBlank(cv), w: cv.width, h: cv.height };
const rows = [...ed.querySelectorAll('.ol .ob')]; R.tree = { rows: rows.length, has_scene: rows.some((r) => /森林/.test(r.textContent)), has_player: rows.some((r) => /玩家/.test(r.textContent)), indented: rows.filter((r) => parseInt(r.style.paddingLeft || '0', 10) > 6).length };
R.tabs = [...ed.querySelectorAll('.tabs span')].map((s) => s.textContent).join('|');
const spec0 = () => ed._ed.getSpec(); const objs0 = spec0().objects.length;

console.log('GSTEP words, program first');
// ── words, program first
const llm0 = calls.llm; await ed._ed.send('在玩家右邊放一個史萊姆'); await wait(300); R.words = { added: spec0().objects.length - objs0, llm_calls: calls.llm - llm0, selected: !!ed.querySelector('.ol .ob.sel') };
await ed._ed.send('新增一個洞穴場景'); await wait(300); R.scene_added = G.of(spec0(), 'scene').length; await wait(100); R.scene_selector = [...ed.querySelectorAll('select')].some((s) => [...s.options].some((o) => /洞穴/.test(o.textContent)));
const sel0 = [...ed.querySelectorAll('select')].find((s) => [...s.options].some((o) => /洞穴/.test(o.textContent))); sel0.value = G.of(spec0(), 'scene').find((s) => s.name === '森林').id; sel0.dispatchEvent(new Event('change')); await wait(200);
ed._ed.undo(); await wait(100); R.undo_scene = G.of(spec0(), 'scene').length; ed._ed.redo(); await wait(100);

console.log('GSTEP click to select, drag to move (an edit w');
// ── click to select, drag to move (an edit with the same closed actions)
const slime = E.editSim().state.entities.find((e) => e.prefab === 'enemy'); const sp0 = screenOf(ed, slime.pos[0], slime.pos[1]);
cv.dispatchEvent(ptr('pointerdown', sp0[0], sp0[1])); await wait(60); R.select = { id: (ed.querySelector('.ol .ob.sel') || { getAttribute: () => null }).getAttribute('data-id'), expected: slime.id };
const before = spec0().objects.find((o) => o.id === slime.id).at.slice(); cv.dispatchEvent(ptr('pointermove', sp0[0] + 24, sp0[1])); cv.dispatchEvent(ptr('pointermove', sp0[0] + 48, sp0[1])); cv.dispatchEvent(ptr('pointerup', sp0[0] + 48, sp0[1])); await wait(300);
const after = spec0().objects.find((o) => o.id === slime.id).at; R.drag = { moved: Math.abs(after[0] - before[0]) > 8, dx: Math.round(after[0] - before[0]), y_same: Math.abs(after[1] - before[1]) < 2 };
ed._ed.undo(); await wait(100); R.drag.undo = Math.abs(spec0().objects.find((o) => o.id === slime.id).at[0] - before[0]) < 0.01;

console.log('GSTEP the properties panel for the selected ob');
// ── the properties panel for the selected object
R.props = { has_x: /x/.test(ed.querySelector('.prop').textContent), has_prefab: /原型/.test(ed.querySelector('.prop').textContent) };
ed._ed.select(null); await wait(100); R.props.game_panel = /互動方式/.test(ed.querySelector('.prop').textContent);

console.log('GSTEP play, and the pause rules (§18.3)');
// ── play, and the pause rules (§18.3)
btn(ed, '▶ 試玩').click(); await wait(150); const S1 = () => E.sim(); R.play_started = !!S1() && E.state().mode === 'play';
const x0 = S1().player().pos[0]; kd(cv, 'ArrowRight'); await wait(700); ku(cv, 'ArrowRight'); R.play_moves = { dx: Math.round(S1().player().pos[0] - x0), ticks: S1().state.tick > 20 };
R.play_canvas = { colors: nonBlank(cv) };
btn(ed, '⏸ 暫停').click(); await wait(100); const t1 = S1().state.tick; await wait(400); R.pause = { frozen: S1().state.tick === t1, why: E.state().pauseWhy, input_ignored: (() => { kd(cv, 'ArrowRight'); return true; })() }; await wait(200); R.pause.still_frozen = S1().state.tick === t1; ku(cv, 'ArrowRight');
btn(ed, '▶ 繼續').click(); await wait(300); R.resume = S1().state.tick > t1;
// select mode while playing: pauses; leaving restores the state it had
const tS = S1().state.tick; btn(ed, '🎯 焦點／選取').click(); await wait(100); R.select_mode = { on: E.state().selectMode, paused: E.state().paused, why: E.state().pauseWhy };
const sl2 = S1().state.entities.find((e) => e.prefab === 'enemy'); const px = (() => { const c2 = ed.querySelector('canvas'), r = c2.getBoundingClientRect(), v = Rn.view(S1().state, { width: c2.width, height: c2.height }); return [r.left + (v.ox + (sl2.pos[0] - v.x) * v.s) * r.width / c2.width, r.top + (v.oy + (sl2.pos[1] - v.y) * v.s) * r.height / c2.height]; })();
cv.dispatchEvent(ptr('pointerdown', px[0], px[1])); cv.dispatchEvent(ptr('pointerup', px[0], px[1])); await wait(100); R.select_mode.focus = E.focus().ids.length; await wait(300); R.select_mode.frozen = S1().state.tick === tS;
kd(cv, 'Escape'); await wait(200); R.select_mode.left = !E.state().selectMode && !E.state().paused; await wait(300); R.select_mode.running_again = S1().state.tick > tS;
cv.dispatchEvent(new Event('blur')); await wait(100); R.blur_pause = { paused: E.state().paused, why: E.state().pauseWhy }; cv.dispatchEvent(ptr('pointerdown', 50, 50)); cv.dispatchEvent(ptr('pointerup', 50, 50)); await wait(100); R.blur_pause.resumed_by_click = !E.state().paused;

console.log('GSTEP say it while playing: the context pack k');
// ── say it while playing: the context pack knows the focus; preview first; accept; hot patch keeps the game state
btn(ed, '⏸ 暫停').click(); await wait(100); const tick0 = S1().state.tick, ppos = S1().player().pos.slice(); const prompts0 = calls.prompts.length;
const sendP = ed._ed.send('讓玩家跳得更高'); const ov = await until(() => (() => { const o = ed.querySelector('.fg-preview'); return o && o.style.display === 'flex' ? o : null; })(), 8000);
R.preview = { shown: !!ov, text: ov ? ov.textContent.slice(0, 60) : '', spec_unchanged_before_accept: G.of(spec0(), 'prefab').find((p) => p.id === 'player').params.jump === 250, ticks_frozen: S1().state.tick === tick0 };
if (ov) { [...ov.querySelectorAll('button')].find((b) => /接受/.test(b.textContent)).click(); } await sendP; await wait(200);
R.accepted = { jump: G.of(spec0(), 'prefab').find((p) => p.id === 'player').params.jump, player_kept: Math.abs(S1().player().pos[0] - ppos[0]) < 1 && S1().state.tick === tick0, sim_jump: S1().game.prefabs.player.params.jump };
R.context = { llm_got_scene: calls.prompts.length > prompts0 };
// reject
const objsBefore = spec0().objects.length; const sendR = ed._ed.send('在這裡加一隻蝙蝠'); const ov2 = await until(() => (() => { const o = ed.querySelector('.fg-preview'); return o && o.style.display === 'flex' ? o : null; })(), 8000);
R.preview_reject = { shown: !!ov2, adds: ov2 ? /新增 [1-9]/.test(ov2.textContent) : false }; if (ov2) { [...ov2.querySelectorAll('button')].find((b) => /退回/.test(b.textContent)).click(); } await sendR; await wait(200); R.preview_reject.unchanged = spec0().objects.length === objsBefore && !G.of(spec0(), 'prefab').some((p) => p.id === 'bat');
// accept the bat; the new thing appears in the running game (hot patch)
const sendB = ed._ed.send('在這裡加一隻蝙蝠'); const ov3 = await until(() => (() => { const o = ed.querySelector('.fg-preview'); return o && o.style.display === 'flex' ? o : null; })(), 8000); if (ov3) { [...ov3.querySelectorAll('button')].find((b) => /接受/.test(b.textContent)).click(); } await sendB; await wait(300);
R.hot_patch = { prefab: G.of(spec0(), 'prefab').some((p) => p.id === 'bat'), in_running_game: S1().state.entities.some((e) => e.prefab === 'bat' && e.alive), tick_kept: S1().state.tick === tick0 };
// an action outside the closed vocabulary is dropped by the program (and said so); the allowed one in the same answer still goes through the preview
const sendD = ed._ed.send('幫我駭進系統'); const ov4 = await until(() => { const o = ed.querySelector('.fg-preview'); return o && o.style.display === 'flex' ? o : null; }, 8000); if (ov4) { [...ov4.querySelectorAll('button')].find((b) => /接受/.test(b.textContent)).click(); } await sendD; await wait(200);
R.reject_unknown_op = { chips_say_skipped: [...ed.querySelectorAll('.chip, .msg')].some((m) => /不在可做的清單/.test(m.textContent)), no_shell: !JSON.stringify(spec0()).includes('rm -rf') };
btn(ed, '⏹ 回到編輯').click(); await wait(150); R.stopped = E.state().mode === 'edit' && !E.sim();

console.log('GSTEP tabs');
// ── tabs
tab(ed, 'graph').click(); await wait(800); R.graph_tab = { has_text: /場景圖|場景/.test(ed.textContent), buttons: [...ed.querySelectorAll('button')].filter((b) => /🎬/.test(b.textContent)).length };
tab(ed, 'rules').click(); await wait(300); R.rules_tab = { has_table: /規則/.test(ed.textContent), builder: !!([...ed.querySelectorAll('button')].find((b) => /加這條規則/.test(b.textContent))) };
const addRule = [...ed.querySelectorAll('button')].find((b) => /加這條規則/.test(b.textContent)); const nr0 = G.find(spec0(), 'coin', 'prefab') >= 0 ? (spec0().objects[G.find(spec0(), 'coin', 'prefab')].rules || []).length : -1;
ed._ed.ctx.apply([{ op: 'add_rule', target: { prefab: 'coin' }, rule: { event: 'timer', after: 5, do: [{ say: 'hi' }] } }], '新增規則', '', 'panel'); await wait(200); R.rules_tab.added = G.find(spec0(), 'coin', 'prefab') >= 0 && (spec0().objects[G.find(spec0(), 'coin', 'prefab')].rules || []).length >= nr0;
tab(ed, 'audio').click(); await wait(200); R.audio_tab = { sfx_buttons: [...ed.querySelectorAll('button')].filter((b) => /🔊/.test(b.textContent)).length >= 10 };
tab(ed, 'src').click(); await wait(300); const ta = [...ed.querySelectorAll('textarea.code')].pop(); R.yaml_tab = { has_game: /game:/.test(ta.value), roundtrip: G.fromYaml(ta.value).ok };
ta.value = ta.value.replace(/title: .*/, 'title: 改過的遊戲'); ta.dispatchEvent(new Event('input')); tab(ed, 'play').click(); await wait(500); R.yaml_applied = { title: spec0().game.title };
tab(ed, 'src').click(); await wait(200); ta.value = 'game: [oops'; ta.dispatchEvent(new Event('input')); tab(ed, 'play').click(); await wait(300); R.yaml_bad_stays = { on_source: ed.querySelector('.tabs span.on').getAttribute('data-t') === 'src' };
ta.value = ''; tab(ed, 'play').click(); await wait(100); tab(ed, 'src').click(); await wait(100); tab(ed, 'play').click(); await wait(200);
tab(ed, 'pack').click(); await wait(300); R.pack_tab = { targets: [...ed.querySelectorAll('button')].filter((b) => /Electron|SDL2|FC／NES|網頁版/.test(b.textContent)).length, open_input: !!ed.querySelector('input[type=file]') };

console.log('GSTEP export: .fagame, round trip; the web pag');
// ── export: .fagame, round trip; the web page runs and gives the same hash as the test vector
const mo = fa._gameMountOpts(o1.id, '2d'); const sp1 = ed._ed.getSpec();
const bytes = await mo.pack(sp1, { editor: { state: ed._ed.getState(), log: [], prompt: 'x' } }); R.pack = { bytes: bytes.length, zip: bytes[0] === 0x50 && bytes[1] === 0x4b };
const reopened = await fa._gameOpenPack(new Blob([bytes])); R.pack_reopen = { ok: reopened.ok, title: reopened.title, problems: (reopened.problems || []).length };
fa._renderMessageHistory(); const ed2 = await until(() => { const l = [...document.querySelectorAll('.few')].filter((e) => e._ed && e._ed.editor && e._ed.editor.editSim); return l.length > 1 ? l[l.length - 1] : null; }, 15000); R.pack_reopen.same = !!ed2 && JSON.stringify(G.validate(ed2._ed.getSpec()).spec.objects) === JSON.stringify(G.validate(sp1).spec.objects);
const webOut = await fa._gameGenerate('web', G.starter('platformer-side', { name: 'W' })); const html = await webOut.download.blob.text(); R.web_export = { kb: Math.round(html.length / 1024), name: webOut.download.name };
const ifr = document.createElement('iframe'); ifr.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:360px;opacity:0.01'; ifr.srcdoc = html; document.body.appendChild(ifr); const fw = await until(() => ifr.contentWindow && ifr.contentWindow.FAGAME && ifr.contentWindow, 8000);
if (fw) { const vec = FaGameGen.vectors(G.starter('platformer-side', { name: 'W' }), { frames: 90, every: 30 }); const rr = fw.FaGameSim.create(fw.FAGAME.GAME, { seed: 1 }); vec.frames.forEach((h) => rr.step(h)); R.web_export.hash_match = rr.hash() === vec.hashes[vec.hashes.length - 1]; R.web_export.page_running = typeof fw.FAGAME.hash() === 'string'; R.web_export.canvas_colors = nonBlank(ifr.contentDocument.getElementById('c')); void rr; } else R.web_export.hash_match = false; ifr.remove();
const zipOut = await fa._gameGenerate('nodejs', sp1); await fa._ensureJSZipLoaded(); const zz = await JSZip.loadAsync(zipOut.download.blob); R.node_export = { files: Object.keys(zz.files).length, run: Object.keys(zz.files).some((f) => /run\.js$/.test(f)) };
const st0 = calls.llm; const pyOut = await fa._gameGenerate('python', sp1, () => {}); const pz = await JSZip.loadAsync(pyOut.download.blob); R.ai_port = { llm_calls: calls.llm - st0, files: Object.keys(pz.files).length, main: /ported/.test(await pz.file(Object.keys(pz.files).find((f) => /main\.py$/.test(f))).async('string')), vector: Object.keys(pz.files).some((f) => /TESTVECTOR\.json$/.test(f)), says_untested: /沒有在這裡編譯/.test(pyOut.summary) };
let fcErr = null; try { const fcOut = await fa._gameGenerate('fc', sp1, () => {}); R.ai_port.fc = { files: !!fcOut.download }; } catch (e) { fcErr = String(e.message || e); R.ai_port.fc = { err: fcErr }; }
// the sprite editor (a small pixel editor on the prefab) -> closed action update_prefab
E.draw(); const spriteBtn = (() => { ed._ed.select('player'); return null; })(); await wait(200); const eb = [...ed.querySelectorAll('button')].find((b) => /編輯外觀/.test(b.textContent)); R.sprite_editor = { button: !!eb };
if (eb) { eb.click(); await wait(200); const cells = [...ed.querySelectorAll('div')].filter((d) => d.style.cursor === 'crosshair'); R.sprite_editor.cells = cells.length; cells[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); const done = [...ed.querySelectorAll('button')].find((b) => /完成,套用到原型/.test(b.textContent)); if (done) { done.click(); await wait(300); } const pl = G.of(spec0(), 'prefab').find((p) => p.id === 'player'); R.sprite_editor.applied = pl.sprite.kind === 'pixels'; }

console.log('GSTEP persistence and a real reload of the edi');
// ── persistence and a real reload of the editor from the saved project
await wait(600); const proj = await FaEditStore.loadProject('edit-game-2d', o1.id); R.saved = { has_spec: !!(proj && proj.spec), steps: proj && proj.state ? proj.state.states.length : 0, title: proj && proj.spec.game.title };
const fresh = document.createElement('div'); document.body.appendChild(fresh); await fa._edMount('edit-game-2d', o1.id, fresh); const re = fresh.querySelector('.few'); R.reload = { mounted: !!re, steps: re ? re._ed.getState().states.length : 0, title: re ? re._ed.getSpec().game.title : null, canvas: re ? nonBlank(re.querySelector('canvas')) : 0 }; try { re._ed.destroy(); } catch (_) { /* */ } fresh.remove();

console.log('GSTEP all templates open in the editor and dra');
// ── all templates open in the editor and draw something
R.templates = {}; for (const t of G.listTemplates().filter((x) => x.dim === '2d')) { const r = await fa._edOpen('edit-game-2d', { starter: t.id }); fa._renderMessageHistory(); const e2 = await until(() => { const l = [...document.querySelectorAll('.few')].filter((e) => e._ed && e._ed.editor && e._ed.editor.editSim && !e._ed.editor.stage3()); const last = l[l.length - 1]; return last && last._ed.getSpec().game.template === t.id ? last : null; }, 8000); await wait(300); R.templates[t.id] = e2 ? nonBlank(e2.querySelector('canvas')) : -1; }

console.log('GSTEP 3D');
// ── 3D
const o3 = await fa._edOpen('edit-game-3d', { starter: 'walker-3rd' }); R.open3 = { ok: o3.ok }; fa._renderMessageHistory(); const ed3 = await until(() => lastEd(3), 15000); R.mounted3 = !!ed3; await wait(1200);
if (ed3) {
    const E3 = ed3._ed.editor, st3 = E3.stage3(); R.three = { webgl: !!st3.canvas.getContext('webgl2') || !!st3.canvas.getContext('webgl'), children: st3.content.children.length, rows: ed3.querySelectorAll('.ol .ob').length };
    const spec3 = () => ed3._ed.getSpec(); R.three.words = (async () => 0)(); const n3 = spec3().objects.length; await ed3._ed.send('在玩家前面放一個方塊'); await wait(300); R.three.words = { added: spec3().objects.length - n3 };
    btn(ed3, '▶ 試玩').click(); await wait(200); const z0 = E3.sim().player().pos[2]; kd(st3.el, 'ArrowDown'); await until(() => E3.sim().player().pos[2] - z0 > 0.6, 10000); ku(st3.el, 'ArrowDown'); R.three.play = { ticks: E3.sim().state.tick, moved_z: Math.round((E3.sim().player().pos[2] - z0) * 100) / 100, moved_back: E3.sim().player().pos[2] - z0 > 0.5, mesh_follows: (() => { const pl = E3.sim().player(), m = st3.content.children.find((c) => c.userData && c.userData.src === pl.id); return !!m && Math.abs(m.position.z - pl.pos[2]) < 0.05; })(), hud: !!ed3.querySelector('.e3-hud') };
    btn(ed3, '⏸ 暫停').click(); await wait(100); const t3 = E3.sim().state.tick; await wait(300); R.three.pause_frozen = E3.sim().state.tick === t3; btn(ed3, '⏹ 回到編輯').click(); await wait(200);
    const pl3 = E3.editSim().state.entities.find((e) => (e.tags || []).indexOf('player') >= 0); const v = new THREE.Vector3(pl3.pos[0], pl3.pos[1], pl3.pos[2]).project(st3.camera), rc = st3.canvas.getBoundingClientRect(); const sx = rc.left + (v.x + 1) / 2 * rc.width, sy = rc.top + (1 - v.y) / 2 * rc.height; const hit = st3.pickAt(sx, sy); R.three.pick = { src: hit && hit.src, expected: pl3.id };
    st3.canvas.dispatchEvent(ptr('pointerdown', sx, sy)); await wait(60); R.three.selected = (ed3.querySelector('.ol .ob.sel') || { getAttribute: () => null }).getAttribute('data-id'); st3.canvas.dispatchEvent(ptr('pointerup', sx, sy)); await wait(100);
    R.three.yaml = (() => { tab(ed3, 'src').click(); const t = [...ed3.querySelectorAll('textarea.code')].pop(); const ok = /dimension: 3d/.test(t.value) || /3d/.test(t.value); tab(ed3, 'play').click(); return ok; })();
    const w3 = await fa._gameGenerate('threejs', spec3()); const h3 = await w3.download.blob.text(); R.three.export = { three_cdn: /three@/.test(h3), kb: Math.round(h3.length / 1024) };
    R.three.templates = {}; for (const t of G.listTemplates().filter((x) => x.dim === '3d')) { const r = await fa._edOpen('edit-game-3d', { starter: t.id }); R.three.templates[t.id] = r.ok; }
}

console.log('GSTEP slash commands');
// ── slash commands
const cmd = (c) => (fa.slashCommands.get ? fa.slashCommands.get(c) : fa.slashCommands[c]); fa.messages = []; await cmd('/edit-game-2d').handler('', fa); R.slash_help = /platformer-side/.test(String((fa.messages[fa.messages.length - 1] || {}).content || '')); const n0 = fa.messages.length; await cmd('/edit-game-2d').handler('fighting', fa); R.slash_starter = fa.messages.slice(n0).some((m) => /```fa-edit-game-2d/.test(String(m.content || ''))); await cmd('/edit-game-3d').handler('runner-3d', fa); R.slash_3d = fa.messages.some((m) => /```fa-edit-game-3d/.test(String(m.content || '')));
document.querySelectorAll('.few').forEach((e) => { try { e._ed && e._ed.destroy(); } catch (_) { /* */ } });
return R;
