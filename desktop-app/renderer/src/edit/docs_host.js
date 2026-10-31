/* /edit-markdown（/edit-md）、/edit-text（/edit-txt）、/edit-file 的主機轉接層(接在 edit_host.js 後面,同一個 FaEditHost)。設計見 DESIGN.edit-docs.md。
 * 文件是區塊的清單,AI 只能用封閉動作改(FaEditText.AI_OPS);程式讀得懂的白話(parseCommands)由外框先處理,剩下的才交給 AI。
 * 遠端:登記就帶 remote 宣告(sync:'edits'),所以「AI 在」下拉、by 標籤、一致性檢查都自動涵蓋。 */
(function () {
    'use strict';
    const H = FaEditHost, T = H.T, M = H.methods;
    const TEXTY = /\.(md|markdown|mdown|txt|text|log|ini|conf|cfg|properties|env|rst|org|tex|srt|vtt|diff|patch)$/i, MD_EXT = /\.(md|markdown|mdown)$/i;
    const decodeText = (buf) => { const u = new Uint8Array(buf); try { return new TextDecoder('utf-8', { fatal: true }).decode(u); } catch (_) { try { return new TextDecoder('big5').decode(u); } catch (__) { return new TextDecoder('utf-8').decode(u); } } };

    function coreFor(fmt) {
        const C = FaEditText;
        return {
            validate: (s) => C.validate(s),
            listStarters: () => (fmt === 'txt' ? [{ id: 'blank', label: T('空白文字', 'Blank text'), desc: T('一行空白,從零開始。', 'One empty line.') }] : C.listStarters()),
            starter: (id) => { if (fmt === 'txt') { const sp = C.parse('', 'txt'); sp.title = T('未命名文字', 'Untitled text'); return C.validate(sp).spec; } return C.starter(String(id || 'blank')); },
        };
    }
    const KIND = (fmt) => {
        const txt = fmt === 'txt', core = coreFor(fmt);
        return {
            fence: txt ? 'fa-edit-text' : 'fa-edit-markdown', icon: txt ? '📄' : '📝', cmd: txt ? '/edit-text' : '/edit-markdown', prefix: txt ? 'tx' : 'md', label: () => (txt ? T('純文字編輯器', 'Plain text editor') : T('Markdown 編輯器', 'Markdown editor')), core: () => core,
            ui: () => ({ mount: (o) => FaEditTextUI.mount(o) }),
            lead: txt ? '📄 純文字編輯器:每一行是一個區塊,沒動到的行原封不動(換行、空白、結尾換行都保留)。直接改,或用說的:換字、加一行、刪一行、移動、整理全文。每一步都能復原。'
                : '📝 Markdown 編輯器:文件分成區塊(標題、段落、清單、表格、程式碼…),沒動到的區塊原封不動、不會重新排版。單擊選取、雙擊就地改;也可以用說的:「把第 2 段改成…」「在最後加一段…」「把這段整理成清單」「寫一個安裝章節」。AI 的每一步都是封閉動作,可以復原。',
            polishSystem: 'You tidy a prompt that rebuilds a document. Keep every fact (the structure, headings, wording of the user\'s instructions); make it one clear, reusable prompt. Answer with the prompt only.',
            remote: { sync: 'edits', methods: { ask: { doc: true }, polish: {} } },
            ask: function (req, ed) { return this._edAskText(req, ed, fmt); },
        };
    };
    H.register('edit-markdown', KIND('md'));
    H.register('edit-text', KIND('txt'));

    // ───── AI:程式先讀(外框的 parseCommands 已經做過),剩下的請模型回封閉動作;貼的圖用視覺模型轉錄成文字區塊 ─────
    M._edAskText = async function (req, ed, fmt) {
        req = req || {}; const A = this._edAi(), C = FaEditText, spec = C.validate(req.spec).spec, text = String(req.text || '').trim(), notes = [], edits = [], status = typeof req.onStatus === 'function' ? req.onStatus : () => {}; let say = '';
        const sel = req.selection || (req.env && req.env.selection) || null, imgs = (req.images || []).slice(0, 3);
        for (let i = 0; i < imgs.length; i++) {
            const im = imgs[i]; status(T('讀圖片裡的文字…', 'Reading the text in the picture…'));
            try {
                const out = String(await A.vision(im.dataUrl, T('把這張圖裡的文字照原本的結構轉錄出來(標題、清單、表格請用 Markdown),只輸出轉錄的內容,看不到文字就回答「無」。', 'Transcribe the text in this picture with its structure (Markdown for headings, lists and tables). Output only the transcription; answer "none" if there is no text.'))).trim();
                if (!out || /^(無|none|沒有)$/i.test(out)) { notes.push(T('「' + (im.name || '圖片') + '」裡沒有讀到文字', 'No text found in "' + (im.name || 'picture') + '"')); continue; }
                const sub = C.parse(out, fmt === 'txt' ? 'txt' : 'md');
                sub.objects.forEach((b) => { const blk = Object.assign({}, b); delete blk.id; delete blk.name; edits.push({ op: 'add_block', after: 'end', block: blk }); });
                say = say || T('把圖裡的文字轉成文件區塊加在最後了。', 'Added the text from the picture at the end.');
            } catch (e) { notes.push(T('讀圖失敗:', 'Could not read the picture: ') + String((e && e.message) || e).slice(0, 80)); }
        }
        if (edits.length && !text) return { say, edits, notes };
        if (!text) return { say, edits, notes };
        if (!A.have()) return { say: T('這句話程式沒有讀懂,而且目前沒有可用的 AI;可以雙擊區塊直接改,或說程式讀得懂的句子:「把第 2 段改成…」「在最後加一段:…」「把「舊」全部換成「新」」「刪掉第 3 段」。', 'The program did not understand this and there is no AI; double-click a block to edit it, or use a sentence like "replace X with Y".'), edits, notes };
        status(T('想一想怎麼改…', 'Working out the changes…'));
        const offline = this._edIsOffline(), Pm = C.editPrompt(C.applyEdits(spec, edits, {}).spec, text, sel, { budget: offline ? 3500 : 9000 });
        try {
            const rep = await A.chat(Pm.system, Pm.user, { maxTokens: offline ? 1800 : 3500, timeoutMs: 150000 }), pr = C.parseEditsReply(rep);
            if (pr.ok) { pr.edits.forEach((e) => edits.push(e)); if (pr.say) say = say ? say + ';' + pr.say : pr.say; if (pr.dropped) notes.push(T('有 ' + pr.dropped + ' 個動作不在可做的清單裡,已略過', pr.dropped + ' actions were not allowed and were skipped')); }
            else if (!edits.length) say = T('AI 的回覆我讀不懂(要是 JSON 動作)。換個說法再試一次。', 'I could not read the AI\'s answer (it has to be JSON actions). Say it differently.');
        } catch (e) { if (!edits.length) say = T('AI 這次沒有回應(', 'The AI did not answer (') + String((e && e.message) || e).slice(0, 80) + ')。'; }
        return { say, edits, notes };
    };

    // ───── 開檔:/edit-file 依副檔名分派;其他格式(csv／xlsx／docx)還沒做的明講 ─────
    M._edOpenTextFile = async function (name, buf, extra) {
        const text = decodeText(buf), fmt = MD_EXT.test(name) ? 'md' : 'txt', kind = fmt === 'md' ? 'edit-markdown' : 'edit-text', spec = FaEditText.parse(text, fmt); spec.title = String(name).replace(/\.[^.]+$/, '').slice(0, 80) || spec.title || T('未命名文件', 'Untitled');
        return this._edOpen(kind, Object.assign({ spec, origin: { file: { name: String(name), size: buf.byteLength || 0 } } }, extra || {}));
    };
    M._editFileSlash = async function (argsText, run) {
        const r = run || this, raw = String(argsText || ''), atts = FaRecipe.parseAttachments(raw), nameArg = raw.replace(/\[附件：[^\]]*\]/g, '').trim().replace(/^["「]|["」]$/g, '');
        r.messages.push({ role: 'user', content: '/edit-file' + (nameArg ? ' ' + nameArg : '') + (atts.length ? '　📎 ' + atts.map((a) => a.filename).join('、') : '') });
        const say = (t) => { r._pushAssistantMessage(t, null); try { r._persistChatHistory(); r._renderMessageHistory(); } catch (_) { /* */ } };
        let targets = atts.map((a) => ({ id: a.id, name: a.filename })), all = []; try { all = (await this.fileCache.getAll()).filter((x) => x && x.filename); } catch (_) { /* */ }
        all.sort((a, b) => (b.createdAt || b.lastAccessedAt || 0) - (a.createdAt || a.lastAccessedAt || 0));
        if (!targets.length && nameArg) { const low = nameArg.toLowerCase(), hit = all.filter((x) => x.id === low || String(x.filename).toLowerCase() === low), part = hit.length ? hit : all.filter((x) => String(x.filename).toLowerCase().includes(low)); targets = part.slice(0, 3).map((x) => ({ id: x.id, name: x.filename })); if (!targets.length) { say(T('找不到檔案「' + nameArg + '」。先附上檔案(📎、拖進來、貼上)再下 /edit-file,或用 /edit-markdown、/edit-text 開空白的。', 'No such file: ' + nameArg)); return; } }
        if (!targets.length) { const x = all.find((y) => TEXTY.test(y.filename)); if (x) targets = [{ id: x.id, name: x.filename }]; }
        if (!targets.length) { say(T('用法:/edit-file [檔名]　先附上檔案再下 /edit-file。目前可以編輯:Markdown(.md)與純文字(.txt、.log、.ini…);csv、xlsx、docx 還在做。', 'Usage: /edit-file [name] — Markdown and plain text for now; csv, xlsx, docx are coming.')); return; }
        for (const tg of targets.slice(0, 3)) {
            if (!TEXTY.test(tg.name)) { say(T('「' + tg.name + '」這種格式的編輯器還沒做(目前:.md 與純文字)。用 /view 可以先看 csv／xlsx。', '"' + tg.name + '": no editor for this format yet.')); continue; }
            try { const rec = await this.fileCache.get(tg.id); if (!rec || !rec.blob) { say(T('讀不到「' + tg.name + '」', 'Could not read ' + tg.name)); continue; } if (rec.blob.size > 4000000) { say(T('「' + tg.name + '」超過 4 MB,太大了。', tg.name + ' is over 4 MB.')); continue; } const res = await this._edOpenTextFile(tg.name, await rec.blob.arrayBuffer()); if (res && res.ok === false) say('⚠️ ' + (res.error || T('開不起來', 'could not open it'))); }
            catch (e) { say('⚠️ ' + T('開不起來:', 'Could not open it: ') + String((e && e.message) || e)); }
        }
    };

    // ───── 斜線指令與工具 ─────
    M._registerEditDocsCommands = function () {
        const hint = '[起手式｜一句話描述]';
        const mdDesc = 'Markdown 編輯器(區塊式,沒動到的區塊原封不動):單擊選取、雙擊就地改;用說的:「把第 2 段改成…」「在最後加一段:…」「把最後一個改成編號清單」「把「舊」全部換成「新」」「寫一個安裝章節」。物件欄是文件的章節樹;可復原、整理成 prompt、匯出 .md／HTML、開啟本機檔案。/edit-markdown readme 從起手式開始。';
        const txtDesc = '純文字編輯器(一行一個區塊,換行、空白、結尾換行都保留):換字、加一行、刪一行、移動、整理全文;可復原、匯出 .txt、開啟本機檔案。';
        const mk = (kind) => async (argsText, run0) => (run0 || this)._edCommand(kind, argsText, run0);
        this.register_slash_command('/edit-markdown', hint, mdDesc, mk('edit-markdown'));
        this.register_slash_command('/edit-md', hint, 'Markdown 編輯器:/edit-markdown 的別名。', mk('edit-markdown'));
        this.register_slash_command('/edit-text', '[一句話描述]', txtDesc, mk('edit-text'));
        this.register_slash_command('/edit-txt', '[一句話描述]', '純文字編輯器:/edit-text 的別名。', mk('edit-text'));
        this.register_slash_command('/edit-file', '[檔名]', '依副檔名開編輯器:.md 開 Markdown 編輯器,.txt／.log／.ini… 開純文字編輯器(csv、xlsx、docx 還在做)。先附上檔案(📎、拖進來、貼上)再下 /edit-file,或 /edit-file 檔名;不帶參數開最近上傳的文字檔。', (argsText, run0) => (run0 || this)._editFileSlash(argsText, run0));
    };
    const prevRegister = M._registerEditCommands; M._registerEditCommands = function () { if (prevRegister) prevRegister.call(this); this._registerEditDocsCommands(); };
    M._registerEditDocsTools = function (registerOptional) {
        const parse = async (self, raw) => { let a = {}; try { a = await self.repairJsonPayload(String(raw || '{}')); } catch (_) { /* */ } return a || {}; };
        const open = (kind, label) => registerOptional(kind === 'edit-markdown' ? 'edit_markdown_open' : 'edit_text_open',
            '在對話裡放一個「' + label + '」(區塊式文件編輯器,沒動到的區塊原封不動):使用者用說的改(把第 2 段改成…、在最後加一段、把這段整理成清單、全部取代),或雙擊區塊直接改;可復原、匯出、開啟本機檔案。參數:starter(' + (kind === 'edit-markdown' ? 'blank、notes、readme' : 'blank') + ')、text(開起來時的初始內容)、title、request(一句話:開起來後編輯器自己的 AI 去做)、file_id(使用者附的文字檔)、id(接著原本的專案)。做完編輯器就在對話裡,不要把整份文件貼到對話。參數: {"starter":"blank","text":"(選填)","request":"(選填)","file_id":"(選填)","id":"(選填)"}',
            async function (rawArgs) {
                const a = await parse(this, rawArgs);
                try {
                    if (a.file_id) { const rec = await this.fileCache.get(String(a.file_id)); if (!rec || !rec.blob) return JSON.stringify({ ok: false, error: 'no such file: ' + a.file_id }); return JSON.stringify(await this._edOpenTextFile(rec.filename || 'document.txt', await rec.blob.arrayBuffer(), { request: a.request })); }
                    let spec = a.spec; if (!spec && a.text) { spec = FaEditText.parse(String(a.text), kind === 'edit-text' ? 'txt' : 'md'); if (a.title) spec.title = String(a.title).slice(0, 80); }
                    return JSON.stringify(await this._edOpen(kind, { starter: a.starter, request: a.request, spec, id: a.id }));
                } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); }
            },
            { type: 'object', properties: { starter: { type: 'string', description: '起手式' }, text: { type: 'string', description: '開起來時的初始內容' }, title: { type: 'string', description: '文件名稱' }, request: { type: 'string', description: '一句話要怎麼改或寫什麼' }, file_id: { type: 'string', description: '使用者附的文字檔' }, id: { type: 'string', description: '接著原本的專案' } }, additionalProperties: false });
        open('edit-markdown', 'Markdown 編輯器'); open('edit-text', '純文字編輯器');
    };
    { const prevTools = M._registerEditTools; M._registerEditTools = function (ro) { if (prevTools) prevTools.call(this, ro); this._registerEditDocsTools(ro); }; }
})();
