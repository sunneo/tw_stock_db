/* 矩陣層：樣式比對（glob／簡單正規表示式）→ 子集構造的 DFA 轉移表。純函式 UMD，不問模型。設計：DESIGN.matrix-fallback.md §12.2「grep -o／glob／簡單 regex」與缺口 G6「由規格而非範例合成」。
 *
 * 這類題目的樣式在「輸入」裡（第一行 pat、第二行 n、接著 n 行字串，每行輸出是否符合），範例只能決定「語意」是哪一種，不能學樣式本身：
 *   語意候選（4 種）：regex 整行完全符合 ／ regex 在行中找得到 ／ glob（* 任意長度、? 恰一個字元）整行 ／ glob 找得到。
 *   regex 語法：普通字元、. 、[集合]、[^補集]（含 a-z 範圍）、? + * 量詞、| 、( )、\ 跳脫。
 * 輸出程式內含一個小引擎：樣式 → Thompson NFA → 對輸入字串做子集構造（轉移結果快取＝DFA 的轉移表，一個狀態集合對一個字元只算一次）→ 整行逐字元走表。
 * JS 側用等價的 RegExp 驗證範例；測試要求 Python 引擎對 python re 在隨機樣式×隨機字串上完全一致。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixRegex = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const ENGINE = [
        'def build(pat, glob):',
        '    # Thompson NFA：轉移 (來源, 種類, 參數, 目的)；種類 e 空轉移、c 字元、a 任一字元、s 集合、n 補集',
        '    T = []',
        '    cnt = [0]',
        '    i = [0]',
        '    def new():',
        '        cnt[0] += 1',
        '        return cnt[0] - 1',
        '    def atom():',
        '        c = pat[i[0]]',
        '        i[0] += 1',
        '        s, e = new(), new()',
        "        if glob and c == '*':",
        "            T.append((s, 'e', None, e))",
        "            T.append((s, 'a', None, s))",
        "        elif not glob and c == '(':",
        '            s2, e2 = alt()',
        '            i[0] += 1',
        "            T.append((s, 'e', None, s2))",
        "            T.append((e2, 'e', None, e))",
        "        elif c == '[':",
        "            neg = i[0] < len(pat) and pat[i[0]] == '^'",
        '            if neg:',
        '                i[0] += 1',
        '            cs = set()',
        "            while pat[i[0]] != ']':",
        "                if i[0] + 2 < len(pat) and pat[i[0] + 1] == '-' and pat[i[0] + 2] != ']':",
        '                    cs.update(chr(k) for k in range(ord(pat[i[0]]), ord(pat[i[0] + 2]) + 1))',
        '                    i[0] += 3',
        '                else:',
        '                    cs.add(pat[i[0]])',
        '                    i[0] += 1',
        '            i[0] += 1',
        "            T.append((s, 'n' if neg else 's', frozenset(cs), e))",
        "        elif (c == '.' and not glob) or (c == '?' and glob):",
        "            T.append((s, 'a', None, e))",
        "        elif c == '\\\\' and not glob:",
        "            T.append((s, 'c', pat[i[0]], e))",
        '            i[0] += 1',
        '        else:',
        "            T.append((s, 'c', c, e))",
        '        return s, e',
        '    def seq():',
        '        s = e = new()',
        "        while i[0] < len(pat) and (glob or pat[i[0]] not in '|)'):",
        '            a, b = atom()',
        "            if not glob and i[0] < len(pat) and pat[i[0]] in '?+*':",
        '                q = pat[i[0]]',
        '                i[0] += 1',
        "                if q in '?*':",
        "                    T.append((a, 'e', None, b))",
        "                if q in '+*':",
        "                    T.append((b, 'e', None, a))",
        "            T.append((e, 'e', None, a))",
        '            e = b',
        '        return s, e',
        '    def alt():',
        '        s, e = seq()',
        "        while not glob and i[0] < len(pat) and pat[i[0]] == '|':",
        '            i[0] += 1',
        '            s2, e2 = seq()',
        '            ns, ne = new(), new()',
        "            T.extend([(ns, 'e', None, s), (ns, 'e', None, s2), (e, 'e', None, ne), (e2, 'e', None, ne)])",
        '            s, e = ns, ne',
        '        return s, e',
        '    s, e = alt()',
        '    return T, s, e',
        '',
        'def make_matcher(pat, glob, search):',
        "    if search:",
        "        pat = '*' + pat + '*' if glob else '.*(' + pat + ').*'",
        '    T, start, acc = build(pat, glob)',
        '    eps = {}',
        '    for a, k, x, b in T:',
        "        if k == 'e':",
        '            eps.setdefault(a, []).append(b)',
        '    def close(S):',
        '        S = set(S)',
        '        todo = list(S)',
        '        while todo:',
        '            u = todo.pop()',
        '            for v in eps.get(u, []):',
        '                if v not in S:',
        '                    S.add(v)',
        '                    todo.append(v)',
        '        return frozenset(S)',
        '    table = {}  # DFA 轉移表：(狀態集合, 字元) -> 狀態集合，每格只算一次',
        '    def step(S, ch):',
        '        key = (S, ch)',
        '        if key not in table:',
        '            R = set()',
        '            for a, k, x, b in T:',
        '                if a in S and ((k == "c" and x == ch) or k == "a" or (k == "s" and ch in x) or (k == "n" and ch not in x)):',
        '                    R.add(b)',
        '            table[key] = close(R)',
        '        return table[key]',
        '    init = close({start})',
        '    def full(s):',
        '        S = init',
        '        for ch in s:',
        '            S = step(S, ch)',
        '            if not S:',
        '                return False',
        '        return acc in S',
        '    return full',
    ];
    // ---- JS 參考（等價的 RegExp）----
    const escRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function toRegExp(pat, glob, search) {
        let src;
        if (glob) { let out = ''; for (let i = 0; i < pat.length; i++) { const c = pat[i]; out += c === '*' ? '.*' : c === '?' ? '.' : c === '[' ? (() => { const j = pat.indexOf(']', i + 1); if (j < 0) return '\\['; const body = pat.slice(i + 1, j); i = j; return '[' + body.replace(/\\/g, '\\\\') + ']'; })() : escRe(c); } src = out; } else src = pat;
        return new RegExp(search ? '(?:' + src + ')' : '^(?:' + src + ')$', 's');
    }
    const SEM = [['regex-full', false, false], ['regex-search', false, true], ['glob-full', true, false], ['glob-search', true, true]];
    function parsePNL(e) { const l = String(e.in).replace(/\n$/, '').split('\n'); if (l.length < 3 || !/^\d+$/.test(l[1].trim()) || l.length - 2 !== Number(l[1].trim())) return null; return { pat: l[0], rows: l.slice(2) }; }
    function synthRegex(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' }; const st = String(o.statement || '');
        const P = exs.map(parsePNL); if (P.some((x) => !x)) return { ok: false, reason: '不是「樣式、n、n 行字串」的形狀' };
        const outs = exs.map((e) => String(e.out).replace(/\n$/, '').split('\n')); if (outs.some((o2, i) => o2.length !== P[i].rows.length)) return { ok: false, reason: '輸出不是每行一個答案' };
        const labels = [...new Set(outs.flat())]; if (labels.length > 2 || labels.some((x) => /\s/.test(x))) return { ok: false, reason: '輸出不是兩種標籤' };
        const stl = [...st.matchAll(/(?:輸出|印出)\s*(yes|no|YES|NO|Yes|No|是|否|match|true|false)/g)].map((m) => m[1]);
        const hits = [];
        for (const [name, glob, search] of SEM) {
            let res = []; let okAll = true;
            for (let k = 0; k < P.length && okAll; k++) { let re; try { re = toRegExp(P[k].pat, glob, search); } catch (e) { okAll = false; break; } res.push(P[k].rows.map((s) => re.test(s))); }
            if (!okAll) continue;
            const flat = res.flat(), want = outs.flat(); let yes = null, no = null;
            for (const [y, n] of (labels.length === 2 ? [[labels[0], labels[1]], [labels[1], labels[0]]] : labels.length === 1 ? [[labels[0], null], [null, labels[0]]] : [])) if (flat.every((v, i) => want[i] === (v ? y : n))) { if (yes === null && no === null) { yes = y; no = n; } }
            if (yes === null && no === null) continue;
            hits.push({ name, glob, search, yes, no, score: (glob ? /\*|glob|萬用字元/i.test(st) : /正規|regex|\[|量詞/i.test(st)) ? 2 : 0 });
        }
        if (!hits.length) return { ok: false, reason: '樣式比對（regex／glob × 整行／找得到）裡沒有符合所有範例的' };
        // 標籤：能取得兩種時，yes／no 的名字優先採敘述裡出現的；只看到一種標籤時，另一種用敘述裡的字
        hits.sort((a, b) => b.score - a.score);
        const mk = (h) => {
            let yes = h.yes, no = h.no; if (yes === null || no === null) { const other = stl.find((x) => x !== (yes || no)); if (!other) return null; if (yes === null) yes = other; else no = other; }
            const L = ENGINE.slice(); L.push('', 'def main():', '    pat = input()', '    n = int(input())', '    m = make_matcher(pat, ' + (h.glob ? 'True' : 'False') + ', ' + (h.search ? 'True' : 'False') + ')', '    for _ in range(n):', '        print(' + JSON.stringify(yes) + ' if m(input()) else ' + JSON.stringify(no) + ')');
            return { ok: true, source: L.join('\n') + '\n', kind: 'regex-dfa', level: 'L2', size: L.length, tried: SEM.length, ambiguous: false, desc: '樣式比對：' + h.name + '（NFA→子集構造 DFA 轉移表）', matrixForm: { kind: 'regex-dfa', semantics: h.name } };
        };
        const rs = hits.map(mk).filter(Boolean); if (!rs.length) return { ok: false, reason: '只看到一種標籤，敘述也沒寫另一種怎麼印' };
        const r0 = rs[0]; r0.ambiguous = hits.length > 1 && hits[1].score === hits[0].score; r0.alternatives = rs.slice(1); return r0;
    }
    function install(M) { if (!M || !M.register) return false; M.register('regex-match', synthRegex, { order: 43, level: 'L2', note: '樣式比對（glob／簡單 regex → NFA → DFA 轉移表）' }); return true; }
    return { install, synthRegex, ENGINE, toRegExp, SEM };
});
