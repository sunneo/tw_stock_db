// 音樂領域階段 2:MIDI 編輯器畫面 FaMidiEditUI(只依賴 DOM 與注入的 host)。音色只能選 GS 音色庫的 128 個程式＋鼓組。
//   FaMidiEditUI.mount({ song, title, M, E, host }) → DOM 節點
//   host = { player(song, prog), download(name, bytes, mime), askAI(text, song) → Promise<動作清單>(程式讀不懂才呼叫), onChange(song, action) }
//   節點上的 _midiEdit = { getSong(), setSong(song), applyRemote(actions) , destroy() } 給遠端編輯與外部呼叫用
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMidiEditUI = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const GS_NAMES = '平台鋼琴,明亮鋼琴,電子平台鋼琴,酒吧鋼琴,電鋼琴1,電鋼琴2,大鍵琴,擊弦古鋼琴,鋼片琴,鐘琴,音樂盒,顫音琴,馬林巴,木琴,管鐘,洋琴,拉桿風琴,打擊風琴,搖滾風琴,教堂管風琴,簧管風琴,手風琴,口琴,探戈手風琴,尼龍弦吉他,鋼弦吉他,爵士電吉他,清音電吉他,悶音電吉他,過載吉他,失真吉他,吉他和聲,原音貝斯,指彈電貝斯,撥片電貝斯,無琴格貝斯,打弦貝斯1,打弦貝斯2,合成貝斯1,合成貝斯2,小提琴,中提琴,大提琴,低音提琴,顫音弦樂,撥奏弦樂,豎琴,定音鼓,弦樂合奏1,弦樂合奏2,合成弦樂1,合成弦樂2,合唱啊,人聲嗚,合成人聲,管弦樂擊奏,小號,長號,低音號,弱音小號,法國號,銅管組,合成銅管1,合成銅管2,高音薩克斯風,中音薩克斯風,次中音薩克斯風,上低音薩克斯風,雙簧管,英國管,低音管,單簧管,短笛,長笛,直笛,排笛,吹瓶,尺八,哨笛,陶笛,方波主音,鋸齒波主音,汽笛風琴,合成吹管,合成主音4,合成主音5,合成主音6,合成主音7,新世紀鋪底,暖音鋪底,複音鋪底,合唱鋪底,弓弦鋪底,金屬鋪底,光暈鋪底,掃頻鋪底,雨,音軌,水晶,氛圍,明亮,妖精,回音,科幻,西塔琴,斑鳩琴,三味線,古箏,卡林巴,風笛,古提琴,蕭奈,鈴鐺,阿果果,鋼鼓,木魚,太鼓,中音鼓,合成鼓,反向鈸,吉他滑弦,呼吸聲,海浪,鳥鳴,電話鈴,直升機,掌聲,槍聲'.split(',');
  const BTN = 'cursor:pointer;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;border-radius:6px;padding:3px 9px;font-size:13px;';
  const COLORS = ['#4aa3ff', '#ff7a59', '#5fd38d', '#e5c35c', '#c084fc', '#f472b6', '#22d3ee', '#a3e635'];
  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  const gsName = (p) => (p + 1) + '. ' + (GS_NAMES[p] || ('音色 ' + p));

  function mount(opts) {
    const M = opts.M, E = opts.E, P = opts.P, host = opts.host || {};
    let remote = null;   // 共編:{ session, doc }
    const hist = E.history(opts.song);
    let sel = 0, grid = 0.5, pxBeat = 40, pitchLo = 36, rows = 36, playing = null, destroyed = false, posTick = 0, dragging = false; const mute = new Set(), solo = new Set(); // 靜音／獨奏只是試聽狀態(不進曲子、不匯出 MIDI);音量與左右平衡才寫進曲子
    const card = el('div', 'border:1px solid rgba(128,128,128,.4);border-radius:10px;padding:10px;max-width:720px;font-size:13px;'); card.className = 'fa-midi-edit';
    const head = el('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;');
    head.appendChild(el('span', 'font-size:18px', '🎼')); head.appendChild(el('b', 'flex:1;min-width:80px', opts.title || hist.song.title || 'MIDI 編輯器'));
    const colB = el('button', BTN, '👥 共編'); colB.style.display = host.collab ? '' : 'none';
    const undoB = el('button', BTN, '↶'), redoB = el('button', BTN, '↷'), playB = el('button', BTN, '▶ 試聽'), dlB = el('button', BTN, '⬇ MIDI');
    undoB.title = '復原'; redoB.title = '重做';
    const gridSel = el('select', BTN); [['四分音符', 1], ['八分音符', 0.5], ['十六分音符', 0.25]].forEach(([n, v]) => { const o = el('option', '', n); o.value = v; if (v === grid) o.selected = true; gridSel.appendChild(o); });
    gridSel.onchange = () => { grid = Number(gridSel.value); };
    head.append(undoB, redoB, gridSel, playB, colB, dlB); card.appendChild(head);
    // 傳輸列:跳到開頭／結尾、時間與小節、可點可拖的進度條、BPM
    const tp = el('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px;');
    const toStartB = el('button', BTN, '⏮'), toEndB = el('button', BTN, '⏭'); toStartB.title = '跳到開頭'; toEndB.title = '跳到結尾';
    const timeL = el('span', 'font-variant-numeric:tabular-nums;font-size:12px;min-width:112px;', '0:00 / 0:00');
    const bar = el('input', 'flex:1;min-width:120px;'); bar.type = 'range'; bar.min = 0; bar.max = 1; bar.step = 1; bar.value = 0; bar.title = '播放位置(拖曳或點一下跳轉)';
    const bpmL = el('label', 'display:flex;align-items:center;gap:3px;font-size:12px;', '♩='); const bpmIn = el('input', 'width:56px;padding:2px 4px;'); bpmIn.type = 'number'; bpmIn.min = 20; bpmIn.max = 400; bpmIn.step = 1; bpmIn.title = '速度(每分鐘拍數)。曲中有變速時,改這裡會等比縮放整條速度表'; bpmL.appendChild(bpmIn); const bpmNote = el('span', 'opacity:.7;font-size:11px;'); bpmL.appendChild(bpmNote);
    tp.append(toStartB, toEndB, timeL, bar, bpmL); card.appendChild(tp);
    const mid = el('div', 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;');
    const side = el('div', 'min-width:170px;flex:0 0 170px;');
    const canvasWrap = el('div', 'flex:1;min-width:240px;overflow:auto;border:1px solid rgba(128,128,128,.3);border-radius:6px;max-height:300px;');
    const inner = el('div', 'position:relative;'); const rv = el('canvas', 'display:block;cursor:pointer;height:16px;'); rv.title = '點一下或拖曳跳到那個位置';
    const cv = el('canvas', 'display:block;cursor:crosshair;'); const head0 = el('div', 'position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:#ff3b30;pointer-events:none;z-index:2;display:none;');
    inner.append(rv, cv, head0); canvasWrap.appendChild(inner); mid.append(side, canvasWrap); card.appendChild(mid);
    const status = el('div', 'opacity:.75;min-height:1.2em;font-size:12px;margin-top:6px;'); card.appendChild(status);
    const say = (m) => { status.textContent = m || ''; };
    const ask = el('div', 'display:flex;gap:6px;margin-top:6px;');
    const inp = el('input', 'flex:1;min-width:120px;padding:4px 6px;'); inp.placeholder = '跟編輯器說話,例如「第一軌升兩個半音」「速度改成 90」「貝斯換成大提琴」';
    const go = el('button', BTN, '送出'); ask.append(inp, go); card.appendChild(ask);

    function draw() {
      const s = hist.song, dpr = window.devicePixelRatio || 1;
      const end = Math.max(16, Math.ceil(M.endTick(s) / s.ppq) + 4), W = end * pxBeat, H = rows * 12;
      inner.style.width = W + 'px'; cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      for (let r = 0; r < rows; r++) { const p = pitchLo + rows - 1 - r; if ([1, 3, 6, 8, 10].indexOf(p % 12) >= 0) { g.fillStyle = 'rgba(128,128,128,.12)'; g.fillRect(0, r * 12, W, 12); } if (p % 12 === 0) { g.fillStyle = 'rgba(128,128,128,.35)'; g.fillRect(0, r * 12 + 11, W, 1); g.fillStyle = 'rgba(128,128,128,.8)'; g.font = '9px sans-serif'; g.fillText(M.noteName(p), 2, r * 12 + 9); } }
      for (let b = 0; b <= end; b++) { g.fillStyle = b % s.timesig.n === 0 ? 'rgba(128,128,128,.5)' : 'rgba(128,128,128,.2)'; g.fillRect(b * pxBeat, 0, 1, H); }
      s.tracks.forEach((tr, i) => { g.fillStyle = COLORS[i % COLORS.length]; g.globalAlpha = i === sel ? 1 : 0.35; tr.notes.forEach((n) => { const r = pitchLo + rows - 1 - n.n; if (r < 0 || r >= rows) return; g.fillRect(n.t / s.ppq * pxBeat, r * 12 + 1, Math.max(3, n.d / s.ppq * pxBeat - 1), 10); }); }); g.globalAlpha = 1;
      undoB.disabled = !hist.canUndo(); redoB.disabled = !hist.canRedo();
      rv.width = W * dpr; rv.height = 16 * dpr; rv.style.width = W + 'px'; const r = rv.getContext('2d'); r.setTransform(dpr, 0, 0, dpr, 0, 0); r.clearRect(0, 0, W, 16); r.fillStyle = 'rgba(128,128,128,.18)'; r.fillRect(0, 0, W, 16); r.font = '10px sans-serif'; r.fillStyle = 'rgba(128,128,128,.95)';
      for (let b = 0; b <= end; b += s.timesig.n) { r.fillRect(b * pxBeat, 8, 1, 8); r.fillText(String(b / s.timesig.n + 1), b * pxBeat + 3, 10); }
      syncTransport();
    }
    const fmtT = (sec) => { sec = Math.max(0, sec); const m = Math.floor(sec / 60), x = Math.floor(sec % 60); return m + ':' + (x < 10 ? '0' : '') + x; };
    function syncTransport() {
      const s = hist.song, endT = M.endTick(s); bar.max = Math.max(1, endT); if (!dragging) bar.value = Math.min(posTick, endT);
      const beat = posTick / s.ppq; timeL.textContent = fmtT(M.ticksToSec(s, posTick)) + ' / ' + fmtT(M.durationSec(s)) + '  小節 ' + (Math.floor(beat / s.timesig.n) + 1);
      head0.style.display = ''; head0.style.left = (beat * pxBeat) + 'px';
      if (document.activeElement !== bpmIn) bpmIn.value = Math.round(s.tempos[0].bpm * 100) / 100; bpmNote.textContent = s.tempos.length > 1 ? '(+' + (s.tempos.length - 1) + ' 處變速)' : '';
    }
    function setPos(t, follow) {
      posTick = Math.max(0, Math.round(t)); syncTransport();
      if (follow) { const x = posTick / hist.song.ppq * pxBeat, L = canvasWrap.scrollLeft, w = canvasWrap.clientWidth; if (w && (x > L + w - 24 || x < L)) canvasWrap.scrollLeft = Math.max(0, x - 40); }
    }
    function seekTick(t) {
      const s = hist.song; t = Math.max(0, Math.min(M.endTick(s), Math.round(t))); setPos(t, true);
      const p = pt.current(); if (p && p.isPlaying && p.isPlaying()) { try { p.seek(M.ticksToSec(s, t)); } catch (_) { /* */ } }
    }
    const onTick = (sec) => { if (pt.isPlaying() && !dragging) setPos(M.secToTicks(hist.song, sec), true); };
    toStartB.onclick = () => seekTick(0); toEndB.onclick = () => seekTick(M.endTick(hist.song));
    bar.oninput = () => { dragging = true; setPos(Number(bar.value), false); }; bar.onchange = () => { dragging = false; seekTick(Number(bar.value)); };
    const rulerSeek = (ev) => { const rc = rv.getBoundingClientRect(); seekTick((ev.clientX - rc.left) / pxBeat * hist.song.ppq); };
    rv.onpointerdown = (ev) => { rulerSeek(ev); try { rv.setPointerCapture(ev.pointerId); } catch (_) { /* */ } rv.onpointermove = (e2) => { if (e2.buttons) rulerSeek(e2); }; };
    bpmIn.onchange = () => { const v = Number(bpmIn.value); if (!(v >= 20 && v <= 400)) { say('⚠️ 速度要在 20 到 400 之間'); syncTransport(); return; } const multi = hist.song.tempos.length > 1; if (run({ act: 'set_tempo', bpm: v, scale: true }) && multi) say('曲中有變速,已把整條速度表等比縮放(保留快慢起伏)'); };    function drawSide() {
      const s = hist.song; side.textContent = '';
      s.tracks.forEach((tr, i) => {
        const row = el('div', 'padding:4px;border-radius:6px;margin-bottom:4px;cursor:pointer;border:1px solid ' + (i === sel ? COLORS[i % COLORS.length] : 'transparent') + ';');
        const top = el('div', 'display:flex;gap:4px;align-items:center;'); top.appendChild(el('span', 'width:10px;height:10px;border-radius:50%;background:' + COLORS[i % COLORS.length])); top.appendChild(el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', tr.name + (tr.drum ? '(鼓組)' : '')));
        const del = el('button', BTN + 'padding:0 5px;', '✕'); del.title = '刪除這一軌'; del.onclick = (e) => { e.stopPropagation(); run({ act: 'remove_track', track: i }); if (sel >= hist.song.tracks.length) sel = Math.max(0, hist.song.tracks.length - 1); drawSide(); draw(); }; top.appendChild(del); row.appendChild(top);
        if (!tr.drum) { const ps = el('select', 'width:100%;margin-top:2px;font-size:12px;'); for (let p = 0; p < 128; p++) { const o = el('option', '', gsName(p)); o.value = p; if (p === tr.program) o.selected = true; ps.appendChild(o); } ps.onclick = (e) => e.stopPropagation(); ps.onchange = () => run({ act: 'set_program', track: i, program: Number(ps.value) }); row.appendChild(ps); }
        // 混音:靜音／獨奏(試聽用)、音量、左右平衡(拖曳時即時生效,放開才記一筆可復原的改動;存進曲子,匯出成 CC7／CC10)
        const mx = el('div', 'display:flex;align-items:center;gap:4px;margin-top:3px;flex-wrap:wrap;'); mx.onclick = (e) => e.stopPropagation();
        const mB = el('button', BTN + 'padding:0 6px;font-size:12px;' + (mute.has(i) ? 'background:#e5534b;color:#fff;' : ''), 'M'), sB = el('button', BTN + 'padding:0 6px;font-size:12px;' + (solo.has(i) ? 'background:#d9a400;color:#fff;' : ''), 'S'); mB.title = '靜音這一軌(只影響試聽)'; sB.title = '獨奏這一軌(只聽有按 S 的軌,只影響試聽)';
        mB.onclick = () => { if (mute.has(i)) mute.delete(i); else mute.add(i); applyMixState(); drawSide(); }; sB.onclick = () => { if (solo.has(i)) solo.delete(i); else solo.add(i); applyMixState(); drawSide(); };
        const sl = (label, val, title, live, commit) => { const w = el('label', 'display:flex;align-items:center;gap:2px;font-size:11px;flex:1;min-width:70px;', label); const r = el('input', 'flex:1;min-width:40px;width:100%;'); r.type = 'range'; r.min = 0; r.max = 127; r.step = 1; r.value = val; r.title = title + ':' + val; r.oninput = () => { r.title = title + ':' + r.value; live(Number(r.value)); }; r.onchange = () => commit(Number(r.value)); r.ondblclick = () => { r.value = title === '左右平衡' ? 64 : 100; r.oninput(); r.onchange(); }; w.appendChild(r); return w; };
        const live = (v, p) => { const pl = pt.current(); if (pl && pl.setMix) pl.setMix(i, v, p); };
        mx.append(mB, sB, sl('音量', tr.volume, '音量', (v) => live(v, null), (v) => runQuiet({ act: 'set_mix', track: i, volume: v })), sl('平衡', tr.pan, '左右平衡', (v) => live(null, v), (v) => runQuiet({ act: 'set_mix', track: i, pan: v }))); row.appendChild(mx);
        row.onclick = () => { sel = i; drawSide(); draw(); }; side.appendChild(row);
      });
      const add = el('button', BTN + 'width:100%;margin-top:2px;', '＋ 新增音軌'); add.onclick = () => { run({ act: 'add_track', name: '軌道 ' + (hist.song.tracks.length + 1), program: 0 }); sel = hist.song.tracks.length - 1; drawSide(); draw(); };
      const addD = el('button', BTN + 'width:100%;margin-top:4px;', '＋ 新增鼓組'); addD.onclick = () => { run({ act: 'add_track', name: '鼓', drum: true }); sel = hist.song.tracks.length - 1; drawSide(); draw(); };
      side.append(add, addD);
    }
    // 共編:每次本地改動把前後兩份「有 id 的文件」算 diff 送出去;別人的 commit 進來就換掉整份曲子(不再送回去)
    function pushRemote(label) {
      if (!remote) return; const nd = E.reId(remote.doc, hist.song), ops = P.diff(remote.doc, nd, E.PATCH_KEYS); if (!ops.length) return; remote.doc = nd;
      Promise.resolve(remote.session.propose(ops, { summary: label })).then((r) => { if (r && r.ok === false && !r.queued) { say('⚠️ 這個改動被拒絕:' + (r.error || r.rejected || '')); pullRemote(); } }).catch((e) => say('⚠️ 送不出去:' + String((e && e.message) || e)));
    }
    function pullRemote() { if (!remote) return; remote.doc = remote.session.spec; hist.push(E.fromDoc(remote.doc)); stopPlay(); drawSide(); draw(); }
    function attach(session) {
      remote = { session, doc: session.spec }; keysOk(); const me = session.me && session.me.nodeId;
      session.on('commit', (c) => { if (c && c.by && c.by.nodeId === me) return; pullRemote(); }); session.on('reset', () => pullRemote());
      session.on('members', (ms) => { colB.textContent = '👥 共編中(' + ((ms || []).length || 1) + ')'; }); colB.textContent = '👥 共編中';
    }
    function keysOk() { if (remote && remote.session && !remote.session.keys) remote.session.keys = E.PATCH_KEYS; }
    colB.onclick = async () => {
      try {
        const c = host.collab; const box = el('div', 'margin-top:6px;padding:6px;border:1px dashed rgba(128,128,128,.5);border-radius:6px;'); const old = card.querySelector('.fa-midi-collab'); if (old) old.remove(); box.className = 'fa-midi-collab';
        const b1 = el('button', BTN, remote ? '已在共編' : '分享給群組'); b1.disabled = !!remote; b1.onclick = async () => { try { attach(await c.share(E.toDoc(hist.song), opts.title)); box.remove(); say('已分享給群組,對方用「👥 共編 → 加入」'); } catch (e) { say('⚠️ ' + String((e && e.message) || e)); } };
        box.appendChild(b1); const items = await c.list().catch(() => []);
        (items || []).forEach((it) => { const b = el('button', BTN + 'margin-left:6px;', '加入 ' + it.host.name + ' · ' + (it.title || 'MIDI')); b.onclick = async () => { try { const sess = await c.join(it); attach(sess); pullRemote(); box.remove(); say('已加入共編'); } catch (e) { say('⚠️ ' + String((e && e.message) || e)); } }; box.appendChild(b); });
        if (!(items || []).length) box.appendChild(el('span', 'margin-left:8px;opacity:.7', '群組裡目前沒有人開放共編的 MIDI'));
        card.insertBefore(box, mid);
      } catch (e) { say('⚠️ ' + String((e && e.message) || e)); }
    };
    // 不打斷播放的改動(混音):照樣進復原紀錄、共編與 onChange,但不停止播放、不重畫側欄(不然拖到一半滑桿會被換掉)
    function runQuiet(a) { const r = E.apply(hist.song, a); if (r.error) { say('⚠️ ' + r.error); return false; } hist.push(r.song); pushRemote(a.act); if (host.onChange) { try { host.onChange(r.song, a); } catch (_) { /* */ } } draw(); return true; }
    function applyMixState() { const p = pt.current(); if (p && p.setMuteSet) { p.setMuteSet(mute); p.setSolo(Array.from(solo)); } }
    function run(a, fromRemote) {
      const r = E.apply(hist.song, a); if (r.error) { say('⚠️ ' + r.error); return false; } if (a.act === 'remove_track' || a.act === 'merge_tracks') { mute.clear(); solo.clear(); }
      hist.push(r.song); stopPlay(); pushRemote(a.act); if (!fromRemote && host.onChange) { try { host.onChange(r.song, a); } catch (_) { /* */ } } drawSide(); draw(); return true;
    }
    cv.onclick = (ev) => { // 點空白處新增、點音符刪除
      const s = hist.song, tr = s.tracks[sel]; if (!tr) { say('先新增一軌'); return; }
      const rc = cv.getBoundingClientRect(), x = ev.clientX - rc.left, y = ev.clientY - rc.top;
      const beat = x / pxBeat, pitch = pitchLo + rows - 1 - Math.floor(y / 12), tick = beat * s.ppq;
      const hit = tr.notes.find((n) => n.n === pitch && tick >= n.t && tick < n.t + n.d);
      if (hit) run({ act: 'remove_notes', track: sel, fromBeat: hit.t / s.ppq, toBeat: (hit.t + hit.d) / s.ppq - 0.0001, pitchLo: pitch, pitchHi: pitch });
      else run({ act: 'add_note', track: sel, beat: Math.floor(beat / grid) * grid, beats: grid, pitch });
      if (host.preview) { try { host.preview(tr, pitch); } catch (_) { /* */ } }
    };
    undoB.onclick = () => { hist.undo(); pushRemote('undo'); stopPlay(); if (host.onChange) host.onChange(hist.song, { act: 'undo' }); drawSide(); draw(); };
    redoB.onclick = () => { hist.redo(); pushRemote('redo'); stopPlay(); if (host.onChange) host.onChange(hist.song, { act: 'redo' }); drawSide(); draw(); };
    const pt = FaMidiPlay.playToggle({
      player: async () => { const p = await host.player(hist.song, say); p.onTick(onTick); if (p.setMuteSet) { p.setMuteSet(mute); p.setSolo(Array.from(solo)); } const s = hist.song; if (posTick >= M.endTick(s) - 1) setPos(0, true); if (posTick > 0) p.seek(M.ticksToSec(s, posTick)); return p; },
      label: (on) => { playB.textContent = on ? '■ 停止' : '▶ 試聽'; }, ended: () => setPos(0, true), say });
    function stopPlay() { pt.stop(); }
    playB.onclick = () => pt.toggle();
    dlB.onclick = () => { try { host.download((opts.title || hist.song.title || 'song').replace(/[\\/:*?"<>|]/g, '_') + '.mid', M.write(hist.song), 'audio/midi'); } catch (e) { say('⚠️ ' + String((e && e.message) || e)); } };
    async function send() {
      const text = inp.value.trim(); if (!text) return; inp.value = '';
      const pc = E.parseCommands(text, hist.song); let n = 0, errs = [];
      pc.actions.forEach((a) => { if (run(a)) n++; else errs.push(a.act); });
      let note = n ? '已做 ' + n + ' 個動作' : '';
      if (pc.rest) {
        if (!host.askAI) note += (note ? ';' : '') + '讀不懂:' + pc.rest;
        else { go.disabled = true; say('讀不懂的部分交給 AI…'); try { const acts = await host.askAI(pc.rest, hist.song); let k = 0; (acts || []).forEach((a) => { if (E.ACTS.indexOf(a && a.act) >= 0 && run(a)) k++; }); note += (note ? ';' : '') + (k ? 'AI 做了 ' + k + ' 個動作' : 'AI 沒有給出能用的動作'); } catch (e) { note += (note ? ';' : '') + 'AI 失敗:' + String((e && e.message) || e); } go.disabled = false; }
      }
      say(note);
    }
    go.onclick = send; inp.onkeydown = (e) => { if (e.key === 'Enter') send(); };
    card._midiEdit = {
      getSong: () => hist.song, attach,
      setSong(song) { hist.push(song); drawSide(); draw(); },
      applyRemote(actions) { (actions || []).forEach((a) => run(a, true)); },
      destroy() { destroyed = true; pt.dispose(); },
    };
    drawSide(); draw(); return card;
  }
  return { mount, GS_NAMES, gsName };
});
