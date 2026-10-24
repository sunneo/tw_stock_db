// node scripts/computer-tests/vnc.itest.js -- 真實整合測試：RFB 用戶端對真正的 VNC 伺服器（TigerVNC 的 Xvnc、x11vnc、websockify 轉接）。
// 全部用自己起的顯示與只聽 127.0.0.1 的埠；動作一律走 RFB 協定（沒有用 xdotool 去操作被測畫面，xdotool 只在「驗證」時讀資料）。
// 缺 Xvnc 時整組略過。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { suite } = require('./_t.js');
const { startXEnv, which, sleep, freePort } = require('./xenv.js');
const CU = require('../../computer-use.js');
const R = require('../../computer-remote.js');
const PNG = require('../../computer-png.js');
const { RfbClient, deriveObjects } = require('../../rfb-client.js');
const t = suite('vnc 整合測試');

const need = ['Xvnc', 'xterm', 'xfwm4'].filter((b) => !which(b));
if (need.length) { console.log('SKIP vnc 整合測試：缺少 ' + need.join('、')); console.log('vnc 整合測試: 0 passed, 0 failed (skipped)'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-vnc-'));
const xtermLoop = (file) => ['-e', 'sh', '-c', 'while IFS= read -r l; do printf "%s\\n" "$l" >> ' + file + '; done'];
const sh = (x, cmd, args, o) => spawnSync(cmd, args, Object.assign({ env: x.env, encoding: 'utf8' }, o || {}));

(async () => {
  const cleanups = [];
  try {
    // ================= A：Xvnc、無驗證 =================
    const A = await startXEnv({ xvnc: {}, size: '1024x768x24', atspi: false }); cleanups.push(() => A.stop());
    const typed = path.join(tmp, 'typed-A.txt');
    A.run('xterm', ['-T', 'VNC-XTERM', '-geometry', '50x8+50+60'].concat(xtermLoop(typed))); await sleep(1500);
    const LP = require('../../computer-use-linux-parse.js');
    const win = (() => { const n = LP.parseXwininfoTree(sh(A, 'xwininfo', ['-root', '-tree']).stdout).find((q) => q.name === 'VNC-XTERM'); return n ? { x: n.x, y: n.y, w: n.w, h: n.h } : null; })();
    await t.acheck('（準備）Xvnc 裡的 xterm 在', async () => !!win && A.rfbPort > 0, win);

    // --- 協定探測（真的伺服器）
    const pr = await R.probeRemote('127.0.0.1:' + A.rfbPort);
    await t.acheck('probe：真的 Xvnc → RFB 3.8、安全類型 None、內建用戶端可用、物件來源 protocol', async () => pr.ok && pr.kind === 'rfb' && pr.details.version === '003.008' && JSON.stringify(pr.details.securityTypes) === '[1]' && pr.details.supported && pr.capabilities.objects === 'protocol' && pr.capabilities.input === 'protocol', pr);

    // --- 門面：連線需要核准、進入範圍、只靠 RFB 操作
    const confirms = []; const cu = CU.create({ platform: 'linux', env: process.env /* 不會用到：只走 RFB */, enabled: true, selfPids: [process.pid], backend: { kind: 'none', capabilities: async () => ({ features: { a11y: { ok: false } } }), listWindows: async () => ({ ok: true, windows: [], activeId: null }), monitors: async () => ({ ok: false }), releaseAll: async () => ({ ok: true }) }, confirm: async (i) => { confirms.push(i); return { approved: true }; } });
    let c = await cu.remoteConnect({ host: '127.0.0.1', port: A.rfbPort, label: 'Xvnc-A' });
    await t.acheck('remote_connect：核准視窗顯示連線目標、forceAsk、連上後有 remoteTarget（kind rfb、objects protocol、input protocol）', async () => c.ok && c.target.kind === 'rfb' && c.target.capabilities.objects === 'protocol' && c.target.capabilities.input === 'protocol' && c.width === 1024 && c.height === 768 && confirms.length === 1 && confirms[0].forceAsk && /127\.0\.0\.1:\d+/.test(confirms[0].preview), c);
    const id = c.id, client = cu._sessions.get(id).client;
    await t.acheck('連線後自動加入範圍（rfb 範圍），列表可見', async () => cu.safety.rfbInScope(id) && cu.remoteList().sessions.length === 1);
    let shot = await cu.screenshot({ target: id, maxSide: 512 });
    await t.acheck('遠端截圖：PNG、縮放比 0.5、origin 0,0、跟 Xvnc 實際畫面一致（與 xwd 比較）', async () => {
      if (!shot.ok) return shot; const img = PNG.decodePng(Buffer.from(shot.dataUrl.split(',')[1], 'base64')); if (img.width !== 512 || Math.abs(shot.scale.x - 0.5) > 1e-9) return { ok: false, w: img.width, sc: shot.scale };
      await sleep(900); const full = client.getImage(); const ref = sh(A, 'xwd', ['-root', '-silent'], { encoding: 'buffer' }); const P = require('../../computer-use-linux-parse.js'); const truth = P.decodeXwd(ref.stdout);
      let diff = 0, n = 0; for (let i = 0; i < truth.data.length; i += 4 * 37) { const px = (i / 4) % 1024, py = Math.floor(i / 4 / 1024); if (Math.abs(px - 512) < 40 && Math.abs(py - 384) < 40) continue; /* 有些伺服器會把游標畫進畫面 */ n++; if (Math.abs(truth.data[i] - full.data[i]) + Math.abs(truth.data[i + 1] - full.data[i + 1]) + Math.abs(truth.data[i + 2] - full.data[i + 2]) > 30) diff++; }
      return { ok: diff / n < 0.02, diff, n };
    });
    // --- 點擊與打字：只經過 RFB
    const before = client.getImage(); const u0 = client.updateCount;
    let r = await cu.run([{ op: 'move', x: win.x + 40, y: win.y + 40, target: id }, { op: 'click', x: win.x + 40, y: win.y + 40, target: id }]);
    await t.acheck('RFB 點擊（協定層）：計畫通過、需要核准、執行 via rfb', async () => ({ ok: r.ok && r.steps.every((s) => s.via === 'rfb') && /［遠端 rfb:\d+］/.test(r.preview), r: JSON.stringify(r).slice(0, 500) }));
    const nconf = confirms.length;
    r = await cu.run([{ op: 'type', text: 'rfb typed é中文', target: id }, { op: 'key', keys: 'Return', target: id }]); await sleep(600);
    await t.acheck('RFB 打字（含 Latin-1 與中文 keysym）＋Return：xterm 真的收到（檔案內容）', async () => ({ ok: r.ok && /rfb typed é中文/.test(fs.existsSync(typed) ? fs.readFileSync(typed, 'utf8') : ''), file: fs.existsSync(typed) && fs.readFileSync(typed, 'utf8'), r: JSON.stringify(r).slice(0, 300) }));
    await t.acheck('RFB 打字一律要使用者核准（看不出焦點）：多了一次 forceAsk 的詢問', async () => confirms.length > nconf && confirms[confirms.length - 1].forceAsk === true);
    cu.setAuto(true); const nc2 = confirms.length; await cu.run([{ op: 'type', text: 'auto', target: id }, { op: 'key', keys: 'Return', target: id }]);
    await t.acheck('自動模式下 RFB 打字仍然要問', async () => confirms.length === nc2 + 1 && confirms[confirms.length - 1].forceAsk); const nc3 = confirms.length; await cu.run([{ op: 'move', x: 300, y: 300, target: id }]); await t.acheck('自動模式下 RFB 移動不用問', async () => confirms.length === nc3); cu.setAuto(false);
    // --- 損壞矩形 / 物件
    await sleep(400); const after = client.getImage(); const dfr = PNG.diff(before, after, {});
    await t.acheck('畫面真的變了（打字後框架緩衝與打字前不同），而且伺服器有送更新', async () => ({ ok: dfr.ratio > 0.0005 && client.updateCount > u0 && !!dfr.bbox && dfr.bbox.x >= win.x - 5 && dfr.bbox.y >= win.y - 5, ratio: dfr.ratio, bbox: dfr.bbox, win, u0, u1: client.updateCount }));
    const objs = await cu.remoteObjects(id, { sinceMs: 6000 });
    await t.acheck('remote_objects：從損壞矩形推出候選區，其中一塊與 xterm 文字區重疊；有游標物件；座標是遠端畫面像素', async () => { if (!objs.ok) return objs; const hit = objs.objects.find((o) => o.kind === 'damage' && o.rect.x < win.x + win.w && o.rect.x + o.rect.w > win.x && o.rect.y < win.y + win.h && o.rect.y + o.rect.h > win.y); return { ok: !!hit && objs.objects.some((o) => o.kind === 'cursor') && objs.objects.every((o) => o.source === 'rfb' && /^rfb:\d+:\d+$/.test(o.id)), n: objs.objects.length, objs: objs.objects.map((o) => o.kind + JSON.stringify(o.rect)), win }; });
    const tree = await cu.uiTree({ target: id }); await t.acheck('ui_tree 對 rfb 目標回傳同一份物件', async () => tree.ok && tree.source === 'rfb');
    // --- 游標形狀（Cursor 偽編碼）與探索
    r = await cu.run([{ op: 'hover_probe', x: win.x + 60, y: win.y + 50, target: id }, { op: 'hover_probe', x: 700, y: 600, target: id }]);
    await t.acheck('hover_probe（RFB）：xterm 上游標形狀和桌面上不同（Cursor 偽編碼）', async () => ({ ok: r.ok && r.steps[0].probe.cursor && r.steps[0].probe.interactive === true && r.steps[0].probe.cursor.hash !== (r.steps[1].probe.cursor && r.steps[1].probe.cursor.hash), r: JSON.stringify(r).slice(0, 900) }));
    // --- 剪貼簿
    client.clientCutText('cut-from-rfb'); await sleep(500); const xsel = which('xsel') ? sh(A, 'xsel', ['-b', '-o']).stdout : null;
    if (xsel !== null) await t.acheck('ClientCutText → X 剪貼簿（xsel 讀得到）', async () => /cut-from-rfb/.test(xsel) || /cut-from-rfb/.test(sh(A, 'xsel', ['-p', '-o']).stdout), xsel); else t.skip('ClientCutText', '沒有 xsel');
    // --- 範圍與安全
    r = await cu.plan([{ op: 'click', x: 10, y: 10, target: 'rfb:99' }]); await t.acheck('不存在／不在範圍的 rfb 目標拒絕', async () => !r.ok && r.refused[0].code === 'scope');
    r = await cu.plan([{ op: 'click', x: 5000, y: 10, target: id }]); await t.acheck('座標超出遠端畫面拒絕', async () => !r.ok && /超出遠端畫面/.test(r.refused[0].reason));
    r = await cu.plan([{ op: 'window_close', id: 'x', target: id }]); await t.acheck('rfb 目標不支援視窗動作', async () => !r.ok);
    // 密碼欄：RFB 看不到 → 打字一律問（已驗證），這裡再驗證「中止」會放開輸入
    r = await cu.abort('test'); await t.acheck('abort：RFB 放開輸入、之後的計畫被拒', async () => r.ok && !(await cu.plan([{ op: 'move', x: 1, y: 1, target: id }])).ok);
    cu.setEnabled(true); await t.acheck('停用會中斷遠端連線並清掉範圍（setEnabled(false)）', async () => { cu.setEnabled(false); return cu.remoteList().sessions.length === 0 && !cu.safety.rfbInScope(id); });
    A.stop();

    // ================= B：VNC 驗證（真的 DES 對 TigerVNC） =================
    if (which('vncpasswd')) {
      const B = await startXEnv({ xvnc: { password: 'sEcr3t!' }, size: '800x600x24', atspi: false, wm: 'none' }); cleanups.push(() => B.stop()); await sleep(500);
      const pb = await R.probeRemote('127.0.0.1:' + B.rfbPort);
      await t.acheck('probe：VNC 驗證（安全類型 2）、建議用 secretName', async () => pb.kind === 'rfb' && JSON.stringify(pb.details.securityTypes) === '[2]' && /secretName/.test(pb.advice.join('')));
      const secrets = { get: (n) => ({ good: 'sEcr3t!', bad: 'wrong-pass-123' }[n] || null) };
      const mk = () => CU.create({ platform: 'linux', enabled: true, backend: { kind: 'none', capabilities: async () => ({ features: { a11y: { ok: false } } }), listWindows: async () => ({ ok: true, windows: [] }), releaseAll: async () => ({ ok: true }) }, secrets, confirm: async () => ({ approved: true }) });
      let cb = mk(); let rb = await cb.remoteConnect({ host: '127.0.0.1', port: B.rfbPort, secretName: 'good' });
      await t.acheck('VNC 驗證成功（DES 對真的 TigerVNC）：連上、取得畫面尺寸 800x600、security=VNC 驗證', async () => rb.ok && rb.width === 800 && rb.height === 600 && rb.security === 'VNC 驗證', rb);
      cb.remoteDisconnect(rb.id || 'x');
      cb = mk(); rb = await cb.remoteConnect({ host: '127.0.0.1', port: B.rfbPort, secretName: 'bad' });
      await t.acheck('密碼錯誤：明確的失敗訊息，訊息裡沒有密碼', async () => !rb.ok && /驗證失敗/.test(rb.error) && !/wrong-pass-123|sEcr3t/.test(JSON.stringify(rb)), rb);
      cb = mk(); rb = await cb.remoteConnect({ host: '127.0.0.1', port: B.rfbPort });
      await t.acheck('沒給密碼：說明要用 secretName', async () => !rb.ok && /需要 VNC 密碼/.test(rb.error) && /secretName/.test(rb.error), rb);
      cb = mk(); rb = await cb.remoteConnect({ host: '127.0.0.1', port: B.rfbPort, secretName: 'nope' });
      await t.acheck('secretName 不存在 → 當作沒給密碼，一樣明確報錯', async () => !rb.ok && /需要 VNC 密碼/.test(rb.error));
      B.stop();
    } else t.skip('VNC 驗證', '沒有 vncpasswd');

    // ================= C：x11vnc 掛在 Xvfb 上（第二種伺服器實作；libvncserver） =================
    if (which('x11vnc') && which('Xvfb') && which('scrot')) {
      const C = await startXEnv({ size: '800x600x24', atspi: false }); cleanups.push(() => C.stop());
      const typedC = path.join(tmp, 'typed-C.txt'); C.run('xterm', ['-T', 'X11VNC-XTERM', '-geometry', '40x6+40+40'].concat(xtermLoop(typedC))); await sleep(1200);
      const port = await freePort(); C.run('x11vnc', ['-display', C.display, '-rfbport', String(port), '-localhost', '-nopw', '-forever', '-shared', '-quiet', '-noxdamage'], { stdio: 'ignore' });
      let ok = false; for (let i = 0; i < 40 && !ok; i++) { await sleep(250); const p = await R.probeRemote('127.0.0.1:' + port); ok = p.kind === 'rfb'; }
      const cl = new RfbClient({ host: '127.0.0.1', port }); let info = null; try { info = await cl.connect(); await cl.waitForFrame(5000); await sleep(500); } catch (e) { info = { error: e.message }; }
      await t.acheck('x11vnc：連線成功、尺寸 800x600', async () => info && info.width === 800 && info.height === 600, info);
      if (info && info.width) {
        const scrot = sh(C, 'scrot', ['-o', path.join(tmp, 'c.png')]); const truth = PNG.decodePng(fs.readFileSync(path.join(tmp, 'c.png'))); const fb = cl.getImage(); let bad = 0, n = 0; for (let i = 0; i < truth.data.length; i += 4 * 53) { n++; if (Math.abs(truth.data[i] - fb.data[i]) + Math.abs(truth.data[i + 1] - fb.data[i + 1]) + Math.abs(truth.data[i + 2] - fb.data[i + 2]) > 30) bad++; }
        await t.acheck('x11vnc：RFB 畫面與 scrot 的實際螢幕一致（取樣比對）', async () => ({ ok: bad / n < 0.02, bad, n, port, info }));
        const u = cl.updateCount; await cl.click(100, 90); await cl.typeText('via-x11vnc'); await cl.keyChord('Return'); await sleep(700);
        await t.acheck('x11vnc：RFB 打字送到 xterm，並收到損壞矩形更新', async () => ({ ok: /via-x11vnc/.test(fs.existsSync(typedC) ? fs.readFileSync(typedC, 'utf8') : '') && cl.updateCount > u, file: fs.existsSync(typedC) && fs.readFileSync(typedC, 'utf8'), u0: u, u1: cl.updateCount }));
        const encs = new Set(); for (const up of cl.updates) for (const rr of up.rects) encs.add(rr.enc); await t.acheck('x11vnc 實際用到的編碼（至少 Raw／Hextile／ZRLE 之一）', async () => [0, 5, 16, 2, 1].some((e) => encs.has(e)), Array.from(encs));
        // 滾動產生 CopyRect：在 xterm 裡印很多行
        const cu0 = cl.updates.length; for (let i = 0; i < 12; i++) { await cl.typeText('line ' + i); await cl.keyChord('Return'); } await sleep(600);
        const o2 = deriveObjects(cl.updates.slice(cu0), { sessionId: 'rfb:c' }); await t.acheck('連續輸入後的候選物件有 xterm 區域', async () => o2.length >= 1 && o2.some((o) => o.rect.x < 450 && o.rect.y < 300));
        cl.close();
      }
      // websockify（noVNC 的轉接）：同一個 x11vnc 後面接 WebSocket
      if (which('websockify') && info && info.width) {
        const wsPort = await freePort(); const ws = spawn('websockify', ['127.0.0.1:' + wsPort, '127.0.0.1:' + port], { stdio: 'ignore' }); cleanups.push(() => { try { ws.kill(); } catch (_) { /* */ } });
        let wp = null; for (let i = 0; i < 40; i++) { await sleep(250); wp = await R.probeRemote('ws://127.0.0.1:' + wsPort + '/'); if (wp.ok && wp.kind === 'rfb') break; }
        await t.acheck('probe ws://（真的 websockify）：RFB over WebSocket', async () => wp && wp.kind === 'rfb' && wp.details.transport === 'websocket' && wp.capabilities.objects === 'protocol', wp);
        const cw = new RfbClient({ wsUrl: 'ws://127.0.0.1:' + wsPort + '/' }); let iw = null; try { iw = await cw.connect(); await cw.waitForFrame(5000); await sleep(300); } catch (e) { iw = { error: e.message }; }
        await t.acheck('RFB over WebSocket（websockify→x11vnc）：連線、取得畫面、尺寸一致', async () => ({ ok: !!iw && iw.width === 800 && cw.getImage().data.some((v) => v !== 0), iw, wp: wp && wp.kind }));
        cw.close();
      } else t.skip('websockify', '沒有 websockify');
      C.stop();
    } else t.skip('x11vnc', '缺 x11vnc／Xvfb／scrot');

    // ================= D：不認得的埠／協定（真實網路行為） =================
    const closed = await R.probeRemote('127.0.0.1:' + (await freePort())); await t.acheck('probe 沒人監聽的埠 → closed 並給建議', async () => !closed.ok && closed.kind === 'closed');
  } catch (e) { console.log('例外：' + ((e && e.stack) || e)); t.check('整合測試沒有例外', false, String((e && e.message) || e)); }
  finally { for (const c of cleanups.reverse()) { try { c(); } catch (_) { /* */ } } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ } }
  t.done();
})();
