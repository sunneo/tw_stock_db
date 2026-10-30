/* /edit-video 的主機轉接層(接在 edit_host.js 之後,同一個 FaEditHost)。設計見 DESIGN.edit-video.md。
 * 編輯器本身(video_edit_core/jobs/ai/ui、來源選擇器、TTS 對話框)是 window 上的 TwVideo* 全域模組;這裡只接桌面版自己的能力:
 *   影片、配音、燒錄輸出 = fileCache 的檔案(釘選,不被容量淘汰);專案 = FaEditStore(IndexedDB tw_edit,project/edit-video/ID,存成 { v:1, spec:專案, state:null });
 *   語音辨識 = 既有的 Whisper(_getWhisperTranscriber/_runWhisperWindowed,WebGPU 失敗退回 CPU);燒錄 = 既有的 _burnSubtitles(worker 加了配音軌 dubBed);
 *   TTS = _deckSynthesize(簡報旁白同一條:Kokoro 本機／Microsoft 線上);AI = _edAi()(程式先讀白話,讀不懂才問模型)。
 * 外框是共用的 FaWin(彈出、最大化、收回對話裡),對話裡是一則 ```fa-edit-video {"id":…}``` 區塊,重新整理後由 _mountEditEditors 重建。 */
(function () {
    'use strict';
    const H = FaEditHost, T = H.T, M = H.methods;
    const WHISPER_SR = 16000, BED_RATE = 48000;

    H.register('edit-video', {
        fence: 'fa-edit-video', icon: '🎬', cmd: '/edit-video', prefix: 'vd', label: () => T('影片逐字稿編輯器', 'Video transcript editor'),
        core: () => window.TwVideoEdit,
        ui: () => ({ mount: (o) => window.FaVideoEditMount(o) }),
        lead: '🎬 影片逐字稿編輯器:左邊是物件列(影片與配音),中間是播放器(字幕疊在上面),右邊是逐字稿／Ask AI／工作佇列。「🎙 產生逐字稿」排進瀏覽器內的佇列(Whisper,離線);可以改時間與文字、匯入匯出 SRT、「🎤 配音」(麥克風或 TTS)、「🔥 燒錄字幕」(字幕+配音或僅字幕)。',
        collectRefs: () => [],
        mountOpts: function (id) { return this._videoMountOpts(id); },
        help: () => '**' + T('影片逐字稿編輯器', 'Video transcript editor') + '**\n\n' + T('`/edit-video`:開一個空的編輯器,用「📂 載入影片」選影片(這台電腦、對話附件、授權資料夾、這個程式存的檔案);`/edit-video 檔名或檔案 id` 直接載入;對話裡剛附的影片會自動帶入。逐字稿可以用 Whisper 產生(整支或從播放位置起 2 秒)、改時間與文字、匯入匯出 SRT,也可以在「Ask AI」分頁用說的改(「第 3 句改成…」「全部延後 0.5 秒」「把第 2 句用英文配音」)。「🎤 配音」錄麥克風或用 TTS 合成,邊播邊聽;「🔥 燒錄字幕」輸出 MP4(字幕+配音,或僅字幕),輸出還能繼續編輯。', '`/edit-video` opens an empty editor; load a video with "📂 Load video" (this computer, chat attachments, authorized folders, files kept by this app). `/edit-video <name or file id>` loads it directly; a video just attached in the chat is picked up. Make the transcript with Whisper, edit times and text, import/export SRT, talk to it in the Ask AI tab, dub with the microphone or TTS, and burn the subtitles (with or without the dubs) into an MP4.')
    });

    const isLight = (self) => { try { return !!self._isLightTheme(); } catch (_) { return false; } };
    const mediaKind = (n) => (window.TwVideoIntent ? window.TwVideoIntent.mediaKind(n) : null);

    // fileCache 的記錄 → 編輯器要的 File(帶 twClientFileId,載入時不會再存一份)
    function fileOf(rec) { const f = new File([rec.blob], rec.filename || 'video', { type: rec.mimeType || rec.blob.type || '' }); f.twClientFileId = rec.id; return f; }

    // ───── 辨識:既有的 Whisper(主執行緒解碼成 16 kHz 單聲道,只取要辨識的那一段) ─────
    M._videoTranscribe = function (blob, o, report) {
        const self = this; let dead = false, rejectIt = null;
        const promise = new Promise((resolve, reject) => {
            rejectIt = reject;
            (async () => {
                report(T('解碼音訊…', 'Decoding audio…'));
                const audio = await self._decodeAudioForWhisper(blob); if (dead) return;
                const w = window.TwVideoEdit.pcmWindow(audio.pcm.length, WHISPER_SR, o.startSec, o.lenSec), pcm = w ? audio.pcm.slice(w.from, w.to) : new Float32Array(0);
                if (pcm.length < 1600) throw new Error(T('從這個位置起沒有可辨識的聲音', 'There is no audio to recognize from this position'));
                const cpuOnly = self.advancedSettings && (self.advancedSettings.whisperDevicePreference === 'cpu' || self.advancedSettings.offlineDevicePreference === 'cpu');
                const wantWebGpu = !cpuOnly && await self._isWebGpuAvailable(), order = wantWebGpu ? ['webgpu', 'wasm'] : ['wasm']; let lastErr = null;
                for (let i = 0; i < order.length && !dead; i++) {
                    try {
                        report(T('載入 Whisper 模型(首次約需下載 77 MB)…', 'Loading the Whisper model (about 77 MB the first time)…'));
                        const tr = await self._getWhisperTranscriber(order[i], (m) => { if (!dead) report(String(m).replace(/^🎙️\s*/, '')); });
                        const merged = await self._runWhisperWindowed(tr, pcm, o.language || null, order[i], (m) => { if (!dead) report(String(m).replace(/^🎙️\s*/, '')); });
                        if (dead) return;
                        const segments = (merged.chunks || []).map((c) => ({ start: Array.isArray(c.timestamp) ? c.timestamp[0] : null, end: Array.isArray(c.timestamp) ? c.timestamp[1] : null, text: String(c.text || '').trim() })).filter((s) => s.text && s.start != null);
                        resolve({ segments, language: o.language || null, device: order[i] }); return;
                    } catch (e) { lastErr = e; self._whisperTranscriber = null; self._whisperTranscriberDevice = null; }
                }
                throw lastErr || new Error(T('辨識失敗', 'transcription failed'));
            })().catch(reject);
        });
        return { promise, cancel: () => { dead = true; if (rejectIt) rejectIt(new Error('canceled')); } };
    };

    // ───── 配音軌:所有配音依起始時間排成一條 48 kHz 單聲道 ─────
    M._videoRenderBed = async function (dubs) {
        const Ctx = window.AudioContext || window.webkitAudioContext, Off = window.OfflineAudioContext; if (!Ctx || !Off) throw new Error(T('這個瀏覽器不能解碼音訊', 'This browser cannot decode audio'));
        const dec = new Ctx();
        try {
            const list = await Promise.all(dubs.map((d) => d.blob.arrayBuffer().then((ab) => dec.decodeAudioData(ab)).then((buf) => ({ start: d.start, buf }))));
            const end = list.reduce((m, x) => Math.max(m, x.start + x.buf.duration), 0), off = new Off(1, Math.max(1, Math.ceil(end * BED_RATE) + 1), BED_RATE);
            list.forEach((x) => { const src = off.createBufferSource(); src.buffer = x.buf; src.connect(off.destination); src.start(x.start); });
            return new Float32Array((await off.startRendering()).getChannelData(0));
        } finally { try { dec.close(); } catch (_) { /* 已經關了 */ } }
    };
    // videoBlob, segments, report(text), baseName, opt { dubs: [{start, blob}] } -> { promise: {id, name}, cancel() }
    M._videoBurn = function (videoBlob, segments, report, baseName, opt) {
        const self = this; let canceled = false, rejectIt = null; const dubs = opt && opt.dubs && opt.dubs.length ? opt.dubs : null;
        const promise = new Promise((resolve, reject) => {
            rejectIt = reject;
            (async () => {
                let bed = null;
                if (dubs) { report(T('合成配音音軌… ', 'Preparing the dub track… ') + dubs.length); bed = await self._videoRenderBed(dubs); if (canceled) throw new Error('canceled'); }
                report(T('燒錄字幕… ', 'Burning subtitles… ') + segments.length + T(' 段', ' segments'));
                const name = String(baseName || 'video').replace(/\.[^.]+$/, '').replace(/-subtitled$/, '') + '-subtitled.mp4';
                const r = await self._burnSubtitles({ blob: videoBlob, filename: baseName }, segments, (p) => { if (!canceled && p) report(T('燒錄中… ', 'Burning… ') + (p.pct != null ? p.pct + '%' : (p.frames || '') + T(' 幀', ' frames'))); }, { dubBed: bed ? bed.buffer : null, dubRate: BED_RATE, outName: name });
                if (canceled) { if (r && r.video_file_id) { try { await self.fileCache.delete(r.video_file_id); } catch (_) { /* */ } } throw new Error('canceled'); }
                if (!r || !r.ok) throw new Error((r && r.error) || T('燒錄失敗', 'burning failed'));
                await self._videoPin(r.video_file_id);
                if (bed && r.dubMixed === false) report(T('這支影片沒有音軌:配音沒有混進去', 'This video has no audio track: the dubs could not be mixed in'));
                resolve({ id: r.video_file_id, name: r.filename || name });
            })().catch(reject);
        });
        return { promise, cancel: () => { canceled = true; if (rejectIt) rejectIt(new Error('canceled')); } };   // 燒錄 worker 沒有取消通道:已經開始的會跑完,結果丟掉
    };

    M._videoPin = async function (id) { try { if (id && this.fileCache.pin) await this.fileCache.pin(id, true); } catch (_) { /* 釘不了就算了 */ } return id; };

    // ───── 影片從哪裡來:對話附件、其他檔案、授權資料夾 ─────
    M._videoChatFiles = async function () {
        const out = [], seen = {}, add = (rec, from) => { if (!rec || seen[rec.id] || !mediaKind(rec.filename)) return; seen[rec.id] = 1; out.push({ name: rec.filename, size: rec.sizeBytes, from, open: () => this.fileCache.get(rec.id).then((r) => { if (!r) throw new Error(T('檔案不在了', 'the file is gone')); return fileOf(r); }) }); };
        (this._pendingAttachments || []).filter((a) => a.status === 'done').slice().reverse().forEach((a) => add({ id: a.id, filename: a.filename, sizeBytes: a.sizeBytes }, 'chat'));
        let all = []; try { all = await this.fileCache.getAll(); } catch (_) { all = []; }
        all.filter((r) => r.kind === 'uploaded').sort((a, b) => (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0)).forEach((r) => add(r, 'chat'));
        return out;
    };
    M._videoStoredFiles = async function () {
        let all = []; try { all = await this.fileCache.getAll(); } catch (_) { all = []; }
        return all.filter((r) => r.kind !== 'uploaded' && mediaKind(r.filename)).sort((a, b) => (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0)).map((r) => ({ name: r.filename, size: r.sizeBytes, from: 'stored', open: () => Promise.resolve(fileOf(r)) }));
    };
    M._videoFapFolders = async function () { try { const all = await this.fileAccessPoints.getAll(); return all.map((r) => ({ label: r.label, handle: r.handle })); } catch (_) { return []; } };

    // ───── TTS:桌面版的聲音清單 → 對話框要的格式 {id, name, lang(BCP 47), gender, engine: 'local'|'relay'} ─────
    M._videoVoices = function () {
        const out = [], adv = this.advancedSettings || {};
        const enLang = (l) => (/英式/.test(l) ? 'en-GB' : 'en-US');
        (typeof TTS_VOICES !== 'undefined' ? TTS_VOICES : []).forEach((v) => out.push({ id: v.id, name: v.name, lang: v.custom || v.clone ? (/中文/.test(v.lang || '') ? 'zh-TW' : 'en-US') : enLang(v.lang || ''), gender: v.gender, engine: 'local' }));
        (typeof TTS_ZH_VOICES !== 'undefined' ? TTS_ZH_VOICES : []).forEach((v) => out.push({ id: v.id, name: v.name, lang: v.custom || v.clone ? 'zh-TW' : 'zh-CN', gender: v.gender, engine: 'local' }));
        if (adv.ttsApiEnabled) (typeof TTS_API_VOICES !== 'undefined' ? TTS_API_VOICES : []).forEach((v) => out.push({ id: v.id, name: v.name, lang: /^[a-z]{2}-[A-Z]{2}/.test(v.id) ? v.id.slice(0, 5) : 'zh-TW', gender: v.gender, engine: 'relay' }));
        return out;
    };
    M._videoPickVoice = function (text, lang) {
        const list = this._videoVoices(), adv = this.advancedSettings || {}; if (!list.length) return null;
        const fam = String(lang || '').slice(0, 2).toLowerCase(), same = list.filter((v) => !fam || v.lang.slice(0, 2).toLowerCase() === fam); if (!same.length) return list[0];
        const prefer = fam === 'zh' ? [adv.ttsDefaultApiVoice, typeof TTS_DEFAULT_ZH_VOICE !== 'undefined' ? TTS_DEFAULT_ZH_VOICE : ''] : [adv.ttsDefaultVoice, typeof TTS_DEFAULT_VOICE !== 'undefined' ? TTS_DEFAULT_VOICE : ''];
        for (const id of prefer) { const v = same.filter((x) => x.id === id && (!lang || x.lang === lang))[0] || same.filter((x) => x.id === id)[0]; if (v) return v; }
        return same.filter((x) => x.lang === lang)[0] || same[0];
    };
    M._videoSynthesize = async function (text, voiceId, lang) {
        const buf = await this._deckSynthesize(String(text), voiceId || null, 1.0, lang), u = new Uint8Array(buf);
        return new Blob([u], { type: this._deckIsWav(buf) ? 'audio/wav' : 'audio/mpeg' });
    };

    // ───── AI:程式先讀白話(video_edit_ai.localParse,在編輯器裡),讀不懂才問模型 ─────
    M._videoAiMode = async function () {
        const A = this._edAi(); if (!A.have()) return 'none';
        return this.advancedSettings && this.advancedSettings.offlineMode ? 'offline' : 'online';
    };

    // ───── 掛載 ─────
    M._videoHost = function (id) {
        const self = this;
        return {
            save: (p) => FaEditStore.saveProject('edit-video', id, { v: 1, spec: p, state: null }),
            putFile: async (f) => self._videoPin(await self.fileCache.put(f.name || 'file', f.type || 'application/octet-stream', f, 'uploaded')),
            loadFile: async (fid) => { const rec = await self.fileCache.get(fid); if (!rec) throw new Error(T('檔案不在這個程式的檔案儲存裡', 'the file is not in this app\'s file storage')); return { arrayBuffer: await rec.blob.arrayBuffer(), mimeType: rec.mimeType || rec.blob.type, filename: rec.filename }; },
            pin: (fid) => self._videoPin(fid),
            transcribe: (blob, o, report) => self._videoTranscribe(blob, o, report),
            burn: (blob, segs, report, name, opt) => self._videoBurn(blob, segs, report, name, opt),
            chatFiles: () => self._videoChatFiles(), storedFiles: () => self._videoStoredFiles(), fapFolders: () => self._videoFapFolders(),
            openEditor: (fid) => self._videoOpen({ fileId: fid }),
            voices: () => self._videoVoices(), pickVoice: (text, lang) => self._videoPickVoice(text, lang),
            synthesize: (text, voiceId, lang) => self._videoSynthesize(text, voiceId, lang),
            ai: { mode: () => self._videoAiMode(), chat: (system, user) => self._edAi().chat(system || '', user, { maxTokens: 4000, timeoutMs: 150000 }) }
        };
    };
    M._videoMountOpts = function (id) {
        const self = this, fresh = this._videoFresh && this._videoFresh.get(id); if (fresh) this._videoFresh.delete(id);
        return { host: this._videoHost(id), fresh, light: isLight(self) };
    };
    // 專案存成 { v:1, spec: 專案 };外框共用的 _edMount 載入後呼叫這裡
    window.FaVideoEditMount = function (o) {
        const holder = document.createElement('div'); holder.style.cssText = 'display:block';
        const el = window.TwVideoEditUI.mount({ id: o.id, project: o.spec, container: holder, host: o.host, restoring: !o.fresh });
        el.style.setProperty('--ai-win-bg', o.light ? '#ffffff' : '#1e2127'); el.style.setProperty('--ai-win-fg', o.light ? '#1f2328' : '#e6e6e6');
        if (o.fresh && o.fresh.source) {
            const sc = o.fresh.source;
            Promise.resolve(sc.file ? el._ve.setVideo(sc.file) : el._ve.setVideo({ id: sc.id })).then(null, (e) => el._ve.say(T('載入影片失敗:', 'Could not load the video: ') + String((e && e.message) || e)));
        }
        el._ed = { destroy: () => { try { el.remove(); } catch (_) { /* */ } }, getState: () => null };
        return el;
    };

    // ───── 開啟:o.fileId＝fileCache 的檔案 id;o.file＝File;o.id＝接著原本的專案 ─────
    M._videoOpen = async function (o) {
        o = o || {}; const K = H.KINDS['edit-video'];
        if (o.id) { const proj = await FaEditStore.loadProject('edit-video', String(o.id)); if (!proj) return { ok: false, error: T('找不到這個專案:', 'no such project: ') + o.id }; this._edPush('edit-video', String(o.id), null); return { ok: true, id: String(o.id) }; }
        const id = FaEditStore.newId(K.prefix), proj = window.TwVideoEdit.newProject(T('影片', 'Video'));
        await FaEditStore.saveProject('edit-video', id, { v: 1, spec: proj, state: null });
        this._videoFresh = this._videoFresh || new Map(); this._videoFresh.set(id, { source: o.file ? { file: o.file } : o.fileId ? { id: o.fileId } : null });
        this._edPush('edit-video', id, null);
        return { ok: true, id, note: 'the video editor is open in the conversation; the user works in it. Do not paste the content into the conversation.' };
    };
    // 引數:檔案 id 或檔名(找 fileCache 裡最近的同名媒體檔);空＝對話裡剛附的第一個影片/音檔(沒有就開空的)
    M._videoResolveSource = async function (arg) {
        const a = String(arg || '').trim().replace(/^\[?Attached files:\s*/i, '');
        const I = window.TwVideoIntent, parsed = a ? I.pickMedia(I.parseAttachedFiles(a)) : null;
        let all = []; try { all = await this.fileCache.getAll(); } catch (_) { all = []; }
        const media = all.filter((r) => mediaKind(r.filename)).sort((x, y) => (y.lastAccessedAt || 0) - (x.lastAccessedAt || 0));
        const pending = (this._pendingAttachments || []).filter((p) => p.status === 'done' && mediaKind(p.filename))[0];
        if (parsed && parsed.kind === 'client') { const r = media.filter((x) => x.id === parsed.id)[0] || (await this.fileCache.get(parsed.id)); return r ? r.id : null; }
        if (a) { const byId = media.filter((x) => x.id === a)[0], byName = media.filter((x) => x.filename === a || x.filename.toLowerCase().indexOf(a.toLowerCase()) >= 0)[0]; return (byId || byName || {}).id || null; }
        if (pending) return pending.id;
        return null;
    };

    M._registerEditVideoCommands = function () {
        const self0 = this;
        this.register_slash_command('/edit-video', '[檔案 id｜檔名]',
            '影片逐字稿編輯器:左邊物件列(影片與配音)、中間播放器(字幕疊在上面)、右邊逐字稿／Ask AI／工作佇列。用 Whisper 產生逐字稿(整支或從播放位置起 2 秒)、改時間與文字、匯入匯出 SRT、麥克風或 TTS 配音、燒錄字幕(字幕+配音或僅字幕)。/edit-video 開空的、/edit-video 檔名 載入那支影片。',
            async (argsText, run) => {
                const r = run || self0, a = String(argsText || '').trim(); r.messages.push({ role: 'user', content: '/edit-video' + (a ? ' ' + a : '') });
                try {
                    const fid = await r._videoResolveSource(a);
                    if (a && !fid && !/^\[?Attached files:/i.test(a)) { r._pushAssistantMessage('⚠️ ' + T('找不到這個影片:', 'No such video: ') + a + '\n\n' + H.KINDS['edit-video'].help(), null); }
                    else { const res = await r._videoOpen({ fileId: fid }); if (res && res.ok === false) r._pushAssistantMessage('⚠️ ' + (res.error || T('開不起來', 'could not open it')), null); }
                } catch (e) { r._pushAssistantMessage('⚠️ ' + T('開不起來:', 'Could not open it: ') + String((e && e.message) || e), null); }
                try { r._persistChatHistory(); r._renderMessageHistory(); } catch (_) { /* */ }
            });
    };
    const prevRegister = M._registerEditCommands; M._registerEditCommands = function () { if (prevRegister) prevRegister.call(this); this._registerEditVideoCommands(); };
})();
