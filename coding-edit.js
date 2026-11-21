// coding domain 的「小工具式改檔」核心（純函式，不碰檔案系統）：
//   - applyEdits：搜尋／取代區塊（exact → 去行尾空白 → 忽略縮排，唯一性檢查、all-or-nothing）、建立／刪除檔案、在錨點前後插入
//   - regexEdits：跨多個檔案的正規表示式取代，可要求命中次數（expect）
//   - unifiedDiff：兩份文字 → 標準 unified diff（git apply 吃得下），讓每一次修改都留下可審查、可還原的 patch
// 為什麼不只靠 unified diff：弱模型手寫 hunk 的行號與 context 很容易錯；「找這段、換成那段」它寫得出來，
// 由程式負責定位（唯一才改）、保留縮排與換行風格、再產生真正的 diff。找不到時回傳最接近的實際內容，讓模型照實際內容重寫。
"use strict";

const EOL_RE = /\r\n/;
const detectEol = (t) => (EOL_RE.test(t) ? "\r\n" : "\n");
const toEol = (s, eol) => (eol === "\r\n" ? s.replace(/\r?\n/g, "\r\n") : s.replace(/\r\n/g, "\n"));
const lineOf = (text, idx) => { let n = 1; for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; };

function allIndexOf(text, s) {
  const out = []; if (!s) return out;
  for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + Math.max(1, s.length))) out.push(i);
  return out;
}

// 行為單位的寬鬆比對。mode: 'trimEnd'（忽略行尾空白）｜'trim'（忽略縮排與行尾空白）
function fuzzyLineMatches(text, search, mode) {
  const norm = (l) => (mode === 'trim' ? l.trim() : l.replace(/[ \t]+$/, ""));
  const tl = text.split("\n"), sl = search.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  if (!sl.length || sl.every((l) => !l.trim())) return [];
  const sn = sl.map((l) => norm(l.replace(/\r$/, "")));
  const offsets = []; let o = 0; for (const l of tl) { offsets.push(o); o += l.length + 1; }
  const res = [];
  for (let i = 0; i + sl.length <= tl.length; i++) {
    let ok = true;
    for (let k = 0; k < sl.length; k++) if (norm(tl[i + k].replace(/\r$/, "")) !== sn[k]) { ok = false; break; }
    if (ok) {
      const start = offsets[i]; const endLine = i + sl.length - 1; const end = offsets[endLine] + tl[endLine].length;
      res.push({ start, end, firstLine: i, actualIndent: /^[ \t]*/.exec(tl[i])[0], searchIndent: /^[ \t]*/.exec(sl[0])[0] });
    }
  }
  return res;
}

function reindent(replace, actualIndent, searchIndent) {
  if (actualIndent === searchIndent) return replace;
  return replace.split("\n").map((l) => {
    if (!l.trim()) return l;
    if (searchIndent && l.startsWith(searchIndent)) return actualIndent + l.slice(searchIndent.length);
    if (!searchIndent) return actualIndent + l;
    return l;
  }).join("\n");
}

// 找不到時：用「token 集合重疊」找最接近的一段（同樣行數的視窗），回傳實際內容讓模型重寫
function closestRegion(text, search) {
  const tl = text.split("\n"), sl = search.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const tok = (s) => new Set((s.toLowerCase().match(/[a-z_][a-z0-9_]*|\d+|[^\s\w]/g) || []));
  const st = tok(sl.join("\n")); if (!st.size || !tl.length) return null;
  const win = Math.max(1, Math.min(sl.length, tl.length)); let best = null;
  for (let i = 0; i + win <= tl.length; i++) {
    const wt = tok(tl.slice(i, i + win).join("\n")); let inter = 0; for (const t of st) if (wt.has(t)) inter++;
    const sim = inter / (st.size + wt.size - inter);
    if (!best || sim > best.sim) best = { sim, line: i + 1 };
  }
  if (!best || best.sim < 0.2) return null;
  const from = Math.max(0, best.line - 1 - 1), to = Math.min(tl.length, best.line - 1 + win + 1);
  return { line: best.line, similarity: Math.round(best.sim * 100) / 100, actual: tl.slice(from, to).map((l, k) => String(from + k + 1).padStart(4) + "| " + l.replace(/\r$/, "")).join("\n") };
}

