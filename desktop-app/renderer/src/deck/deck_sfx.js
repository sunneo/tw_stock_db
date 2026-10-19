// Sound effects of a deck, made by program (no sound files to ship or to lose): render(name, sampleRate, opts) -> Float32Array (mono, -1..1).
// The names are what a deck description can use in a collage: pop, boing, whoosh, thump, knock, step, wind, ding, sparkle, growl, bell, splat.
// Deterministic (a seeded noise), so the same deck sounds the same in the player and in the exported MP4.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatDeckSfx = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NAMES = ['pop', 'boing', 'whoosh', 'thump', 'knock', 'step', 'wind', 'ding', 'sparkle', 'growl', 'bell', 'splat'];
  var SEC = { pop: 0.18, boing: 0.5, whoosh: 0.7, thump: 0.35, knock: 0.45, step: 0.16, wind: 1.6, ding: 0.9, sparkle: 0.8, growl: 0.9, bell: 1.2, splat: 0.4 };

  function rng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s / 4294967296) * 2 - 1; }; }
  function env(t, a, d) { return t < a ? t / a : Math.exp(-(t - a) / d); }

  // one tone with a pitch that can slide: f0 -> f1 over `dur`, amplitude envelope attack a, decay d
  function tone(out, sr, start, dur, f0, f1, a, d, gain, shape) {
    var n = Math.floor(dur * sr), s0 = Math.floor(start * sr), ph = 0;
    for (var i = 0; i < n && s0 + i < out.length; i++) {
      var t = i / sr, f = f0 + (f1 - f0) * (t / dur); ph += 2 * Math.PI * f / sr;
      var v = shape === 'square' ? (Math.sin(ph) > 0 ? 0.6 : -0.6) : (shape === 'tri' ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : Math.sin(ph));
      out[s0 + i] += v * env(t, a, d) * gain;
    }
  }
  function noise(out, sr, start, dur, a, d, gain, lp, seed) {
    var r = rng(seed || 7), n = Math.floor(dur * sr), s0 = Math.floor(start * sr), y = 0;
    for (var i = 0; i < n && s0 + i < out.length; i++) { var t = i / sr; y += (r() - y) * lp; out[s0 + i] += y * env(t, a, d) * gain; }
  }

  function render(name, sr, opts) {
    opts = opts || {}; name = NAMES.indexOf(name) >= 0 ? name : 'pop'; sr = sr || 44100;
    var dur = opts.dur || SEC[name], out = new Float32Array(Math.ceil(dur * sr)), vol = opts.volume == null ? 1 : opts.volume;
    if (name === 'pop') { tone(out, sr, 0, 0.16, 520, 1500, 0.004, 0.035, 0.7, 'sine'); noise(out, sr, 0, 0.04, 0.001, 0.01, 0.25, 0.6, 3); }
    else if (name === 'boing') { tone(out, sr, 0, 0.45, 180, 520, 0.005, 0.18, 0.55, 'tri'); tone(out, sr, 0.04, 0.4, 360, 1040, 0.005, 0.12, 0.2, 'sine'); }
    else if (name === 'whoosh') { noise(out, sr, 0, 0.7, 0.18, 0.22, 0.9, 0.12, 11); noise(out, sr, 0.1, 0.5, 0.2, 0.15, 0.4, 0.4, 13); }
    else if (name === 'thump') { tone(out, sr, 0, 0.32, 110, 45, 0.003, 0.07, 0.95, 'sine'); noise(out, sr, 0, 0.06, 0.001, 0.015, 0.3, 0.08, 5); }
    else if (name === 'knock') { [0, 0.2].forEach(function (s, k) { tone(out, sr, s, 0.12, 260, 190, 0.002, 0.03, 0.8, 'sine'); noise(out, sr, s, 0.03, 0.001, 0.008, 0.35, 0.3, 21 + k); }); }
    else if (name === 'step') { tone(out, sr, 0, 0.12, 140, 80, 0.002, 0.03, 0.7, 'sine'); noise(out, sr, 0, 0.05, 0.001, 0.012, 0.3, 0.2, 9); }
    else if (name === 'wind') { noise(out, sr, 0, 1.6, 0.4, 0.9, 0.55, 0.035, 17); noise(out, sr, 0.2, 1.2, 0.5, 0.7, 0.3, 0.07, 19); }
    else if (name === 'ding') { tone(out, sr, 0, 0.9, 1320, 1320, 0.003, 0.25, 0.5, 'sine'); tone(out, sr, 0, 0.9, 1980, 1980, 0.003, 0.15, 0.2, 'sine'); }
    else if (name === 'sparkle') { [0, 0.08, 0.16, 0.26, 0.36].forEach(function (s, k) { tone(out, sr, s, 0.3, 1800 + k * 380, 2200 + k * 380, 0.002, 0.07, 0.3, 'sine'); }); }
    else if (name === 'growl') { tone(out, sr, 0, 0.9, 90, 70, 0.08, 0.5, 0.6, 'square'); tone(out, sr, 0, 0.9, 135, 100, 0.08, 0.4, 0.25, 'tri'); noise(out, sr, 0, 0.9, 0.1, 0.5, 0.15, 0.05, 23); }
    else if (name === 'bell') { [523, 1046, 1568, 2093].forEach(function (f, k) { tone(out, sr, 0, 1.2, f, f, 0.002, 0.5 / (k + 1), 0.4 / (k + 1), 'sine'); }); }
    else if (name === 'splat') { noise(out, sr, 0, 0.3, 0.002, 0.07, 0.8, 0.25, 31); tone(out, sr, 0, 0.3, 220, 80, 0.002, 0.06, 0.5, 'sine'); }
    var peak = 0; for (var i = 0; i < out.length; i++) { var a = Math.abs(out[i]); if (a > peak) { peak = a; } }
    var g = peak > 0 ? (0.85 / peak) * vol : 0; for (var j = 0; j < out.length; j++) { out[j] *= g; }
    return out;
  }

  return { NAMES: NAMES, DURATION: SEC, render: render };
});
