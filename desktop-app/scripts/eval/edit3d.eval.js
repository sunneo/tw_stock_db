// /edit-3d-model（真實 Electron；模型、視覺模型、生圖用假的）：開啟、掛載、樹狀物件欄、用說的擺放（以目前相機算位置:轉了視角之後同一句話放到另一邊）、
// 點物件選取與拖曳、YAML 原始碼分頁（改了切回畫面立刻呈現；壞的 YAML 留在原分頁）、單一物件編輯（貼皮、完成交回場景、復原）、貼圖、匯出的場景通過 render_3d_scene 的嚴格驗證、重新整理後還原、斜線指令與工具。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit3d.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(60); } return null; };
const png = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); draw(g, w, h); return c.toDataURL('image/png'); };
const tex = png(128, 128, (g) => { g.fillStyle = '#2a7'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#fc0'; g.beginPath(); g.arc(64, 64, 40, 0, 7); g.fill(); });
const calls = { llm: 0 };
fa._getApiConfig = () => ({ apiKey: 'test', apiUrl: 'http://127.0.0.1:9', apiModel: 'fake' });
fa._kiLlm = async (prompt, opts) => { calls.llm++; const t = String(prompt); if (/讓桌子旁邊/.test(t)) return JSON.stringify({ say: '放了一盞燈', edits: [{ op: 'add_object', object: { type: 'light', light: 'point', name: '檯燈', intensity: 1.5 }, place: { of: '桌子', rel: 'right' } }] }); return JSON.stringify({ say: 'ok', edits: [] }); };
fa._interpretImageWithVisionModel = async () => ({ description: 'a wooden table' });
const lastEd = () => { const l = [...document.querySelectorAll('.few')].filter((e) => e._ed && e._ed.editor && e._ed.editor.stage); return l[l.length - 1]; };
const specOf = (el) => el._ed.getSpec(); const C = FaEdit3d; const get = (sp, n) => sp.objects[C.find(sp, n)];
const screenOf = (stage, w) => { const v = new THREE.Vector3(w[0], w[1], w[2]).project(stage.camera), r = stage.canvas.getBoundingClientRect(); return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; };
const ptr = (type, x, y, extra) => new PointerEvent(type, Object.assign({ clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 7, button: 0, isPrimary: true }, extra || {}));

// ── open
const o1 = await fa._ed3dOpen({ starter: 'room' }); R.open = { ok: o1.ok };
R.fence = !!fa.messages.filter((m) => /```fa-edit-3d/.test(String(m.content || ''))).pop();
fa._renderMessageHistory(); const ed = await until(() => lastEd()); R.mounted = !!ed;
await wait(1200); const stage = ed._ed.editor.stage; const gl = !!stage.canvas.getContext('webgl2') || !!stage.canvas.getContext('webgl'); R.webgl = gl; R.three_ok = typeof THREE;
R.objects = specOf(ed).objects.length; R.scene_children = stage.content.children.length;
// ── the tree
const rows = [...ed.querySelectorAll('.ol .ob')]; const pads = rows.map((r) => parseInt(r.style.paddingLeft || '0', 10));
R.tree = { rows: rows.length, indented: pads.filter((p) => p > 6).length, group_has_fold: rows.some((r) => /[▾▸]/.test(r.querySelector('.ic').textContent)) };
const fold = rows.find((r) => /▾/.test(r.querySelector('.ic').textContent)); fold.querySelector('.ic').click(); await wait(100); R.tree.after_fold = ed.querySelectorAll('.ol .ob').length;
ed.querySelectorAll('.ol .ob').forEach((r) => { if (/▸/.test(r.querySelector('.ic').textContent)) r.querySelector('.ic').click(); }); await wait(100);
// ── words, from my view
const n0 = specOf(ed).objects.length; stage.applyCamera({ position: [0, 5, 10], look_at: [0, 0, 0], fov: 50 }); await wait(100);
const llm0 = calls.llm; await ed._ed.send('在我的左前方放一個紅色的球'); await wait(400);
let ball = specOf(ed).objects[specOf(ed).objects.length - 1];
R.words_left_front = { added: specOf(ed).objects.length - n0, name: ball.name, llm_calls: calls.llm - llm0, x: ball.position[0], z: ball.position[2], selected: !!ed.querySelector('.ol .ob.sel') };
stage.applyCamera({ position: [10, 5, 0], look_at: [0, 0, 0], fov: 50 }); await wait(100);   // now I stand at +x looking toward -x: my left is +z
await ed._ed.send('在我的左前方放一個藍色的方塊'); await wait(400); const box1 = specOf(ed).objects[specOf(ed).objects.length - 1];
R.words_turned = { name: box1.name, x: box1.position[0], z: box1.position[2] };
await ed._ed.send('把藍色方塊移到桌子上面'); await wait(300); const tb = C.worldBox(specOf(ed), get(specOf(ed), '桌子')), bb = C.worldBox(specOf(ed), get(specOf(ed), box1.name));
R.words_onto_table = { bottom: bb.min[1], table_top: tb.max[1], over_table: Math.abs(bb.center[0] - tb.center[0]) < 0.05 && Math.abs(bb.center[2] - tb.center[2]) < 0.05 };
const llm1 = calls.llm; await ed._ed.send('讓桌子旁邊亮一點'); await wait(500); R.llm_path = { llm_calls: calls.llm - llm1, lamp: specOf(ed).objects.some((o) => o.name === '檯燈') };
// ── undo / redo
const cnt = specOf(ed).objects.length; ed._ed.undo(); await wait(100); R.undo = specOf(ed).objects.length === cnt - 1; ed._ed.redo(); await wait(100); R.redo = specOf(ed).objects.length === cnt;
// ── pick and drag in the viewer
stage.applyCamera({ position: [0, 6, 9], look_at: [0, 0.5, 0], fov: 50 }); await wait(300);
const tgt = get(specOf(ed), '紅色球'), wb = C.worldBox(specOf(ed), tgt), sp0 = screenOf(stage, wb.center);
const hit = stage.pickAt(sp0[0], sp0[1]); R.pick = { src: hit && hit.src, expected: tgt.id };
stage.canvas.dispatchEvent(ptr('pointerdown', sp0[0], sp0[1])); await wait(50);
R.pick.selected = (ed.querySelector('.ol .ob.sel') || { getAttribute: () => null }).getAttribute('data-id');
const before = get(specOf(ed), '紅色球').position.slice();
stage.canvas.dispatchEvent(ptr('pointermove', sp0[0] + 40, sp0[1] + 6)); stage.canvas.dispatchEvent(ptr('pointermove', sp0[0] + 90, sp0[1] + 12)); stage.canvas.dispatchEvent(ptr('pointerup', sp0[0] + 90, sp0[1] + 12)); await wait(300);
const after = get(specOf(ed), '紅色球').position; R.drag = { moved: Math.abs(after[0] - before[0]) > 0.3, y_same: Math.abs(after[1] - before[1]) < 0.01, dx: Math.round((after[0] - before[0]) * 100) / 100 };
// ── the YAML source tab
ed.querySelector('.tabs span[data-t="source"]').click(); await wait(200); const ta = [...ed.querySelectorAll('textarea.code')].pop();
R.yaml_tab = { has_title: /title:/.test(ta.value), has_group: /mesh: group/.test(ta.value), has_ids: /id: o\d/.test(ta.value), roundtrip: C.fromYaml(ta.value).ok };
ta.value = ta.value.replace(/background: .*/, "background: '#223344'"); ta.dispatchEvent(new Event('input')); ed.querySelector('.tabs span[data-t="view"]').click(); await wait(500);
R.yaml_applied = { background: specOf(ed).background, steps: ed._ed.getState().states.length };
ed.querySelector('.tabs span[data-t="source"]').click(); await wait(200); ta.value = 'title: [oops'; ta.dispatchEvent(new Event('input')); ed.querySelector('.tabs span[data-t="view"]').click(); await wait(300);
R.yaml_bad_stays = { on_source: ed.querySelector('.tabs span.on').getAttribute('data-t') === 'source', error: [...ed.querySelectorAll('.st')].some((s) => /YAML/.test(s.textContent)) };
ta.value = ''; ed.querySelector('.tabs span[data-t="view"]').click(); ed.querySelector('.tabs span[data-t="source"]').click(); await wait(100); ed.querySelector('.tabs span[data-t="view"]').click(); await wait(200);
// ── a texture from the chat for the selected object
ed._ed.select(get(specOf(ed), '紅色球').id); await ed._ed.addImages([{ name: 'tex.png', dataUrl: tex }]); await ed._ed.send(''); await until(() => get(specOf(ed), '紅色球').material.texture, 15000);
R.texture = { texture: String(get(specOf(ed), '紅色球').material.texture || '').slice(0, 8), kept: await FaEditStore.getImage(String(get(specOf(ed), '紅色球').material.texture).slice(4)).then((b) => !!b) };
// ── the single-object editor
const boxObj = get(specOf(ed), box1.name); ed._ed.select(boxObj.id); await wait(100); const dbl = [...ed.querySelectorAll('.ol .ob')].find((r) => r.getAttribute('data-id') === boxObj.id); dbl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
const partEl = await until(() => fa._edParts && fa._edParts.size ? [...fa._edParts.values()][0].node : null, 15000); R.part_opened = !!partEl;
await wait(1200); const pstage = partEl && partEl._ed && partEl._ed.editor.stage; R.part_stage = !!pstage; R.part_popped = !!(partEl && partEl._win && partEl._win.isPopped());
await partEl._ed.send('把前面塗成紅色，上面漆成綠色'); await wait(400); R.part_words = partEl._ed.getSpec().objects.map((o) => o.zone + ':' + o.color).join();
await partEl._ed.addImages([{ name: 'tex.png', dataUrl: tex }]); await partEl._ed.send('貼在右面的右上角'); await until(() => partEl._ed.getSpec().objects.some((o) => o.image), 15000);
const img = partEl._ed.getSpec().objects.find((o) => o.image); R.part_image = { zone: img && img.zone, u: img && img.u, v: img && img.v, w: img && img.w };
// click on the model moves the selected skin there
const pp = screenOf(pstage, [0.1, 0.3, 0.6]); const pickP = pstage.pickAt(pp[0], pp[1]); R.part_pick = !!pickP;
partEl._ed.select(img.id); await wait(100); pstage.canvas.dispatchEvent(ptr('pointerdown', pp[0], pp[1])); pstage.canvas.dispatchEvent(ptr('pointerup', pp[0], pp[1])); await wait(300);
const img2 = partEl._ed.getSpec().objects.find((o) => o.id === img.id); R.part_click_moved = !!(img2 && (img2.u !== img.u || img2.v !== img.v || img2.zone !== img.zone)); R.part_zone_after = img2 && img2.zone;
const stepsP = partEl._ed.getState().states.length; partEl._ed.undo(); await wait(100); const imgU = partEl._ed.getSpec().objects.find((o) => o.id === img.id); R.part_undo = { steps_before_undo: stepsP, still_there: !!imgU, u_back: !!imgU && imgU.u === img.u };
const nSkins = partEl._ed.getSpec().objects.length; const stepsBefore = ed._ed.getState().states.length;
[...partEl.querySelectorAll('button')].find((b) => /完成/.test(b.textContent)).click(); await wait(500);
R.part_done = { skins_on_object: (get(specOf(ed), box1.name).skins || []).length, expected: nSkins, scene_step_added: ed._ed.getState().states.length === stepsBefore + 1, window_closed: !fa._edParts.size };
const sc = C.toScene(specOf(ed), { resolve: (r) => FaEditStore.imageUrl(String(r).replace(/^ref:/, '')) }); const decals = sc.nodes.filter((n) => n.mesh === 'plane' && n.material.side === 'double');
R.decals = { count: decals.length, textured: decals.filter((d) => /^data:image/.test(d.material.texture || '')).length };
// a picture skin: a part with one image skin -> a textured decal and a textured whole-object material
const withImg = C.applyEdits(specOf(ed), [{ op: 'add_skin', id: box1.name, skin: { zone: '+x', image: get(specOf(ed), '紅色球').material.texture, w: 0.5, h: 0.5 } }]).spec; const sc3 = C.toScene(withImg, { resolve: (r) => FaEditStore.imageUrl(String(r).replace(/^ref:/, '')) }); R.decals.image_decal = sc3.nodes.filter((n) => n.mesh === 'plane' && /^data:image/.test(n.material.texture || '')).length; R.texture_in_scene = sc3.nodes.filter((n) => n.mesh === 'sphere')[0] && /^data:image/.test(sc3.nodes.filter((n) => n.mesh === 'sphere')[0].material.texture || '');
ed._ed.undo(); await wait(100); R.part_scene_undo = (get(specOf(ed), box1.name).skins || []).length === 0; ed._ed.redo(); await wait(100);
// a skin on a curved surface is painted into the texture of the sphere (needs a canvas)
const bk = FaEdit3dUI.makeBaker((r) => FaEditStore.imageUrl(String(r).replace(/^ref:/, ''))); const wsp = C.applyEdits(specOf(ed), [{ op: 'add_skin', id: '紅色球', skin: { zone: 'wrap', color: '#00ff00', u: 0.5, v: 0.5, w: 0.4, h: 0.4 } }]).spec; const scW = C.toScene(wsp, { resolve: (r) => FaEditStore.imageUrl(String(r).replace(/^ref:/, '')), bake: bk.bake }); const sph = scW.nodes.filter((n) => n.mesh === 'sphere')[0]; R.wrap_bake = !!sph && /^data:image\/png/.test(sph.material.texture || '') && sph.material.color === '#ffffff';
// ── the exported scene plays in render_3d_scene (strict validation) and in the assistant's own viewer
await fa._ensureJsYamlLoaded(); const yml = C.toSceneYaml(specOf(ed), { resolve: (r) => FaEditStore.imageUrl(String(r).replace(/^ref:/, '')) }); const val = fa._validate3DSceneYaml(yml);
R.export_scene = { yaml_chars: yml.length, strict_ok: val.ok, error: val.error, nodes: val.expandedNodes && val.expandedNodes.length, warnings: (val.warnings || []).length };
const host = document.createElement('div'); host.style.cssText = 'width:480px;height:320px'; document.body.appendChild(host); let handle = null; try { handle = await fa._mount3DScene(host, yml); } catch (e) { R.mount_error = String(e).slice(0, 100); } await wait(800); R.export_scene.viewer_canvas = !!host.querySelector('canvas'); host.remove();
// ── project saved, then back after a reload of the messages
await wait(900); const pj = await FaEditStore.loadProject('edit-3d', o1.id); R.saved = !!pj && pj.state.states.length >= 6;
const nObj = specOf(ed).objects.length, stepsNow = ed._ed.getState().states.length; const holder = document.createElement('div'); document.body.appendChild(holder); fa._edEditors.set('edit-3d:' + o1.id + '-again', holder); await fa._edMount('edit-3d', o1.id, holder); await wait(800); const ed2 = holder._ed ? holder.querySelector('.few') : null;
R.restored = !!ed2 && ed2 !== ed && specOf(ed2).objects.length === nObj && ed2._ed.getState().states.length === stepsNow && specOf(ed2).background === specOf(ed).background && !!holder.querySelector('canvas'); R.restored_detail = { objects: ed2 && specOf(ed2).objects.length, nObj, steps: ed2 && ed2._ed.getState().states.length, stepsNow }; holder.remove();
// ── the way in: the latest scene of the conversation, a yaml, slash and tool, hints
const msg = { role: 'tool', content: '[scene]' }; Object.defineProperty(msg, '_displayScene3DYaml', { value: yml, enumerable: false, configurable: true, writable: true }); fa.messages.push(msg);
const o3 = await fa._ed3dOpen({ last: true }); R.last_scene = { ok: o3.ok, id: !!o3.id };
fa._renderMessageHistory(); const ed3 = await until(() => { const l = [...document.querySelectorAll('.few')].filter((e) => e._ed && e._ed.editor && e._ed.editor.stage); return l.length >= 2 ? l[l.length - 1] : null; }); await wait(800);
R.last_scene.objects = ed3 && specOf(ed3).objects.length; R.last_scene.origin_button = !!(ed3 && [...ed3.querySelectorAll('button')].some((b) => /更新回原本/.test(b.textContent)));
if (ed3) { await ed3._ed.send('在畫面中間放一個黃色圓柱'); await wait(300); const upd = await [...ed3.querySelectorAll('button')].find((b) => /更新回原本/.test(b.textContent)).click(); await wait(600); R.last_scene.origin_updated = fa.messages.some((m) => m === msg && m._displayScene3DYaml !== yml && /cylinder/.test(m._displayScene3DYaml)); }
// the ✏️ button on a 3D scene card of the conversation opens the editor on that very scene, linked back to it
const nEd = [...document.querySelectorAll('.few')].filter((x) => x._ed && x._ed.editor && x._ed.editor.stage).length; fa._renderMessageHistory(); const eb = await until(() => [...document.querySelectorAll('button')].find((b) => b.textContent === '✏️ 編輯'), 10000); R.card_button = !!eb; if (eb) { eb.click(); await until(() => [...document.querySelectorAll('.few')].filter((x) => x._ed && x._ed.editor && x._ed.editor.stage).length > nEd, 15000); await wait(600); const eds = [...document.querySelectorAll('.few')].filter((x) => x._ed && x._ed.editor && x._ed.editor.stage); const last = eds[eds.length - 1]; R.card_opened = { editors: eds.length - nEd, origin_button: [...last.querySelectorAll('button')].some((b) => /更新回原本/.test(b.textContent)) }; }
const o4 = await fa._ed3dOpen({ yaml: 'title: Y\nnodes:\n  - {mesh: box, position: [0, 0.5, 0], material: {color: "#0f0"}}\n  - {mesh: sphere, radius: 0.4, position: [2, 0.4, 0]}\n' }); R.from_yaml = { ok: o4.ok };
const cmd = (c) => fa.slashCommands.get ? fa.slashCommands.get(c) : fa.slashCommands[c]; fa.messages = []; await cmd('/edit-3d-model').handler('', fa); R.slash_help = /room/.test(String((fa.messages[fa.messages.length - 1] || {}).content || '')); await cmd('/edit-3d-model').handler('studio', fa); R.slash_starter = fa.messages.some((m) => /fa-edit-3d/.test(String(m.content || ''))); R.slash_alias = !!cmd('/edit-3d');
const t3 = JSON.parse(await fa.tools.edit_3d_open.callback.call(fa, JSON.stringify({ starter: 'model' }))); R.tool = t3.ok === true;
R.hints = ['幫我用 3D 場景編輯器擺一個房間', '在我的左前方放一個球', '怎麼用 3D 場景編輯器', '今天天氣如何'].map((t) => _faTaskToolHints(t).map((h) => h.id).join());
R.domain = !!(fa.domains && fa.domains.editors && fa.domains.editors.toolNames.includes('edit_3d_open'));
document.querySelectorAll('.few').forEach((e) => { try { e._ed && e._ed.destroy(); } catch (_) { /* */ } });
return R;
