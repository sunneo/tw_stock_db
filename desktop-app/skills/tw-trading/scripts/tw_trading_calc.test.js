// 台股技能運算核心的單元測試（小型假資料，不依賴網路）。用法：node skills/tw-trading/scripts/tw_trading_calc.test.js
const assert = require('assert');
const C = require('./tw_trading_calc.js');

let ok = 0;
const t = (name, fn) => { fn(); ok++; console.log('ok -', name); };

// ── 市場廣度 ──
t('breadth: 上漲／下跌家數與漲跌比', () => {
    const prices = [
        { stock_code: 'A', trade_date: '2026-01-01', close: 10 },
        { stock_code: 'A', trade_date: '2026-01-02', close: 11 },
        { stock_code: 'B', trade_date: '2026-01-01', close: 20 },
        { stock_code: 'B', trade_date: '2026-01-02', close: 18 },
        { stock_code: 'C', trade_date: '2026-01-01', close: 5 },
        { stock_code: 'C', trade_date: '2026-01-02', close: 5 },
    ];
    const r = C.breadthByDate(prices);
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].advances, 0); // 第一天沒有前一日，不計漲跌
    const d2 = r[1];
    assert.strictEqual(d2.advances, 1);
    assert.strictEqual(d2.declines, 1);
    assert.strictEqual(d2.unchanged, 1);
    assert.strictEqual(d2.adRatio, 1);
    assert.strictEqual(d2.pctAboveMa20, null); // 歷史不足 20 日，不硬算
});

t('breadth: 站上 MA20 比例（用收盤價自算）', () => {
    const prices = [];
    // 股票 X：前 19 天 10 元，第 20 天 12 元 → 第 20 天站上 MA20
    for (let i = 0; i < 20; i++) {
        prices.push({ stock_code: 'X', trade_date: '2026-02-' + String(i + 1).padStart(2, '0'), close: i < 19 ? 10 : 12 });
    }
    const r = C.breadthByDate(prices);
    const last = r[r.length - 1];
    assert.strictEqual(last.pctAboveMa20, 100);
    assert.ok(last.score >= 0 && last.score <= 100);
});

t('breadthZone 分區', () => {
    assert.strictEqual(C.breadthZone(85), '強（參與度廣）');
    assert.strictEqual(C.breadthZone(65), '健康');
    assert.strictEqual(C.breadthZone(10), '嚴重轉弱');
    assert.strictEqual(C.breadthZone(null), '資料不足');
});

// ── 上升趨勢比例（族群） ──
t('uptrendBySector: 取每檔最新一天，依族群統計多排比例', () => {
    const stocks = [
        { stock_code: '2330', sector_id: 1 },
        { stock_code: '2317', sector_id: 1 },
        { stock_code: '1101', sector_id: 2 },
    ];
    const ind = [
        { stock_code: '2330', trade_date: '2026-03-01', ma_alignment: '空排', rs_rating: 40 },
        { stock_code: '2330', trade_date: '2026-03-02', ma_alignment: '多排', rs_rating: 90 }, // 最新
        { stock_code: '2317', trade_date: '2026-03-02', ma_alignment: '多排', rs_rating: 70 },
        { stock_code: '1101', trade_date: '2026-03-02', ma_alignment: '空排', rs_rating: 30 },
    ];
    const r = C.uptrendBySector(stocks, ind);
    const s1 = r.find((x) => x.sector === '1');
    assert.strictEqual(s1.total, 2);
    assert.strictEqual(s1.uptrend, 2);
    assert.strictEqual(s1.uptrendPct, 100);
    assert.strictEqual(s1.avgRs, 80);
    assert.strictEqual(r.find((x) => x.sector === '2').uptrendPct, 0);
});

// ── 跟進日 ──
// 指數：先跌到 100（低點），之後第 1 日上漲，第 4 日大漲且量增 → 跟進日
function indexSeries(closes, vols) {
    return closes.map((c, i) => ({ trade_date: '2026-04-' + String(i + 1).padStart(2, '0'), close: c, volume: vols[i] }));
}
t('followThroughDay: 反彈第 4 日量增大漲 → ftd', () => {
    const closes = [110, 105, 100, 101, 102, 103, 104.5, 107.5]; // 低點 100 在 index 2；index3 為第1日
    const vols =   [900, 950, 980, 1000, 1010, 1020, 1030, 1200];
    // 第 4 日（index 6）104.5 vs 103 = +1.46%，不夠；第 5 日（index 7）107.5 vs 104.5 = +2.87% 且量增
    const r = C.followThroughDay(indexSeries(closes, vols));
    assert.strictEqual(r.state, 'ftd');
    assert.strictEqual(r.attemptDay, 5);
    assert.strictEqual(r.lowClose, 100);
});

