/* 平行排程原語（純函式，不開真的執行緒）：OpenMP 風格的迴圈排程怎麼把索引分給執行緒、負載不均衡度、排程推薦。
 * 給領域包 domain_par、程式分析工具鏈（par_advice）共用；全部確定性（動態／引導式用「最早閒下來的執行緒（同時取編號最小）拿下一塊」的事件模擬）。
 * schedule(kind, n, p, k, cost?) → [每個執行緒的索引陣列（依執行順序）]
 *   kind：static（無區塊大小＝連續區塊，前 n%p 個執行緒多拿一個）、cyclic（＝static,1）、chunked（＝static,k 輪流發 k 個）、dynamic（k 個一塊，誰先閒誰拿）、guided（塊大小＝max(k, ceil(剩餘/p))，漸減）
 * metrics(loads) → {work, span, speedup, imbalance}：work＝總工作量，span＝最忙那個執行緒的量（平行時間下界），speedup＝work/span，imbalance＝span/平均−1（0＝完全均衡） */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaParSched = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const range = (a, b) => { const r = []; for (let i = a; i < b; i++) r.push(i); return r; };
    function schedule(kind, n, p, k, cost) {
        p = Math.max(1, p | 0); k = Math.max(1, k | 0 || 1); const out = Array.from({ length: p }, () => []);
        if (kind === 'static') { const q = Math.floor(n / p), r = n % p; let s = 0; for (let t = 0; t < p; t++) { const len = q + (t < r ? 1 : 0); out[t] = range(s, s + len); s += len; } return out; }
        if (kind === 'cyclic') k = 1;
        if (kind === 'cyclic' || kind === 'chunked') { for (let s = 0, c = 0; s < n; s += k, c++) out[c % p].push(...range(s, Math.min(n, s + k))); return out; }
        if (kind === 'dynamic' || kind === 'guided') {
            const fin = new Array(p).fill(0); let s = 0;
            while (s < n) {
                const sz = kind === 'dynamic' ? k : Math.max(k, Math.ceil((n - s) / p)); const e = Math.min(n, s + sz);
                let t = 0; for (let i = 1; i < p; i++) if (fin[i] < fin[t]) t = i;
                for (let i = s; i < e; i++) { out[t].push(i); fin[t] += cost ? cost[i] : 1; }
                s = e;
            }
            return out;
        }
        throw new Error('未知排程 ' + kind);
    }
    const loads = (sched, cost) => sched.map((ix) => ix.reduce((a, i) => a + (cost ? cost[i] : 1), 0));
    function metrics(ld) {
        const work = ld.reduce((a, b) => a + b, 0), span = Math.max(0, ...ld), mean = work / ld.length;
        return { work, span, speedup: span ? work / span : 1, imbalance: mean ? span / mean - 1 : 0 };
    }
    // 對一組工作量，比較全部候選排程；推薦＝span 最小者，同分依 static、cyclic、dynamic、guided 的先後（越簡單、額外開銷越小越優先）
    const CANDS = [['static', 1], ['cyclic', 1], ['chunked', 4], ['dynamic', 1], ['dynamic', 4], ['guided', 1]];
    const name = (kind, k) => kind === 'static' ? 'schedule(static)' : kind === 'cyclic' ? 'schedule(static,1)' : kind === 'chunked' ? 'schedule(static,' + k + ')' : 'schedule(' + kind + ',' + k + ')';
    function recommend(cost, p) {
        const rows = CANDS.map(([kind, k]) => { const s = schedule(kind, cost.length, p, k, cost); const m = metrics(loads(s, cost)); return { kind, k, name: name(kind, k), span: m.span, speedup: m.speedup, imbalance: m.imbalance }; });
        let best = rows[0]; for (const r of rows) if (r.span < best.span - 1e-9) best = r;
        return { best, rows };
    }
    // 工作量分布分類：uniform（幾乎一樣）、increasing／decreasing（單調）、tail（尾端很重）、random（其他）
    function classify(cost) {
        const n = cost.length; if (n < 3) return 'uniform'; const mx = Math.max(...cost), mn = Math.min(...cost);
        if (mx - mn <= 0.1 * mx) return 'uniform';
        let inc = true, dec = true; for (let i = 1; i < n; i++) { if (cost[i] < cost[i - 1]) inc = false; if (cost[i] > cost[i - 1]) dec = false; }
        if (inc) return 'increasing'; if (dec) return 'decreasing';
        const tail = cost.slice(Math.floor(n * 0.9)).reduce((a, b) => a + b, 0), tot = cost.reduce((a, b) => a + b, 0);
        if (tail >= 0.5 * tot) return 'tail';
        return 'random';
    }
    // 可驗證的理由：回傳文字，其中每個數字都來自 recommend 的實算，不憑印象
    function explain(cost, p) {
        const r = recommend(cost, p), cls = classify(cost), st = r.rows[0];
        return { cls, best: r.best.name, text: '分布=' + cls + '；schedule(static) 的 span=' + st.span + '、不均衡度=' + st.imbalance.toFixed(3) + '；推薦 ' + r.best.name + ' 的 span=' + r.best.span + '、理論加速比=' + r.best.speedup.toFixed(3) };
    }
    return { schedule, loads, metrics, recommend, classify, explain, CANDS, name };
});
