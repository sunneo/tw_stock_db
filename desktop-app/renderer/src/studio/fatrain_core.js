/* .fatrain 容器核心（UMD，純函式；Node 與瀏覽器都能載入）。.fatrain 是 zip，內容即 DESIGN.TODO.offline-training-studio.md §2 的資產。
 * repo 內沒有現成的 zip 寫入器（archive_core.js 只辨識 zip 檔頭、不解 zip），所以這裡是最小的 zip 存放式（stored）讀寫器，沒有外部依賴：
 *  - writeZip(entries, {deflateRaw?})／readZip(u8, {inflateRaw?})：寫入一律存放式（可注入 deflateRaw 壓縮）；讀取支援存放式，壓縮項目需注入 inflateRaw（Node 用 zlib.inflateRawSync，瀏覽器可用同步解壓函式）
 *  - exportAsset(asset, opts)：大檔切成 ≤ shardBytes（預設 20MB）的分片；回 {bytes, name, sharded}
 *  - inspect(bytes, opts)：只讀不寫，回摘要＋核對結果（先看再確認）
 *  - importAsset(bytes, {storage, confirmed, mode, forkName})：沒 confirmed 只回 needsConfirm＋摘要；confirmed 才合併／取代／fork 寫進 storage
 *  - splitVolumes／joinVolumes：把整個容器再切成 ≤ 20MB 的分卷（.fatrain.001…），給有大小上限的傳輸管道
 * zip 限制：不支援 zip64（單檔或整包超過 4GB、項目超過 65535 個會明確報錯）。 */
