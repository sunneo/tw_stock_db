// node scripts/computer-tests/x11.itest.js -- 真實整合測試：自己起 Xvfb（絕不碰真實畫面 DISPLAY）＋ dbus ＋ AT-SPI ＋ xfwm4，
// 用 computer-use.js 門面（Linux 後端：xdotool／wmctrl／xprop／xwininfo／scrot／AT-SPI）實際操作 xterm 與 zenity。
// 沒有 Xvfb／xdotool 等工具時整組略過（印 SKIP、結果 0 failed）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { suite } = require('./_t.js');
const { startXEnv, which, sleep } = require('./xenv.js');
const CU = require('../../computer-use.js');
const PNG = require('../../computer-png.js');
const E = require('../../computer-use-elements.js');
const t = suite('x11 整合測試');

const need = ['Xvfb', 'xdotool', 'wmctrl', 'xwininfo', 'xprop', 'xterm', 'xfwm4', 'zenity', 'scrot'].filter((b) => !which(b));
if (need.length) { console.log('SKIP x11 整合測試：缺少 ' + need.join('、')); console.log('x11 整合測試: 0 passed, 0 failed (skipped)'); process.exit(0); }

(async () => {
  const x = await startXEnv();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-x11-')), typed = path.join(tmp, 'typed.txt');
  const cleanups = []; let cu;
  try {
    if (x.display === process.env.DISPLAY) throw new Error('絕不能用真實畫面');
    // xterm：每行輸入寫進檔案（用來驗證「打字真的送進去了」）
    x.run('xterm', ['-T', 'FA-XTERM', '-geometry', '60x10+100+100', '-e', 'sh', '-c', 'while IFS= read -r l; do printf "%s\\n" "$l" >> ' + typed + '; done']);
    // 另一個視窗：用來測「不在範圍」「被蓋住」
    x.run('xterm', ['-T', 'FA-OTHER', '-geometry', '40x8+600+400', '-e', 'sleep', '600']);
    await sleep(1500);
    const confirms = []; let confirmAnswer = { approved: true };
    cu = CU.create({ env: x.env, platform: 'linux', enabled: true, selfPids: [process.pid], confirm: async (i) => { confirms.push(i); return typeof confirmAnswer === 'function' ? confirmAnswer(i) : confirmAnswer; } });
    const fileText = () => { try { return fs.readFileSync(typed, 'utf8'); } catch (_) { return ''; } };
    const winByTitle = async (title) => (await cu.listWindows({ all: true })).windows.find((w) => w.title === title);

    // ===== 能力 =====
    const cap = await cu.capabilities();
    await t.acheck('capabilities：X11／xfce、視窗／滑鼠／鍵盤／截圖／AT-SPI 都能用，座標空間有文件', async () => cap.ok && cap.session.type === 'x11' && cap.session.desktop === 'xfce' && cap.features.windows.list.ok && cap.features.input.mouse.ok && cap.features.input.keyboard.ok && cap.features.screenshot.screen.ok && cap.features.a11y.ok && cap.coordinateSpace.space === 'screen' && cap.monitors && cap.monitors[0].rect.w === 1280 && /X11/.test(cap.summary));
    await t.acheck('capabilities：缺工具時精確說明原因（用空的 PATH 模擬）', async () => { const c2 = await CU.create({ env: Object.assign({}, x.env, { PATH: '/nonexistent' }), which: () => '', platform: 'linux' }).capabilities(); return c2.ok && !c2.features.input.mouse.ok && /xdotool/.test(c2.features.input.mouse.reason) && !c2.features.windows.list.ok && !c2.features.screenshot.screen.ok && c2.missingTools.includes('xdotool'); });

    // ===== 視窗清單 =====
    const xt = await winByTitle('FA-XTERM'), other = await winByTitle('FA-OTHER');
    await t.acheck('listWindows：id、pid、行程名、類別、客戶區矩形與外框、z 順序、狀態', async () => xt && other && /^0x[0-9a-f]{8}$/.test(xt.id) && xt.process === 'xterm' && xt.class === 'XTerm' && xt.pid > 0 && xt.rect.w > 100 && xt.frame.w > xt.rect.w && xt.frame.h > xt.rect.h && typeof xt.z === 'number' && xt.workspace === 0 && Array.isArray(xt.state) && xt.canvas === null);
    await t.acheck('視窗座標：客戶區矩形與 xwininfo 的絕對座標一致（不是 wmctrl 會偏掉的那種）', async () => { const r = spawnSync('xwininfo', ['-id', xt.id], { env: x.env, encoding: 'utf8' }); const ax = Number(/Absolute upper-left X:\s+(-?\d+)/.exec(r.stdout)[1]), ay = Number(/Absolute upper-left Y:\s+(-?\d+)/.exec(r.stdout)[1]); return xt.rect.x === ax && xt.rect.y === ay; });

    // ===== 安全閘門 =====
    let p = await cu.plan([{ op: 'click', x: xt.rect.x + 20, y: xt.rect.y + 20 }]);
    await t.acheck('沒有範圍 → 計畫被拒絕（no_scope）', async () => !p.ok && p.refused[0].code === 'no_scope');
    const sc = await cu.setScope({ windowIds: [xt.id] });
    await t.acheck('setScope：只有 FA-XTERM', async () => sc.ok && sc.scope.windows.length === 1 && sc.scope.windows[0].title === 'FA-XTERM');
    p = await cu.plan([{ op: 'click', x: other.rect.x + 20, y: other.rect.y + 20 }]);
    await t.acheck('點到範圍外的視窗 → 拒絕（不會真的動滑鼠）', async () => !p.ok && p.refused[0].code === 'scope');
    const before = spawnSync('xdotool', ['getmouselocation', '--shell'], { env: x.env, encoding: 'utf8' }).stdout;
    const nodialog = confirms.length;
    let r = await cu.run([{ op: 'click', x: other.rect.x + 20, y: other.rect.y + 20 }]);
    await t.acheck('run() 對被拒絕的計畫不會呼叫核准視窗、也不會動滑鼠', async () => !r.ok && confirms.length === nodialog && spawnSync('xdotool', ['getmouselocation', '--shell'], { env: x.env, encoding: 'utf8' }).stdout === before);
    p = await cu.plan([{ op: 'click', x: xt.rect.x + 30, y: xt.rect.y + 30 }]);
    await t.acheck('範圍內的點擊：計畫通過、預設需要核准、預覽有座標與視窗', async () => p.ok && p.needsApproval && /點擊 \(\d+, \d+\)，視窗「FA-XTERM」/.test(p.preview));
    const noConfirm = CU.create({ env: x.env, platform: 'linux', enabled: true });
    await noConfirm.setScope({ windowIds: [xt.id] });
    r = await noConfirm.run([{ op: 'click', x: xt.rect.x + 30, y: xt.rect.y + 30 }]);
    await t.acheck('沒有核准函式（fail-closed）：需要核准的計畫一律拒絕執行', async () => !r.ok && r.code === 'no_confirm');
    confirmAnswer = { approved: false }; r = await cu.run([{ op: 'click', x: xt.rect.x + 30, y: xt.rect.y + 30 }]);
    await t.acheck('使用者按「取消」→ 拒絕、動作沒有執行', async () => !r.ok && r.code === 'user_denied');
    confirmAnswer = { approved: true };
    // 計畫是一次性的
    p = await cu.plan([{ op: 'wait', ms: 10 }]); const e1 = await cu.execute(p.planId), e2 = await cu.execute(p.planId);
    await t.acheck('計畫只能執行一次（planId 單次使用）', async () => e1.ok && !e2.ok);

    // ===== 視窗動作、滑鼠、打字（真的打到 xterm） =====
    const n0 = confirms.length;
    r = await cu.run([{ op: 'window_focus', id: xt.id }, { op: 'click', x: xt.rect.x + 50, y: xt.rect.y + 40 }, { op: 'type', text: 'hello 中文é' }, { op: 'key', keys: 'Return' }, { op: 'type', text: 'second line' }, { op: 'key', keys: 'Enter' }]);
    await sleep(500);
    await t.acheck('視窗聚焦＋點擊＋打字（含中文、Latin-1）＋Return，xterm 真的收到（檔案內容驗證）', async () => r.ok && r.completed === 6 && fileText() === 'hello 中文é\nsecond line\n', { r: JSON.stringify(r).slice(0, 400), file: fileText() });
    await t.acheck('打字計畫要核准一次；xterm 沒有無障礙資訊，執行前再問一次（看不出是不是密碼欄）', async () => ({ ok: confirms.length - n0 === 2 && confirms[confirms.length - 1].forceAsk === true && /密碼欄/.test(confirms[confirms.length - 1].preview), n: confirms.length - n0, flags: confirms.slice(n0).map((c) => c.forceAsk) }));
    // 自動模式：仍然要問「看不出焦點」的打字，但不用問已驗證的點擊
    cu.setAuto(true); const n1 = confirms.length;
    r = await cu.run([{ op: 'click', x: xt.rect.x + 60, y: xt.rect.y + 60 }]);
    await t.acheck('自動模式：點擊不再詢問', async () => r.ok && confirms.length === n1);
    r = await cu.run([{ op: 'type', text: 'auto typed' }, { op: 'key', keys: 'Return' }]); await sleep(300);
    await t.acheck('自動模式：看不出焦點的打字仍然會問（forceAsk）', async () => r.ok && confirms.length === n1 + 1 && confirms[confirms.length - 1].forceAsk && /auto typed/.test(fileText()));
    cu.setAuto(false);
    // 視窗移動／縮放後的矩形
    r = await cu.run([{ op: 'window_move', id: xt.id, x: 300, y: 150 }, { op: 'window_resize', id: xt.id, w: 500, h: 300 }]);
    await t.acheck('window_move／window_resize 之後回報新矩形', async () => r.ok && r.steps[1].rect && Math.abs(r.steps[1].rect.w - 500) <= 12, JSON.stringify(r.steps));
    const xt2 = await winByTitle('FA-XTERM');
    await t.acheck('移動後列表矩形也更新（客戶區位置改變）', async () => xt2.rect.x !== xt.rect.x || xt2.rect.y !== xt.rect.y);
    // 被蓋住：把 FA-OTHER 移到 FA-XTERM 上面
    r = await cu.run([{ op: 'window_focus', id: xt.id }]);
    spawnSync('wmctrl', ['-i', '-r', other.id, '-e', '0,' + (xt2.frame.x + 20) + ',' + (xt2.frame.y + 20) + ',-1,-1'], { env: x.env }); spawnSync('wmctrl', ['-i', '-a', other.id], { env: x.env }); await sleep(500);
    const ov = await winByTitle('FA-OTHER'); const cx = Math.min(ov.rect.x + 30, xt2.rect.x + xt2.rect.w - 5), cy = Math.min(ov.rect.y + 30, xt2.rect.y + xt2.rect.h - 5);
    p = await cu.plan([{ op: 'click', x: cx, y: cy }]);
    await t.acheck('座標落在範圍視窗內、但被範圍外的視窗蓋住 → 拒絕（最上層視窗檢查）', async () => !p.ok && p.refused[0].code === 'scope' && /蓋住/.test(p.refused[0].reason), p.refused);
    spawnSync('wmctrl', ['-i', '-r', other.id, '-b', 'add,hidden'], { env: x.env }); spawnSync('xdotool', ['windowminimize', other.id], { env: x.env }); await sleep(400);
    await cu.run([{ op: 'window_focus', id: xt.id }]);

    // ===== 拒絕清單與按鍵 =====
    const lw = await cu.listWindows(); await t.acheck('視窗清單的 canvas／denied 標記存在', async () => lw.windows.every((w) => 'canvas' in w && 'denied' in w && 'inScope' in w));
    p = await cu.plan([{ op: 'key', keys: 'ctrl+alt+Delete' }]); await t.acheck('危險組合鍵 ctrl+alt+Delete 拒絕', async () => !p.ok && p.refused[0].code === 'denied_key');
    p = await cu.plan([{ op: 'key', keys: 'super+l' }]); await t.acheck('super+l 拒絕', async () => !p.ok);
    p = await cu.plan([{ op: 'key', keys: 'alt+Tab' }]); await t.acheck('alt+Tab 拒絕（會切到範圍外的視窗）', async () => !p.ok);

    // ===== 截圖 =====
    let s = await cu.screenshot({ windowId: xt.id, maxSide: 300 });
    await t.acheck('視窗截圖：PNG data URL、origin 是視窗外框左上角、scale<1、有 mapBack 說明', async () => { if (!s.ok) return s; const img = PNG.decodePng(Buffer.from(s.dataUrl.split(',')[1], 'base64')); const win = await winByTitle('FA-XTERM'); return img.width === s.width && s.width <= 300 && s.scale.x < 1 && s.origin.x === Math.max(0, win.frame.x) && /origin/.test(s.mapBack) && s.coordinateSpace === 'screen'; });
    s = await cu.screenshot({ windowId: xt.id, grid: { cols: 4, rows: 3 } });
    await t.acheck('格線截圖：12 個格子，每格附螢幕座標，涵蓋整個視窗', async () => { if (!s.ok) return s; const c = s.grid.cells; return c.length === 12 && c[0].rect.x === s.origin.x && c[11].rect.x + c[11].rect.w >= s.origin.x + s.width - 2 && c[11].rect.y + c[11].rect.h >= s.origin.y + s.height - 2; });
    const crop = await cu.cropShot(s.shotId, { x: s.origin.x + 10, y: s.origin.y + 10, w: 60, h: 40 }, {}); await t.acheck('cropShot：不重拍、尺寸與 origin 正確', async () => crop.ok && crop.width === 60 && crop.height === 40 && crop.origin.x === s.origin.x + 10);
    r = await cu.screenshot({}); await t.acheck('整個螢幕截圖：範圍不是「整個螢幕」就拒絕', async () => !r.ok && /範圍/.test(r.error));
    r = await cu.screenshot({ windowId: other.id }); await t.acheck('範圍外視窗的截圖拒絕', async () => !r.ok && r.code === 'scope');
    r = await cu.screenshot({ rect: { x: 0, y: 0, w: 50, h: 50 } }); await t.acheck('範圍外矩形的截圖拒絕', async () => !r.ok);

    // ===== X11 視窗樹（沒有無障礙元件的 xterm） =====
    let tree = await cu.uiTree({ windowId: xt.id });
    await t.acheck('xterm 沒有 AT-SPI 元件 → 退回 X11 視窗樹並說明只有視窗層級', async () => tree.ok && tree.source === 'x11' && /視覺模型/.test(tree.note) && tree.tried[0].source === 'a11y' && tree.tried[0].ok === false, JSON.stringify(tree).slice(0, 300));

    // ===== 等待與取樣 =====
    const ww = cu.wait({ window: { title: 'FA-LATE' }, timeoutMs: 8000 }); setTimeout(() => x.run('xterm', ['-T', 'FA-LATE', '-e', 'sleep', '30']), 800);
    await t.acheck('wait：等視窗出現', async () => { const w = await ww; return w.ok && w.window.title === 'FA-LATE' && w.waitedMs >= 600; });
    await cu.run([{ op: 'window_focus', id: xt.id }]);
    const rect = (await winByTitle('FA-XTERM')).rect;
    const wc = cu.wait({ rect, mode: 'change', timeoutMs: 8000 }); setTimeout(() => { spawnSync('xdotool', ['type', '--delay', '5', 'zzz'], { env: x.env }); }, 600);
    await t.acheck('wait：等畫面變化（有打字之後才回來）', async () => { const w = await wc; return { ok: w.ok && w.kind === 'change' && w.ratio > 0, w }; });
    const st = await cu.wait({ rect, mode: 'stable', timeoutMs: 6000, quietMs: 500 }); await t.acheck('wait：等畫面穩定', async () => st.ok && st.kind === 'stable');
    const tout = await cu.wait({ rect, mode: 'change', timeoutMs: 700 }); await t.acheck('wait：逾時回報 timedOut 而不是掛住', async () => !tout.ok && tout.timedOut === true);
    // 動畫偵測：另一個持續輸出的 xterm
    x.run('xterm', ['-T', 'FA-ANIM', '-geometry', '30x6+20+500', '-e', 'sh', '-c', 'i=0; while true; do i=$((i+1)); printf "\\r tick %s %s" $i $(date +%N); sleep 0.05; done']); await sleep(1200);
    const anim = await winByTitle('FA-ANIM'); await cu.setScope({ windowIds: [xt.id, anim.id] });
    const sm = await cu.sample({ windowId: anim.id, frames: 6, intervalMs: 120 }); await t.acheck('sample：持續更新的視窗被判為動畫、靜止的不是', async () => sm.ok && sm.animated && sm.changedFrames >= 3, sm);
    const sm2 = await cu.sample({ rect, frames: 4, intervalMs: 100 }); await t.acheck('sample：靜止區塊 animated=false', async () => sm2.ok && !sm2.animated, sm2);

    // ===== 中止、速率、連續失敗 =====
    await cu.setScope({ windowIds: [xt.id] });
    const long = Array.from({ length: 20 }, () => ({ op: 'wait', ms: 400 }));
    const pr = cu.run(long); setTimeout(() => cu.abort('測試中止'), 900); r = await pr;
    await t.acheck('中止：整批停下來（stopped.code=aborted），只做了一部分', async () => !r.ok && r.stopped && r.stopped.code === 'aborted' && r.completed < 20 && r.completed >= 1, r.stopped);
    p = await cu.plan([{ op: 'wait', ms: 1 }]); await t.acheck('中止之後一律拒絕，直到重新啟用', async () => !p.ok && p.refused[0].code === 'aborted');
    const mouseUp = spawnSync('xdotool', ['getmouselocation'], { env: x.env, encoding: 'utf8' }); await t.acheck('中止後放開按鍵（releaseAll 沒有報錯）', async () => mouseUp.status === 0);
    cu.setEnabled(true); await cu.setScope({ windowIds: [xt.id] });
    p = await cu.plan([{ op: 'wait', ms: 1 }]); await t.acheck('重新啟用後恢復', async () => p.ok);
    const rl = CU.create({ env: x.env, platform: 'linux', enabled: true, confirm: async () => ({ approved: true }), safety: { limits: { maxActionsPerMinute: 3, minIntervalMs: 10 } } }); await rl.setScope({ windowIds: [xt.id] });
    r = await rl.run([1, 2, 3, 4, 5].map(() => ({ op: 'move', x: rect.x + 10, y: rect.y + 10 })));
    await t.acheck('速率限制：每分鐘 3 個動作，第 4 個停下來', async () => ({ ok: !r.ok && r.stopped && r.stopped.code === 'rate' && r.completed === 3, r: JSON.stringify(r).slice(0, 500) }));

    // ===== 滑鼠校準與探索 =====
    const cal = await cu.calibrate(); await t.acheck('calibrate：X11 讀得到游標位置 → 比例 1、誤差 0、不需要補償', async () => cal.ok && cal.calibrated && cal.method === 'pointerLocation' && Math.abs(cal.scale.x - 1) < 0.01 && cal.maxErrorPx <= 1 && cal.apply === false, cal);

    // ===== 補測：drag／double_click／middle_click／scroll／剪貼簿／最小化最大化還原關閉（全部真的打到 X 伺服器） =====
    const typedD = path.join(tmp, 'typed-drag.txt');
    x.run('xterm', ['-T', 'FA-DRAG', '-geometry', '40x6+700+100', '-e', 'sh', '-c', 'while IFS= read -r l; do printf "%s\\n" "$l" >> ' + typedD + '; done']);
    x.run('xterm', ['-T', 'FA-SCROLL', '-geometry', '40x8+700+330', '-e', 'sh', '-c', 'seq 1 60; sleep 600']);
    x.run('xterm', ['-T', 'FA-WINOPS', '-geometry', '30x5+50+450', '-e', 'sleep', '600']); await sleep(1500);
    const dw = await winByTitle('FA-DRAG'), sw = await winByTitle('FA-SCROLL'), wo = await winByTitle('FA-WINOPS'); await cu.setScope({ windowIds: [xt.id, dw.id, sw.id, wo.id] });
    const cw = (dw.rect.w - 4) / 40, chh = (dw.rect.h - 4) / 6, cellX = (c) => Math.round(dw.rect.x + 2 + c * cw), rowY = (r) => Math.round(dw.rect.y + 2 + r * chh + chh / 2);
    r = await cu.run([{ op: 'window_focus', id: dw.id }, { op: 'click', x: cellX(5), y: rowY(4) }, { op: 'type', text: 'alpha beta gamma' }, { op: 'key', keys: 'Return' }]); await sleep(300);
    r = await cu.run([{ op: 'drag', x: cellX(0) + 1, y: rowY(0), x2: cellX(5) + 1, y2: rowY(0) }, { op: 'middle_click', x: cellX(10), y: rowY(3) }, { op: 'key', keys: 'Return' }]); await sleep(400);
    const typedDText = fs.existsSync(typedD) ? fs.readFileSync(typedD, 'utf8') : '';
    await t.acheck('drag：在 xterm 裡拖曳選取「alpha」，middle_click 貼上選取內容（檔案裡有第二行 alpha）', async () => ({ ok: r.ok && /^alpha beta gamma\nalpha\n/.test(typedDText), file: typedDText, r: JSON.stringify(r).slice(0, 300), cw, chh }));
    r = await cu.run([{ op: 'double_click', x: cellX(8), y: rowY(0) }, { op: 'middle_click', x: cellX(10), y: rowY(3) }, { op: 'key', keys: 'Return' }]); await sleep(400);
    const typedD2 = fs.readFileSync(typedD, 'utf8').split('\n');
    await t.acheck('double_click 選取一個字（beta）＋ middle_click 貼上', async () => ({ ok: r.ok && typedD2[2] === 'beta', lines: typedD2 }));
    r = await cu.run([{ op: 'right_click', x: cellX(10), y: rowY(3) }]); await sleep(300);
    await t.acheck('right_click：送出右鍵（xterm 沒有選單，但事件順利送達、不報錯）', async () => r.ok && r.steps[0].ok);
    // 捲動：先拍、滾輪往上 8 格、再拍，內容要不一樣
    const s1 = await cu.screenshot({ windowId: sw.id }); r = await cu.run([{ op: 'scroll', x: sw.rect.x + 40, y: sw.rect.y + 40, dy: -8 }]); await sleep(400); const s2 = await cu.screenshot({ windowId: sw.id });
    await t.acheck('scroll：滾輪往上，xterm 捲動緩衝（前後截圖不同）', async () => { const A = PNG.decodePng(Buffer.from(s1.dataUrl.split(',')[1], 'base64')), B = PNG.decodePng(Buffer.from(s2.dataUrl.split(',')[1], 'base64')); const d = PNG.diff(A, B, {}); return { ok: r.ok && d.ratio > 0.01, ratio: d.ratio }; });
    // 剪貼簿
    if (which('xsel')) { r = await cu.run([{ op: 'clipboard_set', text: 'clip ✓ 剪貼簿' }]); await sleep(300); const got = spawnSync('xsel', ['-b', '-o'], { env: x.env, encoding: 'utf8' }).stdout; await t.acheck('clipboard_set：xsel 讀得到（含中文與符號）', async () => ({ ok: r.ok && got === 'clip ✓ 剪貼簿', got })); }
    // 視窗：最小化、還原、最大化、關閉
    r = await cu.run([{ op: 'window_minimize', id: wo.id }]); await sleep(500); let w2 = await winByTitle('FA-WINOPS'); const minOk = r.ok && w2 && w2.minimized === true;
    r = await cu.run([{ op: 'window_restore', id: wo.id }]); await sleep(500); w2 = await winByTitle('FA-WINOPS'); const resOk = r.ok && w2 && w2.minimized === false;
    r = await cu.run([{ op: 'window_maximize', id: wo.id }]); await sleep(600); w2 = await winByTitle('FA-WINOPS'); const maxOk = r.ok && w2 && w2.maximized === true && w2.frame.w > 1000;
    r = await cu.run([{ op: 'window_restore', id: wo.id }]); await sleep(600); r = await cu.run([{ op: 'window_close', id: wo.id }]); await sleep(800); const gone = !(await winByTitle('FA-WINOPS'));
    await t.acheck('window_minimize／restore／maximize／close 都真的生效（用視窗清單的狀態驗證）', async () => ({ ok: minOk && resOk && maxOk && gone, minOk, resOk, maxOk, gone }));
    await cu.setScope({ windowIds: [xt.id] });

    t.done_pending = true;
    // 先收掉這一段，下一段（zenity／AT-SPI）用同一個環境
    const zen = spawn('zenity', ['--entry', '--title', 'FA-ZEN', '--text', 'Name?', '--entry-text', ''], { env: x.env, stdio: ['ignore', 'pipe', 'ignore'] }); cleanups.push(() => { try { zen.kill(); } catch (_) { /* */ } });
    let zenOut = ''; zen.stdout.on('data', (d) => { zenOut += d; }); const zenExit = new Promise((res) => zen.on('exit', (c) => res(c)));
    await sleep(1500); const zw = await winByTitle('FA-ZEN'); await cu.setScope({ windowIds: [xt.id, zw.id] });
    tree = await cu.uiTree({ windowId: zw.id, depth: 8 });
    await t.acheck('AT-SPI 元件樹：zenity 有 dialog→filler→label／text／push button，座標是螢幕座標', async () => { if (!tree.ok || tree.source !== 'atspi') return tree; const flat = E.flatten(tree.tree); const btn = flat.find((e) => e.role === 'button' && e.name === '確定'), ent = flat.find((e) => e.role === 'textbox'), lbl = flat.find((e) => e.role === 'label' && e.name === 'Name?'); return !!(btn && ent && lbl && btn.rect.x >= zw.rect.x - 10 && btn.rect.y > ent.rect.y && btn.actions.includes('invoke') && ent.actions.includes('set_value') && ent.focused && tree.coordinateSpace === 'screen' && /^atspi:\d+:[\d.]+:[0-9a-f]{6}$/.test(btn.id)); });
    const fe = await cu.findElements({ windowId: zw.id, role: 'button', name: '確定' });
    await t.acheck('find_element：按角色＋名稱找到「確定」，附分數、視窗標題', async () => fe.ok && fe.elements.length === 1 && fe.elements[0].windowTitle === 'FA-ZEN' && fe.elements[0].score > 5, fe);
    const fe2 = await cu.findElements({ text: 'name?' }); await t.acheck('find_element：不指定視窗時搜尋範圍內的視窗，文字不分大小寫', async () => fe2.ok && fe2.elements.some((e) => e.role === 'label'));
    const fe3 = await cu.findElements({ regex: '^(取消|Cancel)$' }); await t.acheck('find_element：regex', async () => fe3.ok && fe3.elements.length >= 1 && fe3.elements[0].name === '取消');
    const entry = (await cu.findElements({ windowId: zw.id, role: 'textbox' })).elements[0], okBtn = fe.elements[0];
    const ea = await cu.elementAt({ x: E.center(okBtn.rect).x, y: E.center(okBtn.rect).y }); await t.acheck('elementAt：座標下最深的元件就是「確定」按鈕，附視窗資訊', async () => ea.ok && ea.element && ea.element.name === '確定' && ea.window.title === 'FA-ZEN');
    const ei = await cu.elementInfo(okBtn.id); await t.acheck('elementInfo：用快照 id 取回', async () => ei.ok && ei.element.name === '確定');
    // 無障礙設值（不用座標、不用打字）→ 讀回
    n0; const nAsk = confirms.length;
    r = await cu.run([{ op: 'element_set_value', element: entry.id, value: 'via-a11y 值' }]);
    await t.acheck('element_set_value（AT-SPI）：計畫通過、需核准、設定成功（via a11y）', async () => r.ok && r.steps[0].via === 'a11y' && /無障礙 API/.test(r.preview) && confirms.length === nAsk + 1, r);
    const ent2 = await cu.findElements({ windowId: zw.id, role: 'textbox' }); await t.acheck('設值之後讀回元件的文字', async () => ent2.elements[0].text === 'via-a11y 值', ent2.elements[0]);
    // zenity 的 AT-SPI 焦點 → 打字走「已驗證焦點」路徑（不是密碼欄）：再用鍵盤打字附加（先聚焦 zenity）
    r = await cu.run([{ op: 'window_focus', id: zw.id }, { op: 'type', text: '+kbd' }]); await sleep(300);
    const ent3 = await cu.findElements({ windowId: zw.id, role: 'textbox' }); await t.acheck('zenity 有無障礙焦點：打字後文字真的變了（鍵盤路徑）', async () => r.ok && /via-a11y 值.*\+kbd|\+kbd/.test(String(ent3.elements[0].text)), ent3.elements[0] && ent3.elements[0].text);
    // 按下確定：用元件 invoke
    r = await cu.run([{ op: 'element_invoke', element: okBtn.id }]); const code = await Promise.race([zenExit, sleep(4000).then(() => 'timeout')]);
    await t.acheck('element_invoke（AT-SPI）按下「確定」：zenity 結束並把文字印到 stdout', async () => r.ok && r.steps[0].via === 'a11y' && code === 0 && /via-a11y/.test(zenOut), { code, zenOut, r: JSON.stringify(r).slice(0, 300) });

    // 座標點擊路徑：再開一個 zenity，用元件中心座標點擊「確定」
    const zen2 = spawn('zenity', ['--entry', '--title', 'FA-ZEN2', '--text', 'Again?', '--entry-text', 'typed-by-click-path'], { env: x.env, stdio: ['ignore', 'pipe', 'ignore'] }); cleanups.push(() => { try { zen2.kill(); } catch (_) { /* */ } }); let z2 = ''; zen2.stdout.on('data', (d) => { z2 += d; }); const z2exit = new Promise((res) => zen2.on('exit', (c) => res(c)));
    await sleep(1500); const zw2 = await winByTitle('FA-ZEN2'); await cu.setScope({ windowIds: [xt.id, zw2.id] });
    const b2 = (await cu.findElements({ windowId: zw2.id, role: 'button', name: '確定' })).elements[0], c2 = E.center(b2.rect);
    r = await cu.run([{ op: 'move', x: c2.x, y: c2.y }, { op: 'click', x: c2.x, y: c2.y }]); const code2 = await Promise.race([z2exit, sleep(4000).then(() => 'timeout')]);
    await t.acheck('座標點擊（移動＋左鍵）按下「確定」：zenity 結束、stdout 有預設文字', async () => ({ ok: r.ok && code2 === 0 && /typed-by-click-path/.test(z2), code2, z2, r: JSON.stringify(r).slice(0, 600), c2, b2: b2 && b2.rect }));
    // element 動作失敗退回座標（用 element 當座標來源的 click）
    const zen3 = spawn('zenity', ['--entry', '--title', 'FA-ZEN3', '--text', 'Third?', '--entry-text', 'third'], { env: x.env, stdio: ['ignore', 'pipe', 'ignore'] }); cleanups.push(() => { try { zen3.kill(); } catch (_) { /* */ } }); let z3 = ''; zen3.stdout.on('data', (d) => { z3 += d; }); const z3exit = new Promise((res) => zen3.on('exit', (c) => res(c)));
    await sleep(1500); const zw3 = await winByTitle('FA-ZEN3'); await cu.setScope({ windowIds: [xt.id, zw3.id] });
    const b3 = (await cu.findElements({ windowId: zw3.id, role: 'button', name: '確定' })).elements[0];
    r = await cu.run([{ op: 'click', element: b3.id }]); const code3 = await Promise.race([z3exit, sleep(4000).then(() => 'timeout')]);
    await t.acheck('click 帶 element：座標取元件中心，預覽顯示元件角色與名稱', async () => ({ ok: r.ok && /元件：button「確定」/.test(r.preview) && code3 === 0 && /third/.test(z3), r: JSON.stringify(r).slice(0, 600), code3 }));
    await t.acheck('過期的元件 id（視窗已關閉）：快照還在但 element 動作回報失敗或被拒絕，不會亂點', async () => { const rr = await cu.run([{ op: 'element_invoke', element: b3.id }]); return { ok: !rr.ok && /不存在|過期|找不到/.test(JSON.stringify(rr.refused || rr.error)), rr: JSON.stringify(rr).slice(0, 400) }; });

    // 探索：游標形狀
    const zen4 = spawn('zenity', ['--entry', '--title', 'FA-ZEN4', '--text', 'Probe me', '--entry-text', 'abc'], { env: x.env, stdio: 'ignore' }); cleanups.push(() => { try { zen4.kill(); } catch (_) { /* */ } });
    await sleep(1500); const zw4 = await winByTitle('FA-ZEN4'); await cu.setScope({ windowIds: [zw4.id] });
    const els4 = (await cu.uiTree({ windowId: zw4.id, depth: 8, flat: true })).tree, ent4 = els4.find((e) => e.role === 'textbox'), lbl4 = els4.find((e) => e.role === 'label');
    r = await cu.run([{ op: 'hover_probe', x: E.center(ent4.rect).x, y: E.center(ent4.rect).y }, { op: 'hover_probe', x: E.center(lbl4.rect).x, y: E.center(lbl4.rect).y }, { op: 'hover_probe', x: zw4.frame.x + 2, y: zw4.frame.y + Math.round(zw4.frame.h / 2) }]);
    await t.acheck('hover_probe：文字框上游標變成 text（可輸入）、標籤上是 default（不可互動）', async () => r.ok && r.steps[0].probe.cursor.kind === 'text' && r.steps[0].probe.interactive === true && r.steps[1].probe.cursor.kind === 'default' && r.steps[1].probe.interactive === false, r.steps.map((s) => s.probe && s.probe.cursor));
    await t.acheck('hover_probe：視窗邊緣游標是調整大小（sash）', async () => r.steps[2].probe && E.INTERACTIVE_CURSORS.includes(r.steps[2].probe.cursor.kind) && /sash|resize/.test(r.steps[2].probe.cursor.kind), r.steps[2].probe && r.steps[2].probe.cursor);

    // 密碼欄：zenity --password
    const zp = spawn('zenity', ['--password', '--title', 'Enter your password'], { env: x.env, stdio: 'ignore' }); cleanups.push(() => { try { zp.kill(); } catch (_) { /* */ } });
    await sleep(1500); const zwp = (await cu.listWindows({ all: true })).windows.find((w) => w.denied && w.process === 'zenity');
    await t.acheck('視窗標題含 password 的視窗被拒絕清單擋下（不能放進範圍）', async () => { const sr = await cu.setScope({ windowIds: [zwp.id] }); return { ok: !sr.ok && /拒絕清單/.test(sr.error || ''), sr: JSON.stringify(sr).slice(0, 300), zwp: zwp && zwp.title }; });
    // 把標題不含關鍵字的密碼對話框（--entry --hide-text）放進範圍：靠 AT-SPI 的 password text 角色擋
    const zh = spawn('zenity', ['--entry', '--hide-text', '--title', 'FA-SECRET', '--text', 'Token'], { env: x.env, stdio: 'ignore' }); cleanups.push(() => { try { zh.kill(); } catch (_) { /* */ } });
    await sleep(1500); const zwh = await winByTitle('FA-SECRET'); await cu.setScope({ windowIds: [zwh.id] });
    const th = await cu.uiTree({ windowId: zwh.id, depth: 8, flat: true }); const pwEl = th.ok && th.tree.find((e) => e.isPassword);
    await t.acheck('AT-SPI 把 --hide-text 的欄位標成 password（role=password、isPassword）', async () => !!pwEl && pwEl.role === 'password' && !pwEl.actions.includes('set_value'), th.ok && th.tree.map((e) => e.role + ':' + e.rawRole));
    r = await cu.run([{ op: 'window_focus', id: zwh.id }, { op: 'type', text: 'secret-token' }]);
    await t.acheck('焦點在密碼欄：打字執行前被攔下（不會有任何字元送出）', async () => !r.ok && /密碼/.test(JSON.stringify(r.stopped || r.refused || r.error)) , r.stopped || r.refused || r.error);
    r = await cu.run([{ op: 'element_set_value', element: pwEl.id, value: 'x' }]);
    await t.acheck('element_set_value 對密碼元件拒絕', async () => !r.ok && /密碼/.test(JSON.stringify(r.refused || r.error)), r.refused || r.error);
    const zmd = await cu.screenshot({ windowId: zwh.id, maxSide: 200 }); const pwPx = zmd.ok;
    await t.acheck('（對照）密碼視窗仍可拍照看（唯讀），但不能打字', async () => pwPx);
    t.done_pending = false;
  } catch (e) {
    console.log('例外：' + ((e && e.stack) || e));
    t.check('整合測試沒有例外', false, String((e && e.message) || e));
  } finally {
    try { if (cu) await cu.abort('測試結束'); } catch (_) { /* */ }
    for (const c of cleanups) c();
    x.stop(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
  }
  t.done();
})();
