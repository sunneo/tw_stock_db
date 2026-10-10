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
    const idb = () => new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('沒有 IndexedDB')); return; }
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { r.result.createObjectStore(STORE_T, { keyPath: 'taskId' }); };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    const tx = async (mode, fn) => { const db = await idb(); return new Promise((resolve, reject) => { const t = db.transaction(STORE_T, mode); const out = fn(t.objectStore(STORE_T)); t.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : out); }; t.onerror = () => { db.close(); reject(t.error); }; }); };

    const methods = {
        // ---------------------------------------------------------------- 事件記錄（被派工的一端；重新整理後還在）
        async _rgSaveTask(job) { try { await tx('readwrite', (s) => s.put({ taskId: job.taskId, from: job.from, fromName: job.fromName, text: job.text, events: job.events, updatedAt: Date.now() })); } catch (_) { /* 無痕模式沒有 IndexedDB：只在記憶體 */ } },
        async _rgLoadTasks() {
            let all = []; try { all = await tx('readonly', (s) => s.getAll()); } catch (_) { return; }
            const rg = this._rg; if (!rg) return; rg.exec = rg.exec || {};
            all.sort((a, b) => a.updatedAt - b.updatedAt);
            for (const r of all.slice(-MAX_KEEP)) {
                const job = { taskId: r.taskId, from: r.from, fromName: r.fromName, text: r.text, events: r.events || [], done: false };
                if (!job.events.some((e) => TERMINAL[e.kind])) { job.events.push({ seq: job.events.length + 1, kind: 'failed', error: '這台機器重新整理或重新啟動，任務中斷了（需要的話請重新送出）' }); await this._rgSaveTask(job); }
                job.done = true; rg.exec[job.taskId] = job;
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
            const task = { taskId, targetId, targetName: t.name, prog, lastSeq: 0, done: false, text, run: this, ack: false, stopSent: false, absent: false };
            rg.tasks = rg.tasks || {}; rg.tasks[taskId] = task;
            try { this._setRespondingState(true, '⏳ 等 ' + t.name + ' 完成：' + text.slice(0, 20)); } catch (_) { /* */ }
            const finished = new Promise((resolve) => { task.resolve = resolve; });
            try { await rg.room.send(targetId, 'task', { taskId, text, fromName: rg.room.self.name }); }
            catch (e) { this._rgTaskEnd(task, 'failed', '送出失敗：' + String((e && e.message) || e)); }
            task.ackTimer = setTimeout(() => { if (!task.ack && !task.done) this._rgTaskEnd(task, 'failed', t.name + ' 沒有回應（15 秒）。對方可能已離線，或分頁被瀏覽器凍結了。'); }, 15000);
            // 使用者按「停止」：通知對方也停下來
            task.stopTimer = setInterval(() => { if (!task.done && !task.stopSent && task.run.stopRequested) { task.stopSent = true; rg.room.send(targetId, 'task_stop', { taskId }).catch(() => {}); prog.update({ status: '已通知 ' + t.name + ' 停止…' }); } }, 500);
            await finished;
        },
        _rgTaskEnd(task, kind, textOrError, visual) {
            if (task.done) return; task.done = true; clearTimeout(task.ackTimer); clearInterval(task.stopTimer);
            const run = task.run, name = task.targetName;
            if (kind === 'done') {
                task.prog.finish('完成（由 ' + name + ' 執行）');
                const note = visual ? '\n\n> 📎 ' + name + ' 產生了「' + (visual.title || visual.type || '內容') + '」（' + visual.type + '）。**內容傳輸（在這裡開啟、存到這邊）下一階段開放**；目前只傳回文字結果。' : '';
                run._pushAssistantMessage('🖥️ **' + name + '** 完成：\n\n' + (textOrError || '（沒有文字結果）') + note, null);
            } else {
                const label = { failed: '失敗', stopped: '已停止', rejected: '被拒絕' }[kind] || kind;
                task.prog.fail(name + '：' + label + (textOrError ? '（' + textOrError + '）' : ''));
                run._pushAssistantMessage('⚠️ ' + name + ' ' + label + '：' + (textOrError || ''), null);
            }
            try { run._renderMessageHistory(); run._persistChatHistory(); run._setRespondingState(false, '', kind === 'done' ? 'completed' : 'stopped'); } catch (_) { /* */ }
            task.resolve && task.resolve();
        },
        _rgOnEvent(m) {
            const rg = this._rg, b = m.body || {}, task = rg && rg.tasks && rg.tasks[b.taskId]; if (!task || task.done) return;
            if (m.type === 'task_ack') { task.ack = true; clearTimeout(task.ackTimer); task.prog.update({ status: b.queued > 0 ? '對方正在忙，已排隊（前面還有 ' + b.queued + ' 個）' : task.targetName + ' 開始處理…' }); return; }
            if (m.type !== 'task_ev') return;
            task.ack = true; clearTimeout(task.ackTimer);
            if (b.seq && b.seq <= task.lastSeq) return; // 重複的事件（斷線補齊時會重送）
            task.lastSeq = b.seq || task.lastSeq;
            if (b.kind === 'progress') task.prog.update({ status: b.status || '處理中…' });
            else if (b.kind === 'trace') task.prog.log(b.status || '');
            else if (TERMINAL[b.kind]) this._rgTaskEnd(task, b.kind, b.kind === 'done' ? b.text : (b.error || b.text), b.visual);
        },
        // 成員名單變動：目標離線／回來。回來時用最後看到的序號補齊錯過的事件
        _rgOnMembersChange() {
            const rg = this._rg; if (!rg || !rg.tasks) return;
            const ids = new Set(rg.room.members().map((m) => m.nodeId));
            for (const task of Object.values(rg.tasks)) {
                if (task.done) continue;
                if (!ids.has(task.targetId)) { if (!task.absent) { task.absent = true; task.prog.update({ status: task.targetName + ' 離線了…它回來時我會接續（它如果還在執行，結果不會遺失）' }); } }
                else if (task.absent) { task.absent = false; task.prog.update({ status: task.targetName + ' 回來了，補齊錯過的進度…' }); rg.room.send(task.targetId, 'task_sync', { taskId: task.taskId, since: task.lastSeq }).catch(() => {}); }
            }
            if (this._rgTarget && !ids.has(this._rgTarget) && !Object.values(rg.tasks).some((t) => !t.done && t.targetId === this._rgTarget)) this._rgTarget = '';
        },

        // ---------------------------------------------------------------- 被派工的一端
        _rgEvent(job, ev) {
            const rg = this._rg; if (!rg) return;
            ev.seq = job.events.length + 1; job.events.push(ev); this._rgSaveTask(job);
            rg.room.send(job.from, 'task_ev', Object.assign({ taskId: job.taskId }, ev)).catch(() => { /* 對方離線：回來時用 task_sync 補 */ });
        },
        async _rgOnTask(m) {
            const rg = this._rg; if (!rg) return; const b = m.body || {}; if (!b.taskId || typeof b.text !== 'string') return;
            rg.exec = rg.exec || {}; if (rg.exec[b.taskId]) return; // 重複送來的同一個任務
            const s = this._rgSettings(), fromName = b.fromName || this._rgTargetName(m.from) || m.from;
            const job = { taskId: b.taskId, from: m.from, fromName, text: b.text, events: [], done: false, stop: false };
            rg.exec[b.taskId] = job;
            if (!s.allowDispatch) { this._rgEvent(job, { kind: 'rejected', error: '這台機器目前不接受遠端需求' }); job.done = true; this._rgLog('拒絕了 ' + fromName + ' 的需求（設定不允許）'); return; }
            const queued = rg.running || 0; rg.running = queued + 1; rg.room.self.busy = true; try { await rg.room.publishSelf(); } catch (_) { /* */ }
            await rg.room.send(m.from, 'task_ack', { taskId: b.taskId, queued }).catch(() => {});
            this._rgLog('收到 ' + fromName + ' 的需求：' + b.text.slice(0, 30));
            rg.queue = (rg.queue || Promise.resolve()).then(() => this._rgRunTask(job)).catch(() => {}).then(async () => { rg.running = Math.max(0, (rg.running || 1) - 1); if (!rg.running) { rg.room.self.busy = false; try { await rg.room.publishSelf(); } catch (_) { /* */ } } });
        },
        async _rgRunTask(job) {
            const s = this._rgSettings(); const prog = this._createProgressWidget('🛰️ 遠端需求（來自 ' + job.fromName + '）：' + job.text.slice(0, 24));
            let lastSent = 0;
            const progress = (status, force) => { prog.update({ status }); const now = Date.now(); if (force || now - lastSent > 800) { lastSent = now; this._rgEvent(job, { kind: 'progress', status }); } };
            if (job.stop) { this._rgEvent(job, { kind: 'stopped' }); prog.fail('已停止'); job.done = true; return; }
            try {
                const opts = { onProgress: (st) => progress(String(st)), onTrace: (line) => prog.log(line), shouldStop: () => job.stop };
                if (s.readonlySandbox && this.domains && this.domains.research) { opts.allowedToolNames = this._resolveDomainToolNames(this.domains.research); opts.systemPrompt = this._resolveDomainSystemPrompt(this.domains.research); }
                progress('開始處理…', true);
                const res = await this._runSubAgentTask('這是群組裡另一台機器（' + job.fromName + '）交給你的需求，請完成它並回覆結果：\n\n' + job.text, 40, opts);
                const text = res && res.text ? String(res.text) : '';
                const v = res && res.visual ? { type: res.visual.type, title: res.visual.title || res.visual.name || '' } : null;
                if (job.stop) { this._rgEvent(job, { kind: 'stopped', text }); prog.fail('已停止'); }
                else { this._rgEvent(job, { kind: 'done', text, visual: v }); prog.finish('完成'); }
            } catch (e) { const msg = String((e && e.message) || e); this._rgEvent(job, { kind: 'failed', error: msg }); prog.fail(msg); }
            job.done = true;
        },
        // 發出端斷線回來要求補齊：重播序號大於 since 的事件
        _rgOnSync(m) {
            const rg = this._rg, b = m.body || {}, job = rg && rg.exec && rg.exec[b.taskId]; const since = Number(b.since) || 0;
            if (!job) { rg && rg.room.send(m.from, 'task_ev', { taskId: b.taskId, seq: since + 1, kind: 'failed', error: '這台機器沒有這個任務的記錄（可能已重新整理或重新啟動）' }).catch(() => {}); return; }
            for (const ev of job.events.filter((e) => e.seq > since)) rg.room.send(m.from, 'task_ev', Object.assign({ taskId: job.taskId }, ev)).catch(() => {});
        },
        _rgOnStop(m) { const rg = this._rg, b = m.body || {}, job = rg && rg.exec && rg.exec[b.taskId]; if (job && !job.done && job.from === m.from) { job.stop = true; this._rgLog(job.fromName + ' 要求停止任務'); } },
    };
    return { methods, TERMINAL };
})();
if (typeof module === 'object' && module.exports) module.exports = FaRemoteDispatch;
