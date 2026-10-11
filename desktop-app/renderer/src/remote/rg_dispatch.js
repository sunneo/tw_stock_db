/* 遠端群組的派工（第 2 階段）：把需求交給群組裡的另一台機器，由它用自己的模型與工具完成，結果送回來。
 * 設計見 DESIGN.remote-group.md 第 5、6 節。
 *   發出需求的一端（requester）：   _rgDispatch(text)           → 'task' → 收 'task_ev'（進度／完成／失敗…）→ 顯示在發出的那個對話裡
 *   被派工的一端（executor）：      _rgOnTask(msg)             → 排隊 → 用 _runSubAgentTask 執行 → 送 'task_ev'，每個事件有序號並存進事件記錄
 *   斷線補齊：發出端在目標機器回來時送 'task_sync'（帶最後看到的序號），被派工端重播之後的事件
 * 協定（都經過 rg_core 的加密與切塊）：
 *   task      {taskId, text, fromName}
 *   task_ack  {taskId, queued}
 *   task_ev   {taskId, seq, kind: progress|done|failed|stopped|rejected, status?, text?, visual?, error?}
 *   task_stop {taskId}
 *   task_sync {taskId, since}                                                                          */
const FaRemoteDispatch = (function () {
    'use strict';
    const DB = 'FaRemote', STORE_T = 'tasks', MAX_KEEP = 20;
    const TERMINAL = { done: 1, failed: 1, stopped: 1, rejected: 1 };
    const SIGNED = { task: 1, settings_set: 1, rebuild: 1, chat_say: 1, chat_stop: 1, task_sync: 1 };
    const AGENTS = new Map(); let agentSeq = 0; let agentNotify = null;
    // 包住 _runSubAgentTask：每次子任務開始／結束都登記，並通知在線名單更新數量
    function installTracking(cls) {
        const proto = cls.prototype, orig = proto._runSubAgentTask; if (!orig || orig.__rgTracked) return;
        const wrapped = async function (userPrompt, maxRounds, options) {
            const id = 'a' + (++agentSeq), meta = (options && options.meta) || {};
            AGENTS.set(id, { id, label: meta.label || meta.domain || '子任務', source: meta.source || '本機', kind: meta.kind || 'local', task: String(userPrompt || '').replace(/\s+/g, ' ').slice(0, 80), startedAt: Date.now() });
            if (agentNotify) agentNotify();
            try { return await orig.apply(this, arguments); } finally { AGENTS.delete(id); if (agentNotify) agentNotify(); }
        };
        wrapped.__rgTracked = true; proto._runSubAgentTask = wrapped;
    }
    const idb = () => new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('沒有 IndexedDB')); return; }
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { r.result.createObjectStore(STORE_T, { keyPath: 'taskId' }); };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const tx = async (mode, fn) => { const db = await idb(); return new Promise((resolve, reject) => { const t = db.transaction(STORE_T, mode); const out = fn(t.objectStore(STORE_T)); t.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : out); }; t.onerror = () => { db.close(); reject(t.error); }; }); };

    const methods = {
        // ---------------------------------------------------------------- 事件記錄（被派工的一端；重新整理後還在）
        async _rgSaveTask(job) { try { await tx('readwrite', (s) => s.put({ taskId: job.taskId, from: job.from, fromName: job.fromName, text: job.text, events: job.events, at: job.at, sub: job.sub, fromPk: job.fromPk || '', updatedAt: Date.now() })); } catch (_) { /* 無痕模式沒有 IndexedDB：只在記憶體 */ } },
        async _rgLoadTasks() {
            let all = []; try { all = await tx('readonly', (s) => s.getAll()); } catch (_) { return; }
            const rg = this._rg; if (!rg) return; rg.exec = rg.exec || {};
            all.sort((a, b) => a.updatedAt - b.updatedAt);
            for (const r of all.slice(-MAX_KEEP)) {
                const job = { taskId: r.taskId, from: r.from, fromName: r.fromName, text: r.text, events: r.events || [], at: r.at || r.updatedAt, sub: !!r.sub, fromPk: r.fromPk || '', done: false };
                if (!job.events.some((e) => TERMINAL[e.kind])) { job.events.push({ seq: job.events.length + 1, kind: 'failed', error: '這台機器重新整理或重新啟動，任務中斷了（需要的話請重新送出）' }); await this._rgSaveTask(job); }
                job.done = true; rg.exec[job.taskId] = job; rg.shared = rg.shared || {};
                for (const ev of job.events) for (const it of (ev.refs || [])) { (rg.shared[it.id] = rg.shared[it.id] || new Set()).add(job.from); for (const a of (it.assets || [])) (rg.shared[a.id] = rg.shared[a.id] || new Set()).add(job.from); }
            }
            try { const keep = new Set(all.slice(-MAX_KEEP).map((r) => r.taskId)); for (const r of all) if (!keep.has(r.taskId)) await tx('readwrite', (s) => s.delete(r.taskId)); } catch (_) { /* */ }
        },

        // ---------------------------------------------------------------- 發出需求的一端
        _rgTargets() { const rg = this._rg; if (!rg) return []; const me = rg.room.self.nodeId; return rg.room.members().filter((m) => m.nodeId !== me); },
        _rgTargetName(id) { const m = this._rgTargets().find((x) => x.nodeId === id); return m ? m.name : id; },
        // text：使用者輸入的需求。以「目前這個對話」的名義送出（this 是綁定對話的代理物件）
        async _rgDispatch(text) {
            const rg = this._rg, targetId = this._rgTarget;
            const t = this._rgTargets().find((x) => x.nodeId === targetId);
            if (!rg || !t) { this._pushAssistantMessage('⚠️ 選定的機器已經不在群組裡（或離線了）。請在輸入框旁的「交給」重新選擇。', null); this._renderMessageHistory(); return; }
            if (t.allow === false) { this._pushAssistantMessage('⚠️ ' + t.name + ' 目前不接受遠端需求（對方關掉了「允許其他機器派工給我」）。', null); this._renderMessageHistory(); return; }
            const taskId = rg.room.self.nodeId.slice(0, 6) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
            this.messages.push({ role: 'user', content: text }); this._renderMessageHistory();
            const prog = this._createProgressWidget('🛰️ 交給 ' + t.name + '（' + (t.kind === 'desktop' ? '桌面' : '網頁') + '）');
            prog.update({ status: '送出需求中…' });
            const task = { taskId, targetId, targetName: t.name, prog, lastSeq: 0, done: false, text, run: this, ack: false, stopSent: false, absent: false, at: Date.now(), lastEventAt: Date.now(), chatId: (this._ctx && this._chatListEnabled && this._chatIndex && this._chatEntry(this._ctx.id)) ? this._ctx.id : '' };
            rg.tasks = rg.tasks || {}; rg.tasks[taskId] = task; this._rgPendingSave();
            try { this._setRespondingState(true, '⏳ 等 ' + t.name + ' 完成：' + text.slice(0, 20)); } catch (_) { /* */ }
            const finished = new Promise((resolve) => { task.resolve = resolve; });
            try { await this._rgSend(targetId, 'task', { taskId, text, fromName: rg.room.self.name }); }
            catch (e) { this._rgTaskEnd(task, 'failed', '送出失敗：' + String((e && e.message) || e)); }
            task.resendTimer = setTimeout(() => { if (!task.ack && !task.done) this._rgSend(targetId, 'task', { taskId, text, fromName: rg.room.self.name }).catch(() => {}); }, 6000 * this._rgSlow()); // 通道剛好斷線重連時送出的第一次可能丟了：再送一次（對方用 taskId 去重，不會執行兩次）
            task.ackTimer = setTimeout(() => { if (!task.ack && !task.done) this._rgTaskEnd(task, 'failed', t.name + ' 沒有回應（' + 15 * this._rgSlow() + ' 秒）。對方可能已離線，或分頁被瀏覽器凍結了。'); }, 15000 * this._rgSlow());
            // 使用者按「停止」：通知對方也停下來
            task.stopTimer = setInterval(() => { if (!task.done && !task.stopSent && task.run.stopRequested) { task.stopSent = true; rg.room.send(targetId, 'task_stop', { taskId }).catch(() => {}); prog.update({ status: '已通知 ' + t.name + ' 停止…' }); } }, 500);
            await finished;
        },
        _rgTaskEnd(task, kind, textOrError, visual, refs) {
            if (task.done) return; task.done = true; clearTimeout(task.ackTimer); clearTimeout(task.resendTimer); clearInterval(task.stopTimer); this._rgPendingSave();
            const run = task.run, name = task.targetName;
            if (task.quiet) { task.prog.fail ? (kind === 'done' ? task.prog.finish('完成（' + name + '）') : task.prog.fail(name + '：' + (textOrError || kind))) : 0; task.resolve && task.resolve({ kind, text: kind === 'done' ? textOrError : '', error: kind === 'done' ? '' : textOrError, visual, refs }); return; }
            if (kind === 'done') {
                task.prog.finish('完成（由 ' + name + ' 執行）');
                const has = Array.isArray(refs) && refs.length;
                const note = has ? '\n\n> 📎 ' + name + ' 產生了 ' + refs.length + ' 項內容，在下面可以直接開啟或存到這邊。' : (visual ? '\n\n> （' + name + ' 產生了「' + (visual.title || visual.type || '內容') + '」，但沒有可以傳輸的檔案。）' : '');
                run._pushAssistantMessage('🖥️ **' + name + '** 完成：\n\n' + (textOrError || '（沒有文字結果）') + note, null);
                const grp = has ? { nodeId: task.targetId, machine: name, items: refs.map((x) => Object.assign({}, x)) } : null;
                if (has) run._pushDisplayToolMessage('[' + name + ' 產生了 ' + refs.length + ' 項內容：' + refs.map((x) => x.name).slice(0, 8).join('、') + '，已在對話裡顯示成可開啟的卡片]', '_displayRemoteFiles', grp);
                if (has) this._rgAutoSave(run, { nodeId: task.targetId, machine: name }, grp).catch(() => {});
            } else {
                const label = { failed: '失敗', stopped: '已停止', rejected: '被拒絕' }[kind] || kind;
                task.prog.fail(name + '：' + label + (textOrError ? '（' + textOrError + '）' : ''));
                run._pushAssistantMessage('⚠️ ' + name + ' ' + label + '：' + (textOrError || ''), null);
            }
            try { run._renderMessageHistory(); run._persistChatHistory(); run._setRespondingState(false, '', kind === 'done' ? 'completed' : 'stopped'); } catch (_) { /* */ }
            task.resolve && task.resolve();
        },
        // AI 的工具：把一個子任務分給群組裡「接受子任務分工」的機器，等它做完回傳結果。machine 可以是名稱，或 'auto'（挑最空閒的）
        async _rgDelegate(text, machine) {
            const rg = this._rg; if (!rg) return { ok: false, error: '還沒加入遠端群組（在右上角「🌐 遠端」建立或加入）' };
            const cands = this._rgTargets().filter((x) => x.sub === true);
            if (!cands.length) return { ok: false, error: '群組裡沒有任何機器勾選「接受子任務分工」（要在那台機器自己的面板勾選）' };
            let target = null; const want = String(machine || 'auto').trim();
            const mine = (x) => Object.values(rg.tasks || {}).filter((k) => !k.done && k.targetId === x.nodeId).length; // 我這邊已經分給它、還沒完成的
            if (want && want !== 'auto') { target = cands.find((x) => x.name === want); if (!target) return { ok: false, error: '找不到可分工的機器「' + want + '」。可用：' + cands.map((x) => x.name).join('、') }; }
            else {
                const ok = cands.filter((x) => { const pf = this._rgPrefOf(x.name); return pf.auto !== false && this._rgPrefAllows(pf, text) && mine(x) < pf.maxFromMe; });
                if (!ok.length) return { ok: false, error: '沒有符合「分派規則」的機器可以自動分工（都被排除、範圍不符，或我這邊分給它的已達上限）。可以指定機器名稱，或到機器名稱右鍵「設置分派規則」調整。' };
                target = ok.sort((a, b) => this._rgPrefOf(b.name).priority - this._rgPrefOf(a.name).priority || (a.agents || 0) - (b.agents || 0) || (a.busy ? 1 : 0) - (b.busy ? 1 : 0))[0];
            }
            if (mine(target) >= this._rgPrefOf(target.name).maxFromMe) return { ok: false, machine: target.name, error: '我這邊分給 ' + target.name + ' 的已達上限（' + this._rgPrefOf(target.name).maxFromMe + '），請稍後再試或換一台' };
            const taskId = rg.room.self.nodeId.slice(0, 6) + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
            const prog = this._createProgressWidget('🧩 子任務分給 ' + target.name); prog.update({ status: '送出中…' });
            const task = { taskId, targetId: target.nodeId, targetName: target.name, prog, lastSeq: 0, done: false, text, run: this, ack: false, stopSent: false, absent: false, quiet: true };
            rg.tasks = rg.tasks || {}; rg.tasks[taskId] = task;
            const finished = new Promise((resolve) => { task.resolve = resolve; });
            try { await this._rgSend(target.nodeId, 'task', { taskId, text, fromName: rg.room.self.name, sub: true }); } catch (e) { this._rgTaskEnd(task, 'failed', '送出失敗：' + String((e && e.message) || e)); }
            task.resendTimer = setTimeout(() => { if (!task.ack && !task.done) this._rgSend(target.nodeId, 'task', { taskId, text, fromName: rg.room.self.name, sub: true }).catch(() => {}); }, 6000 * this._rgSlow());
            task.ackTimer = setTimeout(() => { if (!task.ack && !task.done) this._rgTaskEnd(task, 'failed', target.name + ' 沒有回應（' + 15 * this._rgSlow() + ' 秒）'); }, 15000 * this._rgSlow());
            task.stopTimer = setInterval(() => { if (!task.done && !task.stopSent && this.stopRequested) { task.stopSent = true; rg.room.send(target.nodeId, 'task_stop', { taskId }).catch(() => {}); } }, 500);
            const r = await finished;
            if (r.kind !== 'done') return { ok: false, machine: target.name, error: r.error || r.kind };
            const pulled = await this._rgPullRefs({ targetId: target.nodeId, targetName: target.name }, r.refs || []).catch(() => ({ images: [], texts: [], skipped: [] }));
            return { ok: true, machine: target.name, result: r.text || '', images: pulled.images, texts: pulled.texts, not_fetched: pulled.skipped.length ? pulled.skipped : undefined, note: pulled.images.length || pulled.texts.length ? '對方產生的圖片已經存到這台（url 是 client-file/<id>，簡報的 image / chart 視覺可以直接用；有 ref 的用 ref），文字檔內容在 texts 裡' : ((r.refs || []).length ? '對方產生了檔案，但沒有圖片或文字檔可以直接取回' : undefined) };
        },
        // 全螢幕的進度視窗（do-modal）：遠端檔案按「開啟」「存到這邊」之後，整個畫面被擋住、顯示進度條與取消鈕，
        // 不會讓人以為沒反應而連點好幾次。回傳 {update(done, total, via), fail(msg), close()}；onCancel 在按取消（或 Esc）時呼叫。
        _rgProgressModal(title, onCancel) {
            const pal = this._getThemePalette(), e = (s) => this._escapeHtml(String(s)), t0 = Date.now(); let closed = false, cancelling = false, failed = false;
            const ov = document.createElement('div'); ov.setAttribute('data-rg-modal', '1'); ov.style.cssText = 'position:fixed; inset:0; z-index:1000003; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; cursor:wait;';
            ov.innerHTML = '<div style="width:min(460px,92vw); box-sizing:border-box; padding:18px 20px; border-radius:12px; background:' + pal.windowBg + '; color:' + pal.chatText + '; border:1px solid ' + pal.windowBorder + '; box-shadow:0 10px 40px rgba(0,0,0,.5); cursor:default; font-size:13px;">'
                + '<div data-m="title" style="font-weight:bold; font-size:15px; margin-bottom:12px; overflow-wrap:anywhere;">' + e(title) + '</div>'
                + '<div style="height:12px; border-radius:6px; background:rgba(128,128,128,.28); overflow:hidden;"><div data-m="bar" style="height:100%; width:30%; border-radius:6px; background:#76b900; transition:width .15s linear;"></div></div>'
                + '<div data-m="text" style="margin:8px 0 14px; min-height:34px; opacity:.9; line-height:1.5;">連線中…（等對方回應）</div>'
                + '<div style="display:flex; justify-content:flex-end; gap:8px;"><button type="button" data-m="btn" style="padding:6px 16px; border-radius:6px; cursor:pointer; border:1px solid ' + pal.inputBorder + '; background:transparent; color:' + pal.chatText + ';">取消</button></div></div>';
            const q = (n) => ov.querySelector('[data-m="' + n + '"]'), bar = q('bar'); let wait = 0;
            // 還沒有進度時讓進度條來回掃動，表示有在動
            const sweep = setInterval(() => { if (closed || bar.dataset.det) return; wait = (wait + 4) % 140; bar.style.width = '30%'; bar.style.marginLeft = (wait - 30) + '%'; }, 60);
            const close = () => { if (closed) return; closed = true; clearInterval(sweep); document.removeEventListener('keydown', onKey, true); ov.remove(); };
            const doCancel = () => { if (closed || cancelling || failed) return; cancelling = true; q('btn').disabled = true; q('btn').textContent = '取消中…'; q('text').textContent = '正在取消…'; try { onCancel && onCancel(); } catch (_) { /* */ } };
            const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); if (failed) close(); else doCancel(); } else if (ev.key === 'Tab') ev.preventDefault(); };
            q('btn').addEventListener('click', doCancel); document.addEventListener('keydown', onKey, true); document.body.appendChild(ov); q('btn').focus();
            const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
            return {
                update: (done, total, via) => {
                    if (closed || cancelling) return; const sec = Math.max(0.5, (Date.now() - t0) / 1000), pct = total ? Math.min(100, Math.round(done / total * 100)) : 0, rate = done / sec;
                    bar.dataset.det = '1'; bar.style.marginLeft = '0'; bar.style.width = Math.max(2, pct) + '%';
                    q('text').innerHTML = pct + '%　' + mb(done) + (total ? ' / ' + mb(total) : '') + (via ? '　（' + e(via) + '）' : '') + (rate > 1024 && total ? '<br><span style="opacity:.75;">' + mb(rate) + '/秒　剩約 ' + Math.max(1, Math.round((total - done) / rate)) + ' 秒</span>' : '');
                },
                fail: (msg) => { if (closed) return; failed = true; clearInterval(sweep); bar.dataset.det = '1'; bar.style.marginLeft = '0'; bar.style.background = '#f87171'; bar.style.width = '100%'; q('text').innerHTML = '<span style="color:#f87171; font-weight:bold;">失敗</span>：' + e(msg); const b = q('btn'); b.disabled = false; b.textContent = '關閉'; b.onclick = close; b.focus(); ov.style.cursor = 'default'; },
                close,
            };
        },
        // 把對方這次產生的內容取回來：圖片（每張 6MB 內、最多 8 張）存進本機檔案快取，文字檔（200KB 內）直接讀成文字；其他種類只列名稱
        async _rgPullRefs(group, refs) {
            const out = { images: [], texts: [], skipped: [] }; group = { nodeId: group.nodeId || group.targetId, machine: group.machine || group.targetName };
            for (const it of (refs || []).slice(0, 14)) {
                try {
                    if (it.kind === 'image' && it.size <= 6 * 1024 * 1024 && out.images.length < 8) {
                        const r = await this._rgGetItemBlob(group, it, () => {}, { cancelled: false }), id = await this.fileCache.put(r.name || it.name, r.mime || it.mime || 'image/png', r.blob, 'uploaded'); let ref = null;
                        try { const e = this._deckRun().catalog.add('client-file/' + id, { alt: it.name, from: 'delegate_to_machine' }); ref = e && e.ref; } catch (_) { /* 不在簡報任務裡：沒有圖片目錄 */ }
                        out.images.push({ name: it.name, url: 'client-file/' + id, ref });
                    } else if (it.kind === 'text' && it.size <= 200 * 1024) { const r = await this._rgGetItemBlob(group, it, () => {}, { cancelled: false }); out.texts.push({ name: it.name, text: (await r.blob.text()).slice(0, 60000) }); }
                    else out.skipped.push(it.name + '（' + it.kind + '，' + it.size + ' 位元組）');
                } catch (e) { out.skipped.push(it.name + '：' + String((e && e.message) || e).slice(0, 80)); }
            }
            return out;
        },
        _rgRegisterTools() {
            const self = this;
            this.register_openai_tool('list_remote_machines',
                '列出已加入的遠端群組裡的其他機器：名稱、桌面或網頁、是否忙碌、正在跑幾個子任務、是否接受整個需求、是否接受子任務分工。沒有加入群組時回傳空清單。',
                async function () { const rg = this._rg; if (!rg) return JSON.stringify({ ok: true, joined: false, machines: [], note: '還沒加入遠端群組' }); return JSON.stringify({ ok: true, joined: true, group: rg.code, machines: this._rgTargets().map((m) => ({ name: m.name, kind: m.kind, busy: !!m.busy, running_subagents: m.agents || 0, accepts_requests: m.allow !== false, accepts_subtasks: m.sub === true })) }); },
                { type: 'object', properties: {}, additionalProperties: false });
            this.register_openai_tool('delegate_to_machine',
                '把一個可以獨立完成的子任務分給遠端群組裡「接受子任務分工」的機器，等它做完回傳文字結果（那台機器用自己的模型與工具）。task：完整的任務描述（對方看不到這邊的對話，要寫清楚）；machine：機器名稱，或 "auto"（挑最空閒的）。可以同時對不同機器多次呼叫來平行分工。先用 list_remote_machines 看有哪些機器可用。',
                async function (raw) { let a = {}; try { a = await this.repairJsonPayload(String(raw || '{}')); } catch (_) { /* */ } const text = String(a.task || '').trim(); if (!text) return JSON.stringify({ ok: false, error: '缺少 task' }); return JSON.stringify(await this._rgDelegate(text, a.machine)); },
                { type: 'object', properties: { task: { type: 'string', description: '完整的任務描述' }, machine: { type: 'string', description: '機器名稱，或 auto' } }, required: ['task'], additionalProperties: false });
            // ---- 斜線指令：嵌入網頁的助理沒有左邊的對話清單（點不到機器），所以用指令分配給遠端
            const cmd = (name, hint, desc, fn) => this.register_slash_command(name, hint, desc, (argsText, run) => { const me = run || this; return Promise.resolve(fn.call(me, String(argsText || '').trim())).catch((e) => { me._pushAssistantMessage('⚠️ ' + String((e && e.message) || e), null); me._renderMessageHistory(); me._persistChatHistory(); }); });
            const say = function (user, text) { if (user) this.messages.push({ role: 'user', content: user }); this._pushAssistantMessage(text, null); this._renderMessageHistory(); this._persistChatHistory(); };
            cmd('/machines', '', '列出遠端群組裡的其他機器：桌面或網頁、忙碌或閒置、是否接受需求與子任務分工、正在跑幾個子任務、對方分享了幾個對話；也顯示這個對話目前「交給」哪一台。', function () {
                const rg = this._rg; if (!rg) { say.call(this, '/machines', '還沒加入遠端群組（右上角「🌐 遠端」建立或加入）。'); return; }
                const ms = this._rgTargets(), cur = ms.find((m) => m.nodeId === this._rgTarget);
                say.call(this, '/machines', '**遠端群組 ' + rg.code + '**（你是 ' + rg.room.self.name + '）\n\n' + (ms.length ? ms.map((m, i) => (i + 1) + '. **' + m.name + '**（' + (m.kind === 'desktop' ? '桌面' : '網頁') + '）' + (m.busy ? ' 🔶忙碌' : ' 🟢閒置') + (m.allow === false ? '，不接受需求' : '') + (m.sub ? '，可分工' : '') + (m.agents ? '，跑 ' + m.agents + ' 個子任務' : '') + (((rg.remoteChats || {})[m.nodeId] || { list: [] }).list.length ? '，分享了 ' + rg.remoteChats[m.nodeId].list.length + ' 個對話' : '')).join('\n') : '（沒有其他機器在線）') + '\n\n目前這個對話交給：' + (cur ? '**' + cur.name + '**' : '本機') + '\n\n用法：`/remote <機器名稱> <需求>` 交一件事給它；`/remote-to <機器名稱>` 之後的訊息都交給它（`/remote-to 本機` 取消）；`/remote-open <機器名稱>` 看它分享的對話。');
            });
            cmd('/remote', '<機器名稱|auto> <需求或指令>', '把「這一則」需求交給遠端群組裡的某台機器做（用它的模型、工具與資料）；結果與產生的檔案傳回來。機器名稱寫 auto 會挑最閒的。需求可以是 /media-presentation 開頭的簡報指令：在那台機器上做，做好的簡報傳回來播放。名稱有空白時用引號。', async function (args) {
                const m = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/.exec(args); if (!m) { say.call(this, '/remote ' + args, '用法：`/remote <機器名稱|auto> <需求>`，例如 `/remote 股市網頁 /media-presentation 下周的鎖股名單報告`。先用 `/machines` 看有哪些機器。'); return; }
                const m1 = this._rgResolveMachine(m[1] || m[2] || m[3], 'dispatch'); if (m1.error) { say.call(this, '/remote ' + args, '⚠️ ' + m1.error); return; }
                const prev = this._rgTarget; this._rgTarget = m1.machine.nodeId; let p; try { p = this._rgDispatch(m[4].trim()); } finally { this._rgTarget = prev; } // _rgDispatch 一開始就讀走目標，之後恢復原本的「交給」
                await p;
            });
            cmd('/remote-to', '<機器名稱|本機>', '設定這個對話之後的訊息都「交給」哪台遠端機器做（等於輸入框旁的「交給」選單）；寫「本機」或 local 取消。', function (args) {
                if (!this._rg) { say.call(this, '/remote-to ' + args, '還沒加入遠端群組。'); return; }
                if (!args) { const cur = this._rgTargets().find((x) => x.nodeId === this._rgTarget); say.call(this, '/remote-to', '目前交給：' + (cur ? '**' + cur.name + '**' : '本機') + '。用法：`/remote-to <機器名稱>` 或 `/remote-to 本機`。'); return; }
                if (/^(本機|local|here)$/i.test(args)) { this._rgTarget = ''; this._rgSyncTargetSelect(); say.call(this, '/remote-to ' + args, '已取消：之後的訊息在本機做。'); return; }
                const m1 = this._rgResolveMachine(args.replace(/^["']|["']$/g, ''), 'dispatch'); if (m1.error) { say.call(this, '/remote-to ' + args, '⚠️ ' + m1.error); return; }
                this._rgTarget = m1.machine.nodeId; this._rgSyncTargetSelect(); say.call(this, '/remote-to ' + args, '之後這個對話的訊息都交給 **' + m1.machine.name + '**（' + (m1.machine.kind === 'desktop' ? '桌面' : '網頁') + '）做；`/media-presentation …` 也會在那台做。`/remote-to 本機` 取消。');
            });
            cmd('/remote-open', '<機器名稱> [編號]', '看遠端機器分享出來的對話（並可接著對話）：不給編號就列出它分享的對話，給編號就打開。', async function (args) {
                const m = /^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(\d+))?$/.exec(args); if (!m) { say.call(this, '/remote-open ' + args, '用法：`/remote-open <機器名稱> [編號]`。'); return; }
                const m1 = this._rgResolveMachine(m[1] || m[2] || m[3], 'any'); if (m1.error) { say.call(this, '/remote-open ' + args, '⚠️ ' + m1.error); return; }
                const rg = this._rg; rg.remoteChats = rg.remoteChats || {}; this._rgRefreshRemoteChats(true); for (let i = 0; i < 12 && !((rg.remoteChats[m1.machine.nodeId] || {}).list || []).length; i++) await new Promise((r) => setTimeout(r, 400));
                const list = (rg.remoteChats[m1.machine.nodeId] || {}).list || [];
                if (!list.length) { say.call(this, '/remote-open ' + args, m1.machine.name + ' 沒有分享任何對話（要在那台機器的對話上按右鍵→「分享到群組」）。'); return; }
                if (m[4]) { const c = list[Number(m[4]) - 1]; if (!c) { say.call(this, '/remote-open ' + args, '沒有第 ' + m[4] + ' 個。可選：1 到 ' + list.length); return; } await this._rgOpenRemoteChat(m1.machine.nodeId, c.id); return; }
                say.call(this, '/remote-open ' + args, '**' + m1.machine.name + ' 分享的對話**\n\n' + list.map((c, i) => (i + 1) + '. ' + c.title + (c.running ? '（⏳ 進行中）' : '')).join('\n') + '\n\n用 `/remote-open ' + m1.machine.name + ' <編號>` 打開。');
            });
        },
        // 用名稱找群組裡的機器：完全相同（不分大小寫）優先，其次是唯一的開頭符合；auto 挑最閒的（dispatch：要接受需求的；其他：任何在線的）
        _rgResolveMachine(name, mode) {
            const rg = this._rg; if (!rg) return { error: '還沒加入遠端群組' }; const ms = this._rgTargets(); if (!ms.length) return { error: '群組裡沒有其他機器在線' };
            const want = String(name || '').trim(); if (!want) return { error: '要給機器名稱（用 /machines 看有哪些）' };
            if (/^auto$/i.test(want)) { const ok = ms.filter((m) => mode !== 'dispatch' || m.allow !== false); if (!ok.length) return { error: '沒有機器接受遠端需求' }; return { machine: ok.slice().sort((x, y) => (x.busy ? 1 : 0) - (y.busy ? 1 : 0) || (x.agents || 0) - (y.agents || 0))[0] }; }
            const low = want.toLowerCase(), exact = ms.filter((m) => m.name.toLowerCase() === low), pre = ms.filter((m) => m.name.toLowerCase().startsWith(low)), hit = exact.length ? exact : pre;
            if (hit.length === 1) { if (mode === 'dispatch' && hit[0].allow === false) return { error: hit[0].name + ' 目前不接受遠端需求（對方關掉了「允許其他機器派工給我」）' }; return { machine: hit[0] }; }
            return { error: hit.length ? '「' + want + '」符合好幾台：' + hit.map((m) => m.name).join('、') + '，請寫完整名稱' : '找不到機器「' + want + '」。目前有：' + ms.map((m) => m.name).join('、') };
        },
        // ---------------------------------------------------------------- 分派規則
        // 遠端可以修改的設定（白名單；進得了群組就是用密碼同意了）
        _rgRemoteValues() { const s = this._rgSettings(); return { allowDispatch: !!s.allowDispatch, acceptSubtasks: !!s.acceptSubtasks, readonlySandbox: !!s.readonlySandbox, maxParallel: Math.max(1, Math.min(16, Number(s.maxParallel) || 3)) }; },
        _rgSanitizeSettings(p) {
            const out = {}; p = p || {};
            ['allowDispatch', 'acceptSubtasks', 'readonlySandbox'].forEach((k) => { if (typeof p[k] === 'boolean') out[k] = p[k]; });
            if (p.maxParallel != null && Number.isFinite(Number(p.maxParallel))) out.maxParallel = Math.max(1, Math.min(16, Math.round(Number(p.maxParallel))));
            return out;
        },
        // 套用設定（本機自己改、或群組成員遠端改）：存起來、更新在線名單與面板
        _rgApplySettings(clean) {
            this._rgSaveSettings(clean); const rg = this._rg;
            if (rg) { if ('allowDispatch' in clean) rg.room.self.allow = clean.allowDispatch; if ('acceptSubtasks' in clean) rg.room.self.sub = clean.acceptSubtasks; rg.room.publishSelf().catch(() => {}); }
            const p = document.getElementById('ai-rg-panel'); if (p && this._rg) { p.dataset.view = ''; this._rgView = 'joined'; this._rgRender(); }
        },
        async _rgOnSettingsGet(m) { const rg = this._rg; if (!rg) return; try { await rg.room.send(m.from, 'settings', { rid: m.body && m.body.rid, values: this._rgRemoteValues() }); } catch (_) { /* */ } },
        async _rgOnSettingsSet(m) {
            const rg = this._rg; if (!rg) return; const b = m.body || {}; const clean = this._rgSanitizeSettings(b.patch);
            const who = this._rgTargetName(m.from) || m.from;
            const gate = await this._rgGate(m); if (gate) { this._rgLog('拒絕了 ' + who + ' 修改設定：' + gate); await rg.room.send(m.from, 'settings_ack', { rid: b.rid, ok: false, error: gate, values: this._rgRemoteValues() }).catch(() => {}); return; }
            if (!Object.keys(clean).length) { await rg.room.send(m.from, 'settings_ack', { rid: b.rid, ok: false, error: '沒有可以修改的項目', values: this._rgRemoteValues() }).catch(() => {}); return; }
            const label = { allowDispatch: '允許派工', acceptSubtasks: '接受子任務分工', readonlySandbox: '只允許唯讀與沙盒', maxParallel: '同時處理上限' };
            this._rgApplySettings(clean);
            this._rgLog(who + ' 修改了這台機器的設定：' + Object.keys(clean).map((k) => label[k] + '＝' + (typeof clean[k] === 'boolean' ? (clean[k] ? '開' : '關') : clean[k])).join('、'));
            await rg.room.send(m.from, 'settings_ack', { rid: b.rid, ok: true, values: this._rgRemoteValues() }).catch(() => {});
        },
        // ---------------------------------------------------------------- 第 4 階段：簽章訊息與把關
        // 派工、改設定、搬家這三種會簽名：收的人用在線名單裡的公鑰驗證，所以別的成員不能冒用某台機器的名義送出
        async _rgSend(to, type, body) {
            const rg = this._rg; if (!rg) throw new Error('尚未加入群組');
            if (!SIGNED[type]) return rg.room.send(to, type, body);
            const id = await this._rgLoadIdentity(), plain = Object.assign({}, body, { ts: Date.now() }); delete plain.sig;
            const sig = await id.sign(FaRemoteGroup.canon({ type, from: rg.room.self.nodeId, to, body: plain }));
            return rg.room.send(to, type, Object.assign({}, plain, { sig }));
        },
        // 回傳空字串＝驗證通過；否則是失敗原因
        async _rgVerify(m) {
            const rg = this._rg; if (!rg) return '尚未加入群組'; const b = m.body || {}, mem = rg.room.members().find((x) => x.nodeId === m.from);
            if (!mem) return '對方不在名單裡'; if (!mem.pk) return '對方是舊版，沒有身分金鑰（請對方更新）'; if (!b.sig || !b.ts) return '缺少簽章（對方可能是舊版）';
            if (Math.abs(Date.now() - b.ts) > 10 * 60 * 1000) return '簽章過期（兩台機器的時鐘差太多，或是被重送的舊訊息）';
            const plain = Object.assign({}, b); delete plain.sig;
            return (await FaRemoteGroup.verifySig(mem.pk, FaRemoteGroup.canon({ type: m.type, from: m.from, to: rg.room.self.nodeId, body: plain }), b.sig)) ? '' : '簽章驗證失敗（可能有人冒用這台機器的名義）';
        },
        // 收到需求或改設定前的把關：先驗簽章；限制模式再要求對方是核對過指紋的機器
        async _rgGate(m) {
            const bad = await this._rgVerify(m); if (bad) return bad;
            if (this._rgSettings().onlyTrusted) { const mem = this._rg.room.members().find((x) => x.nodeId === m.from); await this._rgRefreshFps(); if (!mem || this._rgTrustState(mem) !== 'trusted') return '這台機器開了限制模式：只接受已核對指紋的機器'; }
            return '';
        },
        async _rgClearTasks() {
            try { await tx('readwrite', (s) => s.clear()); } catch (_) { /* */ }
            const rg = this._rg; if (rg && rg.exec) for (const [k, j] of Object.entries(rg.exec)) if (j.done) delete rg.exec[k];
        },
        // ---------------------------------------------------------------- 內容傳輸（提供者）
        // 在檔案快取的 put 上加一層：任務執行期間新增的檔案都記下來（這就是這個任務「產生的內容」）
        _rgHookFileCache() {
            const fc = this.fileCache; if (!fc || fc.__rgHooked) return; fc.__rgHooked = true; const orig = fc.put.bind(fc); const self = this;
            fc.put = async function (...a) { const id = await orig(...a); try { const rg = self._rg; if (rg && rg.captures) { const size = (a[2] && a[2].size) || 0; for (const cap of rg.captures) cap.push({ id, name: String(a[0] || id), mime: String(a[1] || ''), size }); } } catch (_) { /* 記錄失敗不影響存檔 */ } return id; };
        },
        _rgFileKind(mime, name) { const m = String(mime || '').toLowerCase(), n = String(name || '').toLowerCase(); if (/\.deck\.yaml$/.test(n)) return 'deck'; if (m.startsWith('image/')) return 'image'; if (m.startsWith('video/')) return 'video'; if (m.startsWith('audio/')) return 'audio'; if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'; if (m.startsWith('text/') || /(json|yaml|xml|csv|markdown)/.test(m) || /\.(txt|md|json|yaml|yml|csv|log)$/.test(n)) return 'text'; return 'file'; },
        // cap：任務期間記下的 put；visual：_runSubAgentTask 回傳的最後一個視覺結果；to：要求者的節點代號。回傳內容清單（也把每個檔案宣告給要求者）
        async _rgBuildRefs(cap, visual, to) {
            const rg = this._rg; if (!rg) return []; rg.shared = rg.shared || {}; const fc = this.fileCache; const seen = new Set(); const items = [];
            const addRec = async (c) => { if (!c || seen.has(c.id)) return null; seen.add(c.id); let rec = null; try { rec = await fc.get(c.id); } catch (_) { /* */ } if (!rec || !rec.blob || !rec.blob.size) return null; return { id: c.id, name: rec.filename || c.name, mime: rec.mimeType || c.mime || rec.blob.type || '', size: rec.blob.size, blob: rec.blob }; };
            // 視覺結果裡直接帶資料的（圖表、3D／2D 場景、繪圖）：存成檔案一起列出
            if (visual) {
                try {
                    if (visual.type === 'image' && typeof visual.dataUrl === 'string' && visual.dataUrl.startsWith('data:')) { const blob = await (await fetch(visual.dataUrl)).blob(); const id = await fc.put('圖片-' + Date.now().toString(36) + '.' + (blob.type.split('/')[1] || 'png'), blob.type, blob, 'generated'); cap.push({ id, name: '圖片', mime: blob.type, size: blob.size }); }
                    else if (typeof visual.yaml === 'string') { const ext = visual.type === 'scene3d' ? '3dscene.yaml' : visual.type === 'anim2d' ? '2danim.yaml' : 'yaml'; const blob = new Blob([visual.yaml], { type: 'text/yaml' }); const id = await fc.put((visual.type || 'visual') + '.' + ext, 'text/yaml', blob, 'generated'); cap.push({ id, name: (visual.type || 'visual') + '.' + ext, mime: 'text/yaml', size: blob.size }); }
                    else if (typeof visual.svg === 'string') { const blob = new Blob([visual.svg], { type: 'image/svg+xml' }); const id = await fc.put((visual.type || 'drawing') + '.svg', 'image/svg+xml', blob, 'generated'); cap.push({ id, name: (visual.type || 'drawing') + '.svg', mime: 'image/svg+xml', size: blob.size }); }
                } catch (_) { /* 存不成就只列文字結果 */ }
            }
            const recs = []; for (const c of cap) { const r = await addRec(c); if (r) recs.push(r); }
            // 簡報：把它引用的圖片等素材一起打包成一項（不再另外列出）
            const used = new Set();
            for (const r of recs) {
                if (this._rgFileKind(r.mime, r.name) !== 'deck') continue;
                let text = ''; try { text = await r.blob.text(); } catch (_) { /* */ }
                const assets = []; for (const m of text.matchAll(/client-file\/([\w-]+)/g)) { const a = recs.find((x) => x.id === m[1]) || await addRec({ id: m[1], name: m[1] }); if (a && !used.has(a.id) && a.id !== r.id) { used.add(a.id); assets.push({ id: a.id, name: a.name, mime: a.mime, size: a.size }); } }
                r.assets = assets;
            }
            for (const r of recs) {
                if (used.has(r.id)) continue; const kind = this._rgFileKind(r.mime, r.name);
                items.push({ id: r.id, name: r.name, mime: r.mime, size: r.size, kind, assets: r.assets });
            }
            const list = items.slice(0, 30);
            for (const it of list) { (rg.shared[it.id] = rg.shared[it.id] || new Set()).add(to); for (const a of (it.assets || [])) (rg.shared[a.id] = rg.shared[a.id] || new Set()).add(to); }
            return list;
        },
        // 向某台機器要東西並等回覆（rid 對應）
        _rgAsk(nodeId, type, body, replyType, ms) {
            const rg = this._rg; if (!rg) return Promise.reject(new Error('尚未加入群組'));
            const rid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); rg.asks = rg.asks || {};
            return new Promise((resolve, reject) => {
                const wait = (ms || 6000) * this._rgSlow(); const timer = setTimeout(() => { delete rg.asks[rid]; reject(new Error('對方沒有回應（' + Math.round(wait / 1000) + ' 秒）')); }, wait);
                rg.asks[rid] = { replyType, resolve: (v) => { clearTimeout(timer); delete rg.asks[rid]; resolve(v); } };
                this._rgSend(nodeId, type, Object.assign({ rid }, body || {})).catch((e) => { clearTimeout(timer); delete rg.asks[rid]; reject(e); });
            });
        },
        _rgResolveAsk(m) { const rg = this._rg, b = m.body || {}, a = rg && rg.asks && rg.asks[b.rid]; if (a && a.replyType === m.type) a.resolve(b); },
        // 我這邊對某台機器的分派偏好（只存在這個瀏覽器；以機器名稱為鍵）
        _rgPrefs() { try { return JSON.parse(localStorage.getItem('fa_remote_prefs_v1') || '{}') || {}; } catch (_) { return {}; } },
        _rgPrefOf(name) { return Object.assign({ auto: true, priority: 5, scope: 'all', words: '', maxFromMe: 3, note: '' }, this._rgPrefs()[name] || {}); },
        _rgSavePref(name, patch) { const all = this._rgPrefs(); all[name] = Object.assign(this._rgPrefOf(name), patch || {}); try { localStorage.setItem('fa_remote_prefs_v1', JSON.stringify(all)); } catch (_) { /* */ } },
        _rgPrefAllows(pref, text) {
            const words = String(pref.words || '').split(/[,，、\s]+/).map((w) => w.trim().toLowerCase()).filter(Boolean); if (pref.scope === 'all' || !words.length) return true;
            const hit = words.some((w) => String(text || '').toLowerCase().includes(w)); return pref.scope === 'only' ? hit : !hit;
        },
        // ---------------------------------------------------------------- 內容傳輸（要求者）：從那台機器取得檔案
        async _rgFetchRemote(nodeId, id, onProgress, cancel) {
            const rg = this._rg; if (!rg || !rg.files) throw new Error('沒有加入群組（或對方已離線）');
            if (!rg.room.members().some((m) => m.nodeId === nodeId)) throw new Error('對方現在不在群組裡（離線了），回來之後再試');
            return rg.files.fetch(nodeId, id, { onProgress, cancel });
        },
        // 取得一項內容（優先用已存在這邊的副本）：回傳 {blob, name, mime}
        async _rgGetItemBlob(group, item, onProgress, cancel) {
            if (item.localId) { try { const rec = await this.fileCache.get(item.localId); if (rec && rec.blob) return { blob: rec.blob, name: item.name, mime: item.mime }; } catch (_) { /* 副本不見了就重新抓 */ } }
            const r = await this._rgFetchRemote(group.nodeId, item.id, onProgress, cancel); return { blob: r.blob, name: r.meta.name || item.name, mime: r.meta.mime || item.mime, via: r.via };
        },
        async _rgSaveItem(group, item, onProgress, cancel) {
            if (item.localId) return item.localId;
            if (item.kind === 'deck') { const d = await this._rgSaveDeck(group, item, onProgress, cancel); item.localId = d.yamlId; item.localDeckUrl = d.url; return d.yamlId; }
            const r = await this._rgGetItemBlob(group, item, onProgress, cancel);
            item.localId = await this.fileCache.put(r.name || item.name, r.mime || item.mime || 'application/octet-stream', r.blob, 'uploaded'); return item.localId;
        },
        // 簡報：把簡報檔與它引用的素材都抓過來，換成這邊的檔案編號，存成這邊的簡報
        async _rgSaveDeck(group, item, onProgress, cancel) {
            const parts = [{ id: item.id, name: item.name, mime: item.mime, size: item.size }].concat(item.assets || []); const total = parts.reduce((n, p) => n + (p.size || 0), 0) || 1; let doneBytes = 0; const idMap = {}; let yamlText = '';
            for (const p of parts) {
                const r = await this._rgFetchRemote(group.nodeId, p.id, (d) => onProgress && onProgress(doneBytes + d, total, '直連／轉送'), cancel); doneBytes += r.blob.size;
                if (p.id === item.id) yamlText = await r.blob.text(); else idMap[p.id] = await this.fileCache.put(r.meta.name || p.name, r.meta.mime || p.mime || 'application/octet-stream', r.blob, 'uploaded');
            }
            for (const [oldId, newId] of Object.entries(idMap)) yamlText = yamlText.split('client-file/' + oldId).join('client-file/' + newId);
            const saved = await this._deckSaveYaml(yamlText, String(item.name).replace(/\.deck\.yaml$/i, '')); return { yamlId: saved.id, url: saved.url };
        },
        // 在畫面上看：圖片、影片、音訊、PDF、文字直接顯示；簡報存過來之後在對話裡播放；其他檔案下載
        async _rgOpenItem(group, item, onProgress, cancel) {
            if (item.kind === 'deck') {
                await this._rgSaveItem(group, item, onProgress, cancel);
                if (group.viewer) { this._rgShowDeck(item); return; }
                this._pushAssistantMessage('🎞️ 已從 ' + group.machine + ' 取得簡報「' + item.name + '」，下面直接播放。', null);
                this._pushDisplayToolMessage('[已從 ' + group.machine + ' 取得簡報「' + item.name + '」，已在對話裡顯示成播放器]', '_displayDeckUrl', item.localDeckUrl); this._renderMessageHistory(); this._persistChatHistory(); return;
            }
            const r = await this._rgGetItemBlob(group, item, onProgress, cancel); this._rgShowBlob(r.blob, r.name, r.mime || item.mime, item.kind);
        },
        // 檔案卡片（開啟／存到這邊，有進度視窗）：對話裡的遠端結果和「看別台分享的對話」共用
        _rgFilesCard(grp) {
            const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-bottom: 12px; max-width: 95%; border: 1px solid rgba(128,128,128,.4); border-radius: 8px; padding: 8px 10px; font-size: 12px;';
        const icon = { deck: '🎞️', image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', text: '📄', file: '📎' };
        const fmt = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
        wrap.innerHTML = '<div style="font-weight:bold; margin-bottom:6px;">📎 ' + this._escapeHtml(grp.machine) + ' 產生的內容（' + grp.items.length + '）</div>';
        grp.items.forEach((item) => {
            const row = document.createElement('div'); row.style.cssText = 'display:flex; align-items:center; gap:6px; padding:3px 0; flex-wrap:wrap;';
            const sizeTotal = (item.size || 0) + (item.assets || []).reduce((n, a) => n + (a.size || 0), 0);
            row.innerHTML = '<span>' + (icon[item.kind] || '📎') + '</span><span style="flex:1; min-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' + this._escapeHtml(item.name) + '">' + this._escapeHtml(item.name) + '</span><span style="opacity:.7;">' + fmt(sizeTotal) + (item.assets && item.assets.length ? '（含 ' + item.assets.length + ' 個素材）' : '') + '</span>';
            const st = document.createElement('span'); st.style.cssText = 'font-size:11px; min-width:90px; opacity:.85;'; if (item.localId) st.textContent = '✅ 已存到這邊';
            const mkBtn = (label) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.style.cssText = 'padding:2px 8px; cursor:pointer; border:1px solid rgba(128,128,128,.5); border-radius:6px; background:transparent; color:inherit;'; return b; };
            const openBtn = mkBtn('開啟'), saveBtn = mkBtn('存到這邊'), stopBtn = mkBtn('取消'); stopBtn.style.display = 'none';
            let cancel = null;
            // 開啟／存檔是非同步的：跳出全螢幕進度視窗（擋住畫面、有進度條與取消鈕），不會讓人以為沒反應而連點好幾次
            const run = async (fn, label) => {
                if (cancel) return; cancel = { cancelled: false }; openBtn.disabled = saveBtn.disabled = true; st.style.color = ''; st.textContent = '';
                const cur = cancel, modal = this._rgProgressModal(label + '：' + item.name + '（來自 ' + grp.machine + '）', () => { cur.cancelled = true; });
                try { await fn((d, total, via) => modal.update(d, total, via), cur); modal.close(); st.textContent = item.localId ? '✅ 已存到這邊' : ''; this._persistChatHistory(); }
                catch (e) { const msg = String((e && e.message) || e); if (cur.cancelled) { modal.close(); st.textContent = '已取消'; } else { modal.fail(msg); st.textContent = '❌ ' + msg.slice(0, 80); st.style.color = '#f87171'; } }
                openBtn.disabled = saveBtn.disabled = false; cancel = null;
            };
            openBtn.onclick = () => run((p, c) => this._rgOpenItem(grp, item, p, c), '開啟'); saveBtn.onclick = () => run(async (p, c) => { await this._rgSaveItem(grp, item, p, c); }, '存到這邊'); stopBtn.onclick = () => { if (cancel) cancel.cancelled = true; };
            row.append(st, openBtn, saveBtn, stopBtn); wrap.appendChild(row);
        });
            return wrap;
        },
        // 看別台分享的對話時開簡報：跳出視窗直接播放（不寫進本機的對話）
        _rgShowDeck(item) {
            const pal = this._getThemePalette(), ov = document.createElement('div'); ov.style.cssText = 'position:fixed; inset:0; z-index:1000002; background:rgba(0,0,0,.8); display:flex; flex-direction:column; align-items:center; justify-content:center; padding:16px; box-sizing:border-box;';
            const box = document.createElement('div'); box.style.cssText = 'width:min(1100px,96vw); max-height:94vh; overflow:auto; border-radius:10px; padding:10px; background:' + pal.chatBg + '; color:' + pal.chatText + ';';
            const bar = document.createElement('div'); bar.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;'; bar.innerHTML = '<b>🎞️ ' + this._escapeHtml(item.name) + '</b>'; const x = document.createElement('button'); x.type = 'button'; x.textContent = '關閉'; x.style.cssText = 'padding:3px 12px; cursor:pointer;'; bar.appendChild(x);
            const mount = document.createElement('div'); box.append(bar, mount); ov.appendChild(box); document.body.appendChild(ov); x.onclick = () => ov.remove(); ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
            this._deckMount(mount, item.localDeckUrl).catch((err) => { mount.innerHTML = '<div style="padding:8px; color:#e53e3e;">⚠️ 簡報載入失敗：' + this._escapeHtml(err.message || String(err)) + '</div>'; });
        },
        _rgShowBlob(blob, name, mime, kind) {
            const url = URL.createObjectURL(blob), pal = this._getThemePalette(), e = (s) => this._escapeHtml(String(s));
            const ov = document.createElement('div'); ov.style.cssText = 'position:fixed; inset:0; z-index:1000002; background:rgba(0,0,0,.8); display:flex; flex-direction:column; align-items:center; justify-content:center; padding:20px; box-sizing:border-box;';
            const close = () => { ov.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
            let body = '';
            if (kind === 'image') body = '<img src="' + url + '" style="max-width:96%; max-height:82vh; object-fit:contain;">';
            else if (kind === 'video') body = '<video src="' + url + '" controls autoplay style="max-width:96%; max-height:82vh;"></video>';
            else if (kind === 'audio') body = '<audio src="' + url + '" controls autoplay></audio>';
            else if (kind === 'pdf') body = '<iframe src="' + url + '" style="width:min(96%,1000px); height:82vh; border:0; background:#fff;"></iframe>';
            else if (kind === 'text' && blob.size < 2 * 1024 * 1024) { body = '<pre data-pre style="width:min(96%,1000px); max-height:82vh; overflow:auto; background:' + pal.windowBg + '; color:' + pal.chatText + '; padding:12px; border-radius:8px; white-space:pre-wrap;"></pre>'; }
            else { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); return; }
            ov.innerHTML = '<div style="color:#fff; margin-bottom:8px; font-size:13px;">' + e(name) + '　<a href="' + url + '" download="' + e(name) + '" style="color:#76b900;">下載</a>　<a data-x href="#" style="color:#f87171;">關閉</a></div>' + body;
            document.body.appendChild(ov); ov.querySelector('[data-x]').onclick = (ev) => { ev.preventDefault(); close(); }; ov.addEventListener('click', (ev) => { if (ev.target === ov) close(); });
            const pre = ov.querySelector('[data-pre]'); if (pre) blob.text().then((t) => { pre.textContent = t; });
        },
        // 這台機器現在跑著的子任務清單（給在線名單的數字與「點開看」用）
        _rgAgentsList() { return Array.from(AGENTS.values()).map((a) => ({ id: a.id, label: a.label, source: a.source, kind: a.kind, task: a.task, ago: Math.round((Date.now() - a.startedAt) / 1000) })); },
        _rgOnEvent(m) {
            const rg = this._rg, b = m.body || {}, task = rg && rg.tasks && rg.tasks[b.taskId]; if (!task || task.done) return;
            if (m.type === 'task_ack') { task.ack = true; clearTimeout(task.ackTimer); task.prog.update({ status: b.queued > 0 ? '對方正在忙，已排隊（前面還有 ' + b.queued + ' 個）' : task.targetName + ' 開始處理…' }); return; }
            if (m.type !== 'task_ev') return;
            task.ack = true; clearTimeout(task.ackTimer);
            if (b.seq && b.seq <= task.lastSeq) return; // 重複的事件（斷線補齊時會重送）
            task.lastSeq = b.seq || task.lastSeq; task.lastEventAt = Date.now(); this._rgPendingSave();
            if (b.kind === 'progress') task.prog.update({ status: b.status || '處理中…' });
            else if (b.kind === 'trace') task.prog.log(b.status || '');
            else if (TERMINAL[b.kind]) this._rgTaskEnd(task, b.kind, b.kind === 'done' ? b.text : (b.error || b.text), b.visual, b.refs);
        },
        // 成員名單變動：目標離線／回來。回來時用最後看到的序號補齊錯過的事件
        _rgOnMembersChange() {
            const rg = this._rg; if (!rg || !rg.tasks) return;
            const ids = new Set(rg.room.members().map((m) => m.nodeId));
            for (const task of Object.values(rg.tasks)) {
                if (task.done) continue;
                if (!ids.has(task.targetId)) { const same = rg.room.members().find((x) => x.name === task.targetName && x.nodeId !== rg.room.self.nodeId); if (same) { task.targetId = same.nodeId; task.absent = true; } } // 對方重新啟動換了連線身分：用名稱找回來
                if (!ids.has(task.targetId)) { if (!task.absent) { task.absent = true; task.prog.update({ status: task.targetName + ' 離線了…它回來時我會接續（它如果還在執行，結果不會遺失）' }); } }
                else if (task.absent) { task.absent = false; task.prog.update({ status: task.targetName + ' 回來了，補齊錯過的進度…' }); this._rgSend(task.targetId, 'task_sync', { taskId: task.taskId, since: task.lastSeq }).catch(() => {}); }
            }
            if (this._rgTarget && !ids.has(this._rgTarget) && !Object.values(rg.tasks).some((t) => !t.done && t.targetId === this._rgTarget)) this._rgTarget = '';
        },

        // ---------------------------------------------------------------- 被派工的一端
        _rgEvent(job, ev) {
            const rg = this._rg; if (!rg) return;
            ev.seq = job.events.length + 1; job.events.push(ev); this._rgSaveTask(job); if (TERMINAL[ev.kind] && job.chatCtx) this._rgChatRecord(job, ev);
            rg.room.send(job.from, 'task_ev', Object.assign({ taskId: job.taskId }, ev)).catch(() => { /* 對方離線：回來時用 task_sync 補 */ });
            this._rgAct(job, ev); // 同時廣播給整個群組：大家都看得到這台在忙什麼、過程與結果
        },
        async _rgOnTask(m) {
            const rg = this._rg; if (!rg) return; const b = m.body || {}; if (!b.taskId || typeof b.text !== 'string') return;
            rg.exec = rg.exec || {}; if (rg.exec[b.taskId]) return; // 重複送來的同一個任務
            const s = this._rgSettings(), fromName = b.fromName || this._rgTargetName(m.from) || m.from, sub = !!b.sub;
            const job = { taskId: b.taskId, from: m.from, fromName, text: b.text, events: [], done: false, stop: false, sub, at: Date.now() };
            { const memR = rg.room.members().find((x) => x.nodeId === m.from); job.fromPk = memR && memR.pk ? memR.pk.x + memR.pk.y : ''; }
            rg.exec[b.taskId] = job;
            const gate = await this._rgGate(m); if (gate) { this._rgEvent(job, { kind: 'rejected', error: gate }); job.done = true; this._rgLog('拒絕了 ' + fromName + ' 的' + (sub ? '子任務' : '需求') + '：' + gate); return; }
            // 整個需求要「允許派工」；AI 拆出來的子任務要另外勾「接受子任務分工」（預設關）
            if (sub ? !s.acceptSubtasks : !s.allowDispatch) { this._rgEvent(job, { kind: 'rejected', error: sub ? '這台機器沒有勾選「接受子任務分工」' : '這台機器目前不接受遠端需求' }); job.done = true; this._rgLog('拒絕了 ' + fromName + ' 的' + (sub ? '子任務' : '需求') + '（設定不允許）'); return; }
            const max = Math.max(1, Math.min(16, Number(s.maxParallel) || 3)); rg.running = rg.running || 0; rg.waiting = rg.waiting || [];
            const queued = rg.running >= max ? rg.waiting.length + 1 : 0;
            await rg.room.send(m.from, 'task_ack', { taskId: b.taskId, queued }).catch(() => {});
            this._rgLog('收到 ' + fromName + ' 的' + (sub ? '子任務' : '需求') + '：' + b.text.slice(0, 30) + (queued ? '（排隊中）' : ''));
            this._rgAct(job, { kind: 'start', queued });
            const start = async () => {
                rg.running++; this._rgSetBusy();
                try { await this._rgRunTask(job); } catch (_) { /* 已在內部回報 */ }
                rg.running = Math.max(0, rg.running - 1); this._rgSetBusy();
                const next = rg.waiting.shift(); if (next) next();
            };
            if (rg.running < max) start(); else rg.waiting.push(start);
        },
        _rgSetBusy() { const rg = this._rg; if (!rg) return; rg.room.self.busy = (rg.running || 0) > 0; this._rgPublishSoon(); },
        // 狀態（忙碌、子任務數、設定）變動：稍微合併後更新在線名單
        _rgPublishSoon() { const rg = this._rg; if (!rg || rg.pubTimer) return; rg.pubTimer = setTimeout(() => { rg.pubTimer = null; if (this._rg === rg) { rg.room.self.agents = AGENTS.size; rg.room.publishSelf().catch(() => {}); this._rgRenderMembers && this._rgRenderMembers(); } }, 400); },
        async _rgRunTask(job) {
            const s = this._rgSettings(); const prog = this._createProgressWidget((job.sub ? '🧩 子任務（來自 ' : '🛰️ 遠端需求（來自 ') + job.fromName + '）：' + job.text.slice(0, 24));
            try { job.chatCtx = await this._rgCreateRemoteChat(job); } catch (_) { /* 記錄成對話失敗不影響執行 */ }
            if (job.chatCtx && !job.chatInline) { try { this._chatRunner(job.chatCtx)._setRespondingState(true, '⏳ 遠端需求（來自 ' + job.fromName + '）：' + job.text.slice(0, 20)); } catch (_) { /* */ } }
            let lastSent = 0;
            const progress = (status, force) => { prog.update({ status }); const now = Date.now(); if (force || now - lastSent > 800) { lastSent = now; this._rgEvent(job, { kind: 'progress', status }); } };
            if (job.stop) { this._rgEvent(job, { kind: 'stopped' }); prog.fail('已停止'); job.done = true; return; }
            try {
                const opts = { onProgress: (st) => progress(String(st)), onTrace: (line) => { prog.log(line); this._rgTrace(job, line); const tl = (job.trace = job.trace || []); if (tl.length < 300) tl.push(String(line).slice(0, 300)); }, shouldStop: () => { if (job.chatCtx && job.chatCtx.stopRequested) job.stop = true; return job.stop; }, onToolResult: (name, args, res) => { const l = (job.tools = job.tools || []); if (l.length < 300) l.push({ name, args: String(args).slice(0, 4000), res: typeof res === 'string' ? res : JSON.stringify(res), at: Date.now() }); }, meta: { label: job.sub ? '分工子任務' : '遠端需求', source: job.fromName, kind: 'remote' } };
                if (s.readonlySandbox && this.domains && this.domains.research) { opts.allowedToolNames = this._resolveDomainToolNames(this.domains.research); opts.systemPrompt = this._resolveDomainSystemPrompt(this.domains.research); }
                progress('開始處理…', true);
                this._rgHookFileCache(); const cap = []; const rg0 = this._rg; if (rg0) { rg0.captures = rg0.captures || new Set(); rg0.captures.add(cap); } job.cap = cap;
                let res; const mp = !job.sub && /^\s*\/media-presentation\s+([\s\S]+)$/i.exec(this._rgStripLabel(job.text));
                if (mp) {
                    if (s.readonlySandbox) throw new Error('這台機器設為「只允許唯讀與沙盒」，不能執行簡報技能（它會抓資料、存檔）');
                    const key = this._deckDomainKey(); if (!key) throw new Error('這台機器沒有「media-presentation」技能（被停用或刪除了）');
                    const dr = await this._delegateToSubagentDomain(key, mp[1].trim(), { onProgress: opts.onProgress, onTrace: opts.onTrace, shouldStop: opts.shouldStop, meta: opts.meta });
                    if (!dr || dr.ok === false) throw new Error('簡報技能失敗：' + String((dr && dr.error) || '沒有回應'));
                    res = { text: String(dr.result || dr.note || '（簡報已產生）'), visual: dr.type ? { type: dr.type, title: dr.title || '' } : null };
                } else res = await this._runSubAgentTask('這是群組裡另一台機器（' + job.fromName + '）交給你的需求，請完成它並回覆結果：\n\n' + job.text, 40, opts);
                const text = res && res.text ? String(res.text) : '';
                const v = res && res.visual ? { type: res.visual.type, title: res.visual.title || res.visual.name || '' } : null;
                if (rg0 && rg0.captures) rg0.captures.delete(cap);
                if (job.stop) { this._rgEvent(job, { kind: 'stopped', text }); prog.fail('已停止'); }
                else { let refs = []; try { await this._rgAddRawData(job, cap); } catch (e) { this._rgLog('附上原始工具資料失敗：' + String((e && e.message) || e)); } try { refs = await this._rgBuildRefs(cap, res && res.visual, job.from); } catch (e) { this._rgLog('整理產生的內容失敗：' + String((e && e.message) || e)); } this._rgEvent(job, { kind: 'done', text, visual: v, refs }); prog.finish('完成' + (refs.length ? '（產生了 ' + refs.length + ' 項內容）' : '')); }
            } catch (e) { const msg = String((e && e.message) || e); this._rgEvent(job, { kind: 'failed', error: msg }); prog.fail(msg); }
            try { const rg1 = this._rg; if (rg1 && rg1.captures && job.cap) rg1.captures.delete(job.cap); } catch (_) { /* */ }
            job.done = true;
        },
        // ---------------------------------------------------------------- 遠端需求記成這台機器上的一個新對話
        // 別的機器交給這台的需求（不含 AI 拆出來的子任務），會在左邊清單長出一個新對話，第一則訊息記錄「從哪台機器、什麼時候、指紋是否核對過」，
        // 執行結果接在下面。這樣使用者回到這台機器時，看得到有誰要它做了什麼。
        async _rgCreateRemoteChat(job) {
            if (job.sub) return null;
            // 嵌入網頁的助理沒有對話清單：不長新對話，結果回來時把完整內容（來源、需求、報告、處理過程）包成「一個可展開的框」記在目前這個對話裡
            if (!this._chatListEnabled || !this._chatIndex || !this._chatListReady) { if (!this._activeCtx) return null; job.chatInline = true; return this._activeCtx; }
            const rg = this._rg, mem = rg && rg.room.members().find((m) => m.nodeId === job.from), st = mem ? this._rgTrustState(mem) : 'none', fp = (rg && rg.fps && rg.fps[job.from]) || '';
            const id = this._chatNewId('c'), now = Date.now(), title = '來自 ' + job.fromName + '：' + String(job.text).replace(/\s+/g, ' ').slice(0, 22);
            this._chatIndex.chats.push({ id, title, groupId: null, createdAt: now, updatedAt: now, touched: true, shared: true, remote: { fromName: job.fromName, fromId: job.from, taskId: job.taskId, at: now, fp } });
            const ctx = this._chatCtxNew(id); this._chatCtxs.set(id, ctx); const run = this._chatRunner(ctx);
            const trust = { trusted: '指紋已核對', changed: '⚠️ 指紋跟你核對過的不同', new: '指紋尚未核對', none: '沒有指紋' }[st];
            run._pushAssistantMessage('📨 **遠端需求記錄**\n\n- 來自：**' + job.fromName + '**（' + (mem ? (mem.kind === 'desktop' ? '桌面版' : '網頁版') : '未知') + '）\n- 時間：' + new Date(now).toLocaleString() + '\n- 指紋：' + (fp || '—') + '（' + trust + '）\n- 任務編號：' + job.taskId + '\n\n這是群組裡另一台機器交給這台的需求，由這台機器用自己的模型與工具執行，結果會接在下面。\n\n這個對話已自動分享到群組：發出需求的機器可以在左邊清單看到它、並接著對話。', null);
            ctx.messages.push({ role: 'user', content: job.text });
            try { run._persistChatHistory(); } catch (_) { /* */ }
            this._chatListSig = null; this._renderChatList(); this._saveChatIndex(); this._chatMarkUnread(ctx); this._rgPushChats(); return ctx;
        },
        _rgChatRecord(job, ev) {
            const ctx = job.chatCtx; if (!ctx) return;
            try {
                const run = this._chatRunner(ctx), refs = ev.refs || [], refNames = refs.map((r) => r.name).join('、');
                if (job.chatInline) { this._rgRecordInline(job, ev, run, refs, refNames); return; }
                const txt = ev.kind === 'done' ? (ev.text || '（沒有文字結果）') + (refNames ? '\n\n> 📎 產生了 ' + refs.length + ' 項內容：' + refNames + '（在下面可以直接開啟）' : '') : ev.kind === 'stopped' ? '⏹ 已停止。' + (ev.text ? '\n\n' + ev.text : '') : '⚠️ ' + (ev.kind === 'rejected' ? '被拒絕：' : '失敗：') + (ev.error || '');
                run._pushAssistantMessage(txt, null);
                if (job.trace && job.trace.length) run._pushAssistantMessage('<details><summary>🔎 處理過程（' + job.trace.length + ' 行，點開看）</summary><div style="white-space:pre-wrap; font-size:12px; opacity:.85;">' + this._escapeHtml(job.trace.join('\n')) + '</div></details>', null);
                if (ev.kind === 'done' && refs.length) run._pushDisplayToolMessage('[這台產生了 ' + refs.length + ' 項內容：' + refNames.slice(0, 120) + '，已在對話裡顯示成可開啟的卡片]', '_displayRemoteFiles', { nodeId: this._rg ? this._rg.room.self.nodeId : '', machine: '這台', items: refs.map((r) => Object.assign({}, r, { localId: r.id, localDeckUrl: r.kind === 'deck' ? 'client-file/' + r.id + '.deck.yaml' : undefined })) });
                try { run._setRespondingState(false, '', ev.kind === 'done' ? 'completed' : 'stopped'); } catch (_) { /* */ }
                run._persistChatHistory(); try { run._renderMessageHistory(); } catch (_) { /* 不在畫面上 */ }
                const en = this._chatEntry(ctx.id); if (en) { en.updatedAt = Date.now(); this._saveChatIndex(); }
                this._chatListSig = null; this._renderChatList(); this._chatMarkUnread(ctx);
            } catch (_) { /* 記錄失敗不影響任務本身 */ }
        },
        // 把這次任務裡每個工具呼叫的「原始回傳資料」整理成一個檔案一起傳回去：AI 的結果文字常常只是摘要（例如只列前幾筆），
        // 完整資料要有，委託端才能拿去做簡報、算數或核對。單筆超過 300KB 截斷、總量 3MB 之後的略過，並在檔案裡寫明；圖片資料（dataUrl）省略，圖片另外有檔案。
        async _rgAddRawData(job, cap) {
            const tools = job.tools || []; if (!tools.length) return;
            const MAX_ONE = 300 * 1024, MAX_ALL = 3 * 1024 * 1024; let total = 0, omitted = 0; const calls = [];
            const clean = (s) => String(s).replace(/"dataUrl"\s*:\s*"data:[^"]{200,}"/g, '"dataUrl":"[圖片資料已省略，圖片另存為檔案]"');
            for (const t of tools) {
                let r = clean(t.res), cut = false; if (r.length > MAX_ONE) { r = r.slice(0, MAX_ONE); cut = true; }
                if (total + r.length > MAX_ALL) { omitted++; continue; } total += r.length;
                let result = r; if (!cut) { try { result = JSON.parse(r); } catch (_) { /* 不是 JSON：留原文 */ } }
                let args = t.args; try { args = JSON.parse(t.args); } catch (_) { /* 留原文 */ }
                calls.push({ tool: t.name, arguments: args, result, truncated: cut || undefined, at: new Date(t.at).toISOString() });
            }
            const doc = { note: '這台機器在執行需求時，每個工具呼叫的原始回傳資料（完整，沒有經過 AI 摘要）。單筆超過 300KB 會截斷，總量超過 3MB 之後的呼叫會略過（omitted_after_limit）。', request: String(job.text).slice(0, 500), executed_by: this._rg ? this._rg.room.self.name : '', for: job.fromName, calls, omitted_after_limit: omitted || undefined };
            const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' }), id = await this.fileCache.put('原始工具資料-' + String(job.taskId).slice(-6) + '.json', 'application/json', blob, 'generated');
            cap.push({ id, name: '原始工具資料.json', mime: 'application/json', size: blob.size });
        },
        // 沒有對話清單時的記錄：一個預設收起來的框（不影響使用者正在看的畫面），點開才看到來源、需求、完整報告、處理過程；檔案卡片接在後面
        _rgRecordInline(job, ev, run, refs, refNames) {
            const e = (s) => this._escapeHtml(String(s)), rg = this._rg, mem = rg && rg.room.members().find((m) => m.nodeId === job.from), st = mem ? this._rgTrustState(mem) : 'none', fp = (rg && rg.fps && rg.fps[job.from]) || '';
            const trust = { trusted: '指紋已核對', changed: '⚠️ 指紋跟你核對過的不同', new: '指紋尚未核對', none: '沒有指紋' }[st], icon = ev.kind === 'done' ? '✅' : ev.kind === 'stopped' ? '⏹' : '⚠️';
            const body = ev.kind === 'done' ? (ev.text || '（沒有文字結果）') : ev.kind === 'stopped' ? '已依對方要求停止。' + (ev.text ? '\n\n' + ev.text : '') : (ev.kind === 'rejected' ? '被拒絕：' : '失敗：') + (ev.error || '');
            const proc = job.trace && job.trace.length ? '\n\n<details><summary>🔎 處理過程（' + job.trace.length + ' 行）</summary><div style="white-space:pre-wrap; font-size:12px; opacity:.85;">' + e(job.trace.join('\n')) + '</div></details>' : '';
            const md = '<details>\n<summary>📨 遠端需求（來自 ' + e(job.fromName) + '）：' + icon + ' ' + e(String(job.text).replace(/\s+/g, ' ').slice(0, 40)) + '　<span style="opacity:.7">點開看完整內容</span></summary>\n\n'
                + '- 來自：**' + job.fromName + '**（' + (mem ? (mem.kind === 'desktop' ? '桌面版' : '網頁版') : '未知') + '）　時間：' + new Date().toLocaleString() + '\n- 指紋：' + (fp || '—') + '（' + trust + '）\n- 任務編號：' + job.taskId + '\n\n**需求**\n\n' + job.text.split('\n').map((l) => '> ' + l).join('\n') + '\n\n**結果**\n\n' + body
                + (refNames ? '\n\n> 📎 產生了 ' + refs.length + ' 項內容：' + refNames + '（卡片在下面）' : '') + proc + '\n\n</details>';
            run._pushAssistantMessage(md, null);
            if (ev.kind === 'done' && refs.length) run._pushDisplayToolMessage('[這台產生了 ' + refs.length + ' 項內容：' + refNames.slice(0, 120) + '，已在對話裡顯示成可開啟的卡片]', '_displayRemoteFiles', { nodeId: rg ? rg.room.self.nodeId : '', machine: '這台', items: refs.map((r) => Object.assign({}, r, { localId: r.id, localDeckUrl: r.kind === 'deck' ? 'client-file/' + r.id + '.deck.yaml' : undefined })) });
            run._persistChatHistory(); try { run._renderMessageHistory(); } catch (_) { /* 不在畫面上 */ }
        },
        // ---------------------------------------------------------------- 委託端：任務要撐過斷線與重新整理
        // 還沒做完的任務存在 localStorage（任務編號、對方名稱、對話、最後看到的序號）；重新連上、頁面回到前景、或太久沒消息時，
        // 向對方送「簽章過的 task_sync」要求補齊；對方回來換了連線身分也找得到（用名稱對）。結果回來時寫進當初的那個對話。
        _rgPendingStore() { try { return JSON.parse(localStorage.getItem('fa_remote_pending_v1') || '[]') || []; } catch (_) { return []; } },
        _rgPendingSave() {
            const rg = this._rg; if (!rg) return;
            const mine = Object.values(rg.tasks || {}).filter((t) => !t.done && !t.quiet).map((t) => ({ taskId: t.taskId, targetId: t.targetId, targetName: t.targetName, text: t.text, chatId: t.chatId || '', lastSeq: t.lastSeq || 0, at: t.at || Date.now(), group: rg.code }));
            const others = this._rgPendingStore().filter((p) => p.group !== rg.code && Date.now() - p.at < 24 * 3600 * 1000);
            try { localStorage.setItem('fa_remote_pending_v1', JSON.stringify(others.concat(mine))); } catch (_) { /* 無痕模式：重新整理後就接不回來 */ }
        },
        async _rgLoadPending() {
            const rg = this._rg; if (!rg) return; rg.tasks = rg.tasks || {};
            for (const p of this._rgPendingStore().filter((x) => x.group === rg.code && Date.now() - x.at < 24 * 3600 * 1000)) {
                if (rg.tasks[p.taskId]) continue; let run = this;
                try { if (p.chatId && this._chatListEnabled && this._chatIndex && this._chatEntry(p.chatId)) run = this._chatRunner(await this._chatCtxLoad(p.chatId)); } catch (_) { run = this; }
                const prog = run._createProgressWidget('🛰️ 接續等待 ' + p.targetName + ' 的結果'); prog.update({ status: '重新連線後向對方要結果…' });
                rg.tasks[p.taskId] = { taskId: p.taskId, targetId: p.targetId, targetName: p.targetName, text: p.text, chatId: p.chatId, lastSeq: p.lastSeq || 0, at: p.at, prog, run, done: false, ack: true, absent: true, stopSent: false, lastEventAt: 0 };
            }
            this._rgOnMembersChange();
        },
        _rgSyncPending(force) {
            const rg = this._rg; if (!rg || !rg.tasks) return; const ids = new Set(rg.room.members().map((m) => m.nodeId));
            for (const task of Object.values(rg.tasks)) {
                if (task.done || task.quiet || !task.ack || !ids.has(task.targetId)) continue;
                if (!force && Date.now() - (task.lastEventAt || task.at || 0) < 20000) continue;
                task.lastEventAt = Date.now(); this._rgSend(task.targetId, 'task_sync', { taskId: task.taskId, since: task.lastSeq || 0 }).catch(() => {});
            }
        },
        // 結果回來時就把對方產生的檔案整包存到這邊（不等人去點）：之後對方關機、換身分、重新啟動，這邊都還有完整的內容
        async _rgAutoSave(run, group, grp) {
            const items = grp.items.filter((i) => ((i.size || 0) + (i.assets || []).reduce((n, a) => n + (a.size || 0), 0)) <= 80 * 1024 * 1024); if (!items.length) return;
            const prog = run._createProgressWidget('⬇️ 取回 ' + group.machine + ' 產生的 ' + items.length + ' 項內容'); let k = 0; const failed = [];
            for (const it of items) {
                k++; try { prog.update({ status: '取回「' + it.name + '」（' + k + '/' + items.length + '）…' }); await this._rgSaveItem(group, it, (d, t) => prog.update({ status: '取回「' + it.name + '」' + Math.round((d / (t || 1)) * 100) + '%（' + k + '/' + items.length + '）' }), { cancelled: false }); }
                catch (e) { failed.push(it.name + '：' + String((e && e.message) || e).slice(0, 60)); }
            }
            if (failed.length) prog.fail('有 ' + failed.length + ' 項沒取回（對方可能離線了；之後在卡片上按「存到這邊」再試）：' + failed.join('；')); else prog.finish('已全部存到這邊');
            try { run._persistChatHistory(); run._renderMessageHistory(); } catch (_) { /* */ }
        },
        // ---------------------------------------------------------------- 分享對話：讓群組成員看這台的某個對話、並接著對話
        // 只有「這台自己勾了分享」的對話才會被看到（對話右鍵→分享到群組）。接著對話（chat_say／chat_stop）要簽章、通過把關、
        // 這台要開著「允許派工」且不是唯讀模式；訊息會加上「[來自 某機器 的遠端訊息]」留在對話裡，由這台機器的 AI 用自己的模型與工具執行。
        _rgSharedList() {
            const idx = this._chatIndex; if (!idx) return [];
            return idx.chats.filter((c) => c.shared).map((c) => { const x = this._chatCtxs.get(c.id); return { id: c.id, title: c.title || '新對話', updatedAt: c.updatedAt || 0, running: !!(x && x.isResponding) }; });
        },
        _rgPushChats() {
            const rg = this._rg; if (!rg || rg.pushChatsTimer) return;
            rg.pushChatsTimer = setTimeout(() => { rg.pushChatsTimer = null; if (this._rg === rg) rg.room.send('*', 'chats', { list: this._rgSharedList() }).catch(() => {}); }, 800);
        },
        _rgToggleShare(id) {
            const en = this._chatEntry(id); if (!en) return;
            if (!en.shared && !window.confirm('分享這個對話到群組？\n\n群組裡的任何成員都能看到它的全部內容，並且可以在裡面接著對話——接著的內容會由這台機器的 AI 執行（可能用到這台機器的檔案與指令工具）。只有信任群組裡每個人時才建議分享。')) return;
            en.shared = !en.shared; this._saveChatIndex(); this._chatListSig = null; this._renderChatList(); this._rgPushChats();
        },
        // 對話裡「顯示用」的訊息（簡報播放器、檔案卡片）原本不會傳給看的人，只看得到文字；現在轉成檔案清單（r:'files'），
        // 看的人那邊畫成可開啟的卡片（簡報會在他那邊播放），檔案走一般的內容傳輸（直連或轉送）。
        async _rgChatFileGroups(m, to) {
            const rg = this._rg; if (!rg) return null; const fc = this.fileCache; let cap = [], machine = rg.room.self.name;
            if (m._displayDeckUrl) { const mm = /client-file\/([\w-]+)/.exec(String(m._displayDeckUrl)); if (mm) cap.push({ id: mm[1], name: '簡報.deck.yaml' }); }
            if (m._displayRemoteFiles && Array.isArray(m._displayRemoteFiles.items)) for (const it of m._displayRemoteFiles.items) { const id = it.localId || (m._displayRemoteFiles.nodeId === rg.room.self.nodeId ? it.id : ''); if (id) cap.push({ id, name: it.name, mime: it.mime }); }
            if (!cap.length) return null;
            let refs = []; try { refs = await this._rgBuildRefs(cap, null, to); } catch (_) { return null; }
            return refs.length ? { machine, refs } : null;
        },
        async _rgSerChat(ctx, to) {
            const out = [];
            for (const m of ctx.messages) {
                if (m && (m._displayDeckUrl || m._displayRemoteFiles)) { const g = await this._rgChatFileGroups(m, to); if (g) out.push({ r: 'files', t: '', machine: g.machine, refs: g.refs }); continue; }
                if (!m || m._suggestionChips || (m.role !== 'user' && m.role !== 'assistant')) continue;
                let text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p && p.type === 'text' ? p.text : p && p.type === 'image_url' ? '[圖片]' : '').filter(Boolean).join('\n') : '';
                if (!String(text).trim()) continue; out.push({ r: m.role, t: String(text).slice(0, 12000) });
            }
            return out.slice(-120);
        },
        async _rgOnChatsReq(m) { const rg = this._rg; if (!rg) return; try { await rg.room.send(m.from, 'chats', { rid: m.body && m.body.rid, list: this._rgSharedList() }); } catch (_) { /* */ } },
        async _rgOnChatGet(m) {
            const rg = this._rg; if (!rg) return; const b = m.body || {}, en = this._chatEntry(b.id), reply = (o) => rg.room.send(m.from, 'chat_msgs', Object.assign({ rid: b.rid }, o)).catch(() => {});
            if (!en || !en.shared) { reply({ error: '這個對話沒有分享（或已經取消分享）' }); return; }
            const ctx = await this._chatCtxLoad(b.id), msgs = await this._rgSerChat(ctx, m.from), last = msgs[msgs.length - 1], ver = msgs.length + ':' + (last ? last.t.length : 0) + ':' + msgs.filter((x) => x.refs).length + ':' + (ctx.isResponding ? 1 : 0);
            if (b.ver === ver) reply({ same: true, ver, running: !!ctx.isResponding }); else reply({ ver, msgs, title: en.title || '新對話', running: !!ctx.isResponding });
        },
        // 貼上對話紀錄時常帶著說話者標籤（「You: /media-presentation …」「使用者：…」）：判斷是不是斜線指令前先去掉，否則整句被當成一般文字、指令不會執行
        _rgStripLabel(text) { return String(text == null ? '' : text).trim().replace(/^(?:you|user|me|使用者|你|我)\s*[:：]\s*/i, ''); },
        async _rgOnChatSay(m) {
            const rg = this._rg; if (!rg) return; const b = m.body || {}, s = this._rgSettings(), who = this._rgTargetName(m.from) || m.from, en = this._chatEntry(b.id);
            const ack = (o) => rg.room.send(m.from, 'chat_ack', Object.assign({ rid: b.rid }, o)).catch(() => {});
            let err = await this._rgGate(m); if (!err && !s.allowDispatch) err = '這台機器目前不接受遠端需求'; if (!err && s.readonlySandbox) err = '這台機器設為「只允許唯讀與沙盒」，不能在分享的對話裡接著做事';
            if (!err && (!en || !en.shared)) err = '這個對話沒有分享（或已經取消分享）'; if (!err && (typeof b.text !== 'string' || !b.text.trim())) err = '沒有內容';
            if (err) { this._rgLog('拒絕了 ' + who + ' 在分享對話裡的訊息：' + err); ack({ ok: false, error: err }); return; }
            const ctx = await this._chatCtxLoad(b.id); if (ctx.isResponding) { ack({ ok: false, error: '這個對話的 AI 正在執行中，請等它做完或先按停止' }); return; }
            this._rgLog(who + ' 在分享的對話「' + String(en.title || '').slice(0, 14) + '」裡接著對話'); ack({ ok: true });
            // 斜線指令與技能指令（所有已登錄的 /xxx）要照指令的方式執行，不能當成一般文字丟給 AI（否則 AI 只會口頭規劃、不會真的做）
            const full = this._rgStripLabel(b.text).slice(0, 8000), tok = full.startsWith('/') ? full.split(/\s+/)[0].toLowerCase() : '', slash = tok && this.slashCommands.get(tok);
            if (slash) {
                const run = this._chatRunner(ctx); let argsText = full.slice(tok.length).trim();
                try { run._setRespondingState(true, '⏳ 指令執行中：' + tok); } catch (_) { /* */ }
                Promise.resolve().then(() => slash.handler(argsText, run))
                    .catch((e) => { try { run._pushAssistantMessage('⚠️ 指令執行失敗：' + String((e && e.message) || e), null); } catch (_) { /* */ } })
                    .finally(() => { try { run._setRespondingState(false, '', run.stopRequested ? 'stopped' : 'completed'); } catch (_) { /* */ } });
                return;
            }
            Promise.resolve().then(() => this._chatRunner(ctx).executeChat('[來自 ' + who + ' 的遠端訊息]\n' + b.text.trim().slice(0, 8000))).catch((e) => this._rgLog('分享對話執行失敗：' + String((e && e.message) || e)));
        },
        async _rgOnChatStop(m) {
            const rg = this._rg; if (!rg) return; const b = m.body || {}, en = this._chatEntry(b.id), ack = (o) => rg.room.send(m.from, 'chat_ack', Object.assign({ rid: b.rid }, o)).catch(() => {});
            const err = (await this._rgGate(m)) || (!en || !en.shared ? '這個對話沒有分享' : ''); if (err) { ack({ ok: false, error: err }); return; }
            const ctx = this._chatCtxs.get(b.id); if (ctx && ctx.isResponding) { ctx.stopRequested = true; try { if (ctx.currentAbortController) ctx.currentAbortController.abort(); } catch (_) { /* */ } this._rgLog((this._rgTargetName(m.from) || m.from) + ' 要求停止分享對話裡的執行'); }
            ack({ ok: true });
        },
        // ---------------------------------------------------------------- 群組動態：執行的機器把進度廣播給整個群組（像線上共編：所有人都看得到它在忙什麼、過程、最後結果）
        // 事件：start（開始或排隊）、progress（目前狀態）、trace（過程的每一行，約每秒合併送一次，每個任務最多 300 行）、done／failed／stopped／rejected（結果）。
        // 只是「看」：不含任何控制；內容跟群組裡本來就看得到的一樣（在群組裡的人都被視為互相信任）。
        _rgAct(job, ev) {
            const rg = this._rg; if (!rg) return;
            const b = { taskId: job.taskId, fromId: job.from, fromName: job.fromName, execName: rg.room.self.name, execId: rg.room.self.nodeId, text: String(job.text || '').slice(0, 300), sub: !!job.sub, kind: ev.kind, at: Date.now() };
            if (ev.status) b.status = String(ev.status).slice(0, 300); if (ev.lines) b.lines = ev.lines; if (ev.text) b.result = String(ev.text).slice(0, 6000); if (ev.error) b.error = String(ev.error).slice(0, 1000);
            if (ev.refs && ev.refs.length) b.refs = ev.refs.map((r) => r.name).slice(0, 20); if (ev.queued) b.queued = ev.queued;
            this._rgOnAct({ body: b }); // 自己也看得到自己在做的事（廣播不會送回自己）
            rg.room.send('*', 'act', b).catch(() => {});
        },
        _rgTrace(job, line) {
            job.traceN = (job.traceN || 0) + 1; if (job.traceN > 300) return; (job.traceBuf = job.traceBuf || []).push(String(line).slice(0, 300)); if (job.traceTimer) return;
            job.traceTimer = setTimeout(() => { job.traceTimer = null; const lines = (job.traceBuf || []).splice(0, 15); job.traceBuf = []; if (lines.length) this._rgAct(job, { kind: 'trace', lines }); }, 1000);
        },
        _rgOnAct(m) {
            const rg = this._rg; if (!rg) return; const b = m.body || {}; if (!b.taskId || typeof b.kind !== 'string') return; rg.acts = rg.acts || {};
            let a = rg.acts[b.taskId];
            if (!a) {
                a = rg.acts[b.taskId] = { id: b.taskId, fromName: String(b.fromName || ''), fromId: b.fromId, execName: String(b.execName || ''), execId: b.execId, text: String(b.text || ''), sub: !!b.sub, state: 'running', startedAt: b.at || Date.now(), lines: [], status: '', result: '', error: '', refs: [] };
                const all = Object.values(rg.acts).sort((x, y) => y.startedAt - x.startedAt); all.slice(30).forEach((x) => delete rg.acts[x.id]);
            }
            const add = (s) => { if (s && a.lines[a.lines.length - 1] !== s) { a.lines.push(String(s)); if (a.lines.length > 300) a.lines.shift(); } };
            if (b.kind === 'start') { a.state = b.queued > 0 ? 'queued' : 'running'; add(b.queued > 0 ? '排隊中（前面還有 ' + b.queued + ' 個）' : '開始'); }
            else if (b.kind === 'progress') { a.state = 'running'; a.status = b.status || ''; add(b.status); }
            else if (b.kind === 'trace') { a.state = a.state === 'queued' ? 'running' : a.state; (b.lines || []).forEach(add); }
            else if (FaRemoteDispatch.TERMINAL[b.kind]) { a.state = b.kind; a.endedAt = b.at || Date.now(); a.status = ''; a.result = b.result || ''; a.error = b.error || ''; a.refs = b.refs || []; add({ done: '完成', failed: '失敗：' + (b.error || ''), stopped: '已停止', rejected: '被拒絕：' + (b.error || '') }[b.kind]); }
            try { this._rgRenderActs(); this._chatListSig = null; this._renderChatList(); } catch (_) { /* 畫面還沒準備好 */ }
        },
        // 發出端斷線回來要求補齊：重播序號大於 since 的事件
        async _rgOnSync(m) {
            const rg = this._rg, b = m.body || {}; if (!rg) return; const since = Number(b.since) || 0, bad = await this._rgVerify(m);
            if (bad) { this._rgLog('忽略了一則補齊要求（' + bad + '）'); return; }
            const job = rg.exec && rg.exec[b.taskId];
            if (!job) { rg.room.send(m.from, 'task_ev', { taskId: b.taskId, seq: since + 1, kind: 'failed', error: '這台機器沒有這個任務的記錄（可能已重新整理或重新啟動）' }).catch(() => {}); return; }
            if (job.from !== m.from) {
                const mem = rg.room.members().find((x) => x.nodeId === m.from);
                if (!mem || !mem.pk || !job.fromPk || (mem.pk.x + mem.pk.y) !== job.fromPk) { this._rgLog('忽略了一則補齊要求：不是原本發出這個任務的機器'); return; }
                job.from = m.from; rg.shared = rg.shared || {};
                for (const ev of job.events) for (const it of (ev.refs || [])) { (rg.shared[it.id] = rg.shared[it.id] || new Set()).add(m.from); for (const a2 of (it.assets || [])) (rg.shared[a2.id] = rg.shared[a2.id] || new Set()).add(m.from); }
                this._rgSaveTask(job); this._rgLog(job.fromName + ' 換了連線身分（金鑰相同），已接續它的任務');
            }
            for (const ev of job.events.filter((e) => e.seq > since)) rg.room.send(m.from, 'task_ev', Object.assign({ taskId: job.taskId }, ev)).catch(() => {});
        },
        _rgOnStop(m) { const rg = this._rg, b = m.body || {}, job = rg && rg.exec && rg.exec[b.taskId]; if (job && !job.done && job.from === m.from) { job.stop = true; this._rgLog(job.fromName + ' 要求停止任務'); } },
    };
    installTracking.setNotify = (fn) => { agentNotify = fn; };
    return { methods, TERMINAL, installTracking, AGENTS };
})();
if (typeof module === 'object' && module.exports) module.exports = FaRemoteDispatch;
