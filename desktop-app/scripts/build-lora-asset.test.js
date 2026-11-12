'use strict';
// node scripts/build-lora-asset.test.js — 出貨腳本的測試（不需要真的模型）：
// 1) 正常產出的 .fatrain 讀回來：描述檔的 size／sha256 是實際打包的 lora.bin、base 是 HF 名稱、版本與已知限制在 manifest.extra.lora
// 2) 大小不對、缺 model_card、描述檔不合法、card 不合法都要拒絕產出（不靜默）
// 3) data_sha256 由訓練檔「內容」算出：沒有訓練檔、雜湊對不上都拒絕；同樣的輸入兩次產出 data_sha256 相同
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { build, SLOT_BYTES, BASE } = require('./build-lora-asset.js');
const Fatrain = require('../renderer/src/studio/fatrain_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-build-lora-'));
const mkRel = (name, o) => {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  const desc = Object.assign({ format: 'fa-lora-descriptor', format_version: 1, id: 'demo-r4', version: '1.0.0', name: 'demo-r4', base: 'models/Qwen3-0.6B', base_sha256: null, rank: 4, alpha: 8,
    prompt_format_version: '1', tool_catalog_sha256: H('c'), applies: { domains: ['decompose'], triggers: ['拆題|UML'] }, size: 10143496, sha256: H('e'), location: 'asset:lora/demo-r4', eval: null }, o && o.desc);
  if (!(o && o.noDesc)) fs.writeFileSync(path.join(dir, 'lora.descriptor.json'), JSON.stringify(desc));
  const card = Object.assign({ format: 'fa-lora-card', version: 1, id: 'lora/demo-r4', name: '示範', version_tag: '1.0.0', base: { name: BASE }, created: '2026-11-12', intro: '拆題', capabilities: [{ id: 'split', label: '拆題' }],
    known_limits: ['範圍外未量', '一般限制'], eval: { split_legal_rate: { base: 0, tuned: 1, n: 60 } } }, o && o.card);
  if (!(o && o.noCard)) fs.writeFileSync(path.join(dir, 'model_card.json'), JSON.stringify(card));
  const bin = path.join(dir, 'lora.bin'); fs.writeFileSync(bin, Buffer.alloc(o && o.binSize !== undefined ? o.binSize : SLOT_BYTES, 1));
  const train = path.join(dir, 'train.jsonl'); fs.writeFileSync(train, (o && o.trainText) || ('{"messages":[]}\n' + name + '\n'));
  return { dir, bin, train };
};

{ // 1) 正常產出，讀回來檢查
  const { dir, bin, train } = mkRel('good');
  const r = build(dir, bin, path.join(root, 'out-good'), { trainFile: train });
  check('正常產出：回報檔名與版本', r.name === 'demo-r4' && r.version === '1.0.0' && fs.existsSync(r.out), r);
  const rd = Fatrain.readAsset(new Uint8Array(fs.readFileSync(r.out)), {});
  check('正常產出：讀回成功', rd.ok === true, rd.errors);
  const d = JSON.parse(Buffer.from(rd.asset.files['data/descriptor.json']).toString('utf8'));
  const binBytes = fs.readFileSync(bin);
  check('描述檔 size／sha256 是實際打包的 lora.bin', d.size === SLOT_BYTES && d.sha256 === sha(binBytes), { size: d.size, sha256: d.sha256 });
  check('描述檔 base 是 HF 名稱，本機路徑另存', d.base === BASE && d.base_local === 'models/Qwen3-0.6B', d.base);
  check('描述檔有槽寬 16、訓練秩 4', d.slot_rank === 16 && d.rank === 4, d);
  const lx = rd.asset.manifest.extra.lora;
  check('manifest.extra.lora 帶版本、說明、已知限制、訓練秩', lx.version === '1.0.0' && lx.description === '拆題' && lx.known_limits.length === 2 && lx.trained_rank === 4, lx);
  check('manifest.compat.rank 是槽寬 16', rd.asset.manifest.compat.rank === 16, rd.asset.manifest.compat);
  const trainSha = sha(fs.readFileSync(train));
  check('data_sha256 = 訓練檔內容的 sha256（描述檔、compat、extra 三處一致）', d.data_sha256 === trainSha && rd.asset.manifest.compat.data_sha256 === trainSha && lx.data_sha256 === trainSha && lx.train_file === 'train.jsonl', { d: d.data_sha256, trainSha });
  const r2 = build(dir, bin, path.join(root, 'out-good2'), { trainFile: train });
  check('同樣輸入兩次產出 data_sha256 相同（可重現的雜湊部分）', r2.out !== r.out && JSON.parse(Buffer.from(Fatrain.readAsset(new Uint8Array(fs.readFileSync(r2.out)), {}).asset.files['data/descriptor.json']).toString('utf8')).data_sha256 === trainSha, r2);
  // 描述檔的 train_file（相對於 release 目錄）也能用
  const rel = mkRel('relfile'); const dd = JSON.parse(fs.readFileSync(path.join(rel.dir, 'lora.descriptor.json'), 'utf8')); dd.train_file = 'train.jsonl';
  fs.writeFileSync(path.join(rel.dir, 'lora.descriptor.json'), JSON.stringify(dd));
  const r3 = build(rel.dir, rel.bin, path.join(root, 'out-rel'));
  check('描述檔 train_file（相對於 release 目錄）可用', fs.existsSync(r3.out), r3);
}
{ // 2) 不合格的輸入一律拒絕
  const expectThrow = (name, re, make) => {
    let msg = null; try { const x = make(); build(x.dir, x.bin, path.join(root, 'out-' + name)); } catch (e) { msg = String(e.message || e); }
    check(name + '：拒絕並寫原因', msg !== null && re.test(msg), msg);
  };
  const expectThrowOpts = (name, re, make, optsOf) => {
    let msg = null; try { const x = make(); const o = optsOf ? optsOf(x) : { trainFile: x.train }; build(x.dir, x.bin, path.join(root, 'out-' + name), o); } catch (e) { msg = String(e.message || e); }
    check(name + '：拒絕並寫原因', msg !== null && re.test(msg), msg);
  };
  expectThrow('lora.bin 大小不對', /大小.*不符/, () => mkRel('badsize', { binSize: 1000 }));
  expectThrow('缺 model_card', /model_card/, () => mkRel('nocard', { noCard: true }));
  expectThrow('描述檔不合法', /描述檔不合法/, () => mkRel('baddesc', { desc: { format: 'x' } }));
  expectThrow('card 不合法', /model_card\.json 不合法/, () => mkRel('badcard', { card: { format: 'x' } }));
  expectThrow('缺描述檔', /ENOENT|lora\.descriptor/, () => mkRel('nodesc', { noDesc: true }));
  expectThrowOpts('沒有訓練檔路徑', /沒有訓練檔路徑/, () => mkRel('notrain'), () => undefined);
  expectThrowOpts('訓練檔不存在', /讀不到訓練檔/, () => mkRel('missingtrain'), (x) => ({ trainFile: path.join(x.dir, 'nope.jsonl') }));
  expectThrowOpts('描述檔記錄的 data_sha256 與訓練檔不符', /不符/, () => mkRel('badhash', { desc: { data_sha256: H('9') } }));
  expectThrowOpts('描述檔 trained_on 雜湊與訓練檔不符', /不符/, () => mkRel('badtrained', { desc: { trained_on: { train_file_sha256: H('8') } } }));
}
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
process.exit(bad.length ? 1 : 0);
