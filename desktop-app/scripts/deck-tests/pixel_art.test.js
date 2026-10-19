// node scripts/deck-tests/pixel_art.test.js -- 點陣圖物件設計工具：驗證（指到欄位）、字母列、鏡射、繪圖指令、自動亮暗部、外框、內建範例；純函式
const PA = require('../../renderer/src/deck/pixel_art.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const px = (img, x, y) => { const o = (y * img.width + x) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]]; };
const P = { a: '#ff0000', b: '#0000ff', c: '#00ff00' };
const errs = (spec) => PA.validate(spec).errors.join(' | ');

// ---------- 驗證：指到哪個欄位、怎麼改 ----------
check('validate: not an object', /an object/.test(errs(null)) && /an object/.test(errs([1])));
check('validate: a palette is needed and its keys are one character that is not . or space', /palette: an object/.test(errs({ rows: ['aa'] })) && /ONE character/.test(errs({ palette: { ab: '#ff0000' }, rows: ['aa'] })) && /ONE character/.test(errs({ palette: { '.': '#ff0000' }, rows: ['aa'] })));
check('validate: a colour is #rrggbb', /palette\["a"\]: a colour/.test(errs({ palette: { a: 'red' }, rows: ['aaaa'] })) && /palette\["a"\]/.test(errs({ palette: { a: '#fff' }, rows: ['aaaa'] })));
check('validate: a row character that is not in the palette is named with its row and column', /rows\[1\] column 2: "z" is not in the palette/.test(errs({ palette: P, rows: ['aaaa', 'aazz', 'aaaa', 'aaaa'] })));
check('validate: size, mirror, ops, outline, shade', /size: \[width, height\]/.test(errs({ palette: P, size: [2, 40] })) && /mirror: x, y or xy/.test(errs({ palette: P, rows: ['aaaa', 'aaaa', 'aaaa', 'aaaa'], mirror: 'z' })) && /ops\[0\]\.op: one of/.test(errs({ palette: P, size: [8, 8], ops: [{ op: 'spray' }] })) && /outline: true or a colour/.test(errs({ palette: P, size: [8, 8], outline: 'black' })) && /shade: true or false/.test(errs({ palette: P, size: [8, 8], shade: 'yes' })));
check('validate: an op needs whole numbers, a palette character and a point inside the picture', /ops\[0\]\.w: a whole number/.test(errs({ palette: P, size: [8, 8], ops: [{ op: 'rect', x: 0, y: 0, h: 2, c: 'a' }] })) && /ops\[0\]\.c: a palette character/.test(errs({ palette: P, size: [8, 8], ops: [{ op: 'dot', x: 1, y: 1, c: 'q' }] })) && /ops\[0\]\.x: inside the picture \(0\.\.7\)/.test(errs({ palette: P, size: [8, 8], ops: [{ op: 'dot', x: 9, y: 1, c: 'a' }] })));
check('validate: at most 40 ops, and a picture needs a size (from size or rows)', /at most 40/.test(errs({ palette: P, size: [8, 8], ops: new Array(41).fill({ op: 'dot', x: 1, y: 1, c: 'a' }) })) && /give size/.test(errs({ palette: P })));
check('validate: a good spec is ok', PA.validate({ palette: P, rows: ['.aa.', 'abba', 'abba', '.aa.'], shade: true, outline: true }).ok);
check('validate: errors are limited so the model gets a short list', PA.validate({ palette: P, rows: new Array(10).fill('zzzzzzzzzz') }).errors.length <= 12);

// ---------- 字母列、鏡射 ----------
const r1 = PA.render({ palette: P, rows: ['.aa.', 'abba', 'abba', '.aa.'] });
check('render: rows draw one pixel per character, . is transparent', r1.width === 4 && r1.height === 4 && px(r1, 0, 0)[3] === 0 && px(r1, 1, 0).join() === '255,0,0,255' && px(r1, 1, 1).join() === '0,0,255,255');
check('render: the ascii preview shows the pixels back (palette characters, . for transparent)', r1.ascii.join('/') === '.aa./abba/abba/.aa.', r1.ascii);
const m = PA.render({ palette: P, mirror: 'x', rows: ['..ab', '.aab', 'aabb', '.aab'] });
check('render: mirror x draws the left half and mirrors it to the right', m.width === 8 && m.height === 4 && px(m, 2, 0).join() === px(m, 5, 0).join() && px(m, 3, 0).join() === px(m, 4, 0).join() && px(m, 0, 2).join() === px(m, 7, 2).join());
const m2 = PA.render({ palette: P, mirror: 'y', rows: ['aaaa', 'abba'] });
check('render: mirror y makes the bottom half; xy both', m2.height === 4 && m2.ascii[3] === 'aaaa' && m2.ascii[2] === 'abba' && PA.render({ palette: P, mirror: 'xy', rows: ['ab', 'ba'] }).ascii.join('/') === 'abba/baab/baab/abba', m2.ascii);
check('render: a short row is padded with transparent and a size larger than the rows is allowed', (() => { const r = PA.render({ palette: P, size: [8, 8], rows: ['aa'] }); return r.width === 8 && r.height === 8 && px(r, 1, 0)[3] === 255 && px(r, 5, 0)[3] === 0; })());

// ---------- 繪圖指令 ----------
const op = (o, size) => PA.render({ palette: P, size: size || [12, 12], ops: [o] });
check('ops: rect fills; fill false draws only the border', (() => { const a = op({ op: 'rect', x: 2, y: 2, w: 5, h: 4, c: 'a' }), b = op({ op: 'rect', x: 2, y: 2, w: 5, h: 4, c: 'a', fill: false }); return px(a, 4, 3)[3] === 255 && px(b, 4, 3)[3] === 0 && px(b, 2, 2)[3] === 255 && px(b, 6, 5)[3] === 255; })());
check('ops: a line joins its two ends (also diagonal)', (() => { const a = op({ op: 'line', x1: 1, y1: 1, x2: 9, y2: 1, c: 'b' }), d = op({ op: 'line', x1: 0, y1: 0, x2: 7, y2: 7, c: 'b' }); return px(a, 1, 1)[3] === 255 && px(a, 9, 1)[3] === 255 && px(a, 5, 1)[3] === 255 && px(d, 3, 3)[3] === 255 && px(d, 7, 7)[3] === 255; })());
check('ops: a circle is round; an ellipse is wider than tall', (() => { const c = op({ op: 'circle', cx: 6, cy: 6, r: 4, c: 'a' }), e = op({ op: 'ellipse', cx: 6, cy: 6, rx: 5, ry: 2, c: 'a' }); return px(c, 6, 6)[3] === 255 && px(c, 10, 6)[3] === 255 && px(c, 10, 10)[3] === 0 && px(e, 11, 6)[3] === 255 && px(e, 6, 10)[3] === 0 && px(e, 6, 8)[3] === 255; })());
check('ops: fill floods the connected same-colour area only; erase clears', (() => { const r = PA.render({ palette: P, size: [8, 8], ops: [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, c: 'a' }, { op: 'rect', x: 3, y: 0, w: 1, h: 8, c: 'b' }, { op: 'fill', x: 0, y: 0, c: 'c' }, { op: 'erase', x: 6, y: 6, w: 2, h: 2 }] }); return px(r, 1, 1).join() === '0,255,0,255' && px(r, 3, 4).join() === '0,0,255,255' && px(r, 6, 1).join() === '255,0,0,255' && px(r, 7, 7)[3] === 0; })());
check('ops: dots draw in order (a later one covers an earlier one)', (() => { const r = PA.render({ palette: P, size: [6, 6], ops: [{ op: 'dot', x: 2, y: 2, c: 'a' }, { op: 'dot', x: 2, y: 2, c: 'b' }] }); return px(r, 2, 2).join() === '0,0,255,255'; })());
check('ops: ops draw on top of the rows', (() => { const r = PA.render({ palette: P, rows: ['aaaa', 'aaaa', 'aaaa', 'aaaa'], ops: [{ op: 'dot', x: 1, y: 1, c: 'c' }] }); return px(r, 1, 1).join() === '0,255,0,255' && px(r, 0, 0).join() === '255,0,0,255'; })());

