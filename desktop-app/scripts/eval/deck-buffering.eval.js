// 播放器卡在「準備第 N 頁…」（聲音還沒產生）時暫停、跳到別頁、再播放：不能卡住，字幕要回來（真實 Electron；用假的「第 3 頁一直沒準備好」）。
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const fa = window.fa; const R = {}; await fa._deckEnsureRuntime(); await window.AiChat2D.ensureJsYamlLoaded();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slides = [0, 1, 2, 3].map((i) => ({ title: '頁 ' + i, layout: 'content', bullets: ['一', '二'], narration: '這是第 ' + i + ' 頁的旁白。第二句話在這裡。第三句話也在這裡。' }));
const saved = await fa._deckSaveYaml(window.jsyaml.dump({ deck: { title: 't', lang: 'zh-TW' }, chapters: [{ title: 'c', slides }] }), 'buf');
const holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:560px;z-index:99999;background:#fff'; document.body.appendChild(holder);
await fa._deckMount(holder, saved.url); await sleep(2500);
const box = holder.querySelector('.ai-chat-deck'); const P = box && box._deckPlayer; R.player = !!P; if (!P) return R;
const S = P.s, segs = () => S.tl.segs, origReady = S.isReady.bind(S), origWhen = S.whenReady.bind(S);
await Promise.all([0, 1, 3].map((i) => origWhen(i))); R.ready_013 = [0, 1, 3].map((i) => origReady(i));
let gate = { open: false, res: null, p: null }; const newGate = () => { gate = { open: false, res: null }; gate.p = new Promise((r) => { gate.res = () => { gate.open = true; r(); }; }); };
newGate(); S.isReady = (i) => (i === 2 ? gate.open : origReady(i)); S.whenReady = (i) => (i === 2 ? gate.p : origWhen(i));
const toEndOfSlide1 = async () => { P.pause(); P.T = segs()[1].end - 1.2; P.buffering = -1; P.play(); await sleep(2500); };
// 場景 A：播到第 2 頁結尾，等第 3 頁 → 卡住 → 暫停 → 按 prev → 播放
await toEndOfSlide1(); R.A_waiting = P.buffering === 2;
P.pause(); P.prev(); R.A_cancelled = P.buffering === -1; const t0 = P.T; R.A_loc = P.loc().i;
P.play(); await sleep(1200); R.A_advances = P.T > t0 + 0.6 && P.buffering === -1 && P.playing; R.A_overlay_hidden = P.overlay.style.display === 'none';
gate.res(); await sleep(400); R.A_no_teleport = P.loc().i <= 1 && P.buffering === -1;
// 場景 B：同樣卡住 → 暫停 → 點圓點跳到第 1 頁 → 播放
newGate(); await toEndOfSlide1(); R.B_waiting = P.buffering === 2;
P.pause(); P.dots.children[0].click(); R.B_cancelled = P.buffering === -1 && P.loc().i === 0; const tb = P.T; P.play(); await sleep(1000); R.B_advances = P.T > tb + 0.5;
// 場景 C：同樣卡住 → 暫停 → 用 tracker 跳 → 播放
newGate(); await toEndOfSlide1(); R.C_waiting = P.buffering === 2; P.pause(); P.seekFraction(0.1); await sleep(100); R.C_cancelled = P.buffering === -1; const tc = P.T; P.play(); await sleep(1000); R.C_advances = P.T > tc + 0.5;
// 場景 D：卡住時用 next（下一頁也還沒好）→ 等的是新的那頁，不是舊的；準備好後到那頁
newGate(); await toEndOfSlide1(); P.pause(); P.goTo(0); await sleep(50); P.next(); await sleep(50); R.D_ok = P.buffering === -1 && P.loc().i === 1;
// 場景 E：卡住時沒有任何操作，準備好 → 自動往下播（原本的行為不能壞）
newGate(); await toEndOfSlide1(); R.E_waiting = P.buffering === 2; const te = P.T; gate.res(); await sleep(800); R.E_continues = P.buffering === -1 && P.loc().i === 2 && P.T > segs()[2].transStart - 0.01;
// 場景 F：暫停中等的那頁準備好了，再按播放 → 直接往下播
newGate(); await toEndOfSlide1(); P.pause(); gate.res(); await sleep(300); P.play(); await sleep(800); R.F_resumes = P.buffering === -1 && P.playing && P.loc().i === 2;
// 場景 G：goTo 一頁沒準備好的 → 顯示等待，準備好後到那頁（原本的行為）；等的時候再跳走 → 舊的等待作廢，不會被拉回去
newGate(); P.pause(); P.goTo(2); R.G_waiting = P.buffering === 2 && P.overlay.style.display !== 'none'; P.goTo(0); gate.res(); await sleep(300); R.G_not_pulled_back = P.loc().i === 0 && P.buffering === -1;
S.isReady = origReady; S.whenReady = origWhen; holder.remove(); P.destroy();
return R;
