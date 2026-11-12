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
H.main({ name: '領域包 sync', packs: [SY], seeds: H.loadSeeds(require('path').join(__dirname, 'seeds', 'domain_sync.json')), minSkeletons: 4 });
