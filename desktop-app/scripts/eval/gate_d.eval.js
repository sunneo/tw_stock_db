// 聲紋閘門與靜音閘（階段 D，真 Electron）：真 ECAPA 模型比對、真收音迴圈切段、真控制器與佇列。
// 替身（如實標明）：麥克風用測試音檔（餵進 loop.ingest）；辨識文字與聊天送出為替身（真辨識與真聊天不在本評估範圍）。
return (async () => {
    const R = { checks: [], notes: [] };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const SP = 'C:/Users/sunneo/AppData/Local/Temp/claude/1845096e089295dd/297b791e-2c3f-4f8b-b5fd-9058de6fe069/scratchpad/';
    const readB64 = async (p) => (await window.desktopAPI.rawfs.readFile(p, 'base64')).base64;
    const b64ToU8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const parseWav = (u8) => {
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let p = 12;
        while (p < u8.length - 8) {
            const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]), sz = dv.getUint32(p + 4, true);
            if (id === 'data') { const n = Math.floor(sz / 2), out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = dv.getInt16(p + 8 + i * 2, true) / 32768; return out; }
            p += 8 + sz + (sz & 1);
        }
        throw new Error('WAV 沒有 data');
    };
    const clip = async (name) => parseWav(b64ToU8(await readB64(SP + 'clips/' + name)));
    const silence = (sec) => new Float32Array(Math.round(16000 * sec));

    const saved = { rec: fa._vsRecordStart, tr: fa._liveVoiceTranscribe, submit: fa._submitChatInput, chime: fa._liveVoiceChime, status: fa._liveVoiceStatus };
    const submitted = []; let trCalls = 0; let trText = 'AI 播放音樂';
    try {
        fa._liveVoiceStatus = () => {};
        fa._liveVoiceChime = () => {};
        fa._vsRecordStart = async () => ({ stop: async () => ({ mono: new Float32Array(0), rate: 16000 }) });
        fa._liveVoiceTranscribe = async () => { trCalls++; return trText; };
        fa._submitChatInput = async (el) => { submitted.push(el.value); };
        fa._vpModelOverride = b64ToU8(await readB64(SP + 'ecapa/ecapa_tdnn.onnx'));
        fa._vpStore = null;
        await fa._vpIdbSet('store', null);
        // 先錄入講師（同一位講者的一段）
        const enr = await fa._vpEnrollFrom('講師', { mono: await clip('T1_300.wav'), rate: 16000 });
        ck('錄入講師聲紋（閘門的基準）', enr.ok === true, enr);

        const started = fa._liveVoiceStart({ skipVoiceprint: true });
        ck('收音迴圈啟動（閘門已接上）', started.ok === true, started);
        const lp = fa._liveVoice.loop;
        const waitIdle = async () => { const t0 = Date.now(); while (Date.now() - t0 < 60000 && !lp.idle()) await sleep(100); };

        // 1. 本人說的話：應該通過閘門、送去辨識、送進聊天（主詞後的指令）
        const before1 = trCalls;
        lp.ingest(await clip('T1_900.wav'), 16000); lp.ingest(silence(1.2), 16000);
        await waitIdle();
        ck('本人（同一講者）的話：通過閘門並辨識', trCalls === before1 + 1, { trCalls, before1 });
        ck('本人的指令送進聊天（主詞後的內容）', submitted.length === 1 && submitted[0] === '播放音樂', submitted);

        // 2. 不是本人（角色配音）：應該被閘門擋下，不辨識、不送出
        const before2 = trCalls, rej0 = lp.stats().rejected;
        trText = 'AI 開網頁';
        lp.ingest(await clip('K5_5.wav'), 16000); lp.ingest(silence(1.2), 16000);
        await waitIdle();
        ck('不是本人的聲音：被閘門擋下（rejected 計數增加）', lp.stats().rejected === rej0 + 1, lp.stats());
        ck('不是本人的聲音：不辨識、不送出', trCalls === before2 && submitted.length === 1, { trCalls, before2, submitted });

        // 3. AI 自己說話時的靜音閘：標記靜音中，本人的聲音也要丟掉
        const before3 = trCalls, muted0 = lp.stats().muted;
        fa._vpMuteFor(5000);
        lp.ingest(await clip('T1_900.wav'), 16000); lp.ingest(silence(1.2), 16000);
        await waitIdle();
        ck('AI 說話期間（靜音閘）：音訊丟掉、不辨識', trCalls === before3 && lp.stats().muted > muted0, lp.stats());
        fa._vpMuteUntil = 0;

        // 4. 靜音結束後，本人的話恢復可用
        const before4 = trCalls;
        trText = 'AI 播放音樂';
        lp.ingest(await clip('T1_900.wav'), 16000); lp.ingest(silence(1.2), 16000);
        await waitIdle();
        ck('靜音結束後本人的話恢復可用', trCalls === before4 + 1, { trCalls, before4 });

        await fa._liveVoiceStop();
        ck('停止後迴圈清掉', !fa._liveVoice);
    } catch (e) {
        R.checks.push({ name: '未預期的例外', ok: false, extra: String((e && e.stack) || e).slice(0, 800) });
    } finally {
        fa._vsRecordStart = saved.rec; fa._liveVoiceTranscribe = saved.tr; fa._submitChatInput = saved.submit;
        fa._liveVoiceChime = saved.chime; fa._liveVoiceStatus = saved.status; fa._vpModelOverride = null; fa._vpMuteUntil = 0;
        if (fa._liveVoice) { try { fa._liveVoice.controller.setEnabled(false); } catch (_) {} fa._liveVoice = null; }
    }
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] gate_d ' + JSON.stringify(R));
    return R;
})();
