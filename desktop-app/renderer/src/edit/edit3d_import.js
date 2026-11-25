// /edit-3d-model、/edit-3d 的「📂 開啟」：一個 3D 場景檔（.yaml／.yml，就是 3D 編輯器自己的 YAML）或一個模型檔（.stl、.obj、.3mf、.fbx）→ 場景文件。
// 模型的轉換（跑在 worker 裡）由呼叫端注入：deps.convertModel(name, bytes) → Promise<{ ok, yaml, error }>；YAML 讀取的準備由 deps.prepare() 負責（載入 js-yaml）。
// glb、gltf 目前不支援（轉換器只認 stl、obj、3mf、fbx），會明講而不是假裝能讀。純函式：測試在 scripts/edit-tests/edit3d_import.test.js。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./edit3d_core.js'));
  else root.FaEdit3dImport = factory(root.FaEdit3d || (typeof FaEdit3d !== 'undefined' ? FaEdit3d : undefined));
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var YAML_EXT = /\.ya?ml$/i, MODEL_EXT = /\.(stl|obj|3mf|fbx)$/i, UNSUPPORTED = /\.(glb|gltf)$/i;
  var TYPES = [{ description: '3D 場景或模型', accept: {
    'application/x-3dscene+yaml': ['.yaml', '.yml'], 'model/stl': ['.stl'], 'model/obj': ['.obj'], 'model/3mf': ['.3mf'], 'model/fbx': ['.fbx']
  } }];

  // 檔名 → 'yaml' | 'model' | 'unsupported' | null
  function kindOf(name) {
    var n = String(name || '');
    if (YAML_EXT.test(n)) { return 'yaml'; }
    if (MODEL_EXT.test(n)) { return 'model'; }
    if (UNSUPPORTED.test(n)) { return 'unsupported'; }
    return null;
  }

  // bytes → 場景文件（spec）。不能讀就丟出可讀的錯誤。
  async function fromBytes(bytes, name, deps) {
    deps = deps || {};
    var kind = kindOf(name), u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (kind === 'unsupported') { throw new Error('目前不支援 glb／gltf 模型（能讀的是 stl、obj、3mf、fbx，或 3D 場景 .yaml）'); }
    if (!kind) { throw new Error('這個 3D 編輯器只能開 .yaml 場景或 stl、obj、3mf、fbx 模型'); }
    var stem = String(name || '').replace(/\.[^.]+$/, '').replace(/\.3dscene$/i, '').slice(0, 80);
    if (kind === 'yaml') {
      if (typeof deps.prepare === 'function') { await deps.prepare(); }
      var r = C.fromYaml(new TextDecoder('utf-8').decode(u));
      if (!r.ok) { throw new Error(r.error || '讀不了這個場景'); }
      if (stem && !r.spec.title) { r.spec.title = stem; }
      return r.spec;
    }
    // 模型：轉成場景 YAML，再照場景讀（同 /edit-3d-model 對話裡 file_id 的做法）
    if (typeof deps.convertModel !== 'function') { throw new Error('這裡還不能轉換 3D 模型'); }
    if (typeof deps.prepare === 'function') { await deps.prepare(); }
    var conv = await deps.convertModel(String(name || ''), u);
    if (!conv || !conv.ok) { throw new Error((conv && conv.error) || '讀不了這個模型'); }
    var m = C.fromYaml(conv.yaml);
    if (!m.ok) { throw new Error(m.error || '讀不了這個模型'); }
    if (stem) { m.spec.title = stem; }
    return m.spec;
  }

  return { kindOf: kindOf, fromBytes: fromBytes, TYPES: TYPES };
});
