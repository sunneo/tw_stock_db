// 多層 JSONL 的工具接線（真實 Electron，直接呼叫工具）。
// 用法：node scripts/eval/run_eval.js scripts/eval/layers-jsonl.eval.js 17952
//   big_content tree／expand、midi_song_jsonl（read／write）、網頁三層（_webPageLayers）、uml_edit 的 model_jsonl 讀寫。
const fa = window.fa; const R = {};
const call = async (name, args) => { const t = fa.tools[name]; if (!t) return { _missing: name }; const raw = await t.callback.call(fa, JSON.stringify(args)); try { return JSON.parse(raw); } catch (_) { return { _text: String(raw) }; } };
const page = (text) => { const rows = String(text || '').split('\n'); try { const m = JSON.parse(rows[0]); return m._page ? { meta: m._page, rows: rows.slice(1).filter(Boolean).map((l) => JSON.parse(l)) } : null; } catch (_) { return null; } };

// 1) big_content tree／expand：深層 JSON，先看全貌再往下鑽，合起來還原
let deep = { name: 'M', classes: Array.from({ length: 30 }, (_, i) => ({ name: 'C' + i, attrs: [{ n: 'a' + i, t: { base: 'int', args: [] } }], ops: [{ n: 'f', params: [] }] })), meta: { a: { b: { c: [1, 2, { d: '深' }] } } } };
const id = fa._bigStash(JSON.stringify(deep), 'eval_deep');
const t1 = page(JSON.stringify ? (await fa.tools.big_content.callback.call(fa, JSON.stringify({ id, action: 'tree', levels: 1 }))) : '');
let lines = t1 ? t1.rows.map((r) => JSON.stringify(r)) : [];
R.tree = { ok: !!t1, rows: t1 && t1.rows.length, collapsed: t1 && t1.rows.filter((r) => r.collapsed).map((r) => r.path), layer: t1 && t1.meta.head && t1.meta.head.layer };
if (t1) {
    const pend = t1.rows.filter((r) => r.collapsed).map((r) => r.path);
    for (const pth of pend) { const e = page(await fa.tools.big_content.callback.call(fa, JSON.stringify({ id, action: 'expand', path: pth, levels: 99 }))); if (e) lines = lines.concat(e.rows.map((r) => JSON.stringify(r))); }
    const back = fa._jsonlPagerMod().unflatten(lines); R.tree.restored = JSON.stringify(back) === JSON.stringify(deep);
}

// 2) MIDI：read 各層、write 還原
const song = { ppq: 480, tempos: [{ t: 0, bpm: 120 }], timesig: { n: 4, d: 4 }, title: '評估', tracks: [{ name: '旋律', channel: 0, program: 0, drum: false, volume: 100, pan: 64, notes: Array.from({ length: 200 }, (_, i) => ({ t: i * 480, d: 400, n: 60 + (i % 12), v: 90 })) }] };
if (!fa._midiSongs) fa._midiSongs = new Map(); fa._midiSongs.set('eval1', song);
const m0 = page((await fa.tools.midi_song_jsonl.callback.call(fa, JSON.stringify({ song_id: 'eval1', levels: 0 }))));
const mb = page((await fa.tools.midi_song_jsonl.callback.call(fa, JSON.stringify({ song_id: 'eval1', track: 0, bar: 3 }))));
const rawm = await fa.tools.midi_song_jsonl.callback.call(fa, JSON.stringify({ song_id: 'eval1', levels: 0 })); R.midi_raw = String(rawm).slice(0, 200);
R.midi = { levels0: m0 && m0.rows.map((r) => r.k), bar3: mb && mb.rows.length };
const all = fa._jsonlPagerMod ? FaMidi.toJsonl(song).lines : [];
const w = await call('midi_song_jsonl', { action: 'write', lines: all }); R.midi.write = { ok: w.ok, tracks: w.tracks, missing: w.missing && w.missing.length };

// 3) 網頁三層：長 Markdown
let md = '# 大標\n\n'; for (let c = 0; c < 30; c++) { md += '## 章' + c + '\n\n'; for (let k = 0; k < 20; k++) md += '第' + c + '章第' + k + '段 [連結](http://x/' + c + '/' + k + ')。\n\n'; }
const wl = page(fa._webPageLayers(md, { title: 'T', url: 'http://x', file_id: 'f1' }));
R.web = { ok: !!wl, layer: wl && wl.meta.head && wl.meta.head.layer, sections_on_page1: wl && wl.rows.length, total: wl && wl.meta.total, hasCursor: wl && !!wl.rows[1].blocks_cursor };

// 4) uml_edit 的 model_jsonl 讀寫：用內建範本模型開一個設計，先看全貌、往下鑽、整份換回去
const frag = FaDesign.FRAGMENTS.map((f) => FaUml.parseDsl(f.dsl).model).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
R.uml = {};
try {
    const design = FaDesign.recommend('線上商店', 'python', {}); const sess = await fa._umlStartSession(JSON.parse(JSON.stringify(frag)), 'python', 'app', '評估', design);
    const r1 = await call('uml_edit', { session: sess.id, model_jsonl_read: true, levels: 1 }); const p1 = page(r1.jsonl_page);
    R.uml.top = { ok: r1.ok, rows: p1 && p1.rows.length, collapsed: p1 && p1.rows.filter((x) => x.collapsed).length };
    const r2 = await call('uml_edit', { session: sess.id, model_jsonl_read: true, path: '/classes', levels: 99 }); R.uml.expand = { ok: r2.ok, records: r2.records };
    const full = FaDesign.modelToJsonl(frag, { pager: fa._jsonlPagerMod() }).lines; const w = await call('uml_edit', { session: sess.id, model_jsonl: full });
    R.uml.write_full = { ok: w.ok, replaced: w.replaced, changes: w.changes && w.changes.length, equal: JSON.stringify(fa._umlSessions.get(sess.id).model) === JSON.stringify(frag), err: w.error };
    const w2 = await call('uml_edit', { session: sess.id, model_jsonl: FaDesign.modelToJsonl(frag, { levels: 1, pager: fa._jsonlPagerMod() }).lines }); R.uml.write_collapsed_rejected = { ok: w2.ok, error: String(w2.error || '').slice(0, 60) };
} catch (e) { R.uml.exception = String((e && e.message) || e); }
return R;
