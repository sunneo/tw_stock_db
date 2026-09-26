#!/usr/bin/env node
// AI 功能清冊工具（見 features/README.md）。
//
//   node scripts/ai-features.js check                     驗證清冊格式，並跟原始碼比對有沒有漏列／寫錯的工具與斜線指令
//   node scripts/ai-features.js build                     產生 features/FEATURES.md 與 features/ai-features.json
//   node scripts/ai-features.js commit-msg <id...> [-m 說明]   印出這次改動的 commit message 功能區塊
//   node scripts/ai-features.js record <id...> -m 說明        更新功能的 updated 日期，並在 history 加一筆紀錄
//   node scripts/ai-features.js staged-msg                 比對「已 git add 的清冊」跟 HEAD，把新增的 history 紀錄印成 commit message 功能區塊
//                                                          （scripts/git-hooks/prepare-commit-msg 會自動呼叫它）
//
// 清冊是 YAML（features/ai-features.yaml），這裡用文字方式修改 record 的欄位而不是
// 整份重新輸出，才不會弄丟檔案裡的註解與排版。
//
// js-yaml 不是 package.json 直接宣告的依賴（它是其他套件帶進來的，node_modules
// 裡本來就有），只有開發／建置時才會用到，不會被打包進安裝檔。

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CATALOG_PATH = path.join(ROOT, "features", "ai-features.yaml");
const MD_PATH = path.join(ROOT, "features", "FEATURES.md");
const JSON_PATH = path.join(ROOT, "features", "ai-features.json");
const SRC_PATH = path.join(ROOT, "renderer", "src", "floating-assistant.js");
const BOOTSTRAP_PATH = path.join(ROOT, "renderer", "bootstrap.js");

function loadYaml() {
  let yaml;
  try { yaml = require("js-yaml"); }
  catch (_) { throw new Error("找不到 js-yaml，請先在 desktop-app 資料夾執行 npm install"); }
  return yaml.load(fs.readFileSync(CATALOG_PATH, "utf8"));
}

