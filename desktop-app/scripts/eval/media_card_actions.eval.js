// 影音下載卡片的後續動作（真實 Electron）：視窗、抽 mp3、轉逐字稿能找到檔案、影片編輯器。
// 用法同 youtube_parse.eval.js（FA_DEBUG_EVAL_FILE=本檔 FA_DISABLE_MAIN_OVERLAY=1 FA_BROWSER_CONTROL_PORT=非17923 --user-data-dir=全新資料夾）
const fa = window.fa; const R = { loaded: [...document.scripts].map((s) => s.src).filter((s) => /floating-assistant/.test(s)) };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(80); } return null; };
fa.messages = [];
// 用瀏覽器自己錄一小段「有影像也有聲音」的 webm 當測試影片
const cv = document.createElement('canvas'); cv.width = 160; cv.height = 90; const g = cv.getContext('2d');
const ac = new AudioContext(); const osc = ac.createOscillator(); const dst = ac.createMediaStreamDestination(); osc.connect(dst); osc.start();
const stream = new MediaStream([...cv.captureStream(15).getVideoTracks(), ...dst.stream.getAudioTracks()]);
const rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
rec.start(); for (let i = 0; i < 20; i++) { g.fillStyle = `hsl(${i * 18},70%,50%)`; g.fillRect(0, 0, 160, 90); await wait(100); } rec.stop(); await new Promise((r) => { rec.onstop = r; });
const blob = new Blob(chunks, { type: 'video/webm' }); R.testBlob = blob.size;
const d = await fa.generateAndDeliverFile(blob, '測試影片.webm', 'video/webm'); R.id = d.id;
const dbg = await fa.fileCache.get(d.id); R.kind = dbg.kind;
const rr = await fa._resolveUploadedFileRecord(d.id, { consumePendingAttachment: true, preferAv: true }); R.resolveById = !!rr;
const rn = await fa._resolveUploadedFileRecord('測試影片', { preferAv: true }); R.resolveByName = !!rn;
const rx = await fa._resolveUploadedFileRecord(d.id); R.resolveWithoutPreferAv_stillBlocked = !rx;
// 卡片
const card = await until(() => [...document.querySelectorAll('.ai-file-download-link')].find((a) => /測試影片/.test(a.textContent)));
const wrap = card && card.parentElement; const labels = wrap ? [...wrap.querySelectorAll('button')].map((b) => b.textContent.trim()) : []; R.buttons = labels;
const btn = (t) => [...wrap.querySelectorAll('button')].find((b) => b.textContent.includes(t));
// 視窗
btn('視窗').click(); const win = await until(() => document.querySelector('.fwd .ai-media-el')); R.windowVideo = !!win;
await wait(500); const fw = win && win.closest('.fwd'); R.windowHasShell = !!(fw && fw._fwin); R.windowFloating = fw ? getComputedStyle(fw.closest('.fwin') || fw).position : null;
// 抽 mp3
const before = (await fa.fileCache.getAll()).length; btn('抽取').click();
const mp3 = await until(async () => null, 100); let mp3rec = null; for (let i = 0; i < 150 && !mp3rec; i++) { await wait(200); mp3rec = (await fa.fileCache.getAll()).find((r) => /音軌\.(mp3|wav)$/.test(r.filename)); }
R.extract = mp3rec ? { name: mp3rec.filename, size: mp3rec.blob.size } : null;
// 影片編輯器
btn('影片編輯器').click(); const ed = await until(() => [...document.querySelectorAll('.few')].length, 20000); R.editorOpened = !!ed;
return R;
