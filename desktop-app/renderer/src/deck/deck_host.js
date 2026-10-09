/* /media-presentation 的主機轉接層。
 * 簡報播放器、核心、匯出等模組（deck_*.js、viewer2d.js、viewer3d.js、video_export.js）是從 redmine_ai_chat 外掛原樣移植的，
 * 它們只認一組 window.AiChat* 的全域介面；這裡把那組介面接到這個助理自己的零件（檔案快取、語音合成、mermaid、單次模型呼叫、終端機…）。
 * 全部以方法的形式掛到 FloatingAssistant.prototype（見 embed-code-ui.js 的 DECK 標記）。 */
const FaDeckHost = (function () {
    'use strict';
    // 載入順序與外掛的 index.html.erb 相同
    const ORDER = ['viewer3d', 'viewer2d', 'video_export', 'deck_core', 'deck_stage3d', 'deck_code', 'deck_quiz', 'deck_widget', 'deck_player', 'deck_pack', 'deck_export'];
    const CLIENT_PREFIX = 'client-file/';
    // 預設樣板：結構與外掛的 config/deck_template.default.json 相同（版面座標以 1920x1080 設計空間計），沒有品牌圖片
    const DECK_CSS_ID = 'fa-deck-css';

    const methods = {
        // 簡報用到的函式庫網址（沿用助理本身的設定，可被 FA_ASSET_URLS 覆寫）
        _deckAssetUrls() {
            const u = (typeof FA_ASSET_URLS !== 'undefined' && FA_ASSET_URLS) || {};
            return { jsYaml: u.jsyaml, three: u.threejs, orbitControls: u.threeOrbitControls, jszip: u.jszip, mp4Muxer: u.mp4Muxer, pptxgenjs: u.pptxgenjs, base: '' };
        },
        _deckInjectScript(src, label) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
                const s = document.createElement('script');
                s.src = url; s.async = false; s.setAttribute('data-fa-deck', label);
                s.onload = () => { resolve(); };
                s.onerror = () => { reject(new Error('簡報元件載入失敗：' + label)); };
                document.head.appendChild(s);
            });
        },
        // 載入簡報執行環境（第一次用到時才載入；失敗會清掉，下次再試）
        _deckEnsureRuntime() {
            if (this._deckRuntimePromise) return this._deckRuntimePromise;
            this._deckRuntimePromise = (async () => {
                const SRC = (typeof FA_DECK_SRC !== 'undefined' && FA_DECK_SRC) || null;
                if (!SRC) throw new Error('這個版本沒有內嵌簡報元件');
                const w = window;
                w.AiChatExportAssetUrls = Object.assign({}, w.AiChatExportAssetUrls || {}, this._deckAssetUrls());
                this._deckInstallShims();
                if (!document.getElementById(DECK_CSS_ID)) { const st = document.createElement('style'); st.id = DECK_CSS_ID; st.textContent = SRC.css || ''; document.head.appendChild(st); }
                const tpl = await this._deckLoadTemplate();
                if (tpl) w.AiChatDeckTemplate = tpl; // 核心載入時自動套用
                for (const name of ORDER) { if (SRC[name]) await this._deckInjectScript(SRC[name], name); }
                if (!w.AiChatDeck || !w.AiChatDeckCore) throw new Error('簡報元件載入後找不到 AiChatDeck');
                w.AiChatDeck.setTtsProvider((text, voice, speed, lang) => this._deckSynthesize(text, voice, speed, lang));
                w.AiChatDeck.setGradeProvider((system, user) => this._deckGrade(system, user));
                return true;
            })();
            this._deckRuntimePromise.catch(() => { this._deckRuntimePromise = null; });
            return this._deckRuntimePromise;
        },
        // 外掛的 window.AiChat* 介面，接到這個助理的零件
        _deckInstallShims() {
            const w = window, self = this;
            w.AiChatFileSink = {
                CLIENT_FILE_PREFIX: CLIENT_PREFIX,
                resolve(embed) {
                    const s = String(embed || '');
                    if (s.indexOf(CLIENT_PREFIX) !== 0) return Promise.resolve({ url: s });
                    return self.fileCache.get(s.slice(CLIENT_PREFIX.length)).then((rec) => {
                        if (!rec) throw new Error('找不到檔案 ' + s);
                        return { blob: rec.blob, filename: rec.filename, mimeType: rec.mimeType };
                    });
                },
            };
            w.AiChatDialog = { notify: (m) => { try { self._log(String(m)); } catch (_) { /* */ } } };
            w.AiChatMermaid = {
                renderSvg(source) {
                    return self._ensureMermaidLoaded().then(() => {
                        const id = 'fa-deck-mm-' + Math.random().toString(36).slice(2, 8);
                        return window.mermaid.render(id, String(source)).then((r) => (r && r.svg) || String(r));
                    });
                },
            };
            w.AiChatMarkdown = Object.assign(w.AiChatMarkdown || {}, { pptxKit: self._deckPptxKit() });
        },
        // PPTX 版型零件（標題頁、章節頁；顏色與字型來自樣板）。沒有品牌圖片時用純色底
        _deckPptxKit() {
            const self = this;
            const T = () => (window.AiChatDeckTemplate || {});
            const hex = (c, d) => String(c || d).replace('#', '').slice(0, 6).toUpperCase();
            const colors = () => (T().colors || {});
            const kit = {
                slideW: 13.333, slideH: 7.5,
                get font() { return T().pptxFont || 'Microsoft JhengHei'; },
                get colorHeading() { return hex(colors().heading, '0E2841'); },
                get colorBody() { return hex(colors().body, '333333'); },
                get colorAccent() { return hex(colors().accent, '77BD1D'); },
                get colorTableHeaderBg() { return hex(colors().soft, 'E8E8E8'); },
                contentHeader: { x: 0.44, y: 0.38, w: 11.96, h: 0.79 },
                ensureLibs() { return Promise.all([window.PptxGenJS ? Promise.resolve() : _faLoadScriptOnce(FA_ASSET_URLS.pptxgenjs), window.JSZip ? Promise.resolve() : _faLoadScriptOnce(FA_ASSET_URLS.jszip)]).then(() => undefined); },
                assetSource() { return null; },
                addTitleSlide(pres, title, caption) {
                    const s = pres.addSlide(); s.background = { color: hex(colors().dark, '0E2841') };
                    s.addText(String(title || ''), { x: 0.9, y: 2.4, w: kit.slideW - 1.8, h: 1.6, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: kit.font, valign: 'middle' });
                    if (caption && String(caption).trim()) s.addText(String(caption), { x: 0.9, y: 4.1, w: kit.slideW - 1.8, h: 0.7, fontSize: 20, color: kit.colorAccent, fontFace: kit.font });
                    return s;
                },
                addTopicSlide(pres, heading) {
                    const s = pres.addSlide(); s.background = { color: hex(colors().dark, '0E2841') };
                    s.addShape('rect', { x: 0, y: 0, w: kit.slideW, h: 0.08, fill: { color: kit.colorAccent } });
                    s.addText(String(heading || ''), { x: 1.0, y: 2.6, w: kit.slideW - 2, h: 1.6, fontSize: 38, bold: true, color: 'FFFFFF', fontFace: kit.font, valign: 'middle' });
                    return s;
                },
            };
            return kit;
        },
        // 預設樣板的覆寫：存在助理設定的 deckTemplate（JSON 物件，欄位同外掛的樣板）；沒有就用核心內建的預設
        async _deckLoadTemplate() {
            try { const t = this.advancedSettings && this.advancedSettings.deckTemplate; return t && typeof t === 'object' ? t : null; } catch (_) { return null; }
        },
        // 旁白：文字 → mp3 的位元組（用助理既有的語音合成：英文走本機 Kokoro，中文走設定好的語音轉接）
        async _deckSynthesize(text, voice, speed, lang) {
            const r = await this._synthesizeSpeech(String(text), voice || null, null, speed);
            if (!r || !r.ok) throw new Error((r && r.error) || '語音合成失敗');
            const rec = await this.fileCache.get(r.audio_file_id);
            if (!rec) throw new Error('語音合成的結果檔不見了');
            const buf = await rec.blob.arrayBuffer();
            try { await this.fileCache.delete(r.audio_file_id); } catch (_) { /* 留著也無妨 */ }
            return buf;
        },
        // 問答卡的 AI 評分：單次呼叫模型，要求回 JSON
        async _deckGrade(system, user) {
            const text = await this._callSimpleCompletion(String(user), { systemPrompt: String(system), maxTokens: 500, temperature: 0 });
            const Quiz = window.AiChatDeckQuiz;
            const v = Quiz && Quiz.parseAiReply ? Quiz.parseAiReply(String(text || '')) : null;
            if (!v || typeof v.score !== 'number') throw new Error('AI 評分沒有給出可用的結果');
            return v;
        },
        // ---- 簡報檔：存成 fileCache 裡的 .deck.yaml，網址是 client-file/<id>.deck.yaml（播放器用副檔名認簡報） ----
        async _deckSaveYaml(yamlText, title) {
            const name = String(title || 'presentation').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) + '.deck.yaml';
            const id = await this.fileCache.put(name, 'text/yaml', new Blob([yamlText], { type: 'text/yaml' }), 'generated');
            return { id, name, url: CLIENT_PREFIX + id + '.deck.yaml' };
        },
        async _deckReadYaml(urlOrId) {
            const s = String(urlOrId || '').trim();
            const id = s.indexOf(CLIENT_PREFIX) === 0 ? s.slice(CLIENT_PREFIX.length).replace(/\.deck\.yaml.*$/i, '') : s.replace(/\.deck\.yaml.*$/i, '');
            const rec = await this.fileCache.get(id);
            if (!rec) throw new Error('找不到簡報檔：' + s);
            return rec.blob.text();
        },
        // 在容器裡掛上播放器
        async _deckMount(container, url) {
            await this._deckEnsureRuntime();
            const box = document.createElement('div');
            box.className = 'ai-chat-deck'; box.setAttribute('data-deck-url', url);
            container.appendChild(box);
            window.AiChatDeck.mount(box);
            return box;
        },
    };
    return { methods, ORDER, CLIENT_PREFIX };
})();
if (typeof module === 'object' && module.exports) module.exports = FaDeckHost;
