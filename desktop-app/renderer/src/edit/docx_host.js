/* /edit-docx(/edit-word) 的主機轉接層(接在 sheet_host.js 後面,同一個 FaEditHost)。設計見 DESIGN.edit-docs.md §4(package patching)。
 * 文件是區塊的清單(FaEditDocx);AI 只能用封閉動作改(FaEditDocx.AI_OPS);程式讀得懂的白話(parseCommands)由外框先處理。
 * 原檔存在 fileCache:沒改過匯出原檔;改過只重寫 word/document.xml 的 body(頁首頁尾、樣式、圖片、關聯等其他 part 原封不動)。
 * 遠端:登記就帶 remote 宣告(sync:'edits'),所以「AI 在」下拉、by 標籤、一致性檢查、多人同編都自動涵蓋(多人時原檔只在開檔那台,別台匯出會重新產生)。 */
(function () {
    'use strict';
    const H = FaEditHost, T = H.T, M = H.methods;
    H.register('edit-docx', {
        fence: 'fa-edit-docx', icon: '📄', cmd: '/edit-docx', prefix: 'dx', label: () => T('Word 文件編輯器', 'Word document editor'),
        core: () => FaEditDocx,
        ui: () => ({ mount: (o) => FaEditDocxUI.mount(Object.assign({}, o, { host: Object.assign(o.host || {}, o._docxHostExt || {}) })) }),
        mountOpts: function (id) { return { _docxHostExt: this._docxHostExt(id) }; },
        lead: '📄 Word 文件編輯器:文件分成區塊(標題、段落、清單、表格、分頁…),沒動到的區塊、圖片、頁首頁尾、樣式都原封不動地留在原檔裡,只重寫改過的部分。單擊選取、雙擊就地改字;選一段字再按 B／I／U／顏色只改那段字;也可以用說的:「把第 2 段改成…」「把第 3 段改成粗體」「在最後加一段…」。每一步都能復原。',
        polishSystem: 'You tidy a prompt that rebuilds a Word document. Keep every fact (the structure, headings, wording of the user\'s instructions); make it one clear, reusable prompt. Answer with the prompt only.',
        remote: { sync: 'edits', methods: { ask: { doc: true }, polish: {} } },
        ask: function (req, ed) { return this._edAskDocx(req, ed); },
        help: () => '**' + T('Word 文件編輯器', 'Word document editor') + '**\n\n`/edit-docx`' + T(':開一個空白文件,或 `/edit-file 檔名.docx` 開附上的檔案。', ': open an empty document, or `/edit-file name.docx` for an attached file.'),
    });
    M._docxHostExt = function (id) {
        const self = this, kind = 'edit-docx';
        return {
            jszip: async () => { await self._ensureJSZipLoaded(); return window.JSZip; },
            origDocx: async () => { const o = await self._edOriginGet(kind, id), fid = o && o.origFile; if (!fid) return null; const rec = await self.fileCache.get(fid); return rec && rec.blob ? new Uint8Array(await rec.blob.arrayBuffer()) : null; },
            keepOrig: async (bytes) => { const rec = await self.fileCache.put('origin-' + id + '.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Blob([bytes]), 'uploaded'); const fid = rec && rec.id ? rec.id : rec; if (fid) await self._edPatchOrigin(kind, id, (o) => { o.origFile = fid; }); },
        };
    };
    M._edOpenDocxFile = async function (name, buf, extra) {
        await this._ensureJSZipLoaded(); const spec = await FaEditDocx.read(new Uint8Array(buf), window.JSZip, String(name).replace(/\.[^.]+$/, '').slice(0, 80));
        const res = await this._edOpen('edit-docx', Object.assign({ spec, origin: { file: { name: String(name), size: buf.byteLength || 0 } } }, extra || {}));
        if (res && res.ok) { try { await this._docxHostExt(res.id).keepOrig(new Uint8Array(buf)); } catch (_) { /* 原檔沒存到:匯出時重新產生 */ } }
        return res;
    };
    M._edAskDocx = async function (req) {
        req = req || {}; const A = this._edAi(), C = FaEditDocx, spec = C.validate(req.spec).spec, text = String(req.text || '').trim(), notes = [], edits = [], status = typeof req.onStatus === 'function' ? req.onStatus : () => {}; let say = '';
        const sel = req.selection || (req.env && req.env.selection) || null;
        if (!text) return { say, edits, notes };
        if (!A.have()) return { say: T('這句話程式沒有讀懂,而且目前沒有可用的 AI;可以雙擊區塊直接改,或說程式讀得懂的句子:「把第 2 段改成…」「把第 3 段改成粗體」「在最後加一段:…」「把「舊」全部換成「新」」。', 'I could not read that and no AI is available; edit a block directly or use a plain command.'), edits, notes };
        status(T('想一想怎麼改…', 'Working out the changes…'));
        const offline = this._edIsOffline(), Pm = C.editPrompt(spec, text, sel, { budget: offline ? 3500 : 9000 });
        try {
            const rep = await A.chat(Pm.system, Pm.user, { maxTokens: offline ? 1800 : 3500, timeoutMs: 150000 }), pr = C.parseEditsReply(rep);
            if (pr.ok) { pr.edits.forEach((e) => edits.push(e)); if (pr.say) say = pr.say; if (pr.dropped) notes.push(T('有 ' + pr.dropped + ' 個動作不在可做的清單裡,已略過', pr.dropped + ' actions were not allowed and were skipped')); }
            else say = T('AI 的回覆我讀不懂(要是 JSON 動作)。換個說法再試一次。', 'I could not read the AI\'s answer (it has to be JSON actions). Say it differently.');
        } catch (e) { say = T('AI 這次沒有回應(', 'The AI did not answer (') + String((e && e.message) || e).slice(0, 80) + ')。'; }
        return { say, edits, notes };
    };
    M._registerEditDocxCommands = function () {
        const hint = '[起手式｜一句話描述]', mk = (kind) => async (argsText, run0) => (run0 || this)._edCommand(kind, argsText, run0);
        this.register_slash_command('/edit-docx', hint, 'Word 文件編輯器(.docx):沒動到的區塊、圖片、頁首頁尾、樣式原封不動;單擊選取、雙擊改字、選一段字按 B／I／U／顏色;用說的:「把第 2 段改成…」「把第 3 段改成粗體」「把「重點」變成紅色」「在最後加一段:…」「把最後一個改成編號清單」。/edit-docx report 從報告範本開始;/edit-file 檔名.docx 開附上的檔案。', mk('edit-docx'));
        this.register_slash_command('/edit-word', hint, 'Word 文件編輯器:/edit-docx 的別名。', mk('edit-docx'));
    };
    { const prev = M._registerEditCommands; M._registerEditCommands = function () { if (prev) prev.call(this); this._registerEditDocxCommands(); }; }
    M._registerEditDocxTools = function (registerOptional) {
        const parse = async (self, raw) => { let a = {}; try { a = await self.repairJsonPayload(String(raw || '{}')); } catch (_) { /* */ } return a || {}; };
        registerOptional('edit_docx_open', '在對話裡放一個「Word 文件編輯器」(區塊式,沒動到的區塊、圖片、頁首頁尾、樣式原封不動):使用者用說的改(把第 2 段改成…、改成粗體、在最後加一段、把這段整理成清單、全部取代),或雙擊區塊直接改;可復原、匯出 .docx。參數:starter(blank、letter、report)、text(開起來時的純文字,空行分段)、title、request、file_id(使用者附的 .docx)、id(接著原來的專案編輯)。',
            async function (rawArgs) {
                const a = await parse(this, rawArgs);
                try {
                    if (a.file_id) { const rec = await this.fileCache.get(String(a.file_id)); if (!rec || !rec.blob) return JSON.stringify({ ok: false, error: 'no such file: ' + a.file_id }); return JSON.stringify(await this._edOpenDocxFile(rec.filename || 'document.docx', await rec.blob.arrayBuffer(), { request: a.request })); }
                    let spec = a.spec; if (!spec && a.text) { const paras = String(a.text).split(/\n{2,}|\r\n(?:\r\n)+/).map((x) => x.trim()).filter(Boolean); spec = { v: 1, title: a.title ? String(a.title).slice(0, 80) : '未命名文件', objects: paras.map((t) => ({ type: 'para', runs: [{ t }] })) }; }
                    return JSON.stringify(await this._edOpen('edit-docx', { starter: a.starter, request: a.request, spec, id: a.id }));
                } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); }
            },
            { type: 'object', properties: { starter: { type: 'string', description: '起手式 blank／letter／report' }, text: { type: 'string', description: '開起來時的純文字(空行分段)' }, title: { type: 'string', description: '文件名稱' }, request: { type: 'string', description: '一句話要怎麼改或寫什麼' }, file_id: { type: 'string', description: '使用者附的 .docx' }, id: { type: 'string', description: '接著原來的專案編輯' } } });
    };
    { const prevTools = M._registerEditTools; M._registerEditTools = function (ro) { if (prevTools) prevTools.call(this, ro); this._registerEditDocxTools(ro); }; }
})();
