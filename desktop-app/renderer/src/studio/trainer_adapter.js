/* 離線訓練器 bundle（fa-offline-trainer v2，floating-assistant.js 的 _otBundleExport／_otBundleImport）⇄ 訓練資產（kind:'trainer'）的格式轉換（UMD，純函式）。
 * 只做格式轉換，不碰 floating-assistant.js。往返保證：assetToBundle(bundleToAsset(b)) 的 payload 與 checksum 和原本一致（逐位元，sha256 相同）。
 * 檔案配置：
 *   weights/domains.json   payload.domains（規則／pattern／FSM／JS 工具）
 *   weights/knowledge.json payload.knowledge（有才有）
 *   data/solutions.json    payload.solutions（成功案例）
 *   data/synonyms.json     payload.synonyms
 *   data/turns.json        payload.turns（有才有，未解決紀錄）
 *   manifest.extra.bundle  {format, version, exported_at, summary, checksum, payload_keys（原本的鍵順序）}
 * 版本 1 的舊 bundle（沒有 payload）不轉換，明確回錯，請先用 app 的匯入（舊格式讀得進來）再重新匯出成 v2。 */
(function (root, factory) {
    const dep = (typeof module === 'object' && module.exports) ? require('./asset_core.js') : root.FaStudioAsset;
    if (typeof module === 'object' && module.exports) module.exports = factory(dep);
    else root.FaStudioTrainerAdapter = factory(dep);
})(typeof self !== 'undefined' ? self : this, function (Asset) {
    'use strict';
    const enc = (s) => new TextEncoder().encode(s), dec = (u) => new TextDecoder('utf-8').decode(u);
    // 與 floating-assistant.js 的 _faRepoHash 相同（bundle 的 checksum 用它）
    function bundleHash(text) { let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ':' + text.length; }
    const PLACE = { domains: 'weights/domains.json', knowledge: 'weights/knowledge.json', solutions: 'data/solutions.json', synonyms: 'data/synonyms.json', turns: 'data/turns.json' };

    function bundleToAsset(bundle, opts) {
        opts = opts || {};
        if (!bundle || bundle.format !== 'fa-offline-trainer') return { ok: false, error: '不是離線訓練器 bundle（format 應為 fa-offline-trainer）' };
        if (!bundle.payload || typeof bundle.payload !== 'object') return { ok: false, error: '這份 bundle 沒有 payload（舊版 v1 格式），請先在 app 匯入再重新匯出為 v2' };
        if (Number(bundle.version) > 2) return { ok: false, error: 'bundle 版本（' + bundle.version + '）比這個程式支援的新' };
        const p = bundle.payload;
        if (bundle.checksum && bundle.checksum !== bundleHash(JSON.stringify(p))) return { ok: false, error: 'bundle 內容跟 checksum 對不起來（被改過或毀損）' };
        const keys = Object.keys(p); const unknown = keys.filter((k) => !(k in PLACE));
        const files = {};
        for (const k of keys) { if (k in PLACE) files[PLACE[k]] = enc(JSON.stringify(p[k])); }
        const extra = { bundle: { format: bundle.format, version: bundle.version, exported_at: bundle.exported_at || null, summary: bundle.summary || null, checksum: bundle.checksum || null, payload_keys: keys } };
        if (unknown.length) { extra.unknown_payload = {}; for (const k of unknown) extra.unknown_payload[k] = p[k]; }
        const counts = { domains: Array.isArray(p.domains) ? p.domains.length : 0, solutions: Array.isArray(p.solutions) ? p.solutions.length : 0, turns: Array.isArray(p.turns) ? p.turns.length : 0 };
        const manifest = Asset.createManifest({ kind: 'trainer', name: opts.name || 'trainer-bundle', files, counts, owner: opts.owner || 'user', created: bundle.exported_at || undefined, extra });
        return { ok: true, asset: { manifest, files }, warnings: unknown.length ? ['payload 有未知欄位 ' + unknown.join('、') + '，已存進 manifest.extra.unknown_payload'] : [] };
    }

    function assetToBundle(asset) {
        const m = asset && asset.manifest;
        if (!m || m.kind !== 'trainer') return { ok: false, error: 'kind 不是 trainer，無法轉回離線訓練器 bundle' };
        const meta = m.extra && m.extra.bundle; if (!meta) return { ok: false, error: '這個 trainer 資產不是由 bundle 轉來的（manifest.extra.bundle 缺少）' };
        const v = Asset.verifyFiles(m, asset.files, { allowExtra: true }); if (!v.ok) return { ok: false, error: '拒絕轉換：' + v.message };
        const payload = {}; const inv = {}; for (const k of Object.keys(PLACE)) inv[PLACE[k]] = k;
        const unk = (m.extra && m.extra.unknown_payload) || {};
        for (const k of meta.payload_keys || []) {
            if (k in PLACE) { const f = asset.files[PLACE[k]]; if (!f) return { ok: false, error: '缺少檔案 ' + PLACE[k] }; payload[k] = JSON.parse(dec(f)); }
            else if (k in unk) payload[k] = unk[k];
        }
        const bundle = { format: meta.format, version: meta.version, exported_at: meta.exported_at, summary: meta.summary, payload, checksum: bundleHash(JSON.stringify(payload)) };
        if (meta.checksum && meta.checksum !== bundle.checksum) return { ok: false, error: '轉回的 payload 與原本的 checksum 不一致（資產被改過）' };
        return { ok: true, bundle };
    }

    return { bundleHash, bundleToAsset, assetToBundle };
});
