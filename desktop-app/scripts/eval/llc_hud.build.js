// node scripts/eval/llc_hud.build.js <輸出檔>：內嵌 gpgpu/nbody3d(.ll、_cl.ll)、fluid3d(.ll、_cl.ll) 與 7×13 點陣字型（_gen/_font_data.py）到 llc_hud.eval.js。
// 執行：FA_EVAL_GL=swiftshader FA_EVAL_TIMEOUT_MS=1500000 node scripts/eval/run_eval.js <輸出檔>
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const rd = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dir = path.join(root, 'renderer/src/examples/llc/gpgpu');
const LL = {};
for (const f of ['nbody3d.ll', 'nbody3d_cl.ll', 'fluid3d.ll', 'fluid3d_cl.ll']) LL[f.replace(/\.ll$/, '')] = fs.readFileSync(path.join(dir, f), 'utf8');
// 螢幕說明（HUD）檢查表用的互動範例（DESIGN.run-terminal.md §21.y）：鍵名就是檔名（不含副檔名）
for (const rel of ['gui/music_player.ll', 'gui/midi_player.ll', 'gui/sdl2_gl_triangle.ll', 'game/sdl2_piano.ll', 'game/sdl2_pong.ll']) {
    LL[path.basename(rel, '.ll')] = fs.readFileSync(path.join(root, 'renderer/src/examples/llc', rel), 'utf8');
}
const fontSrc = rd('renderer/src/examples/llc/_gen/_font_data.py');
const m = fontSrc.match(/ROWS = \[([\s\S]*?)\]/);
if (!m) throw new Error('找不到 ROWS');
const ROWS = (m[1].match(/0x[0-9A-Fa-f]+/g) || []).map((h) => parseInt(h, 16));
if (ROWS.length !== 95 * 13) throw new Error('字型列數不對：' + ROWS.length);
const SRC = { LL, ROWS };
const body = fs.readFileSync(path.join(__dirname, 'llc_hud.eval.js'), 'utf8').replace('const SRC = __SRC__;', () => 'const SRC = ' + JSON.stringify(SRC) + ';');
const out = process.argv[2];
if (!out) { console.error('用法：node scripts/eval/llc_hud.build.js <輸出檔>'); process.exit(2); }
fs.writeFileSync(out, body);
console.log('wrote ' + out + ' (' + body.length + ' bytes)');
