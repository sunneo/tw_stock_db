// node scripts/computer-tests/computer_core.test.js -- renderer/src/computer/computer_core.js：詞彙與主行程一致、動作整理、座標換算、視覺答案解析、候選整併與驗證評分、/computer 指令
const C = require('../../renderer/src/computer/computer_core.js');
const S = require('../../computer-use-safety.js');
const E = require('../../computer-use-elements.js');
const { suite } = require('./_t.js');
const t = suite('computer_core');

t.check('動作詞彙：renderer 與主行程 computer-use-safety.js 完全一致（不能各說各話）', JSON.stringify(C.OPS.slice().sort()) === JSON.stringify(Object.keys(S.OPS).sort()), { r: C.OPS.filter((x) => !S.OPS[x]), m: Object.keys(S.OPS).filter((x) => !C.OPS.includes(x)) });
t.check('視窗／元件動作、按鈕詞彙一致', JSON.stringify(C.WINDOW_ACTIONS) === JSON.stringify(S.WINDOW_ACTIONS) && JSON.stringify(C.ELEMENT_ACTIONS) === JSON.stringify(S.ELEMENT_ACTIONS) && JSON.stringify(C.BUTTONS) === JSON.stringify(S.BUTTONS));
t.check('角色詞彙與主行程 computer-use-elements.js 一致', JSON.stringify(C.ROLES) === JSON.stringify(E.ROLES));
t.check('遠端目標種類與 computer-remote.js 一致', JSON.stringify(C.REMOTE_KINDS) === JSON.stringify(require('../../computer-remote.js').REMOTE_KINDS));
t.check('元件動作與視窗動作都有對應的 op', C.ELEMENT_ACTIONS.every((a) => C.OPS.includes('element_' + a)) && C.WINDOW_ACTIONS.every((a) => C.OPS.includes('window_' + a)));

// ---- 動作整理
const N = C.normalizeStep;
t.check('別名：tap→click、press→key、write→type、dblclick→double_click、sleep→wait、probe→hover_probe', N({ op: 'tap', x: 1, y: 2 }).step.op === 'click' && N({ op: 'press', keys: 'Enter' }).step.op === 'key' && N({ op: 'write', text: 'a' }).step.op === 'type' && N({ op: 'dblclick', x: 1, y: 2 }).step.op === 'double_click' && N({ op: 'sleep', ms: 5 }).step.op === 'wait' && N({ action: 'probe', x: 1, y: 2 }).step.op === 'hover_probe');
t.check('click 帶 button:right／count:2 轉成 right_click／double_click', N({ op: 'click', x: 1, y: 2, button: 'right' }).step.op === 'right_click' && N({ op: 'click', x: 1, y: 2, count: 2 }).step.op === 'double_click');
t.check('字串數字轉數字（弱模型常把座標寫成字串）', (() => { const s = N({ op: 'click', x: '100', y: '200' }).step; return s.x === 100 && s.y === 200; })());
t.check('缺座標、缺 text、缺 keys、壞 op → 明確錯誤訊息', /座標/.test(N({ op: 'click' }).error) && /text/.test(N({ op: 'type' }).error) && /keys/.test(N({ op: 'key' }).error) && /不認得/.test(N({ op: 'format_disk' }).error) && /id/.test(N({ op: 'window_close' }).error) && /element/.test(N({ op: 'element_invoke' }).error));
t.check('click 可以用 element 代替座標', N({ op: 'click', element: 'atspi:1:0:abc123' }).step.element === 'atspi:1:0:abc123');
t.check('window_id／element_id 別名', N({ op: 'window_focus', window_id: '0x1' }).step.id === '0x1' && N({ op: 'element_invoke', element_id: 'e' }).step.element === 'e');
t.check('scroll 預設 dy=3、wait 預設 500ms、空值欄位被丟掉', N({ op: 'scroll', x: 1, y: 2 }).step.dy === 3 && N({ op: 'wait' }).step.ms === 500 && !('button' in N({ op: 'click', x: 1, y: 2, button: '' }).step));
t.check('normalizeSteps：整批；有錯誤時列出第幾步', (() => { const r = C.normalizeSteps([{ op: 'click', x: 1, y: 2 }, { op: 'type' }, { op: 'nope' }]); return !r.ok && r.errors.length === 2 && /第 2 步/.test(r.errors[0]) && /第 3 步/.test(r.errors[1]); })() && C.normalizeSteps([]).ok === false && C.normalizeSteps('x').ok === false);
t.check('normalizeSteps 輸出的每一步都被主行程安全引擎認得（op 在詞彙裡）', C.normalizeSteps([{ op: 'move', x: 1, y: 1 }, { op: 'drag', x: 1, y: 1, x2: 2, y2: 2 }, { op: 'hover_probe', x: 5, y: 5 }, { op: 'clipboard_set', text: 'a' }]).steps.every((s) => S.OPS[s.op]));

