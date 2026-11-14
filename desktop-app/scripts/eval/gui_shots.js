// 用法：FA_UPDATE_BASE=http://127.0.0.1:9/none FA_BROWSER_CONTROL_PORT=<不可用 17923> node_modules/electron/dist/electron.exe scripts/eval/gui_shots.js --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
//   環境變數：FA_SHOTS_OUT=<輸出資料夾，預設 docs/gui-templates-shots>、FA_SHOTS_ONLY=<領域，逗號分隔>、FA_SHOTS_RESULT=<結果 json 路徑>
// 真桌面版的 GUI 範本畫面截圖：十三個領域的主範本，淺色與深色各一張（淺色用 main_light，沒有就用 main；深色用 main_dark），
// 存成 <輸出資料夾>/<領域>_light.png、<領域>_dark.png；另外用真實鍵盤與滑鼠驗證文件範本：打字不會失去焦點、「插入段落」在游標處插入、點大綱跳到標題。
// FA_UPDATE_BASE 指向不存在的位址，是為了不要讓啟動時的自動更新視窗蓋住畫面。
const path = require('path');
const fs = require('fs');
process.env.FA_DISABLE_MAIN_OVERLAY = '1';
const { app } = require('electron');
let main = null;
app.on('browser-window-created', (e, w) => { if (!main) { main = w; } });
require('../../main.js');

