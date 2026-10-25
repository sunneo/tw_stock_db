// node scripts/computer-tests/computer_host.test.js -- renderer/src/computer/computer_host.js：工具註冊（跟 edit_host 同樣的樣子）、參數整理、對 desktopAPI.computer 的呼叫、/computer 指令、網頁版不註冊
const fs = require('fs');
const path = require('path');
const { suite } = require('./_t.js');
const t = suite('computer_host');
global.FaComputerCore = require('../../renderer/src/computer/computer_core.js'); global.FaComputerVision = require('../../renderer/src/computer/computer_vision.js');
const Host = require('../../renderer/src/computer/computer_host.js');

// ---- 假的 desktopAPI.computer：記錄呼叫、回罐頭結果
const calls = []; const rec = (n, r) => async (...a) => { calls.push([n, ...a]); return typeof r === 'function' ? r(...a) : r; };
const state = { enabled: true, auto: false, aborted: false, scope: { mode: 'windows', windows: [{ id: '0x1', title: '記事本' }], rfb: [] }, limits: { maxStepsPerBatch: 25, maxActionsPerMinute: 90, maxTypeChars: 400 }, remote: [] };
const PNG1 = 'data:image/png;base64,iVBORw0KGgo=';
const fake = {
    status: rec('status', state), capabilities: rec('capabilities', { ok: true, summary: 'X11 / xfce：可用 視窗管理、滑鼠', features: { windows: { list: { ok: true, via: 'wmctrl' }, focus: { ok: false, reason: 'x' } }, input: { mouse: { ok: true, via: 'xdotool' }, backend: 'xdotool' } }, notes: [], hints: [], missingTools: [], coordinateSpace: { space: 'screen' }, remote: { rfb: { via: '內建 RFB' }, rdp: { note: 'RDP 只能辨識' } } }),
    listWindows: rec('listWindows', { ok: true, activeId: '0x1', windows: [{ id: '0x1', title: '記事本', process: 'gedit', class: 'Gedit', pid: 1, rect: { x: 1, y: 2, w: 3, h: 4 }, frame: { x: 0, y: 0, w: 5, h: 6 }, state: ['focused'], focused: true, z: 3, inScope: true, canvas: null, denied: null }, { id: '0x2', title: 'secret', process: 'polkit', canvas: null, denied: { label: '驗證／提權視窗' }, z: 2 }, { id: '0x3', title: 'VNC', process: 'vncviewer', canvas: { kind: 'vnc', client: 'VNC 用戶端' }, denied: null, z: 1 }] }),
    run: rec('run', (steps) => ({ ok: true, completed: steps.length, total: steps.length, preview: '1. 點擊', steps: steps.map((s) => ({ op: s.op, ok: true, via: 'x11' })) })),
    screenshot: rec('screenshot', (o) => ({ ok: true, shotId: 'shot1', dataUrl: PNG1, width: 300, height: 200, origin: { x: 10, y: 20 }, scale: { x: 0.5, y: 0.5 }, mapBack: 'screenX = origin.x + imageX / scale.x', tool: 'scrot', grid: o.grid ? { cols: o.grid.cols, rows: o.grid.rows, cells: [{ row: 0, col: 0, rect: { x: 10, y: 20, w: 100, h: 100 } }] } : null })),
    cropShot: rec('cropShot', (id, rect) => ({ ok: true, dataUrl: 'crop:' + JSON.stringify(rect), origin: rect, scale: { x: 1, y: 1 }, width: rect.w, height: rect.h })),
    uiTree: rec('uiTree', { ok: true, source: 'atspi', tree: [{ id: 'atspi:1:0:aaa111', role: 'window', name: 'x', children: [] }], truncated: false }),
    findElements: rec('findElements', { ok: true, elements: [{ id: 'atspi:1:0.1:bbb222', role: 'button', name: '確定', rect: { x: 1, y: 1, w: 5, h: 5 }, score: 7 }] }),
    elementInfo: rec('elementInfo', { ok: true, element: { id: 'e1', rect: { x: 50, y: 60, w: 100, h: 30 } } }),
    wait: rec('wait', { ok: true, kind: 'change', waitedMs: 120 }), abort: rec('abort', { ok: true, aborted: true }), resume: rec('resume', { ok: true }),
    remoteProbe: rec('remoteProbe', { ok: true, kind: 'rfb', capabilities: { objects: 'protocol', input: 'protocol' }, advice: ['RFB 可連'] }),
    remoteConnect: rec('remoteConnect', { ok: true, id: 'rfb:1', width: 800, height: 600, security: 'None' }), remoteDisconnect: rec('remoteDisconnect', { ok: true }),
    setEnabled: rec('setEnabled', { ok: true }), setAuto: rec('setAuto', { ok: true, auto: true }), pickScope: rec('pickScope', { ok: true, scope: { mode: 'windows', windows: [{ title: '記事本' }] } }), setScope: rec('setScope', { ok: true, scope: { mode: 'screen', windows: [] } }),
    setRemoteSecret: rec('setRemoteSecret', { ok: true, name: 'vnc1' }), listRemoteSecrets: rec('listRemoteSecrets', { ok: true, names: ['vnc1'], env: 'FA_VNC_PASSWORD_' }), deleteRemoteSecret: rec('deleteRemoteSecret', { ok: true }), addDeny: rec('addDeny', { ok: true }),
    calibrate: rec('calibrate', { ok: true, calibrated: true, scale: { x: 1, y: 1 }, maxErrorPx: 0, apply: false, moveMs: 12, method: 'pointerLocation' }), sample: rec('sample', { ok: true, animated: false }), onEvent: () => () => {},
};
const withApi = (on) => { global.window = on ? { desktopAPI: { computer: fake } } : {}; };

