// 用法：FA_UPDATE_BASE=http://127.0.0.1:9/none FA_BROWSER_CONTROL_PORT=<不是 17923> node_modules/electron/dist/electron.exe scripts/eval/skill_run_script.eval.js --no-sandbox --disable-gpu --user-data-dir=<全新暫存資料夾>
//   環境變數：SKILL_FILE=<.skill 檔>、ATTACH_FILE=<附件檔>、SRS_RESULT=<結果 json 路徑>
// 真桌面版驗證：匯入技能包 → 放一個附件 → 呼叫 skill_run_script 開 tcv_gui.py → 看視窗畫出來、檔案清單有項目 → 關閉。
const fs = require('fs');
const path = require('path');
process.env.FA_DISABLE_MAIN_OVERLAY = '1';
const { app } = require('electron');
let main = null;
app.on('browser-window-created', (e, w) => { if (!main) { main = w; } });
require('../../main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.SRS_RESULT || path.join(__dirname, 'skill_run_script.result.json');
const R = { steps: {}, error: null };
const save = () => fs.writeFileSync(OUT, JSON.stringify(R, null, 2));

app.whenReady().then(async () => {
  try {
    while (!main) { await wait(100); }
    await new Promise((res) => { if (main.webContents.isLoading()) { main.webContents.once('did-finish-load', res); } else { res(); } });
    const wc = main.webContents;
    const ev = (code) => wc.executeJavaScript('(async () => {' + code + '\n})().then((v) => v === undefined ? null : v)');
    await ev('await new Promise((resolve) => { const iv = setInterval(() => { if (window.__faBootstrapReady) { clearInterval(iv); resolve(); } }, 50); });');
    main.setBounds({ x: 0, y: 0, width: 1400, height: 900 });
    await wait(800);
    const skillB64 = fs.readFileSync(process.env.SKILL_FILE).toString('base64');
    const attB64 = fs.readFileSync(process.env.ATTACH_FILE).toString('base64');
    R.steps.import = await ev(`
      const b = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const fa = window.fa;
      const r = await fa._importSkillZip(new File([b(${JSON.stringify(skillB64)})], 'testcaseviewer.skill'), { silent: true });
      const bundles = (fa.advancedSettings.skillBundles || []).map((x) => ({ id: x.id, name: x.name, files: (x.files || []).length }));
      window.__bid = r && r.bundleId; return { r: r && (r.ok !== undefined ? r.ok : true), retId: r && r.bundleId, bundles: bundles.filter((x) => x.name === 'testcaseviewer'), n: bundles.length };
    `);
    R.steps.attach = await ev(`
      const b = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const rec = await window.fa.fileCache.put('result.tar.gz', 'application/gzip', new Blob([b(${JSON.stringify(attB64)})]), 'uploaded');
      window.__attId = (rec && rec.id) || (typeof rec === 'string' ? rec : 'result.tar.gz'); return String(window.__attId) + ' / ' + typeof rec;
    `);
    R.steps.dbg = await ev(`
      const fa = window.fa; const b = (fa.advancedSettings.skillBundles || []).find((x) => x.name === 'testcaseviewer');
      const out = { paths: b.files.map((f) => f.path).slice(0, 10) };
      const rec = await fa.skillFileCache.get(b.id + '::' + b.files[0].path);
      out.rec = !!rec; try { const all = await fa.skillFileCache.getAll(); out.all = all.length; out.ids = all.slice(0, 3).map((x) => x.id); out.bid = b.id; } catch (e) { out.allErr = String(e); } out.first = b.files[0].path;
      const py = fa._getToolDefinition('python_execute');
      const r = await py.callback.call(fa, JSON.stringify({ script: ['import os', 'print(os.getcwd())', 'print(os.listdir("/work"))', 'print(os.path.exists("/work/skills/x/scripts/a.py"))'].join(String.fromCharCode(10)), input_files: { 'skills/x/scripts/a.py': 'print(1)' } }));
      out.py = String(r).slice(0, 400);
      return out;
    `);
    R.steps.run = await ev(`
      const fa = window.fa; const t = fa._getToolDefinition('skill_run_script');
      if (!t) return { error: 'no tool' };
      window.__runDone = null;
      t.callback.call(fa, JSON.stringify({ skill: window.__bid || 'testcaseviewer', script: 'tcv_gui.py', args: ['--open', 'attachment://' + window.__attId], timeout_seconds: 60 })).then((x) => { window.__runDone = x; }, (e) => { window.__runDone = 'ERR ' + e; });
      const t0 = Date.now(); let w = null;
      while (Date.now() - t0 < 120000) { w = document.querySelector('.gui-window[data-window]'); if (w && w.querySelectorAll('[data-node]').length > 8) break; if (window.__runDone) break; await new Promise((r) => setTimeout(r, 300)); }
      await new Promise((r) => setTimeout(r, 4000));
      w = document.querySelector('.gui-window[data-window]');
      const lists = w ? Array.from(w.querySelectorAll('select')).map((s) => ({ options: s.options.length, h: Math.round(s.getBoundingClientRect().height) })) : null;
      const out = { windowShown: !!w, nodes: w ? w.querySelectorAll('[data-node]').length : 0, lists, text: w ? w.innerText.slice(0, 400) : null, runDone: window.__runDone ? String(window.__runDone).slice(0, 3000) : null };
      if (w) {
        const sel = w.querySelectorAll('select')[0]; const opt = sel && Array.from(sel.options).find((o) => /NormalLog\.html/.test(o.textContent));
        out.picked = !!opt;
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 9000)); const w2 = document.querySelector('.gui-window[data-window]'); out.afterPick = w2.innerText.slice(0, 700); out.treeRows = w2.querySelectorAll('tr, .gui-tree-row, [data-row]').length; }
      }
      if (w) { const c = w.querySelector('.gui-close'); if (c) c.click(); }
      return out;
    `);
    await wait(3000);
    R.steps.term = await ev(`
      const ss = window.fa._getMountedTerminalSessions(); const out = ss.map((x) => { const b = x.term.buffer.active; const l = []; for (let i = Math.max(0, b.length - 40); i < b.length; i++) { const q = b.getLine(i); if (q) l.push(q.translateToString(true)); } return { name: x.name, text: l.join(String.fromCharCode(10)).slice(-2500), win: !!(x.container && x.container.querySelector('.gui-window')) }; });
      return out;
    `);
    R.steps.after = await ev('return window.__runDone ? String(window.__runDone).slice(0, 600) : null;');
  } catch (e) { R.error = String((e && e.stack) || e); }
  save();
  app.exit(0);
});
