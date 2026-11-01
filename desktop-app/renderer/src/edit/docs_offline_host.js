/* 表格／文字／Word 編輯器的離線 AI（接在 video_host.js 後面,同一個 FaEditHost）:離線模式下,程式讀不懂的句子不交給離線小模型寫 JSON,而是走整套 harness
 * (FaDocSemantics:細切意圖 → 用編輯器的狀態推導參數 → UML 使用案例 → CoLU 單元目錄接線成 sheet_*／text_*／doc_* 工具呼叫 → 變成編輯器的封閉動作 → 之後仍由 applyEdits 逐項檢查)。
 * 同一組工具也登記成聊天裡 agent 可以呼叫的工具(作用在開著的那個編輯器),CoLU 單元目錄、離線訓練器、聊天 agent 用同一套詞彙。 */
(function () {
    'use strict';
    const H = FaEditHost, T = H.T, M = H.methods;
    const KINDS_OF = { sheet: ['edit-csv', 'edit-xlsx'], text: ['edit-markdown', 'edit-text'], doc: ['edit-docx'] };
    M._edLiveDocEditor = function (domain) {
        const m = this._edEditors; if (!m) return null; let found = null;
        m.forEach((holder, key) => { const k = key.split(':')[0]; if (KINDS_OF[domain].indexOf(k) >= 0 && holder && holder._ed && holder._ed.ctx && holder.isConnected !== false) found = holder; });
        return found;
    };
    // 區塊的 n（第幾個）換成 id；工具給了 id 就用 id
    function withIds(args, spec) {
        const a = Object.assign({}, args); if (a.n != null && !a.id && spec && spec.objects) { const b = spec.objects[Number(a.n) - 1]; if (b) a.id = b.id; } delete a.n; return a;
    }
    M._registerEditDocsAgentTools = function (registerOptional) {
        const DS = window.FaDocSemantics; if (!DS) return; const self = this;
        const parse = async (s, raw) => { let a = {}; try { a = await s.repairJsonPayload(String(raw || '{}')); } catch (_) { /* */ } return a || {}; };
        Object.keys(DS.TOOLS).forEach((name) => {
            const t = DS.TOOLS[name], props = {}; Object.keys(t.props).forEach((k) => { props[k] = Object.assign({}, t.props[k]); if (!props[k].description) props[k].description = k; });
            registerOptional(name, t.desc, async function (rawArgs) {
                const a = await parse(this, rawArgs), holder = this._edLiveDocEditor(t.domain);
                if (!holder) return JSON.stringify({ ok: false, error: T('沒有開著的對應編輯器(先 /edit-csv、/edit-xlsx、/edit-markdown、/edit-text 或 /edit-docx)', 'No matching editor is open') });
                const spec = holder._ed.getSpec(), edit = DS.toEdit(name, name.indexOf('sheet_') === 0 ? a : withIds(a, spec), spec.format);
                if (!edit) return JSON.stringify({ ok: false, error: 'unknown action ' + name });
                try { const r = holder._ed.ctx.apply([edit], '', '', 'chat'); return JSON.stringify({ ok: !!(r && r.applied && r.applied.length), applied: (r && r.applied) || [], rejected: ((r && r.rejected) || []).map((x) => x.error) }); } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); }
            }, { type: 'object', properties: props, required: t.required || [], additionalProperties: false });
        });
    };
    { const prev = M._registerEditTools; M._registerEditTools = function (ro) { if (prev) prev.call(this, ro); this._registerEditDocsAgentTools(ro); }; }
    // 離線 AI:harness(讀不懂的明講,不猜);回 { say, edits, notes }
    M._edOfflineDocs = async function (domain, req, onStep) {
        const DS = window.FaDocSemantics, spec = req.spec || {}, say = typeof onStep === 'function' ? onStep : () => {}, notes = [];
        if (!DS || typeof FaHarnessHost === 'undefined') return { say: T('離線 AI 還沒準備好', 'The offline AI is not ready'), edits: [], notes };
        say(T('離線 AI：細切意圖、推導語意、UML 接線(CoLU)…', 'Offline AI: decompose the intents, derive the semantics, wire through UML (CoLU)…'));
        const sel = req.selection || (req.env && req.env.selection) || null, state = DS.stateOf(domain, spec, sel); let h = null;
        try { h = await this._harnessRun(domain, String(req.text || ''), state, { onStep: say }); } catch (e) { notes.push(String((e && e.message) || e).slice(0, 80)); }
        const edits = h && h.calls ? h.calls.map((c) => DS.toEdit(c.tool, c.args, spec.format)).filter(Boolean) : [];
        if (h) { (h.derived || []).forEach((x) => notes.push(T('推導：', 'Derived: ') + x)); (h.gaps || []).forEach((g) => notes.push(T('缺：', 'Gap: ') + g)); }
        const head = edits.length ? T('離線：細切成 ' + h.total + ' 個意圖，CoLU 接上 ' + h.wired + '/' + h.total, 'Offline: ' + h.total + ' intent(s), CoLU wired ' + h.wired + '/' + h.total) : T('離線：這句話我沒有讀懂，也沒有可以直接做的動作（見下面「缺」）。可以直接改，或說「把第 2 段改成…」「B 欄由大到小排序」這類句子。', 'Offline: I could not read that (see the gaps below).');
        return { say: head, edits, notes };
    };
})();
