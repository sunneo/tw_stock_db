// node renderer/src/gpu/onnx_ops_more_test.js — 補充算子的小張量手算檢查（形狀與數值）。對真 ORT 的整張圖對拍在 scripts/eval/cudaweb_graph_*.js。
const assert = require('assert'); const M = require('./onnx_ops_more.js'); const { HELP: H } = require('./onnx_interp.js');
const T = (d, v, t) => ({ d, t: t || 'f', v: t === 'i' ? Float64Array.from(v) : Float32Array.from(v) });
const attrs = (o) => { const a = {}; for (const k of Object.keys(o)) { const x = o[k]; a[k] = typeof x === 'string' ? { s: x, i: null, f: null, ints: [] } : Array.isArray(x) ? { ints: x, i: null, f: null, s: null } : { i: x, f: null, ints: [], s: null }; } return a; };
const run = async (op, ins, at, nOut) => M.exec({ op, attrs: attrs(at || {}), outputs: new Array(nOut || 1).fill('o'), name: op }, ins, { gpu: null }, H);
let ok = 0; const t = async (n, f) => { try { await f(); ok++; } catch (e) { console.log('FAIL', n, e.message); process.exitCode = 1; } };
const eq = (a, b) => assert.deepStrictEqual(Array.from(a.v), b);
(async () => {
  await t('Relu/LeakyRelu/Max/Min', async () => { eq((await run('Relu', [T([3], [-1, 0, 2])]))[0], [0, 0, 2]); assert.ok(Math.abs((await run('LeakyRelu', [T([2], [-2, 3])], {}))[0].v[0] + 0.02) < 1e-6); eq((await run('Max', [T([2], [1, 5]), T([2], [3, 2])]))[0], [3, 5]); eq((await run('Min', [T([2], [1, 5]), T([2], [3, 2])]))[0], [1, 2]); });
  await t('Pad 常數／reflect', async () => { const r = (await run('Pad', [T([2], [1, 2]), T([2], [1, 2], 'i')]))[0]; eq(r, [0, 1, 2, 0, 0]); const q = (await run('Pad', [T([3], [1, 2, 3]), T([2], [2, 1], 'i')], { mode: 'reflect' }))[0]; eq(q, [3, 2, 1, 2, 3, 2]); });
  await t('Split 等分與指定大小', async () => { const o = await run('Split', [T([2, 2], [1, 2, 3, 4])], { axis: 1 }, 2); eq(o[0], [1, 3]); eq(o[1], [2, 4]); const p = await run('Split', [T([4], [1, 2, 3, 4]), T([2], [1, 3], 'i')], { axis: 0 }, 2); eq(p[1], [2, 3, 4]); });
  await t('ReduceMean／Sum／GlobalAveragePool', async () => { eq((await run('ReduceMean', [T([2, 2], [1, 2, 3, 4])], { axes: [1], keepdims: 0 }))[0], [1.5, 3.5]); const r = (await run('ReduceSum', [T([2, 2], [1, 2, 3, 4])], { axes: [0], keepdims: 1 }))[0]; assert.deepStrictEqual(r.d, [1, 2]); eq(r, [4, 6]); eq((await run('GlobalAveragePool', [T([1, 2, 2, 2], [1, 2, 3, 4, 5, 6, 7, 8])]))[0], [2.5, 6.5]); });
  await t('Expand／Tile', async () => { eq((await run('Expand', [T([2, 1], [1, 2]), T([2], [2, 3], 'i')]))[0], [1, 1, 1, 2, 2, 2]); eq((await run('Tile', [T([2], [1, 2]), T([1], [2], 'i')]))[0], [1, 2, 1, 2]); });
  await t('Resize nearest(asymmetric,floor)／linear(half_pixel)', async () => { const n = (await run('Resize', [T([1, 1, 1, 2], [10, 20]), null, T([4], [1, 1, 1, 2])], { mode: 'nearest', coordinate_transformation_mode: 'asymmetric' }))[0]; eq(n, [10, 10, 20, 20]); const l = (await run('Resize', [T([1, 1, 1, 2], [0, 10]), null, T([4], [1, 1, 1, 2])], { mode: 'linear', coordinate_transformation_mode: 'half_pixel' }))[0]; assert.deepStrictEqual(Array.from(l.v).map((x) => +x.toFixed(4)), [0, 2.5, 7.5, 10]); });
  await t('InstanceNormalization', async () => { const o = (await run('InstanceNormalization', [T([1, 1, 4], [1, 2, 3, 4]), T([1], [2]), T([1], [1])], { epsilon: 1e-5 }))[0]; const m = 2.5, sd = Math.sqrt(1.25 + 1e-5); assert.ok(Math.abs(o.v[0] - ((1 - m) / sd * 2 + 1)) < 1e-5); });
  await t('Trilu', async () => { eq((await run('Trilu', [T([2, 2], [1, 2, 3, 4])], { upper: 1 }))[0], [1, 2, 0, 4]); eq((await run('Trilu', [T([2, 2], [1, 2, 3, 4])], { upper: 0 }))[0], [1, 0, 3, 4]); });
  await t('DynamicQuantizeLinear／DequantizeLinear 往返', async () => { const x = T([4], [-1, 0, 1, 2]); const q = await run('DynamicQuantizeLinear', [x], {}, 3); const d = (await run('DequantizeLinear', [q[0], q[1], q[2]]))[0]; for (let i = 0; i < 4; i++) assert.ok(Math.abs(d.v[i] - x.v[i]) <= q[1].v[0]); });
  await t('MatMulInteger（CPU 整數參考）', async () => { const o = (await run('MatMulInteger', [T([1, 2], [3, 4], 'i'), T([2, 1], [5, 6], 'i'), T([], [1], 'i'), T([], [0], 'i')]))[0]; eq(o, [(3 - 1) * 5 + (4 - 1) * 6]); });
  await t('不認得的算子回 undefined', async () => { assert.strictEqual(await run('Foo', [T([1], [1])]), undefined); });
  console.log(ok + ' passed');
})();
