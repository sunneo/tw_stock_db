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
    };

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
    const POINTS_VS = '#version 300 es\nin vec3 pos; in vec3 col; uniform mat4 mvp; uniform float size; uniform vec3 tint; out vec3 vcol;\nvoid main(){ vcol = col * tint; gl_Position = mvp * vec4(pos, 1.0); gl_PointSize = max(1.0, size); }';
    const POINTS_FS = '#version 300 es\nprecision mediump float; in vec3 vcol; out vec4 o;\nvoid main(){ vec2 d = gl_PointCoord - vec2(0.5); float r = dot(d, d); if (r > 0.25) discard; o = vec4(vcol * (1.0 - 1.2 * r), 1.0); }';
    const FLAT_FS = '#version 300 es\nprecision mediump float; in vec3 vcol; out vec4 o;\nvoid main(){ o = vec4(vcol, 1.0); }';

    let installs = 0;   // 同時有幾個程式在用（登記是全域的：最後一個結束才取消，不然別的 IR 工具會把 printf 之類當成主機函式）
    function create(o) {
        o = o || {}; const gui = o.gui, sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), now = o.now || (() => Date.now()), warn = o.warn || (() => {});
        const t0 = now(); let handleSeq = 0x1000, winSeq = 0, nodeSeq = 0; const handles = new Map();   // 不透明指標（SDL_Window*、SDL_Renderer*、SDL_GLContext）→ 狀態
        const mk = (obj) => { const h = (handleSeq += 16); handles.set(h, obj); return h; };
        const gl = { clear: [0.05, 0.06, 0.09, 1], mode: 'MV', stacks: { MV: [I4()], P: [I4()] }, begin: null, color: [1, 1, 1], batches: [], depth: false, pointSize: 1, warned: {} };
        const top = (n) => gl.stacks[n][gl.stacks[n].length - 1];
        const setTop = (n, m) => { gl.stacks[n][gl.stacks[n].length - 1] = m; };
        const cur = () => (gl.mode === 'P' ? 'P' : 'MV');

        async function ensureWindow(w) {
            if (w.opened) return; w.opened = true; w.id = 'sdl' + (++winSeq) + '_' + Math.random().toString(36).slice(2, 6); w.nid = 'c' + (++nodeSeq);
            await gui('open', { id: w.id, title: w.title, width: Math.min(1200, w.w + 24) });
            await gui('add', { id: w.id, parent: 'root', node: Object.assign({ id: w.nid, kind: 'canvas', width: Math.min(1200, w.w), height: Math.min(1200, w.h), fps: 0, fit: true }, w.gl ? { gl: true } : {}) });
            if (w.gl) { await gui('glprog', { id: w.id, node: w.nid, name: 'flat', vs: FLAT_VS, fs: FLAT_FS }); await gui('glprog', { id: w.id, node: w.nid, name: 'points', vs: POINTS_VS, fs: POINTS_FS }); }
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
                let ops = R.ops; if (ops.length > 200) { if (!R.truncated) { R.truncated = true; warn('SDL：一幀超過 200 道繪圖指令（GUI 橋接的上限），多的被丟掉\n'); } ops = ops.slice(0, 200); }
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
            SDL_GL_CreateContext: (ctx, p) => { const w = handles.get(p); if (!w || !w.gl) return 0; return mk({ kind: 'glctx', win: w }); },
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
            glBegin: (ctx, mode) => { gl.begin = { mode, verts: [], mvp: mul4(top('P'), top('MV')) }; },
            glEnd: () => { const b = gl.begin; gl.begin = null; if (b && b.verts.length) gl.batches.push(b); },
            glColor3f: (ctx, r, g, b) => { gl.color = [r, g, b]; }, glColor4f: (ctx, r, g, b) => { gl.color = [r, g, b]; },
            glVertex2f: (ctx, x, y) => { if (gl.begin) gl.begin.verts.push(x, y, 0, gl.color[0], gl.color[1], gl.color[2]); },
            glVertex3f: (ctx, x, y, z) => { if (gl.begin) gl.begin.verts.push(x, y, z, gl.color[0], gl.color[1], gl.color[2]); },
            glEnable: (ctx, cap) => { if (cap === 0x0B71) gl.depth = true; }, glDisable: (ctx, cap) => { if (cap === 0x0B71) gl.depth = false; },
            glPointSize: (ctx, sz) => { gl.pointSize = sz; }, glLineWidth: () => {},
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
        async function flushGl(w) {
            const cmds = [['clear', gl.clear[0], gl.clear[1], gl.clear[2], gl.clear[3]], ['state', 'depth', gl.depth ? 1 : 0], ['use', 'flat']]; let n = 0;
            for (const b of gl.batches.slice(0, 20)) {
                let v = b.verts; const N = v.length / 6, vtx = (i) => v.slice(i * 6, i * 6 + 6);
                if (b.mode === 7) { const o = []; for (let q = 0; q + 3 < N; q += 4) for (const i of [0, 1, 2, 0, 2, 3]) o.push(...vtx(q + i)); v = o; }
                else if (b.mode === 6) { const o = []; for (let i = 1; i + 1 < N; i++) o.push(...vtx(0), ...vtx(i), ...vtx(i + 1)); v = o; }
                else if (b.mode === 2 && N > 1) v = v.concat(vtx(0));
                const name = 'b' + (n++), data = new Float32Array(v), bytes = new Uint8Array(data.buffer); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                await gui('glbuf', { id: w.id, node: w.nid, name, type: 'f32', data: btoa(s) });
                if (b.mode === 0) cmds.push(['use', 'points'], ['uf', 'mvp'].concat(b.mvp), ['uf', 'size', gl.pointSize], ['uf', 'tint', 1, 1, 1], ['attr', 'pos', name, 3, 24, 0, 0], ['attr', 'col', name, 3, 24, 12, 0], ['draw', 'points', 0, v.length / 6, 1], ['use', 'flat']);
                else cmds.push(['uf', 'mvp'].concat(b.mvp), ['attr', 'pos', name, 3, 24, 0, 0], ['attr', 'col', name, 3, 24, 12, 0], ['draw', GL_MODE[b.mode] || 'triangles', 0, v.length / 6, 1]);
            }
            await gui('glframe', { id: w.id, node: w.nid, cmds });
            gl.batches = [];
        }
        return { impls, SIGS, toS16, install(FaLlvm) { installs++; FaLlvm.registerHost(SIGS); }, uninstall(FaLlvm) { if (--installs <= 0) { installs = 0; FaLlvm.unregisterHost(Object.keys(SIGS)); } }, close() { closeAllFiles(); handles.clear(); Array.from(audioDevs.values()).forEach((d) => { gui('audio', { cmd: 'stream_close', id: d.id }); }); audioDevs.clear(); } };
    }
    return { create, SIGS, formatC, scancodeOf, keycodeOf };
});
