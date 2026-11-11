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
            D('h264.dequant4', 'h264-dequant4', '4×4 反量化（平坦縮放，權重 16）：輸入一行 17 個整數，第一個是量化參數 qP，後面 16 個是係數（依列排列）；每個位置的 normAdjust 值由 (列,行) 的奇偶性決定（兩者皆偶用第 0 欄、兩者皆奇用第 1 欄、其餘用第 2 欄），LevelScale＝16×normAdjust；qP 大於等於 24 時 d＝(c×LevelScale)左移(qP//6-4)位，否則 d＝(c×LevelScale＋2 的 (3-qP//6) 次方)右移(4-qP//6)位；輸出 4 行，每行 4 個整數',
                [S('out', '輸出格式', [['lines', 'lines'], ['flat', 'flat']])],
                (c, N, I) => code(['v = ' + nums(N, I), 'qp = v[0]', 'co = v[1:17]', 'vt = [[10, 16, 13], [11, 18, 14], [13, 20, 16], [14, 23, 18], [16, 25, 20], [18, 29, 23]]', 'out = []', 'for k in range(16):', '    i = k // 4', '    j = k % 4', '    if i % 2 == 0 and j % 2 == 0:', '        t = vt[qp % 6][0]', '    elif i % 2 == 1 and j % 2 == 1:', '        t = vt[qp % 6][1]', '    else:', '        t = vt[qp % 6][2]', '    ls = 16 * t', '    if qp >= 24:', '        out.append((co[k] * ls) << (qp // 6 - 4))', '    else:', '        out.append((co[k] * ls + (1 << (3 - qp // 6))) >> (4 - qp // 6))'].concat(c.out === 'lines' ? ['for i in range(4):', '    print(*out[4 * i:4 * i + 4])'] : ['print(*out)'])),
                { shape: numIn, limit: 4, helpers: () => [] }),
            D('h264.intra4', 'h264-intra4', '4×4 幀內預測（本批只做 0 垂直、1 水平、2 DC 三模式）：輸入一行 12 個整數，前 8 個是上方參考像素（只用前 4 個），後 4 個是左方參考像素；依所選模式輸出 4 行，每行 4 個整數（預測區塊）。垂直：每一欄等於上方對應像素；水平：每一列等於左方對應像素；DC：上方 4 個與左方 4 個的總和加 4 再右移 3 位，全部填入',
                [S('mode', '預測模式', [['v', 'v'], ['h', 'h'], ['dc', 'dc']])],
                (c, N, I) => code(['v = ' + nums(N, I), 'top = v[0:4]', 'left = v[8:12]', 'dc = (sum(top) + sum(left) + 4) >> 3', c.mode === 'v' ? 'rows = [top[:] for y in range(4)]' : c.mode === 'h' ? 'rows = [[left[y]] * 4 for y in range(4)]' : 'rows = [[dc] * 4 for y in range(4)]', 'for y in range(4):', '    print(*rows[y])']),
                { shape: numIn, limit: 4, helpers: () => [] }),
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'h264-idct4', re: ALL('4\\s*[x×*乘]\\s*4', '(?:逆變換|反變換|逆轉換|反轉換|整數變換)'), veto: /正變換|前向/ },
            { key: 'h264-dequant4', re: ALL('反量化', '4\\s*[x×*乘]\\s*4'), veto: /正量化|編碼/ },
            { key: 'h264-intra4', re: ALL('(?:幀內|畫面內|intra)', '4\\s*[x×*乘]\\s*4', '預測'), veto: /逆變換|反變換|反量化|正變換/i },
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['codec-transform'];
        return { id: 'h264dec', label: '影音壓縮 2：H.264 解碼算術（4×4 整數逆變換）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make };
});