// ---- 座標
const shot = { origin: { x: 100, y: 50 }, scale: { x: 0.5, y: 0.5 } };
t.check('影像座標 ↔ 螢幕座標（origin＋scale）往返一致', (() => { const p = C.imagePointToScreen(shot, { x: 40, y: 20 }), b = C.imageBoxToScreen(shot, { x: 10, y: 10, w: 60, h: 30 }), back = C.screenBoxToImage(shot, b); return p.x === 180 && p.y === 90 && b.x === 120 && b.w === 120 && back.x === 10 && back.w === 60; })());
t.check('與主行程 computer-use-elements 的換算結果相同', JSON.stringify(C.imageBoxToScreen(shot, { x: 7, y: 9, w: 33, h: 11 })) === JSON.stringify(E.imageBoxToScreen(shot, { x: 7, y: 9, w: 33, h: 11 })) && JSON.stringify(C.screenBoxToImage(shot, { x: 130, y: 70, w: 20, h: 20 })) === JSON.stringify(E.screenBoxToImage(shot, { x: 130, y: 70, w: 20, h: 20 })));
t.check('scale 是數字也行', C.imagePointToScreen({ origin: { x: 0, y: 0 }, scale: 0.25 }, { x: 10, y: 10 }).x === 40);
t.check('normalizeBox：0~1 比例、0~1000（loc）、像素；反向與超界會校正，太小丟掉', (() => { const a = C.normalizeBox([0.1, 0.2, 0.5, 0.6], 1000, 500), b = C.normalizeBox([100, 200, 500, 600], 2000, 2000, 'k'), c = C.normalizeBox([50, 60, 20, 10], 640, 480), d = C.normalizeBox([10, 10, 10.5, 10.5], 100, 100); return a.x === 100 && a.y === 100 && a.w === 400 && b.x === 200 && b.w === 800 && c.x === 20 && c.w === 30 && d === null; })());
t.check('parseBoxes：Florence 的 <loc_> 記號、JSON、"x1,y1,x2,y2" 三種格式', (() => { const f = C.parseBoxes('button<loc_100><loc_200><loc_300><loc_400>text<loc_0><loc_0><loc_500><loc_500>', 1000, 1000), j = C.parseBoxes('[{"label":"OK","bbox":[10,20,110,60]}]', 800, 600), r = C.parseBoxes('the button is at (10, 20, 110, 60).', 800, 600); return f.length === 2 && f[0].label === 'button' && f[0].box.x === 100 && f[0].box.y === 200 && j.length === 1 && j[0].label === 'OK' && j[0].box.w === 100 && r.length === 1 && r[0].box.h === 40; })());

// ---- 格線
t.check('chooseGrid：每格約 256px、格數不超過上限', (() => { const g = C.chooseGrid(1280, 800), g2 = C.chooseGrid(4000, 3000, { maxCells: 24 }), g3 = C.chooseGrid(100, 100); return g.cols === 5 && g.rows === 3 && g2.cols * g2.rows <= 24 && g3.cols === 1 && g3.rows === 1; })());
t.check('gridCells：涵蓋整張圖、不重疊、cellAt 找得到', (() => { const cs = C.gridCells(100, 70, 3, 2), area = cs.reduce((a, c) => a + c.w * c.h, 0); return cs.length === 6 && area === 7000 && C.cellAt(cs, 99, 69).col === 2 && C.cellAt(cs, 0, 0).row === 0 && C.cellAt(cs, 100, 0) === null; })());
t.check('subCells：子格座標回到父格範圍內', (() => { const cell = { col: 1, row: 1, x: 100, y: 100, w: 90, h: 60 }; const sub = C.subCells(cell, 3); return sub.length === 9 && sub[0].x === 100 && sub[8].x + sub[8].w === 190 && sub[8].y + sub[8].h === 160 && sub[4].parent.col === 1; })());

