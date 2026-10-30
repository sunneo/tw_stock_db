// /edit-video 的離線 harness(真實 Electron):video_* agent 工具、CoLU 單元接線、離線訓練器學回去與重放、計畫模板、Ask AI「線上失效 → 離線 harness」。
// 用法:FA_DEBUG_EVAL_FILE=scripts/eval/video_harness.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.messages = []; fa.advancedSettings.offlineMode = false;
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(80); } return null; };
const blob = await (await fetch('file:///tmp/tmp.g4EdpSSJ2x/a.webm')).blob(); const id = await fa.fileCache.put('a.webm', 'video/webm', blob, 'uploaded');
const T = ['video_split', 'video_cut_range', 'video_cut_clip', 'video_set_transition', 'video_transcribe', 'video_tts_dub', 'video_set_line', 'video_shift_lines', 'video_add_media', 'edit_video_open'];
R.tools = T.filter((n) => !fa.tools[n]);   // missing ones
const cat = fa._unitCatalogBuild(); const u = cat.units.filter((x) => x.id === 'tool:video_split')[0]; R.unit = u && { tier: u.tier, effects: u.effects, returns: u.returns && u.returns.type, params: u.params.map((p) => p.name + ':' + p.type) };
const res = await fa._videoOpen({ fileId: id }); fa._renderMessageHistory(); const ed = await until(() => document.querySelector('[data-tw-ve]'), 20000); R.mounted = !!ed; if (!ed) return R; const V = ed._ve;
R.ready = !!(await until(() => V.clips().length === 1 && Math.abs(V.video.duration - 6) < 0.3, 20000));
R.live = !!fa._videoLiveEditor();
const call = async (name, args) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(args)));
R.tool_split = await call('video_split', { at: '2' }); R.clips_after_split = V.clips().length;
R.tool_cut = await call('video_cut_range', { start: '0:04', end: '0:05' }); R.total_after_cut = Math.round(V.video.duration * 10) / 10;
R.tool_bad = await call('video_cut_range', { start: '0:50', end: '0:60' });
R.colu = (() => { const c = fa._videoCoLU([{ op: 'split', at: 2 }, { op: 'remove_range', start: 1, end: 2 }]); return c && { ok: c.ok, bound: c.bound, total: c.total, error: c.error }; })();
// learn back an ONLINE success, then the OFFLINE harness replays it for the same kind of sentence (other numbers)
R.learn = await fa._videoLearn({ text: '在 0:02 把影片一分為二', edits: [{ op: 'split', at: 2 }] });
const st = () => V.state(); const off = await fa._videoOffline('在 0:03 把影片一分為二', st(), () => {}); R.offline_trainer = { via: off.via, edits: off.edits };
const off2 = await fa._videoOffline('剪掉片頭 1 秒', st(), () => {}); R.offline_plan = { via: off2.via, edits: off2.edits };
const off3 = await fa._videoOffline('把逐字稿往前挪 0.1 秒', st(), () => {}); R.offline_intent = { via: off3.via, edits: off3.edits, colu: off3.notes.filter((n) => /CoLU/.test(n)) };
// the semantic layer (decompose -> derive -> UML -> CoLU wiring): a small benchmark; the rates are what the NLP intent reasoning added later has to beat
{ const S0 = { duration: 60, now: 12, cues: [{ start: 5, end: 10, text: 'a' }, { start: 12, end: 20, text: 'b' }, { start: 40, end: 50, text: 'c' }], clips: [{ in: 0, out: 20, name: 'x' }, { in: 0, out: 40, name: 'y' }] };
  const cases = [['把前半段刪掉', [['remove_range', 0, 30]]], ['剪掉最後 10 秒', [['remove_range', 50, 60]]], ['刪掉中間的部分', [['remove_range', 20, 40]]], ['刪除第 2 句那一段', [['remove_range', 12, 20]]], ['只保留 0:10 到 0:40', [['remove_range', 40, 60], ['remove_range', 0, 10]]],
    ['在正中間切一刀', [['split', 30]]], ['第 2 個片段加圓圈展開轉場', [['set_transition']]], ['把 0:10 到 0:30 的逐字稿用英文配音', [['add_tts_dub']]], ['刪掉第 2 個片段', [['remove_clip']]], ['先在 0:30 分割，然後刪掉第 1 個片段', [['split', 30], ['remove_clip']]]];
  let ok = 0, wired = 0, total = 0; const bad = [];
  for (const [txt, want] of cases) { const r = await fa._videoOffline(txt, S0, () => {}); const got = (r.edits || []).map((e) => [e.op].concat(e.start !== undefined ? [Number(e.start)] : e.at !== undefined ? [Number(e.at)] : []).concat(e.end !== undefined ? [Number(e.end)] : []));
    const match = want.length === got.length && want.every((w, i) => w[0] === got[i][0] && (w.length === 1 || w.slice(1).every((x, j) => x === got[i][1 + j]))); if (match) ok++; else bad.push([txt, got]); }
  const probe = await fa._harnessRun('video', '先在 0:30 分割，然後刪掉第 1 個片段', S0, {}); wired = probe.wired; total = probe.total;
  R.semantic_bench = { ok: ok + '/' + cases.length, bad: bad.slice(0, 3), wired_probe: wired + '/' + total, by: probe.calls.map((c) => c.by), tools: probe.calls.map((c) => c.tool), semantic: probe.semantic }; }
// the whole Ask AI chain: online fails -> offline harness -> preview -> apply
fa._kiLlm = async () => { throw new Error('API錯誤(500)'); };
const t0 = V.video.duration; V.tab('ask'); await V.ask('剪掉片頭 1 秒'); const ap = await until(() => ed.querySelector('[data-ve=ask-apply]'), 10000); R.ask = { proposal: !!ap, said_offline: /離線/.test(ed.querySelector('[data-ve=ask-log]').textContent) }; if (ap) { ap.click(); await wait(800); R.ask.shrunk = Math.round((t0 - V.video.duration) * 10) / 10; }
// an ONLINE answer that worked is learned back: the sentence becomes a general rule in the trainer's domain edit_video
fa._kiLlm = async () => JSON.stringify({ say: 'ok', edits: [{ op: 'split', at: '0:03.5' }] });
const nOld = (await fa._otRun({ action: 'show', domain: 'edit_video' })).domain.patterns.length; V.tab('ask'); await V.ask('幫我在 0:03.5 的地方把影片一分為三');
const ap2 = await until(() => ed.querySelector('[data-ve=ask-apply]'), 10000); if (ap2) { ap2.click(); } const nNew = await until(async () => 0, 10) || 0; await wait(1500);
const dom = (await fa._otRun({ action: 'show', domain: 'edit_video' })).domain; R.online_learn = { proposal: !!ap2, patterns: [nOld, dom.patterns.length], exprs: dom.patterns.map((p) => p.expr).slice(-2) };
return R;
