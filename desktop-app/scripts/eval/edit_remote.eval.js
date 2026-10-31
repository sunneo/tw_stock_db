// 遠端編輯器橋接（真實 Electron；同一個頁面裡用記憶體傳輸架兩個 Peer：請求者＝真的編輯器外框，執行者＝同一個 fa 的 host 方法；LLM 用假的）
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit_remote.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(60); } return null; };
const calls = { llm: 0 };
fa._getApiConfig = () => ({ apiKey: 'test', apiUrl: 'http://127.0.0.1:9', apiModel: 'fake' });
fa._kiLlm = async () => { calls.llm++; return JSON.stringify({ say: '遠端畫好了', edits: [{ op: 'add_object', object: { type: 'shape', name: '藍色方塊', shape: 'rect', x: 10, y: 10, w: 80, h: 40, fill: '#3366cc' } }] }); };
// 兩台機器的房間（記憶體傳輸）
class Hub { constructor() { this.ch = new Map(); } transport() { const hub = this; let name = null, id = null; return { async connect(c, n, h) { name = c; id = n; if (!hub.ch.has(name)) hub.ch.set(name, new Map()); hub.ch.get(name).set(id, { h, meta: null }); }, async track(p) { hub.ch.get(name).get(id).meta = p; hub.sync(name); }, async send(p) { for (const [nid, m] of hub.ch.get(name)) if (nid !== id) setTimeout(() => m.h.onBroadcast(JSON.parse(JSON.stringify(p))), 0); }, async disconnect() { hub.ch.get(name) && hub.ch.get(name).delete(id); } }; } sync(name) { const st = {}; for (const [nid, m] of this.ch.get(name)) if (m.meta) st[nid] = [Object.assign({ presence_ref: nid }, m.meta)]; for (const [, m] of this.ch.get(name)) setTimeout(() => m.h.onPresence(JSON.parse(JSON.stringify(st))), 0); } }
const keys = await FaRemoteGroup.deriveKeys('Tr0ub4dor&3-xyzQ', '12345678', 2000), hub = new Hub();
const mkRoom = (name) => new FaRemoteGroup.Room({ transport: hub.transport(), keys, self: { name }, settleMs: 30 });
const A = mkRoom('請求者'), B = mkRoom('執行者'); await A.join(); await B.join(); await wait(200);
let execRuns = 0; const kindsExec = (k) => { const x = fa._edRemoteKind(k); if (!x) return null; return { remote: x.remote, run: async (m, a, c) => { execRuns++; return x.run(m, a, c); } }; };
const peerB = new FaRemoteEdit.Peer({ room: B, kinds: kindsExec, log: () => {} }); const peerA = new FaRemoteEdit.Peer({ room: A, kinds: (k) => fa._edRemoteKind(k), log: () => {} });
const fsA = new FaRemoteFiles.FileShare({ room: A, rtc: null, getFile: async (id) => peerA.getOffered(id), allowed: (id, f) => peerA.isAllowed(id, f) }), fsB = new FaRemoteFiles.FileShare({ room: B, rtc: null, getFile: async (id) => peerB.getOffered(id), allowed: (id, f) => peerB.isAllowed(id, f) }); peerA.files = fsA; peerB.files = fsB;
fa._rg = { room: A, edit: peerA, files: fsA }; fa._rgTarget = '';
fa._rgTargets = () => [{ nodeId: B.self.nodeId, name: '執行者', allow: true, kind: 'desktop' }];
// ── 沒選機器：本機做（跟以前一樣）
const o1 = await fa._edOpen('edit-svg', { starter: 'blank' }); fa._renderMessageHistory();
const ed = await until(() => [...document.querySelectorAll('.few')].pop()); R.mounted = !!ed;
const sel = ed && [...ed.querySelectorAll('select')].find((s) => /AI 在/.test(s.textContent)); R.ai_dropdown = !!sel; R.ai_options = sel ? [...sel.options].map((o) => o.textContent) : [];
const n0 = ed._ed.getSpec().objects.length; await ed._ed.send('請幫我做一個有點特別的圖案'); await wait(500);
R.local = { added: ed._ed.getSpec().objects.length - n0, llm: calls.llm, exec_runs: execRuns, by_chip: ed.querySelectorAll('.chip.by').length };
// ── 選了「執行者」：請求交給對方，改動傳回來
sel.value = B.self.nodeId; sel.dispatchEvent(new Event('change')); await wait(300); R.selected = sel.value === B.self.nodeId;
const n1 = ed._ed.getSpec().objects.length, llm1 = calls.llm; await ed._ed.send('再做一個有點特別的圖案'); await wait(1500);
const chip = [...ed.querySelectorAll('.chip.by')].map((c) => c.textContent);
R.remote = { added: ed._ed.getSpec().objects.length - n1, llm_called: calls.llm - llm1, exec_runs: execRuns, by_chip: chip, peer_calls: peerA.stats.calls, spec_sent: peerA.stats.specSent };
const hist = document.querySelectorAll('.few .hist div'); R.history_by = [...ed.querySelectorAll('.hist div')].some((d) => /執行者/.test(d.textContent));
// ── 專案記住這個選擇（重開自動重連）
const proj = await FaEditStore.loadProject('edit-svg', o1.id); R.persisted = !!(proj && proj.origin && proj.origin.remote && proj.origin.remote.nodeId === B.self.nodeId);
// ── 對方離線：明確的錯誤，文件不受影響
await B.leave(); await wait(100); peerA.helloCache.clear(); peerA.ackMs = 600; const n2 = ed._ed.getSpec().objects.length; await ed._ed.send('對方離線時再做一個特別的圖案'); await wait(1500);
R.offline = { spec_unchanged: ed._ed.getSpec().objects.length === n2, message: [...ed.querySelectorAll('.msg.a')].pop().textContent.slice(0, 80) };
// ── 改回本機
sel.value = ''; sel.dispatchEvent(new Event('change')); await wait(300); const n3 = ed._ed.getSpec().objects.length; await ed._ed.send('改回本機再做一個特別的圖案'); await wait(600); R.back_local = ed._ed.getSpec().objects.length > n3;
fa._rg = null;
console.log('EDIT_REMOTE_RESULT ' + JSON.stringify(R));
return R;
