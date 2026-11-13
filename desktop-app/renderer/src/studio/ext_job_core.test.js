// node renderer/src/studio/ext_job_core.test.js —— 外部訓練作業：參數檢查、路徑檢查、步驟組裝（六型別）、進度解析、判定規則、執行與停止（假的子行程，不跑 Python）
const X = require('./ext_job_core.js');
const EE = require('events');
let ok = 0, bad = 0; const check = (n, c, d) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, d === undefined ? '' : JSON.stringify(d).slice(0, 300)); } };

function fakeChild() { const ch = new EE(); ch.stdout = new EE(); ch.stderr = new EE(); ch.pid = 1; ch.killed = false; return ch; }
const envBase = { outDir: '/o/music', scriptsDir: '/s', python: '/py', paths: {} };
const SIX = ['music', 'speech_recognition', 'speech', 'audio_to_notes', 'vision', 'image'];

// ---- 規格與參數 ----
check('六種型別都在規格表，且全部已接線', SIX.every((t) => X.specOf(t) && X.specOf(t).wired === true));
check('未接線的型別會擋（沒有假的型別）', !X.planFor('nope', {}, envBase).ok && !X.specOf('nope'));
const bm = X.normalizeParams('music', {});
check('作曲預設值補齊', bm.ok && bm.params.steps === 1500 && bm.params.perStyle === 90, bm);
check('作曲步數超範圍會擋', !X.normalizeParams('music', { steps: 0 }).ok);
check('語音辨識 lr 不是數字會擋（不靜默退回預設）', !X.normalizeParams('speech_recognition', { lr: 'abc' }).ok && /必須是數字/.test(X.normalizeParams('speech_recognition', { lr: 'abc' }).errors[0]));
check('語音合成預設 30 步、lr 0.005', X.normalizeParams('speech', {}).params.steps === 30 && X.normalizeParams('speech', {}).params.lr === 0.005);
check('圖像生成預設提示詞不是空的', X.normalizeParams('image', {}).params.prompt.length > 0);

// ---- 路徑檢查（假的檔案系統）----
const fsOf = (files, dirs, lines) => ({ exists: (p) => files.indexOf(p) >= 0 || dirs.indexOf(p) >= 0, isDir: (p) => dirs.indexOf(p) >= 0, readLines: (p) => (lines && lines[p]) || [] });
const rowOk = '{"audio":"wav/a.wav","text":"hi","split":"train"}';
check('語音辨識路徑：資料夾與 data.jsonl 都在、格式對 → 沒有錯誤', X.checkPaths('speech_recognition', { base: '/b', data: '/d.jsonl' }, fsOf(['/b/config.json', '/d.jsonl'], ['/b'], { '/d.jsonl': [rowOk] })).length === 0);
check('語音辨識資料格式錯（缺 text）會指出行號', /第 1 行缺 audio/.test(X.checkPaths('speech_recognition', { base: '/b', data: '/d.jsonl' }, fsOf(['/b/config.json', '/d.jsonl'], ['/b'], { '/d.jsonl': ['{"audio":"x"}'] }))[0] || ''));
check('語音合成缺 kokoro-v1_0.pth 會指出', X.checkPaths('speech', { model: '/m', voice: '/v.pt', data: '/d' }, fsOf(['/m/config.json', '/v.pt', '/d/train.jsonl'], ['/m', '/d'])).some((e) => /kokoro-v1_0\.pth/.test(e)));
check('圖像生成缺 unet 會指出', X.checkPaths('image', { base: '/s' }, fsOf(['/s/model_index.json'], ['/s', '/s/unet'])).some((e) => /缺 vae/.test(e)));
check('缺路徑參數會說要填哪一個', X.checkPaths('audio_to_notes', {}, fsOf([], []))[0].indexOf('基底轉譜模型') >= 0);