// ---------- 亮暗部與外框 ----------
const flat = { palette: { a: '#808080' }, rows: ['aaaaaa', 'aaaaaa', 'aaaaaa', 'aaaaaa', 'aaaaaa', 'aaaaaa'] };
const sh = PA.render(Object.assign({ shade: true }, flat)), nosh = PA.render(flat);
check('shade: the top-left edge is lighter and the bottom-right edge darker; the middle is unchanged; off by default', px(sh, 0, 0)[0] > 128 && px(sh, 5, 5)[0] < 128 && px(sh, 2, 2)[0] === 128 && px(nosh, 0, 0)[0] === 128 && px(nosh, 5, 5)[0] === 128);
const ol2 = PA.render({ palette: P, size: [6, 6], rows: ['.....', '.aa..', '.aa..'], outline: '#00ff00' });
check('outline: a 1-pixel border outside the shape (dark ink by default, or the given colour)', px(PA.render({ palette: P, size: [6, 6], rows: ['.....', '.aa..', '.aa..'], outline: true }), 0, 1).join() === '32,24,43,255' && px(ol2, 0, 1).join() === '0,255,0,255' && px(ol2, 1, 0).join() === '0,255,0,255' && px(ol2, 4, 4)[3] === 0, [px(ol2, 0, 1)]);
check('render: deterministic', JSON.stringify(Array.from(PA.render({ palette: P, rows: ['.aa.', 'abba', 'abba', '.aa.'], shade: true, outline: true }).data)) === JSON.stringify(Array.from(PA.render({ palette: P, rows: ['.aa.', 'abba', 'abba', '.aa.'], shade: true, outline: true }).data)));

