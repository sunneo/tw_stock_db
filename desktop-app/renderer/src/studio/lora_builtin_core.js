/* 內建 LoRA 的清單、延遲下載與校驗（UMD，純函式＋依賴注入；不碰 DOM／檔案系統；Node 與瀏覽器都能載入）。DESIGN.lora-training.md §32.3。
 *
 * 內建清單 builtin.json（放在 lora-adapters 分支根目錄，由 lora-train/build_builtin.js 產生）：
 *   { format: 'fa-lora-builtin', version: 1, base_url: '<raw.githubusercontent.com/…/<commit>>', entries: [
 *       { id, name, version, size, sha256, dir, parts: [{file, size, sha256}], domains, gate: {pass, reason} } ] }
 *   權重不嵌入 app：首次需要時才下載（fetchBuiltin），下載的分片逐一核對大小與 sha256，接成 .fatrain 後再核對整檔。
 *   任何一步不對都不寫入，回傳看得懂的原因（humanError），不拋出例外給使用者看。
 *
 *  listBuiltin(manifest, opts) → [{ id, name, version, size, sha256, dir, domains, gate, url }]
 *  fetchBuiltin(entry, deps)   → async，{ ok:true, bytes } | { ok:false, code, message }
 *     deps.fetch(url) → Promise<Uint8Array>（失敗就拋出）；deps.hash(bytes) → hex sha256（同步）
 *     opts.retries（預設 1）：單一分片下載失敗時重試次數
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLoraBuiltin = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const FORMAT = 'fa-lora-builtin';
    const HEX64 = /^[0-9a-f]{64}$/;

    function humanError(code, id) {
        const who = id ? '內建 LoRA「' + id + '」' : '內建 LoRA';
        switch (code) {
            case 'network': return who + '下載失敗：連不上 GitHub（網路不通或暫時無法連線）。請確認網路後再試一次；這不影響其他功能。';
            case 'part_mismatch': return who + '的下載檔案校驗不符（下載可能中斷或被截斷）。已丟棄，請再試一次。';
            case 'total_mismatch': return who + '重組後的檔案校驗不符。已丟棄，請再試一次；若一直失敗，請回報這個版本的 sha256。';
            case 'no_entry': return '找不到這個內建 LoRA 的清單項目（可能是舊版的清單）。請更新程式後再試。';
            case 'bad_manifest': return '內建 LoRA 清單格式不對（缺少必要欄位），無法下載。請回報這個問題。';
            default: return who + '發生未知錯誤（' + code + '）。請再試一次。';
        }
    }

    function validManifest(m) {
        const errs = [];
        if (!m || typeof m !== 'object') return ['清單不是物件'];
        if (m.format !== FORMAT) errs.push('format 應為 ' + FORMAT);
        if (typeof m.base_url !== 'string' || !m.base_url) errs.push('缺 base_url');
        if (!Array.isArray(m.entries)) errs.push('缺 entries');
        else m.entries.forEach((e, i) => {
            if (!e || typeof e.id !== 'string') errs.push('entries[' + i + '] 缺 id');
            if (!e || !HEX64.test(String(e.sha256 || ''))) errs.push('entries[' + i + '] sha256 格式不對');
            if (!e || !Array.isArray(e.parts) || !e.parts.length) errs.push('entries[' + i + '] 缺 parts');
        });
        return errs;
    }

    function listBuiltin(manifest) {
        const errs = validManifest(manifest);
        if (errs.length) return { ok: false, errors: errs, entries: [] };
        const entries = manifest.entries.map((e) => Object.assign({}, e, { url: manifest.base_url.replace(/\/+$/, '') + '/' + e.dir }));
        return { ok: true, errors: [], entries };
    }

    async function fetchBuiltin(entry, deps, opts) {
        const retries = opts && opts.retries >= 0 ? opts.retries : 1;
        if (!entry || !Array.isArray(entry.parts) || !entry.parts.length || !HEX64.test(String(entry.sha256 || ''))) {
            return { ok: false, code: 'no_entry', message: humanError('no_entry', entry && entry.id) };
        }
        const base = (deps.baseUrl || '').replace(/\/+$/, '');
        const chunks = [];
        for (const p of entry.parts) {
            const url = base + '/' + entry.dir + '/' + p.file;
            let bytes = null, lastErr = null;
            for (let t = 0; t <= retries && !bytes; t++) {
                try { bytes = await deps.fetch(url); } catch (e) { lastErr = e; }
            }
            if (!bytes) return { ok: false, code: 'network', message: humanError('network', entry.id), detail: String(lastErr && lastErr.message || lastErr) };
            if (bytes.length !== p.size || deps.hash(bytes) !== p.sha256) {
                return { ok: false, code: 'part_mismatch', message: humanError('part_mismatch', entry.id), detail: p.file };
            }
            chunks.push(bytes);
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const all = new Uint8Array(total); let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        if (total !== entry.size || deps.hash(all) !== entry.sha256) {
            return { ok: false, code: 'total_mismatch', message: humanError('total_mismatch', entry.id) };
        }
        return { ok: true, bytes: all };
    }

    return { FORMAT, humanError, validManifest, listBuiltin, fetchBuiltin };
});
