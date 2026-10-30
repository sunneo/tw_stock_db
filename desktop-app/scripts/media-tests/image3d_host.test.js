// node scripts/media-tests/image3d_host.test.js —— 主機端模擬：只要主體（挑主體、貼圖流程、擺到桌子上）。畫面與模型都用假的，驗證程式自己的判斷與核對。
const assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
const root = path.join(__dirname, '..', '..', 'renderer', 'src');
const Core = require(path.join(root, 'media', 'image3d_core.js'));
let pass = 0;
function t(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('ok   ' + name); }, (e) => { console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); process.exitCode = 1; }); }
function grid(w, h, f) { const a = []; for (let y = 0; y < h; y++) { a.push([]); for (let x = 0; x < w; x++) { a[y].push(f(x, y)); } } return a; }

// 載入主機檔：FaEditHost.methods 是 this 上的方法表
const methods = {}, ctx = { FaEditHost: { T: (a) => a, methods, register() {} }, FaImage3d: Core, FaEditOffline: require(path.join(root, 'edit', 'edit_offline.js')), console, document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,AA==' }) }, createImageBitmap: async () => ({ width: 100, height: 80, close() {} }), setTimeout, requestAnimationFrame: () => {} };
vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(root, 'edit', 'edit3d_host.js'), 'utf8'), ctx);
ctx.FaSubject3d = { fit: (m) => m, toObject: (s) => ({ type: 'mesh', name: s.name, mesh: 'polygon' }) };
const M = ctx.FaEditHost.methods;

const W = 48, H = 36;
// 兩個物件：大的在中間（杯子），小的在角落（桌上小東西）
const labels = grid(W, H, (x, y) => (((x - 24) ** 2 + (y - 16) ** 2 < 100) ? 1 : (x >= 36 && x < 46 && y >= 26 && y < 34 ? 2 : 0)));
const host = (answers) => { // answers: 視覺模型每次回答的字母
  let i = 0; return Object.assign(Object.create(M), { calls: [], _visionDescribe: async function (spec) { this.calls.push(spec.prompt); return { ok: true, backend: 'llm', llm: answers[i++ % answers.length] }; }, _interpretImageWithVisionModel: async () => '' });
};

