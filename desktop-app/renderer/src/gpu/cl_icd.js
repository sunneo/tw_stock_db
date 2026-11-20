/* OpenCL 的 ICD 載入器＋驅動介面（FaClIcd，UMD，純邏輯、不碰 DOM）。設計見 DESIGN.pyopencl.md。
 *
 * 分層（跟真的 OpenCL 一樣：介面是主導，實作由驅動提供）：
 *   介面層（呼叫端）  pyopencl 相容模組（Python）、llvm_host 的 cl* C API（之後遷移，見 DESIGN.pyopencl.md §6）
 *        ↓ 都只呼叫載入器的物件 API（平台、裝置、內容、佇列、記憶體、程式、核心、事件）
 *   載入器（本檔）    ICD 登記表（registerDriver，相當於 /etc/OpenCL/vendors/*.icd）＋ 執行期優化器（跟驅動無關）
 *        ↓ 派送到物件所屬的驅動（相當於 ICD 的 dispatch table）
 *   驅動（vendor）    makeKirDriver：OpenCL C 子集 → KIR → 裝置（WebGPU／WebGL2／JS，由呼叫端注入）；介面見下
 *
 * 驅動介面 drv：
 *   { name, vendor, version, device:{ name, type:'GPU'|'CPU', maxWorkGroupSize, globalMemSize, maxMemAllocSize }, extensions,
 *     compile(src, options) → { ok, kernels:{ 名: { params:[{name, kind:'buf'|'scalar', type:'f32'|'i32', access:'in'|'out'}] } }, log },
 *     alloc(nbytes) → h,  upload(h, Uint8Array),  download(h) → Uint8Array | Promise<Uint8Array>,  free(h),
 *     launch(program, kernelName, binds:{參數名→h}, scalars:{參數名→數}, globalSize) }
 *
 * 路由（驅動可選）：drv.route(kernelDef, info) → 'dev'（在裝置上跑：緩衝區常駐裝置）或 'host'（直接在主機副本上跑，零傳輸）；沒有 route 就看 kernelDef.host。
 *   info＝{ N, dims, offset, devOnly（有輸入緩衝區只有裝置副本是新的）}。host 路線呼叫 drv.launchHost(program, name, hostBinds, scalars, N, nd)。
 *   GPU 驅動（makeGpuDriver）用它做「異質」決定：KIR 能編譯且夠大 → WebGPU／WebGL2（cudaweb 的 KIR 裝置層）；很小的問題或多維／offset／KIR 不收的核心 → 主機（clc），省掉派送與傳輸成本。
 * 執行期優化（驅動無關，都有計數器 stats()，測試用它證明有效）：
 *   1. 建置快取：相同的（原始碼＋選項）只編譯一次，跨 Program 物件共用（Python 腳本常在迴圈裡重建 Program）。
 *   2. 主機／裝置副本延遲同步：寫入只動主機副本並標記裝置過期；核心要用時才上傳；讀回只在主機副本過期時才下載。
 *   3. 內容未變的重複寫入不上傳（雜湊比對，≤ 4 MB）。
 *   4. 純輸出緩衝區（核心只寫不讀）且主機端從沒寫過內容 → 不上傳，只配置；寫過的（可能只被核心寫一部分）仍上傳，免得其餘部分變成零。執行後標記主機副本過期。
 *   5. 核心的參數檢查與綁定在 setArg 時完成一次，launch 時只組裝。
 *   尚未做（設計在 DESIGN.pyopencl.md §5）：佇列層的逐元素核心融合、依量測自動選驅動（異質）、工作群大小自適應。
 * KIR 驅動只有 float32／int32（超出範圍由 compile 回報 CL_BUILD_PROGRAM_FAILURE 與記錄）；clc 驅動（makeClcDriver）有完整的最小檔 OpenCL C。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaClIcd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 錯誤碼與名稱（與 OpenCL 標頭一致，pyopencl 的例外也用這些）
    const CODES = { DEVICE_NOT_FOUND: -1, BUILD_PROGRAM_FAILURE: -11, INVALID_VALUE: -30, INVALID_PLATFORM: -32, INVALID_DEVICE: -33, INVALID_CONTEXT: -34, INVALID_COMMAND_QUEUE: -36, INVALID_MEM_OBJECT: -38, INVALID_PROGRAM: -44, INVALID_PROGRAM_EXECUTABLE: -45, INVALID_KERNEL_NAME: -46, INVALID_KERNEL: -48, INVALID_ARG_INDEX: -49, INVALID_ARG_VALUE: -50, INVALID_ARG_SIZE: -51, INVALID_KERNEL_ARGS: -52, INVALID_WORK_DIMENSION: -53, INVALID_WORK_GROUP_SIZE: -54, INVALID_GLOBAL_OFFSET: -56, INVALID_BUFFER_SIZE: -61, INVALID_GLOBAL_WORK_SIZE: -63, OUT_OF_RESOURCES: -5, MEM_OBJECT_ALLOCATION_FAILURE: -4, IMAGE_FORMAT_MISMATCH: -9, IMAGE_FORMAT_NOT_SUPPORTED: -10, INVALID_HOST_PTR: -37, INVALID_IMAGE_SIZE: -40, INVALID_SAMPLER: -41, INVALID_OPERATION: -59, INVALID_IMAGE_DESCRIPTOR: -65, INVALID_PIPE_SIZE: -69 };
    class ClError extends Error { constructor(name, msg) { super(name + (msg ? '：' + msg : '')); this.name = 'ClError'; this.clName = name; this.code = CODES[name] != null ? CODES[name] : -9999; } }
    const fail = (name, msg) => { throw new ClError(name, msg); };

    // 內容雜湊（FNV-1a，逐 32 位元字；只用來判斷「內容有沒有變」，不是安全用途）
    function hashBytes(u8) {
        let h = 0x811c9dc5 >>> 0; const n = u8.length, w = n >>> 2, dv = new DataView(u8.buffer, u8.byteOffset, n);
        for (let i = 0; i < w; i++) { h ^= dv.getUint32(i * 4, true); h = Math.imul(h, 0x01000193) >>> 0; }
        for (let i = w * 4; i < n; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; }
        return h + ':' + n;
    }
    const strHash = (s) => { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h + ':' + s.length; };
    const HASH_LIMIT = 4 << 20;

    // ======================================================================================
    // 載入器
    // ======================================================================================
    function createLoader(o) {
        o = o || {};
        const now = o.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
        const drivers = [], st = { builds: 0, buildHits: 0, uploads: 0, uploadBytes: 0, downloads: 0, downloadBytes: 0, launches: 0, elidedUploads: 0, skippedOutputUploads: 0, lazyReadsServedFromHost: 0, routedDev: 0, routedHost: 0 };
        let seq = 0; const nid = () => ++seq;
        const buildCache = new Map();   // 驅動名＋雜湊 → compile 結果

        // ---- ICD 登記 ----
        function registerDriver(drv) {
            if (!drv || !drv.name || typeof drv.compile !== 'function') fail('INVALID_VALUE', '驅動缺 name 或 compile');
            if (drivers.some((d) => d.drv.name === drv.name)) fail('INVALID_VALUE', '驅動 ' + drv.name + ' 已登記');
            let probe = { ok: true }; if (typeof drv.probe === 'function') { try { probe = drv.probe() || { ok: true }; } catch (e) { probe = { ok: false, reason: String(e.message || e) }; } }
            drivers.push({ drv, probe, platform: { id: nid(), kind: 'platform', name: drv.name, vendor: drv.vendor || drv.name, version: 'OpenCL 1.2 FA-ICD', profile: 'FULL_PROFILE', extensions: drv.extensions || '', drv }, device: { id: nid(), kind: 'device', drv, info: drv.device || { name: drv.name, type: 'CPU' } } });
            drivers[drivers.length - 1].device.platform = drivers[drivers.length - 1].platform;
            return drivers[drivers.length - 1].platform;
        }
        const entry = (drv) => drivers.find((e) => e.drv === drv);
        const platforms = () => drivers.filter((e) => e.probe.ok !== false).map((e) => e.platform);
        const probeReport = () => drivers.map((e) => ({ name: e.drv.name, ok: e.probe.ok !== false, reason: e.probe.reason || '' }));
        function devices(platform, type) {
            const e = drivers.find((x) => x.platform === platform); if (!e) fail('INVALID_PLATFORM');
            const t = (type || 'ALL').toUpperCase(); const dt = (e.device.info.type || 'CPU').toUpperCase();
            if (t !== 'ALL' && t !== 'DEFAULT' && t !== dt) fail('DEVICE_NOT_FOUND', '平台 ' + platform.name + ' 沒有 ' + t + ' 裝置');
            return [e.device];
        }

        // ---- 內容／佇列 ----
        function createContext(devs) {
            if (!devs || !devs.length) fail('INVALID_VALUE', '沒有裝置');
            const d = devs[0]; if (d.kind !== 'device') fail('INVALID_DEVICE');
            if (devs.some((x) => x.drv !== d.drv)) fail('INVALID_DEVICE', '一個內容的裝置要屬於同一個平台（OpenCL 規定）');
            return { id: nid(), kind: 'context', devices: devs, drv: d.drv, mems: new Set() };
        }
        const needCtx = (c) => { if (!c || c.kind !== 'context' || c.released) fail('INVALID_CONTEXT'); return c; };
        function createQueue(ctx, dev, props) { needCtx(ctx); if (dev && dev.drv !== ctx.drv) fail('INVALID_DEVICE'); return { id: nid(), kind: 'queue', ctx, drv: ctx.drv, profiling: !!(props && props.profiling), events: [] }; }
        const needQ = (q) => { if (!q || q.kind !== 'queue' || q.released) fail('INVALID_COMMAND_QUEUE'); return q; };

        // ---- 記憶體：主機副本（Uint8Array，永遠存在）＋裝置副本（延遲） ----
        // 狀態：hostOk＝主機副本是最新的；devOk＝裝置副本是最新的；兩者可同時為真。lastUp＝上次上傳內容的雜湊（略過相同內容）。
        function createBuffer(ctx, flags, size, hostData) {
            needCtx(ctx); size = Number(size); if (!(size > 0)) fail('INVALID_BUFFER_SIZE');
            const m = { id: nid(), kind: 'mem', ctx, drv: ctx.drv, size, host: new Uint8Array(size), dev: null, hostOk: true, devOk: false, lastUp: null, hostWritten: false, ver: 0, flags: flags || {} };   // ver：內容版本號（每次寫入、複製進來、核心寫過就加一；GL 互通用它判斷 CL 有沒有改過）
            if (hostData) { const src = hostData instanceof Uint8Array ? hostData : new Uint8Array(hostData.buffer || hostData, hostData.byteOffset || 0, hostData.byteLength); if (src.length < size) fail('INVALID_VALUE', 'hostbuf 比 size 小'); m.host.set(src.subarray(0, size)); m.hostWritten = true; }
            ctx.mems.add(m); return m;
        }
        // 圖像：一塊緊密排列的緩衝區（x 最快、再 y、再 z／層）加上描述 img＝{ type, w, h, d, order, chType, elem }。讀寫複製與緩衝區共用同一套主機／裝置副本機制；核心一律走主機路線（clc 的 read_image／write_image）。
        function createImage(ctx, flags, meta, hostData) {
            const m = createBuffer(ctx, flags, meta.w * meta.h * meta.d * meta.elem, hostData); m.img = Object.assign({}, meta); m.host.img = m.img; return m;
        }
        // Pipe（OpenCL 2.0）：一塊緩衝區，[讀計數][寫計數] 各 4 位元組後面接 max 個封包；核心走主機路線（clc 的 read_pipe／write_pipe）。主機端不能直接讀寫 pipe（規格也是）
        function createPipe(ctx, flags, packetSize, maxPackets) {
            packetSize = Number(packetSize); maxPackets = Number(maxPackets); if (!(packetSize > 0) || !(maxPackets > 0)) fail('INVALID_PIPE_SIZE', 'packet_size 與 max_packets 要大於 0');
            const m = createBuffer(ctx, flags, 8 + packetSize * maxPackets, null); m.pipe = { ps: packetSize, max: maxPackets }; m.host.pipe = m.pipe; return m;
        }
        // IMAGE1D_BUFFER：圖像與緩衝區共用同一塊記憶體（寫一邊另一邊看得到）；結構同子緩衝區（root＋偏移），另帶 img 描述
        function createImageOnBuffer(parent, meta) {
            if (!parent || parent.kind !== 'mem' || parent.released || parent.root || parent.img) fail('INVALID_MEM_OBJECT', 'IMAGE1D_BUFFER 要建在一般緩衝區上');
            const size = meta.w * meta.elem; if (size > parent.size) fail('INVALID_IMAGE_SIZE', '圖像（' + size + ' 位元組）比緩衝區（' + parent.size + '）大');
            return { id: nid(), kind: 'mem', ctx: parent.ctx, drv: parent.drv, size, root: parent, offset: 0, flags: parent.flags, released: false, img: Object.assign({}, meta) };
        }
        // 子緩衝區：與父緩衝區共用同一塊記憶體（父的 [origin, origin+size)）。狀態（主機／裝置副本）都記在父緩衝區上；讀寫複製轉成父＋偏移，
        // 核心參數走主機路線並帶位元組偏移（GPU 路線沒有偏移，所以子緩衝區一律走主機）
        function createSubBuffer(parent, origin, size, flags) {
            if (!parent || parent.kind !== 'mem' || parent.released) fail('INVALID_MEM_OBJECT'); if (parent.root) fail('INVALID_MEM_OBJECT', '子緩衝區的子緩衝區不合法');
            origin = Number(origin); size = Number(size); if (!(size > 0)) fail('INVALID_BUFFER_SIZE'); if (origin < 0 || origin + size > parent.size) fail('INVALID_VALUE', '子緩衝區範圍 [' + origin + ', ' + (origin + size) + ') 超出父緩衝區（' + parent.size + '）');
            return { id: nid(), kind: 'mem', ctx: parent.ctx, drv: parent.drv, size, root: parent, offset: origin, flags: flags || parent.flags, released: false };
        }
        const needMem = (m) => { if (!m || m.kind !== 'mem' || m.released) fail('INVALID_MEM_OBJECT'); return m; };
        const ensureDevHandle = (m) => { if (m.dev == null) m.dev = m.drv.alloc(m.size); return m.dev; };
        // 裝置副本過期 → 上傳（內容與上次上傳相同就略過）
        function toDevice(m) {
            ensureDevHandle(m); if (m.devOk) return;
            let key = null; if (m.size <= HASH_LIMIT) { key = hashBytes(m.host); if (key === m.lastUp) { m.devOk = true; st.elidedUploads++; return; } }
            m.drv.upload(m.dev, m.host); m.lastUp = key; m.devOk = true; st.uploads++; st.uploadBytes += m.size;
        }
        // 主機副本過期 → 下載
        async function toHost(m) {
            if (m.hostOk) { st.lazyReadsServedFromHost++; return; }
            const got = await m.drv.download(m.dev); m.host.set(got.subarray(0, m.size)); m.hostOk = true; m.lastUp = null; st.downloads++; st.downloadBytes += m.size;
        }
        function checkRange(m, off, n) { if (off < 0 || n < 0 || off + n > m.size) fail('INVALID_VALUE', '範圍超出緩衝區（offset ' + off + ' + ' + n + ' > ' + m.size + '）'); }

        async function enqueueWrite(q, m, data, offset) {
            needQ(q); needMem(m); offset = Number(offset || 0); const src = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength); checkRange(m, offset, src.length);
            const R = m.root || m, at = offset + (m.offset || 0);
            if (!R.hostOk) await toHost(R);          // 部分寫入前要先有最新的主機副本
            R.host.set(src, at); R.hostOk = true; R.devOk = false; R.hostWritten = true; R.ver++;   // 只動主機副本；裝置副本等核心要用時才上傳（優化 2、3）
            return mkEvent(q, 'write');
        }
        async function enqueueRead(q, m, size, offset) {
            needQ(q); needMem(m); offset = Number(offset || 0); size = size == null ? m.size - offset : Number(size); checkRange(m, offset, size);
            const R = m.root || m, at = offset + (m.offset || 0);
            await toHost(R); const ev = mkEvent(q, 'read'); return { data: R.host.slice(at, at + size), event: ev };
        }
        async function enqueueCopy(q, src, dst, size, srcOff, dstOff) {
            needQ(q); needMem(src); needMem(dst); size = size == null ? Math.min(src.size, dst.size) : Number(size); srcOff = Number(srcOff || 0); dstOff = Number(dstOff || 0); checkRange(src, srcOff, size); checkRange(dst, dstOff, size);
            const SR = src.root || src, DR = dst.root || dst, so = srcOff + (src.offset || 0), dof = dstOff + (dst.offset || 0);
            await toHost(SR); if (!DR.hostOk) await toHost(DR); DR.host.set(SR.host.slice(so, so + size), dof); DR.hostOk = true; DR.devOk = false; DR.hostWritten = true; DR.ver++; return mkEvent(q, 'copy');
        }
        function releaseMem(m) { if (!m || m.released) return; m.released = true; if (m.root) return; /* 子緩衝區只是父緩衝區的視圖 */ if (m.dev != null) { try { m.drv.free(m.dev); } catch (_) { /* 釋放失敗不影響結果 */ } m.dev = null; } m.ctx.mems.delete(m); }

        // ---- 程式／核心 ----
        function createProgram(ctx, src) { needCtx(ctx); return { id: nid(), kind: 'program', ctx, drv: ctx.drv, src: String(src), built: null, log: '', options: '' }; }
        const needProg = (p) => { if (!p || p.kind !== 'program') fail('INVALID_PROGRAM'); return p; };
        function build(prog, options) {
            needProg(prog); options = String(options || ''); const key = prog.drv.name + '|' + strHash(prog.src + '\u0000' + options);
            let r = buildCache.get(key);
            if (r) st.buildHits++; else { st.builds++; r = prog.drv.compile(prog.src, options); buildCache.set(key, r); }   // 優化 1：失敗的結果也快取（同一份壞原始碼不重編）
            prog.options = options; prog.log = r.log || '';
            if (!r.ok) { prog.built = null; fail('BUILD_PROGRAM_FAILURE', r.log); }
            prog.built = r; return prog;
        }
        const kernelNames = (prog) => { if (!prog.built) fail('INVALID_PROGRAM_EXECUTABLE', '程式還沒有 build'); return Object.keys(prog.built.kernels); };
        function createKernel(prog, name) {
            needProg(prog); if (!prog.built) fail('INVALID_PROGRAM_EXECUTABLE', '程式還沒有 build'); const k = prog.built.kernels[name]; if (!k) fail('INVALID_KERNEL_NAME', name);
            return { id: nid(), kind: 'kernel', prog, drv: prog.drv, name, def: k, args: new Array(k.params.length).fill(undefined) };
        }
        const needKern = (k) => { if (!k || k.kind !== 'kernel') fail('INVALID_KERNEL'); return k; };
        function setArg(k, idx, value) {
            needKern(k); if (!(idx >= 0 && idx < k.def.params.length)) fail('INVALID_ARG_INDEX', '核心 ' + k.name + ' 只有 ' + k.def.params.length + ' 個參數'); const p = k.def.params[idx];
            if (p.kind === 'local') { const n = value && value.local; if (!(n > 0) || !Number.isInteger(n)) fail('INVALID_ARG_SIZE', '__local 參數 ' + p.name + ' 要傳 {local: 位元組數}（pyopencl 的 LocalMemory(size)）'); k.args[idx] = { local: n }; return; }
            if (value && value.local !== undefined) fail('INVALID_ARG_VALUE', '參數 ' + p.name + ' 不是 __local 指標，不能傳 LocalMemory');
            if (p.kind === 'pipe') { if (!value || value.kind !== 'mem' || !value.pipe) fail('INVALID_MEM_OBJECT', '參數 ' + p.name + ' 要傳 Pipe'); if (value.drv !== k.drv) fail('INVALID_MEM_OBJECT', 'Pipe 屬於別的平台'); if (p.size && value.pipe.ps !== p.size) fail('INVALID_ARG_SIZE', '參數 ' + p.name + ' 的封包是 ' + p.size + ' 位元組，Pipe 的 packet_size 是 ' + value.pipe.ps); k.args[idx] = { mem: value }; return; }
            if ((p.kind === 'buf' || p.kind === 'image') && value && value.pipe) fail('INVALID_MEM_OBJECT', '參數 ' + p.name + ' 不是 pipe，不能傳 Pipe');
            if (p.kind === 'image') { if (!value || value.kind !== 'mem' || !value.img) fail('INVALID_MEM_OBJECT', '參數 ' + p.name + ' 要傳圖像'); if (value.drv !== k.drv) fail('INVALID_MEM_OBJECT', '圖像屬於別的平台'); if (value.img.type !== p.type) fail('INVALID_MEM_OBJECT', '參數 ' + p.name + ' 是 ' + p.type + '_t，傳進來的是 ' + value.img.type); k.args[idx] = { mem: value }; return; }
            if (p.kind === 'buf' && value && value.img) fail('INVALID_MEM_OBJECT', '參數 ' + p.name + ' 是緩衝區指標，不能傳圖像');
            if (p.kind === 'buf') { if (!value || value.kind !== 'mem') fail('INVALID_MEM_OBJECT', '參數 ' + p.name + ' 要傳緩衝區'); if (value.drv !== k.drv) fail('INVALID_MEM_OBJECT', '緩衝區屬於別的平台'); k.args[idx] = { mem: value }; }
            else if (Array.isArray(value)) { if (!value.every((x) => Number.isFinite(Number(x)))) fail('INVALID_ARG_VALUE', '向量參數 ' + p.name + ' 的元素要是數字'); k.args[idx] = { scalar: k.drv.coerceScalar ? k.drv.coerceScalar(p.type, value) : value.map(Number) }; }
            else { const v = Number(value); if (!Number.isFinite(v)) fail('INVALID_ARG_VALUE', '參數 ' + p.name + ' 要傳數字'); k.args[idx] = { scalar: k.drv.coerceScalar ? k.drv.coerceScalar(p.type, v) : (p.type === 'i32' ? (v | 0) : Math.fround(v)) }; }
        }
        async function enqueueNDRange(q, k, globalSize, localSize, globalOffset) {
            needQ(q); needKern(k); if (k.drv !== q.drv) fail('INVALID_KERNEL', '核心與佇列不在同一個平台');
            const maxDims = k.drv.maxDims || 1;
            const gs = (Array.isArray(globalSize) ? globalSize : [globalSize]).map(Number); if (gs.length < 1 || gs.length > 3 || gs.length > maxDims) fail('INVALID_WORK_DIMENSION', '這個驅動最多 ' + maxDims + ' 維（得到 ' + gs.length + ' 維）');
            if (gs.some((x) => !(x > 0) || !Number.isInteger(x))) fail('INVALID_GLOBAL_WORK_SIZE', 'global size 要是正整數');
            const N = gs.reduce((x, y) => x * y, 1);
            let ls = null; if (localSize != null) { ls = (Array.isArray(localSize) ? localSize : [localSize]).map(Number); if (ls.length !== gs.length) fail('INVALID_WORK_DIMENSION', 'local 與 global 的維度不同'); ls.forEach((l, d) => { if (l && gs[d] % l) fail('INVALID_WORK_GROUP_SIZE', 'global size ' + gs[d] + ' 不是 local size ' + l + ' 的整數倍'); }); }
            let off = null; if (globalOffset != null) { off = (Array.isArray(globalOffset) ? globalOffset : [globalOffset]).map(Number); if (off.some((x) => x)) { if (!k.drv.supportsOffset) fail('INVALID_GLOBAL_OFFSET', '這個驅動不支援 global_work_offset'); } else off = null; }
            if (k.args.some((a) => a === undefined)) fail('INVALID_KERNEL_ARGS', '還有參數沒設定：' + k.def.params.filter((p, i) => k.args[i] === undefined).map((p) => p.name).join('、'));
            const binds = {}, scalars = {}, outs = [], rws = [], bufArgs = []; let hasImg = false;
            for (let i = 0; i < k.def.params.length; i++) {
                const p = k.def.params[i], a = k.args[i];
                if (p.kind === 'scalar') { scalars[p.name] = a.scalar; continue; }
                if (p.kind === 'local') { scalars[p.name] = a.local; continue; }   // __local 指標參數：驅動收到位元組數，每個工作群配一塊
                const R = a.mem.root || a.mem; if (!R.hostOk && !R.devOk) fail('INVALID_MEM_OBJECT', '緩衝區沒有有效資料'); if (p.kind === 'image' || p.kind === 'pipe') hasImg = true;
                bufArgs.push({ p, m: R, sub: a.mem.root ? a.mem : null });
            }
            // 路由：裝置（GPU）或主機。主機路線直接在主機副本上跑，不配置、不上傳；裝置路線讓緩衝區常駐裝置
            const info = { N, dims: gs.length, offset: !!off, devOnly: bufArgs.some((x) => !x.m.hostOk && x.m.devOk) };
            let route = k.drv.route ? k.drv.route(k.def, info) : (k.def.host ? 'host' : 'dev');
            if (bufArgs.some((x) => x.sub) || hasImg) route = 'host';   // 圖像也只走主機路線   // 子緩衝區（要位元組偏移）一律走主機路線
            const t0 = now(); let res;
            const mark = (m) => { m.devOk = true; m.hostOk = false; m.lastUp = null; m.ver++; };
            if (route === 'host') {
                if (!k.drv.launchHost) fail('INVALID_KERNEL', '驅動沒有主機路線');
                const hostBinds = {};
                for (const x of bufArgs) { if (!x.m.hostOk) await toHost(x.m); hostBinds[x.p.name] = x.sub ? x.m.host.subarray(x.sub.offset, x.sub.offset + x.sub.size) : x.m.host; if (x.sub && x.sub.img) hostBinds[x.p.name].img = x.sub.img; }
                res = await k.drv.launchHost(k.prog.built, k.name, hostBinds, scalars, N, { gs, ls, off });
                const wr = res && Array.isArray(res.written) ? new Set(res.written) : null;
                for (const x of bufArgs) if (x.p.access !== 'in' && (!wr || wr.has(x.p.name))) { x.m.hostOk = true; x.m.devOk = false; x.m.hostWritten = true; x.m.lastUp = null; x.m.ver++; }
                st.routedHost++;
            } else {
                for (const x of bufArgs) {
                    const { p, m } = x;
                    // 優化 4：純輸出且主機端從沒寫過內容（內容未定義）→ 只配置、不上傳。主機端寫過的（可能只被核心寫一部分，其餘要保留）仍要上傳，否則會變成零。
                    if (p.access === 'out') { ensureDevHandle(m); outs.push(m); if (m.hostWritten || m.devOk) { if (!m.devOk) toDevice(m); } else st.skippedOutputUploads++; }
                    else { if (!m.devOk) toDevice(m); if (p.access === 'rw') rws.push({ name: p.name, m }); }
                    binds[p.name] = m.dev;
                }
                res = await k.drv.launch(k.prog.built, k.name, binds, scalars, N, { gs, ls, off });
                outs.forEach(mark);
                // 讀寫參數：驅動能回報哪些緩衝區真的被寫過（res.written＝參數名清單）就只標那些；否則保守地全部當成被改過
                const written = res && Array.isArray(res.written) ? new Set(res.written) : null;
                rws.forEach((x) => { if (!written || written.has(x.name)) mark(x.m); });
                st.routedDev++;
            }
            const t1 = now(); st.launches++;
            const ev = mkEvent(q, 'kernel'); ev.start = t0; ev.end = t1; return ev;
        }
        function mkEvent(q, kind) { const t = now(); const ev = { id: nid(), kind: 'event', cmd: kind, queued: t, start: t, end: t, status: 'complete' }; if (q.profiling) q.events.push(ev); return ev; }
        async function finish(q) { needQ(q); if (q.drv.finish) await q.drv.finish(); }
        function stats() { return Object.assign({}, st, { driverCount: drivers.length, buildCacheSize: buildCache.size }); }
        function resetStats() { Object.keys(st).forEach((k) => { st[k] = 0; }); }

        return { createPipe, createImage, createImageOnBuffer, createSubBuffer, registerDriver, platforms, probeReport, devices, createContext, createQueue, createBuffer, enqueueWrite, enqueueRead, enqueueCopy, releaseMem, createProgram, build, kernelNames, createKernel, setArg, enqueueNDRange, finish, stats, resetStats };
    }

    // ======================================================================================
    // 驅動：OpenCL C 子集 → KIR → 裝置
    //   mods：{ FaClFront, FaKir }；device（選用）：KIR 裝置介面 { alloc(N,'f32'), upload(b,Float32Array), download(b), dispatch(k,binds,out,scal,N), free(b) }，
    //   沒給就用內建的 JS 裝置（主機陣列＋FaKir.runJs，同一個介面，所以路徑一致、計數器有效）。
    // ======================================================================================
    function jsDevice(FaKir) {
        return {
            alloc: (N) => ({ a: new Float32Array(N) }),
            upload: (b, f) => { b.a.set(f.subarray(0, b.a.length)); },
            download: (b) => b.a.slice(),
            dispatch: (k, binds, out, scal, N) => { const bufs = {}; for (const key of Object.keys(binds)) bufs[key] = binds[key].a; FaKir.runJs(k, bufs, scal, N); },
            free: () => {}
        };
    }
    // 刪掉「沒被任何地方引用」的全域純量常數宣告（例如 `__constant int pyopencl_defeat_cache_ab12 = 0;`——pyopencl 的編譯器快取會在原始碼尾端追加它）。
    // 語意上安全（死的宣告不影響核心行為），對任何來源都適用；被引用的全域常數不刪，cl_front 仍會如實報「不支援全域變數」。
    function stripDeadGlobals(src) {
        const re = /^[ \t]*(?:__constant|constant)[ \t]+(?:const[ \t]+)?(?:int|uint|float|long|ulong|short|ushort|char|uchar|double)[ \t]+([A-Za-z_]\w*)[ \t]*=[^;{}]*;[ \t]*$/gm;
        let out = String(src), m, changed = true;
        while (changed) {
            changed = false; re.lastIndex = 0;
            while ((m = re.exec(out))) {
                const name = m[1], rest = out.slice(0, m.index) + out.slice(m.index + m[0].length);
                if (!new RegExp('\\b' + name + '\\b').test(rest)) { out = rest; changed = true; break; }
            }
        }
        return out;
    }
    function makeKirDriver(o) {
        const { FaClFront, FaKir } = o.mods || {}; if (!FaClFront || !FaKir) throw new Error('makeKirDriver 需要 mods.FaClFront 與 mods.FaKir');
        const dev = o.device || jsDevice(FaKir), kind = o.kind || 'js';
        const f32 = (u8) => new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >> 2);
        return {
            name: o.name || ('fa-kir-' + kind), vendor: o.vendor || 'Floating Assistant', version: '1.0', extensions: o.extensions || 'cl_khr_fp32',
            device: Object.assign({ name: o.deviceName || ('FA KIR ' + kind), type: o.type || (kind === 'js' ? 'CPU' : 'GPU'), maxWorkGroupSize: 256, globalMemSize: 1 << 30, maxMemAllocSize: 1 << 28 }, o.deviceInfo || {}),
            probe: o.probe,
            compile(src) {
                src = stripDeadGlobals(src);
                const r = FaClFront.parseKernels(src); if (!r.ok) return { ok: false, log: r.error, kernels: {} };
                const kernels = {};
                for (const kir of r.kernels) {
                    const v = FaKir.validate(kir); if (!v.ok) return { ok: false, log: '核心 ' + kir.name + ' 不合法：' + v.errors.join('；'), kernels: {} };
                    kernels[kir.name] = { kir, params: kir.params.map((p) => (p.kind === 'buf' ? { name: p.name, kind: 'buf', type: p.elem, access: p.access } : { name: p.name, kind: 'scalar', type: p.type })) };
                }
                return { ok: true, kernels, log: '' };
            },
            alloc: (nbytes) => dev.alloc(nbytes >> 2, 'f32'),
            upload: (h, u8) => dev.upload(h, f32(u8)),
            download: async (h) => { const r = await dev.download(h); return new Uint8Array(r.buffer, r.byteOffset, r.byteLength); },
            free: (h) => dev.free(h),
            launch: async (program, name, binds, scalars, N) => {
                const k = program.kernels[name].kir, out = k.params.find((p) => p.kind === 'buf' && p.access === 'out');
                await dev.dispatch(k, binds, out ? binds[out.name] : null, scalars, N);
            },
            // 主機路線（子緩衝區需要位元組偏移、或單純想不經裝置）：KIR 的 JS 後端直接跑在主機位元組的 float 視圖上，與裝置路線同一個核心
            launchHost: (program, name, hostBinds, scalars, N) => {
                const k = program.kernels[name].kir, bufs = {}; for (const p of k.params) if (p.kind === 'buf') { const u = hostBinds[p.name]; bufs[p.name] = new Float32Array(u.buffer, u.byteOffset, u.byteLength >> 2); }
                FaKir.runJs(k, bufs, scalars, N); const out = k.params.find((p) => p.kind === 'buf' && p.access === 'out'); return { written: out ? [out.name] : [] };
            }
        };
    }

    // ======================================================================================
    // 驅動：OpenCL C 前端（clc_js.js）→ JS，CPU。裝置記憶體是 ArrayBuffer（位元組定址），所以指標轉型、位元組偏移、任意整數型別都行。
    //   mods：{ FaClc }。維度 1–3、支援 global_work_offset；工作項循序執行（沒有 __local／barrier）。
    // ======================================================================================
    function makeClcDriver(o) {
        const { FaClc } = o.mods || {}; if (!FaClc) throw new Error('makeClcDriver 需要 mods.FaClc');
        return {
            name: o.name || 'fa-cpu-clc', vendor: o.vendor || 'Floating Assistant', version: '1.0', extensions: 'cl_khr_fp64',
            device: Object.assign({ name: o.deviceName || 'FA OpenCL C (CPU, JS)', type: 'CPU', maxWorkGroupSize: 256, globalMemSize: 1 << 30, maxMemAllocSize: 1 << 28 }, o.deviceInfo || {}),
            maxDims: 3, supportsOffset: true, coerceScalar: FaClc.coerceScalar, probe: o.probe,
            compile(src, options) {
                const r = FaClc.compile(src, options); if (!r.ok) return { ok: false, log: r.log, kernels: {} };
                const kernels = {}; for (const n of Object.keys(r.kernels)) kernels[n] = { params: r.kernels[n].params, host: true };   // 全部走主機路線：直接在載入器的主機副本上跑，零傳輸
                return { ok: true, kernels, clc: r, log: '' };
            },
            // 主機路線用不到裝置副本；這幾個只為了介面完整
            alloc: (nbytes) => ({ ab: new ArrayBuffer(nbytes) }), upload: () => {}, download: (h) => new Uint8Array(h.ab).slice(), free: () => {},
            launchHost: (program, name, hostBinds, scalars, N, nd) => runClc(program.clc, program.kernels[name].params, hostBinds, scalars, Object.assign({ name }, nd))
        };
    }
    // 在主機位元組上跑 clc 核心；回傳被寫過的參數名
    function runClc(c, params, hostBinds, scalars, nd) {
        const ptrs = {};
        const args = params.map((p) => { if (p.kind !== 'buf' && p.kind !== 'image' && p.kind !== 'pipe') return scalars[p.name]; const u8 = hostBinds[p.name]; const ptr = c.mkptr(u8.buffer); ptr.o = u8.byteOffset; if (p.kind === 'image') ptr.img = u8.img; if (p.kind === 'pipe') ptr.pipe = u8.pipe; ptr.v.w = false; ptrs[p.name] = ptr; return ptr; });   // 子緩衝區：同一塊記憶體、帶位元組偏移（不複製）
        c.run(nd.name || params.__name, args, nd.gs, nd.ls, nd.off);
        const written = Object.keys(ptrs).filter((n) => ptrs[n].v.w); for (const n of Object.keys(ptrs)) ptrs[n].v.w = false;
        return { written };
    }

    // ======================================================================================
    // 驅動：GPU（WebGPU／WebGL2，cudaweb 的 KIR 裝置層）＋主機退路（clc）。
    //   mods：{ FaClFront, FaKir, FaClc }；device：KIR 裝置（kir_host_hooks.setup 的 hooks.kirDev，WebGPU 或 WebGL2）；backend：'webgpu'|'webgl2'；
    //   canGenerate(kir)（選用）：該後端能不能為這個核心產生程式（WGSL／GLSL）；smallN：小於它且資料在主機時走主機（預設 4096）。
    //   核心編譯兩份：KIR（GPU 路線）與 clc（主機路線，也涵蓋 KIR 不收的核心）。執行期優化見檔頭與 DESIGN.pyopencl.md §10。
    // ======================================================================================
    function makeGpuDriver(o) {
        const { FaClFront, FaKir, FaClc } = o.mods || {}; const dev = o.device;
        if (!FaClFront || !FaKir || !dev) throw new Error('makeGpuDriver 需要 mods.FaClFront、mods.FaKir 與 device');
        const backend = o.backend || 'webgpu', smallN = o.smallN == null ? 4096 : o.smallN;
        const f32 = (u8) => new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength >> 2);
        const kirScalar = { i32: 'int', f32: 'float' };
        const coerce = (type, v) => (FaClc ? FaClc.coerceScalar(kirScalar[type] || type, v) : (type === 'i32' ? (Number(v) | 0) : Math.fround(Number(v))));
        const st = { gpuLaunches: 0, hostLaunches: 0, tuned: 0 };
        const tunedKernels = new Set();
        return {
            name: o.name || ('fa-gpu-' + backend), vendor: 'Floating Assistant', version: '1.0', extensions: 'cl_khr_fp64 cl_khr_global_int32_base_atomics',
            device: Object.assign({ name: o.deviceName || ('FA GPU（' + (backend === 'webgpu' ? 'WebGPU' : 'WebGL2') + '，cudaweb／KIR）'), type: 'GPU', maxWorkGroupSize: 256, globalMemSize: 2 ** 30, maxMemAllocSize: 2 ** 28, maxComputeUnits: 16 }, o.deviceInfo || {}),
            maxDims: 3, supportsOffset: true, coerceScalar: coerce, probe: o.probe, stats: () => Object.assign({}, st),
            compile(src, options) {
                const clean = stripDeadGlobals(src);
                const kr = FaClFront.parseKernels(clean), cr = FaClc ? FaClc.compile(src, options) : { ok: false, log: 'clc 前端不存在', kernels: {} };
                if (!kr.ok && !cr.ok) return { ok: false, log: cr.log + (kr.ok === false ? '\n（GPU 路線：' + kr.error + '）' : ''), kernels: {} };
                const kirBy = {}; if (kr.ok) for (const k of kr.kernels) { if (FaKir.validate(k).ok && (!o.canGenerate || o.canGenerate(k))) kirBy[k.name] = k; }
                const kernels = {}, names = cr.ok ? Object.keys(cr.kernels) : Object.keys(kirBy);
                for (const n of names) {
                    const kir = kirBy[n] || null; let params;
                    if (cr.ok) params = cr.kernels[n].params;
                    else params = kir.params.map((p) => (p.kind === 'buf' ? { name: p.name, kind: 'buf', type: p.elem, access: p.access } : { name: p.name, kind: 'scalar', type: p.type }));
                    // GPU 路線的條件：KIR 核心可用、緩衝區全是 float、剛好一個輸出（KIR 裝置的派送介面一次一個輸出）
                    const outs = kir ? kir.params.filter((p) => p.kind === 'buf' && p.access === 'out') : [];
                    const gpu = !!kir && outs.length === 1 ? { kir, out: outs[0].name } : null;
                    // 裝置路線的輸入／輸出判定用 KIR 的（它看得出「純輸出」，載入器據此不上傳輸出緩衝區）；clc 只看得到 const 與否
                    if (gpu) params = params.map((p) => { const q = p.kind === 'buf' ? kir.params.find((x) => x.name === p.name) : null; return q ? Object.assign({}, p, { access: q.access }) : p; });
                    kernels[n] = { params, gpu, host: !gpu };
                }
                return { ok: true, kernels, clc: cr.ok ? cr : null, log: '' };
            },
            route(def, info) {
                if (!def.gpu) return 'host';
                if (info.dims > 1 || info.offset) return 'host';        // KIR 裝置只有一維、沒有 offset
                if (info.N < smallN && !info.devOnly) return 'host';    // 小問題：派送與傳輸的成本大於計算，主機直接算
                return 'dev';
            },
            alloc: (nbytes) => dev.alloc(Math.max(1, Math.ceil(nbytes / 4)), 'f32'),
            upload: (h, u8) => dev.upload(h, f32(u8)),
            download: async (h) => { const r = await dev.download(h); return new Uint8Array(r.buffer, r.byteOffset, r.byteLength); },
            free: (h) => dev.free(h),
            // 裝置路線：同步編碼、不等 GPU 完成（命令編碼器批次提交；讀回或 finish 才同步）
            launch: async (program, name, binds, scalars, N, nd) => {
                const d = program.kernels[name].gpu;
                if (nd && nd.ls && dev.setWorkgroup && nd.ls[0] > 0) { try { dev.setWorkgroup(d.kir, nd.ls[0]); } catch (_) { /* 工作群大小不合就用裝置的預設／自動調校 */ } }
                if (dev.ensureTuned && !tunedKernels.has(d.kir) && N >= 65536) { tunedKernels.add(d.kir); try { await dev.ensureTuned(d.kir, binds, scalars, N); st.tuned++; } catch (_) { /* 調校失敗不影響結果 */ } }   // 大問題第一次：自動調校工作群大小
                dev.dispatch(d.kir, binds, binds[d.out], scalars, N); st.gpuLaunches++;
                return { written: [d.out] };
            },
            // 主機路線：clc（任何核心）；沒有 clc 時用 KIR 的 JS 後端（只有 float 緩衝區的核心）
            launchHost: (program, name, hostBinds, scalars, N, nd) => {
                st.hostLaunches++;
                const def = program.kernels[name];
                if (program.clc) return runClc(program.clc, def.params, hostBinds, scalars, Object.assign({ name }, nd));
                const bufs = {}; for (const p of def.gpu.kir.params) if (p.kind === 'buf') bufs[p.name] = f32(hostBinds[p.name]);
                FaKir.runJs(def.gpu.kir, bufs, scalars, N); return { written: [def.gpu.out] };
            },
            finish: async () => { if (dev.flush) dev.flush(); if (dev.sync) await dev.sync(); }
        };
    }

    return { ClError, CODES, createLoader, makeKirDriver, makeClcDriver, makeGpuDriver, jsDevice, hashBytes };
});
