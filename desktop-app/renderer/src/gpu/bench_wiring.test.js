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
const NAMES = ['_gpuBenchLoad', '_gpuBenchSave', '_gpuBenchClear', '_gpuBenchRefresh', '_gpuBenchPick', '_gpuBenchPin', '_gpuBenchCancelRun', '_gpuBenchRestore', '_gpuBenchRun', '_gpuBenchEnvKey'];
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

    console.log('bench_wiring.test.js: ' + ok + ' passed, ' + bad + ' failed');
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
