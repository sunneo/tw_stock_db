/* 領域包：影音壓縮階段 4「有損聲音」的變換部分（見 DESIGN.blockly-curriculum.md §5、DESIGN.media-codec-domain.md §2F）。
 * 本檔目前只有一個子元件：MDCT（窗長 2N＝16、係數 N＝8）加均勻量化。格式同 domain_avimage_core.js。
 * 輸入：一行 17 個整數，第一個是量化步長 Q，其後 16 個是取樣值；輸出：一行 8 個整數（量化後的 X[k]）。
 * 誠實限制：只涵蓋變換與量化；反變換（IMDCT）、心理聲學模型、熵編碼尚未做。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainAvaudio = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'codec-transform', label, slots, py }, extra || {});
        const numIn = (I) => I.inputs.length === 1 && (I.inputs[0].k === 'list' || (I.inputs[0].k === 'str' && I.inputs[0].raw));
        const nums = (N, I) => (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]');
        const skeletons = [
            D('aud.mdct8q', 'aud-mdct8q', 'MDCT 與量化（窗長 16、輸出 8 個係數）：輸入一行 17 個整數，第一個是量化步長 Q，其後 16 個是取樣值。以正弦窗 w[n]＝sin(π(n＋1/2)/16) 乘上取樣，做 MDCT：X[k]＝Σ w[n]x[n]cos(π/8 (n＋1/2＋4)(k＋1/2))，n 為 0 至 15、k 為 0 至 7；每個 X[k] 除以 Q 加 0.5 後向下取整，輸出一行 8 個整數',
                [],
                (c, N, I) => code(['import math', 'v = ' + nums(N, I), 'Q = v[0]', 'x = v[1:17]', 'out = []', 'for k in range(8):', '    s = 0.0', '    for n in range(16):', '        w = math.sin(math.pi * (n + 0.5) / 16)', '        s = s + w * x[n] * math.cos(math.pi / 8 * (n + 0.5 + 4) * (k + 0.5))', '    out.append(math.floor(s / Q + 0.5))', 'print(*out)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // IMDCT（窗長 16、係數 8）：y[n]＝w[n]·(2/8)·Σ X[k]cos(π/8 (n＋1/2＋4)(k＋1/2))，四捨五入為 floor(y＋0.5)。TDAC 相鄰區塊重疊相加已由測試檔驗證。
            D('aud.imdct8', 'aud-imdct8', 'IMDCT（窗長 16、係數 8）：輸入一行 8 個整數（MDCT 係數 X[0] 至 X[7]）。先算 Y[n]＝Σ X[k]cos(π/8 (n＋1/2＋4)(k＋1/2))，n 為 0 至 15、k 為 0 至 7；再乘上正弦窗 w[n]＝sin(π(n＋1/2)/16) 與係數 2/8，取 y＝w[n]·Y[n]/4，每個 y 加 0.5 後向下取整，輸出一行 16 個整數',
                [],
                (c, N, I) => code(['import math', 'X = ' + (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]'), 'out = []', 'for n in range(16):', '    s = 0.0', '    for k in range(8):', '        s = s + X[k] * math.cos(math.pi / 8 * (n + 0.5 + 4) * (k + 0.5))', '    w = math.sin(math.pi * (n + 0.5) / 16)', '    out.append(math.floor(w * s * 0.25 + 0.5))', 'print(*out)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
            // 端對端重疊相加（TDAC）：輸入一行 16 個整數，前 8 個是前一段的係數、後 8 個是這一段的係數。兩段各自做 IMDCT 並保留小數（窗與縮放 2/N＝0.25），
            // 前段的後半（第 8 至 15 格）與這段的前半（第 0 至 7 格）相加，最後每格加 0.5 向下取整，輸出 8 個整數。
            D('aud.olap8', 'aud-olap8', '重疊相加（TDAC）：輸入一行 16 個整數，前 8 個是前一段的 MDCT 係數，後 8 個是這一段的 MDCT 係數。兩段各自做 IMDCT（窗長 16、正弦窗、縮放 2/8，先不取整），前段輸出的後半 8 格與這段輸出的前半 8 格逐格相加，每格加 0.5 後向下取整，輸出 8 個整數',
                [],
                (c, N, I) => code(['import math', 'X = ' + (I.inputs[0].k === 'list' ? N.ls[0] : '[int(t) for t in ' + N.s[0] + '.split()]'), 'yA = []', 'yB = []', 'for n in range(16):', '    sa = 0.0', '    sb = 0.0', '    for k in range(8):', '        sa = sa + X[k] * math.cos(math.pi / 8 * (n + 0.5 + 4) * (k + 0.5))', '        sb = sb + X[8 + k] * math.cos(math.pi / 8 * (n + 0.5 + 4) * (k + 0.5))', '    w = math.sin(math.pi * (n + 0.5) / 16)', '    yA.append(w * sa * 0.25)', '    yB.append(w * sb * 0.25)', 'out = []', 'for n in range(8):', '    out.append(math.floor(yA[8 + n] + yB[n] + 0.5))', 'print(*out)']),
                { shape: numIn, limit: 1, helpers: () => [] }),
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'aud-mdct8q', re: ALL('MDCT|修正離散餘弦', '(?:窗|window|聲音|音訊|取樣)', '(?:量化|取樣)'), veto: /小波|Haar|哈爾|8\s*[x×*乘]\s*8|IMDCT|反變換/i },
            { key: 'aud-imdct8', re: ALL('IMDCT|反修正離散餘弦|反 ?MDCT', '(?:窗|window|係數|重疊)'), veto: /小波|Haar|哈爾|量化|重疊相加|端對端|TDAC/i },
            { key: 'aud-olap8', re: ALL('IMDCT|反修正離散餘弦|反 ?MDCT', '(?:重疊相加|TDAC|端對端)'), veto: /小波|Haar|哈爾|量化/i },
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['codec-transform'];
        return { id: 'avaudio', label: '影音壓縮 4：有損聲音（MDCT 與量化）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make };
});
