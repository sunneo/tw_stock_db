'use strict';
// 領域包「讀欄位與計數」：train＝教過的措辭（2026-11-12 新增，與乾淨 holdout 第一批、第二批的措辭與題型不同）。參考解獨立以 Python 標準函式庫手寫。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const FC = require('./domain_fieldcount_core.js');
const hex = (n) => Array.from({ length: n }, () => ('0' + rnd(0, 255).toString(16)).slice(-2)).join('');
// 產生器：隨機位元組（可選地從小字母表取值，讓標記與計數有機會出現）
const bytesGen = (n, alpha) => { const out = []; for (let i = 0; i < n; i++) out.push(alpha ? pick(alpha) : rnd(0, 255)); return out.map((b) => ('0' + b.toString(16)).slice(-2)).join('') + '\n'; };
const SEEDS = [
    // ── 讀欄位（train）──
    { id: 'tf-le-u2', st: '輸入一行十六進位，是一個自訂的 8 位元組標頭。請讀出位移 2、欄位寬 2 個位元組的欄位，以小端、無號整數解讀，十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(int.from_bytes(d[2:4], "little", signed=False))', gen: (b, o) => bytesGen(8 + o.rnd(0, 12)) },
    { id: 'tf-be-s4', st: '輸入一行十六進位，是一筆 16 位元組的記錄。請讀出位移 0、欄位寬 4 個位元組的欄位，以大端、有號（二補數）整數解讀，十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(int.from_bytes(d[0:4], "big", signed=True))', gen: (b, o) => bytesGen(16) },
    { id: 'tf-u1-5', st: '輸入一行十六進位，是一段資料。請讀出位移 5、欄位寬 1 個位元組的欄位，無號，十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(int.from_bytes(d[5:6], "little", signed=False))', gen: (b, o) => bytesGen(10) },
    { id: 'tf-be-u3', st: '輸入一行十六進位，是一段資料。請讀出位移 1、欄位寬 3 個位元組的欄位，大端，無號，十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(int.from_bytes(d[1:4], "big", signed=False))', gen: (b, o) => bytesGen(9) },
    // ── 計數：位元組標記（train）──
    { id: 'tc-ov', st: '輸入一行十六進位，是一段位元組。請計算標記「ab cd」在其中出現的次數（標記可以重疊），十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nm = bytes.fromhex("abcd")\nprint(sum(1 for i in range(len(d) - len(m) + 1) if d[i:i + len(m)] == m))', gen: (b, o) => bytesGen(30, [0xab, 0xcd, 0x00]) },
    { id: 'tc-nov', st: '輸入一行十六進位，是一段位元組。請計算標記「00 ff」出現幾次（不重疊），十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(d.count(bytes.fromhex("00ff")))', gen: (b, o) => bytesGen(30, [0x00, 0xff, 0x11]) },
    { id: 'tc-nov2', st: '輸入一行十六進位位元組序列。統計標記「1a 1a」的出現次數，不可重疊，十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(d.count(bytes.fromhex("1a1a")))', gen: (b, o) => bytesGen(30, [0x1a, 0x2b]) },
    { id: 'tc-ov3', st: '輸入一行十六進位位元組。數一數「f0 0f 0f」在裡面出現了幾次，允許重疊，十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nm = bytes.fromhex("f00f0f")\nprint(sum(1 for i in range(len(d) - len(m) + 1) if d[i:i + len(m)] == m))', gen: (b, o) => bytesGen(30, [0xf0, 0x0f]) },
    // ── 計數：位元組值的個數（train）──
    { id: 'tb-all', st: '輸入一行十六進位，是一段位元組。數出位元組值等於 0x41 的個數，十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(sum(1 for b_ in d if b_ == 65))', gen: (b, o) => bytesGen(30, [0x41, 0x42, 0x00]) },
    { id: 'tb-skip1', st: '輸入一行十六進位，是一段位元組。不計第一個位元組，數出位元組值等於 255 的個數，十進位輸出。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(sum(1 for b_ in d[1:] if b_ == 255))', gen: (b, o) => bytesGen(30, [0xff, 0x01]) },
    { id: 'tb-zero', st: '輸入一行十六進位，是一段位元組。統計位元組值為 0x00 的個數。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(sum(1 for b_ in d if b_ == 0))', gen: (b, o) => bytesGen(30, [0x00, 0x07]) },
    { id: 'tb-skip1b', st: '輸入一行十六進位，是一段位元組。不計第一個位元組，數出值為 16 的位元組個數。',
        ref: 'import sys\nd = bytes.fromhex(sys.stdin.read().strip())\nprint(sum(1 for b_ in d[1:] if b_ == 16))', gen: (b, o) => bytesGen(30, [16, 0x20]) }
];
const packs = [FC];
H.main({ name: '領域包 fieldcount', packs: [FC], seeds: SEEDS, minSkeletons: 3, judge: { checker: 'tokens' } });
