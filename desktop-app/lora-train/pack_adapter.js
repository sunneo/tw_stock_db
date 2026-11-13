#!/usr/bin/env node
/* 把訓練好的 PEFT adapter 打包成「可發佈格式」：20MB 分片＋manifest.json（sha256、基底、rank、資料與工具清單雜湊、評量）＋join.js。
 * 用法：node lora-train/pack_adapter.js <adapter_dir> <name> [eval_json]
 * 輸出：lora-train/out/release/<name>/（可直接放進 lora-adapters branch 的 <name>/ 資料夾）
 */
const fs = require('fs'), c = require('crypto'), p = require('path');
const argv = process.argv.slice(2), flags = {}, pos = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]; else pos.push(argv[i]); }
const [adapterDir, name, evalPath] = pos;
// 可選旗標（多顆 LoRA 用；描述檔格式見 DESIGN.lora-training.md §13.2 fa-lora-descriptor v1）：
//   --id <id> --version <字串> --domains a,b --triggers "正規式1,正規式2"（逗號分隔）--pf <prompt_format_version> --card <card_info.json> --metrics <metrics.json>
if (!adapterDir || !name) { console.error('usage: node pack_adapter.js <adapter_dir> <name> [eval_json]'); process.exit(1); }
const SZ = 20 * 1024 * 1024, here = __dirname;
const out = p.join(here, 'out', 'release', name); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const sha = (b) => c.createHash('sha256').update(b).digest('hex');
const buf = fs.readFileSync(p.join(adapterDir, 'adapter_model.safetensors')); const parts = [];
for (let i = 0, n = 0; i < buf.length; i += SZ, n++) { const b = buf.subarray(i, i + SZ); const f = 'adapter_model.safetensors.part' + String(n).padStart(2, '0'); fs.writeFileSync(p.join(out, f), b); parts.push({ file: f, size: b.length, sha256: sha(b) }); }
fs.copyFileSync(p.join(adapterDir, 'adapter_config.json'), p.join(out, 'adapter_config.json'));
const cfg = JSON.parse(fs.readFileSync(p.join(adapterDir, 'adapter_config.json'), 'utf8'));
const opt = (f) => { try { return sha(fs.readFileSync(p.join(here, f))); } catch (e) { return null; } };
// 工具清單雜湊 shape-v2：輸入是 app 內建工具登記的快照 data/app_snapshot_tools.json（lora-train/tool_snapshot.js 產生），
// 用 lora_registry_core 的 toolCatalogHash（與主程式 _toolCatalogSha256 同一個函式）。檔案位元組的雜湊只留在 tool_catalog_file_sha256 供追溯，不拿來比對。
const RegCore = require('../renderer/src/studio/lora_registry_core.js');
const SNAPSHOT = p.join(here, 'data', 'app_snapshot_tools.json');
const shaBytes = (u8) => c.createHash('sha256').update(u8).digest('hex');
const toolShape = (() => { try { return RegCore.toolCatalogHash(JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).tools, shaBytes); } catch (e) { return null; } })();
// 評量檔正規化：評量腳本（eval_run.py）寫 {tuned, base, n}（可能有 neg／pos）；描述檔格式是 {adapter, base, n}。
// verdict（ship、not_winning、no_data、degenerate…）原樣保留，登錄會用它擋住自動選用。
function normEval(e) {
  if (!e || !e.groups) return e;
  const g = {};
  for (const [k, v] of Object.entries(e.groups)) g[k] = Object.assign({ adapter: v.adapter != null ? v.adapter : v.tuned, base: v.base, n: v.n }, v.neg ? { neg: v.neg, pos: v.pos } : {});
  return Object.assign({}, e, { groups: g });
}
const man = { name, base: cfg.base_model_name_or_path || 'Qwen/Qwen3-0.6B', format: 'peft-lora', rank: cfg.r, alpha: cfg.lora_alpha, target_modules: cfg.target_modules,
  trained_on: { train_file_sha256: opt('data/train.jsonl'), tool_catalog_sha256: toolShape, tool_catalog_scheme: toolShape ? RegCore.TOOL_HASH_SCHEME : null, tool_catalog_file_sha256: opt('data/app_snapshot_tools.json') },
  file: 'adapter_model.safetensors', total_size: buf.length, sha256: sha(buf), parts, eval: evalPath && fs.existsSync(evalPath) ? normEval(JSON.parse(fs.readFileSync(evalPath, 'utf8'))) : null, date: new Date().toISOString().slice(0, 10) };
fs.writeFileSync(p.join(out, 'manifest.json'), JSON.stringify(man, null, 2));
fs.writeFileSync(p.join(out, 'join.js'), `// node join.js  -> 重組 ${man.file} 並核對 sha256
const fs=require('fs'),c=require('crypto'),p=require('path');const m=JSON.parse(fs.readFileSync(p.join(__dirname,'manifest.json')));
const h=(b)=>c.createHash('sha256').update(b).digest('hex');
const all=Buffer.concat(m.parts.map(x=>{const b=fs.readFileSync(p.join(__dirname,x.file));if(b.length!==x.size||h(b)!==x.sha256)throw new Error('bad part '+x.file);return b;}));
if(h(all)!==m.sha256)throw new Error('bad total sha256');fs.writeFileSync(p.join(__dirname,m.file),all);console.log('OK',m.file,all.length);
`);
if (flags.id) {
  const desc = { format: 'fa-lora-descriptor', format_version: 1, id: flags.id, version: String(flags.version || '1.0.0'), name: flags.name || flags.id, base: man.base, base_sha256: null,
    rank: cfg.r, alpha: cfg.lora_alpha, prompt_format_version: flags.pf || '1', tool_catalog_sha256: man.trained_on.tool_catalog_sha256, tool_catalog_scheme: man.trained_on.tool_catalog_scheme || undefined,
    applies: { domains: (flags.domains || '').split(',').filter(Boolean), triggers: (flags.triggers || '').split(',').filter(Boolean) },
    size: man.total_size, sha256: man.sha256, location: flags.location || ('asset:lora/' + flags.id), eval: man.eval && man.eval.groups ? { groups: man.eval.groups } : null };
  fs.writeFileSync(p.join(out, 'lora.descriptor.json'), JSON.stringify(desc, null, 2));
  // model card：格式 fa-lora-card v1（與工作室 lora_manage_core.js validateModelCard 對齊）。
  // 評量數字只從 --metrics 檔（由實跑評量算出的 {split_legal_rate:{base,tuned,n}, fc_format_rate:{base,tuned,n}}，小數 0～1）取；沒有就不放 eval 欄位，不手寫。
  const info = flags.card && fs.existsSync(flags.card) ? JSON.parse(fs.readFileSync(flags.card, 'utf8')) : {};
  const met = flags.metrics && fs.existsSync(flags.metrics) ? JSON.parse(fs.readFileSync(flags.metrics, 'utf8')) : null;
  const card = { format: 'fa-lora-card', version: 1, id: 'lora/' + flags.id, name: info.name || flags.id, version_tag: desc.version,
    base: { name: man.base }, created: new Date().toISOString().slice(0, 10), intro: info.intro || '',
    capabilities: info.capabilities || [], known_limits: info.known_limits || [],
    applicable: { rank: cfg.r, domains: desc.applies.domains },
    training: Object.assign({ sources: info.sources || '' }, info.training || {}) };
  if (met) card.eval = met;
  fs.writeFileSync(p.join(out, 'model_card.json'), JSON.stringify(card, null, 2));
  console.log('descriptor + model_card written for', flags.id);
}
console.log('packed', parts.length, 'parts ->', out);
