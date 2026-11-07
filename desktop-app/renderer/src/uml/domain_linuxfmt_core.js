/* 領域包：Linux 格式／規格型小工具的「參數化家族」（純函式，Python 專屬）。格式見 domain_registry_core.js。
 * 家族（不是單一題）：樣板變數展開（$NAME／${NAME}，名稱字元集與未定義處理是槽位）、區塊對齊計數（區塊大小取自敘述；標頭區塊、結尾區塊、輸出形式是槽位）、範式前綴碼（DEFLATE 的 bl_count／next_code，輸出格式是槽位）。
 * 區塊大小這類常數必須在敘述裡抽得到，抽不到就拒絕渲染，不猜。骨架不含 def。train／holdout 見 domain_linuxfmt.test.js。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainLinuxfmt = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'format', label, slots, py }, extra || {});
        const need = (v, what) => { if (v === undefined || v === null || v === '') throw new Error('抽不到' + what); return v; };
        const blockSize = (t) => { const m = /(\d+)\s*(?:個)?\s*位元組\s*(?:為|是|當作)?\s*(?:一個|1\s*個)?\s*(?:區塊|扇區|頁|block)|區塊大小(?:為|是)?\s*(\d+)|每個區塊\s*(\d+)|(?:block|區塊)\s*(?:size|大小)?\s*(\d+)/i.exec(String(t)); return m ? Number(m[1] || m[2] || m[3] || m[4]) : null; };
        const skeletons = [
            D('lf.env-expand', 'env-expand', '樣板變數展開：「名稱=值」表，樣板裡的 $名稱 與 ${名稱} 換成值；名稱字元集（大寫字母，或英數字加底線）決定 $名稱 取到哪裡；沒定義的名稱換成空字串或原樣保留；是否也認不帶括號的 $名稱',
                [S('nm', '名稱字元', [['upper', 'upper'], ['word', 'word']]), S('undef', '沒定義', [['empty', 'empty'], ['keep', 'keep']]), S('bare', '不帶括號的 $名稱', [['yes', 'yes'], ['no', 'no']])],
                (c, N) => { const tab = need(N.L && N.L[0], '「名稱=值」的行'), tpl = need(N.s && N.s[0], '樣板'); const ok = c.nm === 'upper' ? 'ch.isupper()' : '(ch.isalnum() or ch == "_")';
                    return code(['env = {}', 'for line in ' + tab + ':', '    if "=" in line:', '        k, v = line.split("=", 1)', '        env[k] = v', 'src = ' + tpl, 'out = []', 'i = 0', 'while i < len(src):', '    ch = src[i]', '    if ch == "$" and i + 1 < len(src) and src[i + 1] == "{":', '        j = src.find("}", i + 2)', '        if j < 0:', '            out.append(ch)', '            i += 1', '            continue', '        nm = src[i + 2:j]', '        out.append(env.get(nm, "" if "' + c.undef + '" == "empty" else src[i:j + 1]))', '        i = j + 1', '    elif ch == "$" and "' + c.bare + '" == "yes" and i + 1 < len(src) and ' + ok.split('ch').join('src[i + 1]') + ':', '        j = i + 1', '        while j < len(src) and ' + ok.split('ch').join('src[j]') + ':', '            j += 1', '        nm = src[i + 1:j]', '        out.append(env.get(nm, "" if "' + c.undef + '" == "empty" else src[i:j]))', '        i = j', '    else:', '        out.append(ch)', '        i += 1', 'print("".join(out))']); }, { limit: 8 }),
            D('lf.block-count', 'block-count', '區塊對齊計數：檔案大小除以區塊大小無條件進位得資料區塊數，加上標頭區塊（tar 是 1 個）；整個封存檔再加結尾區塊（tar 是 2 個全 0 區塊）；輸出佔用區塊數、封存檔總位元組數、浪費的位元組數（內部碎片），或其中兩項各一行',
                [S('hdr', '標頭區塊數', [['1', '1'], ['0', '0']]), S('tl', '結尾區塊數', [['2', '2'], ['0', '0']]), S('out', '輸出', [['both', 'both'], ['blocks', 'blocks'], ['total', 'total'], ['slack', 'slack'], ['blocks-slack', 'blocks-slack']])],
                (c, N, I) => { const b = need(blockSize(I.statement), '區塊大小'); const s = need(N.sc[0], '檔案大小 s');
                    const pr = { both: ['print(blocks)', 'print((blocks + ' + c.tl + ') * ' + b + ')'], blocks: ['print(blocks)'], total: ['print((blocks + ' + c.tl + ') * ' + b + ')'], slack: ['print(data * ' + b + ' - ' + s + ')'], 'blocks-slack': ['print(data)', 'print(data * ' + b + ' - ' + s + ')'] }[c.out];
                    return code(['data = (' + s + ' + ' + b + ' - 1) // ' + b, 'blocks = data + (' + c.hdr + ' if ' + s + ' >= 0 else 0)'].concat(pr)); }, { limit: 20 }),
            D('lf.canon-huffman', 'canon-huffman', '範式前綴碼（DEFLATE，RFC 1951）：bl_count[L]＝碼長為 L 的符號數，next_code[L]=(next_code[L-1]+bl_count[L-1])*2；依符號編號由小到大，碼長非 0 者取 next_code[len]++；輸出每個使用中符號的碼（二進位、補零到碼長），格式「符號 碼」、「符號:碼」或只輸出碼；依符號編號或依碼排序',
                [S('sep', '符號與碼之間', [['sp', 'sp'], ['colon', 'colon'], ['none', 'none']]), S('ord', '順序', [['sym', 'sym'], ['code', 'code']])],
                (c, N) => { const a = need(N.ls[0], '碼長清單'); const sp = { sp: '" "', colon: '":"', none: null }[c.sep];
                    return code(['lens = list(' + a + ')', 'mx = max(lens) if lens else 0', 'bl = [0] * (mx + 2)', 'for x in lens:', '    if x > 0:', '        bl[x] += 1', 'nxt = [0] * (mx + 2)', 'cc = 0', 'for b in range(1, mx + 1):', '    cc = (cc + bl[b - 1]) << 1', '    nxt[b] = cc', 'res = []', 'for k in range(len(lens)):', '    if lens[k] > 0:', '        res.append((k, format(nxt[lens[k]], "0" + str(lens[k]) + "b")))', '        nxt[lens[k]] += 1'].concat(c.ord === 'code' ? ['res.sort(key=lambda p: p[1])'] : [], ['for k, s in res:', sp ? '    print(str(k) + ' + sp + ' + s)' : '    print(s)'])); }, { limit: 6 }),
        ];
        const algos = [
            ['env-expand', /\$\{?[A-Za-z名]|環境變數(?:展開|替換)|變數展開|樣板.{0,12}(?:換成|替換).{0,6}值/i], ['block-count', /區塊.{0,16}(?:佔用|補\s*0|補零|對齊)|tar.{0,12}區塊|(?:佔用|需要)(?:幾個|多少)區塊|內部碎片/i], ['canon-huffman', /範式(?:碼|Huffman|霍夫曼)|canonical\s*huffman|bl_count|next_code/i],
        ].map(([key, re]) => ({ key, re, pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['format'];
        return { id: 'linuxfmt', label: 'Linux 格式型小工具家族（樣板展開、區塊對齊、範式前綴碼）', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
