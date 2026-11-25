// node scripts/edit-tests/svg_import.test.js -- /edit-svg 📂 開啟 .svg：整份變成一個圖形物件、安全檢查、錯誤訊息
const I = require('../../renderer/src/edit/svg_import.js');
const C = require('../../renderer/src/edit/edit_svg_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const enc = (s) => new TextEncoder().encode(s);

// 1. 有 viewBox：寬高取 viewBox，內容原樣保留
{
  const p = I.parseSvgText('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><circle cx="50" cy="50" r="40" fill="red"/></svg>');
  check('viewBox 解析成功', p.ok === true, p);
  check('viewBox 寬高', p.w === 200 && p.h === 100, p);
  check('內容保留', p.markup === '<circle cx="50" cy="50" r="40" fill="red"/>', p.markup);
}
// 2. viewBox 左上角不是 0：內容包 translate
{
  const p = I.parseSvgText('<svg viewBox="10 20 50 60"><rect width="5" height="5"/></svg>');
  check('viewBox 偏移會平移', p.ok && p.markup === '<g transform="translate(-10 -20)"><rect width="5" height="5"/></g>', p.markup);
  check('偏移後寬高', p.w === 50 && p.h === 60, p);
}
// 3. 沒有 viewBox：用 width／height
{
  const p = I.parseSvgText('<svg width="300px" height="150"><line x1="0" y1="0" x2="10" y2="10"/></svg>');
  check('width／height 當尺寸', p.ok && p.w === 300 && p.h === 150, p);
}
// 4. 什麼尺寸都沒有：預設 400×400
{
  const p = I.parseSvgText('<svg><rect width="1" height="1"/></svg>');
  check('預設尺寸', p.ok && p.w === 400 && p.h === 400, p);
}
// 5. 註解、DOCTYPE（含內部子集）要拿掉
{
  const p = I.parseSvgText('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" [ <!ENTITY x "y"> ]><!-- 註解 --><svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>');
  check('去掉 DOCTYPE 與註解', p.ok && p.markup === '<rect width="5" height="5"/>', p);
}
// 6. 安全檢查：腳本、事件、外部連結、javascript: 都拒絕，並說明
{
  const s1 = I.parseSvgText('<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>');
  check('script 拒絕', s1.ok === false && s1.problems.some((x) => /script/.test(x)), s1);
  const s2 = I.parseSvgText('<svg viewBox="0 0 10 10"><rect width="5" height="5" onclick="x()"/></svg>');
  check('事件屬性拒絕', s2.ok === false && s2.problems.some((x) => /event/.test(x)), s2);
  const s3 = I.parseSvgText('<svg viewBox="0 0 10 10"><image href="https://example.com/a.png" width="5" height="5"/></svg>');
  check('外部連結拒絕', s3.ok === false && s3.problems.some((x) => /links/.test(x)), s3);
  const s4 = I.parseSvgText('<svg viewBox="0 0 10 10"><a href="javascript:alert(1)"><rect width="5" height="5"/></a></svg>');
  check('javascript: 拒絕', s4.ok === false, s4);
  const s5 = I.parseSvgText('<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>');
  check('安全的圖通過', s5.ok === true);
}
// 7. 不是 SVG
{
  const p = I.parseSvgText('<html><body>hi</body></html>');
  check('沒有 svg 根元素', p.ok === false && /svg/.test(p.problems[0]), p);
}
// 8. 文件：物件變成一個 svg 物件，canvas 來自空白起手式，匯出能組出原本的內容
{
  const spec = I.specFromText('<svg viewBox="0 0 200 100"><circle cx="50" cy="50" r="40" fill="red"/></svg>', '紅圓.svg');
  check('文件標題取檔名', spec.title === '紅圓', spec.title);
  const objs = spec.objects || [];
  check('一個 svg 物件', objs.length === 1 && objs[0].type === 'svg' && objs[0].w === 200 && objs[0].h === 100, objs);
  check('文件可再通過驗證', C.validate(spec).problems.length === 0, C.validate(spec).problems);
  const out = C.compose(spec, { resolve: function () { return null; } });
  check('匯出含原圖', /<circle cx="50" cy="50" r="40" fill="red"\/>/.test(out), out && out.slice(0, 200));
}
// 9. 文件：壞檔丟出可讀的錯誤
{
  let err = null; try { I.specFromText('<script>x</script>', 'x.svg'); } catch (e) { err = e; }
  check('壞檔丟錯並說明', err && /讀不了這個 SVG/.test(err.message), err && err.message);
}
// 10. fromBytes：副檔名不對拒絕；位元組可以正常讀
{
  let err = null; try { I.fromBytes(enc('<svg/>'), 'a.png'); } catch (e) { err = e; }
  check('非 .svg 拒絕', err && /不是 \.svg/.test(err.message), err && err.message);
  const spec = I.fromBytes(enc('<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'), 'a.SVG');
  check('大寫副檔名可讀', spec.objects.length === 1 && spec.objects[0].type === 'svg');
}

console.log('svg_import: ' + ok + ' 通過，' + bad.length + ' 失敗');
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
