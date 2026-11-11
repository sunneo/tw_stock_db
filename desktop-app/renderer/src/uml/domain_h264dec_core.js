/* 領域包：影音壓縮階段 2「H.264 解碼的算術部分」（見 DESIGN.blockly-curriculum.md §5、DESIGN.media-codec-domain.md）。
 * 本檔目前只有第一個子元件：4×4 整數逆變換（H.264 8.5.12.2 的兩段一維蝶形：先列後行或先行後列，最後每個值加 32 再右移 6 位）。
 * 格式同 domain_avbits_core.js：register(pack, env) 用的 {id, label, requires, judge, algos, paradigms, skeletons}。
 * 輸入：一行 16 個有號整數（4×4 係數矩陣依列排列）；輸出：4 行，每行 4 個整數（殘差）。
 * 誠實限制：只涵蓋逆變換本身；反量化（LevelScale）、Intra 預測、CAVLC、去區塊尚未做（見 DESIGN.media-codec-domain.md §4）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainH264dec = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const L = (src) => src.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n');
    // CAVLC coeff_token（H.264 表 9-5）。來源：libavc common/ih264_cavlc_tables.c（Apache 2.0，web-fetch 取得後逐字抄入）。
    // 索引：[nC 範圍][TrailingOnes][TotalCoeff−1]；TotalCoeff 0 由程式另列特例；色度直流（nC＝−1）另用 4×4 表。
    const CT_CODE = [[[5, 7, 7, 7, 7, 15, 11, 8, 15, 11, 15, 11, 15, 11, 7, 4], [1, 4, 6, 6, 6, 6, 14, 10, 14, 10, 14, 10, 1, 14, 10, 6], [0, 1, 5, 5, 5, 5, 5, 13, 9, 13, 9, 13, 9, 13, 9, 5], [0, 0, 3, 3, 4, 4, 4, 4, 4, 12, 12, 8, 12, 8, 12, 8]], [[11, 7, 7, 7, 4, 7, 15, 11, 15, 11, 8, 15, 11, 7, 9, 7], [2, 7, 10, 6, 6, 6, 6, 14, 10, 14, 10, 14, 10, 11, 8, 6], [0, 3, 9, 5, 5, 5, 5, 13, 9, 13, 9, 13, 9, 6, 10, 5], [0, 0, 5, 4, 6, 8, 4, 4, 4, 12, 8, 12, 12, 8, 1, 4]], [[15, 11, 8, 15, 11, 9, 8, 15, 11, 15, 11, 8, 13, 9, 5, 1], [14, 15, 12, 10, 8, 14, 10, 14, 14, 10, 14, 10, 7, 12, 8, 4], [0, 13, 14, 11, 9, 13, 9, 13, 10, 13, 9, 13, 9, 11, 7, 3], [0, 0, 12, 11, 10, 9, 8, 13, 12, 12, 12, 8, 12, 10, 6, 2]]];
    const CT_SIZE = [[[6, 8, 9, 10, 11, 13, 13, 13, 14, 14, 15, 15, 16, 16, 16, 16], [2, 6, 8, 9, 10, 11, 13, 13, 14, 14, 15, 15, 15, 16, 16, 16], [0, 3, 7, 8, 9, 10, 11, 13, 13, 14, 14, 15, 15, 16, 16, 16], [0, 0, 5, 6, 7, 8, 9, 10, 11, 13, 14, 14, 15, 15, 16, 16]], [[6, 6, 7, 8, 8, 9, 11, 11, 12, 12, 12, 13, 13, 13, 14, 14], [2, 5, 6, 6, 7, 8, 9, 11, 11, 12, 12, 13, 13, 14, 14, 14], [0, 3, 6, 6, 7, 8, 9, 11, 11, 12, 12, 13, 13, 13, 14, 14], [0, 0, 4, 4, 5, 6, 6, 7, 9, 11, 11, 12, 13, 13, 13, 14]], [[6, 6, 6, 7, 7, 7, 7, 8, 8, 9, 9, 9, 10, 10, 10, 10], [4, 5, 5, 5, 5, 6, 6, 7, 8, 8, 9, 9, 9, 10, 10, 10], [0, 4, 5, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 10], [0, 0, 4, 4, 4, 4, 4, 5, 6, 7, 8, 8, 9, 10, 10, 10]]];
    const CT_CODE_CH = [[7, 4, 3, 2], [1, 6, 3, 3], [0, 1, 2, 2], [0, 0, 5, 0]];
    const CT_SIZE_CH = [[6, 6, 6, 6], [1, 6, 7, 8], [0, 3, 7, 8], [0, 0, 6, 7]];
    // 把一張表轉成 [TotalCoeff, TrailingOnes, 碼字字串] 清單（欄 c 對應 TotalCoeff＝c＋1；長度 0 的格子不是有效碼字）
    const ctRows = (code, size) => { const out = []; for (let t1 = 0; t1 < size.length; t1++) for (let c = 0; c < size[t1].length; c++) { const n = size[t1][c]; if (n > 0) out.push([c + 1, t1, code[t1][c].toString(2).padStart(n, '0')]); } return out; };
    const ctFlc = [[0, 0, '000011']];
    for (let tc = 1; tc <= 16; tc++) for (let t1 = 0; t1 <= Math.min(3, tc); t1++) ctFlc.push([tc, t1, (((tc - 1) << 2) | t1).toString(2).padStart(6, '0')]);
    const ctTables = {
        n0: [[0, 0, '1']].concat(ctRows(CT_CODE[0], CT_SIZE[0])),
        n2: [[0, 0, '11']].concat(ctRows(CT_CODE[1], CT_SIZE[1])),
        n4: [[0, 0, '1111']].concat(ctRows(CT_CODE[2], CT_SIZE[2])),
        flc: ctFlc,
        chroma: [[0, 0, '01']].concat(ctRows(CT_CODE_CH, CT_SIZE_CH)),
    };
    // 去區塊（8.7.2）表：來源 libavc common/ih264_deblk_tables.c（Apache 2.0，web-fetch 逐字取得）。α、β 各 52 格；tC0 表 [indexA][bS]，欄 1 至 3 為 bS 1 至 3（欄 0 為 0，未用）。
    const DB_ALPHA = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15, 17, 20, 22, 25, 28, 32, 36, 40, 45, 50, 56, 63, 71, 80, 90, 101, 113, 127, 144, 162, 182, 203, 226, 255, 255];
    const DB_BETA = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16, 17, 17, 18, 18];
    const DB_TC = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 1, 1], [0, 0, 1, 1], [0, 1, 1, 1], [0, 1, 1, 1], [0, 1, 1, 1], [0, 1, 1, 1], [0, 1, 1, 2], [0, 1, 1, 2], [0, 1, 1, 2], [0, 1, 1, 2], [0, 1, 2, 3], [0, 1, 2, 3], [0, 2, 2, 3], [0, 2, 2, 4], [0, 2, 3, 4], [0, 2, 3, 4], [0, 3, 3, 5], [0, 3, 4, 6], [0, 3, 4, 6], [0, 4, 5, 7], [0, 4, 5, 8], [0, 4, 6, 9], [0, 5, 7, 10], [0, 6, 8, 11], [0, 6, 8, 13], [0, 7, 10, 14], [0, 8, 11, 16], [0, 9, 12, 18], [0, 10, 13, 20], [0, 11, 15, 23], [0, 13, 17, 25]];
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
        // 幀內預測模式 3 至 8：E 為邊界陣列 [L3,L2,L1,L0,C,T0..T7]（13 格）。p(x,-1)＝E[5+x]、p(-1,y)＝E[3-y]、p(-1,-1)＝E[4]。
        const blk = (body) => ['for y in range(4):', '    row = []', '    for x in range(4):'].concat(body.map((l) => '        ' + l), ['        row.append(val)', '    print(*row)']);
        const I8 = {
            ddl: blk(['if x == 3 and y == 3:', '    val = (E[11] + 3 * E[12] + 2) >> 2', 'else:', '    val = (E[5 + x + y] + 2 * E[6 + x + y] + E[7 + x + y] + 2) >> 2']),
            ddr: blk(['if x > y:', '    val = (E[3 + x - y] + 2 * E[4 + x - y] + E[5 + x - y] + 2) >> 2', 'elif x < y:', '    val = (E[5 + x - y] + 2 * E[4 + x - y] + E[3 + x - y] + 2) >> 2', 'else:', '    val = (E[5] + 2 * E[4] + E[3] + 2) >> 2']),
            vr: blk(['z = 2 * x - y', 'k = x - (y >> 1)', 'if z >= 0 and z % 2 == 0:', '    val = (E[4 + k] + E[5 + k] + 1) >> 1', 'elif z >= 0:', '    val = (E[3 + k] + 2 * E[4 + k] + E[5 + k] + 2) >> 2', 'elif z == -1:', '    val = (E[3] + 2 * E[4] + E[5] + 2) >> 2', 'else:', '    val = (E[4 - y] + 2 * E[5 - y] + E[6 - y] + 2) >> 2']),
            hd: blk(['z = 2 * y - x', 'k = y - (x >> 1)', 'if z >= 0 and z % 2 == 0:', '    val = (E[4 - k] + E[3 - k] + 1) >> 1', 'elif z >= 0:', '    val = (E[5 - k] + 2 * E[4 - k] + E[3 - k] + 2) >> 2', 'elif z == -1:', '    val = (E[3] + 2 * E[4] + E[5] + 2) >> 2', 'else:', '    val = (E[4 + x] + 2 * E[3 + x] + E[2 + x] + 2) >> 2']),
            vl: blk(['k = x + (y >> 1)', 'if y % 2 == 0:', '    val = (E[5 + k] + E[6 + k] + 1) >> 1', 'else:', '    val = (E[5 + k] + 2 * E[6 + k] + E[7 + k] + 2) >> 2']),
            hu: blk(['z = x + 2 * y', 'k = y + (x >> 1)', 'if z < 5 and z % 2 == 0:', '    val = (E[3 - k] + E[2 - k] + 1) >> 1', 'elif z < 5:', '    val = (E[3 - k] + 2 * E[2 - k] + E[1 - k] + 2) >> 2', 'elif z == 5:', '    val = (E[1] + 3 * E[0] + 2) >> 2', 'else:', '    val = E[0]']),
        };
        // CAVLC total_zeros（4×4 區塊，tzVlcIndex 1 至 15，H.264 表 9-7、9-8）。來源：libavc ih264_cavlc_tables.c 的 gu1_size_zero_table／gu1_code_zero_table（Apache 2.0），已還原並自檢（每列互不為前綴、Kraft 和 1；tzVlcIndex 1 的 Kraft 0.998，未用碼字 000000000）。
        const TZ = {1: [[0, '1'], [1, '011'], [2, '010'], [3, '0011'], [4, '0010'], [5, '00011'], [6, '00010'], [7, '000011'], [8, '000010'], [9, '0000011'], [10, '0000010'], [11, '00000011'], [12, '00000010'], [13, '000000011'], [14, '000000010'], [15, '000000001']], 2: [[0, '111'], [1, '110'], [2, '101'], [3, '100'], [4, '011'], [5, '0101'], [6, '0100'], [7, '0011'], [8, '0010'], [9, '00011'], [10, '00010'], [11, '000011'], [12, '000010'], [13, '000001'], [14, '000000']], 3: [[0, '0101'], [1, '111'], [2, '110'], [3, '101'], [4, '0100'], [5, '0011'], [6, '100'], [7, '011'], [8, '0010'], [9, '00011'], [10, '00010'], [11, '000001'], [12, '00001'], [13, '000000']], 4: [[0, '00011'], [1, '111'], [2, '0101'], [3, '0100'], [4, '110'], [5, '101'], [6, '100'], [7, '0011'], [8, '011'], [9, '0010'], [10, '00010'], [11, '00001'], [12, '00000']], 5: [[0, '0101'], [1, '0100'], [2, '0011'], [3, '111'], [4, '110'], [5, '101'], [6, '100'], [7, '011'], [8, '0010'], [9, '00001'], [10, '0001'], [11, '00000']], 6: [[0, '000001'], [1, '00001'], [2, '111'], [3, '110'], [4, '101'], [5, '100'], [6, '011'], [7, '010'], [8, '0001'], [9, '001'], [10, '000000']], 7: [[0, '000001'], [1, '00001'], [2, '101'], [3, '100'], [4, '011'], [5, '11'], [6, '010'], [7, '0001'], [8, '001'], [9, '000000']], 8: [[0, '000001'], [1, '0001'], [2, '00001'], [3, '011'], [4, '11'], [5, '10'], [6, '010'], [7, '001'], [8, '000000']], 9: [[0, '000001'], [1, '000000'], [2, '0001'], [3, '11'], [4, '10'], [5, '001'], [6, '01'], [7, '00001']], 10: [[0, '00001'], [1, '00000'], [2, '001'], [3, '11'], [4, '10'], [5, '01'], [6, '0001']], 11: [[0, '0000'], [1, '0001'], [2, '001'], [3, '010'], [4, '1'], [5, '011']], 12: [[0, '0000'], [1, '0001'], [2, '01'], [3, '1'], [4, '001']], 13: [[0, '000'], [1, '001'], [2, '1'], [3, '01']], 14: [[0, '00'], [1, '01'], [2, '1']], 15: [[0, '0'], [1, '1']]};
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
            D('h264.intra4', 'h264-intra4', '4×4 幀內預測：模式 0 垂直、1 水平、2 DC 輸入一行 12 個整數（前 8 個為上方參考，只用前 4 個；後 4 個為左方參考）；模式 3 至 8（對角向左下、對角向右下、垂直偏右、水平偏下、垂直偏左、水平偏上）輸入一行 13 個整數（前 8 個為上方參考含右上 4 格；接著 4 個為左方參考；最後 1 個為左上角）。依所選模式輸出 4 行，每行 4 個整數（預測區塊）',
                [S('mode', '預測模式', [['v', 'v'], ['h', 'h'], ['dc', 'dc'], ['ddl', 'ddl'], ['ddr', 'ddr'], ['vr', 'vr'], ['hd', 'hd'], ['vl', 'vl'], ['hu', 'hu']])],
                (c, N, I) => (c.mode === 'v' || c.mode === 'h' || c.mode === 'dc') ? code(['v = ' + nums(N, I), 'top = v[0:4]', 'left = v[8:12]', 'dc = (sum(top) + sum(left) + 4) >> 3', c.mode === 'v' ? 'rows = [top[:] for y in range(4)]' : c.mode === 'h' ? 'rows = [[left[y]] * 4 for y in range(4)]' : 'rows = [[dc] * 4 for y in range(4)]', 'for y in range(4):', '    print(*rows[y])']) : code(['v = ' + nums(N, I), 'E = [v[11], v[10], v[9], v[8], v[12], v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]]'].concat(I8[c.mode])),
                { shape: numIn, limit: 9, helpers: () => [] }),
            // CAVLC run_before（H.264 表 9-10）：輸入一行「zerosLeft 空格 位元字串」，依 zerosLeft（大於 6 的併為第 7 列）查表，位元字串開頭符合的碼字對應的 run_before 即為答案。
            D('h264.runbefore', 'h264-runbefore', 'CAVLC 的 run_before 解碼：輸入一行 13 個整數，第一個是 zerosLeft（1 到 14），其後 12 個是位元（每個為 0 或 1）。依 H.264 表 9-10：zerosLeft 為 1 至 6 各有一張表，大於 6 的共用一張表；從位元開頭比對碼字，找到的 run_before 即為輸出（一個整數）',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'zl = v[0]', 'bits = ""', 'for x in v[1:13]:', '    bits = bits + str(x)', 'key = 7', 'if zl < 7:', '    key = zl', 'tab = {1: [(0, "1"), (1, "0")], 2: [(0, "1"), (1, "01"), (2, "00")], 3: [(0, "11"), (1, "10"), (2, "01"), (3, "00")], 4: [(0, "11"), (1, "10"), (2, "01"), (3, "001"), (4, "000")], 5: [(0, "11"), (1, "10"), (2, "011"), (3, "010"), (4, "001"), (5, "000")], 6: [(0, "11"), (1, "000"), (2, "001"), (3, "011"), (4, "010"), (5, "101"), (6, "100")], 7: [(0, "111"), (1, "110"), (2, "101"), (3, "100"), (4, "011"), (5, "010"), (6, "001"), (7, "0001"), (8, "00001"), (9, "000001"), (10, "0000001"), (11, "00000001"), (12, "000000001"), (13, "0000000001"), (14, "00000000001")]}', 'ans = -1', 'for run, cw in tab[key]:', '    if ans < 0 and bits.startswith(cw):', '        ans = run', 'print(ans)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // CAVLC coeff_token（表 9-5）：輸入一行 17 個整數（nC，後接 16 個位元）；依 nC 選表，位元開頭符合的碼字即輸出 TotalCoeff 與 TrailingOnes。
            D('h264.coefftoken', 'h264-coefftoken', 'CAVLC 的 coeff_token 解碼：輸入一行 17 個整數，第一個是 nC（色度直流為 -1，亮度為 0 以上），其後 16 個是位元（每個為 0 或 1）。依 H.264 表 9-5 的 nC 那一欄從位元開頭比對碼字，輸出兩個整數：TotalCoeff 與 TrailingOnes',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'nc = v[0]', 'bits = ""', 'for x in v[1:17]:', '    bits = bits + str(x)', 'key = "n0"', 'if nc >= 2:', '    key = "n2"', 'if nc >= 4:', '    key = "n4"', 'if nc >= 8:', '    key = "flc"', 'if nc == -1:', '    key = "chroma"', 'tab = ' + JSON.stringify(ctTables), 'tc = -1', 't1 = -1', 'for e in tab[key]:', '    if tc < 0 and bits.startswith(e[2]):', '        tc = e[0]', '        t1 = e[1]', 'print(tc, t1)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // CAVLC level 解碼（H.264 9.2.2.1）：輸入一行 4 個整數：suffixLength、level_prefix、level_suffix（已讀出的整數值）、加 2 旗標（0 或 1）；輸出 levelVal 與更新後的 suffixLength。
            D('h264.level', 'h264-level', 'CAVLC 的 level 解碼：輸入一行 4 個整數，依序是 suffixLength、level_prefix、level_suffix（已讀出的整數值）、加 2 旗標（0 或 1）。依 H.264 規則先算 levelCode，再換成 levelVal，並依 suffixLength 規則更新，輸出兩個整數：levelVal 與更新後的 suffixLength',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'sl = v[0]', 'lp = v[1]', 'ls = v[2]', 'fl = v[3]', 'lc = (min(15, lp) << sl) + ls', 'if lp >= 15 and sl == 0:', '    lc = lc + 15', 'if lp >= 16:', '    lc = lc + (1 << (lp - 3)) - 4096', 'if fl == 1:', '    lc = lc + 2', 'if lc % 2 == 0:', '    lv = (lc + 2) >> 1', 'else:', '    lv = (-lc - 1) >> 1', 'if sl == 0:', '    sl = 1', 'av = lv', 'if av < 0:', '    av = -av', 'if av > (3 << (sl - 1)) and sl < 6:', '    sl = sl + 1', 'print(lv, sl)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 去區塊亮度邊界濾波（8.7.2.3 至 8.7.2.4，8 位元）：輸入一行 11 個整數：indexA、indexB、bS、p3、p2、p1、p0、q0、q1、q2、q3；輸出 6 個整數：p2、p1、p0、q0、q1、q2 的濾波後值。
            D('h264.deblock', 'h264-deblock', '去區塊濾波（亮度邊界）：輸入一行 11 個整數，依序是 indexA、indexB、邊界強度 bS（0 至 4）、p3、p2、p1、p0、q0、q1、q2、q3。若 bS 為 0 或不符合 α、β 條件則不改；bS 小於 4 時用 tC0 表計算 tC，只改 p0、q0，以及符合條件的 p1、q1；bS 為 4 時用強濾波改 p 側與 q 側最多三格。依序輸出 6 個整數：p2、p1、p0、q0、q1、q2 的濾波後值',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'ia = v[0]', 'ib = v[1]', 'bs = v[2]', 'p3 = v[3]', 'p2 = v[4]', 'p1 = v[5]', 'p0 = v[6]', 'q0 = v[7]', 'q1 = v[8]', 'q2 = v[9]', 'q3 = v[10]', 'AL = ' + JSON.stringify(DB_ALPHA), 'BE = ' + JSON.stringify(DB_BETA), 'TC = ' + JSON.stringify(DB_TC), 'al = AL[ia]', 'be = BE[ib]', 'P2 = p2', 'P1 = p1', 'P0 = p0', 'Q0 = q0', 'Q1 = q1', 'Q2 = q2', 'if bs > 0 and abs(p0 - q0) < al and abs(p1 - p0) < be and abs(q1 - q0) < be:', '    ap = abs(p2 - p0)', '    aq = abs(q2 - q0)', '    if bs < 4:', '        t0 = TC[ia][bs]', '        tc = t0 + (1 if ap < be else 0) + (1 if aq < be else 0)', '        d = (((q0 - p0) << 2) + (p1 - q1) + 4) >> 3', '        d = max(-tc, min(tc, d))', '        P0 = max(0, min(255, p0 + d))', '        Q0 = max(0, min(255, q0 - d))', '        if ap < be:', '            dp = max(-t0, min(t0, (p2 + ((p0 + q0 + 1) >> 1) - (p1 << 1)) >> 1))', '            P1 = p1 + dp', '        if aq < be:', '            dq = max(-t0, min(t0, (q2 + ((p0 + q0 + 1) >> 1) - (q1 << 1)) >> 1))', '            Q1 = q1 + dq', '    else:', '        small = abs(p0 - q0) < ((al >> 2) + 2)', '        if ap < be and small:', '            P0 = (p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3', '            P1 = (p2 + p1 + p0 + q0 + 2) >> 2', '            P2 = (2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3', '        else:', '            P0 = (2 * p1 + p0 + q1 + 2) >> 2', '        if aq < be and small:', '            Q0 = (p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3', '            Q1 = (p0 + q0 + q1 + q2 + 2) >> 2', '            Q2 = (2 * q3 + 3 * q2 + q1 + q0 + p0 + 4) >> 3', '        else:', '            Q0 = (2 * q1 + q0 + p1 + 2) >> 2', 'print(P2, P1, P0, Q0, Q1, Q2)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 階段 3 編碼端：4×4 整數正變換與量化（H.264 8.6 的前向核心，intra 的 f＝2^qbits÷3）。輸入一行 17 個整數：qP 與 16 個殘差（依列）；輸出 16 個量化後的整數（依列）。
            D('h264.fwdquant4', 'h264-fwdquant4', '4×4 整數正變換與量化（intra）：輸入一行 17 個整數，第一個是 qP，其後 16 個是殘差（依列）。先做 W＝Cf·X·Cfᵀ，Cf 為 [[1,1,1,1],[2,1,-1,-2],[1,-1,-1,1],[1,-2,2,-1]]；再依位置類別取 MF：兩個偶數位置用第 0 欄、兩個奇數位置用第 1 欄、其餘用第 2 欄，MF 表依 qP 除以 6 的餘數取列；量化 Z＝符號(W)·((|W|·MF＋f)>>qbits)，qbits＝15＋qP 除以 6 取整，f＝2 的 qbits 次方除以 3 取整。輸出 16 個整數（依列）',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'qp = v[0]', 'X = [v[1:5], v[5:9], v[9:13], v[13:17]]', 'CF = [[1, 1, 1, 1], [2, 1, -1, -2], [1, -1, -1, 1], [1, -2, 2, -1]]', 'MF = [[13107, 5243, 8066], [11916, 4660, 7490], [10082, 4194, 6554], [9362, 3647, 5825], [8192, 3355, 5243], [7282, 2893, 4559]]', 'T = [[0] * 4 for i in range(4)]', 'for i in range(4):', '    for j in range(4):', '        for k in range(4):', '            T[i][j] = T[i][j] + CF[i][k] * X[k][j]', 'W = [[0] * 4 for i in range(4)]', 'for i in range(4):', '    for j in range(4):', '        for k in range(4):', '            W[i][j] = W[i][j] + T[i][k] * CF[j][k]', 'qbits = 15 + qp // 6', 'f = (1 << qbits) // 3', 'out = []', 'for i in range(4):', '    for j in range(4):', '        m = MF[qp % 6][2]', '        if i % 2 == 0 and j % 2 == 0:', '            m = MF[qp % 6][0]', '        if i % 2 == 1 and j % 2 == 1:', '            m = MF[qp % 6][1]', '        a = W[i][j]', '        if a < 0:', '            a = -a', '        z = (a * m + f) >> qbits', '        if W[i][j] < 0:', '            z = -z', '        out.append(z)', 'print(*out)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 運動補償：亮度半像素內插（6 抽頭，H.264 8.4.2.2.1）：輸入一行 6 個整數 E、F、G、H、I、J（0 至 255）；b1＝E−5F＋20G＋20H−5I＋J，b＝clip((b1＋16)>>5)，輸出 b。
            D('h264.hpel', 'h264-hpel', '亮度半像素內插（6 抽頭）：輸入一行 6 個整數 E、F、G、H、I、J（0 至 255）。先算 b1＝E 減 5 倍 F 加 20 倍 G 加 20 倍 H 減 5 倍 I 加 J；再算 b＝(b1 加 16) 右移 5 位，並限制在 0 至 255；輸出一個整數 b',
                [],
                (c, N, I) => code(['v = ' + (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]'), 'b1 = v[0] - 5 * v[1] + 20 * v[2] + 20 * v[3] - 5 * v[4] + v[5]', 'b = (b1 + 16) >> 5', 'if b < 0:', '    b = 0', 'if b > 255:', '    b = 255', 'print(b)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // CAVLC total_zeros（4×4 區塊）：輸入一行 11 個整數，第一個是 tzVlcIndex（1 到 15，即 TotalCoeff），其後 10 個是位元；查 tzVlcIndex 的那一列，位元開頭符合的碼字對應的 total_zeros 即為輸出。
            D('h264.totalzeros', 'h264-totalzeros', 'CAVLC 的 total_zeros 解碼（4×4 區塊）：輸入一行 11 個整數，第一個是 tzVlcIndex（1 到 15），其後 10 個是位元（每個為 0 或 1）。依 H.264 表 9-7、9-8 查 tzVlcIndex 那一列，從位元開頭比對碼字，找到的 total_zeros 即為輸出（一個整數）',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'tzi = v[0]', 'bits = ""', 'for x in v[1:11]:', '    bits = bits + str(x)', 'tab = ' + JSON.stringify(TZ), 'ans = -1', 'for tz, cw in tab[str(tzi)]:', '    if ans < 0 and bits.startswith(cw):', '        ans = tz', 'print(ans)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'h264-idct4', re: ALL('4\\s*[x×*乘]\\s*4', '(?:逆變換|反變換|逆轉換|反轉換|整數變換)'), veto: /正變換|前向/ },
            { key: 'h264-dequant4', re: ALL('反量化', '4\\s*[x×*乘]\\s*4'), veto: /正量化|編碼/ },
            { key: 'h264-intra4', re: ALL('(?:幀內|畫面內|intra)', '4\\s*[x×*乘]\\s*4', '預測'), veto: /逆變換|反變換|反量化|正變換/i },
            { key: 'h264-runbefore', re: ALL('(?:CAVLC|run_before|run before)', '(?:游程|zerosLeft|剩餘零)'), veto: /反量化|逆變換|幀內/ },
            { key: 'h264-coefftoken', re: ALL('(?:CAVLC|coeff_token|coeff token)', '(?:TotalCoeff|TrailingOnes)'), veto: /run_before|total_zeros|游程|zerosLeft|tzVlcIndex|level_prefix|suffixLength|反量化|逆變換|幀內/i },
            { key: 'h264-level', re: ALL('(?:CAVLC|level_prefix)', '(?:suffixLength|level_suffix)'), veto: /coeff_token|TotalCoeff|run_before|total_zeros|游程|反量化|逆變換|幀內/i },
            { key: 'h264-hpel', re: ALL('(?:半像素|half.?pel)', '(?:內插|插值|interpolat|6\\s*抽頭)'), veto: /CAVLC|量化|去區塊|正變換|逆變換/i },
            { key: 'h264-fwdquant4', re: ALL('(?:正變換|前向|forward)', '(?:4\\s*[x×*乘]\\s*4|整數正變換)', '(?:量化|MF|qP)'), veto: /逆變換|反變換|反量化|幀內|CAVLC|去區塊/i },
            { key: 'h264-deblock', re: ALL('(?:去區塊|deblock)', '(?:bS|邊界強度)'), veto: /coeff_token|level|CAVLC|run_before|total_zeros|游程|反量化|逆變換|幀內/i },
            { key: 'h264-totalzeros', re: ALL('(?:CAVLC|total_zeros|total zeros)', '(?:tzVlcIndex|total_zeros|總零)'), veto: /反量化|逆變換|幀內|run_before/ },
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['codec-transform'];
        return { id: 'h264dec', label: '影音壓縮 2：H.264 解碼算術（4×4 整數逆變換）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make, ctTables };
});
