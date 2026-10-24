// node scripts/computer-tests/safety.test.js -- computer-use-safety.js：範圍、拒絕清單、密碼、速率、中止、預覽
const S = require('../../computer-use-safety.js');
const { suite } = require('./_t.js');
const t = suite('computer-use-safety');
const W = (id, title, rect, o) => Object.assign({ id: String(id), title, class: 'App.App', process: 'app', pid: 100 + Number(String(id).replace(/\D/g, '') || 0), rect, frame: rect }, o || {});
const win1 = W('0x1', '記事本', { x: 100, y: 100, w: 400, h: 300 }), win2 = W('0x2', 'Terminal', { x: 300, y: 200, w: 400, h: 300 }, { z: 5 });
const mk = (o) => { const s = S.createSafety(Object.assign({ selfPids: [999], now: () => 1000 }, o || {})); s.setEnabled(true); s.setScope({ mode: 'windows', windows: [win1] }); return s; };
const ctx = (o) => Object.assign({ windows: [Object.assign({}, win1, { z: 1 }), win2], activeWindowId: '0x1', focus: { known: true, isPassword: false, role: 'textbox' } }, o || {});

let s = S.createSafety({}); 
t.check('預設關閉：任何批次都拒絕（disabled）', s.evaluate([{ op: 'click', x: 1, y: 1 }], ctx()).refused[0].code === 'disabled');
s.setEnabled(true);
t.check('開啟但沒有範圍：拒絕（no_scope）', s.evaluate([{ op: 'click', x: 1, y: 1 }], ctx()).refused[0].code === 'no_scope');
s = mk();
let r = s.evaluate([{ op: 'click', x: 150, y: 150 }], ctx());
t.check('範圍內的點擊通過、預設需要核准', r.ok && r.needsApproval && !r.forceAsk, r);
r = s.evaluate([{ op: 'click', x: 350, y: 250 }], ctx());
t.check('座標最上面的視窗是範圍外的（被蓋住）→ 拒絕 scope', !r.ok && r.refused[0].code === 'scope', r);
r = s.evaluate([{ op: 'click', x: 1000, y: 700 }], ctx());
t.check('座標在桌面（沒有視窗）→ 拒絕 no_window', !r.ok && r.refused[0].code === 'no_window');
r = s.evaluate([{ op: 'click', x: 150, y: 150 }, { op: 'click', x: 350, y: 250 }], ctx());
t.check('批次是整批原子的：一步被拒，整批 ok:false（不會只做一半）', !r.ok && r.steps[0].ok && !r.steps[1].ok);
t.check('拖曳終點落在範圍外 → 拒絕', !s.evaluate([{ op: 'drag', x: 150, y: 150, x2: 400, y2: 300 }], ctx()).ok);
t.check('拖曳在範圍內 → 通過', s.evaluate([{ op: 'drag', x: 150, y: 150, x2: 250, y2: 180 }], ctx()).ok);
t.check('最小化的視窗拒絕（要先還原）', s.evaluate([{ op: 'click', x: 150, y: 150 }], ctx({ windows: [Object.assign({}, win1, { minimized: true })] })).refused[0].code !== undefined);
t.check('window_focus 範圍外的視窗拒絕', !s.evaluate([{ op: 'window_focus', id: '0x2' }], ctx()).ok);
t.check('window_focus 範圍內的視窗通過', s.evaluate([{ op: 'window_focus', id: '0x1' }], ctx()).ok);
t.check('window_close 通過但有警告', (() => { const x = s.evaluate([{ op: 'window_close', id: '0x1' }], ctx()); return x.ok && x.steps[0].warnings.length === 1; })());
t.check('不認得的 op 拒絕並列出可用清單', /click/.test(s.evaluate([{ op: 'format_disk' }], ctx()).refused[0].reason));
t.check('座標不是數字 → bad_param', s.evaluate([{ op: 'click', x: 'abc', y: 1 }], ctx()).refused[0].code === 'bad_param');
t.check('一批最多 25 步', s.evaluate(Array.from({ length: 26 }, () => ({ op: 'wait', ms: 1 })), ctx()).refused[0].code === 'too_many');
t.check('wait 超過上限拒絕', !s.evaluate([{ op: 'wait', ms: 999999 }], ctx()).ok);

