// 用法：node_modules/electron/dist/electron.exe scripts/eval/native_driver.js --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
//   環境變數：FA_BROWSER_CONTROL_PORT=<不可用 17923>、FA_UPDATE_BASELINE=1（重新產生基準圖）、FA_NATIVE_OUT=<結果 json 路徑>
// 用 Electron 主行程的原生能力驗證 GUI 範本（不經過頁面裡的合成事件）：
//   A. 真實鍵盤與滑鼠：webContents.sendInputEvent 送滑鼠點擊（對焦）、逐字輸入、Ctrl+Enter／Ctrl+L 快捷鍵；Ctrl+C 中止前景的 Python 程式。
//   B. 畫布截圖比對：webContents.capturePage 截畫布區域，與 scripts/eval/baselines/*.png 比對（逐像素差容忍門檻），同時檢查畫面不是空白、
//      各配色變體的視窗平均亮度與主範本真的不同。
// 這支程式先載入真正的 main.js（同一個應用程式），再從主行程控制它的視窗。
const path = require('path');
const fs = require('fs');
process.env.FA_DISABLE_MAIN_OVERLAY = '1';
const { app } = require('electron');
let main = null;
app.on('browser-window-created', (e, w) => { if (!main) { main = w; } });
require('../../main.js');

const BASE_DIR = path.join(__dirname, 'baselines');
const UPDATE = process.env.FA_UPDATE_BASELINE === '1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { keyboard: {}, shots: {}, variants: {} };

