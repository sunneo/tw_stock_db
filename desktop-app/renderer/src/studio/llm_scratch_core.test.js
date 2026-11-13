// node renderer/src/studio/llm_scratch_core.test.js —— 建立 LLM（從零開始）：規格、參數量、步驟組裝、與 ext_job_core 的接法、判定規則、假子行程跑完整流程
const L = require('./llm_scratch_core.js');
const X = require('./ext_job_core.js');
const EE = require('events');
let ok = 0, bad = 0; const check = (n, c, d) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, d === undefined ? '' : JSON.stringify(d).slice(0, 300)); } };
const env = { outDir: '/o/ls', scriptsDir: '/s', python: '/py', paths: {} };

// ---- 規格與接線 ----
check('登記到 ext_job_core 且已接線', X.specOf('llm_scratch') && X.specOf('llm_scratch').wired === true);
check('原生執行環境的形狀寫死：28 層、8 個 KV 頭、head_dim 128', L.SHAPE.layers === 28 && L.SHAPE.kvHeads === 8 && L.SHAPE.headDim === 128);
// 參數量：與 llm_scratch.py 實測（mini、詞彙 4096 → 13,480,288；詞彙 8192 小型約 2 千萬）一致
check('參數量與腳本實測一致（mini／詞彙 4096＝13,480,288）', L.paramCount('mini', 4096) === 13480288, L.paramCount('mini', 4096));
check('兩種大小都在 1 千萬到 3 千萬之間（詞彙 8192）', ['mini', 'small'].every((k) => { const n = L.paramCount(k, 8192); return n >= 1e7 && n <= 3e7; }));
check('不認得的大小回 NaN', Number.isNaN(L.paramCount('huge', 4096)));

// ---- 參數 ----
const n = X.normalizeParams('llm_scratch', {});
check('預設值補齊（迷你、詞彙 4096、300 步）', n.ok && n.params.preset === 'mini' && n.params.vocab === 4096 && n.params.steps === 300, n);
check('詞彙太小會擋', !X.normalizeParams('llm_scratch', { vocab: 100 }).ok);
check('步數不是數字會擋（不靜默退回預設）', !X.normalizeParams('llm_scratch', { steps: 'abc' }).ok);

// ---- 步驟 ----
const plan = X.planFor('llm_scratch', {}, env);
check('預設組出七步（沒有原生執行環境就不含原生步驟）', plan.ok && plan.steps.map((s) => s.id).join() === 'prep,tokenizer,pretrain,sft,export,hf,check', plan.errors);
check('沒指定語料用內建小語料', plan.steps[0].args.indexOf('--builtin') > 0 && plan.steps[0].args.indexOf('--corpus') < 0);
const pc = X.planFor('llm_scratch', { corpus: '/data/my.txt' }, env);
check('指定語料就傳 --corpus', pc.steps[0].args.indexOf('/data/my.txt') > 0 && pc.steps[0].args.indexOf('--builtin') < 0);
check('語料也可以從路徑欄位來（介面的路徑欄）', X.planFor('llm_scratch', {}, Object.assign({}, env, { paths: { corpus: '/x/dir' } })).steps[0].args.indexOf('/x/dir') > 0);
check('每步的輸出都放在輸出資料夾底下', plan.steps.every((s) => s.args.some((a) => String(a).indexOf('/o/ls') === 0)));
check('預訓練與指令微調都有「留出損失必須下降」的判定', ['pretrain', 'sft'].every((id) => plan.steps.find((s) => s.id === id).check.some((r) => r.op === 'lt' && r.a === 'heldout_loss_after' && r.b === 'heldout_loss_before')));
check('分詞器要求可還原、匯出要求與 PyTorch 貪婪一致、核對要求重載逐字一致', plan.steps.find((s) => s.id === 'tokenizer').check[0].key === 'roundtrip_all_ok' && plan.steps.find((s) => s.id === 'export').check[0].key === 'fp32_greedy_matches_torch' && plan.steps.find((s) => s.id === 'check').check.map((r) => r.key).join() === 'reload_identical,matches_export');
const pn = X.planFor('llm_scratch', {}, Object.assign({}, env, { nativeRuntimeDir: '/rt' }));
check('找得到原生執行環境才加原生步驟', pn.steps[pn.steps.length - 1].id === 'native' && pn.steps[pn.steps.length - 1].args.indexOf('/rt') > 0 && pn.steps[pn.steps.length - 1].env.ELECTRON_RUN_AS_NODE === '1');
check('指令微調資料可自訂', X.planFor('llm_scratch', { sftData: '/d/sft.jsonl' }, env).steps.find((s) => s.id === 'sft').args.indexOf('/d/sft.jsonl') > 0);
check('不認得的模型大小會擋', !X.planFor('llm_scratch', { preset: 'huge' }, env).ok);
check('預熱步數不可大於等於總步數', !X.planFor('llm_scratch', { steps: 20, warmup: 20 }, env).ok);
check('沒有 Python 時說明', /找不到訓練用的 Python/.test(X.planFor('llm_scratch', {}, { outDir: '/o', scriptsDir: '/s' }).errors.join()));

