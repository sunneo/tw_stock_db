// coding domain 的「小工具式上 patch／修正」（主行程；純邏輯在 coding-edit.js）：
//   edit    搜尋／取代區塊＋正規表示式取代＋建立／刪除檔案：由程式定位、保留縮排與換行風格、all-or-nothing，並回傳真正的 unified diff。
//           弱模型手寫 unified diff 常因行號與 context 出錯；「找這段、換成那段」比較寫得出來，定位交給程式。
//   script  隨時準備一支小程式來做機械式的大量修改（改名、批次替換、搬移、產生檔案）：
//           在「暫存工作區」（git）裡執行 → 取得 git diff → dry_run 時還原並把 patch 存起來讓人審查 → apply 時套用「審查過的那份 patch」，不是重跑腳本。
//           腳本與 patch 存在 <workspace>/.floating-assistant/patch-tools/，之後可以重用（list／run name）。腳本等於執行任意程式，所以走跟 run_command 同一個確認閘。
"use strict";
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const E = require("./coding-edit.js");

const IGNORE_DIRS = new Set([".git", "node_modules", ".floating-assistant", "__pycache__", ".venv", "venv", "dist", "build", "target", ".next", ".cache", "coverage"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TOOLS_DIR = ".floating-assistant/patch-tools";

function sh(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, Object.assign({ windowsHide: true, maxBuffer: 30 * 1024 * 1024 }, opts || {}), (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), error: err ? String(err.message || err) : "", killed: !!(err && err.killed) });
    });
  });
}
const git = (cwd, args) => sh("git", args, { cwd });
const cap = (s, n) => (s.length > n ? s.slice(0, n) + "\n…（已截斷，原本 " + s.length + " 字元）" : s);
const rel = (p) => p.split(path.sep).join("/");

async function resolveDir(cwdAbs) {
  const cwd = path.resolve(String(cwdAbs || ""));
  const st = await fs.stat(cwd).catch(() => null);
  return st && st.isDirectory() ? { cwd } : { error: "目標路徑不存在或不是資料夾：" + cwd };
}
const isWorkspace = async (cwd) => !!(await fs.stat(path.join(cwd, ".floating-assistant", "workspace.json")).catch(() => null));

function globToRe(g) {
  g = g.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") { if (g[i + 1] === "*") { i++; if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; } else re += "[^/]*"; }
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}
async function listFiles(cwd, globs, limit) {
  const res = [globs.map(globToRe)][0]; const out = [];
  async function rec(dir, relDir) {
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (out.length >= limit) return;
      const r = relDir ? relDir + "/" + e.name : e.name;
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) await rec(path.join(dir, e.name), r); }
      else if (e.isFile() && res.some((x) => x.test(r))) out.push(r);
    }
  }
  await rec(cwd, "");
  return out;
}
async function readText(abs) {
  const st = await fs.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return null;
  if (st.size > MAX_FILE_BYTES) return { tooBig: st.size };
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) return { binary: true };
  return buf.toString("utf8");
}

