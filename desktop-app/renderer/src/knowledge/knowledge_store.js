/* Knowledge Inventory 的儲存層（UMD）：一個 SQLite3 檔（副檔名 .keeplookup），放來源、章節、片段、全文索引（FTS5）、向量、關聯、摘要。
 * 這裡只管 SQL：用 exec(sql, bind) → Promise<[{ columns, rows }]> 跟任何 SQLite 引擎講話（桌面版 node:sqlite、網頁版 sqlite-wasm、測試用的 node:sqlite 都一樣），
 * 檔案放哪裡（IndexedDB、磁碟、FAP）由 app 那層決定，這裡不知道也不在意。
 * BLOB 的交換格式跟引擎協定一致：綁定時 { $blob: base64 }，讀回來也是 { $blob: base64 }。
 * 全文索引用核心的斷詞（CJK 二字詞）預先斷好存進 toks 欄位，所以中文也能查；FTS5 的 unicode61 另外把 . - _ 當成詞的一部分，讓 flux.1-schnell 這種詞完整。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./knowledge_core.js')); else root.FaKnowledgeStore = factory(root.FaKnowledge || (typeof FaKnowledge !== 'undefined' ? FaKnowledge : undefined));
})(typeof self !== 'undefined' ? self : this, function (K) {
  'use strict';
  var VERSION = 1;
  var SCHEMA = [
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)',
    'CREATE TABLE IF NOT EXISTS sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT, url TEXT, hash TEXT, notes TEXT, text TEXT NOT NULL, loc_runs TEXT, outline_style TEXT, chars INTEGER, enabled INTEGER DEFAULT 1, tags TEXT, added_at INTEGER, updated_at INTEGER)',
    'CREATE INDEX IF NOT EXISTS sources_name ON sources(name)',
    'CREATE TABLE IF NOT EXISTS sections (source_id INTEGER, n INTEGER, level INTEGER, title TEXT, line_start INTEGER, line_end INTEGER, chars INTEGER, PRIMARY KEY (source_id, n))',
    'CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, source_id INTEGER, n INTEGER, line_start INTEGER, line_end INTEGER, text TEXT, section TEXT, section_n INTEGER, loc TEXT, toks TEXT)',
    'CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id)',
    "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(toks, content='', tokenize=\"unicode61 tokenchars '.-_'\")",
    'CREATE TABLE IF NOT EXISTS vectors (chunk_id INTEGER PRIMARY KEY, model TEXT, dim INTEGER, vec BLOB)',
    'CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY, kind TEXT, term TEXT, from_source INTEGER, from_start INTEGER, from_end INTEGER, from_quote TEXT, to_source INTEGER, to_start INTEGER, to_end INTEGER, to_quote TEXT, status TEXT DEFAULT \'auto\')',
    'CREATE TABLE IF NOT EXISTS summaries (source_id INTEGER, section TEXT, line_start INTEGER, line_end INTEGER, quote TEXT)',
  ];

  // ───── 小工具 ─────
  function b64FromBytes(u8) { var s = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'); }
  function bytesFromB64(b64) { var bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary'); var u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  function vecToBlob(v) { var f = v instanceof Float32Array ? v : Float32Array.from(v); return { $blob: b64FromBytes(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)) }; }
  function blobToVec(b) { var u = bytesFromB64(b && b.$blob ? b.$blob : ''); return new Float32Array(u.buffer, u.byteOffset, Math.floor(u.byteLength / 4)); }
  function hashText(s) { var h = 2166136261 >>> 0; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0') + ':' + s.length; }
  function rowsOf(res) { var r = res && res[0]; if (!r || !r.columns) return []; return r.rows.map(function (row) { var o = {}; r.columns.forEach(function (c, i) { o[c] = row[i]; }); return o; }); }
  function ftsQuery(tokens) { return tokens.slice(0, 24).map(function (t) { return '"' + t.replace(/"/g, '""') + '"'; }).join(' OR '); }

  // 每一行的位置資訊壓成「從第幾行開始是哪個位置」的清單（頁、投影片、時間、工作表…），查某一行時二分搜尋
  function locRuns(locators) {
    var runs = [], last = null;
    (locators || []).forEach(function (l, i) { var j = JSON.stringify(l || {}); if (j !== last) { runs.push([i + 1, l || {}]); last = j; } });
    return runs;
  }
  function locAtFrom(runs) { return function (line) { var lo = 0, hi = runs.length - 1, ans = null; while (lo <= hi) { var mid = (lo + hi) >> 1; if (runs[mid][0] <= line) { ans = runs[mid][1]; lo = mid + 1; } else hi = mid - 1; } return ans; }; }

  function Store(exec, opts) { this.exec = exec; this.opts = opts || {}; this.denseCache = null; }
  Store.prototype.init = async function () {
    for (var i = 0; i < SCHEMA.length; i++) await this.exec(SCHEMA[i]);
    var v = rowsOf(await this.exec("SELECT value FROM meta WHERE key='version'"));
    if (!v.length) await this.exec("INSERT INTO meta(key,value) VALUES('version', ?)", [String(VERSION)]);
    else if (Number(v[0].value) > VERSION) throw new Error('這個知識庫檔案是比較新的版本（' + v[0].value + '），這個 app 只認得到版本 ' + VERSION);
    return { version: VERSION };
  };
  Store.prototype.getMeta = async function (k) { var r = rowsOf(await this.exec('SELECT value FROM meta WHERE key=?', [k])); return r.length ? r[0].value : null; };
  Store.prototype.setMeta = async function (k, v) { await this.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, String(v)]); };

  // src：K.ingest() 的結果。同名同內容（hash 相同）就不動；同名內容變了就整份換掉。回傳 { id, status: 'added'|'updated'|'unchanged', chunks }
  Store.prototype.addSource = async function (src, o) {
    o = o || {}; var hash = o.hash || hashText(src.text), now = Date.now();
    var ex = rowsOf(await this.exec('SELECT id, hash FROM sources WHERE name=? AND IFNULL(url,\'\')=?', [src.name, src.url || '']));
    var id = null, status = 'added';
    if (ex.length) { if (ex[0].hash === hash && !o.force) return { id: ex[0].id, status: 'unchanged', chunks: 0 }; id = ex[0].id; status = 'updated'; await this._dropContent(id);
      // 來源內容變了：模型提出的／使用者確認過的關聯不默默指到別行，標成「失效」；程式建立的會在重算時重來
      await this.exec("UPDATE links SET status='stale' WHERE (from_source=? OR to_source=?) AND status IN ('proposed','confirmed')", [id, id]); }
    if (id == null) {
      await this.exec('INSERT INTO sources(name, kind, url, hash, notes, text, loc_runs, outline_style, chars, enabled, tags, added_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [src.name, src.kind, src.url || null, hash, JSON.stringify(src.notes || []), src.text, JSON.stringify(locRuns(src.locators)), src.outline_style || '', src.text.length, 1, o.tags ? JSON.stringify(o.tags) : null, now, now]);
      id = Number(rowsOf(await this.exec('SELECT last_insert_rowid() AS id'))[0].id);
    } else {
      await this.exec('UPDATE sources SET kind=?, hash=?, notes=?, text=?, loc_runs=?, outline_style=?, chars=?, updated_at=? WHERE id=?', [src.kind, hash, JSON.stringify(src.notes || []), src.text, JSON.stringify(locRuns(src.locators)), src.outline_style || '', src.text.length, now, id]);
    }
    for (var i = 0; i < src.sections.length; i++) { var s = src.sections[i]; await this.exec('INSERT INTO sections(source_id,n,level,title,line_start,line_end,chars) VALUES(?,?,?,?,?,?,?)', [id, s.n, s.level, s.title, s.line_start, s.line_end, s.chars]); }
    for (var j = 0; j < src.chunks.length; j++) {
      var c = src.chunks[j], toks = K.tokenize(c.text + ' ' + (c.section || '')).join(' ');
      await this.exec('INSERT INTO chunks(source_id,n,line_start,line_end,text,section,section_n,loc,toks) VALUES(?,?,?,?,?,?,?,?,?)', [id, c.n, c.line_start, c.line_end, c.text, c.section || '', c.section_n || 0, c.loc || '', toks]);
      var cid = Number(rowsOf(await this.exec('SELECT last_insert_rowid() AS id'))[0].id);
      await this.exec('INSERT INTO chunks_fts(rowid, toks) VALUES(?,?)', [cid, toks]);
    }
    this.denseCache = null;
    return { id: id, status: status, chunks: src.chunks.length };
  };
  Store.prototype._dropContent = async function (id) {
    var ids = rowsOf(await this.exec('SELECT id FROM chunks WHERE source_id=?', [id])).map(function (r) { return r.id; });
    for (var i = 0; i < ids.length; i++) { await this.exec("INSERT INTO chunks_fts(chunks_fts, rowid, toks) VALUES('delete', ?, (SELECT toks FROM chunks WHERE id=?))", [ids[i], ids[i]]); }
    await this.exec('DELETE FROM vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id=?)', [id]);
    await this.exec('DELETE FROM chunks WHERE source_id=?', [id]); await this.exec('DELETE FROM sections WHERE source_id=?', [id]);
    await this.exec('DELETE FROM summaries WHERE source_id=?', [id]); await this.exec('DELETE FROM links WHERE from_source=? OR to_source=?', [id, id]);
    this.denseCache = null;
  };
  Store.prototype.removeSource = async function (id) { await this._dropContent(id); await this.exec('DELETE FROM sources WHERE id=?', [id]); return { ok: true }; };
  Store.prototype.setEnabled = async function (id, on) { await this.exec('UPDATE sources SET enabled=? WHERE id=?', [on ? 1 : 0, id]); this.denseCache = null; };
  Store.prototype.listSources = async function () {
    return rowsOf(await this.exec('SELECT s.id, s.name, s.kind, s.url, s.chars, s.enabled, s.updated_at, s.tags, (SELECT COUNT(*) FROM chunks c WHERE c.source_id=s.id) AS chunks, (SELECT COUNT(*) FROM vectors v JOIN chunks c ON c.id=v.chunk_id WHERE c.source_id=s.id) AS vectors, (SELECT COUNT(*) FROM sections x WHERE x.source_id=s.id) AS sections FROM sources s ORDER BY s.name'));
  };
  Store.prototype.findSource = async function (ref) {
    var all = await this.listSources(), r = String(ref == null ? '' : ref).trim(), lower = r.toLowerCase();
    var hit = all.filter(function (s) { return String(s.id) === r; })[0] || all.filter(function (s) { return s.name === r; })[0] || all.filter(function (s) { return s.name.toLowerCase() === lower; })[0] || all.filter(function (s) { return s.name.toLowerCase().indexOf(lower) >= 0; })[0];
    return hit || null;
  };
  // 還原成核心函式用的來源物件（lines、sections、locAt）
  Store.prototype.getSource = async function (id) {
    var r = rowsOf(await this.exec('SELECT * FROM sources WHERE id=?', [id]))[0]; if (!r) return null;
    var secs = rowsOf(await this.exec('SELECT n, level, title, line_start, line_end, chars FROM sections WHERE source_id=? ORDER BY n', [id]));
    var runs = []; try { runs = JSON.parse(r.loc_runs || '[]'); } catch (_) { runs = []; }
    return { id: r.id, name: r.name, kind: r.kind, url: r.url, text: r.text, lines: r.text.split('\n'), sections: secs, locAt: locAtFrom(runs), locators: [], notes: JSON.parse(r.notes || '[]'), enabled: !!r.enabled };
  };

  // ───── 向量 ─────
  Store.prototype.pendingVectors = async function (model, limit) {
    return rowsOf(await this.exec('SELECT c.id, c.text, c.section FROM chunks c JOIN sources s ON s.id=c.source_id LEFT JOIN vectors v ON v.chunk_id=c.id AND v.model=? WHERE v.chunk_id IS NULL ORDER BY c.id LIMIT ?', [model, limit || 64]));
  };
  Store.prototype.putVectors = async function (model, items) {
    for (var i = 0; i < items.length; i++) await this.exec('INSERT INTO vectors(chunk_id, model, dim, vec) VALUES(?,?,?,?) ON CONFLICT(chunk_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec', [items[i].id, model, items[i].vec.length, vecToBlob(items[i].vec)]);
    this.denseCache = null;
  };
  Store.prototype._dense = async function (model) {
    if (this.denseCache && this.denseCache.model === model) return this.denseCache.rows;
    var rows = rowsOf(await this.exec('SELECT v.chunk_id AS id, v.vec AS vec, c.source_id AS source_id FROM vectors v JOIN chunks c ON c.id=v.chunk_id JOIN sources s ON s.id=c.source_id WHERE v.model=? AND s.enabled=1', [model])).map(function (r) { return { id: r.id, source_id: r.source_id, vec: blobToVec(r.vec) }; });
    this.denseCache = { model: model, rows: rows }; return rows;
  };

  // ───── 檢索：FTS5（關鍵字，BM25）＋向量（語意），RRF 合併；只回原文與出處 ─────
  // opts: { limit, sources:[id], queryVec, model, minDense, minCoverage }
  Store.prototype.search = async function (query, opts) {
    opts = opts || {}; var limit = opts.limit || 5, qt = Array.from(new Set(K.queryTokens(query))), k = 60;
    var allowed = opts.sources ? new Set(opts.sources.map(Number)) : null, fused = {};
    var addHit = function (id, how, r) { var f = fused[id] = fused[id] || { rrf: 0, how: [], sim: null }; f.rrf += 1 / (k + r + 1); if (f.how.indexOf(how) < 0) f.how.push(how); };
    var covOf = {};
    // 太常見的字（出現在超過 25% 片段，例如整份手冊裡的產品名）只要問句裡還有更有鑑別力的字，就不參與比對
    if (qt.length > 1) {
      var nch = Number((rowsOf(await this.exec('SELECT COUNT(*) AS n FROM chunks'))[0] || {}).n || 0), dfs = {};
      if (nch >= 20) { for (var qi = 0; qi < qt.length && qi < 24; qi++) { try { dfs[qt[qi]] = Number((rowsOf(await this.exec('SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?', [ftsQuery([qt[qi]])]))[0] || {}).n || 0); } catch (e) { dfs[qt[qi]] = 0; } }
        var rare = qt.filter(function (t) { return dfs[t] <= nch * 0.25; }); if (rare.length && rare.length < qt.length) qt = rare; }
    }
    if (qt.length) {
      var rows = rowsOf(await this.exec('SELECT c.id AS id, c.source_id AS source_id, c.toks AS toks FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN sources s ON s.id=c.source_id WHERE chunks_fts MATCH ? AND s.enabled=1 ORDER BY bm25(chunks_fts) LIMIT 80', [ftsQuery(qt)]));
      var minCov = opts.minCoverage == null ? 0.3 : opts.minCoverage, rank = 0;
      rows.forEach(function (r) { if (allowed && !allowed.has(Number(r.source_id))) return; var set = new Set(String(r.toks || '').split(' ')), m = 0; qt.forEach(function (t) { if (set.has(t)) m++; }); var cov = m / qt.length; if (cov < minCov) return; covOf[r.id] = cov; addHit(r.id, '關鍵字', rank++); });
    }
    if (opts.queryVec && opts.queryVec.length) {
      var qv = opts.queryVec, all = [];
      (await this._dense(opts.model || '')).forEach(function (d) { if (d.vec.length !== qv.length) return; if (allowed && !allowed.has(Number(d.source_id))) return; var dot = 0; for (var i = 0; i < qv.length; i++) dot += qv[i] * d.vec[i]; all.push({ id: d.id, sim: dot }); });
      K.denseKeep(all, opts).sort(function (a, b) { return b.sim - a.sim; }).slice(0, 40).forEach(function (x, r) { addHit(x.id, '語意', r); fused[x.id].sim = Math.round(x.sim * 1000) / 1000; });
    }
    var ranked = Object.keys(fused).sort(function (a, b) { return fused[b].rrf - fused[a].rrf; });
    if (K.isHowTo(query) && ranked.length) {
      var top = ranked.slice(0, 40), trows = rowsOf(await this.exec('SELECT id, text FROM chunks WHERE id IN (' + top.map(function () { return '?'; }).join(',') + ')', top.map(Number)));
      trows.forEach(function (r) { var lines = String(r.text).split('\n'); if (lines.some(function (l) { return K.cmdLine(l) && qt.some(function (t) { return K.fold(l).toLowerCase().indexOf(t) >= 0; }); })) fused[r.id].rrf += 0.02; });
      ranked = Object.keys(fused).sort(function (a, b) { return fused[b].rrf - fused[a].rrf; });
    }
    var ids = ranked.slice(0, limit + 4); if (!ids.length) return [];
    var chunks = rowsOf(await this.exec('SELECT id, source_id, n, line_start, line_end, text FROM chunks WHERE id IN (' + ids.map(function () { return '?'; }).join(',') + ')', ids.map(Number)));
    var byId = {}; chunks.forEach(function (c) { byId[c.id] = c; });
    var srcCache = {}, out = [];
    for (var i = 0; i < ids.length; i++) {
      var ch = byId[ids[i]]; if (!ch) continue;
      var src = srcCache[ch.source_id]; if (!src) { var full = await this.getSource(ch.source_id); src = srcCache[ch.source_id] = { id: full.id, name: full.name, kind: full.kind, sections: full.sections, locAt: full.locAt, locators: [], lines: [] }; }
      var lines = new Array(ch.line_end), cl = String(ch.text).split('\n'); cl.forEach(function (t, j) { lines[ch.line_start - 1 + j] = t; });
      var tmp = { lines: lines }, pp = K.pinpoint(tmp, ch, qt);
      var c = K.cite(src, pp.a, pp.b, lines.slice(pp.a - 1, pp.b).join('\n'));
      var f = fused[ids[i]];
      if (out.some(function (o) { return o.source_id === c.source_id && o.line_start <= c.line_end && c.line_start <= o.line_end; })) continue; // 重疊的片段命中同一段，只留一條
      out.push(Object.assign(c, { score: Math.round(f.rrf * 10000) / 10000, found_by: f.how.join('＋'), coverage: covOf[ids[i]] != null ? Math.round(covOf[ids[i]] * 100) / 100 : undefined, similarity: f.sim != null ? f.sim : undefined, chunk_n: ch.n, chunk_line_start: ch.line_start, chunk_line_end: ch.line_end }));
    }
    return out.slice(0, limit);
  };
  Store.prototype.answer = async function (question, opts) {
    var hits = await this.search(question, opts);
    if (!hits.length) return { ok: true, found: false, message: '在目前選用的來源裡找不到相關內容。', hits: [] };
    return { ok: true, found: true, hits: hits.map(function (h) { return { label: h.label, source: h.source, source_id: h.source_id, line_start: h.line_start, line_end: h.line_end, section: h.section, loc: h.loc, quote: h.quote, found_by: h.found_by, score: h.score }; }) };
  };

  // ───── 摘要、細節、關聯 ─────
  Store.prototype.summary = async function (id, o) {
    var src = await this.getSource(id); if (!src) return { error: '找不到這個來源' };
    var list = K.summarize(src, o); var chk = K.verifyAll(src, list);
    var good = list.filter(function (x) { return chk.bad.indexOf(x) < 0; });
    await this.exec('DELETE FROM summaries WHERE source_id=?', [id]);
    for (var i = 0; i < good.length; i++) await this.exec('INSERT INTO summaries(source_id, section, line_start, line_end, quote) VALUES(?,?,?,?,?)', [id, good[i].section, good[i].line_start, good[i].line_end, good[i].quote]);
    return { source: src.name, kind: 'extractive', note: '摘要的每一句都是來源裡的原句，附行號；沒有改寫。', sentences: good, dropped: chk.bad.length };
  };
  Store.prototype.outline = async function (id) {
    var src = await this.getSource(id); if (!src) return { error: '找不到這個來源' };
    return { source: src.name, source_id: src.id, kind: src.kind, lines: src.lines.length, notes: src.notes, sections: src.sections.map(function (s) { return { n: s.n, level: s.level, title: s.title, line_start: s.line_start, line_end: s.line_end, chars: s.chars }; }) };
  };
  Store.prototype.detail = async function (id, which, o) {
    var src = await this.getSource(id); if (!src) return { error: '找不到這個來源' };
    var d = K.detail(src, which, o); if (d.error) return d;
    return { source: src.name, source_id: src.id, cite: d.cite, lines: d.lines, truncated: d.truncated, next_line: d.next_line };
  };
  // 重新計算關聯（只用字面證據）；使用者確認過或拒絕過的（status 不是 auto）保留
  Store.prototype.rebuildLinks = async function () {
    var ids = rowsOf(await this.exec('SELECT id FROM sources WHERE enabled=1')).map(function (r) { return r.id; }), srcs = [];
    for (var i = 0; i < ids.length; i++) srcs.push(await this.getSource(ids[i]));
    await this.exec("DELETE FROM links WHERE status='auto'");
    var ls = K.links(srcs, { max: 200 }), n = 0;
    for (var j = 0; j < ls.length; j++) { var l = ls[j], to = l.to; var toId = to.source_id != null ? to.source_id : null; await this.exec('INSERT INTO links(kind, term, from_source, from_start, from_end, from_quote, to_source, to_start, to_end, to_quote, status) VALUES(?,?,?,?,?,?,?,?,?,?,\'auto\')', [l.kind, l.term, l.from.source_id, l.from.line_start, l.from.line_end, l.from.quote, toId, to.line_start || null, to.line_end || null, to.quote || null]); n++; }
    return { links: n };
  };
  Store.prototype.getLinks = async function (id) {
    var rows = rowsOf(await this.exec('SELECT l.*, a.name AS from_name, b.name AS to_name FROM links l JOIN sources a ON a.id=l.from_source JOIN sources b ON b.id=l.to_source WHERE l.status<>\'rejected\'' + (id != null ? ' AND (l.from_source=? OR l.to_source=?)' : '') + ' ORDER BY CASE l.status WHEN \'proposed\' THEN 0 WHEN \'confirmed\' THEN 1 WHEN \'auto\' THEN 2 ELSE 3 END, l.kind, l.id LIMIT 300', id != null ? [id, id] : []));
    return rows.map(function (r) { return { id: r.id, kind: r.kind, term: r.term, status: r.status, from: { source: r.from_name, source_id: r.from_source, line_start: r.from_start, line_end: r.from_end, quote: r.from_quote }, to: { source: r.to_name, source_id: r.to_source, line_start: r.to_start, line_end: r.to_end, quote: r.to_quote } }; });
  };
  // 模型提出的關聯：兩段原文各自的某一行都逐字含有 term 才存（status='proposed'，要使用者確認才用在回答裡）
  Store.prototype.proposeLink = async function (kind, term, a, b) {
    var ta = K.foldLow(term); if (!ta || ta.length < 3) return { ok: false, why: '片語太短' };
    var la = null, lb = null, srcA = await this.getSource(a.source_id), srcB = await this.getSource(b.source_id); if (!srcA || !srcB) return { ok: false, why: '找不到來源' };
    for (var i = a.line_start; i <= a.line_end && !la; i++) if (K.foldLow(srcA.lines[i - 1]).indexOf(ta) >= 0) la = i;
    for (var j = b.line_start; j <= b.line_end && !lb; j++) if (K.foldLow(srcB.lines[j - 1]).indexOf(ta) >= 0) lb = j;
    if (!la || !lb) return { ok: false, why: '片語沒有同時逐字出現在兩邊的行裡' };
    var dup = rowsOf(await this.exec('SELECT id FROM links WHERE kind=? AND term=? AND from_source=? AND to_source=?', [kind, term, a.source_id, b.source_id]));
    if (dup.length) return { ok: false, why: '已經有了' };
    await this.exec('INSERT INTO links(kind, term, from_source, from_start, from_end, from_quote, to_source, to_start, to_end, to_quote, status) VALUES(?,?,?,?,?,?,?,?,?,?,\'proposed\')', [kind, term, a.source_id, la, la, srcA.lines[la - 1].trim().slice(0, 160), b.source_id, lb, lb, srcB.lines[lb - 1].trim().slice(0, 160)]);
    return { ok: true };
  };
  // 不同來源、意思接近的片段配對（要有語意向量）：每個片段找最像的「別的來源」的片段，取最像的前 maxPairs 組，同一對來源最多 3 組
  Store.prototype.nearestPairs = async function (model, maxPairs, minSim) {
    var dense = (await this._dense(model)).slice(0, 3000), best = [];
    for (var i = 0; i < dense.length; i++) { var bj = -1, bs = -1; for (var j = 0; j < dense.length; j++) { if (dense[j].source_id === dense[i].source_id || dense[j].vec.length !== dense[i].vec.length) continue; var d = 0, u = dense[i].vec, v = dense[j].vec; for (var k = 0; k < u.length; k++) d += u[k] * v[k]; if (d > bs) { bs = d; bj = j; } } if (bj >= 0 && bs >= minSim && dense[i].id < dense[bj].id) best.push({ a: dense[i].id, b: dense[bj].id, sim: bs }); }
    best.sort(function (x, y) { return y.sim - x.sim; }); var perPair = {}, pick = [];
    for (var m = 0; m < best.length && pick.length < maxPairs; m++) { var ca = best[m]; var rows = rowsOf(await this.exec('SELECT id, source_id, line_start, line_end, text FROM chunks WHERE id IN (?,?)', [ca.a, ca.b])); var ra = rows.filter(function (r) { return r.id === ca.a; })[0], rb = rows.filter(function (r) { return r.id === ca.b; })[0]; if (!ra || !rb) continue; var pk = Math.min(ra.source_id, rb.source_id) + '-' + Math.max(ra.source_id, rb.source_id); perPair[pk] = (perPair[pk] || 0) + 1; if (perPair[pk] > 3) continue; pick.push({ sim: ca.sim, a: { source_id: ra.source_id, line_start: ra.line_start, line_end: ra.line_end, text: ra.text }, b: { source_id: rb.source_id, line_start: rb.line_start, line_end: rb.line_end, text: rb.text } }); }
    return pick;
  };
  // 命中的片段旁邊的關聯（程式建立的與使用者確認過的，一跳）：回答時顯示「這裡還有相關的」
  Store.prototype.relatedOf = async function (sourceId, a, b) {
    var rows = rowsOf(await this.exec("SELECT l.*, s.name AS to_name FROM links l JOIN sources s ON s.id=l.to_source WHERE l.from_source=? AND l.status IN ('auto','confirmed') AND l.from_start<=? AND l.from_end>=? AND l.to_start IS NOT NULL LIMIT 3", [sourceId, b, a]));
    return rows.map(function (r) { return { kind: r.kind, evidence: r.term, status: r.status, source: r.to_name, source_id: r.to_source, line_start: r.to_start, line_end: r.to_end, quote: r.to_quote }; });
  };
  Store.prototype.setLinkStatus = async function (id, status) { await this.exec('UPDATE links SET status=? WHERE id=?', [status, id]); };
  // 關鍵詞（模型整理挑的，或使用者自己加的）：存成 {terms, by, at}；之後關聯會用到
  Store.prototype.setTags = async function (id, terms, by) { await this.exec('UPDATE sources SET tags=? WHERE id=?', [JSON.stringify({ terms: terms, by: by || 'user', at: Date.now() }), id]); };
  Store.prototype.stats = async function () {
    var r = rowsOf(await this.exec('SELECT (SELECT COUNT(*) FROM sources) AS sources, (SELECT COUNT(*) FROM sources WHERE enabled=1) AS enabled, (SELECT COUNT(*) FROM chunks) AS chunks, (SELECT COUNT(*) FROM vectors) AS vectors, (SELECT IFNULL(SUM(chars),0) FROM sources) AS chars, (SELECT COUNT(*) FROM links WHERE status<>\'rejected\') AS links'))[0];
    return r;
  };

  return { Store: Store, VERSION: VERSION, vecToBlob: vecToBlob, blobToVec: blobToVec, hashText: hashText, locRuns: locRuns };
});
