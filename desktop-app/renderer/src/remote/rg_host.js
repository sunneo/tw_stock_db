/* 遠端群組的主機轉接層：右上角「線上」旁的滑出面板、建立／加入／離開、機器清單、測試連線。
 * 核心見 rg_core.js，傳輸見 rg_transport_supabase.js，設計見 DESIGN.remote-group.md。
 * 目前是第 1 階段：房間、密碼、在線名單、人數上限、測試連線；派工與內容傳輸在後面的階段。
 * 全部以方法的形式掛到 FloatingAssistant.prototype（見 embed-code-ui.js 的 REMOTE 標記）。*/
const FaRemoteHost = (function () {
    'use strict';
    const SB = { url: 'https://schvtbxufjwkibnfgbay.supabase.co', key: 'sb_publishable_Y4hgmYhipEf2S-rS-v45rg_R1Gg-dZe', lib: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js' };
    // 備援：第二個 Supabase 專案（同樣要執行 supabase/remote_group.sql）。主要專案的流量用完或連不上時改用它
    const SB2 = { url: 'https://wxxovxvasgwqnchwxbxo.supabase.co', key: 'sb_publishable_5YoJVSApOHEsEcKXi3vwxQ_MWzvhh9q', lib: SB.lib };
    // 第三層：Cloudflare Worker 上的 KV 慢速信箱（兩個 Supabase 都不能用時的最後備援；很慢，只適合文字）
    const KV3 = { kind: 'kv', url: 'https://lively-dream-c1f0.sunneo529.workers.dev' };
    const BACKENDS = [Object.assign({ name: '主要' }, SB), Object.assign({ name: '備援' }, SB2), Object.assign({ name: '慢速備援（Cloudflare）' }, KV3)];
    const STORE = 'fa_remote_group_v1';
    const methods = {
        _rgSettings() {
            const d = { machineName: '', maxMembers: 16, allowDispatch: true, readonlySandbox: false, acceptSubtasks: false, maxParallel: 3, onlyTrusted: false, iceServers: '' };
            let s = {}; try { s = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (_) { s = {}; }
            const out = Object.assign(d, s); if (!out.machineName) out.machineName = (window.desktopAPI ? '桌面' : '網頁') + '-' + String(Math.floor(1000 + Math.random() * 9000));
            return out;
        },
        _rgSaveSettings(patch) { const s = Object.assign(this._rgSettings(), patch || {}); try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (_) { /* 無痕模式 */ } return s; },
        _rgTransport(i) { const b = BACKENDS[i || 0] || BACKENDS[0]; if (b.kind === 'kv') return new FaRemoteTransportKv.KvTransport({ url: b.url }); return new FaRemoteTransport.SupabaseTransport({ url: b.url, key: b.key, loadLib: () => _faLoadScriptOnce(b.lib) }); },
        _rgSelfInfo(name) { const desktop = !!window.desktopAPI; return Object.assign(this._rgNodeIdWanted ? { nodeId: this._rgNodeIdWanted } : {}, { name, kind: desktop ? 'desktop' : 'web', caps: desktop ? ['desktop', 'files', 'shell', 'sandbox'] : ['web', 'sandbox'], allow: this._rgSettings().allowDispatch, sub: this._rgSettings().acceptSubtasks, busy: false, agents: 0, pk: this._rgIdent ? this._rgIdent.pub : undefined }); },
        // 建立：代號由這邊隨機挑（8 位數起）；撞號（伺服器回 false）就換一個，連續撞號多加一位
        // 在某個後端登記一個新房間（代號由這邊隨機挑，8 位數起；撞號就換，連續撞號多加一位）。order：後端編號的嘗試順序
        async _rgRegister(password, order) {
            const R = FaRemoteGroup; let firstErr = null;
            for (const idx of (order || [0, 1])) {
                const t = this._rgTransport(idx); let len = 8, tries = 0;
                try {
                    for (;;) {
                        const bytes = new Uint8Array(8); crypto.getRandomValues(bytes);
                        let digits = ''; for (const x of bytes) digits += String(x % 10); while (digits.length < len) digits += String(Math.floor(Math.random() * 10));
                        const code = String(1 + (bytes[0] % 9)) + digits.slice(0, len - 1);
                        const keys = await R.deriveKeys(password, code);
                        let created; try { created = await t.rpc('rg_create_room', { p_code: code, p_verifier: keys.verifier }); } catch (e) { throw this._rgRpcError(e); }
                        if (created) return { t, keys, code, idx };
                        if (++tries >= 3) { len++; tries = 0; if (len > 14) throw new Error('無法配發房間代號'); }
                    }
                } catch (e) { firstErr = firstErr || e; this._rgLog && this._rg && this._rgLog(BACKENDS[idx].name + '專案登記房間失敗：' + String((e && e.message) || e).slice(0, 80)); }
            }
            throw firstErr || new Error('無法建立群組');
        },
        async _rgCreate(name, password, order) {
            const R = FaRemoteGroup, st = R.passwordStrength(password);
            if (!st.ok) throw new Error('密碼不合格：' + st.reasons.join('；'));
            this._rgLastPw = password; let lastErr = null;
            for (const idx of (order || this._rgBackendOrder())) {
                let reg; try { reg = await this._rgRegister(password, [idx]); } catch (e) { lastErr = lastErr || e; continue; }
                try { return await this._rgEnter(reg.t, reg.keys, reg.code, name, true, idx); }
                catch (e) { lastErr = lastErr || e; try { await reg.t.rpc('rg_close_room', { p_code: reg.code, p_verifier: reg.keys.verifier }); } catch (_) { /* */ } }
            }
            throw lastErr || new Error('無法建立群組');
        },
        // 輪流使用：新房間隨機挑一個專案開始（流量平均分攤，兩個專案都保持有活動），失敗再換另一個
        // 通道掉線：等幾秒、若還沒自己恢復就重新連線，連續重試 4 次（約 45 秒）還是不行，就自動改連下一個後端（主要→備援→慢速備援），原本的恢復後再搬回去
        _rgScheduleReconnect(rg) {
            if (!rg || rg.reconnecting || this._rg !== rg) return; rg.reconnecting = true; const wait = Math.min(60000, 3000 * Math.pow(2, rg.retry || 0));
            setTimeout(async () => {
                rg.reconnecting = false; if (this._rg !== rg || rg.room.status === 'SUBSCRIBED') return;
                rg.retry = (rg.retry || 0) + 1;
                try { await rg.room.reconnect(); this._rgLog('已重新連線'); }
                catch (e) { this._rgLog('重新連線失敗（第 ' + rg.retry + ' 次）：' + String((e && e.message) || e).slice(0, 60)); if (rg.retry < 4) this._rgScheduleReconnect(rg); else this._rgFailover(rg); }
            }, wait);
        },
        _rgBackendOrder() { return Math.random() < 0.5 ? [0, 1, 2] : [1, 0, 2]; },
        // 目前這個群組是不是走慢速信箱：是的話所有等待回覆的逾時都放寬
        _rgSlow() { const rg = this._rg; return rg && BACKENDS[rg.idx || 0] && BACKENDS[rg.idx || 0].kind === 'kv' ? 10 : 1; },
        // 同一個代號與驗證值也登記到其他專案（背景、失敗就算了）：之後某個專案用光額度時，所有成員可以各自依序改連下一個，在同一個房間重逢
        async _rgMirrorRegister(rg) {
            for (let i = 0; i < BACKENDS.length; i++) { if (i === rg.idx) continue; try { await this._rgTransport(i).rpc('rg_create_room', { p_code: rg.code, p_verifier: rg.keys.verifier }); } catch (_) { /* 這個後端現在不能用或還沒設定 */ } }
        },
        // 把這個群組換到另一個後端（同代號、同密碼）。房間在那邊沒登記過就補登記
        async _rgSwitchTo(rg, idx) {
            const t = this._rgTransport(idx); let res = await t.rpc('rg_join_room', { p_code: rg.code, p_verifier: rg.keys.verifier });
            if (res === 'not_found') { await t.rpc('rg_create_room', { p_code: rg.code, p_verifier: rg.keys.verifier }); res = 'ok'; }
            if (res !== 'ok') throw new Error('房間在那邊拒絕了（' + res + '）');
            await rg.room.reconnect(t); rg.t = t; rg.idx = idx; rg.backend = BACKENDS[idx].name; rg.retry = 0;
            if (rg.files) { const kv = BACKENDS[idx].kind === 'kv'; rg.files.slow = kv ? 10 : 1; rg.files.relayMax = kv ? 256 * 1024 : FaRemoteFiles.RELAY_MAX; }
            this._rgRender(); this._rgScheduleFailback(rg);
        },
        // 目前的通道連不上：依序試其他後端（所有成員用同樣的順序，所以會在同一個地方重逢）
        async _rgFailover(rg) {
            if (this._rg !== rg) return; const n = BACKENDS.length;
            for (let k = 1; k < n; k++) {
                const idx = ((rg.idx || 0) + k) % n;
                try { await this._rgSwitchTo(rg, idx); this._rgLog('原本的通道連不上，已自動改用「' + rg.backend + '」' + (BACKENDS[idx].kind === 'kv' ? '（很慢：訊息可能要幾十秒才到，不要傳大檔）' : '')); return true; }
                catch (e) { this._rgLog('「' + BACKENDS[idx].name + '」也連不上：' + String((e && e.message) || e).slice(0, 60)); }
            }
            this._rgLog('所有通道都暫時連不上，一分鐘後再試');
            setTimeout(() => { if (this._rg === rg) { rg.retry = 0; this._rgScheduleReconnect(rg); } }, 60000);
            return false;
        },
        // 不在原本的後端時，每 5 分鐘看一次原本的恢復了沒有，恢復就搬回去
        _rgScheduleFailback(rg) {
            clearInterval(rg.failbackTimer); if (rg.idx === rg.home) return;
            rg.failbackTimer = setInterval(async () => {
                if (this._rg !== rg) { clearInterval(rg.failbackTimer); return; }
                try { await this._rgTransport(rg.home).rpc('rg_touch_room', { p_code: rg.code, p_verifier: rg.keys.verifier }); } catch (_) { return; }
                try { await this._rgSwitchTo(rg, rg.home); this._rgLog('原本的通道恢復了，已搬回「' + rg.backend + '」'); } catch (_) { /* 下次再試 */ }
            }, 5 * 60 * 1000);
        },
        // 免費專案 7 天沒有任何請求會被暫停：App 啟動後每天對兩個專案各送一個最輕的請求（問一個不存在的房間），Cloudflare Worker 另外每 5 天也會送
        _rgKeepAlive() {
            if (this._rgKeepAliveTimer) return; const KEY = 'fa_remote_keepalive_v1';
            this._rgKeepAliveTimer = setTimeout(async () => {
                let last = {}; try { last = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { last = {}; }
                for (let i = 0; i < BACKENDS.length; i++) {
                    if (BACKENDS[i].kind === 'kv') continue; // 慢速信箱有額度限制，保活由 Worker 每 5 天處理
                    if (Date.now() - (last[i] || 0) < 20 * 3600 * 1000) continue;
                    try { await this._rgTransport(i).rpc('rg_join_room', { p_code: '00000000', p_verifier: 'keepalive' }); last[i] = Date.now(); } catch (_) { /* 沒建好表也算有請求；真的連不上就明天再試 */ last[i] = Date.now() - 19 * 3600 * 1000; }
                }
                try { localStorage.setItem(KEY, JSON.stringify(last)); } catch (_) { /* */ }
            }, 15000);
        },
        // 加入：先問主要專案，找不到這個代號（或連不上）再問備援
        async _rgJoin(name, codeText, password) {
            const code = String(codeText || '').replace(/\D/g, '');
            if (code.length < 8) throw new Error('房間代號是 8 位以上的數字');
            if (!password) throw new Error('請輸入密碼');
            this._rgLastPw = password;
            const R = FaRemoteGroup, keys = await R.deriveKeys(password, code); let netErr = null, hit = null, t = null, idx = 0;
            for (idx = 0; idx < BACKENDS.length; idx++) {
                t = this._rgTransport(idx); let res; try { res = await t.rpc('rg_join_room', { p_code: code, p_verifier: keys.verifier }); } catch (e) { netErr = netErr || this._rgRpcError(e); continue; }
                if (res !== 'not_found') { hit = res; break; }
            }
            if (hit == null) { if (netErr) throw netErr; throw new Error('找不到這個房間（代號錯誤，或已閒置超過 24 小時被回收）'); }
            if (hit === 'bad_password') throw new Error('密碼不對');
            if (hit === 'locked') throw new Error('這個房間因為連續猜錯被暫時鎖住，請稍後再試');
            if (hit !== 'ok') throw new Error('加入失敗：' + hit);
            return this._rgEnter(t, keys, code, name, false, idx);
        },
        _rgRpcError(e) { return e && e.notInstalled ? new Error('房間服務還沒建立：請先到 Supabase 的 SQL Editor 執行 supabase/remote_group.sql（只需要做一次）') : e; },
        async _rgEnter(t, keys, code, name, creator, idx) {
            const R = FaRemoteGroup, s = this._rgSettings(); await this._rgLoadIdentity();
            const room = new R.Room({ transport: t, keys, self: this._rgSelfInfo(name), maxMembers: s.maxMembers });
            const rg = { home: idx || 0, idx: idx || 0, backend: (BACKENDS[idx || 0] || BACKENDS[0]).name, room, t, keys, code, creator, pings: {}, log: [], joinedAt: Date.now(), timer: null };
            room.on('members', () => { this._rgRefreshFps(); this._rgRender(); this._rgSyncTargetSelect(); this._rgOnMembersChange(); });
            room.on('message', (m) => this._rgOnMessage(m));
            room.on('status', (st) => { if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') { this._rgLog('連線狀態：' + st); this._rgScheduleReconnect(rg); } else if (st === 'SUBSCRIBED') { rg.retry = 0; this._rgLog('已連線'); } });
            const r = await room.join();
            if (!r.ok) { try { await room.leave(); } catch (_) { /* */ } throw new Error(r.reason === 'full' ? '群組已滿（上限 ' + s.maxMembers + ' 台）' : '加入失敗'); }
            rg.shared = {}; rg.captures = new Set();
            const ice = this._rgIceServers();
            rg.files = new FaRemoteFiles.FileShare({ room, rtc: ice ? { RTCPeerConnection: window.RTCPeerConnection, iceServers: ice } : undefined, log: (x) => this._rgLog(x), getFile: async (id) => { const rec = await this.fileCache.get(id); return rec && rec.blob ? { blob: rec.blob, name: rec.filename, mime: rec.mimeType } : null; }, allowed: (id, from) => !!(rg.shared[id] && rg.shared[id].has(from)) });
            if (BACKENDS[rg.idx].kind === 'kv') { rg.files.slow = 10; rg.files.relayMax = 256 * 1024; }
            if (creator) this._rgMirrorRegister(rg).catch(() => {});
            this._rgSaveSession(code, this._rgLastPw, name, room.self.nodeId); // 存「想用的名稱」，不存自動加了編號的 this._rgLastPw = null;
            this._rg = rg; FaRemoteDispatch.installTracking.setNotify(() => this._rgPublishSoon()); this._rgSaveSettings({ machineName: room.self.name }); try { await this._rgLoadTasks(); } catch (_) { /* */ }
            rg.timer = setInterval(() => { t.rpc('rg_touch_room', { p_code: code, p_verifier: keys.verifier }).then((ok) => { if (ok === false) this._rgLog('房間已被回收（閒置太久）'); }).catch(() => {}); }, 5 * 60 * 1000);
            this._rgLog((creator ? '已建立群組 ' : '已加入群組 ') + code + (rg.idx ? '（用的是「' + rg.backend + '」）' : '')); this._rgView = 'joined'; this._rgRender();
            return { code, name: room.self.name };
        },
        async _rgLeave() {
            const rg = this._rg; if (!rg) return;
            this._rgClearSession(); clearInterval(rg.timer); clearInterval(rg.agentTimer); FaRemoteDispatch.installTracking.setNotify(null);
            const alone = rg.room.members().filter((m) => m.nodeId !== rg.room.self.nodeId).length === 0;
            clearInterval(rg.failbackTimer);
            if (alone) { for (let i = 0; i < BACKENDS.length; i++) { try { await (i === rg.idx ? rg.t : this._rgTransport(i)).rpc('rg_close_room', { p_code: rg.code, p_verifier: rg.keys.verifier }); } catch (_) { /* 沒關成就等自動回收 */ } } }
            try { await rg.room.leave(); } catch (_) { /* 已斷線 */ }
            this._rg = null; this._rgTarget = ''; this._rgView = 'form'; this._rgRender(); this._rgSyncTargetSelect();
        },
        _rgLog(text) { const rg = this._rg; if (!rg) return; rg.log.unshift(new Date().toLocaleTimeString() + ' ' + text); rg.log.length = Math.min(rg.log.length, 30); if (this._rgView === 'joined') this._rgRenderLog(); },
        async _rgOnMessage(m) {
            const rg = this._rg; if (!rg) return;
            const who = (rg.room.members().find((x) => x.nodeId === m.from) || {}).name || m.from;
            if (m.type === 'ping') { let sig = ''; try { const nonce = m.body && m.body.nonce; if (nonce && this._rgIdent) sig = await this._rgIdent.sign(FaRemoteGroup.canon({ pong: nonce, from: rg.room.self.nodeId, to: m.from })); } catch (_) { /* */ } try { await rg.room.send(m.from, 'pong', { t: m.body && m.body.t, sig }); } catch (_) { /* */ } this._rgLog('收到 ' + who + ' 的連線測試'); }
            else if (m.type === 'pong') { const p = rg.pings[m.from]; if (p && p.t === (m.body && m.body.t)) { const mem = rg.room.members().find((x) => x.nodeId === m.from), sg = m.body && m.body.sig; if (mem && mem.pk && sg && await FaRemoteGroup.verifySig(mem.pk, FaRemoteGroup.canon({ pong: p.nonce, from: m.from, to: rg.room.self.nodeId }), sg)) { rg.proven = rg.proven || {}; rg.proven[m.from] = (rg.fps || {})[m.from]; } p.resolve(Date.now() - p.t); delete rg.pings[m.from]; } }
            else if (m.type === 'rebuild') this._rgOnRebuild(m);
            else if (m.type === 'task') this._rgOnTask(m);
            else if (m.type === 'task_ack' || m.type === 'task_ev') this._rgOnEvent(m);
            else if (m.type === 'task_stop') this._rgOnStop(m);
            else if (m.type === 'task_sync') this._rgOnSync(m);
            else if (m.type === 'settings_get') this._rgOnSettingsGet(m);
            else if (m.type === 'settings_set') this._rgOnSettingsSet(m);
            else if (m.type === 'settings' || m.type === 'settings_ack') this._rgResolveAsk(m);
            else if (m.type === 'agents_req') { try { await rg.room.send(m.from, 'agents', { rid: m.body && m.body.rid, list: this._rgAgentsList() }); } catch (_) { /* */ } }
            else if (m.type === 'agents') { rg.agentLists = rg.agentLists || {}; rg.agentLists[m.from] = { at: Date.now(), list: (m.body && m.body.list) || [] }; this._rgRenderAgents(); }
            else if (/^(file_|rtc_)/.test(m.type)) { /* 內容傳輸：由 FileShare 處理 */ }
            else this._rgLog('收到來自 ' + who + ' 的「' + m.type + '」（不認得的訊息）');
        },
        _rgPing(nodeId) {
            const rg = this._rg; if (!rg) return Promise.reject(new Error('尚未加入群組'));
            return new Promise((resolve, reject) => {
                const wait = 8000 * this._rgSlow(), t = Date.now(); const timer = setTimeout(() => { delete rg.pings[nodeId]; reject(new Error('逾時（' + wait / 1000 + ' 秒沒回應）')); }, wait);
                const nonce = FaRemoteGroup.randomId(); rg.pings[nodeId] = { t, nonce, resolve: (ms) => { clearTimeout(timer); resolve(ms); } };
                rg.room.send(nodeId, 'ping', { t, nonce }).catch((e) => { clearTimeout(timer); delete rg.pings[nodeId]; reject(e); });
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
            panel.addEventListener('contextmenu', (e) => { const n = e.target.closest('[data-rg-name]'); if (!n || !this._rg) return; e.preventDefault(); this._rgOpenMenu(e.clientX, e.clientY, n.dataset.id); });
            // 點在面板外面才收起。注意：點按鈕後面板內容可能立刻被換掉（原本被點的元素已不在畫面上），所以用事件發生當下的路徑判斷，不用 contains
            document.addEventListener('click', (e) => { const path = e.composedPath ? e.composedPath() : []; if (this._rgOpen && !path.includes(panel) && !path.includes(btn) && !path.some((el) => el && el.id === 'ai-rg-menu')) this._rgToggle(false); });
            this._rgRender(); this._rgKeepAlive(); this._rgAutoRejoin();
        },
        // 「交給」選單：已加入群組才出現；選項是其他在線機器
        _rgSyncTargetSelect() {
            const sel = document.getElementById('ai-rg-target'); if (!sel) return;
            const rg = this._rg; if (!rg) { sel.style.display = 'none'; sel.innerHTML = ''; const inp0 = document.getElementById('ai-input-text'); if (inp0 && this._rgPh != null) inp0.placeholder = this._rgPh; try { this._renderChatList(); } catch (_) { /* */ } return; }
            const pal = this._getThemePalette(), cur = this._rgTarget || '';
            sel.style.background = pal.inputBg; sel.style.color = pal.inputText; sel.style.border = '1px solid ' + pal.inputBorder;
            const opts = ['<option value="">交給：本機</option>'].concat(this._rgTargets().map((m) => '<option value="' + this._escapeHtml(m.nodeId) + '"' + (m.allow === false ? ' disabled' : '') + '>交給：' + this._escapeHtml(m.name) + (m.kind === 'desktop' ? '（桌面）' : '（網頁）') + (m.busy ? ' 忙碌' : '') + (m.allow === false ? ' 不接受' : '') + '</option>'));
            sel.innerHTML = opts.join(''); sel.value = this._rgTargets().some((m) => m.nodeId === cur) ? cur : ''; if (sel.value !== cur) this._rgTarget = sel.value;
            sel.style.display = '';
            const inp = document.getElementById('ai-input-text'); if (inp) { if (this._rgPh == null) this._rgPh = inp.placeholder; const tm = this._rgTargets().find((m) => m.nodeId === this._rgTarget); inp.placeholder = tm ? '交給「' + tm.name + '」：輸入需求，會在那台機器開一個新對話…' : this._rgPh; }
            try { this._renderChatList(); } catch (_) { /* 對話清單還沒準備好 */ }
        },
        // ---------------------------------------------------------------- 第 4 階段：機器身分、指紋核對、記錄頁、重建群組
        // 每台機器（每個瀏覽器設定檔）一把簽章金鑰，存在 localStorage；公鑰放在在線名單裡
        async _rgLoadIdentity() {
            if (this._rgIdent) return this._rgIdent; let saved = null; try { saved = JSON.parse(localStorage.getItem('fa_remote_identity_v1') || 'null'); } catch (_) { saved = null; }
            const id = await FaRemoteGroup.makeIdentity(saved); if (id.exported) { try { localStorage.setItem('fa_remote_identity_v1', JSON.stringify(id.exported)); } catch (_) { /* 無痕模式：這次連線有效，下次會是新身分 */ } }
            this._rgIdent = id; return id;
        },
        _rgTrust() { try { return JSON.parse(localStorage.getItem('fa_remote_trust_v1') || '{}') || {}; } catch (_) { return {}; } },
        _rgSetTrust(name, fp) { const all = this._rgTrust(); if (fp) all[name] = fp; else delete all[name]; try { localStorage.setItem('fa_remote_trust_v1', JSON.stringify(all)); } catch (_) { /* */ } },
        // 'trusted'：名字與指紋都跟我核對過的一致；'changed'：這個名字我核對過，但現在指紋不同（可能有人冒名）；'new'：沒核對過；'none'：對方沒有公鑰（舊版）
        _rgTrustState(m) {
            const rg = this._rg; const fp = rg && rg.fps && rg.fps[m.nodeId]; if (!fp) return 'none'; const t = this._rgTrust()[m.name];
            return !t ? 'new' : (t === fp ? 'trusted' : 'changed');
        },
        async _rgRefreshFps() {
            const rg = this._rg; if (!rg) return; rg.fps = rg.fps || {}; let changed = false;
            for (const m of rg.room.members()) { if (!m.pk) continue; const key = m.pk.x + m.pk.y; if (rg.fpKey && rg.fpKey[m.nodeId] === key) continue; rg.fpKey = rg.fpKey || {}; rg.fpKey[m.nodeId] = key; rg.fps[m.nodeId] = await FaRemoteGroup.pubFingerprint(m.pk); changed = true; if (this._rgTrustState(m) === 'changed') this._rgLog('⚠️ ' + m.name + ' 的指紋跟你核對過的不一樣：可能是對方換了電腦，也可能有人冒用這個名字'); }
            if (changed && this._rg === rg) this._rgRenderMembers();
        },
        _rgIceServers() {
            const out = []; String(this._rgSettings().iceServers || '').split(/\n+/).map((l) => l.trim()).filter(Boolean).forEach((l) => { const [url, username, credential] = l.split('|').map((x) => x.trim()); if (/^(stun|turn|turns):/i.test(url)) out.push(username ? { urls: url, username, credential: credential || '' } : { urls: url }); });
            return out.length ? out : undefined;
        },
        _rgOverlay(name) {
            const p = document.getElementById('ai-rg-panel'); if (!p) return null; this._rgToggle(true); const pal = this._getThemePalette(); let ov = p.querySelector('[data-rg="' + name + '"]'); if (ov) ov.remove();
            ov = document.createElement('div'); ov.setAttribute('data-rg', name); ov.style.cssText = 'position:absolute; inset:0; z-index:6; overflow-y:auto; padding:12px; box-sizing:border-box; background:' + pal.windowBg + '; color:' + pal.chatText + ';'; p.appendChild(ov); return ov;
        },
        _rgBtnStyle(pal, primary) { return 'padding:6px 10px; margin:2px 4px 2px 0; border-radius:6px; cursor:pointer; ' + (primary ? 'border:none; background:#76b900; color:#fff; font-weight:bold;' : 'border:1px solid ' + pal.inputBorder + '; background:transparent; color:' + pal.chatText + ';'); },
        // 向對方證明「你真的持有名單上那把公鑰對應的私鑰」：回傳 true／false
        async _rgProve(nodeId) { const rg = this._rg; if (!rg) return false; try { await this._rgPing(nodeId); } catch (_) { return false; } return !!(rg.proven && rg.proven[nodeId] && rg.proven[nodeId] === (rg.fps || {})[nodeId]); },
        async _rgOpenFp(nodeId) {
            const rg = this._rg; if (!rg) return; const m = rg.room.members().find((k) => k.nodeId === nodeId); if (!m) return; const ov = this._rgOverlay('fp'); if (!ov) return;
            const pal = this._getThemePalette(), e = (s) => this._escapeHtml(String(s)), self = nodeId === rg.room.self.nodeId, fp = (rg.fps || {})[nodeId] || '（對方是舊版，沒有身分金鑰）', mine = (rg.fps || {})[rg.room.self.nodeId] || '';
            const draw = () => {
                const st = this._rgTrustState(m), label = { trusted: '✅ 已核對，指紋一致', changed: '⚠️ 這個名字你核對過，但指紋不同了：先別信任，跟本人確認', new: '尚未核對', none: '無法核對' }[st];
                ov.innerHTML = '<div style="font-weight:bold; margin-bottom:8px;">🔑 指紋核對：' + e(m.name) + (self ? '（這台）' : '') + '</div>'
                    + '<div style="font-size:12px; opacity:.85; margin-bottom:6px;">機器名稱誰都可以取，無法證明身分。請用電話、當面或其他管道，請對方念出<b>他那台顯示的指紋</b>，跟下面的比對；一致才按「信任」。</div>'
                    + '<div style="font-size:11px; opacity:.7;">' + (self ? '這台的指紋' : '對方的指紋') + '</div><div style="font-family:monospace; font-size:20px; letter-spacing:1px; margin:2px 0 8px; word-break:break-all;">' + e(fp) + '</div>'
                    + (self ? '' : '<div style="font-size:11px; opacity:.7;">你自己的指紋（對方核對你時用）</div><div style="font-family:monospace; font-size:14px; margin:2px 0 8px;">' + e(mine) + '</div>')
                    + '<div data-fp="state" style="margin:6px 0; font-size:12px; color:' + (st === 'trusted' ? '#76b900' : st === 'changed' ? '#f87171' : 'inherit') + ';">' + label + '</div>'
                    + '<div data-fp="proof" style="margin:6px 0; font-size:12px; min-height:16px;"></div>'
                    + (self ? '' : '<div><button type="button" data-fp-act="prove" style="' + this._rgBtnStyle(pal) + '">驗證對方真的持有這把金鑰</button>' + (st === 'trusted' ? '<button type="button" data-fp-act="untrust" style="' + this._rgBtnStyle(pal) + '">取消信任</button>' : (fp.indexOf('-') > 0 ? '<button type="button" data-fp-act="trust" style="' + this._rgBtnStyle(pal, true) + '">指紋一致，信任</button>' : '')) + '</div>')
                    + '<div style="margin-top:8px;"><button type="button" data-fp-act="close" style="' + this._rgBtnStyle(pal) + '">關閉</button></div>';
            };
            draw();
            ov.addEventListener('click', async (ev) => {
                const a = ev.target.closest('[data-fp-act]'); if (!a) return; const act = a.dataset.fpAct;
                if (act === 'close') { ov.remove(); return; }
                if (act === 'trust') { this._rgSetTrust(m.name, (rg.fps || {})[nodeId]); this._rgLog('已信任 ' + m.name + ' 的指紋'); draw(); this._rgRenderMembers(); }
                else if (act === 'untrust') { this._rgSetTrust(m.name, null); draw(); this._rgRenderMembers(); }
                else if (act === 'prove') { const el = ov.querySelector('[data-fp="proof"]'); el.textContent = '驗證中…'; const ok = await this._rgProve(nodeId); el.textContent = ok ? '✅ 對方通過了金鑰持有證明（上面的指紋確實是這台機器自己的）' : '❌ 沒有通過：對方沒回應、是舊版，或名單上的公鑰不是它自己的'; el.style.color = ok ? '#76b900' : '#f87171'; }
            });
        },
        // 記錄頁：這台機器替別人執行過的需求（誰、什麼、結果）。存在這個瀏覽器的 IndexedDB，保留最近 20 筆
        _rgOpenLog() {
            const rg = this._rg; if (!rg) return; const ov = this._rgOverlay('log'); if (!ov) return; const pal = this._getThemePalette(), e = (s) => this._escapeHtml(String(s));
            const jobs = Object.values(rg.exec || {}).sort((a, b) => (b.at || 0) - (a.at || 0));
            const state = (j) => { const last = [...j.events].reverse().find((x) => FaRemoteDispatch.TERMINAL[x.kind]); return last ? ({ done: '✅ 完成', failed: '❌ 失敗', stopped: '⏹ 已停止', rejected: '🚫 被拒絕' }[last.kind]) : '⏳ 進行中'; };
            const detail = (j) => { const last = [...j.events].reverse().find((x) => FaRemoteDispatch.TERMINAL[x.kind]) || {}; const refs = (last.refs || []).map((r) => r.name).join('、'); return '<div style="margin:4px 0; white-space:pre-wrap; opacity:.9;">' + e(j.text) + '</div>' + (last.text ? '<div style="margin:4px 0; padding:4px; border-radius:4px; background:rgba(128,128,128,.15); white-space:pre-wrap;">' + e(String(last.text).slice(0, 1500)) + '</div>' : '') + (last.error ? '<div style="color:#f87171;">' + e(last.error) + '</div>' : '') + (refs ? '<div style="opacity:.8;">📎 ' + e(refs) + '</div>' : '') + '<div style="opacity:.6;">事件 ' + j.events.length + ' 筆' + (j.at && last.seq ? '' : '') + '</div>'; };
            ov.innerHTML = '<div style="font-weight:bold; margin-bottom:6px;">📜 執行記錄（這台替別人做過的事）</div><div style="font-size:11px; opacity:.75; margin-bottom:8px;">只存在這個瀏覽器，最近 20 筆。點一筆看內容與結果。</div>'
                + (jobs.length ? jobs.map((j, i) => '<div data-lg="' + i + '" style="border:1px solid rgba(128,128,128,.35); border-radius:6px; padding:6px; margin-bottom:6px; font-size:12px; cursor:pointer;"><div><b>' + e(j.fromName) + '</b>　' + (j.sub ? '子任務' : '需求') + '　' + state(j) + '</div><div style="opacity:.7; font-size:11px;">' + (j.at ? new Date(j.at).toLocaleString() : '') + '</div><div style="opacity:.9;">' + e(String(j.text).replace(/\s+/g, ' ').slice(0, 60)) + '</div><div data-lg-body="' + i + '" style="display:none; margin-top:6px; font-size:11px;">' + detail(j) + '</div></div>').join('') : '<div style="opacity:.7;">（還沒有記錄）</div>')
                + '<div style="margin-top:8px;"><button type="button" data-lg-act="clear" style="' + this._rgBtnStyle(pal) + '">清除記錄</button><button type="button" data-lg-act="close" style="' + this._rgBtnStyle(pal) + '">關閉</button></div>';
            ov.addEventListener('click', async (ev) => {
                const a = ev.target.closest('[data-lg-act]'); if (a) { if (a.dataset.lgAct === 'close') ov.remove(); else if (window.confirm('清除這台機器的執行記錄？（不會影響正在執行的任務）')) { await this._rgClearTasks(); this._rgLog('已清除執行記錄'); this._rgOpenLog(); } return; }
                const row = ev.target.closest('[data-lg]'); if (row) { const b = row.querySelector('[data-lg-body]'); b.style.display = b.style.display === 'none' ? '' : 'none'; }
            });
        },
        // 重建群組：產生新代號與新密碼的新房間。notify=true：把新代號密碼傳給現在在線的每個人，大家確認後一起搬；
        // notify=false（要踢人用）：只建立新房間並關掉舊房間的登記，新代號密碼由你用別的管道告訴要留下的人——因為舊頻道裡所有人（包含要踢的）都讀得到訊息
        async _rgRebuild(notify, target) {
            const rg = this._rg; if (!rg) throw new Error('尚未加入群組'); const name = rg.room.self.name, pw = FaRemoteGroup.generatePassword(); this._rgLastPw = pw;
            const idx = target == null || target === '' ? (rg.idx || 0) : Number(target), reg = await this._rgRegister(pw, [idx]); let sent = 0; rg.rebuilding = true;
            if (notify) { for (const m of this._rgTargets()) { try { await this._rgSend(m.nodeId, 'rebuild', { code: reg.code, password: pw, fromName: name }); sent++; } catch (_) { /* 這個人沒收到：之後用代號密碼手動加入 */ } } await new Promise((r) => setTimeout(r, 1500)); }
            else { try { await rg.t.rpc('rg_close_room', { p_code: rg.code, p_verifier: rg.keys.verifier }); } catch (_) { /* 沒關成就等 24 小時自動回收 */ } }
            await this._rgLeave(true);
            await this._rgEnter(reg.t, reg.keys, reg.code, name, true, idx);
            return { code: reg.code, password: pw, sent };
        },
        _rgOpenRebuild() {
            const rg = this._rg; if (!rg) return; const ov = this._rgOverlay('rebuild'); if (!ov) return; const pal = this._getThemePalette(), e = (s) => this._escapeHtml(String(s));
            ov.innerHTML = '<div style="font-weight:bold; margin-bottom:8px;">🔄 重建群組</div>'
                + '<div style="font-size:12px; line-height:1.6;">會建立一個<b>新代號與新密碼</b>的房間，這台先搬過去。沒有伺服器能強制踢人，所以要踢人只能換密碼。</div>'
                + '<div style="margin:10px 0 4px; font-weight:bold; font-size:12px;">選一種方式</div>'
                + '<label style="display:flex; gap:6px; font-size:12px; margin-bottom:6px;"><input type="radio" name="rbm" value="notify" checked><span><b>通知現在在線的所有人，大家確認後一起搬</b>（換密碼、換代號，但沒有要踢人）</span></label>'
                + '<label style="display:flex; gap:6px; font-size:12px; margin-bottom:8px;"><input type="radio" name="rbm" value="silent"><span><b>只換不通知</b>（要踢人用）：舊房間會被關掉登記，新代號與密碼我顯示給你，由你用電話等管道告訴要留下的人。<b>不要</b>在舊群組裡傳，被踢的人也看得到。</span></label>'
                + '<div style="font-size:12px; margin-bottom:8px;">新群組放在：<select data-rb="target" style="max-width:100%;"><option value="0">主要 Supabase 專案</option><option value="1">備援 Supabase 專案</option><option value="2">慢速備援（Cloudflare，很慢）</option></select><div style="opacity:.7; margin-top:2px;">目前在「' + e(rg.backend || '主要') + '」；現在的專案流量用完或連不上時才需要換。</div></div>'
                + '<div data-rb="msg" style="min-height:16px; font-size:12px; margin:6px 0;"></div>'
                + '<button type="button" data-rb-act="go" style="' + this._rgBtnStyle(pal, true) + '">建立新群組並搬過去</button><button type="button" data-rb-act="close" style="' + this._rgBtnStyle(pal) + '">取消</button>';
            ov.querySelector('[data-rb="target"]').value = String(rg.idx || 0);
            ov.addEventListener('click', async (ev) => {
                const a = ev.target.closest('[data-rb-act]'); if (!a) return; if (a.dataset.rbAct === 'close') { ov.remove(); return; }
                const notify = ov.querySelector('input[name="rbm"]:checked').value === 'notify', msg = ov.querySelector('[data-rb="msg"]');
                if (!window.confirm(notify ? '要重建群組並通知在線的 ' + this._rgTargets().length + ' 台機器嗎？' : '要重建群組嗎？舊房間會被關掉，其他人需要你另外通知新的代號與密碼才能進去。')) return;
                a.disabled = true; msg.textContent = '建立中（推導金鑰需要幾秒）…';
                try {
                    const r = await this._rgRebuild(notify, ov.querySelector('[data-rb="target"]').value); const p = document.getElementById('ai-rg-panel'); if (p) { p.dataset.view = ''; this._rgView = 'joined'; this._rgRender(); }
                    const ov2 = this._rgOverlay('rebuilt'); if (!ov2) return;
                    ov2.innerHTML = '<div style="font-weight:bold; margin-bottom:8px;">✅ 新群組已建立</div><div style="font-size:12px;">代號</div><div style="font-size:20px; font-weight:bold;">' + e(r.code) + '</div><div style="font-size:12px; margin-top:6px;">密碼（只顯示這一次，請先複製存好）</div><div style="font-family:monospace; font-size:14px; word-break:break-all; user-select:all;">' + e(r.password) + '</div>'
                        + '<div style="font-size:12px; margin:8px 0;">' + (notify ? '已通知 ' + r.sent + ' 台機器，對方確認後會自動搬過來。沒有跟過來的人，用上面的代號與密碼手動加入。' : '舊房間已關閉登記。把上面的代號與密碼用其他管道告訴要留下的人。') + '</div>'
                        + '<button type="button" data-rb2="copy" style="' + this._rgBtnStyle(pal) + '">複製密碼</button><button type="button" data-rb2="close" style="' + this._rgBtnStyle(pal, true) + '">我已存好</button>';
                    ov2.addEventListener('click', async (e2) => { const b = e2.target.closest('[data-rb2]'); if (!b) return; if (b.dataset.rb2 === 'copy') { try { await navigator.clipboard.writeText(r.password); b.textContent = '已複製'; } catch (_) { /* */ } } else ov2.remove(); });
                } catch (err) { msg.textContent = '失敗：' + String((err && err.message) || err); msg.style.color = '#f87171'; a.disabled = false; }
            });
        },
        // 收到別人要搬家的通知：驗證簽章、顯示是誰與核對狀態，使用者確認才搬
        async _rgOnRebuild(m) {
            const rg = this._rg; if (!rg || rg.rebuilding) return; const b = m.body || {}; const bad = await this._rgVerify(m); const who = this._rgTargetName(m.from) || m.from;
            if (bad || typeof b.code !== 'string' || typeof b.password !== 'string') { this._rgLog('忽略了一則搬家通知（' + (bad || '格式不對') + '）'); return; }
            const mem = rg.room.members().find((x) => x.nodeId === m.from), st = mem ? this._rgTrustState(mem) : 'new';
            this._rgToggle(true); const ok = window.confirm(who + (st === 'trusted' ? '（已核對的機器）' : st === 'changed' ? '（⚠️ 指紋跟你核對過的不同）' : '（尚未核對指紋）') + ' 要把群組搬到新房間 ' + b.code + '（新密碼）。\n\n要跟著搬嗎？按「取消」就留在目前的群組。');
            if (!ok) { this._rgLog('沒有跟著 ' + who + ' 搬到新房間'); return; }
            const name = rg.room.self.name; rg.rebuilding = true;
            try { await this._rgLeave(); await this._rgJoin(name, b.code, b.password); this._rgLog('已跟著 ' + who + ' 搬到新房間 ' + b.code); }
            catch (e) { this._rgLog('搬到新房間失敗：' + String((e && e.message) || e) + '（請用新代號與密碼手動加入）'); }
        },
        // ---------------------------------------------------------------- 右鍵選單與「設置分派規則」
        _rgOpenMenu(x, y, nodeId) {
            const rg = this._rg; if (!rg) return; const m = rg.room.members().find((k) => k.nodeId === nodeId); if (!m) return;
            document.getElementById('ai-rg-menu') && document.getElementById('ai-rg-menu').remove();
            const pal = this._getThemePalette(), self = nodeId === rg.room.self.nodeId, menu = document.createElement('div'); menu.id = 'ai-rg-menu';
            menu.style.cssText = 'position:fixed; z-index:1000001; min-width:150px; padding:4px 0; border-radius:8px; font-size:12px; box-shadow:0 4px 16px rgba(0,0,0,.4); background:' + pal.windowBg + '; color:' + pal.chatText + '; border:1px solid ' + pal.windowBorder + ';';
            const items = [['rules', '⚙️ 設置分派規則…'], ['agents', '🧩 查看子任務']].concat(self ? [] : [['ping', '📡 測試連線']]).concat([['fp', '🔑 核對指紋…'], ['copy', '📋 複製機器名稱']]);
            menu.innerHTML = '<div style="padding:4px 12px; font-size:11px; opacity:.7;">' + this._escapeHtml(m.name) + '</div>' + items.map(([a, l]) => '<div data-menu="' + a + '" style="padding:6px 12px; cursor:pointer;">' + l + '</div>').join('');
            menu.style.left = Math.min(x, window.innerWidth - 180) + 'px'; menu.style.top = Math.min(y, window.innerHeight - 160) + 'px'; document.body.appendChild(menu);
            menu.querySelectorAll('[data-menu]').forEach((el) => { el.onmouseenter = () => { el.style.background = 'rgba(118,185,0,.25)'; }; el.onmouseleave = () => { el.style.background = ''; }; });
            const close = () => { menu.remove(); document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', esc, true); };
            const off = (ev) => { if (!menu.contains(ev.target)) close(); }, esc = (ev) => { if (ev.key === 'Escape') close(); };
            setTimeout(() => { document.addEventListener('pointerdown', off, true); document.addEventListener('keydown', esc, true); }, 0);
            menu.addEventListener('click', async (ev) => {
                const a = ev.target.closest('[data-menu]'); if (!a) return; const act = a.dataset.menu; close();
                if (act === 'rules') this._rgOpenRules(nodeId);
                else if (act === 'agents') { if (rg.agentView !== nodeId) await this._rgToggleAgents(nodeId); }
                else if (act === 'ping') { const out = document.querySelector('#ai-rg-panel [data-rg-ping="' + nodeId + '"]'); if (out) out.textContent = '…'; try { const ms = await this._rgPing(nodeId); if (out) { out.textContent = ms + ' ms'; out.style.color = '#76b900'; } } catch (e) { if (out) { out.textContent = '失敗'; out.style.color = '#f87171'; } } }
                else if (act === 'fp') this._rgOpenFp(nodeId);
                else if (act === 'copy') { try { await navigator.clipboard.writeText(m.name); } catch (_) { /* */ } }
            });
        },
        async _rgOpenRules(nodeId) {
            const rg = this._rg, p = document.getElementById('ai-rg-panel'); if (!rg || !p) return; const m = rg.room.members().find((k) => k.nodeId === nodeId); if (!m) return;
            this._rgToggle(true); const pal = this._getThemePalette(), e = (s) => this._escapeHtml(String(s)), self = nodeId === rg.room.self.nodeId, inp = this._rgInputStyle(pal);
            let ov = p.querySelector('[data-rg="rules"]'); if (ov) ov.remove();
            ov = document.createElement('div'); ov.setAttribute('data-rg', 'rules'); ov.style.cssText = 'position:absolute; inset:0; z-index:6; overflow-y:auto; padding:12px; box-sizing:border-box; background:' + pal.windowBg + '; color:' + pal.chatText + ';';
            const pref = this._rgPrefOf(m.name);
            ov.innerHTML = '<div style="font-weight:bold; margin-bottom:8px;">⚙️ 設置分派規則：' + e(m.name) + (self ? '（這台）' : '') + '</div>'
                + '<div style="font-weight:bold; margin:6px 0 4px;">這台機器的設定' + (self ? '' : '（遠端修改，送到對方套用）') + '</div><div data-rl="remote" style="font-size:12px;">讀取中…</div>'
                + '<div style="font-weight:bold; margin:12px 0 4px;">我這邊的分派偏好（只存在我的瀏覽器）</div>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;"><input type="checkbox" data-rl="auto" ' + (pref.auto !== false ? 'checked' : '') + '> 參與「auto」自動挑選</label>'
                + '<label style="font-size:12px;">優先順序（數字大的優先）</label><input type="number" min="1" max="10" data-rl="priority" value="' + pref.priority + '" style="' + inp + '">'
                + '<label style="font-size:12px;">範圍</label><select data-rl="scope" style="' + inp + '"><option value="all">全部子任務</option><option value="only">只限含有這些關鍵字的</option><option value="except">排除含有這些關鍵字的</option></select>'
                + '<label style="font-size:12px;">關鍵字（用逗號分開，例如：程式, 簡報）</label><input data-rl="words" value="' + e(pref.words) + '" style="' + inp + '">'
                + '<label style="font-size:12px;">從我這邊最多同時分幾個給它</label><input type="number" min="1" max="16" data-rl="maxFromMe" value="' + pref.maxFromMe + '" style="' + inp + '">'
                + '<label style="font-size:12px;">備註</label><input data-rl="note" value="' + e(pref.note) + '" style="' + inp + '">'
                + '<div data-rl="msg" style="min-height:16px; font-size:12px; margin:6px 0;"></div>'
                + '<div style="display:flex; gap:8px;"><button type="button" data-rl-act="save" style="flex:1; padding:8px; border:none; border-radius:6px; background:#76b900; color:#fff; font-weight:bold; cursor:pointer;">儲存</button><button type="button" data-rl-act="cancel" style="flex:1; padding:8px; border:1px solid ' + pal.inputBorder + '; border-radius:6px; background:transparent; color:' + pal.chatText + '; cursor:pointer;">取消</button></div>';
            p.appendChild(ov); ov.querySelector('[data-rl="scope"]').value = pref.scope;
            const q = (n) => ov.querySelector('[data-rl="' + n + '"]'), say = (txt, ok) => { const el = q('msg'); el.textContent = txt; el.style.color = ok ? '#76b900' : '#f87171'; };
            let loaded = null;
            const paintRemote = (v) => { loaded = v; q('remote').innerHTML = '<label style="display:flex; gap:6px; align-items:center; margin-bottom:4px;"><input type="checkbox" data-rr="allowDispatch" ' + (v.allowDispatch ? 'checked' : '') + '> 允許其他機器派工給它</label>'
                + '<label style="display:flex; gap:6px; align-items:center; margin-bottom:4px;"><input type="checkbox" data-rr="acceptSubtasks" ' + (v.acceptSubtasks ? 'checked' : '') + '> 接受子任務分工</label>'
                + '<label style="display:flex; gap:6px; align-items:center; margin-bottom:4px;"><input type="checkbox" data-rr="readonlySandbox" ' + (v.readonlySandbox ? 'checked' : '') + '> 只允許唯讀與沙盒工具</label>'
                + '<label style="display:flex; gap:6px; align-items:center; margin-bottom:4px;">同時處理遠端任務上限 <input type="number" min="1" max="16" data-rr="maxParallel" value="' + v.maxParallel + '" style="width:50px; padding:2px;"> 個</label>'; };
            if (self) paintRemote(this._rgRemoteValues());
            else this._rgAsk(nodeId, 'settings_get', {}, 'settings', 6000).then((r) => paintRemote(r.values || {})).catch((err) => { q('remote').textContent = '讀取失敗：' + err.message + '（仍可儲存我這邊的偏好）'; });
            ov.addEventListener('click', async (ev) => {
                const a = ev.target.closest('[data-rl-act]'); if (!a) return;
                if (a.dataset.rlAct === 'cancel') { ov.remove(); return; }
                this._rgSavePref(m.name, { auto: q('auto').checked, priority: Math.max(1, Math.min(10, Number(q('priority').value) || 5)), scope: q('scope').value, words: q('words').value, maxFromMe: Math.max(1, Math.min(16, Number(q('maxFromMe').value) || 3)), note: q('note').value });
                if (loaded) {
                    const next = {}; ov.querySelectorAll('[data-rr]').forEach((el) => { next[el.dataset.rr] = el.type === 'checkbox' ? el.checked : Number(el.value); });
                    const patch = {}; Object.keys(next).forEach((k) => { if (next[k] !== loaded[k]) patch[k] = next[k]; });
                    if (Object.keys(patch).length) {
                        try {
                            if (self) this._rgApplySettings(this._rgSanitizeSettings(patch));
                            else { const r = await this._rgAsk(nodeId, 'settings_set', { patch }, 'settings_ack', 6000); if (!r.ok) { say('對方沒有接受：' + (r.error || ''), false); return; } this._rgLog('已修改 ' + m.name + ' 的設定：' + Object.keys(patch).join('、')); }
                        } catch (err) { say('遠端設定沒有送達：' + err.message + '（我這邊的偏好已儲存）', false); return; }
                    }
                }
                say('已儲存', true); setTimeout(() => { if (ov.parentNode) ov.remove(); }, 700);
            });
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
                + '<div data-rg="msg" style="margin-top:8px; font-size:12px; color:#f87171; white-space:pre-wrap;">' + e(this._rgFormNote || '') + '</div>';
        },
        _rgBuildJoined(p, pal) {
            const e = (s) => this._escapeHtml(String(s)), rg = this._rg, st = this._rgSettings(), pal0 = pal, btn = 'padding:3px 8px; cursor:pointer; border:1px solid ' + pal.inputBorder + '; border-radius:6px; background:transparent; color:' + pal.chatText + ';';
            p.dataset.view = 'joined';
            p.innerHTML = '<div style="font-weight:bold; margin-bottom:6px;">🌐 遠端群組</div>'
                + '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;"><span style="font-size:11px; opacity:.8;">房間代號</span><b style="font-size:18px; letter-spacing:1px;">' + e(rg.code) + '</b>' + (rg.idx ? '<span style="font-size:10px; color:#e2a03f;">（' + e(rg.backend) + '）</span>' : '') + '<button type="button" data-rg-act="copy" style="' + btn + '">複製</button></div>'
                + '<div style="font-size:11px; opacity:.85; margin-bottom:8px;">這台：<b>' + e(rg.room.self.name) + '</b>（' + (rg.room.self.kind === 'desktop' ? '桌面' : '網頁') + '）　指紋 <span data-rg="fp">…</span></div>'
                + '<div style="font-weight:bold; margin:8px 0 4px;">機器清單</div><div data-rg="members"></div><div data-rg="agentbox"></div>'
                + '<div style="font-weight:bold; margin:12px 0 4px;">設定</div>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;"><input type="checkbox" data-rg="allow" ' + (st.allowDispatch ? 'checked' : '') + '> 允許其他機器派工給我</label>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;"><input type="checkbox" data-rg="sub" ' + (st.acceptSubtasks ? 'checked' : '') + '> 接受子任務分工（別人的 AI 可以把子任務分給這台）</label>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;"><input type="checkbox" data-rg="ro" ' + (st.readonlySandbox ? 'checked' : '') + '> 只允許唯讀與沙盒工具</label>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;">同時處理遠端任務上限 <input type="number" min="1" max="16" data-rg="par" value="' + st.maxParallel + '" style="width:50px; padding:2px;"> 個</label>'
                + '<label style="display:flex; gap:6px; align-items:center; font-size:12px; margin-bottom:4px;">人數上限 <input type="number" min="2" max="64" data-rg="max" value="' + st.maxMembers + '" style="width:60px; padding:2px;"> 台（下次加入時生效）</label>'
                + '<label style="display:flex; gap:6px; align-items:flex-start; font-size:12px; margin-bottom:4px;"><input type="checkbox" data-rg="trusted" ' + (st.onlyTrusted ? 'checked' : '') + ' style="margin-top:2px;"> <span>🔒 限制模式：只接受<b>已核對指紋</b>的機器的需求與設定</span></label>'
                + '<details style="font-size:12px; margin:4px 0;"><summary style="cursor:pointer;">進階：直連的備用伺服器（TURN／STUN）</summary><div style="opacity:.75; margin:4px 0;">兩台機器直連失敗（公司網路、對稱式 NAT）時，檔案會改走轉送（單檔上限約 16MB）。有自己的 TURN 伺服器可以填在這裡，一行一個，格式：<code>turn:主機:3478|帳號|密碼</code> 或 <code>stun:主機:3478</code>。下次加入群組時生效。</div><textarea data-rg="ice" rows="3" style="width:100%; box-sizing:border-box;">' + e(st.iceServers || '') + '</textarea></details>'
                + '<div style="font-size:11px; opacity:.7; margin:4px 0 8px;">在對話輸入框旁的「交給」選一台機器，之後這個對話的需求就由那台機器完成。對方產生的檔案、影片、簡報會在對話裡顯示成卡片，可以直接開啟或存到這邊。</div>'
                + '<div style="display:flex; gap:6px; margin-bottom:8px;"><button type="button" data-rg-act="log" style="flex:1; padding:6px; cursor:pointer; border:1px solid ' + pal.inputBorder + '; border-radius:6px; background:transparent; color:' + pal.chatText + ';">📜 執行記錄</button><button type="button" data-rg-act="rebuild" style="flex:1; padding:6px; cursor:pointer; border:1px solid ' + pal.inputBorder + '; border-radius:6px; background:transparent; color:' + pal.chatText + ';">🔄 重建群組</button></div>'
                + '<button type="button" data-rg-act="leave" style="width:100%; padding:8px; border:1px solid #ef4444; border-radius:6px; background:transparent; color:#ef4444; font-weight:bold; cursor:pointer;">離開群組</button>'
                + '<div style="font-weight:bold; margin:12px 0 4px;">最近事件</div><div data-rg="log" style="font-size:11px; opacity:.85; line-height:1.5;"></div>';
            this._rgRefreshFps().then(() => { const el = p.querySelector('[data-rg="fp"]'); if (el) el.textContent = (rg.fps || {})[rg.room.self.nodeId] || '—'; });
            this._rgRenderMembers(); this._rgRenderLog();
        },
        _rgRenderMembers() {
            const p = document.getElementById('ai-rg-panel'), rg = this._rg; if (!p || !rg) return; const box = p.querySelector('[data-rg="members"]'); if (!box) return;
            const e = (s) => this._escapeHtml(String(s)), me = rg.room.self.nodeId;
            box.innerHTML = rg.room.members().map((m) => '<div style="display:flex; align-items:center; gap:6px; padding:3px 0;">🟢 <span data-rg-name="1" data-id="' + e(m.nodeId) + '" title="按右鍵：設置分派規則、測試連線、查看子任務" style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:context-menu;"><b>' + e(m.name) + '</b>' + (m.nodeId === me ? '（這台）' : '') + '</span>' + this._rgBadge(m) + '<span style="font-size:10px; opacity:.7;">' + (m.kind === 'desktop' ? '桌面' : '網頁') + (m.busy ? '・忙碌' : '') + (m.allow === false ? '・不接受派工' : '') + (m.sub ? '・可分工' : '') + (m.agents ? '・跑 ' + m.agents + ' 個子任務' : '') + '</span>'
                + '<button type="button" data-rg-act="agents" data-id="' + e(m.nodeId) + '" title="看這台機器現在跑的子任務" style="padding:1px 6px; font-size:11px; cursor:pointer;">子任務</button>'
                + (m.nodeId === me ? '' : '<button type="button" data-rg-act="ping" data-id="' + e(m.nodeId) + '" style="padding:1px 6px; font-size:11px; cursor:pointer;">測試</button>') + '<span data-rg-ping="' + e(m.nodeId) + '" style="font-size:10px; min-width:44px;"></span></div>').join('') || '<div style="opacity:.7;">（沒有其他機器在線）</div>';
            const btn = document.getElementById('ai-rg-btn'); if (btn) btn.textContent = this._rgBtnLabel();
        },
        _rgBadge(m) { const st = this._rgTrustState(m); const x = { trusted: ['✔', '#76b900', '指紋已核對'], changed: ['⚠', '#f87171', '指紋跟你核對過的不一樣！'], new: ['？', '#999', '指紋還沒核對（右鍵→核對指紋）'], none: ['', '#999', ''] }[st]; return x[0] ? '<span data-rg-act="fp" data-id="' + this._escapeHtml(m.nodeId) + '" title="' + x[2] + '" style="cursor:pointer; color:' + x[1] + '; font-weight:bold;">' + x[0] + '</span>' : ''; },
        // ---------------------------------------------------------------- 重新整理後自動回到群組
        // 網頁與桌面版都存在 localStorage：重新整理、關掉重開都會自動回到群組（離開群組才會清掉）。存的是代號、密碼與名稱。
        // 節點代號另外存在 sessionStorage（每個分頁各一個、重新整理後沿用）：這樣重新整理時舊的在線登記會被取代，不會多出一台「幽靈」機器，
        // 同一個瀏覽器開多個分頁也各是一台獨立的機器（名稱自動加編號）。
        _rgSessStore() { try { return localStorage; } catch (_) { return null; } },
        _rgSaveSession(code, pw, name, nodeId) { const s = this._rgSessStore(); if (!s || !pw) return; try { s.setItem('fa_remote_session_v1', JSON.stringify({ code, pw, name })); } catch (_) { /* 無痕模式：重新整理後要重新加入 */ } try { sessionStorage.setItem('fa_remote_nodeid_v1', nodeId); } catch (_) { /* */ } },
        _rgClearSession() { const s = this._rgSessStore(); try { s && s.removeItem('fa_remote_session_v1'); } catch (_) { /* */ } },
        async _rgAutoRejoin() {
            if (this._rg || this._rgRejoining) return; const s = this._rgSessStore(); let sess = null; try { sess = JSON.parse((s && s.getItem('fa_remote_session_v1')) || 'null'); } catch (_) { sess = null; }
            if (!sess || !sess.code || !sess.pw) return;
            this._rgRejoining = true; const btn = document.getElementById('ai-rg-btn'); if (btn) btn.textContent = '🌐 重新連線中…';
            try { try { this._rgNodeIdWanted = sessionStorage.getItem('fa_remote_nodeid_v1') || null; } catch (_) { this._rgNodeIdWanted = null; } await this._rgJoin(sess.name || this._rgSettings().machineName, sess.code, sess.pw); this._rgLog('重新整理後已自動回到群組 ' + sess.code); }
            catch (e) { this._rgClearSession(); this._rgFormNote = '自動回到群組 ' + sess.code + ' 失敗：' + String((e && e.message) || e) + '（請重新加入）'; this._rgView = 'form'; }
            finally { this._rgNodeIdWanted = null; this._rgRejoining = false; this._rgRender(); }
        },
        // ---------------------------------------------------------------- 左邊對話清單裡的「遠端機器」
        _rgChatListSig() { const rg = this._rg; if (!rg) return ''; return JSON.stringify([this._rgTarget || '', rg.room.members().map((m) => [m.nodeId, m.name, m.busy ? 1 : 0, m.allow === false ? 0 : 1, m.agents || 0])]); },
        _rgRenderChatListMachines(list) {
            const rg = this._rg; if (!rg) return; const others = this._rgTargets(), e = (s) => this._escapeHtml(String(s));
            const head = document.createElement('div'); head.className = 'cl-machine-head'; head.style.cssText = 'padding:6px 8px 3px; font-size:11px; opacity:.75; font-weight:bold;'; head.textContent = '🌐 遠端機器（點一下＝之後的需求在那台開新對話）'; list.appendChild(head);
            if (!others.length) { const none = document.createElement('div'); none.style.cssText = 'padding:3px 12px 6px; font-size:12px; opacity:.6;'; none.textContent = '（沒有其他機器在線）'; list.appendChild(none); }
            for (const m of others) {
                const el = document.createElement('div'); el.dataset.rgMachine = m.nodeId; el.title = '點一下：把之後的需求交給它（會在那台機器開一個新對話）；再點一次取消。右鍵：設置分派規則、指紋核對、測試連線';
                el.style.cssText = 'display:flex; align-items:center; gap:6px; padding:5px 10px; margin:1px 4px; border-radius:6px; cursor:pointer; font-size:13px;' + (this._rgTarget === m.nodeId ? ' background:var(--cl-active);' : '') + (m.allow === false ? ' opacity:.55;' : '');
                el.innerHTML = '<span>🖥️</span><span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + e(m.name) + '</span><span style="font-size:10px; opacity:.7;">' + (m.kind === 'desktop' ? '桌面' : '網頁') + (m.busy ? '・忙碌' : '') + (m.allow === false ? '・不接受' : '') + (m.agents ? '・' + m.agents + ' 個子任務' : '') + '</span>' + (this._rgTarget === m.nodeId ? '<span>✓</span>' : '');
                el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); this._rgOpenMenu(ev.clientX, ev.clientY, m.nodeId); });
                list.appendChild(el);
            }
            const sep = document.createElement('div'); sep.style.cssText = 'height:1px; margin:6px 8px; background:var(--cl-border);'; list.appendChild(sep);
        },
        _rgPickMachine(nodeId) {
            const m = this._rgTargets().find((x) => x.nodeId === nodeId); if (!m) return;
            if (m.allow === false && this._rgTarget !== nodeId) { this._pushAssistantMessage('⚠️ ' + m.name + ' 目前不接受遠端需求（對方關掉了「允許其他機器派工給我」）。', null); this._renderMessageHistory(); return; }
            this._rgTarget = this._rgTarget === nodeId ? '' : nodeId; this._rgSyncTargetSelect();
            const inp = document.getElementById('ai-input-text'); if (inp) inp.focus();
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
            if (t.dataset.rg === 'trusted') this._rgSaveSettings({ onlyTrusted: t.checked });
            if (t.dataset.rg === 'ice') this._rgSaveSettings({ iceServers: t.value });
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
            if (act === 'fp') { this._rgOpenFp(t.dataset.id); return; }
            if (act === 'log') { this._rgOpenLog(); return; }
            if (act === 'rebuild') { this._rgOpenRebuild(); return; }
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
                    const codeText = act === 'join' ? q('code').value : ''; // 要在換成「忙碌」畫面之前讀：換畫面會把表單清掉
                    this._rgBusy(act === 'create' ? '建立群組中（推導金鑰需要幾秒）…' : '加入群組中（驗證密碼需要幾秒）…');
                    if (act === 'create') { const r = await this._rgCreate(name, pw); this._rgView = 'joined'; p.dataset.view = ''; this._rgRender(); this._rgLog('請把代號 ' + r.code + ' 與密碼告訴要加入的人'); }
                    else { await this._rgJoin(name, codeText, pw); p.dataset.view = ''; this._rgView = 'joined'; this._rgRender(); }
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