// ---- 視覺答案 → 封閉詞彙
const W = (s) => C.parseWidget(s).widget;
t.check('parseWidget：單字、片語、中文、帶句子', W('button') === 'button' && W('Button.') === 'button' && W('a text field') === 'textbox' && W('Search box') === 'textbox' && W('this looks like a menu bar') === 'menu' && W('按鈕') === 'button' && W('The picture shows a browser tab') === 'tab' && W('sash') === 'sash' && W('splitter') === 'sash' && W('check box') === 'checkbox' && W('title bar') === 'titlebar');
t.check('parseWidget：none／沒有／空白 → none；找不到詞彙 → null（不亂猜）', W('none') === 'none' && W('Nothing') === 'none' && W('沒有') === 'none' && W('banana') === null && W('') === null && C.parseWidget('blue').role === null);
t.check('parseWidget：「button, no text」不會被後面的 no 當成沒有', W('button, no text') === 'button');
t.check('parseWidget：角色對照（sash→separator、icon→image、textbox→textbox）；短答案信心較高', C.parseWidget('sash').role === 'separator' && C.parseWidget('icon').role === 'image' && C.parseWidget('button').confidence > C.parseWidget('I think this might possibly be a button of some kind here').confidence);
t.check('parseYesNo', C.parseYesNo('Yes') === true && C.parseYesNo('yes, there is a button') === true && C.parseYesNo('No.') === false && C.parseYesNo('There is no button') === false && C.parseYesNo('是') === true && C.parseYesNo('沒有') === false && C.parseYesNo('maybe') === null && C.parseYesNo('') === null);

// ---- 候選與驗證
const mk = (n, rect, o) => C.makeVlmElement(Object.assign({ shotId: 's1', n, rect, confidence: 0.4 }, o || {}));
t.check('makeVlmElement：source vlm、id、封閉角色、信心夾在 0~1、欄位與 AT-SPI／UIA 同一個 schema', (() => { const e = mk(1, { x: 1, y: 2, w: 30, h: 20 }, { widget: 'button', role: 'button', confidence: 7 }); return e.id === 'vlm:s1:1' && e.source === 'vlm' && e.role === 'button' && e.confidence === 1 && ['rect', 'enabled', 'visible', 'states', 'actions', 'isPassword', 'window'].every((k) => k in e) && C.ROLES.includes(mk(2, { x: 0, y: 0, w: 1, h: 1 }, { role: 'bogus' }).role); })());
t.check('mergeCandidates：重疊的合併、保留信心高的、補名稱', (() => { const m = C.mergeCandidates([mk(1, { x: 0, y: 0, w: 100, h: 40 }, { confidence: 0.3 }), mk(2, { x: 5, y: 2, w: 100, h: 40 }, { confidence: 0.6, name: 'OK', role: 'button' }), mk(3, { x: 400, y: 400, w: 50, h: 50 })]); return m.length === 2 && m[0].name === 'OK' && m[0].confidence > 0.6; })());
const cand = mk(1, { x: 10, y: 10, w: 80, h: 30 }, { widget: 'label', role: 'label', confidence: 0.4 });
t.check('applyProbe：游標變成手形 → 可點擊、角色升為 button、信心上升', (() => { const r = C.applyProbe(cand, { cursor: { kind: 'clickable' }, cursorChanged: true, regionChanged: true, interactive: true }); return r.role === 'button' && r.confidence > cand.confidence && r.verified.verdict === 'interactive' && r.verified.notes.length >= 2; })());
t.check('applyProbe：游標變成文字輸入 → textbox；sash 游標 → separator（sash）', C.applyProbe(mk(1, { x: 0, y: 0, w: 9, h: 9 }, { role: 'unknown' }), { cursor: { kind: 'text' }, interactive: true }).role === 'textbox' && C.applyProbe(mk(1, { x: 0, y: 0, w: 9, h: 9 }, { role: 'unknown' }), { cursor: { kind: 'sash-horizontal' }, interactive: true }).role === 'separator');
t.check('applyProbe：移上去沒有任何反應 → 信心下降、verdict inert', (() => { const r = C.applyProbe(cand, { cursor: { kind: 'default' }, cursorChanged: false, regionChanged: false, interactive: false }); return r.confidence < cand.confidence && r.verified.verdict === 'inert'; })());
t.check('applyProbe：沒有探測結果 → 標記 by:none、不改信心', C.applyProbe(cand, null).verified.by === 'none' && C.applyProbe(cand, null).confidence === cand.confidence);
t.check('pickForProbe：先驗證互動型、中等信心、已驗證過的排後面', (() => { const l = [mk(1, { x: 0, y: 0, w: 10, h: 10 }, { widget: 'button', role: 'button', confidence: 0.5 }), mk(2, { x: 0, y: 0, w: 10, h: 10 }, { widget: 'label', role: 'label', confidence: 0.5 }), Object.assign(mk(3, { x: 0, y: 0, w: 10, h: 10 }, { widget: 'button', role: 'button' }), { verified: { by: 'hover_probe' } })]; const p = C.pickForProbe(l, 5); return p.length === 1 && p[0].id === 'vlm:s1:1'; })());
t.check('游標對照：clickable→button、text→textbox、sash→sash（與主行程 classifyCursor 的輸出對得上）', ['hand2', 'xterm', 'sb_h_double_arrow', 'left_ptr'].every((n) => { const k = E.classifyCursor(n); return k === 'default' || C.CURSOR_TO_WIDGET[k] !== undefined; }) && C.CURSOR_TO_WIDGET[E.classifyCursor('hand2')] === 'button' && C.CURSOR_TO_WIDGET[E.classifyCursor('xterm')] === 'textbox' && C.CURSOR_TO_WIDGET[E.classifyCursor('sizewe')] === 'sash');

