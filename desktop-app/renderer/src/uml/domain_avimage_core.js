/* 領域包：影音壓縮階段 5「有損影像」的小波部分（見 DESIGN.blockly-curriculum.md §5、DESIGN.media-codec-domain.md §2E）。
 * 本檔目前做兩個整數小波子元件：
 *   img.haar1d：一層 Haar（整數版）：每對 (a,b) 得低頻 (a+b)>>1 與高頻 a-b。
 *   img.legall53：一層 LeGall 5/3 整數提升（JPEG 2000 可逆版）：先算高頻 d，再算低頻 s；邊界用對稱延伸。
 * 格式同 domain_h264dec_core.js：make(PAR) 回傳 {id, label, requires, judge, algos, paradigms, skeletons}。
 * 輸入：一行 8 個整數；輸出：兩行，第一行是低頻（4 個），第二行是高頻（4 個）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainAvimage = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'codec-transform', label, slots, py }, extra || {});
        const numIn = (I) => I.inputs.length === 1 && (I.inputs[0].k === 'list' || (I.inputs[0].k === 'str' && I.inputs[0].raw));
        const nums = (N, I) => (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]');
        const skeletons = [
            D('img.haar1d', 'img-haar1d', '一層 Haar 小波（整數版）：輸入一行 8 個整數，兩兩一組 (a,b)；低頻為 (a+b) 右移 1 位（向下取整），高頻為 a 減 b；輸出兩行，第一行為低頻（4 個），第二行為高頻（4 個）',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'lo = []', 'hi = []', 'for i in range(0, len(v), 2):', '    lo.append((v[i] + v[i + 1]) >> 1)', '    hi.append(v[i] - v[i + 1])', 'print(*lo)', 'print(*hi)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            D('img.legall53', 'img-legall53', 'LeGall 5/3 整數提升（一層，可逆）：輸入一行 8 個整數，記為 x0 至 x7。先算高頻 d[i]＝x[2i+1] 減去 (x[2i] 加上右鄰 x[2i+2]) 右移 1 位（右鄰超出右端時用 x[2i]，即對稱延伸）；再算低頻 s[i]＝x[2i] 加上 (d[i-1] 加上 d[i] 加 2) 右移 2 位（i 為 0 時 d[-1] 取 d[0]）。輸出兩行：第一行是 s（4 個），第二行是 d（4 個）',
                [],
                (c, N, I) => code(['v = ' + nums(N, I), 'n = len(v)', 'N2 = n // 2', 'd = []', 'for i in range(N2):', '    xr = v[2 * i]', '    if 2 * i + 2 < n:', '        xr = v[2 * i + 2]', '    d.append(v[2 * i + 1] - ((v[2 * i] + xr) >> 1))', 's = []', 'for i in range(N2):', '    dl = d[i]', '    if i > 0:', '        dl = d[i - 1]', '    s.append(v[2 * i] + ((dl + d[i] + 2) >> 2))', 'print(*s)', 'print(*d)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'img-haar1d', re: ALL('(?:Haar|哈爾)', '(?:小波|wavelet)'), veto: /5\s*\/\s*3|LeGall|提升/i },
            { key: 'img-legall53', re: ALL('(?:5\\s*/\\s*3|LeGall|萊加爾)', '(?:小波|提升|lifting|wavelet)'), veto: /Haar|哈爾/i },
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['codec-transform'];
        return { id: 'avimage', label: '影音壓縮 5：有損影像（小波）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make };
});
