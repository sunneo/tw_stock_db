/* /edit-svg、/edit-picture（以及之後同一套外框的 /edit-3d-model）的主機轉接層。
 * 編輯器本體（edit_objects_core／edit_shell／edit_svg_*／edit_picture_*／pic_fx…）是從 redmine_ai_chat 外掛移植的，純函式加 DOM，
 * 不認識這個助理；這裡把它們接到助理自己的零件：模型（_kiLlm：線上優先、失敗改離線）、視覺模型（_interpretImageWithVisionModel）、
 * 生圖（_generateImage：線上 NVIDIA 或本機 SDXS）、檔案（fileCache／generateAndDeliverFile）、網路（fetch，不行再走 _terminalHttpFetch）、
 * 視窗（FaWin）。專案存在這個瀏覽器的 IndexedDB（FaEditStore，tw_edit）；圖片的像素只存一份，每一步只記短代號。
 * 對話裡的編輯器是一則訊息裡的 ```fa-edit-svg {"id":…}``` ／ ```fa-edit-picture {"id":…}``` 區塊（重新整理後由 _mountEditEditors 重建）。
 * 全部以方法的形式掛到 FloatingAssistant.prototype（見 embed-code-ui.js 的 EDITHOST 標記）。設計見 DESIGN.edit-svg.md、DESIGN.edit-picture.md。 */
