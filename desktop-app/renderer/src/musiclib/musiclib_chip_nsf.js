/* NSF 晶片後端：用 jsnes 的 6502 CPU 與 APU 執行 NSF 的 INIT／PLAY，輸出單聲道 PCM。純邏輯（UMD，不碰 DOM、不用網路）。
 *   createBackend(NES) → 後端物件（kind = 'nsf'），交給 FaChipPlayer.registerBackend 註冊。NES 由呼叫端注入（jsnes 的 NES 類別）。
 *   後端介面：canLoad(bytes, name)、parse(bytes) → { title, artist, copyright, nsf, tracks:[{ title, durationSec }] }、
 *            openStream(loaded, trackIndex, sampleRate) → { read(out, off, n)、snapshot()、restore(s) }。
 *   沒有 toMidi：NSF 檔本身沒有音符資料；NES 擷取來源的 MIDI 由曲庫面板另外提供。
 *
 * 做法：
 *   1. 手組一個最小的 iNES 殼（NROM、一個 16KB 銀行，重設後停在 JMP 迴圈），讓 jsnes 的 CPU、PPU、APU 正常運作。
 *   2. NSF 的資料直接寫進 CPU 記憶體（依標頭的載入位址；有銀行初值時照 4KB 頁填 $8000–$FFFF）。
 *   3. 呼叫跳板放在 $6000–$7FFF 的空位（NSF 資料沒佔用的一段）：INIT 跳板是「LDA 曲號、LDX 地區、JSR INIT、JMP 自己」；
 *      PLAY 跳板每畫面寫入「JSR PLAY × n、JMP 自己」，n 依標頭的速度累積算出（每畫面最多 MAX_CALLS 次）。
 *   4. 銀行切換：攔截 CPU 寫入 $5FF8–$5FFF（只有有銀行的 NSF 才攔），把對應的 4KB 頁寫進 $8000+ 的視窗。
 *   5. 時基：NTSC 畫面（60.0988 Hz）；每畫面 jsnes 產生的樣本就是 APU 的輸出。
 *   6. seek：快照是 jsnes 的 toJSON（以 JSON 字串保存，避免 fromJSON 與活的陣列共用記憶體），由播放核心決定檢查點。
 *   7. 曲長：沒有宣告，用「聲音停止後安靜夠久」判斷（安靜門檻 = max(3 秒, 活動畫面數的一半)），循環曲子沒有靜音，只能到 SCAN_MAX_SEC 上限。
 * 已知近似（寫進報告）：APU 與 CPU 為 NTSC 時脈；PAL 標記的檔音高約偏 7%（速度用 PAL 欄位，時基仍是 NTSC 畫面）；
 *   速度快於一畫面時每畫面最多 MAX_CALLS 次 PLAY，更快的檔會慢。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./musiclib_extract_nes.js'));
  else root.FaChipNsf = factory(root.FaMusicLibNes || (typeof FaMusicLibNes !== 'undefined' ? FaMusicLibNes : undefined));
}(typeof self !== 'undefined' ? self : this, function (NESX) {
  'use strict';
  var FRAME_NTSC = 60.0988, FRAME_SEC = 1 / FRAME_NTSC, FRAME_US = 1000000 / FRAME_NTSC;
  var DEFAULT_RATE = 44100, PAGE = 4096;
  var MAX_CALLS = 8;               // 一畫面最多呼叫幾次 PLAY（速度比畫面快時）
  var INIT_MAX_SEC = 10;           // INIT 最多跑這麼久的遊戲時間，超過就回報沒有返回
  var SCAN_MAX_SEC = 600;          // 曲長掃描上限（循環的曲子沒有靜音，只能到這裡）
  var SILENT_GIVEUP_SEC = 60;      // 從頭到尾都沒聲音超過這麼久，就當作沒有聲音
  var QUIET_MIN_SEC = 3;           // 聲音停止後至少安靜這麼久才算結束
  var PEAK_EPS = 1e-3;             // 振幅低於這個值視為靜音（約 −60 dBFS）
  var TRAMP_BYTES = 3 * MAX_CALLS + 3 + 16;   // 跳板要佔的 RAM：PLAY 呼叫段 + JMP，加上 INIT 跳板

  // 手組的 iNES 殼：NROM，一個 16KB PRG（$C000 是 JMP $C000），重設與中斷向量都指向 $C000，CHR 8KB。
  function buildRomBytes() {
    var prg = new Uint8Array(0x4000); prg.fill(0xEA);
    prg[0] = 0x4C; prg[1] = 0x00; prg[2] = 0xC0;
    prg[0x3FFA] = 0x00; prg[0x3FFB] = 0xC0;   // NMI
    prg[0x3FFC] = 0x00; prg[0x3FFD] = 0xC0;   // RESET
    prg[0x3FFE] = 0x00; prg[0x3FFF] = 0xC0;   // IRQ
    var out = new Uint8Array(16 + prg.length + 0x2000);
    out.set([0x4E, 0x45, 0x53, 0x1A, 1, 1, 0, 0], 0);
    out.set(prg, 16);
    return out;
  }
  function toBinaryString(b) {
    var s = '';
    for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(b.length, i + 0x8000)));
    return s;
  }

  // 第 p 個 4KB 頁（依載入位址的低 12 位元偏移；偏移 0 時就是 NSF 資料的第 p×4096 位元組起）
  function pageBytes(nsf, p) {
    var off = nsf.load & 0xFFF, out = new Uint8Array(PAGE), base = p * PAGE - off, data = nsf.data;
    for (var k = 0; k < PAGE; k++) { var i = base + k; if (i >= 0 && i < data.length) out[k] = data[i]; }
    return out;
  }
  // 把 NSF 資料寫進記憶體：有銀行初值就照 8 個視窗（$8000–$FFFF）分頁；沒有就從載入位址連續放
  function layoutData(nsf, mem) {
    if (nsf.banked) {
      for (var s = 0; s < 8; s++) mem.set(pageBytes(nsf, nsf.banks[s]), 0x8000 + s * PAGE);
    } else {
      var len = Math.min(nsf.data.length, 0x10000 - nsf.load);
      if (len > 0) mem.set(nsf.data.subarray(0, len), nsf.load);
    }
  }
  // 跳板位置：$7FFF 往下找一段 TRAMP_BYTES 的空位（不與不銀行的 NSF 資料重疊）；找不到回傳 -1
  function pickTramp(nsf) {
    var lo = nsf.banked ? 0x10000 : nsf.load, hi = nsf.banked ? 0x10000 : nsf.load + nsf.data.length;
    for (var t = 0x7FFF - TRAMP_BYTES + 1; t >= 0x6000; t -= 0x10) {
      if (!(t < hi && t + TRAMP_BYTES > lo)) return t;
    }
    return -1;
  }

  // 一台執行中的 NSF：jsnes 實例 + 播放狀態。INIT 在建立時就跑完，時間 0 = INIT 返回的那一刻。
  function makeMachine(NES, nsf, song, sr) {
    var m = {
      nsf: nsf, song: song, sr: sr, nes: null, banks: [], T: 0, waitAddr: 0, acc: 0, overruns: 0, crashed: null,
      periodUs: nsf.pal ? (nsf.palSpeed || 19997) : (nsf.ntscSpeed || 16639),
      sink: new Float32Array(4096), sinkN: 0,
      q: new Float32Array(1 << 15), qLen: 0, qPos: 0, frames: 0
    };
    m.nes = new NES({
      onFrame: function () {}, emulateSound: true, sampleRate: sr,
      onAudioSample: function (l, r) { if (m.sinkN < m.sink.length) m.sink[m.sinkN++] = (l + r) * 0.5; }
    });
    m.nes.loadROM(toBinaryString(buildRomBytes()));
    m.nes.frame();                       // 暖機一畫面：重設序列跑完，CPU 停在殼的 JMP 迴圈
    m.sinkN = 0;
    var cpu = m.nes.cpu;
    layoutData(nsf, cpu.mem);
    m.banks = nsf.banked ? nsf.banks.slice() : [];
    hookWrites(m);
    m.T = pickTramp(nsf);
    if (m.T < 0) throw new Error('NSF 佔滿 $6000–$7FFF，找不到放呼叫跳板的空間');
    // INIT 跳板：LDA 曲號−1、LDX 地區（0 NTSC、1 PAL）、JSR INIT、JMP 自己
    var T = m.T, W = T + 7, init = nsf.init;
    var stub = [0xA9, (song - 1) & 0xFF, 0xA2, nsf.pal ? 1 : 0, 0x20, init & 0xFF, init >> 8, 0x4C, W & 0xFF, W >> 8];
    for (var i = 0; i < stub.length; i++) cpu.mem[T + i] = stub[i];
    cpu.REG_PC = T; cpu.REG_SP = 0xFD; m.waitAddr = W;
    var f = 0, maxF = Math.ceil(INIT_MAX_SEC / FRAME_SEC);
    while (cpu.REG_PC !== m.waitAddr) {
      if (f++ >= maxF) throw new Error('INIT（$' + init.toString(16) + '）在 ' + INIT_MAX_SEC + ' 秒遊戲時間內沒有返回');
      stepFrame(m, false);
      if (m.crashed) throw new Error('INIT 執行時當掉：' + m.crashed);
    }
    m.sinkN = 0; m.qLen = 0; m.qPos = 0; m.acc = 0; m.frames = 0;
    return m;
  }

  // 攔截銀行切換寫入（只有有銀行的 NSF）。重設後 CPU 會換新，所以每次還原都要重新掛。
  function hookWrites(m) {
    if (!m.nsf.banked) return;
    var cpu = m.nes.cpu, orig = cpu.write;
    cpu.write = function (addr, value) {
      if (addr >= 0x5FF8 && addr <= 0x5FFF) {
        var s = addr - 0x5FF8, v = value & 0xFF;
        m.banks[s] = v;
        m.nes.cpu.mem.set(pageBytes(m.nsf, v), 0x8000 + s * PAGE);
        return;
      }
      return orig.call(this, addr, value);
    };
  }

  function appendQ(m, src, n) {
    if (m.qLen + n > m.q.length) {
      var cap = m.q.length; while (cap < m.qLen + n) cap *= 2;
      var nq = new Float32Array(cap); nq.set(m.q.subarray(0, m.qLen)); m.q = nq;
    }
    if (src) m.q.set(src.subarray(0, n), m.qLen);
    else m.q.fill(0, m.qLen, m.qLen + n);
    m.qLen += n;
  }

  // 寫入這一畫面的 PLAY 跳板：n 次 JSR PLAY，然後 JMP 自己（等待）。回傳等待位址。
  function layoutPlay(m, n) {
    var mem = m.nes.cpu.mem, T = m.T, play = m.nsf.play;
    for (var i = 0; i < n; i++) { mem[T + 3 * i] = 0x20; mem[T + 3 * i + 1] = play & 0xFF; mem[T + 3 * i + 2] = play >> 8; }
    var W = T + 3 * n;
    mem[W] = 0x4C; mem[W + 1] = W & 0xFF; mem[W + 2] = W >> 8;
    return W;
  }

  // 跑一畫面。play=true 時先依時間累積決定這畫面要呼叫幾次 PLAY（上一次 PLAY 還沒返回就不排新的，只累積時間）
  function stepFrame(m, play) {
    var cpu = m.nes.cpu;
    m.sinkN = 0;
    var before = m.qLen;
    if (!m.crashed) {
      m.acc = Math.min(m.acc + FRAME_US, 2 * MAX_CALLS * m.periodUs);
      if (play) {
        if (cpu.REG_PC === m.waitAddr) {
          var n = Math.min(MAX_CALLS, Math.floor(m.acc / m.periodUs));
          m.acc -= n * m.periodUs;
          m.waitAddr = layoutPlay(m, n);
          cpu.REG_PC = m.T;
        } else m.overruns++;
      }
      try { m.nes.frame(); }
      catch (e) { m.crashed = String((e && e.message) || e); }
    }
    if (m.crashed) appendQ(m, null, Math.round(m.sr * FRAME_SEC));
    else appendQ(m, m.sink, m.sinkN);
    m.frames++;
    return { start: before, end: m.qLen };
  }

  function streamApi(m) {
    return {
      read: function (out, off, n) {
        while (m.qLen - m.qPos < n) stepFrame(m, true);
        out.set(m.q.subarray(m.qPos, m.qPos + n), off);
        m.qPos += n;
        if (m.qPos > (1 << 16)) { m.q.copyWithin(0, m.qPos, m.qLen); m.qLen -= m.qPos; m.qPos = 0; }
        return n;
      },
      snapshot: function () {
        return {
          nes: JSON.stringify(m.nes.toJSON()), banks: m.banks.slice(), acc: m.acc, overruns: m.overruns, crashed: m.crashed,
          waitAddr: m.waitAddr, T: m.T, frames: m.frames, q: m.q.slice(m.qPos, m.qLen)
        };
      },
      restore: function (s) {
        m.nes.fromJSON(JSON.parse(s.nes));
        hookWrites(m);
        m.banks = s.banks.slice(); m.acc = s.acc; m.overruns = s.overruns; m.crashed = s.crashed;
        m.waitAddr = s.waitAddr; m.T = s.T; m.frames = s.frames;
        m.q = new Float32Array(Math.max(1 << 15, s.q.length * 2)); m.q.set(s.q); m.qLen = s.q.length; m.qPos = 0;
      },
      // 只給測試用：讀 CPU 記憶體
      peekMem: function (addr) { return m.nes.cpu.mem[addr]; },
      frames: function () { return m.frames; },
      overruns: function () { return m.overruns; }
    };
  }

  // 曲長掃描：從 INIT 之後逐畫面跑，聲音停止後安靜夠久就結束（門檻隨活動長度調整）。回傳 { sec, reason, frames, activeFrames }
  function scanSeconds(NES, nsf, song) {
    var m = makeMachine(NES, nsf, song, DEFAULT_RATE);
    var frameIdx = 0, active = 0, lastActive = 0, sawSound = false, reason = '';
    var maxF = Math.round(SCAN_MAX_SEC / FRAME_SEC), giveUp = Math.round(SILENT_GIVEUP_SEC / FRAME_SEC), quietMin = Math.round(QUIET_MIN_SEC / FRAME_SEC);
    for (;;) {
      var r = stepFrame(m, true), peak = 0;
      for (var i = r.start; i < r.end; i++) { var a = Math.abs(m.q[i]); if (a > peak) peak = a; }
      m.qLen = 0; m.qPos = 0;                   // 掃描不保留樣本
      frameIdx++;
      if (peak > PEAK_EPS) { sawSound = true; active++; lastActive = frameIdx; }
      if (!sawSound && frameIdx >= giveUp) { reason = '從頭到尾沒有聲音'; break; }
      if (sawSound && frameIdx - lastActive >= Math.max(quietMin, active / 2)) { reason = '聲音停止後安靜夠久'; break; }
      if (frameIdx >= maxF) { reason = '到達上限 ' + SCAN_MAX_SEC + ' 秒（循環曲子沒有靜音）'; break; }
    }
    return { sec: sawSound ? lastActive * FRAME_SEC : 0, reason: reason, frames: frameIdx, activeFrames: active, crashed: m.crashed };
  }

  function createBackend(NES) {
    if (typeof NES !== 'function') throw new Error('createBackend 需要 jsnes 的 NES 類別');
    if (!NESX || typeof NESX.parseNsf !== 'function') throw new Error('缺少 NES 擷取模組（FaMusicLibNes），無法解析 NSF 標頭');
    return {
      kind: 'nsf', label: 'NSF（NES APU，jsnes 6502 執行）',
      canLoad: function (bytes) { var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []); return b.length >= 5 && b[0] === 0x4E && b[1] === 0x45 && b[2] === 0x53 && b[3] === 0x4D && b[4] === 0x1A; },
      parse: function (bytes) {
        var N = NESX.parseNsf(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        if (!N.ok) throw new Error(N.reason);
        if (!(N.songs >= 1)) throw new Error('NSF 曲目數為 0');
        var nsf = {
          load: N.load, init: N.init, play: N.play, songs: N.songs, data: N.data, pal: N.pal, palSpeed: N.palSpeed, ntscSpeed: N.ntscSpeed,
          banks: N.banks, banked: N.banks.some(function (x) { return x !== 0; })
        };
        var tracks = [];
        for (var i = 1; i <= N.songs; i++) tracks.push(lazyTrack(NES, nsf, i, i - 1));
        return { title: N.name || 'NSF', artist: N.artist || '', copyright: N.copyright || '', nsf: nsf, tracks: tracks };
      },
      openStream: function (loaded, trackIndex, sr) {
        var tr = loaded.tracks[trackIndex];
        if (!tr) throw new Error('沒有第 ' + (trackIndex + 1) + ' 首 NSF 曲目');
        return streamApi(makeMachine(NES, loaded.nsf, trackIndex + 1, sr || DEFAULT_RATE));
      }
    };
  }

  // 曲長延遲計算：第一次讀 durationSec 才掃描（掃描結果快取在 track 上）
  function lazyTrack(NES, nsf, song, index) {
    var cache = null, tr = { index: index, title: '曲目 ' + song };
    Object.defineProperty(tr, 'durationSec', {
      enumerable: true,
      get: function () {
        if (!cache) cache = scanSeconds(NES, nsf, song);
        return cache.sec;
      }
    });
    Object.defineProperty(tr, 'durationNote', {
      enumerable: false,
      get: function () { if (!cache) cache = scanSeconds(NES, nsf, song); return cache.reason + '（掃描 ' + cache.frames + ' 畫面，有聲音 ' + cache.activeFrames + ' 畫面' + (cache.crashed ? '；遊戲當掉：' + cache.crashed : '') + '）'; }
    });
    return tr;
  }

  return {
    createBackend: createBackend,
    // 給測試與除錯用
    _internals: { buildRomBytes: buildRomBytes, pageBytes: pageBytes, pickTramp: pickTramp, makeMachine: makeMachine, stepFrame: stepFrame, scanSeconds: scanSeconds, FRAME_SEC: FRAME_SEC, MAX_CALLS: MAX_CALLS }
  };
}));
