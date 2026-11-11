'use strict';
// 訓練工作室 GUI 補齊：評量（eval_core）、五種符號式訓練包裝（sym_suites_core＋sym_train_core，可暫停／繼續／停止）、老師迴圈（teacher_core，鐵則由程式強制）。
// 用真實的 uml_core／uml_bench_core／rank_train／feedback_core／matrix_synth；判題器沒有 Python 時，依賴判題器的部分驗證「寫出具體原因」。
const path = require('path'), fs = require('fs');
const Asset = require('./asset_core.js'), Storage = require('./storage_core.js'), Trainer = require('./trainer_adapter.js');
const Ev = require('./eval_core.js'), Sym = require('./sym_suites_core.js'), ST = require('./sym_train_core.js'), Te = require('./teacher_core.js');
const { createServer } = require('./studio_server_core.js');
const R = path.join(__dirname, '..');
const UC = require(path.join(R, 'uml/uml_core.js')), UB = require(path.join(R, 'uml/uml_bench_core.js'));
const Rank = require(path.join(R, 'catalog/rank_train.js')), FB = require(path.join(R, 'catalog/feedback_core.js'));
const MS = require(path.join(R, 'algo/matrix_synth_core.js')); ['matrix_graph_core.js', 'matrix_l0_core.js'].forEach((f) => { const m = require(path.join(R, 'algo', f)); if (m.install) m.install(MS); });
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 真判題器（需要 python）；沒有就當作不可用
let judge = null; try { const J = require('../../../judge-runner.js'); const pr = require('child_process').spawnSync(process.env.FA_PYTHON || 'python3', ['-c', '1']); if (pr.status === 0) judge = (a) => J.judge(a); } catch (_) { /* */ }