const OUT = process.env.FA_SHOTS_OUT || path.join(__dirname, '..', '..', 'docs', 'gui-templates-shots');
const ONLY = (process.env.FA_SHOTS_ONLY || '').split(',').filter(Boolean);
const DOMAINS = ['text-editor', 'office', 'document', 'slides', 'project', 'inventory', 'beauty', 'idphoto', 'image', 'media', 'midi', 'game', 'web-design'];
const LIGHT = { beauty: 'beauty/main_light', game: 'game/main_light', idphoto: 'idphoto/main_light', image: 'image/main_light', inventory: 'inventory/main_light', media: 'media/main_light', midi: 'midi/main_light', project: 'project/main_light', slides: 'slides/main_light', 'web-design': 'web-design/main_light' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { shots: {}, keyboard: {}, errors: null };
fs.mkdirSync(OUT, { recursive: true });

app.whenReady().then(async () => {
  try {
    while (!main) { await wait(100); }
    await new Promise((res) => { if (main.webContents.isLoading()) { main.webContents.once('did-finish-load', res); } else { res(); } });
    const wc = main.webContents;
    const ev = (code) => wc.executeJavaScript('(async () => {' + code + '\n})().then((v) => v === undefined ? null : v)');
    await ev('await new Promise((resolve) => { const iv = setInterval(() => { if (window.__faBootstrapReady) { clearInterval(iv); resolve(); } }, 50); });');
    main.setBounds({ x: 0, y: 0, width: 1500, height: 1000 });
    main.show(); main.focus(); wc.focus();
    await wait(800);

    await ev(`
      const fa = window.fa;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (_) { } await wait(100); } return null; };
      const termText = (s) => { const b = s.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out.push(l.translateToString(true)); } return out.join('\\n'); };
      const t = await fa._createTerminalForAI({ name: 'gui-shots', initialCommand: '' });
      const session = fa._resolveTerminalSession(t.id).session;
      await wait(800);
      await fa._runTerminalCommand(session, 'cd /work');
      const fsStore = await fa._ensureTerminalFsStore(session, await fa._ensureBashWasmLoaded());
      const W = () => document.querySelector('.gui-window[data-window]');
      window.__v = {
        session, termText, wait, until, W, done: false,
        put: (name, text) => fa._writeBytesToTerminalFs(fsStore, '/work/' + name, new TextEncoder().encode(text)),
        cnt: (re) => (termText(session).match(re) || []).length,
        async open(id) {
          const v = window.__v;
          v.done = false; v.endBefore = v.cnt(/SH-END/g);
          v.put('sh_run.py', 'import gui\\nimport guitpl\\nguitpl.run(' + JSON.stringify(id) + ')\\nprint("SH-END")\\n');
          fa._runTerminalCommand(session, 'python3 sh_run.py').then(() => { v.done = true; }, () => { v.done = true; });
          await until(() => W() && W().querySelector('[data-node]'), 30000);
          let last = -1, since = Date.now();
          while (Date.now() - since < 1200 && Date.now() < since + 15000) { const c = document.querySelectorAll('.gui-window[data-window] [data-node]').length; if (c !== last) { last = c; since = Date.now(); } await wait(100); }
          return !!W();
        },
        async closeAll() {
          const v = window.__v;
          document.querySelectorAll('.gui-window[data-window] .gui-close').forEach((c) => c.click());
          await until(() => v.done, 15000);
          await until(() => v.cnt(/SH-END/g) > v.endBefore, 6000);
          return v.cnt(/SH-END/g) > v.endBefore;
        },
        rectOf(el) { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height) }; },
        byText(sel, text) { return Array.from(W().querySelectorAll(sel)).find((b) => (b.textContent || '').indexOf(text) >= 0) || null; },
      };
      return true;
    `);

    const pixels = (img) => { const sz = img.getSize(); return { w: sz.width, h: sz.height, buf: img.toBitmap() }; };
    const stats = (p) => {
      const seen = new Set(); let sum = 0;
      for (let i = 0; i < p.buf.length; i += 4) { seen.add(p.buf[i] + ',' + p.buf[i + 1] + ',' + p.buf[i + 2]); sum += 0.114 * p.buf[i] + 0.587 * p.buf[i + 1] + 0.299 * p.buf[i + 2]; }
      return { colors: seen.size, mean: Math.round(sum / (p.buf.length / 4)) };
    };
    const click = async (x, y) => {
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await wait(250);
    };
    const typeText = async (s) => {
      for (const ch of s) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
        wc.sendInputEvent({ type: 'char', keyCode: ch });
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
        await wait(40);
      }
      await wait(250);
    };

    // 視窗比放它的區域大就彈出（⤢）；還是比頁面大就最大化（□）。回傳最後的視窗矩形
    const popIfClipped = async (r, rect, page) => {
      const layer = await ev('return window.__v.rectOf(document.querySelector(".ai-gui-layer"));');
      r.layer = layer;
      if (rect && layer && (rect.x + rect.width > layer.x + layer.width + 1 || rect.y + rect.height > layer.y + layer.height + 1)) {
        r.popped = await ev('const b = window.__v.byText(".gui-titlebar button", "⤢"); if (b) { b.click(); } return !!b;');
        await wait(900);
        rect = await ev('return window.__v.rectOf(window.__v.W());');
        r.rect_after_pop = rect;
        if (rect && (rect.x + rect.width > page.w || rect.y + rect.height > page.h)) {
          r.maximized = await ev('const b = window.__v.byText(".gui-titlebar button", "□"); if (b) { b.click(); } return !!b;');
          await wait(900);
          rect = await ev('return window.__v.rectOf(window.__v.W());');
          r.rect_after_max = rect;
        }
      }
      return rect;
    };

    // ---- 一、截圖 ----
    for (const dom of DOMAINS) {
      if (ONLY.length && ONLY.indexOf(dom) < 0) { continue; }
      for (const scheme of ['light', 'dark']) {
        const id = scheme === 'dark' ? dom + '/main_dark' : (LIGHT[dom] || dom + '/main');
        const r = { id };
        R.shots[dom + '_' + scheme] = r;
        try {
          r.opened = await ev('return await window.__v.open(' + JSON.stringify(id) + ');');
          await wait(600);
          let rect = await ev('return window.__v.rectOf(window.__v.W());');
          const page = await ev('return { w: window.innerWidth, h: window.innerHeight };');
          r.rect = rect; r.page = page;
          rect = await popIfClipped(r, rect, page);
          if (rect) {
            const img = await wc.capturePage({ x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(rect.width, page.w - Math.max(0, rect.x)), height: Math.min(rect.height, page.h - Math.max(0, rect.y)) });
            const p = pixels(img); const st = stats(p);
            r.size = [p.w, p.h]; r.colors = st.colors; r.mean = st.mean; r.not_blank = st.colors >= 12;
            fs.writeFileSync(path.join(OUT, dom + '_' + scheme + '.png'), img.toPNG());
          }
        } catch (e) { r.error = String(e); }
        r.closed = await ev('return await window.__v.closeAll();');
        await wait(300);
      }
    }

    // ---- 二、文件範本：真實鍵盤與滑鼠 ----
    if (!ONLY.length || ONLY.indexOf('document') >= 0) {
      const k = R.keyboard;
      k.opened = await ev('return await window.__v.open("document/main");');
      await wait(600);
      const kpage = await ev('return { w: window.innerWidth, h: window.innerHeight };');
      k.rect = await popIfClipped(k, await ev('return window.__v.rectOf(window.__v.W());'), kpage);
      await wait(300);
      const taRect = await ev('const t = window.__v.W().querySelector(".gui-ed-ta"); return window.__v.rectOf(t);');
      k.editor_found = !!taRect;
      if (taRect) {
        main.show(); main.focus(); wc.focus();
        await click(taRect.x + taRect.width / 2, taRect.y + taRect.height - 40);   // 點到文末空白處
        await ev('const t = window.__v.W().querySelector(".gui-ed-ta"); t.setSelectionRange(t.value.length, t.value.length); return true;');
        const before = await ev('return window.__v.W().querySelector(".gui-ed-ta").value;');
        await typeText('\n\n## abc');
        k.typed = await ev('const w = window.__v.W(); const t = w.querySelector(".gui-ed-ta"); return { value_tail: t.value.slice(-8), focused: document.activeElement === t, same_node: true };');
        k.typed.grew = k.typed.value_tail.indexOf('abc') >= 0;
        await wait(500);   // Python 端收到輸入後更新字數與大綱（用 set，不能把游標重畫掉）
        k.after_status = await ev('const w = window.__v.W(); const t = w.querySelector(".gui-ed-ta"); const c = Array.from(w.querySelectorAll(".gui-label")).map((l) => l.textContent).filter((x) => /字/.test(x)); return { still_focused: document.activeElement === t, count_label: c, outline: Array.from(w.querySelectorAll(".gui-list option")).map((o) => o.textContent) };');
        // 插入段落：按工具列按鈕（真的滑鼠點擊）
        const btn = await ev('return window.__v.rectOf(window.__v.byText("button", "插入段落"));');
        if (btn) {
          await ev('const t = window.__v.W().querySelector(".gui-ed-ta"); t.focus(); t.setSelectionRange(5, 5); t.dispatchEvent(new Event("keyup", { bubbles: true })); return true;');
          await wait(400);
          await click(btn.x + btn.width / 2, btn.y + btn.height / 2);
          await wait(700);
          k.insert = await ev('const t = window.__v.W().querySelector(".gui-ed-ta"); const i = t.value.indexOf("新段落"); return { found: i >= 0, at: i, selected: t.value.slice(t.selectionStart, t.selectionEnd), focused: document.activeElement === t, msg: (window.__v.byText(".gui-label", "游標處") || {}).textContent || null };');
          await typeText('REPLACED');
          k.replaced = await ev('const t = window.__v.W().querySelector(".gui-ed-ta"); return { has_new: t.value.indexOf("REPLACED") >= 0, placeholder_gone: t.value.indexOf("新段落") < 0 };');
        }
        // 大綱：點第二個項目，游標跳到那個標題
        const opt = await ev('const o = Array.from(window.__v.W().querySelectorAll(".gui-list option"))[1]; return window.__v.rectOf(o);');
        if (opt) {
          await click(opt.x + 10, opt.y + opt.height / 2);
          await wait(700);
          k.jump = await ev('const t = window.__v.W().querySelector(".gui-ed-ta"); const lineStart = t.value.lastIndexOf("\\n", t.selectionStart - 1) + 1; return { selected: t.value.slice(t.selectionStart, t.selectionEnd), is_heading: /^#/.test(t.value.slice(lineStart)), focused: document.activeElement === t };');
        }
        const full = await ev('return window.__v.rectOf(window.__v.W());');
        if (full) {
          const page = await ev('return { w: window.innerWidth, h: window.innerHeight };');
          const img = await wc.capturePage({ x: Math.max(0, full.x), y: Math.max(0, full.y), width: Math.min(full.width, page.w - Math.max(0, full.x)), height: Math.min(full.height, page.h - Math.max(0, full.y)) });
          fs.writeFileSync(path.join(OUT, 'document_after_editing.png'), img.toPNG());
        }
      }
      k.closed = await ev('return await window.__v.closeAll();');
    }
    R.errors = await ev('return window.__v.cnt(/Traceback|\\[guitpl\\]/g);');
  } catch (e) {
    R.fatal = String(e && e.stack || e);
  }
  const out = JSON.stringify(R, null, 1);
  try { fs.writeFileSync(process.env.FA_SHOTS_RESULT || path.join(OUT, 'result.json'), out); } catch (e) { /* ignore */ }
  console.log('[gui-shots] result: ' + out);
  setTimeout(() => app.quit(), 300);
});
