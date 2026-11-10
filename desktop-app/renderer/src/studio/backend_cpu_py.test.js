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
    writeFileSync: (p, c) => { files.set(norm(p), c); }, readFileSync: (p) => { if (!files.has(norm(p))) throw new Error('ENOENT ' + p); return files.get(norm(p)); },
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
  check('有 Python 缺套件：列出缺的套件', !noPkg.available && /torch、peft/.test(noPkg.reason) && /3\.10\.4/.test(noPkg.reason) && !/transformers/.test(noPkg.reason.split('缺少套件：')[1]), noPkg);
  const noScript = await mkP(async () => ({ found: true, version: '3.10.4', packages: { torch: '2', transformers: '4', peft: '1' } }), memfs()).probe();
  check('缺訓練腳本：回具體路徑', !noScript.available && /train_lora\.py/.test(noScript.reason), noScript);
  const good = await mkP(async () => ({ found: true, version: '3.10.4', packages: { torch: '2.3', transformers: '4', peft: '1' } })).probe();
  check('有 Python 且套件齊全：可用、指紋含 Python／torch 版本', good.available && !good.reason && good.fingerprint.python_version === '3.10.4' && good.fingerprint.torch_version === '2.3' && good.fingerprint.cores === 8, good);
  const thrown = await B.safeProbe(mkP(async () => { throw new Error('偵測爆了'); }), {});
  check('偵測函式丟例外：不可用並說找不到 Python', !thrown.available && /找不到 Python/.test(thrown.reason), thrown);
  // 預設偵測（用假 spawnSync，不碰真的行程）
  const det = P.defaultDetect((cmd, args, opts) => { det.calls.push({ cmd, opts }); return cmd === 'python3' ? { status: 0, stdout: JSON.stringify({ version: '3.11.0', packages: { torch: '2', transformers: '4', peft: '1' } }) + '\n' } : { error: new Error('ENOENT'), status: null }; }); det.calls = [];
  const dr = det();
  check('預設偵測：python 找不到就試 python3，且 windowsHide', dr.found && dr.path === 'python3' && dr.version === '3.11.0' && det.calls.every((c) => c.opts.windowsHide === true), { dr, calls: det.calls });
  check('介面型別', B.validateBackend(mkBackend().b).length === 0);

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
  console.log(ok + ' passed, ' + bad.length + ' failed', bad);
  process.exit(bad.length ? 1 : 0);
})();
