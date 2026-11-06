'use strict';
// 領域包「檔案系統」：train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭，只量測、不教。參考解獨立手寫。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const FS = require('./domain_fs_core.js');
const chainGen = (b) => { const n = rnd(4, b ? 30 : 10); const ids = Array.from({ length: n }, (_, i) => i).sort(() => Math.random() - 0.5); const fat = Array(n).fill(-1); const heads = []; let i = 0; while (i < n) { const len = rnd(1, Math.max(1, Math.floor(n / 2))); const part = ids.slice(i, i + len); heads.push(part[0]); for (let j = 0; j + 1 < part.length; j++) fat[part[j]] = part[j + 1]; i += len; } return n + '\n' + fat.join(' ') + '\n' + pick(heads) + '\n'; };
const CH = (out) => 'n = int(input())\nfat = list(map(int, input().split()))\ns = int(input())\nc = [s]\nwhile fat[c[-1]] != -1:\n    c.append(fat[c[-1]])\n' + out + '\n';
const freeGen = (b, ex) => { const n = rnd(4, b ? 30 : 10); const k = rnd(1, 3); const fat = Array.from({ length: n }, () => (rnd(0, 2) ? rnd(1, n) : 0)); for (let i = 0; i < k; i++) fat[rnd(0, n - 1)] = 0; const z = fat.filter((x) => x === 0).length; return n + '\n' + fat.join(' ') + '\n' + Math.min(k, z) + '\n'; };
const freeGen2 = (b) => { const n = rnd(4, b ? 30 : 10); const fat = Array.from({ length: n }, () => (rnd(0, 2) ? rnd(1, n) : 0)); return n + '\n' + fat.join(' ') + '\n'; };
const FR = (out) => 'n = int(input())\nfat = list(map(int, input().split()))\n' + out + '\n';
const inGen = (b) => { const bs = pick([4, 8, 16]); const d = rnd(1, 4), p = rnd(2, 5); const q = rnd(1, b ? 15 : 6); const top = (d + p + p * p + p * p * p) * bs; return bs + ' ' + d + ' ' + p + ' ' + q + '\n' + Array.from({ length: q }, () => rnd(0, top)).join('\n') + '\n'; };
const LV = (out) => 'b, d, p, q = map(int, input().split())\nfor _ in range(q):\n    x = int(input()) // b\n    if x < d:\n        L = 0\n    elif x < d + p:\n        L = 1\n    elif x - d - p < p * p:\n        L = 2\n    else:\n        L = 3\n    ' + out + '\n';
const BL = (out) => 'b, d, p, q = map(int, input().split())\nfor _ in range(q):\n    sz = int(input())\n    n = -(-sz // b)\n    t = n\n    r = n - d\n    if r > 0:\n        t += 1\n        r -= p\n        if r > 0:\n            t += 1 + -(-r // p) if r <= p * p else 1 + p\n            r -= p * p\n            if r > 0:\n                t += 1 + -(-r // (p * p)) + -(-r // p)\n    ' + out + '\n';
const blGen = (b) => { const bs = pick([4, 8]); const d = rnd(1, 3), p = rnd(2, 4); const q = rnd(1, b ? 12 : 5); const top = (d + p + p * p + p * p * p) * bs; return bs + ' ' + d + ' ' + p + ' ' + q + '\n' + Array.from({ length: q }, () => rnd(1, top)).join('\n') + '\n'; };
const SEEDS = [
    { id: 'fat-len', want: 'fs.fat-chain', st: '第一行 n，第二行 n 個整數 fat，fat[i] 是簇 i 的下一個簇，-1 表示檔案結束（簇編號從 0 開始）。第三行 s 是檔案的起始簇。輸出檔案的簇鏈長度。', ref: CH('print(len(c))'), gen: chainGen },
    { id: 'fat-chain', want: 'fs.fat-chain', st: '第一行 n，第二行 n 個整數 fat，fat[i] 是簇 i 的下一個簇，-1 表示檔案結束（簇編號從 0 開始）。第三行 s 是檔案的起始簇。輸出檔案依序佔用的所有簇編號，用空白隔開。', ref: CH('print(*c)'), gen: chainGen },
    { id: 'fat-last', want: 'fs.fat-chain', st: '第一行 n，第二行 n 個整數 fat，fat[i] 是簇 i 的下一個簇，-1 表示檔案結束（簇編號從 0 開始）。第三行 s 是檔案的起始簇。輸出檔案的最後一個簇編號。', ref: CH('print(c[-1])'), gen: chainGen },
    { id: 'fat-jumps', want: 'fs.fat-chain', st: '第一行 n，第二行 n 個整數 fat，fat[i] 是簇 i 的下一個簇，-1 表示檔案結束（簇編號從 0 開始）。第三行 s 是檔案的起始簇。輸出檔案不連續的次數：鏈上下一個簇不是目前簇編號加一的次數。', ref: CH('print(sum(1 for i in range(1, len(c)) if c[i] != c[i-1] + 1))'), gen: chainGen },
    { id: 'free-count', want: 'fs.fat-free', st: '第一行 n，第二行 n 個整數表示 FAT 表（簇編號從 1 開始），0 代表空閒簇。輸出空閒簇的個數。', ref: FR('print(fat.count(0))'), gen: freeGen2 },
    { id: 'free-firstk', want: 'fs.fat-free', st: '第一行 n，第二行 n 個整數表示 FAT 表（簇編號從 1 開始），0 代表空閒簇。第三行 k。輸出編號最小的前 k 個空閒簇，用空白隔開。', ref: 'n = int(input())\nfat = list(map(int, input().split()))\nk = int(input())\nprint(*[i + 1 for i in range(n) if fat[i] == 0][:k])\n', gen: freeGen },
    { id: 'free-run', want: 'fs.fat-free', st: '第一行 n，第二行 n 個整數表示 FAT 表，0 代表空閒簇。輸出最長一段連續空閒簇的長度。', ref: FR('best = cur = 0\nfor x in fat:\n    cur = cur + 1 if x == 0 else 0\n    best = max(best, cur)\nprint(best)'), gen: freeGen2 },
    { id: 'inode-lvl', want: 'fs.inode-level', st: '第一行 b d p q，之後 q 行每行一個整數 x，表示檔案內的位元組偏移。inode 有 d 個直接指標，一個一級間接指標、一個二級間接指標、一個三級間接指標，每個指標區塊可放 p 個指標，區塊大小 b。輸出每個偏移所在邏輯區塊的階層編號：直接為 0、一級間接為 1、二級間接為 2、三級間接為 3。', ref: LV('print(L)'), gen: inGen },
    { id: 'inode-label', want: 'fs.inode-level', st: '第一行 b d p q，之後 q 行每行一個整數 x，表示檔案內的位元組偏移。inode 有 d 個直接指標，一個一級間接指標、一個二級間接指標、一個三級間接指標，每個指標區塊可放 p 個指標，區塊大小 b。輸出每個偏移所在邏輯區塊的階層：DIRECT、SINGLE、DOUBLE、TRIPLE。', ref: LV('print(["DIRECT", "SINGLE", "DOUBLE", "TRIPLE"][L])'), gen: inGen },
    { id: 'inode-total', want: 'fs.inode-blocks', st: '第一行 b d p q，之後 q 行每行一個整數 sz，表示檔案大小（位元組）。inode 有 d 個直接指標，一個一級間接指標、一個二級間接指標、一個三級間接指標，每個指標區塊可放 p 個指標，區塊大小 b。輸出檔案佔用的磁碟區塊總數：資料區塊加上用到的指標區塊。', ref: BL('print(t)'), gen: blGen },
    { id: 'ho-fat', split: 'holdout', st: '第一行 n，第二行 n 個整數 nxt，nxt[i] 表示簇 i 之後接哪個簇，值為 -1 代表檔案到此結束（簇從 0 開始編號）。第三行 s 是檔案第一個簇。輸出這個檔案共占幾個簇。', ref: CH('print(len(c))'), gen: chainGen },
    { id: 'ho-free', split: 'holdout', st: '第一行 n，第二行 n 個整數是 FAT 表（簇編號從 1 開始），值為 0 的簇沒有被使用。輸出沒被使用的簇共有幾個。', ref: FR('print(fat.count(0))'), gen: freeGen2 },
    { id: 'ho-inode', split: 'holdout', st: '第一行 b d p q，之後 q 行每行一個整數 x（檔案內位元組偏移）。一個 inode 有 d 個直接指標，另外有一級、二級、三級間接指標各一個，指標區塊每個可容納 p 個指標，區塊大小 b。對每個偏移輸出它的資料區塊要經過幾層間接（直接區塊是 0，一級是 1，二級是 2，三級是 3）。', ref: LV('print(L)'), gen: inGen },
];
H.main({ name: '領域包 fs', packs: [FS], seeds: SEEDS, minSkeletons: 4 });
