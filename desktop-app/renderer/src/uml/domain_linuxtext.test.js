'use strict';
// 領域包「Linux 文字工具行為」：train（原敘述＋改寫＋選項反序）＋ holdout（另寫措辭／政策組合，只量測、不教）。參考解獨立手寫。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const LT = require('./domain_linuxtext_core.js');
const wd = (al, a, b) => Array.from({ length: rnd(a, b) }, () => al[rnd(0, al.length - 1)]).join('');
const mk = (n, f) => n + '\n' + Array.from({ length: n }, f).join('\n') + '\n';
const csvLine = () => Array.from({ length: rnd(2, 5) }, () => wd('abcxyz', 1, 3)).join(',');
const wordLine = () => Array.from({ length: rnd(0, 4) }, () => wd('abcde', 1, 3)).join(' ');
const dupLines = (b) => mk(rnd(1, b ? 30 : 9), () => pick(['apple', 'pear', 'fig', 'kiwi', 'apple', 'pear']));
const numLines = (b) => mk(rnd(1, b ? 30 : 9), () => String(rnd(1, 60)));
const RD = 'n = int(input())\nL = [input() for _ in range(n)]\n';
const SEEDS = [
    { id: 'cut-2', want: 'lt.cut', st: '第一行 n，接著 n 行文字。用 cut 的做法：每行以逗號分隔切成欄位，輸出第 2 欄（欄位從 1 起算）；該行沒有第 2 欄時輸出空行。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'for t in L:\n    p = t.split(",")\n    print(p[1] if len(p) > 1 else "")', gen: (b) => mk(rnd(1, b ? 20 : 6), csvLine) },
    { id: 'cut-13', want: 'lt.cut', st: '第一行 n，接著 n 行文字。用 cut：每行以冒號分隔切成欄位，輸出第 1、3 欄並用空白接起來；欄位不足的行略過不輸出。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'for t in L:\n    p = t.split(":")\n    if len(p) >= 3:\n        print(p[0], p[2])', gen: (b) => mk(rnd(1, b ? 20 : 6), () => Array.from({ length: rnd(1, 4) }, () => wd('abxy', 1, 3)).join(':')) },
    { id: 'sort-desc-num', want: 'lt.sort-uniq', st: '第一行 n，接著 n 行，每行一個整數。用 sort -n -r 的做法：依數值由大到小排序後輸出每一行。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'for t in sorted(L, key=int, reverse=True):\n    print(t)', gen: numLines },
    { id: 'sort-u', want: 'lt.sort-uniq', st: '第一行 n，接著 n 行文字。相當於 sort -u：把所有行依字典序由小到大排序，相同的行只留一個，輸出。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'for t in sorted(set(L)):\n    print(t)', gen: dupLines },
    { id: 'uniq-c', want: 'lt.sort-uniq', st: '第一行 n，接著 n 行文字。相當於 sort | uniq -c：先排序，再把相同的行合併，每個不同的行輸出一行「次數 內容」，次數靠右對齊補空白到寬度 7，與內容之間隔一個空白。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'L.sort()\ni = 0\nwhile i < n:\n    j = i\n    while j < n and L[j] == L[i]:\n        j += 1\n    print("%7d %s" % (j - i, L[i]))\n    i = j', gen: dupLines },
    { id: 'uniq-adj', want: 'lt.sort-uniq', st: '第一行 n，接著 n 行文字。相當於 uniq：只把「相鄰」的相同行合併成一行，不排序，輸出結果。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'o = []\nfor t in L:\n    if not o or o[-1] != t:\n        o.append(t)\nprint("\\n".join(o))', gen: (b) => mk(rnd(1, b ? 30 : 9), () => pick(['a', 'a', 'b', 'c', 'c'])) },
    { id: 'wc-l', want: 'lt.wc', st: '第一行 n，接著 n 行文字。相當於 wc：輸出行數、單字數（以空白分隔）、字元數（每行包含結尾換行），三個數字以空白分隔。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'print(n, sum(len(t.split()) for t in L), sum(len(t) + 1 for t in L))', gen: (b) => mk(rnd(1, b ? 20 : 6), wordLine) },
    { id: 'head-3', want: 'lt.head-tail', st: '第一行 n，接著 n 行文字。相當於 head -n 3：輸出前 3 行（不足 3 行就全部輸出）。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'for t in L[:3]:\n    print(t)', gen: (b) => mk(rnd(1, b ? 12 : 6), wordLine) },
    { id: 'tail-2', want: 'lt.head-tail', st: '第一行 n，接著 n 行文字。相當於 tail -n 2：輸出最後 2 行（不足 2 行就全部輸出）。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'for t in L[-2:]:\n    print(t)', gen: (b) => mk(rnd(1, b ? 12 : 6), () => wd('abc', 1, 4)) },
    { id: 'tr-upper', want: 'lt.tr', st: '第一行 n，接著 n 行文字。相當於 tr \'a-z\' \'A-Z\'：把每行的小寫字母換成對應的大寫字母，其他字元不變，輸出每行。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'for t in L:\n    print("".join(chr(ord(c) - 32) if "a" <= c <= "z" else c for c in t))', gen: (b) => mk(rnd(1, b ? 15 : 5), () => wd('abXY 12', 1, 8)) },
    { id: 'tr-delete', want: 'lt.tr', st: '第一行 n，接著 n 行文字。相當於 tr -d \'aeiou\'：刪除每行中屬於字集「aeiou」的所有字元，輸出每行。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'for t in L:\n    print("".join(c for c in t if c not in "aeiou"))', gen: (b) => mk(rnd(1, b ? 15 : 5), () => wd('abcdeiou', 1, 8)) },
    { id: 'sed-all', want: 'lt.sed-subst', st: '第一行 n，接著 n 行文字。相當於 sed \'s/ab/X/g\'：每行把所有的「ab」換成「X」，輸出每一行。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'for t in L:\n    print(t.replace("ab", "X"))', gen: (b) => mk(rnd(1, b ? 15 : 5), () => wd('abc', 1, 9)) },
    { id: 'sed-first-changed', want: 'lt.sed-subst', st: '第一行 n，接著 n 行文字。相當於 sed -n \'s/a/#/p\'：每行只把第一個「a」換成「#」，並且只輸出有被換過的行。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'for t in L:\n    if "a" in t:\n        print(t.replace("a", "#", 1))', gen: (b) => mk(rnd(1, b ? 15 : 5), () => wd('abc', 1, 7)) },
    { id: 'awk-sum', want: 'lt.awk-group', st: '第一行 n，接著 n 行「名稱 數量」。相當於 awk：依第一欄分組，把第 2 欄的數值加總，每組輸出一行「名稱 總和」，名稱依字典序排列。', rw: (s) => s.replace(/\bn\b/g, 'm'), ref: RD + 'd = {}\nfor t in L:\n    a, b = t.split()\n    d[a] = d.get(a, 0) + int(b)\nfor k in sorted(d):\n    print(k, d[k])', gen: (b) => mk(rnd(1, b ? 20 : 6), () => pick(['ann', 'bob', 'cy', 'dee']) + ' ' + rnd(1, 50)) },
    // ---- holdout ----
    { id: 'ho-sort-rev', split: 'holdout', st: '第一行 n，接著 n 行，每行是一個單字。請依字典序由大到小排列後輸出（等同 sort -r）。', ref: RD + 'for t in sorted(L, reverse=True):\n    print(t)', gen: dupLines },
    { id: 'ho-cut-semi', split: 'holdout', st: '第一行 n，接著 n 行文字，欄位之間以分號分隔。請印出每一行的第三個欄位（編號從 1 算起）；若該行沒有第三欄就印出空行。', ref: RD + 'for t in L:\n    p = t.split(";")\n    print(p[2] if len(p) > 2 else "")', gen: (b) => mk(rnd(1, b ? 20 : 6), () => Array.from({ length: rnd(1, 5) }, () => wd('abxy', 1, 3)).join(';')) },
    { id: 'ho-tail-skip', split: 'holdout', st: '第一行 n，接著 n 行文字。跳過前 2 行，輸出其餘的行（像 tail -n +3）。', ref: RD + 'for t in L[2:]:\n    print(t)', gen: (b) => mk(rnd(1, b ? 12 : 6), () => wd('abc', 1, 4)) },
    { id: 'ho-awk-max', split: 'holdout', st: '第一行 n，接著 n 行「名稱 分數」。以 awk 的概念處理：依第一欄分組，找出每組第 2 欄的最大值，每組輸出「名稱 最大值」，依名稱字典序。', ref: RD + 'd = {}\nfor t in L:\n    a, b = t.split()\n    d[a] = max(d.get(a, -10**9), int(b))\nfor k in sorted(d):\n    print(k, d[k])', gen: (b) => mk(rnd(1, b ? 20 : 6), () => pick(['ann', 'bob', 'cy']) + ' ' + rnd(1, 90)) },
    { id: 'ho-wc-words', split: 'holdout', st: '第一行 n，接著 n 行文字。像 wc -w 那樣，輸出全部行加起來共有多少個以空白分隔的單字。', ref: RD + 'print(sum(len(t.split()) for t in L))', gen: (b) => mk(rnd(1, b ? 20 : 6), wordLine) },
];
H.main({ name: '領域包 linuxtext', packs: [LT], seeds: SEEDS, minSkeletons: 7 });