// ---- 組步驟（六型別）----
const pm = X.planFor('music', {}, envBase);
check('作曲三步：gen、train、check', pm.ok && pm.steps.map((s) => s.id).join() === 'gen,train,check', pm);
check('作曲 gen 用 node（Electron 要設 ELECTRON_RUN_AS_NODE）', pm.steps[0].env && pm.steps[0].env.ELECTRON_RUN_AS_NODE === '1');
check('作曲 check 規則：reloaded 等於 of', pm.steps[2].check[0].op === 'eq' && pm.steps[2].check[0].a === 'reloaded_songs_identical_to_training_run');
check('作曲沒有 python 會擋（說人話）', !X.planFor('music', {}, { outDir: '/o', scriptsDir: '/s' }).ok);

const ps = X.planFor('speech_recognition', { steps: 40 }, { outDir: '/o/sr', scriptsDir: '/s', python: '/py', paths: { base: '/b', data: '/d.jsonl' } });
check('語音辨識兩步：train、check；check 的 adapter 在輸出夾', ps.ok && ps.steps.map((s) => s.id).join() === 'train,check' && ps.steps[1].args.indexOf('/o/sr/adapter') > 0);

const pt = X.planFor('speech', {}, { outDir: '/o/sp', scriptsDir: '/s', python: '/py', paths: { model: '/km', voice: '/v.pt', data: '/d' } });
check('語音合成兩步：train、synth 核對；config／weights 在子命令前（全域參數）', pt.ok && pt.steps.map((s) => s.id).join() === 'train,check' && pt.steps[0].args.indexOf('--config') < pt.steps[0].args.indexOf('train') && pt.steps[0].args.indexOf('/km/kokoro-v1_0.pth') > 0, pt);
check('語音合成核對：samples 大於 0；輸出含語音包 .bin', pt.steps[1].check[0].op === 'gt0' && pt.outputs.indexOf('voice_trained.bin') >= 0);
check('語音合成缺模型資料夾會擋', !X.planFor('speech', {}, { outDir: '/o', scriptsDir: '/s', python: '/py', paths: {} }).ok);

const pa = X.planFor('audio_to_notes', { steps: 300 }, { outDir: '/o/a2n', scriptsDir: '/s', python: '/py', nodeExec: '/node', paths: { base: '/nmp.onnx' } });
check('音訊轉音符四步：gen_train、gen_eval（node）、train、check', pa.ok && pa.steps.map((s) => s.id).join() === 'gen_train,gen_eval,train,check', pa);
check('音訊轉音符核對：ort_loads 必須是 true；產出 model.onnx', pa.steps[3].check[0].op === 'true' && pa.steps[3].check[0].key === 'ort_loads' && pa.outputs.indexOf('model.onnx') >= 0);

const pv = X.planFor('vision', { steps: 4 }, { outDir: '/o/v', scriptsDir: '/lora-train', python: '/py', paths: { base: '/smol' } });
check('看圖兩步：train（含合成資料）、check 用 eval_vlm', pv.ok && pv.steps[1].args.some((a) => /eval_vlm\.py$/.test(a)) && pv.steps[1].check[0].key === 'n', pv);

const pi = X.planFor('image', { steps: 2 }, { outDir: '/o/i', scriptsDir: '/lora-train', python: '/py', paths: { base: '/sdxs' } });
check('圖像三步：data、train、verify；verify 讀 verify_verify.json', pi.ok && pi.steps.map((s) => s.id).join() === 'data,train,check' && pi.steps[2].checkFile === 'verify_verify.json', pi);
check('圖像核對：重複一致與跨程序一致都必須為 true', pi.steps[2].check.length === 2 && pi.steps[2].check.every((r) => r.op === 'true'));

// ---- 進度解析 ----
check('step 行 → step 事件', X.parseLine('{"step": 3, "loss": 0.5}').type === 'step');
check('vision 的 loss_mean_recent 也算 loss', (() => { const e = X.parseLine('{"step": 4, "loss_mean_recent": 2.5, "elapsed_s": 1}'); return e.type === 'step' && e.loss === 2.5; })());
check('SDXS 的「step N pair P loss X」→ step 事件', (() => { const e = X.parseLine('step 0 pair 3 loss 0.123456 (2.0s)'); return e.type === 'step' && e.loss === 0.123456; })());
check('非 step 的 JSON → json 事件', X.parseLine('{"ok": true}').type === 'json');
check('一般文字 → log 事件（截 300 字）', X.parseLine('before eval loss 4.7').type === 'log' && X.parseLine('x'.repeat(500)).text.length === 300);
check('空白行忽略', X.parseLine('   ') === null);

