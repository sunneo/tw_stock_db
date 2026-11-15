// node renderer/src/gpu/gpu_kernel_test.js
// 任意核心（numba 轉譯來的 WGSL）的主機端流程：runKernel 的綁定、寫回、無 WebGPU 時的原因、執行失敗時的原因。
// 假裝置會從 WGSL 原始碼解析 @binding 宣告，依綁定名稱用 JS 算出結果（代替 GPU）；WGSL 本身的正確性只能在真的 GPU 上驗證。
'use strict';
const assert = require('assert');
const core = require('./gpu_core.js');

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('ok   ' + name); },
    (e) => { fail++; console.log('FAIL ' + name + ': ' + (e && e.message)); }
  );
}

// 假的 WebGPU：submit 時執行 dispatch（用 execFn 代替 GPU 計算）與 copy
function fakeNav(execFn, opts) {
  opts = opts || {};
  const device = {
    limits: { maxStorageBufferBindingSize: 134217728 },
    lost: new Promise(() => {}),
    queue: {
      writeBuffer(buf, off, data) {
        const src = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        new Uint8Array(buf.data).set(src, off);
      },
      submit(cmds) {
        for (const ops of cmds) {
          for (const op of ops) {
            if (op.copy) new Uint8Array(op.dst.data).set(new Uint8Array(op.src.data, op.so, op.n), op.dO);
            else if (op.dispatch) execFn(op.dispatch.code, op.dispatch.bufsByName, op.dispatch.groups);
          }
        }
      }
    },
    createBuffer({ size, usage }) {
      const b = { size, usage, data: new ArrayBuffer(Math.max(4, size)), destroy() {}, unmap() {} };
      b.mapAsync = async () => {};
      b.getMappedRange = () => b.data;
      return b;
    },
    createShaderModule({ code }) { return { code }; },
    createComputePipeline({ compute }) { return { code: compute.module.code, getBindGroupLayout() { return {}; } }; },
    createBindGroup({ entries }) { return { entries }; },
    createCommandEncoder() {
      const ops = [];
      return {
        beginComputePass() {
          let pipe = null, bg = null;
          return {
            setPipeline(p) { pipe = p; },
            setBindGroup(i, g) { bg = g; },
            dispatchWorkgroups(x, y) {
              // 依 WGSL 的 @binding 宣告，把綁定名稱對到緩衝區型別化視圖
              const bufsByName = {};
              const re = /@binding\((\d+)\) var<storage, (read|read_write)> (\w+): array<(atomic<i32>|f32|i32)>;/g;
              let m;
              while ((m = re.exec(pipe.code))) {
                const entry = bg.entries.find((e) => e.binding === Number(m[1]));
                const isInt = m[4] !== 'f32';
                bufsByName[m[3]] = isInt ? new Int32Array(entry.resource.buffer.data) : new Float32Array(entry.resource.buffer.data);
              }
              ops.push({ dispatch: { code: pipe.code, bufsByName, groups: [x, y || 1] } });
            },
            end() {}
          };
        },
        copyBufferToBuffer(src, so, dst, dO, n) { ops.push({ copy: true, src, so, dst, dO, n }); },
        finish() { return ops; }
      };
    },
    pushErrorScope() {},
    popErrorScope: async () => null
  };
  const adapter = { limits: {}, features: [], requestDevice: async () => device };
  if (opts.noGpu) return {};
  return { gpu: { requestAdapter: async () => adapter } };
}

const VEC_ADD = [
  '@group(0) @binding(0) var<storage, read_write> a_out: array<f32>;',
  '@group(0) @binding(1) var<storage, read> a_x: array<f32>;',
  '@group(0) @binding(2) var<storage, read> a_y: array<f32>;',
  '@compute @workgroup_size(128, 1, 1)',
  'fn main(@builtin(global_invocation_id) gid: vec3<u32>) {',
  '  let v_idx: i32 = i32(gid.x);',
  '  if ((v_idx < 4i)) {',
  '    a_out[v_idx] = (a_x[v_idx] + a_y[v_idx]);',
  '  }',
  '}',
  ''
].join('\n');

