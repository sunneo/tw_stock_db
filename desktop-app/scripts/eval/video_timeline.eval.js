// /edit-video 時間軸(真實 Electron、真實 mediabunny 輸出;Whisper 不用):分割、刪除一段(逐字稿跟著往前接)、加入影片(合併)、轉場、疊圖片、插入聲音、播放跨片段、輸出 MP4。
// 用法:FA_DEBUG_EVAL_FILE=scripts/eval/video_timeline.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)   (輸出要連 cdn.jsdelivr.net 載 mediabunny)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); fa.messages = [];
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(80); } return null; };
const blobOf = async (p, type) => new File([await (await fetch('file://' + p)).blob()], p.split('/').pop(), { type });
const A = await blobOf('/tmp/tmp.RLz8sk4WLw/a.webm', 'video/webm'), B = await blobOf('/tmp/tmp.RLz8sk4WLw/b.webm', 'video/webm');
const idA = await fa.fileCache.put('a.webm', 'video/webm', A, 'uploaded');
const png = await new Promise((r) => { const cv = document.createElement('canvas'); cv.width = 40; cv.height = 40; const g = cv.getContext('2d'); g.fillStyle = '#f0f'; g.fillRect(0, 0, 40, 40); cv.toBlob((b) => r(new File([b], 'logo.png', { type: 'image/png' }))); });
const wav = (sec) => { const rate = 22050, n = Math.round(rate * sec), b = new ArrayBuffer(44 + n * 2), v = new DataView(b), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }; w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true); for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 10) * 14000, true); return new File([b], 'beep.wav', { type: 'audio/wav' }); };
const res = await fa._videoOpen({ fileId: idA }); fa._renderMessageHistory(); const ed = await until(() => document.querySelector('[data-tw-ve]'), 20000); R.mounted = !!ed; if (!ed) return R; const V = ed._ve;
R.ready = !!(await until(() => V.clips().length === 1 && Math.abs(V.video.duration - 4) < 0.3, 20000)); R.clip0 = V.clips()[0] && [V.clips()[0].in, V.clips()[0].out];
V.importText('1\n00:00:00,500 --> 00:00:01,500\none\n\n2\n00:00:02,500 --> 00:00:03,500\ntwo', 'x.srt'); await wait(100);
// split at 2 s
V.video.currentTime = 2; await wait(700); V.split(); R.split = V.clips().map((c) => [c.in, c.out]);
// remove 1.0 - 2.5 (the first half's tail + the second's head): total 4 -> 2.5, line "two" (2.5-3.5) moves up to 1.0-2.0
V.removeRange(1, 2.5); await wait(500); R.removed = { clips: V.clips().map((c) => [c.in, c.out]), total: V.video.duration, cues: V.cues().map((c) => [c.text, c.start, c.end]) };
// merge: add video B (3 s) at the end, set a transition into it
await V.addVideos([B]); R.merged = { n: V.clips().length, total: V.video.duration, name: V.clips()[V.clips().length - 1].name };
V.setTransition(V.clips()[V.clips().length - 1].id, { type: 'circle-open', dur: 1 }); R.transition = V.clips()[V.clips().length - 1].tr;
V.video.currentTime = 1; await wait(500); await V.addImage(png); R.overlay = V.overlays().map((o) => [o.name, o.start, o.dur]);
await V.addAudio(wav(1)); R.sound = V.project.dubs.map((d) => [d.kind, d.name, d.start]);
// objects list shows clips (with transition select), overlay and dub rows
R.rows = { clips: ed.querySelectorAll('[data-clip]').length, tr_select: ed.querySelectorAll('[data-f=clip-tr]').length, ov: ed.querySelectorAll('[data-ov]').length, dub: ed.querySelectorAll('[data-dub]').length };
// play across the cut of the first clip into the second
V.video.currentTime = 0.5; await wait(500); await V.video.play(); const crossed = await until(() => V.video.currentTime > 2.0, 12000); R.play = { crossed: !!crossed, t: V.video.currentTime }; V.video.pause();
// undo edit
const nBefore = V.clips().length; V.undoEdit(); await wait(300); R.undo = { sound_gone: V.project.dubs.length === 0 };
// burn (timeline path: real mediabunny + WebCodecs)
await V.addAudio(wav(1)); V.enqueueBurn(); const job = await until(() => V.queue.list().filter((j) => j.kind === 'burn' && (j.status === 'done' || j.status === 'failed'))[0], 120000); R.burn = job && { status: job.status, error: job.error, progress: job.progress };
if (job && job.status === 'done') {
  const out = job.payload.out; const rec = await fa.fileCache.get(out.id); R.out = { name: out.name, size: rec.blob.size, pinned: rec.pinned === true };
  const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(rec.blob); await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 8000); }); R.out.duration = v.duration; R.out.size_wh = [v.videoWidth, v.videoHeight];
  const px = async (t) => { v.currentTime = t; await new Promise((r) => { v.onseeked = r; setTimeout(r, 4000); }); const cv = document.createElement('canvas'); cv.width = 160; cv.height = 90; const g = cv.getContext('2d'); g.drawImage(v, 0, 0, 160, 90); return Array.from(g.getImageData(80, 45, 1, 1).data).slice(0, 3); };
  R.out.px = { start: await px(0.2), second_clip: await px(V.video.duration - 0.3) };
}
return R;
