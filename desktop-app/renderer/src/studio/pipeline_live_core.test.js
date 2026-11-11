// node renderer/src/studio/pipeline_live_core.test.js
const L = require('./pipeline_live_core.js'), P = require('./pipeline_core.js'), BP = require('./backend_cpu_py.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };

// 用真實格式的日誌行（train_lora.py 的 print 與 HF Trainer 的 tqdm／log 字典）解析，不手寫事件
const lines = [
    "{'loss': '2.1034', 'grad_norm': '0.81', 'learning_rate': '0.0002', 'epoch': '0.1'}",
    '  10/100 [00:08<01:12,  0.80s/it]',
    "{'loss': '1.5012', 'grad_norm': '0.52', 'learning_rate': '0.0002', 'epoch': '0.5'}",
    ' 40/100 [00:32<00:48,  0.82s/it]'
];
const ev = lines.map(BP.parseProgressLine).filter(Boolean);
check('真實行解析出 log 與 progress', ev.length === 4 && ev[0].type === 'log' && ev[1].type === 'progress' && ev[1].step === 10 && ev[1].total === 100, ev);

// ---- 進行中的即時狀態 ----
const mem = [{ t: 1, rssBytes: 1.2e9 }, { t: 2, rssBytes: 1.6e9 }, { t: 3, rssBytes: 1.4e9 }];
const live = L.liveProgress(ev, { running: true, nowMs: 60000, startedMs: 0, memSamples: mem });
check('進行中：狀態、步數、百分比', live.logState === '進行中' && live.step === 40 && live.total === 100 && live.pct === 40, live);
check('每步秒數取日誌的 s/it（0.82），預估剩餘 = 60 步 × 0.82 秒', live.secPerStep === 0.82 && live.secSource === '日誌 tqdm 的 s/it' && live.etaSec === 49, live);
check('loss 取最後一次，並保留第一次供比較', live.loss === 1.5012 && live.lossFirst === 2.1034 && live.lossSamples === 2, live);
check('記憶體：最後值與峰值來自真實取樣', live.memory.lastBytes === 1.4e9 && live.memory.peakBytes === 1.6e9 && live.memory.samples === 3, live.memory);
check('經過時間由呼叫端時間算出', live.elapsedSec === 60);

// 日誌沒有 s/it 時，用起始時間推算（需要呼叫端給時間）
const noRate = L.liveProgress([{ type: 'progress', step: 20, total: 100, secPerIt: null }], { running: true, nowMs: 30000, startedMs: 0 });
check('沒有 s/it 時用起始時間推算每步秒數', noRate.secSource === '起始時間推算' && noRate.secPerStep === 1.5 && noRate.etaSec === 120, noRate);
const noTime = L.liveProgress([{ type: 'progress', step: 20, total: 100, secPerIt: null }], { running: true });
check('沒有時間也沒有 s/it：預估為空、不瞎猜', noTime.secPerStep === null && noTime.etaSec === null);

// 沒有記憶體取樣要明說
const noMem = L.liveProgress(ev, { running: true });
check('沒有記憶體取樣：memory 為空並寫原因', noMem.memory === null && /沒有記憶體取樣/.test(noMem.memoryReason));

// ---- 終止事件 ----
const doneEv = ev.concat([BP.parseProgressLine('[done] adapter saved to /out/adapter_demo')]);
const dl = L.liveProgress(doneEv, { running: false });
check('日誌有 [done]：日誌狀態完成，附目錄', dl.logState === '完成' && dl.doneDir === '/out/adapter_demo', dl);
const pl = L.liveProgress(ev.concat([BP.parseProgressLine('[paused] step=40')]), {});
check('[paused]：暫停並記錄最後步數', pl.logState === '暫停' && pl.step === 40, pl);
const errEv = ev.concat([{ type: 'error', text: 'RuntimeError: out of memory' }]);
const el = L.liveProgress(errEv, {});
check('錯誤：失敗並附錯誤文字', el.logState === '失敗' && el.errorText === 'RuntimeError: out of memory', el);
const idle = L.liveProgress([], { running: false });
check('沒有任何事件也沒有在跑：待做', idle.logState === '待做' && idle.step === null && idle.pct === null);
check('沒有事件但在跑：進行中（開始前的空檔）', L.liveProgress([], { running: true }).logState === '進行中');

// ---- 轉成 facts，交給流程核心：只有產物與 done 標記才算完成 ----
const fRun = L.progressToFacts(live);
check('進行中 → running', fRun.running === true && fRun.logDone === false && fRun.progress === live);
const stRun = P.deriveStageStates('lora', { stages: { ingest: { products: [{ count: 10, files: 1, sha256: 'a' }], done: true }, generate: { products: [{ count: 10, files: 1, sha256: 'a' }], done: true }, split: { products: [{ count: 10, files: 1, sha256: 'a' }], done: true }, train: fRun } });
check('訓練中：階段是進行中，附進度', stRun.stages[3].state === '進行中' && stRun.stages[3].progress.step === 40, stRun.stages[3]);
const fDone = L.progressToFacts(dl);
const pre = { products: [{ count: 1, files: 1, sha256: 'a' }], done: true }; const stLogOnly = P.deriveStageStates('lora', { stages: { ingest: pre, generate: pre, split: pre, train: fDone } });
check('日誌寫 [done] 但沒有產物與 done 標記：不算完成（失敗＋原因）', stLogOnly.stages[3].state === '失敗' && /不算完成/.test(stLogOnly.stages[3].reason), stLogOnly.stages[3]);
const stDoneProd = P.deriveStageStates('lora', { stages: { train: Object.assign({}, fDone, { products: [{ count: 10, files: 1, sha256: 'a' }], done: true }), ingest: { products: [{ count: 1, files: 1, sha256: 'a' }], done: true }, generate: { products: [{ count: 1, files: 1, sha256: 'a' }], done: true }, split: { products: [{ count: 1, files: 1, sha256: 'a' }], done: true } } });
check('日誌完成＋產物＋done 標記 → 完成', stDoneProd.stages[3].state === '完成');
const fErr = L.progressToFacts(el);
const stErr = P.deriveStageStates('lora', { stages: { train: fErr } });
check('錯誤 → 失敗並帶錯誤原因', stErr.stages[3].state === '失敗' && /out of memory/.test(stErr.stages[3].reason), stErr.stages[3]);
const fPaused = L.progressToFacts(pl);
const stPaused = P.deriveStageStates('lora', { stages: { train: fPaused } });
check('暫停 → 進行中（標暫停，不算完成）', stPaused.stages[3].state === '進行中' && /暫停/.test(stPaused.stages[3].reason));

console.log(ok + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
