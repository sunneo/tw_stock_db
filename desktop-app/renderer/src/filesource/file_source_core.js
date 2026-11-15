// 斜線指令的「檔案來源」純函式層 FaFileSource(只依賴傳進來的訊息陣列,不碰 DOM、不碰主程式)。
//   FaFileSource.collect(messages, { midi, attachRe }) → [{ label, item }]   對話裡最近的候選(新的在前、同一首去重)
//     midi: true → 認播放卡片 ```fa-midi、編輯器 ```fa-midi-edit 的曲子(item.type='midi'、item.id、item.title、item.b64)
//     attachRe: RegExp → 認使用者附件(item.type='attachment'、item.id=file_id、item.name=檔名),只留檔名符合的
//   FaFileSource.labels(items) → 給卡片用的「對話中的：…」選項文字（順序同 items）
//   FaFileSource.pick(answer, items) → 卡片回答 → { kind:'item', item } | { kind:'upload' } | { kind:'local' } | null
//   常數 FaFileSource.UPLOAD_LABEL／LOCAL_LABEL／CANCEL_LABEL 是卡片上固定的三個選項。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaFileSource = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const UPLOAD_LABEL = '上傳檔案（存進檔案庫）';
  const LOCAL_LABEL = '選本機檔案';
  const CANCEL_LABEL = '取消';
  const MAX_ITEMS = 8;

  // 讀出一段訊息文字裡的附件:[附件：a.mid（file_id=xxx）、b.mp3（file_id=yyy）]
  function attachmentsIn(text) {
    const out = []; const m = /\[附件：([^\]]*)\]/.exec(String(text || '')); if (!m) return out;
    const re = /([^、（]+?)（file_id=([\w-]+)）/g; let x; while ((x = re.exec(m[1]))) out.push({ name: x[1].trim(), id: x[2] });
    return out;
  }

  // 讀出一段訊息文字裡的 MIDI 區塊(播放卡片／編輯器)
  function midiBlocksIn(text) {
    const out = []; const re = /```fa-midi(-edit)?[ \t]*\n([\s\S]*?)```/g; let m;
    while ((m = re.exec(String(text || '')))) {
      let ref = null; try { ref = JSON.parse(m[2]); } catch (_) { ref = null; }
      if (ref && ref.id) out.push({ id: String(ref.id), title: String(ref.title || 'MIDI'), b64: ref.b64 || null, editor: !!m[1] });
    }
    return out;
  }

  function collect(messages, o) {
    o = o || {}; const list = Array.isArray(messages) ? messages : [];
    const seen = new Set(); const items = [];
    for (let i = list.length - 1; i >= 0 && items.length < MAX_ITEMS; i--) {
      const msg = list[i]; if (!msg) continue; const text = typeof msg.content === 'string' ? msg.content : '';
      if (o.midi) {
        for (const b of midiBlocksIn(text)) {
          const key = 'midi:' + b.id; if (seen.has(key)) continue; seen.add(key);
          items.push({ label: b.title + (b.editor ? '（MIDI 編輯器）' : '（MIDI 播放卡片）'), item: { type: 'midi', id: b.id, title: b.title, b64: b.b64 } });
        }
      }
      if (o.attachRe) {
        for (const a of attachmentsIn(text)) {
          if (!o.attachRe.test(a.name)) continue;
          const key = 'file:' + a.id; if (seen.has(key)) continue; seen.add(key);
          items.push({ label: a.name + '（附件）', item: { type: 'attachment', id: a.id, name: a.name } });
        }
      }
    }
    return items.slice(0, MAX_ITEMS);
  }

  function labels(items) { return (items || []).map((x) => '對話中的：' + x.label); }

  // 卡片回答 → 結果。answer 是卡片上按的選項文字；不在清單內或取消 → null
  function pick(answer, items) {
    const list = items || []; const a = String(answer == null ? '' : answer);
    if (a === CANCEL_LABEL) return null;
    if (a === UPLOAD_LABEL) return { kind: 'upload' };
    if (a === LOCAL_LABEL) return { kind: 'local' };
    const k = labels(list).indexOf(a); if (k < 0) return null;
    return { kind: 'item', item: list[k].item };
  }

  return { collect, labels, pick, attachmentsIn, midiBlocksIn, UPLOAD_LABEL, LOCAL_LABEL, CANCEL_LABEL };
});
