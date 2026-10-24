// 遊戲的聲音(四條 bus:bgm 背景音樂、sfx 遊戲音、fx 特效聲、voice 對話框人物聲;設計見 DESIGN.edit-game.md §8)。
//   純函式(node 測得到、匯出時可以預先烘成 wav):FaGameAudio.renderSfx(name, sr, opts) -> Float32Array     renderSong(asset, sr) -> Float32Array(可循環)     wavBlobBytes(samples, sr) -> Uint8Array(16-bit mono wav)
//   播放(要 AudioContext):FaGameAudio.createPlayer(ctx, { buses, assets, voiceProvider }) -> { play(ev), bgm(id), stop(id), setBus(name, v), resume(), dispose() }
// 聲音都是程式合成的(不依賴外部曲庫與版權):sfx 是幾段方波／三角波／雜訊的音高滑動;背景音樂是依風格(happy、calm、tense、battle、sad、town、victory)由種子生成的旋律、低音與鼓。
// 人物聲:voiceProvider(text, voice) 回傳 AudioBuffer(TTS 烘好的音檔);沒有時退回「嘴音」(每個字一個短音,依聲線的音高)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaGameAudio = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TAU = Math.PI * 2;
  const rng = (seed) => { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
  function osc(shape, ph) { const p = ph - Math.floor(ph); switch (shape) { case 'square': return p < 0.5 ? 1 : -1; case 'pulse': return p < 0.25 ? 1 : -1; case 'saw': return 2 * p - 1; case 'tri': return Math.abs(4 * p - 2) - 1; case 'sine': return Math.sin(TAU * p); default: return 0; } }
  // 一段音:{ shape, f0, f1, dur, vol, a(起音), d(衰減), delay }
  function segs(out, sr, list, seed, pitch) {
    const R = rng(seed || 1); list.forEach((g) => {
      const start = Math.floor((g.delay || 0) * sr), n = Math.floor(g.dur * sr), a = Math.max(1, Math.floor((g.a == null ? 0.004 : g.a) * sr)); let ph = 0, lp = 0;
      for (let i = 0; i < n && start + i < out.length; i++) {
        const t = i / n, f = (g.f0 + (g.f1 - g.f0) * (g.curve === 'exp' ? t * t : t)) * (pitch || 1); ph += f / sr; const env = (i < a ? i / a : 1) * Math.pow(1 - t, g.decay == null ? 1.4 : g.decay);
        let v; if (g.shape === 'noise') { const w = R() * 2 - 1; lp += (w - lp) * (g.lp == null ? 0.5 : g.lp); v = lp; } else { v = osc(g.shape || 'square', ph); }
        out[start + i] += v * env * (g.vol == null ? 0.3 : g.vol);
      }
    });
  }
  const SFX = {
    jump: [{ shape: 'square', f0: 280, f1: 620, dur: 0.16, vol: 0.22 }],
    coin: [{ shape: 'square', f0: 988, f1: 988, dur: 0.07, vol: 0.2, decay: 0.3 }, { shape: 'square', f0: 1319, f1: 1319, dur: 0.22, vol: 0.2, delay: 0.07, decay: 1 }],
    hit: [{ shape: 'noise', f0: 1, f1: 1, dur: 0.09, vol: 0.5, lp: 0.6 }, { shape: 'square', f0: 220, f1: 90, dur: 0.09, vol: 0.2 }],
    hurt: [{ shape: 'saw', f0: 400, f1: 110, dur: 0.28, vol: 0.28 }, { shape: 'noise', f0: 1, f1: 1, dur: 0.12, vol: 0.2, lp: 0.4 }],
    explosion: [{ shape: 'noise', f0: 1, f1: 1, dur: 0.55, vol: 0.7, lp: 0.12, decay: 1.8 }, { shape: 'square', f0: 120, f1: 30, dur: 0.4, vol: 0.25, decay: 1.6 }],
    powerup: [523, 659, 784, 1047, 1319].map((f, i) => ({ shape: 'square', f0: f, f1: f, dur: 0.07, vol: 0.2, delay: i * 0.055, decay: 0.5 })),
    select: [{ shape: 'square', f0: 660, f1: 660, dur: 0.05, vol: 0.18, decay: 0.4 }],
    confirm: [{ shape: 'square', f0: 660, f1: 660, dur: 0.05, vol: 0.18, decay: 0.4 }, { shape: 'square', f0: 990, f1: 990, dur: 0.09, vol: 0.18, delay: 0.05 }],
    step: [{ shape: 'noise', f0: 1, f1: 1, dur: 0.035, vol: 0.3, lp: 0.3 }],
    shoot: [{ shape: 'square', f0: 900, f1: 160, dur: 0.12, vol: 0.18, curve: 'exp' }],
    stomp: [{ shape: 'square', f0: 330, f1: 110, dur: 0.1, vol: 0.25 }, { shape: 'noise', f0: 1, f1: 1, dur: 0.06, vol: 0.25, lp: 0.5 }],
    death: [{ shape: 'square', f0: 520, f1: 130, dur: 0.6, vol: 0.25, decay: 1 }, { shape: 'tri', f0: 260, f1: 65, dur: 0.6, vol: 0.2, decay: 1 }],
    win: [523, 659, 784, 1047, 784, 1047].map((f, i) => ({ shape: 'square', f0: f, f1: f, dur: i === 5 ? 0.4 : 0.11, vol: 0.2, delay: i * 0.12, decay: 0.7 })),
    lose: [392, 330, 262, 196].map((f, i) => ({ shape: 'tri', f0: f, f1: f * 0.98, dur: i === 3 ? 0.5 : 0.16, vol: 0.28, delay: i * 0.17, decay: 0.8 })),
    door: [{ shape: 'noise', f0: 1, f1: 1, dur: 0.18, vol: 0.2, lp: 0.15 }, { shape: 'square', f0: 140, f1: 90, dur: 0.18, vol: 0.12 }],
    blip: [{ shape: 'square', f0: 440, f1: 440, dur: 0.04, vol: 0.14, decay: 0.5 }]
  };
  const SFX_DUR = { jump: 0.2, coin: 0.32, hit: 0.14, hurt: 0.32, explosion: 0.6, powerup: 0.45, select: 0.08, confirm: 0.16, step: 0.05, shoot: 0.15, stomp: 0.15, death: 0.65, win: 1.1, lose: 1.0, door: 0.22, blip: 0.06 };
  function renderSfx(name, sr, opts) {
    sr = sr || 22050; opts = opts || {}; const def = SFX[name] || SFX.blip; const dur = (SFX_DUR[name] || 0.2) + 0.05; const out = new Float32Array(Math.floor(dur * sr)); segs(out, sr, def, opts.seed || 1, opts.pitch || 1);
    for (let i = 0; i < out.length; i++) { out[i] = Math.max(-1, Math.min(1, out[i])); } return out;
  }
  // ───────────────────────── 背景音樂 ─────────────────────────
  const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], pent: [0, 2, 4, 7, 9], dorian: [0, 2, 3, 5, 7, 9, 10] };
  const STYLES = {
    happy: { scale: 'major', root: 60, lead: 'square', bass: 'tri', drums: 'light', prog: [0, 3, 4, 0], dens: 0.75 },
    calm: { scale: 'pent', root: 57, lead: 'tri', bass: 'sine', drums: 'none', prog: [0, 5, 3, 4], dens: 0.45 },
    tense: { scale: 'minor', root: 52, lead: 'saw', bass: 'square', drums: 'driving', prog: [0, 0, 5, 6], dens: 0.85 },
    battle: { scale: 'minor', root: 55, lead: 'square', bass: 'saw', drums: 'driving', prog: [0, 6, 5, 4], dens: 0.95 },
    sad: { scale: 'minor', root: 52, lead: 'tri', bass: 'sine', drums: 'none', prog: [0, 5, 3, 4], dens: 0.4 },
    town: { scale: 'dorian', root: 57, lead: 'tri', bass: 'tri', drums: 'light', prog: [0, 3, 0, 4], dens: 0.65 },
    victory: { scale: 'major', root: 62, lead: 'square', bass: 'tri', drums: 'light', prog: [0, 4, 0, 0], dens: 0.9 }
  };
  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  function renderSong(asset, sr) {
    sr = sr || 22050; const st = STYLES[asset.style] || STYLES.happy, bars = Math.max(2, Math.min(32, asset.bars || 8)), tempo = asset.tempo || 120, beat = 60 / tempo, total = bars * 4 * beat; const out = new Float32Array(Math.floor(total * sr)); const R = rng(asset.seed || 1);
    const sc = SCALES[st.scale]; const deg = (d, oct) => st.root + sc[((d % sc.length) + sc.length) % sc.length] + 12 * (Math.floor(d / sc.length) + (oct || 0));
    const note = (shape, n, t0, dur, vol) => { const g = [{ shape, f0: midi(n), f1: midi(n), dur: Math.max(0.04, dur), vol, delay: t0, a: 0.006, decay: shape === 'sine' || shape === 'tri' ? 0.6 : 1.1 }]; segs(out, sr, g, 1, 1); };
    let last = 2; for (let bar = 0; bar < bars; bar++) {
      const chord = st.prog[bar % st.prog.length]; const t0 = bar * 4 * beat;
      for (let b = 0; b < 4; b++) { note(st.bass, deg(chord, -2) - (b % 2 ? 0 : 0), t0 + b * beat, beat * 0.9, 0.13); if (b === 2 || st.dens > 0.8) { note(st.bass, deg(chord + 4, -2), t0 + (b + 0.5) * beat, beat * 0.4, 0.08); } }
      for (let s = 0; s < 8; s++) { if (R() > st.dens) { continue; } const step = R() < 0.6 ? (R() < 0.5 ? 1 : -1) : (R() < 0.5 ? 2 : -2); last = Math.max(-2, Math.min(9, last + step)); const target = (s % 4 === 0) ? [0, 2, 4][Math.floor(R() * 3)] + chord : last + chord; note(st.lead, deg(s % 4 === 0 ? target : last + chord, 1), t0 + s * beat / 2, beat * (R() < 0.3 ? 0.9 : 0.45), 0.1); }
      if (st.drums !== 'none') { for (let b = 0; b < 4; b++) { const t = t0 + b * beat; if (b % 2 === 0) { segs(out, sr, [{ shape: 'sine', f0: 140, f1: 45, dur: 0.12, vol: 0.28, delay: t, decay: 1.2 }], 1, 1); } if (b % 2 === 1) { segs(out, sr, [{ shape: 'noise', f0: 1, f1: 1, dur: 0.1, vol: 0.14, delay: t, lp: 0.7 }], bar * 7 + b, 1); } if (st.drums === 'driving') { segs(out, sr, [{ shape: 'noise', f0: 1, f1: 1, dur: 0.03, vol: 0.07, delay: t + beat / 2, lp: 0.9 }], bar * 11 + b, 1); } } }
    }
    for (let i = 0; i < out.length; i++) { out[i] = Math.max(-1, Math.min(1, out[i] * 0.9)); } const fade = Math.floor(0.01 * sr); for (let i = 0; i < fade; i++) { out[i] *= i / fade; out[out.length - 1 - i] *= i / fade; } return out;
  }
  function wavBytes(samples, sr) {
    const n = samples.length, buf = new Uint8Array(44 + n * 2), dv = new DataView(buf.buffer); const w = (o, s) => { for (let i = 0; i < s.length; i++) { buf[o + i] = s.charCodeAt(i); } };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true); } return buf;
  }
  const VOICE_PITCH = { narrator: 190, calm: 220, deep: 130, rough: 150, elder: 170, old_woman: 260, young: 300, child: 380, none: 0 };
  // ───────────────────────── 播放 ─────────────────────────
  function createPlayer(ctx, o) {
    o = o || {}; const assets = o.assets || {}; const master = ctx.createGain(); master.connect(ctx.destination); const buses = {}; ['bgm', 'sfx', 'fx', 'voice'].forEach((b) => { const g = ctx.createGain(); g.gain.value = o.buses && o.buses[b] != null ? o.buses[b] : 1; g.connect(master); buses[b] = g; });
    const cache = {}; let bgmNode = null, bgmId = null; const playing = {}; let muted = {};
    const bufferOf = (samples, sr) => { const b = ctx.createBuffer(1, samples.length, sr); b.getChannelData(0).set(samples); return b; };
    function sfxBuffer(id) { const a = assets[id]; const key = 'sfx:' + id; if (cache[key]) { return cache[key]; } const sr = ctx.sampleRate > 24000 ? 22050 : ctx.sampleRate; const samples = renderSfx(a && a.synth ? a.synth : id, sr, { seed: a && a.seed, pitch: a && a.pitch }); return (cache[key] = bufferOf(samples, sr)); }
    function songBuffer(id) { const a = assets[id]; if (!a || a.kind !== 'song') { return null; } const key = 'song:' + id; if (cache[key]) { return cache[key]; } const sr = 22050; return (cache[key] = bufferOf(renderSong(a, sr), sr)); }
    function playBuffer(buf, bus, loop, vol) { const src = ctx.createBufferSource(); src.buffer = buf; src.loop = !!loop; const g = ctx.createGain(); g.gain.value = vol == null ? 1 : vol; src.connect(g); g.connect(buses[bus] || buses.sfx); src.start(); return { src, g }; }
    function stopBgm(fade) { if (!bgmNode) { return; } const n = bgmNode; bgmNode = null; bgmId = null; try { n.g.gain.setTargetAtTime(0, ctx.currentTime, (fade || 0.25) / 3); n.src.stop(ctx.currentTime + (fade || 0.25) + 0.05); } catch (e) { /* 已停 */ } }
    function bgm(id) { if (id === bgmId) { return; } stopBgm(0.4); if (!id) { return; } const b = songBuffer(id); if (!b) { return; } bgmId = id; bgmNode = playBuffer(b, 'bgm', true, 0.001); bgmNode.g.gain.setTargetAtTime(1, ctx.currentTime, 0.2); }
    function mouth(text, voice) { const base = VOICE_PITCH[voice] != null ? VOICE_PITCH[voice] : 200; if (!base) { return; } const chars = Array.from(String(text || '')).filter((c) => /\S/.test(c)).slice(0, 40); chars.forEach((c, i) => { const f = base * (1 + ((c.charCodeAt(0) % 7) - 3) * 0.05); const s = renderSfxTone(f); const when = ctx.currentTime + i * 0.065; const src = ctx.createBufferSource(); src.buffer = s; const g = ctx.createGain(); g.gain.value = 0.5; src.connect(g); g.connect(buses.voice); src.start(when); }); }
    function renderSfxTone(f) { const sr = 22050, out = new Float32Array(Math.floor(0.05 * sr)); segs(out, sr, [{ shape: 'tri', f0: f, f1: f * 0.97, dur: 0.05, vol: 0.4, decay: 0.8 }], 1, 1); return bufferOf(out, sr); }
    function play(ev) {
      if (!ev) { return; } if (ev.kind === 'bgm') { bgm(ev.id); return; } if (ev.kind === 'stop_all') { stopBgm(0.5); return; } if (ev.kind === 'stop') { if (!ev.id || ev.id === bgmId) { stopBgm(); } return; }
      if (ev.kind === 'voice') { if (o.voiceProvider) { Promise.resolve(o.voiceProvider(ev.text, ev.voice, ev.id)).then((b) => { if (b) { playBuffer(b, 'voice', false, 1); } else { mouth(ev.text, ev.voice); } }, () => mouth(ev.text, ev.voice)); } else { mouth(ev.text, ev.voice); } return; }
      if (ev.kind === 'play') { const a = assets[ev.id]; if (a && a.kind === 'song') { bgm(ev.id); return; } if (a && a.kind === 'voice') { if (o.voiceProvider) { Promise.resolve(o.voiceProvider(a.text, a.voice, ev.id)).then((b) => { if (b) { playBuffer(b, 'voice', false, 1); } }); } else { mouth(a.text, a.voice); } return; } if (a && a.kind === 'image') { return; } playBuffer(sfxBuffer(ev.id), ev.bus === 'fx' ? 'fx' : 'sfx', false, 1); }
    }
    return { play, bgm, stop: stopBgm, setBus(n, v) { if (buses[n]) { buses[n].gain.value = v; } }, mute(on) { master.gain.value = on ? 0 : 1; muted = on; }, resume() { try { return ctx.resume(); } catch (e) { return null; } }, dispose() { stopBgm(0.05); try { master.disconnect(); } catch (e) { /* */ } }, _cache: cache, _muted: () => muted, playing };
  }
  return { renderSfx, renderSong, wavBytes, createPlayer, SFX_NAMES: Object.keys(SFX), STYLES: Object.keys(STYLES), VOICES: Object.keys(VOICE_PITCH), SFX_DUR };
});
