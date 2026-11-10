/* 領域包：二進位格式家族的補洞（xz 串流標頭的檢查類型名稱、8 位元調色盤 BMP 寫出）。格式見 domain_registry_core.js。
 * 這兩個家族原本在 Linux 題庫的 holdout 裡解不出來（核心範式 xz.stream-header 只輸出三種判決字樣；bmp.write24 只有 24 位元、沒有調色盤）。
 * xz.header-parse：檢查類型的名稱表、各種判決字樣、不在表中的格式，一律從敘述抽（括號例句「OK CRC32」教出前綴；n=名稱 教出表；BAD／FAIL 字樣教出判決），抽不到就拒絕渲染；
 *   差異點（判決字樣的對應、先檢查魔術還是 CRC、CRC 範圍、檢查類型取低 4 位元還是整個位元組）是槽位，由沙盒窮舉。
 * bmp.write8：第一行「寬 高 k」、第二行 k 個 RRGGBB、之後逐列索引；上下翻轉、調色盤位元組順序、biClrUsed／biClrImportant 的值是槽位。解析度從敘述抽（抽不到用 2835）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainBinfmt = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'binary-format', label, slots, py }, extra || {});
        const crcHelper = { name: 'crc32', params: ['data'], py: ['crc = 0xFFFFFFFF', 'for b_ in data:', '    crc ^= b_', '    for _ in range(8):', '        if crc & 1:', '            crc = (crc >> 1) ^ 0xEDB88320', '        else:', '            crc >>= 1', 'return crc ^ 0xFFFFFFFF'] };
        const quoted = (st) => [...String(st).matchAll(/[「『"]([^」』"]+)[」』"]/g)].map((m) => m[1].trim());
        // 從敘述抽 xz 標頭的輸出約定
        const xzSpec = (I) => {
            const st = String(I.statement);
            const names = []; for (const m of st.matchAll(/(\d+)\s*[=＝]\s*([A-Za-z][\w-]*)/g)) names.push([+m[1], m[2]]);
            if (names.length < 2) throw new Error('抽不到檢查類型的名稱表');
            const ex = quoted(st); const okEx = ex.find((e) => names.some((n) => e.endsWith(n[1])));
            if (!okEx) throw new Error('抽不到成功例句');
            const first = names.find((n) => okEx.endsWith(n[1])); const prefix = okEx.slice(0, okEx.length - first[1].length);
            const PH = new RegExp(String.raw`^(.*?[^A-Za-z])(?:數字|值|編號|號碼|N|X|n|x)(\)?)$`);
            const unk = ex.find((e) => e !== okEx && !names.some((n) => e.endsWith(n[1])) && PH.test(e));
            if (!unk) throw new Error('抽不到不在表中的類型格式');
            const um = PH.exec(unk);
            const okw = prefix.trim() ? prefix.trim().split(/\s+/)[0] : null; const bad = []; for (const m of st.matchAll(/輸出\s*[「『"]?([A-Za-z][\w-]*(?: [A-Za-z_]+)?)[」』"]?/g)) { const w = m[1].trim(); if ((!okw || w.indexOf(okw) !== 0) && unk.indexOf(w) !== 0 && !bad.includes(w)) bad.push(w); }
            if (bad.length !== 2) throw new Error('抽不到兩種失敗字樣');
            return { names, prefix, upre: um[1], usuf: um[2], bad };
        };
        const skeletons = [
            D('xz.header-parse', 'xz-header2', 'xz 串流標頭（12 位元組）：魔術數字、串流旗標（檢查類型取第二個位元組的低 4 位元）、旗標的 CRC-32；成功時輸出「前綴＋檢查類型名稱」（表、前綴、不在表中的格式從敘述抽），失敗輸出敘述裡的兩種字樣',
                [S('perm', '失敗字樣對應（魔術不符、CRC 不符）', [['01', '0, 1'], ['10', '1, 0']]), S('first', '先檢查', [['magic', 'magic'], ['crc', 'crc']]), S('crcof', 'CRC 範圍', [['flags', 'raw_[6:8]'], ['hdr', 'raw_[0:8]']]), S('tbits', '檢查類型', [['low', 'raw_[7] & 15'], ['full', 'raw_[7]']])],
                (c, N, I) => { const sp = xzSpec(I); const p = c.perm.split(', ').map(Number); const tbl = '{' + sp.names.map((n) => n[0] + ': ' + JSON.stringify(n[1])).join(', ') + '}';
                    const magicBad = 'print(' + JSON.stringify(sp.bad[p[0]]) + ')', crcBad = 'print(' + JSON.stringify(sp.bad[p[1]]) + ')';
                    const body = c.first === 'magic' ? ['if not mg_:', '    ' + magicBad, 'elif ck_ != st_:', '    ' + crcBad, 'else:', '    OKP'] : ['if ck_ != st_:', '    ' + crcBad, 'elif not mg_:', '    ' + magicBad, 'else:', '    OKP'];
                    const okp = 'tb_ = ' + c.tbits + '\n    nm_ = ' + tbl + '.get(tb_)\n    if nm_ is None:\n        print(' + JSON.stringify(sp.upre) + ' + str(tb_) + ' + JSON.stringify(sp.usuf) + ')\n    else:\n        print(' + JSON.stringify(sp.prefix) + ' + nm_)';
                    return code(['raw_ = bytes.fromhex(' + N.s[0] + '.strip())', 'mg_ = raw_[0:6] == bytes([0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])', 'ck_ = crc32(' + c.crcof + ')', 'st_ = int.from_bytes(raw_[8:12], "little")'].concat(body.map((l) => l.replace('OKP', okp)))); },
                { shape: (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex', limit: 16, helpers: () => [crcHelper] }),
            D('xz.footer-parse', 'xz-footer', 'xz 串流頁尾（12 位元組）：4 位元組小端 CRC-32（算 backward size 與旗標共 6 位元組）、4 位元組 backward size、2 位元組串流旗標、結尾 YZ；成功時輸出「前綴＋檢查類型名稱」（表、前綴、不在表中的格式與兩種失敗字樣從敘述抽）',
                [S('perm', '失敗字樣對應（結尾不符、CRC 不符）', [['01', '0, 1'], ['10', '1, 0']]), S('first', '先檢查', [['magic', 'magic'], ['crc', 'crc']]), S('crcof', 'CRC 範圍', [['six', 'raw_[4:10]'], ['bs', 'raw_[4:8]']]), S('tbits', '檢查類型', [['low', 'raw_[9] & 15'], ['full', 'raw_[9]']])],
                (c, N, I) => { const sp = xzSpec(I); const p = c.perm.split(', ').map(Number); const tbl = '{' + sp.names.map((n) => n[0] + ': ' + JSON.stringify(n[1])).join(', ') + '}';
                    const magicBad = 'print(' + JSON.stringify(sp.bad[p[0]]) + ')', crcBad = 'print(' + JSON.stringify(sp.bad[p[1]]) + ')';
                    const body = c.first === 'magic' ? ['if not mg_:', '    ' + magicBad, 'elif ck_ != st_:', '    ' + crcBad, 'else:', '    OKP'] : ['if ck_ != st_:', '    ' + crcBad, 'elif not mg_:', '    ' + magicBad, 'else:', '    OKP'];
                    const okp = 'tb_ = ' + c.tbits + '\n    nm_ = ' + tbl + '.get(tb_)\n    if nm_ is None:\n        print(' + JSON.stringify(sp.upre) + ' + str(tb_) + ' + JSON.stringify(sp.usuf) + ')\n    else:\n        print(' + JSON.stringify(sp.prefix) + ' + nm_)';
                    return code(['raw_ = bytes.fromhex(' + N.s[0] + '.strip())', 'mg_ = raw_[10:12] == b"YZ"', 'ck_ = crc32(' + c.crcof + ')', 'st_ = int.from_bytes(raw_[0:4], "little")'].concat(body.map((l) => l.replace('OKP', okp)))); },
                { shape: (I) => I.inputs.length === 1 && I.inputs[0].k === 'hex', limit: 16, helpers: () => [crcHelper] }),
            D('bmp.write8', 'bmp-write8', '8 位元調色盤 BMP 寫出：第一行「寬 高 k」、第二行 k 個 RRGGBB、之後逐列調色盤索引；檔頭 14＋資訊標頭 40＋調色盤 4k（B G R 0 或 R G B 0）＋像素（由下而上或由上而下，每列補 0 到 4 的倍數）；使用色彩數與重要色彩數的值由窮舉挑',
                [S('flip', '列序', [['bu', 'range(ht_ - 1, -1, -1)'], ['td', 'range(ht_)']]), S('po', '調色盤位元組順序', [['bgr', '[b_, g_, r_, 0]'], ['rgb', '[r_, g_, b_, 0]']]), S('ci', '使用色彩數／重要色彩數', [['k0', 'k_, 0'], ['00', '0, 0']]), S('pf', '調色盤寫法', [['hex', 'hex'], ['dec', 'dec']])],
                (c, N, I) => { const dpi = (/解析度皆\s*(\d+)/.exec(String(I.statement)) || [])[1] || 2835; const L = N.L[0];
                    return code(['w_, ht_, k_ = [int(t) for t in ' + L + '[0].split()]', c.pf === 'hex' ? 'pal_ = [[int(t[0:2], 16), int(t[2:4], 16), int(t[4:6], 16)] for t in ' + L + '[1].split()]' : 'pal_ = [[int(t) for t in ' + L + '[1 + i].split()] for i in range(k_)]', 'rows_ = [t.split() for t in ' + L + '[' + (c.pf === 'hex' ? '2' : '1 + k_') + ':' + (c.pf === 'hex' ? '2' : '1 + k_') + ' + ht_]]', 'pad_ = (4 - w_ % 4) % 4', 'data_ = bytearray()', 'for y in ' + c.flip + ':', '    data_ += bytes([int(t) for t in rows_[y]])', '    data_ += bytes(pad_)', 'pb_ = bytearray()', 'for c_ in pal_:', '    r_ = c_[0]', '    g_ = c_[1]', '    b_ = c_[2]', '    pb_ += bytes(' + c.po + ')',
                        'off_ = 54 + 4 * k_', 'fs_ = off_ + len(data_)', 'hdr_ = b"BM" + fs_.to_bytes(4, "little") + bytes(4) + off_.to_bytes(4, "little")', 'dib_ = (40).to_bytes(4, "little") + w_.to_bytes(4, "little") + ht_.to_bytes(4, "little") + (1).to_bytes(2, "little") + (8).to_bytes(2, "little") + bytes(4) + len(data_).to_bytes(4, "little") + (' + dpi + ').to_bytes(4, "little") + (' + dpi + ').to_bytes(4, "little") + (' + c.ci.split(', ')[0] + ').to_bytes(4, "little") + (' + c.ci.split(', ')[1] + ').to_bytes(4, "little")', 'print((hdr_ + dib_ + bytes(pb_) + bytes(data_)).hex())']); },
                { shape: (I) => I.inputs.some((x) => x.k === 'rest'), limit: 16 })
        ];
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => String.raw`(?=[\s\S]*` + x + ')').join(''), 'i');
        const algos = [
            { key: 'xz-footer', re: /xz[\s\S]*(?:頁尾|footer)[\s\S]*\d+\s*[=＝]\s*[A-Za-z]/i, veto: /解壓|解碼資料|還原/ },
            { key: 'xz-header2', re: /xz[\s\S]*(?:標頭|header)[\s\S]*\d+\s*[=＝]\s*[A-Za-z]/i, veto: /解壓|解碼資料|還原|頁尾|footer/i },
            { key: 'bmp-write8', re: ALL('(?:寫出|寫成|組出|產生|輸出整個|輸出[^。，；]{0,12}BMP)', '調色盤', String.raw`(?:8\s*位元|八位元|256\s*色)`, 'BMP'), rawAll: true }
        ].map((x) => Object.assign(x, { pri: true }));
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['binary-format'];
        return { id: 'binfmt', label: '二進位格式補洞（xz 標頭檢查類型、8 位元調色盤 BMP 寫出）', requires: [], judge: { checker: 'tokens' }, algos, paradigms, skeletons };
    }
    return { make };
});
