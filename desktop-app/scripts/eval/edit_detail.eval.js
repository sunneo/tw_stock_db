// /edit-picture 的擴散細化層（真實 Electron；生圖模型是假的）:合成（只蓋區域、羽化、色調對齊、隱藏回到原樣）、宿主流程（裁片與脈絡、線上改圖／本機借紋理、啟用項）、語言入口與 UI 的框選。
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const fa = window.fa; const R = {}; const C = FaEditPicture, P = fa._edPics('edit-picture');
const mkBlob = (w, h, f) => new Promise((res) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), id = g.createImageData(w, h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f(x, y), o = (y * w + x) * 4; id.data[o] = v[0]; id.data[o + 1] = v[1]; id.data[o + 2] = v[2]; id.data[o + 3] = 255; } g.putImageData(id, 0, 0); c.toBlob(res, 'image/png'); });
const pix = (cv, x, y) => { const d = cv.getContext('2d').getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2]]; };
const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
// 底圖:平滑漸層（糊）;生出來的圖:高頻棋盤、色調偏紫
const baseK = await P.keep(await mkBlob(200, 200, (x, y) => [60 + x * 0.5, 110 + y * 0.3, 90]));
const genK = await P.keep(await mkBlob(256, 256, (x, y) => (((x >> 1) + (y >> 1)) % 2 ? [230, 90, 220] : [120, 20, 120])));
const baseSpec = C.validate({ canvas: { w: 200, h: 200 }, objects: [{ type: 'image', name: '底圖', ref: baseK.ref, x: 0, y: 0, w: 200, h: 200 }] }).spec;
const withDetail = (props) => C.applyEdits(baseSpec, [{ op: 'add_object', object: Object.assign({ type: 'detail', name: '細化', region: { x: 70, y: 70, w: 60, h: 60 }, crop: { x: 40, y: 40, w: 120, h: 120 }, result: genK.ref, state: 'preview' }, props) }]).spec;
const rd = (spec) => FaEditPictureUI.render(spec, { store: FaEditStore, resolve: (r) => FaEditStore.imageUrl(r), frameOnly: true });
const r0 = await rd(baseSpec), rEdit = await rd(withDetail({ refine: 'edit' })), rTex = await rd(withDetail({ refine: 'texture' }));
R.comp_outside_unchanged = diff(pix(r0.canvas, 10, 10), pix(rEdit.canvas, 10, 10)) === 0 && diff(pix(r0.canvas, 190, 190), pix(rTex.canvas, 190, 190)) === 0 && diff(pix(r0.canvas, 50, 100), pix(rEdit.canvas, 50, 100)) === 0;
const rowVar = (cv, y, x0, x1) => { let s = 0; let prev = null; for (let x = x0; x < x1; x++) { const p = pix(cv, x, y); if (prev) s += diff(p, prev); prev = p; } return s; };
R.comp_edit_inside_changed = diff(pix(r0.canvas, 100, 100), pix(rEdit.canvas, 100, 100)) > 20 && rowVar(rEdit.canvas, 100, 80, 120) > rowVar(r0.canvas, 100, 80, 120) * 3;
R.comp_edit_tone_matched = (() => { const a = pix(rEdit.canvas, 100, 100), b = pix(r0.canvas, 100, 100); return Math.abs(a[0] - b[0]) < 90 && Math.abs(a[1] - b[1]) < 90; })();   // 色調對到原圖附近，不是紫色
R.comp_texture_keeps_colours = (() => { let sa = 0, sb = 0; for (let x = 80; x < 120; x++) { const a = pix(rTex.canvas, x, 100), b = pix(r0.canvas, x, 100); sa += a[0] + a[1] + a[2]; sb += b[0] + b[1] + b[2]; } return Math.abs(sa - sb) / 40 < 25 && rowVar(rTex.canvas, 100, 80, 120) > rowVar(r0.canvas, 100, 80, 120) * 2; })();
R.comp_feather_no_seam = (() => { const colAvg = (cv, x) => { let t = 0; for (let y = 85; y < 115; y++) { const p = pix(cv, x, y); t += p[0] + p[1] + p[2]; } return t / 30; }; let m = 0; for (let x = 64; x < 80; x++) m = Math.max(m, Math.abs(colAvg(rEdit.canvas, x + 1) - colAvg(rEdit.canvas, x))); let hard = 0; const base0 = (x) => colAvg(r0.canvas, x); return m < 40; })();
const hidden = withDetail({ refine: 'edit' }); hidden.objects[1].visible = false; const rh = await rd(hidden);
R.comp_hidden_is_original = diff(pix(r0.canvas, 100, 100), pix(rh.canvas, 100, 100)) === 0;
const pend = withDetail({ result: '', crop: null, state: 'pending' }); const rp = await rd(pend); R.comp_pending_draws_nothing = diff(pix(r0.canvas, 100, 100), pix(rp.canvas, 100, 100)) === 0;
// ── 宿主:啟用項與流程（生圖是假的）──
// 視覺模型與文字模型也是假的（真的會去載入離線視覺模型，吃很多記憶體）
const aiCalls = []; fa._edAi = () => ({ have: () => true, vision: async (u, q) => { aiCalls.push('vision'); return 'a wooden sign with white letters'; }, chat: async (sys, u) => { aiCalls.push('chat'); return 'sign'; }, pick: async () => null, rewrite: async (t) => t });
const calls = []; const origGen = fa._generateImage.bind(fa);
fa._generateImage = async (a) => { calls.push(Object.assign({}, a, { init_image: a.init_image ? a.init_image.slice(0, 24) + '…(' + a.init_image.length + ')' : undefined })); const rec = await fa.fileCache.put('fake-gen.png', 'image/png', await mkBlob(512, 512, (x, y) => (((x >> 2) + (y >> 2)) % 2 ? [200, 160, 120] : [90, 70, 50])), 'generated'); return { ok: true, images: [{ file_id: rec, seed: a.seed }] }; };
fa.advancedSettings.editDiffusion = false; R.state_disabled = await fa._edDiffusionState(); const dis = await fa._edDetail({ spec: withDetail({ result: '', crop: null, state: 'pending' }), id: 'o2' });
R.disabled_refuses = dis.ok === false && /啟用|Enable/.test(dis.error);
await fa._edDiffusionSet(true); R.state_enabled = (await fa._edDiffusionState()).enabled === true && fa.advancedSettings.editDiffusion === true;
const fakeState = (o) => { fa._edDiffusionState = async () => Object.assign({ enabled: true, online: false, local: false, ready: true, reason: '' }, o); };
const spec1 = withDetail({ result: '', crop: null, state: 'pending', prompt: 'a sign with letters' }); const id1 = spec1.objects[1].id;
fakeState({ online: true }); const e1 = await fa._edDetail({ spec: spec1, id: id1 });
R.online_edit = e1.ok && e1.mode === 'edit' && e1.props.refine === 'edit' && e1.props.state === 'preview' && !!e1.props.result && calls[0] && calls[0].provider === 'online' && /kontext/.test(calls[0].model) && /^data:image\/png;base64,/.test(calls[0].init_image) && /sign/.test(calls[0].prompt);
R.crop_has_context = e1.props.crop.w > 60 && e1.props.crop.x < 70 && e1.props.crop.x >= 0 && e1.props.crop.w <= 200;
fakeState({ local: true }); const e2 = await fa._edDetail({ spec: spec1, id: id1 });
R.local_texture = e2.ok && e2.mode === 'texture' && e2.props.refine === 'texture' && /VAE|編碼器/.test(e2.note) && calls[1].provider === 'local' && !calls[1].init_image && /highly detailed/.test(calls[1].prompt);
fakeState({ online: true, local: true }); const e3 = await fa._edDetail({ spec: Object.assign({}, spec1, { objects: spec1.objects.map((o) => (o.id === id1 ? Object.assign({}, o, { model: 'local' }) : o)) }), id: id1 }); R.model_local_forced = e3.mode === 'texture';
fakeState({ online: false, local: false, ready: false }); const e4 = await fa._edDetail({ spec: spec1, id: id1 }); R.no_model_explained = e4.ok === false && /金鑰|下載|key|model/i.test(e4.error);
fakeState({ online: true }); const bad = await fa._edDetail({ spec: C.validate({ canvas: { w: 100, h: 100 }, objects: [{ type: 'image', ref: baseK.ref, x: 0, y: 0, w: 100, h: 100 }, { type: 'detail', region: { x: 500, y: 500, w: 40, h: 40 }, target: 'o1' }] }).spec, id: 'o2' }); R.outside_region_refused = bad.ok === false && /outside|smaller/.test(bad.error);
// ── 語言入口 ──
const spec2 = baseSpec; fakeState({ enabled: false, online: true, ready: false }); const a0 = await fa._edAskPicture({ text: '把右下角細化', spec: spec2, selection: null, onStatus() {} }, { id: 'x' });
R.words_disabled_says_enable = /啟用/.test(a0.say) && a0.edits.length === 0;
fakeState({ online: true }); calls.length = 0; const a1 = await fa._edAskPicture({ text: '把右下角的字細化', spec: spec2, selection: null, onStatus() {} }, { id: 'x' });
const after = C.applyEdits(spec2, a1.edits).spec, lay = after.objects[after.objects.length - 1];
R.words_make_layer = a1.edits.length === 2 && lay.type === 'detail' && lay.state === 'preview' && !!lay.result && lay.region.x > 100 && lay.region.y > 100 && lay.target === 'o1' && calls.length === 1 && /sign/.test(calls[0].prompt) && /preview|預覽/.test(a1.say + ' ');
// 風格的說法（「變成水彩風格」）不會被當成細化:走原本的風格濾鏡層，不叫生圖模型
calls.length = 0; const a2 = await fa._edAskPicture({ text: '把它變成水彩風格', spec: spec2, selection: null, onStatus() {} }, { id: 'x' }); R.style_words_untouched = calls.length === 0 && a2.edits.length >= 1 && a2.edits[0].op === 'apply_style';
// ── UI:按鈕、啟用項、框選 → 建立細化層 → 屬性面板 ──
fa._edDiffusionState = async () => ({ enabled: true, online: true, local: false, ready: true, reason: '' }); fa._generateImage = fa._generateImage;
const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:620px;z-index:99999;background:#fff'; document.body.appendChild(holder);
const pid = FaEditStore.newId('pc'); await FaEditStore.saveProject('edit-picture', pid, { v: 1, spec: baseSpec, state: null }); await FaEditStore.preload([baseK.ref]);
await fa._edMount('edit-picture', pid, holder); await new Promise((r) => setTimeout(r, 800));
const bar = holder.querySelector('.bar'), btns = Array.from(holder.querySelectorAll('button')), bDetail = btns.filter((b) => /擴散細化/.test(b.textContent))[0], ck = Array.from(holder.querySelectorAll('input[type=checkbox]')).filter((i) => /啟用擴散/.test((i.parentNode && i.parentNode.textContent) || ''))[0];
R.ui_button_and_checkbox = !!bDetail && !!ck && ck.checked === true && bDetail.disabled === false;
const ed = holder.querySelector('.fa-edit, [data-ed]') || holder.firstChild; const node = holder.querySelector('*'); const edObj = (function find(el) { return el && el._ed ? el : null; })(holder.firstChild) || Array.from(holder.querySelectorAll('*')).filter((e) => e._ed)[0];
R.ui_mounted = !!edObj;
if (edObj) {
  const e0 = edObj._ed; calls.length = 0; bDetail.click(); await new Promise((r) => setTimeout(r, 300));
  const scroller = holder.querySelector('canvas') && holder.querySelector('canvas').parentNode, cv = holder.querySelector('canvas'), rc = cv.getBoundingClientRect();
  R.ui_mode_on = /pri/.test(bDetail.className);
  const fire = (type, x, y, tgt) => (tgt || cv).dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, buttons: 1 }));
  fire('pointerdown', rc.left + rc.width * 0.45, rc.top + rc.height * 0.45); await new Promise((r) => setTimeout(r, 30)); window.dispatchEvent(new PointerEvent('pointermove', { clientX: rc.left + rc.width * 0.62, clientY: rc.top + rc.height * 0.62, bubbles: true, pointerId: 1 })); window.dispatchEvent(new PointerEvent('pointerup', { clientX: rc.left + rc.width * 0.62, clientY: rc.top + rc.height * 0.62, bubbles: true, pointerId: 1 }));
  await new Promise((r) => setTimeout(r, 1500));
  const sp = e0.getSpec ? e0.getSpec() : null; const dl = sp && sp.objects.filter((o) => o.type === 'detail')[0];
  R.ui_drag_makes_layer = !!dl && !!dl.region && dl.region.w > 8;
  R.ui_layer_generated = !!dl && dl.state === 'preview' && !!dl.result && calls.length === 1;
  R.ui_mode_off_after = !/pri/.test(bDetail.className);
  const props = holder.textContent; R.ui_panel_has_accept = /接受/.test(props) && /重畫/.test(props) && /退回/.test(props);
  const acc = Array.from(holder.querySelectorAll('button')).filter((b) => /接受/.test(b.textContent))[0]; if (acc) { acc.click(); await new Promise((r) => setTimeout(r, 400)); const sp2 = e0.getSpec(); R.ui_accept = sp2.objects.filter((o) => o.type === 'detail')[0].state === 'applied'; }
  const un = Array.from(holder.querySelectorAll('button')).filter((b) => /復原/.test(b.textContent))[0]; if (un) { un.click(); await new Promise((r) => setTimeout(r, 300)); R.ui_undo_back_to_preview = e0.getSpec().objects.filter((o) => o.type === 'detail')[0].state === 'preview'; }
  ck.checked = false; ck.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 300)); R.ui_toggle_saved = fa.advancedSettings.editDiffusion === false;
}
holder.remove(); fa._generateImage = origGen;
return R;
