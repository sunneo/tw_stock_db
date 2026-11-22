/* 通用播放模組（UMD）：曲庫每一筆紀錄、以及 /media-play 的任何檔案都走這裡。
 *   FaMediaPlay.route(kind 或記錄, { chipKinds })   → { route: 'chip'|'midi'|'audio'|'video'|'rom'|'unknown', kind, reason }
 *   FaMediaPlay.planPlay(記錄, 曲庫的 records, opts) → 純計畫：play（直接播）、play-child（來源已有擷取產物，播第一個）、extract（要先擷取）、message（說明）
 *   FaMediaPlay.mount(記錄, host) → DOM 卡片（同步回傳，內容非同步填入）
 *   FaMediaPlay.parseArgs("a b \"c d.mp3\"") → ["a", "b", "c d.mp3"]（/media-play 的參數）
 * 路由順序：晶片後端（FaChipPlayer 註冊表，之後註冊的新後端自動可播）→ mid → 音訊 → 影片 → 來源 ROM（要先擷取）→ 其他（說明）。
 * host（由呼叫端提供，桌面版在 musiclib_host.js）：records()、chipKinds()、extract(記錄)→{results:[…]}、mountMidi(記錄)→Promise<節點>、
 *   mountChip(記錄)→Promise<節點>、mediaUrl(記錄)→Promise<字串>、resolve(記錄)→Promise<記錄>（可省；來源 ROM 要換成曲庫紀錄時用）。
 * 純邏輯可以 node 直接跑測試；DOM 部分只在瀏覽器（或有 document 的環境）會用到。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMediaPlay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var AUDIO_KINDS = { wav: 1, mp3: 1, ogg: 1, flac: 1, m4a: 1, aac: 1, opus: 1 };
  var VIDEO_KINDS = { mp4: 1, mov: 1, webm: 1, m4v: 1, mkv: 1 };
  var ROM_KINDS = { nes: 1, pce: 1, sfc: 1, swf: 1, rix: 1 };   // 來源 ROM：沒有晶片後端時要先擷取（rix 有後端時走晶片播放）
  var ALIAS = { midi: 'mid', smc: 'sfc' };
  var STAGE_ZH = { decode: '解碼', slice: '截取', 'encode-mp3': '編碼 mp3', 'parse-mid': '解析 MIDI', 'trim-mid': '截短', 'render-synth': '合成渲染', 'write-mid': '寫出 MIDI', write: '寫檔', verify: '讀回校驗', 'extract-audio': '抽音軌' };
  var PAIRS = { '"': '"', "'": "'", '“': '”' };

  function normKind(x) {
    var s = String(x == null ? '' : x).trim().toLowerCase();
    if (s.indexOf('.') >= 0) s = s.split('.').pop();
    return ALIAS[s] || s;
  }
  // 記錄或字串（kind 或檔名）→ 種類
  function kindOf(rec) {
    if (typeof rec === 'string') return normKind(rec);
    if (!rec) return '';
    return normKind(rec.kind || rec.name || '');
  }
  function defaultChipKinds() {
    try { return typeof FaChipPlayer !== 'undefined' && FaChipPlayer.listBackends ? FaChipPlayer.listBackends().map(function (b) { return b.kind; }) : []; }
    catch (_) { return []; }
  }

  // ───── 路由（純函式）─────
  function route(rec, opts) {
    opts = opts || {};
    var k = kindOf(rec);
    if (!k) return { route: 'unknown', kind: '', reason: '這個檔案沒有種類（沒有副檔名）' };
    var chips = typeof opts.chipKinds === 'function' ? opts.chipKinds() : defaultChipKinds();
    if (chips.indexOf(k) >= 0) return { route: 'chip', kind: k };
    if (k === 'mid') return { route: 'midi', kind: k };
    if (AUDIO_KINDS[k]) return { route: 'audio', kind: k };
    if (VIDEO_KINDS[k]) return { route: 'video', kind: k };
    if (ROM_KINDS[k]) return { route: 'rom', kind: k };
    return { route: 'unknown', kind: k, reason: '這個檔案（種類：' + k + '）目前沒有播放方式' };
  }

  // ───── 計畫（純函式）：records 是曲庫全部紀錄（用來找來源的擷取產物）─────
  function planPlay(rec, records, opts) {
    var rt = route(rec, opts);
    if (rt.route === 'unknown') return { action: 'message', text: rt.reason };
    if (rt.route !== 'rom') return { action: 'play', route: rt.route, target: rec, others: [] };
    var kids = rec.key ? (records || []).filter(function (c) { return c && c.derivedFrom === rec.key && c.status === 'ok' && !c.pending; }) : [];
    kids.sort(function (a, b) { return (a.derivedIndex || 0) - (b.derivedIndex || 0); });
    var playable = kids.filter(function (c) { var x = route(c, opts).route; return x !== 'unknown' && x !== 'rom'; });
    if (playable.length) return { action: 'play-child', route: route(playable[0], opts).route, target: playable[0], others: playable.slice(1) };
    if (kids.length) return { action: 'message', text: '擷取產物（' + kids.length + ' 個）都沒有播放方式' };
    return { action: 'extract', target: rec };
  }

  // 擷取結果（單筆）→ 給人看的失敗原因；成功或沿用就回傳空字串
  function stageName(s) { return STAGE_ZH[s] || (s ? String(s) : '未進入任何階段'); }
  function extractFailure(res) {
    if (!res) return '擷取沒有回傳結果';
    if (res.status === 'failed') return '擷取失敗（階段：' + stageName(res.stage) + '）：' + (res.reason || '沒有原因');
    if (res.status === 'cancelled') return '擷取已取消（階段：' + stageName(res.stage) + '）';
    return '';
  }

  // /media-play 的參數：空白分隔；雙引號、單引號、中文引號內的空白保留；反斜線照原樣（Windows 路徑）
  function parseArgs(text) {
    var s = String(text == null ? '' : text), out = [], cur = '', has = false, close = null;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (close) { if (ch === close) close = null; else cur += ch; continue; }
      if (PAIRS[ch]) { close = PAIRS[ch]; has = true; continue; }
      if (/\s/.test(ch)) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
      cur += ch; has = true;
    }
    if (has) out.push(cur);
    return out;
  }

  function fmtTime(sec) {
    var s = Math.max(0, Math.floor(Number(sec) || 0)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(x).padStart(2, '0');
  }
  function errText(e) { return String((e && e.message) || e); }

  // ───── DOM 卡片 ─────
  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  var BTN = 'cursor:pointer;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;border-radius:6px;padding:3px 9px;font-size:13px;margin:2px;';
  var CARD = 'border:1px solid rgba(128,128,128,.4);border-radius:10px;padding:10px;max-width:560px;font-size:13px;';

  function mediaCard(url, isVideo, name) {
    var wrap = el('div', 'display:flex;flex-direction:column;gap:6px;');
    var media = document.createElement(isVideo ? 'video' : 'audio');
    media.src = url; media.preload = 'metadata';
    if (isVideo) media.style.cssText = 'max-width:100%;display:block;';
    else media.style.display = 'none';
    var row = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
    var btn = el('button', BTN, '▶ 播放');
    var bar = document.createElement('input'); bar.type = 'range'; bar.min = '0'; bar.max = '1000'; bar.step = '1'; bar.value = '0';
    bar.style.cssText = 'flex:1;min-width:140px;';
    var time = el('span', 'font-size:12px;opacity:.75;white-space:nowrap;', '0:00 / 0:00');
    var err = el('div', 'color:#cf222e;font-size:12px;');
    var dragging = false;
    function dur() { return isFinite(media.duration) && media.duration > 0 ? media.duration : 0; }
    function paint() {
      var d = dur(), c = media.currentTime || 0;
      time.textContent = fmtTime(c) + ' / ' + fmtTime(d);
      if (!dragging && d) bar.value = String(Math.round((c / d) * 1000));
    }
    btn.onclick = function () { if (media.paused) { var p = media.play(); if (p && p.catch) p.catch(function (e) { err.textContent = '⚠️ 播放失敗：' + errText(e); }); } else media.pause(); };
    media.onplay = function () { btn.textContent = '⏸ 暫停'; };
    media.onpause = function () { btn.textContent = '▶ 播放'; };
    media.onended = function () { btn.textContent = '▶ 播放'; paint(); };
    media.ontimeupdate = paint;
    media.onloadedmetadata = paint;
    media.onerror = function () { err.textContent = '⚠️ 瀏覽器無法播放「' + name + '」（錯誤代碼 ' + (media.error ? media.error.code : '?') + '）'; };
    bar.oninput = function () { dragging = true; var d = dur(); time.textContent = fmtTime(d * Number(bar.value) / 1000) + ' / ' + fmtTime(d); };
    bar.onchange = function () { var d = dur(); if (d) media.currentTime = d * Number(bar.value) / 1000; dragging = false; paint(); };
    row.appendChild(btn); row.appendChild(bar); row.appendChild(time);
    wrap.appendChild(row); wrap.appendChild(media); wrap.appendChild(err);
    return wrap;
  }

  // 依計畫把 target 播出來（body 會先清空）；others 列成按鈕，點了切過去
  function showRoute(target, routeName, body, host, others) {
    body.textContent = '';
    var out = el('div');
    body.appendChild(out);
    if (others && others.length) {
      var sw = el('div', 'font-size:12px;opacity:.8;margin-bottom:4px;', '同一個來源的其他擷取產物（點了切換）：');
      body.insertBefore(sw, out);
      others.forEach(function (o) {
        var b = el('button', BTN, '▶ ' + (o.name || '子曲目'));
        b.onclick = function () { playRecord(o, body, host, { chipKinds: host.chipKinds }); };
        sw.appendChild(b);
      });
    }
    var p;
    if (routeName === 'chip') p = host.mountChip(target);
    else if (routeName === 'midi') p = host.mountMidi(target);
    else p = host.mediaUrl(target).then(function (url) { return mediaCard(url, routeName === 'video', target.name); });
    Promise.resolve(p).then(function (node) { out.appendChild(node); }, function (e) { out.appendChild(el('div', 'color:#cf222e;', '⚠️ 無法播放：' + errText(e))); });
  }

  function showMessage(body, text, color) { body.textContent = ''; body.appendChild(el('div', color ? 'color:' + color + ';' : 'color:#59636e;', text)); }

  // 播放一筆紀錄（來源 ROM 會先擷取，失敗就把階段與原因寫在卡片上）
  function playRecord(rec, body, host, opts) {
    var o = Object.assign({}, opts || {}, { chipKinds: host.chipKinds });
    var records = typeof host.records === 'function' ? host.records() : [];
    var plan = planPlay(rec, records, o);
    if (plan.action === 'message') return showMessage(body, '⚠️ ' + plan.text, '#cf222e');
    if (plan.action === 'play') return showRoute(plan.target, plan.route, body, host, []);
    if (plan.action === 'play-child') return showRoute(plan.target, plan.route, body, host, plan.others);
    // extract：來源 ROM 還沒有擷取產物 → 當場擷取，再依結果播
    showMessage(body, '尚未擷取，擷取中…（' + (rec.name || '') + '）');
    Promise.resolve().then(function () { return host.extract(rec); }).then(function (res) {
      var r0 = res && res.results && res.results[0];
      var fail = extractFailure(r0);
      if (fail) return showMessage(body, '⚠️ ' + fail, '#cf222e');
      var again = planPlay(rec, typeof host.records === 'function' ? host.records() : [], o);
      if (again.action === 'play-child') return showRoute(again.target, again.route, body, host, again.others);
      if (again.action === 'message') return showMessage(body, '⚠️ ' + again.text, '#cf222e');
      showMessage(body, '⚠️ 擷取完成，但沒有可播放的子曲目' + (r0 && r0.reason ? '（' + r0.reason + '）' : ''), '#cf222e');
    }, function (e) { showMessage(body, '⚠️ 擷取出錯：' + errText(e), '#cf222e'); });
  }

  // 掛一張播放卡片；source 可以是曲庫紀錄，或 /media-play 的檔案（{ name, kind, path 或 file }）
  function mount(source, host) {
    host = host || {};
    var box = el('div', CARD); box.className = 'fa-mediaplay';
    box.appendChild(el('div', 'font-weight:600;margin-bottom:6px;', '🎵 ' + ((source && source.name) || '')));
    var body = el('div');
    box.appendChild(body);
    showMessage(body, '載入中…');
    Promise.resolve().then(function () {
      var need = route(source, { chipKinds: host.chipKinds }).route === 'rom' && typeof host.resolve === 'function';
      return need ? host.resolve(source) : source;
    }).then(function (rec) { playRecord(rec, body, host, {}); }, function (e) { showMessage(body, '⚠️ ' + errText(e), '#cf222e'); });
    return box;
  }

  return {
    route: route, planPlay: planPlay, parseArgs: parseArgs, extractFailure: extractFailure, stageName: stageName,
    kindOf: kindOf, fmtTime: fmtTime, mount: mount,
    AUDIO_KINDS: AUDIO_KINDS, VIDEO_KINDS: VIDEO_KINDS, ROM_KINDS: ROM_KINDS
  };
});
