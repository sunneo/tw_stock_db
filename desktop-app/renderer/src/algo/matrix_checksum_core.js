/* 矩陣層：校驗碼（CRC 的 GF(2) 矩陣、Adler／Fletcher／總和／互斥或），規格型題目的「由規格編譯成矩陣」（G2、G6）。純函式 UMD，不問模型。
 *
 * 核心事實（DESIGN.matrix-fallback.md §12.1 實測）：一個位元組的 CRC 更新是 GF(2) 上的仿射映射 —— 狀態 s（w 位元）更新為 s' = A·(s ⊕ b)，
 * A 是 w×w 的 0/1 矩陣（＝一個位元步驟連做 8 次），加＝互斥或、乘＝且，也就是 SR.count(2)。矩陣由「多項式＋反射與否」直接編譯（不需要黑箱），
 * 變長輸入就是這個更新逐位元組連乘（Mealy 的狀態轉移）。
 *
 *   crcSpec(name)               已知規格表（crc32、crc32c、crc16-*、crc8…），每個附標準檢查值（"123456789"）
 *   crcBitwise(spec, bytes)     位元逐步的參考實作（不經矩陣）
 *   crcMatrix(spec) → A         w 個整數，A[i] 的第 j 位＝矩陣 (i,j) 項；apply(A, v) 的第 i 位＝ parity(A[i] & v)
 *   crcViaMatrix(spec, bytes)   用矩陣連乘算（要與 crcBitwise 完全一致）
 *   synthChecksum({statement, examples}) → 註冊用：文字（或十六進位）進、校驗碼出；規格從敘述與範例找（常數取自敘述、其餘在小空間枚舉）
 *   synthByteList               位元組值清單進、清單出（delta 解碼／編碼、前綴和、前綴互斥或）與「值 位元組數 序」的端序寫出 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixChecksum = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const q = (s) => JSON.stringify(s);
    const MASK = (w) => (w >= 32 ? 0xFFFFFFFF : ((1 << w) - 1) >>> 0);
    const rev = (x, w) => { let r = 0; for (let i = 0; i < w; i++) if ((x >>> i) & 1) r |= 1 << (w - 1 - i); return r >>> 0; };
    // ---- 規格表（poly 用「正常（MSB 先）」寫法；refl 為真時內部用位元反轉後的多項式）----
    const SPECS = {
        'crc32': { w: 32, poly: 0x04C11DB7, init: 0xFFFFFFFF, xorout: 0xFFFFFFFF, refl: true, check: 0xCBF43926 },
        'crc32c': { w: 32, poly: 0x1EDC6F41, init: 0xFFFFFFFF, xorout: 0xFFFFFFFF, refl: true, check: 0xE3069283 },
        'crc32-bzip2': { w: 32, poly: 0x04C11DB7, init: 0xFFFFFFFF, xorout: 0xFFFFFFFF, refl: false, check: 0xFC891918 },
        'crc16-arc': { w: 16, poly: 0x8005, init: 0, xorout: 0, refl: true, check: 0xBB3D },
        'crc16-modbus': { w: 16, poly: 0x8005, init: 0xFFFF, xorout: 0, refl: true, check: 0x4B37 },
        'crc16-x25': { w: 16, poly: 0x1021, init: 0xFFFF, xorout: 0xFFFF, refl: true, check: 0x906E },
        'crc16-kermit': { w: 16, poly: 0x1021, init: 0, xorout: 0, refl: true, check: 0x2189 },
        'crc16-ccitt-false': { w: 16, poly: 0x1021, init: 0xFFFF, xorout: 0, refl: false, check: 0x29B1 },
        'crc16-xmodem': { w: 16, poly: 0x1021, init: 0, xorout: 0, refl: false, check: 0x31C3 },
        'crc8': { w: 8, poly: 0x07, init: 0, xorout: 0, refl: false, check: 0xF4 },
    };
    const crcSpec = (name) => SPECS[name] || null;
    const polyFor = (sp) => (sp.refl ? rev(sp.poly, sp.w) : sp.poly);
    // 位元逐步參考實作（反射：右移；非反射：左移）
    function crcBitwise(sp, bytes) {
        const w = sp.w, m = MASK(w), P = polyFor(sp); let s = sp.init >>> 0;
        for (const b of bytes) {
            if (sp.refl) { s = (s ^ b) >>> 0; for (let k = 0; k < 8; k++) s = (s & 1) ? ((s >>> 1) ^ P) >>> 0 : s >>> 1; }
            else { s = (s ^ ((b << (w - 8)) >>> 0)) >>> 0; for (let k = 0; k < 8; k++) s = ((s >>> (w - 1)) & 1) ? (((s << 1) & m) ^ P) >>> 0 : (s << 1) & m >>> 0; s = (s & m) >>> 0; }
        }
        return (s ^ sp.xorout) >>> 0;
    }
    // 一個位元組更新的線性部分：s ↦ step^8(s)（不含輸入注入；注入是 s ⊕ b 後再進矩陣）
    function step8(sp, s) { const w = sp.w, m = MASK(w), P = polyFor(sp); for (let k = 0; k < 8; k++) { if (sp.refl) s = (s & 1) ? ((s >>> 1) ^ P) >>> 0 : s >>> 1; else s = ((s >>> (w - 1)) & 1) ? ((((s << 1) & m) ^ P) >>> 0) : (((s << 1) & m) >>> 0); } return s >>> 0; }
    // 矩陣的第 j 欄＝step8(e_j)；以「列整數」輸出：A[i] 的第 j 位＝ step8(e_j) 的第 i 位
    function crcMatrix(sp) { const w = sp.w; const cols = []; for (let j = 0; j < w; j++) cols.push(step8(sp, (1 << j) >>> 0)); const A = []; for (let i = 0; i < w; i++) { let row = 0; for (let j = 0; j < w; j++) if ((cols[j] >>> i) & 1) row |= (1 << j); A.push(row >>> 0); } return A; }
    const par = (x) => { x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4; x ^= x >>> 2; x ^= x >>> 1; return x & 1; };
    const apply = (A, v) => { let r = 0; for (let i = 0; i < A.length; i++) r |= par((A[i] & v) >>> 0) << i; return r >>> 0; };
    function crcViaMatrix(sp, bytes, A) {
        A = A || crcMatrix(sp); const w = sp.w; let s = sp.init >>> 0;
        for (const b of bytes) s = apply(A, (s ^ (sp.refl ? b : ((b << (w - 8)) >>> 0))) >>> 0);
        return (s ^ sp.xorout) >>> 0;
    }
    const hex = (x, n) => { let t = (x >>> 0).toString(16); while (t.length < n) t = '0' + t; return t; };
    // 矩陣連乘的 Python：A 以列整數給出，apply 逐列取內積的奇偶（GF(2) 的乘加）
    function crcPython(sp, inMode, fmt) {
        const A = crcMatrix(sp), w = sp.w, nib = Math.ceil(w / 4);
        const L = ['# CRC 的 GF(2) 矩陣版：狀態 s 是 ' + w + ' 位元向量；每個位元組 b：s ← A·(s ⊕ b)（A 是 ' + w + '×' + w + ' 的 0/1 矩陣，加＝XOR、乘＝AND）', 'A = [' + A.map((x) => '0x' + hex(x, nib)).join(', ') + ']  # 第 i 列的第 j 位＝矩陣 (i, j) 項',
            'def apply(A, v):', '    r = 0', '    for i, row in enumerate(A):', "        r |= (bin(row & v).count('1') & 1) << i", '    return r', 'def main():'];
        if (inMode === 'hex') L.push('    data = bytes.fromhex(input().strip())'); else L.push('    data = input().strip().encode()');
        L.push('    s = 0x' + hex(sp.init, nib), '    for b in data:', '        s = apply(A, s ^ ' + (sp.refl ? 'b' : '(b << ' + (w - 8) + ')') + ')', '    s ^= 0x' + hex(sp.xorout, nib), '    print(' + fmtPy(fmt, 's') + ')');
        return L.join('\n') + '\n';
    }
    const fmtPy = (fmt, v) => (fmt.kind === 'dec' ? 'str(' + v + ')' : '"%0' + fmt.n + (fmt.upper ? 'X' : 'x') + '" % ' + v);
    const fmtJs = (fmt, x) => (fmt.kind === 'dec' ? String(x >>> 0) : (fmt.upper ? hex(x, fmt.n).toUpperCase() : hex(x, fmt.n)));
    const enc = (s) => { const out = []; for (const ch of unescape(encodeURIComponent(s))) out.push(ch.charCodeAt(0)); return out; };
    const hexBytes = (s) => { if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) return null; const o = []; for (let i = 0; i < s.length; i += 2) o.push(parseInt(s.substr(i, 2), 16)); return o; };
    // 敘述裡的十六進位常數（0x…）
    const hexConsts = (st) => [...String(st).matchAll(/0x([0-9a-fA-F]{2,8})/g)].map((m) => ({ v: parseInt(m[1], 16) >>> 0, digits: m[1].length }));
    // ---- 簡單校驗碼：計數半環取模的線性遞推（狀態 (a,b)）與互斥或（GF(2)）----
    const SIMPLE = [
        { id: 'sum-mod-256', kw: /總和|加總|sum|mod\s*256|除以\s*256/i, f: (bs) => bs.reduce((a, b) => (a + b) % 256, 0), py: ['r = sum(data) % 256'], w: 2 },
        { id: 'sum-mod-65536', kw: /65536|16\s*位/, f: (bs) => bs.reduce((a, b) => (a + b) % 65536, 0), py: ['r = sum(data) % 65536'], w: 4 },
        { id: 'xor', kw: /互斥或|xor|異或|\^/i, f: (bs) => bs.reduce((a, b) => a ^ b, 0), py: ['r = 0', 'for b in data:', '    r ^= b'], w: 2 },
        { id: 'lrc', kw: /二補數|LRC|補碼/i, f: (bs) => (256 - bs.reduce((a, b) => (a + b) % 256, 0)) % 256, py: ['r = (-sum(data)) % 256'], w: 2 },
        { id: 'fletcher16', kw: /fletcher/i, f: (bs) => { let a = 0, b = 0; for (const x of bs) { a = (a + x) % 255; b = (b + a) % 255; } return b * 256 + a; }, py: ['a = b = 0', 'for x in data:', '    a = (a + x) % 255', '    b = (b + a) % 255', 'r = b * 256 + a'], w: 4 },
        { id: 'adler32', kw: /adler/i, f: (bs) => { let a = 1, b = 0; for (const x of bs) { a = (a + x) % 65521; b = (b + a) % 65521; } return ((b * 65536) + a) >>> 0; }, py: ['a, b = 1, 0', 'for x in data:', '    a = (a + x) % 65521', '    b = (b + a) % 65521', 'r = b * 65536 + a'], w: 8 },
        { id: 'fletcher16-x', kw: /fletcher/i, f: (bs) => { let a = 0, b = 0; for (const x of bs) { a = (a + x) % 255; b = (b + a) % 255; } return a * 256 + b; }, py: ['a = b = 0', 'for x in data:', '    a = (a + x) % 255', '    b = (b + a) % 255', 'r = a * 256 + b'], w: 4 },
    ];
    function synthChecksum(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' }; const st = String(o.statement || '');
        const I = [], O = [];
        for (const e of exs) { const il = String(e.in).replace(/\n$/, '').split('\n'), ol = String(e.out).replace(/\s+$/, '').split('\n'); if (il.length !== 1 || ol.length !== 1) return { ok: false, reason: '不是一行進一行出' }; I.push(il[0].replace(/\r$/, '').trim()); O.push(ol[0].trim()); }
        if (!/^[0-9a-fA-F]+$/.test(O[0]) && !/^\d+$/.test(O[0])) return { ok: false, reason: '輸出不是數字或十六進位' };
        const inModes = [['text', (s) => enc(s)]]; if (I.every((s) => hexBytes(s))) inModes.push(['hex', hexBytes]);
        // 輸出格式：十進位、或固定位數的小／大寫十六進位（位數由範例輸出長度決定）
        const fmts = []; const lens = new Set(O.map((x) => x.length)); if (O.every((x) => /^\d+$/.test(x))) fmts.push({ kind: 'dec' }); if (lens.size === 1 && O.every((x) => /^[0-9a-f]+$/.test(x))) fmts.push({ kind: 'hex', n: O[0].length, upper: false }); if (lens.size === 1 && O.every((x) => /^[0-9A-F]+$/.test(x))) fmts.push({ kind: 'hex', n: O[0].length, upper: true });
        const hits = []; let tried = 0;
        const specs = Object.keys(SPECS).map((k) => ({ name: k, sp: SPECS[k] }));
        // 敘述裡寫了多項式／初值：以敘述常數組合出自訂規格（反射與否、初值與輸出互斥或取 0 或全 1 都試）
        const hc = hexConsts(st); const stmtSpecs = [];
        for (const c of hc) { const w = c.digits <= 2 ? 8 : c.digits <= 4 ? 16 : 32; for (const refl of [true, false]) for (const init of [0, MASK(w)]) for (const xo of [0, MASK(w)]) { const poly = refl && (c.v >>> (w - 1)) & 1 ? rev(c.v, w) : c.v; stmtSpecs.push({ name: 'custom-' + w + '-0x' + hex(poly, c.digits), sp: { w, poly, init, xorout: xo, refl } }); } }
        for (const [mn, conv] of inModes) for (const fmt of fmts) {
            const ins = I.map(conv); const want = O;
            for (const { name, sp } of specs.concat(stmtSpecs)) { if (fmt.kind === 'hex' && fmt.n !== Math.ceil(sp.w / 4)) continue; tried++; if (ins.every((bs, i) => fmtJs(fmt, crcViaMatrix(sp, bs)) === want[i])) hits.push({ kind: 'crc', name, sp, mn, fmt, score: (new RegExp(name.replace(/-.*/, '').replace('crc', 'CRC[-\\s]?'), 'i').test(st) ? 2 : 0) + (/CRC/i.test(st) ? 1 : 0) + (hc.some((c) => c.v === sp.poly || c.v === rev(sp.poly, sp.w)) ? 3 : 0) }); }
            for (const sm of SIMPLE) { tried++; if (ins.every((bs, i) => fmtJs(fmt, sm.f(bs)) === want[i] || (fmt.kind === 'hex' && fmtJs(Object.assign({}, fmt, { n: fmt.n }), sm.f(bs)) === want[i]))) hits.push({ kind: 'simple', name: sm.id, sm, mn, fmt, score: (sm.kw.test(st) ? 3 : 0) }); }
        }
        if (!hits.length) return { ok: false, reason: '校驗碼家族（CRC ' + specs.length + ' 種＋敘述常數 ' + stmtSpecs.length + ' 種、總和／互斥或／Adler／Fletcher）裡沒有符合所有範例的', tried };
        hits.sort((a, b) => b.score - a.score);
        const mk = (h) => {
            if (h.kind === 'crc') return { ok: true, source: crcPython(h.sp, h.mn, h.fmt), kind: 'crc-gf2', level: 'L6', size: h.sp.w, tried, ambiguous: false, desc: 'CRC（' + h.name + '）：GF(2) 上 ' + h.sp.w + '×' + h.sp.w + ' 矩陣逐位元組連乘', matrixForm: { kind: 'crc-gf2', spec: h.name, w: h.sp.w, poly: h.sp.poly, init: h.sp.init, xorout: h.sp.xorout, refl: h.sp.refl, matrix: crcMatrix(h.sp) } };
            const L = ['def main():', h.mn === 'hex' ? '    data = bytes.fromhex(input().strip())' : '    data = input().strip().encode()'].concat(h.sm.py.map((l) => '    ' + l), ['    print(' + fmtPy(h.fmt, 'r') + ')']);
            return { ok: true, source: L.join('\n') + '\n', kind: 'checksum', level: 'L6', size: h.sm.py.length, tried, ambiguous: false, desc: '校驗碼：' + h.name, matrixForm: { kind: 'checksum', name: h.name } };
        };
        const r0 = mk(hits[0]); r0.ambiguous = hits.length > 1 && hits[1].score === hits[0].score; r0.alternatives = hits.slice(1, 10).map(mk);
        return r0;
    }
    // ---- 位元組清單 ----
    const ints = (s) => { const t = String(s).trim(); if (!t) return []; const p = t.split(/\s+/); return p.every((x) => /^-?\d+$/.test(x)) ? p.map(Number) : null; };
    function synthByteList(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' }; const st = String(o.statement || '');
        // 形狀 A：第一行 d、第二行清單 → 一行清單
        const parsed = exs.map((e) => { const l = String(e.in).replace(/\n$/, '').split('\n'); const ol = String(e.out).replace(/\n$/, '').split('\n'); if (l.length !== 2 || ol.length !== 1) return null; const d = ints(l[0]), a = ints(l[1]), r = ints(ol[0]); if (!d || d.length !== 1 || !a || !r) return null; return { d: d[0], a, r }; });
        const FN = [
            { id: 'delta-decode', kw: /delta|差分|解碼/i, f: (d, a) => { const r = []; a.forEach((x, i) => r.push((x + (i >= d ? r[i - d] : 0)) % 256)); return r; }, py: ['out = []', 'for i, x in enumerate(a):', '    out.append((x + (out[i - d] if i >= d else 0)) % 256)'] },
            { id: 'delta-encode', kw: /delta|差分|編碼/i, f: (d, a) => a.map((x, i) => (((x - (i >= d ? a[i - d] : 0)) % 256) + 256) % 256), py: ['out = [(x - (a[i - d] if i >= d else 0)) % 256 for i, x in enumerate(a)]'] },
            { id: 'prefix-sum-mod', kw: /前綴|累加|prefix/i, f: (d, a) => { let s = 0; return a.map((x) => (s = (s + x) % 256)); }, py: ['out = []', 's = 0', 'for x in a:', '    s = (s + x) % 256', '    out.append(s)'] },
        ];
        if (parsed.every(Boolean)) {
            const hits = FN.filter((f) => parsed.every((p) => { const r = f.f(p.d, p.a); return r.length === p.r.length && r.every((x, i) => x === p.r[i]); }));
            if (hits.length) { const L = ['def main():', '    d = int(input())', '    a = list(map(int, input().split()))'].concat(hits[0].py.map((l) => '    ' + l), ['    print(*out)']); return { ok: true, source: L.join('\n') + '\n', kind: 'byte-list', level: 'L6', size: hits[0].py.length, tried: FN.length, ambiguous: hits.length > 1 && !hits[0].kw.test(st), desc: '位元組清單：' + hits[0].id, matrixForm: { kind: 'byte-list', fn: hits[0].id } }; }
        }
        // 形狀 B：一行「值 位元組數 序(le|be)」→ 十六進位
        const pb = exs.map((e) => { const t = String(e.in).trim().split(/\s+/); const out = String(e.out).trim(); if (t.length !== 3 || !/^\d+$/.test(t[0]) || !/^\d+$/.test(t[1]) || !/^(le|be)$/i.test(t[2])) return null; return { v: BigInt(t[0]), n: Number(t[1]), le: /^le$/i.test(t[2]), out }; });
        if (pb.every(Boolean)) {
            const calc = (p, up) => { let s = ''; for (let i = 0; i < p.n; i++) { const byte = Number((p.v >> BigInt(8 * (p.le ? i : p.n - 1 - i))) & 255n); s += (byte < 16 ? '0' : '') + byte.toString(16); } return up ? s.toUpperCase() : s; };
            const up = pb.every((p) => p.out === calc(p, true)) && !pb.every((p) => p.out === calc(p, false));
            if (pb.every((p) => p.out === calc(p, up))) return { ok: true, source: ['def main():', '    v, n, order = input().split()', '    v = int(v)', '    n = int(n)', '    idx = range(n) if order.lower() == "le" else range(n - 1, -1, -1)', '    # 定寬切片：第 i 個位元組 = (v >> 8i) & 255（權重 256^i 的整數線性映射）', '    print("".join("%02' + (up ? 'X' : 'x') + '" % ((v >> (8 * i)) & 255) for i in idx))'].join('\n') + '\n', kind: 'endian', level: 'L4', size: 6, tried: 1, ambiguous: false, desc: '端序寫出：定寬切片 (v>>8i)&255', matrixForm: { kind: 'endian' } };
        }
        return { ok: false, reason: '不是位元組清單（d＋清單）或端序寫出（值 位元組數 序）' };
    }
    function install(M) { if (!M || !M.register) return false; M.register('checksum', synthChecksum, { order: 42, level: 'L6', note: '校驗碼：CRC 的 GF(2) 矩陣、Adler／Fletcher／總和／互斥或' }); M.register('byte-list', synthByteList, { order: 46, level: 'L6', note: '位元組清單（delta／前綴和）與端序寫出' }); return true; }
    return { install, SPECS, crcSpec, crcBitwise, crcMatrix, crcViaMatrix, crcPython, apply, synthChecksum, synthByteList, SIMPLE, enc };
});
