// 逐模型各開一個獨立行程量測（原生一個行程、WASM 一個 Electron），這樣記憶體峰值才是「單一模型」的值，不會被前一個模型墊高。
// 用法：node run_each.js <工作資料夾> <模型資料夾> <electron.exe> <desktop-app 資料夾> <ort-node 資料夾> [模型 id,逗號分隔；省略=全部]
// 結果合併寫到 <工作資料夾>\native.jsonl 與 wasm.jsonl（WASM 每個模型多一行 event=mem，記整個 Electron 行程樹峰值）。
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [, , WORK, MODELS, ELECTRON, APP, ORT, ONLY = ''] = process.argv;
if (!ORT) { console.error('用法見檔頭'); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench-config.json'), 'utf8'));
const ids = (ONLY ? ONLY.split(',') : cfg.models.map((m) => m.id));
const NAT = path.join(WORK, 'native.jsonl'), WAS = path.join(WORK, 'wasm.jsonl');
for (const f of [NAT, WAS, path.join(WORK, 'wasm.all.jsonl')]) try { fs.unlinkSync(f); } catch (_) { /* 沒有就算了 */ }
for (const id of ids) {
  const m = cfg.models.find((x) => x.id === id); if (!m) continue;
  const tmpN = path.join(WORK, 'native.' + id + '.jsonl');
  try { fs.unlinkSync(tmpN); } catch (_) { /* 沒有就算了 */ }
  cp.spawnSync(ELECTRON, [path.join(__dirname, 'native_bench.js')], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', NAB_ORT: ORT, NAB_MODELS: MODELS, NAB_WORK: WORK, NAB_OUT: tmpN, NAB_ONLY: id }), stdio: 'ignore' });
  if (fs.existsSync(tmpN)) fs.appendFileSync(NAT, fs.readFileSync(tmpN, 'utf8').split('\n').filter((l) => l && !/"event":"done"/.test(l)).join('\n') + '\n');
  if (!fs.existsSync(path.join(MODELS, m.file))) { fs.appendFileSync(path.join(WORK, 'wasm.all.jsonl'), JSON.stringify({ backend: 'wasm', model: id, skipped: 'needs_download', needs_download: { file: m.file, source: m.source, bytes: m.bytes } }) + '\n'); continue; }
  try { fs.unlinkSync(path.join(WORK, 'wasm_mem.json')); } catch (_) { /* 沒有就算了 */ }
  cp.spawnSync('node', [path.join(__dirname, 'run_wasm.js'), WORK, MODELS, ELECTRON, APP, id], { stdio: 'ignore' });
  if (fs.existsSync(path.join(WORK, 'wasm.jsonl'))) {
    // run_wasm 每次會刪掉 wasm.jsonl，所以把這個模型的結果先收進暫存再合併
    const one = fs.readFileSync(path.join(WORK, 'wasm.jsonl'), 'utf8').split('\n').filter((l) => l && !/"event":"(start|done)"/.test(l));
    let mem = {}; try { mem = JSON.parse(fs.readFileSync(path.join(WORK, 'wasm_mem.json'), 'utf8')); } catch (_) { /* 沒有就空 */ }
    one.push(JSON.stringify({ backend: 'wasm', model: id, event: 'mem', peak_tree_mb: mem.peak_tree_mb, peak_main_mb: mem.peak_main_mb }));
    fs.appendFileSync(path.join(WORK, 'wasm.all.jsonl'), one.join('\n') + '\n');
  }
  console.log('完成', id);
}
if (fs.existsSync(path.join(WORK, 'wasm.all.jsonl'))) { fs.copyFileSync(path.join(WORK, 'wasm.all.jsonl'), WAS); fs.unlinkSync(path.join(WORK, 'wasm.all.jsonl')); }
