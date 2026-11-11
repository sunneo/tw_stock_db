/* 矩陣層：文字形狀前端＋有輸出的轉換器（Mealy／逐字元／逐行）。純函式 UMD，不問模型。設計：DESIGN.matrix-fallback.md §12.3 的 G5（輸入形狀）、G1（Mealy）、G4（位元組／十六進位輸入輸出）。
 *
 * 兩個模組（用 FaMatrixSynth.register 註冊）：
 *   text-string：一行字串進、一行出。從「字串函式庫」（大小寫、反轉、凱薩移位、十六進位／二進位展開與還原、游程編碼／解碼、Base64、長度、字數…）
 *     枚舉深度≤2 的組合，對所有範例驗證。逐字元對應＝一個無記憶的 Mealy 轉換器；游程／十六進位還原＝讀兩個字元才輸出的 Mealy。
 *   text-lines：「n 行文字」或「pat、n、n 行文字」進、逐行轉換出。形狀（行數 n、可選的搜尋字串）程式推，不靠讀取器；
 *     管線＝序列運算（原樣／反序／排序／相鄰去重／縮減空行）→ 篩選（全部／含 pat／不含／忽略大小寫含／非空）→ 逐行函式 → 行號裝飾（從範例學：靠右寬度、前後綴）→ 輸出；
 *     或縮成一個數（符合行數、總字元、總字數）。
 * 每個函式同時有 JS 版（驗證範例用）與 Python 版（輸出程式用）；測試要求兩版在隨機輸入上一致。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixText = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const isInt = (s) => /^-?\d+$/.test(s);
    const q = (s) => JSON.stringify(s); // Python 字串字面量（JSON 跳脫在 Python 裡等價）
    const norm = (s) => String(s).replace(/\s+$/, '');
    const lines = (raw) => { let s = String(raw); if (s.endsWith('\n')) s = s.slice(0, -1); return s.split('\n'); };
    // ---- 字串函式庫：js 版（驗證）＋ py 版（輸出）。py 是以變數名 v 組出的運算式 ----
    const rot = (s, k) => s.replace(/[a-z]/g, (c) => String.fromCharCode((c.charCodeAt(0) - 97 + k + 26) % 26 + 97)).replace(/[A-Z]/g, (c) => String.fromCharCode((c.charCodeAt(0) - 65 + k + 26) % 26 + 65));
    const pad = (x, n) => { let t = x; while (t.length < n) t = '0' + t; return t; };
    const b64 = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'latin1').toString('base64') : btoa(s));
    const b64d = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'base64').toString('latin1') : atob(s));
    const rleEnc = (s, front) => { let r = ''; for (let i = 0; i < s.length;) { let j = i; while (j < s.length && s[j] === s[i]) j++; r += front ? (j - i) + s[i] : s[i] + (j - i); i = j; } return r; };
    const SF = [];
    const sf = (id, kw, js, py, o) => SF.push(Object.assign({ id, kw, js, py, out: 'str', imp: '' }, o || {}));
    sf('upper', /大寫|upper/i, (s) => s.toUpperCase(), (v) => v + '.upper()');
    sf('lower', /小寫|lower/i, (s) => s.toLowerCase(), (v) => v + '.lower()');
    sf('swapcase', /互換|swap/i, (s) => s.replace(/[a-zA-Z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())), (v) => v + '.swapcase()');
    sf('reverse', /反轉|反過來|顛倒|reverse/i, (s) => [...s].reverse().join(''), (v) => v + '[::-1]');
    sf('strip', /去除.*空白|strip|頭尾/i, (s) => s.trim(), (v) => v + '.strip()');
    sf('tabs-visible', /Tab|\^I/, (s) => s.split('\t').join('^I'), (v) => v + ".replace('\\t', '^I')");
    sf('no-space', /空白|空格/, (s) => s.split(' ').join(''), (v) => v + ".replace(' ', '')");
    sf('drop-vowels', /母音/, (s) => s.replace(/[aeiouAEIOU]/g, ''), (v) => "''.join(c for c in " + v + " if c not in 'aeiouAEIOU')");
    sf('keep-vowels', /母音/, (s) => s.replace(/[^aeiouAEIOU]/g, ''), (v) => "''.join(c for c in " + v + " if c in 'aeiouAEIOU')");
    sf('drop-digits', /數字/, (s) => s.replace(/[0-9]/g, ''), (v) => "''.join(c for c in " + v + " if not c.isdigit())");
    sf('keep-digits', /數字/, (s) => s.replace(/[^0-9]/g, ''), (v) => "''.join(c for c in " + v + " if c.isdigit())");
    sf('keep-letters', /字母/, (s) => s.replace(/[^a-zA-Z]/g, ''), (v) => "''.join(c for c in " + v + " if c.isalpha())");
    sf('sort-chars', /排序|由小到大|sort/i, (s) => [...s].sort().join(''), (v) => "''.join(sorted(" + v + "))");
    sf('dedup-adjacent', /相鄰|連續.*重複|重複.*連續/, (s) => s.replace(/(.)\1+/g, '$1'), (v) => "''.join(c for i, c in enumerate(" + v + ") if i == 0 or c != " + v + "[i - 1])");
    sf('capitalize', /首字母|capital|title/i, (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s), (v) => v + '.capitalize()');
    for (let k = 1; k <= 25; k++) sf('caesar' + k, new RegExp('移\\s*' + k + '\\b|\\b' + k + '\\s*位|shift\\s*' + k + '\\b|rot\\s*' + k, 'i'), (s) => rot(s, k), (v) => "''.join(chr((ord(c) - 97 + " + k + ") % 26 + 97) if 'a' <= c <= 'z' else chr((ord(c) - 65 + " + k + ") % 26 + 65) if 'A' <= c <= 'Z' else c for c in " + v + ")", { cost: 2 });
    for (const [uc, fm] of [[false, 'x'], [true, 'X']]) for (const sep of ['', ' ']) sf('hex-' + (uc ? 'upper' : 'lower') + (sep ? '-sp' : ''), /十六進位|hex|xxd/i, (s) => [...s].map((c) => pad(c.charCodeAt(0).toString(16)[uc ? 'toUpperCase' : 'toString'](), 2)).join(sep), (v) => q(sep) + ".join('%02" + fm + "' % ord(c) for c in " + v + ')', { cost: 2 });
    for (const sep of [' ', '']) sf('bits8' + (sep ? '-sp' : ''), /二進位|位元|bits?\b/i, (s) => [...s].map((c) => pad(c.charCodeAt(0).toString(2), 8)).join(sep), (v) => q(sep) + ".join(format(ord(c), '08b') for c in " + v + ')', { cost: 2 });
    sf('ord-sp', /ASCII|碼/, (s) => [...s].map((c) => c.charCodeAt(0)).join(' '), (v) => "' '.join(str(ord(c)) for c in " + v + ')', { cost: 2 });
    sf('hex-decode', /還原|十六進位|hex/i, (s) => { if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error('not hex'); let r = ''; for (let i = 0; i < s.length; i += 2) r += String.fromCharCode(parseInt(s.substr(i, 2), 16)); return r; }, (v) => "''.join(chr(int(" + v + "[i:i + 2], 16)) for i in range(0, len(" + v + "), 2))", { cost: 2 });
    sf('rle-enc-front', /游程|行程|run.?length|rle|壓縮/i, (s) => rleEnc(s, true), (v) => "''.join(str(len(list(g))) + k for k, g in __import__('itertools').groupby(" + v + '))', { cost: 2 });
    sf('rle-enc-back', /游程|行程|run.?length|rle|壓縮/i, (s) => rleEnc(s, false), (v) => "''.join(k + str(len(list(g))) for k, g in __import__('itertools').groupby(" + v + '))', { cost: 2 });
    sf('rle-dec-front', /游程|行程|run.?length|rle|還原|解壓/i, (s) => { const m = [...s.matchAll(/(\d+)(\D)/g)]; if (m.map((x) => x[0]).join('') !== s) throw new Error('bad rle'); return m.map((x) => x[2].repeat(Number(x[1]))).join(''); }, (v) => "''.join(c * int(n) for n, c in __import__('re').findall(r'(\\d+)(\\D)', " + v + '))', { cost: 2 });
    sf('rle-dec-back', /游程|行程|run.?length|rle|還原|解壓/i, (s) => { const m = [...s.matchAll(/(\D)(\d+)/g)]; if (m.map((x) => x[0]).join('') !== s) throw new Error('bad rle'); return m.map((x) => x[1].repeat(Number(x[2]))).join(''); }, (v) => "''.join(c * int(n) for c, n in __import__('re').findall(r'(\\D)(\\d+)', " + v + '))', { cost: 2 });
    sf('base64-enc', /base64/i, (s) => b64(s), (v) => "__import__('base64').b64encode(" + v + ".encode()).decode()", { cost: 2 });
    sf('base64-dec', /base64/i, (s) => b64d(s), (v) => "__import__('base64').b64decode(" + v + ").decode()", { cost: 2 });
    sf('len', /長度|幾個字元|length/i, (s) => String([...s].length), (v) => 'str(len(' + v + '))', { out: 'int' });
    sf('words', /單字|字數|words?/i, (s) => String(s.split(/\s+/).filter(Boolean).length), (v) => 'str(len(' + v + '.split()))', { out: 'int' });
    sf('first-word', /第一個單字|首個/, (s) => (s.split(/\s+/).filter(Boolean)[0] || ''), (v) => '(' + v + ".split() or [''])[0]");
    sf('last-word', /最後一個單字|最後/, (s) => { const w = s.split(/\s+/).filter(Boolean); return w.length ? w[w.length - 1] : ''; }, (v) => '(' + v + ".split() or [''])[-1]");
    sf('distinct', /不同|相異|distinct/i, (s) => String(new Set([...s]).size), (v) => 'str(len(set(' + v + ')))', { out: 'int' });
    sf('vowel-count', /母音/, (s) => String((s.match(/[aeiouAEIOU]/g) || []).length), (v) => "str(sum(1 for c in " + v + " if c in 'aeiouAEIOU'))", { out: 'int' });
    sf('digit-sum', /數字.*和|各位/, (s) => String([...s].filter((c) => /[0-9]/.test(c)).reduce((a, c) => a + Number(c), 0)), (v) => 'str(sum(int(c) for c in ' + v + ' if c.isdigit()))', { out: 'int' });
    // 整數進（字串形式）→ 進位表示
    sf('int-hex', /十六進位|hex/i, (s) => { if (!isInt(s) || s[0] === '-') throw new Error('x'); return BigInt(s).toString(16); }, (v) => "format(int(" + v + "), 'x')", { cost: 2 });
    sf('int-bin', /二進位|binary/i, (s) => { if (!isInt(s) || s[0] === '-') throw new Error('x'); return BigInt(s).toString(2); }, (v) => "format(int(" + v + "), 'b')", { cost: 2 });
    sf('int-oct', /八進位|octal/i, (s) => { if (!isInt(s) || s[0] === '-') throw new Error('x'); return BigInt(s).toString(8); }, (v) => "format(int(" + v + "), 'o')", { cost: 2 });
    const IDENT = { id: 'identity', kw: /^$/, js: (s) => s, py: (v) => v, out: 'str', imp: '', cost: 0 };
    const compose = (f, g) => ({ id: g.id + '→' + f.id, kw: f.kw, js: (s) => f.js(g.js(s)), py: (v) => f.py(g.py(v)), out: f.out, cost: (f.cost || 1) + (g.cost || 1) });
    // 深度 1 與 2 的候選（第二層只接「字串→字串」的函式）
    function candidates() { const L1 = [IDENT].concat(SF.map((f) => Object.assign({ cost: 1 }, f))); const out = L1.slice(); for (const f of SF) for (const g of SF) { if (g.out !== 'str') continue; out.push(compose(Object.assign({ cost: 1 }, f), Object.assign({ cost: 1 }, g))); } return out; }
    const CANDS = candidates();
    const prio = (f, st) => (f.cost || 1) - (f.kw && f.kw.test(st) ? 1.5 : 0);
    const PROBES = ['Hello World 123', 'a', 'abc xyz', 'Tab\there', 'ZzAa09', 'the quick brown fox', 'aabbbcccc', 'Mississippi', '  lead', 'x y  z'];
    const same = (a, b, f1, f2) => { for (const p of PROBES.concat(a, b)) { let x, y; try { x = f1.js(p); } catch (e) { x = '\u0000err'; } try { y = f2.js(p); } catch (e) { y = '\u0000err'; } if (x !== y) return false; } return true; };

    // ---- text-string：一行字串進、一行出 ----
    function synthString(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' };
        const st = String(o.statement || ''); const I = [], O = [];
        for (const e of exs) { const il = lines(e.in), ol = lines(e.out); if (il.length !== 1 || ol.length !== 1) return { ok: false, reason: '不是一行進一行出' }; I.push(il[0].replace(/\r$/, '')); O.push(norm(ol[0])); }
        const hits = []; let tried = 0;
        for (const f of CANDS) {
            tried++; let ok = true;
            for (let i = 0; i < I.length && ok; i++) { let r; try { r = f.js(I[i]); } catch (e) { ok = false; break; } if (norm(r) !== O[i]) ok = false; }
            if (ok) hits.push(f);
        }
        if (!hits.length) return { ok: false, reason: '字串函式庫（' + CANDS.length + ' 個組合）裡沒有符合所有範例的', tried };
        // 恆等式不算解（輸入輸出相同表示範例沒有資訊）
        const real = hits.filter((f) => f.id !== 'identity'); if (!real.length) return { ok: false, reason: '只有恆等函式符合（範例沒有資訊）', tried };
        real.sort((a, b) => prio(a, st) - prio(b, st));
        const top = real[0]; const diff = real.slice(1).filter((f) => !same(I.join(''), O.join(''), top, f));
        const intIn = I.every(isInt) && /int-/.test(top.id);
        const src = ['def main():', '    s = input().rstrip("\\r\\n")', '    print(' + top.py('s') + ')'].join('\n') + '\n';
        const mk = (f) => ({ ok: true, source: ['def main():', '    s = input().rstrip("\\r\\n")', '    print(' + f.py('s') + ')'].join('\n') + '\n', kind: 'mealy', level: 'L2', size: 3, tried, ambiguous: false, desc: '字串轉換：' + f.id, matrixForm: { kind: 'mealy', fn: f.id } });
        void src; void intIn; const r0 = mk(top); r0.ambiguous = diff.length > 0; r0.alternatives = diff.slice(0, 20).map(mk);
        if (r0.ambiguous) r0.suggest = suggestInputs(top, diff);
        return r0;
    }
    function suggestInputs(top, diff) { const out = []; for (const p of PROBES) { const outs = new Set(); let a; try { a = top.js(p); } catch (e) { continue; } for (const f of diff) { let b; try { b = f.js(p); } catch (e) { b = '\u0000err'; } if (b !== a) outs.add(b); } if (outs.size) out.push({ in: p + '\n', candidates: [a].concat([...outs]).slice(0, 4) }); if (out.length >= 3) break; } return out; }

    // ---- text-lines：n 行文字（可帶搜尋字串）進、逐行轉換 ----
    function parseLinesShape(exs) {
        const parsed = exs.map((e) => lines(e.in)); const allNL = parsed.every((l) => l.length >= 1 && isInt(l[0].trim()) && l.length - 1 === Number(l[0].trim()));
        if (allNL) return { kind: 'NL', items: parsed.map((l) => ({ pat: null, rows: l.slice(1) })) };
        const allPNL = parsed.every((l) => l.length >= 2 && isInt(l[1].trim()) && l.length - 2 === Number(l[1].trim()) && !isInt(l[0].trim()));
        if (allPNL) return { kind: 'PNL', items: parsed.map((l) => ({ pat: l[0], rows: l.slice(2) })) };
        return null;
    }
    const FILTERS = [
        { id: 'all', kw: /^$/, js: () => true, py: () => 'True', pat: false },
        { id: 'contains', kw: /含有|包含|搜尋|grep/, js: (s, p) => s.includes(p), py: () => 'pat in s', pat: true },
        { id: 'not-contains', kw: /不含|不包含|-v/, js: (s, p) => !s.includes(p), py: () => 'pat not in s', pat: true },
        { id: 'icontains', kw: /忽略大小寫|-i|不分大小寫/, js: (s, p) => s.toLowerCase().includes(p.toLowerCase()), py: () => 'pat.lower() in s.lower()', pat: true },
        { id: 'startswith', kw: /開頭|開始/, js: (s, p) => s.startsWith(p), py: () => 's.startswith(pat)', pat: true },
        { id: 'endswith', kw: /結尾|結束/, js: (s, p) => s.endsWith(p), py: () => 's.endswith(pat)', pat: true },
        { id: 'nonempty', kw: /空行|空白行|非空/, js: (s) => s.length > 0, py: () => "s != ''", pat: false },
    ];
    const SEQS = [
        { id: 'keep', kw: /^$/, js: (a) => a.slice(), py: [] },
        { id: 'tac', kw: /反序|倒過來|最後一行.*第一行|tac|由後往前/i, js: (a) => a.slice().reverse(), py: ['rows = rows[::-1]'] },
        { id: 'sorted', kw: /排序|由小到大|字典序|sort/i, js: (a) => a.slice().sort(), py: ['rows = sorted(rows)'] },
        { id: 'sorted-uniq', kw: /排序.*(重複|去重)|sort -u/, js: (a) => [...new Set(a)].sort(), py: ['rows = sorted(set(rows))'] },
        { id: 'uniq-adjacent', kw: /相鄰.*(重複|相同)|uniq/i, js: (a) => a.filter((x, i) => i === 0 || x !== a[i - 1]), py: ['rows = [x for i, x in enumerate(rows) if i == 0 or x != rows[i - 1]]'] },
        { id: 'squeeze', kw: /連續.*空行|-s/, js: (a) => a.filter((x, i) => !(i > 0 && x === '' && a[i - 1] === '')), py: ['rows = [x for i, x in enumerate(rows) if not (i > 0 and x == "" and rows[i - 1] == "")]'] },
    ];
    // 從範例學行號裝飾：o ＝ 左 + 靠右補空白到寬度 w 的數字 + 右 + 內容 + 後綴
    function learnDeco(rows, outs, idxs, core, suf) {
        if (!rows.length) return [{ left: '', w: 0, right: '', suf }];
        const p0 = outs[0].slice(0, outs[0].length - core[0].length - suf.length); if (p0 === '') return [{ left: '', w: 0, right: '', suf, none: true }];
        const m = p0.match(/^(.*?)( *)(\d+)(.*)$/s); if (!m) return [];
        const res = []; for (const idxv of idxs[0] === undefined ? [] : [0]) { void idxv; }
        const out = [];
        for (let w = m[3].length; w <= m[2].length + m[3].length; w++) { const left = m[1] + ' '.repeat(Math.max(0, m[2].length + m[3].length - w)); out.push({ left, w, right: m[4], suf }); }
        void res; return out;
    }
    const fmtDeco = (d, i) => (d.none ? '' : d.left + String(i).padStart(d.w, ' ') + d.right);
    function runLines(cfg, item) {
        let rows = cfg.seq.js(item.rows); const outRows = []; const kept = [];
        rows.forEach((s, i) => { if (cfg.filter.js(s, item.pat)) kept.push({ s, i: i + 1 }); });
        if (cfg.reduce) { const vals = kept.map((k) => k.s); if (cfg.reduce === 'count') return [String(vals.length)]; if (cfg.reduce === 'chars') return [String(vals.reduce((a, s) => a + [...s].length, 0))]; if (cfg.reduce === 'words') return [String(vals.reduce((a, s) => a + s.split(/\s+/).filter(Boolean).length, 0))]; if (cfg.reduce === 'maxlen') return [String(vals.reduce((a, s) => Math.max(a, [...s].length), 0))]; }
        kept.forEach((k, ord) => { const idx = cfg.idxMode === 'ord' ? ord + 1 : k.i; outRows.push(fmtDeco(cfg.deco, idx) + cfg.fn.js(k.s) + cfg.deco.suf); });
        return outRows;
    }
    function pyLines(cfg, shape) {
        const L = ['def main():']; if (shape.kind === 'PNL') L.push('    pat = input()'); L.push('    n = int(input())', '    rows = [input() for _ in range(n)]'); for (const l of cfg.seq.py) L.push('    ' + l);
        const cond = cfg.filter.py();
        L.push('    out = []', '    for i, s in enumerate(rows, 1):', '        if ' + cond + ':', '            out.append((i, s))');
        if (cfg.reduce) { const e = { count: 'len(out)', chars: 'sum(len(s) for _, s in out)', words: 'sum(len(s.split()) for _, s in out)', maxlen: 'max([len(s) for _, s in out] or [0])' }[cfg.reduce]; L.push('    print(' + e + ')'); return L.join(String.fromCharCode(10)) + String.fromCharCode(10); }
        const num = cfg.idxMode === 'ord' ? 'k' : 'i'; const head = cfg.deco.none ? '' : q(cfg.deco.left) + ' + str(' + num + ').rjust(' + cfg.deco.w + ') + ' + q(cfg.deco.right) + ' + ';
        L.push('    for k, (i, s) in enumerate(out, 1):', '        print(' + head + cfg.fn.py('s') + (cfg.deco.suf ? ' + ' + q(cfg.deco.suf) : '') + ')');
        return L.join(String.fromCharCode(10)) + String.fromCharCode(10);
    }
    function synthLines(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' }; const st = String(o.statement || '');
        const shape = parseLinesShape(exs); if (!shape) return { ok: false, reason: '不是「n 行文字」或「pat、n、n 行文字」的形狀' };
        const outs = exs.map((e) => (norm(e.out) === '' ? [] : lines(e.out)));
        const hasPat = shape.kind === 'PNL'; const hits = []; let tried = 0;
        const fns = CANDS.filter((f) => f.out === 'str' || true);
        for (const seq of SEQS) for (const filter of FILTERS) {
            if (filter.pat && !hasPat) continue; if (!filter.pat && hasPat && filter.id !== 'all' && filter.id !== 'nonempty') continue;
            // 縮成一個數
            for (const red of ['count', 'chars', 'words', 'maxlen']) { tried++; const cfg = { seq, filter, reduce: red }; if (shape.items.every((it, k) => { let r; try { r = runLines(cfg, it); } catch (e) { return false; } return r.length === outs[k].length && r.every((x, j) => x === norm(outs[k][j])); })) hits.push({ cfg, cost: 1 + (seq.id === 'keep' ? 0 : 1) }); }
            for (const fn of fns) {
                tried++;
                // 核心文字：先不看裝飾，用範例求每個輸出行的「核心」＝fn(原行)，再學前後綴
                const per = []; let ok = true;
                for (let k = 0; k < shape.items.length && ok; k++) {
                    const it = shape.items[k]; const rows = seq.js(it.rows); const kept = []; rows.forEach((s, i) => { if (filter.js(s, it.pat)) kept.push({ s, i: i + 1 }); });
                    if (kept.length !== outs[k].length) { ok = false; break; }
                    const core = []; for (const kp of kept) { let c; try { c = fn.js(kp.s); } catch (e) { ok = false; break; } core.push(c); } if (!ok) break;
                    per.push({ kept, core });
                }
                if (!ok) continue;
                for (const suf of ['', '$']) {
                    let decos = null; const flat = { rows: [], outs: [], core: [] };
                    per.forEach((p, k) => p.kept.forEach((kp, j) => { flat.rows.push(kp); flat.outs.push(norm(outs[k][j]) === outs[k][j] ? outs[k][j] : outs[k][j]); flat.core.push(p.core[j]); }));
                    if (!flat.outs.length) { if (suf === '' && fn.id === 'identity') decos = [{ left: '', w: 0, right: '', suf: '', none: true }]; else continue; }
                    else {
                        if (!flat.outs.every((x, j) => x.endsWith(flat.core[j] + suf))) continue;
                        // 行尾空白被 norm 吃掉的情況：逐行輸出不 norm 尾端以外的部分
                        const first = flat.outs.findIndex((x, j) => x.length > flat.core[j].length + suf.length || true); void first;
                        decos = learnDeco(flat.rows, flat.outs, [], flat.core, suf);
                    }
                    for (const d of decos) for (const idxMode of ['orig', 'ord']) {
                        if (d.none && idxMode === 'ord') continue; const cfg = { seq, filter, fn, deco: d, idxMode };
                        if (shape.items.every((it, k) => { let r; try { r = runLines(cfg, it); } catch (e) { return false; } return r.length === outs[k].length && r.every((x, j) => norm(x) === norm(outs[k][j]) || x === outs[k][j]); })) hits.push({ cfg, cost: (fn.cost || 1) + (seq.id === 'keep' ? 0 : 1) + (filter.id === 'all' ? 0 : 1) + (d.none ? 0 : 1) });
                    }
                }
            }
        }
        if (!hits.length) return { ok: false, reason: '逐行轉換管線（序列運算 × 篩選 × 逐行函式 × 行號裝飾）裡沒有符合所有範例的', tried };
        const score = (h) => h.cost - (h.cfg.filter.kw.test(st) ? 1.5 : 0) - (h.cfg.seq.kw.test(st) ? 1.5 : 0) - (h.cfg.fn && h.cfg.fn.kw && h.cfg.fn.id !== 'identity' && h.cfg.fn.kw.test(st) ? 1.5 : 0);
        hits.sort((a, b) => score(a) - score(b));
        // 去掉「所有範例上輸出都相同但其實只是裝飾寬度變體」：用探測輸入比對是否真的不同
        const probe = probeItems(hasPat); const sig = (h) => probe.map((it) => { try { return runLines(h.cfg, it).join('\n'); } catch (e) { return '\u0000err'; } }).join('\u0001');
        const s0 = sig(hits[0]); const diff = []; const seen = new Set([s0]); for (const h of hits.slice(1)) { const s = sig(h); if (!seen.has(s)) { seen.add(s); diff.push(h); } }
        const mk = (h) => ({ ok: true, source: pyLines(h.cfg, shape), kind: 'text-lines', level: 'L6', size: h.cost, tried, ambiguous: false, desc: '逐行：' + [h.cfg.seq.id, h.cfg.filter.id, h.cfg.reduce ? 'reduce:' + h.cfg.reduce : (h.cfg.fn.id + (h.cfg.deco.none ? '' : '+行號'))].join(' / '), matrixForm: { kind: 'text-lines', seq: h.cfg.seq.id, filter: h.cfg.filter.id, fn: h.cfg.fn ? h.cfg.fn.id : null, reduce: h.cfg.reduce || null } });
        const r0 = mk(hits[0]); r0.ambiguous = diff.length > 0; r0.alternatives = diff.slice(0, 20).map(mk);
        return r0;
    }
    function probeItems(hasPat) { const rows = ['Apple pie', '', 'banana  split', 'apple\ttart', 'Apple pie', '', '', 'cherry']; const mk = (r, pat) => ({ pat, rows: r }); const ps = hasPat ? ['ple', 'APP', 'an', 'x'] : [null]; const items = []; for (const p of ps) { items.push(mk(rows, p)); items.push(mk(rows.slice(0, 3), p)); items.push(mk(['b', 'a', 'a', 'c'], p)); } return items; }
    function install(M) { if (!M || !M.register) return false; M.register('text-string', synthString, { order: 44, level: 'L2', note: '一行字串轉換（逐字元／展開／還原／編碼，有輸出的轉換器）' }); M.register('text-lines', synthLines, { order: 45, level: 'L6', note: 'n 行文字逐行轉換（行號、篩選、反序、排序…）' }); return true; }
    return { install, synthString, synthLines, SF, CANDS, parseLinesShape, runLines, lines };
});
