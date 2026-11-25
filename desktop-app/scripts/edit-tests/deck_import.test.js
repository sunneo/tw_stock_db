// node scripts/edit-tests/deck_import.test.js -- /edit-media-presentation 📂 開啟簡報 .deck.yaml：往返、#!fa:deck 標記、.pptx 明講不支援、壞檔
const I = require('../../renderer/src/deck/deck_import.js');
const D = require('../../renderer/src/deck/deck_edit_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const enc = (s) => new TextEncoder().encode(s);

// 1. 往返：編輯器匯出的 YAML 讀回來，標題與頁數一樣
{
  const spec = D.defaultSpec();
  spec.deck.title = '往返測試';
  const yamlText = D.toYaml(spec);
  const back = I.fromBytes(enc(yamlText), '往返測試.deck.yaml');
  check('往返：標題一樣', back.deck.title === '往返測試', back.deck.title);
  check('往返：頁數一樣', D.slides(back).length === D.slides(spec).length, { got: D.slides(back).length, want: D.slides(spec).length });
}
// 2. 帶 #!fa:deck 標記的檔也能讀
{
  const spec = D.defaultSpec();
  const back = I.fromBytes(enc('#!fa:deck v1\n' + D.toYaml(spec)), 'a.deck.yaml');
  check('#!fa:deck 標記不擋', back && back.deck && back.deck.title);
}
// 3. .pptx 明講不支援
{
  let e = null; try { I.fromBytes(enc('x'), '投影片.pptx'); } catch (x) { e = x; }
  check('pptx 明講不支援', e && /pptx/.test(e.message), e && e.message);
}
// 4. 其他副檔名拒絕
{
  let e = null; try { I.fromBytes(enc('x'), 'a.docx'); } catch (x) { e = x; }
  check('非簡報檔拒絕', e && /\.deck\.yaml/.test(e.message), e && e.message);
}
// 5. 壞的 YAML／沒有 chapters：可讀錯誤
{
  let e1 = null; try { I.fromBytes(enc('deck: [\n'), 'bad.deck.yaml'); } catch (x) { e1 = x; }
  check('壞 YAML 丟錯', e1 && e1.message.length > 0, e1 && e1.message);
  let e2 = null; try { I.fromBytes(enc('deck:\n  title: x\n'), 'nochap.deck.yaml'); } catch (x) { e2 = x; }
  check('沒有 chapters 丟錯並說明', e2 && /chapters/.test(e2.message), e2 && e2.message);
}
// 6. 選檔設定
check('選檔類型含 .deck.yaml', I.TYPES[0].accept['text/yaml'].indexOf('.deck.yaml') >= 0);

console.log('deck_import: ' + ok + ' 通過，' + bad.length + ' 失敗');
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
