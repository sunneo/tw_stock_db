/* /edit-media-presentation 的主機轉接層(接在 deck_host.js、deck_tools.js 與 edit_host.js 之後):簡報編輯器 = 原本的簡報播放器 + 章／頁大綱 + AI 對話框。
 * AI 對話框有兩條路,都用 /media-presentation 原本的零件:
 *   快路(一次模型呼叫):改字、改旁白、加頁、換順序;要放真實照片時用 find_picture(Wikimedia／Openverse,跟簡報的 find_photo 同一個函式)、要畫的圖用 generate_image;
 *   代理人(委派給內建技能「media-presentation」,跟 /media-presentation 同一組工具:上網找圖與資料、匯入圖片網址、讀檔案與資料夾、畫圖表、get／render_presentation):
 *     要上網查、讀網頁或檔案、畫圖表、整章重做的時候走這一條;結果是一份新的簡報 → 以 replace_deck 放進外框,先預覽(播放器裡看改過的版本)再套用。
 * 簡報檔都存在檔案快取(.deck.yaml);編輯器的每一步是一個版本(復原重做＝換播放器看哪一份)。播放器上多一顆「✏️ 編輯」(deck_player.js 的 AiChatDeckEditHook)。 */
(function () {
    'use strict';
    const H = FaEditHost, T = H.T, M = H.methods;
    const AGENT_RE = /(上網|網路上|網頁|網站|搜尋資料|查(?:一下|資料|詢|找)|研究|蒐集|收集|讀(?:一下)?.{0,8}(?:檔|文件|資料夾|網址|連結)|https?:\/\/|圖表|統計|新聞|最新的?(?:消息|資料|規格|版本)|整章|一整章|整份重|全部重做|重新做一份|根據.{0,10}(?:文件|檔案|資料夾|網站))/;
    const PIC_RE = /(找|搜尋|搜|插入|放|加|換|配|貼|補|來)[^。\n]{0,14}(圖片|照片|相片|圖|畫面|photo|picture|image)/i;
    const PIC_NOT = /(圖表|流程圖|示意圖|架構圖|甘特圖|長條圖|圓餅圖|折線圖)/;
    const NEWPAGE_RE = /(新增|插入|加|多加|做)\s*(一|1)?\s*(頁|張\s*(投影片|簡報|頁))/;
    const EVERY_RE = /(每一頁|每頁|所有頁|每一張|全部的頁|每個章節|每章)/;
    const CJK = /[㐀-䶿一-鿿]/;
    const D = () => FaDeckEdit;

    H.register('edit-media-presentation', {
        fence: 'fa-edit-media-presentation', icon: '📽', cmd: '/edit-media-presentation', prefix: 'dk', label: () => T('簡報編輯器', 'Presentation editor'), core: () => FaDeckEdit, ui: () => FaDeckEditUI,
        lead: '📽 簡報編輯器:中間是原本的簡報播放器(播放、匯出 MP4／PPTX／封包都在上面),左邊是章與頁的大綱,右邊是 AI 對話框——你現在看的那一頁就是「這頁」:「這頁加一張飛機的照片」「在這頁後面插入一頁講風險」「每一頁都配一張照片」「上網查最新規格再加一章」。要上網、讀檔、畫圖表的工作會請簡報的代理人去做(跟 /media-presentation 一樣的工具)。AI 改的會先放進播放器預覽,你按「接受」才算;每一步都能復原。',
        polishSystem: 'You tidy a prompt that rebuilds a narrated slide deck. Keep every fact (the topic, chapters, slide titles, bullets, narration, pictures and where they go); make it one clear, reusable prompt. Answer with the prompt only.',
        prepare: async function () { await this._ensureJsYamlLoaded(); await this._deckEnsureRuntime(); },
        collectRefs: () => [],
        mountOpts: function (id) { return this._deckEditMountOpts(id); },
        ask: function (req, ed) { return this._edAskDeck(req, ed); },
        help: () => '**' + T('簡報編輯器', 'Presentation editor') + '**\n\n' + T('`/edit-media-presentation`:編輯這個對話裡最近做的簡報(播放器上的「✏️ 編輯」鈕也一樣)。在播放器旁邊用說的改:「這頁加一張飛機的照片」「在這頁後面插入一頁講風險」「旁白講短一點」「把第 3 頁移到最後」「每一頁都配一張照片」「上網查最新規格再加一章」。你現在看的那一頁就是「這頁」。要上網找資料或圖、讀檔、畫圖表,AI 會請簡報代理人(跟 /media-presentation 一樣的工具)去做;改的先預覽、按「接受」才算,每一步都能復原。\n\n用法:`/edit-media-presentation`(最近的簡報)、`/edit-media-presentation 在第 2 頁後面加一頁講風險`(開起來就做)、`/edit-media-presentation <簡報檔案 id 或 client-file/…deck.yaml>`。', 'Edit the latest deck of this chat next to its player; say "add a photo of an airplane to this slide".'),
    });

    // 對話裡最近的簡報網址(這次執行做的,或對話記錄裡找得到的)
    M._deckEditLatestUrl = function () {
        if (this._latestDeckUrl && /^client-file\/[\w-]+\.deck\.yaml/.test(this._latestDeckUrl)) return this._latestDeckUrl;
        const re = /client-file\/[\w-]+\.deck\.yaml/g; const msgs = this.messages || [];
        for (let i = msgs.length - 1; i >= 0; i--) { const c = typeof msgs[i].content === 'string' ? msgs[i].content : JSON.stringify(msgs[i].content || ''); const all = c.match(re); if (all && all.length) return all[all.length - 1]; }
        return null;
    };
    // 開編輯器:url＝簡報網址(或檔案 id);request＝開起來就交給 AI 的一句話
    M._deckEditOpen = async function (urlOrId, request) {
        await this._ensureJsYamlLoaded(); const key = String(urlOrId || '').trim(); let text; try { text = await this._deckReadYaml(key); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
        const r = FaDeckEdit.fromYaml(text); if (!r.ok) return { ok: false, error: r.error };
        const res = await this._edOpen('edit-media-presentation', { spec: r.spec, request: request || '' }); if (res && res.ok) res.title = r.spec.deck.title; return res;
    };
    M._deckEditMountOpts = function (id) {
        const self = this;
        return { mountPlayer: (container, url) => self._deckMount(container, url), saveDeck: (doc) => self._deckSaveDoc(doc) };
    };
    // 把編輯器的文件存成一份新的 .deck.yaml:同一套檢查(格式、圖片、內嵌場景、總長度)過了才存;-> { url, file_id } 或 { error }
    M._deckSaveDoc = async function (doc) {
        await this._ensureJsYamlLoaded(); const data = JSON.parse(JSON.stringify(doc)); if (!this._deckRunState) this._deckBeginRun('');
        const checked = await this._deckCheck(data, 'the editor'); if (checked.error) return { error: String(checked.error).replace(/^the deck has /, '簡報有 ').slice(0, 900) };
        const saved = await this._deckSaveChecked(data, (data.deck && data.deck.title) || 'presentation', checked); return { url: saved.url, file_id: saved.file_id, warnings: checked.warnings };
    };

    // ───── 代理人:跟 /media-presentation 同一組工具(上網找圖與資料、匯入圖片、讀檔、畫圖表) ─────
    M._deckEditAgent = async function (spec, text, env, status) {
        const domainKey = this._deckDomainKey(); if (!domainKey) return { error: T('找不到內建技能「media-presentation」(可能被停用或刪除)。到 Advance Settings 的技能分頁重新啟用它。', 'The built-in skill "media-presentation" is not available.') };
        const D0 = FaDeckEdit, cur = await this._deckSaveDoc(D0.toDoc(spec)); if (cur.error) return { error: T('目前的簡報沒通過檢查,先修好再請代理人:', 'The deck does not pass the checks: ') + cur.error.slice(0, 200) };
        const before = cur.url; this._latestDeckUrl = before; const vis = D0.slides(spec), at = env && env.slide ? vis.findIndex((o) => o.id === env.slide) : -1, o = at >= 0 ? vis[at] : null, locked = D0.slides(spec).filter((x) => x.locked).map((x) => '「' + x.name + '」');
        const task = '【修改一份已經做好的簡報(不是做新的)】\n簡報:' + before + '(標題「' + spec.deck.title + '」,共 ' + vis.length + ' 頁,語言 ' + (spec.deck.lang || 'zh-TW') + ')。使用者正在簡報編輯器裡,左邊是這份簡報的大綱:\n' + D0.outline(spec, { focus: o && o.id }) + '\n'
            + (o ? '使用者現在看的是第 ' + (at + 1) + ' 頁「' + o.name + '」——要求裡的「這頁／這張／這裡」就是它。\n' : '')
            + '\n使用者的要求:' + text + '\n\n做法:先用 get_presentation_yaml 取得上面這份簡報的 YAML,只改要求的地方(其他的頁一個字都不要動),需要的圖用 find_photo／import_image_url／cute_picture／svg_picture 等工具取得真實的檔案(不要編網址),需要的資料用你的搜尋與讀取工具查證,再用 render_presentation 存成新的一份(標題維持原樣)。要在某頁「後面」插入就插在那頁的後面。'
            + (locked.length ? '這幾頁被使用者鎖住,不可以改:' + locked.join('、') + '。' : '') + '最後用一兩句話說你改了什麼(哪幾頁)。';
        status(T('請簡報代理人去做(上網找資料與圖需要一點時間)…', 'Asking the presentation agent (web lookups take a while)…'));
        let res; try { res = await this._delegateToSubagentDomain(domainKey, task); } catch (e) { return { error: String((e && e.message) || e) }; }
        const after = this._latestDeckUrl; const said = String((res && (res.result || res.note)) || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        if (!res || res.ok === false) return { error: T('代理人沒有做完:', 'The agent did not finish: ') + String((res && res.error) || '').slice(0, 200) };
        if (!after || after === before) return { say: said || T('代理人沒有改簡報(可能只是回答了問題)。', 'The agent did not change the deck.'), edits: [], notes: [] };
        let yamlText; try { yamlText = await this._deckReadYaml(after); } catch (e) { return { error: T('讀不到代理人存的簡報:', 'Cannot read what the agent saved: ') + String((e && e.message) || e) }; }
        const fy = FaDeckEdit.fromYaml(yamlText); if (!fy.ok) return { error: T('代理人存的簡報讀不懂:', 'The agent\'s deck is not readable: ') + fy.error };
        const notes = []; const newDoc = FaDeckEdit.toDoc(fy.spec); const titles = (newDoc.chapters || []).reduce((a, c) => a.concat((c.slides || []).map((s) => JSON.stringify(s))), []);
        D0.slides(spec).filter((x) => x.locked).forEach((x) => { const same = titles.indexOf(JSON.stringify(Object.assign({ title: x.name }, (() => { const t = {}; Object.keys(x.slide).forEach((k) => { t[k] = x.slide[k]; }); return t; })()))) >= 0; if (!same) notes.push(T('鎖住的「' + x.name + '」被代理人改到了,預覽時請看清楚,不要就按「退回」', 'A locked slide was changed by the agent; reject if unwanted')); });
        return { say: said, edits: [{ op: 'replace_deck', doc: newDoc }], notes };
    };

    // ───── 找圖(快路):2~5 個英文關鍵字 → _deckFindPhoto(Wikimedia／Openverse)→ 播放器看得到的 client-file 網址 ─────
    M._deckEditPhoto = async function (query, notes, status) {
        const A = this._edAi(); let q = String(query || '').trim(); if (!q) return null;
        if (CJK.test(q)) { if (!A.have()) { notes.push(T('找圖要英文關鍵字,而目前沒有可用的 AI 可以翻;請直接給英文關鍵字', 'Need English keywords')); return null; } try { q = (await A.chat('Give 2 to 5 English keywords for searching a photo of this. Answer with the keywords only, separated by spaces.', q, { maxTokens: 40, timeoutMs: 30000 })).replace(/[^A-Za-z0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim(); } catch (_) { q = ''; } if (!q) { notes.push(T('翻不出英文關鍵字', 'Could not make keywords')); return null; } }
        status(T('上網找圖:', 'Searching: ') + q); if (!this._deckRunState) this._deckBeginRun(''); const r = await this._deckFindPhoto({ query: q, count: 1 });
        if (!r || r.error || !r.photos || !r.photos.length) { notes.push(String((r && r.error) || T('沒找到合適的圖', 'no photo found')).slice(0, 140)); return null; }
        const p = r.photos[0], url = this._deckRun().catalog.resolve(p.ref); if (!url) { notes.push(T('圖片匯入失敗', 'import failed')); return null; }
        return { url, title: p.title, credit: p.credit, license: p.license, source: p.source, page: p.page, query: q };
    };
    M._deckEditPhotoEdits = function (spec, ph, ref, asNewPage, title) {
        const vis = { kind: 'image', src: ph.url }; const cap = [ph.title, ph.credit, ph.license].filter(Boolean).join(' · '); if (cap) vis.caption = cap.slice(0, 160);
        if (asNewPage) return { op: 'add_slide', after: ref || 'current', slide: { title: String(title || ph.query || '圖片').slice(0, 60), layout: 'visual', visual: vis, narration: '' } };
        return { op: 'set_visual', id: ref || 'current', visual: vis };
    };

    M._edAskDeck = async function (req, ed) {
        req = req || {}; const A = this._edAi(), D0 = FaDeckEdit, spec = D0.validate(req.spec).spec, notes = [], edits = [], text = String(req.text || '').trim(), status = typeof req.onStatus === 'function' ? req.onStatus : () => {}; let say = '';
        const holder = this._edEditors && this._edEditors.get('edit-media-presentation:' + ed.id), env = holder && holder._ed && holder._ed.env ? holder._ed.env() : { selection: req.selection };
        const curRef = env.slide || req.selection || 'current'; const asNew = NEWPAGE_RE.test(text);
        // 1) 貼進對話框的圖 → 這頁的圖(或新的一頁)
        for (let i = 0; i < Math.min(3, (req.images || []).length); i++) {
            const im = req.images[i]; try { const blob = await (await fetch(im.dataUrl)).blob(); if (!this._deckRunState) this._deckBeginRun(''); const r = await this._deckImportImageBlob(blob, 'pasted: ' + (im.name || 'picture'), 'edit'); if (r && r.ok) { edits.push(this._deckEditPhotoEdits(spec, { url: r.url, title: '', query: (im.name || '圖片').replace(/\.[a-z0-9]+$/i, '') }, curRef, asNew || i > 0, (im.name || '圖片').replace(/\.[a-z0-9]+$/i, ''))); say = say || T('把你貼的圖放進簡報了。', 'Put the picture in.'); } else notes.push(String((r && r.error) || '圖片匯入失敗').slice(0, 100)); } catch (e) { notes.push(T('「' + (im.name || '圖片') + '」處理失敗:', 'the picture failed: ') + String((e && e.message) || e).slice(0, 80)); }
        }
        if (edits.length && !text) return { say, edits, notes };
        if (!text) return { say, edits, notes };
        // 2) 要上網、讀檔、畫圖表、整章重做 → 代理人
        if (AGENT_RE.test(text) && !(PIC_RE.test(text) && !PIC_NOT.test(text) && !/(查|研究|蒐集|收集|讀)/.test(text))) {
            const r = await this._deckEditAgent(spec, text, env, status); if (r.error) return { say: '⚠️ ' + r.error, edits: [], notes }; return { say: r.say || '', edits: edits.concat(r.edits || []), notes: notes.concat(r.notes || []) };
        }
        // 3) 找圖／插入圖片(程式先讀的:一頁一張,「每一頁」逐頁來)
        if (PIC_RE.test(text) && !PIC_NOT.test(text) && !EVERY_RE.test(text)) {
            const subj = text.replace(/^(?:請|麻煩|幫我|可以)?\s*/, '').replace(/(?:在|到|於)?\s*(?:這頁|這一頁|這張|目前這頁|第\s*[0-9一二三四五六七八九十]+\s*頁)\s*(?:的?後面|之後)?/g, ' ').replace(/(?:新增|插入|加|多加|做)\s*(?:一|1)?\s*(?:頁|張)/g, ' ').replace(/(?:找|搜尋|搜|插入|放|加|換|配|貼|補|來)\s*(?:一|1)?\s*(?:張|個|些)?/g, ' ').replace(/(?:圖片|照片|相片|圖|畫面|picture|photo|image)s?/ig, ' ').replace(/(?:進來|進去|上去|上|吧|的|一下|看看|關於|有關)/g, ' ').replace(/\s+/g, ' ').trim();
            const m = /第\s*([0-9一二三四五六七八九十]+)\s*頁/.exec(text); const ref = m ? D0.parseCommands('刪掉第' + m[1] + '頁', spec).edits[0] ? D0.parseCommands('刪掉第' + m[1] + '頁', spec).edits[0].id : curRef : curRef;
            const target = D0.resolve(spec, ref, env) >= 0 ? spec.objects[D0.resolve(spec, ref, env)] : null; const query = subj || (target ? target.name : '');
            const ph = await this._deckEditPhoto(query, notes, status);
            if (ph) { edits.push(this._deckEditPhotoEdits(spec, ph, ref, asNew, query)); say = say || T('放了一張「', 'Added "') + ph.title.slice(0, 40) + T('」的照片(出處:', '" (source: ') + (ph.source || '') + (ph.license ? ' ' + ph.license : '') + ')。'; if (ph.credit) notes.push(T('出處:', 'Credit: ') + ph.credit.slice(0, 80)); }
            else if (!notes.length) say = T('沒找到合適的圖。', 'No suitable photo.');
            if (edits.length) return { say, edits, notes };
        }
        // 4) 語言:AI 轉成封閉動作(含 find_picture／generate_image／agent)
        if (!A.have()) return { say: edits.length ? say : T('這句話程式沒有讀懂,而且目前沒有可用的 AI;可以用大綱與屬性面板自己改,或說「第 3 頁標題改成…」「在這頁後面加一頁」「把第 2 頁移到最後」這類程式讀得懂的句子。', 'The program did not understand this and there is no AI.'), edits, notes };
        status(T('想一想怎麼改…', 'Working out the changes…'));
        const Pm = D0.editPrompt(spec, text, EVERY_RE.test(text) ? '使用者要的是「每一頁」都做:對大綱裡每一頁各給一個動作(要放照片就每頁各一個 find_picture,query 用那頁主題的英文關鍵字);最多 15 頁,超過就只做前 15 頁並在 say 說明。' : '', req.selection, env);
        try {
            const rep = await A.chat(Pm.system, Pm.user, { maxTokens: 4000, timeoutMs: 150000 }), pr = D0.parseEditsReply(rep);
            if (pr.ok) {
                let hostRuns = 0, agentTask = null;
                for (const e of pr.edits) {
                    if (e.op === 'find_picture') { if (hostRuns++ >= 15) { notes.push(T('一次最多找 15 張圖,其餘略過', 'at most 15 pictures at once')); continue; } const ph = await this._deckEditPhoto(String(e.query || ''), notes, status); if (ph) { const ref = e.id || curRef; edits.push(this._deckEditPhotoEdits(spec, ph, ref, e.mode === 'new_slide', e.title || e.query)); notes.push(T('圖:', 'Photo: ') + String(ph.title).slice(0, 40) + (ph.license ? ' (' + ph.license + ')' : '')); } }
                    else if (e.op === 'generate_image') { if (hostRuns++ >= 15) continue; status(T('畫圖…', 'Generating a picture…')); const g = await this._edGenerate({ prompt: String(e.prompt || '') }, status); if (g.ok) { if (!this._deckRunState) this._deckBeginRun(''); const r = await this._deckImportImageBlob(g.image.blob, 'generated: ' + String(e.prompt || '').slice(0, 40), 'generate_image'); if (r && r.ok) edits.push(this._deckEditPhotoEdits(spec, { url: r.url, title: '', query: String(e.prompt || '').slice(0, 30) }, e.id || curRef, e.mode === 'new_slide', e.title)); else notes.push(String((r && r.error) || '').slice(0, 100)); } else notes.push(g.needs_download ? T('本機生圖模型還沒下載:先輸入 /image download', 'The local image model is not downloaded') : String(g.error || '').slice(0, 100)); }
                    else if (e.op === 'agent') { agentTask = String(e.task || text).slice(0, 1500); }
                    else edits.push(e);
                }
                if (pr.say) say = say ? say + ';' + pr.say : pr.say; if (pr.dropped) notes.push(T('有 ' + pr.dropped + ' 個動作不在可做的清單裡,已略過', pr.dropped + ' actions were not allowed and were skipped'));
                if (agentTask && !edits.length) { const base = D0.applyEdits(spec, edits, env).spec; const r = await this._deckEditAgent(base, agentTask, env, status); if (r.error) return { say: '⚠️ ' + r.error, edits, notes }; return { say: r.say || say, edits: r.edits || [], notes: notes.concat(r.notes || []) }; }
                if (agentTask) notes.push(T('另外有一部分要上網或讀檔的事,這一輪沒做:再說一次「…」就會請代理人去做', 'Part of the request needs the agent; ask again for it'));
            } else if (!edits.length) say = T('AI 的回覆我讀不懂(要是 JSON 動作)。換個說法再試一次。', 'I could not read the AI\'s answer. Say it differently.');
        } catch (e5) { if (!edits.length) say = T('AI 這次沒有回應(', 'The AI did not answer (') + String((e5 && e5.message) || e5).slice(0, 80) + ')。'; }
        return { say, edits, notes };
    };

    // ───── 斜線指令與播放器上的 ✏️ 編輯 ─────
    M._registerEditDeckCommands = function () {
        const self0 = this;
        this.register_slash_command('/edit-media-presentation', '[簡報檔案 id｜一句話要改什麼]',
            '簡報編輯器:在簡報播放器旁邊多一個 AI 對話框,用說的改簡報——你現在看的那一頁就是「這頁」:「這頁加一張飛機的照片」「在這頁後面插入一頁講風險」「每一頁都配一張照片」「旁白講短一點」。要上網找圖與資料、讀檔、畫圖表,會請簡報代理人(跟 /media-presentation 一樣的工具)去做;改的先預覽再套用,每一步都能復原;左邊是章與頁的大綱(搬動、複製、隱藏、鎖定)。/edit-media-presentation 編輯最近的簡報;/edit-media-presentation 在第 2 頁後面加一頁講風險。播放器上也有「✏️ 編輯」鈕。',
            async (argsText, run) => {
                const r = run || self0, a = String(argsText || '').trim(); r.messages.push({ role: 'user', content: '/edit-media-presentation' + (a ? ' ' + a : '') });
                try {
                    const idLike = /^(?:client-file\/)?[\w-]+(?:\.deck\.yaml)?$/.test(a) && /(deck\.yaml|^[\w-]{8,}$)/.test(a) && !/[㐀-鿿]/.test(a);
                    let url = idLike ? (/^client-file\//.test(a) ? a : 'client-file/' + a.replace(/\.deck\.yaml$/, '') + '.deck.yaml') : r._deckEditLatestUrl(); let request = idLike ? '' : (/^(last|最近|上一個|剛剛的)$/i.test(a) ? '' : a);
                    if (!url && request) { r._pushAssistantMessage(T('這個對話裡還沒有簡報,先用 /media-presentation 做一份(下面開始做)…', 'No deck yet; making one first…'), null); await r._deckSlashPresentation(request); url = r._deckEditLatestUrl(); request = ''; }
                    if (!url) { r._pushAssistantMessage(H.KINDS['edit-media-presentation'].help(), null); }
                    else { const res = await r._deckEditOpen(url, request); if (res && res.ok === false) r._pushAssistantMessage('⚠️ ' + (res.error || T('開不起來', 'could not open it')), null); }
                } catch (e) { r._pushAssistantMessage('⚠️ ' + T('開不起來:', 'Could not open it: ') + String((e && e.message) || e), null); }
                try { r._persistChatHistory(); r._renderMessageHistory(); } catch (_) { /* */ }
            });
        // 播放器上的「✏️ 編輯」
        const self = this; window.AiChatDeckEditHook = (url) => { self._deckEditOpen(url, '').then((res) => { if (res && res.ok === false) self._pushAssistantMessage('⚠️ ' + (res.error || ''), null); try { self._persistChatHistory(); self._renderMessageHistory(); } catch (_) { /* */ } }); };
    };
    const prevRegister = M._registerEditCommands; M._registerEditCommands = function () { if (prevRegister) prevRegister.call(this); this._registerEditDeckCommands(); };
})();
