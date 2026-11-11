/* 領域包：影音壓縮階段 2「H.264 解碼的算術部分」（見 DESIGN.blockly-curriculum.md §5、DESIGN.media-codec-domain.md）。
 * 本檔目前只有第一個子元件：4×4 整數逆變換（H.264 8.5.12.2 的兩段一維蝶形：先列後行或先行後列，最後每個值加 32 再右移 6 位）。
 * 格式同 domain_avbits_core.js：register(pack, env) 用的 {id, label, requires, judge, algos, paradigms, skeletons}。
 * 輸入：一行 16 個有號整數（4×4 係數矩陣依列排列）；輸出：4 行，每行 4 個整數（殘差）。
 * 誠實限制：只涵蓋逆變換本身；反量化（LevelScale）、Intra 預測、CAVLC、去區塊尚未做（見 DESIGN.media-codec-domain.md §4）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainH264dec = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const L = (src) => src.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n');
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'codec-transform', label, slots, py }, extra || {});
        const numIn = (I) => I.inputs.length === 1 && (I.inputs[0].k === 'list' || (I.inputs[0].k === 'str' && I.inputs[0].raw));
        const nums = (N, I) => (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]');
        // 先做某一方向的一維變換（不捨入），或做完整的捨入方向
        const rowRaw = ['for i in range(4):', '    a = m[i][0]', '    b = m[i][1]', '    c = m[i][2]', '    d = m[i][3]', '    e = a + c', '    f = a - c', '    g = (b >> 1) - d', '    h = b + (d >> 1)', '    m[i] = [e + h, f + g, f - g, e - h]'];
        const rowRnd = ['for i in range(4):', '    a = m[i][0]', '    b = m[i][1]', '    c = m[i][2]', '    d = m[i][3]', '    e = a + c', '    f = a - c', '    g = (b >> 1) - d', '    h = b + (d >> 1)', '    r = [e + h, f + g, f - g, e - h]', '    m[i] = [(r[k] + 32) >> 6 for k in range(4)]'];
        const colRaw = ['for j in range(4):', '    a = m[0][j]', '    b = m[1][j]', '    c = m[2][j]', '    d = m[3][j]', '    e = a + c', '    f = a - c', '    g = (b >> 1) - d', '    h = b + (d >> 1)', '    r = [e + h, f + g, f - g, e - h]', '    for i in range(4):', '        m[i][j] = r[i]'];
        const colRnd = ['for j in range(4):', '    a = m[0][j]', '    b = m[1][j]', '    c = m[2][j]', '    d = m[3][j]', '    e = a + c', '    f = a - c', '    g = (b >> 1) - d', '    h = b + (d >> 1)', '    r = [e + h, f + g, f - g, e - h]', '    for i in range(4):', '        m[i][j] = (r[i] + 32) >> 6'];
        const skeletons = [
            D('h264.idct4', 'h264-idct4', '4×4 整數逆變換：輸入一行 16 個有號整數（係數矩陣依列排列），依 H.264 的一維蝶形（a、b、c、d 為輸入四個值：e=a+c、f=a-c、g=(b>>1)-d、h=b+(d>>1)，輸出 e+h、f+g、f-g、e-h）做兩個方向的變換；每個值最後加 32 再右移 6 位；輸出 4 行，每行 4 個整數（殘差）。先列後行或先行後列由窮舉挑',
                [S('ord', '先做方向', [['row', 'row'], ['col', 'col']]), S('out', '輸出格式', [['lines', 'lines'], ['flat', 'flat']])],
                (c, N, I) => {
                    const stages = c.ord === 'row' ? [rowRaw, colRnd] : [colRaw, rowRnd];
                    return code(['v = ' + nums(N, I), 'm = [v[4 * i:4 * i + 4] for i in range(4)]'].concat(stages[0], stages[1], c.out === 'lines' ? ['for i in range(4):', '    print(*m[i])'] : ['print(*[x for row in m for x in row])']));
                },
                { shape: numIn, limit: 4, helpers: () => [] }),
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'h264-idct4', re: ALL('4\\s*[x×*乘]\\s*4', '(?:逆變換|反變換|逆轉換|反轉換|整數變換)'), veto: /正變換|前向/ },
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['codec-transform'];
        return { id: 'h264dec', label: '影音壓縮 2：H.264 解碼算術（4×4 整數逆變換）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make };
});