// ---- 判定規則 ----
check('eq：相等通過', X.checkResult([{ op: 'eq', a: 'a', b: 'of' }], { a: 36, of: 36 }) === null);
check('eq：不相等不通過', /應該等於/.test(X.checkResult([{ op: 'eq', a: 'a', b: 'of' }], { a: 3, of: 36 })));
check('true：不是 true 不通過', /應該是 true/.test(X.checkResult([{ op: 'true', key: 'ort_loads' }], { ort_loads: false })));
check('gt0：0 不通過、正數通過', /大於 0/.test(X.checkResult([{ op: 'gt0', key: 'samples' }], { samples: 0 })) && X.checkResult([{ op: 'gt0', key: 'samples' }], { samples: 5 }) === null);
check('lt：要真的變小', X.checkResult([{ op: 'lt', a: 'after', b: 'before' }], { after: 1.3, before: 2.1 }) === null && /應該小於/.test(X.checkResult([{ op: 'lt', a: 'after', b: 'before' }], { after: 3, before: 2 })));
check('沒有 JSON 不通過', /沒有輸出/.test(X.checkResult([{ op: 'eq', a: 'a', b: 'b' }], null)));
check('不認得的規則不通過（不靜默放行）', /不認得/.test(X.checkResult([{ op: 'weird' }], {})));

// ---- 失敗原因翻譯 ----
check('缺套件 → 指名套件', /缺少 Python 套件「transformers」/.test(X.explainCommon("ModuleNotFoundError: No module named 'transformers'")));
check('記憶體不足 → 給建議', /記憶體不足/.test(X.explainCommon('torch.OutOfMemoryError: CUDA out of memory')));
check('認不得的錯誤回 null', X.explainCommon('some other error') === null);

// ---- 執行（假的子行程）----
function runWith(plan, exists, readJson) {
  const children = [];
  const job = X.runJob(plan, {
    spawn: (cmd, args, o) => { const ch = fakeChild(); children.push({ ch, cmd, args, o }); return ch; },
    kill: (ch) => { ch.killed = true; ch.emit('close', null); }, exists: exists || (() => true), join: (a, b) => a + '/' + b,
    readJson: readJson || (() => { throw new Error('no file'); }),
  });
  return { job, children };
}
function tick() { return new Promise((r) => setTimeout(r, 5)); }

