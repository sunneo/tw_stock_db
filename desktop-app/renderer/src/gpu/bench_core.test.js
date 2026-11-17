// node renderer/src/gpu/bench_core.test.js
// GPU 基準的純規則：nearest-rank 統計、有效條件（n≥20、cv<0.30、錯誤為 0）、遲滯（快 15% 才換）、釘選優先、快取 key、整體尺度誤差。
const B = require('./bench_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x === undefined ? '' : ' ' + JSON.stringify(x).slice(0, 240))); } };
const close = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);
const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// 1. 統計（nearest-rank）：1..20 的 median 是 10、p10 是 2、p90 是 18；常數的 cv 是 0；沒有樣本全是 null
{
    const s = B.stats(seq(20, (i) => i + 1));
    check('1 n', s.n === 20, s);
    check('1 median（nearest-rank）=10', s.median === 10, s.median);
    check('1 p10=2、p90=18', s.p10 === 2 && s.p90 === 18, [s.p10, s.p90]);
    check('1 常數 cv=0', B.stats([5, 5, 5, 5]).cv === 0);
    const e = B.stats([]);
    check('1 沒有樣本全是 null', e.n === 0 && e.median === null && e.cv === null);
    check('1 不認的值（負數、NaN）不算', B.stats([1, -2, NaN, 3]).n === 2);
}
// 2. 有效條件：n≥20、cv<0.30、valid 不是 false、錯誤為 0、median>0
{
    const good = { valid: true, errors: 0, stats: B.stats(seq(20, () => 10)) };
    check('2 n=20 常數：有效', B.validResult(good));
    check('2 n=19：無效', !B.validResult({ stats: B.stats(seq(19, () => 10)) }));
    check('2 cv≥0.30：無效（太吵）', !B.validResult({ stats: B.stats(seq(20, (i) => (i % 2 ? 1 : 100))) }));
    check('2 有錯誤：無效', !B.validResult(Object.assign({}, good, { errors: 1 })));
    check('2 valid:false：無效', !B.validResult(Object.assign({}, good, { valid: false })));
}
// 3. 遲滯：沒有有效結果 → 預設；第一個有效結果勝出；快不到 15% 不換；快 15% 以上才換；太吵的更快候選不把選擇交給較慢的有效候選
{
    const mk = (id, median, n, cv) => ({ id, valid: true, stats: { n: n || 20, median, cv: cv === undefined ? 0.01 : cv, p10: median, p90: median, mean: median } });
    const none = B.decide(null, [], { defaultBackend: 'cudaweb' });
    check('3 沒有有效結果：用預設', none.backend === 'cudaweb' && none.switched === false, none);
    const first = B.decide(null, [mk('cudaweb', 10), mk('ort-wasm', 6)], {});
    check('3 第一個有效結果：最快的', first.backend === 'ort-wasm' && first.switched === true, first);
    const small = B.decide('cudaweb', [mk('cudaweb', 10), mk('ort-webgpu', 9.5)], {});
    check('3 只快 5%：不換（遲滯）', small.backend === 'cudaweb' && small.switched === false, small);
    const big = B.decide('cudaweb', [mk('cudaweb', 10), mk('ort-webgpu', 8)], {});
    check('3 快 20%：換', big.backend === 'ort-webgpu' && big.switched === true, big);
    const noisy = B.decide('cudaweb', [mk('cudaweb', 10), mk('ort-webgpu', 5, 20, 0.5), mk('ort-wasm', 9)], {});
    check('3 更快但太吵：不換到較慢的有效者，維持現況並說明要重跑', noisy.backend === 'cudaweb' && noisy.switched === false && noisy.reason.includes('太吵'), noisy);
    const few = B.decide('cudaweb', [mk('cudaweb', 10), mk('ort-wasm', 5, 19)], {});
    check('3 樣本不夠（19 次）：不算有效、不換', few.backend === 'cudaweb' && few.switched === false, few);
}
// 4. 釘選優先於量測；量測只看有效結果；沒有結果就用預設（現行行為）
{
    const row = (id, median) => ({ op: 'matmul', shape: '128x512x512', id, valid: true, errors: 0, stats: { n: 20, median, cv: 0.01, p10: median, p90: median, mean: median } });
    const measured = B.pickBackend('matmul', '128x512x512', { results: [row('cudaweb', 10), row('ort-wasm', 5)], pins: {} });
    check('4 量測選擇（ort-wasm 快很多）', measured.backend === 'ort-wasm' && measured.source === 'measured', measured);
    const pinned = B.pickBackend('matmul', '128x512x512', { results: [row('cudaweb', 10), row('ort-wasm', 5)], pins: { 'matmul|128x512x512': 'cudaweb' } });
    check('4 釘選優先於量測', pinned.backend === 'cudaweb' && pinned.source === 'pinned', pinned);
    const badPin = B.pickBackend('matmul', '128x512x512', { results: [], pins: { 'matmul|128x512x512': 'not-a-backend' } });
    check('4 不認得的釘選值不採用', badPin.source === 'default', badPin);
    const none = B.pickBackend('matmul', '1x1024x1024', { results: [], pins: {} });
    check('4 沒有結果：預設 cudaweb', none.backend === 'cudaweb' && none.source === 'default', none);
    const onlyNoisy = B.pickBackend('matmul', '128x512x512', { results: [Object.assign(row('ort-wasm', 5), { stats: { n: 20, median: 5, cv: 0.9 } })], pins: {} });
    check('4 只有太吵的結果：仍是預設', onlyNoisy.source === 'default' && onlyNoisy.backend === 'cudaweb', onlyNoisy);
    check('4 其他運算沒量過：預設', B.pickBackend('softmax', '512x1024', { results: [], pins: {} }).backend === 'cudaweb');
}
// 5. 快取 key：換介面卡、換瀏覽器版本、換設定都不同；同一台機器的同一組設定相同
{
    const base = { browser: 'Chrome/130', adapter: { vendor: 'nvidia', architecture: 'ampere', description: 'RTX' }, profile: 'mid', budgetMB: 1800 };
    check('5 同一台同設定：相同 key', B.envKey(base) === B.envKey(Object.assign({}, base)));
    check('5 換介面卡：不同 key', B.envKey(base) !== B.envKey(Object.assign({}, base, { adapter: { vendor: 'amd', architecture: 'rdna', description: 'RX' } })));
    check('5 換瀏覽器版本：不同 key', B.envKey(base) !== B.envKey(Object.assign({}, base, { browser: 'Chrome/131' })));
    check('5 換記憶體預算：不同 key', B.envKey(base) !== B.envKey(Object.assign({}, base, { budgetMB: 900 })));
}
// 6. 相對誤差用整體尺度：相同＝0；ref 全 0 時 out 也要全 0；小值（RoPE 類）不因逐元素相對而誤判
{
    check('6 相同＝0', B.relErr([1, 2, 3], [1, 2, 3]) === 0);
    check('6 ref 全 0、out 全 0＝0', B.relErr([0, 0], [0, 0]) === 0);
    check('6 ref 全 0、out 不是 0＝Infinity', B.relErr([0, 1e-9], [0, 0]) === Infinity);
    const ref = [1e-6, 1000, -500];
    const out = [1e-6 * 1.5, 1000 + 0.001, -500];   // 第一個元素相對誤差 50%，但整體尺度只差 1e-6
    check('6 小值不誤判：整體誤差很小', B.relErr(out, ref) < 1e-5, B.relErr(out, ref));
    check('6 長度不同、NaN 都回 Infinity', B.relErr([1], []) === Infinity && B.relErr([NaN], [1]) === Infinity);
}

console.log('bench_core.test.js: ' + ok + ' passed, ' + bad + ' failed');
if (bad) process.exit(1);
