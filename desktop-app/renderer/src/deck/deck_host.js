/* /media-presentation 的主機轉接層。
 * 簡報播放器、核心、匯出等模組（deck_*.js、viewer2d.js、viewer3d.js、video_export.js）是從 redmine_ai_chat 外掛原樣移植的，
 * 它們只認一組 window.AiChat* 的全域介面；這裡把那組介面接到這個助理自己的零件（檔案快取、語音合成、mermaid、單次模型呼叫、終端機…）。
 * 全部以方法的形式掛到 FloatingAssistant.prototype（見 embed-code-ui.js 的 DECK 標記）。 */
const FaDeckHost = (function () {
    'use strict';
    // 載入順序與外掛的 index.html.erb 相同
    const ORDER = ['viewer3d', 'viewer2d', 'video_export', 'deck_core', 'deck_sfx', 'stage_core', 'deck_stage3d', 'deck_code', 'deck_quiz', 'deck_widget', 'deck_player', 'deck_pack', 'deck_export'];
    const CLIENT_PREFIX = 'client-file/';
    // 預設樣板：結構與外掛的 config/deck_template.default.json 相同（版面座標以 1920x1080 設計空間計），沒有品牌圖片
    const DECK_CSS_ID = 'fa-deck-css';

    const CJKTEST = (s) => /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s);
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
                w.AiChatDeck.setTtsProvider((text, voice, speed, lang) => this._deckSynthesize(text, voice, speed, lang), { concurrent: true });
                w.AiChatDeck.setSpeechPreparer((text, voice, lang) => this._deckPrepareSpeech(text, voice, lang));
                if (w.AiChatDeck.setVoiceLister) w.AiChatDeck.setVoiceLister(() => this._deckVoiceList());
                if (w.AiChatDeck.setCaptionTranslator) w.AiChatDeck.setCaptionTranslator((text, to) => this._deckTranslateCaption(text, to));
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
            w.AiChatTerminal = Object.assign(w.AiChatTerminal || {}, { mountEmbedded: (container, opts) => self._deckMountTerminal(container, opts) });
        },
        // 簡報裡的終端機（visual kind terminal、問答卡的實作題）：跟 /run-terminal 同一個 busybox shell（含 /mnt），掛進簡報的方框裡，
        // 不建工具列、不存檔；可以先自動打 commands，之後使用者自己接著打。回傳外掛播放器要的 handle
        async _deckMountTerminal(container, opts) {
            opts = opts || {};
            container.classList.add('ai-chat-terminal-container');
            container.setAttribute('data-deck-embedded', '1');
            await this._mountTerminalWidget(container, null, null);
            const session = container._terminalSession;
            if (!session) throw new Error('終端機沒有啟動');
            session.name = opts.name || 'deck-terminal';
            const Code = window.AiChatDeckCode;
            const restore = opts.restore && Code ? opts.restore : null;
            if (restore) await new Promise((resolve) => session.term.write('\r\n' + Code.snapshotToAnsi(restore) + '\r\n', resolve));
            const theme = this._getTerminalXtermTheme();
            let dirty = true, cache = null;
            ['onWriteParsed', 'onResize', 'onScroll'].forEach((n) => { try { session.term[n](() => { dirty = true; }); } catch (_) { /* 舊版 xterm */ } });
            const self = this;
            const runTyped = async (line) => {
                if (session.ended) return;
                line = String(line);
                session.term.write(line + '\r\n');
                if (line.trim()) session.history.push(line);
                session.historyIndex = session.history.length;
                session.busy = true;
                try {
                    const scan = self._terminalScanInput(line);
                    if (scan.incomplete) await self._runTerminalCommand(session, line); else await self._terminalRunUnits(session, scan.units);
                } catch (err) { session.term.write('\x1b[31m指令執行失敗：' + String((err && err.message) || err) + '\x1b[0m\r\n'); }
                finally { session.busy = false; }
                if (!session.activeProgram) self._writeTerminalPrompt(session);
            };
            if (!restore) for (const c of (opts.commands || [])) await runTyped(c);
            const text = (full) => { const buf = session.term.buffer.active; const lines = []; const from = full ? 0 : buf.viewportY; const to = full ? buf.length : buf.viewportY + session.term.rows; for (let i = from; i < to; i++) { const l = buf.getLine(i); if (l) lines.push(l.translateToString(true)); } while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); return lines.join('\n'); };
            return {
                session,
                text: () => text(false),
                fullText: () => text(true),
                snapshot: (force) => { if (!Code) return null; if (dirty || force || !cache) { cache = Code.snapshotTerminal(session.term, theme); dirty = false; } return cache; },
                resize: (cols, rows) => { try { session.term.resize(cols, rows); } catch (_) { /* */ } },
                history: () => session.history.slice(),
                run: runTyped,
                fit: () => { try { if (session.refit) session.refit(); } catch (_) { /* 還沒有大小 */ } },
                setFontSize: (px) => { try { session.term.options.fontSize = px; if (session.refit) session.refit(); } catch (_) { /* */ } },
                focus: () => { try { session.term.focus(); } catch (_) { /* */ } },
                dispose: () => { session.ended = true; try { session.term.dispose(); } catch (_) { /* */ } },
            };
        },
        // 內容卡片（簡報、簡報封包、遠端內容清單…）要放在 role:'tool' 的訊息上才會被畫出來；content 是給模型看的一句話
        _pushDisplayToolMessage(note, prop, value) {
            const m = this._buildToolResultMessage('display', JSON.stringify({ ok: true, note }), {});
            m.content = String(note); Object.defineProperty(m, prop, { value, enumerable: false, configurable: true, writable: true });
            this.messages.push(m); return m;
        },
        // ---- 簡報封包（.deckpack／舊的 .deck.zip）：整個檔案存進檔案快取，對話訊息只記檔案編號，重新整理後還能再開 ----
        _deckIsPackName(name) { const n = String(name || '').toLowerCase(); return /\.deckpack$/.test(n) || /\.deck\.zip$/.test(n); },
        async _deckOpenPackFile(file) {
            const id = await this.fileCache.put(file.name, 'application/zip', file, 'uploaded');
            this.messages.push({ role: 'user', content: '📦 開啟簡報封包：' + file.name });
            this._pushAssistantMessage('已開啟簡報封包「' + file.name + '」（作答紀錄與終端機畫面都會還原；不需要原本的檔案來源）。', null);
            this._pushDisplayToolMessage('[已開啟簡報封包「' + file.name + '」，已經在對話裡顯示成播放器]', '_displayDeckPackId', id);
            this._renderMessageHistory(); this._persistChatHistory();
            return id;
        },
        async _deckMountPack(container, fileId) {
            await this._deckEnsureRuntime();
            const rec = await this.fileCache.get(fileId);
            if (!rec) throw new Error('找不到簡報封包檔（檔案快取被清掉了，請重新開啟封包）');
            const box = document.createElement('div');
            box.className = 'ai-chat-deck';
            container.appendChild(box);
            await window.AiChatDeck.openPack(new File([rec.blob], rec.filename || 'deck.deckpack'), box);
            return box;
        },
        _deckPickPack() {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = '.deckpack,.zip'; input.style.display = 'none';
            input.addEventListener('change', async () => {
                const f = input.files && input.files[0]; input.remove();
                if (!f) return;
                if (!this._deckIsPackName(f.name)) { this._pushAssistantMessage('⚠️ 「' + f.name + '」不是簡報封包（副檔名要是 .deckpack 或 .deck.zip）。', null); this._renderMessageHistory(); return; }
                try { await this._deckOpenPackFile(f); } catch (e) { this._pushAssistantMessage('⚠️ 開啟簡報封包失敗：' + String((e && e.message) || e), null); this._renderMessageHistory(); }
            });
            document.body.appendChild(input);
            input.click(); // 斜線指令是使用者按 Enter 送出的，這裡仍在使用者手勢內
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
        // 同時做幾段旁白：語音服務的聲音（中文）可以一次做 4 段；本機模型（英文）一次一段（一次只能跑一個推論）
        _deckTtsGate(kind) {
            this._deckTtsQ = this._deckTtsQ || { api: { n: 0, max: 4, wait: [] }, local: { n: 0, max: 1, wait: [] } };
            const g = this._deckTtsQ[kind];
            return new Promise((resolve) => {
                const go = () => { g.n++; resolve(() => { g.n--; const nx = g.wait.shift(); if (nx) nx(); }); };
                if (g.n < g.max) go(); else g.wait.push(go);
            });
        },
        // 一頁旁白念之前的最後把關：一頁只用一種語言的語音。
        //  - 要用英文語音（投影片 lang 是 en，或選了英文語音）而旁白含中文：英文語音唸不出中文（會一個字一個字拼成 "chinese letter"），
        //    所以把「整頁」旁白翻成英文（字幕也跟著換）；翻不出來就整頁退回中文語音，唸原本的全中文。
        //  - 旁白含中文（其餘情況）：一律用中文語音——預設的挑選規則是「中文字超過兩成」，中英混雜的段落會被丟給英文語音而唸成亂碼。
        async _deckPrepareSpeech(text, voice, lang) {
            const s = String(text || ''), CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
            if (!CJK.test(s)) return { text: s, voice };
            const local = typeof TTS_VOICES !== 'undefined' ? TTS_VOICES : [], api = typeof TTS_API_VOICES !== 'undefined' ? TTS_API_VOICES : [];
            const isLocal = !!voice && local.some((v) => v.id === voice), isApi = !!voice && api.some((v) => v.id === voice);
            const zh = () => { const d = (this.advancedSettings && this.advancedSettings.ttsDefaultApiVoice) || ''; const v = api.find((x) => x.id === d) || api[0]; return v ? v.id : null; };
            if (isLocal || (!voice && /^en/i.test(String(lang || '')))) {
                const en = await this._deckTranslateToEnglish(s);
                if (en) { try { this._log('🌐 這頁要用英文語音，已把旁白翻成英文'); } catch (_) { /* */ } return { text: en, voice }; }
                try { this._log('⚠️ 這頁要用英文語音，但旁白含中文又翻不出英文：整頁改用中文語音唸原本的旁白'); } catch (_) { /* */ }
                return { text: s, voice: zh() };
            }
            return { text: s, voice: isApi ? voice : zh() };
        },
        async _deckTranslateToEnglish(text) {
            this._deckTransCache = this._deckTransCache || new Map(); const key = String(text);
            if (this._deckTransCache.has(key)) return this._deckTransCache.get(key);
            let out = null;
            try {
                const r = await this._callSimpleCompletion('Translate this spoken script into natural spoken English for text-to-speech.\n\n' + key, { systemPrompt: 'You translate the narration of a presentation slide into English that will be read aloud by a text-to-speech voice. Output ONLY the English narration: no quotes, no notes, no explanations, no markdown. Keep the number of sentences about the same. Write numbers, units and dates the way they are spoken. Chinese person / product / place names: use a common English form or pinyin without tone marks. Keep English terms as they are. The output must contain no Chinese characters at all.', maxTokens: 1200, temperature: 0 });
                const t = String(r || '').trim().replace(/^["“'‘]+|["”'’]+$/g, '').trim();
                if (t && !CJKTEST(t) && t.length >= Math.min(20, key.length * 0.2)) out = t;
            } catch (_) { out = null; }
            this._deckTransCache.set(key, out); return out;
        },
        // 一頁旁白的合成：
        //  · 逾時（240 秒）從「拿到語音引擎」才開始算，排隊等前面的頁不算（以前是整段都算，長簡報後面的頁會因為排隊就失敗：「narration did not answer within 240 seconds」）
        //  · 失敗或逾時 → 改用離線語音再試一次（中文：本地中文；英文：本地英文），在回傳的資料上放一則說明（fa_note），播放器的 🎙 面板會告訴使用者發生了什麼
        //  · 兩個都失敗才丟錯，錯誤裡兩邊的原因都寫
        async _deckSynthesize(text, voice, speed, lang) {
            const isApiVoice = (v) => (v ? (typeof TTS_API_VOICES !== 'undefined' && TTS_API_VOICES.some((x) => x.id === v)) : this._looksLikeCjkText(String(text)));
            const attempt = async (v) => {
                const release = await this._deckTtsGate(isApiVoice(v) ? 'api' : 'local');
                let timer; try { return await Promise.race([this._deckSynthesizeNow(text, v, speed, lang), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('語音合成 240 秒內沒有回應')), 240000); })]); } finally { clearTimeout(timer); release(); }
            };
            try { return await attempt(voice); }
            catch (e1) {
                const fb = this._deckFallbackVoice(text, voice); const why1 = String((e1 && e1.message) || e1).slice(0, 160);
                if (!fb) throw e1;
                try { this._log('⚠️ 簡報旁白用「' + (voice || '自動') + '」失敗（' + why1 + '），改用' + fb.label); } catch (_) { /* */ }
                try { const buf = await attempt(fb.id); try { buf.fa_note = '原本的語音失敗（' + why1 + '），這一頁改用' + fb.label + '。可以按 🎙 換聲音或重試。'; } catch (_) { /* */ } return buf; }
                catch (e2) { throw new Error(why1 + '；改用' + fb.label + '也失敗：' + String((e2 && e2.message) || e2).slice(0, 160)); }
            }
        },
        _deckFallbackVoice(text, voice) {
            const local = typeof TTS_VOICES !== 'undefined' ? TTS_VOICES : [];
            if (this._looksLikeCjkText(String(text))) {
                const zh = this._pickZhLocalVoice ? this._pickZhLocalVoice(null) : null; if (!zh || zh.id === voice) return null; return { id: zh.id, label: '離線中文語音「' + zh.name + '」' };
            }
            const en = local.find((v) => v.id === (this.advancedSettings && this.advancedSettings.ttsDefaultVoice)) || local[0]; if (!en || en.id === voice) return null;
            return { id: en.id, label: '離線英文語音「' + en.name + '」' };
        },
        // 字幕的另一種語言（中英文字幕）：中英互譯；離線模式只用離線翻譯模型。沒有譯文回 null（那一軌就不出現）
        async _deckTranslateCaption(text, to) {
            this._deckCapTr = this._deckCapTr || new Map(); const key = to + '|' + text; if (this._deckCapTr.has(key)) return this._deckCapTr.get(key);
            let out = null;
            try { const r = await this.translateText({ text: String(text), to, engine: this.advancedSettings && this.advancedSettings.offlineMode ? 'offline' : 'auto' }); if (r && r.ok && r.engine !== 'none' && typeof r.text === 'string' && r.text.trim()) out = r.text; } catch (_) { out = null; }
            this._deckCapTr.set(key, out); return out;
        },
        // 播放器 🎙 面板的聲音清單：本地英文、本地中文、線上中文（有啟用才列）
        _deckVoiceList() {
            const out = []; const add = (list, tag) => (list || []).forEach((v) => out.push({ id: v.id, label: v.name + '（' + tag + (v.gender ? '，' + v.gender : '') + '）' }));
            try { add(typeof TTS_VOICES !== 'undefined' ? TTS_VOICES : [], '離線英文'); add(typeof TTS_ZH_VOICES !== 'undefined' ? TTS_ZH_VOICES : [], '離線中文'); if (this.advancedSettings && this.advancedSettings.ttsApiEnabled) add(typeof TTS_API_VOICES !== 'undefined' ? TTS_API_VOICES : [], '線上中文'); } catch (_) { /* 清單拿不到就不列 */ }
            return out;
        },
        async _deckSynthesizeNow(text, voice, speed, lang) {
            const r = await this._synthesizeSpeech(String(text), voice || null, null, speed, { sentencePause: true });
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
