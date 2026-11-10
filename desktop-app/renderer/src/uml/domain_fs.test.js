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
// ── 第二批的產生器與參考解 ──
const PNTOK = ['a', 'b', 'c', 'd', '..', '.', '..', 'x'];
const pnPath = (abs) => { const k = rnd(1, 6); let s = abs ? '/' : ''; for (let i = 0; i < k; i++) { s += pick(PNTOK); if (i < k - 1) s += pick(['/', '/', '//']); } if (rnd(0, 3) === 0) s += '/'; return s; };
const pnGen = (abs) => (b) => { const q = rnd(1, b ? 12 : 5); return q + '\n' + Array.from({ length: q }, () => pnPath(abs)).join('\n') + '\n'; };
const PNS = (kind, tail) => '第一行 q，接著 q 行，每行一條 Unix 風格的' + kind + '，可能含有 . 、 .. 和連續多個斜線，也可能以斜線結尾。' + tail;
const PNR = (out) => 'import posixpath\nq = int(input())\nfor _ in range(q):\n    p = input().strip()\n    n = "/" + posixpath.normpath(p).lstrip("/")\n    ' + out + '\n';
const DRTOK = ['a', 'b', 'c', 'a/b', 'b/c', '..', '.', '/a', '/a/b', '../a', 'a/..', '/', 'x'];
const drGen = (b) => { const q = rnd(5, b ? 20 : 12); const L = []; for (let i = 0; i < q - 2; i++) L.push(pick(['mkdir', 'mkdir', 'cd', 'cd', 'pwd']) === 'pwd' ? 'pwd' : pick(['mkdir', 'cd']) + ' ' + pick(DRTOK)); L.push('cd ' + pick(DRTOK)); L.push('pwd'); return L.length + '\n' + L.join('\n') + '\n'; };
const DRS = (tail) => '第一行 q，之後 q 行指令：mkdir 路徑（建立目錄，連同缺少的上層目錄）、cd 路徑、pwd（輸出目前所在目錄）。一開始只有根目錄 /，目前目錄是 /。路徑可以是絕對或相對，可含 . 與 ..（根目錄的 .. 還是根目錄）。cd 到不存在的目錄就留在原處。' + tail;
const DRR = (emit, label, mk) => 'import posixpath\nq = int(input())\ndirs = {"/"}\ncwd = "/"\nfor _ in range(q):\n    p = input().split()\n    if p[0] == "pwd":\n        if "' + emit + '" == "pwd":\n            print(cwd)\n        continue\n    t = "/" + posixpath.normpath(posixpath.join(cwd, p[1])).lstrip("/")\n    if p[0] == "mkdir":\n        if "' + mk + '" == "parents":\n            x = t\n            while True:\n                dirs.add(x)\n                if x == "/":\n                    break\n                x = posixpath.dirname(x) or "/"\n        elif (posixpath.dirname(t) or "/") in dirs:\n            dirs.add(t)\n    else:\n        if t in dirs:\n            cwd = t\n            if "' + emit + '" == "cd":\n                print(cwd)\n        elif ' + (label ? 'True' : 'False') + ' and "' + emit + '" != "final":\n            print("ERROR")\n        elif "' + emit + '" == "cd":\n            print(cwd)\nif "' + emit + '" == "final":\n    print(cwd)\n';
const alGen = (b) => { const N = rnd(8, b ? 30 : 18); const bits = Array.from({ length: N }, () => (rnd(0, 9) < 4 ? 1 : 0)); const q = rnd(2, 5); return N + ' ' + q + '\n' + bits.join(' ') + '\n' + Array.from({ length: q }, () => rnd(1, 4)).join('\n') + '\n'; };
const ALS = (strat, tail) => '第一行 N q，第二行 N 個整數描述磁碟，0 表示該區塊空閒、1 表示已被使用。接著 q 行，每行一個整數 k，表示一個新檔案需要連續 k 個空閒區塊。檔案依序處理，每個檔案採用 ' + strat + '，從選到的空閒區段開頭開始占用（占用後這些區塊就不再空閒）；放不下的檔案不占用任何區塊。' + tail;
const ALR = (strat, base, out) => 'import re\nN, q = map(int, input().split())\nbits = list(map(int, input().split()))\nres = []\nfor _ in range(q):\n    k = int(input())\n    runs = [(m.start(), m.end() - m.start()) for m in re.finditer("0+", "".join(map(str, bits)))]\n    cand = [r for r in runs if r[1] >= k]\n    if not cand:\n        res.append(-1)\n        continue\n    r = sorted(cand, key=lambda r: ' + ({ first: '(r[0],)', best: '(r[1], r[0])', worst: '(-r[1], r[0])' }[strat]) + ')[0]\n    for x in range(r[0], r[0] + k):\n        bits[x] = 1\n    res.append(r[0] + ' + base + ')\n' + out + '\n';
const ifGen = (b) => { const q = rnd(1, b ? 10 : 5); return pick([4, 8, 16]) + ' ' + q + '\n' + Array.from({ length: q }, () => rnd(1, 100)).join('\n') + '\n'; };
const IFS = (tail) => '第一行 b q，之後 q 行每行一個整數 s，表示檔案大小（位元組）。檔案系統以大小 b 的區塊（叢集）為配置單位，每個檔案配置的區塊數必須是整數，最後一個區塊通常用不滿，浪費的空間就是內部碎片。' + tail;
const IFR = (out, acc) => 'b, q = map(int, input().split())\ntot = 0\nfor _ in range(q):\n    s = int(input())\n    ' + out + '\n' + (acc ? 'print(tot)\n' : '');
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
    // ── 第二批：路徑正規化、目錄解析、連續配置策略、內部碎片（參考解用 posixpath／regex，跟骨架做法不同）──
    { id: 'pn-abs', want: 'fs.path-normalize', st: PNS('絕對路徑', '輸出正規化後的路徑：不含 . 與連續斜線，.. 退回上一層（根目錄的上一層仍是根目錄），結尾不留斜線（根目錄就是 /）。'), ref: PNR('print(n)'), gen: pnGen(true), rw: (s) => s.replace(/\bq\b/g, 'k') },
    { id: 'pn-depth', want: 'fs.path-normalize', st: PNS('絕對路徑', '輸出正規化後的路徑有幾層（根目錄是 0 層）。'), ref: PNR('print(len([x for x in n.split("/") if x]))'), gen: pnGen(true) },
    { id: 'pn-last', want: 'fs.path-normalize', st: PNS('絕對路徑', '輸出正規化後路徑的最後一層名稱；如果正規化後是根目錄，輸出 /。'), ref: PNR('print(n.split("/")[-1] or "/")'), gen: pnGen(true) },
    { id: 'pn-parent', want: 'fs.path-normalize', st: PNS('絕對路徑', '輸出正規化後路徑的上一層目錄（根目錄的上一層仍是 /）。'), ref: PNR('print(posixpath.dirname(n) or "/")'), gen: pnGen(true) },
    { id: 'pn-rel', want: 'fs.path-normalize', st: PNS('相對路徑（不以斜線開頭）', '輸出正規化後的相對路徑：去掉 . 與連續斜線，能抵消的 .. 要抵消，抵消不掉的開頭 .. 保留；結果是空的就輸出 .'), ref: 'import posixpath\nq = int(input())\nfor _ in range(q):\n    p = input().strip()\n    print(posixpath.normpath(p))\n', gen: pnGen(false) },
    { id: 'pn-cwd', want: 'fs.path-normalize', st: '第一行是一個字串 cwd，表示目前工作目錄（一條正規化的絕對路徑）；第二行 q，接著 q 行，每行一個路徑，可能是相對路徑（相對於 cwd）或絕對路徑，可含 . 、 .. 和連續斜線。輸出每個路徑解析後的絕對路徑（正規化：不含 . 與連續斜線，根目錄的 .. 仍是根目錄，結尾不留斜線）。', ref: 'import posixpath\ncwd = input().strip()\nq = int(input())\nfor _ in range(q):\n    p = input().strip()\n    t = posixpath.normpath(posixpath.join(cwd, p))\n    print("/" + t.lstrip("/"))\n', gen: (b) => pick(['/', '/home/u', '/a/b/c', '/usr']) + '\n' + pnGen(rnd(0, 1) === 1)(b) },
    { id: 'pn-one', want: 'fs.path-normalize', st: '輸入一個字串 p，是一條 Unix 絕對路徑，可能含有 . 、 .. 和連續多個斜線。輸出正規化後的路徑（根目錄的上一層仍是根目錄，結尾不留斜線）。', ref: 'import posixpath\np = input().strip()\nprint("/" + posixpath.normpath(p).lstrip("/"))\n', gen: (b) => pnGen(true)(b).split('\n')[1] + '\n' },
    { id: 'dr-pwd', want: 'fs.dir-resolve', st: DRS('輸出每個 pwd 的結果。'), ref: DRR('pwd', false, 'parents'), gen: drGen },
    { id: 'dr-cd', want: 'fs.dir-resolve', st: DRS('輸出每次 cd 之後的目前目錄（cd 失敗時目前目錄不變，也輸出目前目錄）。').replace('cd 到不存在的目錄就留在原處', 'cd 到不存在的目錄就留在原處'), ref: DRR('cd', false, 'parents'), gen: drGen },
    { id: 'dr-label', want: 'fs.dir-resolve', st: DRS('輸出每個 pwd 的結果；cd 到不存在的目錄時改輸出 ERROR。').replace('cd 到不存在的目錄就留在原處。', 'cd 到不存在的目錄就停在原處。'), ref: DRR('pwd', true, 'parents'), gen: drGen },
    { id: 'dr-strict', want: 'fs.dir-resolve', st: DRS('輸出最後所在的目錄。').replace('mkdir 路徑（建立目錄，連同缺少的上層目錄）', 'mkdir 路徑（建立目錄；它的上一層必須已經存在，否則不建立）'), ref: DRR('final', false, 'strict'), gen: drGen },
    { id: 'al-first', want: 'fs.alloc-strategy', st: ALS('first-fit：選編號最前面的、夠長的空閒區段', '輸出每個檔案配置到的起始區塊編號（區塊從 0 開始編號）；配置不到輸出 -1。'), ref: ALR('first', 0, 'print(*res)'), gen: alGen, rw: (s) => s.replace(/\bN\b/g, 'M') },
    { id: 'al-best', want: 'fs.alloc-strategy', st: ALS('best-fit：選夠長的空閒區段中最短的，同樣長取起點最小的', '輸出每個檔案配置到的起始區塊編號（區塊從 1 開始編號）；配置不到輸出 -1。'), ref: ALR('best', 1, 'print(*res)'), gen: alGen },
    { id: 'al-worst', want: 'fs.alloc-strategy', st: ALS('worst-fit：選最長的空閒區段，同樣長取起點最小的', '輸出每個檔案配置到的起始區塊編號（區塊從 0 開始編號）；配置不到輸出 -1。'), ref: ALR('worst', 0, 'print(*res)'), gen: alGen },
    { id: 'al-fails', want: 'fs.alloc-strategy', st: ALS('best-fit：選夠長的空閒區段中最短的，同樣長取起點最小的', '輸出有幾個檔案配置失敗。'), ref: ALR('best', 0, 'print(res.count(-1))'), gen: alGen },
    { id: 'al-frag', want: 'fs.alloc-strategy', st: ALS('first-fit：選編號最前面的、夠長的空閒區段', '全部檔案處理完之後，輸出外部碎片：空閒區塊總數減去最長一段連續空閒區塊的長度。'), ref: ALR('first', 0, 'print(bits.count(0) - max([m.end() - m.start() for m in re.finditer("0+", "".join(map(str, bits)))] or [0]))'), gen: alGen },
    { id: 'al-largest', want: 'fs.alloc-strategy', st: ALS('worst-fit：選最長的空閒區段，同樣長取起點最小的', '全部檔案處理完之後，輸出最長一段連續空閒區塊的長度。'), ref: ALR('worst', 0, 'print(max([m.end() - m.start() for m in re.finditer("0+", "".join(map(str, bits)))] or [0]))'), gen: alGen },
    { id: 'if-per', want: 'fs.internal-frag', st: IFS('輸出每個檔案的內部碎片（浪費的位元組數），一行一個。'), ref: IFR('print(-s % b)'), gen: ifGen },
    { id: 'if-sum', want: 'fs.internal-frag', st: IFS('輸出所有檔案內部碎片的總和。'), ref: IFR('tot += -s % b', true), gen: ifGen },
    { id: 'if-max', want: 'fs.internal-frag', st: IFS('輸出浪費最多的那個檔案的內部碎片大小。'), ref: IFR('tot = max(tot, -s % b)', true), gen: ifGen },
    { id: 'if-cnt', want: 'fs.internal-frag', st: IFS('輸出有幾個檔案有內部碎片（大小不是區塊大小的整數倍）。'), ref: IFR('tot += 1 if s % b else 0', true), gen: ifGen },
    // ── holdout（第二批，我自己寫的另一種措辭；寫完骨架才出，不是冷啟動；只量測）──
    { id: 'ho-pn', split: 'holdout', st: '第一行 q，接著 q 行，每行一條以 / 開頭的檔案路徑，裡面可能夾雜 ./、../ 以及重複的斜線。請把每條路徑化簡成最短的等價寫法再輸出（到根目錄為止，不能再往上）。', ref: PNR('print(n)'), gen: pnGen(true) },
    { id: 'ho-dr', split: 'holdout', st: '第一行 q，之後 q 行指令：mkdir 路徑 會把整條路徑（包含缺少的上層）建出來，cd 路徑 會進入該目錄（路徑可相對可絕對，可含 . 與 ..），pwd 會印出現在所在的目錄。剛開始只有根目錄 /，人在 /。如果 cd 的目的地不存在，人留在原地。請輸出每一次 pwd 印出的內容。', ref: DRR('pwd', false, 'parents'), gen: drGen },
    { id: 'ho-al', split: 'holdout', st: '第一行 N q，第二行 N 個整數描述磁碟，0 代表那個區塊還空著，1 代表已被占用。接著 q 行每行一個整數 k，是一個新檔案需要的連續區塊數。每個檔案採 best-fit 配置：在所有長度不小於 k 的連續空區塊中挑最短的一段（長度一樣挑起點較小的），從該段開頭開始佔用。請依序輸出每個檔案的起點（從 0 算起），放不下輸出 -1。', ref: ALR('best', 0, 'print(*res)'), gen: alGen },
    { id: 'ho-if', split: 'holdout', st: '第一行 b q，之後 q 行每行一個整數 s，為檔案長度。檔案系統一律以大小 b 的叢集為配置單位，最後一個叢集通常用不滿。請輸出所有檔案白白浪費的空間總和。', ref: IFR('tot += -s % b', true), gen: ifGen },
    // ── 第二輪 holdout（ho2）：補完詞彙後另出的新措辭（同一個人寫，不算冷啟動）──
    { id: 'ho2-pn', split: 'holdout', st: '第一行 q，接著 q 行，每行一條路徑字串，開頭是 /，中間可能出現 .、.. 與連續的 /。請輸出每條路徑經過正規化（canonical form）之後的結果。', ref: PNR('print(n)'), gen: pnGen(true) },
    { id: 'ho2-al', split: 'holdout', st: '第一行 N q，第二行 N 個整數，0 為空閒區塊、1 為已使用區塊。接著 q 行，每行一個整數 k，代表一個檔案需要連續 k 個區塊。依序為每個檔案採用 first-fit（取最前面、足夠長的一段空閒區塊）配置，輸出各檔案的起始區塊編號（從 0 起），配置失敗輸出 -1。', ref: ALR('first', 0, 'print(*res)'), gen: alGen },
];
H.main({ name: '領域包 fs', packs: [FS], seeds: SEEDS, minSkeletons: 8 });
