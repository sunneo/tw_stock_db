// node scripts/game-tests/game_import.test.js -- /edit-game-2d、3d 📂 開啟 .fagame：維度檢查（2D 不收 3D 包，反之亦然）、遊戲包往返（需要 jszip，沒有就略過）
const G = require('../../renderer/src/game/game_core.js');
const PK = require('../../renderer/src/game/game_pack.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

// 1. 維度檢查
{
  const sp2 = G.starter('topdown-free');
  const sp3 = G.starter('walker-3rd');
  check('2D 包進 2D 編輯器通過', PK.dimensionProblem(sp2, '2d') === null, PK.dimensionProblem(sp2, '2d'));
  check('3D 包進 3D 編輯器通過', PK.dimensionProblem(sp3, '3d') === null, PK.dimensionProblem(sp3, '3d'));
  const b1 = PK.dimensionProblem(sp3, '2d');
  check('3D 包進 2D 編輯器拒絕並說明', typeof b1 === 'string' && /3D/.test(b1) && /edit-game-3d/.test(b1), b1);
  const b2 = PK.dimensionProblem(sp2, '3d');
  check('2D 包進 3D 編輯器拒絕並說明', typeof b2 === 'string' && /2D/.test(b2) && /edit-game-2d/.test(b2), b2);
}

// 2. 遊戲包往返（需要 jszip；找不到就略過，同 game_parts.test.js 的做法）
(async () => {
  let JSZip = null;
  for (const p of [process.env.FA_JSZIP, 'jszip']) { if (!p) continue; try { JSZip = require(p); break; } catch (_) { /* 找下一個 */ } }
  if (!JSZip) { console.log('game_import: 遊戲包往返略過（這台 node 找不到 jszip）'); }
  else {
    const P = PK.create(JSZip);
    const sp = G.starter('topdown-free');
    const bytes = await P.pack(sp, { assets: {}, modified: '2026-11-26' });
    const back = await P.open(bytes);
    check('往返：標題一樣', back.spec.game.title === sp.game.title, back.spec.game.title);
    check('往返：維度檢查通過', PK.dimensionProblem(back.spec, '2d') === null);
  }
  console.log('game_import: ' + ok + ' 通過，' + bad.length + ' 失敗');
  if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
