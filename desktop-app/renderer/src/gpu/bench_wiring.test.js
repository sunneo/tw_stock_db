// node renderer/src/gpu/bench_wiring.test.js
// 基準接進助理的接線（從 floating-assistant.js 抽出真正的方法，用假的 this 執行）：
// 存取（沒有 TTL）、釘選優先、gpuAccel 主開關、量測（假 mm、假 ORT、假計時）、取消不存結果、恢復預設、ORT 失敗逐一記錄。
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const BC = require('./bench_core.js'); const BR = require('./bench_run.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };

function methodSource(name) {
    const re = new RegExp('\\n    (async )?' + name + '\\(');
    const m = re.exec(SRC); if (!m) throw new Error('找不到方法 ' + name);
    const nxt = /\n    (async )?[_a-zA-Z][_a-zA-Z0-9]*\(/g; nxt.lastIndex = m.index + m[0].length; const n = nxt.exec(SRC);
    const chunk = SRC.slice(m.index + 1, n ? n.index : SRC.length); const close = chunk.lastIndexOf('}');
    return chunk.slice(0, close + 1);
}
const NAMES = ['_gpuBenchLoad', '_gpuBenchSave', '_gpuBenchClear', '_gpuBenchRefresh', '_gpuBenchPick', '_gpuBenchPin', '_gpuBenchCancelRun', '_gpuBenchRestore', '_gpuBenchRun', '_gpuBenchEnvKey', '_gpuRouteOps', '_gpuRoutePick', '_gpuOrtRun', '_gpuRouteRecord', '_gpuBrokenGet', '_gpuBrokenSet'];
// 假的 localStorage（同一份記憶體，模擬跨呼叫的保存）
const store = new Map();
const fakeLS = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
// 假計時：每個假的矩陣乘（或假 ORT 的執行）前進 2 ms，所以每個樣本都是 2 ms、變異係數 0（有效）
let clockT = 0;
const ctx = { console, Promise, JSON, Date, Math, Number, Array, Object, Set, String, Error, localStorage: fakeLS, navigator: { userAgent: 'FakeBrowser/1' }, setTimeout, performance: { now: () => clockT } };
vm.createContext(ctx);
const M = vm.runInContext('({' + NAMES.map(methodSource).join(',\n') + '})', ctx);

// 假的「模組」：benchCore 用真的純規則；bench 用真的執行器；mm 是假的矩陣乘（回傳參考值）
function qwenModule(mm) { return { benchCore: BC, bench: BR, mm }; }
function assistant(extra) {
    const self = Object.assign({ advancedSettings: { gpuAccel: 'on', gpuBenchPins: {} }, _gpuBenchMem: null, _gpuBenchBusy: false, _gpuBenchCancelFlag: false,
        _saveAdvancedSettings: () => {}, _gpuMemBudget: () => ({ bytes: 1048576 * 1800 }), _envTier: () => 'mid', _qwenModule: () => qwenModule(extra && extra.mm) }, M);
    return self;
}
const fakeMm = { matmul: async (a, ad, b, bd) => { clockT += 2; return { y: BR.matmulRef(a, ad, b, bd) }; } };

(async () => {
    // 1. 存取：存起來的結果一直有效（沒有 TTL）；換環境 key 就讀不到；清掉就沒有
    {
        const s = assistant();
        const env = await s._gpuBenchEnvKey();
        check('1 環境 key 含瀏覽器', env.includes('FakeBrowser/1') && env.includes('mid'), env);
        s._gpuBenchSave(env, { at: 1, results: [{ op: 'matmul', shape: '1x1024x1024', id: 'cudaweb', valid: true, errors: 0, stats: { n: 20, median: 1, cv: 0.01 } }] });
        const back = s._gpuBenchLoad(env);
        check('1 讀得回來（很久以前存的也有效：沒有 TTL）', back && back.results.length === 1 && back.at === 1, back);
        check('1 不同環境讀不到（換介面卡或瀏覽器）', s._gpuBenchLoad(env + 'x') === null);
        s._gpuBenchClear(env);
        check('1 清掉後讀不到', s._gpuBenchLoad(env) === null);
    }
    // 2. 路由：沒量過 → 預設；有有效量測 → 量測選擇；釘選優先；gpuAccel 關閉 → 一律預設
    {
        const s = assistant();
        const env = await s._gpuBenchEnvKey();
        const row = (id, median) => ({ op: 'matmul', shape: '128x512x512', id, valid: true, errors: 0, stats: { n: 20, median, cv: 0.01, p10: median, p90: median, mean: median } });
        s._gpuBenchMem = { env, rec: null };
        check('2 沒量過：預設 cudaweb', s._gpuBenchPick('matmul', '128x512x512').backend === 'cudaweb' && s._gpuBenchPick('matmul', '128x512x512').source === 'default');
        s._gpuBenchMem = { env, rec: { at: 1, results: [row('cudaweb', 10), row('ort-wasm', 5)] } };
        check('2 有有效量測：選 ort-wasm', s._gpuBenchPick('matmul', '128x512x512').backend === 'ort-wasm');
        s._gpuBenchPin('128x512x512', 'cudaweb');
        check('2 釘選優先於量測', s.advancedSettings.gpuBenchPins['matmul|128x512x512'] === 'cudaweb' && s._gpuBenchPick('matmul', '128x512x512').source === 'pinned');
        s._gpuBenchPin('128x512x512', null);
        check('2 取消釘選回到量測', !s.advancedSettings.gpuBenchPins['matmul|128x512x512'] && s._gpuBenchPick('matmul', '128x512x512').backend === 'ort-wasm');
        s.advancedSettings.gpuAccel = 'off';
        check('2 gpuAccel 關閉：一律預設', s._gpuBenchPick('matmul', '128x512x512').backend === 'cudaweb' && s._gpuBenchPick('matmul', '128x512x512').source === 'default');
        s.advancedSettings.gpuAccel = 'on';
        s._gpuBenchPin('128x512x512', 'not-a-backend');
        check('2 不認得的後端不釘', !s.advancedSettings.gpuBenchPins['matmul|128x512x512']);
    }
    // 3. 量測：假 mm、假 ORT（webgpu 與 wasm 各一個）、假計時；存下 2 個形狀 × 3 個後端；每個 ORT 都有 ORT 會話（不靜默）
    {
        const ortMod = (name) => ({ env: { wasm: {} }, Tensor: function (t, d, dims) { this.data = d; this.dims = dims; }, InferenceSession: { create: async (bytes, o) => ({ run: async (f) => { clockT += 2; return { Y: { getData: async () => BR.matmulRef(f.A.data, f.A.dims, f.B.data, f.B.dims) } }; }, ep: o.executionProviders[0], name }) } });
        const s = assistant({ mm: fakeMm });
        s._gpuBenchOrt = async (kind) => ortMod(kind);
        const stored = [];
        s._gpuBenchSave = (env, rec) => stored.push({ env, rec });
        const progress = [];
        const r = await s._gpuBenchRun((x) => progress.push(x));
        check('3 量測完成', r.ok === true, r);
        check('3 存了一次', stored.length === 1, stored.length);
        const res = stored[0].rec.results;
        check('3 2 個形狀 × 3 個後端＝6 列', res.length === 6, res.length);
        check('3 形狀與後端都對', ['1x1024x1024', '128x512x512'].every((sh) => ['cudaweb', 'ort-webgpu', 'ort-wasm'].every((id) => res.some((x) => x.shape === sh && x.id === id))));
        check('3 每列有 20 個樣本（暖機不計）', res.every((x) => x.stats.n === 20), res.map((x) => x.stats.n));
        check('3 進度有回報', progress.some((x) => x.includes('1x1024x1024')) && progress.some((x) => x.includes('128x512x512')), progress);
        check('3 正確性：全部有效（假後端輸出與參考一致）', res.every((x) => x.errors === 0), res.filter((x) => x.errors));
        check('3 沒有載入失敗的註記', (stored[0].rec.notes || []).length === 0, stored[0].rec.notes);
    }
    // 4. ORT 載入失敗：那個後端不參加，並且在註記中寫出原因（不靜默）；另外兩個照常量測
    {
        const s = assistant({ mm: fakeMm });
        s._gpuBenchOrt = async (kind) => { if (kind === 'webgpu') throw new Error('WebGPU 不可用'); return { env: { wasm: {} }, Tensor: function (t, d, dims) { this.data = d; this.dims = dims; }, InferenceSession: { create: async () => ({ run: async (f) => { clockT += 2; return { Y: { getData: async () => BR.matmulRef(f.A.data, f.A.dims, f.B.data, f.B.dims) } }; } }) } }; };
        const stored = []; s._gpuBenchSave = (env, rec) => stored.push(rec);
        await s._gpuBenchRun(() => {});
        const rec = stored[0];
        check('4 有註記寫出 webgpu 載入失敗', rec.notes.length === 1 && rec.notes[0].includes('ORT（webgpu）載入失敗') && rec.notes[0].includes('WebGPU 不可用'), rec.notes);
        check('4 webgpu 那列錯誤（不是靜默）', rec.results.filter((x) => x.id === 'ort-webgpu').every((x) => x.valid === false && x.errors > 0));
        check('4 cudaweb 與 wasm 照常有效', rec.results.filter((x) => x.id !== 'ort-webgpu').every((x) => x.valid === true));
    }
    // 5. 取消：在樣本之間停下，不存任何結果；狀態回到可以再跑
    {
        let calls = 0; const slow = { matmul: async (a, ad, b, bd) => { calls++; if (calls === 30) s._gpuBenchCancelRun(); return { y: BR.matmulRef(a, ad, b, bd) }; } };
        const s = assistant({ mm: slow });
        s._gpuBenchOrt = async () => { throw new Error('略過 ORT'); };
        const stored = []; s._gpuBenchSave = (env, rec) => stored.push(rec);
        const r = await s._gpuBenchRun(() => {});
        check('5 取消回報 cancelled、不存', r.cancelled === true && stored.length === 0, { r, stored: stored.length });
        check('5 取消後旗標與忙碌都清掉', s._gpuBenchBusy === false && s._gpuBenchCancelFlag === false);
    }
    // 6. 恢復預設：清掉存的結果與所有釘選；量測中按恢復預設會先取消量測，不存結果
    {
        const s = assistant();
        const env = await s._gpuBenchEnvKey();
        s._gpuBenchSave(env, { at: 1, results: [] }); s._gpuBenchPin('1x1024x1024', 'ort-wasm'); s._gpuBenchPin('128x512x512', 'cudaweb');
        const r = await s._gpuBenchRestore();
        check('6 恢復預設：結果與釘選都清掉', r.ok && s._gpuBenchLoad(env) === null && Object.keys(s.advancedSettings.gpuBenchPins).length === 0, { r, pins: s.advancedSettings.gpuBenchPins });
    }
    // 7. 不能同時跑兩次量測
    {
        const s = assistant({ mm: fakeMm }); s._gpuBenchBusy = true;
        const r = await s._gpuBenchRun(() => {});
        check('7 量測中再按：拒絕', r.ok === false && r.reason.includes('量測中'), r);
    }

    // 8. 派發：真的 onnx_interp.matmulGpu（2 維、夠大）問路由器；釘選 ORT → 真的走 ORT；量測 ORT 快 15%+ → 走 ORT；不到 15% → cudaweb；ORT 丟錯 → 該次退回 cudaweb 並記錄；
    //    連續 3 次失敗 → 停用（fa_gpu_broken）；gpuAccel 關閉 → 不查路由；沒量過 → cudaweb 且不啟動基準
    const I = require('./onnx_interp.js');
    const mkT = (M, K, seed) => { const x = BR.makeMatmulInputs(M, K, 1, seed); return { t: 'f', d: [M, K], v: x.a }; };
    const runMM = async (s, M, K, N) => {
        const a = mkT(M, K, 3), b = { t: 'f', d: [K, N], v: BR.makeMatmulInputs(K, N, 5, 4).a };
        const ref = BR.matmulRef(a.v, a.d, b.v, b.d);
        const out = await I.matmulGpu(a, b, { gpu: { ops: s._gpuRouteOps(), minMacs: 1 } });
        return { out: Float32Array.from(out.v), ref };
    };
    const ortWith = (counter, fail) => ({ env: { wasm: {} }, Tensor: function (t, d, dims) { this.data = d; this.dims = dims; }, InferenceSession: { create: async () => ({ run: async (f) => { counter.n++; if (fail) throw new Error(fail); return { Y: { getData: async () => BR.matmulRef(f.A.data, f.A.dims, f.B.data, f.B.dims) } }; } }) } });
    const measured = (ortId, ortMedian) => ({ at: 1, results: [
        { op: 'matmul', shape: '8x16x8', id: 'cudaweb', valid: true, errors: 0, stats: { n: 20, median: 10, cv: 0.01, p10: 10, p90: 10, mean: 10 } },
        { op: 'matmul', shape: '8x16x8', id: ortId, valid: true, errors: 0, stats: { n: 20, median: ortMedian, cv: 0.01, p10: ortMedian, p90: ortMedian, mean: ortMedian } }] });
    const setup = (opts) => { const s = assistant({ mm: fakeMm }); const c = { n: 0 }; s._gpuBenchOrt = async () => ortWith(c, opts && opts.fail); s._gpuBenchMem = { env: 'e', rec: opts && opts.rec ? opts.rec : null }; if (opts && opts.pin) s._gpuBenchPin('8x16x8', opts.pin); return { s, c }; };
    {   // 8a 釘選 ORT（ort-wasm）→ 真的走 ORT，結果正確，紀錄 used
        const { s, c } = setup({ pin: 'ort-wasm' });
        const r = await runMM(s, 8, 16, 8);
        check('8a 釘選 ORT：真的走 ORT（會話執行一次）', c.n === 1, c.n);
        check('8a 結果與參考一致', BC.relErr(r.out, r.ref) < 1e-6, BC.relErr(r.out, r.ref));
        check('8a 紀錄為用了 ORT', s._gpuRouteLog.length === 1 && s._gpuRouteLog[0].used === true && s._gpuRouteLog[0].backend === 'ort-wasm', s._gpuRouteLog);
    }
    {   // 8b 量測：ORT 快 20%（≥15%）→ 走 ORT
        const { s, c } = setup({ rec: measured('ort-wasm', 8) });
        await runMM(s, 8, 16, 8);
        check('8b 量測 ORT 快 20%：走 ORT', c.n === 1, c.n);
    }
    {   // 8c 量測：ORT 只快 5%（<15%）→ 維持 cudaweb（不走 ORT）
        const { s, c } = setup({ rec: measured('ort-wasm', 9.5) });
        await runMM(s, 8, 16, 8);
        check('8c 量測 ORT 只快 5%：維持 cudaweb', c.n === 0 && (s._gpuRouteLog || []).length === 0, { n: c.n, log: s._gpuRouteLog });
    }
    {   // 8d ORT 丟錯：這一次退回 cudaweb（結果仍正確）、記錄原因（不靜默）
        const { s, c } = setup({ pin: 'ort-wasm', fail: 'WASM 記憶體不足' });
        const r = await runMM(s, 8, 16, 8);
        check('8d ORT 丟錯：結果退回 cudaweb 仍正確', BC.relErr(r.out, r.ref) < 1e-6, BC.relErr(r.out, r.ref));
        const e = s._gpuRouteLog.find((x) => x.error);
        check('8d 有記錄（後端、形狀、原因、退回）', !!e && e.backend === 'ort-wasm' && e.shape === '8x16x8' && e.error.includes('WASM 記憶體不足') && e.fallback === 'cudaweb', s._gpuRouteLog);
    }
    {   // 8e 連續 3 次失敗 → 停用；之後路由直接回 cudaweb，不再試 ORT
        const { s, c } = setup({ pin: 'ort-wasm', fail: 'ORT 壞了' });
        for (let i = 0; i < 3; i++) await runMM(s, 8, 16, 8);
        check('8e 連續 3 次失敗後 ORT 被停用（fa_gpu_broken）', s._gpuBrokenGet('gpuBench-ort-wasm') !== null);
        const before = c.n; const r = await runMM(s, 8, 16, 8);
        check('8e 停用後不再試 ORT（會話數不增加），仍正確', c.n === before && BC.relErr(r.out, r.ref) < 1e-6, { before, after: c.n });
        check('8e 路由說明：已停用', s._gpuRoutePick('matmul', '8x16x8').source === 'broken');
    }
    {   // 8f gpuAccel 關閉 → 不查路由（不讀儲存）、照舊 cudaweb
        const { s, c } = setup({ pin: 'ort-wasm' });
        s.advancedSettings.gpuAccel = 'off'; let picks = 0; const orig = s._gpuBenchPick; s._gpuBenchPick = (...x) => { picks++; return orig.apply(s, x); };
        const r = await runMM(s, 8, 16, 8);
        check('8f gpuAccel 關：不查路由、不走 ORT、結果正確', picks === 0 && c.n === 0 && BC.relErr(r.out, r.ref) < 1e-6, { picks, n: c.n });
    }
    {   // 8g 沒量過 → cudaweb；派發時不啟動基準（_gpuBenchRun 沒被呼叫）
        const { s, c } = setup({});
        let benchRuns = 0; s._gpuBenchRun = async () => { benchRuns++; return { ok: true }; };
        const pk = s._gpuRoutePick('matmul', '8x16x8');
        await runMM(s, 8, 16, 8);
        check('8g 沒量過：預設 cudaweb，不走 ORT', pk.backend === 'cudaweb' && pk.source === 'default' && c.n === 0, pk);
        check('8g 派發時沒有啟動基準', benchRuns === 0, benchRuns);
    }

    console.log('bench_wiring.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