// ---- /computer 指令
const P = C.parseCommand;
t.check('parseCommand：預設 status、別名（on/off/範圍/中止/連線）、auto 參數', P('').cmd === 'status' && P('on').cmd === 'enable' && P('停用').cmd === 'disable' && P('範圍').cmd === 'scope' && P('中止').cmd === 'abort' && P('auto off').args[0] === 'off' && P('auto').args[0] === 'on' && P('scope screen').args[0] === 'screen' && P('connect host:5901 myvnc').args.join(' ') === 'host:5901 myvnc' && P('whatever').cmd === 'help' && P('whatever').unknown === 'whatever');
t.check('parseSecretCommand：set／delete／list 與錯誤訊息', (() => { const a = C.parseSecretCommand(['set', 'vnc1', 'pa ss']); return a.sub === 'set' && a.password === 'pa ss' && C.parseSecretCommand(['list']).sub === 'list' && C.parseSecretCommand(['delete', 'x']).name === 'x' && /用法/.test(C.parseSecretCommand([]).error) && /需要密碼/.test(C.parseSecretCommand(['set', 'x']).error); })());
t.check('statusText：未啟用／啟用＋範圍＋這台機器能做什麼', (() => { const off = C.statusText({ enabled: false, scope: { mode: 'none', windows: [], rfb: [] } }), on = C.statusText({ enabled: true, auto: true, scope: { mode: 'windows', windows: [{ title: '記事本' }], rfb: ['rfb:1'] }, limits: { maxStepsPerBatch: 25, maxActionsPerMinute: 90, maxTypeChars: 400 }, remote: ['rfb:1'] }, { ok: true, summary: 'X11 / xfce：可用 視窗管理', notes: ['n1'], hints: ['sudo apt install xdotool'] }); return /未啟用/.test(off) && /尚未指定/.test(off) && /已啟用/.test(on) && /「記事本」/.test(on) && /自動核准/.test(on) && /X11 \/ xfce/.test(on) && /sudo apt/.test(on) && /rfb:1/.test(on) && C.statusText(null).includes('桌面版'); })());
t.check('helpText 列出所有子指令', ['enable', 'scope', 'auto', 'abort', 'windows', 'probe', 'connect', 'secret', 'deny', 'calibrate'].every((k) => C.helpText().includes(k)));
t.check('summarizeRun：精簡、保留拒絕原因與步驟結果', (() => { const s = C.summarizeRun({ ok: false, completed: 1, total: 3, refused: [{ index: 1, reason: 'x不在範圍' }], stopped: { code: 'aborted', reason: 'r' }, steps: [{ op: 'click', ok: true, via: 'x11' }, { op: 'type', ok: false, error: 'e' }], preview: 'p' }); return s.ok === false && s.refused[0] === '第2步：x不在範圍' && s.steps[1].error === 'e' && s.stopped.code === 'aborted' && s.preview === 'p' && C.summarizeRun(null).ok === false; })());
t.done();
