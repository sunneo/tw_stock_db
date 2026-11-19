// node renderer/src/gpu/kir_webgpu_test.js — KIR 的 WebGPU 裝置層（kir_webgpu.js）。
// 這個測試用「假的 GPUDevice」：它不會真的編譯 WGSL，而是在 submit 時用 KIR 的 JS 後端（runJs）執行同一個核心，
// 所以只驗證主機端的流程：緩衝區偏移與綁定、uniform 佈局（純量順序與 _count）、派送不讀回、上傳與派送的提交順序、
// 打包部分的對齊、用法衝突的拒絕、裝置遺失、工作群大小與二維派送的參數、自適應的快取。
// WGSL 在真 GPU 上的結果另外由真 Electron 評測（scripts/eval/kir_webgpu.eval.js）驗證，這裡不宣稱。
const K = require('./kir.js'), GEN = require('./kir_gen.js'), D = require('./kir_webgpu.js');
let ok = 0; const bad = [];
const check = (name, c, info) => { if (c) ok++; else bad.push(name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 240) : '')); };
const maxErr = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const tolerance = (k) => 8 * Math.sqrt(Math.max(1, k)) * 1.1920928955078125e-7;   // 與 gpu_core.tolerance 相同（EPS32）
const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };

// ---- 假裝置 ----
// kernels：label（'kir:名字'）→ KIR 核心，由測試登記。submit 時依 WGSL 的 workgroup 大小與 uniform 內容執行。
function fakeDevice(kernels) {
    let lostResolve = null;
    const dev = { kernels, log: [], lost: new Promise((r) => { lostResolve = r; }), errScopes: 0 };
    dev.__loseWith = (info) => lostResolve(info);
    dev.createBuffer = ({ size, usage }) => {
        if (!(size > 0) || size % 4) throw new Error('createBuffer：大小 ' + size + ' 不合法');
        const u8 = new Uint8Array(size);
        return { size, usage, u8, destroyed: false, destroy() { this.destroyed = true; }, mapAsync: async () => {}, getMappedRange() { return this.u8.buffer; }, unmap() {} };
    };
    dev.createBindGroupLayout = ({ entries }) => ({ entries });
    dev.createPipelineLayout = () => ({});
    dev.createShaderModule = ({ code, label }) => { if (!/@compute @workgroup_size\(\d+\)/.test(code)) throw new Error('WGSL 沒有 compute 入口'); return { code, label }; };
    dev.createComputePipeline = ({ compute }) => ({ module: compute.module, entry: compute.entryPoint });
    dev.createBindGroup = ({ layout, entries }) => {
        for (const e of entries) {
            const r = e.resource;
            if (r.buffer && r.offset !== undefined) {
                if (r.offset % 256) throw new Error('綁定偏移 ' + r.offset + ' 不是 256 的倍數');
                if (r.offset + r.size > r.buffer.size) throw new Error('綁定範圍超出緩衝區');
            }
        }
        return { entries };
    };
    dev.createCommandEncoder = () => {
        const ops = [];
        return {
            beginComputePass() { const pass = { pipeline: null, bg: null, dyn: [], groups: null }; return { setPipeline(p) { pass.pipeline = p; }, setBindGroup(i, bg, d) { pass.bg = bg; pass.dyn = d || []; }, dispatchWorkgroups(x, y) { pass.groups = [x, y]; }, end() { ops.push(() => runPass(pass)); } }; },
            copyBufferToBuffer(src, so, dst, dof, size) { ops.push(() => dst.u8.set(src.u8.subarray(so, so + size), dof)); },
            finish() { return { ops }; }
        };
    };
    dev.queue = {
        writeBuffer(buf, off, data) {
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            if (off + bytes.length > buf.size) throw new Error('writeBuffer 超出範圍');
            buf.u8.set(bytes, off);
            dev.log.push('write');
        },
        submit(cmds) { dev.log.push('submit'); for (const c of cmds) for (const op of c.ops) op(); },
        onSubmittedWorkDone: async () => {}
    };
    dev.pushErrorScope = () => { dev.errScopes++; };
    dev.popErrorScope = async () => null;
    dev.addEventListener = () => {};

    function runPass(pass) {
        const name = pass.pipeline.module.label.replace(/^kir:/, '');
        const kernel = kernels[name];
        if (!kernel) throw new Error('假裝置：沒有登記核心 ' + name);
        const wg = Number(/@workgroup_size\((\d+)\)/.exec(pass.pipeline.module.code)[1]);
        const bufParams = kernel.params.filter((p) => p.kind === 'buf');
        const scalars = kernel.params.filter((p) => p.kind === 'scalar');
        const uni = pass.bg.entries[pass.bg.entries.length - 1];
        const off = pass.dyn[0] || 0;
        if (off % 256) throw new Error('動態偏移不對齊');
        const dv = new DataView(uni.resource.buffer.u8.buffer, uni.resource.buffer.u8.byteOffset + off, 4 * (scalars.length + 1));
        const S = {};
        scalars.forEach((s, i) => { S[s.name] = s.type === 'i32' ? dv.getInt32(4 * i, true) : dv.getFloat32(4 * i, true); });
        const N = dv.getInt32(4 * scalars.length, true);
        const B = {};
        pass.bg.entries.slice(0, -1).forEach((e, i) => {
            const p = bufParams[i];
            const r = e.resource;
            const elemCount = (r.size / 4) | 0;
            const f = new Float32Array(r.buffer.u8.buffer, r.buffer.u8.byteOffset + r.offset, elemCount);
            B[p.name] = f;
            if (e.binding !== i) throw new Error('綁定編號與參數順序不符');
        });
        const groups = Math.ceil(N / wg);
        const gx = Math.min(groups, 65535), gy = Math.ceil(groups / 65535);
        if (pass.groups[0] !== gx || pass.groups[1] !== gy) throw new Error('派送工作群數 ' + pass.groups + ' 與預期 ' + [gx, gy] + ' 不符');
        dev.log.push('dispatch:' + name + ':' + N + ':wg' + wg);
        // 只跑 N 個 gid（假裝置）；WGSL 的守衛 gid < _count 在 KIR 的 for gid 迴圈裡等價
        K.runJs(kernel, B, S, N);
    }
    return dev;
}

