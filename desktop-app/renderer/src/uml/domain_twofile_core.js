/* 領域包：Linux 兩段輸入工具（純函式，Python 專屬）。格式見 domain_registry_core.js。
 * 輸入形狀：兩段文字（各自一行數量加上若干行；讀取器的 lines、lines2），例如 cat -n 檔1 檔2、comm／diff（只在其中一檔的行）、join（依第一欄合併）、paste（逐行並排）、cmp（第一個不同的行）。
 * 差異點（行號寬度與分隔、是否去重／排序、保留未配對的行、分隔符號、全相同時印什麼）是槽位，由沙盒窮舉；全相同的標籤只在敘述裡有唯一的全大寫詞時才用，抽不到就拒絕渲染。骨架不含 def。train／holdout 見 domain_twofile.test.js。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainTwofile = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const shape = (I) => I.inputs.filter((x) => x.k === 'lines').length >= 2;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'text-lines', label, slots, py, shape }, extra || {});
        const two = (N) => { if (!N.L || N.L.length < 2) throw new Error('只有一段文字輸入'); return [N.L[0], N.L[1]]; };
        const SEP = { T: '"\\t"', S: '" "', C: '","' };
        const capsLabel = (I) => { const caps = [...new Set([...String(I.statement).matchAll(/(?:輸出|印出)\s*([A-Z][A-Z_]{2,})/g)].map((x) => x[1]))]; return caps.length === 1 ? caps[0] : null; };
        const skeletons = [
            D('tf.cat-n', 'two-cat', 'cat -n 檔1 檔2：把兩段文字依序接起來，逐行編號；行號跨檔連續或每檔重新從 1 開始；行號靠右對齊寬度 6 或不補空白；行號與文字之間是 Tab 或一個空白',
                [S('run', '行號', [['cont', 'cont'], ['restart', 'restart']]), S('wd', '行號寬度', [['6', '6'], ['0', '0']]), S('sep', '行號後的分隔', [['T', 'T'], ['S', 'S']])],
                (c, N) => { const [A, B] = two(N); const num = c.wd === '6' ? 'str(n).rjust(6)' : 'str(n)';
                    return code(['n = 0', 'for part in (' + A + ', ' + B + '):'].concat(c.run === 'restart' ? ['    n = 0'] : [], ['    for t in part:', '        n += 1', '        print(' + num + ' + ' + SEP[c.sep] + ' + t)'])); }, { limit: 8 }),
            D('tf.set', 'two-set', 'comm／diff：比較兩段文字的行，輸出只在第一段、只在第二段或兩段都有的行（或個數）；依原本順序或排序；重複的行只留一次或全留',
                [S('which', '哪些行', [['a', 'a'], ['b', 'b'], ['both', 'both']]), S('ord', '順序', [['keep', 'keep'], ['sorted', 'sorted']]), S('dd', '重複的行', [['uniq', 'uniq'], ['all', 'all']]), S('out', '輸出', [['lines', 'lines'], ['count', 'count']])],
                (c, N) => { const [A, B] = two(N); const [X, Y, neg] = c.which === 'a' ? [A, B, 'not '] : c.which === 'b' ? [B, A, 'not '] : [A, B, ''];
                    return code(['res = [t for t in ' + X + ' if t ' + neg + 'in set(' + Y + ')]'].concat(c.dd === 'uniq' ? ['res = list(dict.fromkeys(res))'] : [], c.ord === 'sorted' ? ['res = sorted(res)'] : [], c.out === 'count' ? ['print(len(res))'] : ['for t in res:', '    print(t)'])); }, { limit: 24 }),
            D('tf.join', 'two-join', 'join：兩段文字各行的第一欄當鍵，鍵相同的行合併成「鍵 第一段其餘欄 第二段其餘欄」；沒配到的行丟掉或保留第一段的；依第一段順序或依鍵排序；欄位用空白或 Tab 接',
                [S('keep', '沒配到', [['inner', 'inner'], ['left', 'left']]), S('ord', '順序', [['a', 'a'], ['key', 'key']]), S('sep', '輸出分隔', [['S', 'S'], ['T', 'T']])],
                (c, N) => { const [A, B] = two(N); const s = SEP[c.sep];
                    return code(['dic = {}', 'for t in ' + B + ':', '    f = t.split()', '    dic.setdefault(f[0], []).append(f[1:])', 'res = []', 'for t in ' + A + ':', '    f = t.split()', '    if f[0] in dic:', '        for r in dic[f[0]]:', '            res.append((f[0], ' + s + '.join([f[0]] + f[1:] + r)))'].concat(c.keep === 'left' ? ['    else:', '        res.append((f[0], ' + s + '.join(f)))'] : [], c.ord === 'key' ? ['res = sorted(res, key=lambda p: p[0])'] : [], ['for p in res:', '    print(p[1])'])); }, { limit: 8 }),
            D('tf.paste', 'two-paste', 'paste：兩段文字逐行並排，第 i 行接第 i 行；用 Tab、空白或逗號隔開；一邊較短時用空字串補',
                [S('sep', '分隔', [['T', 'T'], ['S', 'S'], ['C', 'C']])],
                (c, N) => { const [A, B] = two(N);
                    return code(['for i in range(max(len(' + A + '), len(' + B + '))):', '    x = ' + A + '[i] if i < len(' + A + ') else ""', '    y = ' + B + '[i] if i < len(' + B + ') else ""', '    print(x + ' + SEP[c.sep] + ' + y)']); }, { limit: 6 }),
            D('tf.cmp', 'two-cmp', 'cmp：逐行比較兩段文字，輸出第一個不同的行號（從 1 開始；一邊先結束也算不同）或不同的行數；完全相同時輸出 0、-1 或敘述裡的標籤',
                [S('out', '輸出', [['first', 'first'], ['count', 'count']]), S('same', '全相同時', [['0', '0'], ['-1', '-1'], ['label', 'label']])],
                (c, N, I) => { const [A, B] = two(N); const lab = capsLabel(I); if (c.same === 'label' && !lab) throw new Error('抽不到全相同的標籤'); const sm = c.same === 'label' ? JSON.stringify(lab) : c.same;
                    return code(['dif = []', 'for i in range(max(len(' + A + '), len(' + B + '))):', '    x = ' + A + '[i] if i < len(' + A + ') else None', '    y = ' + B + '[i] if i < len(' + B + ') else None', '    if x != y:', '        dif.append(i + 1)'].concat(c.out === 'first' ? ['print(dif[0] if dif else ' + sm + ')'] : ['print(len(dif) if dif else ' + sm + ')'])); }, { limit: 8 }),
        ];
        const algos = [
            ['two-cat', /cat\s*-n.{0,12}(?:檔\s*1|檔案\s*1|兩個|兩段|兩份)|行號.{0,12}(?:跨檔|連續編|不重新開始)|兩個?檔案.{0,16}(?:依序)?(?:連接|接起來|串起來).{0,12}(?:行號|編號)/i],
            ['two-set', /\bcomm\b|\bdiff\b|只(?:出現)?在\s*(?:A|B|第一|第二|檔案\s*[12AB]|甲|乙).{0,8}(?:出現|有)|只出現(?:在)\s*(?:A|B|甲|乙|第一|第二)|兩(?:個)?檔(?:案)?(?:都有|共同)的行|共同的行|差集|交集/i],
            ['two-join', /\bjoin\b|依第一欄(?:合併|連接|配對)|以第一欄為鍵.{0,10}(?:合併|連接|配對)|第一欄(?:相同|一樣).{0,10}(?:合併|接成)/i],
            ['two-paste', /\bpaste\b|逐行並排|並排(?:輸出|接)|第\s*i\s*行.{0,10}接.{0,6}第\s*i\s*行/i],
            ['two-cmp', /\bcmp\b|第一個不同的行|第一處不同|第一個(?:內容)?不(?:一樣|同)的行|逐行(?:比較|對照|比對|對比).{0,40}不(?:同|一樣)的行/i],
        ].map(([key, re]) => ({ key, re, pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['text-lines'];
        return { id: 'twofile', label: 'Linux 兩段輸入工具（cat -n 兩檔、comm／diff、join、paste、cmp）', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
