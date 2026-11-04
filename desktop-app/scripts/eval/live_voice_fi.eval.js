// 全語音Live 階段 F／G／I（真 Electron，渲染程序）：從設定頁的開啟流程開始，走真聲紋模型閘門，驗證主詞指令、別人聲音、AI 自己說話、危險動作確認。
// 替身（如實標明）：麥克風（用錄好的音檔餵進收音迴圈）、語音辨識（Whisper 模型在無人值守環境未下載，辨識結果由腳本給）、聊天送出（記錄送出的文字，不真的執行刪除）。
// 真的部分：ECAPA 聲紋模型與 onnxruntime-web 推論、IndexedDB、收音迴圈 VAD、控制器、佇列、強制錄入流程 _liveVoiceTurnOn、播放音樂與開網頁的理解閘選工具。
// 用法見記憶 reference_real_electron_eval_verification：FA_DEBUG_EVAL_FILE=<此檔> electron <desktop-app> --no-sandbox --disable-gpu --user-data-dir=<全新資料夾>
return (async () => {
    const R = { checks: [], notes: [] };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const SP = 'C:/Users/sunneo/AppData/Local/Temp/claude/1845096e089295dd/297b791e-2c3f-4f8b-b5fd-9058de6fe069/scratchpad/';
    const readB64 = async (p) => (await window.desktopAPI.rawfs.readFile(p, 'base64')).base64;
    const b64ToU8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const parseWav = (u8) => {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let p = 12;
        while (p < u8.length - 8) {
            const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]), sz = dv.getUint32(p + 4, true);
            if (id === 'data') { const n = Math.floor(sz / 2), out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = dv.getInt16(p + 8 + i * 2, true) / 32768; return out; }
            p += 8 + sz + (sz & 1);
        }
        throw new Error('WAV 沒有 data');
    };
    const clip = async (name) => ({ mono: parseWav(b64ToU8(await readB64(SP + 'clips/' + name))), rate: 16000 });
    R.notes.push('載入的程式：' + Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)).join(','));

    const saved = { rec: fa._vsRecordStart, tr: fa._liveVoiceTranscribe, sub: fa._submitChatInput, chime: fa._liveVoiceChime, st: fa._liveVoiceStatus, prompt: window.prompt, enroll: fa._vpEnrollRecorded, synth: fa._synthesizeSpeech, speak: fa._vpSpeak };
    const statuses = [], sent = [], spoken = [];
    let nextText = null, transcribeCalls = 0;
    try {
        fa._liveVoiceStatus = (m) => { statuses.push(m); };
        fa._liveVoiceChime = () => {};
        fa._vsRecordStart = async () => ({ stop: async () => ({ mono: new Float32Array(0), rate: 16000 }) });
        fa._liveVoiceTranscribe = async () => { transcribeCalls++; const t = nextText; nextText = null; return t || ''; };
        fa._submitChatInput = async (el) => { sent.push(el.value); };
        fa._vpSpeak = (t) => { spoken.push(String(t)); fa._vpMuteFor(800 + String(t).length * 350); };
        fa._vpModelOverride = b64ToU8(await readB64(SP + 'ecapa/ecapa_tdnn.onnx'));
        fa._vpStore = null;
        await fa._vpIdbSet('store', null);

        // G. 設定頁開關：沒有聲紋 → 強制錄入；取消 → 維持關閉
        let store = await fa._vpLoadStore();
        ck('起點沒有聲紋', store.needsEnrollment() === true);
        window.prompt = () => null;
        const cancelled = await fa._liveVoiceTurnOn();
        ck('沒有聲紋時取消錄入：維持關閉', cancelled.ok === false && !fa._liveVoice && /取消/.test(cancelled.error || ''), cancelled);
        window.prompt = () => '我';
        fa._vpEnrollRecorded = async (name) => fa._vpEnrollFrom(name, await clip('T1_300.wav'));
        const on = await fa._liveVoiceTurnOn();
        store = await fa._vpLoadStore();
        ck('強制錄入成功後才開啟收音（聲紋 1 筆）', on.ok === true && !!fa._liveVoice && store.count() === 1, { on, count: store.count() });
        ck('設定頁開關預設仍是關閉', JSON.parse(JSON.stringify(fa.advancedSettings)).liveVoiceEnabled === false || fa.advancedSettings.liveVoiceEnabled === false, fa.advancedSettings.liveVoiceEnabled);
        await sleep(30);

        const loop = () => fa._liveVoice.loop;
        const say = async (name, text) => {   // 餵一段音檔＋1 秒靜音，等處理完
            nextText = text;
            const c = await clip(name);
            loop().ingest(c.mono, c.rate); loop().ingest(new Float32Array(16000), 16000);
            const t0 = Date.now();
            while (Date.now() - t0 < 30000 && !loop().idle()) await sleep(100);
            await sleep(400);
        };

        // 錄入後 AI 唸了「已將聲紋記錄為 ID 1」，這段時間收音本來就靜音（自我靜音正常行為）；評估不等它，直接清掉。
        fa._vpMuteUntil = 0;
        // I1. 本人說「AI 播放音樂」會執行
        await say('T1_900.wav', 'AI 播放音樂');
        R.notes.push('第一句後統計：' + JSON.stringify(loop().stats()) + '，辨識呼叫 ' + transcribeCalls + '，狀態 ' + JSON.stringify(statuses.slice(-3)));
        ck('本人說「AI 播放音樂」→ 送出「播放音樂」', sent.length === 1 && sent[0] === '播放音樂', sent);
        const g = FaIntentGate.gate(sent[0] || '', {});
        ck('送出的指令經理解閘選到音樂播放工具 midi_play', g.openTool === 'midi_play', g.openTool);
        const gw = FaIntentGate.gate('瀏覽器打開 https://example.com', {});
        ck('「瀏覽器打開」選 browser_create_tab 且自己開的自己關', gw.openTool === 'browser_create_tab' && gw.closeWhenDone === true && gw.openArgs.keep_open === false, gw);

        // I2. 別人聲音被無視（不同講者：巧虎片段；辨識根本不會被呼叫）
        const callsBefore = transcribeCalls, sentBefore = sent.length;
        await say('K5_5.wav', 'AI 播放音樂');
        ck('別人的聲音被無視（沒送出、沒辨識）', sent.length === sentBefore && transcribeCalls === callsBefore, { sent: sent.length, calls: transcribeCalls - callsBefore });

        // I3. AI 自己說話時不被收進去
        fa._vpMuteFor(5000);
        const callsB2 = transcribeCalls;
        await say('T1_900.wav', 'AI 開啟網頁');
        ck('AI 自己說話的時段（靜音中）本人聲音也丟棄', sent.length === sentBefore && transcribeCalls === callsB2, { sent: sent.length, calls: transcribeCalls - callsB2 });
        fa._vpMuteUntil = 0;

        // I4. 「AI 刪除某檔」要求確認，確認前不執行
        await say('T1_900.wav', 'AI 刪除報告檔');
        ck('刪除指令確認前不送出', sent.length === sentBefore, sent);
        ck('有唸出確認提問', spoken.some((t) => /確認/.test(t)), spoken);
        fa._vpMuteUntil = 0;
        await say('T1_900.wav', 'AI 確認');
        await sleep(300);
        ck('說「確認」後才送出刪除指令', sent[sent.length - 1] === '刪除報告檔', sent);
        // 取消路徑
        fa._vpMuteUntil = 0;
        await say('T1_900.wav', 'AI 刪除另一個檔');
        fa._vpMuteUntil = 0;
        const n1 = sent.length;
        await say('T1_900.wav', 'AI 取消');
        await sleep(200);
        ck('確認提問後說「取消」不執行', sent.length === n1, sent);

        // F. 唸故事：專案 TTS 失敗時退回瀏覽器內建語音，且收音靜音
        fa._synthesizeSpeech = async () => ({ ok: false, error: '（評估替身）專案語音合成不可用' });
        fa._vpMuteUntil = 0;
        const sp = await fa._liveVoiceSpeakText('從前從前有一隻小兔子住在森林裡。', { isCancelled: () => false });
        ck('專案 TTS 不可用 → 退回內建語音並設靜音', sp.ok === true && sp.engine === 'speechSynthesis' && Date.now() < fa._vpMuteUntil, sp);
        R.notes.push('唸故事的專案 TTS 真實合成（Kokoro／Edge）未在此評估測：需要模型下載或網路，標未驗證');

        await fa._liveVoiceStop();
        ck('停止後迴圈已清掉', !fa._liveVoice);
    } catch (e) {
        R.checks.push({ name: '未預期的例外', ok: false, extra: String((e && e.stack) || e).slice(0, 800) });
    } finally {
        fa._vsRecordStart = saved.rec; fa._liveVoiceTranscribe = saved.tr; fa._submitChatInput = saved.sub; fa._liveVoiceChime = saved.chime;
        fa._liveVoiceStatus = saved.st; window.prompt = saved.prompt; fa._vpEnrollRecorded = saved.enroll; fa._synthesizeSpeech = saved.synth; fa._vpSpeak = saved.speak; fa._vpModelOverride = null;
        if (fa._liveVoice) { try { fa._liveVoice.controller.setEnabled(false); } catch (_) {} fa._liveVoice = null; }
    }
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] live_voice_fi ' + JSON.stringify(R));
    return R;
})();
