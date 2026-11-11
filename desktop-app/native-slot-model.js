'use strict';
/* 桌面版原生推論：自動把使用者自己下載的標準版 Qwen3-0.6B q8 ONNX 轉成「LoRA 槽版」並快取（使用者免 Python）。
 *  轉換演算法在 lora-slot-build.js（make_lora_onnx.py build 的 JavaScript 孿生）；本檔管：找標準版、算來源 sha256、背景子行程轉換、快取、
 *  下載清單／使用者同意後的下載（分段、可續傳、核對大小與 sha256）、進度與錯誤。可注入依賴（fs／path／crypto／cp／https），不需 Electron 就能測。
 *  快取：<userData>/native-lora/slot-model/<來源 sha256>/{model_quantized.onnx, layout.json, lora.bin(全零), .ok}
 *  絕不自動下載：download() 必須帶 confirm:true 與畫面顯示過的 url／bytes，否則拒絕。 */
const STD = {
    repo: 'onnx-community/Qwen3-0.6B-ONNX',
    files: [
        { name: 'model_quantized.onnx', rel: 'onnx/model_quantized.onnx', bytes: 617687575, sha256: '__MODEL_SHA__' },
        { name: 'tokenizer.json', rel: 'tokenizer.json', bytes: 9117040, sha256: 'e7a95fce95bf5b0946d0ddb3f9d7caa030b7e850bbe92b0edb26bcf563e9f3d5' },
    ],
    base: 'https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/',
    localDirName: 'qwen3-0.6b-q8',
    rank: 16,
};
const SEG = 16 * 1024 * 1024;

