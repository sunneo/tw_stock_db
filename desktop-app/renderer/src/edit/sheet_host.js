/* /edit-csv、/edit-xlsx(/edit-sheet) 的主機轉接層(接在 docs_host.js 後面,同一個 FaEditHost)。設計見 DESIGN.edit-docs.md。
 * 文件是工作表的清單(FaEditSheet);AI 只能用封閉動作改(FaEditSheet.AI_OPS),且只看欄位概要;程式讀得懂的白話(parseCommands)由外框先處理。
 * 遠端:登記就帶 remote 宣告(sync:'edits'),所以「AI 在」下拉、by 標籤、一致性檢查、多人同編都自動涵蓋。 */
(function () {
    'use strict';
    const H = FaEditHost, T = H.T, M = H.methods;
    const SHEETY = /\.(csv|tsv|xlsx)$/i;
    const decodeText = (buf) => { const u = new Uint8Array(buf); try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(u); } catch (_) { try { return new TextDecoder('big5').decode(u); } catch (__) { return new TextDecoder('utf-8').decode(u); } } };
    function coreFor(fmt) {
        const C = FaEditSheet, pick = (id) => (fmt === 'xlsx' ? (id === 'blank' ? 'sheet' : id) : id);
        return { validate: (s) => C.validate(s), listStarters: () => C.listStarters().filter((t) => (t.id === 'budget' || t.id === 'sheet') === (fmt === 'xlsx')), starter: (id) => C.starter(pick(String(id || 'blank'))) };
    }
    const KIND = (fmt) => {
        const x = fmt === 'xlsx';
        return {
            fence: x ? 'fa-edit-xlsx' : 'fa-edit-csv', icon: x ? '📊' : '🧾', cmd: x ? '/edit-xlsx' : '/edit-csv', prefix: x ? 'xl' : 'cs', label: () => (x ? T('試算表編輯器', 'Spreadsheet editor') : T('CSV 編輯器', 'CSV editor')),
            core: () => coreFor(fmt),
            ui: () => ({ mount: (o) => FaEditSheetUI.mount(Object.assign({}, o, { host: Object.assign(o.host || {}, o._sheetHostExt || {}) })) }),
            mountOpts: function (id) { return { _sheetHostExt: this._sheetHostExt(x ? 'edit-xlsx' : 'edit-csv', id) }; },
            lead: x ? '📊 試算表編輯器:工作表在左邊,公式(SUM、AVERAGE、IF、VLOOKUP…)會算,公式與算好的值都保留。單擊選格、雙擊或直接打字改;用說的:排序、刪空白列、加欄加列、取代。每一步都能復原。'
                : '🧾 CSV 編輯器:沒動到的檔案一個位元組都不會變(分隔符號、換行、引號、BOM 都保留)。單擊選格、雙擊或直接打字改;用說的:排序、刪空白列／重複列、加欄加列、條件式刪列、取代。每一步都能復原。',
            polishSystem: 'You tidy a prompt that rebuilds a table. Keep every fact (columns, rules, wording of the user\'s instructions); make it one clear, reusable prompt. Answer with the prompt only.',
            remote: { sync: 'edits', methods: { ask: { doc: true }, polish: {} } },
            ask: function (req, ed) { return this._edAskSheet(req, ed, fmt); },
            help: () => '**' + (x ? T('試算表編輯器', 'Spreadsheet editor') : T('CSV 編輯器', 'CSV editor')) + '**\n\n' + (x ? '`/edit-xlsx`' : '`/edit-csv`') + T(':開一個空的表,或 `/edit-file 檔名` 開附上的檔案。', ': open an empty table, or `/edit-file name` for an attached file.'),
        };
    };
    H.register('edit-csv', KIND('csv'));
    H.register('edit-xlsx', KIND('xlsx'));

    // ───── 編輯器的檔案轉接(xlsx 需要 JSZip;沒改過的 xlsx 匯出原檔,所以原檔存在 fileCache) ─────
    M._sheetHostExt = function (kind, id) {
        const self = this;
        return {
            jszip: async () => { await self._ensureJSZipLoaded(); return window.JSZip; },
            origXlsx: async () => { const o = await self._edOriginGet(kind, id), fid = o && o.origFile; if (!fid) return null; const rec = await self.fileCache.get(fid); return rec && rec.blob ? new Uint8Array(await rec.blob.arrayBuffer()) : null; },
            keepOrig: async (bytes) => { const rec = await self.fileCache.put('origin-' + id + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', new Blob([bytes]), 'uploaded'); const fid = rec && rec.id ? rec.id : rec; if (fid) await self._edPatchOrigin(kind, id, (o) => { o.origFile = fid; }); },
        };
    };
    M._edOpenSheetFile = async function (name, buf, extra) {
        const isX = /\.xlsx$/i.test(name), title = String(name).replace(/\.[^.]+$/, '').slice(0, 80); let spec;
        if (isX) { await this._ensureJSZipLoaded(); spec = await FaEditSheet.readXlsx(new Uint8Array(buf), window.JSZip, title); } else { spec = FaEditSheet.parseCsv(decodeText(buf), title); }
        const kind = spec.format === 'xlsx' ? 'edit-xlsx' : 'edit-csv', res = await this._edOpen(kind, Object.assign({ spec, origin: { file: { name: String(name), size: buf.byteLength || 0 } } }, extra || {}));
        if (isX && res && res.ok) { try { await this._sheetHostExt(kind, res.id).keepOrig(new Uint8Array(buf)); } catch (_) { /* 原檔沒存到:匯出時重新產生 */ } }
        return res;
    };

    // ───── AI:程式先讀(外框已做過 parseCommands),剩下的請模型回封閉動作(只給欄位概要) ─────
    M._edAskSheet = async function (req, ed, fmt) {
        req = req || {}; const A = this._edAi(), C = FaEditSheet, spec = C.validate(req.spec).spec, text = String(req.text || '').trim(), notes = [], edits = [], status = typeof req.onStatus === 'function' ? req.onStatus : () => {}; let say = '';
        const sel = req.selection || (req.env && req.env.selection) || null;
        if (!text) return { say, edits, notes };
        if (this._edIsOffline() && this._edOfflineDocs) return this._edOfflineDocs('sheet', req, status);   // 離線：整套 harness（不讓離線小模型自己寫 JSON）
        if (!A.have()) return { say: T('這句話程式沒有讀懂,而且目前沒有可用的 AI;可以直接在表格上改,或說程式讀得懂的句子:「把 B 欄由大到小排序」「刪掉空白列」「B2 改成 99」「在最後加一欄「總價」」。', 'I could not read that and no AI is available; edit the grid directly or use a plain command.'), edits, notes };
        status(T('想一想怎麼改…', 'Working out the changes…'));
        const Pm = C.editPrompt(spec, text, sel, { budget: this._edIsOffline() ? 3500 : 9000 });
        try {
            const rep = await A.chat(Pm.system, Pm.user, { maxTokens: this._edIsOffline() ? 1800 : 3500, timeoutMs: 150000 }), pr = C.parseEditsReply(rep);
            if (pr.ok) { pr.edits.forEach((e) => edits.push(e)); if (pr.say) say = pr.say; if (pr.dropped) notes.push(T('有 ' + pr.dropped + ' 個動作不在可做的清單裡,已略過', pr.dropped + ' actions were not allowed and were skipped')); }
            else say = T('AI 的回覆我讀不懂(要是 JSON 動作)。換個說法再試一次。', 'I could not read the AI\'s answer (it has to be JSON actions). Say it differently.');
        } catch (e) { say = T('AI 這次沒有回應(', 'The AI did not answer (') + String((e && e.message) || e).slice(0, 80) + ')。'; }
        return { say, edits, notes };
    };

    M._registerEditSheetCommands = function () {
        const hint = '[起手式｜一句話描述]', mk = (kind) => async (argsText, run0) => (run0 || this)._edCommand(kind, argsText, run0);
        this.register_slash_command('/edit-csv', hint, 'CSV 編輯器(沒動到的檔案一個位元組都不會變,分隔符號、換行、引號、BOM 保留):單擊選格、雙擊改;用說的:「把 qty 由大到小排序」「刪掉空白列」「B2 改成 99」「在最後加一欄「總價」」「刪掉 name 是 banana 的列」;可復原、匯出、開啟本機檔案。', mk('edit-csv'));
        this.register_slash_command('/edit-xlsx', hint, '試算表編輯器(xlsx):多工作表、公式會算(SUM AVERAGE IF VLOOKUP…)、公式與算好的值都保留;其餘同 /edit-csv。/edit-xlsx budget 從收支表(有公式)開始。', mk('edit-xlsx'));
        this.register_slash_command('/edit-sheet', hint, '試算表編輯器:/edit-xlsx 的別名。', mk('edit-xlsx'));
    };
    { const prev = M._registerEditCommands; M._registerEditCommands = function () { if (prev) prev.call(this); this._registerEditSheetCommands(); }; }
    M._registerEditSheetTools = function (registerOptional) {
        const parse = async (self, raw) => { let a = {}; try { a = await self.repairJsonPayload(String(raw || '{}')); } catch (_) { /* */ } return a || {}; };
        const open = (kind, label) => registerOptional(kind === 'edit-xlsx' ? 'edit_xlsx_open' : 'edit_csv_open',
            '在對話裡放一個「' + label + '」' + (kind === 'edit-xlsx' ? '（適用：Excel、試算表、財務報表、帳務明細、績效統計、數據表格）' : '（適用：CSV、名單、通訊錄、清單、逗號分隔資料）') + ':使用者用說的改(排序、刪空白列、加欄加列、取代、條件式刪列),或直接在表格上改;可復原、匯出、開啟本機檔案。參數:starter、csv(開起來時的 CSV 文字)、title、request、file_id(使用者附的 csv／xlsx)。',
            async function (rawArgs) {
                const a = await parse(this, rawArgs);
                try {
                    if (a.file_id) { const rec = await this.fileCache.get(String(a.file_id)); if (!rec || !rec.blob) return JSON.stringify({ ok: false, error: 'no such file: ' + a.file_id }); return JSON.stringify(await this._edOpenSheetFile(rec.filename || 'table.csv', await rec.blob.arrayBuffer(), { request: a.request })); }
                    let spec = a.spec; if (!spec && a.csv) { spec = FaEditSheet.parseCsv(String(a.csv), a.title ? String(a.title).slice(0, 80) : undefined); delete spec.src; delete spec.sig; if (kind === 'edit-xlsx') spec.format = 'xlsx'; }
                    return JSON.stringify(await this._edOpen(kind, { starter: a.starter, request: a.request, spec, id: a.id }));
                } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); }
            },
            { type: 'object', properties: { starter: { type: 'string', description: '起手式' }, csv: { type: 'string', description: '開起來時的 CSV 文字' }, title: { type: 'string', description: '檔名' }, request: { type: 'string', description: '一句話要怎麼改' }, file_id: { type: 'string', description: '使用者附的 csv／xlsx 檔' }, id: { type: 'string', description: '接著原來的專案編輯' } } });
        open('edit-csv', 'CSV 編輯器'); open('edit-xlsx', '試算表編輯器');
    };
    { const prevTools = M._registerEditTools; M._registerEditTools = function (ro) { if (prevTools) prevTools.call(this, ro); this._registerEditSheetTools(ro); }; }
})();