(function (root, factory) {
    const dep = (typeof module === 'object' && module.exports) ? require('./asset_core.js') : root.FaStudioAsset;
    if (typeof module === 'object' && module.exports) module.exports = factory(dep);
    else root.FaFatrain = factory(dep);
})(typeof self !== 'undefined' ? self : this, function (Asset) {
    'use strict';
    const SHARD_BYTES = 20 * 1048576;
    const MAX_ENTRY = 0xffffffff;
    const enc = (s) => new TextEncoder().encode(s), dec = (u) => new TextDecoder('utf-8').decode(u);

    // ===== crc32 =====
    const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
    function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

    // ===== zip 寫入 =====
    function writeZip(entries, opts) {
        opts = opts || {}; if (entries.length > 0xffff) throw new Error('zip 項目超過 65535 個（不支援 zip64）');
        const parts = []; const central = []; let offset = 0;
        for (const e of entries) {
            if (!Asset.safePath(e.name)) throw new Error('zip 項目名稱不合法：' + e.name);
            const raw = e.data; if (raw.length > MAX_ENTRY) throw new Error('單一項目超過 4GB（不支援 zip64）：' + e.name + '，請改用較小的 shardBytes 分片');
            let body = raw, method = 0;
            if (opts.deflateRaw) { const d = opts.deflateRaw(raw); if (d.length < raw.length) { body = d; method = 8; } }
            const name = enc(e.name); const crc = crc32(raw);
            const lh = new Uint8Array(30 + name.length); const v = new DataView(lh.buffer);
            v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, method, true);
            v.setUint16(10, 0, true); v.setUint16(12, 0x0021, true); // 1980-01-01，讓輸出可重現
            v.setUint32(14, crc, true); v.setUint32(18, body.length, true); v.setUint32(22, raw.length, true); v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
            lh.set(name, 30);
            const ch = new Uint8Array(46 + name.length); const c = new DataView(ch.buffer);
            c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, method, true);
            c.setUint16(12, 0, true); c.setUint16(14, 0x0021, true); c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, raw.length, true);
            c.setUint16(28, name.length, true); c.setUint32(42, offset, true); ch.set(name, 46);
            parts.push(lh, body); central.push(ch); offset += lh.length + body.length;
            if (offset > MAX_ENTRY) throw new Error('整包超過 4GB（不支援 zip64），請改存成資料夾或分卷');
        }
        const cdStart = offset; let cdSize = 0; for (const c of central) { parts.push(c); cdSize += c.length; }
        const eo = new Uint8Array(22); const ev = new DataView(eo.buffer);
        ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true);
        parts.push(eo);
        let total = 0; for (const p of parts) total += p.length; const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }

    // ===== zip 讀取 =====
    function readZip(u8, opts) {
        opts = opts || {}; const n = u8.length;
        if (n < 22) throw new Error('不是 zip／.fatrain：檔案太小（' + n + ' 位元組）');
        const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let eocd = -1; for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        if (eocd < 0) throw new Error('不是完整的 zip／.fatrain：找不到結尾記錄（檔案可能被截斷）');
        const count = v.getUint16(eocd + 10, true), cdSize = v.getUint32(eocd + 12, true), cdOff = v.getUint32(eocd + 16, true);
        if (count === 0xffff || cdOff === 0xffffffff) throw new Error('zip64 不支援');
        if (cdOff + cdSize > n) throw new Error('zip 中央目錄超出檔案範圍（檔案毀損）');
        const out = []; let p = cdOff; const maxTotal = opts.maxTotalBytes || 2 * 1073741824; let total = 0;
        for (let i = 0; i < count; i++) {
            if (v.getUint32(p, true) !== 0x02014b50) throw new Error('zip 中央目錄記錄損毀（第 ' + i + ' 筆）');
            const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), csize = v.getUint32(p + 20, true), usize = v.getUint32(p + 24, true);
            const nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lho = v.getUint32(p + 42, true);
            const name = dec(u8.subarray(p + 46, p + 46 + nl)); p += 46 + nl + el + cl;
            if (flags & 1) throw new Error('項目已加密，不支援：' + name);
            if (name.endsWith('/')) continue; // 目錄項目
            if (!Asset.safePath(name)) throw new Error('zip 項目名稱不安全（含 .. 或絕對路徑）：' + name);
            total += usize; if (total > maxTotal) throw new Error('解開後總大小超過上限 ' + Math.round(maxTotal / 1048576) + 'MB');
            if (v.getUint32(lho, true) !== 0x04034b50) throw new Error('zip 項目標頭損毀：' + name);
            const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
            if (start + csize > n) throw new Error('zip 項目資料超出檔案範圍（截斷）：' + name);
            const raw = u8.subarray(start, start + csize); let data;
            if (method === 0) data = raw;
            else if (method === 8) { if (!opts.inflateRaw) throw new Error('項目「' + name + '」是壓縮的，需要提供 inflateRaw（Node 用 zlib.inflateRawSync）才能解開'); data = opts.inflateRaw(raw); }
            else throw new Error('不支援的壓縮方式 ' + method + '：' + name);
            if (data.length !== usize) throw new Error('項目大小不符：' + name);
            if (crc32(data) !== crc) throw new Error('項目 crc32 對不上（毀損）：' + name);
            out.push({ name, data: data.slice() });
        }
        return out;
    }

    // ===== 匯出 =====
    function pad(i) { return String(i + 1).padStart(4, '0'); }
    function exportAsset(asset, opts) {
        opts = opts || {}; const shardBytes = Math.max(16, opts.shardBytes || SHARD_BYTES);
        const m = asset.manifest, files = asset.files || {};
        const v = Asset.verifyFiles(m, files); if (!v.ok) return { ok: false, error: '匯出前核對失敗：' + v.message };
        const chk = Asset.validateManifest(m); if (!chk.ok) return { ok: false, error: 'manifest 不合法：' + chk.errors.join('；') };
        const entries = []; const shards = {};
        for (const p of Object.keys(files).sort()) {
            const f = files[p];
            if (f.length <= shardBytes) { entries.push({ name: p, data: f }); continue; }
            const names = []; for (let i = 0, k = 0; i < f.length; i += shardBytes, k++) { const nm = p + '.part' + pad(k); names.push(nm); entries.push({ name: nm, data: f.subarray(i, Math.min(f.length, i + shardBytes)) }); }
            shards[p] = { size: f.length, parts: names, sha256: m.sha256[p] };
        }
        const mm = JSON.parse(JSON.stringify(m)); if (Object.keys(shards).length) mm.shards = shards;
        entries.unshift({ name: 'manifest.json', data: enc(JSON.stringify(mm, null, 1)) });
        let bytes; try { bytes = writeZip(entries, { deflateRaw: opts.deflateRaw }); } catch (e) { return { ok: false, error: String(e.message || e) }; }
        return { ok: true, bytes, name: m.name + '.fatrain', size: bytes.length, sharded: Object.keys(shards) };
    }

    // ===== 讀取＋檢查 =====
    function readAsset(bytes, opts) {
        opts = opts || {}; const errors = [], warnings = [];
        let entries; try { entries = readZip(bytes, opts); } catch (e) { return { ok: false, errors: [String(e.message || e)], warnings }; }
        const byName = {}; for (const e of entries) byName[e.name] = e.data;
        if (!byName['manifest.json']) return { ok: false, errors: ['缺少 manifest.json：這不是 .fatrain 訓練包'], warnings };
        let raw; try { raw = JSON.parse(dec(byName['manifest.json'])); } catch (e) { return { ok: false, errors: ['manifest.json 不是合法的 JSON：' + e.message], warnings }; }
        const mg = Asset.migrateManifest(raw); if (!mg.ok) return { ok: false, errors: [mg.error], warnings };
        const manifest = mg.manifest; const shards = raw.shards || {}; delete manifest.shards;
        if (mg.migrated) warnings.push('舊版資產（版本 ' + mg.from + '）已升級到 ' + mg.to + '：' + mg.notes.join('；'));
        const files = {}; const used = new Set(['manifest.json']);
        for (const p of Object.keys(shards)) {
            const s = shards[p]; const parts = []; let len = 0;
            for (const nm of s.parts || []) { if (!byName[nm]) { errors.push('缺少分片：' + nm); continue; } used.add(nm); parts.push(byName[nm]); len += byName[nm].length; }
            if (errors.length) continue;
            const joined = new Uint8Array(len); let o = 0; for (const x of parts) { joined.set(x, o); o += x.length; }
            if (s.size !== undefined && s.size !== len) errors.push('分片合併後大小不符：' + p);
            files[p] = joined;
        }
        for (const nm of Object.keys(byName)) if (!used.has(nm)) files[nm] = byName[nm];
        if (errors.length) return { ok: false, errors, warnings, manifest };
        const v = Asset.verifyFiles(manifest, files, { allowExtra: !!opts.allowExtra });
        if (!v.ok) return { ok: false, errors: ['拒絕：' + v.message], warnings, manifest, verify: v };
        let bytesTotal = 0; for (const p of Object.keys(files)) bytesTotal += files[p].length;
        return { ok: true, errors: [], warnings, manifest, asset: { manifest, files }, verify: v, migratedFrom: mg.migrated ? mg.from : null,
            summary: { kind: manifest.kind, name: manifest.name, created: manifest.created, owner: manifest.owner, parent: manifest.parent, base: manifest.base, files: Object.keys(files).length, bytes: bytesTotal, counts: manifest.counts, eval: manifest.eval, sharded: Object.keys(shards) } };
    }
    function inspect(bytes, opts) { const r = readAsset(bytes, opts); if (r.asset) { const { asset, ...rest } = r; return rest; } return r; }

    // ===== 匯入（先 inspect，確認後才寫入） =====
    // mode：'auto'（預設）＝不存在就新增、存在且相容就合併、存在但不相容就拒絕並建議 fork；'replace'＝整個取代；'fork'＝另存新名稱（parent 記來源）
    async function importAsset(bytes, o) {
        o = o || {}; const storage = o.storage; const mode = o.mode || 'auto';
        const r = readAsset(bytes, o); if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings, error: r.errors.join('；') };
        const inc = r.asset; const existing = storage ? await storage.loadManifest(inc.manifest.kind, inc.manifest.name) : null;
        const plan = { action: 'create', target: inc.manifest.name, kind: inc.manifest.kind };
        let compat = null;
        if (mode === 'fork') { plan.action = 'fork'; plan.target = o.forkName || (inc.manifest.name + '-fork'); }
        else if (existing) {
            if (mode === 'replace') plan.action = 'replace';
            else { compat = Asset.checkCompat(existing, inc.manifest, { checkData: false }); if (!compat.ok) return { ok: false, rejected: true, error: compat.message, reasons: compat.reasons, suggest: 'fork', summary: r.summary, warnings: r.warnings }; plan.action = 'merge'; }
        }
        if (plan.action === 'fork' && storage && await storage.loadManifest(inc.manifest.kind, plan.target)) return { ok: false, error: '名稱「' + plan.target + '」已存在，請換一個 fork 名稱', suggest: 'rename' };
        if (!o.confirmed) return { ok: true, needsConfirm: true, summary: r.summary, plan, existing: existing ? { created: existing.created, counts: existing.counts } : null, warnings: r.warnings };
        if (!storage) return { ok: false, error: '沒有提供 storage，無法寫入' };
        let asset = inc;
        if (plan.action === 'fork') { const mf = Asset.forkManifest(inc.manifest, { name: plan.target, files: inc.files }); asset = { manifest: mf, files: inc.files }; }
        else if (plan.action === 'merge') {
            const cur = await storage.loadAsset(existing.kind, existing.name); const files = Object.assign({}, cur ? cur.asset.files : {}, inc.files);
            const mf = Asset.createManifest({ kind: existing.kind, name: existing.name, files, base: inc.manifest.base, compat: Object.assign({}, inc.manifest.compat, { data_sha256: undefined }), counts: Object.assign({}, existing.counts, inc.manifest.counts), eval: inc.manifest.eval, parent: existing.parent, owner: existing.owner, created: existing.created, extra: inc.manifest.extra });
            asset = { manifest: mf, files };
        }
        const w = await storage.saveAsset(asset, { replace: plan.action !== 'merge' });
        return { ok: !!w.ok, plan, summary: r.summary, write: w, dataMayBeLost: !!w.dataMayBeLost, warnings: r.warnings, error: w.ok ? undefined : w.error };
    }

    // ===== 分卷（整個容器再切） =====
    function splitVolumes(bytes, baseName, maxBytes) {
        maxBytes = maxBytes || SHARD_BYTES; const out = [];
        for (let i = 0, k = 1; i < bytes.length; i += maxBytes, k++) out.push({ name: baseName + '.' + String(k).padStart(3, '0'), bytes: bytes.subarray(i, Math.min(bytes.length, i + maxBytes)) });
        if (!out.length) out.push({ name: baseName + '.001', bytes: new Uint8Array(0) });
        return out;
    }
    function joinVolumes(volumes) {
        const vs = volumes.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
        for (let i = 0; i < vs.length; i++) { const m = /\.(\d{3})$/.exec(vs[i].name); if (!m || Number(m[1]) !== i + 1) throw new Error('分卷不連續或檔名不對：缺少第 ' + String(i + 1).padStart(3, '0') + ' 卷'); }
        let n = 0; for (const x of vs) n += x.bytes.length; const out = new Uint8Array(n); let o = 0; for (const x of vs) { out.set(x.bytes, o); o += x.bytes.length; }
        return out;
    }

    return { SHARD_BYTES, crc32, writeZip, readZip, exportAsset, readAsset, inspect, importAsset, splitVolumes, joinVolumes };
});
