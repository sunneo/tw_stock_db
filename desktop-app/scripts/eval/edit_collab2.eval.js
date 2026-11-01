// 多人同編：網頁編輯器（webedit）與影片逐字稿編輯器（edit-video）。兩個「機器」用同一個畫面裡的記憶體傳輸
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit_collab2.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = { fail: [] }; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(50); } return null; };
const ok = (name, cond, extra) => { R[name] = !!cond; if (!cond) R.fail.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 200) : '')); };
fa._getApiConfig = () => ({ apiKey: 'test', apiUrl: 'http://127.0.0.1:9', apiModel: 'fake' });
fa._kiLlm = async () => JSON.stringify({ say: 'AI', edits: [] });
// 兩個房間共用一個記憶體傳輸
const keys = await FaRemoteGroup.deriveKeys('Tr0ub4dor&3-xyzQ', '12345678', 2000); const ch = new Map();
const transport = () => { let id = null; return { async connect(c, nodeId, h) { id = nodeId; ch.set(id, { h, meta: null }); }, async track(p) { ch.get(id).meta = p; sync(); }, async send(p) { for (const [nid, m] of ch) if (nid !== id) setTimeout(() => m.h.onBroadcast(JSON.parse(JSON.stringify(p))), 0); }, async disconnect() { ch.delete(id); sync(); } }; };
const sync = () => { const st = {}; for (const [nid, m] of ch) if (m.meta) st[nid] = [Object.assign({ presence_ref: nid }, m.meta)]; for (const [, m] of ch) setTimeout(() => m.h.onPresence(JSON.parse(JSON.stringify(st))), 0); };
const mkRoom = (name, kind) => new FaRemoteGroup.Room({ transport: transport(), keys, self: { name, kind }, settleMs: 30 });
const rA = mkRoom('小明', 'desktop'), rB = mkRoom('阿華', 'web'); await rA.join(); await rB.join(); await wait(250);
const kinds = (k) => fa._edRemoteKind(k);
const cA = new FaEditCollab.Collab({ room: rA, kinds }), cB = new FaEditCollab.Collab({ room: rB, kinds }); cA.slow = cB.slow = 0.2;
const seen = new Set(); const mount = async (kind, opts) => { const r = await fa._edOpen(kind, opts); fa._renderMessageHistory(); const ed = await until(() => [...document.querySelectorAll('.few')].filter((x) => !seen.has(x)).pop()); seen.add(ed); await wait(700); return { r, ed }; };

