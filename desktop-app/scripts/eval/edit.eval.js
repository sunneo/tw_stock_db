// /edit-svg 與 /edit-picture（真實 Electron；模型、視覺模型、生圖用假的）：開啟、掛載、用說的加物件（程式先讀、其餘交給假 LLM）、描圖、貼圖成第一個圖層、
// 「變成水彩」（視覺模型先說不像→加強→確認；只多一個濾鏡層、原圖沒動）、修復、AI 重畫、匯出、放進對話、重新整理後從專案還原、斜線指令與工具。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(60); } return null; };
const editors = (kind) => [...document.querySelectorAll('.few')].filter((e) => !kind || (e._ed && e.getAttribute('data-kind') === kind || true));
const lastEd = () => { const l = [...document.querySelectorAll('.few')]; return l[l.length - 1]; };
const specOf = (el) => el._ed.getSpec(); const objsOf = (el) => specOf(el).objects;
const png = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); draw(g, w, h); return c.toDataURL('image/png'); };
const photo = png(240, 180, (g, w, h) => { g.fillStyle = '#7ec8f0'; g.fillRect(0, 0, w, h); g.fillStyle = '#3a8f3a'; g.fillRect(0, 120, w, 60); g.fillStyle = '#ffd400'; g.beginPath(); g.arc(190, 40, 22, 0, 7); g.fill(); g.fillStyle = '#b5532a'; g.fillRect(60, 80, 70, 50); g.fillStyle = '#7a1f1f'; g.beginPath(); g.moveTo(50, 80); g.lineTo(95, 45); g.lineTo(140, 80); g.fill(); });
const calls = { llm: [], vision: [], gen: [] };
fa._getApiConfig = () => ({ apiKey: 'test', apiUrl: 'http://127.0.0.1:9', apiModel: 'fake' });
fa._kiLlm = async (prompt, opts) => { calls.llm.push({ sys: String((opts && opts.systemPrompt) || '').slice(0, 60), prompt: String(prompt).slice(0, 200) }); if (/name the colour regions/.test((opts && opts.systemPrompt) || '')) return '1=天空\n2=草地'; if (/tidy a prompt/.test((opts && opts.systemPrompt) || '')) return 'tidy prompt'; if (/污點/.test(prompt)) return JSON.stringify({ say: '修好了', edits: [{ op: 'add_heal', of: 'o1', at: 'bottom-right', r: 30, method: 'inpaint' }] }); return JSON.stringify({ say: '加了一朵雲', edits: [{ op: 'add_object', object: { type: 'shape', shape: 'ellipse', name: '雲', fill: '#ffffff', w: 120, h: 60 }, place: { of: 'canvas', rel: 'center' } }] }); };
let visionYes = 0;
fa._interpretImageWithVisionModel = async (du, q) => { calls.vision.push(String(q).slice(0, 60)); if (/Does this picture look like/.test(q)) { visionYes++; return { answer: visionYes >= 2 ? 'Yes, it looks painted.' : 'No, it is too sharp.' }; } return { description: 'a red house on a green field under a blue sky with a yellow sun' }; };
fa._generateImage = async (a) => { calls.gen.push(a); const blob = await (await fetch(png(256, 256, (g) => { g.fillStyle = '#c33'; g.fillRect(0, 0, 256, 256); g.fillStyle = '#fc3'; g.fillRect(60, 60, 140, 140); }))).blob(); const id = await fa.fileCache.put('gen-test.png', 'image/png', blob, 'generated'); return { ok: true, images: [{ file_id: id, seed: 4242 }] }; };