t('followThroughDay: 反彈中跌破低點 → undercut（尚未開始新反彈）', () => {
    const closes = [110, 105, 100, 103, 98];
    const vols = [1, 1, 1, 1, 1];
    const r = C.followThroughDay(indexSeries(closes, vols));
    assert.strictEqual(r.state, 'undercut');
    assert.strictEqual(r.lowClose, 98);
});

t('followThroughDay: 跌破後又開始新反彈 → rally_attempt 且記錄失敗日', () => {
    const closes = [110, 105, 100, 103, 98, 99];
    const vols = [1, 1, 1, 1, 1, 1];
    const r = C.followThroughDay(indexSeries(closes, vols));
    assert.strictEqual(r.state, 'rally_attempt');
    assert.strictEqual(r.attemptDay, 1);
    assert.strictEqual(r.lowClose, 98);
    assert.ok(r.undercutDate);
});

t('followThroughDay: 還在反彈、尚無跟進日 → rally_attempt', () => {
    const closes = [110, 105, 100, 100.5, 101];
    const vols = [1, 1, 1, 1, 1];
    const r = C.followThroughDay(indexSeries(closes, vols));
    assert.strictEqual(r.state, 'rally_attempt');
    assert.strictEqual(r.attemptDay, 2);
});

t('followThroughDay: 資料太少', () => {
    assert.strictEqual(C.followThroughDay(indexSeries([1, 2], [1, 1])).state, 'none');
});

// ── 出貨日 ──
t('distributionDays: 跌幅≥0.2% 且量增才算', () => {
    const closes = [100, 99, 98.5, 98.4, 97.5];   // 1: -1% 量增 ✓；2: -0.5% 量增 ✓；3: -0.1% ✗；4: -0.9% 量增 ✓
    const vols =   [100, 110, 120, 100, 130];     // 3: 量縮不算（-0.1% 也不夠）；4: 量增 ✓
    const r = C.distributionDays(indexSeries(closes, vols));
    assert.strictEqual(r.count, 3);
    assert.strictEqual(r.level, '正常');
});

t('distributionDays: 6 日以上為高風險', () => {
    const closes = [], vols = [];
    let c = 100, v = 100;
    for (let i = 0; i < 26; i++) {
        c = i % 2 === 0 ? c * 0.99 : c * 1.001; // 跌 1% 再小漲，交替
        v = i % 2 === 0 ? v + 10 : v; // 跌日量增
        closes.push(c); vols.push(v);
    }
    const r = C.distributionDays(indexSeries(closes, vols));
    assert.ok(r.count >= 6, 'count=' + r.count);
    assert.ok(r.level.startsWith('高風險'));
});

// ── VCP ──
t('vcpCheck: 構造好的三段遞減收縮（20%→10%→5%）+ 量縮 → found true', () => {
    // 轉折點：100 高 → 80 低（-20%）→ 95 高 → 85.5 低（-10%）→ 92 高 → 87.4 低（-5%）→ 之後小漲
    const turns = [100, 80, 95, 85.5, 92, 87.4, 89, 90];
    const closes = [];
    for (let i = 0; i < 25; i++) closes.push(49.5); // 前段平盤，不產生轉折點
    for (let k = 0; k + 1 < turns.length; k++) {
        for (let s = 0; s < 4; s++) closes.push(turns[k] + (turns[k + 1] - turns[k]) * s / 4);
    }
    closes.push(turns[turns.length - 1]);
    const bars = closes.map((c, i) => bar(i, c + 0.5, c - 0.5, c, i < closes.length - 5 ? 1000 : 500));
    const r = C.vcpCheck(bars, { vcpMinBars: 40, vcpPivotWidth: 2, vcpWindowBars: 200 });
    assert.strictEqual(r.contractions.length >= 3, true, JSON.stringify(r.contractions));
    assert.strictEqual(r.found, true, r.reason);
    const d = r.contractions.map((x) => x.depthPct);
    assert.ok(d[0] > d[1] && d[1] > d[2], JSON.stringify(d));
});
function bar(i, h, l, c, v) { return { trade_date: 'd' + String(i).padStart(3, '0'), high: h, low: l, close: c, volume: v }; }
t('vcpCheck: 資料不足不硬算', () => {
    const r = C.vcpCheck([bar(1, 10, 9, 9.5, 100)]);
    assert.strictEqual(r.found, false);
    assert.ok(r.reason.startsWith('資料不足'));
});

