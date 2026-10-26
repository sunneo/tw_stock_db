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
    const str0 = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
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
                async chat(system, user, o) { o = o || {}; const refB = self._edQuiet && self._edQuiet.ref; if (refB) user = String(user) + String.fromCharCode(10, 10) + refB; return String(await self._kiLlm(user, { systemPrompt: system || '', maxTokens: o.maxTokens || 8000, temperature: o.temperature == null ? 0.2 : o.temperature }, { timeoutMs: o.timeoutMs || 180000, label: o.label || 'AI', onStep: stepOf() })); },
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
        // ───── 成功案例 → 離線訓練器的知識（設計見 DESIGN.edit-cases.md）：做出好結果 → 存成訓練器的案例 → 下次相似的需求拿來參考（強模型）或直接當起點（弱模型／離線） ─────
        // 案例是訓練器領域 editor_cases 裡的一個 semantic pattern（範例語句、意圖、參考 prompt、開編輯器的工具與參數樣板）：用訓練器自己的語意比對與同義詞、在訓練器裡看得到／可以停用／可以刪。
        // 成品（大）不放訓練器的記憶體：存在獨立的資料表（FloatingAssistantEditCases/body），用到才讀；訓練器裡只有小小的 pattern，所以不吃記憶體、也不進對話上下文。
        _edCasesOn() { return typeof FaEditCases !== 'undefined' && typeof this._otLoad === 'function' && !(this.advancedSettings && this.advancedSettings.editorCasesOff === true); },
        _edCasesDb() {
            if (this._edCasesDbP) return this._edCasesDbP;
            this._edCasesDbP = new Promise((resolve, reject) => { const rq = indexedDB.open('FloatingAssistantEditCases', 2); rq.onupgradeneeded = () => { const db = rq.result; if (db.objectStoreNames.contains('meta')) db.deleteObjectStore('meta'); if (!db.objectStoreNames.contains('body')) db.createObjectStore('body', { keyPath: 'id' }); }; rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error); });
            this._edCasesDbP.catch(() => { this._edCasesDbP = null; }); return this._edCasesDbP;
        },
        async _edCasesTx(mode, fn) { const db = await this._edCasesDb(); return new Promise((resolve, reject) => { const tx = db.transaction(['body'], mode); let out; Promise.resolve(fn(tx.objectStore('body'))).then((v) => { out = v; }, reject); tx.oncomplete = () => resolve(out); tx.onerror = tx.onabort = () => reject(tx.error); }); },
        _edReq(rq) { return new Promise((resolve, reject) => { rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error); }); },
        async _edCaseDomain(create) { const st = await this._otLoad(); let dom = st.domains.get(FaEditCases.DOMAIN); if (!dom && create) { dom = { name: FaEditCases.DOMAIN, description: '編輯器的成功案例（在編輯器裡做出好結果，按「⭐ 存成案例」或匯出時自動存；下次相似的需求會拿來參考，弱模型與離線時直接當起點）', enabled: true, source: 'editor', patterns: [], tools: [], states: { initial: null, states: {} } }; } return dom || null; },
        // 目前所有案例（訓練器裡的 pattern）；順便清掉「pattern 已經被刪（例如在訓練器裡刪掉）但成品還留著」的孤兒
        async _edCaseList() { const dom = await this._edCaseDomain(false); return dom ? dom.patterns.filter(FaEditCases.isCase) : []; },
        async _edCasesGc() {
            if (this._edCasesGcDone) return; this._edCasesGcDone = true; try { const live = new Set((await this._edCaseList()).map((p) => p.id)); const ids = await this._edCasesTx('readonly', (os) => this._edReq(os.getAllKeys())); const orphan = ids.filter((id) => !live.has(id)); if (orphan.length) await this._edCasesTx('readwrite', (os) => { orphan.forEach((id) => os.delete(id)); }); } catch (_) { /* 下次再清 */ }
        },
        // 存一個案例：info＝{ spec, prompt, title, requests }；opt.auto＝自動存的（排序略低、最先被淘汰）。相似度很高的舊案例直接更新，不重複存
        async _edCaseSave(kind, info, opt) {
            opt = opt || {}; if (!this._edCasesOn()) return { ok: false, error: '案例庫關閉了（Advance Settings 的 editorCasesOff）' };
            const ent = FaEditCases.makeEntry({ kind, title: info.title, prompt: info.prompt, requests: info.requests, spec: info.spec, auto: !!opt.auto }); if (ent.error) return { ok: false, error: ent.error };
            const dom = await this._edCaseDomain(true), p = ent.pattern, same = this._edCaseHits(kind, p.examples.join('。'), 1, 0.94)[0];
            if (same) { if (opt.auto && !same.p.stats.auto) return { ok: true, kept: same.p.stats.title, duplicate: true }; p.id = same.p.id; ent.body.id = same.p.id; p.stats.uses = same.p.stats.uses || 0; p.hits = same.p.hits || 0; p.stats.auto = same.p.stats.auto && !!opt.auto; }
            dom.patterns = dom.patterns.filter((x) => x.id !== p.id).concat([p]); await this._otSaveDomain(dom); await this._otSyncPatternExamples(dom, p);
            await this._edCasesTx('readwrite', (os) => { os.put(ent.body); });
            try { const drop = FaEditCases.evictPlan(await this._edCaseList()); if (drop.length) await this._edCaseDelete(drop); } catch (_) { /* 淘汰失敗下次再說 */ }
            return { ok: true, id: p.id, title: p.stats.title, updated: !!same };
        },
        async _edCaseDelete(ids) { const dom = await this._edCaseDomain(false); if (!dom) return 0; const set = new Set(ids); dom.patterns = dom.patterns.filter((p) => !set.has(p.id)); await this._otSaveDomain(dom); for (const id of ids) { await this._otVecDelete('ot_examples', (eid) => eid.indexOf(dom.name + '/' + id + '#') === 0); } await this._edCasesTx('readwrite', (os) => { ids.forEach((id) => os.delete(id)); }); return ids.length; },
        // 用訓練器的語意比對找案例（只看領域 editor_cases、同一種編輯器）
        _edCaseHits(kind, text, top, minSim) {
            const st = this._ot; if (!st || !st.loaded) return []; const dom = st.domains.get(FaEditCases.DOMAIN); if (!dom || !dom.patterns.length) return [];
            const byId = new Map(dom.patterns.map((p) => [p.id, p])), raw = this._otVecQuery('ot_examples', text, 12, (m) => m && m.domain === FaEditCases.DOMAIN);
            const cand = raw.map((h) => ({ p: byId.get(h.meta.pattern), sim: h.sim })), seen = new Set(cand.map((x) => x.p && x.p.id));
            dom.patterns.forEach((p) => { if (FaEditCases.isCase(p) && !seen.has(p.id) && p.stats.title && String(text).indexOf(p.stats.title) >= 0) cand.push({ p, sim: 0 }); });   // 標題直接出現在這句話裡：就算語意比對沒排進前面也算候選
            return FaEditCases.rank(cand, kind, { top: top || 2, minSim, text });
        },
        // 平常的對話（不在編輯器裡）：這句話跟某個成功案例很像 → 在這一輪的提示裡多一小段「有這個案例，可以直接用」。同步的（只用已經載入的訓練器），沒有相似的案例就什麼都不加。
        _edCaseTaskHint(text) {
            try {
                if (!this._edCasesOn() || !this._ot || !this._ot.loaded) return ''; text = String(text || '').replace(/\[附件：[^\]]*\]/g, ' ').trim(); if (text.length < 4 || text.length > 600) return '';
                let best = null; FaEditCases.KINDS.forEach((k) => { const h = this._edCaseHits(k, text, 1, 0.6)[0]; if (h && (!best || h.score > best.score)) best = Object.assign({ kind: k }, h); }); if (!best) return '';
                const tool = FaEditCases.TOOL_OF[best.kind], label = { 'edit-svg': 'SVG 編輯器', 'edit-picture': '圖片編輯器', 'edit-3d': '3D 場景編輯器', 'edit-media-presentation': '簡報編輯器', 'edit-game-2d': '2D 遊戲編輯器', 'edit-game-3d': '3D 遊戲編輯器' }[best.kind], offline = !!(this.advancedSettings && this.advancedSettings.offlineMode), budget = Math.max(300, Math.min(1200, Math.round(this._kiBudgetChars(offline) * 0.1)));
                const how = str0(best.p.description, Math.max(120, budget - 260)), use = tool ? '用法：這句話跟這個案例很像——直接呼叫 ' + tool + '（request 給上面這段做法），會用這個案例當起點，不用從頭畫；也可以照這個做法自己畫。' : '用法：這句話跟這個案例很像——請使用者輸入 /' + best.kind + ' 後面接這句話（會用這個案例當起點），或照這個做法自己做。';
                return '【你之前存的成功案例（相似度 ' + Math.round(best.sim * 100) / 100 + '）：' + best.p.stats.title + '（' + label + '）】' + String.fromCharCode(10) + '當時有效的做法：' + how + String.fromCharCode(10) + use;
            } catch (_) { return ''; }
        },
        // 這次的需求有沒有相似的成功案例？回傳 { title, sim, block（給模型的小段參考）, replay（弱模型／離線：程式直接放進去的結果） } 或 null
        async _edCaseFor(kind, req) {
            if (!this._edCasesOn() || !req) return null; const text = String(req.text || '').trim(); if (text.length < 4) return null;
            await this._otLoad(); this._edCasesGc(); const hit = this._edCaseHits(kind, text, 1)[0]; if (!hit) return null;
            const body = await this._edCasesTx('readonly', (os) => this._edReq(os.get(hit.p.id))); if (!body) return null;
            hit.p.stats.uses = (hit.p.stats.uses || 0) + 1; hit.p.hits = (hit.p.hits || 0) + 1; hit.p.stats.lastUsed = Date.now(); this._edCaseDomain(false).then((dom) => dom && this._otSaveDomain(dom)).catch(() => { /* 用過幾次只是加分 */ });
            const offline = !!(this.advancedSettings && this.advancedSettings.offlineMode), weak = offline || (this.advancedSettings && this.advancedSettings.editorCasesWeak === true), budget = Math.max(300, Math.min(1500, Math.round(this._kiBudgetChars(offline) * 0.12))), title = hit.p.stats.title;
            const nObj = req.spec && Array.isArray(req.spec.objects) ? req.spec.objects.length : 0, out = { title, sim: hit.sim, block: FaEditCases.refBlock(body, title, hit.sim, budget) };
            if (FaEditCases.shouldReplay(nObj, hit.sim, weak, !!req.fresh)) { const edits = FaEditCases.replayEdits(kind, body.spec, { deckToDoc: typeof FaDeckEdit !== 'undefined' ? FaDeckEdit.toDoc : null }); if (edits) out.replay = { say: T('用你之前存的案例「' + title + '」當起點（相似度 ' + Math.round(hit.sim * 100) + '%），可以再用說的調整。', 'Started from your saved case "' + title + '" (' + Math.round(hit.sim * 100) + '% alike); keep talking to adjust it.'), edits, notes: [T('案例不經過模型，直接放進去', 'the case is placed by the program, not the model')] }; }
            return out;
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
        // ───── /edit-picture 的擴散細化（只重畫一小塊再羽化蓋回去；設計見 DESIGN.edit-picture-diffusion.md）─────
        // 兩條路:① 線上有能改圖的模型（NVIDIA FLUX.1 Kontext）→ 把這一小塊（含四周多裁的脈絡）當輸入、依原圖重畫細節（refine=edit）；
        // ② 只有本機 SDXS → 它沒有 VAE 編碼器、一步取樣沒有「強度」，不能依原圖重畫；改成用提示詞重畫一張，只借它的細節紋理加到原圖上（refine=texture，實驗性）。
        async _edDiffusionState() {
            const enabled = !!(this.advancedSettings && this.advancedSettings.editDiffusion === true); let online = false, local = false;
            try { const cfg = this._imageGenConfig(); online = !!(cfg && cfg.apiKey) && !!FaNvidiaImage.editModel(); } catch (_) { /* 沒有金鑰 */ }
            try { for (const mid of ['sdxs-512-webgpu', 'sdxs-512-cpu-int8']) { const m = FaLocalSd.byId(mid); if (m && (await this._localSdFileState(m)).every((x) => x.ok)) { local = true; break; } } } catch (_) { /* 沒下載 */ }
            const reason = !enabled ? T('先勾選「啟用擴散編修」', 'Tick "Enable diffusion editing" first') : (!online && !local ? T('沒有可用的生圖模型：要有 NVIDIA 金鑰（線上，能改圖），或先下載本機模型（/image download）', 'No image model is available: an NVIDIA key (online, can edit a picture) or the local model (/image download)') : '');
            return { enabled, online, local, ready: enabled && (online || local), reason };
        },
        _edDiffusionSet(on) { this.advancedSettings.editDiffusion = !!on; try { this._saveAdvancedSettings(); } catch (_) { /* 只是存設定 */ } return this._edDiffusionState(); },
        async _edDetail(req) {
            req = req || {}; const C = FaEditPicture, PD = FaPicDetail, status = typeof req.onStatus === 'function' ? req.onStatus : () => {}, spec = C.validate(req.spec).spec;
            const idx = spec.objects.findIndex((o) => o.id === req.id && o.type === 'detail'); if (idx < 0) return { ok: false, error: T('找不到這個細化層', 'that detail layer is gone') };
            const L = spec.objects[idx], st = await this._edDiffusionState();
            if (!st.enabled) return { ok: false, error: T('還沒啟用擴散編修：勾選畫面上的「啟用擴散編修」。', 'Diffusion editing is not enabled: tick "Enable diffusion editing".') };
            const mode = L.model === 'online' ? (st.online ? 'edit' : null) : L.model === 'local' ? (st.local ? 'texture' : null) : (st.online ? 'edit' : (st.local ? 'texture' : null));
            if (!mode) return { ok: false, error: L.model === 'online' ? T('線上改圖要有 NVIDIA 金鑰（進階設定 → 圖像生成）。', 'Online editing needs an NVIDIA key (Advanced settings → image generation).') : L.model === 'local' ? T('本機模型還沒下載：先輸入 /image download（只下載一次）。', 'The local model is not downloaded: type /image download (once).') : (st.reason || T('沒有可用的生圖模型：要有 NVIDIA 金鑰（線上，能改圖），或先下載本機模型（/image download）', 'No image model is available: an NVIDIA key (online, can edit a picture) or the local model (/image download)')) };
            const region = L.region || PD.regionOfMarks(L.marks, 0), tgt = L.target !== 'all' ? spec.objects.filter((o) => o.id === L.target)[0] : null, bounds = tgt ? C.types[tgt.type].bbox(tgt) : (C.bounds(spec) || spec.canvas);
            const plan = PD.plan(region, bounds, { context: L.context, target: mode === 'edit' ? 1024 : 512, feather: L.feather }); if (!plan.ok) return { ok: false, error: plan.error };
            status(T('把下面的圖層合成起來…', 'Putting the layers below together…'));
            const under = Object.assign({}, spec, { objects: spec.objects.slice(0, idx) }), rr = await FaEditPictureUI.render(under, { store: FaEditStore, resolve: (ref) => FaEditStore.imageUrl(ref), maxSide: 4096 }); if (!rr) return { ok: false, error: T('合成失敗', 'could not put the picture together') };
            const cb = plan.crop, sc = rr.scale, cvs = document.createElement('canvas'); cvs.width = plan.out.w; cvs.height = plan.out.h; const g = cvs.getContext('2d'); g.imageSmoothingQuality = 'high';
            g.drawImage(rr.canvas, (cb.x - rr.region.x) * sc, (cb.y - rr.region.y) * sc, cb.w * sc, cb.h * sc, 0, 0, cvs.width, cvs.height);
            const seed = L.seed != null ? L.seed : (Math.floor(Math.random() * 4294967296) >>> 0), A = this._edAi(); let desc = '', user = L.prompt;
            if (A.have()) { try { status(T('視覺模型看這一小塊…', 'The vision model looks at this part…')); desc = (await A.vision(cvs.toDataURL('image/jpeg', 0.85), 'In one short English sentence, say what is in the middle of this picture (subject, material, colours). Only what you can see.')).trim().replace(/\s+/g, ' ').slice(0, 200); } catch (_) { /* 沒有也行 */ } }
            if (user && /[一-鿿]/.test(user) && A.have()) { try { user = (await A.chat('Translate to short English image keywords. Output only the translation.', user)).trim().slice(0, 200); } catch (_) { /* 用原文 */ } }
            const focus = [/[一-鿿]/.test(user || '') ? '' : user, desc].filter(Boolean).join(', '); let res, note = '';
            if (mode === 'edit') {
                status(T('線上模型依原圖補細節…（要等一下）', 'The online model adds detail to the picture… (this takes a moment)'));
                res = await this._edGenerate({ provider: 'online', model: FaNvidiaImage.editModel(), prompt: ('Add fine, realistic detail and sharpness to this picture. Keep the composition, the colours and every shape in place.' + (focus ? ' Focus: ' + focus : '')).slice(0, 900), init_image: cvs.toDataURL('image/png'), seed, steps: Math.round(10 + L.strength * 30) }, status);
            } else {
                status(T('本機小模型重畫細節紋理…（CPU 版要等一下）', 'The local model draws the detail texture… (the CPU version takes a while)'));
                res = await this._edGenerate({ provider: 'local', prompt: ((focus || 'detailed texture') + ', highly detailed, sharp focus, intricate texture').slice(0, 600), seed }, status);
                note = T('本機小模型沒有 VAE 編碼器、不能依原圖重畫，所以只借它重畫出來的細節紋理蓋在原圖上（實驗性，效果因圖而異；不滿意可以重畫或退回）。', 'The local model has no VAE encoder and cannot redraw from the picture, so only the detail texture it draws is laid over the picture (experimental; redraw or revert if it is not good).');
            }
            if (!res.ok) return { ok: false, error: res.needs_download ? T('本機生圖模型還沒下載：先輸入 /image download（只下載一次）', 'The local image model is not downloaded: type /image download first (once)') : String(res.error || 'no image') };
            const k = await this._edPics('edit-picture').keep(res.image.blob);
            return { ok: true, mode, note, props: { result: k.ref, crop: plan.crop, refine: mode, seed, state: 'preview' } };
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
            if (C.detailIntent(text) && !fr.handled && !edits.length) {
                const stD = await this._edDiffusionState();
                if (!stD.enabled) return { say: T('擴散細化還沒啟用：勾選畫面上的「啟用擴散編修」再說一次（它只重畫你指的那一小塊細節，再羽化蓋回去，原圖不動）。', 'Diffusion detail is not enabled: tick "Enable diffusion editing" and say it again (it redraws only the part you mean and blends it back; the picture stays as it is).'), edits, notes };
                const AT_WORDS = [[/左上/, 'top-left'], [/右上/, 'top-right'], [/左下/, 'bottom-left'], [/右下/, 'bottom-right'], [/(上方|上面|上半|頂)/, 'top'], [/(下方|下面|下半|底)/, 'bottom'], [/左(邊|側)?/, 'left'], [/右(邊|側)?/, 'right']], hit = AT_WORDS.filter((x) => x[0].test(text))[0], at = hit ? hit[1] : 'center';
                const ad = C.applyEdits(cur(), [{ op: 'add_detail', at, prompt: text.replace(/(把|請|幫我|幫忙)/g, '').replace(/(細化|加細節|多一點細節|更多細節|補細節|更精細|精細一點)/g, '').trim() }], { selection: sel });
                if (ad.rejected.length) { notes.push(ad.rejected[0].error); return { say: T('沒辦法加細化層：', 'Could not add a detail layer: ') + ad.rejected[0].error, edits, notes }; }
                ad.appliedEdits.forEach((e) => edits.push(e)); const s2 = cur(), layer = s2.objects[s2.objects.length - 1];
                const rs = await this._edDetail({ spec: s2, id: layer.id, onStatus: status });
                if (rs.ok) { edits.push({ op: 'update_object', id: layer.id, props: rs.props }); if (rs.note) notes.push(rs.note); notes.push(T('區域：' + (hit ? '依你說的位置' : '圖片中央（沒說位置；要精確請按「✨ 擴散細化」在畫面上框選）'), 'Region: ' + (hit ? 'where you said' : 'the middle of the picture (no place said; use "✨ Diffusion detail" to box the part exactly)'))); return { say: T('細化好了（預覽中）：滿意就按「接受」，不滿意可以重畫或退回。', 'Refined (preview): accept it, redraw or revert.'), edits, notes }; }
                notes.push(rs.error); return { say: T('加了一個細化層，但生成沒成功：', 'Added a detail layer, but the drawing did not work: ') + rs.error, edits, notes };
            }
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
                        else if (e.op === 'generate_detail') { /* 下面統一處理待細化的層 */ }
                        else edits.push(e);
                    }
                    if (pr.say) say = say ? say + '；' + pr.say : pr.say; if (pr.dropped) notes.push(T('有 ' + pr.dropped + ' 個動作不在可做的清單裡，已略過', pr.dropped + ' actions were not in the allowed list and were skipped'));
                } else if (!edits.length) say = T('AI 的回覆我讀不懂（要是 JSON 動作）。換個說法再試一次。', 'I could not read the AI\'s answer (it has to be JSON actions). Say it differently.');
                for (let guard = 0; guard < 3; guard++) {
                    const sf = cur(), pend = sf.objects.filter((o) => o.type === 'detail' && !o.result && o.state === 'pending')[0]; if (!pend) break;
                    const rs = await this._edDetail({ spec: sf, id: pend.id, onStatus: status });
                    if (rs.ok) { edits.push({ op: 'update_object', id: pend.id, props: rs.props }); if (rs.note) notes.push(rs.note); say = say || T('細化好了（預覽中）：滿意就按「接受」，不滿意可以重畫或退回。', 'Refined (preview): accept it, redraw or revert.'); }
                    else { notes.push(rs.error); break; }
                }
            } catch (e5) { if (!edits.length) say = T('AI 這次沒有回應（', 'The AI did not answer (') + String((e5 && e5.message) || e5).slice(0, 80) + '）。'; }
            return { say, edits, notes };
        },


        // ───── 不認識的東西，先去查（設計見 DESIGN.subject-research.md）─────
        // 「放一個盤子、把雞翅放到盤子」→ 模型不知道雞翅長怎樣就放了兩個圓錐。做法：先問模型這句話裡有哪些東西它不確定 → 上網查外形描述（維基百科）→ 模型整理成「由哪幾塊基本形狀組成」→ 存起來 → 給編輯器的模型一小段參考。
        // 網路或模型不通、離線模式、查不到：什麼都不加，不影響原本的編輯。
        _subjOn() { return typeof FaSubjectResearch !== 'undefined' && !(this.advancedSettings && (this.advancedSettings.subjectResearchOff === true || this.advancedSettings.offlineMode)); },
        _subjDb() {
            if (this._subjDbP) return this._subjDbP;
            this._subjDbP = new Promise((resolve, reject) => { const rq = indexedDB.open('FloatingAssistantSubjects', 1); rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains('brief')) rq.result.createObjectStore('brief', { keyPath: 'key' }); }; rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error); });
            this._subjDbP.catch(() => { this._subjDbP = null; }); return this._subjDbP;
        },
        async _subjTx(mode, fn) { const db = await this._subjDb(); return new Promise((resolve, reject) => { const tx = db.transaction(['brief'], mode); let out; Promise.resolve(fn(tx.objectStore('brief'))).then((v) => { out = v; }, reject); tx.oncomplete = () => resolve(out); tx.onerror = tx.onabort = () => reject(tx.error); }); },
        // 查一個地方的網址（直接連線，不行再走程式的網路轉接）
        async _subjGetJson(url) {
            let e1 = null; try { const r = await fetch(url, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } catch (e) { e1 = e; }
            try { const { resp } = await this._terminalHttpFetch('GET', url, { headers: { Accept: 'application/json' }, timeoutMs: 20000 }); if (!resp.ok) throw new Error('HTTP ' + resp.status); return await resp.json(); } catch (e2) { throw new Error(String((e2 && e2.message) || e2) + (e1 ? '（直接連線：' + String(e1.message || e1) + '）' : '')); }
        },

        // ───── 2D（SVG、畫圖）多兩階：先找現成的 SVG（維基共享資源）→ 沒有描述時，找一張參考圖請視覺模型整理成部位 ─────
        async _subjGetText(url) {
            let e1 = null; try { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); } catch (e) { e1 = e; }
            try { const { resp } = await this._terminalHttpFetch('GET', url, { timeoutMs: 25000 }); if (!resp.ok) throw new Error('HTTP ' + resp.status); return await resp.text(); } catch (e2) { throw new Error(String((e2 && e2.message) || e2) + (e1 ? '（直接連線：' + String(e1.message || e1) + '）' : '')); }
        },
        async _subjSvgAsset(subject) {
            const R = FaSubjectResearch;
            for (const q of [subject.en, subject.name]) {
                if (!q) continue; let j = null; try { j = await this._subjGetJson(R.svgSearchUrl(q)); } catch (_) { continue; }
                const pick = R.pickSvg(j, subject); if (!pick) continue; let text = ''; try { text = await this._subjGetText(pick.url); } catch (_) { continue; }
                const svg = R.sanitizeSvg(text); if (svg) return { pick, svg };
            }
            return null;
        },
        async _subjImageBrief(subject, kind) {
            const R = FaSubjectResearch, ai = this._edAi(); if (!ai.have()) return null;
            const ps = FaPictureSource.make({ fetch: this._edFetchFn(), timeoutMs: 20000 }); let sr = null; try { sr = await ps.search(subject.en || subject.name, { limit: 6 }); } catch (_) { return null; }
            if (!sr || !sr.ok || !sr.results || !sr.results.length) return null;
            for (const r of sr.results.slice(0, 3)) {
                try { const { blob } = await ps.load(r), du = await FaEditStore.dataUrl(blob), brief = R.parseBrief(await ai.vision(du, R.imageBriefPrompt(subject, kind)), subject, 'image'); if (brief) { brief.page = r.title; brief.credit = [r.creator, r.license].filter(Boolean).join(' / '); return brief; } } catch (_) { /* 這張不行就換下一張 */ }
            }
            return null;
        },


        // ───── 用瀏覽器控制（使用者的 Chrome，要在設定開啟並裝好擴充功能）搜尋：GitHub 程式碼搜尋（要登入 GitHub）、Google 圖片、imgur。沒開、沒連上、沒登入都不是錯誤，往下一個來源 ─────
        async _subjBcReady() {
            if (!(this.advancedSettings && this.advancedSettings.browserControlEnabled)) return false;
            if (this._subjBcOk && Date.now() - this._subjBcOk.at < 30000) return this._subjBcOk.ok;
            let ok = false; try { const r = await this._bcCall('ping', {}, 4000); ok = !!(r && r.ok && r.allowed !== false); } catch (_) { ok = false; }
            this._subjBcOk = { at: Date.now(), ok }; return ok;
        },
        // 開一個背景分頁（不搶畫面）、等頁面準備好（抽取腳本回 ready:true）、取結果、關掉分頁
        async _subjBcRead(url, js, timeoutMs) {
            const created = await this._bcCall('tab_create', { url, active: false }, 20000); if (!created || !created.ok) return null;
            const tabId = created.tab_id, t0 = Date.now(); let last = null;
            try {
                while (Date.now() - t0 < (timeoutMs || 25000)) {
                    await new Promise((r) => setTimeout(r, 1200));
                    const r = await this._bcCall('tab_eval', { tab_id: tabId, js, timeout_ms: 8000 }, 11000);
                    if (r && r.ok) { let v = r.value; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { /* 照原樣 */ } } last = v; if (v && v.ready) return v; }
                }
                return last;
            } finally { try { await this._bcCall('tab_close', { tab_id: tabId }, 8000); } catch (_) { /* 擴充功能回合結束會自己關 */ } }
        },
        async _subjObjViaBc(subject) {
            if (!(await this._subjBcReady())) return null; const M = FaSubject3d;
            const v = await this._subjBcRead(M.githubCodeSearchUrl(subject), M.GH_EXTRACT_JS, 22000), ph = M.parseCodeHits(v, subject);
            if (ph.login) { this._subjLoginHint = true; return null; }   // GitHub 的程式碼搜尋要登入：請使用者在 Chrome 登入，這次改用公開專案搜尋
            for (const h of ph.hits.slice(0, 4)) {
                let text = ''; try { text = await this._subjGetText(h.raw); } catch (_) { continue; } if (text.length > M.LIM.objBytes + 1024) continue;
                const parsed = M.parseObj(text); if (!parsed.ok) continue;
                return { mesh: parsed.mesh, repo: h.full, path: h.path, license: 'none', faces: parsed.faces, originalFaces: parsed.original.faces, via: 'browser' };
            }
            return null;
        },
        // ───── 3D 第一階：GitHub 公開專案裡找現成的 OBJ（使用者定的順序：有 OBJ 就不用再查描述）─────
        async _subjObjAsset(subject) {
            const M = FaSubject3d; if (!subject.en) return null;
            try { const viaBc = await this._subjObjViaBc(subject); if (viaBc) return viaBc; } catch (_) { /* 瀏覽器控制不通：用公開專案搜尋 */ }
            let repos = []; try { repos = M.pickRepos(await this._subjGetJson(M.repoSearchUrl(subject)), subject); } catch (_) { return null; }   // 沒網路或超過 GitHub 的次數限制：往下一階
            for (const repo of repos.slice(0, M.LIM.trees)) {
                let pick = null; try { pick = M.pickObj(await this._subjGetJson(M.treeUrl(repo)), subject, repo); } catch (_) { continue; } if (!pick) continue;
                let text = ''; try { text = await this._subjGetText(M.rawUrl(repo, pick.path)); } catch (_) { continue; } if (text.length > M.LIM.objBytes + 1024) continue;
                const parsed = M.parseObj(text); if (!parsed.ok) continue;
                return { mesh: parsed.mesh, repo: repo.full, path: pick.path, license: repo.license, faces: parsed.faces, originalFaces: parsed.original.faces };
            }
            return null;
        },

        // ───── 3D 第三階：找一張圖 → 切掉背景 → 現有的圖片分解（2.5D 充氣）→ 帶貼圖的自訂形狀。全部只放記憶體，不存成檔案 ─────
        // 圖片來源：維基共享資源與 Openverse（免金鑰）；有填 imgurClientId 就加 imgur；有填 googleSearchKey＋googleSearchCx 就加 Google 圖片（兩者都要使用者自己的金鑰）
        async _subjImageCandidates(subject) {
            const q = subject.en || subject.name, out = [], adv = this.advancedSettings || {}, M = FaSubject3d; let bcOk = false;
            try { bcOk = await this._subjBcReady(); } catch (_) { bcOk = false; }
            if (bcOk) { try { const v = await this._subjBcRead(M.googleImagesUrl(subject), M.GOOGLE_EXTRACT_JS, 22000); M.parseImageList(v, 'google').forEach((c) => out.push(c)); } catch (_) { /* 下一個來源 */ } }
            try { const ps = FaPictureSource.make({ fetch: this._edFetchFn(), timeoutMs: 20000 }), sr = await ps.search(q, { limit: 8 }); if (sr && sr.ok) (sr.results || []).forEach((r) => out.push({ ref: r, title: r.title, source: r.source, license: r.license || '', creator: r.creator || '' })); } catch (_) { /* 這個來源不通就看下一個 */ }
            if (bcOk) { try { const v = await this._subjBcRead(M.imgurSearchUrl(subject), M.IMGUR_EXTRACT_JS, 22000); M.imgurLarge(M.parseImageList(v, 'imgur')).forEach((c) => out.push(c)); } catch (_) { /* 下一個來源 */ } }
            if (!bcOk && adv.imgurClientId) { try { const r = await fetch('https://api.imgur.com/3/gallery/search/top/all/1?q=' + encodeURIComponent(q + ' ext:png'), { headers: { Authorization: 'Client-ID ' + adv.imgurClientId } }); if (r.ok) { const j = await r.json(); (j.data || []).forEach((g) => { const im = (g.images && g.images[0]) || g; if (im && im.link && /\.(png|jpe?g|webp)$/i.test(im.link) && !im.animated) out.push({ ref: im.link, title: g.title || q, source: 'imgur', license: '', creator: g.account_url || '' }); }); } } catch (_) { /* */ } }
            if (!bcOk && adv.googleSearchKey && adv.googleSearchCx) { try { const r = await fetch('https://www.googleapis.com/customsearch/v1?searchType=image&num=8&imgType=clipart&key=' + encodeURIComponent(adv.googleSearchKey) + '&cx=' + encodeURIComponent(adv.googleSearchCx) + '&q=' + encodeURIComponent(q)); if (r.ok) { const j = await r.json(); (j.items || []).forEach((it) => { if (it.link) out.push({ ref: it.link, title: it.title || q, source: 'google', license: '', creator: (it.displayLink || '') }); }); } } catch (_) { /* */ } }
            return out;
        },
        // 圖片的位元組 → 縮到長邊 360 以內的 RGBA 與 PNG 位元組（分解不需要大圖）
        async _subjDecodeImage(blob, maxSide) {
            const bmp = await createImageBitmap(blob), s = Math.min(1, (maxSide || 360) / Math.max(bmp.width, bmp.height)), w = Math.max(8, Math.round(bmp.width * s)), h = Math.max(8, Math.round(bmp.height * s));
            const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0, w, h); try { bmp.close(); } catch (_) { /* */ }
            const img = g.getImageData(0, 0, w, h), png = await new Promise((res) => cv.toBlob(res, 'image/png')); return { img, png: new Uint8Array(await png.arrayBuffer()) };
        },
        // 圖片分解（Pyodide 裡跑 image-decompose-redraw 的腳本），全程在記憶體裡：輸入寫進 Pyodide 的暫存區、輸出讀回字串、用完就清掉；回 scene3d 的文字或 null
        async _subjDecompose(pngBytes) {
            if (typeof FA_IDR_SKILL_FILES === 'undefined' || !FA_IDR_SKILL_FILES['scripts/run_geometric.py']) return null;
            let pyodide; try { pyodide = await this._ensurePyodideLoaded(); } catch (_) { return null; }
            try {
                pyodide.FS.mkdirTree('/work/in'); pyodide.FS.mkdirTree('/work/out');
                for (const [k, v] of Object.entries(FA_IDR_SKILL_FILES)) { if (k === 'SKILL.md') continue; const abs = '/work/idr/' + k; pyodide.FS.mkdirTree(abs.slice(0, abs.lastIndexOf('/'))); pyodide.FS.writeFile(abs, v); }
                pyodide.FS.writeFile('/work/in/input.png', pngBytes);
                const args = ['/work/in/input.png', '--out', '/work/out', '--vision', 'off', '--max-side', '320', '--max-leaves', '2500'];
                const script = ['import sys, json', 'import pyodide_js', "await pyodide_js.loadPackage(['numpy', 'pillow'])", 'sys.dont_write_bytecode = True', "sys.path.insert(0, '/work/idr/scripts')", 'import run_geometric', 'run_geometric.main(' + JSON.stringify(args) + ')'].join('\n');
                const r = await this._runPyodideScriptAsync(pyodide, script, null); if (r.returncode !== 0) return null;
                const f = this._walkPyodideFsDir(pyodide, '/work/out').find((x) => /\.scene3d\.yaml$/i.test(x.absPath)); if (!f) return null;
                return pyodide.FS.readFile(f.absPath, { encoding: 'utf8' });
            } finally { try { for (const f of this._walkPyodideFsDir(pyodide, '/work')) pyodide.FS.unlink(f.absPath); } catch (_) { /* */ } }
        },
        async _subjImage3d(subject) {
            const M = FaSubject3d, cands = await this._subjImageCandidates(subject); if (!cands.length) return null;
            const ps = FaPictureSource.make({ fetch: this._edFetchFn(), timeoutMs: 20000 }); let tried = 0;
            for (const c of cands) {
                if (tried >= 4) break; tried++;
                try {
                    const { blob } = await ps.load(c.ref), dec = await this._subjDecodeImage(blob, 360), bm = M.bgMask(dec.img);
                    if (bm.fg < 0.1 || bm.fg > 0.85) continue;   // 背景切不乾淨（整張都是東西，或東西跟背景同色）：換下一張
                    const txt = await this._subjDecompose(dec.png); const sc = txt && M.parseScene(txt); if (!sc) continue;
                    const cut = M.cutBackground(sc.mesh, bm.mask, dec.img.width, dec.img.height); if (cut.kept < 40) continue;
                    return { mesh: { vertices: cut.vertices, faces: cut.faces, uvs: cut.uvs }, texture: sc.texture, from: c.title, source: c.source, license: c.license, creator: c.creator, fg: Math.round(bm.fg * 100) };
                } catch (_) { /* 這張不行就換下一張 */ }
            }
            return null;
        },
        // 這個東西的外形資料：快取 → 2D 先找現成 SVG → 維基百科（中文、英文）→（2D 沒有描述時）參考圖＋視覺模型 → 模型整理。回 { brief, asset, from } 或 null
        async _subjBrief(subject, kind) {
            const R = FaSubjectResearch, key = R.cacheKey(subject.name), ai = this._edAi(), want2D = kind === 'edit-svg' || kind === 'image';
            try { const hit = await this._subjTx('readonly', (os) => new Promise((res, rej) => { const rq = os.get(key); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); })); if (hit && (hit.brief || (hit.asset && want2D) || (hit.asset3d && kind === 'edit-3d'))) return { brief: hit.brief || null, asset: want2D ? hit.asset || null : null, asset3d: kind === 'edit-3d' ? hit.asset3d || null : null, from: 'cache' }; } catch (_) { /* 沒有快取就查 */ }
            // 2D：先找現成的 SVG；找到就是它（不用再整理外形）
            let asset = null, asset3d = null;
            if (kind === 'edit-3d') { try { asset3d = await this._subjObjAsset(subject); } catch (_) { asset3d = null; } }   // 3D：先找現成的 OBJ
            if (want2D) { try { const f = await this._subjSvgAsset(subject); if (f) asset = { inner: f.svg.inner, w: f.svg.w, h: f.svg.h, title: f.pick.title, license: f.pick.license, creator: f.pick.creator, page: f.pick.page }; } catch (_) { /* 找不到就往下 */ } }
            let brief = null, ev = null;
            if (!asset && !asset3d) {
                for (const [lang, q] of [['zh', subject.name], ['en', subject.en]]) { if (!q || ev) continue; try { const x = R.pickExtract(await this._subjGetJson(R.wikiUrl(lang, q)), q); if (x) ev = x; } catch (_) { /* 這個來源不通就換下一個 */ } }
                if (!ev && kind === 'edit-3d') { try { asset3d = await this._subjImage3d(subject); } catch (_) { asset3d = null; } }   // 3D 沒有文字描述：找一張圖，切掉背景，用現有的圖片分解做成 3D
                if (!asset3d && !ev && (want2D || kind === 'edit-picture')) { try { brief = await this._subjImageBrief(subject, kind); } catch (_) { brief = null; } }   // 2D 沒有文字描述：找一張參考圖，請視覺模型看圖整理
                if (!brief && !asset3d) {
                    const bp = R.briefPrompt(subject, ev ? ev.title + '：' + ev.text : '', kind);
                    let reply = ''; try { reply = await ai.chat(bp.system, bp.user, { maxTokens: 1500, temperature: 0.2 }); } catch (_) { return null; }
                    brief = R.parseBrief(reply, subject, ev ? 'web' : 'model'); if (brief && ev) brief.page = ev.title;
                }
                if (!brief && !asset3d) return null; if (brief) brief.at = Date.now();
            }
            try { await this._subjTx('readwrite', (os) => { os.put({ key, at: Date.now(), brief, asset, asset3d }); }); const all = await this._subjTx('readonly', (os) => new Promise((res, rej) => { const rq = os.getAll(); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); })); const drop = R.evictPlan(all); if (drop.length) await this._subjTx('readwrite', (os) => { drop.forEach((k) => os.delete(k)); }); } catch (_) { /* 存不了下次再查 */ }
            return { brief, asset, asset3d, from: asset ? 'svg' : asset3d ? (asset3d.mesh && asset3d.repo ? 'obj' : 'picture3d') : brief.source === 'image' ? 'image' : ev ? 'web' : 'model' };
        },
        // 這句話裡不認識的東西 → { block: 給模型的一小段參考, assets: [svg 物件], subjects }（沒有就 block 為 ''）。status：顯示進度的函式
        async _subjResolve(kind, text, status) {
            const none = { block: '', assets: [], subjects: [] };
            if (!this._subjOn() || (kind !== 'edit-3d' && kind !== 'edit-svg' && kind !== 'edit-picture' && kind !== 'image')) return none;
            const R = FaSubjectResearch; if (!R.worthAsking(text)) return none;
            const known = kind === 'edit-3d' && typeof FaMeshGen !== 'undefined' ? FaMeshGen.CATALOG.map((c) => c.label || c.id) : [], ai = this._edAi();
            let subs = []; try { const q = R.subjectsPrompt(text, known, kind); subs = R.parseSubjects(await ai.chat(q.system, q.user, { maxTokens: 300, temperature: 0 }), known); } catch (_) { return none; }
            if (!subs.length) return none;
            const briefs = [], notes = [], assets = [], used = [];
            for (const s of subs) {
                if (typeof status === 'function') status(T('查「' + s.name + '」長怎樣…', 'Looking up what "' + s.name + '" looks like…'));
                let r = null; try { r = await this._subjBrief(s, kind); } catch (_) { r = null; }
                if (!r) continue; used.push(s);
                if (r.asset && kind !== 'edit-3d') { const a = R.assetObject(s, r.asset, { inner: r.asset.inner, w: r.asset.w, h: r.asset.h }, 300); assets.push(a); notes.push(s.name + T('（找到現成的向量圖：' + r.asset.title + (r.asset.license ? '，' + r.asset.license : '') + (r.asset.creator ? '，' + r.asset.creator : '') + '）', ' (found a ready-made vector: ' + r.asset.title + ')')); }
                if (r.asset3d) {
                    const a3 = r.asset3d, fitted = FaSubject3d.fit(a3.mesh, (s.cm || 30) / 100, a3.texture ? { depthRatio: 0.4 } : null), obj = FaSubject3d.toObject(s, fitted, { texture: a3.texture || '', color: a3.texture ? '#ffffff' : '' });
                    if (a3.repo) { const lic = a3.license === 'none' ? T('未標示授權，僅供個人使用', 'no licence stated, personal use only') : a3.license; obj.credit = 'GitHub ' + a3.repo + '（' + lic + '）' + a3.path; notes.push(s.name + T('（找到現成的 3D 模型：GitHub ' + a3.repo + '，' + lic + '）', ' (found a 3D model on GitHub: ' + a3.repo + ')')); }
                    else { obj.credit = [a3.source, a3.from, a3.creator, a3.license].filter(Boolean).join(' / '); notes.push(s.name + T('（沒有現成模型，用網路上找到的圖做成立體的：' + (a3.from || a3.source) + '）', ' (built in 3D from a picture found online)')); }
                    assets.push(obj);
                }
                if (r.brief) { briefs.push(r.brief); notes.push(s.name + (r.from === 'cache' ? T('（記得）', ' (remembered)') : r.from === 'web' ? T('（查了網路）', ' (web)') : r.from === 'image' ? T('（看了參考圖）', ' (from a reference picture)') : T('（沒查到網路資料）', ' (nothing found online)'))); }
            }
            if (this._subjLoginHint) { this._subjLoginHint = false; if (typeof status === 'function') status(T('GitHub 的程式碼搜尋要先在 Chrome 登入 GitHub；這次改用公開專案搜尋', 'GitHub code search needs you to sign in to GitHub in Chrome; used the public repository search this time')); }
            if (!briefs.length && !assets.length) return none;
            if (typeof status === 'function') status(T('找到外形資料：' + notes.join('、'), 'Found the shape: ' + notes.join(', ')));
            const offline = !!(this.advancedSettings && this.advancedSettings.offlineMode), budget = Math.max(400, Math.min(1600, Math.round(this._kiBudgetChars(offline) * 0.15)));
            const block = (briefs.length ? R.refBlock(briefs, budget, kind) : '') + (assets.length ? (briefs.length ? '\n' : '') + (kind === 'edit-3d' ? FaSubject3d.assetNote(assets) : R.assetNote(assets)) : '');
            return { block, assets, subjects: used, notes };
        },
        async _subjRefFor(kind, text, status) { const r = await this._subjResolve(kind, text, status); return r.block; },
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
            const ask = (req) => self._edQuietRun((line) => { try { if (req && typeof req.onStatus === 'function') req.onStatus(line); } catch (_) { /* */ } }, async () => {
                let hit = null; try { hit = await self._edCaseFor(kind, req); } catch (_) { hit = null; }   // 範例庫壞了不影響編輯
                if (hit && hit.replay) return hit.replay;                                                  // 弱模型／離線：程式直接放範例的成品，不經過模型
                if (hit && self._edQuiet) self._edQuiet.ref = hit.block;                                    // 強模型：只多一小段參考
                if ((!hit || !hit.replay) && (kind === 'edit-3d' || kind === 'edit-svg' || kind === 'edit-picture') && req && req.text) {   // 不認識的東西先去查，結果也只是一小段參考
                    let sres = { block: '', assets: [] }; try { sres = await self._subjResolve(kind, String(req.text), (line) => { try { if (typeof req.onStatus === 'function') req.onStatus(line); } catch (_) { /* */ } }); } catch (_) { sres = { block: '', assets: [] }; }
                    if (sres.block && self._edQuiet) self._edQuiet.ref = (self._edQuiet.ref ? self._edQuiet.ref + String.fromCharCode(10, 10) : '') + sres.block;
                    const ans = await ask0(req);
                    // 找到現成的向量圖：由程式先放進畫面（模型之後的動作用名字安排它的位置與大小）
                    if ((kind === 'edit-svg' || kind === 'edit-3d') && sres.assets.length && ans && Array.isArray(ans.edits)) { ans.edits = sres.assets.map((a) => ({ op: 'add_object', object: a })).concat(ans.edits); ans.notes = (ans.notes || []).concat(sres.assets.map((a) => T('素材來源：', 'Source: ') + (a.credit || a.name))); }
                    return ans;
                }
                return ask0(req);
            });
            return {
                palette: () => ({ dark: !self._isLightTheme() }),
                ask,
                save: async (state) => { const c = getSpecState(); let old = null; try { old = await FaEditStore.loadProject(kind, id); } catch (_) { /* a new project */ } return FaEditStore.saveProject(kind, id, Object.assign({}, old && old.origin ? { origin: old.origin } : {}, { v: 1, spec: c.spec, state })); },
                download: (blob, name, mime) => self.generateAndDeliverFile(blob, name, mime || blob.type),
                toChat: (blob, name, info) => self._edToChat(kind, blob, name, info),
                saveCase: (info, o) => self._edCaseSave(kind, info, o),
                diffusion: kind === 'edit-picture' ? { get: () => self._edDiffusionState(), set: (on) => self._edDiffusionSet(on) } : undefined,
                detail: kind === 'edit-picture' ? (req) => self._edDetail(req) : undefined,
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
