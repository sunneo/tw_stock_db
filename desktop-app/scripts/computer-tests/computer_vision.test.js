// node scripts/computer-tests/computer_vision.test.js -- computer_vision.js：切磚、定位、驗證、探索、動畫與校準（用假的視覺模型，程式負責座標與驗證）
const V = require('../../renderer/src/computer/computer_vision.js');
const C = require('../../renderer/src/computer/computer_core.js');
const { suite } = require('./_t.js');
const t = suite('computer_vision');

// 假螢幕：1000x600，origin(0,0) scale 0.5（截圖縮成 500x300）。真實畫面裡：一顆按鈕在 (700..780, 100..140)、一個輸入框在 (100..400, 300..340)、其餘是空白
const REAL = { button: { x: 700, y: 100, w: 80, h: 40 }, input: { x: 100, y: 300, w: 300, h: 40 } };
const hit = (rect, box) => !!C.intersect(rect, box);
let asked = [];
// 假的視覺模型：依「被問的那一塊（螢幕座標）」回答，行為像弱模型——只回封閉詞彙；看到的內容是 crop 時傳進來的 rect 決定的
const mkDeps = (o) => {
    o = o || {};
    return {
        crop: async (shotId, rect, opt) => ({ ok: true, dataUrl: 'crop:' + JSON.stringify(rect), origin: { x: rect.x, y: rect.y }, scale: { x: 1, y: 1 }, width: rect.w, height: rect.h }),
        ask: async (dataUrl, q) => {
            const rect = JSON.parse(dataUrl.replace('crop:', '')); asked.push(q.slice(0, 30));
            if (o.failAsk) throw new Error('model down');
            if (/exactly one word/.test(q)) { if (hit(rect, REAL.button)) return 'button'; if (hit(rect, REAL.input)) return 'text field'; return 'none'; }
            if (/Is there/.test(q)) { const what = /Is there (.*) in this/.exec(q)[1]; const box = /button|OK/i.test(what) ? REAL.button : /input|field|text/i.test(what) ? REAL.input : null; return box && hit(rect, box) ? 'Yes' : 'No'; }
            if (/Read the text/.test(q)) return hit(rect, REAL.button) ? 'OK' : 'none';
            return 'A window.';
        },
        probe: async (points) => {
            const steps = points.map((p) => { const inB = C.inside(REAL.button, p.x, p.y), inI = C.inside(REAL.input, p.x, p.y); return { op: 'hover_probe', ok: true, probe: { x: p.x, y: p.y, cursor: { kind: inB ? 'clickable' : inI ? 'text' : 'default' }, cursorChanged: inB || inI, regionChanged: inB, changeRatio: inB ? 0.05 : 0, interactive: inB || inI } }; });
            return { ok: true, steps };
        },
        sample: async () => ({ ok: true, animated: false, ratios: [0, 0] }), calibrate: async () => ({ ok: true, calibrated: true, scale: { x: 1, y: 1 }, maxErrorPx: 0, apply: false }),
    };
};
const shot = { shotId: 's1', origin: { x: 0, y: 0 }, scale: { x: 0.5, y: 0.5 }, width: 500, height: 300, dataUrl: 'data:full' };

