#!/usr/bin/env node
// node scripts/sf-pack.js <音色庫檔> <輸出目錄> [--path=GeneralUser-GS.sf2] [--part-mb=8] [--version=1]
// 把音色庫切成每片 <= part-mb 的 .partNNN,並在輸出目錄的 manifest.json 登記(upsert):長度與 sha256(整份與每片)。
// 輸出目錄用 git plumbing 單一 commit 推到 soundfont-assets 分支(同 desktop-app-patch 慣例);網頁版用完整 commit SHA 釘住 base。
// 授權:只放 GeneralUser GS(允許修改散布,輸出目錄要附 LICENSE 文字);不要放任何 Roland 樣本。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const args = process.argv.slice(2), pos = args.filter((a) => !a.startsWith('--')), opt = {};
args.filter((a) => a.startsWith('--')).forEach((a) => { const m = /^--([^=]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; });
if (pos.length < 2) { console.error('用法: node scripts/sf-pack.js <音色庫檔> <輸出目錄> [--path=名稱] [--part-mb=8] [--version=1]'); process.exit(1); }
const src = pos[0], out = pos[1], rel = opt.path || path.basename(src), partBytes = Math.floor(Number(opt['part-mb'] || 8) * 1000 * 1000);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex'); const data = fs.readFileSync(src);
if (data.slice(0, 4).toString() !== 'RIFF') { console.error('不是 sf2/RIFF 檔'); process.exit(1); }
fs.mkdirSync(out, { recursive: true }); const ent = { path: rel, version: Number(opt.version || 1), size: data.length, sha256: sha(data), parts: 0, partSize: [], partSha256: [] };
for (let off = 0, i = 0; off < data.length; off += partBytes, i++) { const b = data.subarray(off, off + partBytes); fs.writeFileSync(path.join(out, rel + '.part' + String(i).padStart(3, '0')), b); ent.parts++; ent.partSize.push(b.length); ent.partSha256.push(sha(b)); }
const mp = path.join(out, 'manifest.json'); let man = { schema: 1, files: [] }; try { man = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch (_) { /* 新的 */ }
man.files = (man.files || []).filter((x) => x.path !== rel).concat([ent]); fs.writeFileSync(mp, JSON.stringify(man, null, 1));
console.log('已切成 ' + ent.parts + ' 片,最大 ' + Math.max.apply(null, ent.partSize) + ' 位元組,sha256 ' + ent.sha256.slice(0, 12) + '…');
