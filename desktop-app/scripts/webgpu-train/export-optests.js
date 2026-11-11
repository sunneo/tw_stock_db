#!/usr/bin/env node
// 逐算子測試圖：每個測試是一張只含一個（或一小串）運算子的 ONNX，形狀仿真模型。頁面（optests.html）用同一組輸入分別在 WASM 與 WebGPU 執行並比對。
//   node scripts/webgpu-train/export-optests.js <輸出資料夾>
const fs = require('fs'), path = require('path');
const Gm = require('../../renderer/src/studio/onnx_grad_core.js');
const out = process.argv[2]; if (!out) { console.error('用法見檔頭'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const tests = [];
function add(name, build) { const g = new Gm.G(); const inputs = []; const inp = (n, shape, scale) => { inputs.push({ name: n, shape, scale: scale || 1 }); return g.input(n, shape); }; const r = build(g, inp); g.output(r); fs.writeFileSync(path.join(out, name + '.onnx'), Gm.toOnnx(g, { name })); tests.push({ name, inputs, output: r.name, nodes: g.nodes.map((n) => n.op).join('>') }); }
const rnd = (n, f) => Float64Array.from({ length: n }, (_, i) => f(i));
add('add_bcast', (g, i) => g.add(i('a', [32, 1024]), i('b', [1024])));
add('mul_scalar', (g, i) => g.mul(i('a', [32, 1024]), g.scalar(0.5)));
add('sub_bcast', (g, i) => g.sub(i('a', [32, 8, 128]), i('b', [32, 1, 128])));
add('div', (g, i) => g.div(i('a', [32, 1024]), g.add(g.mul(i('b', [32, 1024]), i('b2', [32, 1024])), g.scalar(1))));
add('neg', (g, i) => g.neg(i('a', [32, 1024])));
add('sqrt', (g, i) => (() => { const a = i('a', [32, 1024]); return g.sqrt(g.add(g.mul(a, a), g.scalar(1e-6))); })());
add('reciprocal', (g, i) => g.recip(g.add(g.mul(i('a', [32, 1024]), i('a2', [32, 1024])), g.scalar(1))));
add('log', (g, i) => (() => { const a = i('a', [32]); return g.log(g.add(g.mul(a, a), g.scalar(1))); })());
add('exp', (g, i) => g.exp(i('a', [32, 1024])));
add('sigmoid', (g, i) => g.sigmoid(i('a', [32, 3072], 4)));
add('softmax_causal', (g, i) => { const m = new Float64Array(32 * 32); for (let a = 0; a < 32; a++) for (let b = a + 1; b < 32; b++) m[a * 32 + b] = -1e9; return g.softmax(g.add(i('a', [16, 32, 32]), g.const('mask', [32, 32], m)), -1); });
add('matmul_2d', (g, i) => g.matmul(i('a', [32, 1024]), i('b', [1024, 2048], 0.03)));
add('matmul_batch', (g, i) => g.matmul(i('a', [16, 32, 128]), i('b', [16, 128, 32])));
add('matmul_bcast_rhs', (g, i) => g.matmul(i('a', [32, 8, 128]), i('b', [128, 128], 0.1)));
add('matmul_lora', (g, i) => g.matmul(g.matmul(i('a', [32, 1024]), i('A', [1024, 8], 0.03)), i('B', [8, 2048], 0.02)));
add('transpose_102', (g, i) => g.transpose(i('a', [32, 16, 128]), [1, 0, 2]));
add('transpose_021', (g, i) => g.transpose(i('a', [16, 32, 128]), [0, 2, 1]));
add('reshape', (g, i) => g.reshape(i('a', [32, 2048]), [32, 16, 128]));
add('reducemean_keep', (g, i) => g.reduceMean(i('a', [32, 1024]), [-1], true));
add('reducesum_axis1', (g, i) => g.reduceSum(i('a', [32, 18992]), [1], false));
add('reducesum_all', (g, i) => g.reduceSum(i('a', [32, 1024]), [0, 1], false));
add('expand_kv', (g, i) => g.expand(i('a', [8, 1, 32, 128]), [8, 2, 32, 128]));
add('dequant_u8_scalar', (g, i) => { const q = g.const('q', [1024, 3072], rnd(1024 * 3072, (k) => (k * 7919) % 256), 'u8'); const s = g.const('s', [], Float64Array.of(0.0123)), z = g.const('z', [], Float64Array.of(128), 'u8'); return g.matmul(i('a', [32, 1024]), g.dequant(q, s, z)); });
add('dequant_u8_only', (g, i) => { const q = g.const('q', [1024, 3072], rnd(1024 * 3072, (k) => (k * 7919) % 256), 'u8'); const s = g.const('s', [], Float64Array.of(0.0123)), z = g.const('z', [], Float64Array.of(128), 'u8'); return g.mul(g.dequant(q, s, z), g.scalar(1)); });
add('dequant_transpose_u8', (g, i) => { const q = g.const('q', [4096, 1024], rnd(4096 * 1024, (k) => (k * 7919) % 256), 'u8'); const s = g.const('s', [], Float64Array.of(0.0123)), z = g.const('z', [], Float64Array.of(128), 'u8'); return g.matmul(i('a', [32, 1024]), g.dequant(g.transpose(q, [1, 0]), s, z)); });
add('gather_u8', (g, i) => { const q = g.const('q', [5000, 1024], rnd(5000 * 1024, (k) => (k * 7919) % 256), 'u8'); const ids = g.const('ids', [32], Float64Array.from({ length: 32 }, (_, k) => k * 13), 'i64'); const s = g.const('s', [], Float64Array.of(0.0123)), z = g.const('z', [], Float64Array.of(128), 'u8'); return g.add(g.dequant(g.gather(q, ids), s, z), i('a', [32, 1024])); });
const Q8 = (rows, cols) => rnd(rows * cols, (k) => (k * 7919) % 256);
add('cast_u8_only', (g, i) => g.add(g.cast(g.const('q', [1024, 1024], Q8(1024, 1024), 'u8'), 'f32'), i('a', [1024, 1024], 0.001)));
add('cast_i8_only', (g, i) => g.add(g.cast(g.const('q', [1024, 1024], rnd(1024 * 1024, (k) => ((k * 7919) % 256) - 128), 'i8'), 'f32'), i('a', [1024, 1024], 0.001)));
add('dq_cast_sub_mul_u8', (g, i) => { const q = g.const('q', [1024, 3072], Q8(1024, 3072), 'u8'); return g.matmul(i('a', [32, 1024]), g.mul(g.sub(g.cast(q, 'f32'), g.scalar(128)), g.scalar(0.0123))); });
add('dq_linear_i8', (g, i) => { const q = g.const('q', [1024, 3072], rnd(1024 * 3072, (k) => ((k * 7919) % 256) - 128), 'i8'); return g.matmul(i('a', [32, 1024]), g.dequant(q, g.const('s', [], Float64Array.of(0.0123)), null)); });
add('dq_linear_i8_zp', (g, i) => { const q = g.const('q', [1024, 3072], rnd(1024 * 3072, (k) => ((k * 7919) % 256) - 128), 'i8'); return g.matmul(i('a', [32, 1024]), g.dequant(q, g.const('s', [], Float64Array.of(0.0123)), g.const('z', [], Float64Array.of(0), 'i8'))); });
add('gather_cast_u8', (g, i) => { const q = g.const('q', [5000, 1024], Q8(5000, 1024), 'u8'); const ids = g.const('ids', [32], Float64Array.from({ length: 32 }, (_, k) => k * 13), 'i64'); return g.add(g.mul(g.sub(g.cast(g.gather(q, ids), 'f32'), g.scalar(128)), g.scalar(0.0123)), i('a', [32, 1024])); });
add('rmsnorm_pattern', (g, i) => { const x = i('x', [32, 1024]); const ss = g.reduceMean(g.mul(x, x), [-1], true); return g.mul(g.mul(x, g.recip(g.sqrt(g.add(ss, g.scalar(1e-6))))), g.const('gain', [1024], rnd(1024, (k) => 1 + (k % 7) / 10))); });
add('rope_pattern', (g, i) => { const R = new Float64Array(128 * 128); for (let k = 0; k < 64; k++) { R[(k + 64) * 128 + k] = -1; R[k * 128 + 64 + k] = 1; } const x = i('x', [32, 16, 128]); return g.add(g.mul(x, g.const('c', [32, 1, 128], rnd(32 * 128, (k) => Math.cos(k * 0.01)))), g.mul(g.matmul(x, g.const('R', [128, 128], R)), g.const('s', [32, 1, 128], rnd(32 * 128, (k) => Math.sin(k * 0.01))))); });
add('silu_mul', (g, i) => { const a = i('a', [32, 3072]); return g.mul(g.mul(a, g.sigmoid(a)), i('b', [32, 3072])); });
fs.writeFileSync(path.join(out, 'optests.json'), JSON.stringify(tests));
console.log('輸出 ' + tests.length + ' 個逐算子測試到 ' + out);
