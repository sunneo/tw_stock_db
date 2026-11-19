// 音訊主機（UMD，純邏輯）：程式（python 的 pygame.mixer／fa_audio、node 的 audio）把 PCM 或已編碼的聲音檔經橋接送到頁面，頁面用 Web Audio 真的播出來。
// 為什麼在頁面：程式跑在 Worker 裡，Worker 沒有 AudioContext；頁面有。協定不經過視窗（音訊不屬於哪個視窗）：op "audio"，欄位 cmd：
//   load   {name, rate, channels, data}   data＝16 位元有號 PCM（小端）的 base64；channels 1 或 2        → {duration, name}
//          {name, encoded, mime}          encoded＝wav／mp3／ogg 等檔案的 base64，由瀏覽器解碼（async）  → {duration, name}
//   unload {name}
//   play   {name, ch?, loops?, volume?, fade_ms?, maxtime_ms?, music?}  loops：0＝播一次、-1＝一直播、n＝多播 n 次；ch 沒給就找空的聲道；music＝用獨立的音樂聲道
//          → {ch}（沒有空聲道：{ch: -1}）
//   stop   {ch} 或 {name} 或 {all: true} 或 {music: true}；fade_ms？                                       → {stopped}
//   volume {ch, volume}（0..1）、{master: v}、{music: true, volume}
//   busy   {ch?}、{music: true}                                                                           → {busy, count}
//   pause／resume                                                                                        整個 AudioContext 暫停／繼續
//   channels {n}                                                                                         聲道數（1..32，預設 8）
//   info   {name}                                                                                        → {duration} 或 null
// 限制：一個聲音至多 8 MB 的 PCM（編碼檔 12 MB）、同時至多 64 個聲音、總計 64 MB；聲道至多 32。owner（呼叫的終端機／job）結束時 stopOwner 收掉它的聲音。
// 瀏覽器的自動播放政策：AudioContext 可能是 suspended（還沒有使用者操作過頁面）；play 會嘗試 resume，仍不行就回傳 suspended:true（聲音排在 context 上，resume 後才響）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatAudioHost = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX_PCM = 8 * 1048576, MAX_ENC = 12 * 1048576, MAX_SOUNDS = 64, MAX_TOTAL = 64 * 1048576, MAX_CH = 32;

  function b64bytes(s) {
    var bin = atob(String(s || '')), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { u[i] = bin.charCodeAt(i); }
    return u;
  }

  // opts: { AudioContext }（建構子；測試傳假的）、owner 在 handle 的第二個參數
  function create(opts) {
    opts = opts || {};
    var Ctor = opts.AudioContext || (typeof AudioContext !== 'undefined' ? AudioContext : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null));
    var ctx = null, master = null, sounds = {}, total = 0, nch = 8, channels = [], music = null, masterVol = 1;

    function ensure() {
      if (!Ctor) { throw new Error('這個環境沒有 Web Audio（AudioContext）'); }
      if (!ctx) { ctx = new Ctor(); master = ctx.createGain(); master.gain.value = masterVol; master.connect(ctx.destination); }
      return ctx;
    }
    function resume() {
      var c = ensure();
      if (c.state === 'suspended' && c.resume) { try { c.resume(); } catch (e) { /* 沒有使用者操作時會被擋 */ } }
      return c.state === 'suspended';
    }
    function drop(name) { var s = sounds[name]; if (s) { total -= s.bytes; delete sounds[name]; } }
    function store(name, buffer, bytes) {
      if (!sounds[name] && Object.keys(sounds).length >= MAX_SOUNDS) { throw new Error('最多同時載入 ' + MAX_SOUNDS + ' 個聲音（unload 不用的）'); }
      if (total - (sounds[name] ? sounds[name].bytes : 0) + bytes > MAX_TOTAL) { throw new Error('載入的聲音總量超過 ' + (MAX_TOTAL >> 20) + ' MB'); }
      drop(name);
      sounds[name] = { buffer: buffer, bytes: bytes };
      total += bytes;
      return { name: name, duration: buffer.duration };
    }
    function load(a) {
      var name = String(a.name || ''); if (!/^[\w.-]{1,60}$/.test(name)) { throw new Error('聲音名稱要是 1~60 個英數、_、.、-'); }
      var c = ensure();
      if (a.encoded !== undefined) {
        var enc = b64bytes(a.encoded); if (enc.length > MAX_ENC) { throw new Error('聲音檔超過 ' + (MAX_ENC >> 20) + ' MB'); }
        return Promise.resolve(c.decodeAudioData(enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength))).then(function (buf) { return store(name, buf, buf.length * buf.numberOfChannels * 4); });
      }
      var rate = Number(a.rate) || 44100, chans = Number(a.channels) === 2 ? 2 : 1;
      if (rate < 3000 || rate > 192000) { throw new Error('取樣率要在 3000~192000'); }
      var raw = b64bytes(a.data); if (raw.length > MAX_PCM) { throw new Error('PCM 超過 ' + (MAX_PCM >> 20) + ' MB'); }
      var frames = Math.floor(raw.length / (2 * chans));
      if (frames < 1) { throw new Error('PCM 是空的'); }
      var dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength), buf = c.createBuffer(chans, frames, rate), k, i, d;
      for (k = 0; k < chans; k++) { d = buf.getChannelData(k); for (i = 0; i < frames; i++) { d[i] = dv.getInt16((i * chans + k) * 2, true) / 32768; } }
      return store(name, buf, frames * chans * 4);
    }
    function ensureChannels() { while (channels.length < nch) { channels.push(null); } if (channels.length > nch) { channels.length = nch; } }
    function stopSlot(slot, fadeMs) {
      if (!slot) { return false; }
      var c = ctx, t = c.currentTime;
      try {
        if (fadeMs > 0) { slot.gain.gain.cancelScheduledValues(t); slot.gain.gain.setValueAtTime(slot.gain.gain.value, t); slot.gain.gain.linearRampToValueAtTime(0, t + fadeMs / 1000); slot.src.stop(t + fadeMs / 1000); }
        else { slot.src.stop(); }
      } catch (e) { /* 已經停了 */ }
      return true;
    }
    function play(a, owner) {
      var s = sounds[String(a.name || '')]; if (!s) { throw new Error('沒有載入這個聲音：' + a.name); }
      var susp = resume(), c = ctx; ensureChannels();
      var isMusic = !!a.music, idx = -1;
      if (!isMusic) {
        if (a.ch !== undefined && a.ch !== null && Number(a.ch) >= 0) { idx = Math.min(nch - 1, Number(a.ch) | 0); stopSlot(channels[idx], 0); }
        else { for (var i = 0; i < nch; i++) { if (!channels[i]) { idx = i; break; } } }
        if (idx < 0) { return { ch: -1 }; }
      } else { stopSlot(music, 0); }
      var src = c.createBufferSource(), gain = c.createGain(), vol = a.volume === undefined ? 1 : Math.max(0, Math.min(1, Number(a.volume)));
      src.buffer = s.buffer; var loops = a.loops === undefined ? 0 : Number(a.loops);
      if (loops !== 0) { src.loop = true; }
      var fade = Number(a.fade_ms) || 0, t = c.currentTime;
      if (fade > 0) { gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(vol, t + fade / 1000); } else { gain.gain.value = vol; }
      src.connect(gain); gain.connect(master);
      var slot = { src: src, gain: gain, name: a.name, owner: owner || '', ends: loops === -1 ? Infinity : t + s.buffer.duration * (loops + 1) };
      if (isMusic) { music = slot; } else { channels[idx] = slot; }
      src.onended = function () { if (isMusic) { if (music === slot) { music = null; } } else if (channels[idx] === slot) { channels[idx] = null; } };
      if (loops > 0) { try { src.loopEnd = s.buffer.duration; } catch (e) { /* 預設就是整段 */ } }
      src.start(t);
      var stopAfter = Number(a.maxtime_ms) > 0 ? Number(a.maxtime_ms) / 1000 : (loops > 0 ? s.buffer.duration * (loops + 1) : 0);
      if (stopAfter > 0) { try { src.stop(t + stopAfter); } catch (e) { /* */ } }
      return { ch: isMusic ? -2 : idx, suspended: susp };
    }
    function stop(a, owner) {
      if (!ctx) { return { stopped: 0 }; }
      var n = 0, fade = Number(a.fade_ms) || 0;
      // 不淡出的停止：聲道立刻釋放（onended 是瀏覽器非同步送來的，不能等它）
      function kill(i, isMusic) { var slot = isMusic ? music : channels[i]; if (!stopSlot(slot, fade)) { return 0; } if (fade <= 0) { if (isMusic) { music = null; } else { channels[i] = null; } } return 1; }
      if (a.all) { for (var i = 0; i < channels.length; i++) { if (channels[i] && (!owner || channels[i].owner === owner)) { n += kill(i, false); } } if (music && (!owner || music.owner === owner)) { n += kill(0, true); } }
      else if (a.music) { n += kill(0, true); }
      else if (a.ch !== undefined && a.ch !== null) { n += kill(Number(a.ch) | 0, false); }
      else if (a.name) { for (var j = 0; j < channels.length; j++) { if (channels[j] && channels[j].name === a.name) { n += kill(j, false); } } }
      return { stopped: n };
    }
    function busy(a) {
      if (!ctx) { return { busy: false, count: 0 }; }
      if (a.music) { return { busy: !!music, count: music ? 1 : 0 }; }
      if (a.ch !== undefined && a.ch !== null) { var s = channels[Number(a.ch) | 0]; return { busy: !!s, count: s ? 1 : 0 }; }
      var n = 0; for (var i = 0; i < channels.length; i++) { if (channels[i]) { n++; } }
      return { busy: n > 0, count: n };
    }
    function volume(a) {
      ensure();
      var v = Math.max(0, Math.min(1, Number(a.volume === undefined ? a.master : a.volume)));
      if (a.master !== undefined && a.ch === undefined && !a.music) { masterVol = v; master.gain.value = v; return { ok: true }; }
      var slot = a.music ? music : channels[Number(a.ch) | 0]; if (slot) { slot.gain.gain.value = v; }
      return { ok: !!slot };
    }

    // 回傳 Promise（或同步值）：呼叫端一律 await
    function handle(a, owner) {
      a = a || {};
      switch (String(a.cmd || '')) {
        case 'load': return load(a);
        case 'unload': drop(String(a.name || '')); return { ok: true };
        case 'play': return play(a, owner);
        case 'stop': return stop(a, owner);
        case 'volume': return volume(a);
        case 'busy': return busy(a);
        case 'pause': if (ctx && ctx.suspend) { ctx.suspend(); } return { ok: true };
        case 'resume': if (ctx && ctx.resume) { ctx.resume(); } return { ok: true };
        case 'channels': nch = Math.max(1, Math.min(MAX_CH, Number(a.n) | 0 || 8)); ensureChannels(); return { n: nch };
        case 'info': return sounds[String(a.name || '')] ? { duration: sounds[String(a.name)].buffer.duration } : null;
        default: throw new Error('不認得的 audio 指令：' + a.cmd);
      }
    }
    // 程式結束：收掉這個 owner 的聲音（沒有 owner 就全部）
    function stopOwner(owner) { stop({ all: true }, owner); }
    return { handle: handle, stopOwner: stopOwner, stats: function () { return { sounds: Object.keys(sounds).length, bytes: total, channels: nch, state: ctx ? ctx.state : 'none' }; }, close: function () { stop({ all: true }); sounds = {}; total = 0; if (ctx && ctx.close) { try { ctx.close(); } catch (e) { /* */ } } ctx = null; } };
  }
  return { create: create, LIMITS: { MAX_PCM: MAX_PCM, MAX_ENC: MAX_ENC, MAX_SOUNDS: MAX_SOUNDS, MAX_TOTAL: MAX_TOTAL, MAX_CH: MAX_CH } };
}));
