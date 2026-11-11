/* 矩陣層 L5／L6：清單草圖（list sketch）。純函式 UMD，不問模型。設計：DESIGN.matrix-fallback.md §3「L5／L6 骨架優先，槽位窮舉；通用枚舉不承諾」。
 *
 * 輸入形狀（從範例推，不靠讀取器）：「n」＋一行 n 個整數；「n k」或「k n」＋一行 n 個整數；「n」＋清單＋「m」＋清單；單行括號字串。
 * 骨架（每個只有幾個洞，候選數固定，保證會停）：
 *   pipeline   前處理（排序／反序／去重／偶奇篩選／平方／前綴和／前綴最大最小／相鄰差／旋轉 k／取前後 k 個）→ 歸約（和／最大／最小／個數／相異數／第二大不同值／中位數／平均以上個數／第 k 小大／前 k 大和／原清單）
 *   pairs      對 (i<j) 的關係（> < = ≠ 和等於 k 和≤k 差等於 k 整除…）→ 個數／是否存在
 *   segments   連續段：最大和／最小和／和為 k 的段數／最長相同／最長遞增／最長和≤k
 *   window     長度 k 的視窗：和／最大／最小 的清單，或其中最大的
 *   adjacent   相鄰關係計數：山峰／山谷／上升／下降／相等
 *   multiset   眾數（平手取小或取大）／眾數次數／只出現一次的個數／重複的個數
 *   two-lists  合併排序／交集／聯集／差集／交集個數／內積／是否相同
 *   stack      右邊第一個更大／更小（值或距離，沒有給 -1 或 0）、左邊第一個更大、股價跨度
 *   brackets   括號字串：是否合法（1～3 種括號）／最大深度／配對數／最少補幾個
 * 每個候選有 JS 版（驗證範例用）與 Python 版（輸出）；測試要求兩版在隨機輸入上一致。
 * 標籤、排序與歧義的處理同 matrix_sketch_core：敘述關鍵字命中者先；探測輸入上輸出不同的多個候選＝ambiguous＋suggest。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMatrixList = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const isInt = (s) => /^-?\d+$/.test(s);
    const ints = (l) => { const t = String(l).trim(); if (!t) return []; const p = t.split(/\s+/); return p.every(isInt) ? p.map(Number) : null; };
    const asc = (x) => x.slice().sort((p, q) => p - q);
    const uniqSorted = (x) => asc([...new Set(x)]);
    const uniqKeep = (x) => { const s = new Set(); return x.filter((v) => (s.has(v) ? false : (s.add(v), true))); };
    const maxOf = (x) => (x.length ? Math.max(...x) : null), minOf = (x) => (x.length ? Math.min(...x) : null);
    // ---- 前處理 ----
    const PRE = [
        { id: 'id', js: (a) => a.slice(), py: [], cost: 0 },
        { id: 'sort', js: asc, py: ['a = sorted(a)'], kw: /排序|由小到大|遞增|sort/i, cost: 1 },
        { id: 'sort-desc', js: (a) => asc(a).reverse(), py: ['a = sorted(a, reverse=True)'], kw: /由大到小|遞減|降序/, cost: 1 },
        { id: 'reverse', js: (a) => a.slice().reverse(), py: ['a = a[::-1]'], kw: /反轉|倒過來|反序|顛倒/, cost: 1 },
        { id: 'uniq-sorted', js: uniqSorted, py: ['a = sorted(set(a))'], kw: /不同|相異|去重|distinct/i, cost: 2 },
        { id: 'dedup-keep', js: uniqKeep, py: ['seen = set()', 'a = [x for x in a if not (x in seen or seen.add(x))]'], kw: /去掉重複|去重|保留.*順序|第一次出現/, cost: 2 },
        { id: 'even', js: (a) => a.filter((x) => x % 2 === 0), py: ['a = [x for x in a if x % 2 == 0]'], kw: /偶數/, cost: 2 },
        { id: 'odd', js: (a) => a.filter((x) => Math.abs(x % 2) === 1), py: ['a = [x for x in a if x % 2 != 0]'], kw: /奇數/, cost: 2 },
        { id: 'positive', js: (a) => a.filter((x) => x > 0), py: ['a = [x for x in a if x > 0]'], kw: /正數|大於\s*0/, cost: 2 },
        { id: 'square', js: (a) => a.map((x) => x * x), py: ['a = [x * x for x in a]'], kw: /平方/, cost: 2 },
        { id: 'abs', js: (a) => a.map(Math.abs), py: ['a = [abs(x) for x in a]'], kw: /絕對值/, cost: 2 },
        { id: 'prefix-sum', js: (a) => { let s = 0; return a.map((x) => (s += x)); }, py: ['s = 0', 'b2 = []', 'for x in a:', '    s += x', '    b2.append(s)', 'a = b2'], kw: /前綴和|累加|prefix/i, cost: 2 },
        { id: 'prefix-max', js: (a) => { let m = -Infinity; return a.map((x) => (m = Math.max(m, x))); }, py: ['m = a[0]', 'b2 = []', 'for x in a:', '    m = max(m, x)', '    b2.append(m)', 'a = b2'], kw: /前綴.*最大|到目前為止.*最大|前\s*i\s*個.*最大/, cost: 2 },
        { id: 'prefix-min', js: (a) => { let m = Infinity; return a.map((x) => (m = Math.min(m, x))); }, py: ['m = a[0]', 'b2 = []', 'for x in a:', '    m = min(m, x)', '    b2.append(m)', 'a = b2'], kw: /前綴.*最小|到目前為止.*最小/, cost: 2 },
        { id: 'diff', js: (a) => a.slice(1).map((x, i) => x - a[i]), py: ['a = [a[i] - a[i - 1] for i in range(1, len(a))]'], kw: /相鄰.*差|差分/, cost: 2 },
        { id: 'rot-right', js: (a, k) => { if (!a.length) return a; const r = ((k % a.length) + a.length) % a.length; return r ? a.slice(-r).concat(a.slice(0, -r)) : a.slice(); }, py: ['r = k % len(a)', 'a = a[-r:] + a[:-r] if r else a'], needK: true, kw: /向右|右旋|右移/, cost: 2 },
        { id: 'rot-left', js: (a, k) => { if (!a.length) return a; const r = ((k % a.length) + a.length) % a.length; return a.slice(r).concat(a.slice(0, r)); }, py: ['r = k % len(a)', 'a = a[r:] + a[:r]'], needK: true, kw: /向左|左旋|左移/, cost: 2 },
        { id: 'head-k', js: (a, k) => a.slice(0, k), py: ['a = a[:k]'], needK: true, kw: /前\s*k/, cost: 2 },
        { id: 'tail-k', js: (a, k) => (k > 0 ? a.slice(-k) : []), py: ['a = a[-k:] if k > 0 else []'], needK: true, kw: /後\s*k|最後\s*k/, cost: 2 },
        { id: 'drop-k', js: (a, k) => a.slice(k), py: ['a = a[k:]'], needK: true, kw: /去掉.*前\s*k|刪掉.*前\s*k/, cost: 2 },
    ];
    // ---- 歸約（後處理）----
    const POST = [
        { id: 'list', out: 'list', js: (a) => a, py: 'a', kw: /^$/, cost: 0 },
        { id: 'sum', out: 'int', js: (a) => a.reduce((x, y) => x + y, 0), py: 'sum(a)', kw: /總和|和|加總|sum/i, cost: 1 },
        { id: 'max', out: 'int', js: maxOf, py: 'max(a)', kw: /最大|max/i, cost: 1 }, { id: 'min', out: 'int', js: minOf, py: 'min(a)', kw: /最小|min/i, cost: 1 },
        { id: 'len', out: 'int', js: (a) => a.length, py: 'len(a)', kw: /個數|幾個|長度|有多少/, cost: 1 },
        { id: 'distinct', out: 'int', js: (a) => new Set(a).size, py: 'len(set(a))', kw: /不同|相異|distinct/i, cost: 2 },
        { id: 'first', out: 'int', js: (a) => (a.length ? a[0] : null), py: 'a[0]', kw: /第一個|首個/, cost: 2 }, { id: 'last', out: 'int', js: (a) => (a.length ? a[a.length - 1] : null), py: 'a[-1]', kw: /最後一個/, cost: 2 },
        { id: 'range', out: 'int', js: (a) => (a.length ? maxOf(a) - minOf(a) : null), py: 'max(a) - min(a)', kw: /最大.*最小.*差|極差|範圍/, cost: 2 },
        { id: 'second-max', out: 'int', js: (a) => { const u = uniqSorted(a); return u.length >= 2 ? u[u.length - 2] : null; }, py: 'sorted(set(a))[-2]', kw: /第二大/, cost: 3 },
        { id: 'second-min', out: 'int', js: (a) => { const u = uniqSorted(a); return u.length >= 2 ? u[1] : null; }, py: 'sorted(set(a))[1]', kw: /第二小/, cost: 3 },
        { id: 'median', out: 'int', js: (a) => (a.length ? asc(a)[Math.floor(a.length / 2)] : null), py: 'sorted(a)[len(a) // 2]', kw: /中位數|正中間/, cost: 2 },
        { id: 'median-low', out: 'int', js: (a) => (a.length ? asc(a)[Math.floor((a.length - 1) / 2)] : null), py: 'sorted(a)[(len(a) - 1) // 2]', kw: /中位數/, cost: 3 },
        { id: 'above-avg', out: 'int', js: (a) => { if (!a.length) return null; const s = a.reduce((x, y) => x + y, 0); return a.filter((x) => x * a.length > s).length; }, py: 'sum(1 for x in a if x * len(a) > sum(a))', kw: /平均/, cost: 3 },
        { id: 'below-avg', out: 'int', js: (a) => { if (!a.length) return null; const s = a.reduce((x, y) => x + y, 0); return a.filter((x) => x * a.length < s).length; }, py: 'sum(1 for x in a if x * len(a) < sum(a))', kw: /平均/, cost: 3 },
        { id: 'count-gt-k', out: 'int', js: (a, k) => a.filter((x) => x > k).length, py: 'sum(1 for x in a if x > k)', needK: true, kw: /大於\s*k/, cost: 3 },
        { id: 'count-eq-k', out: 'int', js: (a, k) => a.filter((x) => x === k).length, py: 'a.count(k)', needK: true, kw: /等於\s*k|出現.*k/, cost: 3 },
        { id: 'kth-small', out: 'int', js: (a, k) => (k >= 1 && k <= a.length ? asc(a)[k - 1] : null), py: 'sorted(a)[k - 1]', needK: true, kw: /第\s*k\s*小/, cost: 3 },
        { id: 'kth-large', out: 'int', js: (a, k) => (k >= 1 && k <= a.length ? asc(a)[a.length - k] : null), py: 'sorted(a)[-k]', needK: true, kw: /第\s*k\s*大/, cost: 3 },
        { id: 'top-k-sum', out: 'int', js: (a, k) => asc(a).slice(Math.max(0, a.length - k)).reduce((x, y) => x + y, 0), py: 'sum(sorted(a)[-k:]) if k > 0 else 0', needK: true, kw: /前\s*k\s*大.*和/, cost: 3 },
        { id: 'sorted-asc?', out: 'bool', js: (a) => a.every((x, i) => i === 0 || a[i - 1] <= x), py: 'all(a[i - 1] <= a[i] for i in range(1, len(a)))', kw: /遞增|已排序|由小到大/, cost: 3 },
        { id: 'has-dup?', out: 'bool', js: (a) => new Set(a).size < a.length, py: 'len(set(a)) < len(a)', kw: /重複/, cost: 3 },
        { id: 'has-k?', out: 'bool', js: (a, k) => a.includes(k), py: 'k in a', needK: true, kw: /是否.*k|有沒有.*k|包含/, cost: 3 },
    ];
    const cands = [];
    for (const pre of PRE) for (const post of POST) {
        if (pre.id === 'id' && post.id === 'list') continue; if ((post.id === 'list') && pre.id === 'id') continue;
        cands.push({ fam: 'pipeline', id: pre.id + '→' + post.id, kw: [pre.kw, post.kw].filter(Boolean), cost: 1 + (pre.cost || 0) + (post.cost || 0), needK: !!(pre.needK || post.needK), out: post.out,
            f: (e) => { const a = pre.js(e.a, e.k); if (post.id !== 'list' && !a.length && !['sum', 'len', 'distinct', 'count-gt-k', 'count-eq-k', 'above-avg', 'below-avg', 'has-dup?', 'has-k?', 'sorted-asc?', 'top-k-sum'].includes(post.id)) return null; return post.js(a, e.k); }, py: pre.py.concat(['r = ' + post.py]) });
    }
    // ---- pairs ----
    const REL = [['gt', (x, y) => x > y, 'a[i] > a[j]', /逆序|大於/], ['lt', (x, y) => x < y, 'a[i] < a[j]', /小於/], ['eq', (x, y) => x === y, 'a[i] == a[j]', /相同|相等|重複/], ['ne', (x, y) => x !== y, 'a[i] != a[j]', /不同/],
        ['sum-k', (x, y, k) => x + y === k, 'a[i] + a[j] == k', /和.*等於\s*k|和為\s*k|加起來.*k/], ['sum-le-k', (x, y, k) => x + y <= k, 'a[i] + a[j] <= k', /不超過\s*k|至多\s*k|小於等於\s*k/], ['sum-ge-k', (x, y, k) => x + y >= k, 'a[i] + a[j] >= k', /至少\s*k|大於等於\s*k/], ['diff-k', (x, y, k) => Math.abs(x - y) === k, 'abs(a[i] - a[j]) == k', /差.*等於\s*k|差為\s*k/],
        ['diff-le-k', (x, y, k) => Math.abs(x - y) <= k, 'abs(a[i] - a[j]) <= k', /差.*不超過\s*k/], ['sum-even', (x, y) => (x + y) % 2 === 0, '(a[i] + a[j]) % 2 == 0', /和.*偶數/], ['divides', (x, y) => y !== 0 && x % y === 0, 'a[j] != 0 and a[i] % a[j] == 0', /整除|倍數/], ['sum-gt-third', (x, y, k) => x + y > k, 'a[i] + a[j] > k', /大於\s*k/]];
    for (const [rid, rf, rp, kw] of REL) for (const o of ['count', 'exists']) cands.push({ fam: 'pairs', id: '配對/' + rid + '/' + o, kw: [kw], cost: 4 + (o === 'exists' ? 1 : 0), needK: /k/.test(rp), out: o === 'count' ? 'int' : 'bool', f: (e) => { let c = 0; for (let i = 0; i < e.a.length; i++) for (let j = i + 1; j < e.a.length; j++) if (rf(e.a[i], e.a[j], e.k)) c++; return o === 'count' ? c : c > 0; }, py: ['c = sum(1 for i in range(len(a)) for j in range(i + 1, len(a)) if ' + rp + ')', o === 'count' ? 'r = c' : 'r = c > 0'] });
    // ---- segments ----
    const SEGS = [
        ['max-sum', 'int', (a) => { if (!a.length) return null; let best = a[0], cur = a[0]; for (let i = 1; i < a.length; i++) { cur = Math.max(a[i], cur + a[i]); best = Math.max(best, cur); } return best; }, ['best = cur = a[0]', 'for x in a[1:]:', '    cur = max(x, cur + x)', '    best = max(best, cur)', 'r = best'], /連續.*和.*最大|最大.*連續|子陣列.*最大/],
        ['min-sum', 'int', (a) => { if (!a.length) return null; let best = a[0], cur = a[0]; for (let i = 1; i < a.length; i++) { cur = Math.min(a[i], cur + a[i]); best = Math.min(best, cur); } return best; }, ['best = cur = a[0]', 'for x in a[1:]:', '    cur = min(x, cur + x)', '    best = min(best, cur)', 'r = best'], /連續.*和.*最小|子陣列.*最小/],
        ['count-sum-k', 'int', (a, k) => { let c = 0; for (let i = 0; i < a.length; i++) { let s = 0; for (let j = i; j < a.length; j++) { s += a[j]; if (s === k) c++; } } return c; }, ['r = 0', 'for i in range(len(a)):', '    s = 0', '    for j in range(i, len(a)):', '        s += a[j]', '        if s == k:', '            r += 1'], /連續.*和.*(剛好)?等於\s*k|和為\s*k.*段/, true],
        ['longest-equal', 'int', (a) => { if (!a.length) return null; let b = 1, c = 1; for (let i = 1; i < a.length; i++) { c = a[i] === a[i - 1] ? c + 1 : 1; b = Math.max(b, c); } return b; }, ['best = cur = 1', 'for i in range(1, len(a)):', '    cur = cur + 1 if a[i] == a[i - 1] else 1', '    best = max(best, cur)', 'r = best'], /連續相同|連續.*一樣/],
        ['longest-inc', 'int', (a) => { if (!a.length) return null; let b = 1, c = 1; for (let i = 1; i < a.length; i++) { c = a[i] > a[i - 1] ? c + 1 : 1; b = Math.max(b, c); } return b; }, ['best = cur = 1', 'for i in range(1, len(a)):', '    cur = cur + 1 if a[i] > a[i - 1] else 1', '    best = max(best, cur)', 'r = best'], /連續.*遞增|連續.*上升/],
        ['longest-noninc', 'int', (a) => { if (!a.length) return null; let b = 1, c = 1; for (let i = 1; i < a.length; i++) { c = a[i] <= a[i - 1] ? c + 1 : 1; b = Math.max(b, c); } return b; }, ['best = cur = 1', 'for i in range(1, len(a)):', '    cur = cur + 1 if a[i] <= a[i - 1] else 1', '    best = max(best, cur)', 'r = best'], /連續.*不增|連續.*遞減/],
        ['longest-sum-le-k', 'int', (a, k) => { let best = 0; for (let i = 0; i < a.length; i++) { let s = 0; for (let j = i; j < a.length; j++) { s += a[j]; if (s <= k) best = Math.max(best, j - i + 1); } } return best; }, ['r = 0', 'for i in range(len(a)):', '    s = 0', '    for j in range(i, len(a)):', '        s += a[j]', '        if s <= k:', '            r = max(r, j - i + 1)'], /最長.*和.*(不超過|至多)\s*k/, true],
    ];
    for (const [sid, out, sf, spy, kw, nk] of SEGS) cands.push({ fam: 'segments', id: '連續段/' + sid, kw: [kw], cost: 4, needK: !!nk, out, f: (e) => sf(e.a, e.k), py: spy });
    // ---- window（需要 k）----
    const WIN = [['sum', (w) => w.reduce((x, y) => x + y, 0), 'sum(w)'], ['max', (w) => Math.max(...w), 'max(w)'], ['min', (w) => Math.min(...w), 'min(w)']];
    for (const [wid, wf, wp] of WIN) { cands.push({ fam: 'window', id: '視窗/' + wid + '/清單', kw: [/視窗|連續\s*k|長度為\s*k/], cost: 4, needK: true, out: 'list', f: (e) => (e.k >= 1 && e.k <= e.a.length ? Array.from({ length: e.a.length - e.k + 1 }, (_, i) => wf(e.a.slice(i, i + e.k))) : null), py: ['r = [' + wp + ' for w in (a[i:i + k] for i in range(len(a) - k + 1))]'] });
        cands.push({ fam: 'window', id: '視窗/' + wid + '/最大', kw: [/視窗|連續\s*k|長度為\s*k/], cost: 5, needK: true, out: 'int', f: (e) => (e.k >= 1 && e.k <= e.a.length ? Math.max(...Array.from({ length: e.a.length - e.k + 1 }, (_, i) => wf(e.a.slice(i, i + e.k)))) : null), py: ['r = max(' + wp + ' for w in (a[i:i + k] for i in range(len(a) - k + 1)))'] }); }
    // ---- adjacent 計數 ----
    const ADJ = [['peaks', (a, i) => i > 0 && i < a.length - 1 && a[i] > a[i - 1] && a[i] > a[i + 1], 'range(1, len(a) - 1)', 'a[i] > a[i - 1] and a[i] > a[i + 1]', /山峰|峰/], ['valleys', (a, i) => i > 0 && i < a.length - 1 && a[i] < a[i - 1] && a[i] < a[i + 1], 'range(1, len(a) - 1)', 'a[i] < a[i - 1] and a[i] < a[i + 1]', /山谷|谷/],
        ['ascents', (a, i) => i > 0 && a[i] > a[i - 1], 'range(1, len(a))', 'a[i] > a[i - 1]', /上升|變大/], ['descents', (a, i) => i > 0 && a[i] < a[i - 1], 'range(1, len(a))', 'a[i] < a[i - 1]', /下降|變小/], ['equal-adj', (a, i) => i > 0 && a[i] === a[i - 1], 'range(1, len(a))', 'a[i] == a[i - 1]', /相鄰.*相同|相鄰.*相等/]];
    for (const [aid, af, rng, cond, kw] of ADJ) cands.push({ fam: 'adjacent', id: '相鄰/' + aid, kw: [kw], cost: 4, needK: false, out: 'int', f: (e) => { let c = 0; for (let i = 0; i < e.a.length; i++) if (af(e.a, i)) c++; return c; }, py: ['r = sum(1 for i in ' + rng + ' if ' + cond + ')'] });
    // ---- multiset ----
    const freq = (a) => { const m = new Map(); for (const x of a) m.set(x, (m.get(x) || 0) + 1); return m; };
    cands.push({ fam: 'multiset', id: '眾數/平手取小', kw: [/眾數|出現次數最多/], cost: 3, out: 'int', needK: false, f: (e) => { if (!e.a.length) return null; const m = freq(e.a); const mx = Math.max(...m.values()); return Math.min(...[...m].filter(([, v]) => v === mx).map(([x]) => x)); }, py: ['from collections import Counter', 'c = Counter(a)', 'mx = max(c.values())', 'r = min(x for x in c if c[x] == mx)'] });
    cands.push({ fam: 'multiset', id: '眾數/平手取大', kw: [/眾數|出現次數最多/], cost: 4, out: 'int', needK: false, f: (e) => { if (!e.a.length) return null; const m = freq(e.a); const mx = Math.max(...m.values()); return Math.max(...[...m].filter(([, v]) => v === mx).map(([x]) => x)); }, py: ['from collections import Counter', 'c = Counter(a)', 'mx = max(c.values())', 'r = max(x for x in c if c[x] == mx)'] });
    cands.push({ fam: 'multiset', id: '眾數/次數', kw: [/眾數.*次數|最多.*幾次/], cost: 3, out: 'int', needK: false, f: (e) => (e.a.length ? Math.max(...freq(e.a).values()) : null), py: ['from collections import Counter', 'r = max(Counter(a).values())'] });
    cands.push({ fam: 'multiset', id: '只出現一次的個數', kw: [/只出現一次|恰好一次|唯一/], cost: 3, out: 'int', needK: false, f: (e) => [...freq(e.a).values()].filter((v) => v === 1).length, py: ['from collections import Counter', 'r = sum(1 for v in Counter(a).values() if v == 1)'] });
    cands.push({ fam: 'multiset', id: '重複的值個數', kw: [/重複/], cost: 3, out: 'int', needK: false, f: (e) => [...freq(e.a).values()].filter((v) => v > 1).length, py: ['from collections import Counter', 'r = sum(1 for v in Counter(a).values() if v > 1)'] });
    cands.push({ fam: 'multiset', id: '多餘的重複個數', kw: [/重複/], cost: 4, out: 'int', needK: false, f: (e) => e.a.length - new Set(e.a).size, py: ['r = len(a) - len(set(a))'] });
    // ---- two lists ----
    const TWO = [['merge', 'list', (a, b) => asc(a.concat(b)), 'r = sorted(a + b)', /合併/], ['intersect', 'list', (a, b) => uniqSorted(a.filter((x) => b.includes(x))), 'r = sorted(set(a) & set(b))', /交集|共同/], ['union', 'list', (a, b) => uniqSorted(a.concat(b)), 'r = sorted(set(a) | set(b))', /聯集|所有出現/], ['diff', 'list', (a, b) => uniqSorted(a.filter((x) => !b.includes(x))), 'r = sorted(set(a) - set(b))', /差集|只在第一/],
        ['sym-diff', 'list', (a, b) => uniqSorted(a.filter((x) => !b.includes(x)).concat(b.filter((x) => !a.includes(x)))), 'r = sorted(set(a) ^ set(b))', /只出現在其中一個/], ['common-count', 'int', (a, b) => uniqSorted(a.filter((x) => b.includes(x))).length, 'r = len(set(a) & set(b))', /共同.*(個數|幾個)|交集.*個數/], ['dot', 'int', (a, b) => (a.length === b.length ? a.reduce((s, x, i) => s + x * b[i], 0) : null), 'r = sum(x * y for x, y in zip(a, b))', /內積/], ['same?', 'bool', (a, b) => a.length === b.length && a.every((x, i) => x === b[i]), 'r = a == b', /相同|一樣/],
        ['merge-len', 'int', (a, b) => a.length + b.length, 'r = len(a) + len(b)', /總共/], ['sum-all', 'int', (a, b) => a.concat(b).reduce((x, y) => x + y, 0), 'r = sum(a) + sum(b)', /總和/], ['max-all', 'int', (a, b) => Math.max(...a.concat(b)), 'r = max(a + b)', /最大/]];
    for (const [tid, out, tf, tp, kw] of TWO) cands.push({ fam: 'two-lists', id: '兩清單/' + tid, kw: [kw], cost: 3, two: true, needK: false, out, f: (e) => tf(e.a, e.b), py: [tp] });
    // ---- stack ----
    const STK = [
        ['next-greater-val', (a) => a.map((x, i) => { for (let j = i + 1; j < a.length; j++) if (a[j] > x) return a[j]; return -1; }), 'r = []\nfor i in range(len(a)):\n    v = -1\n    for j in range(i + 1, len(a)):\n        if a[j] > a[i]:\n            v = a[j]\n            break\n    r.append(v)', /右邊.*第一個.*(更)?大|下一個更大/],
        ['next-smaller-val', (a) => a.map((x, i) => { for (let j = i + 1; j < a.length; j++) if (a[j] < x) return a[j]; return -1; }), 'r = []\nfor i in range(len(a)):\n    v = -1\n    for j in range(i + 1, len(a)):\n        if a[j] < a[i]:\n            v = a[j]\n            break\n    r.append(v)', /右邊.*第一個.*(更)?小|下一個更小/],
        ['next-greater-dist', (a) => a.map((x, i) => { for (let j = i + 1; j < a.length; j++) if (a[j] > x) return j - i; return 0; }), 'r = []\nfor i in range(len(a)):\n    v = 0\n    for j in range(i + 1, len(a)):\n        if a[j] > a[i]:\n            v = j - i\n            break\n    r.append(v)', /距離|等幾天|還要等/],
        ['next-greater-idx', (a) => a.map((x, i) => { for (let j = i + 1; j < a.length; j++) if (a[j] > x) return j + 1; return 0; }), 'r = []\nfor i in range(len(a)):\n    v = 0\n    for j in range(i + 1, len(a)):\n        if a[j] > a[i]:\n            v = j + 1\n            break\n    r.append(v)', /位置|第幾個|索引/],
        ['prev-greater-val', (a) => a.map((x, i) => { for (let j = i - 1; j >= 0; j--) if (a[j] > x) return a[j]; return -1; }), 'r = []\nfor i in range(len(a)):\n    v = -1\n    for j in range(i - 1, -1, -1):\n        if a[j] > a[i]:\n            v = a[j]\n            break\n    r.append(v)', /左邊.*第一個.*(更)?大/],
        ['span', (a) => a.map((x, i) => { let c = 1; for (let j = i - 1; j >= 0 && a[j] <= x; j--) c++; return c; }), 'r = []\nfor i in range(len(a)):\n    c = 1\n    j = i - 1\n    while j >= 0 and a[j] <= a[i]:\n        c += 1\n        j -= 1\n    r.append(c)', /跨度|span/i],
    ];
    for (const [sid, sf, sp, kw] of STK) cands.push({ fam: 'stack', id: '堆疊/' + sid, kw: [kw], cost: 4, needK: false, out: 'list', f: (e) => sf(e.a), py: sp.split('\n') });
    // ---- brackets（單行字串）----
    function bracketRun(s, types) { const op = types.map((t) => t[0]).join(''), cl = types.map((t) => t[1]).join(''); const st = []; let depth = 0, maxd = 0, pairs = 0, bad = false, closeBad = 0; for (const ch of s) { if (op.includes(ch)) { st.push(ch); maxd = Math.max(maxd, st.length); } else if (cl.includes(ch)) { if (st.length && op.indexOf(st[st.length - 1]) === cl.indexOf(ch)) { st.pop(); pairs++; } else { bad = true; closeBad++; } } } void depth; return { valid: !bad && st.length === 0, maxd, pairs, rest: st.length, closeBad, bad }; }
    const BRK = [['()'], ['()', '[]'], ['()', '[]', '{}']];
    for (const types of BRK) {
        const cs = types.map((t) => t[0] + t[1]).join(''), tag = types.length + '種';
        const pyCommon = ['pair = ' + JSON.stringify(Object.fromEntries(types.map((t) => [t[1], t[0]]))), 'st = []', 'ok = True', 'maxd = 0', 'pairs = 0', 'for ch in s:', '    if ch in ' + JSON.stringify(types.map((t) => t[0]).join('')) + ':', '        st.append(ch)', '        maxd = max(maxd, len(st))', '    elif ch in pair:', '        if st and st[-1] == pair[ch]:', '            st.pop()', '            pairs += 1', '        else:', '            ok = False'];
        cands.push({ fam: 'brackets', id: '括號/' + tag + '/合法', kw: [/配對|合法|正確|balanced/i], cost: 3, str: true, out: 'bool', needK: false, f: (e) => bracketRun(e.s, types).valid, py: pyCommon.concat(['r = ok and not st']) });
        cands.push({ fam: 'brackets', id: '括號/' + tag + '/最大深度', kw: [/深度|巢狀/], cost: 3, str: true, out: 'int', needK: false, f: (e) => bracketRun(e.s, types).maxd, py: pyCommon.concat(['r = maxd']) });
        cands.push({ fam: 'brackets', id: '括號/' + tag + '/配對數', kw: [/幾對|配對數|對括號/], cost: 3, str: true, out: 'int', needK: false, f: (e) => bracketRun(e.s, types).pairs, py: pyCommon.concat(['r = pairs']) });
        cands.push({ fam: 'brackets', id: '括號/' + tag + '/最少補', kw: [/最少.*(補|加)|至少.*(補|加)/], cost: 4, str: true, out: 'int', needK: false, f: (e) => { const t = bracketRun(e.s, types); return t.closeBad + t.rest; }, py: pyCommon.concat(['r = (0 if ok else sum(1 for _ in [0])) and 0']).slice(0, -1).concat(['bad = 0', 'st2 = []', 'for ch in s:', '    if ch in ' + JSON.stringify(types.map((t) => t[0]).join('')) + ':', '        st2.append(ch)', '    elif ch in pair:', '        if st2 and st2[-1] == pair[ch]:', '            st2.pop()', '        else:', '            bad += 1', 'r = bad + len(st2)']) });
        void cs;
    }
    // ---- 入口 ----
    function parseExample(e) {
        const L = String(e.in).replace(/\n$/, '').split('\n'); const ol = String(e.out).replace(/\s+$/, '');
        if (L.length === 1 && !ints(L[0])) return { s: L[0].trim(), out: ol };
        if (L.length === 2) { const h = ints(L[0]), a = ints(L[1]); if (!h || !a || h.length < 1 || h.length > 2) return null; let n, k = null; if (h.length === 1) n = h[0]; else if (h[0] === a.length) { n = h[0]; k = h[1]; } else if (h[1] === a.length) { n = h[1]; k = h[0]; } else return null; if (n !== a.length) return null; return { a, k, out: ol, kpos: h.length === 2 ? (h[0] === a.length ? 'nk' : 'kn') : null }; }
        if (L.length === 4) { const h1 = ints(L[0]), a = ints(L[1]), h2 = ints(L[2]), b = ints(L[3]); if (!h1 || !a || !h2 || !b || h1.length !== 1 || h2.length !== 1 || h1[0] !== a.length || h2[0] !== b.length) return null; return { a, b, k: null, out: ol }; }
        if (L.length === 1) { const a = ints(L[0]); if (a && a.length) return { a, k: null, out: ol, noN: true }; }
        return null;
    }
    const fmt = (v, out) => (out === 'list' ? v.join(' ') : String(v));
    function pyProgram(c, shape, yes, no) {
        const L = ['def main():'];
        if (c.str) L.push('    s = input().strip()');
        else if (shape.two) L.push('    n = int(input())', '    a = list(map(int, input().split()))', '    m = int(input())', '    b = list(map(int, input().split()))');
        else if (shape.noN) L.push('    a = list(map(int, input().split()))');
        else if (shape.kpos === 'nk') L.push('    n, k = map(int, input().split())', '    a = list(map(int, input().split()))');
        else if (shape.kpos === 'kn') L.push('    k, n = map(int, input().split())', '    a = list(map(int, input().split()))');
        else L.push('    n = int(input())', '    a = list(map(int, input().split()))');
        for (const l of c.py) L.push('    ' + l);
        L.push(c.out === 'list' ? '    print(*r)' : c.out === 'bool' ? '    print(' + JSON.stringify(yes) + ' if r else ' + JSON.stringify(no) + ')' : '    print(r)');
        return L.join('\n') + '\n';
    }
    function synthList(o) {
        const exs = o.examples || []; if (!exs.length) return { ok: false, reason: '沒有範例' }; const st = String(o.statement || '');
        const P = exs.map(parseExample); if (P.some((x) => !x)) return { ok: false, reason: '不是「n＋清單」「n k＋清單」「兩個清單」或括號字串的形狀' };
        const isStr = P.every((x) => x.s !== undefined), isLists = P.every((x) => x.a !== undefined); if (!isStr && !isLists) return { ok: false, reason: '輸入形狀不一致' };
        const two = P.every((x) => x.b !== undefined); if (!two && P.some((x) => x.b !== undefined)) return { ok: false, reason: '輸入形狀不一致' };
        const hasK = P.every((x) => x.k !== null && x.k !== undefined); const shape = { two, noN: P.every((x) => x.noN), kpos: hasK ? P[0].kpos : null };
        const labelsEx = [...new Set(P.map((x) => x.out))]; const stLabels = [...st.matchAll(/(?:輸出|印出)\s*([A-Za-z]+)/g)].map((m) => m[1]);
        const hits = []; let tried = 0;
        for (const c of cands) {
            if (!!c.str !== isStr) continue; if (!!c.two !== two) continue; if (c.needK && !hasK) continue; tried++;
            let vals; try { vals = P.map((x) => c.f({ a: x.a, b: x.b, k: x.k, s: x.s })); } catch (e) { continue; } if (vals.some((v) => v === null || v === undefined)) continue;
            if (c.out === 'bool') { if (labelsEx.length > 2) continue; const lbls = labelsEx.concat(stLabels.filter((x) => !labelsEx.includes(x))); if (lbls.length < 2) continue; const ls = lbls.slice(0, 2); const first = st.indexOf(ls[0]) <= st.indexOf(ls[1]) || st.indexOf(ls[1]) < 0 ? [ls[0], ls[1]] : [ls[1], ls[0]]; const inSt = ls.some((l) => st.indexOf(l) >= 0); const orders = [first, [first[1], first[0]]]; for (const [y, n] of (inSt ? orders.slice(0, 1) : orders)) if (vals.every((v, i) => P[i].out === (v ? y : n))) { hits.push({ c, yes: y, no: n }); break; } }
            else if (vals.every((v, i) => fmt(v, c.out).trim() === P[i].out.trim())) hits.push({ c });
        }
        if (!hits.length) return { ok: false, reason: '清單草圖庫（前處理×歸約、配對、連續段、視窗、相鄰、多重集、兩清單、堆疊、括號；候選 ' + tried + ' 個）裡沒有符合所有範例的', tried };
        const score = (h) => (h.c.kw.some((r) => r.test(st)) ? 3 : 0) - h.c.cost; hits.sort((a, b) => score(b) - score(a));
        const probes = []; for (let q = 0; q < 14; q++) { const n = 2 + (q * 3) % 7; const a = Array.from({ length: n }, (_, i) => ((q * 5 + i * 7 + 3) % 11) - 3); const b = Array.from({ length: 2 + (q % 4) }, (_, i) => ((q * 3 + i * 5) % 9)); probes.push({ a, b: asc(b), k: 1 + (q % 4), s: ['()', '([)]', '(()', '{[()]}', ')(', '((()))', '()[]{}', '[(])', '(', '))'][q % 10] }); }
        const sig = (h) => probes.map((e) => { try { const v = h.c.f(e); return v === null ? 'n' : h.c.out === 'bool' ? (v ? 1 : 0) : fmt(v, h.c.out); } catch (err) { return 'e'; } }).join('|');
        const s0 = sig(hits[0]); const seen = new Set([s0]); const alts = []; for (const h of hits.slice(1)) { const s = sig(h); if (!seen.has(s)) { seen.add(s); alts.push(h); } }
        const mk = (h) => ({ ok: true, source: pyProgram(h.c, shape, h.yes, h.no), kind: 'list-sketch', level: h.c.fam === 'brackets' || h.c.fam === 'stack' ? 'L5' : 'L6', size: h.c.py.length, tried, ambiguous: false, desc: '清單草圖（' + h.c.fam + '）：' + h.c.id, matrixForm: { kind: 'list-sketch', family: h.c.fam, id: h.c.id } });
        const r0 = mk(hits[0]); r0.ambiguous = alts.length > 0 && !alts.every((a) => score(a) < score(hits[0]) - 1.5); r0.alternatives = alts.slice(0, 30).map(mk);
        if (alts.length) { const sg = []; for (const e of probes) { let x; try { x = hits[0].c.f(e); } catch (err) { continue; } if (x === null) continue; const other = new Set(); for (const h of alts.slice(0, 12)) { try { const v = h.c.f(e); if (v !== null && fmt(v, h.c.out) !== fmt(x, hits[0].c.out)) other.add(h.c.out === 'bool' ? (v ? h.yes : h.no) : fmt(v, h.c.out)); } catch (err) { /* 略過 */ } } if (other.size) { const inp = isStr ? e.s + '\n' : two ? e.a.length + '\n' + e.a.join(' ') + '\n' + e.b.length + '\n' + e.b.join(' ') + '\n' : (shape.kpos === 'kn' ? e.k + ' ' + e.a.length : shape.noN ? '' : e.a.length + (hasK ? ' ' + e.k : '')) + (shape.noN ? '' : '\n') + e.a.join(' ') + '\n'; sg.push({ in: inp, candidates: [hits[0].c.out === 'bool' ? (x ? hits[0].yes : hits[0].no) : fmt(x, hits[0].c.out)].concat([...other]).slice(0, 4) }); } if (sg.length >= 3) break; } r0.suggest = sg; }
        return r0;
    }
    function install(M) { if (!M || !M.register) return false; M.register('list-sketch', synthList, { order: 38, level: 'L5/L6', note: '清單草圖：前處理×歸約、配對、連續段、視窗、相鄰、多重集、兩清單、堆疊、括號' }); return true; }
    return { install, synthList, cands, pyProgram, parseExample, PRE, POST };
});
