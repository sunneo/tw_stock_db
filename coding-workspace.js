// 桌面版 coding domain 的「暫存工作區」：把使用者的專案複製一份到系統暫存資料夾、在那裡 git init，
// 所有 patch／測試／還原都在暫存區進行，確認沒問題後才用 deploy 轉移回使用者資料夾。
// 不管使用者的資料夾本身有沒有 git 都一樣處理；轉移用「基準清單（manifest）」判斷哪些檔案被改過、
// 使用者的原檔在這段期間有沒有被別人改動（有就視為衝突、不覆蓋）。
"use strict";
const fs = require("fs/promises");
const fss = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const IGNORE_DIRS = new Set([".git", "node_modules", ".floating-assistant", "__pycache__", ".venv", "venv", "dist", "build", "target", ".next", ".cache", "coverage", ".pytest_cache", ".mypy_cache"]);
const MAX_FILES = 20000;
const MAX_BYTES = 300 * 1024 * 1024;
const META_DIR = ".floating-assistant";

const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
const rel2 = (p) => p.split(path.sep).join("/");

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || (err && err.message) || "") });
    });
  });
}

function workspaceRoot() { return path.join(os.tmpdir(), "floating-assistant", "coding"); }
function workspaceFor(sourceAbs) {
  const base = path.basename(sourceAbs).replace(/[^\w.-]+/g, "_").slice(0, 40) || "project";
  return path.join(workspaceRoot(), `${base}-${sha1(Buffer.from(sourceAbs.toLowerCase())).slice(0, 8)}`);
}

async function walkFiles(root, onFile) {
  const skipped = [];
  async function rec(dir, relDir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = relDir ? relDir + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) { skipped.push(rel); continue; }
        await rec(abs, rel);
      } else if (e.isFile()) await onFile(abs, rel);
    }
  }
  await rec(root, "");
  return skipped;
}

async function readMeta(ws) {
  try { return JSON.parse(await fs.readFile(path.join(ws, META_DIR, "workspace.json"), "utf8")); } catch (_) { return null; }
}
async function readManifest(ws) {
  try { return JSON.parse(await fs.readFile(path.join(ws, META_DIR, "ws-manifest.json"), "utf8")); } catch (_) { return {}; }
}
async function writeManifest(ws, m) {
  await fs.writeFile(path.join(ws, META_DIR, "ws-manifest.json"), JSON.stringify(m), "utf8");
}

async function hashTree(root) {
  const out = {};
  await walkFiles(root, async (abs, rel) => { out[rel] = sha1(await fs.readFile(abs)); });
  return out;
}

function userMessage(ws, source) {
  return `已建立暫存工作區：${ws}（系統暫存資料夾，會在那裡複製一份「${source}」並 git init）。所有修改與測試都在暫存區進行，確認沒問題後才會轉移回你的資料夾，你的原始資料夾在那之前不會被動到。`;
}

async function openWorkspace({ sourceAbs, subpath }) {
  const source = path.resolve(String(sourceAbs || ""));
  const st = await fs.stat(source).catch(() => null);
  if (!st || !st.isDirectory()) return { ok: false, error: `來源資料夾不存在：${source}` };
  const ws = workspaceFor(source);
  const meta = await readMeta(ws);
  if (meta && meta.source === source) {
    const s = await workspaceStatus({ workspaceAbs: ws });
    return Object.assign({}, s, { resumed: true, tell_user: `沿用先前建立的暫存工作區：${ws}（尚未轉移回原資料夾的修改都還在）。` });
  }
  await fs.rm(ws, { recursive: true, force: true });
  await fs.mkdir(path.join(ws, META_DIR), { recursive: true });
  const manifest = {};
  let files = 0, bytes = 0, tooBig = false;
  const from = subpath ? path.join(source, String(subpath)) : source;
  const skipped = await walkFiles(from, async (abs, rel) => {
    if (tooBig) return;
    const relFromSource = subpath ? rel2(path.relative(source, abs)) : rel;
    const buf = await fs.readFile(abs);
    files++; bytes += buf.length;
    if (files > MAX_FILES || bytes > MAX_BYTES) { tooBig = true; return; }
    const dest = path.join(ws, relFromSource);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    manifest[relFromSource] = sha1(buf);
  });
  if (tooBig) {
    await fs.rm(ws, { recursive: true, force: true });
    return { ok: false, error: `專案太大（超過 ${MAX_FILES} 個檔案或 ${Math.round(MAX_BYTES / 1048576)}MB），請用 subpath 只複製要處理的子資料夾。` };
  }
  await writeManifest(ws, manifest);
  await fs.writeFile(path.join(ws, META_DIR, "workspace.json"), JSON.stringify({ source, subpath: subpath || "", created: new Date().toISOString() }), "utf8");
  const init = await git(ws, ["init", "-q"]);
  if (!init.ok) return { ok: false, error: "git init 失敗：" + init.stderr };
  await git(ws, ["config", "user.name", "Floating AI Assistant"]);
  await git(ws, ["config", "user.email", "fa@localhost"]);
  await git(ws, ["config", "core.autocrlf", "false"]);
  await fs.appendFile(path.join(ws, ".git", "info", "exclude"), "\n.floating-assistant/\n");
  await git(ws, ["add", "-A"]);
  const c = await git(ws, ["commit", "-q", "--allow-empty", "-m", `baseline: copy of ${source}`]);
  return {
    ok: true, workspace_path: ws, source_path: source, files_copied: files, bytes_copied: bytes, skipped_dirs: skipped.slice(0, 20),
    git_baseline_committed: c.ok, tell_user: userMessage(ws, source),
    next: "之後所有 apply_git_patch / git_inspect / run_command / coding_task_state 的 cwd_abs 都改用 workspace_path；完成後用 coding_workspace action:deploy 轉移回原資料夾。",
  };
}

