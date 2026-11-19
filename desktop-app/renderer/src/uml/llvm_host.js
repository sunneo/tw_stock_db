/* LLVM IR 程式的「主機函式庫」（FaLlvmHost，UMD）：讓同一份 .ll（呼叫 SDL2、OpenGL、GTK3、printf 的 C API）在模擬環境的 wasm 裡也能跑。
 * IR 裡 declare 了這些函式、又沒有自己定義，llvm_core 就把它們編成 wasm 匯入（模組 env）；執行時（FaLlvm.runHost，JSPI）由這裡的 JS 實作：
 *   視窗、畫布、鍵盤、滑鼠經 GUI 橋接（跟 python 的 gui、pygame、gl3d 與 node 的 gui 同一套協定，見 gui_bridge.js）；
 *   OpenGL 固定管線（glBegin／glVertex／glColor…）收成一批批頂點，用 gl3d 的 flat 程式在 WebGL2 畫布畫；
 *   printf／snprintf／sprintf／atoi 等 libc 的格式化。
 * 範圍很小（見 SIGS 與 examples/llc/README.md）：沒有的函式 IR 檢查時會明確說「沒有實作」。
 *   const H = FaLlvmHost.create({ gui: async (op, args) => result, sleep, now })      gui：視窗操作（open、add、draw、poll、close、glbuf、glprog、glframe…）
 *   H.install(FaLlvm)      → 登記簽名（之後 IR 的 declare 才會被當成匯入；用完要 H.uninstall(FaLlvm)）      FaLlvm.runHost(bytes, io, H.impls)
 * 純邏輯：沒有 DOM；gui／sleep／now 由呼叫端傳入，所以 node 測試可以用假的。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLlvmHost = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // 每幀繪圖指令上限：與 GUI 橋接的 MAX_DRAW 一致（視窗依實測成本自適應繪製，不再是 200）
    const SDL_MAX_OPS = 100000;

    // ---- 簽名（跟 C 的原型一致；float＝'float'、指標＝'ptr'、Uint8＝'i8'）。async：會等 JS 的 Promise（用 JSPI 暫停 wasm）
    const SIGS = {
        // libc
        printf: { params: ['ptr'], ret: 'i32', varargs: true },
        snprintf: { params: ['ptr', 'i32|i64', 'ptr'], ret: 'i32', varargs: true },
        sprintf: { params: ['ptr', 'ptr'], ret: 'i32', varargs: true },
        atoi: { params: ['ptr'], ret: 'i32' },
        atof: { params: ['ptr'], ret: 'double' },
        // 數學（libm）：double 版與 float 版（sinf…）
        sin: { params: ['double'], ret: 'double' }, sinf: { params: ['float'], ret: 'float' },
        cos: { params: ['double'], ret: 'double' }, cosf: { params: ['float'], ret: 'float' },
        tan: { params: ['double'], ret: 'double' }, tanf: { params: ['float'], ret: 'float' },
        asin: { params: ['double'], ret: 'double' }, asinf: { params: ['float'], ret: 'float' },
        acos: { params: ['double'], ret: 'double' }, acosf: { params: ['float'], ret: 'float' },
        atan: { params: ['double'], ret: 'double' }, atanf: { params: ['float'], ret: 'float' },
        sqrt: { params: ['double'], ret: 'double' }, sqrtf: { params: ['float'], ret: 'float' },
        exp: { params: ['double'], ret: 'double' }, expf: { params: ['float'], ret: 'float' },
        log: { params: ['double'], ret: 'double' }, logf: { params: ['float'], ret: 'float' },
        log2: { params: ['double'], ret: 'double' }, log2f: { params: ['float'], ret: 'float' },
        log10: { params: ['double'], ret: 'double' }, log10f: { params: ['float'], ret: 'float' },
        fabs: { params: ['double'], ret: 'double' }, fabsf: { params: ['float'], ret: 'float' },
        floor: { params: ['double'], ret: 'double' }, floorf: { params: ['float'], ret: 'float' },
        ceil: { params: ['double'], ret: 'double' }, ceilf: { params: ['float'], ret: 'float' },
        round: { params: ['double'], ret: 'double' }, roundf: { params: ['float'], ret: 'float' },
        trunc: { params: ['double'], ret: 'double' }, truncf: { params: ['float'], ret: 'float' },
        sinh: { params: ['double'], ret: 'double' }, sinhf: { params: ['float'], ret: 'float' },
        cosh: { params: ['double'], ret: 'double' }, coshf: { params: ['float'], ret: 'float' },
        tanh: { params: ['double'], ret: 'double' }, tanhf: { params: ['float'], ret: 'float' },
        cbrt: { params: ['double'], ret: 'double' }, cbrtf: { params: ['float'], ret: 'float' },
        atan2: { params: ['double', 'double'], ret: 'double' }, atan2f: { params: ['float', 'float'], ret: 'float' },
        pow: { params: ['double', 'double'], ret: 'double' }, powf: { params: ['float', 'float'], ret: 'float' },
        fmod: { params: ['double', 'double'], ret: 'double' }, fmodf: { params: ['float', 'float'], ret: 'float' },
        fmin: { params: ['double', 'double'], ret: 'double' }, fminf: { params: ['float', 'float'], ret: 'float' },
        fmax: { params: ['double', 'double'], ret: 'double' }, fmaxf: { params: ['float', 'float'], ret: 'float' },
        hypot: { params: ['double', 'double'], ret: 'double' }, hypotf: { params: ['float', 'float'], ret: 'float' },
        // 檔案（stdio）：接到呼叫端給的 fs（終端機沙盒的檔案系統，含 /mnt/<名稱>）。寫入在 fclose／fflush／程式結束時才寫回
        fopen: { params: ['ptr', 'ptr'], ret: 'ptr' }, fclose: { params: ['ptr'], ret: 'i32' }, fflush: { params: ['ptr'], ret: 'i32' },
        fread: { params: ['ptr', 'i32|i64', 'i32|i64', 'ptr'], ret: 'i32|i64' }, fwrite: { params: ['ptr', 'i32|i64', 'i32|i64', 'ptr'], ret: 'i32|i64' },
        fgets: { params: ['ptr', 'i32', 'ptr'], ret: 'ptr' }, fputs: { params: ['ptr', 'ptr'], ret: 'i32' }, fgetc: { params: ['ptr'], ret: 'i32' }, fputc: { params: ['i32', 'ptr'], ret: 'i32' },
        fseek: { params: ['ptr', 'i32|i64', 'i32'], ret: 'i32' }, ftell: { params: ['ptr'], ret: 'i32|i64' }, rewind: { params: ['ptr'], ret: 'void' }, feof: { params: ['ptr'], ret: 'i32' }, ferror: { params: ['ptr'], ret: 'i32' },
        remove: { params: ['ptr'], ret: 'i32' }, rename: { params: ['ptr', 'ptr'], ret: 'i32' }, access: { params: ['ptr', 'i32'], ret: 'i32' },
        // SDL2：視窗、渲染器、事件、時間
        SDL_Init: { params: ['i32'], ret: 'i32' }, SDL_Quit: { params: [], ret: 'void' },
        SDL_CreateWindow: { params: ['ptr', 'i32', 'i32', 'i32', 'i32', 'i32'], ret: 'ptr' }, SDL_DestroyWindow: { params: ['ptr'], ret: 'void' },
        SDL_SetWindowTitle: { params: ['ptr', 'ptr'], ret: 'void' },
        SDL_CreateRenderer: { params: ['ptr', 'i32', 'i32'], ret: 'ptr' }, SDL_DestroyRenderer: { params: ['ptr'], ret: 'void' },
        SDL_SetRenderDrawColor: { params: ['ptr', 'i8', 'i8', 'i8', 'i8'], ret: 'i32' },
        SDL_RenderClear: { params: ['ptr'], ret: 'i32' }, SDL_RenderFillRect: { params: ['ptr', 'ptr'], ret: 'i32' }, SDL_RenderDrawRect: { params: ['ptr', 'ptr'], ret: 'i32' },
        SDL_RenderDrawLine: { params: ['ptr', 'i32', 'i32', 'i32', 'i32'], ret: 'i32' }, SDL_RenderDrawPoint: { params: ['ptr', 'i32', 'i32'], ret: 'i32' },
        SDL_RenderPresent: { params: ['ptr'], ret: 'void', async: true },
        SDL_PollEvent: { params: ['ptr'], ret: 'i32', async: true },
        SDL_Delay: { params: ['i32'], ret: 'void', async: true }, SDL_GetTicks: { params: [], ret: 'i32' },
        // SDL2 音訊（佇列模式：callback 給 NULL，用 SDL_QueueAudio 送 PCM）；SDL_AudioSpec 的欄位偏移：freq 0、format 4、channels 6、silence 7、samples 8、size 12、callback 16
        SDL_OpenAudioDevice: { params: ['ptr', 'i32', 'ptr', 'ptr', 'i32'], ret: 'i32', async: true }, SDL_OpenAudio: { params: ['ptr', 'ptr'], ret: 'i32', async: true },
        SDL_QueueAudio: { params: ['i32', 'ptr', 'i32'], ret: 'i32', async: true }, SDL_GetQueuedAudioSize: { params: ['i32'], ret: 'i32', async: true },
        SDL_ClearQueuedAudio: { params: ['i32'], ret: 'void', async: true }, SDL_PauseAudioDevice: { params: ['i32', 'i32'], ret: 'void', async: true },
        SDL_PauseAudio: { params: ['i32'], ret: 'void', async: true }, SDL_CloseAudioDevice: { params: ['i32'], ret: 'void', async: true }, SDL_CloseAudio: { params: [], ret: 'void', async: true },
        // SDL2 的 OpenGL 視窗
        SDL_GL_SetAttribute: { params: ['i32', 'i32'], ret: 'i32' }, SDL_GL_CreateContext: { params: ['ptr'], ret: 'ptr' }, SDL_GL_DeleteContext: { params: ['ptr'], ret: 'void' },
        SDL_GL_SetSwapInterval: { params: ['i32'], ret: 'i32' }, SDL_GL_SwapWindow: { params: ['ptr'], ret: 'void', async: true },
        // OpenGL 固定管線（即時模式）
        glClearColor: { params: ['float', 'float', 'float', 'float'], ret: 'void' }, glClear: { params: ['i32'], ret: 'void' },
        glViewport: { params: ['i32', 'i32', 'i32', 'i32'], ret: 'void' },
        glMatrixMode: { params: ['i32'], ret: 'void' }, glLoadIdentity: { params: [], ret: 'void' }, glPushMatrix: { params: [], ret: 'void' }, glPopMatrix: { params: [], ret: 'void' },
        glTranslatef: { params: ['float', 'float', 'float'], ret: 'void' }, glScalef: { params: ['float', 'float', 'float'], ret: 'void' }, glRotatef: { params: ['float', 'float', 'float', 'float'], ret: 'void' },
        glOrtho: { params: ['double', 'double', 'double', 'double', 'double', 'double'], ret: 'void' }, glFrustum: { params: ['double', 'double', 'double', 'double', 'double', 'double'], ret: 'void' },
        gluPerspective: { params: ['double', 'double', 'double', 'double'], ret: 'void' },
        glBegin: { params: ['i32'], ret: 'void' }, glEnd: { params: [], ret: 'void' },
        glColor3f: { params: ['float', 'float', 'float'], ret: 'void' }, glColor4f: { params: ['float', 'float', 'float', 'float'], ret: 'void' },
        glVertex2f: { params: ['float', 'float'], ret: 'void' }, glVertex3f: { params: ['float', 'float', 'float'], ret: 'void' },
        glEnable: { params: ['i32'], ret: 'void' }, glDisable: { params: ['i32'], ret: 'void' },
        glPointSize: { params: ['float'], ret: 'void' }, glLineWidth: { params: ['float'], ret: 'void' },
        glBlendFunc: { params: ['i32', 'i32'], ret: 'void' }, glPointParameterfv: { params: ['i32', 'ptr'], ret: 'void' }, gluLookAt: { params: ['double', 'double', 'double', 'double', 'double', 'double', 'double', 'double', 'double'], ret: 'void' },
        // GTK3：widget（視窗、盒子、標籤、輸入框、按鈕、勾選框、進度條）與訊號、計時器。函式指標是 wasm 函式表格的索引（見 llvm_core 的函式指標）
        gtk_init: { params: ['ptr', 'ptr'], ret: 'void' }, gtk_main: { params: [], ret: 'void', async: true }, gtk_main_quit: { params: [], ret: 'void' },
        gtk_window_new: { params: ['i32'], ret: 'ptr' }, gtk_window_set_title: { params: ['ptr', 'ptr'], ret: 'void' }, gtk_window_set_default_size: { params: ['ptr', 'i32', 'i32'], ret: 'void' },
        gtk_container_add: { params: ['ptr', 'ptr'], ret: 'void' }, gtk_container_set_border_width: { params: ['ptr', 'i32'], ret: 'void' },
        gtk_widget_show_all: { params: ['ptr'], ret: 'void' }, gtk_widget_show: { params: ['ptr'], ret: 'void' }, gtk_widget_destroy: { params: ['ptr'], ret: 'void' }, gtk_widget_set_sensitive: { params: ['ptr', 'i32'], ret: 'void' },
        gtk_box_new: { params: ['i32', 'i32'], ret: 'ptr' }, gtk_box_pack_start: { params: ['ptr', 'ptr', 'i32', 'i32', 'i32'], ret: 'void' }, gtk_box_pack_end: { params: ['ptr', 'ptr', 'i32', 'i32', 'i32'], ret: 'void' },
        gtk_label_new: { params: ['ptr'], ret: 'ptr' }, gtk_label_set_text: { params: ['ptr', 'ptr'], ret: 'void' }, gtk_label_get_text: { params: ['ptr'], ret: 'ptr' },
        gtk_entry_new: { params: [], ret: 'ptr' }, gtk_entry_set_text: { params: ['ptr', 'ptr'], ret: 'void' }, gtk_entry_get_text: { params: ['ptr'], ret: 'ptr' },
        gtk_button_new_with_label: { params: ['ptr'], ret: 'ptr' }, gtk_button_set_label: { params: ['ptr', 'ptr'], ret: 'void' }, gtk_button_clicked: { params: ['ptr'], ret: 'void' },
        gtk_check_button_new_with_label: { params: ['ptr'], ret: 'ptr' }, gtk_toggle_button_get_active: { params: ['ptr'], ret: 'i32' }, gtk_toggle_button_set_active: { params: ['ptr', 'i32'], ret: 'void' },
        gtk_progress_bar_new: { params: [], ret: 'ptr' }, gtk_progress_bar_set_fraction: { params: ['ptr', 'double'], ret: 'void' },
        g_signal_connect_data: { params: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'i32'], ret: 'i32' }, g_timeout_add: { params: ['i32', 'ptr', 'ptr'], ret: 'i32' }, g_source_remove: { params: ['i32'], ret: 'i32' },
        // OpenCL 1.2 最小子集（CPU 後備：核心用 JS 執行，見 clCompile）。size_t／cl_ulong 收 i32 或 i64（x86_64 風格的 IR 用 i64）
        clGetPlatformIDs: { params: ['i32', 'ptr', 'ptr'], ret: 'i32' }, clGetDeviceIDs: { params: ['ptr', 'i32|i64', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clGetPlatformInfo: { params: ['ptr', 'i32', 'i32|i64', 'ptr', 'ptr'], ret: 'i32' }, clGetDeviceInfo: { params: ['ptr', 'i32', 'i32|i64', 'ptr', 'ptr'], ret: 'i32' },
        clCreateContext: { params: ['ptr', 'i32', 'ptr', 'ptr', 'ptr', 'ptr'], ret: 'ptr' }, clCreateCommandQueue: { params: ['ptr', 'ptr', 'i32|i64', 'ptr'], ret: 'ptr' },
        clCreateCommandQueueWithProperties: { params: ['ptr', 'ptr', 'ptr', 'ptr'], ret: 'ptr' },
        clCreateBuffer: { params: ['ptr', 'i32|i64', 'i32|i64', 'ptr', 'ptr'], ret: 'ptr' },
        clEnqueueWriteBuffer: { params: ['ptr', 'ptr', 'i32', 'i32|i64', 'i32|i64', 'ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' }, clEnqueueReadBuffer: { params: ['ptr', 'ptr', 'i32', 'i32|i64', 'i32|i64', 'ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' },
        clCreateProgramWithSource: { params: ['ptr', 'i32', 'ptr', 'ptr', 'ptr'], ret: 'ptr' }, clBuildProgram: { params: ['ptr', 'i32', 'ptr', 'ptr', 'ptr', 'ptr'], ret: 'i32' },
        clGetProgramBuildInfo: { params: ['ptr', 'ptr', 'i32', 'i32|i64', 'ptr', 'ptr'], ret: 'i32' },
        clCreateKernel: { params: ['ptr', 'ptr', 'ptr'], ret: 'ptr' }, clSetKernelArg: { params: ['ptr', 'i32', 'i32|i64', 'ptr'], ret: 'i32' },
        fa_cl_backend: { params: [], ret: 'i32' },
        fa_cl_pack: { params: ['ptr', 'i32'], ret: 'i32' }, fa_cl_view: { params: ['ptr', 'i32'], ret: 'ptr' }, fa_cl_points: { params: ['ptr', 'ptr', 'ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' },   // 本程式最後一次 OpenCL 派送用的後端：0＝尚未派送、1＝WebGL2（KIR，裝置或複製）、2＝JS 墊片
        clEnqueueNDRangeKernel: { params: ['ptr', 'ptr', 'i32', 'ptr', 'ptr', 'ptr', 'i32', 'ptr', 'ptr'], ret: 'i32' }, clFinish: { params: ['ptr'], ret: 'i32' }, clFlush: { params: ['ptr'], ret: 'i32' },
        clWaitForEvents: { params: ['i32', 'ptr'], ret: 'i32' }, clReleaseEvent: { params: ['ptr'], ret: 'i32' },
        clReleaseMemObject: { params: ['ptr'], ret: 'i32' }, clReleaseKernel: { params: ['ptr'], ret: 'i32' }, clReleaseProgram: { params: ['ptr'], ret: 'i32' },
        clReleaseCommandQueue: { params: ['ptr'], ret: 'i32' }, clReleaseContext: { params: ['ptr'], ret: 'i32' },
    };

    // ---- OpenCL C 子集 → JS（CPU 後備）。回傳 { kernels:{名字:{params:[{name,type,ptr}], run(gs,off,args)}} } 或 { error }
    const CL_ELEM = { float: Float32Array, int: Int32Array, uint: Uint32Array, char: Int8Array, uchar: Uint8Array, short: Int16Array, ushort: Uint16Array, double: Float64Array };
    const CL_SCALAR = { float: 'getFloat32', int: 'getInt32', uint: 'getUint32', char: 'getInt8', uchar: 'getUint8', short: 'getInt16', ushort: 'getUint16', double: 'getFloat64' };
    const CL_TYPES = 'float|int|uint|uchar|char|short|ushort|double|size_t|bool';
    function clCompile(src) {
        let t = String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/^\s*#pragma[^\n]*/gm, ' ');
        const kernels = {}, re = /(?:__kernel|\bkernel)\s+void\s+(\w+)\s*\(([^)]*)\)\s*\{/g; let m, rest = '', last = 0;
        while ((m = re.exec(t))) {
            let d = 1, i = re.lastIndex; while (i < t.length && d) { if (t[i] === '{') d++; else if (t[i] === '}') d--; i++; }
            if (d) return { error: 'kernel ' + m[1] + '：大括號不成對' };
            rest += t.slice(last, m.index); last = re.lastIndex = i; let body = t.slice(m.index + m[0].length, i - 1);
            if (/\b(__local|local|barrier|mem_fence|struct|image\w*|atomic_\w+|__private)\b|\b(float|int|uint|char|uchar|short|ushort|double)(2|3|4|8|16)\b/.test(body + ' ' + m[2])) return { error: 'kernel ' + m[1] + '：用到本墊片沒有的功能（__local／barrier／向量型別／struct／image／atomic）' };
            const params = []; const ints = new Set();
            for (const raw of m[2].split(',').map((x) => x.trim()).filter(Boolean)) {
                const q = raw.replace(/\b(__global|global|__constant|constant|const|restrict|__restrict|volatile)\b/g, ' ').replace(/\s+/g, ' ').trim(), pm = /^(\w+)\s*(\*)?\s*(\w+)$/.exec(q.replace(/\*\s*/g, '* ').replace(/(\w)\*/g, '$1 *'));
                if (!pm || !CL_ELEM[pm[1]]) return { error: 'kernel ' + m[1] + '：不支援的參數 "' + raw + '"（支援 float／int／uint／char／uchar／short／ushort／double 與其指標）' };
                params.push({ name: pm[3], type: pm[1], ptr: !!pm[2] }); if (!pm[2] && /^(int|uint|short|ushort|char|uchar)$/.test(pm[1])) ints.add(pm[3]);
            }
            body = body.replace(/\b(__global|global|__constant|constant|const|restrict|__restrict)\b/g, ' ').replace(/(\d(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fF]\b/g, (x) => x.slice(0, -1));
            body = body.replace(new RegExp('\\b(' + CL_TYPES + ')\\s+(?=[A-Za-z_])', 'g'), (x, ty, off) => { const dm = /^\s*(\w+)/.exec(body.slice(off + x.length)); if (dm && /^(int|uint|short|ushort|char|uchar|size_t|bool)$/.test(ty)) ints.add(dm[1]); return 'let '; });
            body = body.replace(/\((?:float|double)\)/g, '').replace(/\((int|uint|short|ushort|char|uchar|size_t)\)\s*(\w+(?:\[[^\]]*\])?|\([^()]*\))/g, 'Math.trunc($2)');
            const isInt = (x) => /^\d+$/.test(x) || ints.has(x) || /^get_(global|local|group)_id\(\d\)$/.test(x);
            body = body.replace(/(get_\w+\(\d\)|\w+)\s*\/\s*(get_\w+\(\d\)|\w+)(?!\s*=)/g, (x, a, b) => (isInt(a) && isInt(b) ? '((' + a + '/' + b + ')|0)' : x));
            const names = params.map((p) => p.name), code = 'let [' + names.join(',') + ']=__a;const __g=[0,0,0];const get_global_id=(d)=>__g[d],get_group_id=(d)=>__g[d],get_global_size=(d)=>__gs[d],get_num_groups=(d)=>__gs[d],get_local_id=()=>0,get_local_size=()=>1,get_work_dim=()=>__dim,get_global_offset=(d)=>__off[d],sqrt=Math.sqrt,native_sqrt=Math.sqrt,rsqrt=(x)=>1/Math.sqrt(x),fabs=Math.abs,abs=Math.abs,sin=Math.sin,cos=Math.cos,tan=Math.tan,exp=Math.exp,log=Math.log,pow=Math.pow,floor=Math.floor,ceil=Math.ceil,fmin=Math.min,fmax=Math.max,min=Math.min,max=Math.max,atan2=Math.atan2,hypot=Math.hypot,fmod=(a,b)=>a%b,mad=(a,b,c)=>a*b+c,fma=(a,b,c)=>a*b+c,clamp=(x,a,b)=>Math.min(Math.max(x,a),b),M_PI=Math.PI,M_PI_F=Math.PI;const __k=()=>{' + body + '\n};for(let z=0;z<__gs[2];z++){__g[2]=__off[2]+z;for(let y=0;y<__gs[1];y++){__g[1]=__off[1]+y;for(let x=0;x<__gs[0];x++){__g[0]=__off[0]+x;__k();}}}';
            let fn; try { fn = new Function('__gs', '__off', '__dim', '__a', code); } catch (e) { return { error: 'kernel ' + m[1] + '：翻譯後語法錯誤（' + e.message + '）；本墊片只支援簡單的 OpenCL C 子集' }; }
            kernels[m[1]] = { params, run: fn };
        }
        rest += t.slice(last); if (rest.replace(/\s+/g, '')) return { error: '除了 __kernel 函式之外還有程式碼（輔助函式、全域變數、巨集）——本墊片不支援：' + rest.trim().slice(0, 60) };
        if (!Object.keys(kernels).length) return { error: '原始碼裡沒有 __kernel void 函式' };
        return { kernels };
    }

    // ---- 小工具
    const css = (r, g, b) => '#' + [r, g, b].map((x) => ('0' + (x & 255).toString(16)).slice(-2)).join('');
    function cstr(ctx, p) { const m = ctx.u8(); let e = p; while (m[e]) e++; return new TextDecoder('utf-8').decode(m.subarray(p, e)); }
    function writeCStr(ctx, p, s, cap) { const b = new TextEncoder().encode(s), n = Math.min(b.length, Math.max(0, cap - 1)); if (cap > 0) { ctx.u8().set(b.subarray(0, n), p); ctx.u8()[p + n] = 0; } return b.length; }
    // C 的格式化（printf 家族）：args＝指向 8 位元組對齊引數緩衝區的指標（llvm_core 的可變參數轉換）
    function formatC(ctx, fmtPtr, argsPtr) {
        const fmt = cstr(ctx, fmtPtr), dv = ctx.dv(); let ai = 0, out = '';
        const nextI32 = () => dv.getInt32(argsPtr + 8 * ai++, true), nextI64 = () => Number(dv.getBigInt64(argsPtr + 8 * ai++, true)), nextF = () => dv.getFloat64(argsPtr + 8 * ai++, true);
        for (let i = 0; i < fmt.length; i++) {
            const c = fmt[i]; if (c !== '%') { out += c; continue; }
            const m = /^%([-+ 0#]*)(\d+)?(?:\.(\d+))?(hh|h|ll|l|z)?([diuxXcsfFeEgGp%])/.exec(fmt.slice(i)); if (!m) { out += c; continue; }
            i += m[0].length - 1; const [, flags, w, pr, len, conv] = m; let s;
            if (conv === '%') { out += '%'; continue; }
            const wide = len === 'll' || len === 'l' || len === 'z';
            if (conv === 'd' || conv === 'i') { const v = wide ? nextI64() : nextI32(); s = String(Math.abs(v)); if (pr !== undefined) s = s.padStart(+pr, '0'); s = (v < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + s; }
            else if (conv === 'u') { const v = wide ? nextI64() : nextI32() >>> 0; s = String(v < 0 ? v + 2 ** 64 : v); }
            else if (conv === 'x' || conv === 'X') { const v = wide ? nextI64() : nextI32() >>> 0; s = (v < 0 ? BigInt.asUintN(64, BigInt(v)) : v).toString(16); if (conv === 'X') s = s.toUpperCase(); if (flags.includes('#') && v) s = '0x' + s; }
            else if (conv === 'p') s = '0x' + (nextI32() >>> 0).toString(16);
            else if (conv === 'c') s = String.fromCharCode(nextI32() & 255);
            else if (conv === 's') { s = cstr(ctx, nextI32()); if (pr !== undefined) s = s.slice(0, +pr); }
            else { const v = nextF(), p = pr === undefined ? 6 : +pr; s = conv === 'f' || conv === 'F' ? v.toFixed(p) : conv === 'e' || conv === 'E' ? v.toExponential(p).replace(/e([+-])(\d)$/, 'e$10$2') : String(+v.toPrecision(p || 1)); if (conv === 'E') s = s.toUpperCase(); if (v >= 0 && flags.includes('+')) s = '+' + s; }
            if (w && s.length < +w) s = flags.includes('-') ? s.padEnd(+w) : (flags.includes('0') && conv !== 's' && conv !== 'c' ? (/^[+-]/.test(s) ? s[0] + s.slice(1).padStart(+w - 1, '0') : s.padStart(+w, '0')) : s.padStart(+w));
            out += s;
        }
        return out;
    }

    // ---- SDL 的鍵盤對照（瀏覽器的 event.key → SDL scancode／keycode）
    const NAMED = { Enter: 40, Escape: 41, Backspace: 42, Tab: 43, ' ': 44, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82, Home: 74, End: 77, PageUp: 75, PageDown: 78, Delete: 76, Insert: 73, Shift: 225, Control: 224, Alt: 226 };
    function scancodeOf(key) {
        if (NAMED[key] !== undefined) return NAMED[key]; const k = String(key);
        if (/^[a-zA-Z]$/.test(k)) return 4 + k.toLowerCase().charCodeAt(0) - 97;
        if (/^[1-9]$/.test(k)) return 30 + +k - 1; if (k === '0') return 39;
        const f = /^F(\d{1,2})$/.exec(k); if (f && +f[1] >= 1 && +f[1] <= 12) return 58 + +f[1] - 1;
        return 0;
    }
    function keycodeOf(key, sc) { const k = String(key); if (/^[a-zA-Z]$/.test(k)) return k.toLowerCase().charCodeAt(0); if (/^[0-9]$/.test(k)) return k.charCodeAt(0); if (k === ' ') return 32; if (k === 'Enter') return 13; if (k === 'Escape') return 27; if (k === 'Backspace') return 8; if (k === 'Tab') return 9; return (sc | 0x40000000) >>> 0; }

    // ---- 4×4 矩陣（欄優先，跟 OpenGL 一樣）
    const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    function mul4(a, b) { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
    const GL_MODE = { 0: 'points', 1: 'lines', 2: 'line_strip', 3: 'line_strip', 4: 'triangles', 5: 'triangle_strip', 6: 'triangles', 7: 'triangles' };
    const FLAT_VS = '#version 300 es\nin vec3 pos; in vec3 col; uniform mat4 mvp; out vec3 vcol;\nvoid main(){ vcol = col; gl_Position = mvp * vec4(pos, 1.0); }';
    const GLOW_VS = '#version 300 es\nin vec3 pos; in vec3 col; uniform mat4 mvp; uniform float size; uniform float ref; out vec3 vcol;\nvoid main(){ vcol = col; gl_Position = mvp * vec4(pos, 1.0); gl_PointSize = max(1.0, ref > 0.0 ? size * ref / max(gl_Position.w, 0.2) : size); }';
    const GLOW_FS = '#version 300 es\nprecision mediump float; in vec3 vcol; uniform float gain; out vec4 o;\nvoid main(){ vec2 d = gl_PointCoord - vec2(0.5); float r2 = dot(d, d) * 4.0; if (r2 > 1.0) discard; o = vec4(vcol, gain * exp(-4.0 * r2)); }';
    const POINTS_VS = '#version 300 es\nin vec3 pos; in vec3 col; uniform mat4 mvp; uniform float size; uniform vec3 tint; out vec3 vcol;\nvoid main(){ vcol = col * tint; gl_Position = mvp * vec4(pos, 1.0); gl_PointSize = max(1.0, size); }';
    const POINTS_FS = '#version 300 es\nprecision mediump float; in vec3 vcol; out vec4 o;\nvoid main(){ vec2 d = gl_PointCoord - vec2(0.5); float r = dot(d, d); if (r > 0.25) discard; o = vec4(vcol * (1.0 - 1.2 * r), 1.0); }';
    const FLAT_FS = '#version 300 es\nprecision mediump float; in vec3 vcol; out vec4 o;\nvoid main(){ o = vec4(vcol, 1.0); }';

    let installs = 0;   // 同時有幾個程式在用（登記是全域的：最後一個結束才取消，不然別的 IR 工具會把 printf 之類當成主機函式）
    function create(o) {
        o = o || {}; const asyncRb = !!o.asyncReadback; const sigs = Object.assign({}, SIGS, { clEnqueueReadBuffer: Object.assign({}, SIGS.clEnqueueReadBuffer, { async: !!o.asyncReadback }), clEnqueueNDRangeKernel: Object.assign({}, SIGS.clEnqueueNDRangeKernel, { async: !!o.asyncReadback }) }); const gui = o.gui, sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), now = o.now || (() => Date.now()), warn = o.warn || (() => {});
        // OpenCL → KIR 接線（DESIGN.webgpu-cuda.md §13 階段 4）：kirTranslate(src) → { 核心名: KIR 核心 } 或 null（不支援）；kirRun(核心, { 參數名: 型別化陣列 }, { 純量名: 數字 }, N) → { out: { 名: Float32Array } }（失敗就丟例外）。
        // 沒有提供、或翻譯／執行失敗，就退回 JS 後備（clCompile 的核心）。
        const kirTranslate = o.kirTranslate || null, kirRun = o.kirRun || null;
        // 常駐裝置（DESIGN.webgpu-cuda.md §13 階段 6 步驟 1b）：kirDev＝{ alloc(N,elem), upload(b, arr), download(b), dispatch(核心, binds, out, scal, N), free(b) }。
        // 有它且有 kirTranslate 時，核心在裝置上跑；緩衝區記錄「主機副本是否最新」（hostOk）與「裝置副本是否最新」（devOk），讀寫時才同步。
        const kirDev = o.kirDev || null; const kirDevKind = o.kirBackend === 'webgpu' ? 'webgpu' : 'webgl2';
        let clBackend = 0;   // fa_cl_backend 的值（見 SIGS）
        const t0 = now(); let handleSeq = 0x1000, winSeq = 0, nodeSeq = 0; const handles = new Map();   // 不透明指標（SDL_Window*、SDL_Renderer*、SDL_GLContext）→ 狀態
        const mk = (obj) => { const h = (handleSeq += 16); handles.set(h, obj); return h; };
        const gl = { clear: [0.05, 0.06, 0.09, 1], mode: 'MV', stacks: { MV: [I4()], P: [I4()] }, begin: null, color: [1, 1, 1], batches: [], depth: false, pointSize: 1, blend: false, blendAdd: false, alpha: 1, atten: 0, warned: {} };
        const top = (n) => gl.stacks[n][gl.stacks[n].length - 1];
        const setTop = (n, m) => { gl.stacks[n][gl.stacks[n].length - 1] = m; };
        const cur = () => (gl.mode === 'P' ? 'P' : 'MV');

        async function ensureWindow(w) {
            if (w.opened) return; w.opened = true; w.id = 'sdl' + (++winSeq) + '_' + Math.random().toString(36).slice(2, 6); w.nid = 'c' + (++nodeSeq);
            await gui('open', { id: w.id, title: w.title, width: Math.min(1200, w.w + 24) });
            await gui('add', { id: w.id, parent: 'root', node: Object.assign({ id: w.nid, kind: 'canvas', width: Math.min(1200, w.w), height: Math.min(1200, w.h), fps: 0, fit: true }, w.gl ? { gl: true } : {}) });
            if (w.gl) { await gui('glprog', { id: w.id, node: w.nid, name: 'flat', vs: FLAT_VS, fs: FLAT_FS }); await gui('glprog', { id: w.id, node: w.nid, name: 'points', vs: POINTS_VS, fs: POINTS_FS }); await gui('glprog', { id: w.id, node: w.nid, name: 'glow', vs: GLOW_VS, fs: GLOW_FS }); }
        }
        const winOf = (p) => { const w = handles.get(p); return w && w.kind === 'renderer' ? w.win : w && w.kind === 'window' ? w : null; };
        const rend = (p) => { const r = handles.get(p); return r && r.kind === 'renderer' ? r : null; };
        const audioDevs = new Map(); let audioSeq = 1;   // 裝置號 → {id（頁面端的串流名）, rate, channels, fmt, bps}；SDL_OpenAudio 用 1，SDL_OpenAudioDevice 從 2 起
        async function openAudio(ctx, capture, spec, obt, legacy) {
            if (capture || !spec) return 0;
            const dv = ctx.dv(), u8 = ctx.u8(), rate = dv.getInt32(spec, true), fmt = dv.getUint16(spec + 4, true), ch = u8[spec + 6], samples = dv.getUint16(spec + 8, true), cb = dv.getUint32(spec + 16, true);
            if (cb) { warn('SDL 音訊：不支援 callback 模式（audio callback）；請把 SDL_AudioSpec 的 callback 設成 NULL，用 SDL_QueueAudio 送資料\n'); return 0; }
            const bps = { 0x0008: 1, 0x8008: 1, 0x0010: 2, 0x8010: 2, 0x8020: 4, 0x8120: 4 }[fmt];
            if (!bps || (ch !== 1 && ch !== 2) || rate < 3000 || rate > 192000) { warn('SDL 音訊：不支援的格式（支援 U8、S8、U16LSB、S16LSB、S32LSB、F32LSB，1 或 2 聲道，3000~192000 Hz）\n'); return 0; }
            const dev = legacy ? 1 : (audioSeq = Math.max(audioSeq, 1) + 1), id = 'sdla' + dev + '_' + Math.random().toString(36).slice(2, 6);
            await gui('audio', { cmd: 'stream_open', id, rate, channels: ch }); await gui('audio', { cmd: 'stream_pause', id, on: true });
            audioDevs.set(dev, { id, rate, channels: ch, fmt, bps });
            if (obt) { u8.copyWithin(obt, spec, spec + 16); u8[obt + 7] = (fmt === 0x0008 ? 128 : 0); dv.setUint32(obt + 12, (samples || 4096) * ch * bps, true); dv.setUint32(obt + 16, 0, true); }
            return dev;
        }
        function toS16(src, fmt) {   // SDL 的取樣格式 → 16 位元有號小端 PCM
            const dv = new DataView(src.buffer, src.byteOffset, src.byteLength), out = new Uint8Array(src.length / ({ 0x0008: 1, 0x8008: 1, 0x0010: 2, 0x8010: 2, 0x8020: 4, 0x8120: 4 }[fmt]) * 2), od = new DataView(out.buffer);
            if (fmt === 0x8010) return src.slice();
            let n = 0;
            if (fmt === 0x0008) for (let i = 0; i < src.length; i++, n++) od.setInt16(n * 2, (src[i] - 128) << 8, true);
            else if (fmt === 0x8008) for (let i = 0; i < src.length; i++, n++) od.setInt16(n * 2, dv.getInt8(i) << 8, true);
            else if (fmt === 0x0010) for (let i = 0; i + 1 < src.length; i += 2, n++) od.setInt16(n * 2, dv.getUint16(i, true) - 32768, true);
            else if (fmt === 0x8020) for (let i = 0; i + 3 < src.length; i += 4, n++) od.setInt16(n * 2, dv.getInt32(i, true) >> 16, true);
            else for (let i = 0; i + 3 < src.length; i += 4, n++) od.setInt16(n * 2, Math.max(-32768, Math.min(32767, Math.round(dv.getFloat32(i, true) * 32767))), true);
            return out;
        }
        function b64(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
        // ---- 檔案：FILE* 是不透明的整數（>= 0x2000）；開啟時整個檔案讀進記憶體（寫入模式是空的緩衝），fclose／fflush／結束時寫回
        const files = new Map(); let fileSeq = 0x2000; const fsys = o.fs || null;
        const flushFile = (f) => { if (f.dirty && f.canWrite && fsys) { fsys.write(f.path, f.data.slice(0, f.size)); f.dirty = false; } };
        const ensureCap = (f, n) => { if (n > f.data.length) { const d = new Uint8Array(Math.max(n, f.data.length * 2, 256)); d.set(f.data.subarray(0, f.size)); f.data = d; } };
        const fileOf = (p) => files.get(p) || null;
        function closeAllFiles() { for (const f of files.values()) { try { flushFile(f); } catch (_) { /* 寫回失敗：程式已經結束，無處可報 */ } } files.clear(); }
        const queue = [];   // 已經轉成 SDL_Event 的事件

        // 把一個 GUI 事件轉成 SDL_Event 的位元組（回傳 true 表示有寫入）。結構的偏移跟 SDL 2.0 的 C 結構一致（見 examples/llc 的註解）。
        function writeEvent(ctx, ptr, ev) {
            const u8 = ctx.u8(); u8.fill(0, ptr, ptr + 56); const dv = ctx.dv(), t = (now() - t0) >>> 0; dv.setUint32(ptr + 4, t, true);
            if (ev.t === 'quit') { dv.setUint32(ptr, 0x100, true); return true; }
            if (ev.t === 'key') { dv.setUint32(ptr, ev.down ? 0x300 : 0x301, true); dv.setUint32(ptr + 8, 1, true); u8[ptr + 12] = ev.down ? 1 : 0; dv.setUint32(ptr + 16, ev.sc, true); dv.setInt32(ptr + 20, ev.sym | 0, true); return true; }
            if (ev.t === 'motion') { dv.setUint32(ptr, 0x400, true); dv.setUint32(ptr + 8, 1, true); dv.setUint32(ptr + 16, ev.state | 0, true); dv.setInt32(ptr + 20, ev.x, true); dv.setInt32(ptr + 24, ev.y, true); dv.setInt32(ptr + 28, ev.xrel | 0, true); dv.setInt32(ptr + 32, ev.yrel | 0, true); return true; }
            if (ev.t === 'button') { dv.setUint32(ptr, ev.down ? 0x401 : 0x402, true); dv.setUint32(ptr + 8, 1, true); u8[ptr + 16] = ev.button; u8[ptr + 17] = ev.down ? 1 : 0; u8[ptr + 18] = 1; dv.setInt32(ptr + 20, ev.x, true); dv.setInt32(ptr + 24, ev.y, true); return true; }
            if (ev.t === 'wheel') { dv.setUint32(ptr, 0x403, true); dv.setUint32(ptr + 8, 1, true); dv.setInt32(ptr + 16, ev.x | 0, true); dv.setInt32(ptr + 20, ev.y | 0, true); return true; }
            return false;
        }
        let lastMouse = { x: 0, y: 0 }, buttons = 0;
        function convert(ev) {   // GUI 事件 → 內部事件（或 null）
            const v = ev.value || {};
            if (ev.event === 'close') return { t: 'quit' };
            if (ev.event === 'key' && v.key !== undefined) { const sc = scancodeOf(v.key); return sc ? { t: 'key', down: !!v.down, sc, sym: keycodeOf(v.key, sc) } : null; }
            if (ev.event === 'mouse') {
                const x = Math.round(v.x || 0), y = Math.round(v.y || 0), b = (v.button | 0) + 1;   // 瀏覽器 0／1／2＝左／中／右；SDL 1／2／3
                if (v.kind === 'move') { const r = { t: 'motion', x, y, xrel: x - lastMouse.x, yrel: y - lastMouse.y, state: buttons }; lastMouse = { x, y }; return r; }
                lastMouse = { x, y }; const bit = 1 << (b - 1); if (v.kind === 'down') buttons |= bit; else buttons &= ~bit;
                return { t: 'button', down: v.kind === 'down', button: b, x, y };
            }
            if (ev.event === 'wheel') return { t: 'wheel', x: 0, y: -Math.sign(v.dy || 0) };
            return null;
        }

        const impls = {
            // ---- libc
            printf: (ctx, fmt, args) => { const s = formatC(ctx, fmt, args); ctx.write(1, new TextEncoder().encode(s)); return s.length; },
            snprintf: (ctx, buf, n, fmt, args) => writeCStr(ctx, buf, formatC(ctx, fmt, args), Number(n)),
            sprintf: (ctx, buf, fmt, args) => writeCStr(ctx, buf, formatC(ctx, fmt, args), 1 << 30),
            atoi: (ctx, p) => { const m = /^\s*[+-]?\d+/.exec(cstr(ctx, p)); return m ? Number(BigInt.asIntN(32, BigInt(m[0]))) : 0; },
            atof: (ctx, p) => { const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(cstr(ctx, p)); return m ? Number(m[0]) : 0; },
            // ---- 數學
            sin: (ctx, x) => Math.sin(x), sinf: (ctx, x) => Math.fround(Math.sin(x)),
            cos: (ctx, x) => Math.cos(x), cosf: (ctx, x) => Math.fround(Math.cos(x)),
            tan: (ctx, x) => Math.tan(x), tanf: (ctx, x) => Math.fround(Math.tan(x)),
            asin: (ctx, x) => Math.asin(x), asinf: (ctx, x) => Math.fround(Math.asin(x)),
            acos: (ctx, x) => Math.acos(x), acosf: (ctx, x) => Math.fround(Math.acos(x)),
            atan: (ctx, x) => Math.atan(x), atanf: (ctx, x) => Math.fround(Math.atan(x)),
            sqrt: (ctx, x) => Math.sqrt(x), sqrtf: (ctx, x) => Math.fround(Math.sqrt(x)),
            exp: (ctx, x) => Math.exp(x), expf: (ctx, x) => Math.fround(Math.exp(x)),
            log: (ctx, x) => Math.log(x), logf: (ctx, x) => Math.fround(Math.log(x)),
            log2: (ctx, x) => Math.log2(x), log2f: (ctx, x) => Math.fround(Math.log2(x)),
            log10: (ctx, x) => Math.log10(x), log10f: (ctx, x) => Math.fround(Math.log10(x)),
            fabs: (ctx, x) => Math.abs(x), fabsf: (ctx, x) => Math.fround(Math.abs(x)),
            floor: (ctx, x) => Math.floor(x), floorf: (ctx, x) => Math.fround(Math.floor(x)),
            ceil: (ctx, x) => Math.ceil(x), ceilf: (ctx, x) => Math.fround(Math.ceil(x)),
            round: (ctx, x) => Math.round(x), roundf: (ctx, x) => Math.fround(Math.round(x)),
            trunc: (ctx, x) => Math.trunc(x), truncf: (ctx, x) => Math.fround(Math.trunc(x)),
            sinh: (ctx, x) => Math.sinh(x), sinhf: (ctx, x) => Math.fround(Math.sinh(x)),
            cosh: (ctx, x) => Math.cosh(x), coshf: (ctx, x) => Math.fround(Math.cosh(x)),
            tanh: (ctx, x) => Math.tanh(x), tanhf: (ctx, x) => Math.fround(Math.tanh(x)),
            cbrt: (ctx, x) => Math.cbrt(x), cbrtf: (ctx, x) => Math.fround(Math.cbrt(x)),
            atan2: (ctx, x, y) => Math.atan2(x, y), atan2f: (ctx, x, y) => Math.fround(Math.atan2(x, y)),
            pow: (ctx, x, y) => Math.pow(x, y), powf: (ctx, x, y) => Math.fround(Math.pow(x, y)),
            fmod: (ctx, x, y) => x % y, fmodf: (ctx, x, y) => Math.fround(x % y),
            fmin: (ctx, x, y) => Math.min(x, y), fminf: (ctx, x, y) => Math.fround(Math.min(x, y)),
            fmax: (ctx, x, y) => Math.max(x, y), fmaxf: (ctx, x, y) => Math.fround(Math.max(x, y)),
            hypot: (ctx, x, y) => Math.hypot(x, y), hypotf: (ctx, x, y) => Math.fround(Math.hypot(x, y)),
            // ---- 檔案
            fopen: (ctx, path, mode) => {
                if (!fsys) return 0;
                const p = cstr(ctx, path), m = cstr(ctx, mode), plus = m.includes('+'), kind = m[0];
                let data = null;
                if (kind === 'r' || kind === 'a') { data = fsys.read(p); if (data === null || data === undefined) { if (kind === 'r') return 0; data = new Uint8Array(0); } }
                else if (kind === 'w') data = new Uint8Array(0); else return 0;
                const f = { path: p, data: new Uint8Array(data), size: data.length, pos: kind === 'a' ? data.length : 0, canRead: kind === 'r' || plus, canWrite: kind !== 'r' || plus, append: kind === 'a', dirty: kind === 'w', eof: false };
                files.set(++fileSeq, f); return fileSeq;
            },
            fclose: (ctx, h) => { const f = fileOf(h); if (!f) return -1; flushFile(f); files.delete(h); return 0; },
            fflush: (ctx, h) => { if (!h) { for (const f of files.values()) flushFile(f); return 0; } const f = fileOf(h); if (!f) return -1; flushFile(f); return 0; },
            fread: (ctx, buf, size, n, h) => { const f = fileOf(h); size = Number(size); n = Number(n); if (!f || !f.canRead || !size) return 0; const want = Math.min(n * size, f.size - f.pos), items = Math.floor(want / size), bytes = items * size; ctx.u8().set(f.data.subarray(f.pos, f.pos + bytes), buf); f.pos += bytes; if (items < n) f.eof = true; return items; },
            fwrite: (ctx, buf, size, n, h) => {
                const f = fileOf(h); size = Number(size); n = Number(n); if (!f || !f.canWrite) return 0;
                if (h === 1 || h === 2) return 0;
                const bytes = size * n; if (f.append) f.pos = f.size; ensureCap(f, f.pos + bytes); f.data.set(ctx.u8().subarray(buf, buf + bytes), f.pos); f.pos += bytes; f.size = Math.max(f.size, f.pos); f.dirty = true; return n;
            },
            fgets: (ctx, buf, n, h) => { const f = fileOf(h); if (!f || !f.canRead || n <= 0 || f.pos >= f.size) { if (f) f.eof = true; return 0; } let e = f.pos; while (e < f.size && e - f.pos < n - 1) { if (f.data[e++] === 10) break; } ctx.u8().set(f.data.subarray(f.pos, e), buf); ctx.u8()[buf + (e - f.pos)] = 0; f.pos = e; return buf; },
            fputs: (ctx, str, h) => { const f = fileOf(h); if (!f || !f.canWrite) return -1; const b = new TextEncoder().encode(cstr(ctx, str)); if (f.append) f.pos = f.size; ensureCap(f, f.pos + b.length); f.data.set(b, f.pos); f.pos += b.length; f.size = Math.max(f.size, f.pos); f.dirty = true; return b.length; },
            fgetc: (ctx, h) => { const f = fileOf(h); if (!f || !f.canRead || f.pos >= f.size) { if (f) f.eof = true; return -1; } return f.data[f.pos++]; },
            fputc: (ctx, c, h) => { const f = fileOf(h); if (!f || !f.canWrite) return -1; if (f.append) f.pos = f.size; ensureCap(f, f.pos + 1); f.data[f.pos++] = c & 255; f.size = Math.max(f.size, f.pos); f.dirty = true; return c & 255; },
            fseek: (ctx, h, off, whence) => { const f = fileOf(h); if (!f) return -1; off = Number(off); const base = whence === 0 ? 0 : whence === 1 ? f.pos : f.size, np = base + off; if (np < 0) return -1; f.pos = np; if (f.pos > f.size && f.canWrite) { ensureCap(f, f.pos); f.size = f.pos; } f.eof = false; return 0; },
            ftell: (ctx, h) => { const f = fileOf(h); return f ? f.pos : -1; },
            rewind: (ctx, h) => { const f = fileOf(h); if (f) { f.pos = 0; f.eof = false; } },
            feof: (ctx, h) => { const f = fileOf(h); return f && f.eof ? 1 : 0; }, ferror: () => 0,
            remove: (ctx, path) => (fsys && fsys.remove(cstr(ctx, path)) ? 0 : -1),
            rename: (ctx, a, b) => { if (!fsys) return -1; const x = cstr(ctx, a), data = fsys.read(x); if (data === null || data === undefined) return -1; fsys.write(cstr(ctx, b), data); fsys.remove(x); return 0; },
            access: (ctx, path) => (fsys && fsys.exists(cstr(ctx, path)) ? 0 : -1),
            // ---- SDL2
            SDL_Init: () => 0, SDL_Quit: () => {},
            SDL_CreateWindow: (ctx, title, x, y, w, h, flags) => mk({ kind: 'window', title: cstr(ctx, title), w, h, gl: !!(flags & 2), opened: false }),
            SDL_DestroyWindow: async (ctx, p) => { const w = handles.get(p); if (w && w.opened) { try { await gui('close', { id: w.id }); } catch (_) { /* 已經關了 */ } } handles.delete(p); },
            SDL_SetWindowTitle: (ctx, p, t) => { const w = handles.get(p); if (w) w.title = cstr(ctx, t); },
            SDL_CreateRenderer: (ctx, p) => { const w = handles.get(p); if (!w || w.kind !== 'window') return 0; return mk({ kind: 'renderer', win: w, ops: [], color: '#000000', truncated: false }); },
            SDL_DestroyRenderer: (ctx, p) => { handles.delete(p); },
            SDL_SetRenderDrawColor: (ctx, p, r, g, b) => { const R = rend(p); if (!R) return -1; R.color = css(r, g, b); return 0; },
            SDL_RenderClear: (ctx, p) => { const R = rend(p); if (!R) return -1; R.ops = [['clear', R.color]]; return 0; },
            SDL_RenderFillRect: (ctx, p, rc) => { const R = rend(p); if (!R) return -1; const dv = ctx.dv(); if (rc) R.ops.push(['rect', dv.getInt32(rc, true), dv.getInt32(rc + 4, true), dv.getInt32(rc + 8, true), dv.getInt32(rc + 12, true), R.color]); else R.ops.push(['rect', 0, 0, R.win.w, R.win.h, R.color]); return 0; },
            SDL_RenderDrawRect: (ctx, p, rc) => { const R = rend(p); if (!R || !rc) return -1; const dv = ctx.dv(), x = dv.getInt32(rc, true), y = dv.getInt32(rc + 4, true), w = dv.getInt32(rc + 8, true), h = dv.getInt32(rc + 12, true); R.ops.push(['line', x, y, x + w, y, R.color], ['line', x + w, y, x + w, y + h, R.color], ['line', x + w, y + h, x, y + h, R.color], ['line', x, y + h, x, y, R.color]); return 0; },
            SDL_RenderDrawLine: (ctx, p, x1, y1, x2, y2) => { const R = rend(p); if (!R) return -1; R.ops.push(['line', x1, y1, x2, y2, R.color]); return 0; },
            SDL_RenderDrawPoint: (ctx, p, x, y) => { const R = rend(p); if (!R) return -1; R.ops.push(['rect', x, y, 1, 1, R.color]); return 0; },
            SDL_RenderPresent: async (ctx, p) => {
                const R = rend(p); if (!R) return; const w = R.win; await ensureWindow(w);
                let ops = R.ops; if (ops.length > SDL_MAX_OPS) { if (!R.truncated) { R.truncated = true; warn('SDL：一幀超過 ' + SDL_MAX_OPS + ' 道繪圖指令（GUI 橋接的上限），多的被丟掉\n'); } ops = ops.slice(0, SDL_MAX_OPS); }
                await gui('draw', { id: w.id, node: w.nid, ops }); R.ops = [];
            },
            SDL_PollEvent: async (ctx, ptr) => {
                const opened = Array.from(handles.values()).filter((h) => h.kind === 'window' && h.opened);
                if (!queue.length) {
                    for (const w of opened) { if (w.gone) continue; for (let k = 0; k < 20; k++) { const ev = await gui('wait', { id: w.id, timeout: 0 }); if (!ev) break; if (ev.event === 'close') w.gone = true; const c = convert(ev); if (c) queue.push(c); if (w.gone) break; } }   // wait(0)：沒有事件回 null，視窗已關閉回 close 事件
                    if (!queue.length) { await sleep(0); return 0; }   // 沒有事件：讓出一下，瀏覽器才有機會把事件送進來
                }
                const e = queue.shift(); return ptr && writeEvent(ctx, ptr, e) ? 1 : 0;
            },
            SDL_Delay: async (ctx, ms) => { await sleep(Math.max(0, ms)); },
            SDL_GetTicks: () => (now() - t0) >>> 0,
            // ---- SDL2 音訊（佇列模式）：每個裝置對應頁面端的一個串流；裝置一開始是暫停的（SDL 的規則），PauseAudioDevice(dev, 0) 才開始播
            SDL_OpenAudioDevice: async (ctx, name, capture, desired, obtained) => openAudio(ctx, capture, desired, obtained, 0),
            SDL_OpenAudio: async (ctx, desired, obtained) => (await openAudio(ctx, 0, desired, obtained, 1)) ? 0 : -1,
            SDL_QueueAudio: async (ctx, dev, data, len) => {
                const d = audioDevs.get(dev); if (!d || len < 0) return -1;
                const u8 = ctx.u8(); let pos = data, left = len - (len % (d.bps * d.channels));
                while (left > 0) { const n = Math.min(left, 524288 - (524288 % (d.bps * d.channels))); await gui('audio', { cmd: 'stream_queue', id: d.id, data: b64(toS16(u8.subarray(pos, pos + n), d.fmt)) }); pos += n; left -= n; }
                return 0;
            },
            SDL_GetQueuedAudioSize: async (ctx, dev) => { const d = audioDevs.get(dev); if (!d) return 0; const r = await gui('audio', { cmd: 'stream_queued', id: d.id }); return Math.round(r.seconds * d.rate) * d.channels * d.bps; },
            SDL_ClearQueuedAudio: async (ctx, dev) => { const d = audioDevs.get(dev); if (d) await gui('audio', { cmd: 'stream_clear', id: d.id }); },
            SDL_PauseAudioDevice: async (ctx, dev, on) => { const d = audioDevs.get(dev); if (d) await gui('audio', { cmd: 'stream_pause', id: d.id, on: !!on }); },
            SDL_PauseAudio: async (ctx, on) => { const d = audioDevs.get(1); if (d) await gui('audio', { cmd: 'stream_pause', id: d.id, on: !!on }); },
            SDL_CloseAudioDevice: async (ctx, dev) => { const d = audioDevs.get(dev); if (d) { audioDevs.delete(dev); await gui('audio', { cmd: 'stream_close', id: d.id }); } },
            SDL_CloseAudio: async () => { const d = audioDevs.get(1); if (d) { audioDevs.delete(1); await gui('audio', { cmd: 'stream_close', id: d.id }); } },
            // ---- SDL 的 OpenGL
            SDL_GL_SetAttribute: () => 0, SDL_GL_SetSwapInterval: () => 0,
            SDL_GL_CreateContext: (ctx, p) => { const w = handles.get(p); if (!w || !w.gl) return 0; gl.win = w; return mk({ kind: 'glctx', win: w }); },
            SDL_GL_DeleteContext: (ctx, p) => { handles.delete(p); },
            SDL_GL_SwapWindow: async (ctx, p) => { const w = handles.get(p); if (!w) return; await ensureWindow(w); await flushGl(w); },
            // ---- OpenGL（固定管線的子集）
            glClearColor: (ctx, r, g, b, a) => { gl.clear = [r, g, b, a]; },
            glClear: (ctx, mask) => { if (mask & 0x4000) gl.batches = []; },
            glViewport: () => {},
            glMatrixMode: (ctx, m) => { gl.mode = m === 0x1701 ? 'P' : 'MV'; },
            glLoadIdentity: () => setTop(cur(), I4()),
            glPushMatrix: () => { const s = gl.stacks[cur()]; if (s.length < 32) s.push(s[s.length - 1].slice()); },
            glPopMatrix: () => { const s = gl.stacks[cur()]; if (s.length > 1) s.pop(); },
            glTranslatef: (ctx, x, y, z) => setTop(cur(), mul4(top(cur()), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])),
            glScalef: (ctx, x, y, z) => setTop(cur(), mul4(top(cur()), [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1])),
            glRotatef: (ctx, deg, x, y, z) => {
                const len = Math.hypot(x, y, z) || 1; x /= len; y /= len; z /= len; const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
                setTop(cur(), mul4(top(cur()), [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1]));
            },
            glOrtho: (ctx, l, r, b, t, n, f) => setTop(cur(), mul4(top(cur()), [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1])),
            glFrustum: (ctx, l, r, b, t, n, f) => setTop(cur(), mul4(top(cur()), [2 * n / (r - l), 0, 0, 0, 0, 2 * n / (t - b), 0, 0, (r + l) / (r - l), (t + b) / (t - b), -(f + n) / (f - n), -1, 0, 0, -2 * f * n / (f - n), 0])),
            gluPerspective: (ctx, fovy, aspect, n, f) => { const k = 1 / Math.tan(fovy * Math.PI / 360); setTop(cur(), mul4(top(cur()), [k / aspect, 0, 0, 0, 0, k, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0])); },
            glBegin: (ctx, mode) => { gl.begin = { mode, verts: [], mvp: mul4(top('P'), top('MV')), additive: gl.blend && gl.blendAdd, size: gl.pointSize, ref: gl.atten > 0 ? 1 / Math.sqrt(gl.atten) : 0, gain: gl.alpha }; },
            glEnd: () => { const b = gl.begin; gl.begin = null; if (b && b.verts.length) gl.batches.push(b); },
            glColor3f: (ctx, r, g, b) => { gl.color = [r, g, b]; }, glColor4f: (ctx, r, g, b) => { gl.color = [r, g, b]; },
            glVertex2f: (ctx, x, y) => { if (gl.begin) gl.begin.verts.push(x, y, 0, gl.color[0], gl.color[1], gl.color[2]); },
            glVertex3f: (ctx, x, y, z) => { if (gl.begin) gl.begin.verts.push(x, y, z, gl.color[0], gl.color[1], gl.color[2]); },
            glEnable: (ctx, cap) => { if (cap === 0x0B71) gl.depth = true; else if (cap === 0x0BE2) gl.blend = true; }, glDisable: (ctx, cap) => { if (cap === 0x0B71) gl.depth = false; else if (cap === 0x0BE2) gl.blend = false; },
            glPointSize: (ctx, sz) => { gl.pointSize = sz; }, glLineWidth: () => {},
            glBlendFunc: (ctx, sf, df) => { gl.blendAdd = (df === 1); },
            glPointParameterfv: (ctx, pname, p) => { if (pname === 0x8129) { const c = new DataView(ctx.mem().buffer).getFloat32(p + 8, true); gl.atten = c > 0 ? c : 0; } },   // GL_POINT_DISTANCE_ATTENUATION：只用 (0, 0, c)＝大小隨距離反比
            gluLookAt: (ctx, ex, ey, ez, cx, cy, cz, ux, uy, uz) => {
                let fx = cx - ex, fy = cy - ey, fz = cz - ez; const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
                let sx = fy * uz - fz * uy, sy = fz * ux - fx * uz, sz = fx * uy - fy * ux; const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
                const u2x = sy * fz - sz * fy, u2y = sz * fx - sx * fz, u2z = sx * fy - sy * fx;
                setTop(cur(), mul4(mul4(top(cur()), [sx, u2x, -fx, 0, sy, u2y, -fy, 0, sz, u2z, -fz, 0, 0, 0, 0, 1]), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -ex, -ey, -ez, 1]));
            },
        };

        // ---- GTK3：widget 樹在 gtk_widget_show_all 時一次送成 GUI 節點；之後的屬性變更（gtk_label_set_text…）排進佇列送 set。gtk_main 輪詢事件、呼叫訊號處理函式（wasm 函式表格）。
        const widgets = new Map(); let gtkSeq = 0, gtkQuit = false, timerSeq = 0; const timers = []; let uiChain = Promise.resolve();
        const enqueue = (fn) => { uiChain = uiChain.then(fn).catch((e) => warn('GTK：' + String((e && e.message) || e) + '\n')); return uiChain; };
        const wid = (p) => widgets.get(p) || null;
        const newWidget = (kind, fields) => { const w = Object.assign({ kind, nid: 'g' + (++gtkSeq), children: [], signals: {}, parent: null, shown: false, sensitive: true }, fields); const p = mk({ kind: 'widget', w }); w.ptr = p; widgets.set(p, w); return p; };
        const SCRATCH = 64, SLOT = 240; let slot = 0;   // 位址 0..1024 是 wasm 的保留區：用來放回傳字串的暫存環（gtk_entry_get_text 這類回傳 const char*，下 3 次呼叫內有效）
        const scratch = (ctx, str) => { const p = SCRATCH + (slot++ % 3) * SLOT; writeCStr(ctx, p, str, SLOT); return p; };
        const rootOf = (w) => { while (w.parent) w = w.parent; return w; };
        const nodeOf = (w) => {
            const base = { id: w.nid };
            if (w.kind === 'box') return Object.assign(base, { kind: w.horizontal ? 'row' : 'column' });
            if (w.kind === 'label') return Object.assign(base, { kind: 'label', text: w.text || '' });
            if (w.kind === 'button') return Object.assign(base, { kind: 'button', text: w.text || '', enabled: w.sensitive });
            if (w.kind === 'entry') return Object.assign(base, { kind: 'entry', value: w.text || '', enabled: w.sensitive });
            if (w.kind === 'check') return Object.assign(base, { kind: 'checkbox', text: w.text || '', checked: !!w.active, enabled: w.sensitive });
            if (w.kind === 'progress') return Object.assign(base, { kind: 'progress', value: Math.round((w.fraction || 0) * 100), max: 100 });
            return Object.assign(base, { kind: 'column' });
        };
        function showTree(win) {
            if (win.shown) return; win.shown = true; win.id = 'gtk' + (++winSeq) + '_' + Math.random().toString(36).slice(2, 6);
            enqueue(async () => {
                await gui('open', { id: win.id, title: win.text || 'GTK', width: Math.max(240, Math.min(1000, win.width || 360)) });
                const add = async (w, parentNid) => { w.win = win; await gui('add', { id: win.id, parent: parentNid, node: nodeOf(w) }); for (const c of w.children) await add(c, w.nid); };
                for (const c of win.children) await add(c, 'root');
            });
        }
        const live = (w) => { const r = rootOf(w); return r.kind === 'window' && r.shown ? r : null; };
        const pushSet = (w, props) => { const r = live(w); if (r) enqueue(() => gui('set', { id: r.id, node: w.nid, props })); };
        function emit(ctx, w, name, extra) {
            let veto = 0;
            for (const h of (w.signals[name] || []).slice()) {
                const fn = ctx.table().get(h.fn); if (!fn) continue;
                const r = name === 'delete-event' ? fn(w.ptr, 0, h.data) : fn(w.ptr, h.data); if (typeof r === 'number' && r) veto = r;
            }
            void extra; return veto;
        }
        Object.assign(impls, {
            gtk_init: () => {}, gtk_main_quit: () => { gtkQuit = true; },
            gtk_window_new: () => newWidget('window', { text: 'GTK', width: 360 }),
            gtk_window_set_title: (ctx, p, t) => { const w = wid(p); if (w) { w.text = cstr(ctx, t); } },
            gtk_window_set_default_size: (ctx, p, wd) => { const w = wid(p); if (w) w.width = wd; },
            gtk_container_add: (ctx, c, ch) => { const a = wid(c), b = wid(ch); if (a && b && !b.parent) { a.children.push(b); b.parent = a; const r = live(a); if (r) enqueue(async () => { await gui('add', { id: r.id, parent: a.kind === 'window' ? 'root' : a.nid, node: nodeOf(b) }); }); } },
            gtk_container_set_border_width: () => {},
            gtk_box_new: (ctx, orient) => newWidget('box', { horizontal: orient === 0 }),
            gtk_box_pack_start: (ctx, box, ch) => impls.gtk_container_add(ctx, box, ch), gtk_box_pack_end: (ctx, box, ch) => impls.gtk_container_add(ctx, box, ch),
            gtk_label_new: (ctx, t) => newWidget('label', { text: t ? cstr(ctx, t) : '' }),
            gtk_label_set_text: (ctx, p, t) => { const w = wid(p); if (!w) return; w.text = cstr(ctx, t); pushSet(w, { text: w.text }); },
            gtk_label_get_text: (ctx, p) => { const w = wid(p); return scratch(ctx, w ? w.text || '' : ''); },
            gtk_entry_new: () => newWidget('entry', { text: '' }),
            gtk_entry_set_text: (ctx, p, t) => { const w = wid(p); if (!w) return; w.text = cstr(ctx, t); pushSet(w, { value: w.text }); },
            gtk_entry_get_text: (ctx, p) => { const w = wid(p); return scratch(ctx, w ? w.text || '' : ''); },
            gtk_button_new_with_label: (ctx, t) => newWidget('button', { text: t ? cstr(ctx, t) : '' }),
            gtk_button_set_label: (ctx, p, t) => { const w = wid(p); if (!w) return; w.text = cstr(ctx, t); pushSet(w, { text: w.text }); },
            gtk_button_clicked: (ctx, p) => { const w = wid(p); if (w) emit(ctx, w, 'clicked'); },
            gtk_check_button_new_with_label: (ctx, t) => newWidget('check', { text: t ? cstr(ctx, t) : '', active: false }),
            gtk_toggle_button_get_active: (ctx, p) => { const w = wid(p); return w && w.active ? 1 : 0; },
            gtk_toggle_button_set_active: (ctx, p, v) => { const w = wid(p); if (!w) return; const was = !!w.active; w.active = !!v; pushSet(w, { checked: w.active }); if (was !== w.active) emit(ctx, w, 'toggled'); },
            gtk_progress_bar_new: () => newWidget('progress', { fraction: 0 }),
            gtk_progress_bar_set_fraction: (ctx, p, f) => { const w = wid(p); if (!w) return; w.fraction = Math.max(0, Math.min(1, f)); pushSet(w, { value: Math.round(w.fraction * 100) }); },
            gtk_widget_set_sensitive: (ctx, p, v) => { const w = wid(p); if (!w) return; w.sensitive = !!v; pushSet(w, { enabled: w.sensitive }); },
            gtk_widget_show: (ctx, p) => { const w = wid(p); if (w && w.kind === 'window') showTree(w); },
            gtk_widget_show_all: (ctx, p) => { const w = wid(p); if (w && w.kind === 'window') showTree(w); },
            gtk_widget_destroy: (ctx, p) => { const w = wid(p); if (!w) return; emit(ctx, w, 'destroy'); if (w.kind === 'window' && w.shown) { enqueue(() => gui('close', { id: w.id })); w.closed = true; } },
            g_signal_connect_data: (ctx, p, name, fn, data) => { const w = wid(p); if (!w) return 0; const n = cstr(ctx, name); (w.signals[n] = w.signals[n] || []).push({ fn, data }); return ++timerSeq; },
            g_timeout_add: (ctx, ms, fn, data) => { const id = ++timerSeq; timers.push({ id, at: now() + ms, ms, fn, data }); return id; },
            g_source_remove: (ctx, id) => { const k = timers.findIndex((t) => t.id === id); if (k >= 0) { timers.splice(k, 1); return 1; } return 0; },
            gtk_main: async (ctx) => {
                gtkQuit = false;
                for (;;) {
                    await uiChain;
                    const shown = Array.from(widgets.values()).filter((w) => w.kind === 'window' && w.shown && !w.closed);
                    for (const win of shown) {
                        for (let k = 0; k < 50; k++) {
                            const ev = await gui('wait', { id: win.id, timeout: 0 }); if (!ev) break;
                            const v = ev.value; const w = Array.from(widgets.values()).find((x) => x.nid === ev.node && x.win === win);
                            if (ev.event === 'close') { win.closed = true; if (!emit(ctx, win, 'delete-event')) { emit(ctx, win, 'destroy'); } else win.closed = false; }
                            else if (w && ev.event === 'click') emit(ctx, w, 'clicked');
                            else if (w && ev.event === 'input') { w.text = String(v); emit(ctx, w, 'changed'); }
                            else if (w && ev.event === 'change') { w.active = !!v && v !== 'false'; emit(ctx, w, 'toggled'); }
                            if (gtkQuit) break;
                        }
                        if (gtkQuit) break;
                    }
                    const t = now();
                    for (const tm of timers.slice()) if (tm.at <= t) { const fn = ctx.table().get(tm.fn); const keep = fn ? fn(tm.data) : 0; if (keep) tm.at = t + tm.ms; else { const k = timers.indexOf(tm); if (k >= 0) timers.splice(k, 1); } }
                    if (gtkQuit) break;
                    if (!shown.length && !timers.length && !Array.from(widgets.values()).some((w) => w.kind === 'window' && w.shown && !w.closed)) break;   // 視窗都關了、沒有計時器：真的 GTK 會一直等，這裡結束（沙盒沒有人能再叫醒它）
                    await sleep(25);
                }
                await uiChain;
            },
        });

        // 一幀的 OpenGL：每個 glBegin／glEnd 批次上傳成一個緩衝區（x y z r g b），用 flat 程式畫。QUADS／TRIANGLE_FAN 先拆成三角形。
        // 一幀最多畫的 glBegin／glEnd 批次數（DESIGN.webgpu-cuda.md §13 階段 9）。超過的批次不畫，並在 console 警告（不靜默丟棄）。
        const GL_MAX_BATCHES_PER_FRAME = 1024;
        async function flushGl(w) {
            const cmds = [['clear', gl.clear[0], gl.clear[1], gl.clear[2], gl.clear[3]], ['state', 'depth', gl.depth ? 1 : 0], ['use', 'flat']]; let n = 0;
            if (gl.batches.length > GL_MAX_BATCHES_PER_FRAME) { const over = gl.batches.length - GL_MAX_BATCHES_PER_FRAME; gl.droppedBatches = (gl.droppedBatches || 0) + over; console.warn('[llvm_host] 一幀 ' + gl.batches.length + ' 個 glBegin 批次，超過上限 ' + GL_MAX_BATCHES_PER_FRAME + '，多出的 ' + over + ' 個不畫'); }
            for (const b of gl.batches.slice(0, GL_MAX_BATCHES_PER_FRAME)) {
                if (b.extern) { o.setExtern(w.id, w.nid, b.extern, b.canvas); cmds.push(['extern', b.extern]); continue; }   // 點精靈：畫布交給 GUI（setExtern），這裡只放記號
                let v = b.verts; const N = v.length / 6, vtx = (i) => v.slice(i * 6, i * 6 + 6);
                if (b.mode === 7) { const o = []; for (let q = 0; q + 3 < N; q += 4) for (const i of [0, 1, 2, 0, 2, 3]) o.push(...vtx(q + i)); v = o; }
                else if (b.mode === 6) { const o = []; for (let i = 1; i + 1 < N; i++) o.push(...vtx(0), ...vtx(i), ...vtx(i + 1)); v = o; }
                else if (b.mode === 2 && N > 1) v = v.concat(vtx(0));
                const name = 'b' + (n++), data = new Float32Array(v), bytes = new Uint8Array(data.buffer); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                await gui('glbuf', { id: w.id, node: w.nid, name, type: 'f32', data: btoa(s) });
                if (b.mode === 0 && b.additive) cmds.push(['state', 'additive', 1], ['use', 'glow'], ['uf', 'mvp'].concat(b.mvp), ['uf', 'size', b.size], ['uf', 'ref', b.ref], ['uf', 'gain', b.gain], ['attr', 'pos', name, 3, 24, 0, 0], ['attr', 'col', name, 3, 24, 12, 0], ['draw', 'points', 0, v.length / 6, 1], ['state', 'additive', 0], ['use', 'flat']);
                else if (b.mode === 0) cmds.push(['use', 'points'], ['uf', 'mvp'].concat(b.mvp), ['uf', 'size', b.size], ['uf', 'tint', 1, 1, 1], ['attr', 'pos', name, 3, 24, 0, 0], ['attr', 'col', name, 3, 24, 12, 0], ['draw', 'points', 0, v.length / 6, 1], ['use', 'flat']);
                else cmds.push(['uf', 'mvp'].concat(b.mvp), ['attr', 'pos', name, 3, 24, 0, 0], ['attr', 'col', name, 3, 24, 12, 0], ['draw', GL_MODE[b.mode] || 'triangles', 0, v.length / 6, 1]);
            }
            await gui('glframe', { id: w.id, node: w.nid, cmds });
            gl.batches = [];
        }
        // ---- OpenCL（CPU 後備）：平台／裝置各一個；buffer 是 JS 端的 Uint8Array（寫入、讀回時跟 wasm 記憶體互相複製，跟真裝置一樣）；核心在 clEnqueueNDRangeKernel 當下同步執行（in-order queue，clFinish 不用等）
        {
            const cl = { plat: mk({ kind: 'clplat' }), dev: mk({ kind: 'cldev' }) }, errOut = (ctx, p, v) => { if (p) ctx.dv().setInt32(p, v, true); };
            const clH = (p, k) => { const h = handles.get(p); return h && h.kind === k ? h : null; };
            const setStr = (ctx, str, size, p, retp) => { const b = new TextEncoder().encode(str + '\0'); if (retp) ctx.dv().setUint32(retp, b.length, true); if (p) ctx.u8().set(b.subarray(0, Math.min(b.length, Number(size) || b.length)), p); return 0; };
            const copyOut = (ctx, buf, off, n, p) => { ctx.u8().set(buf.data.subarray(off, off + n), p); };
            // 主機副本過期（裝置是新的）→ 從裝置讀回；失敗回傳 false
            // 打包與 view（DESIGN.webgpu-cuda.md §13 階段 6 步驟 1c）：fa_cl_pack 把一個緩衝區標成 parts 個部分；fa_cl_view 得到第 k 部分（與 root 共用資料）。
            // 狀態（hostOk／devOk）記在 root 上；裝置物件：root 是 allocPacked／alloc，view 是 kirDev.view(root 的裝置, k)。
            const rootOf = (m) => m.parentMem || m;
            const syncHost = (m) => { const r = rootOf(m); if (r.hostOk) return true; if (!kirDev || !r.dev) return false; const N = r.size / 4; const got = kirDev.download(r.dev); const apply = (res) => { if (!res || res.length < N) return false; new Float32Array(r.data.buffer, r.data.byteOffset, N).set(res.subarray(0, N)); r.hostOk = true; return true; }; if (got && typeof got.then === 'function') { if (!asyncRb) throw new Error('讀回是非同步的（WebGPU），但這個 host 沒有開 asyncReadback（需要 JSPI）'); return got.then(apply); } return apply(got); };
            const setHostNew = (m) => { const r = rootOf(m); r.hostOk = true; r.devOk = false; };
            const setDevNew = (m) => { const r = rootOf(m); r.devOk = true; r.hostOk = false; };
            // 配置 root 的裝置緩衝區（不上傳）；回傳 m 的裝置物件
            const allocDev = (m) => {
                const r = rootOf(m);
                if (!r.dev) r.dev = r.packParts ? kirDev.allocPacked(r.size / 4 / r.packParts, r.packParts) : kirDev.alloc(r.size / 4, 'f32');
                if (m.parentMem && !m.dev) m.dev = kirDev.view(r.dev, m.part);
                return m.parentMem ? m.dev : r.dev;
            };
            // 裝置副本過期（主機是新的）→ 上傳整個 root；回傳 m 的裝置物件
            const ensureDev = (m) => {
                const r = rootOf(m); allocDev(m);
                if (!r.devOk) { if (!r.hostOk) return null; kirDev.upload(r.dev, new Float32Array(r.data.buffer, r.data.byteOffset, r.size / 4)); r.devOk = true; }
                return m.parentMem ? m.dev : r.dev;
            };
            Object.assign(impls, {
                clGetPlatformIDs: (ctx, n, p, num) => { if (!n && p) return -30; if (p && n) ctx.dv().setUint32(p, cl.plat, true); if (num) ctx.dv().setUint32(num, 1, true); return 0; },
                clGetDeviceIDs: (ctx, plat, type, n, p, num) => { if (plat !== cl.plat) return -32; type = Number(type); if (!(type & (2 | 4 | 1 | 0xFFFFFFFF))) return -31; if (type === 4 && !(type & 2)) return -1;   // 沒有 GPU 裝置（CPU 後備只有一個 CPU 裝置）：呼叫端通常會退回 CPU
                    if (p && n) ctx.dv().setUint32(p, cl.dev, true); if (num) ctx.dv().setUint32(num, 1, true); return 0; },
                clGetPlatformInfo: (ctx, p, name, size, v, ret) => { if (p !== cl.plat) return -32; const S = { 0x902: 'FULL_PROFILE', 0x903: 'OpenCL 1.2 FaLlvmHost-CPU', 0x904: 'FaLlvmHost CPU emulation', 0x905: 'fa', 0x0900: 'x' }; return setStr(ctx, S[name] || 'FaLlvmHost CPU emulation', size, v, ret); },
                clGetDeviceInfo: (ctx, d, name, size, v, ret) => { if (d !== cl.dev) return -33; if (name === 0x1000) { if (v) ctx.dv().setBigUint64(v, 2n, true); if (ret) ctx.dv().setUint32(ret, 8, true); return 0; }   // CL_DEVICE_TYPE＝CPU
                    if (name === 0x1004 || name === 0x1002 || name === 0x1003) { if (v) ctx.dv().setBigUint64(v, name === 0x1004 ? 1n : 1n, true); if (ret) ctx.dv().setUint32(ret, 8, true); return 0; }   // MAX_WORK_GROUP_SIZE／MAX_COMPUTE_UNITS／MAX_WORK_ITEM_DIMENSIONS 都回 1（本墊片的工作群組大小固定 1）
                    return setStr(ctx, name === 0x102B ? 'FaLlvmHost CPU (JS)' : 'FaLlvmHost', size, v, ret); },
                clCreateContext: (ctx, props, n, devs, cb, ud, err) => { errOut(ctx, err, 0); return mk({ kind: 'clctx' }); },
                clCreateCommandQueue: (ctx, c, d, props, err) => { if (!clH(c, 'clctx')) { errOut(ctx, err, -34); return 0; } errOut(ctx, err, 0); return mk({ kind: 'clq' }); },
                clCreateCommandQueueWithProperties: (ctx, c, d, props, err) => { if (!clH(c, 'clctx')) { errOut(ctx, err, -34); return 0; } errOut(ctx, err, 0); return mk({ kind: 'clq' }); },
                clCreateBuffer: (ctx, c, flags, size, host, err) => {
                    flags = Number(flags); size = Number(size); if (!clH(c, 'clctx')) { errOut(ctx, err, -34); return 0; } if (!size) { errOut(ctx, err, -61); return 0; }
                    if ((flags & (8 | 32)) && !host) { errOut(ctx, err, -37); return 0; } const data = new Uint8Array(new ArrayBuffer(size));
                    if (flags & (8 | 32)) data.set(ctx.u8().subarray(host, host + size)); errOut(ctx, err, 0); return mk({ kind: 'clmem', size, data, dev: null, hostOk: true, devOk: false });
                },
                clEnqueueWriteBuffer: (ctx, q, b, blocking, off, size, ptr) => { const buf = clH(b, 'clmem'); off = Number(off); size = Number(size); if (!clH(q, 'clq')) return -36; if (!buf) return -38; if (off + size > buf.size || !ptr) return -30; if (!syncHost(buf)) return -9999; buf.data.set(ctx.u8().subarray(ptr, ptr + size), off); setHostNew(buf); return 0; },
                clEnqueueReadBuffer: (ctx, q, b, blocking, off, size, ptr) => { const buf = clH(b, 'clmem'); off = Number(off); size = Number(size); if (!clH(q, 'clq')) return -36; if (!buf) return -38; if (off + size > buf.size || !ptr) return -30; const fin = (ok) => { if (!ok) return -9999; copyOut(ctx, buf, off, size, ptr); return 0; }; const sr = syncHost(buf); return sr && typeof sr.then === 'function' ? sr.then(fin) : fin(sr); },
                clCreateProgramWithSource: (ctx, c, count, strs, lens, err) => {
                    if (!clH(c, 'clctx')) { errOut(ctx, err, -34); return 0; } const dv = ctx.dv(); let src = '';
                    for (let i = 0; i < count; i++) { const sp = dv.getUint32(strs + 4 * i, true); src += cstr(ctx, sp); }
                    errOut(ctx, err, 0); return mk({ kind: 'clprog', src, built: null, log: '' });
                },
                clBuildProgram: (ctx, p) => { const pr = clH(p, 'clprog'); if (!pr) return -44; const r = clCompile(pr.src); if (r.error) { pr.log = r.error; pr.built = null; warn('OpenCL 建置失敗：' + r.error + '\n'); return -11; } pr.built = r.kernels; pr.log = ''; pr.kir = null; if (kirTranslate && (kirRun || kirDev)) { try { pr.kir = kirTranslate(pr.src) || null; } catch (e) { pr.kir = null; } } return 0; },
                clGetProgramBuildInfo: (ctx, p, d, name, size, v, ret) => { const pr = clH(p, 'clprog'); if (!pr) return -44; if (name === 0x1181) { if (v) ctx.dv().setInt32(v, pr.built ? 0 : -2, true); if (ret) ctx.dv().setUint32(ret, 4, true); return 0; } return setStr(ctx, pr.log, size, v, ret); },
                clCreateKernel: (ctx, p, name, err) => { const pr = clH(p, 'clprog'); if (!pr) { errOut(ctx, err, -44); return 0; } if (!pr.built) { errOut(ctx, err, -45); return 0; } const n = cstr(ctx, name), k = pr.built[n]; if (!k) { errOut(ctx, err, -46); return 0; } errOut(ctx, err, 0); return mk({ kind: 'clkernel', name: n, def: k, prog: pr, args: new Array(k.params.length).fill(undefined) }); },
                clSetKernelArg: (ctx, kp, idx, size, ptr) => {
                    const k = clH(kp, 'clkernel'); if (!k) return -48; if (idx >= k.def.params.length) return -49; const pa = k.def.params[idx]; size = Number(size);
                    if (pa.ptr) { if (!ptr) return -50; const h = ctx.dv().getUint32(ptr, true), buf = clH(h, 'clmem'); if (!buf) return -38; k.args[idx] = { mem: buf }; return 0; }
                    const w = CL_ELEM[pa.type].BYTES_PER_ELEMENT; if (size !== w || !ptr) return -51; k.args[idx] = { scalar: new DataView(ctx.mem().buffer.slice(ptr, ptr + w))[CL_SCALAR[pa.type]](0, true) }; return 0;
                },
                clEnqueueNDRangeKernel: (ctx, q, kp, dim, offp, gsp, lsp) => {
                    const k = clH(kp, 'clkernel'); if (!clH(q, 'clq')) return -36; if (!k) return -48; if (dim < 1 || dim > 3) return -53; if (!gsp) return -63;
                    const dv = ctx.dv(), gs = [1, 1, 1], off = [0, 0, 0]; for (let d = 0; d < dim; d++) { gs[d] = Number(dv.getBigUint64(gsp + 8 * d, true)); if (offp) off[d] = Number(dv.getBigUint64(offp + 8 * d, true)); }
                    if (lsp) for (let d = 0; d < dim; d++) { const l = Number(dv.getBigUint64(lsp + 8 * d, true)); if (l && gs[d] % l) return -54; }
                    if (k.args.some((a) => a === undefined)) return -52; const args = k.def.params.map((pa, i) => { const a = k.args[i]; if (a.mem) { const E = CL_ELEM[pa.type]; return new E(a.mem.data.buffer, a.mem.data.byteOffset, Math.floor(a.mem.size / E.BYTES_PER_ELEMENT)); } return a.scalar; });
                    // 有 KIR 版本且一維：走 kirRun（緩衝區複製進出；之後階段改成留在 GPU 紋理）；失敗就退回 JS
                    const kirK = dim === 1 && (kirRun || kirDev) && k.prog && k.prog.kir && k.prog.kir[k.name];
                    // 常駐裝置路徑：所有指標參數都是 float（f32），輸出只有一個，且不與輸入同一個緩衝區；任何一步失敗就同步主機副本、退回 JS
                    if (kirK && kirDev && kirTranslate) {
                        const ptrs = k.def.params.map((pa, i) => ({ pa, i, a: k.args[i] })).filter((x) => x.pa.ptr);
                        const okTypes = ptrs.every((x) => x.pa.type === 'float' && x.a.mem);
                        const outDecl = kirK.params.filter((q) => q.kind === 'buf' && q.access === 'out');
                        // 打包緩衝區需要 kirDev.allocPacked／view；沒有（舊版的裝置掛鉤）就不走裝置路徑
                        const canDev = ptrs.every((x) => x.a.mem && (!rootOf(x.a.mem).packParts || (kirDev.allocPacked && kirDev.view)));
                        if (okTypes && outDecl.length === 1 && canDev) {
                            try {
                                const N = gs[0], binds = {}, scal = {};
                                const outName = outDecl[0].name; const ox = ptrs.find((x) => x.pa.name === outName); if (!ox) throw new Error('找不到輸出參數');
                                const outMem = ox.a.mem;
                                for (const x of ptrs) if (x.a.mem === outMem && x.pa.name !== outName) throw new Error('輸出與輸入是同一個緩衝區');
                                for (const x of ptrs) {
                                    if (x.pa.name === outName) {
                                        // 輸出：一般緩衝區只配置（它馬上會被覆寫）；打包的 view 要先保證同一張紋理上其他部分是最新的
                                        const dv = outMem.parentMem ? ensureDev(outMem) : allocDev(outMem);
                                        if (!dv) throw new Error('緩衝區沒有有效的資料');
                                        binds[x.pa.name] = dv;
                                    } else {
                                        const dv = ensureDev(x.a.mem);
                                        if (!dv) throw new Error('緩衝區沒有有效的資料');
                                        binds[x.pa.name] = dv;
                                    }
                                }
                                for (const q of kirK.params) if (q.kind === 'scalar') { const pa = k.def.params.find((z) => z.name === q.name); scal[q.name] = k.args[k.def.params.indexOf(pa)].scalar; }
                                kirDev.dispatch(kirK, binds, binds[outName], scal, N);
                                setDevNew(outMem); clBackend = kirDevKind === 'webgpu' ? 3 : 1;
                                return 0;
                            } catch (e) { warn('OpenCL：常駐裝置執行失敗，退回主機：' + e.message + '\n'); }
                        }
                    }
                    // 非裝置路徑：先把裝置上較新的資料拉回主機；執行後主機副本就是最新的（裝置副本過期）
                    const waits = [];
                    if (kirDev) for (const a of k.args) if (a && a.mem) { const sr = syncHost(a.mem); if (sr && typeof sr.then === 'function') waits.push(sr); }
                    const markHost = () => { for (const a of k.args) if (a && a.mem) setHostNew(a.mem); };
                    const runRest = () => {
                    if (kirK && kirRun) {
                        try {
                            const N = gs[0], bufs = {}, scal = {}, backs = [];
                            k.def.params.forEach((pa, i) => {
                                const a = k.args[i];
                                if (pa.ptr) { const E = CL_ELEM[pa.type]; const v = new E(a.mem.data.buffer, a.mem.data.byteOffset, Math.floor(a.mem.size / E.BYTES_PER_ELEMENT)); bufs[pa.name] = v; backs.push({ name: pa.name, v }); }
                                else scal[pa.name] = a.scalar;
                            });
                            const res = kirRun(kirK, bufs, scal, N);
                            for (const b of backs) if (res && res.out && res.out[b.name]) b.v.set(res.out[b.name].subarray(0, b.v.length));
                            markHost(); clBackend = 1; return 0;
                        } catch (e) { warn('OpenCL：KIR 執行失敗，退回 JS：' + e.message + '\n'); }
                    }
                    try { k.def.run(gs, off, dim, args); } catch (e) { warn('OpenCL 核心執行錯誤：' + e.message + '\n'); return -9999; } markHost(); clBackend = 2; return 0;
                    };
                    return waits.length ? Promise.all(waits).then(() => runRest()) : runRest();
                },
                fa_cl_backend: () => clBackend,
                // 打包：把緩衝區標成 parts 個等長部分（大小要是 parts×部分長度×4）；回傳 0 成功，-30 參數錯
                fa_cl_pack: (ctx, b, parts) => { const m = clH(b, 'clmem'); parts = Number(parts); if (!m || m.parentMem || parts < 1 || m.size % (parts * 4) || m.packParts) return -30; m.packParts = parts; return 0; },
                // 第 part 部分（與 root 共用資料；寫入與讀回都通過 root 的狀態）；失敗回傳 0
                fa_cl_view: (ctx, b, part) => { const m = clH(b, 'clmem'); part = Number(part); if (!m || m.parentMem || !m.packParts || part < 0 || part >= m.packParts) return 0; const sz = m.size / m.packParts; return mk({ kind: 'clmem', size: sz, data: m.data.subarray(part * sz, (part + 1) * sz), parentMem: m, part, dev: null, hostOk: true, devOk: false }); },
                // 點精靈（DESIGN.webgpu-cuda.md §13 階段 9）：只有 WebGPU 裝置才走這裡。位置留在裝置上，drawPoints 直接畫到一張畫布；
                // 畫布放進本幀的 GL 批次（flushGl 會交給 GUI 的 extern 記號），不讀回。回傳 1＝已畫（呼叫端不要讀回）；0＝不能畫（沒有 WebGPU、沒有 GL 視窗、或失敗），呼叫端退回讀回＋GL 點。
                // 參數：x、y、z 的 cl 記憶體；n 點數；pal＝10 色×3 個 float 接著縮放 1 個 float（共 31 個，GL 路徑也是 ×0.1）；ctr＝盒子中心 3 個 float（點的位置是 (x−ctr)·縮放）。
                fa_cl_points: (ctx, xb, yb, zb, n, pal, ctr) => {
                    const mx = clH(xb, 'clmem'), my = clH(yb, 'clmem'), mz = clH(zb, 'clmem'), count = Number(n) | 0;
                    if (!mx || !my || !mz || count < 1 || !kirDev || !kirDev.drawPoints || kirDevKind !== 'webgpu' || !gl.win || !o.setExtern) return 0;
                    try {
                        const dx = ensureDev(mx), dy = ensureDev(my), dz = ensureDev(mz);
                        if (!dx || !dy || !dz) return 0;
                        const dv = ctx.dv(), colors = [];
                        for (let i = 0; i < 10; i++) colors.push([dv.getFloat32(pal + 12 * i, true), dv.getFloat32(pal + 12 * i + 4, true), dv.getFloat32(pal + 12 * i + 8, true)]);
                        const scale = dv.getFloat32(pal + 120, true), offset = [dv.getFloat32(ctr, true), dv.getFloat32(ctr + 4, true), dv.getFloat32(ctr + 8, true)];
                        const win = gl.win;
                        const canvas = kirDev.drawPoints({ x: dx, y: dy, z: dz }, count, { mvp: Array.from(mul4(top('P'), top('MV'))), offset, scale, sizePx: gl.pointSize, ref: gl.atten > 0 ? 1 / Math.sqrt(gl.atten) : 0, gain: gl.alpha, colors, width: win.w, height: win.h, makeCanvas: o.makeCanvas });
                        gl.batches.push({ extern: 'clpts', canvas });
                    } catch (e) { warn('OpenCL：點精靈畫圖失敗，退回讀回＋GL 點：' + e.message + '\n'); return 0; }
                    return 1;
                },
                clFinish: (ctx, q) => (clH(q, 'clq') ? 0 : -36), clFlush: (ctx, q) => (clH(q, 'clq') ? 0 : -36), clWaitForEvents: () => 0, clReleaseEvent: () => 0,
                clReleaseMemObject: (ctx, p) => { const m = clH(p, 'clmem'); if (!m) return -38; if (!m.parentMem && m.dev && kirDev) kirDev.free(m.dev); m.dev = null; handles.delete(p); return 0; }, clReleaseKernel: (ctx, p) => { if (!clH(p, 'clkernel')) return -48; handles.delete(p); return 0; },
                clReleaseProgram: (ctx, p) => { if (!clH(p, 'clprog')) return -44; handles.delete(p); return 0; }, clReleaseCommandQueue: (ctx, p) => { if (!clH(p, 'clq')) return -36; handles.delete(p); return 0; },
                clReleaseContext: (ctx, p) => { if (!clH(p, 'clctx')) return -34; handles.delete(p); return 0; },
            });
        }

        return { impls, SIGS: sigs, toS16, install(FaLlvm) { installs++; FaLlvm.registerHost(sigs); }, uninstall(FaLlvm) { if (--installs <= 0) { installs = 0; FaLlvm.unregisterHost(Object.keys(sigs)); } }, close() { closeAllFiles(); handles.clear(); Array.from(audioDevs.values()).forEach((d) => { gui('audio', { cmd: 'stream_close', id: d.id }); }); audioDevs.clear(); } };
    }
    return { create, SIGS, clCompile, formatC, scancodeOf, keycodeOf };
});
