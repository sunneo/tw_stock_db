// node scripts/computer-tests/electron.itest.js -- 端到端：真的 Electron（node_modules/electron）跑真的 main.js／preload.js（套上 renderer/src/computer/main-wiring.patch），
// 在自己的 Xvfb 裡：renderer 呼叫 window.desktopAPI.computer.* → preload → IPC → main-ext → computer-use-ipc → 門面 → xdotool／AT-SPI。
// 這個測試扮演「使用者」：在原生核准視窗用 AT-SPI 按下「啟用」「確定」「執行」（Chromium 開 --force-renderer-accessibility），並按下全域中止鍵。
// 不會碰真實畫面（DISPLAY 是自己起的 Xvfb）；userData 是暫存資料夾；沒有 electron／Xvfb／patch 時略過。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { suite } = require('./_t.js');
const { startXEnv, which, sleep } = require('./xenv.js');
const { createExec } = require('../../computer-use-linux.js');
const { createAtspi } = require('../../computer-use-atspi.js');
const t = suite('electron 端到端');
const ROOT = path.join(__dirname, '..', '..'), ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
const need = ['Xvfb', 'xdotool', 'wmctrl', 'xterm', 'xfwm4', 'patch'].filter((b) => !which(b)); if (!fs.existsSync(ELECTRON)) need.push('electron');
if (need.length) { console.log('SKIP electron 端到端：缺少 ' + need.join('、')); console.log('electron 端到端: 0 passed, 0 failed (skipped)'); process.exit(0); }

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-e2e-')), app = path.join(tmp, 'app'), ud = path.join(tmp, 'ud'), typed = path.join(tmp, 'typed.txt');
  let x = null, proc = null;
  try {
    // ----- 組出一份「已接線」的 app：全部 symlink 到原目錄，只有 4 個接線檔用複製＋（如果還沒接線）套 patch
    fs.mkdirSync(app); const wired = /computer-use-ipc\.js/.test(fs.readFileSync(path.join(ROOT, 'main-ext.js'), 'utf8')) && /fa:computer:/.test(fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8'));
    const copyFiles = ['main.js', 'main-ext.js', 'preload.js', 'package.json'];
    for (const f of fs.readdirSync(ROOT)) { if (['dist', 'scripts', 'supabase', 'cloudflare', 'launcher', 'features', 'skills', 'builtin-secrets.json', 'builtin-secrets.json.bak'].includes(f) || (!wired && copyFiles.includes(f))) continue; try { fs.symlinkSync(path.join(ROOT, f), path.join(app, f)); } catch (_) { /* */ } }
    if (!wired) { for (const f of copyFiles) fs.copyFileSync(path.join(ROOT, f), path.join(app, f)); const pr = spawnSync('patch', ['-p1', '-s', '-i', path.join(ROOT, 'renderer', 'src', 'computer', 'main-wiring.patch')], { cwd: app, encoding: 'utf8' }); if (pr.status !== 0) throw new Error('套 patch 失敗：' + pr.stdout + pr.stderr); }
    t.check('（準備）接線檔就緒：preload 有 computer、main-ext 載入 computer-use-ipc', /computer-use-ipc\.js/.test(fs.readFileSync(path.join(app, 'main-ext.js'), 'utf8')) && /fa:computer:/.test(fs.readFileSync(path.join(app, 'preload.js'), 'utf8')));

    x = await startXEnv({ atspi: true, size: '1280x900x24' });
    x.run('xterm', ['-T', 'FA-TARGET', '-geometry', '60x10+80+80', '-e', 'sh', '-c', 'while IFS= read -r l; do printf "%s\\n" "$l" >> ' + typed + '; done']);
    x.run('xterm', ['-T', 'FA-OTHER', '-geometry', '40x6+700+500', '-e', 'sleep', '900']); await sleep(1200);
    const run = createExec(x.env), atspi = createAtspi({ run, env: x.env });
    const sh = (c, a) => spawnSync(c, a, { env: x.env, encoding: 'utf8' });
    const winList = () => sh('wmctrl', ['-lp']).stdout.split('\n').filter(Boolean).map((l) => { const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+\S+\s+(.*)$/.exec(l); return m ? { id: m[1], pid: +m[3], title: m[4] } : null; }).filter(Boolean);
    const target = winList().find((w) => w.title === 'FA-TARGET');
    const tgtGeo = (() => { const r = sh('xwininfo', ['-id', target.id]).stdout; const g = (re) => Number(re.exec(r)[1]); return { x: g(/Absolute upper-left X:\s+(-?\d+)/), y: g(/Absolute upper-left Y:\s+(-?\d+)/), w: g(/Width:\s+(\d+)/), h: g(/Height:\s+(\d+)/) }; })();

    // ----- eval 腳本（在 renderer 裡跑）：每一步都是「AI／助理」會做的事；需要使用者的地方由下面的「使用者」處理
    const evalFile = path.join(tmp, 'eval.js'); const TG = JSON.stringify({ id: target.id, geo: tgtGeo });
    fs.writeFileSync(evalFile, `const c = window.desktopAPI.computer, TG = ${TG}, log = {};
      const P = (n) => console.log('FA-STEP ' + n);
      P('start'); log.platform = (await c.status()).platform;
      log.preEnabled = (await c.status()).enabled;
      log.runWhileOff = await c.run([{ op: 'click', x: TG.geo.x + 30, y: TG.geo.y + 30 }]);
      P('enable'); log.enable = await c.setEnabled(true);
      log.afterEnable = (await c.status());
      log.noScope = await c.plan([{ op: 'click', x: TG.geo.x + 30, y: TG.geo.y + 30 }]);
      const all = await c.listWindows({ all: true }); log.selfWins = all.windows.filter((w) => w.self).map((w) => w.title);
      P('scopeSelf'); log.scopeSelf = null; const selfWin = all.windows.find((w) => w.self); if (selfWin) log.scopeSelf = await c.setScope({ windowIds: [selfWin.id] });
      P('pick'); log.pick = await c.pickScope();
      log.afterPick = (await c.status()).scope;
      log.out = await c.run([{ op: 'click', x: 710, y: 520 }]);
      log.shot = await c.screenshot({ windowId: TG.id, maxSide: 300 }); if (log.shot && log.shot.dataUrl) { log.shot = { ok: log.shot.ok, w: log.shot.width, h: log.shot.height, origin: log.shot.origin, scale: log.shot.scale, len: log.shot.dataUrl.length }; }
      log.tree = await c.uiTree({ windowId: TG.id }); log.tree = { ok: log.tree.ok, source: log.tree.source, error: log.tree.error };
      P('run1'); log.run1 = await c.run([{ op: 'window_focus', id: TG.id }, { op: 'click', x: TG.geo.x + 60, y: TG.geo.y + 40 }, { op: 'type', text: 'electron typed é中文' }, { op: 'key', keys: 'Return' }]);
      log.run1 = { ok: log.run1.ok, completed: log.run1.completed, error: log.run1.error, stopped: log.run1.stopped };
      P('long'); log.longStart = Date.now(); log.long = await c.run(Array.from({ length: 20 }, () => ({ op: 'wait', ms: 500 }))); log.longMs = Date.now() - log.longStart;
      log.long = { ok: log.long.ok, completed: log.long.completed, stopped: log.long.stopped };
      log.afterAbort = await c.run([{ op: 'wait', ms: 1 }]); log.afterAbort = { ok: log.afterAbort.ok, error: log.afterAbort.error, refused: log.afterAbort.refused };
      log.resume = (await c.resume()).ok;
      P('secret'); log.sec1 = await c.setRemoteSecret('vnc one', 'pw-123'); log.secs = await c.listRemoteSecrets(); log.secLeak = JSON.stringify(log.secs).includes('pw-123');
      log.disable = await c.setEnabled(false); log.final = await c.status();
      log.afterEnable = { enabled: log.afterEnable.enabled, scope: log.afterEnable.scope.mode };
      return log;`);

    // ----- 啟動真的 Electron
    const env = Object.assign({}, x.env, { FA_DEBUG_EVAL_FILE: evalFile, ELECTRON_ENABLE_LOGGING: '1' });
    proc = spawn(ELECTRON, [app, '--no-sandbox', '--disable-gpu', '--force-renderer-accessibility', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = ''; proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });

    // ----- 扮演使用者：看到原生視窗就用 AT-SPI 按對應的按鈕
    const done = () => /\[eval-file\] (result|error)/.test(out); const clicked = []; const seen = new Set(); const dbg = (m) => { if (process.env.FA_E2E_DEBUG) console.log('[user] ' + m); };
    async function press(name, nameRe) { const f = await atspi.find({ rawRole: 'push button', limit: 80 }); const el = f.ok && f.elements.find((e) => nameRe.test(e.name || '')); dbg('找按鈕 ' + name + ' → ' + (el ? el.id : '沒有（共 ' + (f.ok ? f.elements.length : '?') + ' 個按鈕）')); if (!el) return false; const r = await atspi.act(el.id, 'invoke'); if (r.ok) clicked.push(name); return r.ok; }
    async function user() {
      const t0 = Date.now();
      while (!done() && Date.now() - t0 < 150000) {
        await sleep(450);
        const w = winList().find((q) => /AI 要求操作電腦/.test(q.title)); if (!w) continue;
        const key = w.id + w.title; if (seen.has(key)) continue; dbg('視窗 ' + w.title);
        await sleep(700); // 等頁面畫好、無障礙樹出現
        if (/選擇範圍/.test(w.title)) {
          const cb = await atspi.find({ rawRole: 'check box', limit: 30 }); const hit = cb.ok && cb.elements.find((e) => /FA-TARGET/.test(e.name || '') || /FA-TARGET/.test(e.description || ''));
          const all = cb.ok ? cb.elements.map((e) => e.name) : null; if (hit) { await atspi.act(hit.id, 'invoke'); clicked.push('勾選 FA-TARGET'); await sleep(300); } else clicked.push('找不到勾選框：' + JSON.stringify(all));
          if (await press('確定', /^確定$/)) seen.add(key);
        } else if (/啟用/.test(w.title)) { if (await press('啟用', /^啟用$/)) seen.add(key); }
        else if (/指定範圍/.test(w.title)) { if (await press('允許這些視窗', /允許這些視窗/)) seen.add(key); }
        else {
          const isLong = JSON.stringify(await atspi.find({ text: '等待 500', limit: 1 })).includes('等待'); // 先看預覽是不是那批「等待」的長批次
          if (await press('執行', /(執行這批動作|我確認，執行)$/)) { seen.add(key); if (isLong) { dbg('長批次已核准，2.2 秒後按全域中止鍵'); setTimeout(() => sh('xdotool', ['key', 'ctrl+alt+shift+Escape']), 2200); } }
        }
      }
    }
    const userP = user(); const t0 = Date.now(); while (!done() && Date.now() - t0 < 160000) await sleep(500);
    await userP.catch(() => {});
    const m = /\[eval-file\] result: (.*)/.exec(out); let log = null; try { log = m ? JSON.parse(m[1]) : null; } catch (_) { /* */ }
    t.check('eval 腳本在 150 秒內跑完並回傳結果', !!log, out.split('\n').filter((l) => /FA-STEP|eval-file/.test(l)).slice(-6).join('\n').slice(0, 800) + ' | clicked=' + clicked.join('|'));
    if (log) {
      const L = log; const j = (v) => JSON.stringify(v).slice(0, 300);
      t.check('預設關閉：renderer 透過 desktopAPI.computer 取得 status（platform linux、未啟用）', L.platform === 'linux' && L.preEnabled === false);
      t.check('關閉時 run 被拒絕（沒有彈任何視窗、沒有動作）', L.runWhileOff && L.runWhileOff.ok === false && /沒有啟用/.test(j(L.runWhileOff)), j(L.runWhileOff));
      t.check('啟用要在原生視窗按「啟用」（使用者）→ enabled', L.enable && L.enable.ok && L.afterEnable.enabled === true && clicked.includes('啟用'), j(L.enable) + ' ' + clicked.join('|'));
      t.check('啟用後、沒指定範圍：計畫被拒（no_scope）', L.noScope && L.noScope.ok === false && /範圍/.test(j(L.noScope)));
      t.check('助理自己的 Electron 視窗在清單裡被標成 self（pid 比對有效）', Array.isArray(L.selfWins) && L.selfWins.length >= 1, j(L.selfWins));
      t.check('把助理自己的視窗指定成範圍：（使用者確認後）仍被拒絕', L.scopeSelf === null ? true : L.scopeSelf.ok === false && /助理自己的視窗|拒絕清單/.test(j(L.scopeSelf)), j(L.scopeSelf));
      t.check('範圍選擇視窗：使用者勾選 FA-TARGET → 範圍只有它', L.pick && L.pick.ok && L.afterPick.windows.length === 1 && L.afterPick.windows[0].title === 'FA-TARGET', j(L.pick) + ' | ' + clicked.join('|'));
      t.check('範圍外的點擊（FA-OTHER）被拒絕', L.out && L.out.ok === false && /範圍/.test(j(L.out)), j(L.out));
      t.check('截圖：只能拍範圍內視窗；回傳 origin／scale', L.shot && L.shot.ok && L.shot.w <= 300 && L.shot.scale && L.shot.scale.x < 1, j(L.shot));
      t.check('ui_tree：xterm 沒有 AT-SPI 元件 → 退回 X11 視窗樹', L.tree && L.tree.ok && L.tree.source === 'x11', j(L.tree));
      const typedText = fs.existsSync(typed) ? fs.readFileSync(typed, 'utf8') : '';
      t.check('run：核准（使用者在原生視窗按「執行」）→ 真的聚焦、點擊、打字到 xterm（含中文）', L.run1 && L.run1.ok && typedText === 'electron typed é中文\n', j(L.run1) + ' typed=' + JSON.stringify(typedText) + ' clicked=' + clicked.join('|'));
      t.check('全域中止鍵（Ctrl+Alt+Shift+Esc）：長批次在中途停下來', L.long && L.long.ok === false && L.long.stopped && L.long.stopped.code === 'aborted' && L.long.completed >= 1 && L.long.completed < 20 && L.longMs < 9000, j(L.long) + ' ms=' + L.longMs);
      t.check('中止之後所有動作被拒，直到 resume', L.afterAbort && L.afterAbort.ok === false && /中止/.test(j(L.afterAbort)) && L.resume === true, j(L.afterAbort));
      t.check('機密：設定後 listRemoteSecrets 只回名稱、不含密碼', L.sec1 && L.sec1.ok && L.secs.names.includes('vnc_one') && L.secLeak === false);
      const secFile = path.join(ud, 'secrets.json'); t.check('機密只存在主行程的 userData/secrets.json（權限 600）', fs.existsSync(secFile) && JSON.parse(fs.readFileSync(secFile, 'utf8')).COMPUTER_REMOTE_SECRETS.vnc_one.password === 'pw-123' && (fs.statSync(secFile).mode & 0o077) === 0);
      t.check('停用：立即生效、清掉範圍', L.disable && L.disable.ok && L.final.enabled === false && L.final.scope.mode === 'none');
      const st = path.join(ud, 'desktop-settings.json'); t.check('設定檔記錄 computerUseEnabled（停用後 false）', fs.existsSync(st) && JSON.parse(fs.readFileSync(st, 'utf8')).computerUseEnabled === false);
    }
  } catch (e) { console.log('例外：' + ((e && e.stack) || e)); t.check('端到端測試沒有例外', false, String((e && e.message) || e)); }
  finally {
    try { if (proc && proc.pid) process.kill(-proc.pid, 'SIGTERM'); } catch (_) { /* */ }
    await sleep(800); try { if (proc && proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch (_) { /* */ }
    if (x) x.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
  }
  t.done();
})();