function allFeatures(catalog) {
  const out = [];
  for (const cat of catalog.categories || []) {
    for (const f of cat.features || []) out.push({ cat, f });
  }
  return out;
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// ── check ───────────────────────────────────────────────────────────────
function collectSourceNames() {
  const src = fs.readFileSync(SRC_PATH, "utf8");
  const boot = fs.existsSync(BOOTSTRAP_PATH) ? fs.readFileSync(BOOTSTRAP_PATH, "utf8") : "";
  const tools = new Set();
  const slash = new Set();
  const domains = new Set();
  for (const m of src.matchAll(/(?:registerOptional|register_openai_tool)\(\s*['"]([a-z_0-9]+)['"]/g)) tools.add(m[1]);
  for (const m of boot.matchAll(/register_openai_tool\(\s*['"]([a-z_0-9]+)['"]/g)) tools.add(m[1]);
  // 斜線指令：引擎裡是 register_slash_command 的第一個參數（換行後才出現）
  for (const m of src.matchAll(/register_slash_command\(\s*['"](\/[a-z0-9-]+)['"]/g)) slash.add(m[1]);
  for (const m of src.matchAll(/^\s+['"](\/[a-z][a-z0-9-]+)['"],\s*['"`]/gm)) slash.add(m[1]);
  // domain 名稱：SUBAGENT_DOMAIN_REGISTRY 的 key，以及桌面版 register_domain('xxx')
  const reg = src.match(/const SUBAGENT_DOMAIN_REGISTRY = \{([\s\S]*?)\n\};/);
  if (reg) for (const m of reg[1].matchAll(/^    ([a-z_0-9]+): \{/gm)) domains.add(m[1]);
  for (const m of (src + boot).matchAll(/register_domain\(\s*['"]([a-z_0-9]+)['"]/g)) domains.add(m[1]);
  return { tools, slash, domains };
}

function check() {
  const catalog = loadYaml();
  const errors = [];
  const warnings = [];
  const ids = new Set();
  const catIds = new Set();
  for (const cat of catalog.categories || []) {
    if (!cat.id || !cat.name) errors.push(`分類缺少 id 或 name：${JSON.stringify(cat).slice(0, 60)}`);
    if (catIds.has(cat.id)) errors.push(`分類 id 重複：${cat.id}`);
    catIds.add(cat.id);
  }
  const src = collectSourceNames();
  const used = { tools: new Set(), slash: new Set(), domains: new Set() };
  for (const { cat, f } of allFeatures(catalog)) {
    const tag = `${cat.id}/${f.id}`;
    if (!f.id || !/^[a-z0-9-]+$/.test(f.id)) errors.push(`${tag}：id 必須是小寫英數與連字號`);
    if (ids.has(f.id)) errors.push(`功能 id 重複：${f.id}`);
    ids.add(f.id);
    if (!f.name) errors.push(`${tag}：缺少 name`);
    if (!f.summary) errors.push(`${tag}：缺少 summary`);
    if (!f.how || !(f.how.slash || f.how.tools || f.how.domain || f.how.ui)) errors.push(`${tag}：how 至少要有 slash／tools／domain／ui 其中一項`);
    for (const p of asArray(f.platforms)) if (!["web", "desktop"].includes(p)) errors.push(`${tag}：未知平台 ${p}`);
    if (!asArray(f.platforms).length) errors.push(`${tag}：缺少 platforms`);
    for (const t of asArray(f.how && f.how.tools)) { used.tools.add(t); if (!src.tools.has(t) && t !== "list_ai_features") errors.push(`${tag}：原始碼裡找不到工具 ${t}`); }
    for (const s of asArray(f.how && f.how.slash)) { used.slash.add(s); if (!src.slash.has(s) && s !== "/ai-features") errors.push(`${tag}：原始碼裡找不到斜線指令 ${s}`); }
    for (const d of asArray(f.how && f.how.domain)) { used.domains.add(d); if (!src.domains.has(d) && d !== "feature_guide") errors.push(`${tag}：原始碼裡找不到 domain ${d}`); }
  }
  // 反方向：原始碼有、清冊沒列的（只警告，內部輔助工具不一定要對外介紹）
  const missing = (label, have, listed) => {
    const list = [...have].filter((n) => !listed.has(n)).sort();
    if (list.length) warnings.push(`清冊沒有列到的${label}（${list.length}）：${list.join("、")}`);
  };
  missing("斜線指令", src.slash, used.slash);
  missing("工具", src.tools, used.tools);
  missing("domain", src.domains, used.domains);

  warnings.forEach((w) => console.warn("[警告] " + w));
  if (errors.length) {
    errors.forEach((e) => console.error("[錯誤] " + e));
    console.error(`\n檢查失敗：${errors.length} 個錯誤`);
    return false;
  }
  console.log(`檢查通過：${catIds.size} 個分類、${ids.size} 個功能`);
  return true;
}

// ── build ───────────────────────────────────────────────────────────────
// 給前端內嵌用的精簡版：不含 history，欄位名稱都保持原樣。
function frontendCatalog(catalog) {
  return {
    schema: catalog.schema,
    categories: (catalog.categories || []).map((c) => ({
      id: c.id, name: c.name, summary: c.summary,
      features: (c.features || []).map((f) => ({
        id: f.id, name: f.name, summary: f.summary,
        how: f.how || {}, platforms: asArray(f.platforms),
        // js-yaml 會把 2026-09-26 這種寫法解析成 Date 物件，要轉回字串
        samples: asArray(f.samples),
        updated: f.updated instanceof Date ? f.updated.toISOString().slice(0, 10) : String(f.updated || ""),
      })),
    })),
  };
}

function renderMarkdown(catalog) {
  const lines = [
    "# AI 功能清單", "",
    "> 這份檔案由 `node scripts/ai-features.js build` 從 `features/ai-features.yaml` 自動產生，請不要手改。", "",
  ];
  for (const c of catalog.categories || []) {
    lines.push(`## ${c.name}`, "", c.summary || "", "");
    for (const f of c.features || []) {
      lines.push(`### ${f.name}（\`${f.id}\`）`, "", f.summary, "");
      const how = f.how || {};
      const plat = asArray(f.platforms).map((p) => (p === "web" ? "網頁版" : "桌面版")).join("、");
      lines.push(`- 可用平台：${plat}`);
      if (how.slash) lines.push(`- 斜線指令：${asArray(how.slash).map((s) => "`" + s + "`").join("、")}`);
      if (how.domain) lines.push(`- 子代理人領域：${asArray(how.domain).map((s) => "`" + s + "`").join("、")}`);
      if (how.tools) lines.push(`- AI 工具：${asArray(how.tools).map((s) => "`" + s + "`").join("、")}`);
      if (how.ui) lines.push(`- 介面入口：${asArray(how.ui).join("、")}`);
      if (asArray(f.samples).length) {
        lines.push("- 範例：");
        for (const s of asArray(f.samples)) lines.push(`  - \`${s}\``);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function build() {
  const catalog = loadYaml();
  const slim = frontendCatalog(catalog);
  fs.writeFileSync(JSON_PATH, JSON.stringify(slim) + "\n", "utf8");
  fs.writeFileSync(MD_PATH, renderMarkdown(catalog), "utf8");
  return slim;
}

// ── commit-msg / record ────────────────────────────────────────────────
function findFeatures(catalog, ids) {
  const map = new Map(allFeatures(catalog).map(({ cat, f }) => [f.id, { cat, f }]));
  return ids.map((id) => {
    const hit = map.get(id);
    if (!hit) throw new Error(`清冊裡沒有功能 ${id}（可用 id：${[...map.keys()].join("、")}）`);
    return hit;
  });
}

function parseIdsAndNote(argv) {
  const ids = [];
  let note = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-m") note = argv[++i] || "";
    else ids.push(argv[i]);
  }
  if (!ids.length) throw new Error("請至少給一個功能 id");
  return { ids, note };
}

function commitMsg(argv) {
  const { ids, note } = parseIdsAndNote(argv);
  const hits = findFeatures(loadYaml(), ids);
  const lines = ["Features:"];
  for (const { cat, f } of hits) lines.push(`  - ${cat.id}/${f.id}（${f.name}）${note ? "：" + note : ""}`);
  console.log(lines.join("\n"));
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function record(argv) {
  const { ids, note } = parseIdsAndNote(argv);
  if (!note) throw new Error("record 需要用 -m 給一句說明");
  findFeatures(loadYaml(), ids); // 先確認 id 都存在
  let text = fs.readFileSync(CATALOG_PATH, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const date = today();
  for (const id of ids) {
    const start = lines.findIndex((l) => new RegExp(`^\\s*- id: ${id}\\s*$`).test(l));
    const indent = lines[start].match(/^(\s*)/)[1].length;
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === "" || lines[end].match(/^(\s*)/)[1].length > indent)) end++;
    // 區塊尾端的空白行不算區塊內容
    while (end > start + 1 && lines[end - 1].trim() === "") end--;
    const pad = " ".repeat(indent + 2);
    const entry = `${pad}  - { date: ${date}, note: ${JSON.stringify(note)} }`;
    let updatedIdx = -1, historyIdx = -1;
    for (let i = start + 1; i < end; i++) {
      if (/^\s*updated:/.test(lines[i])) updatedIdx = i;
      if (/^\s*history:\s*$/.test(lines[i])) historyIdx = i;
    }
    if (updatedIdx >= 0) lines[updatedIdx] = `${pad}updated: ${date}`;
    else lines.splice(end++, 0, `${pad}updated: ${date}`);
    if (historyIdx >= 0) {
      let hEnd = historyIdx + 1;
      while (hEnd < end && /^\s*-\s/.test(lines[hEnd])) hEnd++;
      lines.splice(hEnd, 0, entry);
    } else {
      lines.splice(end, 0, `${pad}history:`, entry);
    }
  }
  fs.writeFileSync(CATALOG_PATH, lines.join(eol), "utf8");
  loadYaml(); // 改完一定要還能解析
  console.log(`已更新 ${ids.join("、")}（updated=${date}）。接著執行 node scripts/ai-features.js build 重新產生前端資料。`);
}

// 比對 HEAD 與已 git add 的清冊，找出這次 commit 新增的 history 紀錄。
function stagedMsg() {
  const { execFileSync } = require("child_process");
  const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const rel = git(["rev-parse", "--show-prefix"]).trim() + "features/ai-features.yaml";
  let stagedText, headText = "";
  try { stagedText = git(["show", ":" + rel]); } catch (_) { return; } // 這次沒有 git add 清冊
  try { headText = git(["show", "HEAD:" + rel]); } catch (_) { /* 第一次加入清冊 */ }
  const yaml = require("js-yaml");
  const entries = (text) => {
    const set = new Map();
    const doc = text ? yaml.load(text) : { categories: [] };
    for (const c of doc.categories || []) for (const f of c.features || []) {
      for (const h of f.history || []) set.set(`${f.id}|${h.date instanceof Date ? h.date.toISOString().slice(0, 10) : h.date}|${h.note}`, { cat: c, f, h });
    }
    return set;
  };
  const before = entries(headText);
  const lines = [];
  for (const [key, { cat, f, h }] of entries(stagedText)) {
    if (!before.has(key)) lines.push(`  - ${cat.id}/${f.id}（${f.name}）：${h.note}`);
  }
  if (lines.length) console.log(["Features:", ...lines].join("\n"));
}

module.exports = { loadYaml, check, build, frontendCatalog };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "check") process.exit(check() ? 0 : 1);
    else if (cmd === "build") { const c = build(); console.log(`已產生 features/FEATURES.md 與 features/ai-features.json（${c.categories.length} 個分類）`); }
    else if (cmd === "commit-msg") commitMsg(rest);
    else if (cmd === "record") record(rest);
    else if (cmd === "staged-msg") stagedMsg();
    else { console.error("用法：check | build | commit-msg <id...> [-m 說明] | record <id...> -m 說明 | staged-msg"); process.exit(2); }
  } catch (err) {
    console.error("[ai-features] " + err.message);
    process.exit(1);
  }
}