// edits：applyEdits 的編輯陣列；regex：{pattern, flags, replacement, paths:[glob], expect_count, expect_files}
async function editFiles({ cwdAbs, edits, regex, dryRun }) {
  const d = await resolveDir(cwdAbs); if (d.error) return { ok: false, error: d.error };
  const cwd = d.cwd; const files = {};
  if (regex) {
    if (!Array.isArray(regex.paths) || !regex.paths.length) return { ok: false, error: "regex 需要 paths（glob 清單，例如 [\"src/**/*.c\"]）" };
    const list = await listFiles(cwd, regex.paths, 5000); if (!list.length) return { ok: false, error: "paths 沒有符合任何檔案：" + regex.paths.join("、") };
    for (const p of list) { const t = await readText(path.join(cwd, p)); if (typeof t === "string") files[p] = t; }
    const r = E.regexEdits(files, regex);
    if (!r.ok) return { ok: false, applied: false, errors: r.errors };
    return await commit(cwd, files, r.files, r.changes, dryRun);
  }
  if (!Array.isArray(edits) || !edits.length) return { ok: false, error: "缺少 edits（陣列）或 regex" };
  const paths = Array.from(new Set(edits.map((e) => String((e && e.path) || "").replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean)));
  for (const p of paths) {
    if (p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p) || /^[A-Za-z]:/.test(p)) continue; // applyEdits 會回報錯誤
    const t = await readText(path.join(cwd, p));
    if (t && typeof t === "object") return { ok: false, applied: false, errors: [{ path: p, error: t.binary ? "這是二進位檔案，不能用文字方式修改" : "檔案太大（" + t.tooBig + " 位元組，上限 " + MAX_FILE_BYTES + "）" }] };
    files[p] = t;
  }
  const r = E.applyEdits(files, edits);
  if (!r.ok) return { ok: false, applied: false, errors: r.errors, note: "沒有修改任何檔案（all-or-nothing）。照 errors 裡的提示（尤其是 closest.actual 的實際內容）修正後重送。" };
  return await commit(cwd, files, r.files, r.changes, dryRun);
}
async function commit(cwd, before, after, changes, dryRun) {
  const diff = E.diffForChanges(before, after);
  const stat = changes.map((c) => c.path + "（" + { create: "新增", modify: "修改 " + c.edits + " 處", delete: "刪除" }[c.kind] + (c.fuzzy && c.fuzzy.length ? "；" + Array.from(new Set(c.fuzzy)).join("、") : "") + "）");
  if (dryRun) return { ok: true, applied: false, dry_run: true, files: stat, diff: cap(diff, 40000), note: "乾跑：沒有寫入任何檔案。確認 diff 符合預期後，去掉 dry_run 再送一次。" };
  const backup = {}; const written = [];
  try {
    for (const [p, t] of Object.entries(after)) {
      const abs = path.join(cwd, p); backup[p] = before[p] == null ? null : before[p];
      if (t == null) await fs.rm(abs, { force: true });
      else { await fs.mkdir(path.dirname(abs), { recursive: true }); await fs.writeFile(abs, t, "utf8"); }
      written.push(p);
    }
  } catch (e) {
    for (const p of written) { const abs = path.join(cwd, p); try { if (backup[p] == null) await fs.rm(abs, { force: true }); else await fs.writeFile(abs, backup[p], "utf8"); } catch (_) { /* 盡力還原 */ } }
    return { ok: false, applied: false, error: "寫入失敗，已還原：" + String((e && e.message) || e) };
  }
  const g = await git(cwd, ["diff", "--stat"]);
  return { ok: true, applied: true, files: stat, diff: cap(diff, 40000), git_diff_stat: g.ok ? g.stdout.trim() : undefined, next: "接著跑語法檢查與測試；用 git_inspect({mode:\"diff\"}) 可以再看一次實際變更。" };
}

// ---- 腳本式 patch ----
const EXT = { python: "py", node: "js", sh: "sh" };
async function findInterpreter(lang) {
  if (lang === "node") return { cmd: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: "1" }, label: "node（內建）" };
  if (lang === "sh") { for (const c of ["bash", "sh"]) { const r = await sh(c, ["--version"]); if (r.ok || r.stdout || r.stderr) return { cmd: c, args: [], env: {}, label: c }; } return null; }
  for (const c of process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]) { const r = await sh(c, ["--version"]); if (r.ok) return { cmd: c, args: c === "py" ? ["-3"] : [], env: {}, label: c }; }
  return null;
}
const safeName = (n) => String(n || "").trim().replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 60);

