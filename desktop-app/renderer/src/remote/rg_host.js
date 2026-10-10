/* 遠端群組的主機轉接層：右上角「線上」旁的滑出面板、建立／加入／離開、機器清單、測試連線。
 * 核心見 rg_core.js，傳輸見 rg_transport_supabase.js，設計見 DESIGN.remote-group.md。
 * 目前是第 1 階段：房間、密碼、在線名單、人數上限、測試連線；派工與內容傳輸在後面的階段。
 * 全部以方法的形式掛到 FloatingAssistant.prototype（見 embed-code-ui.js 的 REMOTE 標記）。*/
const FaRemoteHost = (function () {
    'use strict';
    const SB = { url: 'https://schvtbxufjwkibnfgbay.supabase.co', key: 'sb_publishable_Y4hgmYhipEf2S-rS-v45rg_R1Gg-dZe', lib: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js' };
    const STORE = 'fa_remote_group_v1';
    const methods = {
        _rgSettings() {
            const d = { machineName: '', maxMembers: 16, allowDispatch: true, readonlySandbox: false, acceptSubtasks: false, maxParallel: 3 };
            let s = {}; try { s = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (_) { s = {}; }
            const out = Object.assign(d, s); if (!out.machineName) out.machineName = (window.desktopAPI ? '桌面' : '網頁') + '-' + String(Math.floor(1000 + Math.random() * 9000));
            return out;
        },
        _rgSaveSettings(patch) { const s = Object.assign(this._rgSettings(), patch || {}); try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (_) { /* 無痕模式 */ } return s; },
        _rgTransport() { return new FaRemoteTransport.SupabaseTransport({ url: SB.url, key: SB.key, loadLib: () => _faLoadScriptOnce(SB.lib) }); },
        _rgSelfInfo(name) { const desktop = !!window.desktopAPI; return { name, kind: desktop ? 'desktop' : 'web', caps: desktop ? ['desktop', 'files', 'shell', 'sandbox'] : ['web', 'sandbox'], allow: this._rgSettings().allowDispatch, sub: this._rgSettings().acceptSubtasks, busy: false, agents: 0 }; },
        // 建立：代號由這邊隨機挑（8 位數起）；撞號（伺服器回 false）就換一個，連續撞號多加一位
        async _rgCreate(name, password) {
            const R = FaRemoteGroup, st = R.passwordStrength(password);
            if (!st.ok) throw new Error('密碼不合格：' + st.reasons.join('；'));
            const t = this._rgTransport(); let len = 8, tries = 0;
            for (;;) {
                const b = new Uint8Array(8); crypto.getRandomValues(b);
                let digits = ''; for (const x of b) digits += String(x % 10); while (digits.length < len) digits += String(Math.floor(Math.random() * 10));
                const code = String(1 + (b[0] % 9)) + digits.slice(0, len - 1);
                const keys = await R.deriveKeys(password, code);
                let created;
                try { created = await t.rpc('rg_create_room', { p_code: code, p_verifier: keys.verifier }); } catch (e) { throw this._rgRpcError(e); }
                if (created) return this._rgEnter(t, keys, code, name, true);
                if (++tries >= 3) { len++; tries = 0; if (len > 14) throw new Error('無法配發房間代號'); }
            }
        },
        async _rgJoin(name, codeText, password) {
            const code = String(codeText || '').replace(/\D/g, '');
            if (code.length < 8) throw new Error('房間代號是 8 位以上的數字');
            if (!password) throw new Error('請輸入密碼');
            const R = FaRemoteGroup, t = this._rgTransport(), keys = await R.deriveKeys(password, code);
            let res; try { res = await t.rpc('rg_join_room', { p_code: code, p_verifier: keys.verifier }); } catch (e) { throw this._rgRpcError(e); }
            if (res === 'not_found') throw new Error('找不到這個房間（代號錯誤，或已閒置超過 24 小時被回收）');
            if (res === 'bad_password') throw new Error('密碼不對');
            if (res === 'locked') throw new Error('這個房間因為連續猜錯被暫時鎖住，請稍後再試');
            if (res !== 'ok') throw new Error('加入失敗：' + res);
            return this._rgEnter(t, keys, code, name, false);
        },
        _rgRpcError(e) { return e && e.notInstalled ? new Error('房間服務還沒建立：請先到 Supabase 的 SQL Editor 執行 supabase/remote_group.sql（只需要做一次）') : e; },
        async _rgEnter(t, keys, code, name, creator) {
            const R = FaRemoteGroup, s = this._rgSettings();
            const room = new R.Room({ transport: t, keys, self: this._rgSelfInfo(name), maxMembers: s.maxMembers });
            const rg = { room, t, keys, code, creator, pings: {}, log: [], joinedAt: Date.now(), timer: null };
            room.on('members', () => { this._rgRender(); this._rgSyncTargetSelect(); this._rgOnMembersChange(); });
            room.on('message', (m) => this._rgOnMessage(m));
            room.on('status', (st) => { if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') this._rgLog('連線狀態：' + st); else if (st === 'SUBSCRIBED') this._rgLog('已連線'); });
            const r = await room.join();
            if (!r.ok) { try { await room.leave(); } catch (_) { /* */ } throw new Error(r.reason === 'full' ? '群組已滿（上限 ' + s.maxMembers + ' 台）' : '加入失敗'); }
            this._rg = rg; FaRemoteDispatch.installTracking.setNotify(() => this._rgPublishSoon()); this._rgSaveSettings({ machineName: room.self.name }); try { await this._rgLoadTasks(); } catch (_) { /* */ }
            rg.timer = setInterval(() => { t.rpc('rg_touch_room', { p_code: code, p_verifier: keys.verifier }).then((ok) => { if (ok === false) this._rgLog('房間已被回收（閒置太久）'); }).catch(() => {}); }, 5 * 60 * 1000);
            this._rgLog((creator ? '已建立群組 ' : '已加入群組 ') + code); this._rgView = 'joined'; this._rgRender();
            return { code, name: room.self.name };
        },
        async _rgLeave() {
            const rg = this._rg; if (!rg) return;
            clearInterval(rg.timer); clearInterval(rg.agentTimer); FaRemoteDispatch.installTracking.setNotify(null);
            const alone = rg.room.members().filter((m) => m.nodeId !== rg.room.self.nodeId).length === 0;
            if (alone) { try { await rg.t.rpc('rg_close_room', { p_code: rg.code, p_verifier: rg.keys.verifier }); } catch (_) { /* 沒關成就等 24 小時自動回收 */ } }
            try { await rg.room.leave(); } catch (_) { /* 已斷線 */ }
            this._rg = null; this._rgTarget = ''; this._rgView = 'form'; this._rgRender(); this._rgSyncTargetSelect();
        },
        _rgLog(text) { const rg = this._rg; if (!rg) return; rg.log.unshift(new Date().toLocaleTimeString() + ' ' + text); rg.log.length = Math.min(rg.log.length, 30); if (this._rgView === 'joined') this._rgRenderLog(); },
        async _rgOnMessage(m) {
            const rg = this._rg; if (!rg) return;
            const who = (rg.room.members().find((x) => x.nodeId === m.from) || {}).name || m.from;
            if (m.type === 'ping') { try { await rg.room.send(m.from, 'pong', { t: m.body && m.body.t }); } catch (_) { /* */ } this._rgLog('收到 ' + who + ' 的連線測試'); }
            else if (m.type === 'pong') { const p = rg.pings[m.from]; if (p && p.t === (m.body && m.body.t)) { p.resolve(Date.now() - p.t); delete rg.pings[m.from]; } }
            else if (m.type === 'task') this._rgOnTask(m);
            else if (m.type === 'task_ack' || m.type === 'task_ev') this._rgOnEvent(m);
            else if (m.type === 'task_stop') this._rgOnStop(m);
            else if (m.type === 'task_sync') this._rgOnSync(m);
            else if (m.type === 'agents_req') { try { await rg.room.send(m.from, 'agents', { rid: m.body && m.body.rid, list: this._rgAgentsList() }); } catch (_) { /* */ } }
            else if (m.type === 'agents') { rg.agentLists = rg.agentLists || {}; rg.agentLists[m.from] = { at: Date.now(), list: (m.body && m.body.list) || [] }; this._rgRenderAgents(); }
            else this._rgLog('收到來自 ' + who + ' 的「' + m.type + '」（不認得的訊息）');
        },
        _rgPing(nodeId) {
            const rg = this._rg; if (!rg) return Promise.reject(new Error('尚未加入群組'));
            return new Promise((resolve, reject) => {
                const t = Date.now(); const timer = setTimeout(() => { delete rg.pings[nodeId]; reject(new Error('逾時（8 秒沒回應）')); }, 8000);
                rg.pings[nodeId] = { t, resolve: (ms) => { clearTimeout(timer); resolve(ms); } };
                rg.room.send(nodeId, 'ping', { t }).catch((e) => { clearTimeout(timer); delete rg.pings[nodeId]; reject(e); });
            });
        },
        // ---------------------------------------------------------------- 畫面：右上角按鈕與滑出面板
        _rgInstallUi() {
            const win = document.getElementById('ai-floating-window'); if (!win) return;
            ['ai-rg-btn', 'ai-rg-panel'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
            const btn = document.createElement('span'); btn.id = 'ai-rg-btn'; btn.title = '遠端群組：加入或建立群組，把工作交給群組裡的其他電腦';
            btn.style.cssText = 'cursor:pointer; margin-right:12px; font-size:12px; font-weight:normal; vertical-align:middle; padding:2px 6px; border-radius:999px; border:1px solid rgba(128,128,128,.4); white-space:nowrap;';
            const sw = document.getElementById('ai-offline-switch'); if (sw && sw.parentNode) sw.parentNode.insertBefore(btn, sw); else document.getElementById('ai-window-header').appendChild(btn);
            const panel = document.createElement('div'); panel.id = 'ai-rg-panel';
            panel.style.cssText = 'position:absolute; top:46px; right:0; bottom:0; width:350px; max-width:92%; z-index:50; overflow-y:auto; box-sizing:border-box; padding:12px; font-size:13px; transform:translateX(105%); transition:transform .2s ease; box-shadow:-4px 0 14px rgba(0,0,0,.25);';
            win.appendChild(panel);
            this._rgOpen = false; this._rgView = this._rg ? 'joined' : 'form'; this._rgTab = this._rgTab || 'create';
            const ind = document.getElementById('ai-response-indicator');
            if (ind && ind.parentNode) { const sel = document.createElement('select'); sel.id = 'ai-rg-target'; sel.title = '把這個對話的需求交給群組裡的哪台機器完成'; sel.style.cssText = 'display:none; margin-left:auto; max-width:48%; font-size:11px; padding:1px 4px; border-radius:6px;'; sel.addEventListener('change', () => { this._rgTarget = sel.value; }); ind.parentNode.appendChild(sel); }
            btn.addEventListener('click', (e) => { e.stopPropagation(); this._rgToggle(); });
            panel.addEventListener('click', (e) => this._rgOnClick(e));
            panel.addEventListener('input', (e) => this._rgOnInput(e));
            // 點在面板外面才收起。注意：點按鈕後面板內容可能立刻被換掉（原本被點的元素已不在畫面上），所以用事件發生當下的路徑判斷，不用 contains
            document.addEventListener('click', (e) => { const path = e.composedPath ? e.composedPath() : []; if (this._rgOpen && !path.includes(panel) && !path.includes(btn)) this._rgToggle(false); });
            this._rgRender();
        },
        // 「交給」選單：已加入群組才出現；選項是其他在線機器
        _rgSyncTargetSelect() {
            const sel = document.getElementById('ai-rg-target'); if (!sel) return;
            const rg = this._rg; if (!rg) { sel.style.display = 'none'; sel.innerHTML = ''; return; }
            const pal = this._getThemePalette(), cur = this._rgTarget || '';
            sel.style.background = pal.inputBg; sel.style.color = pal.inputText; sel.style.border = '1px solid ' + pal.inputBorder;
            const opts = ['<option value="">交給：本機</option>'].concat(this._rgTargets().map((m) => '<option value="' + this._escapeHtml(m.nodeId) + '"' + (m.allow === false ? ' disabled' : '') + '>交給：' + this._escapeHtml(m.name) + (m.kind === 'desktop' ? '（桌面）' : '（網頁）') + (m.busy ? ' 忙碌' : '') + (m.allow === false ? ' 不接受' : '') + '</option>'));
            sel.innerHTML = opts.join(''); sel.value = this._rgTargets().some((m) => m.nodeId === cur) ? cur : ''; if (sel.value !== cur) this._rgTarget = sel.value;
            sel.style.display = '';
        },
        _rgToggle(open) {
            const p = document.getElementById('ai-rg-panel'); if (!p) return;
            this._rgOpen = open == null ? !this._rgOpen : !!open; p.style.transform = this._rgOpen ? 'translateX(0)' : 'translateX(105%)';
            if (this._rgOpen) this._rgRender();
        },
        _rgBtnLabel() {
            const rg = this._rg; if (!rg) return '🌐 遠端';
            const n = rg.room.members().length; return '🌐 ' + rg.code + ' · ' + n + '台';
        },
        _rgRender() {
            const btn = document.getElementById('ai-rg-btn'), p = document.getElementById('ai-rg-panel'); if (!btn || !p) return;
            btn.textContent = this._rgBtnLabel(); btn.style.background = this._rg ? 'rgba(118,185,0,.25)' : 'transparent';
            const pal = this._getThemePalette(); p.style.background = pal.windowBg; p.style.color = pal.chatText; p.style.borderLeft = '1px solid ' + pal.windowBorder;
            if (!this._rgOpen && p.dataset.built) { /* 面板收著時只更新按鈕 */ return; }
            if (this._rgView === 'joined' && this._rg) { if (p.dataset.view !== 'joined') this._rgBuildJoined(p, pal); else { this._rgRenderMembers(); this._rgRenderLog(); } }
            else if (this._rgView === 'busy') { /* 忙碌畫面由 _rgBusy 設定 */ }
            else if (p.dataset.view !== 'form') this._rgBuildForm(p, pal);
            p.dataset.built = '1';
        },
        _rgBusy(text) { const p = document.getElementById('ai-rg-panel'); if (!p) return; this._rgView = 'busy'; p.dataset.view = 'busy'; p.innerHTML = '<div style="padding:30px 10px; text-align:center;">⏳ ' + this._escapeHtml(text) + '</div>'; },
        _rgInputStyle(pal) { return 'width:100%; box-sizing:border-box; padding:6px; margin:3px 0 8px; border:1px solid ' + pal.inputBorder + '; border-radius:6px; background:' + pal.inputBg + '; color:' + pal.inputText + ';'; },
        _rgBuildForm(p, pal) {
            const e = (s) => this._escapeHtml(String(s)), st = this._rgSettings(), inp = this._rgInputStyle(pal), tab = this._rgTab;
            const warn = '<label style="display:flex; gap:6px; align-items:flex-start; font-size:11px; margin:6px 0 10px; color:#e2a03f;"><input type="checkbox" data-rg="warn" style="margin-top:2px;"><span>我了解：加入後，群組內的任何成員都可以讓這台電腦<b>直接執行 AI 工作</b>（可能包含讀寫檔案與執行指令），<b>不會再詢問</b>。只有信任的人才應該知道密碼。</span></label>';
            const tabBtn = (id, label) => '<button type="button" data-rg-act="tab" data-tab="' + id + '" style="flex:1; padding:6px; border:1px solid ' + pal.inputBorder + '; background:' + (tab === id ? '#76b900' : 'transparent') + '; color:' + (tab === id ? '#fff' : pal.chatText) + '; cursor:pointer; border-radius:6px;">' + label + '</button>';
            p.dataset.view = 'form';
            p.innerHTML = '<div style="font-weight:bold; margin-bottom:8px;">🌐 遠端群組</div>'
                + '<div style="font-size:11px; opacity:.8; margin-bottom:8px;">把工作交給群組裡的其他電腦（桌面版或網頁）。用房間代號加密碼進同一個群組，內容端對端加密。</div>'
                + '<label style="font-size:12px;">這台機器的名稱</label><input data-rg="name" value="' + e(st.machineName) + '" style="' + inp + '">'
                + '<div style="display:flex; gap:6px; margin-bottom:10px;">' + tabBtn('create', '建立群組') + tabBtn('join', '加入群組') + '</div>'
                + (tab === 'create'
                    ? '<label style="font-size:12px;">密碼（至少 12 個字元，不接受空白或太弱的）</label><input data-rg="pw" type="password" autocomplete="new-password" style="' + inp + '">'
                      + '<label style="font-size:12px;">再輸入一次確認</label><input data-rg="pw2" type="password" autocomplete="new-password" style="' + inp + '">'
                      + '<div style="display:flex; gap:6px; align-items:center; margin:-2px 0 6px;"><button type="button" data-rg-act="gen" style="padding:3px 8px; cursor:pointer; border:1px solid ' + pal.inputBorder + '; border-radius:6px; background:transparent; color:' + pal.chatText + ';">🎲 產生密碼</button><span data-rg="meter" style="font-size:11px; opacity:.85;"></span></div>'
                      + warn + '<button type="button" data-rg-act="create" style="width:100%; padding:8px; border:none; border-radius:6px; background:#76b900; color:#fff; font-weight:bold; cursor:pointer;">建立群組</button>'
                    : '<label style="font-size:12px;">房間代號（8 位以上的數字）</label><input data-rg="code" inputmode="numeric" style="' + inp + '">'
                      + '<label style="font-size:12px;">密碼</label><input data-rg="pw" type="password" autocomplete="off" style="' + inp + '">'
                      + warn + '<button type="button" data-rg-act="join" style="width:100%; padding:8px; border:none; border-radius:6px; background:#76b900; color:#fff; font-weight:bold; cursor:pointer;">加入群組</button>')
                + '<div data-rg="msg" style="margin-top:8px; font-size:12px; color:#f87171; white-space:pre-wrap;"></div>';
        },
        _rgBuildJoined(p, pal) {
            const e = (s) => this._escapeHtml(String(s)), rg = this._rg, st = this._rgSettings(), btn = 'padding:3px 8px; cursor:pointer; border:1px solid ' + pal.inputBorder + '; border-radius:6px; background:transparent; color:' + pal.chatText + ';';
            p.dataset.view = 'joined';
            p.innerHTML = '<div style="font-weight:bold; margin-bottom:6px;">🌐 遠端群組</div>'
                + '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;"><span style="font-size:11px; opacity:.8;">房間代號</span><b style="font-size:18px; letter-spacing:1px;">' + e(rg.code) + '</b><button type="button" data-rg-act="copy" style="' + btn + '">複製</button></div>'
                + '<div style="font-size:11px; opacity:.85; margin-bottom:8px;">這台：<b>' + e(rg.room.self.name) + '</b>（' + (rg.room.self.kind === 'desktop' ? '桌面' : '網頁') + '）　指紋 <span data-rg="fp">…</span></div>'
                + '<div style="font-weight:bold; margin:8px 0 4px;">機器清單</div><div data-rg="members"></div><div data-rg="agentbox"></div>'
                + '<div style="font-weight:bold; margin:12px 0 4px;">設定</div>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;"><input type="checkbox" data-rg="allow" ' + (st.allowDispatch ? 'checked' : '') + '> 允許其他機器派工給我</label>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;"><input type="checkbox" data-rg="sub" ' + (st.acceptSubtasks ? 'checked' : '') + '> 接受子任務分工（別人的 AI 可以把子任務分給這台）</label>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;"><input type="checkbox" data-rg="ro" ' + (st.readonlySandbox ? 'checked' : '') + '> 只允許唯讀與沙盒工具</label>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;">同時處理遠端任務上限 <input type="number" min="1" max="16" data-rg="par" value="' + st.maxParallel + '" style="width:50px; padding:2px;"> 個</label>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;">人數上限 <input type="number" min="2" max="64" data-rg="max" value="' + st.maxMembers + '" style="width:60px; padding:2px;"> 台（下次加入時生效）</label>'
                + '<div style="font-size:11px; opacity:.7; margin:4px 0 8px;">在對話輸入框旁的「交給」選一台機器，之後這個對話的需求就由那台機器完成（目前只能傳文字；附件與影片的傳輸下一階段開放）。</div>'
                + '<button type="button" data-rg-act="leave" style="width:100%; padding:8px; border:1px solid #ef4444; border-radius:6px; background:transparent; color:#ef4444; font-weight:bold; cursor:pointer;">離開群組</button>'
                + '<div style="font-weight:bold; margin:12px 0 4px;">最近事件</div><div data-rg="log" style="font-size:11px; opacity:.85; line-height:1.5;"></div>';
            FaRemoteGroup.fingerprint(rg.keys.channel + rg.room.self.nodeId).then((fp) => { const el = p.querySelector('[data-rg="fp"]'); if (el) el.textContent = fp; });
            this._rgRenderMembers(); this._rgRenderLog();
        },
        _rgRenderMembers() {
            const p = document.getElementById('ai-rg-panel'), rg = this._rg; if (!p || !rg) return; const box = p.querySelector('[data-rg="members"]'); if (!box) return;
            const e = (s) => this._escapeHtml(String(s)), me = rg.room.self.nodeId;
            box.innerHTML = rg.room.members().map((m) => '<div style="display:flex; align-items:center; gap:6px; padding:3px 0;">🟢 <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><b>' + e(m.name) + '</b>' + (m.nodeId === me ? '（這台）' : '') + '</span><span style="font-size:10px; opacity:.7;">' + (m.kind === 'desktop' ? '桌面' : '網頁') + (m.busy ? '・忙碌' : '') + (m.allow === false ? '・不接受派工' : '') + (m.sub ? '・可分工' : '') + (m.agents ? '・跑 ' + m.agents + ' 個子任務' : '') + '</span>'
                + '<button type="button" data-rg-act="agents" data-id="' + e(m.nodeId) + '" title="看這台機器現在跑的子任務" style="padding:1px 6px; font-size:11px; cursor:pointer;">子任務</button>'
                + (m.nodeId === me ? '' : '<button type="button" data-rg-act="ping" data-id="' + e(m.nodeId) + '" style="padding:1px 6px; font-size:11px; cursor:pointer;">測試</button>') + '<span data-rg-ping="' + e(m.nodeId) + '" style="font-size:10px; min-width:44px;"></span></div>').join('') || '<div style="opacity:.7;">（沒有其他機器在線）</div>';
            const btn = document.getElementById('ai-rg-btn'); if (btn) btn.textContent = this._rgBtnLabel();
        },
        // 子任務清單：展開在機器清單下面；對別台機器是即時向它要，對自己是直接讀
        _rgRenderAgents() {
            const p = document.getElementById('ai-rg-panel'), rg = this._rg; if (!p || !rg) return; const box = p.querySelector('[data-rg="agentbox"]'); if (!box) return;
            const id = rg.agentView; if (!id) { box.innerHTML = ''; return; }
            const e = (s) => this._escapeHtml(String(s)), m = rg.room.members().find((x) => x.nodeId === id); if (!m) { box.innerHTML = ''; rg.agentView = null; return; }
            const list = id === rg.room.self.nodeId ? this._rgAgentsList() : ((rg.agentLists && rg.agentLists[id] && rg.agentLists[id].list) || null);
            box.innerHTML = '<div style="margin:6px 0; padding:6px; border:1px solid rgba(128,128,128,.4); border-radius:6px; font-size:11px;"><b>' + e(m.name) + ' 的子任務</b>' + (list === null ? '<div style="opacity:.7;">讀取中…</div>' : list.length ? list.map((a) => '<div style="margin-top:4px;">• ' + e(a.label) + '（' + e(a.source) + '，' + a.ago + ' 秒）<br><span style="opacity:.75;">' + e(a.task) + '</span></div>').join('') : '<div style="opacity:.7;">目前沒有在跑的子任務</div>') + '</div>';
        },
        async _rgToggleAgents(id) {
            const rg = this._rg; if (!rg) return;
            if (rg.agentView === id) { rg.agentView = null; clearInterval(rg.agentTimer); this._rgRenderAgents(); return; }
            rg.agentView = id; this._rgRenderAgents(); clearInterval(rg.agentTimer);
            const ask = () => { if (id !== rg.room.self.nodeId) rg.room.send(id, 'agents_req', { rid: Date.now() }).catch(() => {}); else this._rgRenderAgents(); };
            ask(); rg.agentTimer = setInterval(() => { if (this._rg !== rg || rg.agentView !== id) { clearInterval(rg.agentTimer); return; } ask(); }, 3000);
        },
        _rgRenderLog() { const p = document.getElementById('ai-rg-panel'), rg = this._rg; if (!p || !rg) return; const box = p.querySelector('[data-rg="log"]'); if (box) box.innerHTML = rg.log.slice(0, 8).map((l) => '<div>' + this._escapeHtml(l) + '</div>').join('') || '<div style="opacity:.7;">（還沒有事件）</div>'; },
        _rgOnInput(ev) {
            const t = ev.target, p = document.getElementById('ai-rg-panel'); if (!t || !t.dataset) return;
            if (t.dataset.rg === 'pw' && this._rgTab === 'create') {
                const meter = p.querySelector('[data-rg="meter"]'), s = FaRemoteGroup.passwordStrength(t.value);
                if (meter) { meter.textContent = !t.value ? '' : (s.ok ? '✅ ' + s.label + '（約 ' + s.bits + ' 位元）' : '❌ ' + s.reasons[0]); meter.style.color = s.ok ? '#76b900' : '#f87171'; }
            }
            if (t.dataset.rg === 'allow') { this._rgSaveSettings({ allowDispatch: t.checked }); if (this._rg) { this._rg.room.self.allow = t.checked; this._rg.room.publishSelf().catch(() => {}); } }
            if (t.dataset.rg === 'ro') this._rgSaveSettings({ readonlySandbox: t.checked });
            if (t.dataset.rg === 'sub') { this._rgSaveSettings({ acceptSubtasks: t.checked }); if (this._rg) { this._rg.room.self.sub = t.checked; this._rg.room.publishSelf().catch(() => {}); } }
            if (t.dataset.rg === 'par') this._rgSaveSettings({ maxParallel: Math.max(1, Math.min(16, Number(t.value) || 3)) });
            if (t.dataset.rg === 'max') this._rgSaveSettings({ maxMembers: Math.max(2, Math.min(64, Number(t.value) || 16)) });
        },
        async _rgOnClick(ev) {
            const t = ev.target.closest('[data-rg-act]'); if (!t) return;
            const p = document.getElementById('ai-rg-panel'), q = (n) => p.querySelector('[data-rg="' + n + '"]'), act = t.dataset.rgAct;
            const say = (m) => { const el = q('msg'); if (el) el.textContent = m || ''; };
            if (act === 'tab') { this._rgTab = t.dataset.tab; p.dataset.view = ''; this._rgBuildForm(p, this._getThemePalette()); return; }
            if (act === 'gen') { const pw = FaRemoteGroup.generatePassword(); const a = q('pw'), b = q('pw2'); a.value = pw; b.value = pw; a.type = 'text'; this._rgOnInput({ target: a }); say('已產生密碼並填入兩個欄位：請先複製存好（離開後無法再看到），再按「建立群組」。'); try { navigator.clipboard && navigator.clipboard.writeText(pw); } catch (_) { /* 沒有剪貼簿權限 */ } return; }
            if (act === 'copy') { try { await navigator.clipboard.writeText(this._rg.code); t.textContent = '已複製'; setTimeout(() => { t.textContent = '複製'; }, 1500); } catch (_) { /* */ } return; }
            if (act === 'leave') { if (window.confirm('離開群組？離開後這台機器不再接受群組裡的需求。')) await this._rgLeave(); return; }
            if (act === 'agents') { await this._rgToggleAgents(t.dataset.id); return; }
            if (act === 'ping') {
                const id = t.dataset.id, out = p.querySelector('[data-rg-ping="' + id + '"]'); if (out) out.textContent = '…';
                try { const ms = await this._rgPing(id); if (out) { out.textContent = ms + ' ms'; out.style.color = '#76b900'; } this._rgLog('測試連線 ' + ((this._rg.room.members().find((m) => m.nodeId === id) || {}).name || id) + '：' + ms + ' ms'); }
                catch (e) { if (out) { out.textContent = '失敗'; out.style.color = '#f87171'; out.title = e.message; } }
                return;
            }
            if (act === 'create' || act === 'join') {
                if (!q('warn').checked) { say('請先勾選「我了解…」的聲明。'); return; }
                const name = (q('name').value || '').trim() || this._rgSettings().machineName, pw = q('pw').value;
                try {
                    if (act === 'create') { if (pw !== q('pw2').value) { say('兩次輸入的密碼不一樣。'); return; } const s = FaRemoteGroup.passwordStrength(pw); if (!s.ok) { say('密碼不合格：' + s.reasons.join('；')); return; } }
                    this._rgSaveSettings({ machineName: name });
                    this._rgBusy(act === 'create' ? '建立群組中（推導金鑰需要幾秒）…' : '加入群組中（驗證密碼需要幾秒）…');
                    if (act === 'create') { const r = await this._rgCreate(name, pw); this._rgView = 'joined'; p.dataset.view = ''; this._rgRender(); this._rgLog('請把代號 ' + r.code + ' 與密碼告訴要加入的人'); }
                    else { await this._rgJoin(name, q('code').value, pw); p.dataset.view = ''; this._rgView = 'joined'; this._rgRender(); }
                } catch (e) {
                    this._rgView = 'form'; p.dataset.view = ''; this._rgBuildForm(p, this._getThemePalette());
                    const m = p.querySelector('[data-rg="msg"]'); if (m) m.textContent = String((e && e.message) || e);
                }
            }
        },
    };
    return { methods, SB };
})();
if (typeof module === 'object' && module.exports) module.exports = FaRemoteHost;
