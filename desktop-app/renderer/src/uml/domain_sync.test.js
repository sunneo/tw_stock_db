'use strict';
// 領域包「作業系統：同步原語事件模擬」：train＝教過的措辭（原敘述＋改寫＋選項反序）；holdout＝另寫措辭與政策，只量測、不教。參考解獨立手寫。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const SY = require('./domain_sync_core.js');
const ev = (q, ops) => Array.from({ length: q }, () => ops()).join('\n');
const semGen = (b) => { const q = rnd(2, b ? 24 : 10); return rnd(0, 3) + ' ' + q + '\n' + ev(q, () => pick(['wait', 'signal']) + ' ' + rnd(1, 6)) + '\n'; };
const SEM = (wake, out) => 's, q = map(int, input().split())\nW = []\ng = []\nfor _ in range(q):\n    a, b = input().split()\n    if a == "wait":\n        if s > 0:\n            s -= 1\n            g.append(b)\n        else:\n            W.append(b)\n    else:\n        if W:\n            g.append(W.pop(' + (wake ? '0' : '-1') + '))\n        else:\n            s += 1\n' + out;
const mxGen = (b) => { const q = rnd(2, b ? 24 : 10); return q + '\n' + ev(q, () => pick(['lock', 'lock', 'unlock']) + ' ' + rnd(1, 4)) + '\n'; };
const MX = (wake, out) => 'q = int(input())\no = None\nW = []\ng = []\nbl = 0\nbad = 0\nfor _ in range(q):\n    a, t = input().split()\n    if a == "lock":\n        if o is None:\n            o = t\n            g.append(t)\n        else:\n            bl += 1\n            W.append(t)\n    elif o != t:\n        bad += 1\n    elif W:\n        o = W.pop(' + (wake ? '0' : '-1') + ')\n        g.append(o)\n    else:\n        o = None\n' + out;
const cvGen = (b) => { const q = rnd(2, b ? 24 : 10); return q + '\n' + ev(q, () => pick(['wait', 'wait', 'signal', 'broadcast']) + ' ' + rnd(1, 6)).replace(/^(signal|broadcast) \d+$/gm, '$1') + '\n'; };
const CV = (out) => 'q = int(input())\nW = []\nwk = []\nlost = 0\nfor _ in range(q):\n    p = input().split()\n    if p[0] == "wait":\n        W.append(p[1])\n    elif p[0] == "signal":\n        if W:\n            wk.append(W.pop(0))\n        else:\n            lost += 1\n    else:\n        if W:\n            wk += W\n            W = []\n        else:\n            lost += 1\n' + out;
const pcGen = (b) => { const q = rnd(2, b ? 24 : 10); return rnd(1, 3) + ' ' + q + '\n' + ev(q, () => pick(['produce', 'produce', 'consume'])).replace(/^produce$/gm, () => 'produce ' + rnd(10, 99)) + '\n'; };
const PC = (out) => 'cap, q = map(int, input().split())\nbuf = []\npend = []\ncw = 0\ntk = []\nfor _ in range(q):\n    p = input().split()\n    if p[0] == "produce":\n        if cw:\n            cw -= 1\n            tk.append(p[1])\n        elif len(buf) < cap:\n            buf.append(p[1])\n        else:\n            pend.append(p[1])\n    elif buf:\n        tk.append(buf.pop(0))\n        if pend:\n            buf.append(pend.pop(0))\n    else:\n        cw += 1\n' + out;
const rw = (s) => s.replace(/\bq\b/g, 'm');
const SEEDS = [
    { id: 'sem-order', want: 'sync.semaphore', st: '第一行 s q，之後 q 行事件：wait p 或 signal p（p 是行程編號）。計數信號量初值為 s：wait 時若值大於 0 就減一並通過，否則該行程排進等待佇列阻塞；signal 時若有人在等就喚醒最早等的那個（直接讓它通過，值不變），沒有人等才把值加一。輸出所有通過的行程編號，依通過的順序以空白隔開。', rw, ref: SEM(true, 'print(*g)'), gen: semGen },
    { id: 'sem-blocked', want: 'sync.semaphore', st: '第一行 s q，之後 q 行事件：wait p 或 signal p。信號量初值為 s：wait 在值為正時減一通過，否則進入等待佇列；signal 在有等待者時喚醒最早的一個，否則值加一。輸出全部事件處理完後還在等待的行程數。', rw, ref: SEM(true, 'print(len(W))'), gen: semGen },
    { id: 'sem-neg', want: 'sync.semaphore', st: '第一行 s q，之後 q 行事件：wait p 或 signal p。信號量值如 Dijkstra 的定義可以為負：值為負數時絕對值就是等待中的行程數。wait 最早等待的先被喚醒。輸出最後的信號量值。', rw, ref: 's, q = map(int, input().split())\nW = 0\nfor _ in range(q):\n    a, b = input().split()\n    s += -1 if a == "wait" else 1\nprint(s)', gen: semGen },
    { id: 'mx-order', want: 'sync.mutex', st: '第一行 q，之後 q 行事件：lock t 或 unlock t（t 是執行緒編號）。互斥鎖一開始沒人持有：lock 時若沒人持有就取得，否則該執行緒排進等待佇列；unlock 只有持有者才有效，有人在等就把鎖直接交給最早等的那個，否則鎖變成沒人持有；不是持有者的 unlock 忽略。輸出每次取得鎖的執行緒編號，依取得順序以空白隔開。', rw, ref: MX(true, 'print(*g)'), gen: mxGen },
    { id: 'mx-bad', want: 'sync.mutex', st: '第一行 q，之後 q 行事件：lock t 或 unlock t。互斥鎖一開始沒人持有：lock 時被占用就排隊阻塞，unlock 時若有人排隊就交棒給最早的那個。若 unlock 的人不是目前持有者（含鎖空著），算一次非法解鎖，不改變狀態。輸出非法解鎖的總次數。', rw, ref: MX(true, 'print(bad)'), gen: mxGen },
    { id: 'cv-woken', want: 'sync.condvar', st: '第一行 q，之後 q 行事件：wait t、signal、broadcast。條件變數：wait t 讓執行緒 t 睡眠排隊；signal 喚醒最早睡眠的一個；broadcast 喚醒全部（依睡眠先後）；沒人在睡時 signal 和 broadcast 沒有效果。輸出被喚醒的執行緒編號，依喚醒順序以空白隔開。', rw, ref: CV('print(*wk)'), gen: cvGen },
    { id: 'cv-lost', want: 'sync.condvar', st: '第一行 q，之後 q 行事件：wait t、signal、broadcast。條件變數沒有記憶：signal 或 broadcast 發生時若沒有任何執行緒在等，這次通知就白費了。signal 喚醒最早等的一個，broadcast 全部喚醒。輸出白費的通知次數。', rw, ref: CV('print(lost)'), gen: cvGen },
    { id: 'pc-taken', want: 'sync.prodcons', st: '第一行 cap q，之後 q 行事件：produce x 或 consume。生產者消費者問題：有限緩衝區容量為 cap（先進先出）。produce 時若有消費者在等就直接交給它，否則緩衝區有空位就放入，滿了就阻塞（等有空位時依序進入）；consume 時緩衝區有貨就取走最舊的（並讓阻塞的生產者進入一個），空了就阻塞等候。輸出被取走的物品，依取走順序以空白隔開。', rw, ref: PC('print(*tk)'), gen: pcGen },
    { id: 'ho-sem-lifo', split: 'holdout', st: '第一行 s q，接著 q 行操作：wait x 或 signal x。這是一個計數信號量，初始值 s。wait 發現值是 0 時，該行程就被擋下來排隊；signal 若有被擋的行程，會放行最後擋下的那個（後進先出），沒有就把值加一。輸出最終值。', ref: SEM(false, 'print(s)'), gen: semGen },
    { id: 'ho-mx-owner', split: 'holdout', st: '第一行 q，接著 q 行：lock t 或 unlock t。一把互斥鎖，起初沒有主人。lock 遇到有主人就排在後面等；unlock 由主人執行時，若有人排隊就把鎖交給排最前面的，否則空出來；非主人的 unlock 無效。全部做完後輸出鎖的主人編號，沒有主人輸出 none。', ref: MX(true, 'print(o if o is not None else "none")'), gen: mxGen },
    { id: 'ho-cv-waiting', split: 'holdout', st: '第一行 q，接著 q 行：wait t、signal、broadcast。條件變數：wait 的人睡著排隊，signal 叫醒最早睡的一人，broadcast 叫醒所有人。輸出最後仍然睡著的人數。', ref: CV('print(len(W))'), gen: cvGen },
    { id: 'ho-pc-size', split: 'holdout', st: '第一行 cap q，接著 q 行：produce x 或 consume。有限緩衝區（容量 cap）生產者消費者，先進先出；緩衝區滿時生產者要等，空時消費者要等，等的人在條件滿足時依序完成。處理完所有事件後，輸出緩衝區裡剩下幾個物品。', ref: PC('print(len(buf))'), gen: pcGen },
];
H.main({ name: '領域包 sync', packs: [SY], seeds: SEEDS, minSkeletons: 4 });
