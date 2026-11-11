/* 符號式訓練的工作執行器（UMD，依賴注入）：把 sym_suites_core.prepareTrain 回來的 units 一段一段跑，段與段之間檢查暫停／停止，
 * 全部做完 finish 寫成資產（owner:'user'），再跑一次該 kind 的評量，把結果寫進資產 manifest.eval 並更新評量基準。設計 §15.3。
 *   createRunner({ storage, Asset, Trainer, now, tick, onChange, runEval })
 *   start(kind, name, prepared, o) → { ok, jobId }       同一時間只跑一個符號式訓練
 *   status(jobId?) / pause(jobId?) / resume(jobId?) / stop(jobId?)
 * 暫停＝目前這一段做完後停住，記住做到第幾段，resume 從下一段繼續（只在同一次開啟內有效；關掉視窗／程式會丟失進度，因為 units 是記憶體裡的閉包——
 * 若要跨重開續訓，需要把每段的輸入輸出序列化成檢查點，目前沒做）。停止＝丟棄，不寫資產。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioSymTrain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function createRunner(h) {
        const jobs = new Map(); let active = null, seq = 0; const now = () => (h.now ? h.now() : Date.now()); const tick = h.tick || (() => new Promise((r) => setTimeout(r, 0)));
        const view = (j) => ({ ok: true, jobId: j.id, kind: j.kind, name: j.name, state: j.state, done: j.cursor, total: j.units.length, pct: j.units.length ? Math.round(j.cursor / j.units.length * 100) : 100, current: j.current || '', log: j.log.slice(-40), error: j.error || null, result: j.result || null, note: j.note || '', elapsedMs: (j.endedAt || now()) - j.startedAt });
        const note = (j, text) => { j.log.push({ at: now(), text }); if (j.log.length > 300) j.log.shift(); if (h.onChange) { try { h.onChange(j); } catch (_) { /* */ } } };
        async function loop(j) {
            j.state = 'running'; j.pauseReq = false; note(j, j.cursor ? '繼續：從第 ' + (j.cursor + 1) + ' 段' : '開始（共 ' + j.units.length + ' 段）');
            try {
                while (j.cursor < j.units.length) {
                    if (j.stopReq) { j.state = 'stopped'; j.endedAt = now(); note(j, '已停止（不寫資產）'); active = null; return; }
                    if (j.pauseReq) { j.state = 'paused'; note(j, '已暫停在第 ' + j.cursor + '／' + j.units.length + ' 段後'); return; }
                    const u = j.units[j.cursor]; j.current = u.label; const t0 = now();
                    try { await u.run({ job: j }); } catch (e) { if (u.optional) note(j, '略過（' + u.label + '）：' + String((e && e.message) || e)); else throw e; }
                    note(j, u.label + '（' + (now() - t0) + ' ms）'); j.cursor++; await tick();
                }
                if (j.stopReq) { j.state = 'stopped'; j.endedAt = now(); active = null; return; }
                j.state = 'finishing'; note(j, '寫成資產 ' + j.kind + '/' + j.name);
                const fin = await j.prepared.finish({ job: j }); const out = await saveResult(j, fin);
                j.result = out; j.state = 'finished'; j.endedAt = now(); note(j, '完成：' + JSON.stringify(out.counts || {})); active = null;
            } catch (e) { j.state = 'error'; j.error = String((e && e.message) || e); j.endedAt = now(); note(j, '失敗：' + j.error); active = null; }
        }
        async function saveResult(j, fin) {
            const created = new Date(now()).toISOString(); const saved = [];
            if (j.kind === 'trainer') {
                const mk = (bundle, name) => { const c = h.Trainer.bundleToAsset(bundle, { name }); if (!c.ok) throw new Error(c.error); return c.asset; };
                if (fin.bundleBefore) { const b = mk(fin.bundleBefore, j.name + '-before'); const w = await h.storage.saveAsset(b, { replace: true }); if (!w.ok) throw new Error(w.error); saved.push('trainer/' + j.name + '-before'); }
                const a = mk(fin.bundleAfter, j.name); const w2 = await h.storage.saveAsset(a, { replace: true }); if (!w2.ok) throw new Error(w2.error); saved.push('trainer/' + j.name);
                return { saved, counts: fin.counts, evalSummary: null };
            }
            const files = fin.files || {}; const m = h.Asset.createManifest({ kind: j.kind, name: j.name, files, counts: fin.counts || {}, owner: 'user', created, eval: fin.eval || null, extra: Object.assign({ train: { note: j.note, units: j.units.length, ms: now() - j.startedAt, backend: 'cpu-js' } }, fin.extra || {}) });
            const w = await h.storage.saveAsset({ manifest: m, files }, { replace: true }); if (!w.ok) throw new Error(w.error); saved.push(j.kind + '/' + j.name);
            return { saved, counts: fin.counts, eval: fin.eval || null };
        }
        return {
            start(kind, name, prepared, o) {
                if (active && (active.state === 'running' || active.state === 'paused' || active.state === 'finishing')) return { ok: false, error: '已有符號式訓練在進行（' + active.kind + '/' + active.name + '，' + active.state + '）；先暫停後繼續、或停止它' };
                if (!prepared || !prepared.ok) return { ok: false, error: (prepared && prepared.error) || '沒有可執行的訓練' };
                if (!h.Asset.safeName(name)) return { ok: false, error: '名稱不合法：' + name };
                const j = { id: 'sym' + (++seq), kind, name, units: prepared.units, prepared, cursor: 0, state: 'queued', log: [], startedAt: now(), note: prepared.note || '', opts: o || {} };
                jobs.set(j.id, j); active = j; loop(j); return { ok: true, jobId: j.id, total: j.units.length, note: j.note };
            },
            status(id) { const j = jobs.get(id) || active || Array.from(jobs.values()).pop(); return j ? view(j) : { ok: true, state: 'idle', done: 0, total: 0, pct: 0, log: [] }; },
            async pause(id) { const j = jobs.get(id) || active; if (!j || j.state !== 'running') return { ok: false, error: '沒有執行中的符號式訓練可暫停' }; j.pauseReq = true; for (let i = 0; i < 400 && j.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10)); return view(j); },
            resume(id) { const j = jobs.get(id) || active; if (!j || j.state !== 'paused') return { ok: false, error: '沒有暫停中的訓練可繼續' }; loop(j); return { ok: true, jobId: j.id, done: j.cursor, total: j.units.length }; },
            stop(id) { const j = jobs.get(id) || active; if (!j || !(j.state === 'running' || j.state === 'paused')) return { ok: true, already: true }; j.stopReq = true; if (j.state === 'paused') { j.state = 'stopped'; j.endedAt = now(); active = null; } return { ok: true }; },
            isActive: () => !!active && (active.state === 'running' || active.state === 'paused' || active.state === 'finishing'),
            jobs
        };
    }
    return { createRunner };
});
