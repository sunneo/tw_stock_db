// 台股技能的純函式運算核心（網頁版與桌面版共用，不依賴網路、不依賴 DOM）。
//
// 來源與版權：本檔的演算法骨架參考 tradermonty/claude-trading-skills（MIT License，
// Copyright (c) 2026 TraderMonty，https://github.com/tradermonty/claude-trading-skills）
// 的 market-breadth-analyzer、uptrend-analyzer、ftd-detector、ibd-distribution-day-monitor、
// vcp-screener、position-sizer 等技能的概念，改寫成台股慣例（漲跌幅 10%、加權指數、
// 1 張＝1000 股、手續費 0.1425%、證交稅 0.3%）並改用我們自己的資料欄位
// （daily_prices／market_index／technical_indicators／stocks）。數值門檻全部可由參數覆寫。
//
// 免責聲明：本程式只做教學與資料整理的計算，輸出不構成投資建議。
//
// 用法（Node）：const C = require('./tw_trading_calc.js');
// 用法（瀏覽器）：<script src=".../tw_trading_calc.js"> 之後使用 window.FaTwTradingCalc。
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaTwTradingCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // 台股預設參數（可由呼叫端覆寫）。
    const DEFAULTS = {
        // 市場廣度
        maShortDays: 20,
        maLongDays: 60,
        // 強勢股（上升趨勢）
        alignmentLabel: '多排',
        // 跟進日（follow-through day）
        ftdLookbackBars: 40,      // 往回找最近低點的範圍
        ftdMinDay: 4,             // 反彈第 4 日起才算跟進日候選
        ftdMaxDay: 10,            // 到第 10 日為止
        ftdMinGainPct: 1.5,       // 指數當日漲幅至少 1.5%
        // 出貨日（distribution day）
        distributionWindow: 25,   // 近 25 個交易日
        distributionDropPct: 0.2, // 跌幅至少 0.2% 且量增
        distributionCaution: 4,   // 4 日以上：留意
        distributionRisk: 6,      // 6 日以上：高風險
        // VCP
        vcpPivotWidth: 3,         // 轉折點左右各看幾根 K
        vcpMinBars: 40,           // 至少要幾根 K 才能判斷
        vcpWindowBars: 60,        // 只看最近幾根 K
        vcpMaxLastDepthPct: 10,   // 最後一次收縮深度上限
        vcpDryUpRatio: 0.8,       // 近 5 日均量 < 前段均量 × 0.8 才算量縮
        // 部位試算（台股）
        feeRate: 0.001425,        // 買進與賣出手續費率（0.1425%）
        feeDiscount: 1,           // 券商折扣，例如 0.6 代表六折
        minFee: 20,               // 手續費最低 20 元
        stockTaxRate: 0.003,      // 股票賣出證交稅 0.3%
        etfTaxRate: 0.001,        // ETF 賣出證交稅 0.1%
        lotShares: 1000,          // 1 張＝1000 股
    };

    function opt(options) { return Object.assign({}, DEFAULTS, options || {}); }
    function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
    function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null; }
    function pct(a, b) { return (a / b - 1) * 100; }
    function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }

    // 依交易日排序（不改動輸入陣列）。
    function sortByDate(rows) {
        return rows.slice().sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0));
    }

    // ───── 1. 市場廣度（我們自己的股票池，取代 US S&P 500 資料） ─────
    // prices: [{stock_code, trade_date, close, volume}]（daily_prices 的欄位）
    // 回傳每個交易日：上漲／下跌家數、漲跌比、站上 MA20／MA60 的比例、0-100 綜合分數。
    // 綜合分數＝三個分量等權平均（缺資料的分量自動排除、權重重分配）：
    //   分量一 = 上漲家數占比；分量二 = 站上 MA20 比例；分量三 = 站上 MA60 比例。
    function breadthByDate(prices, options) {
        const o = opt(options);
        const byStock = new Map();
        for (const r of prices) {
            const c = num(r.close);
            if (c == null) continue;
            if (!byStock.has(r.stock_code)) byStock.set(r.stock_code, []);
            byStock.get(r.stock_code).push({ d: r.trade_date, c });
        }
        const perDate = new Map(); // date -> {adv, dec, unch, n, above20, n20, above60, n60}
        const bump = (d) => {
            if (!perDate.has(d)) perDate.set(d, { adv: 0, dec: 0, unch: 0, n: 0, above20: 0, n20: 0, above60: 0, n60: 0 });
            return perDate.get(d);
        };
        for (const series0 of byStock.values()) {
            const series = series0.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
            const closes = [];
            for (let i = 0; i < series.length; i++) {
                const { d, c } = series[i];
                closes.push(c);
                const agg = bump(d);
                agg.n++;
                if (i > 0) {
                    const prev = series[i - 1].c;
                    if (c > prev) agg.adv++;
                    else if (c < prev) agg.dec++;
                    else agg.unch++;
                }
                if (closes.length >= o.maShortDays) {
                    const ma20 = mean(closes.slice(-o.maShortDays));
                    agg.n20++;
                    if (c > ma20) agg.above20++;
                }
                if (closes.length >= o.maLongDays) {
                    const ma60 = mean(closes.slice(-o.maLongDays));
                    agg.n60++;
                    if (c > ma60) agg.above60++;
                }
            }
        }
        return [...perDate.keys()].sort().map((d) => {
            const a = perDate.get(d);
            const movers = a.adv + a.dec;
            const parts = [];
            if (movers > 0) parts.push(a.adv / movers * 100);
            if (a.n20 > 0) parts.push(a.above20 / a.n20 * 100);
            if (a.n60 > 0) parts.push(a.above60 / a.n60 * 100);
            return {
                trade_date: d,
                stocks: a.n,
                advances: a.adv,
                declines: a.dec,
                unchanged: a.unch,
                adRatio: a.dec > 0 ? round2(a.adv / a.dec) : null,
                pctAboveMa20: a.n20 > 0 ? round2(a.above20 / a.n20 * 100) : null,
                pctAboveMa60: a.n60 > 0 ? round2(a.above60 / a.n60 * 100) : null,
                score: parts.length ? round2(mean(parts)) : null,
            };
        });
    }

    // 廣度分數轉區間（與 upstream 的健康區間同一套切法，但數值是我們自己算的台股廣度）。
    function breadthZone(score) {
        if (score == null) return '資料不足';
        if (score >= 80) return '強（參與度廣）';
        if (score >= 60) return '健康';
        if (score >= 40) return '中性（選股為主）';
        if (score >= 20) return '轉弱（留意風險）';
        return '嚴重轉弱';
    }

    // ───── 2. 上升趨勢比例（依族群統計） ─────
    // stocks: [{stock_code, sector_id, market}]（stocks 的欄位）
    // indicators: [{stock_code, trade_date, ma_alignment, rs_rating}]（technical_indicators 的欄位）
    // 只取每檔股票「最近一個交易日」的資料（或 options.asOf 指定的日期）。
    function uptrendBySector(stocks, indicators, options) {
        const o = opt(options);
        const sectorOf = new Map(stocks.map((s) => [s.stock_code, s.sector_id == null ? '未分類' : String(s.sector_id)]));
        const latest = new Map();
        for (const r of indicators) {
            if (o.asOf && r.trade_date > o.asOf) continue;
            const prev = latest.get(r.stock_code);
            if (!prev || r.trade_date > prev.trade_date) latest.set(r.stock_code, r);
        }
        const groups = new Map();
        for (const r of latest.values()) {
            const sector = sectorOf.get(r.stock_code) || '未分類';
            if (!groups.has(sector)) groups.set(sector, { sector, total: 0, uptrend: 0, rs: [] });
            const g = groups.get(sector);
            g.total++;
            if (String(r.ma_alignment || '').trim() === o.alignmentLabel) g.uptrend++;
            const rs = num(r.rs_rating);
            if (rs != null) g.rs.push(rs);
        }
        return [...groups.values()]
            .map((g) => ({
                sector: g.sector,
                total: g.total,
                uptrend: g.uptrend,
                uptrendPct: round2(g.uptrend / g.total * 100),
                avgRs: g.rs.length ? round2(mean(g.rs)) : null,
            }))
            .sort((a, b) => b.uptrendPct - a.uptrendPct);
    }

    // ───── 3. 跟進日（follow-through day）與反彈狀態 ─────
    // indexRows: 加權指數 [{trade_date, close, volume}]（market_index 的 TAIEX 列）
    // 規則：
    //   1) 在最近 ftdLookbackBars 根 K 中找收盤最低點 L（修正低點）。
    //   2) L 之後第一個收盤上漲的日子 = 反彈第 1 日（rally attempt）。
    //   3) 反彈期間若收盤跌破 L → 反彈失敗（undercut）。
    //   4) 反彈第 ftdMinDay～ftdMaxDay 日中，出現「漲幅 ≥ ftdMinGainPct 且量大於前一日」的日子 → 跟進日。
    // 回傳 state：'none'（資料不足）、'correction'（還沒出現反彈）、'rally_attempt'（反彈中、尚無跟進日）、
    //            'ftd'（已出現跟進日）、'undercut'（最近一次反彈失敗，跌破低點、尚未開始新反彈）
    // 狀態機：低點不斷往下更新；低點之後第一個上漲日＝反彈第 1 日；反彈中收盤跌破該低點＝反彈失敗，
    // 低點重設為跌破當日，之前的反彈計數全部作廢。
    function followThroughDay(indexRows, options) {
        const o = opt(options);
        const rows = sortByDate(indexRows).map((r) => ({ d: r.trade_date, c: num(r.close), v: num(r.volume) })).filter((r) => r.c != null);
        if (rows.length < 3) return { state: 'none', reason: '資料不足（至少需要 3 個交易日）' };
        const start = Math.max(0, rows.length - o.ftdLookbackBars);
        let low = rows[start].c, lowIdx = start, d1 = -1, undercutDate = null;
        for (let i = start + 1; i < rows.length; i++) {
            const c = rows[i].c;
            if (d1 < 0) {
                if (c < low) { low = c; lowIdx = i; continue; }
                if (c > rows[i - 1].c) d1 = i; // 反彈第 1 日
                continue;
            }
            // 反彈中
            if (c < low) { // 反彈失敗：重設低點，之前的反彈作廢
                undercutDate = rows[i].d;
                low = c; lowIdx = i; d1 = -1;
                continue;
            }
            const day = i - d1 + 1;
            if (day < o.ftdMinDay || day > o.ftdMaxDay) continue;
            const gain = pct(c, rows[i - 1].c);
            const volUp = rows[i].v != null && rows[i - 1].v != null && rows[i].v > rows[i - 1].v;
            if (gain >= o.ftdMinGainPct && volUp) {
                return { state: 'ftd', lowDate: rows[lowIdx].d, lowClose: low, attemptDay: day, attemptStartDate: rows[d1].d, ftdDate: rows[i].d, ftdGainPct: round2(gain), reason: `反彈第 ${day} 日出現跟進日` };
            }
        }
        if (d1 >= 0) {
            const attemptDay = rows.length - d1; // 今天是反彈第幾日（d1 為第 1 日）
            return { state: 'rally_attempt', lowDate: rows[lowIdx].d, lowClose: low, attemptDay, attemptStartDate: rows[d1].d, undercutDate, reason: `反彈第 ${attemptDay} 日，尚未出現符合條件的跟進日` };
        }
        if (undercutDate) return { state: 'undercut', lowDate: rows[lowIdx].d, lowClose: low, undercutDate, reason: '最近一次反彈跌破低點而失敗，尚未開始新的反彈' };
        return { state: 'correction', lowDate: rows[lowIdx].d, lowClose: low, reason: '還沒有出現反彈' };
    }

    // ───── 4. 出貨日（distribution day）計數 ─────
    // 近 distributionWindow 個交易日中，「跌幅 ≥ distributionDropPct 且成交量大於前一日」的日子。
    function distributionDays(indexRows, options) {
        const o = opt(options);
        const rows = sortByDate(indexRows).map((r) => ({ d: r.trade_date, c: num(r.close), v: num(r.volume) })).filter((r) => r.c != null);
        const startIdx = Math.max(1, rows.length - o.distributionWindow);
        const days = [];
        for (let i = startIdx; i < rows.length; i++) {
            const drop = pct(rows[i].c, rows[i - 1].c);
            const volUp = rows[i].v != null && rows[i - 1].v != null && rows[i].v > rows[i - 1].v;
            if (drop <= -o.distributionDropPct && volUp) days.push(rows[i].d);
        }
        const count = days.length;
        let level = '正常';
        if (count >= o.distributionRisk) level = '高風險（出貨日偏多）';
        else if (count >= o.distributionCaution) level = '留意（出貨日增加）';
        return { count, level, days, windowBars: o.distributionWindow, sessionsSeen: rows.length - startIdx };
    }

    // ───── 5. VCP（波動收縮型態）粗篩 ─────
    // bars: 單一股票的日K [{trade_date, high, low, close, volume}]（daily_prices 的欄位）
    // 方法：用左右各 vcpPivotWidth 根 K 的極值找轉折高低點，組成「高→低」收縮段，
    // 要求最後三段深度嚴格遞減，且最後一段深度 ≤ vcpMaxLastDepthPct，並且近 5 日量縮。
    // 資料不足 vcpMinBars 根時回傳 found:false 與原因，不硬算。
    function vcpCheck(bars, options) {
        const o = opt(options);
        const rows = sortByDate(bars).map((r) => ({
            d: r.trade_date, h: num(r.high), l: num(r.low), c: num(r.close), v: num(r.volume),
        })).filter((r) => r.h != null && r.l != null && r.c != null);
        if (rows.length < o.vcpMinBars) {
            return { found: false, reason: `資料不足：只有 ${rows.length} 根 K，需要至少 ${o.vcpMinBars} 根`, contractions: [] };
        }
        const win = rows.slice(-o.vcpWindowBars);
        const w = o.vcpPivotWidth;
        const pivots = [];
        for (let i = w; i < win.length - w; i++) {
            let isHigh = true, isLow = true;
            for (let k = i - w; k <= i + w; k++) {
                if (k === i) continue;
                if (win[k].h >= win[i].h) isHigh = false;
                if (win[k].l <= win[i].l) isLow = false;
            }
            if (isHigh) pivots.push({ type: 'H', i, price: win[i].h, d: win[i].d });
            if (isLow) pivots.push({ type: 'L', i, price: win[i].l, d: win[i].d });
        }
        // 同類型相鄰的轉折點只保留極端的那一個，讓高低交替
        const alt = [];
        for (const p of pivots) {
            const last = alt[alt.length - 1];
            if (!last) { alt.push(p); continue; }
            if (last.type === p.type) {
                if ((p.type === 'H' && p.price > last.price) || (p.type === 'L' && p.price < last.price)) alt[alt.length - 1] = p;
            } else alt.push(p);
        }
        const contractions = [];
        for (let k = 0; k + 1 < alt.length; k++) {
            if (alt[k].type === 'H' && alt[k + 1].type === 'L') {
                const depth = (alt[k].price - alt[k + 1].price) / alt[k].price * 100;
                contractions.push({ highDate: alt[k].d, lowDate: alt[k + 1].d, depthPct: round2(depth) });
            }
        }
        if (contractions.length < 3) {
            return { found: false, reason: `只找到 ${contractions.length} 段收縮，需要至少 3 段`, contractions };
        }
        const last3 = contractions.slice(-3);
        const strictlyShrinking = last3[0].depthPct > last3[1].depthPct && last3[1].depthPct > last3[2].depthPct;
        const lastDepthOk = last3[2].depthPct <= o.vcpMaxLastDepthPct;
        const recentVol = mean(win.slice(-5).map((r) => r.v).filter((x) => x != null));
        const priorVol = mean(win.slice(0, -5).map((r) => r.v).filter((x) => x != null));
        const dryUp = recentVol != null && priorVol != null && priorVol > 0 && recentVol < priorVol * o.vcpDryUpRatio;
        const found = strictlyShrinking && lastDepthOk && dryUp;
        const reasons = [];
        reasons.push(strictlyShrinking ? '收縮深度逐段遞減 ✓' : '收縮深度未逐段遞減 ✗');
        reasons.push(lastDepthOk ? `最後一段深度 ≤ ${o.vcpMaxLastDepthPct}% ✓` : `最後一段深度超過 ${o.vcpMaxLastDepthPct}% ✗`);
        reasons.push(dryUp ? '近 5 日量縮 ✓' : '近 5 日未量縮 ✗');
        return {
            found,
            reason: reasons.join('；'),
            contractions: last3,
            lastDepthPct: last3[2].depthPct,
            recentVolAvg: round2(recentVol),
            priorVolAvg: round2(priorVol),
        };
    }

    // ───── 6. 部位試算（台股：1 張 = 1000 股、手續費、證交稅） ─────
    // input: {capital, riskPct, entry, stop, isEtf?, oddLot?, maxPositionPct?}
    //   capital：可用資金（元）；riskPct：單筆最多虧損占資金的百分比（預設 1）
    //   entry：預計買進價；stop：停損價（必須低於 entry）
    //   oddLot：true 時可買零股（以 1 股為單位），預設 false（以整張為單位）
    //   maxPositionPct：單一部位最多占資金的百分比（預設 100）
    // 每股風險 = (進場價 − 停損價) + 買進手續費/股 + 賣出手續費與證交稅/股（停損當下）。
    // 手續費與稅一律無條件捨去到元，手續費最低 minFee 元。
    function positionSize(input, options) {
        const o = opt(options);
        const capital = num(input.capital), entry = num(input.entry), stop = num(input.stop);
        const riskPct = input.riskPct == null ? 1 : num(input.riskPct);
        const maxPositionPct = input.maxPositionPct == null ? 100 : num(input.maxPositionPct);
        if (capital == null || capital <= 0) return { ok: false, error: '資金必須是正數' };
        if (entry == null || entry <= 0) return { ok: false, error: '進場價必須是正數' };
        if (stop == null || stop <= 0 || stop >= entry) return { ok: false, error: '停損價必須大於 0 且低於進場價' };
        if (riskPct == null || riskPct <= 0 || riskPct > 100) return { ok: false, error: '風險百分比必須在 (0, 100]' };
        const taxRate = input.isEtf ? o.etfTaxRate : o.stockTaxRate;
        const feeRate = o.feeRate * o.feeDiscount;
        const riskAmount = capital * riskPct / 100;
        // 以每股計的成本（費用按股數線性近似；最低手續費在最後一步處理）
        const perShareRisk = (entry - stop) + entry * feeRate + stop * (feeRate + taxRate);
        let shares = Math.floor(riskAmount / perShareRisk);
        const notes = [];
        if (!input.oddLot) {
            const lots = Math.floor(shares / o.lotShares);
            if (lots !== shares / o.lotShares) notes.push(`以整張計算，已由 ${shares} 股無條件捨去為 ${lots * o.lotShares} 股`);
            shares = lots * o.lotShares;
        }
        // 單一部位上限
        const maxValue = capital * maxPositionPct / 100;
        if (shares * entry > maxValue) {
            const cap = Math.floor(maxValue / entry);
            const capped = input.oddLot ? cap : Math.floor(cap / o.lotShares) * o.lotShares;
            notes.push(`部位金額超過 ${maxPositionPct}% 上限，股數由 ${shares} 降為 ${capped}`);
            shares = capped;
        }
        if (shares <= 0) {
            return { ok: true, shares: 0, lots: 0, notes: notes.concat(['風險額度不足以買進一個單位（在這個停損距離下）']) };
        }
        const value = shares * entry;
        const buyFee = Math.max(o.minFee, Math.floor(value * feeRate));
        const sellValue = shares * stop;
        const sellFee = Math.max(o.minFee, Math.floor(sellValue * feeRate));
        const tax = Math.floor(sellValue * taxRate);
        const lossAtStop = (value - sellValue) + buyFee + sellFee + tax;
        return {
            ok: true,
            shares,
            lots: input.oddLot ? null : shares / o.lotShares,
            positionValue: value,
            buyFee,
            sellFee,
            tax,
            lossAtStop,
            lossPctOfCapital: round2(lossAtStop / capital * 100),
            riskAmountTarget: round2(riskAmount),
            notes,
        };
    }

    return {
        DEFAULTS,
        breadthByDate,
        breadthZone,
        uptrendBySector,
        followThroughDay,
        distributionDays,
        vcpCheck,
        positionSize,
    };
});
