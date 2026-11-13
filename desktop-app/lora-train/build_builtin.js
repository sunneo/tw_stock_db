#!/usr/bin/env node
/* 產生內建 LoRA 的上傳暫存目錄與 builtin.json（DESIGN.lora-training.md §32.3）。只寫檔，不 push、不 embed、不 build。
 *
 * 用法：node lora-train/build_builtin.js <.fatrain 資料夾> <暫存輸出資料夾> [--base-url <URL，含 commit>]
 *   每顆：<id>/<id>.fatrain.partNN（≤20 MB）、<id>/manifest.json（與 join.js 同格式）、<id>/join.js
 *   根目錄：builtin.json（格式 fa-lora-builtin v1，見 renderer/src/studio/lora_builtin_core.js）
 * 只收 builtin 清單裡的六顆；缺任何一顆就失敗。gate 欄位由登錄表的 gateOf 算出（與 App 同一套規則）。
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const R = require('../renderer/src/studio/lora_registry_core.js');

const IDS = ['decompose-r4-v2', 'toolcall-r4', 'plan-r4', 'colu-r4', 'codewrite-r4', 'reading-r4'];
const PART = 20 * 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function main() {
  const argv = process.argv.slice(2), pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]; else pos.push(argv[i]); }
  const [srcDir, outDir] = pos;
  if (!srcDir || !outDir) { console.error('用法：node lora-train/build_builtin.js <.fatrain 資料夾> <暫存輸出資料夾> [--base-url <URL>]'); process.exit(2); }
  const baseUrl = flags['base-url'] || 'https://raw.githubusercontent.com/sunneo/tw_stock_db/<COMMIT>/';
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const entries = [];
  for (const id of IDS) {
    const file = path.join(srcDir, id + '.fatrain');
    if (!fs.existsSync(file)) { console.error('缺 ' + file); process.exit(1); }
    const buf = fs.readFileSync(file);
    const dir = path.join(outDir, id); fs.mkdirSync(dir, { recursive: true });
    const parts = [];
    for (let i = 0, n = 0; i < buf.length; i += PART, n++) {
      const b = buf.subarray(i, i + PART), name = id + '.fatrain.part' + String(n).padStart(2, '0');
      fs.writeFileSync(path.join(dir, name), b);
      parts.push({ file: name, size: b.length, sha256: sha(b) });
    }
    const desc = (() => { // 描述檔（fatrain 內）→ 把關結果；讀法同 verify_fatrain.js
      try {
        const Fat = require('../renderer/src/studio/fatrain_core.js');
        const r = Fat.readAsset(new Uint8Array(buf));
        const d = JSON.parse(Buffer.from(r.asset.files['data/descriptor.json']).toString('utf8'));
        return d;
      } catch (e) { return null; }
    })();
    const gate = desc && desc.eval ? R.gateOf(desc.eval) : { pass: false, reason: "沒有評測數字" };
    const manifest = { format: 'fa-lora-builtin-part', name: id, file: id + '.fatrain', size: buf.length, sha256: sha(buf), parts };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, 'join.js'), `// node join.js  -> 重組 ${id}.fatrain 並核對 sha256
const fs=require('fs'),c=require('crypto'),p=require('path');const m=JSON.parse(fs.readFileSync(p.join(__dirname,'manifest.json')));
const h=(b)=>c.createHash('sha256').update(b).digest('hex');
const all=Buffer.concat(m.parts.map(x=>{const b=fs.readFileSync(p.join(__dirname,x.file));if(b.length!==x.size||h(b)!==x.sha256)throw new Error('bad part '+x.file);return b;}));
if(all.length!==m.size||h(all)!==m.sha256)throw new Error('bad total');fs.writeFileSync(p.join(__dirname,m.file),all);console.log('OK',m.file,all.length);
`);
    entries.push({ id, name: desc && desc.name || id, version: desc && desc.version || '1.0.0', size: buf.length, sha256: sha(buf), dir: id,
      parts: parts.map((p) => ({ file: p.file, size: p.size, sha256: p.sha256 })), domains: desc && desc.applies ? desc.applies.domains : [],
      gate: { pass: gate.pass, reason: gate.reason } });
  }
  const builtin = { format: 'fa-lora-builtin', version: 1, base_url: baseUrl, entries };
  fs.writeFileSync(path.join(outDir, 'builtin.json'), JSON.stringify(builtin, null, 2));
  let total = 0; for (const e of entries) total += e.size;
  for (const e of entries) console.log(`${e.id.padEnd(16)} ${String(e.size).padStart(11)} bytes  ${e.parts.length} 分片  gate=${e.gate.pass ? '通過' : '未通過'}  sha256=${e.sha256}`);
  console.log(`合計 ${total} bytes（${(total / 1048576).toFixed(1)} MiB），暫存目錄：${outDir}`);
}
main();
