/* /computer 與 computer_* 工具（桌面版限定、預設關閉）的主機轉接層，寫法跟 edit_host.js／edit3d_host.js 一樣：
 * 純邏輯在 computer_core.js（FaComputerCore）與 computer_vision.js（FaComputerVision）；真正操作電腦的在主行程（computer-use*.js），renderer 只能經過 window.desktopAPI.computer。
 * 這裡把它們接到助理自己的零件：視覺模型（_interpretImageWithVisionModel：線上優先、離線 Florence-2／LLaVA 當備援）、對話訊息（_pushAssistantMessage）、檔案快取（fileCache）。
 * 全部以方法的形式掛到 FloatingAssistant.prototype（見 renderer/src/computer/INTEGRATION.md 的 COMPUTERHOST 標記與 Object.assign 那一行）。設計見 DESIGN.computer-use.md。
 * 安全：預覽、核准、範圍選擇、中止都在主行程的原生視窗；這裡的工具只能「請求」。沒有任何工具可以啟用功能、開自動核准或指定範圍（那些只有使用者的 /computer 指令能發起，而且還要原生視窗確認）。 */
const FaComputerHost = (function () {
    'use strict';
    const C = () => (typeof FaComputerCore !== 'undefined' ? FaComputerCore : (typeof require === 'function' ? require('./computer_core.js') : null));
    const V = () => (typeof FaComputerVision !== 'undefined' ? FaComputerVision : (typeof require === 'function' ? require('./computer_vision.js') : null));
    const api = () => (typeof window !== 'undefined' && window.desktopAPI && window.desktopAPI.computer) || null;
    const NO_DESKTOP = '電腦操作只有桌面版（Electron）支援；網頁版沒有這個功能，請如實告訴使用者，不要嘗試其他方式。';
    const OFF_HINT = '電腦操作功能沒有啟用或還沒指定範圍：請使用者輸入 /computer enable 啟用、/computer scope 選擇 AI 可以操作的視窗（這兩件事只有使用者能做，你不能代替他做）。';
    const jstr = (o) => JSON.stringify(o);
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

    // 把 features 壓成一行一項（給模型看的精簡版）
    function briefFeatures(f) {
        const out = {}; if (!f) return out;
        const one = (x) => (x && typeof x === 'object' ? (x.ok ? (x.via || 'ok') + (x.unverified ? '（未實測）' : '') : '不可用：' + (x.reason || '?')) : x);
        for (const [group, v] of Object.entries(f)) { if (v && typeof v === 'object' && 'ok' in v) out[group] = one(v); else if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (x && typeof x === 'object' && 'ok' in x) o[k] = one(x); out[group] = o; } }
        return out;
    }
    const slimWindow = (w) => ({ id: w.id, title: clip(w.title, 80), process: w.process, class: w.class, pid: w.pid, rect: w.rect, frame: w.frame, state: w.state, focused: !!w.focused, minimized: !!w.minimized, z: w.z, in_scope: !!w.inScope, canvas: w.canvas || undefined, protected: w.denied ? w.denied.label : undefined, self: w.self || undefined });

    const methods = {
        // ───── 共用 ─────
        _cuApi() { return api(); },
        async _cuParse(raw) { let a = {}; try { a = await this.repairJsonPayload(String(raw || '{}')); } catch (_) { /* 空參數 */ } return a || {}; },
        // 呼叫前的共同檢查：桌面版？
        _cuNeed() { const a = api(); return a ? { api: a } : { error: jstr({ ok: false, error: NO_DESKTOP }) }; },
        // 主行程回的失敗，補上「該怎麼辦」
        _cuFix(r) { if (r && r.ok === false && /沒有啟用|還沒有指定範圍|no_scope|disabled/.test(String(r.error || '') + JSON.stringify(r.refused || ''))) r.next = OFF_HINT; return r; },
        // 看圖：呼叫助理的視覺模型（線上優先、離線備援），一律回純文字；失敗就丟例外讓呼叫端處理
        async _cuVlmAsk(dataUrl, question) { const r = await this._interpretImageWithVisionModel(dataUrl, question); return String(typeof r === 'string' ? r : (r && (r.description || r.answer || r.transcription)) || ''); },
        // 視覺模組要的外部能力（全部走主行程；probe 會讓使用者核准一次）
        _cuVisionDeps() {
            const a = api(), self = this;
            return {
                crop: (shotId, rect, o) => a.cropShot(shotId, rect, o), ask: (dataUrl, q) => self._cuVlmAsk(dataUrl, q),
                probe: (points) => a.run(points.map((p) => ({ op: 'hover_probe', x: p.x, y: p.y, radius: p.radius })), {}),
                sample: (t) => a.sample(t), calibrate: () => a.calibrate({}),
            };
        },
        // 取得一張截圖：shot_id（上次拍的）→ 用快取的資料；否則依 window_id／rect／element_id／target 重拍
        async _cuShotFor(a, args) {
            this._cuShots = this._cuShots || new Map();
            if (args.shot_id && this._cuShots.has(String(args.shot_id))) return this._cuShots.get(String(args.shot_id));
            let spec = { maxSide: args.max_side || 1024 };
            if (args.element_id) { const e = await a.elementInfo(String(args.element_id)); if (!e.ok) return { ok: false, error: e.error }; spec.rect = e.element.rect; spec.maxSide = args.max_side || 512; if (!spec.rect) return { ok: false, error: '這個元件沒有座標（看不見）' }; }
            else if (args.rect) spec.rect = { x: +args.rect.x, y: +args.rect.y, w: +(args.rect.w || args.rect.width), h: +(args.rect.h || args.rect.height) };
            else if (args.window_id) spec.windowId = String(args.window_id);
            else if (args.target) spec.target = String(args.target);
            else if (args.screen) spec.screen = true;
            else return { ok: false, error: '需要 shot_id、window_id、rect、element_id、target（遠端連線）其中之一' };
            const s = await a.screenshot(spec); if (!s.ok) return s; const shot = { ok: true, shotId: s.shotId, origin: s.origin, scale: s.scale, width: s.width, height: s.height, dataUrl: s.dataUrl };
            this._cuShots.set(s.shotId, shot); while (this._cuShots.size > 6) this._cuShots.delete(this._cuShots.keys().next().value); return shot;
        },
        // 跑一批動作：整理參數 → 主行程預覽＋核准＋執行 → 精簡結果（look:true 之後附一張截圖）
        async _cuRun(steps, o) {
            o = o || {}; const n = this._cuNeed(); if (n.error) return n.error; const cc = C().normalizeSteps(steps); if (!cc.ok) return jstr({ ok: false, error: cc.errors.join('；') });
            this._cuMarkRunning(true);
            try {
                const r = await n.api.run(cc.steps, { screenshotAfter: !!o.look, maxSide: o.maxSide || 800 }); const sum = C().summarizeRun(r); this._cuFix(sum);
                if (o.look && r && r.after && r.after.dataUrl) return jstr({ type: 'image', dataUrl: r.after.dataUrl, meta: Object.assign({}, sum, { shot_id: r.after.shotId, origin: r.after.origin, scale: r.after.scale, note: '動作後的畫面（座標換算：screenX = origin.x + imageX / scale.x）' }) });
                return jstr(sum);
            } catch (e) { return jstr({ ok: false, error: String((e && e.message) || e) }); } finally { this._cuMarkRunning(false); }
        },
        // 「AI 正在操作」的提示列與 Esc 中止：第一次用到時才裝
        _cuMarkRunning(on) {
            this._cuRunningCount = Math.max(0, (this._cuRunningCount || 0) + (on ? 1 : -1)); const running = this._cuRunningCount > 0;
            try { this._cuBanner(running); } catch (_) { /* 沒有 DOM（測試）就略過 */ }
        },
        _cuInstallGuards() {
            if (this._cuGuards || typeof document === 'undefined') return; this._cuGuards = true; const a = api(); if (!a) return;
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (this._cuRunningCount || 0) > 0) { e.preventDefault(); a.abort('使用者按 Esc 中止'); } }, true);
            if (a.onEvent) a.onEvent((m) => { if (m && m.type === 'abort') { this._cuRunningCount = 0; try { this._cuBanner(false); } catch (_) { /* */ } try { this._log && this._log('🛑 電腦操作已中止'); } catch (_) { /* */ } } });
        },
        _cuBanner(show) {
            if (typeof document === 'undefined') return; let el = document.getElementById('fa-computer-banner');
            if (!show) { if (el) el.style.display = 'none'; return; }
            if (!el) { el = document.createElement('div'); el.id = 'fa-computer-banner'; el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:2147483000;background:#b42318;color:#fff;padding:8px 16px;border-radius:8px;font:13px sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4)'; el.textContent = '🖥️ AI 正在操作電腦 — 按 Esc 或點這裡中止'; el.onclick = () => { const a = api(); if (a) a.abort('使用者點擊中止'); }; document.body.appendChild(el); }
            el.style.display = 'block';
        },

        // ───── /computer ─────
        async _computerCommand(argsText, run) {
            const r = run || this, parsed = C().parseCommand(argsText); r.messages.push({ role: 'user', content: '/computer' + (String(argsText || '').trim() ? ' ' + String(argsText).trim() : '') });
            const say = (t) => r._pushAssistantMessage(t, null); const a = api();
            try {
                if (!a) say(NO_DESKTOP);
                else if (parsed.cmd === 'help') say((parsed.unknown ? '不認得的子指令「' + parsed.unknown + '」。\n\n' : '') + C().helpText());
                else if (parsed.cmd === 'status') { const st = await a.status(), cap = st.enabled ? await a.capabilities() : null; say(C().statusText(st, cap)); }
                else if (parsed.cmd === 'enable') { const x = await a.setEnabled(true); say(x.ok ? '✅ 已啟用。接著用 `/computer scope` 選擇 AI 可以操作的視窗。' : '⛔ ' + (x.error || '沒有啟用')); }
                else if (parsed.cmd === 'disable') { await a.setEnabled(false); say('⛔ 已停用，範圍與自動核准都已清除。'); }
                else if (parsed.cmd === 'scope') { const x = parsed.args[0] === 'screen' ? await a.setScope({ mode: 'screen' }) : await a.pickScope(); say(x.ok ? '✅ 範圍：' + (x.scope.mode === 'screen' ? '整個螢幕' : x.scope.windows.map((w) => '「' + w.title + '」').join('、')) : '⛔ ' + (x.error || '沒有設定範圍')); }
                else if (parsed.cmd === 'auto') { const x = await a.setAuto(parsed.args[0] === 'on'); say(x.ok ? (x.auto ? '⚠️ 本次工作階段自動核准已開（看不出焦點的打字仍會問你）。' : '自動核准已關。') : '⛔ ' + (x.error || '沒有變更')); }
                else if (parsed.cmd === 'abort') { await a.abort('使用者 /computer abort'); say('🛑 已中止所有動作，之後一律拒絕，直到 `/computer resume`。'); }
                else if (parsed.cmd === 'resume') { const x = await a.resume(); say(x.ok ? '✅ 已恢復。' : '⛔ ' + (x.error || '')); }
                else if (parsed.cmd === 'windows') { const l = await a.listWindows({ all: false }); say(l.ok ? '**視窗**（`id`｜標題｜行程｜範圍）\n' + l.windows.map((w) => '- `' + w.id + '`｜' + (w.denied ? '（受保護：' + w.denied.label + '）' : clip(w.title, 60)) + '｜' + (w.process || '?') + (w.canvas ? '｜🖼 畫布：' + w.canvas.client : '') + (w.inScope ? '｜✅ 範圍內' : '')).join('\n') : '⛔ ' + l.error); }
                else if (parsed.cmd === 'probe') { if (!parsed.args[0]) say('用法：`/computer probe <host:port|ws://…>`'); else { const p = await a.remoteProbe(parsed.args[0]); say(p.ok === false ? '⛔ ' + (p.error || '探測失敗') + (p.advice ? '\n' + p.advice.join('\n') : '') : '**' + p.kind + '**（物件來源：' + p.capabilities.objects + '，輸入：' + p.capabilities.input + '）\n' + p.advice.join('\n')); } }
                else if (parsed.cmd === 'connect') { if (!parsed.args[0]) say('用法：`/computer connect <host:port|ws://…> [機密名稱]`'); else { const t = parsed.args[0], o = /^wss?:/i.test(t) ? { wsUrl: t } : { host: t.split(':')[0], port: Number(t.split(':')[1]) || undefined }; if (parsed.args[1]) o.secretName = parsed.args[1]; const x = await a.remoteConnect(o); say(x.ok ? '✅ 已連線 `' + x.id + '`（' + x.width + '×' + x.height + '，' + x.security + '）。AI 現在可以用 `target:"' + x.id + '"` 操作它。' : '⛔ ' + x.error); } }
                else if (parsed.cmd === 'disconnect') { const x = await a.remoteDisconnect(parsed.args[0]); say(x.ok ? '已中斷 ' + parsed.args[0] : '⛔ ' + x.error); }
                else if (parsed.cmd === 'secret') { const s = C().parseSecretCommand(parsed.args); if (s.error) say(s.error); else if (s.sub === 'list') { const l = await a.listRemoteSecrets(); say('已設定的機密（只有名稱）：' + ((l.names || []).join('、') || '（沒有）') + '\n' + (l.env || '')); } else if (s.sub === 'delete') { await a.deleteRemoteSecret(s.name); say('已刪除機密 ' + s.name); } else { const x = await a.setRemoteSecret(s.name, s.password); say(x.ok ? '已儲存機密「' + x.name + '」（只存在主行程，不會回傳給畫面）。⚠️ 剛才輸入的密碼還留在這則對話紀錄裡，建議清掉這則訊息。' : '⛔ ' + x.error); } }
                else if (parsed.cmd === 'deny') { const x = await a.addDeny(parsed.args.join(' ')); say(x.ok ? '已加入拒絕規則（標題／類別／行程符合就不碰）。' : '⛔ ' + x.error); }
                else if (parsed.cmd === 'calibrate') { const x = await V().calibrate(this._cuVisionDeps()); say(x.ok ? '座標校準：' + x.advice + '（比例 ' + x.scale.x + '×' + x.scale.y + '，移動延遲約 ' + (x.moveMs || '?') + ' ms，方法 ' + x.method + '）' : '⛔ ' + x.error); }
            } catch (e) { say('⚠️ ' + String((e && e.message) || e)); }
            try { r._persistChatHistory(); r._renderMessageHistory(); } catch (_) { /* */ }
        },
        _registerComputerCommands() {
            this.register_slash_command('/computer', '[status|enable|disable|scope|auto|abort|resume|windows|probe|connect|secret|deny|calibrate|help]',
                '讓 AI 操作這台電腦（桌面版限定，預設關閉）。每一批動作先預覽、你在原生視窗核准才執行；只在你指定的視窗範圍內；不會在密碼欄打字、不碰系統設定／付款／驗證視窗；隨時可以用 Esc 或 Ctrl+Alt+Shift+Esc 中止。/computer enable 啟用、/computer scope 選視窗、/computer auto on 本次自動核准、/computer abort 中止、/computer probe host:5900 探測遠端桌面協定、/computer connect host:5900 [機密名稱] 用內建 VNC 用戶端連線。',
                (argsText, run) => (run || this)._computerCommand(argsText, run));
        },

        // ───── 工具 ─────
        _registerComputerTools(registerOptional) {
            const self = this; if (!api()) return; // 網頁版不註冊
            this._cuInstallGuards();
            const reg = (name, desc, fn, schema) => registerOptional(name, desc, async function (raw) { const a = await this._cuParse(raw); try { return await fn.call(this, a); } catch (e) { return jstr({ ok: false, error: String((e && e.message) || e) }); } }, schema);
            const P = (props, req) => ({ type: 'object', properties: props, required: req || [], additionalProperties: false });
            const winId = { type: 'string', description: '視窗 id（computer_list_windows 取得，例如 0x00600003）' };
            const targetP = { type: 'string', description: '（選填）遠端連線 id（computer_remote_connect 取得，例如 rfb:1）；不填＝本機桌面' };
            const xy = { x: { type: 'number', description: '螢幕座標 x（像素，左上角 0,0；截圖要用 origin／scale 換算）' }, y: { type: 'number', description: '螢幕座標 y' } };

            reg('computer_capabilities',
                '查「電腦操作」目前的狀態與這台機器能做什麼：是否已啟用、使用者指定的範圍、可用的後端（視窗管理／滑鼠鍵盤／截圖／無障礙元件樹）以及不能用的原因（缺工具、Wayland 限制…）、座標空間說明、安全限制。開始任何電腦操作前先呼叫一次。無參數。',
                async function () {
                    const n = this._cuNeed(); if (n.error) return n.error; const st = await n.api.status(), cap = await n.api.capabilities();
                    return jstr({ ok: true, enabled: st.enabled, aborted: st.aborted, auto: st.auto, scope: st.scope, summary: cap.summary, features: briefFeatures(cap.features), notes: cap.notes, hints: cap.hints, missing_tools: cap.missingTools, coordinate_space: cap.coordinateSpace, remote: cap.remote && { rfb: cap.remote.rfb.via, rdp: cap.remote.rdp.note }, limits: st.limits, how: st.enabled ? (st.scope.mode === 'none' ? OFF_HINT : '可以開始：list_windows → ui_tree／find_element（優先，用無障礙元件）→ 不行再 screenshot＋describe（視覺模型）→ 動作（每一批使用者會在原生視窗核准）') : OFF_HINT });
                }, P({}));

            reg('computer_list_windows',
                '列出桌面上的視窗：id、標題、行程名稱、類別、客戶區矩形 rect 與外框 frame（螢幕座標）、狀態（最大化／最小化／焦點）、z 順序（越大越上面）、是否在使用者指定的範圍內（in_scope）、是否是遠端畫面的畫布（canvas：RDP／VNC／KVM／瀏覽器 noVNC…，這種視窗沒有元件可讀，要用視覺模型或 remote_connect）、是否是受保護的視窗（protected：系統設定／驗證／密碼／付款，不會碰）。參數：all（選填，true＝連面板、桌面等非一般視窗也列）。',
                async function (a) { const n = this._cuNeed(); if (n.error) return n.error; const r = await n.api.listWindows({ all: !!a.all }); if (!r.ok) return jstr(this._cuFix(r)); return jstr({ ok: true, windows: r.windows.map(slimWindow), active_id: r.activeId, coordinate_space: '螢幕座標（像素，左上角 0,0）' }); },
                P({ all: { type: 'boolean' } }));

            reg('computer_window_action',
                '視窗管理：focus（切到前景）、move（x,y 移動）、resize（w,h 調整大小）、minimize、maximize、restore、close（關閉，未存檔內容可能遺失）。只能對使用者指定範圍內的視窗；使用者會在原生視窗核准。參數：action、window_id，move 要 x,y，resize 要 w,h。',
                async function (a) { return this._cuRun([Object.assign({ op: 'window_' + String(a.action || '').toLowerCase(), id: a.window_id }, a.x != null ? { x: a.x, y: a.y } : {}, a.w != null ? { w: a.w, h: a.h } : {})], { look: !!a.look }); },
                P({ action: { type: 'string', enum: ['focus', 'move', 'resize', 'minimize', 'maximize', 'restore', 'close'] }, window_id: winId, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, look: { type: 'boolean', description: '做完後附一張畫面' } }, ['action', 'window_id']));

            reg('computer_ui_tree',
                '讀一個視窗的「控制項樹」（像 Spy++／Inspect）：每個元件有 id、role（button／textbox／checkbox／menuitem…）、name、value／text、矩形 rect（螢幕座標）、enabled／visible／focused、isPassword、可以用無障礙 API 直接做的 actions（invoke／toggle／select／set_value／focus）。Linux 用 AT-SPI（GTK／Qt／Electron 要開無障礙／Java），Windows 用 UI Automation；都沒有時退回 X11／Win32 視窗樹（只有視窗層級）。**優先用這個，比截圖準又省**。目標是遠端畫面（target）時回傳從損壞矩形／游標推出的候選區域。參數：window_id（或 target）、depth（預設 6）、only_visible、flat（扁平清單，省 token）、source（auto／a11y／x11／win32）。元件 id 只在這次快照內有效。',
                async function (a) {
                    const n = this._cuNeed(); if (n.error) return n.error; const r = await n.api.uiTree({ windowId: a.window_id, target: a.target, depth: a.depth, onlyVisible: !!a.only_visible, flat: a.flat !== false && a.flat !== undefined ? !!a.flat : undefined, source: a.source, maxNodes: a.max_nodes || 300 });
                    if (!r.ok) return jstr(this._cuFix(r)); let txt = jstr(r); if (txt.length > 26000 && !a.flat) { const r2 = await n.api.uiTree({ windowId: a.window_id, depth: Math.min(4, a.depth || 4), onlyVisible: true, flat: true, maxNodes: 120 }); if (r2.ok) { r2.note = '樹太大，改回傳「只含可見元件、前 120 個」的扁平清單；要找特定元件請用 computer_find_element'; txt = jstr(r2); } }
                    return txt;
                },
                P({ window_id: winId, target: targetP, depth: { type: 'integer' }, only_visible: { type: 'boolean' }, flat: { type: 'boolean' }, source: { type: 'string', enum: ['auto', 'a11y', 'x11', 'win32'] }, max_nodes: { type: 'integer' } }));

            reg('computer_find_element',
                '在使用者指定範圍的視窗裡找元件（無障礙樹）：text（名稱／說明／值／文字的片段，不分大小寫）、role（button／textbox／checkbox／menuitem／tab／link…）、name、automation_id（Windows）、regex（比對名稱等）、window_id（不給＝搜尋範圍內所有視窗）、limit。回傳依分數排序的元件（含 id、rect、actions、window）。找不到就改用 computer_screenshot＋computer_describe。',
                async function (a) { const n = this._cuNeed(); if (n.error) return n.error; return jstr(this._cuFix(await n.api.findElements({ windowId: a.window_id, text: a.text, role: a.role, name: a.name, automationId: a.automation_id, regex: a.regex, limit: a.limit || 10 }))); },
                P({ text: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' }, automation_id: { type: 'string' }, regex: { type: 'string' }, window_id: winId, limit: { type: 'integer' } }));

            reg('computer_element_action',
                '對元件做動作（優先走無障礙 API，不用座標，最穩）：invoke（按下按鈕／啟動）、toggle（勾選框）、select（選取清單項）、focus、set_value（設定文字框的值；**不會對密碼欄做**）。element_id 來自 computer_ui_tree／computer_find_element（同一次快照內有效；視窗移動或關閉後會過期，要重新取得）。無障礙動作失敗時 invoke／toggle／select 會自動退回「點元件中心」（fallback:false 可關掉）。使用者會在原生視窗核准。',
                async function (a) { return this._cuRun([{ op: 'element_' + String(a.action || 'invoke').toLowerCase(), element: a.element_id, value: a.value, fallback: a.fallback }], { look: !!a.look }); },
                P({ element_id: { type: 'string' }, action: { type: 'string', enum: ['invoke', 'toggle', 'select', 'focus', 'set_value'] }, value: { type: 'string', description: 'set_value 才要' }, fallback: { type: 'boolean' }, look: { type: 'boolean' } }, ['element_id', 'action']));

            reg('computer_screenshot',
                '拍畫面（會顯示給使用者看；只能拍使用者指定範圍內的視窗／矩形，整個螢幕要範圍是「整個螢幕」）。參數：window_id（拍這個視窗外框）／rect {x,y,w,h}（螢幕座標）／screen:true／target（遠端連線 id）；max_side（長邊上限，預設 1024；縮小時 scale<1）；grid_cols、grid_rows（疊上格線與每格「列,欄」編號，給視覺模型定位用）；pointer（畫上游標）；describe（問題字串或 true：用視覺模型看這張圖並把描述放進 meta.description）。回傳 shot_id、origin、scale——**影像上的座標換回螢幕座標：screenX = origin.x + imageX / scale.x**。',
                async function (a) {
                    const n = this._cuNeed(); if (n.error) return n.error; const spec = { windowId: a.window_id, rect: a.rect && { x: +a.rect.x, y: +a.rect.y, w: +(a.rect.w || a.rect.width), h: +(a.rect.h || a.rect.height) }, target: a.target, maxSide: a.max_side || 1024, pointer: !!a.pointer };
                    if (a.screen) spec.screen = true; if (a.grid_cols && a.grid_rows) spec.grid = { cols: +a.grid_cols, rows: +a.grid_rows };
                    const s = await n.api.screenshot(spec); if (!s.ok) return jstr(this._cuFix(s));
                    this._cuShots = this._cuShots || new Map(); this._cuShots.set(s.shotId, { ok: true, shotId: s.shotId, origin: s.origin, scale: s.scale, width: s.width, height: s.height, dataUrl: s.dataUrl }); while (this._cuShots.size > 6) this._cuShots.delete(this._cuShots.keys().next().value);
                    const meta = { shot_id: s.shotId, width: s.width, height: s.height, origin: s.origin, scale: s.scale, coordinate_space: '螢幕座標（像素）', map_back: s.mapBack, tool: s.tool, warning: s.warning, grid: s.grid ? { cols: s.grid.cols, rows: s.grid.rows, note: '每格有螢幕座標 rect；格線標號是「列,欄」從 0 起算', cells: s.grid.cells.map((c) => ({ row: c.row, col: c.col, rect: c.rect })) } : undefined };
                    if (a.describe) { try { meta.description = clip(await this._cuVlmAsk(s.dataUrl, typeof a.describe === 'string' ? a.describe : undefined), 1500); } catch (e) { meta.describe_error = String((e && e.message) || e).slice(0, 200); } }
                    return jstr({ type: 'image', dataUrl: s.dataUrl, meta });
                },
                P({ window_id: winId, rect: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } }, screen: { type: 'boolean' }, target: targetP, max_side: { type: 'integer' }, grid_cols: { type: 'integer' }, grid_rows: { type: 'integer' }, pointer: { type: 'boolean' }, describe: { description: '字串（問題）或 true' } }));

            reg('computer_describe',
                '用視覺模型看畫面的一部分（慢路徑；沒有無障礙元件、或目標是畫布／遠端畫面時用）。程式負責座標與驗證，模型只回答小的封閉問題。mode：describe（預設，描述這塊內容；question 可指定問題）、tiles（把畫面切成格子，每格問「這是什麼控制項」，回傳候選元件 source:vlm，信心低）、locate（query＝要找的東西，逐格 yes/no 再縮小範圍，回傳螢幕座標框與中心點）、explore（tiles＋對最可疑的幾個做 verify）。verify:true＝探索驗證：移動滑鼠到候選位置、重拍比對游標形狀（手／文字／調整大小=sash）與周圍變化（需要使用者核准一次，只移動不點擊）。來源：shot_id／window_id／rect／element_id／target。回傳的座標都是螢幕座標。',
                async function (a) {
                    const n = this._cuNeed(); if (n.error) return n.error; const shot = await this._cuShotFor(n.api, a); if (!shot.ok) return jstr(this._cuFix(shot)); const deps = this._cuVisionDeps(), mode = String(a.mode || 'describe').toLowerCase();
                    const sh = { shotId: shot.shotId, origin: shot.origin, scale: shot.scale, width: shot.width, height: shot.height, dataUrl: shot.dataUrl }, slim = (e) => ({ id: e.id, role: e.role, widget: e.rawRole || undefined, name: e.name || undefined, text: e.text || undefined, rect: e.rect, center: C().center(e.rect), confidence: e.confidence, verified: e.verified ? { verdict: e.verified.verdict, cursor: e.verified.cursor && e.verified.cursor.kind, notes: e.verified.notes } : undefined });
                    this._cuMarkRunning(true);
                    try {
                        if (mode === 'describe') { const d = await V().describe(deps, sh, { question: a.question }); return jstr(Object.assign({ shot_id: shot.shotId, origin: shot.origin, scale: shot.scale }, d)); }
                        if (mode === 'tiles') { const r = await V().tileScan(deps, sh, { ocr: !!a.ocr }); let cands = r.candidates; let note; if (a.verify) { const v = await V().verify(deps, cands, { max: 6 }); if (v.ok && v.all) cands = v.all; else note = v.error; } return jstr({ ok: true, shot_id: shot.shotId, grid: r.grid, candidates: cands.map(slim), asked: r.asked, notes: r.notes, verify_note: note }); }
                        if (mode === 'locate') { if (!a.query) return jstr({ ok: false, error: 'locate 需要 query（要找什麼，用英文短語最準，例如 "the OK button"）' }); const r = await V().locate(deps, sh, String(a.query), {}); let els = r.elements; if (a.verify && els.length) { const v = await V().verify(deps, els, { max: 4 }); if (v.ok && v.all) els = v.all; } return jstr({ ok: true, shot_id: shot.shotId, query: r.query, found: els.length, elements: els.map(slim), asked: r.asked, hint: r.hint }); }
                        if (mode === 'explore') { const r = await V().explore(deps, sh, { verify: a.verify !== false, ocr: !!a.ocr }); return jstr({ ok: true, shot_id: shot.shotId, grid: r.grid, candidates: r.candidates.map(slim), verified_count: r.verifiedCount, verify_note: r.verifyNote, asked: r.asked, notes: r.notes }); }
                        return jstr({ ok: false, error: '不認得的 mode；可用：describe／tiles／locate／explore' });
                    } finally { this._cuMarkRunning(false); }
                },
                P({ mode: { type: 'string', enum: ['describe', 'tiles', 'locate', 'explore'] }, shot_id: { type: 'string' }, window_id: winId, rect: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } }, element_id: { type: 'string' }, target: targetP, question: { type: 'string' }, query: { type: 'string' }, verify: { type: 'boolean' }, ocr: { type: 'boolean' }, max_side: { type: 'integer' } }));

            reg('computer_click',
                '點擊（座標層級；有元件 id 時優先用 computer_element_action）。x,y 是螢幕座標（或 element_id＝點元件中心）。button：left／right／middle；count：1 或 2（雙擊）。座標必須落在使用者指定的視窗範圍內、而且那一點最上面的視窗就是它（被別的視窗蓋住會被拒絕）。使用者會在原生視窗看到預覽並核准。target＝遠端連線 id 時用協定送出。look:true＝做完附一張畫面。',
                async function (a) { return this._cuRun([Object.assign({ op: 'click', button: a.button, count: a.count, target: a.target, element: a.element_id }, a.x != null ? { x: a.x, y: a.y } : {})], { look: !!a.look }); },
                P(Object.assign({ element_id: { type: 'string' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, count: { type: 'integer' }, target: targetP, look: { type: 'boolean' } }, xy)));

            reg('computer_type',
                '打字（目前焦點）。text：要輸入的文字（Unicode 可，中文、emoji 都行；一次最多 400 字）；mode：type（預設，逐字送出）或 paste（改用剪貼簿貼上，某些遠端桌面收不到 type 時用）；press_enter：打完按 Enter。**絕不會在密碼欄輸入**（偵測到焦點是密碼欄就拒絕）；看不出焦點是不是密碼欄時（沒有無障礙資訊、遠端畫面）一律要使用者親自核准，自動模式也一樣。先用 computer_click 或 computer_window_action 把焦點放到對的欄位。',
                async function (a) { const steps = [{ op: 'type', text: String(a.text == null ? '' : a.text), mode: a.mode, target: a.target }]; if (a.press_enter) steps.push({ op: 'key', keys: 'Return', target: a.target }); return this._cuRun(steps, { look: !!a.look }); },
                P({ text: { type: 'string' }, mode: { type: 'string', enum: ['type', 'paste'] }, press_enter: { type: 'boolean' }, target: targetP, look: { type: 'boolean' } }, ['text']));

            reg('computer_key',
                '按鍵或組合鍵：keys 例如 "Enter"、"Escape"、"Tab"、"ctrl+s"、"ctrl+shift+t"、"alt+Left"、"F5"、"PageDown"。不會送出危險組合（Ctrl+Alt+Del、Super／Win 鍵、Alt+Tab、切換虛擬終端…）。',
                async function (a) { return this._cuRun([{ op: 'key', keys: a.keys, target: a.target }], { look: !!a.look }); },
                P({ keys: { type: 'string' }, target: targetP, look: { type: 'boolean' } }, ['keys']));

            reg('computer_scroll',
                '在 x,y 捲動：dy 正＝往下、負＝往上（格數，預設 3）；dx 正＝往右。',
                async function (a) { return this._cuRun([{ op: 'scroll', x: a.x, y: a.y, dx: a.dx, dy: a.dy == null && a.dx == null ? 3 : a.dy, target: a.target }], { look: !!a.look }); },
                P(Object.assign({ dx: { type: 'number' }, dy: { type: 'number' }, target: targetP, look: { type: 'boolean' } }, xy), ['x', 'y']));

            reg('computer_drag',
                '拖曳：從 x,y 按住左鍵拖到 x2,y2（起點與終點都要在範圍內）。可用來移動視窗標題列、拖 sash（分隔條）、框選。',
                async function (a) { return this._cuRun([{ op: 'drag', x: a.x, y: a.y, x2: a.x2, y2: a.y2, button: a.button, target: a.target }], { look: !!a.look }); },
                P(Object.assign({ x2: { type: 'number' }, y2: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, target: targetP, look: { type: 'boolean' } }, xy), ['x', 'y', 'x2', 'y2']));

            reg('computer_actions',
                '一次送出「一批」動作（使用者只需要核准一次這批預覽；一批最多 25 步，任何一步被拒絕整批都不執行）。steps 是陣列，每個元素 {op, …}，op 的封閉詞彙：move／click／double_click／right_click／middle_click（x,y 或 element）、drag（x,y,x2,y2）、scroll（x,y,dx,dy）、hover_probe（x,y，只移動並比對游標，不點擊）、type（text）、key（keys）、window_focus／window_move／window_resize／window_minimize／window_maximize／window_restore／window_close（id）、element_invoke／element_toggle／element_select／element_focus／element_set_value（element,value）、clipboard_set（text）、wait（ms）。例：[{"op":"window_focus","id":"0x600003"},{"op":"click","x":300,"y":200},{"op":"type","text":"hello"},{"op":"key","keys":"Return"}]。每一步執行前都會重新檢查範圍、被蓋住、密碼欄。',
                async function (a) { return this._cuRun(a.steps, { look: !!a.look }); },
                P({ steps: { type: 'array', items: { type: 'object' } }, look: { type: 'boolean', description: '做完附一張範圍視窗的畫面' } }, ['steps']));

            reg('computer_wait',
                '等待：window＝{title／class／pid／regex}（等這個視窗出現）；或 window_id／rect＋mode：change（等畫面有變化）、stable（等畫面不再變動，quiet_ms 內沒變）。timeout_ms 預設 10000。動作之後用它代替盲目 sleep。',
                async function (a) { const n = this._cuNeed(); if (n.error) return n.error; return jstr(this._cuFix(await n.api.wait({ window: a.window, windowId: a.window_id, rect: a.rect, mode: a.mode, timeoutMs: a.timeout_ms, quietMs: a.quiet_ms, threshold: a.threshold }))); },
                P({ window: { type: 'object', properties: { title: { type: 'string' }, class: { type: 'string' }, pid: { type: 'integer' }, regex: { type: 'string' } } }, window_id: winId, rect: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } }, mode: { type: 'string', enum: ['change', 'stable'] }, timeout_ms: { type: 'integer' }, quiet_ms: { type: 'integer' }, threshold: { type: 'number' } }));

            reg('computer_remote_probe',
                '探測遠端桌面協定（不登入）：給 host:port（VNC 顯示編號 host:1＝5901）或 ws://（noVNC／websockify）網址，辨識是 RFB（VNC）／RDP／NX／SPICE／SSH／HTTP（noVNC、Guacamole 頁面），回傳版本、安全等級（例如 RDP 是否 NLA、是否還接受舊式 Standard Security）、能做到什麼（objects：protocol 協定層／vlm 視覺模型；input：protocol／os）與建議。**RFB 可以用內建用戶端連線（computer_remote_connect）；RDP／NX／SPICE 只能辨識，要靠桌面用戶端開視窗再走視覺模型慢路徑。**',
                async function (a) { const n = this._cuNeed(); if (n.error) return n.error; const r = await n.api.remoteProbe(a.target || (a.ws_url || (a.host ? a.host + ':' + (a.port || '') : ''))); return jstr(this._cuFix(r)); },
                P({ target: { type: 'string', description: 'host:port 或 ws://…' }, host: { type: 'string' }, port: { type: 'integer' }, ws_url: { type: 'string' } }));

            reg('computer_remote_connect',
                '用內建 RFB（VNC）用戶端連線到遠端畫面（不需要任何 OS 工具）。host＋port 或 ws_url（noVNC／websockify）；secret_name＝主行程裡存的密碼名稱（使用者用 /computer secret set 設定；**密碼不要出現在對話裡**）。連線要使用者在原生視窗核准；連上後得到 id（例如 rfb:1），之後 computer_screenshot／click／type／key／scroll／drag／ui_tree 都可以帶 target:"rfb:1"。RFB 沒有繪圖物件：ui_tree 回傳的是從損壞矩形／CopyRect／游標推出的候選區域，內容由 computer_describe 命名。',
                async function (a) { const n = this._cuNeed(); if (n.error) return n.error; this._cuMarkRunning(true); try { return jstr(this._cuFix(await n.api.remoteConnect({ kind: 'rfb', host: a.host, port: a.port, wsUrl: a.ws_url, secretName: a.secret_name, label: a.label }))); } finally { this._cuMarkRunning(false); } },
                P({ host: { type: 'string' }, port: { type: 'integer' }, ws_url: { type: 'string' }, secret_name: { type: 'string' }, label: { type: 'string' } }));

            reg('computer_remote_disconnect', '中斷遠端連線（id 例如 rfb:1），並把它從操作範圍移除。',
                async function (a) { const n = this._cuNeed(); if (n.error) return n.error; return jstr(await n.api.remoteDisconnect(a.id)); }, P({ id: { type: 'string' } }, ['id']));

            reg('computer_abort', '立刻中止所有電腦操作（停止進行中的批次、放開按住的滑鼠鍵與修飾鍵、之後一律拒絕直到使用者 /computer resume）。覺得不對勁、使用者說「停」時馬上呼叫。無參數。',
                async function () { const n = this._cuNeed(); if (n.error) return n.error; return jstr(await n.api.abort('AI 呼叫 computer_abort')); }, P({}));
        },
    };
    return { methods, briefFeatures, slimWindow, TOOL_NAMES: ['computer_capabilities', 'computer_list_windows', 'computer_window_action', 'computer_ui_tree', 'computer_find_element', 'computer_element_action', 'computer_screenshot', 'computer_describe', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll', 'computer_drag', 'computer_actions', 'computer_wait', 'computer_remote_probe', 'computer_remote_connect', 'computer_remote_disconnect', 'computer_abort'] };
})();
if (typeof module === 'object' && module.exports) module.exports = FaComputerHost;
