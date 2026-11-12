// node scripts/media-tests/image3d_wiring.test.js
// 2026-11-12 真實事故：貼圖用說的「把這張圖轉3D」，模型回「沒有圖片轉 3D 的工具」——image_to_3d 工具存在，卻不在任何領域的工具清單、也沒有自然語言觸發提示；
// 工具參數有 detail／max_faces／pose，處理程式卻沒有傳下去。這個測試守住接線（原始碼檢查，不啟動產品）。
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'src', 'floating-assistant.js'), 'utf8');
let ok = 0, bad = 0; const check = (n, c) => { if (c) ok++; else { bad++; console.log('FAIL ' + n); } };
const toolNamesOf = (key) => { const i = SRC.indexOf('\n    ' + key + ': {'); if (i < 0) return []; const m = /toolNames: \[([^\]]*)\]/.exec(SRC.slice(i, i + 4000)); return m ? m[1].split(',').map((x) => x.replace(/['\s]/g, '')) : []; };
check('scene_3d 領域有 image_to_3d', toolNamesOf('scene_3d').includes('image_to_3d'));
check('editors 領域有 image_to_3d', toolNamesOf('editors').includes('image_to_3d'));
const reg = /registerOptional\('image_to_3d',[\s\S]*?this\._imageTo3d\(\{([^}]*)\}\)/.exec(SRC); const args = reg ? reg[1] : '';
for (const k of ['image', 'request', 'subject', 'subject_name', 'segment', 'detail', 'max_faces', 'pose', 'depth_scale', 'thickness_scale']) check('處理程式傳下去：' + k, new RegExp('\\b' + k + ': a\\.' + k + '\\b').test(args));
const hint = /FA_TASK_TOOL_HINTS\.push\(\{\s*id: 'image_to_3d',\s*re: (\/.*\/i),\s*neg: (\/.*\/i),\s*tools: \[([^\]]*)\]/.exec(SRC);
check('有自然語言觸發提示', !!hint);
if (hint) {
  const re = eval(hint[1]), neg = eval(hint[2]), hit = (t) => re.test(t) && !neg.test(t);
  check('提示命中：把這張圖轉3D 中間的老鼠要足夠精細', hit('把這張圖轉3D 中間的老鼠要足夠精細'));
  check('提示命中：請把附件圖片轉成3D模型', hit('請把附件圖片轉成3D模型'));
  check('提示命中：把這張照片做成立體模型', hit('把這張照片做成立體模型'));
  check('提示不誤中：怎麼把圖片轉3D（問用法）', !hit('怎麼把圖片轉3D'));
  check('提示不誤中：簡報、3D 場景、轉 pdf', !hit('做一份關於3D的簡報') && !hit('幫我寫一個3D場景') && !hit('把圖片轉成pdf'));
  check('提示給的工具含 image_to_3d', /image_to_3d/.test(hint[3]));
}
check('斜線指令用法列有 --detail 與 --max-faces', /\[--detail 1\|2\|3\] \[--max-faces 面數\]/.test(SRC));
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
