#!/usr/bin/env node
// yt-dlp 升版前的本機預跑：對「指定版本」的 yt-dlp wheel 跑同一份契約自檢（就是 app 裡
// PYODIDE_YTDLP_CONTRACT_SRC 那份 Python），不需要開瀏覽器，幾秒鐘就知道升到那個版本
// 會壞哪幾條管線。完整流程見 desktop-app/DESIGN.youtube-download.md。
//
// 用法：node scripts/yt-dlp-contract-precheck.js [yt-dlp版本]   （不給版本＝目前釘住的版本）
// 需要本機有 python + pip（只用來下載並解開 wheel，不會安裝任何東西）。
// 注意：這只檢查「不需要網路、不需要我們橋接」的項目（HTTP 橋接註冊與 deno 偵測墊片
// 這兩項只能在瀏覽器裡跑，請接著在 app 執行 /media-youtube-selfcheck）。
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SRC = path.join(__dirname, "..", "renderer", "src", "floating-assistant.js");
const src = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");
const a = src.indexOf("const FA_YTDLP_CONTRACT = {");
const b = src.indexOf("// tw_stock_db客製: 2026-09-29——攔截yt-dlp-ejs對外部JS runtime（deno/node/");
if (a < 0 || b < 0) throw new Error("找不到 FA_YTDLP_CONTRACT / 契約自檢原始碼（floating-assistant.js 結構變了？）");
const { FA_YTDLP_CONTRACT: contract, PYODIDE_YTDLP_CONTRACT_SRC: contractPy } =
  new Function(src.slice(a, b) + "\nreturn { FA_YTDLP_CONTRACT, PYODIDE_YTDLP_CONTRACT_SRC };")();

const version = process.argv[2] || contract.version;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-precheck-"));
const py = process.platform === "win32" ? "python" : "python3";
const run = (args, opts) => spawnSync(py, args, Object.assign({ encoding: "utf8", env: Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" }) }, opts));

console.log(`下載 yt-dlp==${version} 的 wheel（僅供檢查，不安裝）…`);
let r = run(["-m", "pip", "download", `yt-dlp==${version}`, "--no-deps", "-d", work, "-q"]);
if (r.status !== 0) { console.error(r.stderr || r.stdout); console.error("下載失敗：版本號是否存在？"); process.exit(2); }
const wheel = fs.readdirSync(work).find((f) => f.endsWith(".whl"));
r = run(["-c", "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", path.join(work, wheel), path.join(work, "src")]);
if (r.status !== 0) { console.error(r.stderr); process.exit(2); }

fs.writeFileSync(path.join(work, "contract.py"), contractPy);
fs.writeFileSync(path.join(work, "runner.py"), [
  "import sys, json",
  "sys.path.insert(0, sys.argv[1]); sys.path.insert(0, sys.argv[2])",
  "from contract import fa_contract_check",
  "exp = json.loads(sys.argv[3])",
  "res = fa_contract_check(exp, False)",
  "print(json.dumps(res, ensure_ascii=False))",
].join("\n"));
const expected = { version, meriyah: contract.meriyah, astring: contract.astring, format: contract.formatSelector, stdin_regex: contract.jscStdinRegex };
// 版本以「要預跑的版本」為準（自檢的 A1 項目比對的是釘住版本，這裡刻意用預跑版本，才不會誤報）
r = run([path.join(work, "runner.py"), path.join(work, "src"), work, JSON.stringify(expected)]);
if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(2); }
const results = JSON.parse(r.stdout.trim().split("\n").pop());
const failed = results.filter((x) => !x.ok);
console.log(`\nyt-dlp ${version}（釘住版本：${contract.version}）契約自檢：${results.length - failed.length}/${results.length} 項通過\n`);
const groups = new Map();
for (const x of results) { if (!groups.has(x.pipeline)) groups.set(x.pipeline, []); groups.get(x.pipeline).push(x); }
for (const [pipeline, items] of groups) {
  console.log(`${items.some((x) => !x.ok) ? "❌" : "✅"} ${pipeline}`);
  for (const x of items) console.log(`   ${x.ok ? "✅" : "❌"} ${x.id}${!x.ok && x.detail ? "\n        " + x.detail : ""}`);
}
console.log(failed.length
  ? "\n❌ 標示的項目對應的管線，就是升到這個版本需要先改寫的地方（對照 DESIGN.youtube-download.md 的「耦合點與改寫指引」）。"
  : "\n✅ 本機可檢查的項目都成立。接著請在 app 執行 /media-youtube-selfcheck <版本> → 重新整理 → /media-youtube-selfcheck，再實際下載一支影片驗證。");
try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
process.exit(failed.length ? 1 : 0);
