// node renderer/src/uml/llvm_hud.test.js -- 螢幕說明（HUD）的文字繪製（DESIGN.run-terminal.md §21.y）：
// _gen/_hud.py 產生的 hud_text／hud_int 畫出的矩形，必須與 7×13 字型逐像素相同、順序相同（同一列的連續亮像素合併成一個矩形）。
// 固定 IR 由 `python _gen/_hud.py` 產生（_gen/_hud_test.ll）；這裡用自己的 SDL_RenderFillRect 記錄矩形，不需要視窗。
const fs = require('fs'), path = require('path');
const L = require('./llvm_core.js'), H = require('./llvm_host.js');
const GEN = path.join(__dirname, '../examples/llc/_gen');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 240) : '')); };

// 字型（與 _font_data.py 同一份資料）
const fontSrc = fs.readFileSync(path.join(GEN, '_font_data.py'), 'utf8');
const mm = fontSrc.match(/ROWS = \[([\s\S]*?)\]/);
const ROWS = (mm[1].match(/0x[0-9A-Fa-f]+/g) || []).map((h) => parseInt(h, 16));

// 期望的繪圖：依 hud_text 的規則，每列由左到右、連續亮的像素合成一段（跨字元也合併）
const expectRuns = (str, x0, y0) => {
    const bytes = [...str].map((ch) => ch.charCodeAt(0) & 255);
    const n = bytes.length, runs = [];
    for (let r = 0; r < 13; r++) {
        let start = -1;
        for (let X = 0; X <= 7 * n; X++) {
            let lit = false;
            if (X < 7 * n) {
                let c = bytes[Math.floor(X / 7)]; if (c < 32 || c > 126) c = 32;
                lit = ((ROWS[(c - 32) * 13 + r] >> (6 - (X % 7))) & 1) === 1;
            }
            if (lit && start < 0) start = X;
            if (!lit && start >= 0) { runs.push([x0 + start, y0 + r, X - start, 1]); start = -1; }
        }
    }
    return runs;
};

(async () => {
    const memfs = new Map();
    const fsx = { read: (p) => (memfs.has(p) ? memfs.get(p) : null), write: (p, bytes) => { memfs.set(p, new Uint8Array(bytes)); }, exists: (p) => memfs.has(p), remove: (p) => memfs.delete(p) };
    const host = H.create({ gui: async () => null, fs: fsx }); host.install(L);
    const ir = fs.readFileSync(path.join(GEN, '_hud_test.ll'), 'utf8');
    const c = L.compileIr(ir, {});
    check('測試用 IR 編得出來', !!c.wasm, c.errors);
    if (!c.wasm) { console.log('llvm_hud.test: 編譯失敗', c.errors); process.exit(1); }
    const dec = {}; for (const d of L.parse(ir).mod.declares) dec[d.name] = d;
    const rects = [];
    const impls = Object.assign({}, host.impls, {
        SDL_SetRenderDrawColor: () => 0,
        SDL_RenderFillRect: (ctx, p, rc) => { const dv = ctx.dv(); rects.push([dv.getInt32(rc, true), dv.getInt32(rc + 4, true), dv.getInt32(rc + 8, true), dv.getInt32(rc + 12, true)]); return 0; },
    });
    const o = await L.runHost(c.wasm, { args: ['prog'] }, impls, undefined, dec);
    check('測試用程式正常結束', o.exitCode === 0, o);

    // 呼叫順序：hud_text("MUSIC BOX",3,5)、hud_int(105 @40,5)、hud_int(7 @70,5)、hud_text("UP DOWN TEMPO",3,40)、hud_text("A\xE4B"→空白,3,60)
    const exp = [
        ...expectRuns('MUSIC BOX', 3, 5),
        ...expectRuns('105', 40, 5),
        ...expectRuns('  7', 70, 5),
        ...expectRuns('UP DOWN TEMPO', 3, 40),
        ...expectRuns('A B', 3, 60),
        ...expectRuns('ESC QUIT  NOTES PLAYED ', 3, 80),
        ...expectRuns('000', 3, 100),
    ];
    check('矩形的數量與順序', rects.length === exp.length, { got: rects.length, want: exp.length });
    let firstDiff = -1;
    for (let i = 0; i < Math.min(rects.length, exp.length); i++) if (rects[i].join(',') !== exp[i].join(',')) { firstDiff = i; break; }
    check('每個矩形逐一相同（位置與長度）', firstDiff < 0 && rects.length === exp.length, firstDiff >= 0 ? { i: firstDiff, got: rects[firstDiff], want: exp[firstDiff] } : undefined);
    // 非 ASCII 位元組（0xE4）不應出現在任何矩形之外的地方：空白字不畫，所以 "A\xE4B" 的矩形＝ "A B" 的矩形
    const tailLen = expectRuns('ESC QUIT  NOTES PLAYED ', 0, 0).length + expectRuns('000', 0, 0).length;
    const abExp = expectRuns('A B', 3, 60), abGot = rects.slice(rects.length - tailLen - abExp.length, rects.length - tailLen);
    check('非 ASCII 位元組畫成空白', abGot.length === abExp.length && abGot.every((r, i) => r.join(',') === abExp[i].join(',')), abGot);
    check('繪圖次數＝同列連續亮像素段數（MUSIC BOX 應為 103 段）', expectRuns('MUSIC BOX', 0, 0).length === 103, expectRuns('MUSIC BOX', 0, 0).length);

    if (bad.length) { console.log('llvm_hud.test 失敗 ' + bad.length + ' 項：\n  ' + bad.join('\n  ')); process.exit(1); }
    console.log('llvm_hud.test 全部通過（' + ok + ' 項）');
})().catch((e) => { console.error(e); process.exit(1); });
