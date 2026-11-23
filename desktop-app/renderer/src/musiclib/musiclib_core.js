/* 本地音樂庫的核心（純函式，UMD）：辨識檔案種類（副檔名＋檔頭）、從路徑推專輯、解析中繼資料（能解析多少算多少，解析不了留空、不丟例外）、
 * 增量掃描（路徑＋大小＋修改時間都不變就跳過、不重讀位元組）、多關鍵字搜尋（路徑／檔名／專輯／標題／演出者；中文、日文、英文都用子字串比對）。
 * 不碰 DOM、不碰檔案系統：檔案從哪裡來（桌面版磁碟、瀏覽器 File）由 host 決定，這裡只收「狀態＋讀檔頭的函式」。
 * 儲存：由 backend 提供 load／save（IndexedDB、磁碟 JSON、記憶體都行），這裡不寫死筆數上限。
 * 第一階段只做「庫與掃描」：遊戲音樂來源（nes、pce、sfc、rix、swf）只登記辨識成「待擷取」，不做擷取。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var VERSION = 1;
  var HEAD_BYTES = 2 * 1024 * 1024; // 讀檔頭的上限（ID3、WAV 檔頭、MIDI 整檔都在這之內；mp4 的 moov 若在檔尾就解析不到，留空）

  // 種類表：副檔名 → 種類。category：audio（音訊）、video（影片）、game（遊戲音樂來源，待擷取）
  var KINDS = {
    mid: { category: 'audio', label: 'MIDI 樂譜' },
    wav: { category: 'audio', label: 'WAV 音訊' },
    mp3: { category: 'audio', label: 'MP3 音訊' },
    mp4: { category: 'video', label: 'MP4 影片' },
    mov: { category: 'video', label: 'MOV 影片' },
    webm: { category: 'video', label: 'WebM 影片' },
    nes: { category: 'extract', label: 'NES 遊戲音樂，可擷取' },
    pce: { category: 'extract', label: 'PC Engine 遊戲音樂，可擷取' },
    sfc: { category: 'extract', label: 'SNES 遊戲音樂，可擷取' },
    rix: { category: 'extract', label: 'RIX（OPL2）音樂，可擷取' },
    swf: { category: 'extract', label: 'Flash（SWF）音樂，可擷取' },
    // 獨立可播放的音樂檔（不需擷取）：晶片播放器的 spc 後端直接播放
    spc: { category: 'chip', label: 'SNES 音效檔（.spc），可晶片播放' },
    // 只由擷取產生的子曲目用（不從掃描辨識）
    nsf: { category: 'game', label: 'NSF 音樂（擷取產生，需 NSF 播放器）' }
  };
  var DERIVED_ONLY = { nsf: 1 };
  var EXT_ALIAS = { midi: 'mid', smc: 'sfc' };

  // ───── 文字小工具 ─────
  function normalizeText(s) { return String(s == null ? '' : s).normalize('NFKC').toLowerCase().trim(); }
  function basename(p) { return String(p || '').split(/[\\\/]/).pop(); }
  function extOf(name) { var m = /\.([^.\\\/]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  function stripExt(name) { return String(name || '').replace(/\.[^.\\\/]+$/, ''); }
  function kindFromExt(name) { var e = extOf(name); e = EXT_ALIAS[e] || e; return KINDS[e] && !DERIVED_ONLY[e] ? e : null; }

  // 只看副檔名就能認的檔案（掃描時用來決定要不要先讀檔頭）
  function isSupportedName(name) { return !!kindFromExt(name); }

  // ───── 種類辨識：先看檔頭（最準），認不出來再看副檔名；檔頭與副檔名不同時以檔頭為準 ─────
  function ascii(a, o, n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(a[o + i] == null ? 0 : a[o + i]); return s; }
  function sniffKind(a) {
    if (!a || a.length < 4) return null;
    if (a[0] === 0x4D && a[1] === 0x54 && a[2] === 0x68 && a[3] === 0x64) return 'mid'; // MThd
    if (ascii(a, 0, 4) === 'RIFF' && a.length >= 12 && ascii(a, 8, 4) === 'WAVE') return 'wav';
    if (ascii(a, 0, 3) === 'ID3') return 'mp3';
    if (a[0] === 0xFF && (a[1] & 0xE0) === 0xE0 && ((a[1] >> 1) & 3) === 1) return 'mp3'; // MPEG 音框同步，第 III 層
    if (a.length >= 12 && ascii(a, 4, 4) === 'ftyp') return ascii(a, 8, 4) === 'qt  ' ? 'mov' : 'mp4';
    if (a[0] === 0x1A && a[1] === 0x45 && a[2] === 0xDF && a[3] === 0xA3) return 'webm';
    if (ascii(a, 0, 4) === 'NES\u001a') return 'nes';
    var f = ascii(a, 0, 3);
    if (f === 'FWS' || f === 'CWS' || f === 'ZWS') return 'swf';
    return null;
  }
  // 回傳 { kind, category, label, pending, via }；認不出來回傳 null
  function identifyKind(name, bytes) {
    var byExt = kindFromExt(name), byMagic = sniffKind(bytes), kind = byMagic || byExt;
    if (!kind) return null;
    var k = KINDS[kind];
    return { kind: kind, category: k.category, label: k.label, pending: k.category === 'game', via: byMagic ? 'magic' : 'ext' };
  }

  // 遊戲音樂來源（待擷取，或可擷取但還沒擷取）不是可以直接讀歌詞、哼歌的音訊：歌詞佇列與計數都不算
  function isSourceOnly(r) { return !!r.pending || r.category === 'extract' || r.category === 'game'; }

  // ───── 專輯：沒有專輯標籤時，用上一層資料夾名（路徑最後一段之前那一段；碟符不算）─────
  function albumFromPath(p) {
    var parts = String(p || '').split(/[\\\/]+/).filter(Boolean);
    if (parts.length < 2) return '';
    var parent = parts[parts.length - 2];
    if (/^[A-Za-z]:$/.test(parent)) return '';
    return parent;
  }

  // ───── 位元組讀取（大端／小端）與文字解碼 ─────
  function u16be(a, o) { return (a[o] << 8) | a[o + 1]; }
  function u32be(a, o) { return ((a[o] << 24) >>> 0) + (a[o + 1] << 16) + (a[o + 2] << 8) + a[o + 3]; }
  function u32le(a, o) { return (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16)) + a[o + 3] * 16777216; }
  function syncsafe(a, o) { return (a[o] << 21) | (a[o + 1] << 14) | (a[o + 2] << 7) | a[o + 3]; }
  function utf8(body) { try { return new TextDecoder('utf-8', { fatal: true }).decode(body); } catch (e) { return null; } }
  function latin1(body) { var s = ''; for (var i = 0; i < body.length; i++) s += String.fromCharCode(body[i]); return s; }
  function utf16(body, le) { var s = ''; for (var i = 0; i + 1 < body.length; i += 2) s += String.fromCharCode(le ? (body[i] | (body[i + 1] << 8)) : ((body[i] << 8) | body[i + 1])); return s; }
  // ID3 的文字：第一個位元組是編碼（0 Latin-1 或 GBK、1 UTF-16 有 BOM、2 UTF-16BE、3 UTF-8）
  function decodeId3Text(a, o, n) {
    if (n <= 1) return null;
    var enc = a[o], body = a.subarray(o + 1, o + n), s;
    if (enc === 1) {
      var le = true, st = 0;
      if (body[0] === 0xFE && body[1] === 0xFF) { le = false; st = 2; } else if (body[0] === 0xFF && body[1] === 0xFE) { st = 2; }
      s = utf16(body.subarray(st), le);
    } else if (enc === 2) s = utf16(body, false);
    else if (enc === 3) s = utf8(body) || latin1(body);
    else s = utf8(body) || decodeGbk(body);
    s = s.split('\u0000')[0].replace(/^﻿/, '').trim();
    return s || null;
  }
  function decodeGbk(body) { try { return new TextDecoder('gbk').decode(body); } catch (e) { return latin1(body); } }
  function decodeUtf8Loose(body) { return utf8(body) || decodeGbk(body); }

  // ───── MP3：ID3v2（TIT2／TPE1／TALB／TLEN）、ID3v1（尾端 128 位元組）、音框（Xing／Info 精確，否則用位元率估長度）─────
  var MP3_BR_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  var MP3_BR_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  var MP3_SR = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]]; // MPEG1、MPEG2、MPEG2.5
  function parseId3(a) {
    var out = {};
    if (a.length < 10 || ascii(a, 0, 3) !== 'ID3') return out;
    var major = a[3], flags = a[5], size = syncsafe(a, 6), pos = 10, end = Math.min(a.length, 10 + size);
    if (flags & 0x40) { var ext = major === 4 ? syncsafe(a, 10) : u32be(a, 10); pos += major === 4 ? ext : 4 + ext; }
    var idLen = major === 2 ? 3 : 4, hdrLen = major === 2 ? 6 : 10;
    while (pos + hdrLen <= end) {
      var id = ascii(a, pos, idLen);
      if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // 補零區，結束
      var fsize = major === 2 ? ((a[pos + 3] << 16) | (a[pos + 4] << 8) | a[pos + 5]) : (major === 4 ? syncsafe(a, pos + 4) : u32be(a, pos + 4));
      var body = pos + hdrLen;
      if (fsize <= 0 || body + fsize > end) break;
      var txt = id.charAt(0) === 'T' ? decodeId3Text(a, body, fsize) : null;
      if (txt) {
        if (id === 'TIT2' || id === 'TT2') out.title = txt;
        else if (id === 'TPE1' || id === 'TP1') out.artist = txt;
        else if (id === 'TALB' || id === 'TAL') out.album = txt;
        else if (id === 'TLEN') { var ms = Number(txt); if (ms > 0) out.lengthMs = ms; }
      }
      pos = body + fsize;
    }
    out.audioStart = major === 0 ? 0 : (10 + size + ((flags & 0x10) && major === 4 ? 10 : 0));
    return out;
  }
  function parseId3v1(a, out) {
    if (a.length < 128 || ascii(a, a.length - 128, 3) !== 'TAG') return;
    var t = a.length - 128;
    var clean = function (o, n) { var s = latin1(a.subarray(o, o + n)).split('\u0000')[0].trim(); return s || null; };
    if (!out.title) out.title = clean(t + 3, 30);
    if (!out.artist) out.artist = clean(t + 33, 30);
    if (!out.album) out.album = clean(t + 63, 30);
  }
  function mp3Duration(a, start, size, m) {
    var lim = Math.min(a.length - 4, start + 8192);
    for (var p = start; p <= lim; p++) {
      if (!(a[p] === 0xFF && (a[p + 1] & 0xE0) === 0xE0 && ((a[p + 1] >> 1) & 3) === 1)) continue;
      var verBits = (a[p + 1] >> 3) & 3, b2 = a[p + 2], b3 = a[p + 3];
      if (verBits === 1) continue; // 保留位
      var br = (b2 >> 4) & 15, sri = (b2 >> 2) & 3;
      if (br === 0 || br === 15 || sri === 3) continue; // 自由位元率或非法值，換下一個
      var isV1 = verBits === 3, bitrate = (isV1 ? MP3_BR_V1L3 : MP3_BR_V2L3)[br] * 1000;
      var sr = MP3_SR[isV1 ? 0 : (verBits === 2 ? 1 : 2)][sri], spf = isV1 ? 1152 : 576;
      var mono = ((b3 >> 6) & 3) === 3, side = isV1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
      var xo = p + 4 + side;
      m.format = { bitrateKbps: bitrate / 1000, sampleRate: sr };
      if (xo + 8 <= a.length) {
        var tag = ascii(a, xo, 4);
        if ((tag === 'Xing' || tag === 'Info') && (u32be(a, xo + 4) & 1)) {
          m.durationSec = u32be(a, xo + 8) * spf / sr; m.durationApprox = false; return;
        }
      }
      var audioBytes = (size || a.length) - p;
      m.durationSec = audioBytes * 8 / bitrate; m.durationApprox = true; // 位元率估計（CBR 準；VBR 有誤差）
      return;
    }
  }
  function parseMp3(a, size, m) {
    var tags = parseId3(a);
    ['title', 'artist', 'album'].forEach(function (k) { if (tags[k]) m[k] = tags[k]; });
    if (tags.lengthMs) { m.durationSec = tags.lengthMs / 1000; m.durationApprox = false; }
    parseId3v1(a, m);
    if (m.durationSec == null) mp3Duration(a, tags.audioStart || 0, size, m);
  }

  // ───── WAV：fmt 區塊（聲道、取樣率、位元深度）、data 區塊大小 ÷ 每秒位元組數 = 長度；LIST/INFO 的標題、演出者、專輯 ─────
  function parseWav(a, size, m) {
    var pos = 12, byteRate = null, dataSize = null, info = {};
    while (pos + 8 <= a.length) {
      var id = ascii(a, pos, 4), sz = u32le(a, pos + 4), body = pos + 8;
      if (id === 'fmt ') {
        m.format = { channels: a[body + 2] | (a[body + 3] << 8), sampleRate: u32le(a, body + 4), bitsPerSample: a[body + 14] | (a[body + 15] << 8) };
        byteRate = u32le(a, body + 8);
      } else if (id === 'data') {
        dataSize = sz === 0xFFFFFFFF && size ? size - body : sz;
      } else if (id === 'LIST' && ascii(a, body, 4) === 'INFO') {
        var q = body + 4, qEnd = Math.min(a.length, body + sz);
        while (q + 8 <= qEnd) {
          var sid = ascii(a, q, 4), ssz = u32le(a, q + 4), sb = q + 8;
          var val = decodeUtf8Loose(a.subarray(sb, Math.min(a.length, sb + ssz))).split('\u0000')[0].trim();
          if (sid === 'INAM') info.title = val; else if (sid === 'IART') info.artist = val; else if (sid === 'IPRD') info.album = val;
          q = sb + ssz + (ssz & 1);
        }
      }
      if (sz > a.length) break; // 區塊超出已讀範圍：到此為止（data 區塊的大小已拿到）
      pos = body + sz + (sz & 1);
    }
    ['title', 'artist', 'album'].forEach(function (k) { if (info[k]) m[k] = info[k]; });
    if (byteRate && dataSize != null) m.durationSec = dataSize / byteRate;
  }

  // ───── MIDI：標頭（格式、軌數、每拍 tick 數）；各軌 tick 數與速度變化（tempo）→ 長度（秒）─────
  function readVlq(a, p) {
    var v = 0;
    for (var i = 0; i < 4; i++) {
      if (p >= a.length) return null;
      var b = a[p++];
      v = v * 128 + (b & 0x7F);
      if (!(b & 0x80)) return { v: v, next: p };
    }
    return null;
  }
  function parseMidTrack(a, p, end) {
    var tick = 0, status = 0, res = { ticks: 0, tempos: [], name: null };
    while (p < end) {
      var d = readVlq(a, p); if (!d) break;
      tick += d.v; p = d.next;
      if (p >= end) break;
      if (a[p] & 0x80) { status = a[p]; p++; }
      if (!status) break;
      if (status === 0xFF) {
        var type = a[p++], l = readVlq(a, p); if (!l) break;
        p = l.next;
        if (type === 0x51 && l.v === 3) res.tempos.push({ tick: tick, us: (a[p] << 16) | (a[p + 1] << 8) | a[p + 2] });
        else if (type === 0x03 && res.name == null) res.name = decodeUtf8Loose(a.subarray(p, p + l.v)).split('\u0000')[0].trim() || null;
        p += l.v;
        status = 0; // 中繼事件不設定執行狀態
        if (type === 0x2F) break; // 軌道結束
      } else if (status === 0xF0 || status === 0xF7) {
        var l2 = readVlq(a, p); if (!l2) break;
        p = l2.next + l2.v; status = 0;
      } else {
        var hi = status & 0xF0;
        p += (hi === 0xC0 || hi === 0xD0) ? 1 : 2;
      }
    }
    res.ticks = tick;
    return res;
  }
  function parseMid(a, m) {
    if (a.length < 14 || ascii(a, 0, 4) !== 'MThd') return;
    var hlen = u32be(a, 4), div = u16be(a, 12);
    m.format = { midiFormat: u16be(a, 8) };
    m.tracks = u16be(a, 10);
    if (div & 0x8000) return; // SMPTE 時間碼：長度無法從 tick 算，留空
    var pos = 8 + hlen, tracks = [];
    while (pos + 8 <= a.length) {
      var id = ascii(a, pos, 4), len = u32be(a, pos + 4), body = pos + 8;
      if (id === 'MTrk') tracks.push(parseMidTrack(a, body, Math.min(a.length, body + len)));
      pos = body + len;
    }
    if (!tracks.length) return;
    var maxTick = 0, tempos = [];
    tracks.forEach(function (t) { if (t.ticks > maxTick) maxTick = t.ticks; tempos = tempos.concat(t.tempos); });
    if (tracks[0].name) m.trackName = tracks[0].name;
    tempos.sort(function (x, y) { return x.tick - y.tick; });
    var sec = 0, cur = 0, us = 500000; // 預設每拍 120 BPM
    tempos.forEach(function (t) { sec += (t.tick - cur) * us / div / 1e6; cur = t.tick; us = t.us; });
    sec += (maxTick - cur) * us / div / 1e6;
    m.durationSec = sec;
    m.durationApprox = false;
  }

  // ───── MP4／MOV：moov → mvhd（時間尺度、總長）。moov 在檔尾而沒讀到時留空 ─────
  function findBox(a, start, end, type) {
    var p = start;
    while (p + 8 <= end) {
      var sz = u32be(a, p), t = ascii(a, p + 4, 4), hdr = 8;
      if (sz === 1) { if (p + 16 > end) return null; sz = u32be(a, p + 8) * 4294967296 + u32be(a, p + 12); hdr = 16; }
      else if (sz === 0) sz = end - p;
      if (sz < hdr) return null;
      if (t === type) return { start: p + hdr, end: Math.min(end, p + sz) };
      p += sz;
    }
    return null;
  }
  function parseMp4(a, m) {
    var moov = findBox(a, 0, a.length, 'moov'); if (!moov) return;
    var mvhd = findBox(a, moov.start, moov.end, 'mvhd'); if (!mvhd) return;
    var ts, dur;
    if (a[mvhd.start] === 1) { ts = u32be(a, mvhd.start + 20); dur = u32be(a, mvhd.start + 24) * 4294967296 + u32be(a, mvhd.start + 28); }
    else { ts = u32be(a, mvhd.start + 12); dur = u32be(a, mvhd.start + 16); }
    if (ts > 0) { m.durationSec = dur / ts; m.durationApprox = false; }
  }

  // 解析中繼資料：kind 是種類，bytes 是檔頭（或整檔），size 是整檔大小。任何一步失敗都只記在 notes 裡，不丟例外。
  function parseMetadata(kind, bytes, size) {
    var m = { title: null, artist: null, album: null, durationSec: null, durationApprox: false, tracks: null, trackName: null, format: null, notes: [] };
    if (!bytes || !bytes.length) return m;
    try {
      if (kind === 'mp3') parseMp3(bytes, size, m);
      else if (kind === 'wav') parseWav(bytes, size, m);
      else if (kind === 'mid') parseMid(bytes, m);
      else if (kind === 'mp4' || kind === 'mov') parseMp4(bytes, m);
    } catch (e) {
      m.notes.push('中繼資料解析失敗，已留空');
    }
    return m;
  }

  // 長度顯示：約 m:ss，超過一小時 h:mm:ss；null 顯示「—」
  function formatDuration(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    var s = Math.round(sec), h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), ss = s % 60;
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return h ? h + ':' + p2(mi) + ':' + p2(ss) : mi + ':' + p2(ss);
  }

  // ───── 記錄（一個檔案一筆）─────
  // key = 來源 id + 路徑（同一檔案可能被兩個來源加進來）
  function buildRecord(src, e, id, meta, now) {
    var path = String(e.path), name = basename(path), album = meta.album || albumFromPath(path) || null;
    return {
      key: src.id + '|' + path, sourceId: src.id, sourceType: src.type, sourceLabel: src.label,
      path: path, name: name, ext: extOf(name), kind: id.kind, category: id.category, label: id.label,
      pending: id.pending, via: id.via,
      title: meta.title || stripExt(name), titleSource: meta.title ? 'tag' : 'filename',
      artist: meta.artist || null,
      album: album, albumSource: meta.album ? 'tag' : (album ? 'folder' : null),
      durationSec: meta.durationSec == null ? null : meta.durationSec, durationApprox: !!meta.durationApprox,
      sizeBytes: e.size, mtimeMs: e.mtimeMs, status: 'ok', scannedAt: now,
      // 歌詞（轉錄結果）：檔案變更時這筆會被重建，歌詞跟著清掉，所以「檔案變了才重做」自然成立
      lyrics: null, lyricStatus: 'none', lyricError: null,
      meta: { format: meta.format, tracks: meta.tracks, trackName: meta.trackName, notes: meta.notes }
    };
  }

  // 增量掃描：statEntries 是 [{ path, size, mtimeMs }]（host 只給狀態，不讀內容）；readHead(path, n) 非同步回傳檔頭 Uint8Array 或 null。
  // 路徑＋大小＋修改時間都一樣、而且目前狀態是 ok 的 → 直接沿用，不呼叫 readHead。
  // 新增或變更 → 讀檔頭、辨識、解析。這次沒看到、原本有的 → 標成 missing（不刪，之後再出現會重新解析）。
  async function scanSource(lib, sourceId, statEntries, readHead, opts) {
    opts = opts || {};
    var now = opts.now || Date.now(), headBytes = opts.headBytes || HEAD_BYTES;
    var src = lib.sources.filter(function (s) { return s.id === sourceId; })[0];
    if (!src) throw new Error('找不到來源：' + sourceId);
    var old = {};
    lib.records.forEach(function (r) { if (r.sourceId === sourceId) old[r.path] = r; });
    var report = { added: 0, changed: 0, unchanged: 0, missing: 0, skipped: 0, skippedPaths: [] };
    var seen = {}, out = [];
    for (var i = 0; i < statEntries.length; i++) {
      var e = statEntries[i], path = String(e.path);
      if (seen[path]) continue;
      seen[path] = true;
      var prev = old[path], sig = e.size + '|' + e.mtimeMs;
      if (prev && prev.status === 'ok' && prev.sizeBytes === e.size && prev.mtimeMs === e.mtimeMs) { out.push(prev); report.unchanged++; continue; }
      // 上次辨識不出來、而且大小與修改時間都沒變 → 不重讀檔頭
      if (!prev && src.skipIndex && src.skipIndex[path] === sig) { report.skipped++; report.skippedPaths.push(path); continue; }
      var bytes = null;
      try { bytes = await readHead(path, headBytes); } catch (err) { bytes = null; }
      var id = identifyKind(path, bytes);
      if (!id) {
        report.skipped++; report.skippedPaths.push(path);
        src.skipIndex = src.skipIndex || {}; src.skipIndex[path] = sig;
        if (prev) out.push(Object.assign({}, prev, { status: 'missing', scannedAt: now }));
        continue;
      }
      if (src.skipIndex) delete src.skipIndex[path];
      var meta = parseMetadata(id.kind, bytes, e.size);
      out.push(buildRecord(src, e, id, meta, now));
      if (prev) report.changed++; else report.added++;
    }
    Object.keys(old).forEach(function (path) {
      if (seen[path]) return;
      var r = old[path];
      if (r.status !== 'missing') { out.push(Object.assign({}, r, { status: 'missing', scannedAt: now })); report.missing++; }
      else out.push(r);
    });
    lib.records = lib.records.filter(function (r) { return r.sourceId !== sourceId; }).concat(out);
    src.lastScanAt = now;
    return report;
  }

  // ───── 搜尋：多關鍵字（空白分隔，全部都要命中），每個關鍵字在任一欄位命中即可；欄位權重 檔名＝標題 3、專輯＝演出者 2、路徑 1；
  // 檔名完全相同 +5、檔名開頭相同 +2；依分數高到低，同分依路徑排序 ─────
  // 範圍 opts.scope：'all'（預設：檔名中繼資料＋歌詞）、'meta'（不含歌詞）、'lyrics'（只查歌詞）。
  // 歌詞命中的權重 1.2（每個關鍵字），低於檔名／標題的 3，所以檔名命中仍排前面；歌詞命中回傳 lyricHits（命中的段落與時間點，最多 8 段）。
  var LYRIC_WEIGHT = 1.2, LYRIC_HITS_MAX = 8;
  function searchRecords(records, query, opts) {
    opts = opts || {};
    var scope = opts.scope || 'all';
    var words = normalizeText(query).split(/\s+/).filter(Boolean), out = [];
    (records || []).forEach(function (r) {
      if (r.status === 'missing' && !opts.includeMissing) return;
      if (!words.length) { out.push({ record: r, score: 0, lyricHits: [] }); return; }
      var name = normalizeText(r.name), score = 0, segs = null, segNorm = null;
      if (scope !== 'meta' && r.lyrics && r.lyrics.segments) {
        segs = r.lyrics.segments;
        segNorm = segs.map(function (s) { return normalizeText(s.text); });
      }
      var fields = scope === 'lyrics' ? [] : [[name, 3], [normalizeText(r.title), 3], [normalizeText(r.album), 2], [normalizeText(r.artist), 2], [normalizeText(r.path), 1]];
      var hitSet = {};
      for (var i = 0; i < words.length; i++) {
        var w = words[i], best = 0;
        for (var j = 0; j < fields.length; j++) if (fields[j][0].indexOf(w) >= 0 && fields[j][1] > best) best = fields[j][1];
        if (segNorm) {
          var lyricHit = false;
          for (var k = 0; k < segNorm.length; k++) if (segNorm[k].indexOf(w) >= 0) { lyricHit = true; hitSet[k] = true; }
          if (lyricHit && LYRIC_WEIGHT > best) best = LYRIC_WEIGHT;
        }
        if (!best) return;
        score += best;
        if (name === w) score += 5; else if (name.indexOf(w) === 0) score += 2;
      }
      var lyricHits = segs ? Object.keys(hitSet).map(Number).sort(function (a, b) { return a - b; }).slice(0, LYRIC_HITS_MAX).map(function (k) { return { start: segs[k].start, end: segs[k].end, text: segs[k].text }; }) : [];
      out.push({ record: r, score: score, lyricHits: lyricHits });
    });
    out.sort(function (x, y) {
      if (y.score !== x.score) return y.score - x.score;
      return x.record.path < y.record.path ? -1 : (x.record.path > y.record.path ? 1 : 0);
    });
    return out;
  }

  // ───── 歌詞轉錄佇列（含無進展偵測、暫時性失敗自動重試）─────
  // 狀態（每筆曲目的 lyricStatus）：none 未轉錄、queued 排隊、running 轉錄中、done 完成、failed 失敗（lyricError 記具體原因）。
  // transcriber(record, { language, report(stage, { detail, units, window }), onProgress(0~1), shouldPause() }) → Promise<{ segments, language, durationSeconds }>
  //   report 是進展回報：每回報一次就重新計時。stage 用 decode（解碼）、load（載入模型）、infer（推論）。
  //   units：這個階段完成的工作量（累計用來學習每單位耗時，例如解碼用 MB、推論用音訊秒）；window：本次回報對應的「無進展」判斷單位。
  // 無進展偵測：某階段在 STALL_FACTOR × 每單位預估耗時 × window 之內沒有任何回報，就中止這次嘗試（StallError，附階段名、已耗時、最後進度）。
  //   每單位預估耗時一開始用保守的先驗值，之後依實測（指數移動平均）自動更新：長檔、慢機器自動放寬，短檔自動收緊。STALL_FLOOR_MS 只是最短保底。
  // 暫時性失敗（無進展、逾時、網路、GPU 裝置遺失）：全新再試一次（會重新建立轉錄器），最多重試 3 次，間隔 2、6、14 秒（遞增）。
  //   其餘失敗（例如這個格式解不了）不重試，立刻標失敗。3 次重試後仍失敗才標失敗，原因寫明嘗試次數。
  // 暫停：轉錄函式可在分段之間檢查 shouldPause()，要停就丟出 err.paused = true；那首退回排隊，續跑時從頭做。
  // 每轉完一首就 lib.save()，中途關掉 app，已完成的不會丟；已完成的不重做；檔案變更時曲目重建、歌詞清掉。
  var STALL_FACTOR = 3, STALL_FLOOR_MS = 20000, EMA_ALPHA = 0.3;
  var STAGE_PRIOR_MS_PER_UNIT = { decode: 1500, load: 60000, infer: 3000 }; // 每單位先驗：解碼＝MB、載入＝1、推論＝音訊秒
  var RETRY_BACKOFF_MS = [2000, 6000, 14000];
  var TRANSIENT_RE = /無進展|timed? ?out|逾時|network|fetch|load failed|networkerror|connection|device lost|context lost|gpu|連線|網路/i;
  var STAGE_NAME = { start: '準備', decode: '解碼', load: '載入模型', infer: '推論' };

  function createLyricQueue(lib, transcriber, opts) {
    opts = opts || {};
    if (typeof transcriber !== 'function') throw new Error('createLyricQueue 需要轉錄函式');
    var P = Object.assign({ floorMs: STALL_FLOOR_MS, factor: STALL_FACTOR, backoffMs: RETRY_BACKOFF_MS, prior: STAGE_PRIOR_MS_PER_UNIT }, opts.policy || {});
    var ema = { decode: P.prior.decode, load: P.prior.load, infer: P.prior.infer }; // 每單位毫秒，實測後更新
    var st = { running: false, paused: false, current: null, progress: null, queue: [], doneRun: 0, failedRun: 0, saveError: null,
      stage: null, stageSince: null, stageDetail: '', attempt: 0, retry: null };
    var listeners = [], pauseWaiters = [];
    lib.records.forEach(function (r) { if (r.lyricStatus === 'running' || r.lyricStatus === 'queued') r.lyricStatus = 'none'; }); // 重開後沒有在跑的工作

    function find(key) { for (var i = 0; i < lib.records.length; i++) if (lib.records[i].key === key) return lib.records[i]; return null; }
    function emit() { var s = q.state(); listeners.forEach(function (fn) { try { fn(s); } catch (_) { /* 監聽者出錯不影響佇列 */ } }); }
    function sanitize(res) {
      var segs = Array.isArray(res && res.segments) ? res.segments : [];
      return {
        segments: segs.map(function (s) { return { start: typeof s.start === 'number' ? s.start : null, end: typeof s.end === 'number' ? s.end : null, text: String(s.text == null ? '' : s.text).trim() }; }).filter(function (s) { return s.text; }),
        language: (res && res.language) || opts.language || 'zh',
        durationSec: res && typeof res.durationSeconds === 'number' ? res.durationSeconds : null
      };
    }
    function defaultWindow(stage, r) {
      if (stage === 'decode') return Math.max(1, (r.sizeBytes || 0) / 1048576);
      if (stage === 'load') return 1;
      if (stage === 'infer') return 30;
      return 1;
    }
    function stallLimitMs(stage, windowUnits) {
      var per = ema[stage] != null ? ema[stage] : P.prior.infer;
      return Math.max(P.floorMs, Math.round(P.factor * per * Math.max(1, windowUnits || 1)));
    }
    function learn(stage, elapsedMs, units) {
      if (!stage || !(units > 0) || ema[stage] == null || !(elapsedMs >= 0)) return;
      ema[stage] = (1 - EMA_ALPHA) * ema[stage] + EMA_ALPHA * (elapsedMs / units);
    }
    function stallError(stage, elapsedMs, detail, limitMs) {
      var e = new Error('階段「' + (STAGE_NAME[stage] || stage) + '」無進展超過 ' + Math.round(limitMs / 1000) + ' 秒（已耗時 ' + Math.round(elapsedMs / 1000) + ' 秒，最後進度：' + (detail || '無') + '）');
      e.stall = true; e.stage = stage; e.elapsedMs = elapsedMs; e.lastDetail = detail;
      return e;
    }
    function isTransient(err) { if (!err || err.userWait) return false; if (err.stall) return true; return TRANSIENT_RE.test(String(err.message || '')); }

    // 單一次嘗試：監看進展；超過無進展上限就中止這次（底層工作可能還在跑，但結果會被忽略）
    function runAttempt(r) {
      return new Promise(function (resolve, reject) {
        var done = false, timer = null, stage = 'start', stageAt = Date.now(), stageUnits = 0, detail = '', win = 1;
        function finish(fn, v) { if (done) return; done = true; clearTimeout(timer); pauseWaiters = pauseWaiters.filter(function (w) { return w !== onPause; }); fn(v); }
        // 暫停要立刻生效：正在跑的這次嘗試直接以「已暫停」結束（底層工作若還在跑，它的結果會被忽略）
        function onPause() { var e = new Error(st.cancelRequested ? '已取消' : '已暫停'); e.paused = true; e.cancelled = !!st.cancelRequested; finish(reject, e); }
        pauseWaiters.push(onPause);
        function arm() {
          clearTimeout(timer);
          var limit = stallLimitMs(stage, win);
          timer = setTimeout(function () { finish(reject, stallError(stage, Date.now() - stageAt, detail, limit)); }, limit);
        }
        function report(s, d) {
          if (done) return;
          d = d || {};
          var now = Date.now();
          if (s && s !== stage) { learn(stage, now - stageAt, stageUnits); stage = s; stageAt = now; stageUnits = 0; win = defaultWindow(s, r); }
          if (d.units > 0) stageUnits += d.units;
          if (d.window > 0) win = d.window;
          if (d.detail != null) detail = String(d.detail).slice(0, 200);
          st.stage = stage; st.stageSince = stageAt; st.stageDetail = detail;
          emit(); arm();
        }
        arm();
        var p;
        try {
          p = Promise.resolve(transcriber(r, {
            language: opts.language || 'zh',
            report: report,
            onProgress: function (f) { st.progress = Math.max(0, Math.min(1, Number(f) || 0)); emit(); },
            shouldPause: function () { return st.paused; }
          }));
        } catch (e) { p = Promise.reject(e); }
        p.then(function (v) { if (!done) learn(stage, Date.now() - stageAt, stageUnits); finish(resolve, v); }, function (e) { finish(reject, e); });
      });
    }
    function waitWithPause(ms) {
      return new Promise(function (resolve, reject) {
        var end = Date.now() + ms;
        (function tick() {
          if (st.paused || st.cancelRequested) { var e = new Error(st.cancelRequested ? '已取消' : '已暫停'); e.paused = true; e.cancelled = !!st.cancelRequested; return reject(e); }
          var left = end - Date.now();
          if (left <= 0) return resolve();
          setTimeout(tick, Math.min(200, left));
        })();
      });
    }
    // 暫時性失敗：全新重試（每次都重新呼叫轉錄函式），間隔遞增；其餘失敗或重試用完就丟出
    async function transcribeWithRetry(r) {
      var backoff = P.backoffMs;
      for (var attempt = 1; ; attempt++) {
        st.attempt = attempt; emit();
        try {
          return await runAttempt(r);
        } catch (err) {
          if (err && err.paused) throw err;
          var exhausted = attempt > backoff.length;
          if (exhausted || !isTransient(err)) {
            var fin = new Error('第 ' + attempt + ' 次嘗試失敗' + (attempt > 1 ? '（已自動重試 ' + (attempt - 1) + ' 次）' : '') + '：' + String((err && err.message) || err || '未知錯誤'));
            fin.attempts = attempt;
            throw fin;
          }
          var wait = backoff[attempt - 1];
          st.retry = { afterAttempt: attempt, waitMs: wait, untilAt: Date.now() + wait, reason: String((err && err.message) || err) };
          emit();
          await waitWithPause(wait);
          st.retry = null; emit();
        }
      }
    }

    async function loop() {
      st.running = true; emit();
      try {
        while (!st.paused && st.queue.length) {
          var key = st.queue.shift(), r = find(key);
          if (!r || r.status !== 'ok' || r.lyricStatus === 'done') continue;
          st.current = key; st.progress = 0; r.lyricStatus = 'running'; r.lyricError = null; emit();
          try {
            var res = await transcribeWithRetry(r);
            r.lyrics = Object.assign(sanitize(res), { transcribedAt: Date.now() });
            r.lyricStatus = 'done'; r.lyricError = null; st.doneRun++;
          } catch (err) {
            if (err && err.cancelled) { r.lyricStatus = 'none'; r.lyricError = null; break; } // 取消：不記失敗，也不再排隊
            if (err && err.paused) { r.lyricStatus = 'queued'; st.queue.unshift(key); break; }
            r.lyricStatus = 'failed';
            r.lyricError = String((err && err.message) || err || '未知錯誤') || '未知錯誤';
            st.failedRun++;
          }
          st.current = null; st.progress = null; st.stage = null; st.stageSince = null; st.stageDetail = ''; st.attempt = 0; st.retry = null;
          try { await lib.save(); st.saveError = null; } catch (e) { st.saveError = String((e && e.message) || e); }
          emit();
        }
      } finally {
        st.current = null; st.progress = null; st.running = false; st.stage = null; st.stageSince = null; st.stageDetail = ''; st.attempt = 0; st.retry = null;
        // 暫停時還在佇列裡的曲目標成排隊中（顯示用）
        st.queue.forEach(function (k) { var x = find(k); if (x && x.lyricStatus !== 'done') x.lyricStatus = 'queued'; });
        emit();
      }
    }
    function kick() { if (!st.running && !st.paused && st.queue.length) loop(); }

    var q = {
      // keys 為空＝全部還沒完成的（none／failed／queued）；遊戲來源（pending）不排進佇列
      enqueue: function (keys) {
        st.cancelRequested = false;
        var list = keys && keys.length ? keys : lib.records.filter(function (r) { return r.status === 'ok' && !isSourceOnly(r); }).map(function (r) { return r.key; });
        list.forEach(function (k) {
          var r = find(k);
          if (!r || r.status !== 'ok' || isSourceOnly(r) || r.lyricStatus === 'done' || st.queue.indexOf(k) >= 0 || st.current === k) return;
          st.queue.push(k); r.lyricStatus = 'queued'; r.lyricError = null;
        });
        emit(); kick();
        return st.queue.length;
      },
      pause: function () { st.paused = true; pauseWaiters.slice().forEach(function (f) { f(); }); emit(); },
      // 執行期調整政策（測試與評測用；正式值是常數）。prior 會同時更新目前的每單位估計。
      setPolicy: function (p) {
        p = p || {};
        Object.keys(p).forEach(function (k) { if (k !== 'prior') P[k] = p[k]; });
        if (p.prior) { P.prior = Object.assign({}, P.prior, p.prior); Object.keys(p.prior).forEach(function (k) { if (ema[k] != null) ema[k] = p.prior[k]; }); }
        emit();
      },
      resume: function () { st.paused = false; emit(); kick(); },
      // 取消：清空排隊、中止正在跑的那一首（不算失敗、不重試），曲目回到未轉錄。評測結束前與面板卡住時用。
      cancelAll: function () {
        st.cancelRequested = true;
        st.queue.forEach(function (k) { var x = find(k); if (x && x.lyricStatus === 'queued') x.lyricStatus = 'none'; });
        st.queue = [];
        pauseWaiters.slice().forEach(function (f) { f(); });
        emit();
      },
      // 等目前這一輪結束（測試與關閉前用）
      idle: function () { return new Promise(function (res) { (function wait() { if (!st.running) res(); else setTimeout(wait, 5); })(); }); },
      onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (x) { return x !== fn; }); }; },
      state: function () {
        var c = { none: 0, queued: 0, running: 0, done: 0, failed: 0 };
        lib.records.forEach(function (r) { if (r.status === 'ok' && !isSourceOnly(r) && c[r.lyricStatus] != null) c[r.lyricStatus]++; });
        return {
          running: st.running, paused: st.paused, current: st.current, progress: st.progress, queued: st.queue.length,
          doneRun: st.doneRun, failedRun: st.failedRun, saveError: st.saveError, counts: c,
          stage: st.stage, stageLabel: st.stage ? (STAGE_NAME[st.stage] || st.stage) : null, stageSince: st.stageSince, stageDetail: st.stageDetail,
          attempt: st.attempt, retry: st.retry
        };
      }
    };
    return q;
  }

  // ───── 儲存後端：只要求 load() → { sources, records } 或 null、save(data) ─────
  function createMemoryBackend(initial) {
    var data = initial ? JSON.parse(JSON.stringify(initial)) : null;
    return {
      load: async function () { return data ? JSON.parse(JSON.stringify(data)) : null; },
      save: async function (d) { data = JSON.parse(JSON.stringify(d)); }
    };
  }
  // io：{ read: async () => 字串或 null, write: async (字串) }，檔案放哪裡（IndexedDB、磁碟、FAP）由 app 決定
  function createJsonBackend(io) {
    return {
      load: async function () {
        var s = await io.read();
        if (!s) return null;
        var d = JSON.parse(s);
        if (d.version > VERSION) throw new Error('音樂庫檔案是比較新的版本（' + d.version + '），這個 app 只認得到版本 ' + VERSION);
        return { sources: d.sources || [], records: d.records || [] };
      },
      save: async function (d) { await io.write(JSON.stringify({ version: VERSION, sources: d.sources, records: d.records })); }
    };
  }

  // 庫：load／save 經過 backend；addSource 登記來源（檔案或資料夾）；scan 做增量掃描；search 搜尋
  function createLibrary(backend) {
    var be = backend || createMemoryBackend();
    var lib = { sources: [], records: [] };
    lib.load = async function () {
      var d = await be.load();
      lib.sources = (d && d.sources) || [];
      lib.records = (d && d.records) || [];
      return lib;
    };
    lib.save = async function () { await be.save({ sources: lib.sources, records: lib.records }); };
    lib.addSource = function (type, label) {
      var existing = lib.sources.filter(function (s) { return s.type === type && s.label === label; })[0];
      if (existing) return existing.id;
      var id = 'src' + (lib.sources.length + 1) + '-' + Date.now().toString(36);
      lib.sources.push({ id: id, type: type, label: label, addedAt: Date.now(), lastScanAt: null });
      return id;
    };
    lib.removeSource = function (id) {
      lib.sources = lib.sources.filter(function (s) { return s.id !== id; });
      lib.records = lib.records.filter(function (r) { return r.sourceId !== id; });
    };
    lib.planRemove = function (keys, opts) { return planRemove(lib, keys, opts); };
    lib.planSourceRemove = function (sourceId, opts) { return planSourceRemove(lib, sourceId, opts); };
    lib.applyRemove = function (plan, opts) { return applyRemove(lib, plan, opts); };
    lib.scan = function (sourceId, statEntries, readHead, opts) { return scanSource(lib, sourceId, statEntries, readHead, opts); };
    lib.search = function (query, opts) { return searchRecords(lib.records, query, opts); };
    return lib;
  }

  // ───────────────────────── 批次輸出（mid／mp3）：純函式，不碰瀏覽器 API
  // 分鐘數：'whole'（整首）或正數（分鐘）。整首回傳 null，表示不截斷；沒有人為長度上限。
  function minutesToSec(minutes) {
    if (minutes === 'whole') return null;
    var m = Number(minutes);
    if (!isFinite(m) || m <= 0) throw new Error('分鐘數必須是大於 0 的數字，或選「整首」');
    return m * 60;
  }

  // 要截的時間窗：從 0 開始，到 limitSec 或整首結束（取較小者）。
  function sliceWindow(totalSec, limitSec) {
    var total = Math.max(0, Number(totalSec) || 0);
    var end = limitSec == null ? total : Math.min(total, limitSec);
    return { startSec: 0, endSec: end, truncated: limitSec != null && limitSec < total };
  }

  // 輸出檔名：原檔名去副檔名＋分鐘標記（整首或 N分）＋新副檔名；檔名不能有路徑分隔字元。
  function outputName(baseName, format, minutes) {
    var stem = String(baseName || 'track').replace(/\.[^.\\\/]+$/, '').replace(/[\\\/:*?"<>|]/g, '_');
    var label = minutes === 'whole' ? '整首' : (Number(minutes) + '分');
    return stem + '_' + label + '.' + format;
  }

  var EXPORT_FORMATS = ['mid', 'mp3'];
  var EXPORT_MAX_ATTEMPTS = 3;
  var EXPORT_RETRY_BACKOFF_MS = [1000, 3000];
  // 路由表：來源類別＞輸出格式 → 步驟序列。步驟名稱由呼叫端（host）實作。
  var EXPORT_ROUTES = {
    'audio>mp3': ['decode', 'slice', 'encode-mp3'],
    'mid>mp3': ['parse-mid', 'trim-mid', 'render-synth', 'slice', 'encode-mp3'],
    'mid>mid': ['parse-mid', 'trim-mid', 'write-mid'],
    // 影片與音訊同一條：extract_audio 用的 _decodeAudioBuffer 會原生解出 mp4/mov/webm 的音軌，不需要 ffmpeg.wasm
    'video>mp3': ['decode', 'slice', 'encode-mp3'],
    // 音訊（與影片）轉 MIDI：to-song 走既有 FaAudioPipeline（有 Basic Pitch 就用，沒有或失敗就單音音高追蹤並標明）
    'audio>mid': ['decode', 'slice', 'to-song', 'write-mid'],
    'video>mid': ['decode', 'slice', 'to-song', 'write-mid']
  };
  var SOURCE_CLASS = { wav: 'audio', mp3: 'audio', mid: 'mid', midi: 'mid', mp4: 'video', mov: 'video', webm: 'video', m4v: 'video' };
  var ROM_EXT = {};
  var EXTRACT_EXT = { rix: 1, swf: 1, nes: 1, pce: 1, sfc: 1, smc: 1 };

  // 規劃單一檔案的輸出路線。回傳 { ok:true, route, steps } 或 { ok:false, reason }。
  // 不支援的組合一律說明原因，不偷偷略過。
  function planExport(name, format) {
    var ext = String(name || '').split('.').pop().toLowerCase();
    if (EXPORT_FORMATS.indexOf(format) < 0) return { ok: false, reason: '不支援的輸出格式：' + format };
    if (EXTRACT_EXT[ext]) return { ok: false, reason: ext.toUpperCase() + ' 要先按「擷取」產生子曲目（MIDI／mp3／wav／NSF），再批次輸出子曲目' };
    if (ROM_EXT[ext]) return { ok: false, reason: '尚未支援：' + ext + ' 遊戲檔的音樂需要模擬器驅動，本輪沒有擷取器' };
    var cls = SOURCE_CLASS[ext];
    if (!cls) return { ok: false, reason: '尚未支援這種格式：.' + ext };
    var key = cls + '>' + format;
    var steps = EXPORT_ROUTES[key];
    if (!steps) return { ok: false, reason: '沒有對應的路線：' + key };
    return { ok: true, route: key, steps: steps.slice() };
  }

  // 批次執行。items: [{ id, name, format }]。opts:
  //   minutes（'whole' 或分鐘數）、runStep(ctx) → Promise<{path,sizeBytes}>（ctx: item, route, steps, limitSec, isCancelled, onStage）
  //   verify(out, item) → Promise<{ok, detail}>（可省略）、isCancelled()、onEvent(ev)、sleep(ms)
  // 每個檔案獨立：單檔失敗不影響其他檔案；暫時性錯誤（TRANSIENT_RE）自動重來，最多 EXPORT_MAX_ATTEMPTS 次。
  async function runExportBatch(items, opts) {
    opts = opts || {};
    var limitSec = minutesToSec(opts.minutes == null ? 'whole' : opts.minutes);
    var isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : function () { return false; };
    var emit = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    async function runOne(it) {
      var rec = { id: it.id, name: it.name, format: it.format, status: 'pending', stage: null, reason: '', attempts: 0, elapsedMs: 0, output: null, verify: null, route: null };
      var t0 = Date.now();
      var plan = planExport(it.name, it.format);
      if (!plan.ok) { rec.status = 'unsupported'; rec.stage = 'plan'; rec.reason = plan.reason; return rec; }
      rec.route = plan.route;
      for (;;) {
        if (isCancelled()) { rec.status = 'cancelled'; break; }
        rec.attempts++;
        try {
          var out = await opts.runStep({
            item: it, route: plan.route, steps: plan.steps, limitSec: limitSec, isCancelled: isCancelled,
            onStage: function (s) { rec.stage = s; emit({ id: it.id, stage: s }); }
          });
          rec.output = out;
          if (typeof opts.verify === 'function') {
            rec.stage = 'verify';
            rec.verify = await opts.verify(out, it);
            if (!rec.verify || rec.verify.ok !== true) { rec.status = 'failed'; rec.reason = '輸出檢查未通過：' + ((rec.verify && rec.verify.detail) || '未知'); break; }
          }
          rec.status = 'done'; rec.reason = ''; break;
        } catch (err) {
          var msg = String((err && err.message) || err);
          if (isCancelled() || (err && err.cancelled)) { rec.status = 'cancelled'; break; }
          if (TRANSIENT_RE.test(msg) && rec.attempts < EXPORT_MAX_ATTEMPTS) {
            emit({ id: it.id, retry: rec.attempts, reason: msg });
            await sleep(EXPORT_RETRY_BACKOFF_MS[rec.attempts - 1] || EXPORT_RETRY_BACKOFF_MS[EXPORT_RETRY_BACKOFF_MS.length - 1]);
            continue;
          }
          rec.status = 'failed'; rec.reason = msg; break;
        }
      }
      rec.elapsedMs = Date.now() - t0;
      return rec;
    }

    var results = [];
    for (var i = 0; i < items.length; i++) {
      if (isCancelled()) { results.push({ id: items[i].id, name: items[i].name, format: items[i].format, status: 'cancelled', stage: null, reason: '', attempts: 0, elapsedMs: 0, output: null, verify: null, route: null }); continue; }
      results.push(await runOne(items[i]));
      emit({ id: items[i].id, finished: results[results.length - 1].status });
    }
    var summary = { done: 0, failed: 0, unsupported: 0, cancelled: 0 };
    results.forEach(function (r) { summary[r.status] = (summary[r.status] || 0) + 1; });
    return { results: results, summary: summary };
  }

  // ───────────────────────── 擷取的子曲目（RIX／Flash 擷取出來的 MIDI、mp3、wav）
  // 子曲目的格式與普通檔案一樣（kind 是 mid／mp3／wav），之後的檔名搜尋、歌詞、哼歌索引、批次輸出都不分辨來源。
  // 只記下來源：derivedFrom（來源記錄的 key）、derivedIndex（第幾個）、derivedMethod（擷取方式）。
  function buildDerivedRecord(parent, out, now) {
    var path = String(out.path), name = basename(path), kind = out.kind;
    var k = KINDS[kind] || { category: 'audio', label: kind };
    return {
      key: 'derived|' + parent.key + '|' + out.index, sourceId: parent.sourceId, sourceType: parent.sourceType, sourceLabel: parent.sourceLabel,
      path: path, name: name, ext: extOf(name), kind: kind, category: k.category, label: k.label,
      pending: false, via: 'extract',
      title: out.title || stripExt(name), titleSource: 'derived', artist: null,
      album: parent.album || null, albumSource: parent.album ? 'folder' : null,
      durationSec: out.durationSec == null ? null : out.durationSec, durationApprox: false,
      sizeBytes: out.sizeBytes || 0, mtimeMs: now, status: 'ok', scannedAt: now,
      lyrics: null, lyricStatus: 'none', lyricError: null,
      meta: { format: 'derived', tracks: null, trackName: null, notes: null },
      derivedFrom: parent.key, derivedIndex: out.index, derivedMethod: out.method || ''
    };
  }
  // 換掉某個來源的子曲目（重新擷取時先把舊的拿掉，避免重複）
  function replaceDerived(lib, parentKey, newRecs) {
    lib.records = lib.records.filter(function (r) { return r.derivedFrom !== parentKey; }).concat(newRecs || []);
    return lib.records.length;
  }

  // ───────────────────────── 匯出／匯入資料庫（純函式，不碰檔案系統）
  // 匯出檔：{ format, version, exportedAt, sources, records }；records 帶旋律索引（melody）、歌詞（lyrics）、衍生關係（derivedFrom）。
  var DB_FORMAT = 'fa-musiclib-db';
  function cloneJson(x) { return JSON.parse(JSON.stringify(x)); }
  function exportDb(lib, opts) {
    opts = opts || {};
    return { format: DB_FORMAT, version: VERSION, exportedAt: opts.now || new Date().toISOString(), sources: cloneJson(lib.sources || []), records: cloneJson(lib.records || []) };
  }
  // 檔案的 sig：大小＋修改時間（與掃描判斷「檔案變了沒」同一套）
  function sigOfRec(r) { return String(r.sizeBytes != null ? r.sizeBytes : (r.size || 0)) + ':' + String(r.mtimeMs || 0); }
  function sigOfStat(st) { return String(st.size || 0) + ':' + String(st.mtimeMs || 0); }
  // 先整份驗證；壞的就回傳錯誤，不碰現有資料。statOf(path) → { size, mtimeMs } 或 null（檔案不存在）。
  // mode：'merge'（保留現有、補上新的）或 'replace'（取代全部）。回傳的 plan 只是新狀態，要 applyImport 才寫進 lib。
  function planImport(lib, data, opts) {
    opts = opts || {};
    var mode = opts.mode === 'replace' ? 'replace' : 'merge';
    var statOf = opts.statOf || function () { return null; };
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '檔案內容不是音樂庫資料（不是 JSON 物件）' };
    if (data.format !== DB_FORMAT) return { ok: false, error: '這不是音樂庫匯出的檔案（格式欄位不是 ' + DB_FORMAT + '）' };
    if (typeof data.version !== 'number' || !(data.version >= 1)) return { ok: false, error: '檔案沒有有效的版本號，無法確認能不能讀' };
    if (data.version > VERSION) return { ok: false, error: '檔案版本是 ' + data.version + '，比這個 app 認得的版本 ' + VERSION + ' 新，請先更新 app；現有資料沒有被改動' };
    if (!Array.isArray(data.sources) || !Array.isArray(data.records)) return { ok: false, error: '檔案缺少來源或紀錄清單' };
    for (var i = 0; i < data.sources.length; i++) {
      var s = data.sources[i];
      if (!s || typeof s.id !== 'string' || typeof s.label !== 'string' || typeof s.type !== 'string') return { ok: false, error: '第 ' + (i + 1) + ' 個來源的格式不對' };
    }
    for (var j = 0; j < data.records.length; j++) {
      var r = data.records[j];
      if (!r || typeof r.key !== 'string' || typeof r.path !== 'string' || typeof r.sourceId !== 'string') return { ok: false, error: '第 ' + (j + 1) + ' 筆紀錄的格式不對（缺 key、path 或 sourceId）' };
    }
    // 以下只讀現有資料、在副本上算
    var base = mode === 'replace' ? { sources: [], records: [] } : cloneJson({ sources: lib.sources || [], records: lib.records || [] });
    var srcMap = {}, usedSrcIds = {};
    base.sources.forEach(function (s) { usedSrcIds[s.id] = true; });
    data.sources.forEach(function (s) {
      var same = base.sources.filter(function (x) { return x.type === s.type && x.label === s.label; })[0];
      if (same) { srcMap[s.id] = same.id; return; }
      var id = s.id, n = 0;
      while (usedSrcIds[id]) id = s.id + '~' + (++n);
      usedSrcIds[id] = true;
      srcMap[s.id] = id;
      base.sources.push({ id: id, type: s.type, label: s.label, addedAt: s.addedAt || null, lastScanAt: s.lastScanAt || null });
    });
    var localByPath = {};
    base.records.forEach(function (r) { localByPath[r.path] = r; });
    var keyMap = {}, stats = { imported: data.records.length, added: 0, matched: 0, filledIndex: 0, indexStale: 0, missing: 0, orphanDerived: 0 };
    var statCache = {};
    function statFor(p) { if (!(p in statCache)) statCache[p] = statOf(p) || null; return statCache[p]; }
    // 先處理來源檔，再處理擷取產物（擷取產物的 key 依賴父紀錄的新 key）
    var ordered = data.records.filter(function (r) { return !r.derivedFrom; }).concat(data.records.filter(function (r) { return !!r.derivedFrom; }));
    ordered.forEach(function (src) {
      var sid = srcMap[src.sourceId] || src.sourceId;
      var st = statFor(src.path);
      var local = localByPath[src.path];
      if (local) {
        // 同一個路徑已經在曲庫裡：沿用現有的紀錄；它沒有索引／歌詞、而匯入的檔案 sig 跟現在一樣，才補上
        keyMap[src.key] = local.key; stats.matched++;
        if (st && sigOfRec(src) === sigOfStat(st)) {
          var filled = false;
          if (!local.melody && src.melody && src.melody.status === 'ok') { local.melody = cloneJson(src.melody); filled = true; }
          if (!local.lyrics && src.lyrics) { local.lyrics = cloneJson(src.lyrics); local.lyricStatus = src.lyricStatus || 'done'; filled = true; }
          if (filled) stats.filledIndex++;
        }
        return;
      }
      var nr = cloneJson(src);
      nr.sourceId = sid;
      if (nr.derivedFrom) {
        var parentNew = keyMap[nr.derivedFrom];
        if (!parentNew) stats.orphanDerived++;
        nr.derivedFrom = parentNew || nr.derivedFrom;
        nr.key = 'derived|' + nr.derivedFrom + '|' + (src.derivedIndex || 0);
      } else nr.key = sid + '|' + src.path;
      keyMap[src.key] = nr.key;
      if (!st) {
        nr.status = 'missing'; stats.missing++;
      } else {
        nr.status = 'ok';
        var same = sigOfRec(src) === sigOfStat(st);
        nr.sizeBytes = st.size; nr.mtimeMs = st.mtimeMs;
        if (!same) {
          // 檔案變了：索引與歌詞是舊內容的，不沿用；紀錄本身保留，標為索引過期（下次建索引會重算）
          nr.indexStale = true; stats.indexStale++;
          nr.melody = null; nr.lyrics = null; nr.lyricStatus = 'none'; nr.lyricError = null;
        } else delete nr.indexStale;
      }
      base.records.push(nr);
      localByPath[nr.path] = nr;
      stats.added++;
    });
    return { ok: true, mode: mode, sources: base.sources, records: base.records, stats: stats };
  }
  function applyImport(lib, plan) {
    lib.sources = plan.sources;
    lib.records = plan.records;
    return plan.stats;
  }

  // ───────────────────────── 旋律索引完成後的白話訊息（純函式）
  // sum：{ done, skipped, failed, cancelled, failures:[{name, reason}] }；groups：{ source, mp3, wav, other }（不建索引的筆數，依類別）
  function describeMelodySummary(sum, groups) {
    sum = sum || {}; groups = groups || {};
    var out = [], head = '旋律索引完成：新建 ' + (sum.done || 0) + ' 首、已建過沿用 ' + (sum.skipped || 0) + ' 首、失敗 ' + (sum.failed || 0) + ' 首';
    if (sum.cancelled) head += '、取消 ' + sum.cancelled + ' 首';
    out.push(head + '。');
    var parts = [];
    if (groups.source) parts.push('遊戲原始檔 ' + groups.source + ' 個（請看它擷取出來的 MIDI）');
    var sib = [];
    if (groups.mp3) sib.push('mp3 ' + groups.mp3 + ' 個');
    if (groups.wav) sib.push('wav ' + groups.wav + ' 個');
    if (sib.length) parts.push('擷取出的 ' + sib.join(' 與 ') + '（跟同一首的 MIDI 是同一首，所以只用 MIDI 建索引，搜到時會連到同一首）');
    if (groups.other) parts.push('其他 ' + groups.other + ' 個（種類不支援旋律比對）');
    var n = (groups.source || 0) + (groups.mp3 || 0) + (groups.wav || 0) + (groups.other || 0);
    if (n) out.push('另有 ' + n + ' 筆不需要建：' + parts.join('、') + '。');
    var f = sum.failures || [];
    if (f.length) {
      var shown = f.slice(0, 5).map(function (x) { return x.name + '（' + x.reason + '）'; }).join('；');
      out.push('失敗的有：' + shown + (f.length > 5 ? '；…另 ' + (f.length - 5) + ' 筆' : '') + '。');
    }
    return out.join('');
  }
  // 不建索引的分類（給訊息用）：來源檔、擷取出的 mp3、擷取出的 wav、其他
  function melodyGroup(r) {
    if (isSourceOnly(r)) return 'source';
    if (r.derivedFrom && r.kind === 'mp3') return 'mp3';
    if (r.derivedFrom && r.kind === 'wav') return 'wav';
    return 'other';
  }

  // ───────────────────────── 旋律索引的收錄規則（純函式）
  // 只收一般音樂檔（音訊、影片、MIDI）與擷取產物的 MIDI；來源 ROM（rix／nes／pce／sfc／swf）與 nsf 不收，
  // 它們本身不是音訊，拿去解碼一定失敗（舊版就是這樣：86 筆全部失敗）。
  var MEDIA_KINDS = { mid: 1, wav: 1, mp3: 1, mp4: 1, mov: 1, webm: 1 };
  function melodyEligible(r) {
    if (!r) return { ok: false, reason: '沒有這筆紀錄' };
    if (r.pending) return { ok: false, reason: '來源檔（待擷取），不建索引' };
    if (r.status !== 'ok') return { ok: false, reason: '檔案已消失或不可讀' };
    if (r.derivedFrom) return r.kind === 'mid' ? { ok: true } : { ok: false, reason: '擷取產物只有 MIDI 建索引（' + r.kind + ' 不建）' };
    if (isSourceOnly(r)) return { ok: false, reason: '遊戲音樂來源檔，不建索引（請先擷取出 MIDI）' };
    if (!MEDIA_KINDS[r.kind]) return { ok: false, reason: '種類 ' + r.kind + ' 不建索引' };
    return { ok: true };
  }

  // ───────────────────────── 樹狀列（純函式）
  // records：要顯示的紀錄（呼叫端已篩過；搜尋時要把命中子曲目的來源也放進來）。
  // derivedFrom 指向清單裡的來源 → 接在來源下面（depth 1）；父不在清單裡 → 當頂層列並標 orphan。
  // opts.expanded：{ 來源 key: true }；opts.forceExpand：搜尋時一律展開。
  function buildTreeRows(records, opts) {
    opts = opts || {};
    var expanded = opts.expanded || {}, force = !!opts.forceExpand;
    var byKey = {}, kids = {}, tops = [];
    (records || []).forEach(function (r) { byKey[r.key] = r; });
    (records || []).forEach(function (r) {
      if (r.derivedFrom && byKey[r.derivedFrom]) (kids[r.derivedFrom] = kids[r.derivedFrom] || []).push(r);
      else tops.push(r);
    });
    Object.keys(kids).forEach(function (k) {
      kids[k].sort(function (a, b) { return (a.derivedIndex || 0) - (b.derivedIndex || 0) || String(a.name).localeCompare(String(b.name)); });
    });
    var rows = [];
    tops.forEach(function (r) {
      var ks = kids[r.key] || [], open = ks.length > 0 && (force || !!expanded[r.key]);
      rows.push({ rec: r, depth: 0, orphan: !!r.derivedFrom, kidCount: ks.length, expanded: open });
      if (open) ks.forEach(function (c) { rows.push({ rec: c, depth: 1, orphan: false, kidCount: 0, expanded: false }); });
    });
    return rows;
  }

  // ───────────────────────── 移除規則（純函式，不碰檔案）
  // 原始檔：只從曲庫移除，絕不刪磁碟上的原始檔。
  // 擷取產物（derivedFrom）：移除記錄，並刪除衍生檔——但只刪 opts.isDerivedPath(path, rec) 認可的路徑（不認可＝只移除記錄、檔案留著，並寫明原因）。
  // 移除原始檔時，opts.includeDerived（預設 true）決定要不要連同它的擷取產物一起移除；不移除的擷取產物會變成沒有來源的獨立列。
  // 回傳 plan：{ removeKeys, deleteFiles:[{key,path}], skipped:[{key,reason}], originals, derived, orphanedDerived }
  function planRemove(lib, keys, opts) {
    opts = opts || {};
    var includeDerived = opts.includeDerived !== false;
    var isDerivedPath = typeof opts.isDerivedPath === 'function' ? opts.isDerivedPath : null;
    var byKey = {}, originalPaths = {};
    lib.records.forEach(function (r) { byKey[r.key] = r; if (!r.derivedFrom) originalPaths[r.path] = true; });
    var remove = {}, plan = { removeKeys: [], deleteFiles: [], skipped: [], originals: 0, derived: 0, orphanedDerived: 0 };
    function addDerived(rec) {
      if (originalPaths[rec.path]) { plan.skipped.push({ key: rec.key, reason: '這個路徑同時是原始檔，不刪檔（只移除記錄）' }); return; }
      if (!isDerivedPath || !isDerivedPath(rec.path, rec)) { plan.skipped.push({ key: rec.key, reason: '路徑不在衍生資料夾內，不刪檔（只移除記錄）' }); return; }
      plan.deleteFiles.push({ key: rec.key, path: rec.path });
    }
    (keys || []).forEach(function (k) {
      var r = byKey[k];
      if (!r || remove[k]) return;
      remove[k] = true;
      if (r.derivedFrom) { plan.derived++; addDerived(r); return; }
      plan.originals++;
      if (!includeDerived) return;
      lib.records.forEach(function (c) {
        if (c.derivedFrom === k && !remove[c.key]) { remove[c.key] = true; plan.derived++; addDerived(c); }
      });
    });
    plan.removeKeys = Object.keys(remove);
    plan.orphanedDerived = includeDerived ? 0 : lib.records.filter(function (c) { return c.derivedFrom && remove[c.derivedFrom] && !remove[c.key]; }).length;
    return plan;
  }
  // 來源整個移除（addSource 的相反）：原始檔＝這個來源登記的所有非衍生紀錄；擷取產物照 includeDerived 處理。
  function planSourceRemove(lib, sourceId, opts) {
    var keys = lib.records.filter(function (r) { return r.sourceId === sourceId && !r.derivedFrom; }).map(function (r) { return r.key; });
    var plan = planRemove(lib, keys, opts);
    var src = lib.sources.filter(function (s) { return s.id === sourceId; })[0];
    plan.sourceId = sourceId; plan.sourceLabel = src ? src.label : '';
    return plan;
  }
  // 套用：keys 預設 plan.removeKeys（呼叫端可以拿掉衍生檔刪不掉的，讓那筆記錄留著）；dropSource 預設 true（來源登記也拿掉）
  function applyRemove(lib, plan, opts) {
    opts = opts || {};
    var keys = opts.keys || plan.removeKeys, gone = {};
    keys.forEach(function (k) { gone[k] = true; });
    var before = lib.records.length;
    lib.records = lib.records.filter(function (r) { return !gone[r.key]; });
    if (plan.sourceId && opts.dropSource !== false && !opts.keepSource) lib.sources = lib.sources.filter(function (s) { return s.id !== plan.sourceId; });
    return { removed: before - lib.records.length };
  }

  return {
    melodyEligible: melodyEligible, buildTreeRows: buildTreeRows,
    planRemove: planRemove, planSourceRemove: planSourceRemove, applyRemove: applyRemove,
    buildDerivedRecord: buildDerivedRecord, replaceDerived: replaceDerived,
    minutesToSec: minutesToSec, sliceWindow: sliceWindow, outputName: outputName, planExport: planExport, runExportBatch: runExportBatch,
    EXPORT_ROUTES: EXPORT_ROUTES, EXPORT_FORMATS: EXPORT_FORMATS, EXPORT_MAX_ATTEMPTS: EXPORT_MAX_ATTEMPTS,
    VERSION: VERSION, HEAD_BYTES: HEAD_BYTES, KINDS: KINDS, isSourceOnly: isSourceOnly,
    identifyKind: identifyKind, isSupportedName: isSupportedName, albumFromPath: albumFromPath,
    parseMetadata: parseMetadata, formatDuration: formatDuration, normalizeText: normalizeText,
    scanSource: scanSource, searchRecords: searchRecords, createLyricQueue: createLyricQueue, LYRIC_WEIGHT: LYRIC_WEIGHT,
    createMemoryBackend: createMemoryBackend, createJsonBackend: createJsonBackend, createLibrary: createLibrary,
    DB_FORMAT: DB_FORMAT, exportDb: exportDb, planImport: planImport, applyImport: applyImport,
    sigOfRec: sigOfRec, sigOfStat: sigOfStat, describeMelodySummary: describeMelodySummary, melodyGroup: melodyGroup
  };
});
