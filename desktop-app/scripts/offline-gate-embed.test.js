// 語意向量檢索的純函式部分（排名、z 分數、門檻、詞表），以及沒同意就不下載（不載入模型、不改變探索結果）。模型本身的實測在 scripts/eval/offline-open-embed.electron.eval.js。
const fs = require('fs'), path = require('path');
const G = require('../renderer/src/offline/intent_gate.js');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else fail++; console.log((c ? 'ok   ' : 'FAIL ') + m); };
const terms = G.embedTerms();
ok(terms.length > 100 && terms.every((t) => t.kind && t.text && !/[\\()]/.test(t.text)), '詞表：每個種類的名稱、名詞、相關詞彙各成一段，沒有殘留的規則符號（' + terms.length + ' 段）');
ok(new Set(terms.map((t) => t.kind)).size >= 18, '詞表涵蓋大部分種類');
ok(G.embedQuery('叫出今年的損益表 [附件：a（file_id=1）]') === '今年 損益表', '句子先去掉動詞與附件標記再算向量');
// 假向量：兩維，種類 a 在 (1,0)，b 在 (0,1)，其餘種類在 (0.7,0.7) 附近
const mk = (kind, x, y) => { const n = Math.hypot(x, y); return { kind, v: [x / n, y / n] }; };
const T = [mk('docx', 1, 0), mk('xlsx', 0, 1), mk('deck', 1, 1), mk('video', 1, -1), mk('music', -1, 1), mk('svg', -1, -1), mk('csv', 1, 0.2)];
let r = G.rankEmbedded([1, 0], T);
ok(r[0].kind === 'docx' && r[0].z > r[1].z, '排名：最像的排第一');
ok(G.pickEmbedded([{ kind: 'a', z: 2.4 }, { kind: 'b', z: 1.2 }]) && !G.pickEmbedded([{ kind: 'a', z: 2.4 }, { kind: 'b', z: 2.1 }]), '門檻：夠突出且領先第二名夠多才採用');
ok(!G.pickEmbedded([{ kind: 'a', z: 1.4 }, { kind: 'b', z: 0.2 }]), '門檻：第一名不夠突出就不採用（相似度擠在一起的模型不能只看相對名次）');
ok(G.pickEmbedded([]) === null, '空結果不採用');
// 沒同意不下載：模擬沒有同意旗標、使用者按「先不要」→ 不載入模型
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8');
ok(/fa_gate_embed_consent/.test(src) && /要下載語意向量模型嗎/.test(src) && /M\.approxMB/.test(src) && /M\.repo/.test(src), '接線：第一次要先問，並寫明檔名、大小、來源');
const i = src.indexOf('async _otGateEmbedRank('), j = src.indexOf('// 探索（內建在迴圈裡）', i);
const body = src.slice(i, j);
ok(body.indexOf('先不要') > 0 && body.indexOf("'下載並啟用'") > 0 && body.indexOf('_unitCatalogEmbedder()') > body.indexOf('你沒有同意下載'), '接線：沒同意就在載入模型之前離開');
console.log(pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