// ---- 核心（KIR 直接建構，不經過解析器）----
const vadd = {
    name: 'vadd',
    params: [{ kind: 'buf', name: 'a', elem: 'f32', access: 'in' }, { kind: 'buf', name: 'b', elem: 'f32', access: 'in' }, { kind: 'buf', name: 'c', elem: 'f32', access: 'out' },
        { kind: 'scalar', name: 'n', type: 'i32' }, { kind: 'scalar', name: 's', type: 'f32' }],
    body: [{ k: 'if', c: { k: 'cmp', op: '<', a: { k: 'gid' }, b: { k: 'var', name: 'n', t: 'i32' } },
        body: [{ k: 'store', buf: 'c', idx: { k: 'gid' }, e: { k: 'bin', op: '+', t: 'f32', a: { k: 'bin', op: '*', t: 'f32', a: { k: 'load', buf: 'a', idx: { k: 'gid' }, comp: null }, b: { k: 'var', name: 's', t: 'f32' } }, b: { k: 'load', buf: 'b', idx: { k: 'gid' }, comp: null } } }] }]
};
// 有迴圈的歸約：out[i] ＝ (Σ_{j<m} p[j].x) × p[i].y（p 是 f32x4）
const sumk = {
    name: 'sumk',
    params: [{ kind: 'buf', name: 'p', elem: 'f32x4', access: 'in' }, { kind: 'buf', name: 'out', elem: 'f32', access: 'out' }, { kind: 'scalar', name: 'm', type: 'i32' }],
    body: [{ k: 'let', name: 'acc', t: 'f32', e: { k: 'num', v: 0, t: 'f32' } },
        { k: 'for', v: 'j', bound: 'm', body: [{ k: 'set', name: 'acc', e: { k: 'bin', op: '+', t: 'f32', a: { k: 'var', name: 'acc', t: 'f32' }, b: { k: 'load', buf: 'p', idx: { k: 'var', name: 'j', t: 'i32' }, comp: 0 } } }] },
        { k: 'store', buf: 'out', idx: { k: 'gid' }, e: { k: 'bin', op: '*', t: 'f32', a: { k: 'var', name: 'acc', t: 'f32' }, b: { k: 'load', buf: 'p', idx: { k: 'gid' }, comp: 1 } } }]
};
check('測試核心通過 KIR 驗證', K.validate(vadd).ok && K.validate(sumk).ok, [K.validate(vadd).errors, K.validate(sumk).errors]);