// ───────── /edit-svg ─────────
const o1 = await fa._edOpen('edit-svg', { starter: 'shapes' }); R.svg_open = { ok: o1.ok };
R.svg_fence = !!fa.messages.filter((m) => /```fa-edit-svg/.test(String(m.content || ''))).pop();
fa._renderMessageHistory(); const sv = await until(() => lastEd()); R.svg_mounted = !!sv;
await until(() => objsOf(sv).length >= 1); const n0 = objsOf(sv).length; R.svg_starter_objects = n0;
await until(() => sv.querySelector('svg, canvas')); R.svg_viewer = !!sv.querySelector('.pane.vp svg, .pane.vp canvas, .pane.vp div');
// 說「畫一個紅色的圓」：位置由程式算，內容由（假的）模型回封閉動作
const llm0 = calls.llm.length; await sv._ed.send('在中間畫一個紅色的圓'); await wait(300);
R.svg_program_add = { objects: objsOf(sv).length - n0, llm_calls: calls.llm.length - llm0, last: (objsOf(sv)[objsOf(sv).length - 1] || {}).fill };
// 程式讀不懂 → 假 LLM 回封閉動作
const n1 = objsOf(sv).length; await sv._ed.send('在太陽的上面加一朵雲，要有點可愛的感覺'); await wait(500);
R.svg_llm_add = { objects: objsOf(sv).length - n1, name: (objsOf(sv)[objsOf(sv).length - 1] || {}).name, llm_calls: calls.llm.length - llm0 };
// 復原／重做
const st0 = sv._ed.getState(); sv._ed.undo(); await wait(100); R.svg_undo = objsOf(sv).length === n1; sv._ed.redo(); await wait(100); R.svg_redo = objsOf(sv).length === n1 + 1; R.svg_steps = st0.states.length;
// 描圖：貼進對話的圖 → SVG 物件（程式描、視覺模型看、數字量）
const blob = await (await fetch(photo)).blob(); const logs = []; const vec = await fa._edVectorize(blob, { status: (t) => logs.push(t) });
R.svg_trace = { objects: vec.objects.length, score: Math.round(vec.score * 100), ok: vec.ok, rounds: logs.filter((l) => /輪|Round/.test(l)).length, named: vec.objects.some((o) => /天空|草地/.test(o.name)) };
const n2 = objsOf(sv).length; await sv._ed.addImages([{ name: 'photo.png', dataUrl: photo }]); await sv._ed.send('描成 SVG'); await until(() => objsOf(sv).length > n2 + 2, 30000); R.svg_traced_into_editor = objsOf(sv).length - n2;
// 輸出：下載與放進對話
const svgText = FaEditSvg.compose(specOf(sv)); R.svg_compose = /^<svg/.test(svgText) && svgText.length > 200;
const m0 = fa.messages.length; await fa._edToChat('edit-svg', new Blob([svgText], { type: 'image/svg+xml' }), 'drawing.svg', { title: 'test', prompt: 'a prompt' }); R.svg_to_chat = fa.messages.slice(m0).some((m) => /a prompt/.test(String(m.content || '')));
// 專案存起來了：重新掛載（模擬重新整理）還原
await wait(900); const svId = o1.id; const proj = await FaEditStore.loadProject('edit-svg', svId); R.svg_saved = !!proj && proj.state && proj.state.states.length >= 4;
const hs = document.createElement('div'); document.body.appendChild(hs); fa._edEditors.set('edit-svg:' + svId + '-again', hs); await fa._edMount('edit-svg', svId, hs); await wait(600); const sv2 = hs.querySelector('.few'); R.svg_restored = !!sv2 && sv2 !== sv && specOf(sv2).objects.length === objsOf(sv).length && sv2._ed.getState().states.length === sv._ed.getState().states.length; hs.remove();

// ───────── /edit-picture ─────────
const o2 = await fa._edOpen('edit-picture', { starter: 'blank' }); R.pic_open = { ok: o2.ok };
fa._renderMessageHistory(); const pc = await until(() => { const l = [...document.querySelectorAll('.few')]; return l.length > 1 ? l[l.length - 1] : null; }); R.pic_mounted = !!pc && pc !== sv;
await pc._ed.addImages([{ name: 'photo.png', dataUrl: photo }]); await pc._ed.send(''); await until(() => objsOf(pc).some((o) => o.type === 'image')); R.pic_first_layer = { images: objsOf(pc).filter((o) => o.type === 'image').length, canvas: specOf(pc).canvas && [specOf(pc).canvas.w, specOf(pc).canvas.h] };
// 變成水彩：程式放濾鏡層；視覺模型先說不像→加強→再說像
const before = JSON.stringify(objsOf(pc).filter((o) => o.type === 'image').map((o) => o.ref)); const v0 = calls.vision.length; await pc._ed.send('把它變成水彩風格'); await until(() => objsOf(pc).some((o) => o.type === 'adjust'), 30000);
const adj = objsOf(pc).filter((o) => o.type === 'adjust'); R.pic_restyle = { adjust_layers: adj.length, vision_calls: calls.vision.filter((q) => /Does this picture look like/.test(q)).length, picture_untouched: before === JSON.stringify(objsOf(pc).filter((o) => o.type === 'image').map((o) => o.ref)), ops: adj[0] && adj[0].ops && adj[0].ops.map((o) => o.op).join(',') };
// 隱藏濾鏡層，畫面真的變回去
const r1 = await FaEditPictureUI.render(specOf(pc), { store: FaEditStore, resolve: (ref) => FaEditStore.imageUrl(ref), frameOnly: true, maxSide: 120 });
const hid = JSON.parse(JSON.stringify(specOf(pc))); hid.objects.forEach((o) => { if (o.type === 'adjust') o.visible = false; });
const r2 = await FaEditPictureUI.render(hid, { store: FaEditStore, resolve: (ref) => FaEditStore.imageUrl(ref), frameOnly: true, maxSide: 120 });
const diff = (a, b) => { const A = a.canvas.getContext('2d').getImageData(0, 0, a.canvas.width, a.canvas.height).data, B = b.canvas.getContext('2d').getImageData(0, 0, b.canvas.width, b.canvas.height).data; let d = 0; for (let i = 0; i < Math.min(A.length, B.length); i += 4) d += Math.abs(A[i] - B[i]); return d; };
R.pic_filter_changes_pixels = diff(r1, r2) > 1000;
// 修復：右下角的污點
const nh = objsOf(pc).length; await pc._ed.send('修掉右下角的污點'); await until(() => objsOf(pc).some((o) => o.type === 'heal')); R.pic_heal = objsOf(pc).filter((o) => o.type === 'heal').length;
// 一般的調整（程式先讀）
const llm1 = calls.llm.length; await pc._ed.send('調亮'); await wait(300); R.pic_bright = { adjust_layers: objsOf(pc).filter((o) => o.type === 'adjust').length, llm_calls: calls.llm.length - llm1 };
// AI 重畫（視覺描述＋生圖）
const g0 = calls.gen.length; await pc._ed.send('用 AI 重畫成油畫'); await until(() => calls.gen.length > g0, 30000); await wait(500); R.pic_repaint = { gen_calls: calls.gen.length - g0, prompt: String((calls.gen[calls.gen.length - 1] || {}).prompt || '').slice(0, 120), images: objsOf(pc).filter((o) => o.type === 'image').length, seed: (objsOf(pc).filter((o) => o.seed).pop() || {}).seed };
// 匯出
const out = await FaEditPictureUI.render(specOf(pc), { store: FaEditStore, resolve: (ref) => FaEditStore.imageUrl(ref), maxSide: 800 }); R.pic_export = out && out.canvas ? [out.canvas.width, out.canvas.height] : null;
const m1 = fa.messages.length; const pngBlob = await new Promise((res) => out.canvas.toBlob(res, 'image/png')); await fa._edToChat('edit-picture', pngBlob, 'picture.png', { title: 'pic', prompt: 'pic prompt' }); R.pic_to_chat = fa.messages.slice(m1).some((m) => /pic prompt/.test(String(m.content || ''))) && fa.messages.slice(m1).some((m) => m._displayDataUrl);
// 重新整理後還原
await wait(900); const pid = o2.id; const pj = await FaEditStore.loadProject('edit-picture', pid); R.pic_saved = !!pj && pj.state.states.length >= 5;
const hp = document.createElement('div'); document.body.appendChild(hp); fa._edEditors.set('edit-picture:' + pid + '-again', hp); await fa._edMount('edit-picture', pid, hp); await wait(900); const pc2 = hp.querySelector('.few'); R.pic_restored = !!pc2 && pc2 !== pc && specOf(pc2).objects.length === objsOf(pc).length && pc2._ed.getState().states.length === pc._ed.getState().states.length && !!pc2.querySelector('canvas, svg'); hp.remove();

// ───────── 斜線指令、工具、依任務補工具 ─────────
const cmd = (c) => fa.slashCommands.get ? fa.slashCommands.get(c) : fa.slashCommands[c];
fa.messages = []; await cmd('/edit-svg').handler('', fa); R.slash_svg_help = /shapes/.test(String((fa.messages[fa.messages.length - 1] || {}).content || ''));
await cmd('/edit-picture').handler('poster', fa); R.slash_pic_starter = fa.messages.some((m) => /fa-edit-picture/.test(String(m.content || '')));
const tres = JSON.parse(await fa.tools.edit_svg_open.callback.call(fa, JSON.stringify({ starter: 'flow' }))); R.tool_svg = tres.ok === true;
const tres2 = JSON.parse(await fa.tools.edit_picture_open.callback.call(fa, JSON.stringify({ starter: 'blank', style: 'oil' }))); R.tool_pic = tres2.ok === true;
R.hints = ['幫我畫一個 SVG 的圖示', '把這張圖描成 svg', '把這張照片變成水彩風格', '修掉照片右下角的污點', '怎麼讀 svg 檔', '今天天氣如何'].map((t) => _faTaskToolHints(t).map((h) => h.id).join());
R.domain = !!(fa.domains && fa.domains.editors && fa.domains.editors.enabled);
document.querySelectorAll('.few').forEach((e) => { try { e._ed && e._ed.destroy(); } catch (_) { /* */ } });
return R;