// files：{path: 文字或 null(不存在)}；edits：見檔頭。回傳 {ok, files, changes, errors}
function applyEdits(files, edits) {
  const cur = {}; for (const [p, t] of Object.entries(files || {})) cur[p] = t;
  const changes = {}; const errors = [];
  const note = (p, k, n) => { const c = changes[p] || (changes[p] = { path: p, kind: files[p] == null ? "create" : "modify", edits: 0, fuzzy: [] }); c.edits += n || 1; if (k) c.fuzzy.push(k); if (c.kind === "create" && files[p] != null) c.kind = "modify"; };
  (edits || []).forEach((e, index) => {
    const err = (error, extra) => errors.push(Object.assign({ index, path: e && e.path, error }, extra || {}));
    if (!e || typeof e.path !== "string" || !e.path.trim()) return err("缺少 path");
    const p = e.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p) || /^[A-Za-z]:/.test(p)) return err("path 必須是相對於專案根目錄的路徑（不能是絕對路徑或含 ..）");
    if (/(^|\/)\.git(\/|$)/.test(p)) return err("不能改 .git 底下的檔案");
    if (e.delete) { if (cur[p] == null) return err("要刪除的檔案不存在"); cur[p] = null; changes[p] = { path: p, kind: "delete", edits: 1, fuzzy: [] }; return; }
    if (typeof e.create === "string") {
      if (cur[p] != null && !e.overwrite) return err("檔案已存在（要整個覆蓋請加 overwrite:true；只改一部分請用 search/replace）");
      const existed = cur[p] != null; cur[p] = e.create; changes[p] = { path: p, kind: existed ? "modify" : "create", edits: 1, fuzzy: [] }; return;
    }
    if (cur[p] == null) return err("檔案不存在：" + p + "（要新增檔案請用 create）");
    let text = cur[p]; const eol = detectEol(text);
    let search, replace;
    if (typeof e.insert_after === "string" || typeof e.insert_before === "string") {
      const anchor = e.insert_after != null ? e.insert_after : e.insert_before; if (typeof e.text !== "string") return err("insert_after／insert_before 需要 text");
      search = anchor; replace = e.insert_after != null ? anchor + "\n" + e.text : e.text + "\n" + anchor;
    } else if (typeof e.search === "string") { search = e.search; replace = typeof e.replace === "string" ? e.replace : ""; }
    else return err("要有 search（搭配 replace）、insert_after／insert_before（搭配 text）、create 或 delete 其中之一");
    if (!search.trim()) return err("search 不能是空的");
    const s = toEol(search, eol), r = toEol(replace, eol);
    let hits = allIndexOf(text, s).map((i) => ({ start: i, end: i + s.length, rep: r })); let fuzzy = null;
    if (!hits.length) {
      for (const mode of ["trimEnd", "trim"]) {
        const m = fuzzyLineMatches(text, s, mode);
        if (m.length) { hits = m.map((x) => ({ start: x.start, end: x.end, rep: mode === "trim" ? reindent(r.replace(/\r\n/g, "\n"), x.actualIndent, x.searchIndent) : r.replace(/\r\n/g, "\n") })); fuzzy = mode === "trim" ? "忽略縮排" : "忽略行尾空白"; break; }
      }
      if (hits.length && eol === "\r\n") hits.forEach((h) => { h.rep = toEol(h.rep, eol); });
    }
    if (!hits.length) { const near = closestRegion(text, s); return err("找不到 search 的內容（逐字比對、也試過忽略行尾空白與縮排）", near ? { closest: near, hint: "最接近的實際內容在第 " + near.line + " 行附近（相似度 " + near.similarity + "）；請照實際內容重寫 search，不要憑記憶" } : { hint: "檔案裡完全沒有相似的內容；先重新讀檔確認" }); }
    if (hits.length > 1 && !e.all) return err("search 在檔案裡出現了 " + hits.length + " 次，無法判斷要改哪一處", { lines: hits.slice(0, 8).map((h) => lineOf(text, h.start)), hint: "在 search 裡多帶前後幾行讓它唯一；或確定每一處都要改就加 all:true（最好同時給 expect:" + hits.length + "）" });
    if (e.expect != null && Number(e.expect) !== hits.length) return err("命中 " + hits.length + " 處，但 expect 是 " + e.expect + "（沒有修改）", { lines: hits.slice(0, 8).map((h) => lineOf(text, h.start)) });
    hits.sort((a, b) => b.start - a.start);
    for (const h of hits) text = text.slice(0, h.start) + h.rep + text.slice(h.end);
    cur[p] = text; note(p, fuzzy, hits.length);
  });
  if (errors.length) return { ok: false, files: {}, changes: [], errors };
  const out = {}; for (const p of Object.keys(changes)) out[p] = cur[p];
  return { ok: true, files: out, changes: Object.values(changes), errors: [] };
}

