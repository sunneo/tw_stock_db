/* OpenCL 宿主操作派送（FaClHostOps，UMD，純邏輯）：把「JSON 指令＋二進位資料」翻成對 cl_icd.js 載入器的呼叫。
 * 這是 Python 端 `pyopencl._cl`（pybridge/pyopencl_backend/_cl.py）的對口：Pyodide 裡走 `_fa_opencl.call`，測試裡走 stdio（cl_host_stdio.js）。
 *   const H = FaClHostOps.create(loader);  const r = await H.call(op, args, dataUint8OrNull)  →  { result, data }  或丟出 { error:{name, code, msg} } 形狀的結果
 * 物件一律用整數控制代碼（載入器物件的 id）；列舉的數值對照留在 Python 端（這裡只回具名欄位），所以這裡不需要知道 OpenCL 標頭的數字。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./cl_icd.js'), require('./clc_js.js'));
    else root.FaClHostOps = factory(root.FaClIcd, root.FaClc);
})(typeof self !== 'undefined' ? self : this, function (ICD, CLC) {
    'use strict';
    // ---- 圖像格式：支援所有「非打包」通道型別與通道順序（打包的 565／555／101010 與 RGB／RGBx 沒做，所以不回報、建立時回 IMAGE_FORMAT_NOT_SUPPORTED）
    const CHN = { R: 1, A: 1, RG: 2, RA: 2, RGB: 3, RGBx: 4, RGBA: 4, BGRA: 4, ARGB: 4, INTENSITY: 1, LUMINANCE: 1, Rx: 2, RGx: 3 };
    const CHB = { SNORM_INT8: 1, UNORM_INT8: 1, SIGNED_INT8: 1, UNSIGNED_INT8: 1, SNORM_INT16: 2, UNORM_INT16: 2, SIGNED_INT16: 2, UNSIGNED_INT16: 2, HALF_FLOAT: 2, SIGNED_INT32: 4, UNSIGNED_INT32: 4, FLOAT: 4, UNORM_SHORT_565: 2, UNORM_SHORT_555: 2, UNORM_INT_101010: 4 };
    const PACKED = new Set(['UNORM_SHORT_565', 'UNORM_SHORT_555', 'UNORM_INT_101010']);   // 打包型別：整個像素就是 CHB 那麼多位元組；RGB／RGBx 只能配它們
    const elemSize = (o, t) => (PACKED.has(t) ? CHB[t] : CHN[o] * CHB[t]);
    const FLOATISH = new Set(['SNORM_INT8', 'SNORM_INT16', 'UNORM_INT8', 'UNORM_INT16', 'HALF_FLOAT', 'FLOAT']);
    const IMG_DIMS = { image1d: [1, 0], image2d: [2, 0], image3d: [3, 0], image1d_array: [1, 1], image2d_array: [2, 1], image1d_buffer: [1, 0] };
    const NS = 1e6;   // 載入器的時間是毫秒（浮點），pyopencl 的 profiling 是奈秒（整數）

    function create(loader) {
        const objs = new Map();
        const reg = (o) => { objs.set(o.id, o); return o.id; };
        const get = (h, kind, err) => { const o = objs.get(h); if (!o || o.kind !== kind || o.released) throw new ICD.ClError(err || 'INVALID_VALUE', '控制代碼 ' + h + ' 不是有效的 ' + kind); return o; };
        const devInfo = (d) => { const i = d.info || {}; return { h: reg(d), name: i.name || d.drv.name, type: String(i.type || 'CPU').toUpperCase(), vendor: d.drv.vendor || '', version: 'OpenCL 1.2 FA-ICD', driver_version: d.drv.version || '1.0', profile: 'FULL_PROFILE', extensions: d.drv.extensions || '', max_work_group_size: i.maxWorkGroupSize || 256, global_mem_size: i.globalMemSize || 0, max_mem_alloc_size: i.maxMemAllocSize || 0, max_compute_units: i.maxComputeUnits || 1, max_work_item_dimensions: d.drv.maxDims || 1, max_work_item_sizes: [i.maxWorkGroupSize || 256, d.drv.maxDims > 1 ? i.maxWorkGroupSize || 256 : 1, d.drv.maxDims > 2 ? i.maxWorkGroupSize || 256 : 1], available: true, compiler_available: true, address_bits: 64, local_mem_size: 32768, local_mem_type: 1, max_parameter_size: 4096, max_clock_frequency: 1000, max_constant_buffer_size: 65536, endian_little: true, image_support: d.drv.name !== 'fa-kir-js', image2d_max_width: 16384, image2d_max_height: 16384, image3d_max_width: 2048, image3d_max_height: 2048, image3d_max_depth: 2048, image_max_buffer_size: 1 << 27, image_max_array_size: 2048, max_read_image_args: 128, max_write_image_args: 64, max_read_write_image_args: 64, image_pitch_alignment: 1, image_base_address_alignment: 1, error_correction_support: false, global_mem_cacheline_size: 64, global_mem_cache_size: 0, global_mem_cache_type: 0, mem_base_addr_align: 1024, min_data_type_align_size: 128, profiling_timer_resolution: 1, max_constant_args: 8, max_samplers: 16, svm_capabilities: d.drv.name !== 'fa-kir-js' ? 1 : 0, max_pipe_args: d.drv.name !== 'fa-kir-js' ? 16 : 0, pipe_max_active_reservations: 16, pipe_max_packet_size: 1024, pipe_support: d.drv.name !== 'fa-kir-js' }; };
        const ev = (e) => ({ h: reg(e), cmd: e.cmd, queued: Math.round(e.queued * NS), start: Math.round(e.start * NS), end: Math.round(e.end * NS) });
        const imgOf = (m) => { if (!m.img) throw new ICD.ClError('INVALID_MEM_OBJECT', '這不是圖像'); return m.img; };
        // 把 region 拆成連續位元組段：[圖像內位元組偏移, 長度, 在 region 緊密資料裡的偏移]；做邊界檢查（INVALID_VALUE）
        function segs(I, o, r) {
            o = (o || [0, 0, 0]).map(Number); r = (r || [1, 1, 1]).map(Number); const dim = [I.w, I.h, I.d];
            for (let k = 0; k < 3; k++) if (!(r[k] > 0) || o[k] < 0 || o[k] + r[k] > dim[k]) throw new ICD.ClError('INVALID_VALUE', 'region 超出圖像（維度 ' + k + '：origin ' + o[k] + ' + ' + r[k] + ' > ' + dim[k] + '）');
            const E = I.elem, row = I.w * E, slice = row * I.h, out = [];
            if (r[0] === I.w && r[1] === I.h) out.push([o[2] * slice, r[2] * slice, 0]);
            else if (r[0] === I.w) for (let z = 0; z < r[2]; z++) out.push([(o[2] + z) * slice + o[1] * row, r[1] * row, z * r[1] * row]);
            else for (let z = 0; z < r[2]; z++) for (let y = 0; y < r[1]; y++) out.push([(o[2] + z) * slice + (o[1] + y) * row + o[0] * E, r[0] * E, (z * r[1] + y) * r[0] * E]);
            return out;
        }
        const u8 = (d) => { if (!d) throw new ICD.ClError('INVALID_VALUE', '這個操作需要二進位資料'); return d; };

        const ops = {
            platforms: () => ({ platforms: loader.platforms().map((p) => ({ h: reg(p), name: p.name, vendor: p.vendor, version: p.version, profile: p.profile, extensions: p.extensions })) }),
            devices: (a) => ({ devices: loader.devices(get(a.platform, 'platform', 'INVALID_PLATFORM'), a.type).map(devInfo) }),
            ctx_create: (a) => ({ h: reg(loader.createContext(a.devices.map((h) => get(h, 'device', 'INVALID_DEVICE')))) }),
            queue_create: (a) => { const c = get(a.ctx, 'context', 'INVALID_CONTEXT'); return { h: reg(loader.createQueue(c, a.device ? get(a.device, 'device', 'INVALID_DEVICE') : null, { profiling: !!a.profiling })) }; },
            buf_create: (a, d) => ({ h: reg(loader.createBuffer(get(a.ctx, 'context', 'INVALID_CONTEXT'), { flags: a.flags }, a.size, d || null)) }),
            buf_sub: (a) => ({ h: reg(loader.createSubBuffer(get(a.mem, 'mem', 'INVALID_MEM_OBJECT'), a.origin, a.size, { flags: a.flags })) }),
            buf_write: async (a, d) => ({ event: ev(await loader.enqueueWrite(get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'), get(a.mem, 'mem', 'INVALID_MEM_OBJECT'), u8(d), a.offset || 0)) }),
            buf_read: async (a) => { const r = await loader.enqueueRead(get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'), get(a.mem, 'mem', 'INVALID_MEM_OBJECT'), a.size, a.offset || 0); return { result: { event: ev(r.event) }, data: r.data }; },
            buf_copy: async (a) => ({ event: ev(await loader.enqueueCopy(get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'), get(a.src, 'mem', 'INVALID_MEM_OBJECT'), get(a.dst, 'mem', 'INVALID_MEM_OBJECT'), a.size, a.src_offset || 0, a.dst_offset || 0)) }),
            buf_fill: async (a, d) => {   // 以樣式重複填滿 [offset, offset+size)；size 必須是樣式長度的整數倍（OpenCL 規定）
                const pat = u8(d), n = Number(a.size); if (!pat.length || n % pat.length) throw new ICD.ClError('INVALID_VALUE', 'fill 的 size 要是 pattern 長度的整數倍');
                const buf = new Uint8Array(n); for (let i = 0; i < n; i += pat.length) buf.set(pat, i);
                return { event: ev(await loader.enqueueWrite(get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'), get(a.mem, 'mem', 'INVALID_MEM_OBJECT'), buf, a.offset || 0)) };
            },
            buf_version: (a) => ({ ver: get(a.mem, 'mem', 'INVALID_MEM_OBJECT').ver }),
            prog_create: (a) => ({ h: reg(loader.createProgram(get(a.ctx, 'context', 'INVALID_CONTEXT'), a.src)) }),
            prog_build: (a) => { const p = get(a.prog, 'program', 'INVALID_PROGRAM'); if (a.src != null) p.src = a.src; try { loader.build(p, a.options); return { ok: true, log: p.log, kernels: loader.kernelNames(p) }; } catch (e) { if (e && e.clName === 'BUILD_PROGRAM_FAILURE') return { ok: false, log: p.log, kernels: [], error: { name: e.clName, code: e.code, msg: p.log } }; throw e; } },
            prog_info: (a) => { const p = get(a.prog, 'program', 'INVALID_PROGRAM'); return { built: !!p.built, log: p.log, src: p.src, kernels: p.built ? loader.kernelNames(p) : [] }; },
            kernel_create: (a) => { const k = loader.createKernel(get(a.prog, 'program', 'INVALID_PROGRAM'), a.name); return { h: reg(k), num_args: k.def.params.length, args: k.def.params.map((p) => ({ name: p.name, kind: p.kind, type: p.type, access: p.access || null, size: p.size || null })) }; },
            kernel_set_arg: (a) => { const k = get(a.kernel, 'kernel', 'INVALID_KERNEL'); loader.setArg(k, a.index, a.mem != null ? get(a.mem, 'mem', 'INVALID_MEM_OBJECT') : a.local != null ? { local: a.local } : a.scalar); return {}; },
            nd_range: async (a) => ({ event: ev(await loader.enqueueNDRange(get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'), get(a.kernel, 'kernel', 'INVALID_KERNEL'), a.global, a.local == null ? null : a.local, a.offset == null ? null : a.offset)) }),
            finish: async (a) => { await loader.finish(get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE')); return {}; },
            // ---- 圖像：與緩衝區同一套儲存（緊密排列），region 的資料由 Python 端先打包成連續位元組
            pipe_create: (a) => { const m = loader.createPipe(get(a.ctx, 'context', 'INVALID_CONTEXT'), { flags: a.flags }, a.packet_size, a.max_packets); return { h: reg(m), size: m.size }; },
            img_formats: (a) => { const out = []; for (const o of Object.keys(CHN)) for (const t of Object.keys(CHB)) { if ((o === 'INTENSITY' || o === 'LUMINANCE') && !FLOATISH.has(t)) continue; if ((o === 'RGB' || o === 'RGBx') !== PACKED.has(t)) continue; out.push([o, t]); } return { formats: out }; },
            img_create: (a, d) => {
                const dims = IMG_DIMS[a.type]; if (!dims) throw new ICD.ClError('INVALID_IMAGE_DESCRIPTOR', '不認得的圖像型別 ' + a.type);
                if (!CHN[a.order] || !CHB[a.chType]) throw new ICD.ClError('IMAGE_FORMAT_NOT_SUPPORTED', '圖像格式 ' + a.order + '／' + a.chType + ' 沒有實作（打包型別與 RGB／RGBx 不支援）');
                const w = a.w, h = a.h || 1, dd = a.d || 1; if (!(w > 0) || !(h > 0) || !(dd > 0)) throw new ICD.ClError('INVALID_IMAGE_SIZE', '圖像尺寸要是正整數');
                if ((a.order === 'RGB' || a.order === 'RGBx') !== PACKED.has(a.chType)) throw new ICD.ClError('IMAGE_FORMAT_NOT_SUPPORTED', '打包型別只能配 RGB／RGBx，且 RGB／RGBx 只能配打包型別');
                const elem = elemSize(a.order, a.chType), meta = { type: a.type, w, h, d: dd, order: a.order, chType: a.chType, elem };
                if (d && d.length < w * h * dd * elem) throw new ICD.ClError('INVALID_HOST_PTR', '初始資料比圖像小');
                if (a.type === 'image1d_buffer') { const m = loader.createImageOnBuffer(get(a.buffer, 'mem', 'INVALID_MEM_OBJECT'), meta); return { h: reg(m), elem, size: m.size }; }
                const m = loader.createImage(get(a.ctx, 'context', 'INVALID_CONTEXT'), { flags: a.flags }, meta, d || null); return { h: reg(m), elem, size: m.size };
            },
            img_write: async (a, d) => { const m = get(a.mem, 'mem', 'INVALID_MEM_OBJECT'), q = get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'); let last; const data = u8(d); for (const [io, n, dof] of segs(imgOf(m), a.origin, a.region)) last = await loader.enqueueWrite(q, m, data.subarray(dof, dof + n), io); return { event: ev(last) }; },
            img_read: async (a) => { const m = get(a.mem, 'mem', 'INVALID_MEM_OBJECT'), q = get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'), I = imgOf(m), out = new Uint8Array(a.region[0] * a.region[1] * a.region[2] * I.elem); let last; for (const [io, n, dof] of segs(I, a.origin, a.region)) { const r = await loader.enqueueRead(q, m, n, io); out.set(r.data, dof); last = r.event; } return { result: { event: ev(last) }, data: out }; },
            img_copy: async (a) => {
                const s = get(a.src, 'mem', 'INVALID_MEM_OBJECT'), t = get(a.dst, 'mem', 'INVALID_MEM_OBJECT'), q = get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'), S = imgOf(s), T = imgOf(t);
                if (S.order !== T.order || S.chType !== T.chType) throw new ICD.ClError('IMAGE_FORMAT_MISMATCH', '來源與目的圖像的格式不同');
                const buf = new Uint8Array(a.region[0] * a.region[1] * a.region[2] * S.elem); for (const [io, n, dof] of segs(S, a.src_origin, a.region)) buf.set((await loader.enqueueRead(q, s, n, io)).data, dof);
                let e; for (const [io, n, dof] of segs(T, a.dst_origin, a.region)) e = await loader.enqueueWrite(q, t, buf.subarray(dof, dof + n), io); return { event: ev(e) };
            },
            img_to_buf: async (a) => {   // 圖像 region → 緩衝區（緊密排列）
                const s = get(a.img, 'mem', 'INVALID_MEM_OBJECT'), b = get(a.buf, 'mem', 'INVALID_MEM_OBJECT'), q = get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'), S = imgOf(s);
                const buf = new Uint8Array(a.region[0] * a.region[1] * a.region[2] * S.elem); for (const [io, n, dof] of segs(S, a.origin, a.region)) buf.set((await loader.enqueueRead(q, s, n, io)).data, dof);
                return { event: ev(await loader.enqueueWrite(q, b, buf, a.offset || 0)) };
            },
            buf_to_img: async (a) => {
                const t = get(a.img, 'mem', 'INVALID_MEM_OBJECT'), b = get(a.buf, 'mem', 'INVALID_MEM_OBJECT'), q = get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'), T = imgOf(t);
                const n0 = a.region[0] * a.region[1] * a.region[2] * T.elem, buf = (await loader.enqueueRead(q, b, n0, a.offset || 0)).data; let e;
                for (const [io, n, dof] of segs(T, a.origin, a.region)) e = await loader.enqueueWrite(q, t, buf.subarray(dof, dof + n), io); return { event: ev(e) };
            },
            img_fill: async (a) => {   // 用 color（4 個數字，kind＝f／i／ui）填滿 region：先用 write_image 的編碼把一個像素編出來，再重複寫入
                const t = get(a.mem, 'mem', 'INVALID_MEM_OBJECT'), q = get(a.queue, 'queue', 'INVALID_COMMAND_QUEUE'), T = imgOf(t); if (!CLC) throw new ICD.ClError('INVALID_OPERATION', '沒有 clc 前端，無法編碼像素');
                const one = new Uint8Array(T.elem), r = CLC.imageRuntime(), ab = one.buffer, v = { ab, u8: one, i8: new Int8Array(ab), i16: new Int16Array(ab, 0, T.elem >> 1), u16: new Uint16Array(ab, 0, T.elem >> 1), i32: new Int32Array(ab, 0, T.elem >> 2), u32: new Uint32Array(ab, 0, T.elem >> 2), f32: new Float32Array(ab, 0, T.elem >> 2) };
                r.wimg({ v, o: 0, img: Object.assign({}, T, { type: 'image1d', w: 1, h: 1, d: 1 }) }, [0], a.color, a.kind || 'f');
                const n = a.region[0] * a.region[1] * a.region[2], buf = new Uint8Array(n * T.elem); for (let i = 0; i < n; i++) buf.set(one, i * T.elem);
                let e; for (const [io, len, dof] of segs(T, a.origin, a.region)) e = await loader.enqueueWrite(q, t, buf.subarray(dof, dof + len), io); return { event: ev(e) };
            },
            release: (a) => { const o = objs.get(a.h); if (o) { if (o.kind === 'mem') loader.releaseMem(o); o.released = true; objs.delete(a.h); } return {}; },
            stats: () => ({ stats: loader.stats() }),
            ping: () => ({ pong: true })
        };

        // 回傳 { result, data? }；錯誤也回傳（不丟出），讓傳輸層不用處理例外
        async function call(op, args, data) {
            const f = ops[op];
            if (!f) return { result: { error: { name: 'INVALID_VALUE', code: -30, msg: '不認得的操作 ' + op } } };
            try {
                const r = await f(args || {}, data || null);
                if (r && r.result !== undefined && r.data !== undefined) return { result: r.result, data: r.data };
                return { result: r };
            } catch (e) {
                if (e && e.clName) return { result: { error: { name: e.clName, code: e.code, msg: String(e.message) } } };
                return { result: { error: { name: 'OUT_OF_RESOURCES', code: -5, msg: String((e && e.message) || e) } } };
            }
        }
        return { call, ops: Object.keys(ops) };
    }
    return { create };
});
