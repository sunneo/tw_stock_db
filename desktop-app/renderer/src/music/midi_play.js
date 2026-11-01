// 音樂領域:播放排程核心 FaMidiPlay(純函式＋與合成器無關的播放器;node 與瀏覽器都能跑,合成器用「轉接器」注入)。
//   轉接器介面(SpessaSynth 的 WorkletSynthesizer 剛好符合,見 loadSynth):
//     noteOn(ch, n, v, {time}) noteOff(ch, n, {time}) programChange(ch, p, {time}) controllerChange(ch, cc, val, {time}) stopAll(force)
//   時間 time 是 AudioContext 的絕對秒數;播放器用 clock() 取得現在時間(預設 ctx.currentTime)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./midi_core.js')); else root.FaMidiPlay = factory(root.FaMidi || (typeof FaMidi !== 'undefined' ? FaMidi : undefined)); })(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  // 軌道 → 頻道:鼓組固定 9,其他依序用 0–15 跳過 9;超過 15 個旋律軌的多餘軌道不發聲(回報在 dropped)
  function channelMap(song) {
    const map = []; let next = 0; const dropped = [];
    song.tracks.forEach((t, i) => {
      if (t.drum) { map[i] = 9; return; }
      if (next === 9) next++;
      if (next > 15) { map[i] = -1; dropped.push(i); return; }
      map[i] = next++;
    });
    return { map, dropped };
  }

  // 整首曲子變成依時間排序的事件清單(秒)。opts.mute: 靜音軌道索引集合;opts.solo: 獨奏索引(有就只放它);
  // 同一時間的順序:程式／控制 → 音符結束 → 音符開始(同音高連續音不會被吃掉)
  function buildEvents(song, opts) {
    opts = opts || {}; const mute = new Set(opts.mute || []); const solo = opts.solo != null ? new Set([].concat(opts.solo)) : null;
    const { map } = channelMap(song); const ev = [];
    song.tracks.forEach((tr, i) => {
      const ch = map[i]; if (ch < 0) return;
      ev.push({ t: 0, ord: 0, type: 'prog', ch, a: tr.drum ? 0 : tr.program });
      ev.push({ t: 0, ord: 0, type: 'cc', ch, a: 7, b: tr.volume }, { t: 0, ord: 0, type: 'cc', ch, a: 10, b: tr.pan });
      if (mute.has(i) || (solo && !solo.has(i))) return;
      for (const n of tr.notes) {
        const on = M.ticksToSec(song, n.t), off = M.ticksToSec(song, n.t + n.d);
        ev.push({ t: on, ord: 2, type: 'on', ch, a: n.n, b: n.v, i }, { t: off, ord: 1, type: 'off', ch, a: n.n, i });
      }
    });
    ev.sort((x, y) => x.t - y.t || x.ord - y.ord);
    return ev;
  }

  // 播放器:前瞻排程(每 tickMs 把接下來 ahead 秒內的事件送進合成器,時間用絕對 AudioContext 秒數)
  function createPlayer(song, synth, opts) {
    opts = opts || {};
    const clock = opts.clock || (() => 0); const ahead = opts.ahead || 0.25, tickMs = opts.tickMs || 50;
    const setT = opts.setInterval || setInterval, clearT = opts.clearInterval || clearInterval;
    const setOnce = opts.setTimeout || (typeof setTimeout === 'function' ? setTimeout : null), clearOnce = opts.clearTimeout || (typeof clearTimeout === 'function' ? clearTimeout : null), group = opts.group || null;
    const st = { song, events: [], idx: 0, startAt: 0, offset: 0, playing: false, timer: null, mute: new Set(), solo: null, volume: new Map(), total: M.durationSec(song), onEnd: null, onTick: null, loop: !!opts.loop, held: new Map(), guard: null, disposed: false };
    const rebuild = () => { st.events = buildEvents(st.song, { mute: st.mute, solo: st.solo }); };
    const pos = () => (st.playing ? Math.min(st.total, st.offset + (clock() - st.startAt)) : st.offset);
    const evOpts = (at) => ({ time: at });
    const send = (e, at) => {
      if (e.type === 'on') { synth.noteOn(e.ch, e.a, e.b, evOpts(at)); const k = e.ch + ':' + e.a; (st.held.get(k) || st.held.set(k, []).get(k)).push(at); }
      else if (e.type === 'off') { synth.noteOff(e.ch, e.a, evOpts(at)); const k = e.ch + ':' + e.a, l = st.held.get(k); if (l) { l.shift(); if (!l.length) st.held.delete(k); } }
      else if (e.type === 'prog') synth.programChange(e.ch, e.a, evOpts(at));
      else if (e.type === 'cc') {
        const { map } = channelMap(st.song); const ti = map.indexOf(e.ch); let b = e.b;
        if (e.a === 7 && st.volume.has(ti)) b = Math.round(b * st.volume.get(ti));
        synth.controllerChange(e.ch, e.a, Math.max(0, Math.min(127, b)), evOpts(at));
      }
    };
    const seekIndex = (sec) => { let lo = 0, hi = st.events.length; while (lo < hi) { const m = (lo + hi) >> 1; if (st.events[m].t < sec) lo = m + 1; else hi = m; } return lo; };
    function pump() {
      const now = clock(); const rel = st.offset + (now - st.startAt);
      while (st.idx < st.events.length && st.events[st.idx].t <= rel + ahead) {
        const e = st.events[st.idx++]; send(e, st.startAt + (e.t - st.offset) );
      }
      if (st.onTick) st.onTick(Math.min(st.total, rel));
      if (rel >= st.total + 0.05 && st.idx >= st.events.length) {
        if (st.loop) { api.seek(0); return; }
        api.pause(); st.offset = 0; if (st.onEnd) st.onEnd();
      }
    }
    // 清掉混音(暫停、停止、播放完畢、換曲、跳轉、卡片被移除、頁面關閉都走這裡):合成器會把「帶時間」的事件排進佇列,stopAll 取消不了還沒到時間的 noteOn,
    // 所以(1)每個送出了 noteOn 卻還沒送 noteOff 的音符,補一個「不早於它開始時間」的 noteOff(沒有這個,排在前面的 noteOn 之後會永遠響,長音與 loop 音色尤其明顯);
    // (2)每個頻道送延音踏板放開、全部聲音關閉、全部音符關閉;(3)stopAll(true);(4)過了前瞻時間再關一次,把剛好在這之後才到時間的殘餘聲音收掉。
    function silenceAll() {
      if (st.timer) { clearT(st.timer); st.timer = null; }
      const now = clock();
      st.held.forEach((times, k) => { const i = k.indexOf(':'), ch = Number(k.slice(0, i)), n = Number(k.slice(i + 1)); times.forEach((at) => { try { synth.noteOff(ch, n, evOpts(Math.max(now, at) + 0.01)); } catch (_) { /* 合成器已釋放 */ } }); });
      st.held.clear();
      for (let ch = 0; ch < 16; ch++) { try { synth.controllerChange(ch, 64, 0, evOpts(now)); synth.controllerChange(ch, 120, 0, evOpts(now)); synth.controllerChange(ch, 123, 0, evOpts(now)); } catch (_) { /* */ } }
      try { synth.stopAll(true); } catch (_) { /* */ }
      if (st.guard && clearOnce) { clearOnce(st.guard); st.guard = null; }
      if (setOnce) st.guard = setOnce(() => { st.guard = null; if (!st.playing) { try { synth.stopAll(true); } catch (_) { /* */ } } }, (ahead + 0.2) * 1000);
    }
    // 跳轉時,已經開始但還沒結束的音符要補送 noteOn 嗎?不補(從音符邊界重新聽起);跳轉前先全部停掉
    const api = {
      state: st,
      play() {
        if (st.playing || st.disposed) return;
        // 同一個合成器只讓一張卡片出聲:另一張正在放的先停掉並通知它的畫面(共用頻道,不然互相蓋掉或漏關)
        if (group) { const other = group.active; if (other && other !== api) { try { other.stop(); if (other.state.onEnd) other.state.onEnd(); } catch (_) { /* */ } } group.active = api; }
        rebuild();
        // 從 offset 開始;先送出所有 t<offset 的程式／控制事件,讓音色與音量到位
        st.idx = 0;
        const now = clock(); st.startAt = now + 0.05;
        while (st.idx < st.events.length && st.events[st.idx].t < st.offset) { const e = st.events[st.idx++]; if (e.type === 'prog' || e.type === 'cc') send(e, now); }
        st.playing = true; st.timer = setT(pump, tickMs); pump();
      },
      pause() { if (st.playing) { st.offset = pos(); st.playing = false; } silenceAll(); },
      stop() { if (st.playing) { st.offset = pos(); st.playing = false; } silenceAll(); st.offset = 0; if (st.onTick) st.onTick(0); },
      // 卡片被移除、清除對話、頁面關閉:停掉、清空、之後不再出聲(重複呼叫沒關係)
      dispose() { if (st.disposed) return; st.playing = false; silenceAll(); st.disposed = true; st.onEnd = null; st.onTick = null; if (group && group.active === api) group.active = null; },
      isDisposed() { return st.disposed; },
      silence() { silenceAll(); },
      seek(sec) { const was = st.playing; if (was) api.pause(); st.offset = Math.max(0, Math.min(st.total, Number(sec) || 0)); if (was) api.play(); else if (st.onTick) st.onTick(st.offset); },
      position() { return pos(); },
      duration() { return st.total; },
      isPlaying() { return st.playing; },
      setMute(i, on) { if (on) st.mute.add(i); else st.mute.delete(i); api._refresh(); },
      setSolo(i) { st.solo = i == null ? null : [i]; api._refresh(); },
      setTrackVolume(i, factor) { st.volume.set(i, Math.max(0, Math.min(1.5, Number(factor)))); const { map } = channelMap(st.song); if (map[i] >= 0) { const base = st.song.tracks[i].volume; synth.controllerChange(map[i], 7, Math.max(0, Math.min(127, Math.round(base * st.volume.get(i)))), evOpts(clock())); } },
      setSong(s) { const was = st.playing; if (was) api.pause(); st.song = s; st.total = M.durationSec(s); st.offset = Math.min(st.offset, st.total); if (was) api.play(); },
      _refresh() { if (st.playing) { const at = pos(); api.pause(); st.offset = at; api.play(); } },
      onEnd(f) { st.onEnd = f; }, onTick(f) { st.onTick = f; }, setLoop(v) { st.loop = !!v; }
    };
    return api;
  }

  // 瀏覽器端:載入 SpessaSynth(程式庫與處理器文字用 fetchText 取得,以 data 位址載入,離線單檔與 file 頁面都可)與音色庫。
  // sources = { lib, processor, soundbank }:各自是網址陣列(依序試,失敗換下一個);onProgress(msg, 0..1)
  async function loadSynth(ctx, destination, sources, onProgress, fetchImpl) {
    const prog = onProgress || (() => {}); const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!f) throw new Error('這個環境沒有 fetch,無法載入合成器');
    const getText = async (urls) => { let last = ''; for (const u of urls) { try { const r = await f(u); if (!r.ok) { last = 'HTTP ' + r.status + ' ' + u; continue; } return await r.text(); } catch (e) { last = String(e && e.message || e) + ' ' + u; } } throw new Error('載入失敗:' + last); };
    prog('載入合成器程式…', 0.02);
    const [procText, libText] = await Promise.all([getText(sources.processor), getText(sources.lib)]);
    const b64 = (t) => btoa(unescape(encodeURIComponent(t)));
    await ctx.audioWorklet.addModule('data:text/javascript;base64,' + b64(procText));
    const mod = await import(/* webpackIgnore: true */ 'data:text/javascript;base64,' + b64(libText));
    const synth = new mod.WorkletSynthesizer(ctx); await synth.isReady; synth.connect(destination);
    const bank = await fetchBank(sources.soundbank, prog, f);
    prog('安裝音色庫…', 0.97);
    await synth.soundBankManager.addSoundBank(bank, 'main');
    prog('就緒', 1);
    return synth;
  }
  // 分片來源:{ base, path }。base 底下有 manifest.json({files:[{path,size,sha256,parts,partSize:[…],partSha256:[…]}]})與 <path>.partNNN;
  // 每片單獨核對長度與 sha256、單獨放進 Cache API(中斷後重來只補缺的片),合併後核對總大小。base 要用完整 commit SHA 釘住。
  async function sha256Hex(buf) { const d = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join(''); }
  async function fetchParts(src, prog, f) {
    const CACHE = 'fa-soundbank-v1'; const base = src.base;
    const cache = typeof caches !== 'undefined' ? await caches.open(CACHE) : null;
    const mUrl = base + 'manifest.json'; let mr = await f(mUrl); if (!mr.ok) throw new Error('manifest HTTP ' + mr.status);
    const man = await mr.json(); const ent = (man.files || []).find((x) => x.path === src.path); if (!ent || !(ent.parts > 0)) throw new Error('manifest 裡沒有 ' + src.path);
    const whole = base + '#' + src.path + '@' + (ent.sha256 || ent.size); const hit = cache && await cache.match(whole); if (hit) { prog('從本機快取讀取音色庫…', 0.5); return await hit.arrayBuffer(); }
    const out = new Uint8Array(ent.size); let off = 0;
    for (let i = 0; i < ent.parts; i++) {
      const u = base + src.path + '.part' + String(i).padStart(3, '0'); let buf = null; const ph = cache && await cache.match(u); if (ph) { const b = await ph.arrayBuffer(); if (b.byteLength === ent.partSize[i]) buf = b; }
      if (!buf) {
        prog('下載音色庫 第 ' + (i + 1) + ' / ' + ent.parts + ' 片(共 ' + Math.round(ent.size / 1048576) + ' MB)', i / ent.parts);
        const r = await f(u); if (!r.ok) throw new Error(u.split('/').pop() + ' HTTP ' + r.status); buf = await r.arrayBuffer();
        if (buf.byteLength !== ent.partSize[i]) throw new Error('第 ' + (i + 1) + ' 片長度不符(預期 ' + ent.partSize[i] + '、實際 ' + buf.byteLength + ')');
        if (ent.partSha256 && typeof crypto !== 'undefined' && crypto.subtle && (await sha256Hex(buf)) !== ent.partSha256[i]) throw new Error('第 ' + (i + 1) + ' 片檢查碼不符');
        if (cache) { try { await cache.put(u, new Response(buf.slice(0))); } catch (e) { /* 配額不足就算了 */ } }
      }
      out.set(new Uint8Array(buf), off); off += buf.byteLength;
    }
    if (off !== ent.size) throw new Error('合併後大小不符(預期 ' + ent.size + '、實際 ' + off + ')');
    if (new Uint8Array(out.buffer, 0, 4).join() !== '82,73,70,70') throw new Error('不是 sf2/RIFF 檔');
    if (cache) { try { await cache.put(whole, new Response(out.buffer.slice(0))); } catch (e) { /* */ } }
    return out.buffer;
  }
  // 下載音色庫:有進度、核對長度、快取放 Cache API(下次不用再下載)
  async function fetchBank(urls, prog, f) {
    const CACHE = 'fa-soundbank-v1';
    const list = [].concat(urls || []); let last = '';
    for (const u of list) {
      if (u && typeof u === 'object') { try { return await fetchParts(u, prog, f); } catch (e) { last = String(e && e.message || e); continue; } }
      try {
        const cache = typeof caches !== 'undefined' ? await caches.open(CACHE) : null;
        const hit = cache && await cache.match(u); if (hit) { prog('從本機快取讀取音色庫…', 0.5); return await hit.arrayBuffer(); }
        const r = await f(u); if (!r.ok) { last = 'HTTP ' + r.status; continue; }
        const total = Number(r.headers.get('content-length')) || 0; const reader = r.body && r.body.getReader ? r.body.getReader() : null;
        let buf;
        if (reader) { const chunks = []; let got = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; if (total) prog('下載音色庫 ' + Math.round(got / 1048576) + ' / ' + Math.round(total / 1048576) + ' MB', 0.05 + 0.9 * got / total); } buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; } if (total && got !== total) { last = '大小不符 ' + got + '/' + total; continue; } buf = buf.buffer; }
        else buf = await r.arrayBuffer();
        if (new Uint8Array(buf, 0, 4).join() !== '82,73,70,70') { last = '不是 sf2/RIFF 檔'; continue; }
        if (cache) { try { await cache.put(u, new Response(buf.slice(0))); } catch (e) { /* 配額不足就算了 */ } }
        return buf;
      } catch (e) { last = String(e && e.message || e); }
    }
    throw new Error('音色庫下載失敗:' + last);
  }

  // 離線渲染成 AudioBuffer(MIDI 轉 mp3 的前半):tail 秒是音符結束後的殘響
  async function renderOffline(song, sources, opts) {
    opts = opts || {}; const sr = opts.sampleRate || 44100, tail = opts.tail == null ? 2.5 : opts.tail;
    const secs = M.durationSec(song) + tail; const OAC = opts.OfflineAudioContext || (typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : null);
    if (!OAC) throw new Error('這個環境不支援離線渲染(沒有 OfflineAudioContext)');
    const ctx = new OAC(2, Math.ceil(secs * sr), sr);
    const synth = await loadSynth(ctx, ctx.destination, sources, opts.onProgress, opts.fetch);
    const adapter = { noteOn: (c, n, v, o) => synth.noteOn(c, n, v, o), noteOff: (c, n, o) => synth.noteOff(c, n, o), programChange: (c, p, o) => synth.programChange(c, p, o), controllerChange: (c, cc, v, o) => synth.controllerChange(c, cc, v, o) };
    const evs = buildEvents(song, { mute: opts.mute });
    for (const e of evs) {
      const o = { time: e.t };
      if (e.type === 'on') adapter.noteOn(e.ch, e.a, e.b, o); else if (e.type === 'off') adapter.noteOff(e.ch, e.a, o);
      else if (e.type === 'prog') adapter.programChange(e.ch, e.a, o); else adapter.controllerChange(e.ch, e.a, e.b, o);
    }
    // 事件經 MessagePort 非同步送進處理器執行緒,離線渲染一開始就跑會搶在事件前面(結果是靜音);等事件到齊再開始
    await new Promise((r) => setTimeout(r, 300 + Math.min(4000, evs.length / 10)));
    if (opts.onProgress) opts.onProgress('渲染中…', 0.98);
    return await ctx.startRendering();
  }

  return { channelMap, buildEvents, createPlayer, loadSynth, fetchBank, fetchParts, renderOffline };
});