let curC = cA; fa._edCollab = () => curC; fa._rg = { room: rA };
// ═══ 網頁編輯器 ═══
const wspec = FaWebEdit.defaults(); wspec.title = '共編網頁';
const wres = await fa._webeditOpen({ spec: wspec }); fa._renderMessageHistory(); await wait(900);
const wid = wres.id; const wnode = fa._weEditors.get(wid); ok('web_opened', !!(wnode && wnode._we), wres);
ok('web_has_button', [...wnode.querySelectorAll('.bar button')].some((b) => /共編/.test(b.textContent)));
const recW = fa._edShareNow('webedit', wid); ok('web_shared', recW && recW.role === 'host');
const wi = await cB.list(300); ok('web_listed', wi.length === 1 && wi[0].kind === 'webedit', wi);
const wp = await cB.join(wi[0].host, wi[0].sid); const wopen = await fa._edOpenShared('webedit', wp.spec, { shared: { host: rA.self.nodeId, name: '小明', sid: wi[0].sid } }); fa._renderMessageHistory(); await wait(900);
const wnodeB = fa._weEditors.get(wopen.id); ok('web_joiner_opened', !!(wnodeB && wnodeB._we));
const recWB = { role: 'joined', session: wp, adapter: fa._edCollabAdapter(wp) }; fa._edShared.set('webedit:' + wopen.id, recWB); fa._edWatch('webedit', wopen.id, recWB); wnodeB._we.attachCollab(recWB.adapter); await wait(150);
const idx = (n) => n._we.getSpec().files.find((f) => f.name === 'index.html').content;
ok('web_same_start', idx(wnode) === idx(wnodeB));
const mkTail = (t) => FaWebEdit.applyEdits(wnode._we.getSpec(), [{ op: 'set_file', name: 'a.txt', content: t }]);
const sp1 = JSON.parse(JSON.stringify(wnode._we.getSpec())); sp1.files.push({ name: 'host.txt', content: '來自小明' }); wnode._we.setSpec(sp1, '小明加檔'); await wait(500);
ok('web_host_edit_reaches_joiner', wnodeB._we.getSpec().files.some((f) => f.name === 'host.txt'), wnodeB._we.getSpec().files.map((f) => f.name));
const sp2 = JSON.parse(JSON.stringify(wnodeB._we.getSpec())); sp2.files.push({ name: 'join.txt', content: '來自阿華' }); wnodeB._we.setSpec(sp2, '阿華加檔'); await wait(600);
ok('web_joiner_edit_reaches_host', wnode._we.getSpec().files.some((f) => f.name === 'join.txt') && wnode._we.getSpec().files.some((f) => f.name === 'host.txt'), wnode._we.getSpec().files.map((f) => f.name));
ok('web_files_keyed_by_name_no_clobber', wnodeB._we.getSpec().files.length === wnode._we.getSpec().files.length);
wnode._we.undo(); await wait(500); ok('web_undo_own_only', !wnode._we.getSpec().files.some((f) => f.name === 'host.txt') && wnode._we.getSpec().files.some((f) => f.name === 'join.txt') && wnodeB._we.getSpec().files.some((f) => f.name === 'join.txt') && !wnodeB._we.getSpec().files.some((f) => f.name === 'host.txt'));
ok('web_by_label_in_history', /阿華/.test(wnode.querySelector('.hist').textContent), wnode.querySelector('.hist').textContent.slice(0, 200));
// ═══ 影片逐字稿編輯器 ═══
const vp = window.TwVideoEdit.newProject('共編影片'); vp.cues = [{ id: 'c1', start: 0, end: 2, text: '你好' }, { id: 'c2', start: 2, end: 4, text: '世界' }];
const vres = await fa._edOpenShared('edit-video', vp, null); fa._renderMessageHistory(); const vid = vres.id;
const vnode = await until(() => { const n = fa._edNode('edit-video', vid); return n && n._ed ? fa._edEditors.get('edit-video:' + vid) : null; }, 8000); await wait(900); ok('video_opened', !!vnode, vres);
const veA = () => vnode.querySelector('[data-tw-ve]')._ve || vnode._ve;
const boxA = () => vnode.querySelector('.tw-ve') || vnode; const VA = () => boxA()._ve;
ok('video_has_button', [...boxA().querySelectorAll('button')].some((b) => /共編/.test(b.textContent)));
const recV = fa._edShareNow('edit-video', vid); ok('video_shared', recV && recV.role === 'host');
const vi = await cB.list(300); const vitem = vi.find((x) => x.kind === 'edit-video'); ok('video_listed', !!vitem, vi);
const vpB = await cB.join(vitem.host, vitem.sid); const vopen = await fa._edOpenShared('edit-video', vpB.spec, { shared: { host: rA.self.nodeId, name: '小明', sid: vitem.sid } }); fa._renderMessageHistory(); await wait(900);
const vnodeB = await until(() => { const n = fa._edNode('edit-video', vopen.id); return n && n._ed ? fa._edEditors.get('edit-video:' + vopen.id) : null; }, 8000); await wait(700); ok('video_joiner_opened', !!vnodeB);
const VB = () => (vnodeB.querySelector('.tw-ve') || vnodeB)._ve;
const recVB = { role: 'joined', session: vpB, adapter: fa._edCollabAdapter(vpB) }; fa._edShared.set('edit-video:' + vopen.id, recVB); fa._edWatch('edit-video', vopen.id, recVB); fa._edNode('edit-video', vopen.id)._ed.attachCollab(recVB.adapter); await wait(200);
const cuesOf = (V) => V().project.cues.map((c) => c.id + ':' + c.text).join('|');
ok('video_same_start', cuesOf(VA) === cuesOf(VB), [cuesOf(VA), cuesOf(VB)]);
await VA().runOps([{ op: 'set_text', n: 1, text: '哈囉' }]); await wait(600);
ok('video_host_edit_reaches_joiner', /c1:哈囉/.test(cuesOf(VB)) && cuesOf(VA) === cuesOf(VB), [cuesOf(VA), cuesOf(VB)]);
await VB().runOps([{ op: 'set_text', n: 2, text: '宇宙' }]); await wait(600);
ok('video_joiner_edit_reaches_host', /c2:宇宙/.test(cuesOf(VA)) && /c1:哈囉/.test(cuesOf(VA)) && cuesOf(VA) === cuesOf(VB), [cuesOf(VA), cuesOf(VB)]);
// 同時各改不同一句（沒等對方）：兩個都保留
await Promise.all([VA().runOps([{ op: 'set_text', n: 1, text: 'A改一' }]), VB().runOps([{ op: 'set_text', n: 2, text: 'B改二' }])]); await wait(900);
ok('video_concurrent_both_kept', /c1:A改一/.test(cuesOf(VA)) && /c2:B改二/.test(cuesOf(VA)) && cuesOf(VA) === cuesOf(VB), [cuesOf(VA), cuesOf(VB)]);
ok('video_members_shown', /阿華|小明/.test(boxA().textContent));
// 復原只復原自己：A 用「復原」按鈕（逐字稿分頁）退回自己最近一步，B 的改動留著
const undoBtn = [...boxA().querySelectorAll('button')].find((b) => b.textContent === '↶' && !b.disabled); if (undoBtn) { undoBtn.click(); await wait(700); }
ok('video_undo_only_own', !!undoBtn && /c1:哈囉/.test(cuesOf(VA)) && /c2:B改二/.test(cuesOf(VA)) && cuesOf(VA) === cuesOf(VB), [!!undoBtn, cuesOf(VA), cuesOf(VB)]);
R.ok = R.fail.length === 0; console.log('EDIT_COLLAB2 ' + JSON.stringify(R)); return R;