// 同一批裡先 window_focus 再點：聚焦會把視窗拉到最上面（計畫階段模擬），所以原本被蓋住的視窗在聚焦之後可以點；沒有聚焦就不行
(() => { const under = W('0xa', '記事本', { x: 100, y: 100, w: 400, h: 300 }, { z: 1 }), over = W('0xb', '別的視窗', { x: 0, y: 0, w: 800, h: 600 }, { z: 9 }); const sx = S.createSafety({ selfPids: [999] }); sx.setEnabled(true); sx.setScope({ mode: 'windows', windows: [under] }); const c = { windows: [under, over], activeWindowId: '0xb', focus: { known: true, isPassword: false } };
  t.check('被蓋住的範圍視窗：直接點拒絕；先 window_focus 再點就通過（聚焦會拉到最上面）', !sx.evaluate([{ op: 'click', x: 150, y: 150 }], c).ok && sx.evaluate([{ op: 'window_focus', id: '0xa' }, { op: 'click', x: 150, y: 150 }], c).ok && !sx.evaluate([{ op: 'click', x: 150, y: 150 }, { op: 'window_focus', id: '0xa' }], c).ok); })();

// 打字與密碼
r = s.evaluate([{ op: 'type', text: 'hello' }], ctx());
t.check('在已知非密碼欄打字通過', r.ok && !r.forceAsk);
r = s.evaluate([{ op: 'type', text: 'hunter2' }], ctx({ focus: { known: true, isPassword: true, role: 'password' } }));
t.check('焦點是密碼欄 → 拒絕 password', !r.ok && r.refused[0].code === 'password');
r = s.evaluate([{ op: 'key', keys: 'ctrl+v' }], ctx({ focus: { known: true, isPassword: true } }));
t.check('貼上（ctrl+v）進密碼欄也拒絕', !r.ok && r.refused[0].code === 'password');
r = s.evaluate([{ op: 'key', keys: 'ctrl+s' }], ctx({ focus: { known: true, isPassword: true } }));
t.check('ctrl+s 不算打字、密碼欄焦點時仍可', r.ok);
r = s.evaluate([{ op: 'type', text: 'x' }], ctx({ focus: null }));
t.check('看不出焦點：打字 forceAsk（要使用者核准）', r.ok && r.forceAsk && r.needsApproval);
s.setAuto(true);
r = s.evaluate([{ op: 'type', text: 'x' }], ctx({ focus: null }));
t.check('自動模式下，看不出焦點的打字仍然要問', r.needsApproval && r.forceAsk);
r = s.evaluate([{ op: 'click', x: 150, y: 150 }], ctx());
t.check('自動模式下，已驗證的點擊不用問', r.ok && !r.needsApproval);
r = s.evaluate([{ op: 'type', text: 'x'.repeat(401) }], ctx());
t.check('單次打字長度上限', !r.ok && r.refused[0].code === 'bad_param');
t.check('element_set_value 對密碼元件拒絕', !s.evaluate([{ op: 'element_set_value', element: 'e1', value: 'x', _resolved: { element: { isPassword: true, role: 'password', window: '0x1' }, window: win1 } }], ctx()).ok);
t.check('element_invoke 通過', s.evaluate([{ op: 'element_invoke', element: 'e1', _resolved: { element: { role: 'button', name: 'OK', window: '0x1' }, window: win1 } }], ctx()).ok);