const HIST = [
  '@group(0) @binding(0) var<storage, read_write> a_out: array<atomic<i32>>;',
  '@group(0) @binding(1) var<storage, read> a_data: array<i32>;',
  '@compute @workgroup_size(32, 1, 1)',
  'fn main(@builtin(global_invocation_id) gid: vec3<u32>) {',
  '  let v_i: i32 = i32(gid.x);',
  '  if ((v_i < 6i)) {',
  '    _ = atomicAdd(&a_out[a_data[v_i]], (1i));',
  '  }',
  '}',
  ''
].join('\n');

function f32bytes(arr) { return new Uint8Array(new Float32Array(arr).buffer); }
function i32bytes(arr) { return new Uint8Array(new Int32Array(arr).buffer); }

// 執行函式：依綁定名稱計算（向量加、原子直方圖）
function execFn(code, bufs) {
  if (code.indexOf('atomicAdd') >= 0) {
    const d = bufs.a_data, o = bufs.a_out;
    for (let i = 0; i < 6; i++) o[d[i]] += 1;
    return;
  }
  const x = bufs.a_x, y = bufs.a_y, o = bufs.a_out;
  for (let i = 0; i < 4; i++) o[i] = x[i] + y[i];
}

(async function () {
  await check('runKernel 向量加：輸入輸出正確，層是 T1', async () => {
    const rt = core.createRuntime({ navigator: fakeNav(execFn) });
    const r = await rt.runKernel({
      wgsl: VEC_ADD, groups: [1, 1],
      bindings: [
        { name: 'a_out', dtype: 'f32', n: 4, write: true, data: null },
        { name: 'a_x', dtype: 'f32', n: 4, write: false, data: new Float32Array([1, 2, 3, 4]) },
        { name: 'a_y', dtype: 'f32', n: 4, write: false, data: new Float32Array([10, 20, 30, 40]) }
      ]
    });
    assert.strictEqual(r.ran, true, JSON.stringify(r));
    assert.strictEqual(r.layer, 'T1');
    assert.deepStrictEqual(Array.from(new Float32Array(r.outputs.a_out.buffer)), [11, 22, 33, 44]);
  });

  await check('runKernel 原子直方圖：i32 寫回正確', async () => {
    const rt = core.createRuntime({ navigator: fakeNav(execFn) });
    const r = await rt.runKernel({
      wgsl: HIST, groups: [1, 1],
      bindings: [
        { name: 'a_out', dtype: 'i32', n: 3, write: true, data: null },
        { name: 'a_data', dtype: 'i32', n: 6, write: false, data: new Int32Array([0, 1, 1, 2, 2, 2]) }
      ]
    });
    assert.strictEqual(r.ran, true, JSON.stringify(r));
    assert.deepStrictEqual(Array.from(new Int32Array(r.outputs.a_out.buffer)), [1, 2, 3]);
  });

  await check('沒有 WebGPU：ran=false，原因寫清楚（不假裝跑在 GPU）', async () => {
    const rt = core.createRuntime({ navigator: {} });
    const r = await rt.runKernel({ wgsl: VEC_ADD, groups: [1, 1], bindings: [] });
    assert.strictEqual(r.ran, false);
    assert.strictEqual(r.layer, 'CPU');
    assert.ok(/沒有 WebGPU/.test(r.reason), r.reason);
    assert.ok(/WebGL2/.test(r.reason), r.reason);
  });

  await check('執行失敗：ran=false，原因帶上 WGSL 錯誤訊息', async () => {
    const rt = core.createRuntime({ navigator: fakeNav(function () { throw new Error('假的驗證錯誤'); }) });
    const r = await rt.runKernel({
      wgsl: VEC_ADD, groups: [1, 1],
      bindings: [
        { name: 'a_out', dtype: 'f32', n: 4, write: true, data: null },
        { name: 'a_x', dtype: 'f32', n: 4, write: false, data: new Float32Array(4) },
        { name: 'a_y', dtype: 'f32', n: 4, write: false, data: new Float32Array(4) }
      ]
    });
    assert.strictEqual(r.ran, false);
    assert.ok(/WGSL 核心執行失敗（假的驗證錯誤）/.test(r.reason), r.reason);
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