// 跨檔案正規表示式取代。files：{path: 文字}；opts：{pattern, flags, replacement, expect_count, expect_files}
function regexEdits(files, opts) {
  const errors = [];
  let re; try { re = new RegExp(String(opts.pattern), (String(opts.flags || "g").replace(/[^gimsuy]/g, "").replace(/g/g, "") + "g")); } catch (e) { return { ok: false, files: {}, changes: [], errors: [{ error: "正規表示式不合法：" + e.message }] }; }
  const out = {}; const changes = []; let total = 0;
  for (const [p, t] of Object.entries(files)) {
    if (t == null) continue; let n = 0;
    const nt = t.replace(re, (...a) => { n++; const groups = typeof a[a.length - 1] === "object" ? a.pop() : null; void groups; const m = a[0]; return String(opts.replacement == null ? "" : opts.replacement).replace(/\$(\d+|&|\$)/g, (_, k) => (k === "$" ? "$" : k === "&" ? m : (a[Number(k)] == null ? "" : a[Number(k)]))); });
    if (n) { out[p] = nt; total += n; changes.push({ path: p, kind: "modify", edits: n, fuzzy: [] }); }
  }
  if (opts.expect_count != null && Number(opts.expect_count) !== total) errors.push({ error: "共命中 " + total + " 處，但 expect_count 是 " + opts.expect_count + "（沒有修改）", matches: changes.map((c) => c.path + "：" + c.edits).slice(0, 30) });
  if (opts.expect_files != null && Number(opts.expect_files) !== changes.length) errors.push({ error: "共改到 " + changes.length + " 個檔案，但 expect_files 是 " + opts.expect_files + "（沒有修改）", matches: changes.map((c) => c.path).slice(0, 30) });
  if (!total && !errors.length) errors.push({ error: "沒有任何命中（正規表示式在這些檔案裡找不到東西）" });
  if (errors.length) return { ok: false, files: {}, changes: [], errors };
  return { ok: true, files: out, changes, errors: [], total };
}

