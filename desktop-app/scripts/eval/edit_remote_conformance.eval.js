// 遠端橋接一致性檢查（真實 Electron）：走訪 FaEditHost.KINDS，每一種編輯器都要有遠端宣告、host 方法存在、素材轉接器可往返、經 Peer 的 ask 能跑完並帶 by。
// 新增編輯器沒過就是紅燈（DESIGN.edit-remote.md §17）。PENDING 是還沒接上的（要接上就從清單拿掉）。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/edit_remote_conformance.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = { kinds: {}, failed: [] }; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.advancedSettings.offlineMode = false; fa.messages = [];
const PENDING = { 'edit-video': 'video 是服務式（host.ai／transcribe／synthesize／burn），要 sync:patch' };
fa._getApiConfig = () => ({ apiKey: 'test', apiUrl: 'http://127.0.0.1:9', apiModel: 'fake' });
fa._kiLlm = async () => JSON.stringify({ say: 'ok', edits: [] }); fa._subjResolve = async () => ({ block: '', assets: [] }); fa._interpretImageWithVisionModel = async () => ({ description: 'x' });
class Hub { constructor() { this.ch = new Map(); } transport() { const hub = this; let name = null, id = null; return { async connect(c, n, h) { name = c; id = n; if (!hub.ch.has(name)) hub.ch.set(name, new Map()); hub.ch.get(name).set(id, { h, meta: null }); }, async track(p) { hub.ch.get(name).get(id).meta = p; hub.sync(name); }, async send(p) { for (const [nid, m] of hub.ch.get(name)) if (nid !== id) setTimeout(() => m.h.onBroadcast(JSON.parse(JSON.stringify(p))), 0); }, async disconnect() { hub.ch.get(name) && hub.ch.get(name).delete(id); } }; } sync(name) { const st = {}; for (const [nid, m] of this.ch.get(name)) if (m.meta) st[nid] = [Object.assign({ presence_ref: nid }, m.meta)]; for (const [, m] of this.ch.get(name)) setTimeout(() => m.h.onPresence(JSON.parse(JSON.stringify(st))), 0); } }
const keys = await FaRemoteGroup.deriveKeys('Tr0ub4dor&3-xyzQ', '12345678', 2000), hub = new Hub();
const mkRoom = (name) => new FaRemoteGroup.Room({ transport: hub.transport(), keys, self: { name }, settleMs: 30 });
const A = mkRoom('請求者'), B = mkRoom('執行者'); await A.join(); await B.join(); await wait(200);
const peerB = new FaRemoteEdit.Peer({ room: B, kinds: (k) => fa._edRemoteKind(k), log: () => {} }), peerA = new FaRemoteEdit.Peer({ room: A, kinds: (k) => fa._edRemoteKind(k), log: () => {} });
peerA.files = new FaRemoteFiles.FileShare({ room: A, rtc: null, getFile: async (id) => peerA.getOffered(id), allowed: (id, f) => peerA.isAllowed(id, f) }); peerB.files = new FaRemoteFiles.FileShare({ room: B, rtc: null, getFile: async (id) => peerB.getOffered(id), allowed: (id, f) => peerB.isAllowed(id, f) });
const T = { nodeId: B.self.nodeId, name: '執行者' };
for (const kind of Object.keys(FaEditHost.KINDS)) {
  const K = FaEditHost.KINDS[kind], r = R.kinds[kind] = {}; const fail = (why) => { r.error = why; R.failed.push(kind + '：' + why); };
  if (PENDING[kind]) { r.pending = PENDING[kind]; continue; }
  try {
    const decl = fa._edRemoteDecl(kind); r.sync = decl.sync; r.methods = Object.keys(decl.methods || {});
    if (!decl.methods || !decl.methods.ask) { fail('宣告裡沒有 ask'); continue; }
    const host = fa._edHost(kind, 'conf-' + kind, () => ({ spec: {}, state: null })); const missing = r.methods.filter((m) => m !== 'polish' && typeof host[m] !== 'function'); if (missing.length) { fail('host 沒有這些方法：' + missing.join()); continue; }
    const rk = fa._edRemoteKind(kind); if (!rk || typeof rk.run !== 'function') { fail('_edRemoteKind 沒回傳'); continue; }
    const ad = rk.remote.assets, bytes = new Uint8Array([1, 2, 3, kind.length]); await ad.put('ref', 'confimg' + kind.replace(/\W/g, ''), new Blob([bytes], { type: 'image/png' })); const id1 = 'confimg' + kind.replace(/\W/g, '');
    const got = await ad.get('ref', id1); r.assets = !!(await ad.has('ref', id1)) && !!got && new Uint8Array(await got.arrayBuffer()).join() === bytes.join(); if (!r.assets) { fail('素材轉接器往返不一致'); continue; }
    const C = K.core(); const spec = (C.starter && C.starter('blank')) || (C.validate({}).spec);
    const v = await peerA.call(T, kind, 'conf-' + kind, 'ask', [{ text: '做一個很特別的東西', spec, images: [], selection: null, fresh: true, env: { selection: null } }], {});
    r.ask = !!v && typeof v === 'object'; r.by = !!(v && v.by && v.by.exec && v.by.exec.name === '執行者' && v.by.src === 'ai'); if (!r.ask || !r.by) fail('ask 沒有帶回結果或 by：' + JSON.stringify(v).slice(0, 120));
  } catch (e) { fail(String((e && e.message) || e).slice(0, 160)); }
}
// webedit（/edit-html）不在 FaEditHost.KINDS 裡，有自己的宣告（sync:patch）與 host
try { const decl = fa._edRemoteDecl('webedit'), spec = FaWebEdit.validate({}).spec, v = await peerA.call(T, 'webedit', 'conf-we', 'ask', [{ text: '做一個很特別的網頁', spec, images: [] }], {}); const r = R.kinds.webedit = { sync: decl.sync, methods: Object.keys(decl.methods), ask: !!v && typeof v === 'object', by: !!(v && v.by && v.by.exec && v.by.src === 'ai') }; if (!r.ask || !r.by) R.failed.push('webedit：ask 沒有帶回結果或 by'); } catch (e) { R.failed.push('webedit：' + String((e && e.message) || e).slice(0, 160)); }
R.ok = R.failed.length === 0;
console.log('CONFORMANCE ' + JSON.stringify(R));
return R;
