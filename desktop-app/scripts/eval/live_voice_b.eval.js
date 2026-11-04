// 全語音Live 階段 B（真 Electron，渲染程序）：收音迴圈→辨識→主詞／取消指令→佇列（先進先出）→送進聊天，以及聲紋未完成前不能從開關啟用。
// 注意：麥克風與辨識模型在無人值守環境不可用，所以這裡「如實」做法是：麥克風用替身（不擷取真聲音）、辨識用替身文字，
// 語音區塊（高低能量）用合成音，只驗證 VAD、排班、主詞、取消、提示音與送出的邏輯鏈。真實麥克風與真實辨識另外測。
return (async () => {
    const R = { checks: [], notes: [] };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rate = 48000;
    const tone = (ms) => { const n = Math.round(ms * rate / 1000), a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / rate); return a; };
    const silence = (ms) => new Float32Array(Math.round(ms * rate / 1000));

    // 先確認真麥克風在這個環境是否可用（只記錄，不影響通過與否）
    try {
        const devs = navigator.mediaDevices && navigator.mediaDevices.enumerateDevices ? await navigator.mediaDevices.enumerateDevices() : [];
        R.notes.push('audioinput 裝置數：' + devs.filter((d) => d.kind === 'audioinput').length);
    } catch (e) { R.notes.push('enumerateDevices 失敗：' + e.message); }

    const saved = {
        vsRecordStart: fa._vsRecordStart, transcribe: fa._liveVoiceTranscribe, submit: fa._submitChatInput,
        chime: fa._liveVoiceChime, status: fa._liveVoiceStatus, ctx: fa._activeCtx,
    };
    const statuses = [], chimes = [], sent = [], transcripts = [];
    let nextText = 0;
    const script = ['AI 第一件事', '今天天氣很好', 'AI 第二件事', 'AI 取消前一個指令', 'AI 第三件事', 'AI 停止前面的動作'];
    try {
        // 替身：麥克風（不開真裝置，但保留 onChunk 介面）、辨識（回傳腳本文字）、聊天送出（模擬一輪回覆 300ms 或直到被停止）、提示音（只計數）。
        fa._vsRecordStart = async () => ({ stop: async () => {} });
        fa._liveVoiceTranscribe = async () => { transcripts.push(script[nextText]); return script[nextText++] || ''; };
        fa._liveVoiceChime = () => { chimes.push(Date.now()); };
        fa._liveVoiceStatus = (m) => { statuses.push(m); };
        const t0all = Date.now(), tl = [];
        let respVal = false;
        const fakeCtx = { stopRequested: false, currentAbortController: null };
        Object.defineProperty(fakeCtx, 'isResponding', { get() { return respVal; }, set(v) { respVal = v; tl.push('ctx.isResponding=' + v + '@' + (Date.now() - t0all)); }, enumerable: true });
        // _ctx 是 getter（讀 _activeCtx），要換的是 _activeCtx；直接寫 _ctx 會被忽略。
        fa._activeCtx = fakeCtx;
        R.notes.push('診斷 _ctx 是否被替換：' + (fa._ctx === fakeCtx));
        fa._submitChatInput = async (el) => {
            sent.push(el.value);
            const ac = new AbortController(); fakeCtx.currentAbortController = ac; fakeCtx.isResponding = true; fakeCtx.stopRequested = false;
            const dur = el.value.indexOf('停止') >= 0 ? 0 : 300;
            if (el.value === '第三件事') {
                const t0 = Date.now();
                while (Date.now() - t0 < 2000 && !fakeCtx.stopRequested) await sleep(20);
                R.notes.push('第三件事被停止後 abort 訊號：' + ac.signal.aborted + '，stopRequested：' + fakeCtx.stopRequested);
                fakeCtx.isResponding = false; return;
            }
            await sleep(dur); fakeCtx.isResponding = false;
        };

        // 1. 聲紋未完成前，使用者開關不能啟用
        const gate = fa._liveVoiceStart();
        ck('聲紋未完成前不能從使用者開關啟用', gate && gate.ok === false && /聲紋/.test(gate.error || ''), gate);
        ck('未啟用時沒有殘留的收音迴圈', !fa._liveVoice);

        // 2. 以測試身分啟動，確認主詞預設 AI
        const started = fa._liveVoiceStart({ skipVoiceprint: true });
        ck('測試身分可以啟動', started && started.ok === true, started);
        await sleep(30);
        ck('啟動後狀態顯示收音中（主詞 AI）', statuses.some((s) => /收音中（主詞：AI）/.test(s)), statuses.slice(-1)[0]);

        // 3. 逐句餵入合成音（說話 600ms＋靜音 900ms），每句都會切出一段、送進替身辨識
        const utter = async () => { fa._liveVoice.loop.ingest(tone(600), rate); fa._liveVoice.loop.ingest(silence(900), rate); await sleep(15); };
        await utter(); // 第一件事（會開始跑，持續 300ms）
        await utter(); // 今天天氣很好（沒有主詞，忽略）
        await utter(); // 第二件事（排隊）
        await utter(); // 取消前一個指令（取消排隊中的第二件事）
        await sleep(700);
        ck('辨識依序收到每一句（4 句）', transcripts.length === 4, transcripts);
        ck('沒有主詞的一句不送出', !sent.some((s) => /天氣/.test(s)), sent);
        ck('第一件事送出；第二件事被取消不送出', sent.length === 1 && sent[0] === '第一件事', sent);
        ck('排入提示音：兩個有效指令各一次', chimes.length === 2, chimes.length);
        ck('狀態顯示取消結果', statuses.some((s) => /已取消「第二件事」/.test(s)), statuses.filter((s) => /取消/.test(s)));

        // 4. 停止前面的動作：第三件事開始跑後，送出停止指令，應該要 abort 這一輪
        await utter(); // 第三件事（開始跑，最多 2 秒）
        await sleep(100);
        await utter(); // 停止前面的動作
        await sleep(400);
        R.notes.push('診斷 時間軸：' + tl.join(' | ').slice(0, 700));
        R.notes.push('診斷 佇列狀態：' + JSON.stringify(fa._liveVoice && fa._liveVoice.queue.items()));
        R.notes.push('診斷 佇列紀錄最後幾筆：' + JSON.stringify((fa._liveVoice && fa._liveVoice.queue.log()) || []).slice(-600));
        R.notes.push('診斷 狀態最後幾則：' + JSON.stringify(statuses.slice(-4)));
        R.notes.push('診斷 送出：' + JSON.stringify(sent));
        ck('停止指令會讓正在跑的那一輪被 abort', R.notes.some((n) => /abort 訊號：true/.test(n)), R.notes.slice(-1)[0]);

        // 5. 停止收音
        await fa._liveVoiceStop();
        ck('停止後迴圈已清掉', !fa._liveVoice);
        ck('停止後狀態顯示已停止', statuses.slice(-1)[0] === '已停止', statuses.slice(-1)[0]);
    } catch (e) {
        R.checks.push({ name: '未預期的例外', ok: false, extra: String((e && e.stack) || e) });
    } finally {
        fa._vsRecordStart = saved.vsRecordStart; fa._liveVoiceTranscribe = saved.transcribe; fa._submitChatInput = saved.submit;
        fa._liveVoiceChime = saved.chime; fa._liveVoiceStatus = saved.status; fa._activeCtx = saved.ctx;
        if (fa._liveVoice) { try { fa._liveVoice.controller.setEnabled(false); } catch (_) {} fa._liveVoice = null; }
    }
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] live_voice_b ' + JSON.stringify(R));
    return R;
})();