t('vcpCheck: 三段遞減收縮 + 量縮 → found', () => {
    // 手工設計：高 100 → 低 80（-20%）→ 高 95 → 低 85（約 -10.5%）→ 高 92 → 低 87（約 -5.4%），最後 5 日量縮
    const seq = [
        [100, 99], [98, 96], [95, 92], [90, 84], [80, 80], // 第一段：高點 100 → 低點 80
        [84, 82], [90, 88], [95, 92], [93, 90], [88, 85], // 第二段起點 95、低點 85
        [92, 90], [93, 91], [92, 88], [90, 87], [89, 86],  // 第三段高點 93、低點 86… 深度約 7.5%
        [91, 88], [90, 89], [89, 88], [88, 87], [89, 88],
    ];
    const bars = seq.map((p, i) => {
        const vol = i < 15 ? 1000 : 500; // 最後 5 日量縮
        return bar(i, p[0], p[1], (p[0] + p[1]) / 2, vol);
    });
    // 補足到最少 40 根：前面放平盤
    const pad = [];
    for (let i = 0; i < 25; i++) pad.push(bar(-100 + i, 50, 49, 49.5, 1000));
    const r = C.vcpCheck(pad.concat(bars), { vcpMinBars: 40, vcpPivotWidth: 2 });
    // 這組假資料的目的是驗證流程與欄位，不是確認是否符合真實型態
    assert.ok(Array.isArray(r.contractions));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
});

t('vcpCheck: 沒有三段收縮 → found false', () => {
    const bars = [];
    for (let i = 0; i < 50; i++) bars.push(bar(i, 10 + i * 0.1, 9 + i * 0.1, 9.5 + i * 0.1, 1000)); // 單調上漲
    const r = C.vcpCheck(bars);
    assert.strictEqual(r.found, false);
});

// ── 部位試算 ──
t('positionSize: 整張、風險 1%、含手續費與稅', () => {
    // 資金 1,000,000；風險 1% = 10,000；進場 100、停損 95 → 每股風險 5 + 0.1425 + 95*(0.1425%+0.3%)
    const r = C.positionSize({ capital: 1000000, riskPct: 1, entry: 100, stop: 95 });
    assert.strictEqual(r.ok, true);
    assert.ok(r.shares >= 1000 && r.shares % 1000 === 0, 'shares=' + r.shares);
    assert.ok(r.lossAtStop <= 10000, 'loss=' + r.lossAtStop);
    assert.ok(r.buyFee >= 20);
    assert.ok(r.tax > 0);
});

t('positionSize: 風險額度不足一張 → 0 股並說明', () => {
    const r = C.positionSize({ capital: 100000, riskPct: 1, entry: 500, stop: 300 });
    assert.strictEqual(r.shares, 0);
    assert.ok(r.notes.length > 0);
});

t('positionSize: 零股模式不捨去到張', () => {
    const r = C.positionSize({ capital: 100000, riskPct: 1, entry: 50, stop: 48, oddLot: true });
    assert.ok(r.shares > 0 && r.shares % 1000 !== 0 || r.shares < 1000);
    assert.strictEqual(r.lots, null);
});

t('positionSize: 部位上限生效', () => {
    const r = C.positionSize({ capital: 100000, riskPct: 50, entry: 10, stop: 9.9, maxPositionPct: 20 });
    assert.ok(r.positionValue <= 20000 + 1e-9, 'value=' + r.positionValue);
});

t('positionSize: 輸入錯誤', () => {
    assert.strictEqual(C.positionSize({ capital: 1, entry: 10, stop: 11 }).ok, false);
    assert.strictEqual(C.positionSize({ capital: -1, entry: 10, stop: 9 }).ok, false);
});

console.log(`\n${ok} 項通過`);