// ---- unified diff ----
function splitLines(t) { if (t === "") return { lines: [], eofNl: true }; const eofNl = /\n$/.test(t); const lines = t.split("\n"); if (eofNl) lines.pop(); return { lines, eofNl }; }
function lcsOps(a, b) { // 回傳 [{t:' '|'-'|'+', s}]
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf); const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: " ", s: a[i] });
  if (am.length * bm.length > 4e6) { am.forEach((s) => ops.push({ t: "-", s })); bm.forEach((s) => ops.push({ t: "+", s })); }
  else {
    const n = am.length, m = bm.length; const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) { if (am[i] === bm[j]) { ops.push({ t: " ", s: am[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", s: am[i++] }); } else { ops.push({ t: "+", s: bm[j++] }); } }
    while (i < n) ops.push({ t: "-", s: am[i++] }); while (j < m) ops.push({ t: "+", s: bm[j++] });
  }
  for (let k = a.length - suf; k < a.length; k++) ops.push({ t: " ", s: a[k] });
  return ops;
}
function unifiedDiff(path, oldText, newText, ctx) {
  ctx = ctx == null ? 3 : ctx; if (oldText === newText) return "";
  const A = splitLines(oldText == null ? "" : oldText), B = splitLines(newText == null ? "" : newText);
  const ops = lcsOps(A.lines, B.lines);
  // 結尾沒有換行（"\ No newline at end of file"）：標在各自「最後一行」之後；兩邊最後一行是同一個 context 行、但換行狀態不同時要拆成 -／+
  { let lastA = -1, lastB = -1; ops.forEach((o, k) => { if (o.t !== "+") lastA = k; if (o.t !== "-") lastB = k; });
    const split = (k, nlA, nlB) => { const o = ops[k]; ops.splice(k, 1, { t: "-", s: o.s, nonl: nlA }, { t: "+", s: o.s, nonl: nlB }); };
    if (lastA >= 0 && lastA === lastB && ops[lastA].t === " ") {
      if (A.eofNl === B.eofNl) { if (!A.eofNl) ops[lastA].nonl = true; } else split(lastA, !A.eofNl, !B.eofNl);
    } else {
      const jobs = [];
      if (lastA >= 0 && !A.eofNl) jobs.push([lastA, "A"]);
      if (lastB >= 0 && !B.eofNl) jobs.push([lastB, "B"]);
      jobs.sort((x, y) => y[0] - x[0]);
      for (const [k, side] of jobs) { if (ops[k].t === " ") split(k, side === "A", side === "B"); else ops[k].nonl = true; }
    } }
  const hunks = []; let i = 0, ao = 0, bo = 0; const idxA = [], idxB = [];
  ops.forEach((o) => { idxA.push(ao); idxB.push(bo); if (o.t !== "+") ao++; if (o.t !== "-") bo++; });
  const changed = ops.map((o, k) => (o.t !== " " ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) { // 只有「空檔案的建立／刪除」才會走到這裡（沒有任何 hunk）
    if (oldText == null && newText != null) return "diff --git a/" + path + " b/" + path + "\nnew file mode 100644\nindex 0000000..e69de29\n";
    if (newText == null && oldText != null) return "diff --git a/" + path + " b/" + path + "\ndeleted file mode 100644\nindex e69de29..0000000\n";
    return "";
  }
  let start = Math.max(0, changed[0] - ctx), end = Math.min(ops.length - 1, changed[0] + ctx);
  const groups = [];
  for (const k of changed) { if (k - ctx <= end + 1) end = Math.min(ops.length - 1, k + ctx); else { groups.push([start, end]); start = Math.max(0, k - ctx); end = Math.min(ops.length - 1, k + ctx); } }
  groups.push([start, end]);
  const body = [];
  for (const [s, e] of groups) {
    const seg = ops.slice(s, e + 1); const ac = seg.filter((o) => o.t !== "+").length, bc = seg.filter((o) => o.t !== "-").length;
    const aStart = ac ? idxA[s] + 1 : idxA[s], bStart = bc ? idxB[s] + 1 : idxB[s];
    body.push("@@ -" + aStart + (ac === 1 ? "" : "," + ac) + " +" + bStart + (bc === 1 ? "" : "," + bc) + " @@");
    for (const o of seg) { body.push(o.t + o.s); if (o.nonl) body.push("\\ No newline at end of file"); }
  }
  const head = ["diff --git a/" + path + " b/" + path];
  if (oldText == null) head.push("new file mode 100644", "--- /dev/null", "+++ b/" + path);
  else if (newText == null) head.push("deleted file mode 100644", "--- a/" + path, "+++ /dev/null");
  else head.push("--- a/" + path, "+++ b/" + path);
  return head.concat(body).join("\n") + "\n";
}
function diffForChanges(files, newFiles) {
  const out = []; for (const p of Object.keys(newFiles).sort()) { const d = unifiedDiff(p, files[p] == null ? null : files[p], newFiles[p], 3); if (d) out.push(d); }
  return out.join("");
}

module.exports = { applyEdits, regexEdits, unifiedDiff, diffForChanges, closestRegion };