(async () => {
  // ===== eval_core =====
  const suites = [{ group: 'a', run: async () => ({ n: 10, pass: 9 }) }, { group: 'b', run: async () => ({ n: 10, pass: 5 }) }, { group: 'c', unavailable: '需要 X；解除條件 Y' }, { group: 'h', heldout: true, run: async () => ({ n: 4, pass: 4, detail: { secret: 1 } }) }, { group: 'boom', run: async () => { throw new Error('壞了'); } }];
  let res = await Ev.runEval('t', suites, { baseline: { a: 1, b: 0.5 } });
  const G = (n) => res.groups.find((g) => g.group === n);
  check('評量每組都列', res.groups.length === 5);
  check('退步標記（0.9 比基準 1 低超過容差）', G('a').regressed === true && G('a').delta === -0.1);
  check('持平不算退步；低於門檻', G('b').regressed === false && G('b').passedGate === false);
  check('沒跑成的組有原因、不算通過也不算退步', G('c').ran === false && /解除條件/.test(G('c').unavailable) && !G('c').regressed);
  check('例外被收成原因', G('boom').ran === false && /壞了/.test(G('boom').unavailable));
  check('上線判斷：有退步／未過門檻即不可上線', res.summary.releaseOk === false && res.summary.regressed === 1 && res.summary.belowGate === 1);
  check('留出組不帶逐題細節', G('h').detail === undefined);
  check('老師視角的留出組只剩通過率', Ev.teacherView(res).groups.find((g) => g.group === 'h').rate === 1 && !JSON.stringify(Ev.teacherView(res).groups.find((g) => g.group === 'h')).includes('secret'));
  const res2 = await Ev.runEval('t', [{ group: 'a', run: async () => ({ n: 10, pass: 10 }) }], { gate: { default: 0.8, groups: { a: 0.95 } } });
  check('每組門檻可個別設定', res2.summary.releaseOk === true && res2.groups[0].gate === 0.95);
  check('存基準', Ev.saveBaseline(res2, { z: 1 }).a === 1 && Ev.saveBaseline(res2, { z: 1 }).z === 1);
  check('改善比較', Ev.improvement(res, { groups: [{ group: 'b', ran: true, rate: 0.9 }, { group: 'a', ran: true, rate: 0.9 }] }).improved === true);

  // ===== 評量組（真實模組）=====
  const deps = { UC, UmlBench: UB, Rank, Feedback: FB, Synth: MS, rankUse: ['f1', 'f2'], lessons: { verified: { tasks: 20, offlineAfter: 20, offlineBefore: 3 }, generatedAt: 'x' }, now: () => 1 };
  const um = await Ev.runEval('uml', Sym.evalSuites('uml', deps), {});
  check('uml 評量 8 組、全部有跑', um.groups.length === 8 && um.groups.every((g) => g.ran), um.groups.map((g) => g.unavailable));
  check('uml 通過率來自真實比對（0..1 且不全為 1）', um.groups.every((g) => g.rate >= 0 && g.rate <= 1) && um.groups.some((g) => g.rate < 1), um.groups.map((g) => g.rate));
  const bl = await Ev.runEval('blockly', Sym.evalSuites('blockly', deps), {});
  check('blockly：內建課為「已記錄」；種子題寫明為何不能跑', bl.groups[0].recorded && bl.groups[0].rate === 1 && bl.groups[1].ran === false && /tree-sitter/.test(bl.groups[1].unavailable));
  const mx = await Ev.runEval('matrix', Sym.evalSuites('matrix', Object.assign({}, deps, { judge })), {});
  if (judge) check('matrix 真跑（有 Python）：L0／L1／L2 至少解出一半', mx.groups.every((g) => g.ran) && mx.groups.filter((g) => g.pass >= 1).length >= 3, mx.groups.map((g) => [g.group, g.pass, g.unavailable]));
  else check('matrix 沒有判題器：每組寫明需要判題器', mx.groups.length === Sym.MATRIX_CASES.length && mx.groups.every((g) => g.ran === false && /判題器/.test(g.unavailable)));
  const cl = await Ev.runEval('colu', Sym.evalSuites('colu', Object.assign({}, deps, { feedbackStore: async () => FB.emptyStore(), presetProfiles: () => [{ model: 'm', advice: 'self' }, { model: 'n', advice: 'guided' }] })), {});
  check('colu：回饋不足時寫明缺什麼與解除條件；體檢為已記錄', cl.groups[0].ran === false && /groups 0\/8/.test(cl.groups[0].unavailable) && /解除條件/.test(cl.groups[0].unavailable) && cl.groups[1].recorded && cl.groups[1].rate === 0.5, cl.groups.map((g) => g.unavailable));
  const tr = await Ev.runEval('trainer', Sym.evalSuites('trainer', Object.assign({}, deps, { toolNames: () => ['t1'], trainerDomains: async () => [{ name: 'd', patterns: [{ id: 'a', type: 'regex', expr: '^a', tool: 't1', confidence: 0.9 }, { id: 'b', type: 'regex', expr: '(', tool: 't1' }, { id: 'c', type: 'regex', expr: 'x', tool: 'nope' }, { id: 'd', type: 'regex', expr: 'y', confidence: 3 }] }] })), {});
  check('trainer 規則自檢抓出壞正規式／不存在的工具／信心值', tr.groups[0].n === 4 && tr.groups[0].pass === 1 && tr.groups[0].detail.bad.length === 3, tr.groups[0]);
  const lo = await Ev.runEval('lora', Sym.evalSuites('lora', deps), {});
  check('lora 沒有評量資產：寫明來源與解除條件', lo.groups[0].ran === false && /eval_run\.py/.test(lo.groups[0].unavailable));

  // ===== 訓練包裝與執行器 =====
  const storage = Storage.createStorage({ memory: Storage.createMemoryStore() });
  // colu：造足夠的回饋
  let store = FB.emptyStore(); const recs = []; for (let g = 0; g < 10; g++) for (let k = 0; k < 4; k++) recs.push(FB.makeRecord({ url: 'https://x/' + g + '/' + k, gap_id: 'g' + g, name: 'n', label: k === 0 ? 1 : 0, source: k === 0 ? 'user_adopt' : 'user_reject', features: { f1: k === 0 ? 1 + g * 0.01 : 0.1 * k, f2: k === 0 ? 0.9 : 0.2 } }));
  store = FB.append(store, recs); const st = FB.stats(store);
  const cdeps = Object.assign({}, deps, { feedbackStore: async () => store });
  const none = await Sym.prepareTrain('colu', Object.assign({}, deps, { feedbackStore: async () => FB.emptyStore() }), {}); check('colu 無回饋：拒絕並寫解除條件', !none.ok && /解除條件/.test(none.error));
  const pc = await Sym.prepareTrain('colu', cdeps, {}); check('colu 備妥（回饋 ' + st.records + ' 筆、ready=' + st.ready_to_train + '）', pc.ok && pc.units.length === 4, pc);
  const events = []; const runner = ST.createRunner({ storage, Asset, Trainer, now: () => Date.now(), onChange: (j) => events.push(j.state) });
  let r = runner.start('colu', 'colu-t1', pc, {}); check('啟動符號式訓練', r.ok && r.total === 4, r);
  const r2 = runner.start('colu', 'colu-t2', pc, {}); check('同時只能一個', r2.ok === false && /已有符號式訓練/.test(r2.error));
  for (let i = 0; i < 400 && runner.status().state !== 'finished'; i++) await sleep(10);
  let stt = runner.status(); check('訓練完成並存成資產', stt.state === 'finished' && stt.result.saved[0] === 'colu/colu-t1', stt);
  const sa = await storage.loadAsset('colu', 'colu-t1'); check('資產有模型檔、評量寫進 manifest、owner=user', sa && sa.asset.files['data/rank-model.json'] && sa.asset.manifest.eval && sa.asset.manifest.eval.pass > 50 && sa.asset.manifest.owner === 'user', sa && sa.asset.manifest.eval);
  // 暫停／繼續／停止（用慢的假單元）
  const slow = { ok: true, note: 'slow', units: Array.from({ length: 6 }, (_, i) => ({ label: 'u' + i, run: async () => { await sleep(15); } })), finish: async () => ({ files: { 'README.txt': new TextEncoder().encode('x') }, counts: { n: 6 } }) };
  r = runner.start('colu', 'slow1', slow, {}); await sleep(25); const p = await runner.pause(); check('暫停停在段與段之間', p.state === 'paused' && p.done >= 1 && p.done < 6, p);
  const cur = p.done; await sleep(60); check('暫停期間不前進', runner.status().done === cur);
  check('繼續', runner.resume().ok === true); for (let i = 0; i < 400 && runner.status().state !== 'finished'; i++) await sleep(10);
  check('繼續後做完，沒有重做已完成的段', runner.status().state === 'finished' && runner.status().done === 6 && runner.status().log.filter((l) => /^u0（/.test(l.text)).length === 1);
  r = runner.start('colu', 'slow2', slow, {}); await sleep(20); runner.stop(); for (let i = 0; i < 200 && runner.status().state === 'running'; i++) await sleep(10);
  check('停止不寫資產', runner.status().state === 'stopped' && !(await storage.loadManifest('colu', 'slow2')));
  const bad1 = { ok: true, units: [{ label: 'x', run: async () => { throw new Error('爆'); } }], finish: async () => ({}) }; runner.start('colu', 'err1', bad1, {}); for (let i = 0; i < 100 && runner.status().state === 'running'; i++) await sleep(10);
  check('單元出錯：狀態 error 並帶原因', runner.status().state === 'error' && /爆/.test(runner.status().error));
  // 其他四種
  const nb = await Sym.prepareTrain('blockly', deps, {}); check('blockly 沒題目：寫格式與解除條件', !nb.ok && /tasks\.jsonl/.test(nb.error));
  const nj = await Sym.prepareTrain('blockly', deps, { tasks: [{ id: 'a', statement: 's', solution: 'x', tests: [] }] }); check('blockly 沒有判題器：寫具體原因', !nj.ok && /判題器|tree-sitter/.test(nj.error), nj);
  const um1 = await Sym.prepareTrain('uml', deps, {}); check('uml 沒情境對：寫格式', !um1.ok && /pairs\.jsonl/.test(um1.error));
  const fx = UB.FIXTURES[0]; const gen = await UC.scenarioToModel(fx.scenario, {});
  const pairs = [{ scenario: fx.scenario, model: gen.model }, { scenario: 'bad', model: { actors: [], classes: [{ name: 'lower_case', members: [] }], usecases: [], relations: [] } }];
  const pu = await Sym.prepareTrain('uml', deps, { pairs }); const rr = ST.createRunner({ storage, Asset, Trainer, now: () => 1 }); rr.start('uml', 'uml-t1', pu, {}); for (let i = 0; i < 200 && rr.status().state !== 'finished' && rr.status().state !== 'error'; i++) await sleep(10);
  check('uml：合法的收、不合法的拒並進 rejected', rr.status().state === 'finished' && rr.status().result.counts.accepted === 1 && rr.status().result.counts.rejected === 1, rr.status());
  const pm = await Sym.prepareTrain('matrix', deps, { tasks: [{ id: 'm1', statement: '輸入三個整數，輸出中位數', examples: [{ in: '2 1 3\n', out: '2\n' }, { in: '9 8 7\n', out: '8\n' }] }] });
  const rm = ST.createRunner({ storage, Asset, Trainer, now: () => 1 }); rm.start('matrix', 'mx-t1', pm, {}); for (let i = 0; i < 300 && rm.status().state !== 'finished' && rm.status().state !== 'error'; i++) await sleep(10);
  check('matrix 擬合（無判題器時標「未用隱藏測資驗證」）', rm.status().state === 'finished' && rm.status().result.counts.fitted === 1 && (judge ? true : rm.status().result.counts.verified === 0) && /不保證/.test(pm.note), rm.status());
  const pt = await Sym.prepareTrain('trainer', deps, {}); check('trainer 沒接蒸餾接口：寫明', !pt.ok && /蒸餾|整理/.test(pt.error));
  const bundle = { format: 'fa-offline-trainer', version: 2, exported_at: 'x', summary: {}, payload: { domains: [{ name: 'd1', patterns: [] }], solutions: [], synonyms: {} } }; bundle.checksum = Trainer.bundleHash(JSON.stringify(bundle.payload));
  let dist = 0; const ptr = await Sym.prepareTrain('trainer', Object.assign({}, deps, { trainerSnapshot: async () => bundle, trainerDistill: async () => { dist++; return { ok: true, turns: 5, proposals: 2, adopted: 1, updated: 0 }; } }), {});
  const rt = ST.createRunner({ storage, Asset, Trainer, now: () => 1 }); rt.start('trainer', 'tr-t1', ptr, {}); for (let i = 0; i < 200 && rt.status().state !== 'finished' && rt.status().state !== 'error'; i++) await sleep(10);
  check('trainer：蒸餾一次、存「整理前」與「整理後」兩份資產', rt.status().state === 'finished' && dist === 1 && !!(await storage.loadManifest('trainer', 'tr-t1')) && !!(await storage.loadManifest('trainer', 'tr-t1-before')), rt.status());

  // ===== 老師迴圈 =====
  const K = Sym.teacherKinds({ UC });
  const good = { scenario: fx.scenario, model: gen.model };
  let aiCalls = 0, rowsFromAi = [];
  const mkT = (aiFn, extra) => Te.createTeacher(Object.assign({ now: () => 1, Eval: Ev, kinds: K, hash: (s) => String(s.length), evaluate: async () => Ev.runEval('uml', [{ group: 'g1', run: async () => ({ n: 10, pass: 6 }) }, { group: 'hold', heldout: true, run: async () => ({ n: 5, pass: 2 }) }], {}), ai: aiFn, loadExisting: async () => ({ train: [{ scenario: 'old one', model: {} }], heldout: [{ scenario: '留出情境', model: {} }] }) }, extra || {}));
  const noAI = mkT(null); const pn = await noAI.plan({ kind: 'uml', goal: 'x' }); check('沒有線上 AI：不能開始並寫解除條件', !pn.ok && /線上 AI/.test(pn.error) && /解除條件/.test(pn.error));
  const unk = await mkT(async () => ({})).plan({ kind: 'colu' }); check('colu 不給老師代做：寫原因', !unk.ok && /使用者的決定|沒有老師可用/.test(unk.error), unk.error);
  const T1 = mkT(async ({ tools }) => {
    aiCalls++; const gap = await tools.studio_gap_report.call({}); rowsFromAi.push(gap);
    const out = []; out.push(await tools.studio_dataset_add.call({ rows: [good] }));
    out.push(await tools.studio_dataset_add.call({ rows: [good] }));                                   // 重複
    out.push(await tools.studio_dataset_add.call({ rows: [{ scenario: '留出情境', model: gen.model }] })); // 與留出題相同
    out.push(await tools.studio_dataset_add.call({ rows: [{ scenario: '標 heldout', model: gen.model, split: 'heldout' }] }));
    out.push(await tools.studio_dataset_add.call({ rows: [{ scenario: '壞設計', model: { actors: [], classes: [{ name: 'bad_name' }], usecases: [], relations: [] } }] }));
    rowsFromAi.push(out); return { text: '{"status":"done","added":1}' };
  });
  const pl = await T1.plan({ kind: 'uml', goal: '補 uml', target: 'uml-teach' }); check('建立工作階段並算出缺口（留出組只列通過率）', pl.ok && pl.session.preview.prompt.includes('補 uml') && !pl.session.preview.prompt.includes('留出情境') && /heldout/.test(pl.session.preview.prompt), pl.session && pl.session.preview.prompt.slice(0, 200));
  const sid = pl.session.id; const noConf = await T1.run(sid, {}); check('送出前沒確認就不送', noConf.ok === false && noConf.needsConfirm && aiCalls === 0);
  const wrongHash = await T1.run(sid, { confirmed: true, previewHash: 'zzz' }); check('hash 不符不送', wrongHash.needsConfirm && aiCalls === 0);
  const run = await T1.run(sid, { confirmed: true, previewHash: pl.session.preview.hash });
  check('老師執行：只收通過驗證的一筆', run.ok && run.session.counts.accepted === 1 && run.session.items[0].verified_by === 'uml_core.validateModel', run.session && run.session.counts);
  const results = rowsFromAi[1]; check('重複、與留出題相同、heldout、驗證沒過 都被拒並有原因', !results[1].results[0].ok && /已經有相同/.test(results[1].results[0].error) && /留出題相同/.test(results[2].results[0].error) && /split 只能是 train/.test(results[3].results[0].error) && /程式驗證沒過/.test(results[4].results[0].error), results.map((x) => x.results && x.results[0]));
  check('每列記 author／來源／時間／驗證證據', (() => { const rows = T1.rowsToCommit(sid); return rows.length === 1 && rows[0].author === 'teacher' && rows[0].source.tool === 'studio_dataset_add' && rows[0].at === 1 && rows[0].verified_by && rows[0].row.meta.author === 'teacher' && rows[0].row.split === 'train'; })());
  check('這輪沒有改善就停（無試算接口＝明說）', run.session.report && run.session.state !== 'running' && run.session.rounds.length >= 1);
  const listTool = T1.makeTools(sid).studio_dataset_list; const lst = await listTool.call({}); check('list 不含留出題', !JSON.stringify(lst).includes('留出情境'));
  const rd = await T1.makeTools(sid).studio_dataset_read.call({ i: 1 }); check('read 讀不到留出題（索引超出 train）', rd.ok === false);
  check('使用者可逐筆拒絕；拒絕後不再被寫入', T1.reject(sid, 'r1', '不要').ok === true && T1.rowsToCommit(sid).length === 0);
  // 試算：沒改善 → 回滾並停止
  let tcalls = 0; const T2 = mkT(async ({ tools }) => { tcalls++; await tools.studio_dataset_add.call({ rows: [{ scenario: '新情境' + tcalls, model: gen.model }] }); return { text: 'ok' }; }, { trial: async () => Ev.runEval('uml', [{ group: 'g1', run: async () => ({ n: 10, pass: 6 }) }], {}) });
  const p2 = await T2.plan({ kind: 'uml', goal: 'g' }); const r2b = await T2.run(p2.session.id, { confirmed: true, previewHash: p2.session.preview.hash });
  check('試算沒改善：回滾本輪、停止、不再灌資料', r2b.session.state === 'no_improvement' && tcalls === 1 && r2b.session.counts.rolled_back === 1 && r2b.session.counts.accepted === 0, r2b.session);
  // 上限
  const T3 = mkT(async ({ tools }) => { const rows = Array.from({ length: 5 }, (_, i) => ({ scenario: '情境' + i, model: gen.model })); const o = await tools.studio_dataset_add.call({ rows }); rowsFromAi.push(o); return { text: 'ok' }; }, { trial: async () => Ev.runEval('uml', [{ group: 'g1', run: async () => ({ n: 10, pass: 9 }) }], {}) });
  const p3 = await T3.plan({ kind: 'uml', goal: 'g', limits: { maxRows: 2 } }); const r3 = await T3.run(p3.session.id, { confirmed: true, previewHash: p3.session.preview.hash });
  check('單次擴充上限：只收 2 筆，其餘被拒', r3.session.counts.accepted === 2 && /上限/.test(JSON.stringify(rowsFromAi[rowsFromAi.length - 1].results[2])), rowsFromAi[rowsFromAi.length - 1]);
  check('白名單恰為七個工具', Te.TOOLS.join(',') === 'studio_dataset_list,studio_dataset_read,studio_dataset_add,studio_dataset_remove,studio_dataset_verify,studio_dataset_eval,studio_gap_report' && Object.keys(T3.makeTools(p3.session.id)).join(',') === Te.TOOLS.join(','));
  // blockly／matrix 需要判題器：沒有就寫具體原因
  const vb = await K.blockly.verifyRow({ statement: 's', solution: 'x', tests: [{ in: '', out: '' }, { in: '', out: '' }] }); check('blockly 驗證沒有判題器：寫原因，不收', vb.ok === false && /判題器/.test(vb.problems[0]));
  const vl = await K.lora.verifyRow({ messages: [{ role: 'user', content: 'q' }] }); check('lora 列沒有語料塊依據：拒收', vl.ok === false && /語料塊/.test(vl.problems[0]));

  // ===== 伺服器整合 =====
  const storage2 = Storage.createStorage({ memory: Storage.createMemoryStore() }); let prefs = {};
  const h = { storage: storage2, desktop: true, now: () => 1000, prefsGet: () => prefs, prefsSet: (p) => { prefs = p; }, sym: Object.assign({}, deps, { feedbackStore: async () => store }), teacherAI: async ({ tools }) => { await tools.studio_dataset_add.call({ rows: [good] }); return { text: 'ok' }; } };
  const srv = createServer(h); srv.setPush(() => {}); const req = async (m, p, b) => { const x = await srv.route(m, new URL('http://mock.local' + p), b); return { s: x.s || 200, j: x.j }; };
  let q = await req('GET', '/api/eval'); check('/api/eval 列出六種且符號式可用', q.j.implemented && q.j.kinds.every((k) => k.available), q.j.kinds);
  q = await req('POST', '/api/eval/run', { kind: 'uml', saveBaseline: true }); check('/api/eval/run 跑 uml、存基準', q.j.ok && q.j.summary.ran === 8 && q.j.baselineSaved && Object.keys(prefs.evalBaseline.uml).length === 8, q.j.summary);
  q = await req('POST', '/api/eval/run', { kind: 'uml' }); check('再跑一次：有上次通過率、沒有退步', q.j.groups.every((g) => g.prev === g.rate && g.regressed === false));
  q = await req('POST', '/api/eval/gate', { default: 0.9 }); check('門檻存起來', q.j.gate.default === 0.9 && prefs.evalGate.default === 0.9);
  q = await req('POST', '/api/eval/run', { kind: 'zzz' }); check('不認得的種類被拒', q.s === 400);
  q = await req('POST', '/api/train/start', { kind: 'colu', name: 'colu-srv', cfg: {} }); check('/api/train/start 走符號式', q.j.ok && q.j.sym === true, q.j);
  for (let i = 0; i < 300; i++) { const s = await req('GET', '/api/train/sym-status'); if (s.j.state === 'finished') break; await sleep(10); }
  q = await req('GET', '/api/train/sym-status'); check('伺服器端狀態 finished 並存成使用者資產', q.j.state === 'finished' && !!(await storage2.loadManifest('colu', 'colu-srv')), q.j);
  q = await req('GET', '/api/assets'); check('新資產列在「我的」', q.j.groups.find((g) => g.kind === 'colu').counts.mine === 1);
  q = await req('POST', '/api/train/start', { kind: 'blockly', name: 'bb', cfg: {} }); check('blockly 沒題目回 409 與格式', q.s === 409 && /tasks\.jsonl/.test(q.j.error));
  q = await req('GET', '/api/teacher'); check('/api/teacher 已實作且可執行', q.j.implemented && q.j.canRun && q.j.tools.length === 7);
  q = await req('POST', '/api/teacher/plan', { kind: 'uml', goal: '補', target: 'uml-teach' }); const ps = q.j.session; check('老師 plan', q.j.ok && ps.preview.hash, q.j);
  q = await req('POST', '/api/teacher/run', { id: ps.id }); check('路由：沒確認不送', q.s === 400 && q.j.needsConfirm);
  q = await req('POST', '/api/teacher/run', { id: ps.id, confirmed: true, previewHash: ps.preview.hash }); check('路由：確認後執行並新增 1 筆', q.j.ok && q.j.session.counts.accepted === 1, q.j);
  const before = await storage2.loadManifest('uml', 'uml-teach'); check('執行後尚未寫入資產', before === null || before === undefined);
  q = await req('POST', '/api/teacher/commit', { id: ps.id }); check('commit 寫入 data/teacher.jsonl，且沒有啟動訓練', q.j.ok && q.j.written === 1 && !(srv.S.lastSym && false), q.j);
  const ta = await storage2.loadAsset('uml', 'uml-teach'); check('資產含 teacher.jsonl（author:teacher）', ta && JSON.parse(Buffer.from(ta.asset.files['data/teacher.jsonl']).toString().split('\n')[0]).author === 'teacher');
  q = await req('POST', '/api/teacher/commit', { id: ps.id, name: '../x' }); check('不合法名稱被拒', q.s === 400);

  console.log('sym_studio 測試：通過 ' + ok + ' 項，失敗 ' + bad.length + ' 項（判題器：' + (judge ? '有 Python，matrix 真跑' : '沒有 Python，判題相關只驗證原因') + '）');
  if (bad.length) process.exit(1);
})().catch((e) => { console.log('ERR', e && e.stack || e); process.exit(1); });
