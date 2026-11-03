// 音樂領域:虛擬鋼琴 FaVirtualPiano(純邏輯＋一個 DOM 元件;合成器由 host 注入,node 可測純邏輯)。
// 做法參考 piano-web(piano-html)的操作方式:雙排電腦鍵盤當琴鍵、按 Shift 可另綁一組、獨立的「鍵位設定」畫面(核取方塊選要顯示哪幾個八度,
// 在畫面上點一個琴鍵再按電腦鍵盤就綁定)、可匯出入。程式是照這個操作流程自己寫的,沒有複製 piano-web 的原始碼;
// 鍵位用 KeyboardEvent.code(實體按鍵位置),不受輸入法／鍵盤排列影響。
//   FaVirtualPiano.mount({ host, storage, title }) → DOM 節點
//   host = { noteOn(midi, vel), noteOff(midi) }(可選 allOff());節點上的 _vpiano = { setActive(on), destroy(), getState() }
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaVirtualPiano = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const STORE_KEY = 'fa_vpiano_v1', TYPE = 'fa-virtual-piano-keybindings';
  const ALL_OCTAVES = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const OCT_LABEL = { 0: 'A0–B0(超低音)', 1: 'C1–B1(低音)', 2: 'C2–B2', 3: 'C3–B3', 4: 'C4–B4(中央)', 5: 'C5–B5', 6: 'C6–B6', 7: 'C7–B7(高音)', 8: 'C8(最高)' };
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);
  const isBlack = (m) => NAMES[m % 12].indexOf('#') >= 0;
  // 預設鍵位(電腦鍵盤常見的兩排鋼琴排列:下排白鍵＋上一排黑鍵,往上再一組):C4–G6
  const DEFAULT_KEYS = { KeyZ: 60, KeyS: 61, KeyX: 62, KeyD: 63, KeyC: 64, KeyV: 65, KeyG: 66, KeyB: 67, KeyH: 68, KeyN: 69, KeyJ: 70, KeyM: 71,
    KeyQ: 72, Digit2: 73, KeyW: 74, Digit3: 75, KeyE: 76, KeyR: 77, Digit5: 78, KeyT: 79, Digit6: 80, KeyY: 81, Digit7: 82, KeyU: 83,
    KeyI: 84, Digit9: 85, KeyO: 86, Digit0: 87, KeyP: 88, BracketLeft: 89, Equal: 90, BracketRight: 91 };
  const defaults = () => ({ octaves: [3, 4, 5, 6], keys: Object.assign({}, DEFAULT_KEYS), shiftKeys: {} });
  const CODE_LABEL = { Comma: ',', Period: '.', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', Slash: '/', Backslash: '\\', Backquote: '`', Space: '␣', Enter: '↵' };
  function keyLabel(code) { code = String(code || ''); if (CODE_LABEL[code]) return CODE_LABEL[code]; let m = /^Key([A-Z])$/.exec(code); if (m) return m[1]; m = /^Digit(\d)$/.exec(code); if (m) return m[1]; m = /^Numpad(.+)$/.exec(code); if (m) return 'N' + m[1]; return code.slice(0, 6); }
  // 要顯示的音(MIDI 21–108,即 A0–C8)
  function visibleNotes(octaves) {
    const set = new Set(octaves || []); const out = [];
    for (let m = 21; m <= 108; m++) if (set.has(Math.floor(m / 12) - 1)) out.push({ midi: m, name: noteName(m), black: isBlack(m) });
    return out;
  }
  function clone(st) { return { octaves: st.octaves.slice(), keys: Object.assign({}, st.keys), shiftKeys: Object.assign({}, st.shiftKeys) }; }
  // 綁定:同一張表裡,這個鍵原本綁的別的音要解除(一鍵一音),這個音原本的舊鍵也要解除(一音在一張表最多一個鍵)。回傳新狀態,不改原物件
  function bind(st, code, shift, midi) {
    const n = clone(st); const t = shift ? n.shiftKeys : n.keys; midi = Math.round(Number(midi));
    if (!code || !(midi >= 0 && midi <= 127)) return n;
    Object.keys(t).forEach((k) => { if (k === code || t[k] === midi) delete t[k]; }); t[code] = midi; return n;
  }
  function unbind(st, midi, shift) { const n = clone(st); const t = shift ? n.shiftKeys : n.keys; Object.keys(t).forEach((k) => { if (t[k] === midi) delete t[k]; }); return n; }
  // 按鍵 → 音:按著 Shift 先查 Shift 那張表,沒有再退回主表(不會因為按著 Shift 就突然沒聲音)
  function noteFor(st, code, shift) { if (shift && st.shiftKeys[code] != null) return st.shiftKeys[code]; return st.keys[code] != null ? st.keys[code] : null; }
  function labelsOf(st, midi) { const f = (t) => Object.keys(t).filter((k) => t[k] === midi).map(keyLabel).join('/'); return { plain: f(st.keys), shift: f(st.shiftKeys) }; }
  function validate(o) {
    const d = defaults(); if (!o || typeof o !== 'object') return d;
    const oct = Array.isArray(o.octaves) ? o.octaves.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x <= 8).filter((x, i, a) => a.indexOf(x) === i).sort((a, b) => a - b) : d.octaves;
    const tab = (t, fallback) => { if (!t || typeof t !== 'object') return fallback; const r = {}; Object.keys(t).slice(0, 200).forEach((k) => { const v = Number(t[k]); if (/^[A-Za-z0-9]{1,20}$/.test(k) && Number.isInteger(v) && v >= 0 && v <= 127) r[k] = v; }); return r; };
    return { octaves: oct, keys: tab(o.keys, d.keys), shiftKeys: tab(o.shiftKeys, {}) };
  }
  const serialize = (st) => JSON.stringify({ type: TYPE, version: 1, octaves: st.octaves, keys: st.keys, shiftKeys: st.shiftKeys }, null, 1);
  function parse(text) { let o; try { o = JSON.parse(String(text)); } catch (_) { return { error: '不是有效的 JSON' }; } if (!o || o.type !== TYPE || typeof o.keys !== 'object') return { error: '不是虛擬鋼琴的鍵位設定(type 不符)' }; return { state: validate(o) }; }

  // ───────── DOM
  const BTN = 'cursor:pointer;border:1px solid rgba(128,128,128,.5);background:transparent;color:inherit;border-radius:6px;padding:3px 9px;font-size:13px;';
  const el = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  const typing = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  function mount(opts) {
    opts = opts || {}; const host = opts.host || {}; let storage = opts.storage; if (storage === undefined) { try { storage = typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { storage = null; } }
    let st = defaults(); try { const r = storage && storage.getItem(STORE_KEY); if (r) st = validate(JSON.parse(r)); } catch (_) { /* 沒存過或讀不到就用預設 */ }
    const save = () => { try { if (storage) storage.setItem(STORE_KEY, JSON.stringify(st)); } catch (_) { /* 存不了不影響使用 */ } };
    let active = false, configuring = false, selMidi = null, snapshot = null, destroyed = false; const down = new Map(), lit = new Set(); // down: 實體鍵 code → midi(放開時送對應的 noteOff,就算中途 Shift 變了)
    const box = el('div', 'border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:6px;margin-top:8px;'); box.className = 'fa-vpiano';
    const bar = el('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;'); bar.appendChild(el('b', 'flex:1;min-width:80px;font-size:13px;', '🎹 ' + (opts.title || '虛擬鋼琴')));
    const cfgB = el('button', BTN, '⚙ 鍵位設定'); cfgB.title = '選要顯示哪幾個八度,並自訂電腦鍵盤的按鍵對應'; bar.appendChild(cfgB); box.appendChild(bar);
    const view = el('div', 'overflow-x:auto;padding-bottom:4px;'); box.appendChild(view); const hint = el('div', 'font-size:11px;opacity:.7;margin-top:4px;', '用電腦鍵盤彈奏(按著 Shift 可彈另一組綁定),或直接點／觸碰琴鍵。'); box.appendChild(hint);
    const cfg = el('div', 'display:none;margin-top:6px;border-top:1px dashed rgba(128,128,128,.5);padding-top:6px;'); box.appendChild(cfg);

    const keyEls = new Map();
    function renderKeys(into, onPress, onRelease) {
      into.textContent = ''; keyEls.set(into, new Map()); const row = el('div', 'display:flex;min-width:min-content;height:96px;user-select:none;touch-action:none;'); const notes = visibleNotes(st.octaves);
      if (!notes.length) { into.appendChild(el('div', 'opacity:.7;font-size:12px;padding:8px;', '沒有勾選任何八度,請到「鍵位設定」勾選要顯示的音域。')); return; }
      const set = new Set(notes.map((n) => n.midi));
      notes.forEach((n) => {
        if (n.black) return; const w = el('div', 'position:relative;width:30px;flex:0 0 30px;height:100%;box-sizing:border-box;border:1px solid #888;border-radius:0 0 4px 4px;background:#fff;color:#222;display:flex;align-items:flex-end;justify-content:center;font-size:9px;text-align:center;cursor:pointer;'); w.dataset.midi = n.midi;
        const lab = labelsOf(st, n.midi); w.appendChild(el('span', 'line-height:1.1;padding-bottom:2px;pointer-events:none;', (lab.plain || '') + (lab.shift ? '\n⇧' + lab.shift : '') + '\n' + n.name)); w.firstChild.style.whiteSpace = 'pre'; keyEls.get(into).set(n.midi, w);
        if (set.has(n.midi + 1) && isBlack(n.midi + 1)) { const b = el('div', 'position:absolute;top:-1px;right:-10px;width:20px;height:60%;z-index:2;background:#222;color:#eee;border-radius:0 0 3px 3px;display:flex;align-items:flex-end;justify-content:center;font-size:8px;text-align:center;cursor:pointer;'); b.dataset.midi = n.midi + 1; const lb = labelsOf(st, n.midi + 1); b.appendChild(el('span', 'line-height:1.05;padding-bottom:2px;pointer-events:none;white-space:pre;', (lb.plain || '') + (lb.shift ? '\n⇧' + lb.shift : ''))); keyEls.get(into).set(n.midi + 1, b); w.appendChild(b); }
        row.appendChild(w);
      });
      // 開頭是黑鍵(例如只勾 A0–B0 之後第一個是 A,正常;若第一個音是黑鍵,前面補一個空白白鍵位置)——這裡的音域都從 C 或 A 起,不會發生
      row.onpointerdown = (ev) => { const t = ev.target.closest && ev.target.closest('[data-midi]'); if (!t) return; ev.preventDefault(); const m = Number(t.dataset.midi); try { t.setPointerCapture(ev.pointerId); } catch (_) { /* */ } t._m = m; onPress(m); };
      row.onpointerup = row.onpointercancel = (ev) => { const t = ev.target.closest && ev.target.closest('[data-midi]'); if (t && t._m != null) { onRelease(t._m); t._m = null; } };
      into.appendChild(row);
    }
    const paint = (m, on) => { keyEls.forEach((mp) => { const k = mp.get(m); if (k) k.style.filter = on ? 'brightness(.7) sepia(1) hue-rotate(170deg) saturate(3)' : ''; }); };
    const press = (m, vel) => { if (lit.has(m)) return; lit.add(m); paint(m, true); try { if (host.noteOn) host.noteOn(m, vel || 100); } catch (_) { /* */ } };
    const release = (m) => { if (!lit.has(m)) return; lit.delete(m); paint(m, false); try { if (host.noteOff) host.noteOff(m); } catch (_) { /* */ } };
    const releaseAll = () => { Array.from(lit).forEach(release); down.clear(); };
    function drawMain() { renderKeys(view, press, release); lit.forEach((m) => paint(m, true)); }

    // 鍵位設定畫面:核取方塊選八度、點琴鍵再按電腦鍵、匯出入、還原
    function drawCfg() {
      cfg.textContent = ''; cfg.appendChild(el('b', 'font-size:12px;', '顯示哪幾個八度(可多選)'));
      const q = el('div', 'display:flex;gap:4px;margin:4px 0;'); const all = el('button', BTN + 'font-size:11px;padding:1px 8px;', '全選'), none = el('button', BTN + 'font-size:11px;padding:1px 8px;', '全不選'); all.onclick = () => { st.octaves = ALL_OCTAVES.slice(); sync(); }; none.onclick = () => { st.octaves = []; sync(); }; q.append(all, none); cfg.appendChild(q);
      const cks = el('div', 'display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;');
      ALL_OCTAVES.forEach((o) => { const lb = el('label', 'display:flex;align-items:center;gap:3px;cursor:pointer;'); const c = el('input'); c.type = 'checkbox'; c.checked = st.octaves.indexOf(o) >= 0; c.onchange = () => { st.octaves = c.checked ? st.octaves.concat(o).sort((a, b) => a - b) : st.octaves.filter((x) => x !== o); sync(); }; lb.append(c, document.createTextNode(OCT_LABEL[o])); cks.appendChild(lb); }); cfg.appendChild(cks);
      cfg.appendChild(el('div', 'height:6px'));
      const h = el('div', 'font-size:12px;margin:4px 0;'); h.className = 'fa-vp-hint'; cfg.appendChild(h); const kv = el('div', 'overflow-x:auto;'); cfg.appendChild(kv);
      const hintText = () => { h.textContent = selMidi == null ? '先點一下下面的琴鍵選要綁定的音,再按電腦鍵盤的按鍵(搭配 Shift 綁到另一組)。選了琴鍵後按 Delete／Backspace 可解除綁定。' : '已選 ' + noteName(selMidi) + ',請按下想綁定的電腦按鍵(可搭配 Shift)。'; };
      const drawCfgKeys = () => { renderKeys(kv, (m) => { selMidi = m; hintText(); drawCfgKeys(); }, () => {}); if (selMidi != null) { const k = keyEls.get(kv) && keyEls.get(kv).get(selMidi); if (k) k.style.outline = '3px solid #ff7a59'; } };
      drawCfgKeys(); hintText(); cfg._redraw = drawCfgKeys;
      const io = el('div', 'margin-top:6px;'); const ta = el('textarea', 'width:100%;height:56px;font-size:11px;box-sizing:border-box;display:none;'); ta.placeholder = '匯出的內容會顯示在這裡;要匯入就把設定貼在這裡再按「匯入」';
      const exB = el('button', BTN, '📤 匯出'), imB = el('button', BTN + 'margin-left:6px;', '📥 匯入'); exB.onclick = () => { ta.style.display = ''; ta.value = serialize(st); ta.select(); }; imB.onclick = () => { if (ta.style.display === 'none') { ta.style.display = ''; ta.value = ''; ta.focus(); return; } const r = parse(ta.value); if (r.error) { hint.textContent = '⚠️ ' + r.error; return; } st = r.state; hint.textContent = '已匯入'; sync(); };
      io.append(exB, imB, ta); cfg.appendChild(io);
      const act = el('div', 'display:flex;gap:6px;margin-top:8px;justify-content:flex-end;'); const rs = el('button', BTN, '還原'), ca = el('button', BTN, '取消'), ok = el('button', BTN + 'background:#4aa3ff;color:#fff;', '完成');
      rs.title = '還原成開啟設定時的樣子'; rs.onclick = () => { st = validate(snapshot); sync(); }; const dflt = el('button', BTN, '預設'); dflt.title = '全部改回預設鍵位與八度'; dflt.onclick = () => { st = defaults(); sync(); };
      ca.onclick = () => { st = validate(snapshot); closeCfg(); }; ok.onclick = () => closeCfg(); act.append(dflt, rs, ca, ok); cfg.appendChild(act);
    }
    function sync() { save(); drawMain(); if (configuring) drawCfg(); }
    function openCfg() { configuring = true; snapshot = clone(st); selMidi = null; releaseAll(); cfg.style.display = ''; cfgB.textContent = '⚙ 設定中…'; drawCfg(); }
    function closeCfg() { configuring = false; selMidi = null; cfg.style.display = 'none'; cfgB.textContent = '⚙ 鍵位設定'; sync(); }
    cfgB.onclick = () => { if (configuring) closeCfg(); else openCfg(); };

    // 電腦鍵盤(只在面板開著時接手;在輸入框打字時不攔)
    function onKeyDown(e) {
      if (!active || destroyed) return;
      if (configuring) { // 設定中:攔下按鍵拿來綁定,不發聲
        if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || typing(e.target)) return; e.preventDefault(); e.stopPropagation(); if (selMidi == null) return;
        if (e.code === 'Delete' || e.code === 'Backspace') { st = unbind(unbind(st, selMidi, false), selMidi, true); } else if (e.code !== 'Escape') st = bind(st, e.code, e.shiftKey, selMidi);
        sync(); return;
      }
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const m = noteFor(st, e.code, e.shiftKey); if (m == null) return; e.preventDefault(); down.set(e.code, m); press(m, 100);
    }
    function onKeyUp(e) { if (!active || destroyed) return; const m = down.get(e.code); if (m == null) return; down.delete(e.code); release(m); }
    const onBlur = () => releaseAll();
    document.addEventListener('keydown', onKeyDown, true); document.addEventListener('keyup', onKeyUp, true); window.addEventListener('blur', onBlur);
    drawMain();
    box._vpiano = {
      setActive(on) { active = !!on; if (!active) { if (configuring) closeCfg(); releaseAll(); } },
      getState: () => clone(st), setState(s) { st = validate(s); sync(); },
      destroy() { destroyed = true; releaseAll(); document.removeEventListener('keydown', onKeyDown, true); document.removeEventListener('keyup', onKeyUp, true); window.removeEventListener('blur', onBlur); },
    };
    return box;
  }
  return { mount, defaults, DEFAULT_KEYS, ALL_OCTAVES, visibleNotes, bind, unbind, noteFor, labelsOf, keyLabel, noteName, serialize, parse, validate, STORE_KEY };
});