// 按鍵拒絕清單
for (const [k, why] of [['ctrl+alt+Delete', 'ctrl+alt+delete'], ['Ctrl+Alt+F2', 'VT'], ['Super+L', 'super'], ['alt+tab', 'alt+tab'], ['Win', 'win'], ['ctrl+alt+t', 'term']]) t.check('拒絕按鍵 ' + k, s.evaluate([{ op: 'key', keys: k }], ctx()).refused[0].code === 'denied_key', why);
t.check('按鍵 ctrl+c／Enter／F5／alt+Left 可以', ['ctrl+c', 'Enter', 'F5', 'alt+Left', 'Page_Down'].every((k) => s.evaluate([{ op: 'key', keys: k }], ctx()).ok));
t.check('alt+f4 通過但有警告', s.evaluate([{ op: 'key', keys: 'alt+F4' }], ctx()).steps[0].warnings.length === 1);

// 拒絕清單
const deniedTitles = [['系統設定', { process: 'systemsettings' }], ['設定', { process: 'gnome-control-center' }], ['需要驗證', {}], ['Authentication Required', {}], ['PayPal Checkout', {}], ['結帳 - 購物車', {}], ['Bitwarden', {}], ['使用者帳戶控制', {}], ['x', { process: 'consent.exe' }], ['x', { process: 'regedit.exe' }], ['Enter your password', {}], ['x', { class: 'polkit-gnome-authentication-agent-1' }]];
for (const [title, o] of deniedTitles) { const w = W('0x9', title, { x: 0, y: 0, w: 800, h: 600 }, o); const sx = mk(); sx.setScope({ mode: 'windows', windows: [w] }); const rr = sx.evaluate([{ op: 'click', x: 10, y: 10 }], { windows: [w] }); t.check('拒絕清單擋下：' + title + ' ' + JSON.stringify(o), !rr.ok && rr.refused[0].code === 'denied', rr); }
t.check('一般視窗不被誤擋（記事本、Terminal、Firefox）', ['記事本', 'Terminal', 'Mozilla Firefox', 'Visual Studio Code', 'Document1 - LibreOffice Writer'].every((x) => !S.denyMatch({ title: x, class: 'a', process: 'b' })));
t.check('自己的視窗不碰（selfPids）', (() => { const w = W('0x7', 'FloatingAssistant', { x: 0, y: 0, w: 500, h: 500 }, { pid: 999 }); const sx = mk(); sx.setScope({ mode: 'windows', windows: [w] }); return !sx.evaluate([{ op: 'click', x: 5, y: 5 }], { windows: [w] }).ok; })());
t.check('使用者自訂拒絕（addDeny）', (() => { const sx = mk(); sx.addDeny('記事'); return !sx.evaluate([{ op: 'click', x: 150, y: 150 }], ctx()).ok; })());
t.check('scope=screen 時任何（沒被拒絕的）視窗都可以，但拒絕清單仍然生效', (() => { const sx = mk(); sx.setScope({ mode: 'screen' }); const a = sx.evaluate([{ op: 'click', x: 350, y: 250 }], ctx()).ok; const b = sx.evaluate([{ op: 'click', x: 350, y: 250 }], ctx({ windows: [Object.assign({}, win2, { title: '付款' })] })).ok; return a && !b; })());

// 中止
s = mk(); s.setAuto(true);
t.check('abort 之後拒絕、自動模式被關掉', (() => { s.abort('test'); const x = s.evaluate([{ op: 'click', x: 150, y: 150 }], ctx()); return s.isAborted() && !s.state().auto && x.refused[0].code === 'aborted'; })());
s.setEnabled(true); t.check('重新啟用後清除中止', !s.isAborted());
t.check('停用會清掉範圍與自動模式', (() => { s.setAuto(true); s.setEnabled(false); const st = s.state(); return !st.enabled && !st.auto && st.scope.mode === 'none'; })());

