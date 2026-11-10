'use strict';
// 規範化檢查點、PCG32、資料游標、相容性（含負向）、跨後端 loss 比對、暫停→續訓前 20 步 loss 對照。
// 注意：暫停／續訓這項是「用迷你訓練器模擬」（真的 AdamW＋PCG32＋游標＋檢查點往返，但不是 Qwen3 的訓練），不代表 train_lora.py 的續訓精度。
const C = require('./checkpoint_core.js'), J = require('./backend_cpu_js.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
(async () => {
  // PCG32 官方示範向量（seed 42、序列 54）
  const g = new C.PCG32(42, 54), v = [0, 1, 2, 3, 4, 5].map(() => g.nextU32().toString(16));
  check('PCG32 與官方示範向量一致', v.join() === 'a15c02b7,7b47f409,ba1d3330,83d2f293,bfa4784b,cbed606e', v);
  const g2 = new C.PCG32(5, 1); for (let i = 0; i < 10; i++) g2.nextU32(); const snap = g2.snapshot(), g3 = C.PCG32.fromSnapshot(snap);
  check('亂數狀態可快照還原', g2.nextU32() === g3.nextU32() && g2.nextU32() === g3.nextU32());
  check('洗牌可重現且是排列', JSON.stringify(C.shuffleIndices(16, 7)) === JSON.stringify(C.shuffleIndices(16, 7)) && C.shuffleIndices(16, 7).slice().sort((a, b) => a - b).join() === Array.from({ length: 16 }, (_, i) => i).join());
  check('不同種子洗牌不同', JSON.stringify(C.shuffleIndices(16, 7)) !== JSON.stringify(C.shuffleIndices(16, 8)));
  // 游標：分兩段取 = 一次取
  let cur = C.createCursor(3), all = []; for (let i = 0; i < 40; i++) { const r = C.nextIndices(cur, 16, 1); all.push(r.indices[0]); cur = r.cursor; }
  let cur2 = C.createCursor(3), a1 = []; for (let i = 0; i < 40; i++) { if (i === 20) cur2 = JSON.parse(JSON.stringify(cur2)); const r = C.nextIndices(cur2, 16, 1); a1.push(r.indices[0]); cur2 = r.cursor; }
  check('游標中斷再接與一次取相同（含跨 epoch）', JSON.stringify(all) === JSON.stringify(a1) && cur.epoch >= 2, { e: cur.epoch });
  // 張量檔往返、依名稱排序
  const t = C.decodeTensors(C.encodeTensors([{ name: 'b', shape: [2], data: new Float32Array([1.5, -2]) }, { name: 'a', shape: [1, 2], data: new Float32Array([0.1, 3]) }]));
  check('張量檔依層名排序且位元精確', t[0].name === 'a' && t[1].name === 'b' && t[0].data[0] === Math.fround(0.1) && t[1].data[1] === -2, t);
  // 檢查點往返、sha256
  const b = J.createCpuJsBackend(), h = await b.init(null, {}); for (let i = 0; i < 5; i++) await b.step(h, {});
  const cp = await b.saveCheckpoint(h);
  check('檢查點欄位齊全（§3.1）', C.validateCkptJson(cp.ckpt).ok && cp.ckpt.dtype === 'float32' && cp.ckpt.rng.algo === 'pcg32' && cp.ckpt.cursor.order_seed !== undefined && cp.ckpt.optimizer.kind === 'adamw' && cp.ckpt.compat.rank === 2 && cp.ckpt.produced_by.backend === 'cpu-js' && cp.ckpt.loss_tail.length === 5 && cp.ckpt.eval_check.loss > 0);
  check('四個張量檔都在且 sha256 一致', C.TENSOR_FILES.every((f) => cp.files[f] && cp.ckpt.sha256[f] === C.sha256(cp.files[f])) && C.verifyChecksums(cp).ok);
  const tam = { ckpt: cp.ckpt, files: Object.assign({}, cp.files, { 'lora_A.f32': Buffer.from(cp.files['lora_A.f32']) }) }; tam.files['lora_A.f32'][tam.files['lora_A.f32'].length - 1] ^= 1;
  check('位元被改動會被 sha256 抓到', !C.verifyChecksums(tam).ok && /lora_A/.test(C.verifyChecksums(tam).bad[0]));
  let rejected = ''; try { await b.loadCheckpoint(await b.init(null, {}), tam); } catch (e) { rejected = e.message; }
  check('載入被改動的檢查點被拒絕', /驗證失敗/.test(rejected), rejected);
  // 相容性（負向）
  const curr = { compat: cp.ckpt.compat, data_sha256: cp.ckpt.data_sha256, optimizer: { kind: 'adamw' } };
  check('相容欄位全符：允許續訓', C.checkCompat(cp.ckpt, curr).ok);
  for (const [f, val] of [['rank', 4], ['base_sha256', 'zzz'], ['alpha', 99], ['target_modules', ['q']], ['prompt_format_version', 2], ['tool_catalog_sha256', 'new'], ['base', 'other']]) {
    const r = C.checkCompat(cp.ckpt, { compat: Object.assign({}, cp.ckpt.compat, { [f]: val }), data_sha256: curr.data_sha256, optimizer: curr.optimizer });
    check('負向：' + f + ' 不符被拒絕並提示 fork', !r.ok && r.action === 'fork' && r.mismatches[0].field === 'compat.' + f && /fork/.test(r.message), r);
  }
  check('負向：data_sha256 不符被拒絕', C.checkCompat(cp.ckpt, Object.assign({}, curr, { data_sha256: 'x' })).action === 'fork');
  check('負向：優化器種類不符被拒絕', C.checkCompat(cp.ckpt, Object.assign({}, curr, { optimizer: { kind: 'sgd' } })).action === 'fork');
  check('負向：version 不符被拒絕（沒有遷移器就明說）', (() => { const r = C.checkCompat(Object.assign({}, cp.ckpt, { version: 0 }), curr); return !r.ok && r.action === 'reject' && /遷移/.test(r.mismatches[0].detail); })());
  check('負向：format 錯誤被拒絕', C.checkCompat(Object.assign({}, cp.ckpt, { format: 'x' }), curr).action === 'reject');
  check('後端與裝置不同仍允許（只記錄）', C.checkCompat(Object.assign({}, cp.ckpt, { produced_by: { backend: 'webgpu', device_fingerprint: 'other' } }), curr).ok);
  let loadErr = null; const hh = await b.init(null, { rank: 2 }); const cpBad = { ckpt: Object.assign({}, cp.ckpt, { compat: Object.assign({}, cp.ckpt.compat, { rank: 8 }) }), files: cp.files };
  try { await b.loadCheckpoint(hh, cpBad); } catch (e) { loadErr = e; }
  check('後端載入時也拒絕相容欄位不符（rank）', loadErr && loadErr.compat && loadErr.compat.action === 'fork', loadErr && loadErr.message);
  // 跨後端 loss 比對（2%／半精度 5%）
  check('比對：相對差 1.9% 通過', C.compareLoss(1.019, 1).ok); check('比對：2.1% 不通過', !C.compareLoss(1.021, 1).ok);
  check('比對：半精度 4.9% 通過、5.1% 不通過', C.compareLoss(1.049, 1, { fp16: true }).ok && !C.compareLoss(1.051, 1, { fp16: true }).ok);
  check('比對：NaN 不通過', !C.compareLoss(NaN, 1).ok);
  check('同後端門檻 1e-5', C.TOL.sameBackend === 1e-5 && !C.compareSameBackendRun([1], [1.0001]).ok && C.compareSameBackendRun([1], [1 + 5e-6]).ok);
  check('長度不同視為不符', !C.compareSameBackendRun([1, 2], [1]).ok);
  check('趨勢警示只警示不拒絕', C.trendWarning([1, 1], [5, 5]).warn === true && C.trendWarning([1, 1], [0.9]).warn === false && C.trendWarning([], [1]).warn === false);
  const rr = C.resumeRecord(cp.ckpt, 'cpu-py', { ok: true }); check('續訓紀錄寫明由 A 暫停、B 續訓', /由 cpu-js 後端暫停、cpu-py 後端續訓/.test(rr.text) && rr.sameBackend === false);

  // 同後端暫停→重開→續訓：前 20 步 loss 最大相對差 ≤ 1e-5（模擬，見檔頭說明）
  const cfg = { total: 100 };
  const base = await b.init(null, cfg), ref = []; for (let i = 0; i < 40; i++) ref.push((await b.step(base, {})).loss);
  const first = await b.init(null, cfg); for (let i = 0; i < 20; i++) await b.step(first, {});
  const saved = await b.saveCheckpoint(first);
  // 搬移：只帶檔案內容（Buffer 與 JSON 文字），不共用任何記憶體物件
  const moved = { ckpt: JSON.parse(JSON.stringify(saved.ckpt)), files: {} }; Object.keys(saved.files).forEach((f) => { moved.files[f] = Buffer.from(saved.files[f]); });
  const second = await b.init(moved, cfg), resumed = []; for (let i = 0; i < 20; i++) resumed.push((await b.step(second, {})).loss);
  const cmp = C.compareSameBackendRun(ref.slice(20), resumed);
  check('暫停→續訓前 20 步 loss 最大相對差 ≤ 1e-5（模擬）', cmp.ok, cmp);
  console.log('  （續訓前20步最大相對差 ' + cmp.maxRelErr + '）');
  // 敏感度：若亂數狀態沒還原，結果應不同（證明這個比對有鑑別力）
  const broken = JSON.parse(JSON.stringify(moved.ckpt)); broken.rng = new C.PCG32(1, 1).snapshot();
  const third = await b.init({ ckpt: broken, files: moved.files }, cfg), r3 = []; for (let i = 0; i < 20; i++) r3.push((await b.step(third, {})).loss);
  check('對照：亂數沒還原會讓比對失敗（有鑑別力）', !C.compareSameBackendRun(ref.slice(20), r3).ok);
  // 與暫停當下 eval_check 一致（續訓前比對）
  const ev = (await b.evalLoss(await b.init(moved, cfg), { indices: saved.ckpt.eval_check.batch })).loss;
  check('續訓前以 eval_batch 比對：同後端差為 0', C.compareLoss(ev, saved.ckpt.eval_check.loss, { tol: 1e-5 }).ok);
  console.log(ok + ' passed, ' + bad.length + ' failed', bad);
  process.exit(bad.length ? 1 : 0);
})();
