// 遊戲包 .fagame(壓縮,可以持續編輯;設計見 DESIGN.edit-game.md §12)。zip(JSZip,跟 .deckpack 同一種做法):
//   manifest.yaml     格式版本、名稱、範本、維度、解析度、修改時間、檔案清單(大小與雜湊)
//   game.yaml         全域:interaction、input、vars、audio bus、起始場景
//   scenes/*.yaml     每個場景一檔(物件、磚塊地圖、路線、區域、對白、場景內規則)
//   prefabs/*.yaml    每個原型一檔;behaviors/*.yaml 每個行為一檔
//   assets/           素材(圖片原檔、wav／ogg;文件裡只有短名);assets.yaml 是素材清單(合成的聲音與歌曲只存參數)
//   uml/*.mmd         推導出來的 UML(唯讀)
//   editor/           編輯器狀態(步驟歷史、對話記錄、有效 prompt;選配,精簡匯出時不含)
//   README.md、PROMPT.md    怎麼打開、怎麼重建的 prompt
//   FaGamePack.create(JSZip) -> { pack(spec, o) -> Promise<Blob|Uint8Array>, open(bytes) -> Promise<{ spec, assets, editor, manifest, problems }> }
//   o: { assets:{ 檔名: Uint8Array }, editor:{ state, log, prompt }, lite:true(不含 editor)、uml:true(預設)、prompt:文字 }
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./game_core.js'), require('./game_uml.js')); else root.FaGamePack = factory((root.FaGame || (typeof FaGame !== 'undefined' ? FaGame : undefined)), (root.FaGameUml || (typeof FaGameUml !== 'undefined' ? FaGameUml : undefined))); })(typeof self !== 'undefined' ? self : this, function (G, U) {
  'use strict';
  const FORMAT = 1;
  const MIGRATIONS = {};   // 之後格式升版時:MIGRATIONS[舊版] = (doc) => doc
  function fnv(bytes) { let h = 2166136261 >>> 0; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); }
  const enc = (s) => new TextEncoder().encode(s), dec = (b) => new TextDecoder().decode(b);
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_\-.]/g, '_').slice(0, 60) || 'x';
  function create(JSZip) {
    async function pack(spec, o) {
      o = o || {}; const s = G.validate(spec).spec, n = G.nest(s), files = {}; const put = (name, text) => { files[name] = typeof text === 'string' ? enc(text) : text; };
      const assetsDoc = n.assets; put('assets.yaml', G.dump(assetsDoc || {}) + '\n');
      put('game.yaml', G.dump(Object.assign({}, n.game)) + '\n');
      Object.keys(n.scenes).forEach((id) => put('scenes/' + safe(id) + '.yaml', G.dump({ [id]: n.scenes[id] }) + '\n')); Object.keys(n.prefabs).forEach((id) => put('prefabs/' + safe(id) + '.yaml', G.dump({ [id]: n.prefabs[id] }) + '\n')); Object.keys(n.behaviors).forEach((id) => put('behaviors/' + safe(id) + '.yaml', G.dump({ [id]: n.behaviors[id] }) + '\n'));
      Object.keys(o.assets || {}).forEach((f) => put('assets/' + safe(f), o.assets[f]));
      if (o.uml !== false && U) { const u = U.all(s); Object.keys(u).forEach((f) => put('uml/' + f, u[f] + '\n')); }
      if (o.editor && !o.lite) { put('editor/state.json', JSON.stringify(o.editor.state || null)); put('editor/log.json', JSON.stringify(o.editor.log || [])); put('editor/prompt.txt', String(o.editor.prompt || '')); }
      put('README.md', '# ' + s.game.title + '\n\n用「/edit-game-' + (s.game.dimension === '3d' ? '3d' : '2d') + '」開啟這個 .fagame(拖進對話,或 /edit-game-' + (s.game.dimension === '3d' ? '3d' : '2d') + ' 加檔案)繼續編輯;匯出的遊戲在「套件」分頁。\n\n範本:' + (s.game.template || '(自訂)') + '。內容:' + G.of(s, 'scene').length + ' 個場景、' + G.of(s, 'prefab').length + ' 個原型、' + G.of(s, 'behavior').length + ' 個行為。\n');
      put('PROMPT.md', String(o.prompt || G.promptOf(s, [])) + '\n');
      const list = Object.keys(files).sort().map((f) => ({ path: f, bytes: files[f].length, hash: fnv(files[f]) }));
      const manifest = { format: FORMAT, kind: 'fagame', id: s.game.id, title: s.game.title, template: s.game.template, dimension: s.game.dimension, view: s.game.view, rev: s.rev, modified: o.modified || 'unspecified', lite: !!o.lite || !o.editor, files: list };
      const zip = new JSZip(); zip.file('manifest.yaml', G.dump(manifest) + '\n'); Object.keys(files).forEach((f) => zip.file(f, files[f]));
      return zip.generateAsync({ type: o.type || 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    }
    async function open(bytes) {
      const zip = await JSZip.loadAsync(bytes), read = async (name) => { const f = zip.file(name); return f ? dec(await f.async('uint8array')) : null; }; const Y = (typeof jsyaml !== 'undefined' ? jsyaml : (typeof require === 'function' ? require('js-yaml') : null)); if (!Y) { throw new Error('沒有 YAML 讀取器'); }
      const mtext = await read('manifest.yaml'); if (!mtext) { throw new Error('這不是遊戲包(沒有 manifest.yaml)'); } let manifest = Y.load(mtext); if (!manifest || manifest.kind !== 'fagame') { throw new Error('這不是遊戲包(manifest 的 kind 不是 fagame)'); }
      const problems = []; if (manifest.format > FORMAT) { throw new Error('這個遊戲包是較新的格式(' + manifest.format + '),請先更新助理'); }
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir); const doc = { game: Y.load(await read('game.yaml')) || {}, assets: Y.load((await read('assets.yaml')) || '{}') || {}, prefabs: {}, behaviors: {}, scenes: {} };
      for (const n of names) { const m = /^(scenes|prefabs|behaviors)\/.+\.yaml$/.exec(n); if (m) { const t = Y.load(await read(n)) || {}; Object.assign(doc[m[1]], t); } }
      (manifest.files || []).forEach((f) => { if (!zip.file(f.path)) { problems.push('少了檔案 ' + f.path); } });
      let m = manifest.format || 1; while (MIGRATIONS[m]) { doc.__migrated = true; Object.assign(doc, MIGRATIONS[m](doc)); m++; }
      const r = G.validate(G.flatten(doc)); (r.problems || []).slice(0, 5).forEach((p) => problems.push(p));
      const assets = {}; for (const n of names) { if (/^assets\//.test(n)) { assets[n.slice(7)] = await zip.file(n).async('uint8array'); } }
      let editor = null; if (zip.file('editor/state.json')) { try { editor = { state: JSON.parse(await read('editor/state.json')), log: JSON.parse((await read('editor/log.json')) || '[]'), prompt: (await read('editor/prompt.txt')) || '' }; } catch (e) { problems.push('編輯器狀態讀不了,已略過'); } }
      return { spec: r.spec, assets, editor, manifest, problems };
    }
    return { pack, open };
  }
  return { create, FORMAT, fnv };
});
