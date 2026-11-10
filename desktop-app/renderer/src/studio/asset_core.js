/* 訓練資產（fa-training-asset）核心（UMD，純函式，不碰 DOM／網路／檔案系統；Node 與瀏覽器都能載入）。
 * 設計見 DESIGN.TODO.offline-training-studio.md §2、§3、§3.1、§9。
 *  - sha256Hex(u8)：純 JavaScript 的 sha256（同步，不靠 crypto.subtle，所以瀏覽器與 Node 結果一致）
 *  - createManifest(opts)：由檔案表算出雜湊並建立 manifest
 *  - validateManifest(m)：欄位檢查，回 {ok, errors}
 *  - migrateManifest(m)：舊版（缺欄位、欄位名稱不同）升級到現行版本，不改動輸入
 *  - verifyFiles(manifest, files)：逐檔核對 sha256（竄改、缺檔、多出的檔）
 *  - checkCompat(base, incoming, opts)：base／rank／alpha／target_modules／prompt_format_version／tool_catalog_sha256／資料雜湊的相容性；不符回具體原因並建議 fork
 *  - forkManifest(parent, opts)：以新資產 fork，parent 欄位記來源
 * 「資產」＝ {manifest, files}，files 是 {相對路徑: Uint8Array}（不含 manifest.json 本身）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioAsset = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const FORMAT = 'fa-training-asset';
    const VERSION = 2; // 版本 1：舊式（檔案雜湊放在 files／hashes，沒有 compat／counts／eval／owner）
    const KINDS = ['colu', 'blockly', 'matrix', 'uml', 'trainer', 'lora'];
    const OWNERS = ['user', 'builtin'];
    // 續訓／合併要比對的相容欄位（§3.1）；不看後端與裝置
    const COMPAT_FIELDS = ['base', 'base_sha256', 'rank', 'alpha', 'target_modules', 'prompt_format_version', 'tool_catalog_sha256'];
    const COMPAT_LABEL = { base: '基底模型', base_sha256: '基底模型雜湊', rank: 'LoRA 秩（rank）', alpha: 'LoRA alpha', target_modules: '目標模組', prompt_format_version: '提示格式版本', tool_catalog_sha256: '工具目錄雜湊', data_sha256: '資料集雜湊', kind: '資產種類' };
    const HEX64 = /^[0-9a-f]{64}$/;

    // ===== sha256（純 JavaScript） =====
    const K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
    function toU8(x) {
        if (x instanceof Uint8Array) return x;
        if (typeof x === 'string') return new TextEncoder().encode(x);
        if (x && x.buffer instanceof ArrayBuffer) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
        if (x instanceof ArrayBuffer) return new Uint8Array(x);
        throw new Error('需要 Uint8Array 或字串');
    }
    function sha256Hex(input) {
        const data = toU8(input); const n = data.length;
        const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
        const w = new Uint32Array(64);
        const total = ((n + 9 + 63) >> 6) << 6; // 補 0x80 與 8 位元組長度後對齊 64
        const block = (get) => {
            for (let i = 0; i < 16; i++) w[i] = (get(i * 4) << 24) | (get(i * 4 + 1) << 16) | (get(i * 4 + 2) << 8) | get(i * 4 + 3);
            for (let i = 16; i < 64; i++) {
                const a = w[i - 15], b = w[i - 2];
                const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
                const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
            }
            let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
            for (let i = 0; i < 64; i++) {
                const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
                const ch = (e & f) ^ (~e & g);
                const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
                const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
                const mj = (a & b) ^ (a & c) ^ (b & c);
                const t2 = (S0 + mj) | 0;
                hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
            }
            h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
        };
        const fullEnd = n - (n % 64);
        for (let off = 0; off < fullEnd; off += 64) block((i) => data[off + i]);
        const tail = new Uint8Array(total - fullEnd); tail.set(data.subarray(fullEnd), 0); tail[n - fullEnd] = 0x80;
        const bits = n * 8; const dv = new DataView(tail.buffer);
        dv.setUint32(tail.length - 8, Math.floor(bits / 4294967296)); dv.setUint32(tail.length - 4, bits >>> 0);
        for (let off = 0; off < tail.length; off += 64) block((i) => tail[off + i]);
        let out = ''; for (let i = 0; i < 8; i++) out += (h[i] >>> 0).toString(16).padStart(8, '0');
        return out;
    }

    // ===== 工具 =====
    function stable(v) { // 鍵排序的 JSON（雜湊用，與鍵順序無關）
        if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
        if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
        return JSON.stringify(v === undefined ? null : v);
    }
    const clone = (o) => JSON.parse(JSON.stringify(o));
    function safePath(p) { // 容器內路徑：相對、正斜線、沒有 .. 與空段
        if (typeof p !== 'string' || !p || p.length > 300) return false;
        if (p.indexOf('\\') >= 0 || p[0] === '/' || /^[A-Za-z]:/.test(p) || p.indexOf('\0') >= 0) return false;
        return p.split('/').every((s) => s && s !== '.' && s !== '..');
    }
    function safeName(n) { return typeof n === 'string' && /^[\w一-鿿][\w一-鿿.\- ]{0,79}$/.test(n) && n.indexOf('..') < 0 && !/[. ]$/.test(n); }
    function hashFiles(files) { const out = {}; for (const p of Object.keys(files).sort()) out[p] = sha256Hex(files[p]); return out; }
    // 資料集雜湊：data/ 底下所有檔的（路徑＋雜湊）依序串起來再雜湊
    function dataHash(files, hashes) {
        hashes = hashes || hashFiles(files); let s = '';
        for (const p of Object.keys(hashes).sort()) if (p.indexOf('data/') === 0) s += p + '\0' + hashes[p] + '\n';
        return sha256Hex(s);
    }
    function manifestHash(m) { return sha256Hex(stable(m)); }

    // ===== 建立 =====
    function createManifest(o) {
        o = o || {}; const files = o.files || {};
        if (KINDS.indexOf(o.kind) < 0) throw new Error('kind 必須是 ' + KINDS.join('／') + '，收到 ' + JSON.stringify(o.kind));
        if (!safeName(o.name)) throw new Error('名稱不合法（只能用中英文數字、底線、連字號、點與空白，最長 80 字，且不可含 ..）：' + JSON.stringify(o.name));
        for (const p of Object.keys(files)) if (!safePath(p) || p === 'manifest.json') throw new Error('檔案路徑不合法：' + p);
        const sha = hashFiles(files);
        const compat = Object.assign({}, o.compat || {});
        if (compat.data_sha256 === undefined) compat.data_sha256 = dataHash(files, sha);
        const base = o.base !== undefined ? o.base : (compat.base !== undefined ? compat.base : null);
        const m = {
            format: FORMAT, version: VERSION, kind: o.kind, name: o.name, created: o.created || new Date().toISOString(),
            parent: o.parent || null, base, compat, counts: Object.assign({}, o.counts || {}), eval: o.eval === undefined ? null : o.eval,
            sha256: sha, owner: o.owner || 'user'
        };
        if (o.extra !== undefined) m.extra = o.extra;
        return m;
    }

    // ===== 驗證 =====
    function validateManifest(m) {
        const errors = [];
        if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['manifest 不是物件'] };
        if (m.format !== FORMAT) errors.push('format 應為 ' + FORMAT + '，收到 ' + JSON.stringify(m.format));
        if (!Number.isInteger(m.version)) errors.push('version 缺少或不是整數');
        else if (m.version > VERSION) errors.push('資產版本（' + m.version + '）比這個程式支援的（' + VERSION + '）新，請先更新程式');
        else if (m.version < VERSION) errors.push('資產版本（' + m.version + '）較舊，需先用 migrateManifest 升級');
        if (KINDS.indexOf(m.kind) < 0) errors.push('kind 不合法：' + JSON.stringify(m.kind));
        if (!safeName(m.name)) errors.push('name 不合法：' + JSON.stringify(m.name));
        if (m.owner !== undefined && OWNERS.indexOf(m.owner) < 0) errors.push('owner 只能是 user 或 builtin');
        if (!m.sha256 || typeof m.sha256 !== 'object' || Array.isArray(m.sha256)) errors.push('sha256 表缺少');
        else for (const p of Object.keys(m.sha256)) { if (!safePath(p)) errors.push('sha256 表裡的路徑不合法：' + p); else if (!HEX64.test(String(m.sha256[p]))) errors.push('sha256 值格式不對：' + p); }
        if (!m.compat || typeof m.compat !== 'object') errors.push('compat 缺少');
        if (m.parent != null && (typeof m.parent !== 'object' || !m.parent.name)) errors.push('parent 格式不對（需要 {name, kind, manifest_sha256}）');
        return { ok: !errors.length, errors };
    }

    // ===== 遷移 =====
    function migrateManifest(input) {
        if (!input || typeof input !== 'object') return { ok: false, error: 'manifest 不是物件' };
        const m = clone(input); const notes = [];
        const isTrainerBundleLike = m.format === 'fa-offline-trainer';
        if (m.format !== FORMAT && !isTrainerBundleLike) return { ok: false, error: 'format 不是 ' + FORMAT + '（收到 ' + JSON.stringify(m.format) + '），這不是訓練資產' };
        if (isTrainerBundleLike) return { ok: false, error: '這是離線訓練器的 bundle（fa-offline-trainer），請用 trainer_adapter 轉成資產，不是資產 manifest' };
        let v = m.version === undefined ? 0 : Number(m.version);
        if (!Number.isInteger(v) || v < 0) return { ok: false, error: 'version 不是非負整數：' + JSON.stringify(m.version) };
        if (v > VERSION) return { ok: false, error: '資產版本（' + v + '）比這個程式支援的（' + VERSION + '）新，請先更新程式' };
        const from = v;
        if (v < 1) { // 版本 0：只有 format／kind／name，雜湊沒記
            if (!m.sha256 && !m.files && !m.hashes) notes.push('版本 0：沒有檔案雜湊，升級後 sha256 為空，核對時所有檔案會被視為「多出」，請重新計算');
            v = 1; notes.push('0→1：補上版本號');
        }
        if (v < 2) { // 版本 1 → 2
            if (!m.sha256) { m.sha256 = m.hashes || m.files || {}; notes.push('1→2：檔案雜湊欄位（hashes／files）改名為 sha256'); }
            delete m.hashes; if (m.files && typeof m.files === 'object') delete m.files;
            if (!m.compat) { m.compat = {}; ['base', 'rank', 'alpha', 'prompt_format_version', 'tool_catalog_sha256'].forEach((k) => { if (m[k] !== undefined) { m.compat[k] = m[k]; delete m[k]; } }); notes.push('1→2：補上 compat（舊的頂層 base／rank／prompt_format_version 搬進去）'); }
            if (m.base === undefined) m.base = m.compat.base !== undefined ? m.compat.base : null;
            if (!m.counts) { m.counts = {}; notes.push('1→2：補上 counts'); }
            if (m.eval === undefined) m.eval = null;
            if (!m.owner) { m.owner = 'user'; notes.push('1→2：補上 owner=user'); }
            if (m.parent === undefined) m.parent = null;
            if (!m.created) { m.created = ''; notes.push('1→2：舊資產沒有建立時間，留空'); }
            v = 2;
        }
        m.version = VERSION;
        const chk = validateManifest(m);
        if (!chk.ok) return { ok: false, error: '升級後仍不合法：' + chk.errors.join('；'), manifest: m, notes };
        return { ok: true, manifest: m, migrated: from !== VERSION, from, to: VERSION, notes };
    }

    // ===== 核對檔案 =====
    function verifyFiles(manifest, files, opts) {
        opts = opts || {}; const mismatched = [], missing = [], extra = [];
        const want = manifest.sha256 || {};
        for (const p of Object.keys(want)) {
            const f = files[p];
            if (!f) { missing.push(p); continue; }
            if (sha256Hex(f) !== want[p]) mismatched.push(p);
        }
        for (const p of Object.keys(files)) if (!(p in want) && p !== 'manifest.json') extra.push(p);
        const ok = !mismatched.length && !missing.length && (opts.allowExtra || !extra.length);
        const parts = [];
        if (mismatched.length) parts.push('內容被改過或毀損（sha256 對不上）：' + mismatched.slice(0, 5).join('、') + (mismatched.length > 5 ? '…共 ' + mismatched.length + ' 個' : ''));
        if (missing.length) parts.push('缺少檔案：' + missing.slice(0, 5).join('、'));
        if (extra.length && !opts.allowExtra) parts.push('多出 manifest 沒有記錄的檔案：' + extra.slice(0, 5).join('、'));
        return { ok, mismatched, missing, extra, message: parts.join('；') };
    }

    // ===== 相容性 =====
    // base、incoming 可以是 manifest 或 compat 物件（含 kind／data_sha256 時一併比）。opts.checkData（預設 true）：續訓要比資料雜湊；合併匯入不比。
    function checkCompat(base, incoming, opts) {
        opts = opts || {};
        const A = (base && base.compat) ? Object.assign({}, base.compat, { kind: base.kind }) : Object.assign({}, base || {});
        const B = (incoming && incoming.compat) ? Object.assign({}, incoming.compat, { kind: incoming.kind }) : Object.assign({}, incoming || {});
        const fields = ['kind'].concat(COMPAT_FIELDS); if (opts.checkData !== false) fields.push('data_sha256');
        const reasons = [];
        for (const f of fields) {
            const a = A[f], b = B[f];
            if (a === undefined && b === undefined) continue;
            if (a === undefined || b === undefined || stable(a) !== stable(b)) {
                reasons.push({ field: f, expected: a === undefined ? null : a, actual: b === undefined ? null : b, message: (COMPAT_LABEL[f] || f) + '不同：原本 ' + (a === undefined ? '（未記錄）' : JSON.stringify(a)) + '，這份是 ' + (b === undefined ? '（未記錄）' : JSON.stringify(b)) });
            }
        }
        if (!reasons.length) return { ok: true, reasons: [], suggest: null };
        return { ok: false, reasons, suggest: 'fork', message: '不相容，不能直接續訓／合併：' + reasons.map((r) => r.message).join('；') + '。請改以新資產 fork（parent 欄位記錄來源）。' };
    }

    function forkManifest(parent, o) {
        o = o || {}; const m = clone(parent);
        const name = o.name || (String(parent.name) + '-fork');
        if (!safeName(name)) throw new Error('fork 的名稱不合法：' + name);
        m.name = name; m.created = o.created || new Date().toISOString(); m.owner = 'user';
        m.parent = { name: parent.name, kind: parent.kind, version: parent.version, manifest_sha256: manifestHash(parent) };
        if (o.compat) m.compat = Object.assign({}, m.compat, o.compat);
        if (m.compat && o.files) m.compat.data_sha256 = dataHash(o.files);
        if (o.files) m.sha256 = hashFiles(o.files);
        return m;
    }

    return { FORMAT, VERSION, KINDS, OWNERS, COMPAT_FIELDS, sha256Hex, stable, safePath, safeName, hashFiles, dataHash, manifestHash, createManifest, validateManifest, migrateManifest, verifyFiles, checkCompat, forkManifest, toU8 };
});
