// 聲紋門檻量測（真 Electron）：用 ECAPA 模型對一組 6 秒測試音檔算嵌入，回傳嵌入（由 node 端算同人／不同人分數）。
// 音檔來源與數量見 scripts/voice-tests/voiceprint_measure.js（它負責準備 WAV 與列出名單）。
// 只讀檔，不寫入倉庫。
return (async () => {
    const R = { checks: [], notes: [], emb: {} };
    const ck = (name, ok, extra) => R.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });
    const REPO = 'D:/Downloads/videos-嗨投資-desktop-app/desktop-app/';
    const SP = 'C:/Users/sunneo/AppData/Local/Temp/claude/1845096e089295dd/297b791e-2c3f-4f8b-b5fd-9058de6fe069/scratchpad/';
    const MODEL_PATH = SP + 'ecapa/ecapa_tdnn.onnx';
    const CLIPS = (window.__faMeasureClips || []);
    const useCmn = window.__faMeasureCmn !== false;
    try {
        const readText = async (p) => (await window.desktopAPI.rawfs.readFile(p, 'utf8')).text;
        const fbSrc = await readText(REPO + 'renderer/src/voice/fbank.js');
        const ecSrc = await readText(REPO + 'renderer/src/voice/ecapa_embed.js');
        const load = (src) => { const m = { exports: {} }; new Function('module', 'exports', src)(m, m.exports); return m.exports; };
        const FB = load(fbSrc), EC = load(ecSrc);
        const b64 = async (p) => (await window.desktopAPI.rawfs.readFile(p, 'base64')).base64;
        const mb = await window.desktopAPI.rawfs.readFile(MODEL_PATH, 'base64');
        const bin = atob(mb.base64); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs');
        ort.env.wasm.numThreads = 1;
        const sess = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
        const emb = EC.createEmbedder({ ort: ort, session: sess, fbank: FB, cmn: useCmn });
        R.notes.push('cmn=' + useCmn + '；模型已載入');
        const parseWavMono16 = (u8) => {
            const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
            let p = 12;
            while (p < u8.length - 8) {
                const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
                const sz = dv.getUint32(p + 4, true);
                if (id === 'data') {
                    const n = Math.floor(sz / 2), out = new Float32Array(n);
                    for (let i = 0; i < n; i++) out[i] = dv.getInt16(p + 8 + i * 2, true) / 32768;
                    return out;
                }
                p += 8 + sz + (sz & 1);
            }
            throw new Error('WAV 沒有 data 區塊');
        };
        for (const name of CLIPS) {
            const u8 = Uint8Array.from(atob(await b64(SP + 'clips/' + name)), (c) => c.charCodeAt(0));
            const x = parseWavMono16(u8);
            let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
            const rms = Math.sqrt(s / x.length);
            const v = await emb.embed(x);
            R.emb[name] = { rms: +rms.toFixed(5), v: Array.from(v, (t) => +t.toFixed(6)) };
        }
        ck('全部音檔都算出 192 維嵌入', Object.keys(R.emb).length === CLIPS.length && Object.values(R.emb).every((o) => o.v.length === 192), Object.keys(R.emb).length);
    } catch (e) {
        R.checks.push({ name: '量測過程例外', ok: false, extra: String((e && e.stack) || e).slice(0, 600) });
    }
    R.pass = R.checks.every((c) => c.ok);
    console.log('[eval-file] ecapa_measure ' + JSON.stringify(R));
    return R;
})();
