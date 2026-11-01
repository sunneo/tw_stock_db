// 多人同編（真實 Electron；兩個「機器」用同一個畫面裡的記憶體傳輸）：主持機分享、參與者加入、兩邊的編輯器互相同步、by 標籤、各人只復原自己的、唯讀、離線暫存
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit_collab.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
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
const kinds = (k) => (FaEditHost.KINDS[k] ? { remote: {} } : null);
const cA = new FaEditCollab.Collab({ room: rA, kinds }), cB = new FaEditCollab.Collab({ room: rB, kinds }); cA.slow = cB.slow = 0.2;
const seen = new Set(); const mount = async (kind, opts) => { const r = await fa._edOpen(kind, opts); fa._renderMessageHistory(); const ed = await until(() => [...document.querySelectorAll('.few')].filter((x) => !seen.has(x)).pop()); seen.add(ed); await wait(700); return { r, ed }; };
// ① 主持機（桌面）：開 Markdown 編輯器、分享
const spec0 = FaEditText.parse('# 標題\n\n第一段\n\n第二段\n', 'md'); spec0.title = '共編測試';
const A = await mount('edit-markdown', { spec: spec0 }); ok('host_opened', A.r && A.r.ok && A.ed);
fa._edCollab = () => cA; fa._edEditors.get('edit-markdown:' + A.r.id); const recA = fa._edShareNow('edit-markdown', A.r.id); ok('shared', !!recA && recA.role === 'host');
ok('host_has_toolbar_button', [...A.ed.querySelectorAll('.bar button')].some((b) => /共編/.test(b.textContent)));
// ② 參與者（網頁）：列表 → 加入 → 開本機副本
const items = await cB.list(300); ok('list_shows_host', items.length === 1 && items[0].host.name === '小明' && items[0].kind === 'edit-markdown', items);
const p = await cB.join(items[0].host, items[0].sid); const B = await mount('edit-markdown', { spec: p.spec }); ok('joiner_opened', B.r && B.r.ok);
const recB = { role: 'joined', session: p, adapter: fa._edCollabAdapter(p) }; fa._edShared.set('edit-markdown:' + B.r.id, recB); B.ed._ed.attachCollab(recB.adapter); await wait(100);
const ser = (e) => FaEditText.serialize(e._ed.getSpec());
ok('same_start', ser(A.ed) === ser(B.ed));
ok('members_shown', /小明/.test(A.ed.querySelector('.collab').textContent) && /阿華/.test(A.ed.querySelector('.collab').textContent) && /🌐/.test(A.ed.querySelector('.collab').textContent), A.ed.querySelector('.collab') && A.ed.querySelector('.collab').textContent);
// ③ 主持機說一句 → 兩邊都變
await A.ed._ed.send('在最後加一段：來自小明'); await wait(400);
ok('host_edit_reaches_joiner', /來自小明/.test(ser(B.ed)) && ser(A.ed) === ser(B.ed), [ser(A.ed), ser(B.ed)]);
// ④ 參與者改 → 兩邊都變；主持機歷史有「阿華」標籤
await B.ed._ed.send('在最後加一段：來自阿華'); await wait(500);
ok('joiner_edit_reaches_host', /來自阿華/.test(ser(A.ed)) && ser(A.ed) === ser(B.ed), [ser(A.ed), ser(B.ed)]);
const histA = [...A.ed.querySelectorAll('.rp .hist div, .hist div')].map((d) => d.textContent).join('|'); ok('by_label_on_host_history', /阿華/.test(histA), histA.slice(0, 300));
// ⑤ 各人只復原自己的步驟：A 復原 → 只移掉「來自小明」，「來自阿華」還在
A.ed._ed.undo(); await wait(500);
ok('undo_only_own_step', !/來自小明/.test(ser(A.ed)) && /來自阿華/.test(ser(A.ed)) && ser(A.ed) === ser(B.ed), [ser(A.ed), ser(B.ed)]);
ok('undo_disabled_when_nothing_of_mine', A.ed._ed.getSpec() && [...A.ed.querySelectorAll('.bar button')].find((b) => /復原/.test(b.textContent)).disabled === true);
B.ed._ed.undo(); await wait(500); ok('joiner_undo_own', !/來自阿華/.test(ser(A.ed)) && ser(A.ed) === ser(B.ed), [ser(A.ed), ser(B.ed)]);
// ⑥ 唯讀：設定後參與者的改動被拒並提示
recA.session.setReadonly(rB.self.nodeId, true); await wait(150);
await B.ed._ed.send('在最後加一段：不該成功'); await wait(500);
ok('readonly_rejected', !/不該成功/.test(ser(A.ed)) && !/不該成功/.test(ser(B.ed)) && /唯讀/.test(B.ed.textContent), ser(B.ed));
recA.session.setReadonly(rB.self.nodeId, false); await wait(100);
// ⑦ 面板：開、關
const btn = [...A.ed.querySelectorAll('.bar button')].find((b) => /共編/.test(b.textContent)); btn.click(); await wait(100); ok('panel_opens', !!A.ed.querySelector('.collabpanel') && /小明|阿華/.test(A.ed.querySelector('.collabpanel').textContent)); btn.click(); await wait(50); ok('panel_closes', !A.ed.querySelector('.collabpanel'));
// ⑧ 主持機離線 → 參與者暫存；回來自動送出
await rA.leave(); await wait(400); ok('offline_shown', /離線/.test(B.ed.querySelector('.collab').textContent), B.ed.querySelector('.collab').textContent);
await B.ed._ed.send('在最後加一段：離線寫的'); await wait(300); ok('queued_count_shown', /1 筆待同步/.test(B.ed.querySelector('.collab').textContent), B.ed.querySelector('.collab').textContent);
await rA.join(); await wait(1200); ok('flushed_after_return', /離線寫的/.test(ser(A.ed)) && ser(A.ed) === ser(B.ed) && !/待同步/.test(B.ed.querySelector('.collab').textContent), [ser(A.ed), ser(B.ed)]);
// ⑨ 停止分享
fa._edUnshare('edit-markdown', A.r.id); await wait(200); ok('unshared', !A.ed.querySelector('.collab') && !fa._edShared.has('edit-markdown:' + A.r.id));
R.ok = R.fail.length === 0; console.log('EDIT_COLLAB ' + JSON.stringify(R)); return R;