// ---- 1. WGSL 產生：工作群大小參數與二維派送的 gid 公式
{
    const w64 = GEN.toWgsl(vadd), w128 = GEN.toWgsl(vadd, { wg: 128 }), w256 = GEN.toWgsl(vadd, { wg: 256 });
    check('WGSL 預設工作群 64（與舊測試相容）', w64.ok && /@workgroup_size\(64\)/.test(w64.code));
    check('WGSL 可指定 128／256', w128.ok && /@workgroup_size\(128\)/.test(w128.code) && w256.ok && /@workgroup_size\(256\)/.test(w256.code) && w128.workgroupSize === 128);
    check('WGSL 二維派送公式（y×65535×wg）', /i32\(gid3\.y\) \* 8388480/.test(w128.code) === true, w128.code.slice(0, 300));
    check('WGSL 拒絕不合法工作群 0／2048', GEN.toWgsl(vadd, { wg: 0 }).ok === false && GEN.toWgsl(vadd, { wg: 2048 }).ok === false);
    // 分塊版（workgroup 共享記憶體）：sumk 的 for 迴圈讀 p[j] → 產生分塊；沒有迴圈的 vadd 退回一般版
    const ts = GEN.toWgsl(sumk, { wg: 64, tile: true });
    check('分塊 WGSL：sumk 產生共享記憶體與兩道 barrier', ts.ok && ts.tiles === 1 && /var<workgroup> T\d+_p: array<vec4<f32>, 64>;/.test(ts.code) && (ts.code.match(/workgroupBarrier\(\)/g) || []).length === 2, ts.code && ts.code.slice(0, 200));
    check('分塊 WGSL：沒有 early return（所有執行緒進迴圈）、寫入用 in_range 守衛', ts.ok && !/return;/.test(ts.code) && /if \(in_range\) \{ out\[/.test(ts.code));
    check('分塊 WGSL：迴圈內的 p[v] 改讀共享記憶體（T?_p[jj?].x）', ts.ok && /T\d+_p\[jj\d+\]\.x/.test(ts.code) && !/p\[v_j\]/.test(ts.code), ts.ok && ts.code);
    const tu = GEN.toWgsl(sumk, { wg: 64, tile: true, unroll: 4 });
    check('分塊展開 4 次：內層副本各自讀 jj＋k，共享記憶體讀取 4 處', tu.ok && (tu.code.match(/T\d+_p\[\(jj\d+ \+ [0-3]i\)\]/g) || []).length === 4, tu.ok ? '' : tu.error);
    check('分塊展開：不整除工作群大小會拒絕（wg 64、展開 3）', GEN.toWgsl(sumk, { wg: 64, tile: true, unroll: 3 }).ok === false);
    const tv = GEN.toWgsl(vadd, { wg: 64, tile: true });
    check('分塊：沒有符合迴圈的核心退回一般版（tiles＝0）', tv.ok && tv.tiles === undefined && /if \(gid >= P\._count\) \{ return; \}/.test(tv.code));
}

// ---- 2. 基本流程：上傳一次、連續派送、只在 download 讀回（非同步）
(async () => {
    const dev = fakeDevice({ vadd, sumk });
    const d = D.createDevice(dev, { wg: 64 });
    const N = 1000;
    const a = d.alloc(N, 'f32'), b = d.alloc(N, 'f32'), c = d.alloc(N, 'f32');
    const A = new Float32Array(N).map((_, i) => i * 0.5), Bv = new Float32Array(N).map((_, i) => 2 * i);
    d.upload(a, A); d.upload(b, Bv);
    const before = d.stats.downloads;
    for (let r = 0; r < 5; r++) d.dispatch(vadd, { a, b, c }, c, { n: N, s: 1.5 }, N);
    check('派送不讀回（5 次派送後 downloads 不變）', d.stats.downloads === before);
    const got = await d.download(c);
    const want = new Float32Array(N).map((_, i) => Math.fround(Math.fround(A[i] * 1.5) + Bv[i]));
    check('vecadd 經裝置的結果與參考一致', maxErr(got, want) <= tolerance(N) * 10, maxErr(got, want));
    check('download 只讀回一次（非同步）', d.stats.downloads === before + 1);
    check('派送順序：上傳在派送之前提交', dev.log.indexOf('write') < dev.log.findIndex((x) => x.startsWith('dispatch')));

    // 3. 有迴圈的歸約（f32x4 輸入、i32 迴圈上界）
    const M = 300, P = new Float32Array(M * 4).map((_, i) => ((i * 37) % 101) / 101);
    const p = d.alloc(M, 'f32x4'), o = d.alloc(M, 'f32');
    d.upload(p, P);
    d.dispatch(sumk, { p, out: o }, o, { m: 200 }, M);
    const sumOut = await d.download(o);
    let refSum = 0; for (let j = 0; j < 200; j++) refSum += P[j * 4];
    let serr = 0; for (let i = 0; i < M; i++) serr = Math.max(serr, Math.abs(sumOut[i] - Math.fround(refSum) * P[i * 4 + 1]));
    check('歸約核心（迴圈、f32x4 分量）結果一致', serr <= tolerance(200) * 100, serr);

    // 4. 派送數超過上限：會分批提交，結果仍正確
    const subBefore = d.stats.submits;
    for (let r = 0; r < 300; r++) d.dispatch(vadd, { a, b, c }, c, { n: 10, s: 1 }, N);
    await d.sync();
    check('超過 256 次派送會分批提交', d.stats.submits - subBefore >= 2, d.stats.submits - subBefore);

    // 5. 拒絕：輸出與輸入重疊、大小不符、缺純量、缺緩衝區
    check('拒絕輸出＝輸入（用法衝突）', /用法衝突|重疊/.test(throws(() => d.dispatch(vadd, { a, b, c: a }, a, { n: N, s: 1 }, N)) || ''));
    check('拒絕緩衝區比 N 小', /小於 N/.test(throws(() => d.dispatch(vadd, { a, b, c }, c, { n: N, s: 1 }, N + 1)) || ''));
    check('允許 N 比緩衝區小（只派送前 N 個）', throws(() => d.dispatch(vadd, { a, b, c }, c, { n: 10, s: 1 }, 10)) === null);
    check('拒絕缺純量', /缺少純量 s/.test(throws(() => d.dispatch(vadd, { a, b, c }, c, { n: N }, N)) || ''));
    check('拒絕缺輸入緩衝區', /缺少輸入緩衝區 b/.test(throws(() => d.dispatch(vadd, { a, c }, c, { n: N, s: 1 }, N)) || ''));
    check('拒絕已釋放的緩衝區', (() => { const t = d.alloc(4, 'f32'); d.free(t); return /已釋放|缺少/.test(throws(() => d.dispatch(vadd, { a, b, c: t }, t, { n: 4, s: 1 }, 4)) || ''); })());

    // 6. 打包緩衝區：部分的偏移對齊；view 讀寫同一個 GPUBuffer 的不同區段
    const NP = 256;   // 256×4 位元組＝1024，是 256 的倍數
    const root = d.allocPacked(NP, 3);
    const v0 = d.view(root, 0), v1 = d.view(root, 1), v2 = d.view(root, 2);
    const X = new Float32Array(NP).map((_, i) => i), Yv = new Float32Array(NP).map((_, i) => 1000 + i);
    d.upload(v0, X); d.upload(v1, Yv);
    const aa = d.alloc(NP, 'f32');
    d.dispatch(vadd, { a: v0, b: v1, c: v2 }, v2, { n: NP, s: 2 }, NP);
    const z = await d.download(v2);
    check('打包 view：輸入 view＋輸出 view 結果正確', maxErr(z, new Float32Array(NP).map((_, i) => 2 * i + 1000 + i)) === 0);
    const xBack = await d.download(v0);
    check('打包 view：讀回一個 view 不影響其他部分', maxErr(xBack, X) === 0);
    check('打包對齊不對（每部分 100 個 f32）會拒絕', /256 的倍數/.test(throws(() => d.allocPacked(100, 2)) || ''));
    d.free(aa);

    // 7. uniform 佈局：純量順序與 _count（i32 與 f32 各自的位元）
    {
        const sc = { n: 7, s: -0.25 };
        d.dispatch(vadd, { a, b, c }, c, sc, 7);
        await d.sync();
        const cc = await d.download(c);
        // 只派送前 7 個：第 7 個（索引 6）必須用 s＝-0.25 算，索引 7 以後不能被改寫成這次的值（_count＝7）
        check('uniform：i32 與 f32 純量與 _count 都正確', cc[6] === Math.fround(Math.fround(A[6] * -0.25) + Bv[6]), [cc[6]]);
    }

    // 8. 工作群大小與自適應快取
    {
        const store = new Map(); const st = { get: async (k) => store.get(k) || null, set: async (k, v) => { store.set(k, v); } };
        const r1 = await d.ensureTuned(vadd, N, { store, adapterKey: 'fake-kepler', scalars: { n: N, s: 1 }, reps: 2 });
        check('自適應：第一次實測，候選全部跑過', r1.cached === false && Object.keys(r1.times).length === 4 && [32, 64, 128, 256].includes(r1.best), r1);
        const tunedBefore = d.stats.tuned;
        const r2 = await d.ensureTuned(vadd, N, { store, adapterKey: 'fake-kepler', scalars: { n: N, s: 1 }, reps: 2 });
        check('自適應：第二次命中快取（不重測）', r2.cached === true && d.stats.tuned === tunedBefore && r2.best === r1.best);
        const r3 = await d.ensureTuned(vadd, N, { store, adapterKey: 'other-device', scalars: { n: N, s: 1 }, reps: 2 });
        check('自適應：換裝置（adapterKey 不同）會重測', r3.cached === false);
        check('工作群大小被記住（wgFor 回傳選定值）', d.wgFor(vadd) === r3.best);
    }

    // 9. 裝置遺失：之後的派送與上傳都拒絕（不靜默）
    dev.__loseWith({ reason: 'destroyed', message: 'test' });
    await new Promise((r) => setTimeout(r, 0));
    check('裝置遺失後派送拒絕並說明', /已遺失/.test(throws(() => d.dispatch(vadd, { a, b, c }, c, { n: N, s: 1 }, N)) || ''));
    check('裝置遺失後上傳拒絕', /已遺失/.test(throws(() => d.upload(a, A)) || ''));

    // 10. 不是 WebGPU 裝置就不建立（呼叫端退回）
    check('沒有 GPUDevice 時 createDevice 丟錯（呼叫端退回）', /不可用/.test(throws(() => D.createDevice(null)) || ''));

    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'kir_webgpu: ' + ok + ' passed');
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAILED (exception): ' + (e && e.stack || e)); process.exit(1); });
