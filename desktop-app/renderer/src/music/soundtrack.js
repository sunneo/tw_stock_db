// 配樂:簡報、2D／3D 遊戲、影片剪輯共用的「背景音樂」介面(階段 6,設計見 DESIGN.music.md)。
//   規格 spec = { kind:'midi'|'audio', title, midiB64(MIDI 檔的 base64,kind=midi 時)、fileId(檔案快取的編號,kind=audio 時)、volume 0..1(預設 0.35)、loop(預設 true)、fadeIn 秒(預設 1.5)、fadeOut 秒(預設 2)、offset 開始秒數 }
//   純函式:normalize(spec) → 乾淨的規格或 null;gainAt(spec, t, totalSec);fill(channels, srcRate, outRate, outSec, spec) → 鋪滿 outSec 的聲道(循環接縫交叉淡化、套淡入淡出與音量,匯出影片／簡報時混進音軌用)
//   需要環境:resolve(spec, deps) → { channels, sr, duration }(MIDI 用 deps.renderMidi 離線渲染、音訊用 deps.decodeAudio 解碼,結果快取);start(ctx, destination, spec, deps) → 播放控制 { stop(fade), setVolume(v) }
// 全部延遲載入:沒有人設定配樂就不會載入合成器與音色庫。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaSoundtrack = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const r3 = (n) => Math.round(n * 1000) / 1000;
  function normalize(spec) {
    if (!spec || typeof spec !== 'object') return null;
    const kind = spec.kind === 'audio' ? 'audio' : spec.kind === 'midi' ? 'midi' : (spec.fileId ? 'audio' : spec.midiB64 ? 'midi' : '');
    if (!kind) return null;
    if (kind === 'midi' && !(typeof spec.midiB64 === 'string' && spec.midiB64.length > 20)) return null;
    if (kind === 'audio' && !spec.fileId) return null;
    const out = { kind, title: String(spec.title || (kind === 'midi' ? 'MIDI 配樂' : '音訊配樂')).slice(0, 80), volume: r3(num(spec.volume, 0, 1, 0.35)), loop: spec.loop !== false, fadeIn: r3(num(spec.fadeIn, 0, 30, 1.5)), fadeOut: r3(num(spec.fadeOut, 0, 30, 2)), offset: r3(num(spec.offset, 0, 36000, 0)) };
    if (kind === 'midi') out.midiB64 = spec.midiB64; else out.fileId = String(spec.fileId);
    return out;
  }
  // 時間 t(秒,從配樂開始算)的增益。totalSec = 這段配樂要播多久(影片長度、簡報總長);0 或沒給就不淡出
  function gainAt(spec, t, totalSec) {
    if (t < 0) return 0; let g = spec.volume;
    if (spec.fadeIn > 0 && t < spec.fadeIn) g *= t / spec.fadeIn;
    if (totalSec > 0 && spec.fadeOut > 0) { const left = totalSec - t; if (left <= 0) return 0; if (left < spec.fadeOut) g *= left / spec.fadeOut; }
    return g;
  }
  // 把來源聲道鋪成 outSec 秒、outRate 取樣率:循環時接縫做 30 毫秒交叉淡化(沒有循環就只放一次、後面靜音);回傳新的聲道陣列(單聲道來源會複製成兩聲道)
  function fill(channels, srcRate, outRate, outSec, spec) {
    const n = Math.max(0, Math.floor(outSec * outRate)), src = channels.length ? channels : [new Float32Array(0)], ratio = srcRate / outRate;
    const startS = Math.min(Math.floor(spec.offset * srcRate), Math.max(0, src[0].length - 1)), srcLen = src[0].length - startS, outCh = [];
    const xf = Math.min(Math.floor(0.03 * srcRate), Math.floor(srcLen / 4));
    for (let c = 0; c < Math.max(2, src.length); c++) {
      const s = src[Math.min(c, src.length - 1)], o = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let p = i * ratio, v;
        if (spec.loop && srcLen > 0) { // 循環體 = 開頭 xf 之後的部分;最後 xf 點漸入開頭 xf 點,接縫連續
          const L = srcLen - xf, q = p % L, k = Math.floor(q) + xf, fr = q - Math.floor(q); v = (s[startS + k] || 0) * (1 - fr) + (s[startS + Math.min(k + 1, srcLen - 1)] || 0) * fr;
          if (xf > 0 && q >= L - xf) { const w = (q - (L - xf)) / xf, h = Math.floor(q - (L - xf)); v = v * (1 - w) + (s[startS + h] || 0) * w; }
        } else { if (p >= srcLen) break; const k = Math.floor(p), fr = p - k; v = (s[startS + k] || 0) * (1 - fr) + (s[startS + Math.min(k + 1, srcLen - 1)] || 0) * fr; }
        o[i] = v * gainAt(spec, i / outRate, outSec);
      }
      outCh.push(o);
    }
    return outCh;
  }
  // 16 位元 PCM 的 wav(聲道交錯);匯出影片／簡報時混進音軌、或存成檔案
  function wavBytes(channels, sr) {
    const nc = channels.length, n = nc ? channels[0].length : 0, buf = new Uint8Array(44 + n * nc * 2), dv = new DataView(buf.buffer), w = (o, t) => { for (let i = 0; i < t.length; i++) buf[o + i] = t.charCodeAt(i); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nc, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * nc * 2, true); dv.setUint16(32, nc * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * nc * 2, true);
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) dv.setInt16(44 + (i * nc + c) * 2, Math.round(Math.max(-1, Math.min(1, channels[c][i])) * 32767), true);
    return buf;
  }
  const cache = new Map();
  function keyOf(spec) { return spec.kind === 'midi' ? 'm:' + spec.midiB64.length + ':' + spec.midiB64.slice(0, 40) + spec.midiB64.slice(-40) : 'a:' + spec.fileId; }
  async function resolve(spec, deps) {
    spec = normalize(spec); if (!spec) throw new Error('配樂規格不完整');
    const key = keyOf(spec); if (cache.has(key)) return cache.get(key);
    const p = (async () => {
      const r = spec.kind === 'midi' ? await deps.renderMidi(spec.midiB64) : await deps.decodeAudio(spec.fileId);
      if (!r || !r.channels || !r.channels.length || !(r.sr > 0)) throw new Error('配樂內容讀不出來');
      return { channels: r.channels, sr: r.sr, duration: r.channels[0].length / r.sr };
    })();
    cache.set(key, p); p.catch(() => cache.delete(key)); // 失敗不留快取,下次重試
    return p;
  }
  async function start(ctx, destination, spec, deps) {
    spec = normalize(spec); if (!spec) throw new Error('配樂規格不完整');
    const r = await resolve(spec, deps), buf = ctx.createBuffer(r.channels.length, r.channels[0].length, r.sr);
    r.channels.forEach((ch, i) => buf.getChannelData(i).set(ch));
    const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = buf; src.loop = spec.loop; if (spec.loop && spec.offset > 0 && spec.offset < r.duration) { src.loopStart = spec.offset; src.loopEnd = r.duration; }
    const t0 = ctx.currentTime; g.gain.setValueAtTime(spec.fadeIn > 0 ? 0.0001 : spec.volume, t0); if (spec.fadeIn > 0) g.gain.linearRampToValueAtTime(spec.volume, t0 + spec.fadeIn);
    src.connect(g); g.connect(destination); src.start(t0, spec.offset); let stopped = false;
    return {
      duration: r.duration,
      setVolume(v) { spec.volume = num(v, 0, 1, spec.volume); try { g.gain.cancelScheduledValues(ctx.currentTime); g.gain.setValueAtTime(spec.volume, ctx.currentTime); } catch (_) { /* */ } },
      stop(fade) { if (stopped) return; stopped = true; const f = fade == null ? spec.fadeOut : fade, t = ctx.currentTime; try { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t); g.gain.linearRampToValueAtTime(0.0001, t + Math.max(0.02, f)); src.stop(t + Math.max(0.02, f) + 0.05); } catch (_) { /* 已停 */ } }
    };
  }
  return { normalize, gainAt, fill, wavBytes, resolve, start, clearCache: () => cache.clear() };
});