// 假的 FloatingAssistant：混入 methods 後註冊
function makeAssistant() {
    const self = Object.assign({ tools: {}, gated: new Set(), messages: [], slash: {}, pushed: [] }, Host.methods);
    self.repairJsonPayload = async (s) => JSON.parse(s);
    self._interpretImageWithVisionModel = async (dataUrl, q) => ({ description: 'VLM:' + String(q || '').slice(0, 20) });
    self._pushAssistantMessage = (t) => { self.pushed.push(t); }; self._persistChatHistory = () => {}; self._renderMessageHistory = () => {};
    self.register_slash_command = (name, hint, desc, fn) => { self.slash[name] = { hint, desc, fn }; };
    self._cuNeedRegister = () => { const reg = (name, desc, cb, schema) => { self.tools[name] = { desc, cb, schema }; }; self._registerComputerTools(reg); };
    return self;
}
const call = async (self, name, args) => JSON.parse(await self.tools[name].cb.call(self, JSON.stringify(args || {})));

(async () => {
  withApi(true); const A = makeAssistant(); A._cuNeedRegister(); A._registerComputerCommands();
  t.check('工具名稱與 TOOL_NAMES 一致、全部以 computer_ 開頭（共 19 個）', JSON.stringify(Object.keys(A.tools).sort()) === JSON.stringify(Host.TOOL_NAMES.slice().sort()) && Host.TOOL_NAMES.length === 19 && Host.TOOL_NAMES.every((n) => /^computer_/.test(n)));
  t.check('每個工具有中文說明、物件型 schema、additionalProperties:false', Object.values(A.tools).every((x) => /[一-鿿]/.test(x.desc) && x.schema.type === 'object' && x.schema.additionalProperties === false && typeof x.schema.properties === 'object'));
  t.check('必填參數：click 沒有；type 要 text；actions 要 steps；ui_tree 沒有（window_id 或 target）', !A.tools.computer_click.schema.required.length && A.tools.computer_type.schema.required.includes('text') && A.tools.computer_actions.schema.required.includes('steps') && A.tools.computer_remote_disconnect.schema.required.includes('id'));
  t.check('/computer 斜線指令有註冊、說明含安全承諾', !!A.slash['/computer'] && /預設關閉/.test(A.slash['/computer'].desc) && /Esc/.test(A.slash['/computer'].desc));
  t.check('沒有任何工具可以啟用功能／自動核准／指定範圍（只有使用者的斜線指令能發起）', !Object.values(A.tools).some((x) => /setEnabled|setAuto|pickScope/.test(x.cb.toString())) && !Object.keys(A.tools).some((n) => /enable|scope|auto/.test(n)));
  const scoped = Object.values(A.tools).map((x) => x.cb.toString()).join('\n'); t.check('工具只透過 window.desktopAPI.computer（api()）存取主行程，沒有 require／fs／child_process', !/require\(['"](fs|child_process|electron)/.test(Host.methods._cuNeed.toString() + scoped));

  // ---- 呼叫
  let r = await call(A, 'computer_capabilities'); t.check('capabilities：狀態、摘要、精簡 features（不可用的附原因）、下一步', r.ok && r.enabled && /xfce/.test(r.summary) && r.features.windows.list === 'wmctrl' && /不可用/.test(r.features.windows.focus) && /list_windows/.test(r.how));
  r = await call(A, 'computer_list_windows'); t.check('list_windows：精簡欄位、in_scope／canvas／protected 標示', r.ok && r.windows.length === 3 && r.windows[0].in_scope === true && r.windows[1].protected === '驗證／提權視窗' && r.windows[2].canvas.kind === 'vnc' && r.windows[0].frame.w === 5);
  calls.length = 0; r = await call(A, 'computer_click', { x: '100', y: 200, button: 'right' });
  const runCall = calls.find((c) => c[0] === 'run'); t.check('click：整理成封閉詞彙的 step（right_click、數字座標）並走 api.run（預覽與核准在主行程）', runCall && runCall[1][0].op === 'right_click' && runCall[1][0].x === 100 && runCall[1][0].y === 200 && r.ok && r.completed === 1);
  calls.length = 0; r = await call(A, 'computer_type', { text: '你好', press_enter: true }); t.check('type＋press_enter → 兩步（type、key Return）一批', calls.find((c) => c[0] === 'run')[1].map((s) => s.op).join() === 'type,key' && calls.find((c) => c[0] === 'run')[1][0].text === '你好');
  calls.length = 0; r = await call(A, 'computer_actions', { steps: [{ op: 'tap', x: 1, y: 2 }, { op: 'write', text: 'a' }, { op: 'press', keys: 'ctrl+s' }] }); t.check('actions：別名整理後一批送出', calls.find((c) => c[0] === 'run')[1].map((s) => s.op).join() === 'click,type,key');
  calls.length = 0; r = await call(A, 'computer_actions', { steps: [{ op: 'format_disk' }] }); t.check('actions：壞的動作在 renderer 就擋下、不會呼叫 run', !r.ok && /不認得/.test(r.error) && !calls.some((c) => c[0] === 'run'));
  calls.length = 0; r = await call(A, 'computer_window_action', { action: 'focus', window_id: '0x1' }); t.check('window_action → window_focus step', calls.find((c) => c[0] === 'run')[1][0].op === 'window_focus' && calls.find((c) => c[0] === 'run')[1][0].id === '0x1');
  calls.length = 0; r = await call(A, 'computer_element_action', { element_id: 'atspi:1:0:aaa111', action: 'invoke' }); t.check('element_action → element_invoke step', calls.find((c) => c[0] === 'run')[1][0].op === 'element_invoke');
  calls.length = 0; r = await call(A, 'computer_click', { element_id: 'e9' }); t.check('click 可以只給 element_id（座標由主行程取元件中心）', calls.find((c) => c[0] === 'run')[1][0].element === 'e9');
  calls.length = 0; r = await call(A, 'computer_scroll', { x: 5, y: 6 }); t.check('scroll 預設往下 3 格', calls.find((c) => c[0] === 'run')[1][0].dy === 3);
  calls.length = 0; r = await call(A, 'computer_drag', { x: 1, y: 2, x2: 30, y2: 40 }); t.check('drag', calls.find((c) => c[0] === 'run')[1][0].op === 'drag' && calls.find((c) => c[0] === 'run')[1][0].x2 === 30);
  calls.length = 0; r = await call(A, 'computer_key', { keys: 'Ctrl + S', target: 'rfb:1' }); t.check('key 帶遠端 target', calls.find((c) => c[0] === 'run')[1][0].target === 'rfb:1');
  calls.length = 0; r = await call(A, 'computer_click', { x: 1, y: 1, look: true }); t.check('look:true → 要求主行程動作後附截圖（screenshotAfter）', calls.find((c) => c[0] === 'run')[2].screenshotAfter === true);
  fake.run = rec('run', () => ({ ok: true, completed: 1, total: 1, steps: [{ op: 'click', ok: true }], after: { dataUrl: PNG1, shotId: 'shotA', origin: { x: 0, y: 0 }, scale: { x: 1, y: 1 } } })); r = await call(A, 'computer_click', { x: 1, y: 1, look: true }); t.check('look 的結果以 image 回傳（顯示給使用者），meta 有動作結果與座標換算', r.type === 'image' && r.dataUrl === PNG1 && r.meta.completed === 1 && r.meta.shot_id === 'shotA' && /origin/.test(r.meta.note));
  fake.run = rec('run', () => ({ ok: false, error: '有動作被拒絕：還沒有指定範圍視窗', refused: [{ index: 0, code: 'no_scope', reason: '還沒有指定範圍視窗，請使用者先用 /computer scope 選視窗' }] })); r = await call(A, 'computer_click', { x: 1, y: 1 });
  t.check('被拒絕（未啟用／沒範圍）→ 回傳原因，並提醒「只有使用者能 /computer enable／scope，你不能代替」', r.ok === false && /範圍/.test(JSON.stringify(r)) && /只有使用者能做/.test(r.next || ''), r);
  fake.run = rec('run', (steps) => ({ ok: true, completed: steps.length, total: steps.length, steps: steps.map((s) => ({ op: s.op, ok: true })) }));
  r = await call(A, 'computer_screenshot', { window_id: '0x1', max_side: 300, grid_cols: 4, grid_rows: 3, describe: '這是什麼視窗？' });
  t.check('screenshot：image 型回傳、shot_id、origin／scale、mapBack、格線 cells；describe 用視覺模型', r.type === 'image' && r.meta.shot_id === 'shot1' && r.meta.scale.x === 0.5 && /screenX/.test(r.meta.map_back) && r.meta.grid.cells.length === 1 && /VLM:/.test(r.meta.description));
  calls.length = 0; await call(A, 'computer_screenshot', { rect: { x: 1, y: 2, width: 30, height: 40 } }); t.check('screenshot：rect 的 width／height 別名', calls.find((c) => c[0] === 'screenshot')[1].rect.w === 30 && calls.find((c) => c[0] === 'screenshot')[1].rect.h === 40);
  r = await call(A, 'computer_ui_tree', { window_id: '0x1' }); t.check('ui_tree', r.ok && r.source === 'atspi');
  r = await call(A, 'computer_find_element', { text: '確定', role: 'button' }); t.check('find_element', r.ok && r.elements[0].id === 'atspi:1:0.1:bbb222' && calls.filter((c) => c[0] === 'findElements').pop()[1].text === '確定');
  r = await call(A, 'computer_wait', { window_id: '0x1', mode: 'change', timeout_ms: 500 }); t.check('wait', r.ok && r.kind === 'change');
  r = await call(A, 'computer_remote_probe', { host: 'h', port: 5901 }); t.check('remote_probe：host/port 轉成 target 字串', r.ok && r.kind === 'rfb' && calls.filter((c) => c[0] === 'remoteProbe').pop()[1] === 'h:5901');
  r = await call(A, 'computer_remote_connect', { host: 'h', port: 5901, secret_name: 'vnc1' }); t.check('remote_connect：只傳密碼的名稱（secretName）、不傳密碼', r.ok && r.id === 'rfb:1' && calls.filter((c) => c[0] === 'remoteConnect').pop()[1].secretName === 'vnc1' && !JSON.stringify(calls.filter((c) => c[0] === 'remoteConnect').pop()).includes('password'));
  r = await call(A, 'computer_abort'); t.check('abort', r.ok && r.aborted === true && calls.some((c) => c[0] === 'abort'));

  // ---- describe：視覺慢路徑（假 api＋假視覺模型）
  A._interpretImageWithVisionModel = async (dataUrl, q) => { let rect = {}; try { rect = JSON.parse(String(dataUrl).replace('crop:', '')); } catch (_) { /* 整張圖 */ } if (/exactly one word/.test(q)) return rect.x === 0 ? 'button' : 'none'; if (/Is there/.test(q)) return rect.x < 300 ? 'yes' : 'no'; return 'desc'; };
  A._cuShots = new Map(); fake.screenshot = rec('screenshot', () => ({ ok: true, shotId: 'shot2', dataUrl: 'data:full', width: 1000, height: 500, origin: { x: 0, y: 0 }, scale: { x: 1, y: 1 } }));
  r = await call(A, 'computer_describe', { window_id: '0x1', mode: 'tiles' }); t.check('describe mode=tiles：回傳候選元件（source vlm、中心點、信心、unverified 說明）', r.ok && r.candidates.length >= 1 && r.candidates[0].center && r.candidates[0].widget === 'button' && r.candidates[0].confidence < 0.9 && r.notes.some((n) => /封閉詞彙/.test(n)));
  fake.run = rec('run', (steps) => ({ ok: true, completed: steps.length, steps: steps.map((s) => ({ op: s.op, ok: true, probe: { x: s.x, y: s.y, cursor: { kind: 'clickable' }, cursorChanged: true, regionChanged: true, interactive: true } })) }));
  calls.length = 0; r = await call(A, 'computer_describe', { shot_id: 'shot2', mode: 'tiles', verify: true }); t.check('describe verify:true：用 hover_probe 步驟（只移動）走主行程核准，結果回寫 verified', r.ok && calls.some((c) => c[0] === 'run' && c[1].every((s) => s.op === 'hover_probe')) && r.candidates.some((c) => c.verified && c.verified.verdict === 'interactive'));
  r = await call(A, 'computer_describe', { window_id: '0x1', mode: 'locate', query: 'the OK button' }); t.check('describe mode=locate：回傳螢幕座標中心點', r.ok && r.query === 'the OK button' && (r.found === 0 || r.elements[0].center.x >= 0));
  r = await call(A, 'computer_describe', { window_id: '0x1', mode: 'locate' }); t.check('locate 沒給 query → 錯誤說明', !r.ok && /query/.test(r.error));
  r = await call(A, 'computer_describe', { mode: 'describe' }); t.check('describe 沒指定來源 → 錯誤說明', !r.ok && /shot_id|window_id/.test(r.error));
  r = await call(A, 'computer_describe', { element_id: 'e1', mode: 'describe', question: 'what?' }); t.check('describe element_id：先查元件矩形、只拍那一塊', r.ok && calls.filter((c) => c[0] === 'screenshot').pop()[1].rect.w === 100);

  // ---- /computer 指令
  const cmd = async (a) => { A.pushed.length = 0; await A.slash['/computer'].fn(a, A); return A.pushed.join('\n'); };
  t.check('/computer（status）：狀態與範圍', /已啟用/.test(await cmd('')) && /「記事本」/.test(await cmd('status')));
  t.check('/computer enable → 呼叫 setEnabled(true)（原生視窗在主行程）', (await cmd('enable'), calls.filter((c) => c[0] === 'setEnabled').pop()[1] === true));
  t.check('/computer scope → pickScope；scope screen → setScope({mode:screen})', /範圍/.test(await cmd('scope')) && calls.some((c) => c[0] === 'pickScope') && (await cmd('scope screen'), calls.filter((c) => c[0] === 'setScope').pop()[1].mode === 'screen'));
  t.check('/computer auto on／abort／windows／probe／connect', /自動核准/.test(await cmd('auto on')) && /中止/.test(await cmd('abort')) && /記事本/.test(await cmd('windows')) && /受保護/.test(await cmd('windows')) && /rfb/.test(await cmd('probe h:5901')) && /rfb:1/.test(await cmd('connect h:5901 vnc1')) && calls.filter((c) => c[0] === 'remoteConnect').pop()[1].secretName === 'vnc1');
  t.check('/computer secret set：密碼只送到 setRemoteSecret，並提醒對話紀錄裡還有明文', (await cmd('secret set vnc1 pa55'), calls.filter((c) => c[0] === 'setRemoteSecret').pop()[1] === 'vnc1' && calls.filter((c) => c[0] === 'setRemoteSecret').pop()[2] === 'pa55') && /建議清掉/.test(A.pushed.join('')));
  t.check('/computer calibrate、deny、不認得的子指令（help）', /校準/.test(await cmd('calibrate')) && /拒絕規則/.test(await cmd('deny foo')) && /不認得的子指令/.test(await cmd('xyz')));
  // 遠端的人（分享對話、遠端需求）打的設定類指令一律拒絕；狀態與說明仍然能看
  const remoteCmd = async (a) => { A.pushed.length = 0; const n0 = calls.length; await A.slash['/computer'].fn(a, A, { remoteOrigin: '某人' }); return { text: A.pushed.join(String.fromCharCode(10)), calls: calls.slice(n0) }; };
  const rr = []; for (const c of ['enable', 'disable', 'scope', 'scope screen', 'auto on', 'deny foo', 'secret set v p']) rr.push(await remoteCmd(c));
  t.check('遠端來源：enable／disable／scope／auto／deny／secret 全部被拒絕，而且沒有碰到 desktopAPI', rr.every((x) => /只有在這台電腦上/.test(x.text) && x.calls.length === 0), rr.map((x) => x.text.slice(0, 40)));
  t.check('遠端來源：status 與 help 仍然可以看', /已啟用/.test((await remoteCmd('status')).text) && /scope/.test((await remoteCmd('help')).text));
  t.check('每個 /computer 指令都會把使用者輸入記進對話（messages）', A.messages.length >= 10 && A.messages[0].content === '/computer');

  // ---- 網頁版
  withApi(false); const W = makeAssistant(); W._cuNeedRegister(); t.check('網頁版（沒有 desktopAPI.computer）：不註冊任何工具', Object.keys(W.tools).length === 0);
  W._registerComputerCommands(); await W.slash['/computer'].fn('status', W); t.check('網頁版的 /computer：說明只有桌面版', /桌面版/.test(W.pushed.join('')));
  // 嵌入相容：檔案頭尾的形狀（const FaComputerHost = (function () {… return { methods … } })();）
  const src = fs.readFileSync(path.join(__dirname, '../../renderer/src/computer/computer_host.js'), 'utf8'); t.check('檔案形狀與 edit_host.js 一致：const FaComputerHost = (function () { … return { methods, … }; })();', /^\/\*[\s\S]*?\*\/\nconst FaComputerHost = \(function \(\) \{/.test(src) && /return \{ methods,/.test(src) && /_registerComputerTools\(registerOptional\)/.test(src) && /_registerComputerCommands\(\)/.test(src));
  t.done();
})();
