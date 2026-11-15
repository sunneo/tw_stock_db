// /media-transcribe 的解碼退路（純函式，無 DOM、無網路）。
// 流程：先看檔頭判斷格式 → 瀏覽器原生解碼（Web Audio decodeAudioData）→ 解不了才用 ffmpeg.wasm
// 轉成 16 kHz 單聲道 PCM wav 再解碼。每一步失敗自動重試一次；兩次都失敗才回報哪一步、錯誤、耗時。
// 所有外部能力（原生解碼、同意、載入、轉檔、時鐘、記錄）都由呼叫端注入，方便用假的解碼器與假的 ffmpeg 測試。
// 注意：這裡不決定要不要下載；同意由 getConsent 回傳，沒同意就不載入、不轉、直接失敗。

const FaTranscodeFallback = (function () {
    const FFMPEG_MAX_INPUT_BYTES = 300 * 1024 * 1024; // 輸入上限：ffmpeg.wasm 把整個檔案複製進記憶體，超過就先擋下來
    const FFMPEG_APPROX_CORE_MB = 30; // ffmpeg-core.wasm 大小估計（尚未實測；同意卡片會寫明是估計值）
    const WHISPER_SAMPLE_RATE = 16000;

    function msgOf(e) { return String((e && e.message) || e || '未知錯誤'); }

    // 檔頭魔數判斷格式（只看前幾個位元組，不靠副檔名）
    function sniffFormat(head) {
        const b = head instanceof Uint8Array ? head : new Uint8Array(head || []);
        const s = (from, len) => { let out = ''; for (let i = from; i < from + len && i < b.length; i++) out += String.fromCharCode(b[i]); return out; };
        if (b.length >= 12 && s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav';
        if (s(0, 3) === 'ID3') return 'mp3';
        if (b.length >= 2 && b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return ((b[1] & 0xF6) === 0xF0) ? 'aac' : 'mp3';
        if (s(0, 4) === 'OggS') return 'ogg';
        if (s(0, 4) === 'fLaC') return 'flac';
        if (b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'webm';
        if (s(4, 4) === 'ftyp') return s(8, 4) === 'M4A ' ? 'm4a' : 'mp4';
        if (s(0, 5) === '#!AMR') return 'amr';
        if (b.length >= 8 && b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75) return 'asf'; // wma／wmv
        return 'unknown';
    }

    // 這些格式瀏覽器幾乎一定解不了，先跳過原生解碼，省一次失敗的等待
    function skipNative(format) { return format === 'amr' || format === 'asf'; }

    // ffmpeg 參數：-vn 丟掉影像軌（影片只抽音軌）；-map 0:a:0 沒有音軌就直接失敗；輸出 16 kHz 單聲道 pcm_s16le wav
    function ffmpegArgs(inName, outName) {
        return ['-hide_banner', '-loglevel', 'error', '-i', inName, '-vn', '-map', '0:a:0',
            '-ac', '1', '-ar', String(WHISPER_SAMPLE_RATE), '-c:a', 'pcm_s16le', '-y', outName];
    }

    function mb(n) { return Math.round((n / 1048576) * 10) / 10; }

    function checkSize(bytes, limit) {
        const lim = limit || FFMPEG_MAX_INPUT_BYTES;
        if (bytes <= lim) return { ok: true };
        return {
            ok: false,
            message: `檔案 ${mb(bytes)} MB，超過 ffmpeg.wasm 的輸入上限 ${mb(lim)} MB。建議：先用其他工具只留音軌（16 kHz 單聲道 wav 或 mp3）再上傳，或把影片剪短後再轉錄。`,
        };
    }

    // 同意卡片的內容：來源、檔名、大小都要寫清楚（大小是估計值）
    function consentText(o) {
        return '轉錄這個格式需要 ffmpeg.wasm（瀏覽器直接解不了）。\n\n' +
            '來源：' + o.jsUrl + '\n' +
            '　　　' + o.coreUrl + '\n' +
            '大小：核心檔約 ' + (o.approxMb || FFMPEG_APPROX_CORE_MB) + ' MB（估計值，尚未實測）\n\n' +
            '同意後下載一次並由瀏覽器快取；不同意就不轉、直接回報。音訊只在本機處理，不會上傳到任何伺服器。';
    }

    function consentSignature(jsUrl, coreUrl) { return 'v1|' + jsUrl + '|' + coreUrl; }

    // 一步一步跑，失敗自動重試（retries 次）；回傳成功值或具體失敗資訊
    async function runStep(step, fn, o) {
        const now = o.now || (() => Date.now());
        const log = o.log || (() => {});
        const retries = typeof o.retries === 'number' ? o.retries : 1;
        const t0 = now();
        const errors = [];
        for (let attempt = 1; attempt <= retries + 1; attempt++) {
            try {
                const value = await fn();
                return { ok: true, value, attempts: attempt, elapsedMs: now() - t0 };
            } catch (e) {
                errors.push(msgOf(e));
                const more = attempt <= retries ? '，自動重試一次…' : '';
                log(`${step} 第 ${attempt} 次失敗：${msgOf(e)}${more}`);
            }
        }
        return { ok: false, step, error: errors[errors.length - 1], errors, attempts: retries + 1, elapsedMs: now() - t0 };
    }

    function failMessage(f) {
        return `${f.step}失敗（已試 ${f.attempts} 次，耗時 ${(f.elapsedMs / 1000).toFixed(1)} 秒）：${f.error}`;
    }

    // 主流程。opts: { head(Uint8Array 檔頭), size, decodeNative(), decodeWav(bytes), getConsent(), loadFfmpeg(), transcode(), log(msg), now(), maxInputBytes }
    // 回傳 { ok:true, route:'native'|'ffmpeg-wasm', value, format, elapsedMs } 或 { ok:false, step, message, nativeError }
    async function decodeForWhisper(opts) {
        const now = opts.now || (() => Date.now());
        const log = opts.log || (() => {});
        const t0 = now();
        const format = sniffFormat(opts.head);
        let nativeError = null;
        if (!skipNative(format)) {
            try {
                const value = await opts.decodeNative();
                return { ok: true, route: 'native', value, format, elapsedMs: now() - t0 };
            } catch (e) {
                nativeError = msgOf(e);
                log(`瀏覽器直接解碼失敗（格式 ${format}）：${nativeError}，改用 ffmpeg.wasm 退路…`);
            }
        } else {
            log(`格式 ${format} 瀏覽器不支援，直接改用 ffmpeg.wasm 退路…`);
        }
        const size = checkSize(opts.size, opts.maxInputBytes);
        if (!size.ok) return { ok: false, step: '檢查檔案大小', message: size.message, nativeError, format };
        const consent = await opts.getConsent();
        if (!consent) {
            return { ok: false, step: '取得下載同意', message: '你沒有同意下載 ffmpeg.wasm，這個格式無法轉錄。' + (nativeError ? '（瀏覽器原生解碼錯誤：' + nativeError + '）' : ''), nativeError, format };
        }
        const load = await runStep('載入 ffmpeg.wasm', opts.loadFfmpeg, { retries: 1, now, log });
        if (!load.ok) return { ok: false, step: load.step, message: failMessage(load), nativeError, format };
        const tr = await runStep('ffmpeg 轉成 16 kHz 單聲道 wav', opts.transcode, { retries: 1, now, log });
        if (!tr.ok) return { ok: false, step: tr.step, message: failMessage(tr), nativeError, format };
        const dec = await runStep('解碼轉檔後的 wav', () => opts.decodeWav(tr.value), { retries: 0, now, log });
        if (!dec.ok) return { ok: false, step: dec.step, message: failMessage(dec), nativeError, format };
        return { ok: true, route: 'ffmpeg-wasm', value: dec.value, format, elapsedMs: now() - t0, nativeError };
    }

    return {
        FFMPEG_MAX_INPUT_BYTES, FFMPEG_APPROX_CORE_MB, WHISPER_SAMPLE_RATE,
        sniffFormat, skipNative, ffmpegArgs, checkSize, consentText, consentSignature,
        runStep, failMessage, decodeForWhisper,
    };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FaTranscodeFallback;