// ---------- 檢查 ----------
check('check: an empty picture and a nearly empty one are reported', /empty/.test(PA.check(PA.render({ palette: P, size: [8, 8] })).join()) && /only 3 pixels/.test(PA.check(PA.render({ palette: P, size: [8, 8], rows: ['aaa'] })).join()) && PA.check(r1).length === 0);
check('check: a render error is passed on', PA.check(PA.render({ palette: P })).length === 1);

// ---------- 內建範例 ----------
check('templates: nine, each valid, drawn, passing the check, within 64x64 and at most 32 colours', PA.TEMPLATE_NAMES.length === 9 && PA.TEMPLATE_NAMES.every((n) => { const s = PA.template(n), v = PA.validate(s), r = PA.render(s); return v.ok && !r.error && PA.check(r).length === 0 && r.width <= 64 && r.height <= 64 && r.palette.length <= 32; }), PA.TEMPLATE_NAMES.map((n) => PA.validate(PA.template(n)).errors));
check('templates: recolor changes a palette colour (only known keys and real colours)', (() => { const a = PA.render(PA.template('heart')), b = PA.render(PA.template('heart', { r: '#3366ff' })), c = PA.render(PA.template('heart', { r: 'blue', zz: '#ffffff' })); return JSON.stringify(Array.from(a.data)) !== JSON.stringify(Array.from(b.data)) && JSON.stringify(Array.from(a.data)) === JSON.stringify(Array.from(c.data)); })());
check('templates: an unknown one gives nothing; the templates are copies (editing one does not change the next)', PA.template('dragon') === null && (() => { const t = PA.template('coin'); t.palette.y = '#000000'; return PA.template('coin').palette.y === '#ffd54f'; })());

console.log(ok + ' passed, ' + bad.length + ' failed'); bad.forEach((b) => console.log('FAIL', b)); process.exit(bad.length ? 1 : 0);
