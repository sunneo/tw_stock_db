/* 領域包：影音壓縮階段 3「運動補償」的子元件（H.264 8.4.2.2 與 8.4.2.3 的規則，加上教學用的全搜尋）。
 * 骨架（格式同 domain_h264dec_core.js）：
 *   h264.motion.sad：4×4 目前區塊對 6×6 參考窗做整數像素全搜尋（位移 −1 至 1），以 SAD 為準。
 *     平手規則（寫在題目裡）：依 dy 由小到大、同一 dy 內依 dx 由小到大，只有嚴格小於時才更新，所以平手取先出現者。
 *   h264.bipred：B 幀雙向預測的預設平均（8.4.2.3.1）：(a＋b＋1)>>1。
 *   h264.qpel：1/4 像素位置的內插：(G＋b＋1)>>1（8.4.2.2.1，a 位置）。
 * 限制：全搜尋只涵蓋整數像素與單一參考；不含運動向量預測、子像素搜尋、加權預測。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainH264motion = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const nums = (N, I) => (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]');
    function make(PAR) {
        const { code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'codec-motion', label, slots, py }, extra || {});
        const numIn = (I) => I.inputs.length === 1 && (I.inputs[0].k === 'list' || (I.inputs[0].k === 'str' && I.inputs[0].raw));
        const skeletons = [
            D('h264.motion.sad', 'h264-motion-sad', '運動搜尋（全搜尋 SAD）：輸入一行 52 個整數，前 16 個為目前區塊的樣本（4 列、每列 4 個，依列排列），其後 36 個為參考窗的樣本（6 列、每列 6 個，依列排列）。參考窗的左上角對應位移 (−1, −1)。對位移 dx 與 dy 各取 −1、0、1 共九個位置，計算目前區塊與參考窗對應樣本的絕對差總和 SAD。依 dy 由小到大、同一 dy 內依 dx 由小到大檢查，只有嚴格小於目前最小值時才更新，因此平手取先出現者。輸出三個整數：最佳的 dx、dy 與該位置的 SAD。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'cur = [v[0:4], v[4:8], v[8:12], v[12:16]]', 'win = [v[16 + 6 * r:22 + 6 * r] for r in range(6)]',
                    'best = None', 'for dy in (-1, 0, 1):', '    for dx in (-1, 0, 1):', '        s = 0', '        for y in range(4):', '            for x in range(4):', '                s = s + abs(cur[y][x] - win[y + 1 + dy][x + 1 + dx])',
                    '        if best is None or s < best[2]:', '            best = (dx, dy, s)',
                    'print(best[0], best[1], best[2])']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('h264.bipred', 'h264-bipred', 'B 幀雙向預測的預設平均：輸入一行 8 個整數，前 4 個為清單 0 的預測樣本 a0 至 a3，後 4 個為清單 1 的預測樣本 b0 至 b3。每個位置的結果為 (a 加 b 加 1) 右移 1 位。輸出 4 個整數，依序為四個位置的結果。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'out = [(v[i] + v[i + 4] + 1) >> 1 for i in range(4)]', 'print(*out)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('h264.qpel', 'h264-qpel', '1/4 像素內插（a 位置）：輸入一行 2 個整數，依序為整數位置的樣本 G 與半像素樣本 b（都是 0 至 255）。a 的值為 (G 加 b 加 1) 右移 1 位。輸出一個整數 a。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'G = v[0]', 'b = v[1]', 'a = (G + b + 1) >> 1', 'print(a)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('h264.qpel.diag', 'h264-qpel-diag', '四分之一像素的對角位置：輸入一行 4 個整數，依序為半像素樣本 b、h、m、s（都是 0 至 255）。e 為 (b 加 h 加 1) 右移 1 位；g 為 (b 加 m 加 1) 右移 1 位；p 為 (h 加 s 加 1) 右移 1 位；r 為 (m 加 s 加 1) 右移 1 位。輸出四個整數，依序為 e、g、p、r。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'b = v[0]', 'h = v[1]', 'm = v[2]', 's = v[3]', 'print((b + h + 1) >> 1, (b + m + 1) >> 1, (h + s + 1) >> 1, (m + s + 1) >> 1)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('h264.qpel.edge', 'h264-qpel-edge', '1/4 像素的邊緣位置 c、d、n：輸入一行 5 個整數，依序為整數位置的樣本 G、H、M（都是 0 至 255）與半像素樣本 b、h。c 為 (H 加 b 加 1) 右移 1 位；d 為 (G 加 h 加 1) 右移 1 位；n 為 (M 加 h 加 1) 右移 1 位。輸出三個整數，依序為 c、d、n。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'G = v[0]', 'H = v[1]', 'M = v[2]', 'b = v[3]', 'h = v[4]', 'print((H + b + 1) >> 1, (G + h + 1) >> 1, (M + h + 1) >> 1)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('h264.qpel.tap6', 'h264-qpel-tap6', '六分接頭半像素樣本 b：輸入一行 6 個整數，依序為同一列的整數位置樣本 E、F、G、H、I、J（都是 0 至 255）。先算 b1 等於 E 減 5F 加 20G 加 20H 減 5I 加 J，再算 b 等於 (b1 加 16) 右移 5 位，並限制在 0 至 255。輸出一個整數 b。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'b1 = v[0] - 5 * v[1] + 20 * v[2] + 20 * v[3] - 5 * v[4] + v[5]', 'b = min(max((b1 + 16) >> 5, 0), 255)', 'print(b)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('h264.qpel.j', 'h264-qpel-j', '六分接頭中心位置 j：輸入一行 6 個整數，依序為未截斷的中間值 cc、dd、h1、m1、ee、ff（可為負數）。j1 等於 cc 減 5dd 加 20h1 加 20m1 減 5ee 加 ff。j 等於 (j1 加 512) 右移 10 位，並限制在 0 至 255。輸出一個整數 j。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'j1 = v[0] - 5 * v[1] + 20 * v[2] + 20 * v[3] - 5 * v[4] + v[5]', 'j = min(max((j1 + 512) >> 10, 0), 255)', 'print(j)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('h264.qpel.fikq', 'h264-qpel-fikq', '1/4 像素的 f、i、k、q 位置：輸入一行 5 個整數，依序為半像素樣本 b、h、j、m、s（都是 0 至 255）。f 為 (b 加 j 加 1) 右移 1 位；i 為 (h 加 j 加 1) 右移 1 位；k 為 (j 加 m 加 1) 右移 1 位；q 為 (j 加 s 加 1) 右移 1 位。輸出四個整數，依序為 f、i、k、q。',
                [], (c, N, I) => code(['v = ' + nums(N, I), 'b = v[0]', 'h = v[1]', 'j = v[2]', 'm = v[3]', 's = v[4]', 'print((b + j + 1) >> 1, (h + j + 1) >> 1, (j + m + 1) >> 1, (j + s + 1) >> 1)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
        ];
        const ALL =(...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'h264-motion-sad', re: ALL('(?:運動|motion)', '(?:全搜尋|SAD|絕對差)'), veto: /CAVLC|CABAC|量化|去區塊|幀內|逆變換|正變換/ },
            { key: 'h264-bipred', re: ALL('(?:雙向|B\\s*幀|bi.?pred)', '(?:預設平均|平均|預測樣本)'), veto: /CABAC|CAVLC|量化|去區塊|幀內|全搜尋|SAD/ },
            { key: 'h264-qpel-diag', re: ALL('(?:1\\s*/\\s*4|四分之一)', 'e、g、p、r'), veto: /CABAC|CAVLC|量化|去區塊|幀內|全搜尋|SAD|色度|雙向/ },
            { key: 'h264-qpel', re: ALL('(?:1\\s*/\\s*4|四分之一|quarter)', '(?:像素|sample|內插)'), veto: /CABAC|CAVLC|量化|去區塊|幀內|全搜尋|SAD|色度|雙向|e、g、p、r|c、d、n|f、i、k、q|六分接頭/ },
            { key: 'h264-qpel-edge', re: ALL('c、d、n'), veto: /e、g、p、r|f、i、k、q|六分接頭/ },
            { key: 'h264-qpel-tap6', re: ALL('六分接頭', 'b1'), veto: /中心位置|f、i、k、q|c、d、n|1\s*\/\s*4|四分之一/ },
            { key: 'h264-qpel-j', re: ALL('中心位置', 'cc'), veto: /f、i、k、q|c、d、n|e、g、p、r/ },
            { key: 'h264-qpel-fikq', re: ALL('f、i、k、q'), veto: /c、d、n|e、g、p、r|六分接頭|中心位置/ },
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['codec-motion'];
        return { id: 'h264motion', label: '影音壓縮 3：運動搜尋、B 幀雙向平均、1/4 像素', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make };
});