app.whenReady().then(async () => {
  try {
    while (!main) { await wait(100); }
    await new Promise((res) => { if (main.webContents.isLoading()) { main.webContents.once('did-finish-load', res); } else { res(); } });
    const wc = main.webContents;
    const ev = (code) => wc.executeJavaScript('(async () => {' + code + '\n})().then((v) => v === undefined ? null : v)');
    await ev('await new Promise((resolve) => { const iv = setInterval(() => { if (window.__faBootstrapReady) { clearInterval(iv); resolve(); } }, 50); });');
    main.show(); main.focus(); wc.focus();

    // 頁面裡的小工具：開一個範本、取畫布／視窗矩形、關窗
    await ev(`
      const fa = window.fa;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { } await wait(100); } return null; };
      const termText = (s) => { const b = s.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\\n'); };
      const t = await fa._createTerminalForAI({ name: 'native-driver', initialCommand: '' });
      const session = fa._resolveTerminalSession(t.id).session;
      await wait(800);
      await fa._runTerminalCommand(session, 'cd /work');
      const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
      window.__v = {
        session, termText, wait, until,
        put: (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text)),
        cnt: (re) => (termText(session).match(re) || []).length,
        W: () => document.querySelector('.gui-window[data-window]'),
        done: false,
        async open(id) {
          const v = window.__v;
          v.done = false; v.endBefore = v.cnt(/ND-END/g);
          v.put('nd_run.py', 'import gui\\nimport guitpl\\nguitpl.run(' + JSON.stringify(id) + ')\\nprint("ND-END")\\n');
          fa._runTerminalCommand(session, 'python3 nd_run.py').then(() => { v.done = true; }, () => { v.done = true; });
          await until(() => v.W() && v.W().querySelector('[data-node]'), 25000);
          let last = -1, since = Date.now();
          while (Date.now() - since < 800 && Date.now() < since + 12000) { const c = document.querySelectorAll('.gui-window[data-window] [data-node]').length; if (c !== last) { last = c; since = Date.now(); } await wait(100); }
          return !!v.W();
        },
        async closeAll() {
          const v = window.__v;
          document.querySelectorAll('.gui-window[data-window] .gui-close').forEach((c) => c.click());
          await until(() => v.done, 15000);
          await until(() => v.cnt(/ND-END/g) > v.endBefore, 6000);
          return v.cnt(/ND-END/g) > v.endBefore;
        },
        rect(sel) { const e = v_W().querySelector(sel); if (!e) return null; if (sel === 'canvas') e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; },
        winRect() { const b = v_W().getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; },
      };
      function v_W() { return document.querySelector('.gui-window[data-window]'); }
      return true;
    `);

    // ---- 輸入事件工具 ----
    const click = async (x, y) => {
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await wait(150);
    };
    const key = async (keyCode, modifiers = []) => {
      wc.sendInputEvent({ type: 'rawKeyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await wait(200);
    };
    const typeText = async (s) => {
      for (const ch of s) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
        wc.sendInputEvent({ type: 'char', keyCode: ch });
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
        await wait(40);
      }
      await wait(150);
    };

    // ===== A. 真實鍵盤：office/main（待辦清單）=====
    const k = R.keyboard;
    k.opened = await ev('return await window.__v.open("office/main");');
    // 對焦第一個輸入框（真的滑鼠點擊），逐字輸入
    const entry = await ev('return window.__v.rect("input.gui-entry");');
    k.entry_found = !!entry;
    if (entry) {
      main.show(); main.focus(); wc.focus();
      await click(entry.x + 10, entry.y + entry.height / 2);
      await typeText('Hello');
      k.entry_value = await ev('const e = window.__v.W().querySelector("input.gui-entry"); return e && e.value;');
      // 真實快捷鍵：Ctrl+Enter（新增待辦）
      const before = await ev('return window.__v.W().textContent;');
      await key('Return', ['control']);
      await wait(400);
      const after = await ev('return window.__v.W().textContent + "|" + Array.from(window.__v.W().querySelectorAll("textarea,input")).map((x) => x.value).join("~");');
      k.shortcut_changed = after !== before;
      k.shortcut_has_text = /Hello/.test(after);
      // Ctrl+L（清除已完成）也送一次，不能出錯
      await key('L', ['control']);
    }
    k.errors = await ev('return window.__v.cnt(/Traceback|\\[guitpl\\]/g);');
    k.closed = await ev('return await window.__v.closeAll();');

    // ===== A2. 真實 Ctrl+C 中止前景的 Python 程式 =====
    const c = {};
    R.ctrl_c = c;
    // 程式本身寫成檔案，指令用真實鍵盤打進終端機（這樣終端機才把它當成前景程式）
    await ev(`window.__v.put('nd_loop.py', 'import gui\\nimport guitpl\\nguitpl.run("game/main")\\nprint("LOOP-END")\\n'); window.__v.session.term.focus(); window.__v.loopBefore = window.__v.cnt(/LOOP-END/g); return true;`);
    wc.focus();
    await wait(300);
    await typeText('python3 nd_loop.py');
    await key('Return');
    c.opened = !!(await ev('return await window.__v.until(() => window.__v.W() && window.__v.W().querySelector("[data-node]"), 25000);'));
    await wait(1500);
    c.window_open_before = await ev('return !!window.__v.W();');
    c.running_before = await ev('return window.__v.cnt(/LOOP-END/g) === window.__v.loopBefore;');
    await ev('window.__v.session.term.focus(); return true;');
    wc.focus();
    await wait(200);
    await key('C', ['control']);
    await wait(1500);
    c.aborted = await ev('return await window.__v.until(() => window.__v.cnt(/\\^C/g) > 0, 6000) ? true : false;');
    c.prompt_back = await ev('return /\\/work \\$ *$/.test(window.__v.termText(window.__v.session).split("\\n").filter((l) => l.trim()).slice(-1)[0] || "");');
    c.tail = await ev('return window.__v.termText(window.__v.session).split("\\n").filter((l) => l.trim()).slice(-3).join(" // ");');
    await ev('document.querySelectorAll(".gui-window[data-window] .gui-close").forEach((x) => x.click()); return true;');
    await wait(500);

    // ===== B. 畫布截圖比對 =====
    if (!fs.existsSync(BASE_DIR)) { fs.mkdirSync(BASE_DIR, { recursive: true }); }
    const pixels = (img) => { const s = img.getSize(); return { w: s.width, h: s.height, buf: img.toBitmap() }; };
    const compare = (a, b) => {
      if (a.w !== b.w || a.h !== b.h) { return { size_mismatch: true, a: [a.w, a.h], b: [b.w, b.h] }; }
      let diff = 0;
      for (let i = 0; i < a.buf.length; i += 4) {
        if (Math.abs(a.buf[i] - b.buf[i]) > 24 || Math.abs(a.buf[i + 1] - b.buf[i + 1]) > 24 || Math.abs(a.buf[i + 2] - b.buf[i + 2]) > 24) { diff++; }
      }
      return { diff_ratio: diff / (a.w * a.h) };
    };
    const stats = (p) => {
      const seen = new Set(); let sum = 0;
      for (let i = 0; i < p.buf.length; i += 4) { seen.add(p.buf[i] + ',' + p.buf[i + 1] + ',' + p.buf[i + 2]); sum += 0.114 * p.buf[i] + 0.587 * p.buf[i + 1] + 0.299 * p.buf[i + 2]; }
      return { colors: seen.size, mean: sum / (p.buf.length / 4) };
    };
    const CANVAS_IDS = ['beauty/main', 'game/main', 'idphoto/main', 'image/main', 'media/main', 'midi/main', 'web-design/main'];
    for (const id of CANVAS_IDS) {
      const r = {};
      R.shots[id] = r;
      r.opened = await ev('return await window.__v.open(' + JSON.stringify(id) + ');');
      await wait(900);
      const rect = await ev('return window.__v.rect("canvas");');
      if (!rect) { r.ok = false; await ev('return await window.__v.closeAll();'); continue; }
      const img = await wc.capturePage(rect);
      const p = pixels(img);
      const st = stats(p);
      r.size = [p.w, p.h]; r.colors = st.colors;
      r.not_blank = st.colors >= 3;
      const file = path.join(BASE_DIR, id.replace('/', '_') + '.png');
      if (UPDATE || !fs.existsSync(file)) { fs.writeFileSync(file, img.toPNG()); r.baseline = 'written'; }
      const base = pixels(require('electron').nativeImage.createFromPath(file));
      const cmp = compare(p, base);
      Object.assign(r, cmp);
      r.within_tolerance = !cmp.size_mismatch && cmp.diff_ratio <= 0.02;
      r.ok = r.not_blank && r.within_tolerance;
      await ev('return await window.__v.closeAll();');
      await wait(300);
    }

    // 配色變體：視窗截圖的平均亮度要和主範本不同（深色變體明顯更暗）
    const VARIANTS = [['office', 'main', 'main_dark'], ['image', 'main', 'main_dark'], ['image', 'main', 'main_light'], ['text-editor', 'main', 'main_dark'], ['text-editor', 'main', 'main_contrast'],
      ['game', 'main', 'main_dark'], ['office', 'main', 'main_warm']];
    const meanOf = async (id) => {
      await ev('return await window.__v.open(' + JSON.stringify(id) + ');');
      await wait(700);
      const rect = await ev('return window.__v.winRect();');
      const p = pixels(await wc.capturePage(rect));
      await ev('return await window.__v.closeAll();');
      await wait(300);
      return Object.assign({ p }, stats(p));
    };
    const cache = {};
    for (const [dom, a, b] of VARIANTS) {
      const ida = dom + '/' + a, idb = dom + '/' + b;
      cache[ida] = cache[ida] || await meanOf(ida);
      cache[idb] = cache[idb] || await meanOf(idb);
      const d = Math.abs(cache[ida].mean - cache[idb].mean);
      const cmp2 = compare(cache[ida].p, cache[idb].p);
      // 視窗截圖裡至少 2% 的像素顏色明顯不同（與基準圖容忍門檻一致）；字型不同使視窗大小不同（例如 monospace）時無法逐像素比，改看平均亮度差 8 以上，才算這個變體真的改了配色
      R.variants[idb] = { base_mean: Math.round(cache[ida].mean), mean: Math.round(cache[idb].mean), delta: Math.round(d), diff_ratio: cmp2.diff_ratio, size_mismatch: !!cmp2.size_mismatch, changed: cmp2.size_mismatch ? d >= 8 : cmp2.diff_ratio >= 0.02 };
    }
    R.failed_shots = Object.keys(R.shots).filter((k2) => !R.shots[k2].ok);
    R.failed_variants = Object.keys(R.variants).filter((k2) => !R.variants[k2].changed);
    R.all_ok = !!(k.opened && k.entry_value === 'Hello' && k.shortcut_changed && k.shortcut_has_text && !k.errors && k.closed && c.aborted && c.prompt_back && !R.failed_shots.length && !R.failed_variants.length);
  } catch (err) {
    R.error = String((err && err.stack) || err);
  }
  const out = JSON.stringify(R);
  if (process.env.FA_NATIVE_OUT) { fs.writeFileSync(process.env.FA_NATIVE_OUT, out, 'utf8'); }
  console.log('[native-driver] result: ' + out);
  setTimeout(() => app.quit(), 300);
});
