/* 壓縮檔的辨識與純 JavaScript 解碼（UMD，純函式，不碰 DOM／網路）：
 *  - sniff(u8, name)  ：用檔頭魔術數字（不只看副檔名）判斷格式：zip／jar、7z、rar（4 與 5）、tar、gzip、bzip2、xz、zstd、iso，以及 tar.gz／tgz、tar.bz2／tbz2、tar.xz／txz 這類『壓縮過的 tar』
 *  - parseTar(u8)      ：tar 讀取（ustar 的 prefix、pax 擴充標頭、GNU 長檔名，hard link／symlink 標示）
 *  - bzip2Decode(u8)   ：bzip2 解壓（含多區塊、多串接串流、區塊 CRC 檢查、輸出上限）
 *  - looksBinary(u8)、decodeText(u8)、jarSummary(entries)、tree(entries)
 * 其他格式（7z、rar、iso、xz、tar.xz…）由應用程式端用 libarchive（WebAssembly）解開，見 floating-assistant.js 的 _archiveOpen；
 * 這裡的 gzip 靠瀏覽器／Node 內建的 DecompressionStream（呼叫端提供）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaArchive = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const MAX_OUT = 256 * 1048576;
    const ASCII = (u8, off, s) => { for (let i = 0; i < s.length; i++) if (u8[off + i] !== s.charCodeAt(i)) return false; return true; };
    const EXT_FORMATS = [[/\.(tar\.gz|tgz|taz)$/i, 'tgz'], [/\.(tar\.bz2|tbz2?|tb2|tar\.bz)$/i, 'tbz2'], [/\.(tar\.xz|txz)$/i, 'txz'], [/\.(tar\.zst|tzst|tar\.zstd)$/i, 'tzst'], [/\.(jar|war|ear|apk|aar|xpi|nupkg|whl|egg|vsix|crx|odt|ods|odp|epub|zip)$/i, 'zip'], [/\.7z$/i, '7z'], [/\.rar$/i, 'rar'], [/\.tar$/i, 'tar'], [/\.(gz|gzip)$/i, 'gz'], [/\.(bz2|bzip2)$/i, 'bz2'], [/\.xz$/i, 'xz'], [/\.(zst|zstd)$/i, 'zst'], [/\.(iso|img)$/i, 'iso'], [/\.(cab)$/i, 'cab'], [/\.(lz4)$/i, 'lz4'], [/\.(z)$/i, 'z']];
    // 副檔名 → 格式（沒有檔頭可看的時候用）；不是壓縮檔回傳 ''
    function formatFromName(name) { const s = String(name || ''); for (const [re, f] of EXT_FORMATS) if (re.test(s)) return f; return ''; }
    const LABEL = { zip: 'zip', jar: 'jar（Java 套件）', '7z': '7z', rar: 'rar', tar: 'tar', gz: 'gzip', tgz: 'tar.gz', bz2: 'bzip2', tbz2: 'tar.bz2', xz: 'xz', txz: 'tar.xz', zst: 'zstd', tzst: 'tar.zst', iso: 'iso（光碟映像）', cab: 'cab', lz4: 'lz4', z: 'compress(.Z)' };
    // 檔頭 → { format, compressed（是不是單檔壓縮，裡面可能還有 tar）}
    function sniff(u8, name) {
        const n = u8 ? u8.length : 0; const byName = formatFromName(name); let magic = '';
        if (n >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7) && (u8[3] === 4 || u8[3] === 6 || u8[3] === 8)) magic = 'zip';
        else if (n >= 6 && u8[0] === 0x37 && u8[1] === 0x7a && u8[2] === 0xbc && u8[3] === 0xaf && u8[4] === 0x27 && u8[5] === 0x1c) magic = '7z';
        else if (n >= 7 && ASCII(u8, 0, 'Rar!\x1a\x07')) magic = 'rar';
        else if (n >= 3 && u8[0] === 0x1f && u8[1] === 0x8b) magic = 'gz';
        else if (n >= 4 && ASCII(u8, 0, 'BZh') && u8[3] >= 0x31 && u8[3] <= 0x39) magic = 'bz2';
        else if (n >= 6 && u8[0] === 0xfd && ASCII(u8, 1, '7zXZ') && u8[5] === 0) magic = 'xz';
        else if (n >= 4 && u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd) magic = 'zst';
        else if (n >= 4 && u8[0] === 0x04 && u8[1] === 0x22 && u8[2] === 0x4d && u8[3] === 0x18) magic = 'lz4';
        else if (n >= 4 && ASCII(u8, 0, 'MSCF')) magic = 'cab';
        else if (n >= 2 && u8[0] === 0x1f && u8[1] === 0x9d) magic = 'z';
        else if (n >= 262 && ASCII(u8, 257, 'ustar')) magic = 'tar';
        else if (n >= 0x8006 && ASCII(u8, 0x8001, 'CD001')) magic = 'iso';
        else if (n >= 512 && validTarHeader(u8)) magic = 'tar'; // 古老的 v7 tar 沒有 ustar 標記，靠檢查碼認
        // 檔頭優先；檔頭認不出來（例如被截斷）才用副檔名。壓縮過的 tar 用副檔名補上『裡面是 tar』
        let format = magic || byName; let tarInside = false;
        if (magic === 'gz' && /^(tgz)$/.test(byName)) { format = 'tgz'; tarInside = true; } else if (magic === 'bz2' && byName === 'tbz2') { format = 'tbz2'; tarInside = true; } else if (magic === 'xz' && byName === 'txz') { format = 'txz'; tarInside = true; } else if (magic === 'zst' && byName === 'tzst') { format = 'tzst'; tarInside = true; }
        if (format === 'zip' && /\.(jar|war|ear|aar)$/i.test(String(name || ''))) format = 'jar';
        const single = /^(gz|bz2|xz|zst|lz4|z)$/.test(format) || /^(tgz|tbz2|txz|tzst)$/.test(format);
        const base = { tgz: 'gz', tbz2: 'bz2', txz: 'xz', tzst: 'zst' }[format] || format;
        return { format: format || '', label: LABEL[format] || format || '', codec: single ? base : '', tarInside, byMagic: !!magic, mismatch: !!(magic && byName && byName !== magic && !(['tgz', 'tbz2', 'txz', 'tzst'].includes(byName)) && !(magic === 'zip' && byName === 'zip')) };
    }
    // tar 標頭檢查碼：第 148～155 位元組是八進位的 checksum，把這 8 個位元組當空白算出來的總和要一致
    function validTarHeader(u8) {
        if (u8.length < 512) return false; let sum = 0; for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : u8[i];
        let s = ''; for (let i = 148; i < 156; i++) { if (u8[i] === 0 || u8[i] === 32) { if (s) break; else continue; } s += String.fromCharCode(u8[i]); } if (!/^[0-7]+$/.test(s)) return false; return parseInt(s, 8) === sum && u8[0] !== 0;
    }

    // ===== tar =====
    const dec = (u8) => new TextDecoder('utf-8').decode(u8);
    function octal(seg) { let s = ''; for (const b of seg) { if (b === 0 || b === 32) { if (s) break; else continue; } s += String.fromCharCode(b); } return s ? parseInt(s, 8) : 0; }
    function cstr(seg) { let e = seg.indexOf(0); if (e < 0) e = seg.length; return dec(seg.subarray(0, e)); }
    // pax 的紀錄長度是『位元組數』（含長度本身、空白、等號與結尾換行），所以要照位元組走，不能照字元走
    function parsePax(u8) {
        const out = {}; let i = 0;
        while (i < u8.length) { let sp = i; while (sp < u8.length && u8[sp] !== 32) sp++; if (sp >= u8.length) break; const len = parseInt(dec(u8.subarray(i, sp)), 10); if (!len || i + len > u8.length) break; const rec = dec(u8.subarray(sp + 1, i + len - 1)); const eq = rec.indexOf('='); if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1); i += len; }
        return out;
    }
    // 回傳 { entries:[{ name, size, isDir, type, linkname, mtime, mode, _off }], truncated }；資料不完整時盡量讀到哪算哪
    function parseTar(u8) {
        const entries = []; let off = 0; let pendingName = null, pax = null, globalPax = null, truncated = false;
        while (off + 512 <= u8.length) {
            const h = u8.subarray(off, off + 512); let zero = true; for (let i = 0; i < 512; i++) if (h[i] !== 0) { zero = false; break; } if (zero) break;
            let name = cstr(h.subarray(0, 100)); const size = octal(h.subarray(124, 136)); const type = String.fromCharCode(h[156] || 48); const magic = cstr(h.subarray(257, 263));
            if (/^ustar/.test(magic)) { const prefix = cstr(h.subarray(345, 500)); if (prefix) name = prefix + '/' + name; }
            const dataOff = off + 512; const next = dataOff + Math.ceil(size / 512) * 512; if (dataOff + size > u8.length) truncated = true;
            if (type === 'L') { pendingName = cstr(u8.subarray(dataOff, dataOff + size)); off = next; continue; } // GNU 長檔名
            if (type === 'K') { off = next; continue; } // GNU 長連結名（不用）
            if (type === 'x') { pax = parsePax(u8.subarray(dataOff, dataOff + size)); off = next; continue; }
            if (type === 'g') { globalPax = parsePax(u8.subarray(dataOff, dataOff + size)); off = next; continue; }
            const px = Object.assign({}, globalPax || {}, pax || {}); if (pendingName) name = pendingName; if (px.path) name = px.path; const fsize = px.size ? parseInt(px.size, 10) : size;
            entries.push({ name, size: fsize, isDir: type === '5' || name.endsWith('/'), type, linkname: px.linkpath || cstr(h.subarray(157, 257)) || undefined, mtime: px.mtime ? Math.floor(Number(px.mtime)) : octal(h.subarray(136, 148)), mode: octal(h.subarray(100, 108)), _off: dataOff });
            pendingName = null; pax = null; off = dataOff + Math.ceil(fsize / 512) * 512;
        }
        return { entries, truncated, bytes: u8 };
    }
    function tarRead(parsed, name) { const e = parsed.entries.find((x) => x.name === name); if (!e) return null; if (e.type === '1' || e.type === '2') return null; return parsed.bytes.subarray(e._off, e._off + e.size); }

    // ===== bzip2 =====
    const CRC_T = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i << 24; for (let j = 0; j < 8; j++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04c11db7) : (c << 1); t[i] = c >>> 0; } return t; })();
    function bzip2Decode(data, opts) {
        const maxOut = (opts && opts.maxOut) || MAX_OUT; let pos = 0, bitBuf = 0, bitCnt = 0;
        const bits = (n) => { while (bitCnt < n) { if (pos >= data.length) throw new Error('bzip2：資料不完整（檔案可能被截斷）'); bitBuf = (bitBuf << 8) | data[pos++]; bitCnt += 8; } bitCnt -= n; const v = (bitBuf >>> bitCnt) & ((1 << n) - 1); bitBuf &= (1 << bitCnt) - 1; return v; };
        const bit = () => bits(1);
        let out = new Uint8Array(Math.min(maxOut, Math.max(65536, data.length * 4))); let outLen = 0;
        const put = (b) => { if (outLen >= out.length) { if (out.length >= maxOut) throw new Error('bzip2：解開後超過上限 ' + Math.round(maxOut / 1048576) + 'MB（可能是壓縮炸彈）'); const bigger = new Uint8Array(Math.min(maxOut, out.length * 2)); bigger.set(out); out = bigger; } out[outLen++] = b; };
        let streams = 0;
        while (true) {
            if (!(bits(8) === 0x42 && bits(8) === 0x5a && bits(8) === 0x68)) { if (streams) break; throw new Error('不是 bzip2 檔案（檔頭不是 BZh）'); }
            const level = bits(8) - 0x30; if (level < 1 || level > 9) throw new Error('bzip2：區塊大小不合法'); const blockMax = level * 100000; streams++; let combined = 0;
            while (true) {
                const m1 = bits(24), m2 = bits(24);
                if (m1 === 0x177245 && m2 === 0x385090) { const stored = bits(16) * 65536 + bits(16); if ((stored >>> 0) !== (combined >>> 0)) throw new Error('bzip2：整個串流的 CRC 對不上（資料損毀）'); bitBuf = 0; bitCnt = 0; break; } // 串流結束，對齊到位元組
                if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2：區塊標記不對（資料損毀）');
                const blockCrc = ((bits(16) * 65536) + bits(16)) >>> 0; if (bit()) throw new Error('bzip2：不支援舊版的隨機化區塊'); const origPtr = bits(24);
                const used16 = bits(16); const seqToUnseq = []; for (let i = 0; i < 16; i++) if (used16 & (0x8000 >> i)) { const b = bits(16); for (let j = 0; j < 16; j++) if (b & (0x8000 >> j)) seqToUnseq.push(i * 16 + j); }
                const nInUse = seqToUnseq.length; if (!nInUse) throw new Error('bzip2：區塊裡沒有任何符號'); const alpha = nInUse + 2; const nGroups = bits(3); if (nGroups < 2 || nGroups > 6) throw new Error('bzip2：霍夫曼表數量不對'); const nSel = bits(15); if (nSel < 1) throw new Error('bzip2：沒有選擇器');
                const selMtf = []; for (let i = 0; i < nSel; i++) { let j = 0; while (bit()) { j++; if (j >= nGroups) throw new Error('bzip2：選擇器損毀'); } selMtf.push(j); }
                const pos0 = []; for (let i = 0; i < nGroups; i++) pos0.push(i); const selector = new Uint8Array(nSel); for (let i = 0; i < nSel; i++) { const v = selMtf[i]; const t = pos0[v]; for (let k = v; k > 0; k--) pos0[k] = pos0[k - 1]; pos0[0] = t; selector[i] = t; }
                const tables = []; for (let t = 0; t < nGroups; t++) {
                    const len = new Uint8Array(alpha); let cur = bits(5); for (let i = 0; i < alpha; i++) { while (true) { if (cur < 1 || cur > 20) throw new Error('bzip2：霍夫曼碼長不合法'); if (!bit()) break; if (!bit()) cur++; else cur--; } len[i] = cur; }
                    let minL = 32, maxL = 0; for (let i = 0; i < alpha; i++) { if (len[i] > maxL) maxL = len[i]; if (len[i] < minL) minL = len[i]; }
                    const perm = new Int32Array(alpha); let pp = 0; for (let i = minL; i <= maxL; i++) for (let j = 0; j < alpha; j++) if (len[j] === i) perm[pp++] = j;
                    const base = new Int32Array(23), limit = new Int32Array(23); for (let i = 0; i < alpha; i++) base[len[i] + 1]++; for (let i = 1; i < 23; i++) base[i] += base[i - 1];
                    let vec = 0; for (let i = minL; i <= maxL; i++) { vec += base[i + 1] - base[i]; limit[i] = vec - 1; vec <<= 1; } for (let i = minL + 1; i <= maxL; i++) base[i] = ((limit[i - 1] + 1) << 1) - base[i];
                    tables.push({ minL, maxL, perm, base, limit });
                }
                const EOB = nInUse + 1; const tt = new Int32Array(blockMax); const unz = new Int32Array(256); const yy = new Uint8Array(nInUse); for (let i = 0; i < nInUse; i++) yy[i] = i;
                let groupNo = -1, groupPos = 0, tab = null, nblock = 0;
                const nextSym = () => { if (groupPos === 0) { groupNo++; if (groupNo >= nSel) throw new Error('bzip2：選擇器用完了（資料損毀）'); groupPos = 50; tab = tables[selector[groupNo]]; } groupPos--; let zn = tab.minL; let zv = bits(zn); while (zv > tab.limit[zn]) { zn++; if (zn > 20) throw new Error('bzip2：霍夫曼解碼失敗'); zv = (zv << 1) | bit(); } const idx = zv - tab.base[zn]; if (idx < 0 || idx >= alpha) throw new Error('bzip2：霍夫曼解碼失敗'); return tab.perm[idx]; };
                let sym = nextSym();
                while (sym !== EOB) {
                    if (sym <= 1) { let es = -1, N = 1; do { es += (sym === 0 ? 1 : 2) * N; N <<= 1; if (N > (1 << 22)) throw new Error('bzip2：重複次數太大（資料損毀）'); sym = nextSym(); } while (sym <= 1); es++; const uc = seqToUnseq[yy[0]]; if (nblock + es > blockMax) throw new Error('bzip2：區塊超過大小（資料損毀）'); unz[uc] += es; while (es-- > 0) tt[nblock++] = uc; continue; }
                    if (nblock >= blockMax) throw new Error('bzip2：區塊超過大小（資料損毀）'); const nn = sym - 1; const u = yy[nn]; for (let k = nn; k > 0; k--) yy[k] = yy[k - 1]; yy[0] = u; const byte = seqToUnseq[u]; unz[byte]++; tt[nblock++] = byte; sym = nextSym();
                }
                if (origPtr >= nblock && nblock) throw new Error('bzip2：起點指標不對（資料損毀）');
                const cf = new Int32Array(256); let sum = 0; for (let i = 0; i < 256; i++) { cf[i] = sum; sum += unz[i]; } for (let i = 0; i < nblock; i++) { const uc = tt[i] & 0xff; tt[cf[uc]++] |= (i << 8); }
                // 逆 BWT ＋ 第一層 RLE（連續 4 個相同位元組後面接一個重複次數）
                let tPos = nblock ? (tt[origPtr] >> 8) : 0; let run = 0, prev = -1, crc = 0xffffffff;
                const emit = (b) => { put(b); crc = ((crc << 8) ^ CRC_T[((crc >>> 24) ^ b) & 0xff]) >>> 0; };
                for (let i = 0; i < nblock; i++) {
                    tPos = tt[tPos]; const ch = tPos & 0xff; tPos >>= 8;
                    if (run === 4) { for (let k = 0; k < ch; k++) emit(prev); run = 0; prev = -1; continue; }
                    if (ch === prev) run++; else { run = 1; prev = ch; } emit(ch);
                }
                crc = (~crc) >>> 0; if (crc !== blockCrc) throw new Error('bzip2：區塊 CRC 對不上（資料損毀）'); combined = (((combined << 1) | (combined >>> 31)) ^ crc) >>> 0;
            }
            if (pos >= data.length) break;
        }
        return out.subarray(0, outLen);
    }

    // ===== 內容判斷 =====
    function looksBinary(u8, n) { const m = Math.min(u8.length, n || 4096); let ctrl = 0; for (let i = 0; i < m; i++) { const b = u8[i]; if (b === 0) return true; if (b < 9 || (b > 13 && b < 32)) ctrl++; } return m > 0 && ctrl / m > 0.1; }
    function decodeText(u8) {
        if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
        if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2)); if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
        try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (_) { /* 往下試 */ }
        for (const enc of ['big5', 'gbk', 'windows-1252']) { try { return new TextDecoder(enc, { fatal: true }).decode(u8); } catch (_) { /* 下一個 */ } }
        return new TextDecoder('utf-8').decode(u8);
    }
    // 項目清單的摘要：資料夾樹的第一層、副檔名統計、總大小
    function summarize(entries) {
        const files = entries.filter((e) => !e.isDir); const ext = {}; for (const f of files) { const m = /\.([A-Za-z0-9]+)$/.exec(f.name); const k = m ? m[1].toLowerCase() : '(無)'; ext[k] = (ext[k] || 0) + 1; }
        const top = {}; for (const e of entries) { const p = e.name.replace(/^\.?\//, '').split('/')[0]; if (p) top[p] = (top[p] || 0) + 1; }
        return { files: files.length, dirs: entries.length - files.length, total_bytes: files.reduce((a, f) => a + (f.size || 0), 0), by_ext: Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 8), top_level: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => k + (v > 1 ? '（' + v + ' 項）' : '')) };
    }
    // Java 套件：MANIFEST.MF 的重點、類別數、有沒有 module-info、套件目錄
    function jarSummary(entries, manifestText) {
        const classes = entries.filter((e) => /\.class$/i.test(e.name)).length; const pk = new Set(); for (const e of entries) { if (/\.class$/i.test(e.name)) { const d = e.name.split('/').slice(0, -1).join('.'); if (d) pk.add(d); } }
        const man = {}; String(manifestText || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/).forEach((l) => { const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(l); if (m) man[m[1]] = m[2]; });
        return { classes, packages: Array.from(pk).slice(0, 12), packages_total: pk.size, main_class: man['Main-Class'] || null, title: man['Implementation-Title'] || man['Bundle-Name'] || null, version: man['Implementation-Version'] || man['Bundle-Version'] || null, created_by: man['Created-By'] || null, module_info: entries.some((e) => /(^|\/)module-info\.class$/.test(e.name)), spring_boot: entries.some((e) => /^BOOT-INF\//.test(e.name)) };
    }
    const SUPPORTED = ['zip', 'jar', '7z', 'rar', 'tar', 'tar.gz / tgz', 'gzip', 'bzip2', 'tar.bz2 / tbz2', 'xz', 'tar.xz / txz', 'iso'];
    return { MAX_OUT, SUPPORTED, formatFromName, sniff, validTarHeader, parseTar, tarRead, bzip2Decode, looksBinary, decodeText, summarize, jarSummary };
});
