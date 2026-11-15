// node scripts/transcode-tests/transcode_fallback_core.test.js -- /media-transcribe 解碼退路（假的解碼器與假的 ffmpeg）
const T = require('../../renderer/src/media/transcode_fallback_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const enc = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
const fakeNow = () => { let t = 0; return () => (t += 100); };
const silentLog = () => {};

// 檔頭判斷
check('sniff wav', T.sniffFormat(enc('RIFF\x00\x00\x00\x00WAVEfmt ')) === 'wav');
check('sniff mp3 id3', T.sniffFormat(enc('ID3\x03\x00\x00\x00\x00\x00\x00\x00')) === 'mp3');
check('sniff mp3 frame', T.sniffFormat(Uint8Array.from([0xFF, 0xFB, 0x90, 0x00])) === 'mp3');
check('sniff aac adts', T.sniffFormat(Uint8Array.from([0xFF, 0xF1, 0x50, 0x80])) === 'aac');
check('sniff m4a brand', T.sniffFormat(enc('\x00\x00\x00\x20ftypM4A \x00\x00')) === 'm4a');
check('sniff mp4 brand', T.sniffFormat(enc('\x00\x00\x00\x20ftypisom\x00\x00')) === 'mp4');
check('sniff amr', T.sniffFormat(enc('#!AMR\n')) === 'amr');
check('sniff wma(asf)', T.sniffFormat(Uint8Array.from([0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11])) === 'asf');
check('sniff ogg', T.sniffFormat(enc('OggS\x00')) === 'ogg');
check('sniff unknown', T.sniffFormat(enc('hello world')) === 'unknown');
check('skip native for amr/asf only', T.skipNative('amr') && T.skipNative('asf') && !T.skipNative('m4a') && !T.skipNative('mp3'));

// ffmpeg 參數：丟影像軌、單聲道、16 kHz、pcm_s16le
const args = T.ffmpegArgs('in.bin', 'out.wav');
check('ffmpeg args drop video', args.includes('-vn'), args);
check('ffmpeg args mono 16k pcm', args.join(' ').includes('-ac 1 -ar 16000 -c:a pcm_s16le'), args);
check('ffmpeg args map first audio', args.join(' ').includes('-map 0:a:0'), args);

// 大小上限
const big = T.checkSize(400 * 1024 * 1024);
check('size over limit rejected', big.ok === false && /400 MB/.test(big.message) && /300 MB/.test(big.message) && /建議/.test(big.message), big);
check('size under limit ok', T.checkSize(10 * 1024 * 1024).ok === true);

// runStep：失敗一次後重試成功
(async () => {
    const logs = [];
    let calls = 0;
    const r1 = await T.runStep('測試步驟', async () => { calls++; if (calls === 1) throw new Error('暫時錯誤'); return 42; }, { retries: 1, now: fakeNow(), log: (m) => logs.push(m) });
    check('retry once then success', r1.ok && r1.value === 42 && r1.attempts === 2 && calls === 2, r1);
    check('retry logged', logs.length === 1 && /自動重試/.test(logs[0]), logs);

    // 兩次都失敗：回報具體步驟、錯誤、次數、耗時
    const r2 = await T.runStep('載入 ffmpeg.wasm', async () => { throw new Error('CDN 404'); }, { retries: 1, now: fakeNow(), log: silentLog });
    check('two failures reported', !r2.ok && r2.attempts === 2 && r2.error === 'CDN 404' && r2.step === '載入 ffmpeg.wasm', r2);
    const msg2 = T.failMessage(r2);
    check('failure message has step, count, time, error', /載入 ffmpeg\.wasm失敗/.test(msg2) && /已試 2 次/.test(msg2) && /耗時 \d+\.\d 秒/.test(msg2) && /CDN 404/.test(msg2), msg2);

    // 原生可解：不轉、不問同意、不載入 ffmpeg
    const calls2 = { consent: 0, load: 0, transcode: 0 };
    const native = await T.decodeForWhisper({
        head: enc('ID3\x03\x00'), size: 1000, now: fakeNow(), log: silentLog,
        decodeNative: async () => ({ pcm: [1], durationSeconds: 1 }),
        decodeWav: async () => { throw new Error('不該呼叫'); },
        getConsent: async () => { calls2.consent++; return true; },
        loadFfmpeg: async () => { calls2.load++; },
        transcode: async () => { calls2.transcode++; },
    });
    check('native decodable: no transcode, no consent, no load', native.ok && native.route === 'native' && calls2.consent + calls2.load + calls2.transcode === 0, native);

    // m4a 原生解不了：走 ffmpeg 退路，輸出再用解碼器讀
    const seen = { wavBytes: null, loaded: 0 };
    const m4a = await T.decodeForWhisper({
        head: enc('\x00\x00\x00\x20ftypM4A \x00\x00'), size: 5000, now: fakeNow(), log: silentLog,
        decodeNative: async () => { throw new Error('EncodingError: Unable to decode audio data'); },
        getConsent: async () => true,
        loadFfmpeg: async () => { seen.loaded++; },
        transcode: async () => Uint8Array.from([1, 2, 3]),
        decodeWav: async (bytes) => { seen.wavBytes = bytes; return { pcm: [0.5], durationSeconds: 2 }; },
    });
    check('m4a falls back to ffmpeg', m4a.ok && m4a.route === 'ffmpeg-wasm' && m4a.format === 'm4a' && seen.loaded === 1, m4a);
    check('m4a fallback keeps native error for diagnosis', m4a.ok && /EncodingError/.test(m4a.nativeError), m4a);
    check('fallback decodes the transcoded wav', seen.wavBytes && seen.wavBytes.length === 3 && m4a.value.durationSeconds === 2, seen);

    // amr 不先試原生，直接退路
    let nativeTried = false;
    const amr = await T.decodeForWhisper({
        head: enc('#!AMR\n'), size: 100, now: fakeNow(), log: silentLog,
        decodeNative: async () => { nativeTried = true; return {}; },
        getConsent: async () => true, loadFfmpeg: async () => {}, transcode: async () => new Uint8Array(4),
        decodeWav: async () => ({ pcm: [], durationSeconds: 0 }),
    });
    check('amr skips native attempt', amr.ok && !nativeTried, amr);

    // 轉檔第一次失敗、第二次成功：自動重試一次
    let tr = 0;
    const retry = await T.decodeForWhisper({
        head: enc('\x00\x00\x00\x20ftypM4A '), size: 100, now: fakeNow(), log: silentLog,
        decodeNative: async () => { throw new Error('bad'); },
        getConsent: async () => true, loadFfmpeg: async () => {},
        transcode: async () => { tr++; if (tr === 1) throw new Error('ffmpeg aborted'); return new Uint8Array(4); },
        decodeWav: async () => ({ pcm: [], durationSeconds: 0 }),
    });
    check('transcode retried once', retry.ok && tr === 2, { ok: retry.ok, tr });

    // 載入與轉檔都兩次失敗：回報哪一步
    let tr2 = 0;
    const dead = await T.decodeForWhisper({
        head: enc('\x00\x00\x00\x20ftypM4A '), size: 100, now: fakeNow(), log: silentLog,
        decodeNative: async () => { throw new Error('bad'); },
        getConsent: async () => true, loadFfmpeg: async () => {},
        transcode: async () => { tr2++; throw new Error('ffmpeg aborted: invalid data'); },
        decodeWav: async () => ({ pcm: [], durationSeconds: 0 }),
    });
    check('transcode twice fails with step + message', !dead.ok && dead.step === 'ffmpeg 轉成 16 kHz 單聲道 wav' && tr2 === 2 && /已試 2 次/.test(dead.message) && /invalid data/.test(dead.message), dead);

    // 大檔超限：不問同意、不載入
    let asked = 0;
    const huge = await T.decodeForWhisper({
        head: enc('\x00\x00\x00\x20ftypM4A '), size: 400 * 1024 * 1024, now: fakeNow(), log: silentLog,
        decodeNative: async () => { throw new Error('bad'); },
        getConsent: async () => { asked++; return true; }, loadFfmpeg: async () => {}, transcode: async () => new Uint8Array(1),
        decodeWav: async () => ({ pcm: [], durationSeconds: 0 }),
    });
    check('oversize: specific message, no consent asked', !huge.ok && huge.step === '檢查檔案大小' && /400 MB/.test(huge.message) && asked === 0, huge);

    // 沒同意：不載入、不轉，回報同意
    let loadedNoConsent = 0;
    const declined = await T.decodeForWhisper({
        head: enc('\x00\x00\x00\x20ftypM4A '), size: 100, now: fakeNow(), log: silentLog,
        decodeNative: async () => { throw new Error('bad'); },
        getConsent: async () => false, loadFfmpeg: async () => { loadedNoConsent++; }, transcode: async () => new Uint8Array(1),
        decodeWav: async () => ({ pcm: [], durationSeconds: 0 }),
    });
    check('declined consent: no load, clear message', !declined.ok && declined.step === '取得下載同意' && loadedNoConsent === 0, declined);

    // 同意卡片文字要有來源、大小（估計）
    const txt = T.consentText({ jsUrl: 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js', coreUrl: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js' });
    check('consent text shows source and size', /cdn\.jsdelivr\.net/.test(txt) && /約 30 MB/.test(txt) && /估計值/.test(txt), txt);

    console.log(`通過 ${ok}/${ok + bad.length}`);
    if (bad.length) { console.log('失敗：\n' + bad.join('\n')); process.exit(1); }
    console.log('transcode fallback core tests: all passed');
})();
