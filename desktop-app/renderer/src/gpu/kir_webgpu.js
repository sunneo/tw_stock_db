/* KIR 的 WebGPU 裝置層（DESIGN.webgpu-cuda.md §13，階段 3）。UMD：瀏覽器掛 FaKirWebGPU，node 用 require。無 DOM 依賴。
 * 呼叫端給一個 GPUDevice（cudaweb 的 nn_ops.getDevice 取得的那個）。核心由 kir_gen.toWgsl 產生（storage buffer＋uniform）。
 *   alloc(N, elem)       常駐 storage buffer（f32：每元素 4 位元組；f32x4：16 位元組）。跨多次派送保留。
 *   allocPacked(Npart, parts) 一個 buffer 裝 parts 個部分；view(打包, k) 是第 k 個部分（同一個 GPUBuffer，綁定時用 offset）。
 *                        部分的位元組偏移必須是 256 的倍數（minStorageBufferOffsetAlignment），否則拒絕（呼叫端退回別的路徑）。
 *   upload(b, arr)       writeBuffer（與之前的派送保持順序）。
 *   download(b)          **非同步**：回傳 Promise<Float32Array>（mapAsync 的結果）。只有這裡讀回。
 *   dispatch(kernel, binds, out, scalars, N)  同步編碼、不讀回。派送先放進一個命令編碼器，遇到上傳／讀回／上限才提交。
 *   prepare(kernel, wg)  非同步：建立 shader 與 pipeline，用 validation error scope 確認編譯成功（失敗丟例外）。
 *   tune(kernel, N, {scalars, reps, wgCandidates})  實測候選工作群大小（32／64／128／256），回傳最快的與各自耗時。
 *   ensureTuned(kernel, N, {store, adapterKey, scalars})  先查 store（非同步，例如 IndexedDB），沒有就 tune 後存回。
 *   free(b)
 * 輸入與輸出不能是同一塊重疊的位元組範圍（WebGPU 的用法衝突）；拒絕並說明。
 * 注意：這個檔案的 WGSL 只能在真的 GPU 上編譯與執行，node 測試用假裝置（只驗證綁定、偏移、提交順序與 uniform 佈局）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./kir_gen.js'), require('./kir.js'));
    else root.FaKirWebGPU = factory(root.FaKirGen, root.FaKir);
})(typeof self !== 'undefined' ? self : this, function (GEN, K) {
    'use strict';

    const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 };
    const STAGE_COMPUTE = 0x4, MAP_MODE_READ = 0x1;
    const SLOT = 256;             // 動態 uniform 偏移的對齊（minUniformBufferOffsetAlignment 預設值）
    const SLOTS = 1024;           // 一個提交週期內最多幾個 uniform 槽（用完就先提交）
    const MAX_PER_SUBMIT = 256;   // 一個命令編碼器最多幾個派送
    const MAX_DIM = 65535;        // 一維工作群數量上限（WebGPU 預設）
    const ALIGN = 256;            // 打包部分的位元組對齊（minStorageBufferOffsetAlignment 預設值）
    const BG_CACHE_MAX = 512;

    const bytesOf = (elem) => (elem === 'f32x4' ? 16 : 4);
    const compsOf = (elem) => (elem === 'f32x4' ? 4 : 1);

    function supportsWebGPU(gdev) {
        return !!(gdev && gdev.queue && typeof gdev.createBuffer === 'function' && typeof gdev.createComputePipeline === 'function');
    }

    function createDevice(gdev, opts) {
        if (!supportsWebGPU(gdev)) throw new Error('WebGPU 裝置不可用');
        const o = opts || {};
        const wgDefault = o.wg || 64;
        const cands = o.wgCandidates || [32, 64, 128, 256];
        let lost = null;   // 裝置遺失的原因（一旦遺失，之後的派送全部拒絕）
        const stats = { allocs: 0, uploads: 0, downloads: 0, dispatches: 0, submits: 0, pipelines: 0, bindGroups: 0, errors: [], tuned: 0 };
        if (gdev.lost && typeof gdev.lost.then === 'function') {
            gdev.lost.then((info) => { lost = ((info && info.reason) || 'unknown') + '：' + ((info && info.message) || ''); });
        }
        if (typeof gdev.addEventListener === 'function') {
            gdev.addEventListener('uncapturederror', (e) => { stats.errors.push(String((e && e.error && e.error.message) || e).slice(0, 200)); });
        }
        const ring = gdev.createBuffer({ size: SLOTS * SLOT, usage: USAGE.UNIFORM | USAGE.COPY_DST });
        let enc = null, pending = 0, slot = 0, nextId = 1;
        const progs = new WeakMap();   // kernel → Map(wg → 程式)
        const wgOf = new WeakMap();    // kernel → 選定的工作群大小（ensureTuned／setWorkgroup）
        const layouts = new Map();     // 綁定佈局的關鍵字 → GPUBindGroupLayout
        const allProgs = [];           // 所有已建立的程式（free 時清綁定群組快取用）

        const live = () => { if (lost) throw new Error('WebGPU 裝置已遺失（' + lost + '）'); };
        const encoder = () => enc || (enc = gdev.createCommandEncoder());
        const flush = () => {
            if (!enc) return;
            const cb = enc.finish(); enc = null;
            gdev.queue.submit([cb]);
            stats.submits++; pending = 0; slot = 0;   // 提交後，寫入 ring 的新槽位排在這次提交之後，安全
        };

        // ---- 緩衝區
        const mkBuf = (gbuf, offset, N, elem, parent) => ({ id: nextId++, gbuf, offset, N, elem, bytes: N * bytesOf(elem), parent, root: parent ? parent.root : null, freed: false });
        const alloc = (N, elem) => {
            live();
            if (!Number.isInteger(N) || N < 1) throw new Error('alloc：N 要是正整數');
            if (elem !== 'f32' && elem !== 'f32x4') throw new Error('alloc：元素型別 ' + elem + ' 不支援');
            const gbuf = gdev.createBuffer({ size: N * bytesOf(elem), usage: USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST });
            stats.allocs++;
            const b = mkBuf(gbuf, 0, N, elem, null); b.root = b; b.packedParts = 0; return b;
        };
        const allocPacked = (Npart, parts) => {
            live();
            if (!Number.isInteger(Npart) || Npart < 1 || !Number.isInteger(parts) || parts < 1) throw new Error('allocPacked：參數錯');
            if ((Npart * 4) % ALIGN !== 0) throw new Error('allocPacked：每部分 ' + Npart + ' 個 f32 的位元組數不是 ' + ALIGN + ' 的倍數（綁定偏移對齊），拒絕');
            const gbuf = gdev.createBuffer({ size: Npart * parts * 4, usage: USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST });
            stats.allocs++;
            const b = mkBuf(gbuf, 0, Npart * parts, 'f32', null); b.root = b; b.packedParts = parts; b.Npart = Npart; return b;
        };
        const view = (parent, k) => {
            if (!parent || parent.freed || !parent.packedParts) throw new Error('view：不是打包緩衝區');
            if (!Number.isInteger(k) || k < 0 || k >= parent.packedParts) throw new Error('view：部分編號 ' + k + ' 超出');
            return mkBuf(parent.gbuf, k * parent.Npart * 4, parent.Npart, 'f32', parent);
        };
        const upload = (b, arr) => {
            live();
            if (!b || b.freed) throw new Error('upload：緩衝區已釋放');
            if (!(arr instanceof Float32Array)) throw new Error('upload：資料要是 Float32Array');
            const count = b.N * compsOf(b.elem);
            if (arr.length < count) throw new Error('upload：資料長度 ' + arr.length + ' 不足 ' + count);
            flush();   // 之前排好的派送先提交，保證它們讀到的是上傳前的值
            gdev.queue.writeBuffer(b.gbuf, b.offset, arr.subarray(0, count));
            stats.uploads++;
        };
        const download = async (b) => {
            live();
            if (!b || b.freed) throw new Error('download：緩衝區已釋放');
            flush();
            const staging = gdev.createBuffer({ size: b.bytes, usage: USAGE.COPY_DST | USAGE.MAP_READ });
            const e = gdev.createCommandEncoder();
            e.copyBufferToBuffer(b.gbuf, b.offset, staging, 0, b.bytes);
            gdev.queue.submit([e.finish()]);
            await staging.mapAsync(MAP_MODE_READ);
            const res = new Float32Array(staging.getMappedRange().slice(0));
            staging.unmap(); staging.destroy();
            stats.downloads++;
            return res;
        };
        const free = (b) => {
            if (!b || b.freed) return;
            flush();
            b.freed = true;
            if (!b.parent) { b.gbuf.destroy(); }
            for (const p of allProgs) p.bg.clear();   // 綁定群組快取可能還指著它
        };

        // ---- 程式（pipeline）
        const build = (kernel, wg) => {
            let m = progs.get(kernel); if (!m) { m = new Map(); progs.set(kernel, m); }
            const got = m.get(wg); if (got) return got;
            const v = K.validate(kernel); if (!v.ok) throw new Error('KIR 不合法：' + v.errors.join('；'));
            const w = GEN.toWgsl(kernel, { wg });
            if (!w.ok) throw new Error(w.error);
            const scalars = kernel.params.filter((q) => q.kind === 'scalar');
            if (scalars.length + 1 > SLOT / 4) throw new Error('純量太多（超過 ' + (SLOT / 4 - 1) + ' 個）');
            const uniformBytes = 4 * (scalars.length + 1);
            const bufs = w.bindings.filter((b) => b.kind === 'buf');
            const uni = w.bindings.find((b) => b.kind === 'uniform');
            const entries = bufs.map((b) => ({ binding: b.binding, visibility: STAGE_COMPUTE, buffer: { type: b.access === 'in' ? 'read-only-storage' : 'storage' } }));
            entries.push({ binding: uni.binding, visibility: STAGE_COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: uniformBytes } });
            const key = JSON.stringify(entries);
            let bgl = layouts.get(key);
            if (!bgl) { bgl = gdev.createBindGroupLayout({ entries }); layouts.set(key, bgl); }
            const mod = gdev.createShaderModule({ code: w.code, label: 'kir:' + kernel.name });
            const pipeline = gdev.createComputePipeline({ layout: gdev.createPipelineLayout({ bindGroupLayouts: [bgl] }), compute: { module: mod, entryPoint: 'main' } });
            stats.pipelines++;
            const p = { name: kernel.name, wg, pipeline, bgl, scalars, uniformBytes, bufs: bufs.map((b) => ({ name: b.name, binding: b.binding, access: b.access, elem: b.elem })), uniBinding: uni.binding, bg: new Map() };
            m.set(wg, p); allProgs.push(p);
            return p;
        };
        // 非同步版：用 validation error scope 確認 WGSL 與 pipeline 真的通過（失敗丟例外）
        const prepare = async (kernel, wg) => {
            live();
            gdev.pushErrorScope('validation');
            const p = build(kernel, wg);
            const err = await gdev.popErrorScope();
            if (err) throw new Error('WGSL 編譯或 pipeline 建立失敗（工作群 ' + wg + '）：' + String(err.message).slice(0, 300));
            return p;
        };
        const bindGroupFor = (p, binds) => {
            const parts = p.bufs.map((q) => { const b = binds[q.name]; return b.id + '@' + b.offset; });
            const key = parts.join('|');
            let bg = p.bg.get(key);
            if (bg) return bg;
            const entries = p.bufs.map((q) => { const b = binds[q.name]; return { binding: q.binding, resource: { buffer: b.gbuf, offset: b.offset, size: b.bytes } }; });
            entries.push({ binding: p.uniBinding, resource: { buffer: ring, offset: 0, size: p.uniformBytes } });
            bg = gdev.createBindGroup({ layout: p.bgl, entries });
            stats.bindGroups++;
            if (p.bg.size >= BG_CACHE_MAX) p.bg.clear();
            p.bg.set(key, bg);
            return bg;
        };

        // ---- 派送（不讀回）
        const dispatchWg = (kernel, binds, scalars, N, wg, outArg) => {
            live();
            const p = build(kernel, wg);
            if (!Number.isInteger(N) || N < 1) throw new Error('dispatch：N 要是正整數');
            const outQ = p.bufs.find((q) => q.access === 'out');
            if (!outQ) throw new Error('核心沒有輸出緩衝區');
            const out = binds[outQ.name];
            if (!out || out.freed) throw new Error('輸出緩衝區 ' + outQ.name + ' 缺少或已釋放');
            if (outArg !== undefined && outArg !== out) throw new Error('out 參數與 binds 裡的輸出 ' + outQ.name + ' 不是同一個緩衝區');
            if (out.N < N) throw new Error('輸出 ' + outQ.name + ' 的大小 ' + out.N + ' 小於 N=' + N);
            if (out.elem !== outQ.elem) throw new Error('輸出型別不符');
            const oa = out.offset, ob = out.offset + out.bytes;
            for (const q of p.bufs) {
                if (q.access !== 'in') continue;
                const b = binds[q.name];
                if (!b || b.freed) throw new Error('缺少輸入緩衝區 ' + q.name);
                if (b.N < N || b.elem !== q.elem) throw new Error('輸入 ' + q.name + ' 的大小不足或型別不符');
                if (b.gbuf === out.gbuf && b.offset < ob && oa < b.offset + b.bytes) throw new Error('輸出與輸入 ' + q.name + ' 的位元組範圍重疊（用法衝突），拒絕');
            }
            for (const s of p.scalars) if (!(s.name in scalars)) throw new Error('缺少純量 ' + s.name);
            if (pending >= MAX_PER_SUBMIT || slot >= SLOTS) flush();
            const off = slot * SLOT; slot++;
            const dv = new DataView(new ArrayBuffer(p.uniformBytes));
            p.scalars.forEach((s, i) => { if (s.type === 'i32') dv.setInt32(4 * i, scalars[s.name] | 0, true); else dv.setFloat32(4 * i, Number(scalars[s.name]), true); });
            dv.setInt32(4 * p.scalars.length, N, true);
            gdev.queue.writeBuffer(ring, off, dv.buffer);
            const bg = bindGroupFor(p, binds);
            const groups = Math.ceil(N / wg);
            if (groups > MAX_DIM * MAX_DIM) throw new Error('N 太大（工作群數超過二維上限）');
            const gx = Math.min(groups, MAX_DIM), gy = Math.ceil(groups / MAX_DIM);
            const pass = encoder().beginComputePass();
            pass.setPipeline(p.pipeline);
            pass.setBindGroup(0, bg, [off]);
            pass.dispatchWorkgroups(gx, gy);
            pass.end();
            pending++; stats.dispatches++;
        };
        const wgFor = (kernel) => wgOf.get(kernel) || wgDefault;
        // 呼叫格式與 runGl／WebGL2 裝置相同：out 必須就是 binds 裡輸出參數的那個緩衝區
        const dispatch = (kernel, binds, out, scalars, N) => dispatchWg(kernel, binds, scalars, N, wgFor(kernel), out);
        const setWorkgroup = (kernel, wg) => { if (!cands.includes(wg) && !(o.allowAnyWg)) throw new Error('工作群大小 ' + wg + ' 不在候選中'); wgOf.set(kernel, wg); };

        // ---- 實測（只在呼叫時做；每個候選都先 prepare，再計時）
        const tune = async (kernel, N, t) => {
            live();
            const reps = (t && t.reps) || 8, scalars = (t && t.scalars) || {};
            const binds = {}; const scratch = [];
            try {
                for (const pr of kernel.params) if (pr.kind === 'buf') {
                    const b = alloc(N, pr.elem); scratch.push(b); binds[pr.name] = b;
                    const n = N * compsOf(pr.elem), arr = new Float32Array(n);
                    if (pr.access === 'in') for (let i = 0; i < n; i++) arr[i] = ((i * 2654435761) >>> 0) % 1000 / 1000;   // 固定的假資料
                    if (pr.access === 'in') upload(b, arr);
                }
                const times = {};
                for (const wg of cands) {
                    await prepare(kernel, wg);
                    dispatchWg(kernel, binds, scalars, N, wg); flush(); await gdev.queue.onSubmittedWorkDone();   // 熱機
                    const t0 = performance.now();
                    for (let r = 0; r < reps; r++) dispatchWg(kernel, binds, scalars, N, wg, binds[kernel.params.find((q) => q.access === 'out').name]);
                    flush(); await gdev.queue.onSubmittedWorkDone();
                    times[wg] = (performance.now() - t0) / reps;
                }
                let best = cands[0]; for (const wg of cands) if (times[wg] < times[best]) best = wg;
                stats.tuned++;
                return { best, times, N, reps };
            } finally {
                for (const b of scratch) free(b);
            }
        };
        const tuneKey = (adapterKey, kernel, N) => 'kirwg:' + adapterKey + ':' + kernel.name + ':' + Math.ceil(Math.log2(Math.max(1, N)));
        const ensureTuned = async (kernel, N, t) => {
            const st = t && t.store, key = tuneKey((t && t.adapterKey) || 'unknown', kernel, N);
            if (st) { const hit = await st.get(key); if (hit && cands.includes(hit.best)) { wgOf.set(kernel, hit.best); return { best: hit.best, cached: true, times: hit.times }; } }
            const r = await tune(kernel, N, t);
            wgOf.set(kernel, r.best);
            if (st) await st.set(key, { best: r.best, times: r.times, N: r.N, reps: r.reps, at: Date.now() });
            return Object.assign({ cached: false }, r);
        };
        // 送出所有排著的派送並等它們完成（給量測與測試用）
        const sync = async () => { flush(); await gdev.queue.onSubmittedWorkDone(); };

        return {
            alloc, allocPacked, view, upload, download, dispatch, free, prepare, tune, ensureTuned, setWorkgroup, wgFor, flush, sync, tuneKey,
            stats, get lost() { return lost; }, wgCandidates: cands.slice()
        };
    }

    return { supportsWebGPU, createDevice, USAGE, SLOT, ALIGN };
});