const FaEditHost = (function () {
    'use strict';
    const zh = () => { const l = String((document.documentElement && document.documentElement.lang) || (typeof window !== 'undefined' && window.FaUiLocale && window.FaUiLocale.locale) || ''); return !l || /^zh/i.test(l); };
    const T = (a, b) => (zh() ? a : b);
    const words = (t) => String(t || '').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((w) => w.length > 2 || /[一-鿿]/.test(w));
    const overlap = (a, b) => { const A = {}, B = {}; let n = 0, u = 0; words(a).forEach((w) => { A[w] = 1; }); words(b).forEach((w) => { B[w] = 1; }); Object.keys(A).forEach((w) => { u++; if (B[w]) n++; }); Object.keys(B).forEach((w) => { if (!A[w]) u++; }); return u ? n / u : 0; };
    const VECTOR_WORDS = /(svg|向量|描摹|描圖|trace|vector|轉成?圖形|變成?圖形|畫成)/i, PLACE_WORDS = /(放進|放入|放到|貼上|貼到|加入|加進|插入|擺|place|insert|put|add)/i;
    const RESTYLE_WORDS = /(變成|轉成|改成|換成|做成|弄成|風格|畫風|style|looks? like|像.{0,6}一樣|in the style)/i, REPAINT_WORDS = /(重畫|重新畫|重繪|重新生成|用\s*ai\s*(?:重)?畫|regenerate|redraw|re-?imagine|repaint|paint it again)/i;
    const STYLE_FOR_SD = { oil: 'oil', watercolor: 'watercolor', sketch: 'sketch', ink: 'ink', cartoon: 'anime', pixel: 'pixel', poster: 'flat', vintage: 'photo', neon: 'cyberpunk', night: 'cinematic', dreamy: 'fantasy' };
    const yes = (t) => /^\s*(yes|yeah|y\b|是|對|像|有)/i.test(String(t || '')), no = (t) => /^\s*(no\b|nope|不|沒|否)/i.test(String(t || ''));

    // 每一種編輯器的差異都在這張表；方法本身共用。core／ui 用函式取（模組是 const，embed 順序在這個檔案之前，但保險起見到用的時候才讀）
    const KINDS = {
        'edit-svg': { fence: 'fa-edit-svg', icon: '🖍', cmd: '/edit-svg', prefix: 'sv', label: () => T('SVG 編輯器', 'SVG editor'), core: () => FaEditSvg, ui: () => FaEditSvgUI, lead: '🖍 SVG 編輯器：用語言主導的概念畫家——說要畫什麼、放在哪個東西的哪一邊，就加一個新的物件；畫面沒有邊界。貼圖進去可以描成 SVG。每一步都能復原，進度會保留。' },
        'edit-picture': { fence: 'fa-edit-picture', icon: '🎨', cmd: '/edit-picture', prefix: 'pc', label: () => T('圖片編輯器', 'Picture editor'), core: () => FaEditPicture, ui: () => FaEditPictureUI, lead: '🎨 圖片編輯器：圖層式的後製與修復——貼圖、給網址或說「找一張…的圖」就有第一個圖層；然後用說的：「變成水彩風格」「調亮」「修掉右下角的污點」。濾鏡與修復都是圖層，原圖不動；每一步都能復原，進度會保留。' },
    };
    const register = (kind, def) => { KINDS[kind] = def; };

    const methods = {
        // ───── 模型、視覺、網路 ─────
        // 在編輯器裡做的事（離線模型、視覺模型的卡片與步驟）全部送進編輯器自己的記錄，不在主對話裡冒出一堆卡片
        async _edQuietRun(sink, fn) { const prev = this._edQuiet; this._edQuiet = { sink }; try { return await fn(); } finally { this._edQuiet = prev; } },
        _edAi() {
            const self = this, stepOf = () => (self._edQuiet && self._edQuiet.sink) || undefined;
            return {
                have() { try { const c = self._getApiConfig(); return !!(c && c.apiKey) || !!(self.advancedSettings && self.advancedSettings.offlineMode); } catch (_) { return false; } },
                async chat(system, user, o) { o = o || {}; return String(await self._kiLlm(user, { systemPrompt: system || '', maxTokens: o.maxTokens || 8000, temperature: o.temperature == null ? 0.2 : o.temperature }, { timeoutMs: o.timeoutMs || 180000, label: o.label || 'AI', onStep: stepOf() })); },
                // 離線小模型用的封閉題：只回答一個字母（題目與解析見 edit_offline.js）；答不出來回傳 null，由程式用預設
                async pick(question, options) { const r = await self._kiLlm(FaEditOffline.letterPrompt(question, options), { systemPrompt: '你是選擇題的回答者。只回答一個大寫字母，不要解釋。', maxTokens: 16, temperature: 0 }, { timeoutMs: 60000, label: '選擇題', onStep: stepOf() }); return FaEditOffline.parseLetter(r, options.length); },
                // 只有「把一段字改寫得更短／更長」這種真的要寫字的事才請模型自由寫
                async rewrite(text, how) { return String(await self._kiLlm('原文：\n' + text + '\n\n請' + how + '。只輸出改寫後的文字，不要加說明、不要加引號。', { systemPrompt: '你是文字編輯，只輸出改寫後的文字。', maxTokens: 1200, temperature: 0.3 }, { timeoutMs: 90000, label: '改寫', onStep: stepOf() })).trim(); },
                async vision(dataUrl, question) { const r = await self._interpretImageWithVisionModel(dataUrl, question); return String(typeof r === 'string' ? r : (r && (r.description || r.answer || r.transcription)) || ''); },
            };
        },
        // ───── 離線 AI：程式讀出顏色／數字／物件，只在有歧義時問模型一個字母選擇題（見 DESIGN.edit-offline.md）。離線模式開著時，程式讀不懂的話先走這條，再不行才請模型自由寫 JSON
        _edIsOffline() { return !!(this.advancedSettings && this.advancedSettings.offlineMode) && typeof FaEditOffline !== 'undefined'; },
        async _edOfflineTry(kind, text, spec, env, status) {
            if (typeof FaEditOffline === 'undefined' || !String(text || '').trim()) return null;
            const adapters = { 'edit-svg': () => FaEditOffline.drawAdapter(FaEditSvg), 'edit-picture': () => FaEditOffline.drawAdapter(FaEditPicture), 'edit-3d': () => FaEditOffline.sceneAdapter(FaEdit3d), 'edit-media-presentation': () => FaEditOffline.deckAdapter(FaDeckEdit), 'edit-game-2d': () => FaEditOffline.gameAdapter(FaGame), 'edit-game-3d': () => FaEditOffline.gameAdapter(FaGame) };
            if (!adapters[kind]) return null; const A = this._edAi(); if (typeof status === 'function') status(T('用程式讀這句話…', 'Reading the sentence with the program…'));
            const e2 = Object.assign({}, env || {}); if (!e2.selection && e2.slide) e2.selection = e2.slide;
            let r; try { r = await FaEditOffline.make(adapters[kind]()).run(String(text), spec, e2, (q, opts) => A.pick(q, opts), (t, how) => A.rewrite(t, how)); } catch (e) { return { edits: [], notes: [String((e && e.message) || e).slice(0, 80)], unmatched: [String(text)], asked: [] }; }
            const asked = r.asked.filter((a) => a.by === 'model').length;
            return { edits: r.edits, notes: r.notes.concat(asked ? [T('問了模型 ' + asked + ' 個選擇題', 'asked the model ' + asked + ' multiple-choice questions')] : []), unmatched: r.unmatched, asked: r.asked, say: r.edits.length ? T('離線：程式讀懂了 ' + r.matched.length + ' 句', 'Offline: the program understood ' + r.matched.length + ' sentence(s)') : '' };
        },
        _edFetchFn() {
            const self = this;
            return async function (url, opts) {
                try { return await fetch(url, opts); } catch (e1) {
                    if (!/^https?:/i.test(String(url)) || typeof self._terminalHttpFetch !== 'function') throw e1;
                    const hdr = Object.assign({}, (opts && opts.headers) || {}); const { resp } = await self._terminalHttpFetch('GET', String(url), { headers: hdr, timeoutMs: 25000 }); return resp;
                }
            };
        },
        _edPics(kind) {
            this._edPicsCache = this._edPicsCache || {};
            if (!this._edPicsCache[kind]) { const ai = this._edAi(); this._edPicsCache[kind] = FaEditPictures.make({ C: KINDS[kind].core(), store: FaEditStore, ai: { have: ai.have, chat: ai.chat }, T, fetch: this._edFetchFn() }); }
            return this._edPicsCache[kind];
        },

        // ───── /edit-svg：圖 → SVG 物件（程式描、視覺模型看、數字量、最多三輪） ─────
        async _edVectorize(blob, o) {
            const self = this, A = this._edAi(), C = FaEditSvg, Tr = FaSvgTrace, P = this._edPics('edit-svg'), say = o.status || (() => {}), notes = [];
            const img = await P.decode(blob, 1024), want = img.canvas.toDataURL('image/jpeg', 0.8); let d0 = '';
            if (A.have()) { try { say(T('視覺模型先看原圖…', 'The vision model looks at the picture first…')); d0 = (await A.vision(want, C.refPrompt())).trim(); if (d0) notes.push(T('視覺模型看到：', 'The vision model sees: ') + d0.replace(/\s+/g, ' ').slice(0, 180)); } catch (e) { notes.push(T('（視覺模型沒有回應，只用數字確認）', '(no answer from the vision model: only the numbers check it)')); } }
            const ROUNDS = [{ colors: 10, maxSide: 160 }, { colors: 18, maxSide: 256 }, { colors: 30, maxSide: 384 }], targetW = o.targetWidth || Math.min(img.width, 800); let best = null;
            for (let n = 0; n < ROUNDS.length; n++) {
                say(T('第 ' + (n + 1) + ' 輪：用 ' + ROUNDS[n].colors + ' 種顏色描出輪廓…', 'Round ' + (n + 1) + ': tracing with ' + ROUNDS[n].colors + ' colours…'));
                await new Promise((r) => setTimeout(r, 0));
                const res = Tr.trace(img, ROUNDS[n]), objs = Tr.toObjects(res, { x: 0, y: 0, width: targetW }), sc = targetW / res.w;
                const sp = C.validate({ canvas: { x: 0, y: 0, w: res.w * sc, h: res.h * sc }, objects: objs }).spec, svgText = C.compose(sp, { region: { x: 0, y: 0, w: res.w * sc, h: res.h * sc } });
                const rb = await FaEditSvgUI.rasterize(svgText, res.w * sc, res.h * sc, 1 / sc), rd = await P.decode(rb, 512), score = Tr.compare(img, rd).score;
                say(T('第 ' + (n + 1) + ' 輪：' + res.layers.length + ' 個色塊，和原圖的相似度 ' + Math.round(score * 100) + '%', 'Round ' + (n + 1) + ': ' + res.layers.length + ' colour regions, ' + Math.round(score * 100) + '% like the original'));
                if (!best || score > best.score) best = { res, objs, score, round: n + 1, raster: rd };
                if (score >= 0.93) break;
            }
            let d1 = '', ov = null;
            if (d0 && A.have()) { try { say(T('視覺模型再看一次畫出來的 SVG…', 'The vision model looks at the SVG that was made…')); d1 = (await A.vision(best.raster.canvas.toDataURL('image/jpeg', 0.8), C.refPrompt())).trim(); ov = overlap(d0, d1); notes.push(T('再看一次：', 'Again: ') + d1.replace(/\s+/g, ' ').slice(0, 140)); } catch (e) { /* 數字還在 */ } }
            const ok = best.score >= 0.85 && (ov == null || ov >= 0.12 || best.score >= 0.93);
            notes.push(T('結果：第 ' + best.round + ' 輪，' + best.res.layers.length + ' 個物件，相似度 ' + Math.round(best.score * 100) + '%' + (ov != null ? '，視覺模型兩次描述的相同度 ' + Math.round(ov * 100) + '%' : '') + (ok ? '。' : '。不太像原圖：可以請我「用更多顏色」重做。'), 'Result: round ' + best.round + ', ' + best.res.layers.length + ' objects, ' + Math.round(best.score * 100) + '% like the original' + (ov != null ? ', the two descriptions of the vision model are ' + Math.round(ov * 100) + '% alike' : '') + (ok ? '.' : '. It is not very close: ask me to "use more colours" to try again.')));
            if (d0 && A.have() && best.objs.length > 1) {
                try {
                    say(T('請模型替每個色塊取名…', 'Asking the model to name the regions…'));
                    const list = best.objs.map((ob, i) => (i + 1) + '=' + ob.name).join('\n');
                    const reply = await A.chat('You name the colour regions of a traced picture. Answer with one line per region: number=short name (at most 8 characters, in the language of the user\'s picture description). Nothing else.', 'The picture: ' + d0.replace(/\s+/g, ' ').slice(0, 600) + '\nRegions (number=colour and place):\n' + list, { maxTokens: 400, timeoutMs: 60000 }); let got = 0;
                    String(reply).split('\n').forEach((ln) => { const m = /^\s*(\d{1,3})\s*[=:：]\s*(.{1,12}?)\s*$/.exec(ln); if (m && best.objs[Number(m[1]) - 1] && !/[<>{}]/.test(m[2])) { best.objs[Number(m[1]) - 1].name = m[2]; got++; } });
                    if (got) notes.push(T('取了 ' + got + ' 個名字', 'named ' + got + ' regions'));
                } catch (e) { /* 程式取的名字還在 */ }
            }
            return { objects: best.objs, score: best.score, size: { w: targetW, h: best.res.h * targetW / best.res.w }, notes, ok };
        },
        _edVectorEdits(spec, vec) {
            const p = this._edPics('edit-svg').placementFor(spec), edits = [], b = vec.size; if (p.empty) edits.push({ op: 'set_canvas', x: 0, y: 0, w: Math.round(b.w), h: Math.round(b.h) });
            vec.objects.forEach((o) => { edits.push({ op: 'add_object', object: Object.assign({}, o, { x: p.x, y: p.y }) }); }); return edits;
        },
        async _edAskSvg(req, ed) {
            req = req || {}; const self = this, A = this._edAi(), C = FaEditSvg, P = this._edPics('edit-svg'); const spec = C.validate(req.spec).spec, notes = [], edits = []; let say = ''; const text = String(req.text || '').trim(), status = typeof req.onStatus === 'function' ? req.onStatus : () => {};
            const wantVector = VECTOR_WORDS.test(text) || (!text && req.images && req.images.length); let refText = '';
            for (let i = 0; i < Math.min(2, (req.images || []).length); i++) {
                const im = req.images[i];
                try {
                    const blob = await (await fetch(im.dataUrl)).blob();
                    if (wantVector) { const vec = await this._edVectorize(blob, { status }); vec.notes.forEach((n) => notes.push(n)); this._edVectorEdits(spec, vec).forEach((e) => edits.push(e)); say = say || T('把「' + (im.name || '圖片') + '」描成 SVG 了。', 'Traced "' + (im.name || 'picture') + '" into SVG.'); }
                    else if (PLACE_WORDS.test(text) && /(圖|照片|picture|image|photo)/i.test(text)) { const k = await P.keep(blob); P.addImageEdits(C.applyEdits(spec, edits).spec, k, (im.name || 'picture').replace(/\.[a-z0-9]+$/i, ''), '').forEach((e) => edits.push(e)); say = say || T('把圖片放進來了。', 'Added the picture.'); }
                    else if (A.have()) { try { refText += (refText ? '\n\n' : '') + (await A.vision(im.dataUrl, C.refPrompt())).trim(); } catch (e0) { notes.push(T('看不懂「' + (im.name || '圖片') + '」', 'could not read the picture')); } }
                } catch (e) { notes.push(T('「' + (im.name || '圖片') + '」處理失敗：', 'the picture failed: ') + String((e && e.message) || e).slice(0, 80)); }
            }
            const fr = await P.fromText({ text, spec: C.applyEdits(spec, edits).spec, editorId: ed.id, status, onBlob: wantVector ? async (blob, name, credit, editsArr, spec2) => { const v2 = await self._edVectorize(blob, { status }); v2.notes.forEach((n) => notes.push(n)); self._edVectorEdits(spec2, v2).forEach((e) => editsArr.push(e)); return true; } : null });
            fr.edits.forEach((e) => edits.push(e)); fr.notes.forEach((n) => notes.push(n)); if (fr.say) say = say || fr.say;
            if (edits.length) return { say, edits, notes };
            if (this._edIsOffline() && text) { const off = await this._edOfflineTry('edit-svg', text, C.applyEdits(spec, edits).spec, { selection: req.selection }, status); if (off && off.edits.length) return { say: off.say, edits: off.edits, notes: notes.concat(off.notes) }; }
            if (!A.have()) return { say: T('這句話程式沒有讀懂，而且目前沒有可用的 AI；可以用物件欄與屬性面板自己改，或用「找一張…的圖」、貼網址。', 'The program did not understand this and there is no AI; use the objects view and the properties, or "find a picture of …", or paste an address.'), edits, notes };
            if (!text && !refText) return { say, edits, notes };
            status(T('畫…', 'Painting…'));
            const Pm = C.editPrompt(C.applyEdits(spec, edits).spec, text || T('照這張圖的樣子畫', 'draw it like this picture'), refText ? T('使用者附了參考圖，內容描述如下（請照它的構圖、物件與顏色畫，每個物件獨立成一個新物件）：\n', 'The user attached a reference picture, described as (draw its layout, objects and colours; each thing its own new object):\n') + refText : '', req.selection);
            try { const rep = await A.chat(Pm.system, Pm.user), pr = C.parseEditsReply(rep); if (pr.ok) { pr.edits.forEach((e) => edits.push(e)); if (pr.say) say = say ? say + '；' + pr.say : pr.say; if (pr.dropped) notes.push(T('有 ' + pr.dropped + ' 個動作不在可做的清單裡，已略過', pr.dropped + ' actions were not in the allowed list and were skipped')); } else if (!edits.length) say = T('AI 的回覆我讀不懂（要是 JSON 動作）。換個說法再試一次。', 'I could not read the AI\'s answer (it has to be JSON actions). Say it differently.'); }
            catch (e5) { if (!edits.length) say = T('AI 這次沒有回應（', 'The AI did not answer (') + String((e5 && e5.message) || e5).slice(0, 80) + '）。'; }
            return { say, edits, notes };
        },
        async _edVectorizeObject(el, obj) {
            const ed = el._ed, blob = await FaEditStore.getImage(obj.ref); if (!blob) { ed.ctx.say(T('找不到這張圖的內容', 'the picture is gone')); return; }
            ed.ctx.say(T('描成 SVG 中…', 'Tracing…'));
            return this._edQuietRun((line) => { try { ed.ctx.say(line); } catch (_) { /* */ } }, () => this._edVectorizeObject2(el, obj, ed, blob));
        },
        async _edVectorizeObject2(el, obj, ed, blob) {
            try {
                const vec = await this._edVectorize(blob, { status: (t) => ed.ctx.say(t), targetWidth: obj.w }), x0 = obj.x + obj.w + 40, y0 = obj.y;
                ed.ctx.apply(vec.objects.map((o) => ({ op: 'add_object', object: Object.assign({}, o, { x: x0, y: y0 }) })), T('把「' + obj.name + '」描成 SVG', 'Traced "' + obj.name + '" into SVG'), '', 'panel'); ed.ctx.say(vec.notes[vec.notes.length - 1] || '');
            } catch (e) { ed.ctx.say(T('描成 SVG 失敗：', 'Tracing failed: ') + String((e && e.message) || e).slice(0, 80)); }
        },

        // ───── /edit-picture：風格（濾鏡層＋視覺模型確認）、重畫（視覺描述＋生圖）、修復、找圖 ─────
        async _edSnapshot(spec, size) {
            const r = await FaEditPictureUI.render(spec, { store: FaEditStore, resolve: (ref) => FaEditStore.imageUrl(ref), frameOnly: true, maxSide: size || 512 });
            return r ? r.canvas.toDataURL('image/jpeg', 0.82) : null;
        },
        async _edRestyle(spec, styleId, target, status, notes) {
            const A = this._edAi(), C = FaEditPicture, st = C.STYLES[styleId], tries = [1, 1.8, 2.8]; let chosen = 1, verdict = null;
            for (let i = 0; i < tries.length; i++) {
                const cand = C.applyEdits(spec, [{ op: 'apply_style', style: styleId, target, strength: tries[i] }]); if (!cand.applied.length) { notes.push(cand.rejected[0] ? cand.rejected[0].error : 'no layer'); return null; }
                chosen = tries[i];
                if (!A.have()) { notes.push(T('（沒有視覺模型，沒有確認像不像）', '(no vision model: not checked whether it looks like it)')); break; }
                status(T('第 ' + (i + 1) + ' 次：做出「' + st.label + '」，請視覺模型看像不像…', 'Try ' + (i + 1) + ': made "' + st.en.replace(/^(an?|the) /, '') + '", asking the vision model whether it looks like it…'));
                const url = await this._edSnapshot(cand.spec, 448); if (!url) break;
                try { verdict = (await A.vision(url, 'Does this picture look like ' + st.en + '? Answer yes or no first, then give one short reason.')).trim(); } catch (e) { notes.push(T('（視覺模型沒有回應，沒有確認）', '(the vision model did not answer: not checked)')); break; }
                notes.push(T('視覺模型說：', 'The vision model says: ') + verdict.replace(/\s+/g, ' ').slice(0, 110));
                if (yes(verdict) && !no(verdict)) break;
                if (i < tries.length - 1) notes.push(T('不太像，加強一點再試', 'Not very close: a stronger one'));
            }
            return { edit: { op: 'apply_style', style: styleId, target, strength: chosen }, verdict };
        },
        // 生圖統一走 _generateImage（線上或本機），再把檔案快取裡的圖拿回來當圖層
        async _edGenerate(a, status) {
            const g = await this._generateImage(a); if (!g || !g.ok) return { ok: false, error: (g && g.error) || 'no image', needs_download: !!(g && g.needs_download) };
            const im = (g.images && g.images[0]) || null; const rec = im && im.file_id ? await this.fileCache.get(im.file_id) : null;
            if (!rec || !rec.blob) return { ok: false, error: T('生圖完成了但取不回圖片', 'the image was made but could not be read back') };
            return { ok: true, image: { blob: rec.blob, prompt_used: a.prompt, seed: im.seed } };
        },
        async _edRepaint(spec, srcObj, styleId, extraText, status, notes) {
            const A = this._edAi(), C = FaEditPicture, st = styleId ? C.STYLES[styleId] : null; let desc = '';
            if (A.have() && srcObj) { try { status(T('視覺模型描述這張圖的內容…', 'The vision model describes what is in the picture…')); const blob = await FaEditStore.getImage(srcObj.ref), du = await FaEditStore.dataUrl(blob); desc = (await A.vision(du, 'Describe the content of this picture for a painter in one or two short sentences: the subjects, where they are, the colours, the scene. Only what you see.')).trim().replace(/\s+/g, ' '); notes.push(T('看到：', 'Sees: ') + desc.slice(0, 140)); } catch (e) { notes.push(T('（視覺模型沒有回應，只用名字與你的描述）', '(no answer from the vision model: only the name and your words)')); } }
            const prompt = (desc || (srcObj && srcObj.prompt) || (srcObj && srcObj.name) || extraText || '').slice(0, 400) + (st ? ', ' + st.en : '') + (extraText && desc ? ', ' + extraText.slice(0, 120) : '');
            status(T('生圖模型重畫中…（要等一下）', 'The image model is painting… (this takes a moment)'));
            const res = await this._edGenerate({ prompt, style: STYLE_FOR_SD[styleId] || undefined }, status);
            if (!res.ok) { notes.push(res.needs_download ? T('本機生圖模型還沒下載：先輸入 /image download（只下載一次）', 'The local image model is not downloaded: type /image download first (once)') : res.error); return null; }
            const k = await this._edPics('edit-picture').keep(res.image.blob), b = srcObj ? FaEditPicture.types.image.bbox(srcObj) : null, w = b ? b.w : 480, h = b ? Math.round(b.w * k.h / k.w) : 480;
            const obj = { type: 'image', name: T('AI 重畫', 'AI repaint') + (st ? '：' + st.label : ''), ref: k.ref, mime: k.mime, x: b ? b.x + b.w + 40 : 0, y: b ? b.y : 0, w, h, prompt: res.image.prompt_used || prompt, seed: res.image.seed };
            return { edits: [{ op: 'add_object', object: obj }], prompt: obj.prompt };
        },
        async _edAskPicture(req, ed) {
            req = req || {}; const A = this._edAi(), C = FaEditPicture, P = this._edPics('edit-picture'); const spec = C.validate(req.spec).spec, notes = [], edits = []; let say = ''; const text = String(req.text || '').trim(), status = typeof req.onStatus === 'function' ? req.onStatus : () => {}, sel = req.selection; let refText = '';
            const cur = () => C.applyEdits(spec, edits).spec;
            const imageTarget = (s) => { const o = sel ? s.objects.filter((x) => x.id === sel)[0] : null; if (o && (o.type === 'image' || o.type === 'shape' || o.type === 'svg')) return o; for (let i = s.objects.length - 1; i >= 0; i--) if (s.objects[i].type === 'image' && s.objects[i].visible) return s.objects[i]; return null; };
            let lastAdded = null;
            for (let i = 0; i < Math.min(3, (req.images || []).length); i++) {
                const im = req.images[i];
                try { const blob = await (await fetch(im.dataUrl)).blob(), k = await P.keep(blob), nm = (im.name || 'picture').replace(/\.[a-z0-9]+$/i, ''); P.addImageEdits(cur(), k, nm, '').forEach((e) => edits.push(e)); lastAdded = nm; say = say || T('把圖片放進來了。', 'Added the picture.'); }
                catch (e) { notes.push(T('「' + (im.name || '圖片') + '」處理失敗：', 'the picture failed: ') + String((e && e.message) || e).slice(0, 80)); }
            }
            const fr = await P.fromText({ text, spec: cur(), editorId: ed.id, status });
            fr.edits.forEach((e) => edits.push(e)); fr.notes.forEach((n) => notes.push(n)); if (fr.say) say = say || fr.say;
            if (fr.handled && fr.edits.length) { const last = fr.edits.filter((e) => e.op === 'add_object' && e.object.type === 'image').pop(); if (last) lastAdded = last.object.name; }
            const styleId = FaPicFx.styleFor(text), wantsRepaint = REPAINT_WORDS.test(text);
            if (styleId && (RESTYLE_WORDS.test(text) || wantsRepaint) && !fr.handled) {
                const s1 = cur(), so = imageTarget(s1), targetRef = lastAdded || (so && so.type === 'image' ? so.id : 'all');
                if (wantsRepaint) { const rsrc = so && so.type === 'image' ? so : s1.objects.filter((x) => x.type === 'image' && x.visible).pop() || null; const swords = (C.STYLES[styleId].words || []).concat([C.STYLES[styleId].label]).filter(Boolean).sort((x, y) => y.length - x.length).map((w) => String(w).replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch)); const extra = text.replace(REPAINT_WORDS, ' ').replace(new RegExp('(?:成|為|變成|轉成)?(?:' + swords.join('|') + ')(?:風格|風)?', 'gi'), ' ').replace(/[，。,.]/g, ' ').replace(/\s+/g, ' ').trim(); const rp = await this._edRepaint(s1, rsrc, styleId, extra.slice(0, 80), status, notes); if (rp) { rp.edits.forEach((e) => edits.push(e)); say = say || T('用生圖模型照這張圖的內容重畫了一張。（這不是把原圖轉成那個風格，是重新畫的）', 'Painted a new picture of what is in it with the image model (it is a new painting, not a conversion of the original).'); } }
                else { const rs = await this._edRestyle(s1, styleId, targetRef, status, notes); if (rs) { edits.push(rs.edit); say = say || T('套用了「' + C.STYLES[styleId].label + '」風格（濾鏡層，原圖沒動，可以隱藏）。想要依內容重新畫成這個風格，說「用 AI 重畫成…」。', 'Applied the "' + C.STYLES[styleId].en.replace(/^(an?|the) /, '') + '" look (a filter layer; the picture itself is untouched). To paint it again in that style, say "repaint it as …".'); } }
            }
            if (edits.length && (styleId || fr.handled || (req.images && req.images.length && !text))) return { say, edits, notes };
            if (req.images && req.images.length && text && A.have() && !edits.length) { for (let j = 0; j < Math.min(2, req.images.length); j++) { try { refText += (refText ? '\n\n' : '') + (await A.vision(req.images[j].dataUrl, C.refPrompt())).trim(); } catch (e) { /* 只用文字 */ } } }
            if (this._edIsOffline() && text) { const off = await this._edOfflineTry('edit-picture', text, cur(), { selection: sel }, status); if (off && off.edits.length) return { say: off.say, edits: edits.concat(off.edits), notes: notes.concat(off.notes) }; }
            if (!A.have()) return { say: edits.length ? say : T('這句話程式沒有讀懂，而且目前沒有可用的 AI；可以用圖層欄與屬性面板自己改，或說「變成水彩風格」「調亮」「去污點」這類簡單的指令，或貼網址、「找一張…的圖」。', 'The program did not understand this and there is no AI; use the layers and the properties, or simple commands like "make it watercolor", "brighter", "remove specks", or paste an address / "find a picture of …".'), edits, notes };
            if (!text && !refText) return { say, edits, notes };
            status(T('想一想怎麼改…', 'Working out the changes…'));
            const Pm = C.editPrompt(cur(), text, refText ? T('使用者附了參考圖，內容描述如下：\n', 'The user attached a picture, described as:\n') + refText : '', sel);
            try {
                const rep = await A.chat(Pm.system, Pm.user), pr = C.parseEditsReply(rep);
                if (pr.ok) {
                    for (let q = 0; q < pr.edits.length; q++) {
                        const e = pr.edits[q];
                        if (e.op === 'find_picture') { const f2 = await P.fromText({ text: 'find a picture of ' + String(e.query || ''), spec: cur(), editorId: ed.id, status }); f2.edits.forEach((x) => edits.push(x)); f2.notes.forEach((n) => notes.push(n)); say = say || f2.say; }
                        else if (e.op === 'generate_image') { const g = await this._edGenerate({ prompt: String(e.prompt || ''), style: e.style }, status); if (g.ok) { const kk = await P.keep(g.image.blob); P.addImageEdits(cur(), kk, String(e.prompt || 'AI').slice(0, 24), '').forEach((x) => { if (x.op === 'add_object') { x.object.prompt = g.image.prompt_used; x.object.seed = g.image.seed; } edits.push(x); }); } else notes.push(g.needs_download ? T('本機生圖模型還沒下載：先輸入 /image download', 'The local image model is not downloaded: type /image download first') : g.error); }
                        else edits.push(e);
                    }
                    if (pr.say) say = say ? say + '；' + pr.say : pr.say; if (pr.dropped) notes.push(T('有 ' + pr.dropped + ' 個動作不在可做的清單裡，已略過', pr.dropped + ' actions were not in the allowed list and were skipped'));
                } else if (!edits.length) say = T('AI 的回覆我讀不懂（要是 JSON 動作）。換個說法再試一次。', 'I could not read the AI\'s answer (it has to be JSON actions). Say it differently.');
            } catch (e5) { if (!edits.length) say = T('AI 這次沒有回應（', 'The AI did not answer (') + String((e5 && e5.message) || e5).slice(0, 80) + '）。'; }
            return { say, edits, notes };
        },

        // ───── 共用：外框要的 host、開啟、掛載、斜線指令、工具 ─────
        // 成品放進對話：下載卡片＋（圖片時）直接顯示＋整理好的 prompt
        async _edToChat(kind, blob, name, info) {
            info = info || {}; const K = KINDS[kind]; this.messages.push({ role: 'user', content: K.cmd + ' ' + T('輸出', 'export') });
            await this.generateAndDeliverFile(blob, name, blob.type || 'application/octet-stream');
            if (/\.3dscene\.yaml$/i.test(name) && this._ed3dToChatScene) { try { await this._ed3dToChatScene(null, await blob.text(), info.title); } catch (_) { /* the file card is there */ } }
            if (/^image\/(png|jpeg|webp)/.test(blob.type)) { try { const du = await FaEditStore.dataUrl(blob); const msg = { role: 'tool', content: '[' + K.label() + ' 的成品圖，已直接顯示給使用者看：' + String(info.title || name) + ']' }; Object.defineProperty(msg, '_displayDataUrl', { value: du, enumerable: false, configurable: true }); this.messages.push(msg); } catch (_) { /* 顯示不了就只有下載卡片 */ } }
            if (info.prompt) this._pushAssistantMessage('**' + T('成品', 'Result') + '：' + (info.title || name) + '**\n\n' + T('整理出來的 prompt（只收有效的那幾輪）：', 'The prompt that rebuilds it (only the steps that count):') + '\n\n```text\n' + info.prompt + '\n```', null);
            try { this._persistChatHistory(); this._renderMessageHistory(); } catch (_) { /* */ }
        },
        _edHost(kind, id, getSpecState) {
            const self = this, K = KINDS[kind], ai = this._edAi();
            const ask0 = kind === 'edit-svg' ? (req) => self._edAskSvg(req, { id }) : kind === 'edit-picture' ? (req) => self._edAskPicture(req, { id }) : (req) => K.ask.call(self, req, { id });
            const ask = (req) => self._edQuietRun((line) => { try { if (req && typeof req.onStatus === 'function') req.onStatus(line); } catch (_) { /* */ } }, () => ask0(req));
            return {
                palette: () => ({ dark: !self._isLightTheme() }),
                ask,
                save: async (state) => { const c = getSpecState(); let old = null; try { old = await FaEditStore.loadProject(kind, id); } catch (_) { /* a new project */ } return FaEditStore.saveProject(kind, id, Object.assign({}, old && old.origin ? { origin: old.origin } : {}, { v: 1, spec: c.spec, state })); },
                download: (blob, name, mime) => self.generateAndDeliverFile(blob, name, mime || blob.type),
                toChat: (blob, name, info) => self._edToChat(kind, blob, name, info),
                polish: (self.advancedSettings && self.advancedSettings.offlineMode) ? undefined : (async (text) => String(await ai.chat(K.polishSystem || ('You tidy a prompt that rebuilds ' + (kind === 'edit-svg' ? 'a drawing' : 'an edited picture') + '. Keep every fact (objects, colours, places, texts); make it one clear, reusable prompt. Answer with the prompt only.'), text, { maxTokens: 1200, timeoutMs: 90000 })).trim()),
            };
        },
        _edPush(kind, id, lead) {
            const K = KINDS[kind];
            this._pushAssistantMessage((lead || K.lead) + '\n\n```' + K.fence + '\n' + JSON.stringify({ id }) + '\n```', null);
            try { this._persistChatHistory(); this._renderMessageHistory(); } catch (_) { /* */ }
        },
        // 開一個編輯器（斜線指令與工具的入口）：o.id＝接著原本的專案；否則 starter／spec 開新的；request 開起來之後交給編輯器自己的 AI 去做；files＝[{name, dataUrl}] 當第一個（些）圖
        async _edOpen(kind, o) {
            o = o || {}; const K = KINDS[kind]; if (!K) return { ok: false, error: 'unknown editor ' + kind };
            const C = K.core(); let id = o.id ? String(o.id) : '';
            if (id) { const proj = await FaEditStore.loadProject(kind, id); if (!proj) return { ok: false, error: T('找不到這個專案：', 'no such project: ') + id }; this._edPush(kind, id, null); return { ok: true, id, note: 'the editor is in the conversation' }; }
            const spec = o.spec ? C.validate(typeof o.spec === 'string' ? (() => { try { return JSON.parse(o.spec); } catch (_) { return {}; } })() : o.spec).spec : ((o.starter && C.starter(String(o.starter))) || C.starter('blank'));
            id = FaEditStore.newId(K.prefix); await FaEditStore.saveProject(kind, id, Object.assign({ v: 1, spec, state: null }, o.origin ? { origin: o.origin } : {}));
            this._edFresh = this._edFresh || new Map(); this._edFresh.set(id, { request: String(o.request || '').trim(), style: String(o.style || '').trim(), images: o.images || [] });
            this._edPush(kind, id, null);
            return { ok: true, id, note: 'the ' + K.label() + ' is open in the conversation; the user works by talking to it. Do not paste the content into the conversation.' };
        },
        async _edMount(kind, id, holder) {
            const K = KINDS[kind], key = kind + ':' + id; let proj = null;
            try { proj = await FaEditStore.loadProject(kind, id); } catch (_) { /* 下面處理 */ }
            if (proj && K.prepare) { try { await K.prepare.call(this); } catch (e) { holder.textContent = '⚠️ ' + T('編輯器需要的函式庫載入失敗：', 'The libraries the editor needs could not be loaded: ') + String((e && e.message) || e).slice(0, 100); holder.style.opacity = '1'; this._edEditors.delete(key); return; } }
            if (!proj) { holder.textContent = '⚠️ ' + T('這個編輯器的專案不在這個瀏覽器裡（可能清掉了網站資料）— 請重新開一個。', 'The project of this editor is not in this browser (the site data may have been cleared) — open a new one.'); holder.style.opacity = '1'; this._edEditors.delete(key); return; }
            const fresh = this._edFresh && this._edFresh.get(id); if (fresh) this._edFresh.delete(id);
            const refs = K.collectRefs ? K.collectRefs(proj) : []; if (!K.collectRefs) { [proj.spec].concat(((proj.state && proj.state.states) || []).map((x) => x.spec)).forEach((sp) => { ((sp && sp.objects) || []).forEach((ob) => { if (ob.type === 'image' && ob.ref && refs.indexOf(ob.ref) < 0) refs.push(ob.ref); }); }); }
            await FaEditStore.preload(refs);
            let node = null; const self = this;
            const host = this._edHost(kind, id, () => { const st = node && node._ed ? node._ed.getState() : proj.state; const sp = st && st.states && st.states[st.ptr] ? st.states[st.ptr].spec : proj.spec; return { spec: sp, state: st }; });
            node = K.ui().mount(Object.assign({ id, state: proj.state, spec: proj.spec, host, restoring: !fresh, store: FaEditStore, onVectorize: (obj) => self._edVectorizeObject(node, obj) }, K.mountOpts ? K.mountOpts.call(this, id, proj) : {}));
            holder.textContent = ''; holder.style.cssText = ''; holder.appendChild(node); holder._ed = node._ed; holder._win = node._win;
            try { FaEditI18n.localize(node); } catch (_) { /* 英文介面只是方便 */ }
            if (fresh) {
                if (!proj.state) { try { await FaEditStore.saveProject(kind, id, Object.assign({}, proj.origin ? { origin: proj.origin } : {}, { v: 1, spec: proj.spec, state: node._ed.getState() })); } catch (_) { /* */ } }
                requestAnimationFrame(() => {
                    try { if (node._win && node._win.pop) node._win.pop(); } catch (_) { /* 留在對話裡也能用 */ }
                    try { if (fresh.images && fresh.images.length && node._ed.addImages) node._ed.addImages(fresh.images); const req = [fresh.style ? (kind === 'edit-picture' ? T('變成' + fresh.style + '風格', 'make it ' + fresh.style + ' style') : fresh.style) : '', fresh.request].filter(Boolean).join(' '); if (req || (fresh.images && fresh.images.length)) node._ed.send(req); } catch (_) { /* */ }
                });
            }
        },
        _mountEditEditors(mdDiv) {
            if (typeof FaEditShell === 'undefined' || !FaEditShell || !FaEditShell.mount) return; this._edEditors = this._edEditors || new Map();
            Object.keys(KINDS).forEach((kind) => {
                const K = KINDS[kind]; if (!K.ui || !K.fence) return;
                mdDiv.querySelectorAll('pre > code.language-' + K.fence).forEach((code) => {
                    let ref = null; try { ref = JSON.parse(code.textContent); } catch (_) { /* */ } if (!ref || !ref.id) return; const key = kind + ':' + ref.id; let el = this._edEditors.get(key);
                    if (!el) {
                        el = document.createElement('div'); el.textContent = T('載入編輯器…', 'Loading the editor…'); el.style.cssText = 'padding:8px;opacity:.7'; this._edEditors.set(key, el);
                        this._edMount(kind, ref.id, el).catch((e) => { el.textContent = '⚠️ ' + T('開啟失敗：', 'Could not open it: ') + String((e && e.message) || e); el.style.opacity = '1'; this._edEditors.delete(key); });
                        if (this._edEditors.size > 12) { const k0 = this._edEditors.keys().next().value; const old = this._edEditors.get(k0); try { if (old && old._ed) old._ed.destroy(); } catch (_) { /* */ } this._edEditors.delete(k0); }
                    }
                    code.parentElement.replaceWith(el);
                });
            });
        },
        // 斜線指令：不帶參數＝說明與起手式；起手式名稱＝從它開始；其他文字／網址＝開空白、交給編輯器自己的 AI
        async _edCommand(kind, argsText, run) {
            const r = run || this, K = KINDS[kind], a = String(argsText || '').trim(); r.messages.push({ role: 'user', content: K.cmd + (a ? ' ' + a : '') });
            try {
                const C = K.core(), starters = C.listStarters();
                if (!a) { r._pushAssistantMessage(K.help ? K.help(starters) : ('**' + K.label() + '**\n\n' + K.lead + '\n\n' + T('起手式：', 'Starters:') + '\n' + starters.map((s) => '- `' + K.cmd + ' ' + s.id + '` — ' + s.label + '：' + s.desc).join('\n')), null); }
                else { const st = starters.filter((s) => s.id === a.toLowerCase())[0]; const res = await r._edOpen(kind, st ? { starter: st.id } : { starter: 'blank', request: a }); if (res && res.ok === false) r._pushAssistantMessage('⚠️ ' + (res.error || T('開不起來', 'could not open it')), null); }
            } catch (e) { r._pushAssistantMessage('⚠️ ' + T('開不起來：', 'Could not open it: ') + String((e && e.message) || e), null); }
            try { r._persistChatHistory(); r._renderMessageHistory(); } catch (_) { /* */ }
        },
        _registerEditCommands() {
            const hint = '[起手式｜一句話描述｜圖片網址]';
            this.register_slash_command('/edit-svg', hint,
                'SVG 編輯器（用語言主導的概念畫家）：你說要畫什麼、放在哪個東西的哪一邊，AI 就加一個新物件；畫面沒有邊界，可以加在任何地方。可以貼圖讓 AI 描成 SVG、給網址或說「找一張…的圖」。物件欄、屬性面板、復原／重做、整理成 prompt、匯出 SVG／PNG。/edit-svg shapes 從起手式開始、/edit-svg 畫一隻紅色的小鳥站在樹枝上。',
                (argsText, run) => (run || this)._edCommand('edit-svg', argsText, run));
            this._registerEdit3dCommands && this._registerEdit3dCommands();
            this.register_slash_command('/edit-picture', hint,
                '圖片編輯器（圖層式、語言主導、像 GIMP 的後製與修復）：貼圖、給網址或說「找一張…的圖」就有第一個圖層；然後用說的：「變成水彩風格」（視覺模型會看像不像）、「調亮」、「修掉右下角的污點」、「在左邊加一隻貓」。濾鏡與修復都是圖層，原圖不動；「🩹 修復畫筆」可以直接塗；說「用 AI 重畫成油畫」會用生圖模型依內容重畫。匯出 PNG／JPEG。',
                (argsText, run) => (run || this)._edCommand('edit-picture', argsText, run));
        },
        _registerEditTools(registerOptional) {
            const parse = async (self, raw) => { let a = {}; try { a = await self.repairJsonPayload(String(raw || '{}')); } catch (_) { /* */ } return a || {}; };
            const filesOf = async (self, a) => { const out = []; const ids = [].concat(a.file_id || [], a.file_ids || []).filter(Boolean).slice(0, 3); for (const fid of ids) { try { const rec = await self.fileCache.get(String(fid)); if (rec && rec.blob && /^image\//.test(rec.blob.type || '')) out.push({ name: rec.filename || 'picture', dataUrl: await FaEditStore.dataUrl(rec.blob) }); } catch (_) { /* 少一張而已 */ } } return out; };
            registerOptional('edit_svg_open',
                '在對話裡放一個「SVG 編輯器」（用語言主導的概念畫家）：一堆物件在沒有邊界的平面上，使用者說要畫什麼、放在哪個東西的哪一邊，編輯器自己的 AI 就加一個物件；可貼圖描成 SVG、給網址、找圖；有物件欄、屬性面板、復原／重做、整理成 prompt、匯出 SVG／PNG。參數：starter（blank、shapes、flow）、request（一句話：開起來後編輯器自己的 AI 去做）、file_id（使用者附的圖片，當作第一個要描的圖）、id（接著原本的專案）。做完編輯器就在對話裡，不要把 SVG 貼到對話。參數: {"starter":"blank","request":"（選填）","file_id":"（選填）","id":"（選填）"}',
                async function (rawArgs) { const a = await parse(this, rawArgs); try { return JSON.stringify(await this._edOpen('edit-svg', { starter: a.starter, request: a.request, spec: a.spec, id: a.id, images: await filesOf(this, a) })); } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); } },
                { type: 'object', properties: { starter: { type: 'string', description: '起手式：blank、shapes、flow' }, request: { type: 'string', description: '一句話要畫什麼' }, file_id: { type: 'string', description: '使用者附的圖片（會當第一個要描成 SVG 的圖）' }, id: { type: 'string', description: '接著原本的專案' } }, additionalProperties: false }
            );
            if (this._registerEdit3dTools) this._registerEdit3dTools(registerOptional);
            registerOptional('edit_picture_open',
                '在對話裡放一個「圖片編輯器」（圖層式、語言主導、像 GIMP 的後製與修復）：圖片、形狀、濾鏡層、修復層疊在沒有邊界的平面上；使用者用說的改（變成水彩風格、調亮、修掉右下角的污點、在左邊加一隻貓、找一張飛機的照片、用 AI 重畫成油畫），濾鏡與修復都是圖層，原圖不動。參數：starter（blank、poster）、request（一句話：開起來後編輯器自己的 AI 去做）、style（先套用的風格：oil、watercolor、sketch、ink、cartoon、pixel、poster、vintage、neon…）、file_id（使用者附的圖片，當作第一個圖層）、id。做完編輯器就在對話裡，不要自己處理圖片。參數: {"starter":"blank","request":"（選填）","style":"watercolor","file_id":"（選填）","id":"（選填）"}',
                async function (rawArgs) { const a = await parse(this, rawArgs); try { return JSON.stringify(await this._edOpen('edit-picture', { starter: a.starter, request: a.request, style: a.style, spec: a.spec, id: a.id, images: await filesOf(this, a) })); } catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); } },
                { type: 'object', properties: { starter: { type: 'string', description: '起手式：blank、poster' }, request: { type: 'string', description: '一句話要怎麼處理或畫什麼' }, style: { type: 'string', description: '先套用的風格' }, file_id: { type: 'string', description: '使用者附的圖片（第一個圖層）' }, id: { type: 'string', description: '接著原本的專案' } }, additionalProperties: false }
            );
        },
    };
    return { methods, KINDS, register, T, zh };
})();
