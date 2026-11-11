'use strict';
// 訓練工作室「內建資產」：用真實的領域包、內建課、矩陣層註冊表、UML／設計核心、離線訓練器規則樣本；數字全部從原始碼動態取得（不寫死）。
const fs = require('fs'), path = require('path');
const Asset = require('./asset_core.js'), Storage = require('./storage_core.js'), Fatrain = require('./fatrain_core.js');
const Builtin = require('./builtin_assets_core.js'), { createServer } = require('./studio_server_core.js');
const U = path.join(__dirname, '..', 'uml'), AL = path.join(__dirname, '..', 'algo'), CA = path.join(__dirname, '..', 'catalog');
const DR = require(path.join(U, 'domain_registry_core.js')), PAR = require(path.join(U, 'py_paradigms_core.js')), AI = require(path.join(U, 'algo_intent_core.js'));
const LESSONS = require(path.join(U, 'py_lessons_builtin.js'));
const FB = require(path.join(CA, 'feedback_core.js'));
const { seedCounts } = require('../../../scripts/domain-seed-counts.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };

// ---- 真實領域包：從 uml/ 目錄列出所有 domain_*_core.js（不含 registry），逐一 make 再註冊 ----
const packFiles = fs.readdirSync(U).filter((f) => /^domain_.+_core\.js$/.test(f) && f !== 'domain_registry_core.js');
const packs = packFiles.map((f) => require(path.join(U, f)).make(PAR));
packs.forEach((p) => { const r = DR.register(p, { AI, PAR }); if (!r.ok) throw new Error(r.reason); });
const registered = DR.list().map((x) => DR.get(x.id));
const sc = seedCounts(path.join(__dirname, '..', '..', '..'));
// 矩陣層：載入全部合成器模組
const MS = require(path.join(AL, 'matrix_synth_core.js'));
for (const [f, nm] of [['matrix_graph_core.js'], ['matrix_l0_core.js']]) { const m = require(path.join(AL, f)); if (m.install) m.install(MS); }
try { const cm = require(path.join(AL, 'matrix_compose_core.js')); cm.install(MS, require(path.join(AL, 'matrix_graph_core.js'))); } catch (_) { /* */ }
const UML = require(path.join(U, 'uml_core.js')), DES = require(path.join(U, 'design_core.js'));
let fbStore = FB.emptyStore();
const otDomains = [{ name: 'core_rules', description: '通用規則', source: 'builtin', enabled: true, patterns: [{ id: 'a', type: 'regex', intent: 'x' }, { id: 'b', type: 'regex', intent: 'y' }], tools: [{ name: 'tt' }] }, { name: 'ref_x', source: 'builtin', patterns: [{ id: 'c' }], tools: [] }];

(async () => {
  const mkDeps = (more) => Object.assign({ now: () => 1000, domainPacks: () => registered, seedCounts: sc, lessons: LESSONS, matrixSynth: MS, umlCore: UML, designCore: DES,
    feedbackStats: async () => ({ stats: FB.stats(fbStore), store: fbStore, location: 'test' }), rankModel: async () => null, presetProfiles: () => [{ model: 'm1', advice: 'self' }, { model: 'm2', advice: 'guided' }],
    trainerDomains: async () => otDomains }, more || {});
  const B = Builtin.createProvider(mkDeps());
  const items = await B.list(); const by = (k, n) => items.find((x) => x.kind === k && x.name === Builtin.NAMES[n]);
  check('每項都是 builtin／唯讀', items.length >= 10 && items.every((x) => x.owner === 'builtin' && x.origin === 'builtin' && x.readonly), items.map((x) => x.name));

  const dom = by('blockly', 'blockly_domains');
  check('領域包數＝registry 實際註冊數＝檔案數', dom.counts.packs === registered.length && dom.counts.packs === packFiles.length, dom.counts);
  check('算法數＝各包 algos 總和', dom.counts.algos === registered.reduce((n, p) => n + (p.algos || []).length, 0));
  check('骨架數＝各包 skeletons 總和', dom.counts.skeletons === registered.reduce((n, p) => n + (p.skeletons || []).length, 0));
  const sumT = Object.keys(sc).reduce((n, k) => n + sc[k].train, 0), sumH = Object.keys(sc).reduce((n, k) => n + sc[k].holdout, 0);
  check('種子題 train／holdout＝測試檔實際題數', dom.counts.train === sumT && dom.counts.holdout === sumH && dom.counts.seeds === sumT + sumH && dom.counts.seeds > 0, { c: dom.counts, sumT, sumH });
  check('每個領域包都有種子題數資料', registered.every((p) => sc[p.id] && sc[p.id].total > 0), registered.filter((p) => !sc[p.id]).map((p) => p.id));
  const ls = by('blockly', 'blockly_lessons');
  check('內建課數＝py_lessons_builtin.lessons.length', ls.counts.lessons === LESSONS.lessons.length && ls.version === LESSONS.generatedAt && ls.counts.algos === new Set(LESSONS.lessons.map((l) => l.algo)).size, ls.counts);
  const ms = by('matrix', 'matrix');
  check('矩陣層合成器數＝FaMatrixSynth.list() 長度，且含 L0／L1／L2', ms.counts.synthesizers === MS.list().length && ms.counts.synthesizers >= 4 && ms.counts.L0 >= 1 && ms.counts.L1 >= 1 && ms.counts.L2 >= 1, ms.counts);
  const um = by('uml', 'uml');
  check('UML 表數量＝核心匯出表長度；摘要明說唯讀且寫在程式裡', um.counts.uml_actors === UML.ACTORS.length && um.counts.design_arch === Object.keys(DES.ARCH).length + 0 || um.counts.design_arch === DES.ARCH.length, um.counts);
  check('UML 摘要說明不是可訓練資料', /唯讀/.test(um.summary) && /不是可訓練/.test(um.summary));
  const tr = by('trainer', 'trainer');
  check('離線訓練器：領域／規則／工具數', tr.counts.domains === 2 && tr.counts.patterns === 3 && tr.counts.tools === 1, tr.counts);
  const co = by('colu', 'colu_profiles');
  check('CoLU 體檢數', co.counts.models === 2 && co.counts.self === 1 && co.counts.guided === 1, co.counts);
  const fbA = by('colu', 'colu_feedback'); check('回饋紀錄 0 筆時如實顯示 0 並說明', fbA.counts.records === 0 && /還沒有人|還不夠/.test(fbA.summary), fbA.summary);
  const rk = by('colu', 'colu_rank'); check('排序模型未訓練：說明程式碼已內建但沒有模型檔', /還沒有訓練出的模型檔/.test(rk.summary), rk.summary);
  const lo = by('lora', 'lora'); check('LoRA：寫明 lora-train 資料集不在打包內', /不在打包內/.test(lo.summary) && lo.counts.adapters === 0, lo.summary);
  const LD = require('../../../scripts/domain-seed-counts.js').loraDatasets(path.join(__dirname, '..', '..', '..'));
  const lo2 = (await Builtin.createProvider(mkDeps({ loraInfo: async () => ({ adapters: [], datasets: LD.datasets, generators: LD.generators }) })).list()).find((x) => x.kind === 'lora');
  check('LoRA：資料表數／筆數／產生器數來自 lora-train 實際檔案', LD.datasets.length >= 3 && lo2.counts.datasets === LD.datasets.length && lo2.counts.rows === LD.datasets.reduce((n, d) => n + d.rows, 0) && lo2.counts.generators === LD.generators.length, lo2.counts);
  // 回饋有資料時數字跟著變
  fbStore = FB.append(fbStore, [FB.makeRecord({ url: 'https://x/y', gap_id: 'g1', name: 'x', label: 1, source: 'user_adopt', features: [1, 0] })]);
  const B2 = Builtin.createProvider(mkDeps()); const fb2 = (await B2.list()).find((x) => x.name === Builtin.NAMES.colu_feedback);
  check('回饋累積後數量更新（數字來自 stats）', fb2.counts.records === FB.stats(fbStore).records, fb2.counts);

  // 缺來源 → 不可用並寫原因
  const B3 = Builtin.createProvider({}); const it3 = await B3.list();
  check('沒接任何來源：全部標「不可用」且有具體原因，不假裝 0 個', it3.filter((x) => x.kind !== 'lora').every((x) => x.unavailable && /沒有/.test(x.unavailable)), it3.map((x) => x.unavailable));
  // 讀取＋manifest 驗證＋匯出
  const r = await B.read('blockly', Builtin.NAMES.blockly_lessons);
  check('read：manifest owner=builtin、雜湊核對通過', r && r.asset.manifest.owner === 'builtin' && Asset.verifyFiles(r.asset.manifest, r.asset.files).ok, r && r.asset.manifest);
  const lines = Buffer.from(r.asset.files['data/lessons.jsonl']).toString('utf8').split('\n');
  check('資料集行數＝內建課數', lines.length === LESSONS.lessons.length);
  const ex = Fatrain.exportAsset(r.asset, {}); check('可匯出 .fatrain', ex.ok && ex.bytes.length > 0, ex);
  const st = Storage.createStorage({ memory: Storage.createMemoryStore() });
  const imp = await Fatrain.importAsset(ex.bytes, { storage: st, confirmed: true }); check('匯出的檔可以再匯入（變成使用者資產）', imp.ok, imp);

  // ---- 伺服器整合 ----
  const Trainer = require('./trainer_adapter.js'); const bundle = { format: 'fa-offline-trainer', version: 2, exported_at: '2026-11-11T00:00:00Z', summary: 's', payload: { domains: [{ id: 'd1' }], solutions: [{ q: 1 }], synonyms: {} } }; bundle.checksum = Trainer.bundleHash(JSON.stringify(bundle.payload));
  const storage = Storage.createStorage({ memory: Storage.createMemoryStore() }); let dl = [];
  const h = { storage, desktop: true, now: () => 1000, builtin: Builtin.createProvider(mkDeps()), prefsGet: () => ({}), prefsSet: () => {}, download: async (n, b) => { dl.push({ n, b }); }, otExport: async () => bundle };
  const srv = createServer(h); srv.setPush(() => {});
  const req = async (m, p, b) => { const x = await srv.route(m, new URL('http://mock.local' + p), b); return { s: x.s || 200, j: x.j }; };
  let a = await req('GET', '/api/assets'); const g = (k) => a.j.groups.find((x) => x.kind === k);
  check('/api/assets：blockly 內建數＝2、我的／匯入＝0', g('blockly').counts.builtin === 2 && g('blockly').counts.mine === 0 && g('blockly').counts.imported === 0, g('blockly').counts);
  check('/api/assets：各 kind 都有內建項', ['colu', 'blockly', 'matrix', 'uml', 'trainer', 'lora'].every((k) => g(k).counts.builtin >= 1), a.j.groups.map((x) => [x.kind, x.counts]));
  check('colu 內建 4 項（回饋／排序／體檢／接線評量不可用）', g('colu').counts.builtin === 4, g('colu').items.map((x) => x.name));
  await req('POST', '/api/import/pick'); // 無 picked 檔 → 取消，不影響
  const d = await req('GET', '/api/asset?kind=blockly&name=' + encodeURIComponent(Builtin.NAMES.blockly_domains));
  check('/api/asset 內建詳情唯讀、有檔案列表', d.j.readonly === true && d.j.files.some((f) => f.path === 'data/domains.json'), d.j);
  const f = await req('GET', '/api/asset-file?kind=blockly&name=' + encodeURIComponent(Builtin.NAMES.blockly_domains) + '&path=data%2Fdomains.json');
  check('/api/asset-file 可瀏覽資料集', f.j.ok && /"id"/.test(f.j.text), f.j);
  const ds = await req('GET', '/api/datasets'); check('/api/datasets 含內建資料檔且標唯讀', ds.j.files.some((x) => x.readonly && x.kind === 'blockly' && x.path === 'data/seeds.jsonl'), ds.j.files.length);
  const e = await req('POST', '/api/export', { kind: 'blockly', name: Builtin.NAMES.blockly_lessons }); check('/api/export 內建資產', e.j.ok && dl.length === 1 && /\.fatrain$/.test(dl[0].n), e.j);
  const del = await req('POST', '/api/asset/delete', { kind: 'blockly', name: Builtin.NAMES.blockly_lessons, confirmed: true }); check('刪除內建資產被拒', del.s === 409 && /內建/.test(del.j.error), del.j);
  // 使用者資產行為不變：同 kind 另存一個，「我的」+1，內建不變
  await req('POST', '/api/trainer/snapshot', { name: 'my-t' });
  a = await req('GET', '/api/assets'); check('我的／內建分開計數', g('trainer').counts.mine === 1 && g('trainer').counts.builtin === 1, g('trainer').counts);
  const del2 = await req('POST', '/api/asset/delete', { kind: 'trainer', name: 'my-t', confirmed: true }); check('使用者資產照常可刪', del2.j.ok === true, del2.j);
  const hn = createServer(Object.assign({}, h, { builtin: null })); hn.setPush(() => {});
  const x0 = await hn.route('GET', new URL('http://mock.local/api/assets'), {}); check('沒有提供者時只列儲存層（舊行為）', x0.j.groups.every((q) => q.items.length === 0));
  console.log('builtin_assets_core 測試：通過 ' + ok + ' 項，失敗 ' + bad.length + ' 項');
  console.log(items.map((x) => x.kind + '/' + x.name + ' ' + JSON.stringify(x.counts)).join('\n'));
  if (bad.length) process.exit(1);
})().catch((e) => { console.log('ERR', e && e.stack || e); process.exit(1); });
