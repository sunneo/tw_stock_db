/* 領域包：「讀欄位」與「計數」兩個範式（二進位檔的固定位移欄位、位元組標記的出現次數、某位元組值的個數）。格式見 domain_registry_core.js。
 * 原因：2026-11-12 的乾淨 holdout（domain_fresh_holdout.test.js）0/27，根因是現有 7 個領域包都是「解碼成完整內容／編碼成完整檔」，沒有「讀固定位移欄位」與「數一數」。
 * bin.field-read：一行十六進位；位移 O 與欄位寬 W 由敘述抽（「位移 O」「欄位寬 W 個位元組」），抽不到就拒絕渲染；端序（小端／大端）與有無號是槽位，由沙盒窮舉。
 * bin.count-mark：一行十六進位；標記（「ab cd」形式的引號內容）由敘述抽；可重疊與不重疊是槽位。
 * bin.count-byte：一行十六進位；比較值（「等於 X」「為 X」，X 可十進位或 0x）由敘述抽；計入範圍（全部／不計第一個位元組）是槽位。
 * 誠實限制：只做「原始位元組上的固定位移」與「位元組序列的出現次數」；不做解壓後再計數、不做 TLV 迴圈。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainFieldCount = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const quoted = (st) => [...String(st).matchAll(/[「『"]([^」』"]+)[」』"]/g)].map((m) => m[1].trim());
        const HEXM = /^[0-9a-fA-F]{2}(?: [0-9a-fA-F]{2})*$/;
        const skeletons = [
            { id: 'bin.field-read', algo: 'field-read', paradigm: 'field-read', limit: 8,
                label: '固定位移的欄位讀取：從位移 O 取寬 W 個位元組，端序與有無號由窮舉挑；O、W 由敘述抽（「位移 O」「欄位寬 W 個位元組」）',
                slots: [S('end', '端序', [['le', '"little"', '小端'], ['be', '"big"', '大端']]), S('sg', '有無號', [['u', 'False', '無號'], ['s', 'True', '有號']])],
                py: (c, N, I) => { const st = String(I.statement); const mo = /位移\s*(?:是|為)?\s*(\d+)/.exec(st); const mw = /欄位寬\s*(?:為|是)?\s*(\d+)\s*(?:個)?位元組/.exec(st); if (!mo || !mw) throw new Error('抽不到位移或欄位寬');
                    const o = +mo[1], w = +mw[1];
                    return code(['raw_ = bytes.fromhex(' + N.s[0] + '.strip())', 'v_ = int.from_bytes(raw_[' + o + ':' + (o + w) + '], ' + c.end + ', signed=' + c.sg + ')', 'print(v_)']); },
                shape: (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex' },
            { id: 'bin.count-mark', algo: 'count-mark', paradigm: 'counting', limit: 4,
                label: '位元組標記的出現次數：標記由敘述的引號抽（十六進位位元組序列）；可重疊或不重疊由窮舉挑',
                slots: [S('mode', '計數方式', [['ov', 'sum(1 for i_ in range(len(raw_) - len(mk_) + 1) if raw_[i_:i_ + len(mk_)] == mk_)', '可重疊'], ['nov', 'raw_.count(mk_)', '不重疊']])],
                py: (c, N, I) => { const mk = quoted(I.statement).find((q) => HEXM.test(q)); if (!mk) throw new Error('抽不到標記');
                    return code(['raw_ = bytes.fromhex(' + N.s[0] + '.strip())', 'mk_ = bytes.fromhex("' + mk.replace(/ /g, '') + '")', 'n_ = ' + c.mode, 'print(n_)']); },
                shape: (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex' },
            { id: 'bin.count-byte', algo: 'count-byte', paradigm: 'counting', limit: 4,
                label: '位元組值的個數：比較值由敘述抽（「等於 X」「為 X」，X 為十進位或 0x 十六進位）；計入範圍（全部／不計第一個位元組）由窮舉挑',
                slots: [S('scope', '計入範圍', [['all', 'raw_', '全部位元組'], ['skip1', 'raw_[1:]', '不計第一個位元組']])],
                py: (c, N, I) => { const m = /(?:等於|為)\s*(0x[0-9a-fA-F]{1,2}|\d{1,3})(?![\d.])/.exec(String(I.statement)); if (!m) throw new Error('抽不到比較值'); const x = m[1].startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10);
                    return code(['raw_ = bytes.fromhex(' + N.s[0] + '.strip())', 'n_ = sum(1 for b_ in ' + c.scope + ' if b_ == ' + x + ')', 'print(n_)']); },
                shape: (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex' }
        ];
        // 領域詞彙（pri:true：壓過內建的通用詞彙；veto 擋掉寫出／解壓類題目）
        const algos = [
            { key: 'field-read', re: /(?=[\s\S]*位移\s*(?:是|為)?\s*\d+)(?=[\s\S]*欄位寬\s*(?:為|是)?\s*\d+\s*(?:個)?位元組)/, veto: /寫出|寫成|組出|產生|解壓|還原|頁尾|footer|調色盤/ },
            { key: 'count-mark', re: /(?=[\s\S]*(?:計算|數出|數一數|統計|數)[\s\S]*(?:出現|次數|幾次|個數))(?=[\s\S]*[「『"]\s*[0-9a-fA-F]{2}(?: [0-9a-fA-F]{2})*\s*[」』"])/, veto: /寫出|寫成|解壓|還原/ },
            { key: 'count-byte', re: /(?=[\s\S]*位元組)(?=[\s\S]*(?:數出|計算|統計|數一數|數)[\s\S]*(?:個數|幾個|次數|出現|幾次))(?=[\s\S]*(?:等於|為)\s*(?:0x[0-9a-fA-F]{1,2}|\d{1,3})(?![\d.]))(?![\s\S]*[「『"]\s*[0-9a-fA-F]{2}\s)/, veto: /寫出|寫成|解壓|還原/ }
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = { 'field-read': ['field-read'], 'count-mark': ['counting'], 'count-byte': ['counting'] };
        return { id: 'fieldcount', label: '讀欄位與計數（固定位移欄位、位元組標記次數、位元組值個數）', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