async function scriptTool({ cwdAbs, action, name, language, code, dryRun, timeoutSec, args, gate }) {
  const d = await resolveDir(cwdAbs); if (d.error) return { ok: false, error: d.error };
  const ws = d.cwd; const dir = path.join(ws, TOOLS_DIR);
  if (!(await isWorkspace(ws))) return { ok: false, error: "patch 腳本只能在 coding 暫存工作區裡跑（先 coding_workspace action:open，cwd_abs 用它回傳的 workspace_path）——腳本可能弄壞檔案，工作區是 git 暫存、確認後才轉移回你的資料夾。" };
  const act = action || ((code || name) ? "run" : "list");
  if (act === "list") {
    let names = []; try { names = await fs.readdir(dir); } catch (_) { /* 還沒有 */ }
    const tools = names.filter((n) => /\.(py|js|sh)$/.test(n)).map((n) => { const base = n.replace(/\.[^.]+$/, ""); return { name: base, file: TOOLS_DIR + "/" + n, has_last_patch: names.includes(base + ".last.patch") }; });
    return { ok: true, tools, note: tools.length ? "用 action:run＋name 可以重跑（dry_run 預設 true）；沒有 code 就是重跑存起來的那支。" : "還沒有存任何 patch 腳本。action:run 帶 name、language、code 就會建立。" };
  }
  const nm = safeName(name); if (!nm) return { ok: false, error: "缺少 name（英文／數字／底線，例如 rename_api）" };
  if (act === "apply") { // 套用「審查過的那份 patch」
    let patch; try { patch = await fs.readFile(path.join(dir, nm + ".last.patch"), "utf8"); } catch (_) { return { ok: false, error: "沒有 " + nm + " 的 dry-run patch；先 action:run（dry_run 預設 true）看過 diff 再 apply" }; }
    const st = await git(ws, ["status", "--porcelain"]); if (st.stdout.trim()) return { ok: false, error: "工作區有未 commit 的變更，先 commit 或還原再套用（才能確保只套用這份 patch）", dirty: st.stdout.trim().split("\n").slice(0, 20) };
    const tmp = path.join(os.tmpdir(), "fa-pt-" + Date.now() + ".patch"); await fs.writeFile(tmp, patch, "utf8");
    try {
      const tmpArg = tmp.split("\\").join("/");
      const chk = await git(ws, ["apply", "--check", "--binary", tmpArg]); if (!chk.ok) return { ok: false, stage: "check", applied: false, stderr: cap(chk.stderr, 4000), note: "patch 對不上目前的檔案（dry-run 之後檔案又被改過？）。重新 action:run 產生新的 patch。" };
      const ap = await git(ws, ["apply", "--binary", tmpArg]); if (!ap.ok) return { ok: false, stage: "apply", applied: false, stderr: cap(ap.stderr, 4000) };
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    const stat = await git(ws, ["diff", "--stat"]);
    return { ok: true, applied: true, git_diff_stat: stat.stdout.trim(), next: "接著跑語法檢查與測試，再 commit。" };
  }
  // run
  let lang = language && EXT[language] ? language : null; let file;
  if (code) {
    if (!lang) return { ok: false, error: "language 必須是 python／node／sh" };
    if (String(code).length > 200000) return { ok: false, error: "腳本太長（上限 200000 字元）" };
    await fs.mkdir(dir, { recursive: true }); file = path.join(dir, nm + "." + EXT[lang]); await fs.writeFile(file, String(code), "utf8");
  } else {
    let names = []; try { names = await fs.readdir(dir); } catch (_) { /* */ }
    const hit = names.find((n) => n.replace(/\.[^.]+$/, "") === nm && /\.(py|js|sh)$/.test(n)); if (!hit) return { ok: false, error: "找不到存起來的腳本 " + nm + "（action:list 看有哪些）" };
    file = path.join(dir, hit); lang = Object.keys(EXT).find((k) => EXT[k] === hit.split(".").pop());
  }
  const itp = await findInterpreter(lang); if (!itp) return { ok: false, error: "這台電腦找不到 " + lang + " 直譯器（python 要有 python3／python／py；sh 要有 bash）。改用 node（內建、不用安裝）寫腳本。" };
  const before = await git(ws, ["status", "--porcelain"]); if (!before.ok) return { ok: false, error: "工作區不是 git repo 或 git 不能用：" + before.stderr.trim() };
  if (before.stdout.trim()) return { ok: false, error: "工作區有未 commit 的變更，先 commit 或還原再跑腳本（這樣 diff 才只包含這支腳本改的東西）。", dirty: before.stdout.trim().split("\n").slice(0, 20) };
  const isDry = dryRun !== false;
  const argv = itp.args.concat([file], Array.isArray(args) ? args.map(String) : []);
  const display = itp.label + " " + rel(path.relative(ws, file)) + (args && args.length ? " " + args.join(" ") : "") + "（patch 腳本，" + (isDry ? "乾跑：跑完會還原" : "直接套用") + "）";
  if (gate) await gate(display, ws);
  const t0 = Date.now(); const to = Math.max(5, Math.min(300, Number(timeoutSec) || 60)) * 1000;
  const run = await sh(itp.cmd, argv, { cwd: ws, timeout: to, env: Object.assign({}, process.env, itp.env, { PATCH_WORKSPACE: ws, PATCH_TOOL: nm, PYTHONIOENCODING: "utf-8" }) });
  const out = { script: rel(path.relative(ws, file)), interpreter: itp.label, exit_code: run.code, stdout: cap(run.stdout, 8000), stderr: cap(run.stderr, 8000), ms: Date.now() - t0 };
  const revert = async () => { await git(ws, ["reset", "-q", "--hard", "HEAD"]); await git(ws, ["clean", "-fdq"]); };
  if (!run.ok) { await revert(); return Object.assign({ ok: false, applied: false, error: run.killed ? "腳本逾時（" + to / 1000 + " 秒）已中止，所有變更已還原" : "腳本結束碼 " + run.code + "，所有變更已還原", reverted: true }, out); }
  await git(ws, ["add", "-A"]);
  const diff = await git(ws, ["diff", "--cached", "--binary"]); const stat = await git(ws, ["diff", "--cached", "--stat"]);
  if (!diff.stdout.trim()) { return Object.assign({ ok: true, applied: false, changed: false, note: "腳本跑完了，但沒有改任何檔案（搜尋條件沒命中？）。" }, out); }
  const patchFile = path.join(dir, nm + ".last.patch"); await fs.writeFile(patchFile, diff.stdout, "utf8");
  if (isDry) { await revert(); return Object.assign({ ok: true, applied: false, dry_run: true, changed: true, git_diff_stat: stat.stdout.trim(), diff: cap(diff.stdout, 40000), patch_saved: TOOLS_DIR + "/" + nm + ".last.patch", next: "看過 diff 確認沒問題 → action:apply（套用這份審查過的 patch）；不對就修改腳本再 run。" }, out); }
  await git(ws, ["reset", "-q"]);
  return Object.assign({ ok: true, applied: true, changed: true, git_diff_stat: stat.stdout.trim(), diff: cap(diff.stdout, 40000), patch_saved: TOOLS_DIR + "/" + nm + ".last.patch", next: "接著跑語法檢查與測試，再 commit。" }, out);
}

function register(ipcMain, deps) {
  deps = deps || {};
  const wrap = (fn) => async (_evt, a) => { try { return await fn(_evt, a || {}); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } };
  ipcMain.handle("fa:codingtools:edit", wrap((_e, a) => editFiles({ cwdAbs: a.cwdAbs, edits: a.edits, regex: a.regex, dryRun: !!a.dryRun })));
  // 腳本等於執行任意程式：沒有確認閘（舊版 main.js 沒傳 execConfirmGate）就拒絕，不能放行
  ipcMain.handle("fa:codingtools:script", wrap((e, a) => (deps.execConfirmGate ? scriptTool(Object.assign({}, a, { gate: (cmd, cwd) => deps.execConfirmGate(cmd, cwd, e.sender.id) })) : { ok: false, error: "這個動作需要新版主程式（缺少執行確認閘）：請重新安裝最新版。" })));
}

module.exports = { register, editFiles, scriptTool, listFiles };
