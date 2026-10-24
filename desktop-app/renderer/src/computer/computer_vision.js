// computer use 的「慢路徑」：用弱的視覺模型（Florence-2 base、LLaVA-Interleave Qwen 0.5B…）看畫面，程式負責幾何與驗證（UMD，嵌入成 FaComputerVision）。
// 原則（DESIGN.TODO.four-directions.md §3）：弱模型只回答「很小的封閉問題」，座標、比例、格子、重疊、信心全部由程式算：
//   1. 切磚（tileScan）：把截圖切成格子（每格約 256px），每格問「這一格裡面是什麼控制項？」，答案只能是封閉詞彙（button／textbox／menu／tab／…／none）。
//   2. 定位（locate）：「有沒有 X？」逐格答 yes/no，有的格再切 3×3 縮小範圍；位置由格子座標決定，不是模型猜的。
//   3. 驗證（verify）：探索 → 移動滑鼠 → 重拍 → 比對：游標形狀變化（手／I 字／調整大小＝sash）、周圍區域變化（hover 效果）；沒反應的降低信心。
//   4. 動畫（sampleAnimation）：同一區塊連拍，一直在變就是動畫，改走連續取樣的觀察串流。
//   5. 校準（calibrate）：移動滑鼠到已知點、讀回位置，量出座標比例與速度，之後的點擊自動補償。
// 這個檔案不碰 window.desktopAPI／DOM：所有外部能力由 deps 注入（computer_host.js 接到 desktopAPI.computer 與 _interpretImageWithVisionModel），所以可以用假的 deps 在 node 裡測。
// deps：{ crop(shotId, screenRect, {maxSide})→{dataUrl,origin,scale,width,height}, ask(dataUrl, question)→文字, probe(points)→[{probe}]（主行程 hover_probe；要使用者核准）,
//         calibrate()→校準結果, sample(rect|windowId)→{animated,…}, now() }
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./computer_core.js')); else root.FaComputerVision = factory(typeof FaComputerCore !== 'undefined' ? FaComputerCore : root.FaComputerCore); })(typeof self !== 'undefined' ? self : this, function (C) {
    'use strict';

    // ===== 問題（英文；小模型的英文最穩）=====
    const Q = {
        // 這一格裡面最主要的是什麼控制項（封閉詞彙）
        cell: 'What kind of user interface element is mainly shown in this picture? Answer with exactly one word from: button, textbox, checkbox, radio, menu, tab, toolbar, titlebar, scrollbar, sash, icon, link, image, text, list, slider, dialog, none.',
        // 有沒有 X（yes/no）
        has: (what) => 'Is there ' + what + ' in this picture? Answer yes or no.',
        // 這個框裡的字（OCR）
        text: 'Read the text in this picture. Answer with only the text. If there is no text, answer none.',
        // 這是不是按鈕／輸入框（二選一的確認題）
        isA: (kind) => 'Is the main thing in this picture a ' + kind + '? Answer yes or no.',
        describe: 'Describe this part of a computer screen in one short sentence: what window or control it is and what it shows.',
    };
    const WIDGET_SYN = { button: 'a button', textbox: 'a text input field', checkbox: 'a checkbox', menu: 'a menu', tab: 'a tab', link: 'a link', icon: 'an icon', image: 'a picture', toolbar: 'a toolbar', scrollbar: 'a scroll bar', slider: 'a slider' };

    // 有限併發地做一串非同步工作（弱模型在瀏覽器裡一次只能做一件，預設 1）
    async function mapPool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.max(1, Math.min(n || 1, items.length)) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
    const trimText = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 200);

    // ===== 1. 切磚掃描 =====
    // shot：{ shotId, origin, scale, width, height }（computer_screenshot 的結果）；o：{ cols, rows, maxCellPx, maxCells, ocr, concurrency, onProgress, signal }
    // 回傳 { ok, candidates:[element(source:'vlm')], cells:[{col,row,rect,widget,raw}], asked, notes }
    async function tileScan(deps, shot, o) {
        o = o || {}; const g = o.cols && o.rows ? { cols: o.cols, rows: o.rows } : C.chooseGrid(shot.width, shot.height, { maxCellPx: o.maxCellPx || 256, maxCells: o.maxCells || 24 });
        const cells = C.gridCells(shot.width, shot.height, g.cols, g.rows), notes = [], out = []; let asked = 0, failed = 0;
        const run = async (cell) => {
            if (o.signal && o.signal.aborted) return null;
            const rect = C.imageBoxToScreen(shot, cell); let crop; try { crop = await deps.crop(shot.shotId, rect, { maxSide: o.cellSide || 256 }); } catch (e) { failed++; return null; } if (!crop || !crop.ok) { failed++; return null; }
            let ans = ''; try { ans = await deps.ask(crop.dataUrl, Q.cell); asked++; } catch (e) { failed++; notes.push('第 ' + (cell.row + 1) + ' 列第 ' + (cell.col + 1) + ' 欄看圖失敗：' + String((e && e.message) || e).slice(0, 60)); return null; }
            const w = C.parseWidget(ans); if (o.onProgress) { try { o.onProgress({ done: ++progress, total: cells.length }); } catch (_) { /* */ } }
            return { cell, rect, widget: w.widget, role: w.role, confidence: w.confidence, raw: trimText(ans), crop };
        };
        let progress = 0; const rows = await mapPool(cells, o.concurrency || 1, run);
        const kept = []; rows.forEach((r) => { if (!r) return; out.push({ col: r.cell.col, row: r.cell.row, rect: r.rect, widget: r.widget, raw: r.raw }); if (r.widget && r.widget !== 'none') kept.push(r); });
        const cands = [];
        for (let i = 0; i < kept.length; i++) {
            const k = kept[i]; let text = null;
            if (o.ocr && ['button', 'link', 'tab', 'label', 'menu', 'textbox', 'checkbox'].includes(k.widget)) { try { const t = trimText(await deps.ask(k.crop.dataUrl, Q.text)); asked++; if (t && !/^none\b/i.test(t)) text = t; } catch (_) { /* 沒有 OCR 也能用 */ } }
            cands.push(C.makeVlmElement({ shotId: shot.shotId, n: i + 1, rect: k.rect, widget: k.widget, role: k.role, confidence: k.confidence, name: text || '', text, cell: { col: k.cell.col, row: k.cell.row, cols: g.cols, rows: g.rows }, states: ['unverified'] }));
        }
        if (failed) notes.push(failed + ' 格看圖失敗');
        notes.push('這些元件是弱視覺模型對每一格的「封閉詞彙」回答（confidence 很低，位置只有格子精度）；點擊前請先用 verify（移動滑鼠→看游標與周圍變化）。');
        return { ok: true, grid: g, candidates: C.mergeCandidates(cands, 0.6), cells: out, asked, notes };
    }

    // ===== 2. 定位 =====
    // 找「X」：逐格問 yes/no，有的格再切 3×3 縮小範圍。回傳最可能的幾個位置（螢幕座標框與中心點）。
    async function locate(deps, shot, what, o) {
        o = o || {}; const g = o.cols && o.rows ? { cols: o.cols, rows: o.rows } : C.chooseGrid(shot.width, shot.height, { maxCellPx: o.maxCellPx || 320, maxCells: o.maxCells || 20 });
        const cells = C.gridCells(shot.width, shot.height, g.cols, g.rows), hits = []; let asked = 0;
        for (const cell of cells) {
            if (o.signal && o.signal.aborted) break; const rect = C.imageBoxToScreen(shot, cell); const crop = await deps.crop(shot.shotId, rect, { maxSide: 288 }); if (!crop || !crop.ok) continue;
            let yn = null; try { yn = C.parseYesNo(await deps.ask(crop.dataUrl, Q.has(what))); asked++; } catch (_) { continue; }
            if (yn === true) hits.push({ cell, rect, level: 1 });
        }
        // 第二層：有的格切 3×3 再問一次，縮小範圍
        const refined = [];
        for (const h of hits.slice(0, o.maxRefine || 4)) {
            let best = null; const subs = C.subCells(h.cell, 3);
            for (const sc of subs) {
                const rect = C.imageBoxToScreen(shot, sc); if (rect.w < 12 || rect.h < 12) continue; const crop = await deps.crop(shot.shotId, rect, { maxSide: 224 }); if (!crop || !crop.ok) continue;
                let yn = null; try { yn = C.parseYesNo(await deps.ask(crop.dataUrl, Q.has(what))); asked++; } catch (_) { continue; }
                if (yn === true) { best = best ? Object.assign({}, best, { rect: C.union(best.rect, rect), subs: best.subs + 1 }) : { rect, subs: 1 }; }
            }
            refined.push(best ? { rect: best.rect, confidence: 0.35 + 0.05 * Math.min(4, best.subs), level: 2 } : { rect: h.rect, confidence: 0.25, level: 1 });
        }
        const elements = C.mergeCandidates(refined.map((r, i) => C.makeVlmElement({ shotId: shot.shotId, n: i + 1, rect: r.rect, widget: null, role: 'unknown', name: what, confidence: r.confidence, states: ['unverified'], verified: null })), 0.4);
        return { ok: true, query: what, found: elements.length, elements: elements.map((e) => Object.assign(e, { center: C.center(e.rect) })), asked, hint: elements.length ? '位置只有格子精度；點擊前先 verify（hover_probe），或縮小範圍再問一次' : '這張圖裡沒找到「' + what + '」（弱模型可能漏看：換個說法、放大那個區域再問）' };
    }

    // ===== 3. 驗證：探索 → 移動 → 拍照 → 比對 =====
    // cands：element 陣列。回傳同一批元件（附 verified 與調整後的 confidence／role）。deps.probe 會讓使用者核准一次（整批一個預覽）。
    async function verify(deps, cands, o) {
        o = o || {}; const picked = C.pickForProbe(cands, o.max || 8); if (!picked.length) return { ok: true, verified: [], skipped: cands.length, note: '沒有需要驗證的候選' };
        const points = picked.map((c) => Object.assign({ id: c.id }, C.center(c.rect), { radius: Math.max(16, Math.min(60, Math.round(Math.min(c.rect.w, c.rect.h) / 2))) }));
        const res = await deps.probe(points); if (!res || res.ok === false) return { ok: false, error: (res && res.error) || '探索沒有執行', refused: !!(res && res.refused), verified: [] };
        const byId = new Map(); (res.steps || res.results || []).forEach((r, i) => { if (r && r.probe) byId.set(points[i].id, r.probe); });
        const out = cands.map((c) => (byId.has(c.id) ? C.applyProbe(c, byId.get(c.id)) : c));
        return { ok: true, verified: out.filter((c) => c.verified && c.verified.by === 'hover_probe'), all: out, probed: byId.size };
    }

    // ===== 4. 描述（整張或一塊）=====
    async function describe(deps, shot, o) {
        o = o || {}; let dataUrl = shot.dataUrl; if (o.rect) { const c = await deps.crop(shot.shotId, o.rect, { maxSide: o.maxSide || 512 }); if (!c || !c.ok) return { ok: false, error: (c && c.error) || '裁切失敗' }; dataUrl = c.dataUrl; }
        const q = o.question || Q.describe; const text = trimText(await deps.ask(dataUrl, q)); return { ok: true, description: text, question: q };
    }

    // ===== 5. 動畫與校準（薄包裝：邏輯在主行程，這裡只翻成給模型看的建議）=====
    async function sampleAnimation(deps, target) { const r = await deps.sample(target); if (!r || !r.ok) return r || { ok: false, error: '取樣失敗' }; return Object.assign({}, r, { advice: r.animated ? '這個區塊在動：用 computer_describe 搭配 stream 連續觀察，不要用單張截圖判斷狀態' : '這個區塊是靜態的，單張截圖就夠' }); }
    async function calibrate(deps) { const r = await deps.calibrate(); if (!r || !r.ok) return r || { ok: false, error: '校準失敗' }; return Object.assign({}, r, { advice: r.apply ? '座標比例不是 1（' + r.scale.x + '×' + r.scale.y + '），之後的點擊已自動補償' : r.calibrated ? '座標比例正常（誤差 ' + r.maxErrorPx + 'px），不需要補償' : (r.note || '讀不到游標位置，無法校準') }); }

    // ===== 6. 一條龍：看整個畫面 → 找候選 → 驗證最可疑的幾個 =====
    async function explore(deps, shot, o) {
        o = o || {}; const scan = await tileScan(deps, shot, o); if (!scan.ok) return scan;
        let cands = scan.candidates, verified = null;
        if (o.verify !== false && cands.length) { const v = await verify(deps, cands, { max: o.maxProbes || 6 }); if (v.ok && v.all) { cands = v.all; verified = v.probed; } else verified = { error: v.error, refused: v.refused }; }
        cands = cands.slice().sort((a, b) => b.confidence - a.confidence);
        return { ok: true, grid: scan.grid, candidates: cands, verifiedCount: typeof verified === 'number' ? verified : 0, verifyNote: verified && verified.error ? verified.error : undefined, asked: scan.asked, notes: scan.notes };
    }

    return { Q, WIDGET_SYN, mapPool, tileScan, locate, verify, describe, sampleAnimation, calibrate, explore };
});
