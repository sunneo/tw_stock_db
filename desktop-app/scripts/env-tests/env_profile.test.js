// node scripts/env-tests/env_profile.test.js -- 環境基準線：檔位判斷、政策、OOM 辨識、資源治理（載入讓位、跑完卸載、閒置卸載、壓力、降級）
const E = require('../../renderer/src/env/env_profile.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const MB = 1048576, GB = 1024 * MB;
const tier = (raw, ov, dg) => E.tierOf(E.detect(raw), ov || 'auto', dg || 0);
check('手機一律低檔', tier({ mobile: true, deviceMemory: 8, cores: 8 }) === 'low');
check('省流量模式低檔', tier({ saveData: true, deviceMemory: 8, cores: 8 }) === 'low');
check('瀏覽器回報 4GB 以下低檔', tier({ deviceMemory: 4, cores: 8 }) === 'low' && tier({ deviceMemory: 2 }) === 'low');
check('heap 上限小（手機瀏覽器）低檔', tier({ deviceMemory: 8, heapLimit: 700 * MB, cores: 8 }) === 'low');
check('桌面 8GB+8 核＝高檔；8GB+4 核＝中檔', tier({ deviceMemory: 8, cores: 8, heapLimit: 4 * GB }) === 'high' && tier({ deviceMemory: 8, cores: 4 }) === 'mid');
check('桌面版主行程給的真實記憶體最準', tier({ totalMem: 4 * GB, deviceMemory: 8, cores: 8 }) === 'low' && tier({ totalMem: 8 * GB, cores: 8 }) === 'mid' && tier({ totalMem: 32 * GB, cores: 8 }) === 'high');
check('沒有任何資訊：保守當中檔', tier({}) === 'mid' || tier({ cores: 4 }) === 'mid');
check('使用者指定檔位優先於偵測', tier({ mobile: true }, 'high') === 'high' && tier({ deviceMemory: 16, cores: 16 }, 'low') === 'low');
check('電量很低又沒插電：自動檔降一級；指定檔位不降', tier({ deviceMemory: 8, cores: 8, batteryLow: true }) === 'mid' && tier({ deviceMemory: 8, cores: 8, batteryLow: true }, 'high') === 'high');
check('工作階段降級：一次降一級、最低 low', tier({ deviceMemory: 8, cores: 8 }, 'auto', 1) === 'mid' && tier({ deviceMemory: 8, cores: 8 }, 'auto', 2) === 'low' && tier({ mobile: true }, 'auto', 2) === 'low');
const lo = E.policyOf('low'), mid = E.policyOf('mid'), hi = E.policyOf('high');
check('低檔：跑完就卸載、預算小、只開一個任務、偏好小模型', lo.unloadAfterTask && lo.budgetMB < mid.budgetMB && lo.parallelTasks === 1 && lo.preferSmall && lo.maxImagePx <= 1024);
check('高檔比中檔寬鬆', hi.budgetMB > mid.budgetMB && hi.maxWorkers > mid.maxWorkers && hi.idleMs > mid.idleMs && !hi.unloadAfterTask);
check('個別覆寫', E.policyOf('low', { budgetMB: 999, idleMs: Infinity }).budgetMB === 999);
check('OOM 辨識（各種說法與數字錯誤碼）', [new Error('Out of memory'), new Error('Array buffer allocation failed'), new RangeError('Invalid typed array length: 99999999999'), new Error('WebGPU device was lost'), '記憶體不足', 1234567890].every(E.isOom) && !E.isOom(new Error('network error')) && !E.isOom(42));

// ── Governor（假計時器）
let clock = 0, timers = []; const fake = { now: () => clock, setTimeout: (fn, ms) => { const t = { fn, at: clock + ms, id: timers.length + 1 }; timers.push(t); return t.id; }, clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); } };
const advance = async (ms) => { clock += ms; const due = timers.filter((t) => t.at <= clock); timers = timers.filter((t) => t.at > clock); for (const t of due) await t.fn(); };
const mk = (policy) => { const unloaded = []; const g = new E.Governor(Object.assign({ policy: () => policy }, fake)); const add = (id, mb) => g.register(id, { unload: async () => { unloaded.push(id); }, bytes: () => mb * MB, label: id }); return { g, unloaded, add }; };
(async () => {
    // 低檔：跑完（grace 後）卸載
    let { g, unloaded, add } = mk(E.policyOf('low')); add('vlm', 400); add('whisper', 300);
    let a = await g.acquire('vlm', 400 * MB); check('acquire：放得下', a.fits && g.state().residentMB === 400);
    g.release('vlm'); check('低檔：任務完成後不是馬上卸載（grace 內再用不用重載）', g.res.get('vlm').resident && unloaded.length === 0);
    await advance(3000); a = await g.acquire('vlm', 400 * MB); await advance(2000); check('grace 內又用到：計時取消，沒被卸載', unloaded.length === 0 && g.res.get('vlm').busy === 1);
    g.release('vlm'); await advance(4001); check('低檔：用完 grace 之後卸載', unloaded.join() === 'vlm' && !g.res.get('vlm').resident);
    // 讓位：預算 600，載入 whisper(300) 時 vlm(400) 常駐 → 先卸 vlm
    await g.acquire('vlm', 400 * MB); g.release('vlm', { immediate: false }); const r2 = await g.acquire('whisper', 300 * MB); check('載入新的之前，把閒置的最久沒用的卸載來讓位', unloaded.filter((x) => x === 'vlm').length === 2 && r2.fits, [unloaded, r2]);
    // busy 的不能被卸
    ({ g, unloaded, add } = mk(E.policyOf('low'))); add('a', 400); add('b', 400); await g.acquire('a', 400 * MB); let got = null; const pb = g.acquire('b', 400 * MB).then((r) => { got = r; }); await new Promise((r) => setTimeout(r, 30));
    check('放不下、別人正在用：排隊等（不超額同時載入、也不卸載正在用的）', got === null && unloaded.length === 0 && g.state().residentMB === 400);
    g.release('a'); await pb; check('正在用的用完（graceMs 前就讓位）後輪到它', got && got.fits === true && g.res.get('b').busy === 1 && unloaded.join() === 'a', [got, unloaded]);
    ({ g, unloaded, add } = mk(E.policyOf('low'))); add('big', 900); const rbig = await g.acquire('big', 900 * MB); check('單一個就超過預算、沒有別人在用：不硬擋，回報 fits:false 給呼叫端改用小模型／分塊', rbig.fits === false);
    { const ug = []; g = new E.Governor({ policy: () => E.policyOf('low') }); g.register('p', { unload: async () => ug.push('p'), bytes: () => 400 * MB, label: 'p' }); g.register('q', { unload: async () => ug.push('q'), bytes: () => 400 * MB, label: 'q' }); }   // 這一題用真的計時器（等待逾時要真的過時間）
    await g.acquire('p', 400 * MB); let werr = null; await g.acquire('q', 400 * MB, { maxWaitMs: 50, pollMs: 80 }).catch((e) => { werr = e.message; });
    check('等太久就丟錯（說明在等誰），不去硬載造成被殺', /等太久|不載入/.test(werr || '') && /p/.test(werr || ''), werr);
    ({ g, unloaded, add } = mk(E.policyOf('low'))); add('a', 400); add('b', 400); await g.acquire('a', 400 * MB);
    // 中檔：閒置 idleMs 後卸載
    ({ g, unloaded, add } = mk(E.policyOf('mid'))); add('m', 500); await g.acquire('m'); g.release('m'); await advance(119000); check('中檔：閒置 2 分鐘內不卸', unloaded.length === 0); await advance(2000); check('中檔：閒置超過 2 分鐘卸載', unloaded.join() === 'm');
    // 高檔 idleMs 可設成 Infinity（不卸）
    ({ g, unloaded, add } = mk(E.policyOf('high', { idleMs: Infinity }))); add('h', 500); await g.acquire('h'); g.release('h'); await advance(99999999); check('idleMs＝Infinity：不卸載', unloaded.length === 0 && g.res.get('h').resident);
    // release immediate
    ({ g, unloaded, add } = mk(E.policyOf('high'))); add('i', 100); await g.acquire('i'); g.release('i', { immediate: true }); await advance(1); check('release immediate：馬上卸載', unloaded.join() === 'i');
    // 壓力
    ({ g, unloaded, add } = mk(E.policyOf('mid', { budgetMB: 1000 }))); add('x', 400); add('y', 400); add('z', 100); await g.acquire('x'); g.release('x'); await advance(10); await g.acquire('y'); g.release('y'); await g.acquire('z'); g.release('z');
    const n1 = await g.pressure('high'); check('壓力 high：卸載閒置的最久沒用的，直到低於預算 70%', n1 >= 1 && unloaded[0] === 'x' && g.residentBytes() <= 1000 * MB * 0.7, [n1, unloaded]);
    const n2 = await g.pressure('critical'); check('壓力 critical：閒置的全卸並降一級', g.residentBytes() === 0 && g.degradeLevel === 1 && n2 >= 0);
    g.degrade('again'); const again = g.degrade('third'); check('降級最多兩級', g.degradeLevel === 2 && again === false); g.recover(); check('recover 回到 0', g.degradeLevel === 0);
    // 卸載出錯不影響其他
    ({ g, unloaded, add } = mk(E.policyOf('low'))); g.register('boom', { unload: async () => { throw new Error('壞了'); }, bytes: () => 100 * MB }); add('ok', 100); await g.acquire('boom'); await g.acquire('ok'); g.release('boom'); g.release('ok'); const cnt = await g.unloadAll(); check('卸載出錯：記錄並繼續卸載其他', cnt === 2 && unloaded.join() === 'ok' && !g.res.get('boom').resident, [cnt, unloaded]);
    // 沒登記的資源
    let thrown = null; try { await g.acquire('nope'); } catch (e) { thrown = e.message; } check('沒登記的資源 acquire 會報錯', /沒有登記/.test(thrown || ''));
    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'env_profile: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