// ---- 估時間 ----
const e = L.estimate(X.normalizeParams('llm_scratch', {}).params);
check('估時間：預設預訓練分鐘數 = 步 × 批 × 序列 ÷ 1000 × 每千 token 秒數 ÷ 60', e.pretrainMin === Math.round(300 * 4 * 128 / 1000 * L.SEC_PER_KTOK.mini / 60) && e.sftMin === Math.round(40 * L.SFT_SEC_PER_STEP.mini / 60) && Math.abs(e.totalMin - (e.pretrainMin + e.sftMin + 3)) <= 1, e);

// ---- 判定規則與進度解析 ----
check('預訓練進度行解析成 step 事件', X.parseLine('{"step": 5, "loss": 6.5, "lr": 0.001}').type === 'step');
check('留出評量行不當作進度（沒有 loss 欄）', X.parseLine('{"event":"eval","step":50,"heldout_loss":5.1,"heldout_ppl":164}').type === 'json');
check('留出損失沒降會失敗', /應該小於/.test(X.checkResult(plan.steps[2].check, { heldout_loss_before: 5, heldout_loss_after: 5.2 })) && X.checkResult(plan.steps[2].check, { heldout_loss_before: 5, heldout_loss_after: 4.9 }) === null);
check('重載不一致會失敗', /reload_identical/.test(X.checkResult(plan.steps[6].check, { reload_identical: false, matches_export: true })));
check('缺 Python 套件時給中文原因', /缺少 Python 套件「torch」/.test(X.specOf('llm_scratch').explain("ModuleNotFoundError: No module named 'torch'")));

// ---- 假子行程跑完整流程（每步印腳本會印的最後一行）----
const out = {
  prep: '{"event":"prep","ok":true}',
  tokenizer: '{"event":"tokenizer","roundtrip_all_ok":true,"bytes_per_token":3.19}',
  pretrain: '{"step":1,"loss":8.3}\n{"event":"pretrain_done","heldout_loss_before":8.3,"heldout_loss_after":6.1}',
  sft: '{"event":"sft_done","heldout_loss_before":6.5,"heldout_loss_after":5.0}',
  export: '{"event":"export_verify","fp32_greedy_matches_torch":true}',
  hf: '{"event":"export_hf","transformers_loads":true,"greedy_identical":true}',
  check: '{"event":"check","reload_identical":true,"matches_export":true}',
};
const files = new Set(plan.outputs.map((f) => '/o/ls/' + f));
const spawn = (cmd, args) => { const ch = new EE(); ch.stdout = new EE(); ch.stderr = new EE(); const id = args[1] === 'export-hf' ? 'hf' : args[1]; setImmediate(() => { ch.stdout.emit('data', out[id] + '\n'); ch.emit('close', 0); }); return ch; };
const job = X.runJob(plan, { spawn, kill() {}, exists: (p) => files.has(p), join: (a, b) => a + '/' + b, readJson() { return {}; } });
job.done.then((j) => {
  check('假子行程跑完：七步都完成', j.state === 'finished' && j.steps.every((s) => s.state === 'done'), { s: j.state, m: j.message });
  check('跑完有進度事件與輸出清單', j.step === 1 && j.loss === 8.3 && j.outputs.length === plan.outputs.length);
  // 預訓練留出損失沒降 → 整個作業失敗並指出原因
  const bad2 = Object.assign({}, out, { pretrain: '{"event":"pretrain_done","heldout_loss_before":8.3,"heldout_loss_after":8.9}' });
  const sp2 = (cmd, args) => { const ch = new EE(); ch.stdout = new EE(); ch.stderr = new EE(); setImmediate(() => { ch.stdout.emit('data', bad2[args[1] === 'export-hf' ? 'hf' : args[1]] + '\n'); ch.emit('close', 0); }); return ch; };
  return X.runJob(plan, { spawn: sp2, kill() {}, exists: (p) => files.has(p), join: (a, b) => a + '/' + b }).done;
}).then((j) => {
  check('預訓練留出損失沒降：作業失敗並指出步驟', j.state === 'failed' && /預訓練.*核對不過/.test(j.message), j.message);
  console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
});