(async () => {
  // 1) 正常路徑（作曲）：三步都成功，核對通過，輸出都在
  const r1 = runWith(X.planFor('music', {}, envBase));
  await tick(); r1.children[0].ch.emit('close', 0); await tick();
  r1.children[1].ch.stdout.emit('data', Buffer.from('before eval loss 4.7\n{"step": 1, "loss": 4.1}\n{"step": 2,'));
  r1.children[1].ch.stdout.emit('data', Buffer.from(' "loss": 3.9}\n'));
  r1.children[1].ch.emit('close', 0); await tick();
  r1.children[2].ch.stdout.emit('data', Buffer.from('{"reloaded_songs_identical_to_training_run": 36, "of": 36}\n'));
  r1.children[2].ch.emit('close', 0);
  const j1 = await r1.job.done;
  check('正常路徑：狀態 finished', j1.state === 'finished', j1);
  check('正常路徑：進度事件被解析（step=2，loss=3.9）', j1.step === 2 && j1.loss === 3.9, { step: j1.step, loss: j1.loss });

  // 2) 核對不過
  const r2 = runWith(X.planFor('music', {}, envBase));
  await tick(); r2.children[0].ch.emit('close', 0); await tick(); r2.children[1].ch.emit('close', 0); await tick();
  r2.children[2].ch.stdout.emit('data', Buffer.from('{"reloaded_songs_identical_to_training_run": 30, "of": 36}\n')); r2.children[2].ch.emit('close', 0);
  const j2 = await r2.job.done;
  check('核對不過 → failed 並寫在哪一步', j2.state === 'failed' && /核對不過/.test(j2.message), j2.message);

  // 3) 步驟失敗：翻譯缺套件
  const r3 = runWith(X.planFor('music', {}, envBase));
  await tick(); r3.children[0].ch.emit('close', 0); await tick();
  r3.children[1].ch.stderr.emit('data', Buffer.from("Traceback...\nModuleNotFoundError: No module named 'torch'\n")); r3.children[1].ch.emit('close', 1);
  const j3 = await r3.job.done;
  check('缺套件 → 中文原因指名套件', j3.state === 'failed' && /torch/.test(j3.message) && /訓練作曲模型/.test(j3.message), j3.message);

  // 4) 輸出檔沒有產生
  const r4 = runWith(X.planFor('music', {}, envBase), (f) => !/model\.pt$/.test(f));
  await tick(); r4.children[0].ch.emit('close', 0); await tick(); r4.children[1].ch.emit('close', 0); await tick();
  r4.children[2].ch.stdout.emit('data', Buffer.from('{"reloaded_songs_identical_to_training_run": 36, "of": 36}\n')); r4.children[2].ch.emit('close', 0);
  const j4 = await r4.job.done;
  check('步驟跑完但缺輸出檔 → failed 並列出缺的檔', j4.state === 'failed' && /model\.pt/.test(j4.message), j4.message);

  // 5) 圖像：核對走 checkFile（讀 JSON 檔），不看 stdout
  const r5 = runWith(X.planFor('image', { steps: 2 }, { outDir: '/o/i', scriptsDir: '/l', python: '/py', paths: { base: '/s' } }), null, (p) => ({ repeat_identical_before: true, fresh_process_identical_to_in_process: true }));
  await tick(); for (let k = 0; k < 2; k++) { r5.children[k].ch.emit('close', 0); await tick(); }
  r5.children[2].ch.emit('close', 0);
  const j5 = await r5.job.done;
  check('圖像核對讀 checkFile，兩項都 true → finished', j5.state === 'finished', j5.message);
  const r5b = runWith(X.planFor('image', { steps: 2 }, { outDir: '/o/i', scriptsDir: '/l', python: '/py', paths: { base: '/s' } }), null, () => ({ repeat_identical_before: true, fresh_process_identical_to_in_process: false }));
  await tick(); for (let k = 0; k < 2; k++) { r5b.children[k].ch.emit('close', 0); await tick(); }
  r5b.children[2].ch.emit('close', 0);
  const j5b = await r5b.job.done;
  check('圖像跨程序不一致 → failed', j5b.state === 'failed' && /fresh_process/.test(j5b.message), j5b.message);

  // 6) 停止：正在跑的步驟被停，狀態 stopped，後面的步驟不啟動
  const r6 = runWith(X.planFor('music', {}, envBase));
  await tick(); r6.job.stop(); await tick();
  const j6 = await r6.job.done;
  check('停止 → stopped，且只啟動過第一步', j6.state === 'stopped' && r6.children.length === 1, { state: j6.state, n: r6.children.length });
  check('停止後再停是 already', r6.job.stop().already === true);

  // 7) 啟動即失敗（spawn 丟例外）
  const job7 = X.runJob(X.planFor('music', {}, envBase), { spawn: () => { throw new Error('ENOENT python'); }, exists: () => true, join: (a, b) => a + '/' + b });
  const j7 = await job7.done;
  check('spawn 失敗 → failed 並說明步驟', j7.state === 'failed' && /無法啟動/.test(j7.message), j7.message);

  // 8) publicJob 不含子行程與 done
  const pj = X.publicJob(j1);
  check('publicJob 不外洩 child／done', pj.child === undefined && pj.done === undefined && Array.isArray(pj.steps));

  console.log(ok + ' 項通過，' + bad + ' 項失敗');
  process.exitCode = bad ? 1 : 0;
})();
