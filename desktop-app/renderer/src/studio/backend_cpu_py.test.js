'use strict';
// cpu-py 後端：probe（有／無 Python、缺套件、缺腳本，用注入的探測函式，不真的卸載 Python）、進度行解析、
// 子行程啟動參數（windowsHide、核心數）、暫停＝存檢查點後結束、續訓、基準測試與中斷（假子行程）、safetensors 轉規範化檢查點。
const { EventEmitter } = require('events');
const P = require('./backend_cpu_py.js'), B = require('./backend_core.js'), C = require('./checkpoint_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };

// 記憶體檔案系統（路徑一律用 / ）
function memfs() {
  const files = new Map(), dirs = new Set();
  const norm = (p) => String(p).replace(/\\/g, '/');
  return { files, dirs,
    existsSync: (p) => { p = norm(p); return files.has(p) || dirs.has(p) || [...files.keys(), ...dirs].some((k) => k.startsWith(p + '/')); },
    readdirSync: (d) => { d = norm(d).replace(/\/$/, ''); const out = new Set(); [...files.keys(), ...dirs].forEach((k) => { if (k.startsWith(d + '/')) out.add(k.slice(d.length + 1).split('/')[0]); }); return [...out]; },
    writeFileSync: (p, c) => { files.set(norm(p), c); }, appendFileSync: (p, c) => { p = norm(p); files.set(p, (files.get(p) || '') + c); }, readFileSync: (p) => { if (!files.has(norm(p))) throw new Error('ENOENT ' + p); return files.get(norm(p)); },
    unlinkSync: (p) => { files.delete(norm(p)); }, mkdirSync: (p) => { dirs.add(norm(p)); } };
}
const posix = require('path').posix;
// 假子行程：依 --max_steps 每 2ms 印一行 log；stop_file 出現就存 checkpoint-N、印 [paused]、結束；可注入失敗
function fakeSpawner(fs, o) {
  o = o || {}; const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts }); const ch = new EventEmitter(); ch.stdout = new EventEmitter(); ch.stderr = new EventEmitter(); ch.killed = false;
    const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
    const max = +(arg('--max_steps') || 50), out = arg('--output_dir'), stop = arg('--stop_file'), resume = arg('--resume_from_checkpoint');
    let step = resume ? +/checkpoint-(\d+)$/.exec(resume)[1] : 0, timer = null;
    const end = (code) => { clearInterval(timer); setImmediate(() => ch.emit('exit', code, null)); };
    ch.kill = () => { ch.killed = true; ch.killedAt = step; end(null); };
    timer = setInterval(() => {
      if (o.crashAt && step >= o.crashAt) { ch.stderr.emit('data', 'Traceback (most recent call last):\nRuntimeError: out of memory\n'); return end(1); }
      step++; ch.stdout.emit('data', "{'loss': " + (o.nan && step > 5 ? 'nan' : (3 / step).toFixed(4)) + ", 'grad_norm': 1.5, 'learning_rate': 0.0001, 'epoch': " + (step / 100).toFixed(2) + '}\n');
      if (stop && fs.existsSync(stop)) { fs.dirs.add(out + '/checkpoint-' + step); fs.writeFileSync(out + '/checkpoint-' + step + '/adapter_model.safetensors', Buffer.alloc(0)); ch.stdout.emit('data', '[paused] step=' + step + '\n'); return end(0); }
      if (!o.noSave && step % 10 === 0) fs.dirs.add(out + '/checkpoint-' + step);
      if (step >= max) { ch.stdout.emit('data', '[done] adapter saved to ' + out + '\n'); end(0); }
    }, 2);
    return ch;
  };
  spawn.calls = calls; return spawn;
}
const mkBackend = (o) => { const fs = memfs(); fs.writeFileSync('/lora/train_lora.py', 'x'); const spawn = fakeSpawner(fs, o && o.spawnOpts); return { fs, spawn, b: P.createCpuPyBackend(Object.assign({ detect: async () => ({ found: true, path: 'python', version: '3.10.4', packages: { torch: '2.3', transformers: '4.4', peft: '0.1' } }), spawn, fs, path: posix, loraDir: '/lora', hw: { cpuModel: 'Core Ultra 7 155U', cores: 12 } }, o && o.inject)) }; };

