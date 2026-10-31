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
        // 遠端共筆橋接（DESIGN.edit-remote.md）：服務式的請求（AI、辨識）交給「AI 在」選的那台；專案與影片檔留在本機（影片檔只在辨識時送過去）。voices／pickVoice／synthesize／burn 還在本機
        remote: { sync: 'patch', methods: { 'ai.chat': { longRunning: true }, 'ai.offline': { longRunning: true }, 'ai.mode': {}, transcribe: { longRunning: true } } },
        remoteRun: async function (method, args, ctx) {
            const h = this._videoHost(ctx.sid), q = args[0] || {};
            if (method === 'ai.mode') return { mode: await h.ai.mode() };
            if (method === 'ai.chat') return { text: await h.ai.chat(q.system, q.user, q.onStatus) };
            if (method === 'ai.offline') { const r = await h.ai.offline(q.text, q.state, q.onStatus); return r && typeof r === 'object' ? r : { none: true }; }
            if (method === 'transcribe') { const x = h.transcribe(q.blob, q.o || {}, q.onStatus || (() => {})), t = setInterval(() => { try { if (ctx.shouldStop && ctx.shouldStop()) x.cancel(); } catch (_) { /* */ } }, 300); try { return await x.promise; } finally { clearInterval(t); } }
            throw new Error(T('這個編輯器沒有 ', 'No such method: ') + method);
        },
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
        if (opt && opt.timeline) return this._videoRenderTimeline(opt.timeline, segments, report, baseName, opt);
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

    // ───── 時間軸輸出(分割／合併／刪除／轉場／疊圖):逐格合成 → _encodeCanvasFramesToMp4(含字幕與整條混好的音軌) ─────
    // timeline: { clips: [{id, fileId, name, in, out, tr}], overlays: [{fileId, start, dur, x, y, w}] }; opt.dubs: [{start, blob}] 在時間軸時間上
    M._videoRenderTimeline = function (timeline, segments, report, baseName, opt) {
        const self = this, TL = window.TwVideoTimeline, FPS = 30; let canceled = false;
        const promise = (async () => {
            const clips = TL.normalizeClips(timeline.clips), ovs = TL.normalizeOverlays(timeline.overlays), total = TL.total(clips), st = TL.starts(clips);
            if (!clips.length || !(total > 0)) throw new Error(T('時間軸是空的', 'The timeline is empty'));
            const MB = await self._ensureMediabunnyLoaded(), srcs = {};
            const need = []; clips.forEach((c) => { if (!c.fileId) throw new Error(T('有片段的來源檔沒有存在檔案儲存裡(重新載入那個影片)', 'A clip\'s source file is not in the file storage (load that video again)')); if (need.indexOf(c.fileId) < 0) need.push(c.fileId); });
            report(T('讀取來源影片… ', 'Reading the source videos… ') + need.length);
            for (const fid of need) {
                const rec = await self.fileCache.get(fid); if (!rec) throw new Error(T('來源影片不在檔案儲存裡了:', 'A source video is gone: ') + fid);
                const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(rec.blob) }), track = await input.getPrimaryVideoTrack(); if (!track) throw new Error(T('這個檔案沒有影像軌:', 'No video track: ') + (rec.filename || fid));
                srcs[fid] = { rec, input, track, w: track.displayWidth || 640, h: track.displayHeight || 360 };
            }
            const first = srcs[clips[0].fileId], W = Math.max(2, first.w & ~1), H = Math.max(2, first.h & ~1);
            report(T('合成音軌… ', 'Mixing the audio… '));
            const audioBuffer = await self._videoTimelineAudio(clips, st, total, srcs, opt && opt.dubs, report); if (canceled) throw new Error('canceled');
            const bitmaps = {}; for (const ov of ovs) { if (ov.fileId && !bitmaps[ov.fileId]) { try { const r = await self.fileCache.get(ov.fileId); bitmaps[ov.fileId] = r ? await createImageBitmap(r.blob) : null; } catch (_) { bitmaps[ov.fileId] = null; } } }
            const hold = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }, sinks = {};
            const sinkOf = (fid) => sinks[fid] || (sinks[fid] = new MB.CanvasSink(srcs[fid].track, { width: W, height: H, fit: 'fill' }));
            const still = async (c, atEnd) => { const f = await sinkOf(c.fileId).getCanvas(atEnd ? Math.max(c.in, c.out - 0.05) : c.in), h = hold(); if (f) h.getContext('2d').drawImage(f.canvas, 0, 0, W, H); return h; };
            let cur = null, curI = -1, last = null, frameCv = null, fx = {};   // fx[i] = { prevLast, nextFirst } of the cut into clip i
            const openCursor = (i) => { if (cur) cur.close(); const c = clips[i]; cur = self._videoClipCursor(sinkOf(c.fileId), c.in, c.out); curI = i; last = null; };
            let pc = 0;
            const encode = (audio) => { const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; const ctx = canvas.getContext('2d'); frameCv = hold(); fx = {}; cur = null; curI = -1; last = null; return self._encodeCanvasFramesToMp4(canvas, Math.max(1, Math.ceil(total * FPS)), FPS, async (n) => {
                if (canceled) throw new Error('canceled');
                const t = Math.min(total - 1e-6, n / FPS), loc = TL.locate(clips, t); if (loc.i !== curI) openCursor(loc.i);
                const f = await cur.advanceTo(loc.src); if (f) last = f; const fc = frameCv.getContext('2d'); fc.clearRect(0, 0, W, H); if (last) fc.drawImage(last.canvas, 0, 0, W, H);
                const tr = TL.transitionAt(clips, t);
                if (tr) {
                    if (!fx[tr.i]) fx[tr.i] = { prevLast: await still(clips[tr.i - 1], true), nextFirst: await still(clips[tr.i], false) };
                    if (tr.before) TL.drawTransition(ctx, tr.type, tr.p, frameCv, fx[tr.i].nextFirst, W, H); else TL.drawTransition(ctx, tr.type, tr.p, fx[tr.i].prevLast, frameCv, W, H);
                } else { ctx.clearRect(0, 0, W, H); ctx.drawImage(frameCv, 0, 0, W, H); }
                TL.activeOverlays(ovs, t).forEach((ov) => { const bm = bitmaps[ov.fileId]; if (!bm) return; const w = ov.w * W, h = w * bm.height / bm.width; ctx.drawImage(bm, ov.x * W - w / 2, ov.y * H - h / 2, w, h); });
            }, (c, tot) => { const p = Math.floor(c / tot * 100); if (p !== pc) { pc = p; report(T('合成畫面… ', 'Rendering… ') + p + '%'); } }, { audioBuffer: audio, captionSegments: segments && segments.length ? segments : null, captionStyle: self._getSubtitleStyle() }); };
            let result = await encode(audioBuffer);
            if (!(result && result.ok) && audioBuffer && /encoder|not supported|aac|audio/i.test(String((result && result.error) || ''))) { report(T('這個環境不能編碼 AAC 音軌:輸出的影片沒有聲音', 'AAC audio cannot be encoded here: the video has no sound')); pc = -1; result = await encode(null); }
            if (cur) cur.close(); Object.keys(srcs).forEach((k) => { try { srcs[k].input.dispose && srcs[k].input.dispose(); } catch (_) { /* */ } });
            if (canceled) throw new Error('canceled'); if (!result || !result.ok) throw new Error((result && result.error) || T('合成失敗', 'rendering failed'));
            const name = String(baseName || 'video').replace(/\.[^.]+$/, '').replace(/-(subtitled|edited)$/, '') + (segments && segments.length ? '-subtitled' : '-edited') + '.mp4', id = await self.fileCache.put(name, 'video/mp4', result.blob, 'uploaded'); await self._videoPin(id);
            return { id, name };
        })();
        return { promise, cancel: () => { canceled = true; } };
    };
    // a cursor over the frames of [in, out) of one source: advanceTo(srcTime) -> the frame showing at that time (the last one after the end)
    M._videoClipCursor = function (sink, inT, outT) {
        const it = sink.canvases(inT, outT)[Symbol.asyncIterator](); let current = null, pending = null, done = false;
        return { async advanceTo(t) { for (;;) { if (pending === null && !done) { const r = await it.next(); if (r.done) { done = true; break; } pending = r.value; } if (pending && pending.timestamp <= t) { current = pending; pending = null; continue; } break; } return current; }, close() { try { it.return(); } catch (_) { /* */ } } };
    };
    // one stereo 48 kHz track for the whole timeline: each clip's own sound at its place (faded out/in around a transition), plus the dubs
    M._videoTimelineAudio = async function (clips, st, total, srcs, dubs, report) {
        const TL = window.TwVideoTimeline, SR = 48000, Off = window.OfflineAudioContext; if (!Off) return null;
        const off = new Off(2, Math.max(1, Math.ceil(total * SR)), SR); let any = false; const decoded = {};
        for (let i = 0; i < clips.length; i++) {
            const c = clips[i]; if (decoded[c.fileId] === undefined) { try { decoded[c.fileId] = await this._decodeAudioBuffer(srcs[c.fileId].rec.blob); } catch (_) { decoded[c.fileId] = null; } }
            const buf = decoded[c.fileId]; if (!buf) continue; any = true;
            const src = off.createBufferSource(), g = off.createGain(); src.buffer = buf; src.connect(g); g.connect(off.destination); const len = c.out - c.in;
            const wIn = TL.windowOf(clips, i), wOut = TL.windowOf(clips, i + 1);
            if (wIn) { g.gain.setValueAtTime(0, st[i]); g.gain.linearRampToValueAtTime(1, st[i] + wIn.dur / 2); }
            if (wOut) { g.gain.setValueAtTime(1, Math.max(st[i], st[i] + len - wOut.dur / 2)); g.gain.linearRampToValueAtTime(0, st[i] + len); }
            src.start(st[i], c.in, len);
        }
        for (const d of (dubs || [])) { try { const b = await this._decodeAudioBuffer(d.blob), s = off.createBufferSource(); s.buffer = b; s.connect(off.destination); s.start(Math.max(0, d.start)); any = true; } catch (_) { report(T('有一個配音讀不到,略過', 'A dub could not be read: skipped')); } }
        return any ? off.startRendering() : null;
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
    // 一律問模型(不再因為「離線模式」或沒設金鑰就不問):_kiLlm 先走線上、線上逾時/出錯才接離線文字模型(離線模式開著時順序相反,但線上一樣是退路);都不行才回報錯誤
    M._videoAiMode = async function () { return this.advancedSettings && this.advancedSettings.offlineMode ? 'offline' : 'online'; };
    // 線上模型(只走線上:_kiLlm 的 noOffline);離線的部分交給 harness(_videoOffline),不讓離線小模型自己寫 JSON
    M._videoOnlineChat = function (system, user, onStep) { return this._kiLlm(String(user), { systemPrompt: system || '', maxTokens: 4000, temperature: 0.2 }, { timeoutMs: 150000, label: '影片編輯器', noOffline: true, onStep: typeof onStep === 'function' ? onStep : undefined }).then(String); };

    // ───── 對話裡的 agent 工具(video_* 與 edit_video_open):編輯器的封閉動作原封不動變成工具,所以聊天裡的 agent、離線訓練器、計畫模板與 CoLU 單元目錄都用同一套詞彙驅動開著的編輯器 ─────
    M._videoLiveEditor = function () {
        const m = this._edEditors; if (!m) return null; let found = null;
        m.forEach((holder, key) => { if (/^edit-video:/.test(key) && holder && holder.querySelector) { const e = holder.querySelector('[data-tw-ve]'); if (e && e._ve && e.isConnected !== false) found = e; } });
        return found;
    };
    M._registerEditVideoTools = function (registerOptional) {
        const TOOLS = window.TwVideoPlans.TOOLS;
        const parse = async (self, raw) => { let a = {}; try { a = await self.repairJsonPayload(String(raw || '{}')); } catch (_) { /* */ } return a || {}; };
        Object.keys(TOOLS).forEach((name) => {
            const t = TOOLS[name], props = {}; Object.keys(t.props).forEach((k) => { props[k] = Object.assign({}, t.props[k]); if (!props[k].description) props[k].description = k; });
            registerOptional(name, t.desc, async function (rawArgs) {
                const a = await parse(this, rawArgs), ed = this._videoLiveEditor(); if (!ed) return JSON.stringify({ ok: false, error: T('沒有開著的影片編輯器(先 /edit-video 或 edit_video_open)', 'No video editor is open (use /edit-video or edit_video_open first)') });
                const op = window.TwVideoPlans.toOp(name, a); try { return JSON.stringify(await ed._ve.runOps([op])); } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); }
            }, { type: 'object', properties: props, required: t.required || [], additionalProperties: false });
        });
        registerOptional('edit_video_open', '在對話裡放一個「影片編輯器」(播放器＋逐字稿＋時間軸:分割、刪除一段、合併、轉場、疊圖片、插入聲音、TTS 配音、燒錄字幕)。參數:file_id(使用者附的影片,選填)、request(一句話要做什麼,開起來後交給編輯器的 Ask AI,選填)。回傳 {ok: true, id: "編輯器 id"}。',
            async function (rawArgs) { const a = await parse(this, rawArgs); try { return JSON.stringify(await this._videoOpen({ fileId: a.file_id ? String(a.file_id) : null, request: a.request ? String(a.request) : '' })); } catch (e) { return JSON.stringify({ ok: false, error: String((e && e.message) || e) }); } },
            { type: 'object', properties: { file_id: { type: 'string', description: '使用者附的影片(file id)' }, request: { type: 'string', description: '一句話要做什麼' } }, additionalProperties: false });
    };
    { const prevTools = M._registerEditTools; M._registerEditTools = function (ro) { if (prevTools) prevTools.call(this, ro); this._registerEditVideoTools(ro); }; }

    // ───── 離線 AI = 整套 harness(線上失效、或離線模式開著時):程式讀白話 → 離線訓練器學過的做法 → 意圖引擎(字母選擇題,模型只選不寫) → 計畫模板 → CoLU/UML 單元接線;每一層做不出來才交給下一層 ─────
    // 回傳 { edits, say, notes, via:[哪幾層出手] };edits 是 video_edit_ai.js 的封閉動作,之後仍由 applyEdits 逐項檢查(模型答錯也弄壞不了專案)
    M._videoOffline = async function (text, st, onStep) {
        const say = typeof onStep === 'function' ? onStep : () => {}, TP = window.TwVideoPlans, via = [], notes = [], spec = { clips: st.clips, cues: st.cues, now: st.now, duration: st.duration };
        let edits = [], head = '';
        // ① 離線訓練器:線上 AI 做成功過的做法(學回去的規則)、使用者教的;只認 video_* 工具,別的領域的結果不拿來用
        try {
            say(T('離線 AI ①:查離線訓練器學過的做法…', 'Offline AI ①: looking up what the offline trainer has learned…'));
            const plan = await this._otPlan(String(text), {}), ch = plan && plan.decision && plan.decision.status === 'planned' ? plan.decision.chosen : null;
            if (ch) {
                const arg = (c) => c.args || (c.rawArgs ? (() => { try { return JSON.parse(c.rawArgs); } catch (_) { return {}; } })() : {});
                const calls = ch.kind === 'cache' ? (ch.calls || []).map((c) => ({ name: c.name || c.tool, args: arg(c) })) : ch.kind === 'steps' ? (ch.steps || []).map((x) => ({ name: x.tool, args: x.args || {} })) : ch.kind === 'tool' ? [{ name: ch.tool, args: ch.args || {} }] : [];
                if (calls.length && calls.every((c) => TP.TOOLS[c.name])) { edits = calls.map((c) => TP.toOp(c.name, c.args)); via.push('trainer'); head = T('離線:離線訓練器學過這個做法', 'Offline: the offline trainer has learned this'); }
            }
        } catch (e) { notes.push(String((e && e.message) || e).slice(0, 80)); }
        // ② 計畫模板:一句話的多步驟目標(剪片頭、只保留一段、每 30 秒切一刀、全部逐字稿配音…)由程式展開成動作,數字來自句子或編輯器的狀態
        if (!edits.length) {
            say(T('離線 AI ②:套計畫模板…', 'Offline AI ②: plan templates…'));
            const pl = TP.expand(String(text), spec); if (pl) { if (pl.edits.length) { edits = pl.edits; via.push('plan'); head = T('離線:計畫模板「' + pl.label + '」展開成 ' + pl.edits.length + ' 個動作', 'Offline: plan template "' + pl.label + '" → ' + pl.edits.length + ' action(s)'); } else { pl.notes.forEach((n) => notes.push(pl.label + ':' + n)); } }
        }
        // ③ 細切 + 語意推導 + UML + CoLU 接線(通用 harness 的 video 領域):意圖切細、相對說法(前半段、最後 10 秒、第 3 句那一段、沒有字幕的地方)用編輯器的狀態推導成數字、寫成 UML 使用案例、交給單元目錄接線成 video_* 工具呼叫
        if (!edits.length && typeof FaHarnessHost !== 'undefined') {
            say(T('離線 AI ③:細切意圖、推導語意、UML 接線(CoLU)…', 'Offline AI ③: decompose the intents, derive the semantics, wire through UML (CoLU)…'));
            try {
                const h = await this._harnessRun('video', String(text), spec, { onStep: say});
                if (h.ok && h.calls.length) {
                    edits = h.calls.map((c) => TP.toOp(c.tool, c.args)).filter(Boolean); via.push('semantics'); head = T('離線:細切成 ' + h.total + ' 個意圖,CoLU 接上 ' + h.wired + '/' + h.total, 'Offline: ' + h.total + ' intent(s), CoLU wired ' + h.wired + '/' + h.total);
                    h.derived.forEach((x) => notes.push(T('推導:', 'Derived: ') + x)); if (h.wired < h.total) notes.push(T('有 ' + (h.total - h.calls.filter((c) => c.wired).length) + ' 步沒接上單元,改用該動作自己的工具', 'Some steps were not wired: the action\'s own tool is used'));
                }
                if (h.gaps && h.gaps.length) { h.gaps.forEach((g) => notes.push(T('缺:', 'Gap: ') + g)); }
            } catch (e) { notes.push(String((e && e.message) || e).slice(0, 80)); }
        }
        // ③b 意圖引擎:一句話切成子句,每個子句對到一個意圖;對不到才問離線模型一個字母(模型只選不寫)
        if (!edits.length && typeof FaEditOffline !== 'undefined') {
            say(T('離線 AI ③:用意圖引擎讀這句話…', 'Offline AI ③: intent engine…'));
            const A = this._edAi(); let r = null;
            try { r = await FaEditOffline.make(FaEditOffline.videoAdapter()).run(String(text), spec, {}, (q, opts) => A.pick(q, opts), null); } catch (e) { notes.push(String((e && e.message) || e).slice(0, 80)); }
            if (r && r.edits.length) { edits = r.edits; via.push('intent'); r.notes.forEach((n) => notes.push(n)); if (r.unmatched.length) notes.push(T('這幾句沒讀懂:', 'Not understood: ') + r.unmatched.join('、')); head = T('離線:程式讀懂了 ' + r.matched.length + ' 句', 'Offline: the program understood ' + r.matched.length + ' sentence(s)'); }
        }
        if (!edits.length) return { edits: [], notes, via };
        // ④ CoLU/UML:這些動作對到單元目錄裡的 video_* 單元(型別接線,0 次模型呼叫);沒接上的只提醒,不擋(編輯器自己的 applyEdits 才是最後一道檢查)
        const co = this._videoCoLU(edits); if (co) { via.push('colu'); notes.push(co.ok ? T('CoLU 接線:' + co.bound + '/' + co.total + ' 個動作對到單元', 'CoLU wiring: ' + co.bound + '/' + co.total + ' actions bound to units') : T('CoLU:' + co.error, 'CoLU: ' + co.error)); }
        return { edits, say: head, notes, via };
    };
    // UML 使用案例:User -> VideoEditor.video_split(at) -> …,交給單元目錄接線(catalog_bind 同一個函式);回 { ok, bound, total, valid, program } 或 null(沒有 CoLU 模組)
    M._videoCoLU = function (edits) {
        if (typeof FaUml === 'undefined' || typeof FaCatalogBind === 'undefined' || !this._unitCatalogBind) return null;
        const calls = (edits || []).map((e) => window.TwVideoPlans.toTool(e)).filter(Boolean); if (!calls.length) return null;
        const uml = 'model: VideoEdit\nactor: User\nusecase Request: User -> ' + calls.map((c) => 'VideoEditor.' + c.name + '(' + Object.keys(c.args).join(',') + ')').join(' -> ');
        try {
            const r = this._unitCatalogBind(uml, {}); if (!r.ok) return { ok: false, error: String(r.error || '').slice(0, 100) };
            const res = (r.results || [])[0] || {}, steps = res.steps || []; return { ok: true, bound: steps.filter((x) => x.unit || (x.units && x.units.length)).length, total: calls.length, valid: !!res.valid, program: res.program, uml };
        } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 100) }; }
    };
    // 線上 AI 做成功的句子 → 離線訓練器:句子裡的數字換成擷取群組、引號裡的字換成 {quoted},存成領域 edit_video 的 regex 規則(steps = video_* 工具呼叫);下次同類的句子離線也讀得懂。學不起來(數字不在句子裡)就不存。
    M._videoLearn = async function (info) {
        const g = window.TwVideoPlans.generalize(info && info.text, info && info.edits); if (!g) return { ok: false, learned: false };
        const init = await this._otRun({ action: 'init_domain', domain: 'edit_video', description: '影片編輯器(/edit-video)的說法 → video_* 編輯動作;線上 AI 做成功的句子自動學回來' }); if (init && init.ok === false) return init;
        let h = 0; for (const ch of g.expr) h = (h * 31 + ch.charCodeAt(0)) | 0; const id = 'vid_' + (h >>> 0).toString(36);
        const pattern = { id, type: 'regex', expr: g.expr, intent: String(info.text).slice(0, 60), examples: [String(info.text).slice(0, 200)], confidence: 0.9, source: 'edit-video-learned', risk: 'safe', enabled: true, hits: 0 };
        if (g.steps.length === 1) { pattern.tool = g.steps[0].tool; pattern.args = g.steps[0].args; } else { pattern.steps = g.steps; }
        const r = await this._otRun({ action: 'add_pattern', domain: 'edit_video', pattern }); return Object.assign({ learned: !!(r && r.ok) }, r);
    };

    // ───── 掛載 ─────
    M._videoHost = function (id) {
        const self = this;
        return {
            save: (p) => FaEditStore.saveProject('edit-video', id, { v: 1, spec: p, state: null }),
            putFile: async (f) => self._videoPin(await self.fileCache.put(f.name || 'file', f.type || 'application/octet-stream', f, 'uploaded')),
            loadBlob: async (fid) => { const rec = await self.fileCache.get(fid); if (!rec) throw new Error(T('檔案不在這個程式的檔案儲存裡', 'the file is not in this app\'s file storage')); return rec.blob; },
            loadFile: async (fid) => { const rec = await self.fileCache.get(fid); if (!rec) throw new Error(T('檔案不在這個程式的檔案儲存裡', 'the file is not in this app\'s file storage')); return { arrayBuffer: await rec.blob.arrayBuffer(), mimeType: rec.mimeType || rec.blob.type, filename: rec.filename }; },
            pin: (fid) => self._videoPin(fid),
            transcribe: (blob, o, report) => self._videoTranscribe(blob, o, report),
            burn: (blob, segs, report, name, opt) => self._videoBurn(blob, segs, report, name, opt),
            chatFiles: () => self._videoChatFiles(), storedFiles: () => self._videoStoredFiles(), fapFolders: () => self._videoFapFolders(),
            openEditor: (fid) => self._videoOpen({ fileId: fid }),
            voices: () => self._videoVoices(), pickVoice: (text, lang) => self._videoPickVoice(text, lang),
            synthesize: (text, voiceId, lang) => self._videoSynthesize(text, voiceId, lang),
            ai: { mode: () => self._videoAiMode(), chat: (system, user, onStep) => self._videoOnlineChat(system, user, onStep), offline: (text, st, onStep) => self._videoOffline(text, st, onStep), learn: (info) => self._videoLearn(info) }
        };
    };
    // 遠端橋接：有選「AI 在」別台機器時，ai.chat／ai.offline／ai.mode／transcribe 交給那台，其餘留本機；沒選就完全是本機
    M._videoHostRemote = function (id) {
        const self = this, local = this._videoHost(id), kind = 'edit-video', tgt = () => self._edRemoteTarget(kind, id);
        if (typeof FaRemoteEdit === 'undefined') return local;
        const call = (method, req) => { const peer = self._rg && self._rg.edit, t = tgt(); return peer ? peer.call(t, kind, id, method, [req], {}) : Promise.reject(new Error(T('還沒加入遠端群組（或已離開），請把「AI 在」改回本機。', 'Not in a remote group (any more): switch "AI on" back to this machine.'))); };
        const say = (t, f) => { if (typeof f === 'function') { try { f('🛰️ ' + t.name + ' · AI'); } catch (_) { /* */ } } };
        const out = Object.assign({}, local); out.ai = Object.assign({}, local.ai);
        out.ai.chat = (system, user, onStep) => { const t = tgt(); if (!t) return local.ai.chat(system, user, onStep); say(t, onStep); return call('ai.chat', { system, user, onStatus: onStep }).then((r) => r.text); };
        out.ai.offline = (text, st, onStep) => { const t = tgt(); if (!t) return local.ai.offline(text, st, onStep); say(t, onStep); return call('ai.offline', { text, state: st, onStatus: onStep }).then((r) => (r && r.none ? null : r)); };
        out.ai.mode = () => { const t = tgt(); return t ? call('ai.mode', {}).then((r) => r.mode) : local.ai.mode(); };
        out.transcribe = (blob, o, report) => {
            const t = tgt(); if (!t) return local.transcribe(blob, o, report); const ac = new AbortController(); say(t, report);
            return { promise: call('transcribe', { blob, o, onStatus: report, signal: ac.signal }), cancel: () => ac.abort() };
        };
        out.selfName = () => (self._rg && self._rg.room && self._rg.room.self && self._rg.room.self.name) || '';
        out.aiWhere = {
            visible: () => !!self._rg || !!self._edRemoteSel(kind, id),
            options: () => [{ value: '', label: T('本機', 'This machine') }].concat((self._rg ? self._rgTargets() : []).map((m) => ({ value: m.nodeId, label: m.name + (m.allow === false ? T('（不接受需求）', ' (not accepting)') : ''), disabled: m.allow === false }))),
            get: () => { const sel = self._edRemoteSel(kind, id); return sel ? sel.nodeId : ''; },
            set: (v) => { const m = v && self._rg ? self._rgTargets().find((x) => x.nodeId === v) : null; return self._edRemoteSet(kind, id, m ? { nodeId: m.nodeId, name: m.name } : null); },
        };
        return out;
    };
    M._videoMountOpts = function (id) {
        const self = this, fresh = this._videoFresh && this._videoFresh.get(id); if (fresh) this._videoFresh.delete(id);
        return { host: this._videoHostRemote(id), fresh, light: isLight(self) };
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
        if (o.fresh && o.fresh.request) { setTimeout(() => { try { el._ve.tab('ask'); el._ve.ask(o.fresh.request); } catch (_) { /* */ } }, 900); }
        el._ed = { destroy: () => { try { el.remove(); } catch (_) { /* */ } }, getState: () => null };
        return el;
    };

    // ───── 開啟:o.fileId＝fileCache 的檔案 id;o.file＝File;o.id＝接著原本的專案 ─────
    M._videoOpen = async function (o) {
        o = o || {}; const K = H.KINDS['edit-video'];
        if (o.id) { const proj = await FaEditStore.loadProject('edit-video', String(o.id)); if (!proj) return { ok: false, error: T('找不到這個專案:', 'no such project: ') + o.id }; this._edPush('edit-video', String(o.id), null); return { ok: true, id: String(o.id) }; }
        const id = FaEditStore.newId(K.prefix), proj = window.TwVideoEdit.newProject(T('影片', 'Video'));
        await FaEditStore.saveProject('edit-video', id, { v: 1, spec: proj, state: null });
        this._videoFresh = this._videoFresh || new Map(); this._videoFresh.set(id, { source: o.file ? { file: o.file } : o.fileId ? { id: o.fileId } : null, request: String(o.request || '').trim() });
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
