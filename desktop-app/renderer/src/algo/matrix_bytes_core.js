/* 矩陣層：位元組／位元級的有輸出轉換器（G1 Mealy、G4 位元組輸入輸出、G7 動態表）。純函式 UMD，不問模型。設計：DESIGN.matrix-fallback.md §12.3。
 *
 * 每個候選是一台小機器（讀入十六進位位元組或記號 → 逐位元組／逐位元輸出），同時有 JS 版與 Python 版，範例全對才採用：
 *   varint-dec / varint-enc   多位元組整數：每位元組低 7 位資料、最高位表示後面還有；低位組在前（LEB128／xz／protobuf）或高位組在前
 *   bit-reader                第一行十六進位位元組、第二行一串位寬：依位元序（低位先讀＝DEFLATE；高位先讀）讀出整數——狀態＝（目前位元組位置、位元位移）
 *   lz77-dec                  記號「單一字元」與 <L,d>（往回 d 個字元複製 L 個，來源可與新寫入重疊）→ 還原字串——需要視窗陣列（輸出緩衝）
 *   huffman-cost              k 個次數 → 最佳霍夫曼碼的總位元數（=所有合併權重之和）——動態表：最小堆累積合併，而非查固定表（G7）
 *   xxd-reverse               xxd 傾印（位移、冒號、十六進位欄、ASCII 欄）→ 位元組十六進位
 *   deflate-stored            文字 → DEFLATE 未壓縮區塊十六進位（01、LEN 小端、NLEN 小端、資料）
 * 與 matrix_checksum_core 的 CRC（GF(2) 矩陣）並列：變長輸入就是「逐位元組的狀態轉移」。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixBytes = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const norm = (s) => String(s).replace(/\s+$/, '');
    const hexOf = (b) => b.map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
    const bytesOf = (h) => { h = h.trim(); if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('not hex'); const o = []; for (let i = 0; i < h.length; i += 2) o.push(parseInt(h.substr(i, 2), 16)); return o; };
    const lines = (s) => { s = String(s); if (s.endsWith('\n')) s = s.slice(0, -1); return s.split('\n'); };
    const M = []; // {id, kw, js(inText)->outText, py:[完整 Python 行]}
    const add = (id, kw, js, py) => M.push({ id, kw, js, py });
    // ---- varint ----
    function varintDec(h, le) { const b = bytesOf(lines(h)[0]); const out = []; let cur = 0n, n = 0, grp = []; for (const x of b) { grp.push(x & 127); if (!(x & 128)) { let v = 0n; const g = le ? grp.slice().reverse() : grp; for (const d of g) v = (v << 7n) | BigInt(d); out.push(v); grp = []; } } if (grp.length) throw new Error('unfinished'); void cur; void n; return out.join(' '); }
    for (const le of [true, false]) add('varint-dec-' + (le ? 'le' : 'be'), /多位元組整數|varint|LEB128/i, (t) => varintDec(t, le), ['def main():', '    b = bytes.fromhex(input().strip())', '    out = []', '    grp = []', '    for x in b:', '        grp.append(x & 127)', '        if not (x & 128):', '            v = 0', '            for d in ' + (le ? 'reversed(grp)' : 'grp') + ':', '                v = (v << 7) | d', '            out.append(v)', '            grp = []', '    print(*out)']);
    function varintEnc(t, le) { const nums = lines(t).join(' ').trim().split(/\s+/).filter(Boolean).map((x) => BigInt(x)); const out = []; for (let v of nums) { const g = []; do { g.push(Number(v & 127n)); v >>= 7n; } while (v > 0n); const ordered = le ? g : g.reverse(); ordered.forEach((d, i) => out.push(d | (i < ordered.length - 1 ? 128 : 0))); } return hexOf(out); }
    for (const le of [true, false]) add('varint-enc-' + (le ? 'le' : 'be'), /多位元組整數|varint|LEB128|編碼/i, (t) => varintEnc(t, le), ['def main():', '    nums = list(map(int, input().split()))', '    out = []', '    for v in nums:', '        g = []', '        while True:', '            g.append(v & 127)', '            v >>= 7', '            if v == 0:', '                break', '        ordered = g if ' + (le ? 'True' : 'False') + ' else g[::-1]', '        for i, d in enumerate(ordered):', '            out.append(d | (128 if i < len(ordered) - 1 else 0))', '    print("".join("%02x" % x for x in out))']);
    // ---- bit reader ----
    function bitRead(t, lsb) { const L = lines(t); const b = bytesOf(L[0]); const ws = L[1].trim().split(/\s+/).map(Number); let pos = 0; const out = []; const bit = (i) => (lsb ? (b[i >> 3] >> (i & 7)) & 1 : (b[i >> 3] >> (7 - (i & 7))) & 1); for (const w of ws) { if (pos + w > b.length * 8) throw new Error('past end'); let v = 0; for (let k = 0; k < w; k++) { const x = bit(pos + k); v = lsb ? v | (x << k) : (v << 1) | x; } pos += w; out.push(v); } return out.join(' '); }
    for (const lsb of [true, false]) add('bit-reader-' + (lsb ? 'lsb' : 'msb'), lsb ? /最低位元|bit 0|DEFLATE|低位先/ : /最高位元|高位先/, (t) => bitRead(t, lsb), ['def main():', '    b = bytes.fromhex(input().strip())', '    ws = list(map(int, input().split()))', '    pos = 0', '    out = []', '    for w in ws:', '        v = 0', '        for k in range(w):', '            i = pos + k', '            x = (b[i >> 3] >> ' + (lsb ? '(i & 7)' : '(7 - (i & 7))') + ') & 1', '            v = ' + (lsb ? 'v | (x << k)' : '(v << 1) | x'), '        pos += w', '        out.append(v)', '    print(*out)']);
    // ---- lz77 ----
    add('lz77-dec', /lz77|往回|複製/i, (t) => { const toks = lines(t)[0].trim().split(/\s+/).filter(Boolean); const out = []; for (const k of toks) { const m = /^<(\d+),(\d+)>$/.exec(k); if (m) { const L = Number(m[1]), d = Number(m[2]); if (d > out.length || d < 1) throw new Error('bad dist'); for (let i = 0; i < L; i++) out.push(out[out.length - d]); } else if (k.length === 1) out.push(k); else throw new Error('bad token'); } return out.join(''); },
        ['def main():', '    toks = input().split()', '    out = []', '    for k in toks:', '        if k.startswith("<"):', '            L, d = map(int, k[1:-1].split(","))', '            for _ in range(L):', '                out.append(out[-d])', '        else:', '            out.append(k)', '    print("".join(out))']);
    // ---- huffman cost ----
    add('huffman-cost', /霍夫曼|huffman/i, (t) => { const L = lines(t); const a = L[1].trim().split(/\s+/).map(Number); if (a.length !== Number(L[0].trim())) throw new Error('k'); const h = a.slice().sort((x, y) => x - y); let cost = 0; while (h.length > 1) { h.sort((x, y) => x - y); const x = h.shift(), y = h.shift(); cost += x + y; h.push(x + y); } return String(cost); },
        ['def main():', '    import heapq', '    k = int(input())', '    h = list(map(int, input().split()))', '    heapq.heapify(h)', '    cost = 0', '    while len(h) > 1:', '        x = heapq.heappop(h)', '        y = heapq.heappop(h)', '        cost += x + y', '        heapq.heappush(h, x + y)', '    print(cost)']);
    // ---- xxd 還原 ----
    add('xxd-reverse', /xxd|傾印/i, (t) => { const L = lines(t); const n = Number(L[0].trim()); if (L.length - 1 !== n) throw new Error('n'); const out = []; for (const l of L.slice(1)) { const m = /^[0-9a-f]{8}: (.{39})/.exec(l); if (!m) throw new Error('fmt'); for (const g of m[1].trim().split(/\s+/)) if (g) out.push(g); } return out.join(''); },
        ['def main():', '    n = int(input())', '    out = []', '    for _ in range(n):', '        line = input()', '        out.append(line[10:49].replace(" ", ""))', '    print("".join(out))']);
    // ---- DEFLATE stored ----
    add('deflate-stored', /DEFLATE|未壓縮區塊|stored/i, (t) => { const s = lines(t)[0].trim(); const b = [...s].map((c) => c.charCodeAt(0)); const len = b.length; return hexOf([1, len & 255, len >> 8, (65535 - len) & 255, (65535 - len) >> 8].concat(b)); },
        ['def main():', '    s = input().strip().encode()', '    n = len(s)', '    hdr = bytes([1, n & 255, n >> 8, (65535 - n) & 255, (65535 - n) >> 8])', '    print((hdr + s).hex())']);
    function synthBytes(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' }; const st = String(o.statement || ''); const hits = [];
        for (const m of M) { let ok = true; for (const e of exs) { let r; try { r = m.js(e.in); } catch (err) { ok = false; break; } if (norm(r) !== norm(e.out)) { ok = false; break; } } if (ok) hits.push(m); }
        if (!hits.length) return { ok: false, reason: '位元組／位元機器庫（' + M.length + ' 台）裡沒有符合所有範例的', tried: M.length };
        hits.sort((a, b) => (b.kw.test(st) ? 1 : 0) - (a.kw.test(st) ? 1 : 0));
        const mk = (h) => ({ ok: true, source: h.py.join('\n') + '\n', kind: 'bytes-machine', level: 'L6', size: h.py.length, tried: M.length, ambiguous: false, desc: '位元組機器：' + h.id, matrixForm: { kind: 'bytes-machine', id: h.id } });
        const r0 = mk(hits[0]); r0.ambiguous = hits.length > 1 && hits[1].kw.test(st) === hits[0].kw.test(st); r0.alternatives = hits.slice(1, 8).map(mk); return r0;
    }
    function install(Sy) { if (!Sy || !Sy.register) return false; Sy.register('bytes-machine', synthBytes, { order: 47.5, level: 'L6', note: '位元組／位元機器：varint、位元讀取器、LZ77 還原、霍夫曼成本、xxd 還原、DEFLATE 未壓縮區塊' }); return true; }
    return { install, synthBytes, MACHINES: M, bytesOf, hexOf };
});
