const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fa.messages = [];
const cv = document.createElement('canvas'); cv.width = 160; cv.height = 90; const g = cv.getContext('2d');
const rec = new MediaRecorder(cv.captureStream(15), { mimeType: 'video/webm' }); const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
rec.start(); for (let i = 0; i < 10; i++) { g.fillStyle = `hsl(${i * 30},70%,50%)`; g.fillRect(0, 0, 160, 90); await wait(100); } rec.stop(); await new Promise((r) => { rec.onstop = r; });
const d = await fa.generateAndDeliverFile(new Blob(chunks, { type: 'video/webm' }), '測試影片.webm', 'video/webm');
R.fid = await fa._videoResolveSource(d.id);
let res; try { res = await fa._videoOpen({ fileId: R.fid || d.id }); } catch (e) { res = { thrown: String(e && e.stack || e) }; }
R.res = res && JSON.stringify(res).slice(0, 300);
await wait(3000);
R.fwe = [...document.querySelectorAll('.few')].length; R.fences = fa.messages.filter((m) => /fa-edit-video/.test(String(m.content || ''))).length;
R.lastMsgs = fa.messages.slice(-3).map((m) => String(m.content || '').slice(0, 160));
R.cls = [...new Set([...document.querySelectorAll('[class*=fe-],[class*=few],[class*=vd]')].map((e) => e.className).slice(0, 12))];
return R;
