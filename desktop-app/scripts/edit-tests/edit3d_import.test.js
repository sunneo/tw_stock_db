// node scripts/edit-tests/edit3d_import.test.js -- /edit-3d 📂 開啟：場景 YAML、模型（注入的轉換器）、glb 明講不支援、錯誤傳遞
const I = require('../../renderer/src/edit/edit3d_import.js');
const C = require('../../renderer/src/edit/edit3d_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const enc = (s) => new TextEncoder().encode(s);

(async () => {
  // 1. 種類判斷
  check('yaml', I.kindOf('房間.3dscene.yaml') === 'yaml' && I.kindOf('a.yml') === 'yaml');
  check('模型', I.kindOf('a.STL') === 'model' && I.kindOf('b.obj') === 'model' && I.kindOf('c.3mf') === 'model' && I.kindOf('d.fbx') === 'model');
  check('glb／gltf 不支援', I.kindOf('e.glb') === 'unsupported' && I.kindOf('f.gltf') === 'unsupported');
  check('其他為 null', I.kindOf('g.png') === null && I.kindOf('noext') === null);

  // 2. 場景 YAML：用編輯器自己的格式往返
  const room = C.starter('room');
  const yamlText = C.toYaml(room);
  const spec = await I.fromBytes(enc(yamlText), '我的房間.3dscene.yaml', { prepare: async () => {} });
  check('YAML 讀回有物件', Array.isArray(spec.objects) && spec.objects.length === room.objects.length, { got: spec.objects && spec.objects.length, want: room.objects.length });
  check('YAML 讀回的文件可通過驗證', C.validate(spec).problems.length === 0, C.validate(spec).problems);

  // 3. 壞的 YAML → 可讀錯誤
  let e1 = null; try { await I.fromBytes(enc('nodes: [\n'), 'bad.yaml', {}); } catch (e) { e1 = e; }
  check('壞 YAML 丟錯', e1 && e1.message.length > 0, e1 && e1.message);

  // 4. 模型：注入的轉換器回 YAML → 讀成文件，標題取檔名，轉換的 name 正確
  let seen = null;
  const model = await I.fromBytes(enc('solid'), '椅子.stl', {
    prepare: async () => {},
    convertModel: async (name, bytes) => { seen = name; return { ok: true, yaml: yamlText }; }
  });
  check('模型交給轉換器的檔名', seen === '椅子.stl', seen);
  check('模型標題取檔名', model.title === '椅子', model.title);
  check('模型讀成物件', Array.isArray(model.objects) && model.objects.length > 0);

  // 5. 轉換器失敗 → 錯誤傳出來
  let e2 = null; try { await I.fromBytes(enc('x'), 'a.obj', { convertModel: async () => ({ ok: false, error: '面數太多' }) }); } catch (e) { e2 = e; }
  check('轉換失敗的原因傳出', e2 && e2.message === '面數太多', e2 && e2.message);

  // 6. glb：明講不支援，不去轉換
  let e3 = null, called = false; try { await I.fromBytes(enc('x'), 'a.glb', { convertModel: async () => { called = true; return { ok: true, yaml: '' }; } }); } catch (e) { e3 = e; }
  check('glb 明講不支援', e3 && /glb/.test(e3.message) && !called, e3 && e3.message);

  // 7. 沒有轉換器就不能讀模型
  let e4 = null; try { await I.fromBytes(enc('x'), 'a.fbx', {}); } catch (e) { e4 = e; }
  check('沒有轉換器就說明', e4 && /不能轉換/.test(e4.message), e4 && e4.message);

  // 8. 選檔類型
  check('選檔包含 yaml 與四種模型', I.TYPES[0].accept['model/stl'][0] === '.stl' && I.TYPES[0].accept['application/x-3dscene+yaml'].indexOf('.yaml') >= 0);

  console.log('edit3d_import: ' + ok + ' 通過，' + bad.length + ' 失敗');
  if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
