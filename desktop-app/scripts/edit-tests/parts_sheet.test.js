// node scripts/edit-tests/parts_sheet.test.js -- 零件表 → 工程圖 SVG（程式畫，不用模型）
const P = require('../../renderer/src/edit/parts_sheet.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const md = [
  '| 零件 | 名稱 | 數量 | 長 × 寬 × 厚（cm） | 備註 |', '|---|---|---|---|---|',
  '| A | 上板（Top Plate） | 1 | 35.0 × 20.0（最寬）× 0.5 | 雙圓弧琴身外形 |', '| B | 下板（Back Plate） | 1 | 35.0 × 20.0（最寬）× 0.5 | 與上板相同 |',
  '| C1 | 上側板條（Rib, Upper） | 2 | 20.0 × 3.0 × 0.5 | 貼合上圓弧 |', '| G | 馬鈴（Bridge） | 1 | 4.0（高）× 3.0（寬）× 0.3 | 直立於琴身中央 |', '| I | 琴弓 | 1 | 60.0 × 1.0 × 0.5 | 瓦楞紙條 |'
].join('\n');
const parts = P.parseParts(md);
check('parse: five parts, header and separator rows are skipped', parts.length === 5 && parts[0].id === 'A' && parts[4].id === 'I', parts.map((p) => p.id));
check('parse: length, width, thickness, quantity and note are read; the (最寬) remark inside the size does not break it', parts[0].w === 35 && parts[0].h === 20 && parts[0].t === 0.5 && parts[2].qty === 2 && parts[0].note === '雙圓弧琴身外形', parts[0]);
check('parse: "4.0（高）× 3.0（寬）× 0.3" reads as 4 × 3 × 0.3', parts[3].w === 4 && parts[3].h === 3 && parts[3].t === 0.3);
const tabbed = P.parseParts('A\t上板\t1\t35 × 20 × 0.5\tx\nB\t下板\t2\t35 x 20 x 0.5\ty');
check('parse: tab separated rows and the letter x work too', tabbed.length === 2 && tabbed[1].qty === 2 && tabbed[1].w === 35);
check('parse: a table without sizes gives nothing', P.parseParts('| a | b |\n|---|---|\n| 1 | 2 |').length === 0 && P.parseParts('今天天氣很好').length === 0);
check('steps: numbered lines are read, size rows are not mistaken for steps', JSON.stringify(P.parseSteps('1. 剪下上下板\n2、貼側板\n3. 35 × 20 × 0.5')) === JSON.stringify(['剪下上下板', '貼側板']));
const out = P.svg(parts, { title: '瓦楞紙小提琴', steps: ['剪下上下板', '貼側板'] });
check('svg: a well formed document with every part, its sizes and the steps', /^<svg [^>]*viewBox/.test(out) && /<\/svg>$/.test(out) && out.indexOf('瓦楞紙小提琴') > 0 && out.split('class="part"').length - 1 === 5 && />35 cm</.test(out) && />20 cm</.test(out) && />60 cm</.test(out) && /組裝步驟/.test(out) && /1\. 剪下上下板/.test(out));
check('svg: drawn to one scale (the 35 cm plate is 35/60 of the 60 cm bow)', (() => { const w = [...out.matchAll(/class="part"/g)].length; const m = [...out.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="[\d.]+" class="part"/g)].map((x) => Number(x[1])); return w === 5 && Math.abs(m[0] / m[4] - 35 / 60) < 0.02; })());
check('svg: text is escaped', P.svg([{ id: 'A', name: '<b>"x"&', qty: 1, w: 10, h: 5, t: 1, note: '' }], {}).indexOf('<b>') < 0);
check('svg: nothing to draw gives an empty string', P.svg([], {}) === '');
check('engineering request words are recognised', P.isEngineeringRequest('幫我準備Cardboard Violin的工程圖，要有每個Component的長度，怎麼組裝') && P.isEngineeringRequest('畫一張零件尺寸圖') && !P.isEngineeringRequest('畫一隻貓'));
console.log('parts_sheet: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
