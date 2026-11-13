// node renderer/src/studio/image_lora_core.test.js
const L = require('./image_lora_core.js');
let ok = 0, bad = 0;
const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); } };
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6);

// 圖文配對
const good = [{ image: 'imgs/000.png', caption: 'a red circle on a white background' }, { image: 'imgs/001.png', caption: ' a blue square ' }];
let v = L.validatePairs(good);
check('配對正常通過', v.ok === true && v.pairs.length === 2 && v.pairs[1].caption === 'a blue square', v);
check('配對 caption 會去頭尾空白', v.pairs[1].caption === 'a blue square');
check('不是陣列拒絕', L.validatePairs({}).ok === false);
check('只有一組拒絕', L.validatePairs([good[0]]).ok === false);
check('缺 caption 拒絕', L.validatePairs([{ image: 'a.png', caption: '  ' }, good[0]]).ok === false);
check('絕對路徑拒絕', L.validatePairs([{ image: '/etc/x.png', caption: 'x' }, good[0]]).ok === false);
check('上一層路徑拒絕', L.validatePairs([{ image: '../x.png', caption: 'x' }, good[0]]).ok === false);
check('Windows 磁碟路徑拒絕', L.validatePairs([{ image: 'C:/x.png', caption: 'x' }, good[0]]).ok === false);
check('非圖片副檔名拒絕', L.validatePairs([{ image: 'x.txt', caption: 'x' }, good[0]]).ok === false);
check('重複圖片拒絕', L.validatePairs([good[0], good[0]]).ok === false);
check('反斜線路徑會正規化', L.validatePairs([{ image: 'imgs\\a.png', caption: 'x' }, good[0]]).pairs[0].image === 'imgs/a.png');
check('錯誤會一次全報', L.validatePairs([{ image: '', caption: '' }, { image: '/x.png', caption: 'y' }]).errors.length >= 3);

// 訓練設定
let p = L.planTrain({});
check('預設設定通過', p.ok && p.config.rank === 8 && p.config.alpha === 8 && p.config.resolution === 512 && p.config.steps === 40, p);
check('預設有時間預估', p.notes.length === 1 && /約 \d+ 分鐘/.test(p.notes[0]), p.notes);
check('alpha 沒給等於 rank', L.planTrain({ rank: 4 }).config.alpha === 4);
check('rank 超範圍拒絕', L.planTrain({ rank: 0 }).ok === false && L.planTrain({ rank: 65 }).ok === false);
check('rank 非整數拒絕', L.planTrain({ rank: 2.5 }).ok === false);
check('步數超範圍拒絕', L.planTrain({ steps: 0 }).ok === false && L.planTrain({ steps: 2001 }).ok === false);
check('學習率超範圍拒絕', L.planTrain({ lr: 0 }).ok === false && L.planTrain({ lr: 0.02 }).ok === false);
check('seed 負數拒絕', L.planTrain({ seed: -1 }).ok === false);
check('解析度不是 512 拒絕', L.planTrain({ resolution: 256 }).ok === false);
check('拒絕時 config 為 null', L.planTrain({ rank: 0 }).config === null);

// 中繼資料
const meta = { format: 'fa-sdxs-lora-v1', rank: '8', alpha: '8', base_repo: 'IDKiro/sdxs-512-dreamshaper', base_rev: '76f720262bb051da75666b22c902a78c8e16c763', resolution: '512', steps: '40', seed: '1234', loss_before: '0.5', loss_after: '0.4', targets: 'attn1.to_q,attn1.to_k' };
let pm = L.parseMeta(meta);
check('中繼資料正確解析', pm.ok && pm.meta.rank === 8 && pm.meta.alpha === 8 && pm.meta.targets.length === 2 && pm.meta.lossAfter === 0.4, pm);
check('格式錯拒絕', L.parseMeta(Object.assign({}, meta, { format: 'other' })).ok === false);
check('rank 錯拒絕', L.parseMeta(Object.assign({}, meta, { rank: '0' })).ok === false);
check('基底版本不是 40 位拒絕', L.parseMeta(Object.assign({}, meta, { base_rev: 'main' })).ok === false);
check('沒有 meta 拒絕', L.parseMeta(null).ok === false);

// 套用縮放
const ms = L.mergeScale({ rank: 8, alpha: 16 }, 1);
check('alpha/rank·強度', ms.ok && near(ms.scale, 2), ms);
check('強度夾在 0 到 2', L.mergeScale({ rank: 8, alpha: 8 }, 5).strength === 2 && L.mergeScale({ rank: 8, alpha: 8 }, -1).strength === 0);
check('強度超過要標記', L.mergeScale({ rank: 8, alpha: 8 }, 5).clamped === true);
check('強度非數字拒絕', L.mergeScale({ rank: 8, alpha: 8 }, 'x').ok === false);

// 合併數學：2×3 的 W，rank 1
const W = new Float32Array([1, 2, 3, 4, 5, 6]);
const A = new Float32Array([1, 0, -1]);          // rank×in = 1×3
const B = new Float32Array([2, 0.5]);             // out×rank = 2×1
const R = L.mergeLinear(W, A, B, 2, 3, 1, 0.5);
// B·A = [[2,0,-2],[0.5,0,-0.5]]；×0.5 = [[1,0,-1],[0.25,0,-0.25]]
check('合併數學（手算）', near(R[0], 2) && near(R[1], 2) && near(R[2], 2) && near(R[3], 4.25) && near(R[4], 5) && near(R[5], 5.75), Array.from(R));
check('合併不改原來的 W', W[0] === 1 && W[5] === 6);
check('形狀不符丟錯', (() => { try { L.mergeLinear(W, A, B, 3, 3, 1, 1); return false; } catch (e) { return /形狀/.test(e.message); } })());
check('mse 已知值', near(L.mse([1, 2], [0, 0]), 2.5));
check('mse 長度不符丟錯', (() => { try { L.mse([1], [1, 2]); return false; } catch (e) { return true; } })());

check('describe 給格式與目標', L.describe().format === 'fa-sdxs-lora-v1' && L.TARGETS.length === 8);

console.log('image_lora_core: ' + ok + ' 通過，' + bad + ' 失敗');
process.exit(bad ? 1 : 0);
