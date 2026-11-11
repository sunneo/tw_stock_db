/* 領域包：BMP 進階讀取（RLE8／RLE4 行程長度壓縮、16／32 位元的色彩遮罩 BI_BITFIELDS）。格式見 domain_registry_core.js。
 * bmpx.rle：依檔頭的壓縮欄位（位元組 30–33：1＝RLE8、2＝RLE4）解碼——編碼模式（count＋值；RLE4 交替高低半位元組）、跳脫碼（0 換行、1 結束、2 位移 dx dy）、
 *   絕對模式（count≥3 個字面像素，補到偶數位元組），沒被涵蓋的像素是索引 0；調色盤從 14＋資訊標頭大小開始，每色 B G R 保留；輸出依列序槽位（由上而下或儲存順序）。
 * bmpx.bitfields：壓縮欄位 3 時遮罩在位元組 54／58／62（資訊標頭 ≥56 時 66 是 alpha 遮罩）；壓縮欄位 0 的 32 位元用 BGRA 預設遮罩、16 位元用 5-5-5 預設遮罩；
 *   每個通道取 (像素 & 遮罩) >> 遮罩最低位元位置，再縮放到 8 位元（縮放方式是槽位，由沙盒窮舉）；高度為負表示由上而下。
 * 誠實限制：只做讀取；調色盤色數、列對齊、像素資料位移都從檔頭讀；RLE 假設串流格式正確（不檢查壞資料）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainBmpx = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'binary-format', label, slots, py }, extra || {});
        const hexIn = (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex';
        const hx = (N) => N.s[0];
        const le = (a, n, signed) => 'int.from_bytes(raw_[' + a + ':' + (a + n) + '], "little"' + (signed ? ', signed=True' : '') + ')';
        const HEAD = (N) => ['raw_ = bytes.fromhex(' + hx(N) + '.strip())', 'off_ = ' + le(10, 4), 'hs_ = ' + le(14, 4), 'w_ = ' + le(18, 4, true), 'ht0_ = ' + le(22, 4, true), 'bpp_ = ' + le(28, 2), 'comp_ = ' + le(30, 4), 'ht_ = abs(ht0_)'];
        const skeletons = [
            D('bmpx.rle', 'bmp-rle', 'BMP RLE8／RLE4 解碼：壓縮欄位 1＝RLE8、2＝RLE4；編碼模式（重複）、跳脫（換行／結束／位移）、絕對模式；調色盤查表後逐列輸出（顏色十六進位或索引）',
                [S('ord', '列序', [['bu', 'range(ht_ - 1, -1, -1)'], ['st', 'range(ht_)']]), S('out', '輸出', [['rgb', 'rgb'], ['idx', 'idx']])],
                (c, N) => code(HEAD(N).concat([
                    'nc_ = ' + le(46, 4), 'if nc_ == 0:', '    nc_ = 1 << bpp_',
                    'pal_ = [(raw_[14 + hs_ + 4 * i + 2], raw_[14 + hs_ + 4 * i + 1], raw_[14 + hs_ + 4 * i]) for i in range(nc_)]',
                    'img_ = [[0] * w_ for _ in range(ht_)]', 'x_ = 0', 'y_ = 0', 'p_ = off_',
                    'while p_ + 1 < len(raw_):', '    n_ = raw_[p_]', '    v_ = raw_[p_ + 1]', '    p_ += 2',
                    '    if n_ > 0:', '        for i_ in range(n_):', '            if x_ < w_ and y_ < ht_:',
                    '                img_[y_][x_] = v_ if comp_ == 1 else ((v_ >> 4) if i_ % 2 == 0 else (v_ & 15))', '            x_ += 1',
                    '    elif v_ == 0:', '        x_ = 0', '        y_ += 1',
                    '    elif v_ == 1:', '        break',
                    '    elif v_ == 2:', '        x_ += raw_[p_]', '        y_ += raw_[p_ + 1]', '        p_ += 2',
                    '    else:', '        for i_ in range(v_):',
                    '            b_ = raw_[p_ + i_] if comp_ == 1 else raw_[p_ + i_ // 2]',
                    '            if comp_ == 2:', '                b_ = (b_ >> 4) if i_ % 2 == 0 else (b_ & 15)',
                    '            if x_ < w_ and y_ < ht_:', '                img_[y_][x_] = b_', '            x_ += 1',
                    '        nb_ = v_ if comp_ == 1 else (v_ + 1) // 2', '        p_ += nb_ + (nb_ & 1)',
                    'for y_ in ' + c.ord + ':', c.out === 'rgb' ? '    print(*["%02x%02x%02x" % pal_[k_] for k_ in img_[y_]])' : '    print(*img_[y_])'])),
                { shape: hexIn, limit: 4 }),
            D('bmpx.bitfields', 'bmp-bitfields', 'BMP 16／32 位元色彩遮罩：壓縮欄位 3 時讀 R／G／B（及 alpha）遮罩，0 時用預設遮罩；各通道 (像素&遮罩)>>位移 後縮放成 8 位元；逐列輸出（高度為負＝由上而下）',
                [S('scale', '縮放成 8 位元', [['mul', 'v_ * 255 // mx_'], ['rnd', '(v_ * 255 + mx_ // 2) // mx_'], ['shl', 'v_ << (8 - b_) if b_ <= 8 else v_ >> (b_ - 8)'], ['rep', '((v_ << (8 - b_)) | (v_ >> (2 * b_ - 8))) if b_ <= 8 else v_ >> (b_ - 8)']]),
                    S('fmt', '輸出', [['hex', '"%02x%02x%02x" % (r_, g_, b2_)'], ['dec', '"%d,%d,%d" % (r_, g_, b2_)'], ['argb', '"%02x%02x%02x%02x" % (a_, r_, g_, b2_)']])],
                (c, N) => code(HEAD(N).concat([
                    'if comp_ == 3:', '    mr_ = ' + le(54, 4), '    mg_ = ' + le(58, 4), '    mb_ = ' + le(62, 4), '    ma_ = ' + le(66, 4) + ' if hs_ >= 56 else 0',
                    'elif bpp_ == 32:', '    mr_, mg_, mb_, ma_ = 0xFF0000, 0xFF00, 0xFF, 0',
                    'else:', '    mr_, mg_, mb_, ma_ = 0x7C00, 0x3E0, 0x1F, 0',
                    'bs_ = bpp_ // 8', 'st_ = (w_ * bpp_ + 31) // 32 * 4',
                    'for yy_ in range(ht_):', '    sy_ = yy_ if ht0_ < 0 else ht_ - 1 - yy_', '    row_ = []', '    for x_ in range(w_):',
                    '        px_ = int.from_bytes(raw_[off_ + sy_ * st_ + x_ * bs_:off_ + sy_ * st_ + (x_ + 1) * bs_], "little")',
                    '        ch_ = []', '        for i_, m_ in enumerate((mr_, mg_, mb_, ma_)):',
                    '            if m_ == 0:', '                ch_.append(255 if i_ == 3 else 0)', '                continue',
                    '            sh_ = (m_ & -m_).bit_length() - 1', '            mx_ = m_ >> sh_', '            b_ = mx_.bit_length()', '            v_ = (px_ & m_) >> sh_', '            ch_.append(' + c.scale + ')',
                    '        r_, g_, b2_, a_ = ch_', '        row_.append(' + c.fmt + ')', '    print(*row_)'])),
                { shape: hexIn, limit: 12 })
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'bmp-rle', re: ALL('BMP', '(?:RLE|行程長度|BI_RLE|壓縮(?:類型|方式|欄位)?\\s*[=＝為是]?\\s*[12]\\b)'), veto: /寫出|組出|編碼成|壓縮成/ },
            { key: 'bmp-bitfields', re: ALL('BMP', '(?:BITFIELDS|遮罩|mask|565|5-5-5|RGB555|ARGB)'), veto: /寫出|組出|RLE/ }
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['binary-format'];
        return { id: 'bmpx', label: 'BMP 進階讀取（RLE8／RLE4、色彩遮罩）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make };
});
