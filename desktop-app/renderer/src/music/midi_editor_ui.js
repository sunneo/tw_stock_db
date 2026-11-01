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
    const M = opts.M, E = opts.E, host = opts.host || {};
    const hist = E.history(opts.song);
    let sel = 0, grid = 0.5, pxBeat = 40, pitchLo = 36, rows = 36, playing = null, destroyed = false;
    const card = el('div', 'border:1px solid rgba(128,128,128,.4);border-radius:10px;padding:10px;max-width:720px;font-size:13px;'); card.className = 'fa-midi-edit';
    const head = el('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;');
    head.appendChild(el('span', 'font-size:18px', '🎼')); head.appendChild(el('b', 'flex:1;min-width:80px', opts.title || hist.song.title || 'MIDI 編輯器'));
    const undoB = el('button', BTN, '↶'), redoB = el('button', BTN, '↷'), playB = el('button', BTN, '▶ 試聽'), dlB = el('button', BTN, '⬇ MIDI');
    undoB.title = '復原'; redoB.title = '重做';
    const gridSel = el('select', BTN); [['四分音符', 1], ['八分音符', 0.5], ['十六分音符', 0.25]].forEach(([n, v]) => { const o = el('option', '', n); o.value = v; if (v === grid) o.selected = true; gridSel.appendChild(o); });
    gridSel.onchange = () => { grid = Number(gridSel.value); };
    head.append(undoB, redoB, gridSel, playB, dlB); card.appendChild(head);
    const mid = el('div', 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;');
    const side = el('div', 'min-width:170px;flex:0 0 170px;');
    const canvasWrap = el('div', 'flex:1;min-width:240px;overflow:auto;border:1px solid rgba(128,128,128,.3);border-radius:6px;max-height:300px;');
    const cv = el('canvas', 'display:block;cursor:crosshair;'); canvasWrap.appendChild(cv); mid.append(side, canvasWrap); card.appendChild(mid);
    const status = el('div', 'opacity:.75;min-height:1.2em;font-size:12px;margin-top:6px;'); card.appendChild(status);
    const say = (m) => { status.textContent = m || ''; };
    const ask = el('div', 'display:flex;gap:6px;margin-top:6px;');
    const inp = el('input', 'flex:1;min-width:120px;padding:4px 6px;'); inp.placeholder = '跟編輯器說話,例如「第一軌升兩個半音」「速度改成 90」「貝斯換成大提琴」';
    const go = el('button', BTN, '送出'); ask.append(inp, go); card.appendChild(ask);

    function draw() {
      const s = hist.song, dpr = window.devicePixelRatio || 1;
      const end = Math.max(16, Math.ceil(M.endTick(s) / s.ppq) + 4), W = end * pxBeat, H = rows * 12;
      cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      for (let r = 0; r < rows; r++) { const p = pitchLo + rows - 1 - r; if ([1, 3, 6, 8, 10].indexOf(p % 12) >= 0) { g.fillStyle = 'rgba(128,128,128,.12)'; g.fillRect(0, r * 12, W, 12); } if (p % 12 === 0) { g.fillStyle = 'rgba(128,128,128,.35)'; g.fillRect(0, r * 12 + 11, W, 1); g.fillStyle = 'rgba(128,128,128,.8)'; g.font = '9px sans-serif'; g.fillText(M.noteName(p), 2, r * 12 + 9); } }
      for (let b = 0; b <= end; b++) { g.fillStyle = b % s.timesig.n === 0 ? 'rgba(128,128,128,.5)' : 'rgba(128,128,128,.2)'; g.fillRect(b * pxBeat, 0, 1, H); }
      s.tracks.forEach((tr, i) => { g.fillStyle = COLORS[i % COLORS.length]; g.globalAlpha = i === sel ? 1 : 0.35; tr.notes.forEach((n) => { const r = pitchLo + rows - 1 - n.n; if (r < 0 || r >= rows) return; g.fillRect(n.t / s.ppq * pxBeat, r * 12 + 1, Math.max(3, n.d / s.ppq * pxBeat - 1), 10); }); }); g.globalAlpha = 1;
      undoB.disabled = !hist.canUndo(); redoB.disabled = !hist.canRedo();
    }
    function drawSide() {
      const s = hist.song; side.textContent = '';
      s.tracks.forEach((tr, i) => {
        const row = el('div', 'padding:4px;border-radius:6px;margin-bottom:4px;cursor:pointer;border:1px solid ' + (i === sel ? COLORS[i % COLORS.length] : 'transparent') + ';');
        const top = el('div', 'display:flex;gap:4px;align-items:center;'); top.appendChild(el('span', 'width:10px;height:10px;border-radius:50%;background:' + COLORS[i % COLORS.length])); top.appendChild(el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', tr.name + (tr.drum ? '(鼓組)' : '')));
        const del = el('button', BTN + 'padding:0 5px;', '✕'); del.title = '刪除這一軌'; del.onclick = (e) => { e.stopPropagation(); run({ act: 'remove_track', track: i }); if (sel >= hist.song.tracks.length) sel = Math.max(0, hist.song.tracks.length - 1); drawSide(); draw(); }; top.appendChild(del); row.appendChild(top);
        if (!tr.drum) { const ps = el('select', 'width:100%;margin-top:2px;font-size:12px;'); for (let p = 0; p < 128; p++) { const o = el('option', '', gsName(p)); o.value = p; if (p === tr.program) o.selected = true; ps.appendChild(o); } ps.onclick = (e) => e.stopPropagation(); ps.onchange = () => run({ act: 'set_program', track: i, program: Number(ps.value) }); row.appendChild(ps); }
        row.onclick = () => { sel = i; drawSide(); draw(); }; side.appendChild(row);
      });
      const add = el('button', BTN + 'width:100%;margin-top:2px;', '＋ 新增音軌'); add.onclick = () => { run({ act: 'add_track', name: '軌道 ' + (hist.song.tracks.length + 1), program: 0 }); sel = hist.song.tracks.length - 1; drawSide(); draw(); };
      const addD = el('button', BTN + 'width:100%;margin-top:4px;', '＋ 新增鼓組'); addD.onclick = () => { run({ act: 'add_track', name: '鼓', drum: true }); sel = hist.song.tracks.length - 1; drawSide(); draw(); };
      side.append(add, addD);
    }
    function run(a, fromRemote) {
      const r = E.apply(hist.song, a); if (r.error) { say('⚠️ ' + r.error); return false; }
      hist.push(r.song); stopPlay(); if (!fromRemote && host.onChange) { try { host.onChange(r.song, a); } catch (_) { /* */ } } drawSide(); draw(); return true;
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
    undoB.onclick = () => { hist.undo(); stopPlay(); if (host.onChange) host.onChange(hist.song, { act: 'undo' }); drawSide(); draw(); };
    redoB.onclick = () => { hist.redo(); stopPlay(); if (host.onChange) host.onChange(hist.song, { act: 'redo' }); drawSide(); draw(); };
    function stopPlay() { if (playing) { try { playing.stop(); } catch (_) { /* */ } playing = null; playB.textContent = '▶ 試聽'; } }
    playB.onclick = async () => {
      if (playing) { stopPlay(); return; }
      try { say('準備合成器…'); playing = await host.player(hist.song, say); playing.onEnd(() => { playing = null; playB.textContent = '▶ 試聽'; }); playing.play(); playB.textContent = '■ 停止'; say(''); }
      catch (e) { say('⚠️ 無法試聽:' + String((e && e.message) || e)); playing = null; }
    };
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
      getSong: () => hist.song,
      setSong(song) { hist.push(song); drawSide(); draw(); },
      applyRemote(actions) { (actions || []).forEach((a) => run(a, true)); },
      destroy() { destroyed = true; stopPlay(); },
    };
    drawSide(); draw(); return card;
  }
  return { mount, GS_NAMES, gsName };
});