async function diffAgainstManifest(ws) {
  const manifest = await readManifest(ws);
  const now = await hashTree(ws);
  const added = [], modified = [], deleted = [];
  for (const [p, h] of Object.entries(now)) {
    if (!(p in manifest)) added.push(p);
    else if (manifest[p] !== h) modified.push(p);
  }
  for (const p of Object.keys(manifest)) if (!(p in now)) deleted.push(p);
  return { manifest, now, added, modified, deleted };
}

async function workspaceStatus({ workspaceAbs }) {
  const ws = path.resolve(String(workspaceAbs || ""));
  const meta = await readMeta(ws);
  if (!meta) return { ok: false, error: `${ws} 不是暫存工作區（找不到 workspace 記錄）` };
  const d = await diffAgainstManifest(ws);
  const sourceChanged = [];
  for (const p of [...d.modified, ...d.deleted]) {
    try { if (sha1(await fs.readFile(path.join(meta.source, p))) !== d.manifest[p]) sourceChanged.push(p); } catch (_) { sourceChanged.push(p); }
  }
  return {
    ok: true, workspace_path: ws, source_path: meta.source,
    pending: { added: d.added.slice(0, 100), modified: d.modified.slice(0, 100), deleted: d.deleted.slice(0, 100), counts: { added: d.added.length, modified: d.modified.length, deleted: d.deleted.length } },
    source_changed_since_copy: sourceChanged.slice(0, 50),
  };
}

async function deployWorkspace({ workspaceAbs, dryRun, force }) {
  const ws = path.resolve(String(workspaceAbs || ""));
  const meta = await readMeta(ws);
  if (!meta) return { ok: false, error: `${ws} 不是暫存工作區` };
  const source = meta.source;
  const d = await diffAgainstManifest(ws);
  const plan = [];
  const conflicts = [];
  const readSource = async (p) => { try { return await fs.readFile(path.join(source, p)); } catch (_) { return null; } };
  for (const p of [...d.added, ...d.modified, ...d.deleted]) {
    const kind = d.added.includes(p) ? "add" : d.modified.includes(p) ? "modify" : "delete";
    const cur = await readSource(p);
    const curHash = cur ? sha1(cur) : null;
    const baseHash = d.manifest[p] || null;
    const newHash = d.now[p] || null;
    if (curHash === newHash) continue;
    if (curHash !== baseHash && !force) { conflicts.push({ path: p, kind, reason: kind === "add" ? "原資料夾已經有不同內容的同名檔案" : "原資料夾的這個檔案在你開始修改後又被別人改過" }); continue; }
    plan.push({ path: p, kind });
  }
  if (dryRun) return { ok: true, dry_run: true, workspace_path: ws, source_path: source, would_apply: plan, conflicts };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(source, META_DIR, "backups", "deploy-" + ts);
  const applied = [], failed = [];
  for (const it of plan) {
    const dest = path.join(source, it.path);
    try {
      const old = await readSource(it.path);
      if (old) { const b = path.join(backupDir, it.path); await fs.mkdir(path.dirname(b), { recursive: true }); await fs.writeFile(b, old); }
      if (it.kind === "delete") { await fs.rm(dest, { force: true }); if (fss.existsSync(dest)) throw new Error("刪除後檔案仍存在"); }
      else {
        const buf = await fs.readFile(path.join(ws, it.path));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
        const back = await fs.readFile(dest);
        if (sha1(back) !== sha1(buf)) throw new Error("寫入後讀回內容不一致");
      }
      applied.push(it);
    } catch (err) { failed.push({ path: it.path, error: String((err && err.message) || err) }); }
  }
  if (!conflicts.length && !failed.length) await writeManifest(ws, d.now);
  else {
    const m = Object.assign({}, d.manifest);
    for (const it of applied) { if (it.kind === "delete") delete m[it.path]; else m[it.path] = d.now[it.path]; }
    await writeManifest(ws, m);
  }
  return {
    ok: failed.length === 0 && conflicts.length === 0, workspace_path: ws, source_path: source, applied, conflicts, failed,
    backup_dir: applied.length ? backupDir : null,
    verified: "每個寫入的檔案都已讀回並比對內容一致",
    note: conflicts.length ? "有檔案因為原資料夾也被改過而沒有轉移；請告訴使用者，確認要以暫存區為準時再用 force:true 重新 deploy。" : undefined,
  };
}

async function discardWorkspace({ workspaceAbs }) {
  const ws = path.resolve(String(workspaceAbs || ""));
  if (!(await readMeta(ws))) return { ok: false, error: `${ws} 不是暫存工作區，不會刪除` };
  await fs.rm(ws, { recursive: true, force: true });
  return { ok: true, discarded: ws };
}

module.exports = { openWorkspace, workspaceStatus, deployWorkspace, discardWorkspace, workspaceRoot };
