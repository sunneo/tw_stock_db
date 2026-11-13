// node renderer/src/studio/ext_job_core.test.js —— 外部訓練作業：參數檢查、步驟組裝、進度解析、核對、失敗原因、停止（假的子行程，不跑 Python）
const X = require('./ext_job_core.js');
const EE = require('events');
let ok = 0, bad = 0; const check = (n, c, d) => { if (c) ok++; else { bad++; console.log('FAIL ' + n, d === undefined ? '' : JSON.stringify(d).slice(0, 300)); } };

// 假子行程：可以手動推 stdout／stderr 與結束
function fakeChild() { const ch = new EE(); ch.stdout = new EE(); ch.stderr = new EE(); ch.pid = 1; ch.killed = false; return ch; }
const envBase = { outDir: '/o/music', scriptsDir: '/s', python: '/py', paths: {} };

// ---- 規格與參數 ----
check('六種型別都在規格表', ['music', 'speech_recognition', 'audio_to_notes', 'image', 'vision', 'speech'].every((t) => !!X.specOf(t)));
check('未接線的型別有寫原因', ['audio_to_notes', 'image', 'vision', 'speech'].every((t) => X.specOf(t).wired === false && X.specOf(t).reason));
check('已接線的：作曲、語音辨識', X.specOf('music').wired && X.specOf('speech_recognition').wired);
const bm = X.normalizeParams('music', {});
check('作曲預設值補齊', bm.ok && bm.params.steps === 1500 && bm.params.perStyle === 90, bm);
check('作曲步數超範圍會擋', !X.normalizeParams('music', { steps: 0 }).ok && /steps/.test(X.normalizeParams('music', { steps: 0 }).errors.join()));
check('語音辨識 lr 不是數字會擋', !X.normalizeParams('speech_recognition', { lr: 'abc' }).ok);
check('不認得的型別', !X.normalizeParams('nope', {}).ok);

// ---- 組步驟 ----
const pm = X.planFor('music', {}, envBase);
check('作曲三步：gen、train、check', pm.ok && pm.steps.map((s) => s.id).join() === 'gen,train,check', pm);
check('作曲 gen 用 node（Electron 要設 ELECTRON_RUN_AS_NODE）', pm.steps[0].env && pm.steps[0].env.ELECTRON_RUN_AS_NODE === '1');
check('作曲 train 帶 --steps 與 --corpus 到輸出夾', pm.steps[1].args.indexOf('--steps') > 0 && pm.steps[1].args.indexOf('/o/music/corpus') > 0 && pm.steps[1].args.indexOf('/o/music') > 0);
check('作曲 check 帶 check 判定', pm.steps[2].check && pm.steps[2].check.ok === 'reloaded_songs_identical_to_training_run');
check('作曲沒有 python 會擋（說人話）', !X.planFor('music', {}, { outDir: '/o', scriptsDir: '/s' }).ok);
const ps = X.planFor('speech_recognition', { steps: 40 }, { outDir: '/o/sr', scriptsDir: '/s', python: '/py', paths: { base: '/b', data: '/d.jsonl' } });
check('語音辨識兩步：train、check；check 的 adapter 路徑在輸出夾', ps.ok && ps.steps.map((s) => s.id).join() === 'train,check' && ps.steps[1].args.indexOf('/o/sr/adapter') > 0, ps);
check('語音辨識缺 base 會擋', !X.planFor('speech_recognition', {}, { outDir: '/o', scriptsDir: '/s', python: '/py', paths: { data: '/d' } }).ok);
check('未接線的型別不組步驟', !X.planFor('image', {}, envBase).ok && /還沒接線/.test(X.planFor('image', {}, envBase).errors[0]));

// ---- 進度解析 ----
check('step 行 → step 事件', X.parseLine('{"step": 3, "loss": 0.5}').type === 'step' && X.parseLine('{"step": 3, "loss": 0.5}').step === 3);
check('非 step 的 JSON → json 事件', X.parseLine('{"ok": true}').type === 'json');
check('一般文字 → log 事件（截 300 字）', X.parseLine('before eval loss 4.7').type === 'log' && X.parseLine('x'.repeat(500)).text.length === 300);
check('空白行忽略', X.parseLine('   ') === null);

// ---- 核對 ----
check('核對：ok 等於 of 通過', X.checkResult({ ok: 'a', of: 'of' }, { a: 36, of: 36 }) === null);
check('核對：不相等不通過', /應該等於/.test(X.checkResult({ ok: 'a', of: 'of' }, { a: 3, of: 36 })));
check('核對：沒有 JSON 不通過', /沒有輸出/.test(X.checkResult({ ok: 'a', of: 'of' }, null)));

// ---- 失敗原因翻譯 ----
check('缺套件 → 指名套件', /缺少 Python 套件「transformers」/.test(X.explainCommon("ModuleNotFoundError: No module named 'transformers'")));
check('記憶體不足 → 給建議', /記憶體不足/.test(X.explainCommon('torch.OutOfMemoryError: CUDA out of memory')));
check('認不得的錯誤回 null', X.explainCommon('some other error') === null);