// 速率
let clock = 1000; const rs = S.createSafety({ now: () => clock, limits: { maxActionsPerMinute: 3, minIntervalMs: 50, maxSessionActions: 5, maxConsecutiveErrors: 2 } }); rs.setEnabled(true);
t.check('第一個動作不用等', rs.rateCheck().ok && rs.rateCheck().waitMs === 0); rs.rateNote();
t.check('動作間隔不到最小間隔要等', rs.rateCheck().waitMs === 50); clock += 100; rs.rateNote(); clock += 100; rs.rateNote(); clock += 100;
t.check('每分鐘上限', !rs.rateCheck().ok && /每分鐘/.test(rs.rateCheck().reason));
clock += 61000; t.check('一分鐘後恢復', rs.rateCheck().ok); rs.rateNote(); rs.rateNote();
t.check('整個工作階段上限', !rs.rateCheck().ok && /工作階段/.test(rs.rateCheck().reason));
t.check('連續失敗達上限自動中止', (() => { rs.noteResult(false); const cont = rs.noteResult(false); return cont === false && rs.isAborted(); })());

// 遠端 RFB 範圍
s = mk(); s.addRfbScope('rfb:1');
t.check('RFB：不在範圍的連線拒絕、在範圍內通過', !s.evaluate([{ op: 'click', x: 5, y: 5, target: 'rfb:2' }], ctx()).ok && s.evaluate([{ op: 'click', x: 5, y: 5, target: 'rfb:1' }], ctx({ remote: { 'rfb:1': { width: 800, height: 600 } } })).ok);
t.check('RFB：座標超出遠端畫面拒絕', !s.evaluate([{ op: 'click', x: 900, y: 5, target: 'rfb:1' }], ctx({ remote: { 'rfb:1': { width: 800, height: 600 } } })).ok);
t.check('RFB：打字一律 forceAsk（自動模式也一樣）', (() => { s.setAuto(true); const x = s.evaluate([{ op: 'type', text: 'a', target: 'rfb:1' }], ctx()); return x.ok && x.forceAsk && x.needsApproval; })());
t.check('RFB：不支援視窗／元件動作', !s.evaluate([{ op: 'window_close', id: 'x', target: 'rfb:1' }], ctx()).ok);

// 唯讀檢查（截圖／控制項樹）
s = mk();
t.check('checkRead window：範圍內通過、範圍外拒絕', s.checkRead({ kind: 'window', windowId: '0x1' }, ctx()).ok && !s.checkRead({ kind: 'window', windowId: '0x2' }, ctx()).ok);
t.check('checkRead screen：範圍不是整個螢幕時拒絕', !s.checkRead({ kind: 'screen' }, ctx()).ok);
t.check('checkRead rect：矩形角落被別的視窗蓋住就拒絕', !s.checkRead({ kind: 'rect', rect: { x: 120, y: 120, w: 300, h: 200 } }, ctx()).ok && s.checkRead({ kind: 'rect', rect: { x: 110, y: 110, w: 100, h: 50 } }, ctx()).ok);

// 預覽文字
const steps = [{ op: 'click', x: 150, y: 150 }, { op: 'type', text: 'hi\nthere' }, { op: 'key', keys: 'Ctrl+S' }, { op: 'drag', x: 1, y: 2, x2: 3, y2: 4 }];
const ev = s.evaluate(steps, ctx({ focus: null })), pv = S.buildPreview(steps, ev, [{ window: win1 }, { window: win1 }, { window: win1 }, {}]);
t.check('預覽：每步一行、含座標、視窗標題、警告', /1\. 點擊 \(150, 150\)，視窗「記事本」/.test(pv) && /2\. 輸入文字（8 字）：「hi↵there」/.test(pv) && /3\. 按鍵 ctrl\+s/.test(pv) && /⚠/.test(pv), pv);
t.check('詞彙：OPS 全部都有 describeStep（不會落到預設分支）', Object.keys(S.OPS).every((op) => S.describeStep({ op, x: 1, y: 1, x2: 1, y2: 1, text: 'a', keys: 'a', ms: 1, id: 'w', w: 100, h: 100, value: 'v', element: 'e' }, {}) !== op));
t.done();