(async () => {
  await t('沒有名字：選最大又靠中間的，不問模型', async () => {
    const h = host(['B']); const r = await h._i3dPickSubject(labels, W, H, {}, ''); assert.strictEqual(r.id, 1); assert.strictEqual(r.how, 'central'); assert.strictEqual(h.calls.length, 0);
  });
  await t('有名字：視覺模型答 A 的那個物件被選中（程式核對字母）', async () => {
    const h = host(['B', 'A']); const r = await h._i3dPickSubject(labels, W, H, {}, '蘋果'); assert.strictEqual(r.how, 'asked'); assert.strictEqual(r.id, 2); assert.strictEqual(h.calls.length, 2); assert(h.calls[0].includes('蘋果'));
  });
  await t('有名字但模型亂答／都說不是：退回最大又靠中間的並註明', async () => {
    const h = host(['我不知道', 'B']); const r = await h._i3dPickSubject(labels, W, H, {}, '杯子'); assert.strictEqual(r.id, 1); assert.strictEqual(r.how, 'central'); assert(/沒能確認/.test(r.note));
  });
  await t('意圖：程式讀得出來就不問模型；讀不出來才問，答案由程式核對', async () => {
    let asked = 0; const h = Object.assign(Object.create(M), { _edAi: () => ({ have: () => true, pick: async () => { asked++; return 0; } }) });
    assert.strictEqual((await h._i3dSubjectIntent('只要咖啡杯')).name, '咖啡杯'); assert.strictEqual(asked, 0);
    const u = await h._i3dSubjectIntent('把這張圖放到場景裡'); assert.strictEqual(asked, 1); assert.strictEqual(u.subject, 'main'); assert.strictEqual(u.source, 'model');
    const h2 = Object.assign(Object.create(M), { _edAi: () => ({ have: () => true, pick: async () => null }) });
    const d = await h2._i3dSubjectIntent('把這張圖放到場景裡'); assert.strictEqual(d.subject, 'all'); assert.strictEqual(d.source, 'default');
  });
  await t('貼圖流程：話裡沒有主體意思、也不是「變成3D」→ 不處理', async () => {
    const h = Object.assign(Object.create(M), { _i3dSubjectSolid: async () => { throw new Error('不該被呼叫'); } });
    assert.strictEqual(await h._i3dAttachedEdits({ text: '把這張圖貼到桌子上當桌布', images: [{ dataUrl: 'x', name: 'a.png' }] }), null);
  });
  await t('貼圖流程：「把咖啡杯的照片擺到桌子上」→ 一個物件、帶主體名稱、place 在桌子上面', async () => {
    const seen = []; ctx.fetch = async () => ({ blob: async () => ({}) });
    const mesh = Core.boxMesh(0, 0, 1, 1, 0, 1); mesh.uvs = mesh.vertices.map(() => [0, 0]);
    const h = Object.assign(Object.create(M), { _edAi: () => ({ have: () => false }), _i3dSubjectSolid: async (b, f, p) => { seen.push(p); return { mesh, texture: 'data:image/jpeg;base64,AA==', faces: mesh.faces.length, all_closed: true, subject: { name: p.subject.name, how: 'asked', note: '確認' } }; } });

    const spec = { objects: [{ id: 'sd1', type: 'mesh', name: '桌子' }, { id: 'sd2', type: 'light', name: '燈' }] };
    const r = await h._i3dAttachedEdits({ text: '把一個咖啡杯的照片要擺到桌子模組上', images: [{ dataUrl: 'data:x', name: 'cup.jpg' }, { dataUrl: 'data:x', name: 'other.jpg' }], spec });
    assert.strictEqual(seen.length, 1); assert.strictEqual(seen[0].subject.name, '咖啡杯');
    assert.strictEqual(r.edits.length, 1); assert.strictEqual(r.edits[0].object.name, '咖啡杯'); assert.strictEqual(JSON.stringify(r.edits[0].place), JSON.stringify({ of: 'sd1', rel: 'on' }));
    assert(/桌子/.test(r.notes[0]));
  });
  await t('貼圖流程：場景沒有那張桌子 → 不帶 place（放中間）並說明', async () => {
    const mesh = Core.boxMesh(0, 0, 1, 1, 0, 1); ctx.fetch = async () => ({ blob: async () => ({}) });
    const h = Object.assign(Object.create(M), { _edAi: () => ({ have: () => false }), _i3dSubjectSolid: async () => ({ mesh, texture: '', faces: 12, all_closed: true, subject: { note: '' } }) });
    const r = await h._i3dAttachedEdits({ text: '只要咖啡杯，擺到桌子上', images: [{ dataUrl: 'data:x', name: 'cup.jpg' }], spec: { objects: [] } });
    assert.strictEqual(r.edits[0].place, undefined); assert(/沒有「桌子」/.test(r.notes[0]));
  });
  await t('貼圖流程：舊的「把這張圖變成 3D 物件」仍是全部（不帶 subject）', async () => {
    const mesh = Core.boxMesh(0, 0, 1, 1, 0, 1); let got = 'unset'; ctx.fetch = async () => ({ blob: async () => ({}) });
    const h = Object.assign(Object.create(M), { _edAi: () => ({ have: () => false }), _i3dSubjectSolid: async (b, f, p) => { got = p; return { mesh, texture: '', faces: 12, all_closed: true }; } });
    const r = await h._i3dAttachedEdits({ text: '把這張圖變成 3D 物件', images: [{ dataUrl: 'data:x', name: 'a.jpg' }] });
    assert.strictEqual(got, undefined); assert.strictEqual(r.edits.length, 1); assert.strictEqual(r.edits[0].place, undefined);
  });
  await t('顯示：預設放成對話裡的 3D 檢視，不開編輯器；--editor 才開編輯器', async () => {
    ctx.FaEdit3d = { toSceneYaml: () => 'nodes: []' }; const log = [];
    const h = Object.assign(Object.create(M), { _ensureJsYamlLoaded: async () => {}, _ed3dToChatScene: async (id, y, title) => { log.push(['chat', y, title]); }, _edOpen: async () => { log.push(['editor']); return { ok: true }; } });
    const r = await h._i3dShow({ objects: [] }, '標題', {}); assert(r.ok && r.viewer); assert.strictEqual(log.length, 1); assert.strictEqual(log[0][0], 'chat');
    await h._i3dShow({ objects: [] }, '標題', { editor: true }); assert.strictEqual(log[1][0], 'editor');
  });
  await t('進度：整段圖片轉3D 只有一張進度卡，子步驟的行都記在它的紀錄裡', async () => {
    const cards = [], lines = [], pcts = [];
    const h = Object.assign(Object.create(M), { _createProgressWidget: (title) => { const c = { title, log: (l) => lines.push(l), update: (u) => { if (u.pct != null) pcts.push(u.pct); }, finish: (s) => { c.done = s; }, fail: (e) => { c.err = e; } }; cards.push(c); return c; }, _edQuietRun: async (sink, fn) => { h._edQuiet = { sink }; try { return await fn(); } finally { h._edQuiet = null; } }, _imageTo3d0: async () => { h._i3dChapter('depth', '估計遠近', '南瓜燈'); h._edQuiet.sink('深度模型：載入…'); h._edQuiet.sink('分割：GPU 失敗，改用 CPU'); return { ok: true }; } });
    const r = await h._imageTo3d({}); assert(r.ok); assert.strictEqual(cards.length, 1); assert.strictEqual(lines.length, 3); assert.strictEqual(lines[0], '【估計深度】南瓜燈：估計遠近'); assert(lines[1].startsWith('　')); assert(pcts[1] > 5 && pcts[1] < 40 && pcts[pcts.length - 1] === 100);
    h._imageTo3d0 = async () => ({ ok: false, error: '壞了' }); await h._imageTo3d({}); assert.strictEqual(cards[1].err, '壞了');
  });
  console.log(pass + ' passed' + (process.exitCode ? ', with failures' : ''));
})();
