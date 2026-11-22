// 晶片音樂播放器的控制卡片（DOM，只依賴注入的 player 與 host，不碰聊天主程式）。
//   FaChipPlayerUI.mount({ player, title, host }) → DOM 節點
//   player = FaChipPlayer.createPlayer(...) 的回傳（seek／read／render／toMidi／tracks…）
//   host   = { createAudioContext(), download(name, bytes, mime), encodeMp3(view, kbps) → Promise<Blob>, midiBytes(song) → Uint8Array, onStatus? }
//   版面與操作對齊 FaMidiUI（播放／暫停、停止、重播、進度條跳轉、音軌列、下載、轉 mp3），但不綁合成器：晶片要 seek 就重新模擬。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./musiclib_chipplayer.js'));
  else root.FaChipPlayerUI = factory(root.FaChipPlayer || (typeof FaChipPlayer !== 'undefined' ? FaChipPlayer : undefined));
}(typeof self !== 'undefined' ? self : this, function (CP) {
  'use strict';
  var BLOCK_SEC = 0.5, AHEAD_SEC = 0.6, TICK_MS = 150;
  var BTN = 'cursor:pointer;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;border-radius:6px;padding:3px 9px;font-size:13px;';
  function fmt(s) { s = Math.max(0, Math.round(s)); var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; var p = function (v) { return String(v).padStart(2, '0'); }; return h ? h + ':' + p(m) + ':' + p(x) : m + ':' + p(x); }
  function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; }
  function safeName(s) { return String(s || 'song').replace(/[\\/:*?"<>|]/g, '_'); }

  function mount(opts) {
    var P = opts.player, host = opts.host || {};
    var sr = P.sampleRate, track = P.currentTrack();
    var card = el('div', 'border:1px solid rgba(128,128,128,.4);border-radius:10px;padding:10px;max-width:560px;font-size:13px;');
    card.className = 'fa-chip-card';

    var head = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
    head.appendChild(el('span', 'font-size:18px', '🎮'));
    head.appendChild(el('b', 'flex:1;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', opts.title || P.title || '晶片音樂'));
    head.appendChild(el('span', 'opacity:.7', P.label + '・' + P.trackCount() + ' 首'));
    card.appendChild(head);

    var bar = el('div', 'display:flex;align-items:center;gap:6px;margin:8px 0;flex-wrap:wrap;');
    var prevBtn = el('button', BTN, '⏮'); prevBtn.title = '上一首';
    var playBtn = el('button', BTN, '▶ 播放'); playBtn.title = '播放／暫停';
    var stopBtn = el('button', BTN, '■'); stopBtn.title = '停止（回到開頭）';
    var replayBtn = el('button', BTN, '↺'); replayBtn.title = '重播（從頭開始）';
    var nextBtn = el('button', BTN, '⏭'); nextBtn.title = '下一首';
    var seek = el('input', 'flex:1;min-width:80px;'); seek.type = 'range'; seek.min = 0; seek.max = 1000; seek.value = 0;
    var time = el('span', 'font-variant-numeric:tabular-nums;opacity:.8;white-space:nowrap;');
    bar.append(prevBtn, playBtn, stopBtn, replayBtn, nextBtn, seek, time); card.appendChild(bar);

    var gotoRow = el('div', 'display:flex;align-items:center;gap:6px;margin-bottom:6px;');
    var gIn = el('input', 'flex:1;min-width:90px;'); gIn.placeholder = '跳到 1:23、83 秒，或 曲目 3';
    var gBtn = el('button', BTN, '前往');
    var loopLbl = el('label', 'display:flex;align-items:center;gap:4px;margin-left:auto;');
    var loopCb = el('input'); loopCb.type = 'checkbox';
    loopLbl.append(loopCb, document.createTextNode('重複'));
    gotoRow.append(gIn, gBtn, loopLbl); card.appendChild(gotoRow);

    var status = el('div', 'opacity:.75;min-height:1.2em;font-size:12px;'); card.appendChild(status);
    function say(m) { status.textContent = m || ''; }

    // ───── 播放（排程 AudioBuffer，播放位置由 AudioContext 時鐘推算） ─────
    var ctx = null, playing = false, sources = [], t0 = 0, base = 0, timer = null, pausedAt = 0, schedEnd = 0;
    function ensureCtx() { if (!ctx) ctx = host.createAudioContext ? host.createAudioContext() : new (window.AudioContext || window.webkitAudioContext)(); return ctx; }
    function nowSec() { return playing ? Math.min(P.durationSec(), base + (ensureCtx().currentTime - t0)) : pausedAt; }
    function scheduleAhead() {
      if (!playing) return;
      var c = ensureCtx();
      while (playing && !P.atEnd() && schedEnd < c.currentTime + AHEAD_SEC) {
        var n = Math.round(BLOCK_SEC * sr), buf = new Float32Array(n);
        var got = P.read(buf, n); if (!got) break;
        var ab = c.createBuffer(1, got, sr); ab.copyToChannel(buf.subarray(0, got), 0);
        var s = c.createBufferSource(); s.buffer = ab; s.connect(c.destination);
        var at = Math.max(c.currentTime, schedEnd);
        s.start(at); schedEnd = at + got / sr;
        sources.push({ node: s });
        s.onended = function () { sources = sources.filter(function (x) { return x.node !== s; }); };
      }
      if (playing && P.atEnd() && sources.length === 0) finish();
    }
    function stopSources() { sources.forEach(function (x) { try { x.node.onended = null; x.node.stop(); } catch (_) { /* */ } }); sources = []; }
    function finish() {
      playing = false; stopSources(); clearInterval(timer); timer = null;
      if (loopCb.checked) { P.seek(0); pausedAt = 0; play(); return; }
      pausedAt = 0; P.seek(0); playBtn.textContent = '▶ 播放'; say('播完了');
    }
    function play() {
      var c = ensureCtx();
      if (c.state === 'suspended' && c.resume) c.resume();
      P.seek(pausedAt);
      base = pausedAt; t0 = c.currentTime + 0.05; schedEnd = t0;
      playing = true; playBtn.textContent = '❚❚ 暫停';
      sources = []; scheduleAhead();
      clearInterval(timer); timer = setInterval(tick, TICK_MS);
    }
    function pause() {
      if (!playing) return;
      pausedAt = nowSec(); playing = false; stopSources(); clearInterval(timer); timer = null;
      P.seek(pausedAt); playBtn.textContent = '▶ 播放'; tick();
    }
    function tick() {
      if (playing) { scheduleAhead(); }
      var cur = nowSec(), total = P.durationSec();
      if (!seekDragging) seek.value = total ? Math.round(cur / total * 1000) : 0;
      time.textContent = fmt(cur) + ' / ' + fmt(total);
    }
    var seekDragging = false;
    function stopAll() { playing = false; stopSources(); clearInterval(timer); timer = null; pausedAt = 0; P.seek(0); playBtn.textContent = '▶ 播放'; tick(); }
    function seekTo(sec) {
      var was = playing;
      if (was) { playing = false; stopSources(); clearInterval(timer); timer = null; }
      pausedAt = Math.max(0, Math.min(P.durationSec(), sec)); P.seek(pausedAt); tick();
      if (was) play();
    }
    function switchTrack(i) {
      var was = playing; stopAll();
      P.selectTrack(i); track = i; renderTracks(); tick();
      say('曲目 ' + (i + 1) + '：' + P.tracks()[i].title);
      if (was) play();
    }

    playBtn.onclick = function () { try { if (playing) pause(); else play(); } catch (e) { say('⚠️ 無法播放：' + String((e && e.message) || e)); playing = false; playBtn.textContent = '▶ 播放'; } };
    stopBtn.onclick = function () { stopAll(); say(''); };
    replayBtn.onclick = function () { pausedAt = 0; stopAll(); play(); };
    prevBtn.onclick = function () { if (P.currentTrack() > 0) switchTrack(P.currentTrack() - 1); };
    nextBtn.onclick = function () { if (P.currentTrack() < P.trackCount() - 1) switchTrack(P.currentTrack() + 1); };
    seek.oninput = function () { seekDragging = true; var total = P.durationSec(); time.textContent = fmt(seek.value / 1000 * total) + ' / ' + fmt(total); };
    seek.onchange = function () { seekDragging = false; seekTo(seek.value / 1000 * P.durationSec()); };
    function doGoto() {
      var g = CP.parseGoto(gIn.value);
      if (!g) { say('看不懂：請輸入 1:23、83（秒）或 曲目 3'); return; }
      if (g.kind === 'track') { if (g.index >= P.trackCount()) { say('沒有第 ' + (g.index + 1) + ' 首（共 ' + P.trackCount() + ' 首）'); return; } switchTrack(g.index); return; }
      if (g.sec > P.durationSec()) { say('超過曲長（' + fmt(P.durationSec()) + '）'); return; }
      seekTo(g.sec); say('跳到 ' + fmt(g.sec));
    }
    gBtn.onclick = doGoto;
    gIn.onkeydown = function (e) { if (e.key === 'Enter') doGoto(); };

    // 音軌列（RIX 只有一首；NSF、SPC 等多首的後端會用到）
    var list = el('div', 'margin-top:6px;');
    function renderTracks() {
      list.textContent = '';
      P.tracks().forEach(function (tr) {
        var row = el('div', 'display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;' + (tr.index === P.currentTrack() ? 'font-weight:600;' : ''));
        row.appendChild(el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', (tr.index + 1) + '. ' + tr.title));
        row.appendChild(el('span', 'opacity:.7;font-variant-numeric:tabular-nums;', fmt(tr.durationSec)));
        row.onclick = function () { if (tr.index !== P.currentTrack()) switchTrack(tr.index); };
        list.appendChild(row);
      });
    }
    renderTracks();
    if (P.trackCount() <= 1) { prevBtn.disabled = true; nextBtn.disabled = true; }
    card.appendChild(list);

    // ───── 匯出：mp3（預設一分鐘，可指定分鐘數）與 MIDI ─────
    var exp = el('div', 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;');
    var minIn = el('input', 'width:56px;'); minIn.type = 'number'; minIn.min = 0.1; minIn.step = 0.5; minIn.value = 1;
    var mp3Btn = el('button', BTN, '⬇ mp3'); mp3Btn.title = '從目前曲目的開頭渲染，長度由分鐘數決定';
    var midBtn = el('button', BTN, '⬇ MIDI');
    exp.append(el('span', '', '分鐘'), minIn, mp3Btn, midBtn); card.appendChild(exp);
    var expStat = el('div', 'opacity:.75;font-size:12px;min-height:1.2em;'); card.appendChild(expStat);
    function expSay(m) { expStat.textContent = m || ''; }

    mp3Btn.onclick = async function () {
      var min = Number(minIn.value);
      if (!(min > 0)) { expSay('⚠️ 分鐘數要大於 0'); return; }
      mp3Btn.disabled = true; var old = mp3Btn.textContent; mp3Btn.textContent = '渲染中…';
      try {
        var sec = Math.min(min * 60, P.durationSec());
        expSay('渲染晶片聲音（' + fmt(sec) + '）…');
        var pcm = P.render(P.currentTrack(), 0, sec);
        var view = { numberOfChannels: 1, sampleRate: sr, length: pcm.length, duration: pcm.length / sr, getChannelData: function () { return pcm; } };
        expSay('編碼 mp3…');
        var blob = await host.encodeMp3(view, 160);
        var bytes = new Uint8Array(await blob.arrayBuffer());
        host.download(safeName(opts.title || P.title) + '_' + (P.currentTrack() + 1) + '.mp3', bytes, 'audio/mpeg');
        expSay('已輸出 mp3（' + fmt(sec) + '，' + Math.round(bytes.length / 1024) + ' KB）');
      } catch (e) { expSay('⚠️ 匯出 mp3 失敗：' + String((e && e.message) || e)); }
      mp3Btn.disabled = false; mp3Btn.textContent = old;
    };
    midBtn.onclick = function () {
      try {
        var song = P.toMidi(P.currentTrack());
        host.download(safeName(opts.title || P.title) + '_' + (P.currentTrack() + 1) + '.mid', host.midiBytes(song), 'audio/midi');
        expSay('已輸出 MIDI');
      } catch (e) { expSay('⚠️ ' + String((e && e.message) || e)); }
    };

    card._chip = { destroy: function () { stopAll(); if (ctx && ctx.close) { try { ctx.close(); } catch (_) { /* */ } } } };
    tick();
    return card;
  }
  return { mount: mount, fmt: fmt };
}));