function create(d) {
    const fs = d.fs, path = d.path, crypto = d.crypto, userData = d.userData;
    const env = d.env || {};
    const slotRoot = path.join(userData, 'native-lora', 'slot-model');
    const stdDir = path.join(userData, 'native-models', STD.localDirName);
    const state = { phase: 'idle', detail: '', done: 0, total: 0, error: null, startedAt: 0, result: null, peakRssMB: null, ms: null };
    let inflight = null;
    const set = (o) => Object.assign(state, o);
    const log = d.log || (() => {});

    const stdFile = (rel) => path.join(stdDir, rel);
    const sizeOf = (p) => { try { return fs.statSync(p).size; } catch (_) { return -1; } };
    // 標準版在哪：環境變數 > 本程式的下載位置；回 {model, tokenizer}（tokenizer 找同層或上一層）
    function findStandard() {
        const cands = [];
        if (env.FA_NATIVE_STD_MODEL_PATH) cands.push(env.FA_NATIVE_STD_MODEL_PATH);
        if (d.baseModelPath) cands.push(d.baseModelPath);
        cands.push(stdFile('onnx/model_quantized.onnx'));
        for (const m of cands) {
            if (!m || sizeOf(m) <= 0) continue;
            if (fs.existsSync(path.join(path.dirname(m), 'layout.json'))) continue; // 已是槽版，不當標準版
            const dir = path.dirname(m);
            const tk = [env.FA_NATIVE_TOKENIZER_PATH, path.join(dir, 'tokenizer.json'), path.join(dir, '..', 'tokenizer.json')].filter(Boolean).find((t) => sizeOf(t) > 0) || '';
            return { model: m, tokenizer: tk, bytes: sizeOf(m) };
        }
        return null;
    }
    function missingInfo() {
        const have = findStandard();
        const need = STD.files.filter((f) => !(f.name === 'model_quantized.onnx' ? have : (have && have.tokenizer)));
        return {
            repo: STD.repo, destDir: stdDir,
            files: need.map((f) => ({ name: f.name, url: STD.base + f.rel, bytes: f.bytes, sha256: f.sha256 })),
            totalBytes: need.reduce((a, f) => a + f.bytes, 0),
        };
    }
    // 來源 sha256（串流；結果以 路徑|大小|修改時間 為鍵快取，避免每次重算 617 MB）
    async function sha256Of(p, onProg) {
        const st = fs.statSync(p), key = p + '|' + st.size + '|' + Math.floor(st.mtimeMs);
        const cf = path.join(slotRoot, '_hashes.json');
        let cache = {}; try { cache = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch (_) { cache = {}; }
        if (cache[key]) return cache[key];
        const h = crypto.createHash('sha256'), fd = fs.openSync(p, 'r'), buf = Buffer.allocUnsafe(8 * 1024 * 1024);
        try {
            let pos = 0;
            for (;;) {
                const n = fs.readSync(fd, buf, 0, buf.length, pos);
                if (n <= 0) break;
                h.update(buf.subarray(0, n)); pos += n;
                if (onProg) onProg(pos, st.size);
                if ((pos / buf.length) % 8 === 0) await new Promise((r) => setImmediate(r)); // 讓出事件迴圈
            }
        } finally { fs.closeSync(fd); }
        const sha = h.digest('hex');
        cache[key] = sha;
        try { fs.mkdirSync(slotRoot, { recursive: true }); fs.writeFileSync(cf, JSON.stringify(cache)); } catch (_) { /* 快取寫不了就下次重算 */ }
        return sha;
    }
    function cachedFor(sha) {
        const dir = path.join(slotRoot, sha);
        try {
            const ok = JSON.parse(fs.readFileSync(path.join(dir, '.ok'), 'utf8')), lay = JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8'));
            if (sizeOf(path.join(dir, 'model_quantized.onnx')) === ok.bytes && lay.total_bytes > 0) return { dir, model: path.join(dir, 'model_quantized.onnx'), layout: lay, info: ok };
        } catch (_) { /* 沒有或壞了 */ }
        return null;
    }
    // 目前可用的槽版（已轉換好）：回 {model, layout}；沒有回 null（不觸發轉換）
    function currentSlot() {
        const s = findStandard(); if (!s) return null;
        // 只用已快取的雜湊，不在這裡算 617 MB
        try {
            const st = fs.statSync(s.model), key = s.model + '|' + st.size + '|' + Math.floor(st.mtimeMs);
            const cache = JSON.parse(fs.readFileSync(path.join(slotRoot, '_hashes.json'), 'utf8'));
            return cache[key] ? cachedFor(cache[key]) : null;
        } catch (_) { return null; }
    }
    function runChild(src, outDir, rank) {
        return new Promise((resolve, reject) => {
            const cp = d.cp;
            const child = cp.spawn(d.execPath || process.execPath, [d.buildScript, '--cli', src, outDir, String(rank)], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '', errText = '', result = null;
            child.stdout.on('data', (b) => {
                out += b.toString();
                let i; while ((i = out.indexOf('\n')) >= 0) {
                    const line = out.slice(0, i); out = out.slice(i + 1);
                    try { const o = JSON.parse(line); if (o.progress) set({ done: o.progress.done, total: o.progress.total }); else if (o.result) result = o.result; } catch (_) { /* 非 JSON 行忽略 */ }
                }
            });
            child.stderr.on('data', (b) => { errText += b.toString(); });
            child.on('error', (e) => reject(e));
            child.on('close', (code) => { if (code === 0 && result) resolve(result); else reject(new Error('轉換子行程失敗（結束碼 ' + code + '）：' + (errText.trim().split('\n').slice(-3).join(' ') || '無輸出'))); });
        });
    }
    // 確保槽版存在：沒有標準版 → 回 need_std_model（含要下載的檔名／來源／大小）；有 → 算雜湊、轉換、快取。同時只跑一個。
    function ensure() {
        if (inflight) return inflight;
        inflight = (async () => {
            const s = findStandard();
            if (!s) { const info = missingInfo(); set({ phase: 'need_std', detail: '', error: null }); return { ok: false, code: 'need_std_model', message: '要套用 LoRA，需要標準版 Qwen3-0.6B 量化模型（' + STD.files[0].name + '，' + STD.repo + '，約 ' + Math.round(STD.files[0].bytes / 1048576) + ' MB）。請在畫面按下載並同意，或把檔案放到 ' + stdDir + path.sep + 'onnx', download: info }; }
            const t0 = Date.now();
            try {
                set({ phase: 'hash', detail: '核對來源檔 sha256', done: 0, total: s.bytes, error: null, startedAt: t0 });
                const sha = await sha256Of(s.model, (a, b) => set({ done: a, total: b }));
                let c = cachedFor(sha);
                if (c) { set({ phase: 'ready', detail: '使用快取', result: { sha, rank: c.layout.rank } }); return { ok: true, model: c.model, tokenizer: s.tokenizer, layout: c.layout, cached: true, sha }; }
                set({ phase: 'build', detail: '改寫成 LoRA 槽版', done: 0, total: 1 });
                const tmp = path.join(slotRoot, sha + '.partial');
                fs.rmSync(tmp, { recursive: true, force: true });
                fs.mkdirSync(slotRoot, { recursive: true });
                const r = await runChild(s.model, tmp, STD.rank);
                const dir = path.join(slotRoot, sha);
                fs.rmSync(dir, { recursive: true, force: true });
                fs.renameSync(tmp, dir);
                fs.writeFileSync(path.join(dir, '.ok'), JSON.stringify({ bytes: r.outBytes, sourceSha256: sha, sourceBytes: s.bytes, rank: STD.rank, targets: r.targets, buildMs: r.ms, at: Date.now() }));
                c = cachedFor(sha);
                if (!c) throw new Error('轉換完成但快取核對失敗');
                set({ phase: 'ready', detail: '完成', result: { sha, rank: c.layout.rank }, peakRssMB: r.peakRssMB, ms: Date.now() - t0 });
                return { ok: true, model: c.model, tokenizer: s.tokenizer, layout: c.layout, cached: false, sha, ms: Date.now() - t0 };
            } catch (e) {
                const msg = String((e && e.message) || e);
                set({ phase: 'failed', error: msg, detail: msg });
                return { ok: false, code: 'slot_build_failed', message: '轉換成 LoRA 槽版失敗：' + msg };
            }
        })().finally(() => { inflight = null; });
        return inflight;
    }
    // 下載（使用者在畫面看過 檔名／來源／大小 並同意後才會被呼叫）：p = { confirm:true, files:[{name,url,bytes}] }，內容必須與 missingInfo() 一致
    async function download(p) {
        if (!p || p.confirm !== true) return { ok: false, code: 'not_confirmed', message: '下載需要使用者在畫面確認（confirm:true）' };
        const want = missingInfo();
        if (!want.files.length) return { ok: true, already: true };
        const given = Array.isArray(p.files) ? p.files : [];
        for (const f of want.files) { const g = given.find((x) => x && x.name === f.name); if (!g || g.url !== f.url || Number(g.bytes) !== f.bytes) return { ok: false, code: 'mismatch', message: '確認的下載清單與目前需要的不一致（' + f.name + '），請重新開啟畫面確認' }; }
        const https = d.https; if (!https) return { ok: false, code: 'no_net', message: '沒有網路模組' };
        try {
            const total = want.files.reduce((a, f) => a + f.bytes, 0); let base = 0;
            for (const f of want.files) {
                const dst = stdFile(STD.files.find((x) => x.name === f.name).rel), tmp = dst + '.partial';
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                let have = sizeOf(tmp); if (have < 0 || have > f.bytes) { have = 0; try { fs.rmSync(tmp, { force: true }); } catch (_) { /* */ } }
                set({ phase: 'download', detail: f.name, done: base + have, total, error: null });
                while (have < f.bytes) {
                    const end = Math.min(f.bytes, have + SEG) - 1;
                    const buf = await (d.fetchRange || fetchRange)(https, f.url, have, end);
                    if (buf.length !== end - have + 1) throw new Error(f.name + ' 區段長度不符（要 ' + (end - have + 1) + '，得 ' + buf.length + '）');
                    fs.appendFileSync(tmp, buf); have += buf.length; set({ done: base + have });
                }
                const sha = crypto.createHash('sha256'), fd = fs.openSync(tmp, 'r'), b = Buffer.allocUnsafe(8 * 1024 * 1024);
                try { let pos = 0; for (;;) { const n = fs.readSync(fd, b, 0, b.length, pos); if (n <= 0) break; sha.update(b.subarray(0, n)); pos += n; } } finally { fs.closeSync(fd); }
                const got = sha.digest('hex'), spec = STD.files.find((x) => x.name === f.name);
                if (spec.sha256 && !spec.sha256.startsWith('__') && got !== spec.sha256) { fs.rmSync(tmp, { force: true }); throw new Error(f.name + ' sha256 不符（預期 ' + spec.sha256.slice(0, 12) + '…，實際 ' + got.slice(0, 12) + '…），已刪除'); }
                fs.rmSync(dst, { force: true }); fs.renameSync(tmp, dst);
                base += f.bytes;
            }
            set({ phase: 'idle', detail: '下載完成' });
            return { ok: true };
        } catch (e) { const msg = String((e && e.message) || e); set({ phase: 'failed', error: msg, detail: msg }); return { ok: false, code: 'download_failed', message: '下載失敗：' + msg }; }
    }
    function status() {
        const s = findStandard(), c = currentSlot();
        return { ok: true, phase: state.phase, detail: state.detail, done: state.done, total: state.total, error: state.error, standard: s ? { model: s.model, bytes: s.bytes, tokenizer: !!s.tokenizer } : null, slot: c ? { model: c.model, rank: c.layout.rank, total_bytes: c.layout.total_bytes } : null, missing: s && s.tokenizer ? null : missingInfo(), peakRssMB: state.peakRssMB, ms: state.ms };
    }
    return { ensure, download, status, findStandard, currentSlot, missingInfo, sha256Of, STD };
}

function fetchRange(https, url, from, to) {
    return new Promise((resolve, reject) => {
        const go = (u, hops) => {
            if (hops > 5) return reject(new Error('轉址太多次'));
            https.get(u, { headers: { Range: 'bytes=' + from + '-' + to, 'User-Agent': 'floating-assistant' } }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return go(new URL(res.headers.location, u).toString(), hops + 1); }
                if (res.statusCode !== 206 && res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
                const parts = []; res.on('data', (b) => parts.push(b)); res.on('end', () => { let b = Buffer.concat(parts); if (res.statusCode === 200) b = b.subarray(from, to + 1); resolve(b); }); res.on('error', reject);
            }).on('error', reject);
        };
        go(url, 0);
    });
}

module.exports = { create, STD, fetchRange };