(async () => {
  // ---- probe：有／無 Python ----
  const mkP = (det, fsx) => { const fs = fsx || memfs(); if (!fsx) fs.writeFileSync('/lora/train_lora.py', 'x'); return P.createCpuPyBackend({ detect: det, spawn: () => {}, fs, path: posix, loraDir: '/lora', hw: { cpuModel: 'X', cores: 8 } }); };
  const noPy = await mkP(async () => ({ found: false })).probe();
  check('無 Python：不可用且 reason 明說找不到 Python 與出路', !noPy.available && /找不到 Python/.test(noPy.reason) && /匯出訓練包/.test(noPy.reason), noPy);
  check('probe 結果型別合法', B.validateProbeResult(noPy).length === 0);
  const noPkg = await mkP(async () => ({ found: true, version: '3.10.4', packages: { torch: null, transformers: '4', peft: null } })).probe();
  check('有 Python 缺套件：列出缺的套件', !noPkg.available && /torch、peft/.test(noPkg.reason) && /3\.10\.4/.test(noPkg.reason) && !/transformers/.test(noPkg.reason.split('缺少套件：')[1].split('。')[0]), noPkg);
  const noScript = await mkP(async () => ({ found: true, version: '3.10.4', packages: { torch: '2', transformers: '4', peft: '1' } }), memfs()).probe();
  check('缺訓練腳本：回具體路徑', !noScript.available && /train_lora\.py/.test(noScript.reason), noScript);
  const good = await mkP(async () => ({ found: true, version: '3.10.4', packages: { torch: '2.3', transformers: '4', peft: '1' } })).probe();
  check('有 Python 且套件齊全：可用、指紋含 Python／torch 版本', good.available && !good.reason && good.fingerprint.python_version === '3.10.4' && good.fingerprint.torch_version === '2.3' && good.fingerprint.cores === 8, good);
  const thrown = await B.safeProbe(mkP(async () => { throw new Error('偵測爆了'); }), {});
  check('偵測函式丟例外：不可用並說找不到 Python', !thrown.available && /找不到 Python/.test(thrown.reason), thrown);
  // 預設偵測（用假 spawnSync，不碰真的行程）
  const det = P.defaultDetect((cmd, args, opts) => { det.calls.push({ cmd, opts }); return cmd === 'python3' ? { status: 0, stdout: JSON.stringify({ version: '3.11.0', packages: { torch: '2', transformers: '4', peft: '1' } }) + '\n' } : { error: new Error('ENOENT'), status: null }; }); det.calls = [];
  const dr = await det();
  check('預設偵測：python 找不到就試 python3，且 windowsHide', dr.found && dr.path === 'python3' && dr.version === '3.11.0' && det.calls.every((c) => c.opts.windowsHide === true), { dr, calls: det.calls });
  check('介面型別', B.validateBackend(mkBackend().b).length === 0);

  // ---- Python 探測順序（全用注入的假 spawnSync／假 fs，不動真環境）----
  {
    const full = { torch: '2.15', transformers: '5.22', peft: '0.21' };
    const mkSpawn = (table) => { const calls = []; const f = (cmd, args) => { calls.push(cmd); if (cmd === 'py' && args[0] === '-0p') return table['py -0p'] ? { status: 0, stdout: table['py -0p'] } : { error: new Error('ENOENT'), status: null }; const t = table[cmd]; return t ? { status: 0, stdout: JSON.stringify({ version: t.v, packages: t.p }) + '\n' } : { error: new Error('ENOENT'), status: null }; }; f.calls = calls; return f; };
    const BS = String.fromCharCode(92), WP = (s) => s.split('/').join(BS), VENV = WP('D:/x/lora-train/.venv/Scripts/python.exe'), fsHas = { existsSync: (f) => f === VENV };
    const winPath = require('path').win32;
    const sp1 = mkSpawn({ [VENV]: { v: '3.13.1', p: full }, python: { v: '3.10.4', p: { torch: null, transformers: null, peft: null } } });
    const r1 = await P.defaultDetect(sp1, { fs: fsHas, path: winPath, platform: 'win32', venvDirs: [WP('D:/x/lora-train')] })();
    check('探測：優先用 lora-train/.venv，找到就不再往後試', r1.found && r1.path === VENV && r1.version === '3.13.1' && sp1.calls.indexOf('python') < 0, r1);
    const PY313 = WP('C:/Python313/python.exe'), sp2 = mkSpawn({ python: { v: '3.10.4', p: full }, 'py -0p': ' -V:3.13 *        ' + PY313 + String.fromCharCode(10) + ' -V:3.10          ' + WP('C:/Python310/python.exe') + String.fromCharCode(10), [PY313]: { v: '3.13.0', p: { torch: null, transformers: null, peft: null } } });
    const r2 = await P.defaultDetect(sp2, { fs: { existsSync: () => false }, path: winPath, platform: 'win32', venvDirs: [WP('D:/x/lora-train')] })();
    check('探測：PATH 上 3.10 不採用，改選 py 啟動器列出的 3.13（缺套件由 probe 說明）', r2.found && r2.path === PY313 && r2.version === '3.13.0', r2);
    const sp3 = mkSpawn({ python: { v: '3.10.4', p: full } });
    const r3 = await P.defaultDetect(sp3, { fs: { existsSync: () => false }, path: winPath, platform: 'win32', venvDirs: [] })();
    check('探測：只有 3.10 → found:false 並記下太舊的版本', !r3.found && r3.tooOld === '3.10.4', r3);
    const pr3 = await P.createCpuPyBackend({ detect: async () => r3, spawn: () => {}, fs: memfs(), path: posix, loraDir: '/lora', hw: { cores: 4 } }).probe();
    check('太舊：reason 寫明需要 3.11 以上與三個套件、建議 .venv，並附安裝指令與 --extra-index-url', !pr3.available && /3\.10\.4/.test(pr3.reason) && /需要 Python 3\.11 以上與 torch／transformers／peft，建議在 lora-train\/\.venv 安裝/.test(pr3.reason) && /uv venv --python 3\.13/.test(pr3.reason) && /--extra-index-url https:\/\/download\.pytorch\.org\/whl\/cpu/.test(pr3.reason), pr3);
    check('pyOk 邊界', P.pyOk('3.11.0') && P.pyOk('3.13.1') && !P.pyOk('3.10.9') && !P.pyOk('2.7.18') && P.pyOk('4.0.0') && !P.pyOk(null));
  }

  // transformers 5.x 實測的 log 行：數值帶引號、且接在進度條後面
  check('解析帶引號數值的 log（實測格式）', JSON.stringify(P.parseProgressLine("{'loss': '13.93', 'grad_norm': '66.25', 'learning_rate': '0', 'epoch': '0.09091'}")) === JSON.stringify({ type: 'log', loss: 13.93, gradNorm: 66.25, lr: 0, epoch: 0.09091 }));
  const glued = P.parseProgressLine("100%|##########| 6/6 [01:10<00:00, 11.83s/it]{'loss': '9.515', 'grad_norm': '84.18', 'learning_rate': '5e-05', 'epoch': '0.5455'}");
  check('解析接在進度條後面的 log', glued && glued.type === 'log' && glued.loss === 9.515 && glued.lr === 5e-05, glued);
  // ---- 探測不 import torch、單項逾時、結果快取 ----
  {
    const full = { torch: '2.15', transformers: '5.22', peft: '0.21' }, BS = String.fromCharCode(92), WP = (x) => x.split('/').join(BS), VENV = WP('D:/x/lora-train/.venv/Scripts/python.exe');
    const fsX = { existsSync: (f) => f === VENV, statSync: () => ({ mtimeMs: 5 }) }, wp = require('path').win32;
    let codeSeen = '', spawns = 0;
    const sp = (cmd, args, o) => { if (cmd === 'py' && args[0] === '-0p') return { error: new Error('ENOENT'), status: null }; spawns++; codeSeen = args[2] || ''; o.__t = o.timeout; return { status: 0, stdout: JSON.stringify({ version: '3.13.1', packages: full }) + String.fromCharCode(10) }; };
    const store = {}, cache = { get: (k) => store[k] || null, set: (k, v) => { store[k] = v; } };
    const mk = () => P.defaultDetect(sp, { fs: fsX, path: wp, platform: 'win32', venvDirs: [WP('D:/x/lora-train')], cache });
    const r1 = await mk()();
    check('探測程式碼用 importlib.metadata、不 import torch', /importlib/.test(codeSeen) && /metadata/.test(codeSeen) && !/__import__/.test(codeSeen) && !/import torch/.test(codeSeen), codeSeen);
    check('第一次真的啟動子行程，結果寫入快取', r1.found && spawns === 1 && Object.keys(store).length === 1, { spawns, store });
    const r2 = await mk()();
    check('第二次直接用快取、不啟動子行程', r2.found && spawns === 1 && r2.tried[0].cached === true, { spawns, r2 });
    fsX.statSync = () => ({ mtimeMs: 6 });   // 裝了套件 → 修改時間變 → 快取失效
    await mk()(); check('site-packages 修改時間變了：快取失效重探', spawns === 2, spawns);
    // 逾時：記下具體原因，probe 的 reason 帶出
    const spT = (cmd, args) => (cmd === 'py' && args[0] === '-0p') ? { error: new Error('ENOENT'), status: null } : { error: Object.assign(new Error('spawnSync python ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null };
    const dt = await P.defaultDetect(spT, { fs: { existsSync: () => false }, path: wp, platform: 'win32', venvDirs: [], timeoutMs: 8000 })();
    check('逾時：找不到，tried 記逾時秒數', !dt.found && dt.tried.length > 0 && dt.tried.every((x) => /逾時（8 秒/.test(x.error)), dt);
    const prT = await P.createCpuPyBackend({ detect: async () => dt, spawn: () => {}, fs: memfs(), path: posix, loraDir: '/lora', hw: { cores: 4 } }).probe();
    check('逾時：probe 的 reason 寫出哪些項目逾時', !prT.available && /探測失敗項目：.*逾時/.test(prT.reason), prT);
  }
  // ---- 進度行解析 ----
  const pl = P.parseProgressLine;
  check('解析 log 字典', JSON.stringify(pl("{'loss': 1.2345, 'grad_norm': 0.5, 'learning_rate': 0.0002, 'epoch': 0.03}")) === JSON.stringify({ type: 'log', loss: 1.2345, gradNorm: 0.5, lr: 0.0002, epoch: 0.03 }));
  check('解析 eval', pl("{'eval_loss': 0.9, 'epoch': 1.0}").type === 'eval' && pl("{'eval_loss': 0.9, 'epoch': 1.0}").evalLoss === 0.9);
  check('解析 nan loss', Number.isNaN(pl("{'loss': nan, 'grad_norm': 1.0}").loss));
  const tq = pl('  3%|▎         | 5/200 [00:10<06:30,  2.01s/it]'); check('解析 tqdm 進度', tq && tq.type === 'progress' && tq.step === 5 && tq.total === 200 && Math.abs(tq.secPerIt - 2.01) < 1e-9, tq);
  check('解析 it/s', Math.abs(pl('10%|█| 20/200 [00:10<01:30,  2.00it/s]').secPerIt - 0.5) < 1e-9);
  check('解析 [done]／[paused]／錯誤', pl('[done] adapter saved to out/x').type === 'done' && pl('[paused] step=40').step === 40 && pl('RuntimeError: boom').type === 'error' && pl('Traceback (most recent call last):').type === 'error');
  check('無關行回 null', pl('') === null && pl('[model] loading') === null);

  // ---- 啟動參數 ----
  const { b, spawn, fs } = mkBackend();
  const args = b.buildArgs({ trainFile: 't.jsonl', outputDir: '/o', epochs: 1, lr: 0.0001, rank: 8, maxSteps: 5 });
  check('參數：腳本、資料、輸出、rank、max_steps、預設 logging_steps=1', args[0] === '/lora/train_lora.py' && args.includes('--lora_r') && args[args.indexOf('--lora_r') + 1] === '8' && args[args.indexOf('--max_steps') + 1] === '5' && args[args.indexOf('--logging_steps') + 1] === '1', args);
  check('沒給的選項不出現', !args.includes('--resume_from_checkpoint') && !args.includes('--stop_file'));
  check('預設核心數＝N−1（12 核心→11）', b.buildEnv({}).LORA_THREADS === '11');
  const b2 = mkBackend({ inject: { config: { cpuCores: 4 } } }).b;
  check('Configure 設定核心數生效', b2.buildEnv({}).LORA_THREADS === '4' && b2.buildEnv({ purpose: 'benchmark' }).LORA_THREADS === '4' && b2.buildEnv({ threads: 2 }).LORA_THREADS === '2');
  check('基準用核心 ≤ N−1 即使設全部核心', mkBackend({ inject: { config: { cpuCores: 12 } } }).b.buildEnv({ purpose: 'benchmark' }).LORA_THREADS === '11' && mkBackend({ inject: { config: { cpuCores: 12 } } }).b.buildEnv({}).LORA_THREADS === '12');

  // ---- 跑完 ----
  const ev = []; const run = await b.startRun({ trainFile: 't', outputDir: '/o', maxSteps: 12 }, { onEvent: (e) => ev.push(e) }), res = await run.done;
  check('子行程以 windowsHide:true 啟動且不接 stdin', spawn.calls[0].opts.windowsHide === true && spawn.calls[0].opts.stdio[0] === 'ignore', spawn.calls[0].opts);
  check('子行程環境含核心數', spawn.calls[0].opts.env.LORA_THREADS === '11');
  check('跑完：finished、收到 12 個 log 與 done', res.state === 'finished' && ev.filter((e) => e.type === 'log').length === 12 && ev.some((e) => e.type === 'done'), res);
  // 真實紀錄：日誌逐行寫進 <outputDir>/train.log，子行程 pid 寫進 run.pid（流程總覽讀這兩個檔）
  const trainLog = fs.files.get('/o/train.log') || ''; check('train.log 逐行寫入（至少 12 行，含 loss）', trainLog.split('\n').filter(Boolean).length >= 12 && /loss/.test(trainLog), trainLog.slice(0, 200));
  check('run.pid 寫進輸出資料夾', fs.files.has('/o/run.pid'), [...fs.files.keys()]);
  check('記錄最後 loss', Math.abs(run.lastLoss - 3 / 12) < 1e-3);

  // ---- 暫停→續訓 ----
  const m = mkBackend(); const ev2 = [];
  const r1 = await m.b.startRun({ trainFile: 't', outputDir: '/o', maxSteps: 200, saveSteps: 100 }, { onEvent: (e) => ev2.push(e) });
  await new Promise((r) => setTimeout(r, 40));
  const pz = await r1.pause(); await r1.done;
  check('暫停：建立 stop_file 參數、子行程自行結束（沒被強殺）、檢查點存在', !pz.forced && pz.ok && pz.checkpoint.step > 0 && r1.state === 'paused' && !r1.child.killed, pz);
  check('暫停：收到 [paused] 事件、且 stop_file 已清掉', ev2.some((e) => e.type === 'paused' && e.step === pz.step) && !m.fs.existsSync('/o/PAUSE'));
  check('暫停：啟動參數帶 --stop_file', m.spawn.calls[0].args.includes('--stop_file'));
  const ev3 = []; const r2 = await m.b.resumeRun({ trainFile: 't', outputDir: '/o', maxSteps: pz.step + 5 }, { onEvent: (e) => ev3.push(e) }); const d2 = await r2.done;
  const ra = m.spawn.calls[1].args;
  check('續訓：帶 --resume_from_checkpoint 指向暫停時的檢查點', ra[ra.indexOf('--resume_from_checkpoint') + 1] === '/o/checkpoint-' + pz.step, ra);
  check('續訓：從暫停的步數往後跑到結束', d2.state === 'finished' && ev3.filter((e) => e.type === 'log').length === 5, d2);
  let nores = ''; try { await mkBackend().b.resumeRun({ trainFile: 't', outputDir: '/nothing' }); } catch (e) { nores = e.message; }
  check('沒有檢查點不能續訓：明說', /找不到 checkpoint-N/.test(nores), nores);
  // 暫停逾時：子行程不理 stop_file → 強制結束並說明
  const stuck = mkBackend({ spawnOpts: {} }); stuck.fs.dirs.add('/o/checkpoint-10');
  const origSpawn = stuck.b; const sp2 = (cmd, args, opts) => { const ch = new EventEmitter(); ch.stdout = new EventEmitter(); ch.stderr = new EventEmitter(); ch.kill = () => { ch.killed = true; setImmediate(() => ch.emit('exit', null, 'SIGKILL')); }; return ch; };
  const b3 = P.createCpuPyBackend({ detect: async () => ({ found: true, path: 'python' }), spawn: sp2, fs: stuck.fs, path: posix, loraDir: '/lora', hw: { cores: 4 } });
  const r3 = await b3.startRun({ trainFile: 't', outputDir: '/o' }); const pz3 = await r3.pause(60);
  check('暫停逾時：強制結束並說明檢查點可能不是最新', pz3.forced && pz3.ok && /逾時/.test(pz3.reason) && pz3.step === 10, pz3);
  const none = mkBackend(); const spN = (c, a) => { const ch = new EventEmitter(); ch.stdout = new EventEmitter(); ch.stderr = new EventEmitter(); ch.kill = () => setImmediate(() => ch.emit('exit', null, 'SIGKILL')); return ch; };
  const b4 = P.createCpuPyBackend({ detect: async () => ({ found: true }), spawn: spN, fs: none.fs, path: posix, loraDir: '/lora', hw: { cores: 4 } }); const r4 = await b4.startRun({ trainFile: 't', outputDir: '/q' }); const pz4 = await r4.pause(30);
  check('還沒有任何檢查點就暫停：明說無法續訓', !pz4.ok && /沒有找到檢查點/.test(pz4.reason), pz4);
  // 失敗
  const crash = mkBackend({ spawnOpts: { crashAt: 3 } }); const rc = await crash.b.startRun({ trainFile: 't', outputDir: '/o', maxSteps: 50 }), dc = await rc.done;
  check('子行程崩潰：failed 並帶 Python 錯誤訊息', dc.state === 'failed' && dc.exitCode === 1 && /out of memory/.test(dc.errors.join()), dc);

  // ---- 逐步介面誠實拒絕 ----
  let e1 = ''; try { await b.step({}, {}); } catch (e) { e1 = e.message; }
  check('cpu-py 的 step 明說不支援逐步、指向 startRun', /不支援逐步/.test(e1) && /startRun/.test(e1));
  let e2 = ''; try { await b.loadCheckpoint({}, {}); } catch (e) { e2 = e.message; }
  check('cpu-py 的規範化檢查點載入：明說阻礙（torch 優化器格式、缺 --init_adapter）', /optimizer|優化器/.test(e2) && /init_adapter/.test(e2), e2);

  // ---- 基準測試（假子行程）----
  const bm = mkBackend({ spawnOpts: { noSave: true } }); const rb = await bm.b.benchmark({ trainFile: 't', outputDir: '/b' });
  check('基準：跑暖機＋30 步、有 token/秒與 p50/p95、cpu-py 為參考所以一致性通過', rb.ok && rb.samples === 29 && rb.tokPerSec > 0 && rb.numericCheck.pass && rb.numericCheck.reference && rb.stepMsP95 >= rb.stepMsP50, rb);
  check('基準命令：max_steps＝33、不存檢查點、用 N−1 核心', bm.spawn.calls[0].args[bm.spawn.calls[0].args.indexOf('--max_steps') + 1] === '33' && bm.spawn.calls[0].opts.env.LORA_THREADS === '11' && bm.spawn.calls[0].opts.windowsHide === true, bm.spawn.calls[0]);
  check('基準結果記錄執行緒數', rb.threads === 11);
  const nanr = await mkBackend({ spawnOpts: { nan: true } }).b.benchmark({ trainFile: 't', outputDir: '/b' });
  check('基準：loss 出現 NaN 不通過', nanr.ok && !nanr.numericCheck.pass && nanr.numericCheck.failed.includes('全程無NaN或Inf'), nanr);
  // 中斷：3 秒內停（真時鐘；假子行程每 2ms 一步，改成很慢的子行程）
  const slowFs = memfs(); slowFs.writeFileSync('/lora/train_lora.py', 'x');
  const slowSpawn = () => { const ch = new EventEmitter(); ch.stdout = new EventEmitter(); ch.stderr = new EventEmitter(); ch.kill = () => { ch.killed = true; setImmediate(() => ch.emit('exit', null, 'SIGKILL')); }; return ch; };
  const bs = P.createCpuPyBackend({ detect: async () => ({ found: true, path: 'python' }), spawn: slowSpawn, fs: slowFs, path: posix, loraDir: '/lora', hw: { cores: 4 } });
  const ac = new AbortController(); setTimeout(() => ac.abort(), 60); const t0 = Date.now(), ar = await bs.benchmark({ trainFile: 't', outputDir: '/b' }, { signal: ac.signal });
  check('基準中斷：子行程被結束、3 秒內停止', ar.aborted && ar.stoppedAfterMs < 3000 && Date.now() - t0 < 3000, ar);
  const sl = await bs.benchmark({ trainFile: 't', outputDir: '/b' }, { deadlineMs: 80 });
  check('基準超時：標太慢並結束子行程', sl.tooSlow && /太慢/.test(sl.reason), sl);

  // ---- safetensors → 規範化檢查點 ----
  function st(tensors) { const head = {}; let off = 0; const parts = []; Object.keys(tensors).forEach((n) => { const d = tensors[n], buf = Buffer.alloc(d.length * 4); d.forEach((x, i) => buf.writeFloatLE(x, i * 4)); head[n] = { dtype: 'F32', shape: [d.length], data_offsets: [off, off + buf.length] }; off += buf.length; parts.push(buf); }); const h = Buffer.from(JSON.stringify(head)); const l = Buffer.alloc(8); l.writeBigUInt64LE(BigInt(h.length)); return Buffer.concat([l, h].concat(parts)); }
  const sfs = memfs(); sfs.writeFileSync('/lora/train_lora.py', 'x'); sfs.dirs.add('/o/checkpoint-20');
  sfs.writeFileSync('/o/checkpoint-20/adapter_model.safetensors', st({ 'base_model.model.layers.1.q_proj.lora_B.weight': [0.5, 0.25], 'base_model.model.layers.0.q_proj.lora_A.weight': [1, 2, 3], 'base_model.model.layers.0.q_proj.lora_B.weight': [0, 0] }));
  sfs.writeFileSync('/o/checkpoint-20/trainer_state.json', JSON.stringify({ epoch: 0.5, log_history: [{ loss: 2 }, { loss: 1.5 }, { eval_loss: 1 }] }));
  const bst = P.createCpuPyBackend({ detect: async () => ({ found: true }), spawn() {}, fs: sfs, path: posix, loraDir: '/lora', hw: { cpuModel: 'X', cores: 4 } });
  const cp = await bst.saveCheckpoint({ outputDir: '/o', cfg: { seed: 1, lr: 1e-4 }, dataSha256: 'd', compat: { rank: 16 } });
  const A = C.decodeTensors(cp.files['lora_A.f32']), Bt = C.decodeTensors(cp.files['lora_B.f32']);
  check('規範化：lora_A／lora_B 分檔、依層名排序、float32', A.length === 1 && Bt.length === 2 && Bt[0].name < Bt[1].name && Array.from(A[0].data).join() === '1,2,3', { A, Bt });
  check('規範化檢查點：step 取自 checkpoint-N、loss_tail 取自 trainer_state、格式合法、sha256 一致', cp.ckpt.step === 20 && cp.ckpt.loss_tail.join() === '2,1.5' && C.validateCkptJson(cp.ckpt).ok && C.verifyChecksums(cp).ok, cp.ckpt);
  check('誠實標明缺少優化器張量與原生檢查點位置', cp.ckpt.missing_files.join() === 'opt_m.f32,opt_v.f32' && cp.ckpt.produced_by.native_dir === '/o/checkpoint-20' && /重置/.test(cp.ckpt.notes[0]), cp.ckpt);
  check('safetensors 支援 BF16／F16', (() => { const hb = Buffer.from(JSON.stringify({ x: { dtype: 'BF16', shape: [1], data_offsets: [0, 2] }, y: { dtype: 'F16', shape: [1], data_offsets: [2, 4] } })); const l = Buffer.alloc(8); l.writeBigUInt64LE(BigInt(hb.length)); const d = Buffer.alloc(4); d.writeUInt16LE(0x3fc0, 0); d.writeUInt16LE(0x3c00, 2); const r = P.readSafetensors(Buffer.concat([l, hb, d])); return r[0].data[0] === 1.5 && r[1].data[0] === 1; })());
  
// ---- 安裝指令依平台（Ubuntu 使用者看到的不能是 Windows 的 py -3.13／Scripts\\python.exe）----
{
    const BSL = String.fromCharCode(92);
    const lin = P.installHint('/home/u/.config/app/studio-host/lora-train', 'linux'), linAuto = P.installHint('/home/u/lora-train');
    check('installHint：Linux 用 uv＋bin/python，不出現 Windows 的指令', /uv venv --python 3\.13/.test(lin) && /\.venv\/bin\/python/.test(lin) && !/Scripts/.test(lin) && !/py -3\.13/.test(lin), lin);
    check('installHint：Linux 有 Ubuntu 備案（deadsnakes）', /deadsnakes/.test(lin) && /python3\.13-venv/.test(lin));
    check('installHint：沒給平台時依路徑判斷（/home/… ＝ Linux）', /uv venv/.test(linAuto));
    check('installHint：Windows 照舊', /py -3\.13 -m venv/.test(P.installHint('D:' + BSL + 'x' + BSL + 'lora-train', 'win32')) && /Scripts\/python\.exe/.test(P.installHint('D:/x/lora-train')), P.installHint('D:/x/lora-train'));
}


// ---- 安裝指令可以整行貼進終端機：指令行只能有 ASCII（不能有全形分號「；」等），中文說明另起一行（2026-11-12 使用者連續兩次貼到全形分號）----
{
    const cmdLines = (t) => String(t).split('\n').filter((x) => /(?:\bpip\b|\buv\b|\bcurl\b|\bsudo\b|\bvenv\b)/.test(x) && /^[A-Za-z]/.test(x.trim()));
    for (const [nm, h] of [['Linux', P.installHint('/home/u/lora-train', 'linux')], ['Windows', P.installHint('D:/x/lora-train', 'win32')]]) {
        const cl = cmdLines(h);
        check('installHint(' + nm + ')：有指令行', cl.length >= 1, h);
        check('installHint(' + nm + ')：指令行只含 ASCII（沒有全形標點）', cl.every((x) => /^[\x20-\x7E]+$/.test(x)), cl.filter((x) => !/^[\x20-\x7E]+$/.test(x)));
        check('installHint(' + nm + ')：指令之間用 && 串接、沒有全形分號', cl.every((x) => !/；|，|：/.test(x)) && cl.every((x) => x.indexOf(' && ') > 0), cl);
    }
    check('installHint：整段提示裡指令行不跟中文同一行', P.installHint('/home/u/lora-train', 'linux').split('\n').every((x) => !(/[\u4e00-\u9fff]/.test(x) && /\b(?:pip|uv venv|curl|sudo)\b/.test(x))));
}


// ---- 探測快取鍵要跟著 Linux 的 lib/python3.x/site-packages 變（裝了套件後要重新探測；2026-11-12 使用者裝好還是顯示舊結果）----
{
    const posixP = require('path').posix; let sp = { v: 100 }; const venvPy = '/h/.config/app/studio-host/lora-train/.venv/bin/python';
    const fsx = { existsSync: (f) => f === venvPy, statSync: (f) => { if (f === venvPy) return { mtimeMs: 5 }; if (f === '/h/.config/app/studio-host/lora-train/.venv/lib/python3.13/site-packages') return { mtimeMs: sp.v }; throw new Error('ENOENT'); }, readdirSync: (d) => (d === '/h/.config/app/studio-host/lora-train/.venv/lib' ? ['python3.13'] : (() => { throw new Error('ENOENT'); })()) };
    let calls = 0; const pkgs = { cur: { torch: null, transformers: null, peft: null } };
    const spawn = async (cmd) => { if (cmd !== venvPy) return { error: { code: 'ENOENT' }, status: null }; calls++; return { status: 0, stdout: JSON.stringify({ version: '3.13.1', packages: pkgs.cur }) + '\n' }; };
    const cache = new Map(); const det = P.defaultDetect(spawn, { fs: fsx, path: posixP, platform: 'linux', cache, venvDirs: ['/h/.config/app/studio-host/lora-train'] });
    {
      const a = await det(); const a2 = await det();
      check('探測：套件不齊時每次都重新探測（不被舊結果卡住）', calls === 2 && a.path === venvPy && a2.path === venvPy, calls);
      check('探測：套件不齊的結果不寫進快取', cache.size === 0, cache.size);
      pkgs.cur = { torch: '2.15', transformers: '5.22', peft: '0.21' }; sp.v = 200;   // 使用者裝了套件：site-packages 修改時間變了
      const b = await det();
      check('探測：裝了套件後（Linux site-packages 變動）重新探測，認得齊全的環境', calls === 3 && b.found && b.packages && b.packages.peft === '0.21', [calls, b]);
      const b2 = await det(); check('探測：套件齊全的結果才用快取', calls === 3 && b2.found, calls);
    }
}

console.log(ok + ' passed, ' + bad.length + ' failed', bad);
  process.exit(bad.length ? 1 : 0);
})();
