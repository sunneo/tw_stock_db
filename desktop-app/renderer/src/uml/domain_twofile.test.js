'use strict';
// 領域包「Linux 兩段輸入工具」：train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。參考解獨立手寫。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const TW = require('./domain_twofile_core.js');
const W = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const wd = () => pick(W) + (rnd(0, 1) ? pick(W) : '');
const sec = (k, f) => k + '\n' + Array.from({ length: k }, f).join('\n') + '\n';
const txtGen = (b) => sec(rnd(1, b ? 15 : 5), wd) + sec(rnd(1, b ? 15 : 5), wd);
const kvGen = (b) => sec(rnd(1, b ? 12 : 5), () => pick(W) + ' ' + rnd(1, 99)) + sec(rnd(1, b ? 12 : 5), () => pick(W) + ' ' + rnd(1, 99));
const sameGen = (b) => { const k = rnd(1, b ? 12 : 5); const A = Array.from({ length: k }, wd); const B = A.slice(); if (rnd(0, 2)) { B[rnd(0, k - 1)] = wd() + 'x'; } if (rnd(0, 3) === 0) B.pop(); if (!B.length) B.push('z'); return k + '\n' + A.join('\n') + '\n' + B.length + '\n' + B.join('\n') + '\n'; };
const RD = 'import sys\nd = sys.stdin.read().split("\\n")\nk = int(d[0])\nA = d[1:1+k]\nm = int(d[1+k])\nB = d[2+k:2+k+m]\n';
const CAT = (w, sep, rs) => RD + 'n = 0\nfor part in (A, B):\n' + (rs ? '    n = 0\n' : '') + '    for t in part:\n        n += 1\n        print(("%' + w + 'd" % n) + ' + sep + ' + t)\n';
const SET = (which, tail) => RD + 'sa, sb = set(A), set(B)\n' + { a: 'res = [t for t in A if t not in sb]', b: 'res = [t for t in B if t not in sa]', both: 'res = [t for t in A if t in sb]' }[which] + '\nres = list(dict.fromkeys(res))\n' + tail + '\n';
const JOIN = (keep) => RD + 'bm = {}\nfor t in B:\n    f = t.split()\n    bm.setdefault(f[0], []).append(f[1:])\nfor t in A:\n    f = t.split()\n    if f[0] in bm:\n        for r in bm[f[0]]:\n            print(" ".join(f + r))\n' + (keep ? '    else:\n        print(" ".join(f))\n' : '');
const PASTE = (sep) => RD + 'for i in range(max(len(A), len(B))):\n    print((A[i] if i < len(A) else "") + ' + sep + ' + (B[i] if i < len(B) else ""))\n';
const CMP = (out, same) => RD + 'dif = [i + 1 for i in range(max(len(A), len(B))) if (A[i] if i < len(A) else None) != (B[i] if i < len(B) else None)]\n' + (out === 'first' ? 'print(dif[0] if dif else ' + same + ')\n' : 'print(len(dif) if dif else ' + same + ')\n');
const rw = (s) => s.replace(/第一行/g, '首行');
const SEEDS = [
    { id: 'cat-cont', want: 'tf.cat-n', st: '輸入兩個「檔案」：每個檔案是一行 k 加上 k 行文字（先第一個、再第二個）。仿 cat -n 檔1 檔2：把兩個檔案依序連接，行號從 1 連續編到最後（不重新開始），格式：行號靠右對齊寬度 6、一個 Tab、文字。', ref: CAT(6, '"\\t"', false), gen: txtGen },
    { id: 'cat-restart', want: 'tf.cat-n', st: '輸入兩個檔案，每個檔案是一行 k 加上 k 行文字。仿 cat -n 檔1 檔2 但每個檔案的行號都重新從 1 開始：行號靠右對齊寬度 6、一個空白、文字。', ref: CAT(6, '" "', true), gen: txtGen },
    { id: 'set-a', want: 'tf.set', st: '第一行 n，接著 n 行是檔案 A 的每一行文字；再來一行 m，接著 m 行是檔案 B 的每一行文字。仿 comm -23：輸出只在 A 出現的行（依 A 的順序，重複的只輸出一次）。', ref: SET('a', 'print("\\n".join(res))'), gen: txtGen },
    { id: 'set-b', want: 'tf.set', st: '第一行 n，接著 n 行是檔案 A 的每一行文字；再來一行 m，接著 m 行是檔案 B 的每一行文字。仿 comm -13：輸出只在 B 出現的行（依 B 的順序，重複的只輸出一次）。', ref: SET('b', 'print("\\n".join(res))'), gen: txtGen },
    { id: 'set-both-count', want: 'tf.set', st: '第一行 n，接著 n 行是檔案 A 的文字；再來一行 m，接著 m 行是檔案 B 的文字。輸出兩個檔案共同的行有幾種（重複的行只算一次）。', ref: SET('both', 'print(len(res))'), gen: txtGen },
    { id: 'join-inner', want: 'tf.join', st: '第一行 n，接著 n 行是檔案 A 的每一行「鍵 值」；再來一行 m，接著 m 行是檔案 B 的每一行「鍵 值」。仿 join：以第一欄為鍵合併，輸出「鍵 A的值 B的值」（用空白隔開），依 A 的順序；沒有配對的行不輸出。', ref: JOIN(false), gen: kvGen },
    { id: 'join-left', want: 'tf.join', st: '第一行 n，接著 n 行是檔案 A 的每一行「鍵 值」；再來一行 m，接著 m 行是檔案 B 的每一行「鍵 值」。仿 join -a 1：以第一欄為鍵合併，輸出「鍵 A的值 B的值」（空白隔開），沒有配到的 A 行也原樣輸出。依 A 的順序。', ref: JOIN(true), gen: kvGen },
    { id: 'paste-tab', want: 'tf.paste', st: '第一行 n，接著 n 行是檔案 A 的每一行文字；再來一行 m，接著 m 行是檔案 B 的每一行文字。仿 paste：把兩個檔案逐行並排，每行是 A 的第 i 行、一個 Tab、B 的第 i 行；較短的檔案用空字串補。', ref: PASTE('"\\t"'), gen: txtGen },
    { id: 'cmp-first', want: 'tf.cmp', st: '第一行 n，接著 n 行是檔案 A 的每一行文字；再來一行 m，接著 m 行是檔案 B 的每一行文字。仿 cmp：輸出第一個不同的行號（從 1 開始，一邊先結束也算不同）；完全相同輸出 0。', ref: CMP('first', '0'), gen: sameGen },
    { id: 'cmp-count', want: 'tf.cmp', st: '第一行 n，接著 n 行是檔案 A 的每一行文字；再來一行 m，接著 m 行是檔案 B 的每一行文字。逐行比較，輸出不同的行數（一邊先結束，多出來的行也算不同）；完全相同輸出 0。', ref: CMP('count', '0'), gen: sameGen },
    { id: 'ho-cat', split: 'holdout', st: '輸入兩份清單，每份都是先一行整數 k，再 k 行字串。把兩份接在一起依序編號，編號從 1 連續到底，格式為編號靠右對齊寬度 6、Tab、字串，仿 cat -n 檔1 檔2。', ref: CAT(6, '"\\t"', false), gen: txtGen },
    { id: 'ho-diff', split: 'holdout', st: '第一行 n，接下來 n 行是檔案甲；再一行 m，之後 m 行是檔案乙。找出只出現在甲的行（依甲原本的順序，重複只留第一次），每行輸出一個。', ref: SET('a', 'print("\\n".join(res))'), gen: txtGen },
    { id: 'ho-join', split: 'holdout', st: '第一行 n，接下來 n 行是檔案 A 的記錄「鍵 值」；再一行 m，之後 m 行是檔案 B 的記錄「鍵 值」。把第一欄相同的記錄合併，輸出「鍵 A值 B值」，空白隔開，按 A 的順序，沒配到的不輸出。', ref: JOIN(false), gen: kvGen },
    { id: 'ho-cmp', split: 'holdout', st: '第一行 n，接著 n 行是文字 A；再來一行 m，接著 m 行是文字 B。逐行對照，輸出第一個不一樣的行是第幾行（從 1 算，長度不同時較短的那邊後面當作缺行）；兩邊完全一樣輸出 0。', ref: CMP('first', '0'), gen: sameGen },
];
H.main({ name: '領域包 twofile', packs: [TW], seeds: SEEDS, minSkeletons: 3 });
