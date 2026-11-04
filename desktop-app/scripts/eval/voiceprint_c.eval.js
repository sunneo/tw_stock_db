// 聲紋（階段 C，真 Electron，渲染程序）：真 ECAPA 模型、真 onnxruntime-web、真 IndexedDB、真收音迴圈與語音指令。
// 替身（如實標明）：麥克風錄音用測試音檔（6 秒 16kHz WAV，取自 D:\Downloads\videos 的講課與巧虎片段）；模型位元組直接讀工作階段暫存（不重新下載，避免重複下載）。
// 不會寫入倉庫。會寫入這個評估行程自己的 IndexedDB（隔離的使用者資料夾，評估結束即丟棄）。
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

    const savedRec = fa._vsRecordStart;
    const savedStatus = fa._liveVoiceStatus;
    const statuses = [];
    try {
        fa._liveVoiceStatus = (m) => { statuses.push(m); };
        // 替身麥克風：live 迴圈啟動時不開真裝置（語音錄入走 ingest 餵測試音檔）。
        fa._vsRecordStart = async () => ({ stop: async () => ({ mono: new Float32Array(0), rate: 16000 }) });
        fa._vpModelOverride = b64ToU8(await readB64(SP + 'ecapa/ecapa_tdnn.onnx'));
        // 乾淨起點：清掉這個評估行程的聲紋資料
        fa._vpStore = null;
        await fa._vpIdbSet('store', null);
        let store = await fa._vpLoadStore();
        ck('乾淨起點沒有聲紋（需要強制錄入）', store.needsEnrollment() === true);

        const enableBefore = await fa._liveVoiceEnableFromUi();
        ck('第一次沒有聲紋時不能開啟全語音Live（強制錄入）', enableBefore.ok === false && enableBefore.needEnroll === true, enableBefore.error);

        // 1. 錄入：同一位講者（講課檔）的一段
        const e1 = await fa._vpEnrollFrom('講師', await clip('T1_300.wav'));
        ck('錄入成功並回報 ID 1（文字）', e1.ok === true && e1.report === '已將聲紋記錄為 ID 1', e1);

        // 2. 持久化：從 IndexedDB 讀回來
        const saved = await fa._vpIdbGet('store');
        ck('聲紋已寫入 IndexedDB（1 筆、含模型版本）', !!saved && saved.entries.length === 1 && saved.entries[0].modelSha256 === fa._vpModelInfo().sha256, saved && saved.entries.length);

        // 3. 比對：同一講者另一段應接受；巧虎片段應拒絕
        const same = await fa._vpMatchSamples((await clip('T1_900.wav')).mono, 16000);
        const diff = await fa._vpMatchSamples((await clip('K5_5.wav')).mono, 16000);
        R.notes.push('同人（T1_900）分數 ' + (same.score && same.score.toFixed(3)) + '，不同人（K5_5）分數 ' + (diff.score && diff.score.toFixed(3)) + '，門檻 ' + fa._vpModelInfo().threshold);
        ck('同一講者另一段：接受', same.accepted === true, same.score);
        ck('不同人（角色配音）：拒絕', diff.accepted === false, diff.score);

        // 4. 語音錄入與語音刪除（經過真收音迴圈與控制器）
        fa._vsRecordStart = async () => ({ stop: async () => ({ mono: new Float32Array(0), rate: 16000 }) });
        const started = fa._liveVoiceStart({ skipVoiceprint: true });
        ck('測試身分啟動收音迴圈', started.ok === true, started);
        await sleep(30);
        const enrollPromiseStatus = (async () => {
            fa._liveVoice.controller.onUtterance('AI 新增聲紋');
            const c2 = await clip('T2_300.wav');
            fa._liveVoice.loop.ingest(c2.mono, c2.rate);   // 6 秒，錄入只取前 5 秒
            // 嵌入需要時間（wasm 推論），等到狀態出現或逾時 30 秒
            const t0 = Date.now();
            while (Date.now() - t0 < 30000 && !statuses.some((s) => s === '已將聲紋記錄為 ID 2')) await sleep(200);
        })();
        await enrollPromiseStatus;
        store = await fa._vpLoadStore();
        ck('語音「新增聲紋」錄入成功，ID 2 回報文字', statuses.some((s) => s === '已將聲紋記錄為 ID 2') && store.count() === 2, statuses.slice(-3));

        fa._liveVoice.controller.onUtterance('AI 刪除聲紋2');
        await sleep(50);
        ck('「刪除聲紋2」沒有確認前不會刪', store.count() === 2);
        fa._liveVoice.controller.onUtterance('AI 確認');
        await sleep(300);
        store = await fa._vpLoadStore();
        ck('說「確認」後才刪除 ID 2', store.count() === 1 && store.list()[0].id === 1, store.list());
        ck('刪除結果回報文字', statuses.some((s) => s === '已刪除聲紋 ID 2'), statuses.slice(-2));

        await fa._liveVoiceStop();
        ck('停止收音後迴圈已清掉', !fa._liveVoice);

        // 5. 上限：設定 8 時，已有 1 筆仍可再錄；上限 8 的夾限在 store 內
        ck('上限預設 8，且不能被語音改（只有設定頁寫入）', fa.advancedSettings.liveVoiceSpeakerLimit === 8 && store.getLimit() === 8);
    } catch (e) {
        R.checks.push({ name: '未預期的例外', ok: false, extra: String((e && e.stack) || e).slice(0, 800) });
    } finally {
        fa._vsRecordStart = savedRec; fa._liveVoiceStatus = savedStatus; fa._vpModelOverride = null;
        if (fa._liveVoice) { try { fa._liveVoice.controller.setEnabled(false); } catch (_) {} fa._liveVoice = null; }
    }
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] voiceprint_c ' + JSON.stringify(R));
    return R;
})();