// ---- 執行（假的子行程）----
function runWith(plan, script, exists) {
  const children = []; const outs = [];
  const job = X.runJob(plan, {
    spawn: (cmd, args, o) => { const ch = fakeChild(); children.push({ ch, cmd, args, o }); return ch; },
    kill: (ch) => { ch.killed = true; ch.emit('close', null); }, exists: exists || (() => true), join: (a, b) => a + '/' + b,
    onEvent: (e) => outs.push(e),
  });
  return { job, children, outs, script };
}
function tick() { return new Promise((r) => setTimeout(r, 5)); }

(async () => {
  // 1) 正常路徑：三步都成功，核對通過，輸出都在
  const plan1 = X.planFor('music', {}, envBase);
  const r1 = runWith(plan1);
  await tick();
  r1.children[0].ch.emit('close', 0);             // gen 完成
  await tick();
  r1.children[1].ch.stdout.emit('data', Buffer.from('before eval loss 4.7\n{"step": 1, "loss": 4.1}\n{"step": 2,'));
  r1.children[1].ch.stdout.emit('data', Buffer.from(' "loss": 3.9}\n'));
  r1.children[1].ch.emit('close', 0);
  await tick();
  r1.children[2].ch.stdout.emit('data', Buffer.from('{"reloaded_songs_identical_to_training_run": 36, "of": 36}\n'));
  r1.children[2].ch.emit('close', 0);
  const j1 = await r1.job.done;
  check('正常路徑：狀態 finished', j1.state === 'finished', j1);
  check('正常路徑：進度事件被解析（step=2，loss=3.9）', j1.step === 2 && j1.loss === 3.9, { step: j1.step, loss: j1.loss });
  check('正常路徑：跨分段的 stdout 行正確合併', r1.outs.some((e) => e.type === 'step' && e.step === 2));
  check('正常路徑：三步都標 done', j1.steps.every((s) => s.state === 'done'));

  // 2) 核對不過
  const r2 = runWith(X.planFor('music', {}, envBase));
  await tick(); r2.children[0].ch.emit('close', 0); await tick(); r2.children[1].ch.emit('close', 0); await tick();
  r2.children[2].ch.stdout.emit('data', Buffer.from('{"reloaded_songs_identical_to_training_run": 30, "of": 36}\n')); r2.children[2].ch.emit('close', 0);
  const j2 = await r2.job.done;
  check('核對不過 → failed 並寫在哪一步', j2.state === 'failed' && /作曲|核對/.test(j2.message), j2.message);

  // 3) 步驟失敗：翻譯缺套件
  const r3 = runWith(X.planFor('music', {}, envBase));
  await tick(); r3.children[0].ch.emit('close', 0); await tick();
  r3.children[1].ch.stderr.emit('data', Buffer.from("Traceback...\nModuleNotFoundError: No module named 'torch'\n")); r3.children[1].ch.emit('close', 1);
  const j3 = await r3.job.done;
  check('缺套件 → 中文原因指名套件', j3.state === 'failed' && /torch/.test(j3.message) && /訓練作曲模型/.test(j3.message), j3.message);

  // 4) 輸出檔沒有產生
  const r4 = runWith(X.planFor('music', {}, envBase), null, (f) => !/model\.pt$/.test(f));
  await tick(); r4.children[0].ch.emit('close', 0); await tick(); r4.children[1].ch.emit('close', 0); await tick(); r4.children[2].ch.stdout.emit('data', Buffer.from('{"reloaded_songs_identical_to_training_run": 36, "of": 36}\n')); r4.children[2].ch.emit('close', 0);
  const j4 = await r4.job.done;
  check('步驟跑完但缺輸出檔 → failed 並列出缺的檔', j4.state === 'failed' && /model\.pt/.test(j4.message), j4.message);

  // 5) 停止：正在跑的步驟被停，狀態 stopped，後面的步驟不啟動
  const r5 = runWith(X.planFor('music', {}, envBase));
  await tick(); r5.job.stop(); await tick();
  const j5 = await r5.job.done;
  check('停止 → stopped，且只啟動過第一步', j5.state === 'stopped' && r5.children.length === 1, { state: j5.state, n: r5.children.length });
  check('停止後再停是 already', r5.job.stop().already === true);

  // 6) 啟動即失敗（spawn 丟例外）
  const plan6 = X.planFor('music', {}, envBase);
  const job6 = X.runJob(plan6, { spawn: () => { throw new Error('ENOENT python'); }, exists: () => true, join: (a, b) => a + '/' + b });
  const j6 = await job6.done;
  check('spawn 失敗 → failed 並說明步驟', j6.state === 'failed' && /無法啟動/.test(j6.message), j6.message);

  // 7) publicJob 不含子行程與 done
  const pj = X.publicJob(j1);
  check('publicJob 不外洩 child／done', pj.child === undefined && pj.done === undefined && Array.isArray(pj.steps));

  console.log(ok + ' 項通過，' + bad + ' 項失敗');
  process.exitCode = bad ? 1 : 0;
})();
