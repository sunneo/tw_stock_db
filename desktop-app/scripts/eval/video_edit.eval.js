// /edit-video(真實 Electron;Whisper、TTS、燒錄 worker 用假的):開啟、掛載、載入影片、產生逐字稿(佇列)、Ask AI 白話、TTS 配音、燒錄(帶配音軌)、釘選、重新整理後還原。
// 用法:FA_VIDEO_FILE=/path/clip.webm FA_DEBUG_EVAL_FILE=scripts/eval/video_edit.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.messages = [];
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(80); } return null; };
const bytes = await (await fetch('file://' + (window.FA_VIDEO_FILE || '/tmp/tmp.lLDxbKhZnL/clip.webm'))).blob();
const id = await fa.fileCache.put('clip.webm', 'video/webm', bytes, 'uploaded');
fa._getWhisperTranscriber = async () => () => ({});
fa._runWhisperWindowed = async () => ({ text: 'a b', chunks: [{ timestamp: [0.2, 1.2], text: 'hello' }, { timestamp: [1.5, 2.5], text: 'world' }] });
fa._isWebGpuAvailable = async () => false;
const wav = (sec) => { const rate = 22050, n = Math.round(rate * sec), b = new ArrayBuffer(44 + n * 2), v = new DataView(b), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }; w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true); for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 20) * 12000, true); return b; };
fa._deckSynthesize = async () => wav(1);
let burnArgs = null;
fa._burnSubtitles = async (rec, segs, onP, opt) => { burnArgs = { n: segs.length, bed: opt && opt.dubBed ? opt.dubBed.byteLength / 4 : 0, rate: opt && opt.dubRate }; const oid = await fa.fileCache.put(opt.outName, 'video/mp4', new Blob(['x'], { type: 'video/mp4' }), 'uploaded'); return { ok: true, video_file_id: oid, filename: opt.outName, dubMixed: true }; };
R.registered = { kind: !!FaEditHost.KINDS['edit-video'], slash: !!(fa.slashCommands.get ? fa.slashCommands.get('/edit-video') : fa.slashCommands['/edit-video']), globals: ['TwVideoEdit', 'TwVideoJobs', 'TwVideoEditAi', 'TwVideoEditUI', 'TwVideoIntent', 'TwVideoSourcePicker', 'TwVideoTtsDialog'].every((k) => !!window[k]) };
const res = await fa._videoOpen({ fileId: id }); R.open = res.ok;
fa._renderMessageHistory(); const ed = await until(() => document.querySelector('[data-tw-ve]'), 20000); R.mounted = !!ed; if (!ed) return R;
R.window = { win: !!ed._win, hasBtns: !!ed.querySelector('.fwin-title, button[title*="最大化"]') };
R.video = !!(await until(() => ed.querySelector('video') && ed.querySelector('video').readyState >= 1, 15000)); R.pinned = null;
const proj0 = await FaEditStore.loadProject('edit-video', res.id); R.saved = { video: proj0 && proj0.spec && proj0.spec.video && proj0.spec.video.id === id };
await fa.fileCache.pin(id); R.pinned = (await fa.fileCache.get(id)).pinned === true;
ed.querySelector('[data-ve=gen-scope]').value = 'whole'; ed.querySelector('[data-ve=gen]').click();
R.cues = !!(await until(() => ed._ve.cues().length === 2, 15000)); R.cue_text = ed._ve.cues().map((c) => c.text);
ed._ve.tab('ask'); await ed._ve.ask('第1句改成「你好」');
R.ask_proposal = !!(await until(() => ed.querySelector('[data-ve=ask-proposal]') && ed.querySelector('[data-ve=ask-apply]'), 8000));
const ap = ed.querySelector('[data-ve=ask-apply]'); if (ap) ap.click(); await wait(300); R.ask_applied = ed._ve.cues()[0] && ed._ve.cues()[0].text;
await ed._ve.addTtsDub({ text: 'dub me', lang: 'en-US', voiceId: 'af_heart', start: 0.5 }); R.dubs = ed._ve.dubs().length;
R.voices = fa._videoVoices().length; R.pick = (fa._videoPickVoice('hi', 'en-US') || {}).id;
ed._ve.enqueueBurn(); R.burn = !!(await until(() => burnArgs, 20000)); R.burnArgs = burnArgs;
const j = await until(() => ed._ve.queue.list().filter((x) => x.kind === 'burn' && x.status === 'done')[0], 10000); R.burn_done = !!j; R.out_pinned = j && j.payload && j.payload.out ? (await fa.fileCache.get(j.payload.out.id)).pinned === true : null;
try { ed._win.pop(); await wait(200); R.popped = ed._win.isPopped(); ed._win.maximize(true); R.maxed = ed._win.isMaximized(); ed._win.dock(); } catch (e) { R.win_err = String(e); }
await wait(600);
// reload
const holder = document.createElement('div'); document.body.appendChild(holder); await fa._edMount('edit-video', res.id, holder);
const ed2 = holder.querySelector('[data-tw-ve]'); R.reload = { mounted: !!ed2, cues: ed2 && ed2._ve.cues().length, dubs: ed2 && ed2._ve.dubs().length, video: !!(ed2 && await until(() => ed2.querySelector('video'), 8000)) };
return R;
