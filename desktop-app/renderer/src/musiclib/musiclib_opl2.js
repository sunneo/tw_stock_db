/* OPL2（Yamaha YM3812）數位模擬：純函式（UMD），不碰 DOM／網路。授權：MIT（自寫）。
 *   依據：Yamaha YM3812 公開的暫存器位址表（0x01 波形致能、0x20 AM/VIB/EGT/KSR/倍頻、0x40 KSL/總音量、0x60 AR/DR、0x80 SL/RR、
 *   0xE0 波形選擇、0xA0 F-number 低位、0xB0 按鍵/八度/F-number 高位、0xC0 回授/連接）。
 *   沒有抄貼任何 GPL 程式（DOSBox、AdPlug 等）；細節是「近似」：包絡用指數衰減、KSL 與 Tremolo／Vibrato 用簡化公式。
 *   用法：
 *     var chip = FaOpl2.create(sampleRate); chip.write(reg, val); chip.render(outFloat32, count) → 單聲道 −1..1 附近的樣本
 *     chip.snapshot() / chip.restore(s)：整個晶片狀態的複製（給分段快取用）
 *   介面的 reg 是 0x00..0xFF 的 OPL 暫存器位址。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaOpl2 = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var CHIP_RATE = 49716;                         // OPL2 的內部更新率（時脈 3.579545 MHz ÷ 72）
  var MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
  var MOD_OFF = [0, 1, 2, 8, 9, 10, 16, 17, 18];  // 九個頻道的調變器運算元位址（載波＝+3）
  var KSL_DB = [0, 3, 1.5, 6];                   // KSL 每級的衰減係數（dB，依八度放大）
  var TWO_PI = Math.PI * 2;

  // 包絡速率索引 rk = 4×速率 + 按鍵縮放（KSR 開為 keyScale，關為 keyScale÷4）；rk 每加 4 時間減半。rk=0 不動。
  function rateTau(rk) { if (rk <= 0) return Infinity; if (rk > 63) rk = 63; return 0.0009 * Math.pow(2, (60 - rk) / 4); }   // 秒，近似
  function rateIndex(rate, keyScale, ksr) { if (!rate) return 0; var ks = ksr ? keyScale : (keyScale >> 2); return Math.min(63, 4 * rate + ks); }
  function wave(ph, ws) {
    var s = Math.sin(TWO_PI * ph);
    switch (ws) {
      case 1: return s > 0 ? s : 0;              // 半波正弦
      case 2: return Math.abs(s);                // 絕對值正弦
      case 3: return ph < 0.5 ? Math.abs(s) : 0; // 脈衝式（近似）
      default: return s;
    }
  }

  // 一個晶片的全部狀態都放在 state（型別陣列），snapshot 只要複製它們
  function newState() {
    return {
      reg: new Uint8Array(256),
      phase: new Float64Array(32), env: new Float64Array(32), stage: new Uint8Array(32),
      fbHist: new Float64Array(9 * 2), chPhaseDummy: new Float64Array(9),
      t: 0
    };
  }

  function create(sampleRate) {
    var sr = sampleRate || 44100;
    var st = newState();
    // 由暫存器衍生的參數（寫入時重算，不必每個取樣都重解）
    var op = {};                                  // op[offset] = { mult, ksr, egt, vib, am, ksl, tl, ar, dr, sl, rr, ws }
    var ch = [];                                  // ch[c] = { hz, keyOn, fb, cnt, block, fnum }
    for (var c = 0; c < 9; c++) ch.push({ hz: 0, keyOn: 0, fb: 0, cnt: 0, block: 0, fnum: 0 });

    function deriveOp(o) {
      var r = st.reg, m = r[0x20 + o], k = r[0x40 + o], a = r[0x60 + o], s = r[0x80 + o], w = r[0xE0 + o];
      op[o] = {
        mult: m & 0x0F, ksr: (m >> 4) & 1, egt: (m >> 5) & 1, vib: (m >> 6) & 1, am: (m >> 7) & 1,
        ksl: (k >> 6) & 3, tl: k & 0x3F,
        ar: (a >> 4) & 0x0F, dr: a & 0x0F, sl: (s >> 4) & 0x0F, rr: s & 0x0F,
        ws: (r[0x01] & 0x20) ? (w & 3) : 0
      };
    }
    function deriveChannel(c) {
      var fa = st.reg[0xA0 + c], fb = st.reg[0xB0 + c], cc = st.reg[0xC0 + c];
      var fnum = fa | ((fb & 3) << 8), block = (fb >> 2) & 7;
      ch[c].fnum = fnum; ch[c].block = block; ch[c].keyOn = (fb >> 5) & 1;
      ch[c].fb = (cc >> 1) & 7; ch[c].cnt = cc & 1;
      ch[c].hz = fnum * CHIP_RATE / Math.pow(2, 20 - block);
    }
    function deriveAll() {
      for (var o = 0; o < 32; o++) if (st.reg[0x20 + o] || st.reg[0x40 + o] || st.reg[0x60 + o] || st.reg[0x80 + o] || st.reg[0xE0 + o]) deriveOp(o);
      for (var c = 0; c < 9; c++) deriveChannel(c);
    }

    function write(reg, val) {
      reg &= 0xFF; val &= 0xFF; st.reg[reg] = val;
      if (reg === 0x01) { deriveAll(); return; }
      if (reg >= 0x20 && reg <= 0x35) return deriveOp(reg - 0x20);
      if (reg >= 0x40 && reg <= 0x55) return deriveOp(reg - 0x40);
      if (reg >= 0x60 && reg <= 0x75) return deriveOp(reg - 0x60);
      if (reg >= 0x80 && reg <= 0x95) return deriveOp(reg - 0x80);
      if (reg >= 0xE0 && reg <= 0xF5) return deriveOp(reg - 0xE0);
      if (reg >= 0xA0 && reg <= 0xA8) { var c1 = reg - 0xA0; deriveChannel(c1); return keyChange(c1); }
      if (reg >= 0xB0 && reg <= 0xB8) { var c2 = reg - 0xB0; deriveChannel(c2); return keyChange(c2); }
      if (reg >= 0xC0 && reg <= 0xC8) { deriveChannel(reg - 0xC0); }
    }
    // 按鍵：0→1 開始攻擊，1→0 進入釋放
    function keyChange(c) {
      var mo = MOD_OFF[c], co = mo + 3, want = ch[c].keyOn;
      if (want && !ch[c].prevKey) { st.stage[mo] = 1; st.stage[co] = 1; }   // 0→1：重新攻擊
      if (!want && ch[c].prevKey) { if (st.stage[mo]) st.stage[mo] = 4; if (st.stage[co]) st.stage[co] = 4; }
      ch[c].prevKey = want;
    }

    // 單一運算元：回傳 { y: 輸出（已乘包絡與音量） }
    function stepOp(o, ph, dt, keyScale) {
      var p = op[o]; if (!p) return 0;
      // 包絡推進
      var sus = Math.pow(10, -(p.sl * 3) / 20); if (p.sl === 15) sus = 0;
      var s = st.stage[o], e = st.env[o];
      if (s === 1) {                                // 攻擊
        var ta = rateTau(rateIndex(p.ar, keyScale, p.ksr)) * 0.3;
        if (p.ar === 15) { e = 1; s = 2; }
        else if (!isFinite(ta) || ta <= 0) { /* AR=0：不攻擊 */ }
        else { e += (1 - e) * (1 - Math.exp(-dt / ta)); if (e > 0.998) { e = 1; s = 2; } }
      } else if (s === 2) {                         // 衰減到持續位準
        var td = rateTau(rateIndex(p.dr, keyScale, p.ksr));
        if (!isFinite(td) || td <= 0) { /* 不衰減 */ }
        else { e = sus + (e - sus) * Math.exp(-dt / td); }
        if (e - sus < 0.002) { e = sus; s = p.egt ? 3 : 4; }
      } else if (s === 3) {                         // 持續（EGT 開，按住期間不動）
        e = sus;
      } else if (s === 4) {                         // 釋放
        var tr = rateTau(rateIndex(p.rr, keyScale, p.ksr));
        if (isFinite(tr) && tr > 0) e *= Math.exp(-dt / tr); else e = 0;
        if (e < 0.0005) { e = 0; s = 0; }
      }
      st.stage[o] = s; st.env[o] = e;
      if (s === 0) return 0;
      // 音量：TL 每級 0.75 dB；KSL 依八度
      var kdb = p.ksl ? KSL_DB[p.ksl] * Math.max(0, (keyScale >> 1) - 2) : 0;
      var att = Math.pow(10, -(p.tl * 0.75 + kdb) / 20);
      if (p.am) att *= Math.pow(10, -(4.8 * (0.5 + 0.5 * Math.sin(TWO_PI * 3.7 * st.t))) / 20);
      return wave(ph, p.ws) * e * att;
    }

    // 產生 count 個取樣到 out（從 out[start] 開始）
    function render(out, start, count) {
      start = start || 0;
      var dt = 1 / sr;
      var anyOn = false, c, o;
      for (c = 0; c < 9; c++) if (ch[c].keyOn || st.stage[MOD_OFF[c] + 3]) { anyOn = true; break; }
      for (var i = 0; i < count; i++) {
        var mix = 0;
        var vib = Math.sin(TWO_PI * 6.1 * st.t);   // 顫音 LFO（約 6 Hz）
        for (c = 0; c < 9; c++) {
          var mo = MOD_OFF[c], co = mo + 3, C = ch[c];
          if (st.stage[mo] === 0 && st.stage[co] === 0) continue;
          var keyScale = (C.block << 1) | ((C.fnum >> 9) & 1);
          var pm = op[mo] ? op[mo].vib : 0, pc = op[co] ? op[co].vib : 0;
          var vf = (pm || pc) ? Math.pow(2, (7 / 1200) * vib) : 1;
          var hz = C.hz * vf;
          // 調變器（含回授）
          var mp = op[mo] ? MULT[op[mo].mult] : 1, cp = op[co] ? MULT[op[co].mult] : 1;
          var fbk = C.fb ? Math.PI / Math.pow(2, 8 - C.fb) : 0;
          var h = st.fbHist, y1 = h[c * 2], y2 = h[c * 2 + 1];
          st.phase[mo] = (st.phase[mo] + hz * (mp === 0.5 ? 0.5 : mp) * dt) % 1;
          var modPh = st.phase[mo] + (fbk * (y1 + y2) / 2) / TWO_PI;
          var my = stepOp(mo, modPh - Math.floor(modPh), dt, keyScale);
          h[c * 2 + 1] = y1; h[c * 2] = my;
          st.phase[co] = (st.phase[co] + hz * cp * dt) % 1;
          var carPh = st.phase[co];
          if (C.cnt === 0) {                         // FM：調變器調相到載波
            var cy = stepOp(co, (carPh + my * 0.5) - Math.floor(carPh + my * 0.5), dt, keyScale);
            mix += cy;
          } else {                                   // 加法
            mix += my + stepOp(co, carPh, dt, keyScale);
          }
        }
        out[start + i] = mix * 0.25;
        st.t += dt;
      }
      return anyOn;
    }

    function snapshot() {
      return { reg: st.reg.slice(), phase: st.phase.slice(), env: st.env.slice(), stage: st.stage.slice(), fbHist: st.fbHist.slice(), t: st.t };
    }
    function restore(s) {
      st.reg.set(s.reg); st.phase.set(s.phase); st.env.set(s.env); st.stage.set(s.stage); st.fbHist.set(s.fbHist); st.t = s.t;
      deriveAll();
    }
    function reset() { st = newState(); deriveAll(); }
    return { write: write, render: render, snapshot: snapshot, restore: restore, reset: reset, sampleRate: sr };
  }

  return { create: create, CHIP_RATE: CHIP_RATE, MOD_OFF: MOD_OFF };
}));
