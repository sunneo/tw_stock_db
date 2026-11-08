/* tree-sitter 文法的取得順序與核對（純函式 UMD；不連網，連網由呼叫端做）。
 * 資源來源已決定（管理者，2026-11-08）：內建只有 Python（renderer/vendor/tree-sitter/），其他語言從釘住 commit 的分支 assets-tree-sitter 延遲下載，
 * 最後才退到原本的 jsdelivr。取得順序：本機快取 → 專案內建 → 分支（下載後核對位元組數與 MD5，核對不過就丟掉）→ jsdelivr。
 *   sources(name) → 依序要試的來源 [{kind:'bundled'|'branch'|'jsdelivr', url?, file?}]（快取由呼叫端先查，不在這裡）
 *   cacheKey(name) → 快取鍵（含 commit 前八碼，換 commit 才會重抓）
 *   verify(name, bytes) → { ok, reason? }（位元組數＋MD5）
 *   md5(bytes) → 十六進位字串 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaTsAssets = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const COMMIT = '69364f48ad463e1aa16c295615644667f993e355';
    const RAW = 'https://raw.githubusercontent.com/sunneo/tw_stock_db/' + COMMIT + '/grammars/';
    const JSD = 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.11/out/', JSD_RUBY = 'https://cdn.jsdelivr.net/npm/tree-sitter-wasms@0.1.6/out/';
    const TABLE = {   // 與分支 README.md 的表一致
        bash: { bytes: 1400214, md5: 'e5da7e39622227a132c39ab2164a2e93' },
        c: { bytes: 792959, md5: '9f270e70632e4cdbaafd25d2c59293fb' },
        c_sharp: { bytes: 3978594, md5: 'a40aa0a0153aa819b3a1a22deb3a0b89' },
        cpp: { bytes: 4662978, md5: '3ed73dfbaaf8d701d135cbc6130ebd55' },
        go: { bytes: 235957, md5: 'ed41674f66152f89b9dac2180da003ed' },
        java: { bytes: 430239, md5: '596734c51f912e0c2cae17b681c71ec3' },
        javascript: { bytes: 643815, md5: 'cade83a3c964ad8faaef86541cf0f132' },
        python: { bytes: 476105, md5: 'ac589601639b19120774d006e1d874f1' },
        ruby: { bytes: 997072, md5: '80b67a754340ae401b5d854168c39564' },
        rust: { bytes: 818756, md5: 'a9d87968609e5f0dd34bae0d6824402c' }
    };
    const BUNDLED = { python: 'tree-sitter-python.wasm' };   // renderer/vendor/tree-sitter/ 底下有的
    const has = (name) => Object.prototype.hasOwnProperty.call(TABLE, name);
    const file = (name) => 'tree-sitter-' + name + '.wasm';
    const cacheKey = (name) => 'asset:ts-lang-' + name + '@' + COMMIT.slice(0, 8) + '.wasm';
    function sources(name) {
        const out = [];
        if (BUNDLED[name]) out.push({ kind: 'bundled', file: BUNDLED[name], url: './vendor/tree-sitter/' + BUNDLED[name] });
        if (has(name)) out.push({ kind: 'branch', url: RAW + file(name) });
        out.push({ kind: 'jsdelivr', url: (name === 'ruby' ? JSD_RUBY : JSD) + file(name) });
        return out;
    }
    // MD5（RFC 1321），輸入 Uint8Array／Buffer／陣列
    function md5(bytes) {
        const K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
        for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
        const n = bytes.length, total = ((n + 8) >>> 6) + 1 << 6, buf = new Uint8Array(total);
        for (let i = 0; i < n; i++) buf[i] = bytes[i];
        buf[n] = 0x80; const bits = n * 8; for (let i = 0; i < 4; i++) { buf[total - 8 + i] = (bits >>> (8 * i)) & 255; } const hi = Math.floor(n / 536870912); for (let i = 0; i < 4; i++) buf[total - 4 + i] = (hi >>> (8 * i)) & 255;
        let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0; const M = new Int32Array(16);
        for (let off = 0; off < total; off += 64) {
            for (let i = 0; i < 16; i++) M[i] = buf[off + i * 4] | (buf[off + i * 4 + 1] << 8) | (buf[off + i * 4 + 2] << 16) | (buf[off + i * 4 + 3] << 24);
            let A = a0, B = b0, C = c0, D = d0;
            for (let i = 0; i < 64; i++) {
                let F, g;
                if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; } else { F = C ^ (B | ~D); g = (7 * i) & 15; }
                const s = S[((i >> 4) << 2) | (i & 3)]; const tmp = D; D = C; C = B; const x = (A + F + K[i] + M[g]) | 0; B = (B + ((x << s) | (x >>> (32 - s)))) | 0; A = tmp;
            }
            a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
        }
        const hex = (v) => { let s = ''; for (let i = 0; i < 4; i++) s += ('0' + ((v >>> (8 * i)) & 255).toString(16)).slice(-2); return s; };
        return hex(a0) + hex(b0) + hex(c0) + hex(d0);
    }
    function verify(name, bytes) {
        if (!has(name)) return { ok: true, note: '沒有核對表（不核對）' };
        const t = TABLE[name]; if (!bytes || bytes.length !== t.bytes) return { ok: false, reason: '位元組數不符：應為 ' + t.bytes + '，實得 ' + (bytes ? bytes.length : 0) };
        const h = md5(bytes); if (h !== t.md5) return { ok: false, reason: 'MD5 不符：應為 ' + t.md5 + '，實得 ' + h };
        return { ok: true };
    }
    return { COMMIT, RAW, TABLE, has, file, cacheKey, sources, md5, verify };
});