(async () => {
  asked = []; let r = await V.tileScan(mkDeps(), shot, { cols: 5, rows: 3, ocr: true });
  await t.acheck('tileScan：每格只問封閉問題；找到按鈕與輸入框兩個候選；位置是格子的螢幕座標（不是模型猜的）', async () => { const b = r.candidates.find((c) => c.role === 'button'), i = r.candidates.find((c) => c.role === 'textbox'); return { ok: r.ok && !!b && !!i && hit(b.rect, REAL.button) && hit(i.rect, REAL.input) && b.source === 'vlm' && b.confidence > 0 && b.confidence < 0.9 && b.states.includes('unverified') && b.text === 'OK', c: r.candidates.map((c) => c.role + JSON.stringify(c.rect)) }; });
  await t.acheck('tileScan：問題都是封閉詞彙問題（每格一題＋OCR）、沒有開放式提問', async () => asked.filter((q) => /What kind/.test(q)).length === 15 && asked.every((q) => /What kind|Read the text/.test(q)));
  await t.acheck('tileScan：格子座標涵蓋整個螢幕（0..1000×0..600），且帶 cell 資訊', async () => r.cells.length === 15 && r.cells[0].rect.x === 0 && r.cells[14].rect.x + r.cells[14].rect.w >= 995 && r.cells[14].rect.y + r.cells[14].rect.h >= 595 && r.candidates[0].cell.cols === 5);
  r = await V.tileScan(mkDeps({ failAsk: true }), shot, { cols: 2, rows: 2 });
  await t.acheck('tileScan：視覺模型壞掉 → 不丟例外、回報失敗格數', async () => r.ok && r.candidates.length === 0 && r.notes.some((n) => /看圖失敗/.test(n)));
  const auto = await V.tileScan(mkDeps(), { shotId: 's1', origin: { x: 0, y: 0 }, scale: 1, width: 1280, height: 800 }, {});
  await t.acheck('tileScan：沒指定格數時依大小自動分格（約 256px 一格）', async () => auto.grid.cols === 5 && auto.grid.rows === 3);

  // ---- 定位
  const loc = await V.locate(mkDeps(), shot, 'the OK button', { cols: 5, rows: 3 });
  await t.acheck('locate：找「the OK button」→ 一個元素、中心點落在真正的按鈕內（兩層 yes/no 縮小範圍）', async () => loc.ok && loc.found >= 1 && C.inside(REAL.button, loc.elements[0].center.x, loc.elements[0].center.y) && loc.elements[0].states.includes('unverified') && /verify|hover_probe|縮小/.test(loc.hint), loc.elements.map((e) => JSON.stringify(e.rect) + JSON.stringify(e.center)));
  const none = await V.locate(mkDeps(), shot, 'a purple unicorn', { cols: 5, rows: 3 }); await t.acheck('locate：找不到 → found 0 並給建議', async () => none.found === 0 && /沒找到/.test(none.hint));

  // ---- 驗證
  const cands = (await V.tileScan(mkDeps(), shot, { cols: 5, rows: 3 })).candidates;
  const ver = await V.verify(mkDeps(), cands, {});
  await t.acheck('verify：對候選做 hover_probe（移動→拍照→比對），游標形狀與區域變化回寫成 verified、信心與角色調整', async () => { const b = ver.all.find((c) => hit(c.rect, REAL.button) && c.role === 'button'), i = ver.all.find((c) => hit(c.rect, REAL.input) && c.role === 'textbox'); return { ok: ver.ok && ver.probed >= 2 && b.verified.by === 'hover_probe' && b.verified.verdict === 'interactive' && b.verified.cursor.kind === 'clickable' && i.verified.cursor.kind === 'text' && b.confidence > cands.find((c) => c.id === b.id).confidence, probed: ver.probed }; });
  const denied = await V.verify({ probe: async () => ({ ok: false, error: '使用者拒絕', refused: true }) }, cands, {}); await t.acheck('verify：使用者拒絕核准 → ok:false、refused，不丟例外', async () => !denied.ok && denied.refused === true);
  await t.acheck('verify：沒有需要驗證的 → 不呼叫 probe', async () => { let n = 0; const rr = await V.verify({ probe: async () => { n++; return { ok: true, steps: [] }; } }, [], {}); return rr.ok && n === 0; });

  // ---- 探索一條龍、描述、動畫、校準
  const ex = await V.explore(mkDeps(), shot, { cols: 5, rows: 3 });
  await t.acheck('explore：切磚→驗證→依信心排序；被驗證過的互動元件排前面', async () => ex.ok && ex.verifiedCount >= 2 && ex.candidates[0].verified && ex.candidates[0].verified.verdict === 'interactive' && ex.candidates.every((c, i, a) => i === 0 || a[i - 1].confidence >= c.confidence));
  const ex2 = await V.explore(mkDeps(), shot, { cols: 5, rows: 3, verify: false }); await t.acheck('explore：verify:false 時不呼叫 probe（不需要使用者核准）', async () => ex2.ok && ex2.verifiedCount === 0 && ex2.candidates.every((c) => !c.verified));
  const d = await V.describe(mkDeps(), shot, { rect: { x: 0, y: 0, w: 300, h: 200 }, question: 'What is this?' }); await t.acheck('describe：裁切指定範圍再問（螢幕座標）', async () => d.ok && d.description === 'A window.' && d.question === 'What is this?');
  const an = await V.sampleAnimation({ sample: async () => ({ ok: true, animated: true, ratios: [0.1, 0.2] }) }, { windowId: 'w' }); await t.acheck('sampleAnimation：在動 → 建議用連續觀察串流', async () => an.animated && /串流|連續/.test(an.advice));
  const cal = await V.calibrate({ calibrate: async () => ({ ok: true, calibrated: true, scale: { x: 1.5, y: 1.5 }, maxErrorPx: 30, apply: true }) }); await t.acheck('calibrate：比例不是 1 → 說明已自動補償', async () => cal.ok && /自動補償/.test(cal.advice));
  const cal2 = await V.calibrate({ calibrate: async () => ({ ok: true, calibrated: false, note: '讀不到游標位置' }) }); await t.acheck('calibrate：無法校準 → 說明原因', async () => /讀不到游標位置/.test(cal2.advice));
  const pool = []; await V.mapPool([1, 2, 3, 4, 5, 6], 2, async (x) => { pool.push(x); await new Promise((r) => setTimeout(r, 5)); return x; }); await t.acheck('mapPool 併發上限（不亂序也不漏）', async () => pool.length === 6);
  t.done();
})();
