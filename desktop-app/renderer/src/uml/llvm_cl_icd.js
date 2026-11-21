/* LLVM IR 程式的 OpenCL 主機函式 → ICD 載入器（FaLlvmClIcd，UMD，純邏輯）。
 * .ll 程式呼叫標準的 clCreateBuffer／clEnqueueNDRangeKernel…；預設由 llvm_host.js 的舊墊片提供（只收 OpenCL C 的簡單子集，給 nbody3d／fluid3d 的 KIR 快路徑用）。
 * 這個模組是另一條路：把同一批 cl* 匯入接到 cl_icd.js 的載入器（經 cl_host_ops.js 的 callSync），於是 .ll 程式得到完整的 OpenCL C（clc：struct、向量、__local＋barrier、
 * 原子、圖像與取樣器、Pipe）、GPU／CPU 異質路由、build 快取。
 *   const X = FaLlvmClIcd.build({ ops: FaClHostOps.create(loader), asyncOk: true／false, warn });   X.impls／X.sigs 合併進 FaLlvmHost 的 impls／SIGS
 *   FaLlvmClIcd.wantsIcd(irText) → IR 的註解有 "; fa-opencl: icd" 才啟用（預設不啟用，所以既有範例的行為不變）
 * 同步優先：clc／主機路線的操作同步完成；遇到 GPU（下載、非同步派送）才回 Promise——要有 JSPI（asyncOk）；沒有 JSPI 又需要等就回 CL_OUT_OF_RESOURCES 並警告。
 * 指標是 wasm32（32 位元）；size_t 與 cl_mem_flags 在簽名裡是 i32|i64，這裡一律轉成 Number。
 * 沒有的功能（如實回報，不假裝）：SVM（沒有 wasm 端配置器可給共享位址）、GL 互通（用預設的舊墊片）、事件等待清單（佇列循序，一律當作已滿足）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLlvmClIcd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const ORDERS = ['R', 'A', 'RG', 'RA', 'RGB', 'RGBA', 'BGRA', 'ARGB', 'INTENSITY', 'LUMINANCE', 'Rx', 'RGx', 'RGBx'];
    const CTYPES = ['SNORM_INT8', 'SNORM_INT16', 'UNORM_INT8', 'UNORM_INT16', 'UNORM_SHORT_565', 'UNORM_SHORT_555', 'UNORM_INT_101010', 'SIGNED_INT8', 'SIGNED_INT16', 'SIGNED_INT32', 'UNSIGNED_INT8', 'UNSIGNED_INT16', 'UNSIGNED_INT32', 'HALF_FLOAT', 'FLOAT'];
    const IMG_TYPE = { 0x10F1: 'image2d', 0x10F2: 'image3d', 0x10F3: 'image2d_array', 0x10F4: 'image1d', 0x10F5: 'image1d_array', 0x10F6: 'image1d_buffer' };
    const IMG_MEMTYPE = { image2d: 0x10F1, image3d: 0x10F2, image2d_array: 0x10F3, image1d: 0x10F4, image1d_array: 0x10F5, image1d_buffer: 0x10F6 };
    const SCALAR = { char: [1, 'getInt8'], uchar: [1, 'getUint8'], short: [2, 'getInt16'], ushort: [2, 'getUint16'], int: [4, 'getInt32'], uint: [4, 'getUint32'], long: [8, 'getBigInt64'], ulong: [8, 'getBigUint64'], float: [4, 'getFloat32'], double: [8, 'getFloat64'] };
    const FLOATISH = new Set(['SNORM_INT8', 'SNORM_INT16', 'UNORM_INT8', 'UNORM_INT16', 'UNORM_SHORT_565', 'UNORM_SHORT_555', 'UNORM_INT_101010', 'HALF_FLOAT', 'FLOAT']);

    const SIGS = {
        clCreateContextFromType: { params: ['ptr', 'i32|i64', 'ptr', 'ptr', 'ptr'], ret: 'ptr' },
        clCreateProgramWithBinary: { params: ['ptr', 'i32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], ret: 'ptr' },
        clCreateProgramWithIL: { params: ['ptr', 'ptr', 'i32|i64', 'ptr'], ret: 'ptr' }, clSetProgramSpecializationConstant: { params: ['ptr', 'i32', 'i32|i64', 'ptr'], ret: 'i32' },
        clCreateSubBuffer: { params: ['ptr', 'i32|i64', 'i32', 'ptr', 'ptr'], ret: 'ptr' },
        clEnqueueCopyBuffer: { params: ['ptr', 'ptr', 'ptr', 'i32|i64', 'i32|i64', 'i32|i64', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clEnqueueFillBuffer: { params: ['ptr', 'ptr', 'ptr', 'i32|i64', 'i32|i64', 'i32|i64', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clCreateImage: { params: ['ptr', 'i32|i64', 'ptr', 'ptr', 'ptr', 'ptr'], ret: 'ptr' },
        clCreateImage2D: { params: ['ptr', 'i32|i64', 'ptr', 'i32|i64', 'i32|i64', 'i32|i64', 'ptr', 'ptr'], ret: 'ptr' },
        clCreateImage3D: { params: ['ptr', 'i32|i64', 'ptr', 'i32|i64', 'i32|i64', 'i32|i64', 'i32|i64', 'i32|i64', 'ptr', 'ptr'], ret: 'ptr' },
        clEnqueueReadImage: { params: ['ptr', 'ptr', 'i32', 'ptr', 'ptr', 'i32|i64', 'i32|i64', 'ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clEnqueueWriteImage: { params: ['ptr', 'ptr', 'i32', 'ptr', 'ptr', 'i32|i64', 'i32|i64', 'ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clEnqueueCopyImage: { params: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clEnqueueCopyImageToBuffer: { params: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'i32|i64', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clEnqueueCopyBufferToImage: { params: ['ptr', 'ptr', 'ptr', 'i32|i64', 'ptr', 'ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clEnqueueFillImage: { params: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clGetImageInfo: { params: ['ptr', 'i32', 'i32|i64', 'ptr', 'ptr'], ret: 'i32' },
        clGetSupportedImageFormats: { params: ['ptr', 'i32|i64', 'i32', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clCreateSampler: { params: ['ptr', 'i32', 'i32', 'i32', 'ptr'], ret: 'ptr' },
        clCreateSamplerWithProperties: { params: ['ptr', 'ptr', 'ptr'], ret: 'ptr' },
        clReleaseSampler: { params: ['ptr'], ret: 'i32' },
        clCreatePipe: { params: ['ptr', 'i32|i64', 'i32', 'i32', 'ptr', 'ptr'], ret: 'ptr' },
        clGetPipeInfo: { params: ['ptr', 'i32', 'i32|i64', 'ptr', 'ptr'], ret: 'i32' },
        clGetKernelWorkGroupInfo: { params: ['ptr', 'ptr', 'i32', 'i32|i64', 'ptr', 'ptr'], ret: 'i32' },
        clGetProgramInfo: { params: ['ptr', 'i32', 'i32|i64', 'ptr', 'ptr'], ret: 'i32' },
        clGetEventProfilingInfo: { params: ['ptr', 'i32', 'i32|i64', 'ptr', 'ptr'], ret: 'i32' },
        clRetainMemObject: { params: ['ptr'], ret: 'i32' }, clRetainKernel: { params: ['ptr'], ret: 'i32' }, clRetainProgram: { params: ['ptr'], ret: 'i32' },
        clRetainContext: { params: ['ptr'], ret: 'i32' }, clRetainCommandQueue: { params: ['ptr'], ret: 'i32' }, clRetainEvent: { params: ['ptr'], ret: 'i32' },
        clEnqueueBarrier: { params: ['ptr'], ret: 'i32' }, clEnqueueMarker: { params: ['ptr', 'ptr'], ret: 'i32' },
        clEnqueueBarrierWithWaitList: { params: ['ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' }, clEnqueueMarkerWithWaitList: { params: ['ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' },
    };
    // 會遇到非同步結果（GPU）的函式：有 JSPI 時標成 async
    const ASYNC_FNS = ['clEnqueueWriteBuffer', 'clEnqueueReadBuffer', 'clEnqueueCopyBuffer', 'clEnqueueFillBuffer', 'clEnqueueNDRangeKernel', 'clFinish', 'clEnqueueReadImage', 'clEnqueueWriteImage',
        'clEnqueueCopyImage', 'clEnqueueCopyImageToBuffer', 'clEnqueueCopyBufferToImage', 'clEnqueueFillImage'];

    const wantsIcd = (ir) => /^[ \t]*;[ \t]*fa-opencl:[ \t]*icd\b/m.test(String(ir || ''));

    function build(o) {
        const ops = o.ops, warn = o.warn || (() => {}), asyncOk = !!o.asyncOk;
        const info = new Map();   // 控制代碼 → JS 端記錄（平台／裝置資訊、圖像描述、取樣器位元、事件時間、核心參數表…）
        const U = (x) => Number(x);

        // 呼叫載入器：回傳結果物件（同步完成時）或 Promise；after(r) 把結果轉成 cl 回傳碼
        const mayWait = (r, f) => {
            if (r && typeof r.then === 'function') {
                if (!asyncOk) { warn('OpenCL（ICD）：這個操作需要等 GPU，但目前環境沒有 JSPI，無法等待\n'); return -5; }
                return r.then(f);
            }
            return f(r);
        };
        const errCode = (r) => (r.result && r.result.error ? r.result.error.code : 0);
        const call = (op, args, data) => ops.callSync(op, args, data);
        const check = (r) => { const c = errCode(r); if (c) { if (r.result.error.msg && c === -11) warn('OpenCL 建置失敗：\n' + r.result.error.msg + '\n'); } return c; };

        const wr32 = (ctx, p, v) => { if (p) ctx.dv().setUint32(p, v >>> 0, true); };
        const errOut = (ctx, p, v) => { if (p) ctx.dv().setInt32(p, v, true); };
        const cstr = (ctx, p) => { const u = ctx.u8(); let e = p; while (u[e]) e++; return new TextDecoder().decode(u.subarray(p, e)); };
        const sizes = (ctx, p, n) => { const a = []; for (let i = 0; i < n; i++) a.push(ctx.dv().getUint32(p + 4 * i, true)); return a; };   // wasm32 的 size_t 陣列
        const evOut = (ctx, evp, ev) => { if (evp && ev) { info.set(ev.h, ev); ctx.dv().setUint32(evp, ev.h, true); } };
        const putVal = (ctx, kind, val, size, v, ret) => {   // clGetXInfo 的輸出：kind＝u32｜u64｜size｜str｜sizes｜raw（Uint8Array）
            let b;
            if (kind === 'str') b = new TextEncoder().encode(String(val) + '\0');
            else if (kind === 'u32') { b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(val) >>> 0, true); }
            else if (kind === 'u64') { b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(Math.trunc(Number(val))), true); }
            else if (kind === 'size') { b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(val) >>> 0, true); }
            else if (kind === 'sizes') { b = new Uint8Array(4 * val.length); val.forEach((x, i) => new DataView(b.buffer).setUint32(4 * i, Number(x) >>> 0, true)); }
            else b = val;
            if (v) { if (Number(size) < b.length) return -30; ctx.u8().set(b, v); }
            if (ret) ctx.dv().setUint32(ret, b.length, true);
            return 0;
        };
        const devParam = { 0x1002: ['u32', 'max_compute_units'], 0x1003: ['u32', 'max_work_item_dimensions'], 0x1004: ['size', 'max_work_group_size'], 0x1005: ['sizes', 'max_work_item_sizes'], 0x100C: ['u32', 'max_clock_frequency'],
            0x100D: ['u32', 'address_bits'], 0x100E: ['u32', 'max_read_image_args'], 0x100F: ['u32', 'max_write_image_args'], 0x1010: ['u64', 'max_mem_alloc_size'], 0x1011: ['size', 'image2d_max_width'], 0x1012: ['size', 'image2d_max_height'],
            0x1013: ['size', 'image3d_max_width'], 0x1014: ['size', 'image3d_max_height'], 0x1015: ['size', 'image3d_max_depth'], 0x1016: ['u32', 'image_support'], 0x1017: ['size', 'max_parameter_size'], 0x1018: ['u32', 'max_samplers'],
            0x1019: ['u32', 'mem_base_addr_align'], 0x101A: ['u32', 'min_data_type_align_size'], 0x101F: ['u64', 'global_mem_size'], 0x1020: ['u64', 'max_constant_buffer_size'], 0x1021: ['u32', 'max_constant_args'],
            0x1022: ['u32', 'local_mem_type'], 0x1023: ['u64', 'local_mem_size'], 0x1024: ['u32', 'error_correction_support'], 0x1025: ['size', 'profiling_timer_resolution'], 0x1026: ['u32', 'endian_little'],
            0x1027: ['u32', 'available'], 0x1028: ['u32', 'compiler_available'], 0x102B: ['str', 'name'], 0x102C: ['str', 'vendor'], 0x102D: ['str', 'driver_version'], 0x102E: ['str', 'profile'], 0x102F: ['str', 'version'],
            0x1030: ['str', 'extensions'], 0x105B: ['str', 'il_version'], 0x1053: ['u64', 'svm_capabilities'], 0x1055: ['u32', 'max_pipe_args'], 0x1049: ['size', 'printf_buffer_size'], 0x1057: ['u32', 'pipe_max_packet_size'], 0x1056: ['u32', 'pipe_max_active_reservations'] };
        const platParam = { 0x0900: 'profile', 0x0901: 'version', 0x0902: 'name', 0x0903: 'vendor', 0x0904: 'extensions' };

        // ---- 內核參數：把 clSetKernelArg 的位元組依參數型別轉成載入器要的值
        function decodeScalar(ctx, spec, size, ptr) {
            const dv = ctx.dv();
            if (spec.type === 'struct') return Array.from(ctx.u8().subarray(ptr, ptr + size));
            const vm = /^([a-z]+?)(\d+)$/.exec(spec.type);
            const base = vm ? vm[1] : spec.type, n = vm ? Number(vm[2]) : 1, sc = SCALAR[base];
            if (!sc) return null;
            const stride = sc[0], read = (i) => { const x = dv[sc[1]](ptr + i * stride, true); return typeof x === 'bigint' ? Number(x) : x; };
            if (size < stride * (vm && n === 3 ? 3 : n)) return null;
            if (!vm) return read(0);
            const out = []; for (let i = 0; i < n; i++) out.push(read(i)); return out;
        }

        const impls = {
            clGetPlatformIDs: (ctx, n, plats, outn) => {
                const r = call('platforms'); if (errCode(r)) return errCode(r);
                const L = r.result.platforms; if (!n && plats) return -30;
                if (plats) L.slice(0, n).forEach((p, i) => { info.set(p.h, p); wr32(ctx, plats + 4 * i, p.h); });
                L.forEach((p) => info.set(p.h, p)); if (outn) wr32(ctx, outn, L.length); return L.length ? 0 : -1001;
            },
            clGetPlatformInfo: (ctx, p, name, size, v, ret) => { const e = info.get(p); if (!e || !platParam[name]) return e ? -30 : -32; return putVal(ctx, 'str', e[platParam[name]] || '', size, v, ret); },
            clGetDeviceIDs: (ctx, p, type, n, devs, outn) => {
                if (!info.has(p)) return -32; type = U(type); const t = type & 0xFFFFFFFF;
                const want = t === 0xFFFFFFFF || (t & 1) ? 'ALL' : (t & 4) ? 'GPU' : (t & 2) ? 'CPU' : null; if (!want) return -31;
                const r = call('devices', { platform: p, type: want }); if (errCode(r)) return errCode(r);
                const L = r.result.devices; L.forEach((d) => info.set(d.h, d));
                if (devs) L.slice(0, n).forEach((d, i) => wr32(ctx, devs + 4 * i, d.h)); if (outn) wr32(ctx, outn, L.length); return 0;
            },
            clGetDeviceInfo: (ctx, d, name, size, v, ret) => {
                const e = info.get(d); if (!e || !e.max_work_group_size) return -33;
                if (name === 0x1000) return putVal(ctx, 'u64', e.type === 'GPU' ? 4 : 2, size, v, ret);
                if (name === 0x103D) return putVal(ctx, 'str', 'OpenCL C 1.2', size, v, ret);
                const pm = devParam[name]; if (!pm) return -30; return putVal(ctx, pm[0], e[pm[1]], size, v, ret);
            },
            clCreateContext: (ctx, props, n, devs, cb, ud, err) => {
                const hs = sizes(ctx, devs, n); const r = call('ctx_create', { devices: hs }); const c = errCode(r); errOut(ctx, err, c); return c ? 0 : r.result.h;
            },
            clCreateContextFromType: (ctx, props, type, cb, ud, err) => {
                const pr = call('platforms'); if (errCode(pr)) { errOut(ctx, err, errCode(pr)); return 0; }
                const t = U(type) & 0xFFFFFFFF, want = t === 0xFFFFFFFF || (t & 1) ? 'ALL' : (t & 4) ? 'GPU' : 'CPU';
                for (const p of pr.result.platforms) { const dr = call('devices', { platform: p.h, type: want }); if (!errCode(dr) && dr.result.devices.length) { dr.result.devices.forEach((d) => info.set(d.h, d)); const r = call('ctx_create', { devices: [dr.result.devices[0].h] }); errOut(ctx, err, errCode(r)); return errCode(r) ? 0 : r.result.h; } }
                errOut(ctx, err, -1); return 0;
            },
            clCreateCommandQueue: (ctx, c, d, props, err) => { const r = call('queue_create', { ctx: c, device: d || null, profiling: !!(U(props) & 2) }); errOut(ctx, err, errCode(r)); return errCode(r) ? 0 : r.result.h; },
            clCreateCommandQueueWithProperties: (ctx, c, d, props, err) => {
                let prof = false; if (props) for (let i = 0; i < 16; i++) { const k = Number(ctx.dv().getBigUint64(props + 8 * i * 2, true)); if (!k) break; if (k === 0x1093) prof = !!(Number(ctx.dv().getBigUint64(props + 8 * (i * 2 + 1), true)) & 2); }
                const r = call('queue_create', { ctx: c, device: d || null, profiling: prof }); errOut(ctx, err, errCode(r)); return errCode(r) ? 0 : r.result.h;
            },
            clCreateBuffer: (ctx, c, flags, size, host, err) => {
                flags = U(flags); size = U(size); if (!size) { errOut(ctx, err, -61); return 0; }
                if ((flags & (8 | 32)) && !host) { errOut(ctx, err, -37); return 0; }
                const data = (flags & (8 | 32)) ? ctx.u8().slice(host, host + size) : null;
                const r = call('buf_create', { ctx: c, flags, size }, data); errOut(ctx, err, errCode(r)); return errCode(r) ? 0 : r.result.h;
            },
            clCreateSubBuffer: (ctx, b, flags, type, infoPtr, err) => {
                if (type !== 0x1220 || !infoPtr) { errOut(ctx, err, -30); return 0; }
                const [origin, size] = sizes(ctx, infoPtr, 2); const r = call('buf_sub', { mem: b, origin, size, flags: U(flags) }); errOut(ctx, err, errCode(r)); return errCode(r) ? 0 : r.result.h;
            },
            clEnqueueWriteBuffer: (ctx, q, b, blocking, off, size, ptr, nw, wl, evp) => {
                if (!ptr) return -30; const r = call('buf_write', { queue: q, mem: b, offset: U(off) }, ctx.u8().slice(ptr, ptr + U(size)));
                return mayWait(r, (x) => { const c = check(x); if (!c) evOut(ctx, evp, x.result.event); return c; });
            },
            clEnqueueReadBuffer: (ctx, q, b, blocking, off, size, ptr, nw, wl, evp) => {
                if (!ptr) return -30; const r = call('buf_read', { queue: q, mem: b, offset: U(off), size: U(size) });
                return mayWait(r, (x) => { const c = check(x); if (c) return c; ctx.u8().set(x.data, ptr); evOut(ctx, evp, x.result.event); return 0; });
            },
            clEnqueueCopyBuffer: (ctx, q, s, d, so, dofs, size, nw, wl, evp) => mayWait(call('buf_copy', { queue: q, src: s, dst: d, size: U(size), src_offset: U(so), dst_offset: U(dofs) }), (x) => { const c = check(x); if (!c) evOut(ctx, evp, x.result.event); return c; }),
            clEnqueueFillBuffer: (ctx, q, b, pat, psize, off, size, nw, wl, evp) => mayWait(call('buf_fill', { queue: q, mem: b, offset: U(off), size: U(size) }, ctx.u8().slice(pat, pat + U(psize))), (x) => { const c = check(x); if (!c) evOut(ctx, evp, x.result.event); return c; }),

            // ---- 圖像
            clCreateImage: null,   // 下面補（要取 flags 參數）
            clCreateImage2D: (ctx, c, flags, fmt, w, h, rp, host, err) => makeImage(ctx, c, 0, fmt, 'image2d', { w: U(w), h: U(h), d: 1, rp: U(rp), sp: 0 }, host, err, U(flags)),
            clCreateImage3D: (ctx, c, flags, fmt, w, h, d, rp, sp, host, err) => makeImage(ctx, c, 0, fmt, 'image3d', { w: U(w), h: U(h), d: U(d), rp: U(rp), sp: U(sp) }, host, err, U(flags)),
            clEnqueueReadImage: (ctx, q, im, blocking, org, reg, rp, sp, ptr, nw, wl, evp) => {
                const E = info.get(im); if (!E || !E.img) return -38; const o3 = pad(sizes(ctx, org, 3), 0), r3 = pad(sizes(ctx, reg, 3), 1);
                const r = call('img_read', { queue: q, mem: im, origin: o3, region: r3 });
                return mayWait(r, (x) => { const c = check(x); if (c) return c; scatter(ctx.u8(), ptr, x.data, r3, E.img.elem, U(rp), U(sp)); evOut(ctx, evp, x.result.event); return 0; });
            },
            clEnqueueWriteImage: (ctx, q, im, blocking, org, reg, rp, sp, ptr, nw, wl, evp) => {
                const E = info.get(im); if (!E || !E.img) return -38; const o3 = pad(sizes(ctx, org, 3), 0), r3 = pad(sizes(ctx, reg, 3), 1);
                const r = call('img_write', { queue: q, mem: im, origin: o3, region: r3 }, gather(ctx.u8(), ptr, r3, E.img.elem, U(rp), U(sp)));
                return mayWait(r, (x) => { const c = check(x); if (!c) evOut(ctx, evp, x.result.event); return c; });
            },
            clEnqueueCopyImage: (ctx, q, s, d, so, dof, reg, nw, wl, evp) => mayWait(call('img_copy', { queue: q, src: s, dst: d, src_origin: pad(sizes(ctx, so, 3), 0), dst_origin: pad(sizes(ctx, dof, 3), 0), region: pad(sizes(ctx, reg, 3), 1) }), (x) => { const c = check(x); if (!c) evOut(ctx, evp, x.result.event); return c; }),
            clEnqueueCopyImageToBuffer: (ctx, q, im, buf, org, reg, off, nw, wl, evp) => mayWait(call('img_to_buf', { queue: q, img: im, buf, origin: pad(sizes(ctx, org, 3), 0), region: pad(sizes(ctx, reg, 3), 1), offset: U(off) }), (x) => { const c = check(x); if (!c) evOut(ctx, evp, x.result.event); return c; }),
            clEnqueueCopyBufferToImage: (ctx, q, buf, im, off, org, reg, nw, wl, evp) => mayWait(call('buf_to_img', { queue: q, buf, img: im, offset: U(off), origin: pad(sizes(ctx, org, 3), 0), region: pad(sizes(ctx, reg, 3), 1) }), (x) => { const c = check(x); if (!c) evOut(ctx, evp, x.result.event); return c; }),
            clEnqueueFillImage: (ctx, q, im, color, org, reg, nw, wl, evp) => {
                const E = info.get(im); if (!E || !E.img) return -38; const dv = ctx.dv(), ct = E.img.chType, fl = FLOATISH.has(ct), un = /^UNSIGNED/.test(ct);
                const col = [0, 1, 2, 3].map((i) => (fl ? dv.getFloat32(color + 4 * i, true) : un ? dv.getUint32(color + 4 * i, true) : dv.getInt32(color + 4 * i, true)));
                return mayWait(call('img_fill', { queue: q, mem: im, origin: pad(sizes(ctx, org, 3), 0), region: pad(sizes(ctx, reg, 3), 1), color: col, kind: fl ? 'f' : un ? 'ui' : 'i' }), (x) => { const c = check(x); if (!c) evOut(ctx, evp, x.result.event); return c; });
            },
            clGetImageInfo: (ctx, im, name, size, v, ret) => {
                const E = info.get(im); if (!E || !E.img) return -38; const m = E.img, arr = /array/.test(m.type), three = m.type === 'image3d';
                switch (name) {
                    case 0x1110: return putVal(ctx, 'raw', (() => { const b = new Uint8Array(8); new DataView(b.buffer).setUint32(0, 0x10B0 + ORDERS.indexOf(m.order), true); new DataView(b.buffer).setUint32(4, 0x10D0 + CTYPES.indexOf(m.chType), true); return b; })(), size, v, ret);
                    case 0x1111: return putVal(ctx, 'size', m.elem, size, v, ret);
                    case 0x1112: return putVal(ctx, 'size', m.w * m.elem, size, v, ret);
                    case 0x1113: return putVal(ctx, 'size', (three || arr) ? m.w * m.h * m.elem : 0, size, v, ret);
                    case 0x1114: return putVal(ctx, 'size', m.w, size, v, ret);
                    case 0x1115: return putVal(ctx, 'size', /image2d|image3d/.test(m.type) ? m.h : 0, size, v, ret);
                    case 0x1116: return putVal(ctx, 'size', three ? m.d : 0, size, v, ret);
                    case 0x1117: return putVal(ctx, 'size', arr ? (m.type === 'image1d_array' ? m.h : m.d) : 0, size, v, ret);
                    default: return -30;
                }
            },
            clGetSupportedImageFormats: (ctx, c, flags, type, n, fmts, outn) => {
                const r = call('img_formats', { type }); if (errCode(r)) return errCode(r); const L = r.result.formats;
                if (fmts) L.slice(0, n).forEach(([ord, ty], i) => { ctx.dv().setUint32(fmts + 8 * i, 0x10B0 + ORDERS.indexOf(ord), true); ctx.dv().setUint32(fmts + 8 * i + 4, 0x10D0 + CTYPES.indexOf(ty), true); });
                if (outn) wr32(ctx, outn, L.length); return 0;
            },
            clCreateSampler: (ctx, c, norm, addr, filt, err) => makeSampler(ctx, c, !!norm, addr, filt, err),
            clCreateSamplerWithProperties: (ctx, c, props, err) => {
                let norm = 1, addr = 0x1132, filt = 0x1140;
                if (props) for (let i = 0; i < 8; i++) { const k = ctx.dv().getUint32(props + 8 * i, true); if (!k) break; const vv = ctx.dv().getUint32(props + 8 * i + 4, true); if (k === 0x1152) norm = vv; else if (k === 0x1153) addr = vv; else if (k === 0x1154) filt = vv; }   // cl_sampler_properties 在 wasm32 是 intptr_t（4 位元組）鍵值對
                return makeSampler(ctx, c, !!norm, addr, filt, err);
            },
            clReleaseSampler: (ctx, s) => (info.delete(s) ? 0 : -41),
            clCreatePipe: (ctx, c, flags, ps, maxp, props, err) => { const r = call('pipe_create', { ctx: c, flags: U(flags), packet_size: ps, max_packets: maxp }); errOut(ctx, err, errCode(r)); if (errCode(r)) return 0; info.set(r.result.h, { pipe: { ps, max: maxp } }); return r.result.h; },
            clGetPipeInfo: (ctx, p, name, size, v, ret) => { const E = info.get(p); if (!E || !E.pipe) return -38; if (name === 0x1120) return putVal(ctx, 'u32', E.pipe.ps, size, v, ret); if (name === 0x1121) return putVal(ctx, 'u32', E.pipe.max, size, v, ret); return -30; },

            // ---- 程式與核心
            clCreateProgramWithIL: (ctx, c, il, len, err) => {   // SPIR-V：不經 OpenCL C 前端
                len = U(len); if (!il || !(len >= 20)) { errOut(ctx, err, -30); return 0; }
                const r = call('prog_create_il', { ctx: c }, ctx.u8().slice(il, il + len)); errOut(ctx, err, errCode(r)); if (errCode(r)) return 0;
                info.set(r.result.h, { prog: true, src: '', il: true, log: '', built: false }); return r.result.h;
            },
            clCreateProgramWithBinary: (ctx, c, ndev, devs, lens, bins, status, err) => {   // 載入器的 binary 容器（clGetProgramInfo(BINARIES) 取得的）：目標相容就不經前端
                if (!ndev || !lens || !bins) { errOut(ctx, err, -30); return 0; }
                const len = ctx.dv().getUint32(lens, true), ptr = ctx.dv().getUint32(bins, true); if (!ptr || !len) { errOut(ctx, err, -30); if (status) errOut(ctx, status, -42); return 0; }
                const r = call('prog_create_binary', { ctx: c }, ctx.u8().slice(ptr, ptr + len)); const code = errCode(r); errOut(ctx, err, code); if (status) errOut(ctx, status, code); if (code) return 0;
                info.set(r.result.h, { prog: true, src: '', binary: true, log: '', built: false }); return r.result.h;
            },
            clSetProgramSpecializationConstant: (ctx, p, id, size, v) => { const E = info.get(p); if (!E || !E.il) return -44; if (!v) return -30; return errCode(call('prog_spec', { prog: p, id }, ctx.u8().slice(v, v + U(size)))); },
            clCreateProgramWithSource: (ctx, c, count, strs, lens, err) => {
                let src = ''; for (let i = 0; i < count; i++) { const sp = ctx.dv().getUint32(strs + 4 * i, true); let L = -1; if (lens) L = ctx.dv().getInt32(lens + 4 * i, true) | 0; src += L > 0 ? new TextDecoder().decode(ctx.u8().subarray(sp, sp + L)) : cstr(ctx, sp); }
                const r = call('prog_create', { ctx: c, src }); errOut(ctx, err, errCode(r)); if (errCode(r)) return 0; info.set(r.result.h, { prog: true, src, log: '', built: false }); return r.result.h;
            },
            clBuildProgram: (ctx, p, nd, devs, opts) => {
                const E = info.get(p); if (!E || !E.prog) return -44; const r = call('prog_build', { prog: p, options: opts ? cstr(ctx, opts) : '' }); const rr = r.result;
                if (rr.error && !('ok' in rr)) return rr.error.code; E.built = !!rr.ok; E.log = rr.log || ''; E.kernels = rr.kernels || []; E.options = opts ? cstr(ctx, opts) : '';
                if (!rr.ok) { warn('OpenCL 建置失敗：\n' + E.log + '\n'); return -11; } return 0;
            },
            clGetProgramBuildInfo: (ctx, p, d, name, size, v, ret) => {
                const E = info.get(p); if (!E || !E.prog) return -44;
                if (name === 0x1181) return putVal(ctx, 'u32', E.built ? 0 : (E.log ? -2 : -1), size, v, ret);   // CL_BUILD_SUCCESS／CL_BUILD_ERROR／CL_BUILD_NONE
                if (name === 0x1182) return putVal(ctx, 'str', E.options || '', size, v, ret);
                if (name === 0x1183) return putVal(ctx, 'str', E.log || '', size, v, ret);
                return -30;
            },
            clGetProgramInfo: (ctx, p, name, size, v, ret) => {
                const E = info.get(p); if (!E || !E.prog) return -44;
                if (name === 0x1164) return putVal(ctx, 'str', E.src, size, v, ret);
                if (name === 0x1169) { const r = call('prog_il', { prog: p }); return errCode(r) ? errCode(r) : putVal(ctx, 'raw', r.data, size, v, ret); }
                if (name === 0x1168) return putVal(ctx, 'str', (E.kernels || []).join(';'), size, v, ret);   // CL_PROGRAM_KERNEL_NAMES
                if (name === 0x1167) return putVal(ctx, 'size', (E.kernels || []).length, size, v, ret);    // CL_PROGRAM_NUM_KERNELS
                if (name === 0x1165 || name === 0x1166) {   // CL_PROGRAM_BINARY_SIZES／BINARIES：真的 binary 容器（最終產物＋內嵌 source／IL）
                    if (!E.built) return -45; const r = call('prog_binary', { prog: p }); if (errCode(r)) return errCode(r); const bin = r.data;
                    if (name === 0x1165) return putVal(ctx, 'sizes', [bin.length], size, v, ret);
                    if (!v) return 0; const dst = ctx.dv().getUint32(v, true); if (!dst) return -30; ctx.u8().set(bin, dst); return 0;
                }
                return -30;
            },
            clCreateKernel: (ctx, p, name, err) => {
                const E = info.get(p); if (!E || !E.prog) { errOut(ctx, err, -44); return 0; } if (!E.built) { errOut(ctx, err, -45); return 0; }
                const r = call('kernel_create', { prog: p, name: cstr(ctx, name) }); errOut(ctx, err, errCode(r)); if (errCode(r)) return 0;
                info.set(r.result.h, { kernel: true, args: r.result.args }); return r.result.h;
            },
            clSetKernelArg: (ctx, kp, idx, size, ptr) => {
                const K = info.get(kp); if (!K || !K.kernel) return -48; const spec = K.args[idx]; if (!spec) return -49; size = U(size);
                let a;
                if (spec.kind === 'local') { if (ptr) return -51; a = { local: size }; }
                else if (spec.kind === 'buf' || spec.kind === 'image' || spec.kind === 'pipe') {
                    if ((size !== 4 && size !== 8) || !ptr) return -51; const h = ctx.dv().getUint32(ptr, true); if (!h) return -38; a = { mem: h };   // cl_mem 在 wasm32 是 4 位元組；有的 IR 照 64 位元寫 8，低 4 位元組就是控制代碼（小端）
                } else {
                    if (!ptr) return -51;
                    if (spec.type === 'uint' && size === 4 && info.get(ctx.dv().getUint32(ptr, true)) && info.get(ctx.dv().getUint32(ptr, true)).sampler) a = { scalar: info.get(ctx.dv().getUint32(ptr, true)).bits };
                    else { const sv = decodeScalar(ctx, spec, size, ptr); if (sv === null) return -51; a = { scalar: sv }; }
                }
                const r = call('kernel_set_arg', Object.assign({ kernel: kp, index: idx }, a)); return errCode(r);
            },
            clGetKernelWorkGroupInfo: (ctx, kp, d, name, size, v, ret) => {
                if (!info.get(kp)) return -48;
                switch (name) {
                    case 0x11B0: return putVal(ctx, 'size', 256, size, v, ret);
                    case 0x11B1: return putVal(ctx, 'sizes', [0, 0, 0], size, v, ret);
                    case 0x11B2: case 0x11B4: return putVal(ctx, 'u64', 0, size, v, ret);
                    case 0x11B3: return putVal(ctx, 'size', 1, size, v, ret);
                    default: return -30;
                }
            },
            clEnqueueNDRangeKernel: (ctx, q, kp, dim, goff, gws, lws, nw, wl, evp) => {
                if (!(dim >= 1 && dim <= 3)) return -53; if (!gws) return -63;
                const r = call('nd_range', { queue: q, kernel: kp, global: sizes(ctx, gws, dim), local: lws ? sizes(ctx, lws, dim) : null, offset: goff ? sizes(ctx, goff, dim) : null });
                return mayWait(r, (x) => { const c = check(x); if (!c) evOut(ctx, evp, x.result.event); return c; });
            },
            clFinish: (ctx, q) => mayWait(call('finish', { queue: q }), (x) => check(x)),
            clFlush: (ctx, q) => (info.has(q) || true ? 0 : -36),
            clWaitForEvents: () => 0,
            clGetEventProfilingInfo: (ctx, e, name, size, v, ret) => { const E = info.get(e); if (!E || E.cmd === undefined) return -58; const t = { 0x1280: E.queued, 0x1281: E.queued, 0x1282: E.start, 0x1283: E.end }[name]; if (t === undefined) return -30; return putVal(ctx, 'u64', t, size, v, ret); },
            clEnqueueBarrier: () => 0, clEnqueueMarker: (ctx, q, evp) => { if (evp) evOut(ctx, evp, { h: 0 }); return 0; },
            clEnqueueBarrierWithWaitList: () => 0, clEnqueueMarkerWithWaitList: () => 0,
            clReleaseEvent: (ctx, e) => { info.delete(e); call('release', { h: e }); return 0; },
            clReleaseMemObject: (ctx, m) => { info.delete(m); const r = call('release', { h: m }); return errCode(r); },
            clReleaseKernel: (ctx, k) => { info.delete(k); call('release', { h: k }); return 0; }, clReleaseProgram: (ctx, p) => { info.delete(p); call('release', { h: p }); return 0; },
            clReleaseCommandQueue: (ctx, q) => { call('release', { h: q }); return 0; }, clReleaseContext: (ctx, c) => { call('release', { h: c }); return 0; },
            clRetainMemObject: () => 0, clRetainKernel: () => 0, clRetainProgram: () => 0, clRetainContext: () => 0, clRetainCommandQueue: () => 0, clRetainEvent: () => 0,

            // ---- 不提供的（如實回報）
            clCreateFromGLBuffer: (ctx, c, flags, name, err) => { errOut(ctx, err, -59); warn('OpenCL（ICD 模式）：GL 互通不在這個模式裡（拿掉 "; fa-opencl: icd" 註解就用預設的墊片，它有 GL 互通）\n'); return 0; },
            clGetGLObjectInfo: () => -59, clEnqueueAcquireGLObjects: () => -59, clEnqueueReleaseGLObjects: () => -59,
            fa_cl_pack: () => -30, fa_cl_view: () => 0, fa_cl_backend: () => 4,   // 4＝ICD 載入器
        };
        const pad = (a, d) => { while (a.length < 3) a.push(d); return a; };
        function makeImage(ctx, c, _unused, fmt, type, g, host, err, flags) {
            const dv = ctx.dv(), order = ORDERS[dv.getUint32(fmt, true) - 0x10B0], chType = CTYPES[dv.getUint32(fmt + 4, true) - 0x10D0];
            if (!order || !chType) { errOut(ctx, err, -39); return 0; }
            const four = (type === 'image1d_array') ? { w: g.w, h: g.arr || g.h, d: 1 } : (type === 'image2d_array') ? { w: g.w, h: g.h, d: g.arr || g.d } : { w: g.w, h: g.h || 1, d: g.d || 1 };
            let data = null;
            const args = { ctx: c, flags: Number(flags) || 0, type, w: four.w, h: four.h, d: four.d, order, chType, buffer: type === 'image1d_buffer' ? g.buffer : null };
            if (host && (Number(flags) & (8 | 32))) {
                const probe = { elem: elemSizeOf(order, chType) }; data = gather(ctx.u8(), host, [four.w, four.h, four.d], probe.elem, g.rp, g.sp);
            }
            const r = call('img_create', args, data); errOut(ctx, err, errCode(r)); if (errCode(r)) return 0;
            info.set(r.result.h, { img: { type, w: four.w, h: four.h, d: four.d, order, chType, elem: r.result.elem } }); return r.result.h;
        }
        const PACKED = { UNORM_SHORT_565: 2, UNORM_SHORT_555: 2, UNORM_INT_101010: 4 }, CN = { R: 1, A: 1, RG: 2, RA: 2, RGB: 3, RGBA: 4, BGRA: 4, ARGB: 4, INTENSITY: 1, LUMINANCE: 1, Rx: 2, RGx: 3, RGBx: 4 };
        const CB = { SNORM_INT8: 1, UNORM_INT8: 1, SIGNED_INT8: 1, UNSIGNED_INT8: 1, SNORM_INT16: 2, UNORM_INT16: 2, SIGNED_INT16: 2, UNSIGNED_INT16: 2, HALF_FLOAT: 2, SIGNED_INT32: 4, UNSIGNED_INT32: 4, FLOAT: 4 };
        const elemSizeOf = (o, t) => PACKED[t] || (CN[o] || 0) * (CB[t] || 0);
        // 主機陣列（可能有 row／slice pitch）↔ 緊密排列的 region 位元組
        function gather(u8, ptr, region, elem, rp, sp) {
            const [w, h, d] = region, rowb = w * elem, RP = rp || rowb, SP = sp || RP * h, out = new Uint8Array(rowb * h * d);
            for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) out.set(u8.subarray(ptr + z * SP + y * RP, ptr + z * SP + y * RP + rowb), (z * h + y) * rowb);
            return out;
        }
        function scatter(u8, ptr, data, region, elem, rp, sp) {
            const [w, h, d] = region, rowb = w * elem, RP = rp || rowb, SP = sp || RP * h;
            for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) u8.set(data.subarray((z * h + y) * rowb, (z * h + y + 1) * rowb), ptr + z * SP + y * RP);
        }
        function makeSampler(ctx, c, norm, addr, filt, err) {
            const A = { 0x1130: 0, 0x1131: 2, 0x1132: 4, 0x1133: 6, 0x1134: 8 }[addr], F = { 0x1140: 16, 0x1141: 32 }[filt];
            if (A === undefined || F === undefined) { errOut(ctx, err, -30); return 0; }
            const h = 0x7000 + (nextSampler++); info.set(h, { sampler: true, bits: (norm ? 1 : 0) | A | F }); errOut(ctx, err, 0); return h;
        }
        let nextSampler = 1;
        impls.clCreateImage = function (ctx, c, flags, fmt, desc, host, err) {
            if (!fmt || !desc) { errOut(ctx, err, -39); return 0; }
            const dv = ctx.dv(), type = IMG_TYPE[dv.getUint32(desc, true)]; if (!type) { errOut(ctx, err, -65); return 0; }
            return makeImage(ctx, c, 0, fmt, type, { w: dv.getUint32(desc + 4, true), h: dv.getUint32(desc + 8, true), d: dv.getUint32(desc + 12, true), arr: dv.getUint32(desc + 16, true), rp: dv.getUint32(desc + 20, true), sp: dv.getUint32(desc + 24, true), buffer: dv.getUint32(desc + 36, true) }, host, err, U(flags));
        };

        const sigs = {}; for (const k of Object.keys(SIGS)) sigs[k] = SIGS[k];
        return { impls, sigs, asyncFns: ASYNC_FNS };
    }
    return { build, wantsIcd, SIGS, ASYNC_FNS };
});
