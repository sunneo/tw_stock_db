// node scripts/edit-tests/edit_import.test.js -- 編輯器共用的「📂 開啟檔案」：格式清單、選檔（假的 input）、拖放（假的事件）
const I = require('../../renderer/src/edit/edit_import.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const enc = (s) => new TextEncoder().encode(s);

const DOCX = [{ description: 'Word 文件', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } }];
const TXT = [{ description: 'Markdown／文字檔', accept: { 'text/plain': ['.md', '.markdown', '.txt', '.csv', '.json'] } }];

(async () => {
  // ── 格式清單
  check('exts 去重、去點、小寫', JSON.stringify(I.exts([{ accept: { a: ['.MD', '.md'], b: ['txt'] } }])) === '["md","txt"]', I.exts([{ accept: { a: ['.MD', '.md'], b: ['txt'] } }]));
  check('acceptAttr', I.acceptAttr(DOCX) === '.docx', I.acceptAttr(DOCX));
  check('accepts 副檔名大小寫不敏感', I.accepts('報告.DOCX', DOCX) && !I.accepts('a.doc', DOCX) && !I.accepts('noext', DOCX));
  check('accepts 路徑含點', I.accepts('C:\\x.y\\a.md', TXT) && !I.accepts('C:\\x.y\\a', TXT));
  check('hint 列出可開的', I.hint(DOCX) === '可以開：.docx', I.hint(DOCX));

  // ── pick：假的 document，讓假的 input 在 click() 時把檔案交給 onchange
  function fakeDocument(files) {
    const made = [];
    return { made, body: { appendChild(n) { n.parentNode = this; }, removeChild(n) { n.parentNode = null; } },
      createElement() {
        const inp = { style: {}, parentNode: null, files: null };
        inp.click = function () { this.files = files; this.onchange(); };
        made.push(inp); return inp;
      } };
  }
  const realDoc = global.document;
  try {
    global.document = fakeDocument([{ name: 'a.docx', size: 5, arrayBuffer: async () => enc('hello').buffer }]);
    const got = await I.pick(DOCX, { maxBytes: 100 });
    check('pick 讀到檔案', got && got.name === 'a.docx' && new TextDecoder().decode(got.bytes) === 'hello', got && got.name);
    check('pick 設了 accept', global.document.made[0].accept === '.docx', global.document.made[0].accept);
    check('pick 用完移掉 input', global.document.made[0].parentNode === null);

    global.document = fakeDocument([]);
    const none = await I.pick(DOCX, {});
    check('pick 取消 → null', none === null);

    global.document = fakeDocument([{ name: 'big.docx', size: 500, arrayBuffer: async () => new ArrayBuffer(0) }]);
    let rej = null; try { await I.pick(DOCX, { maxBytes: 100 }); } catch (e) { rej = e; }
    check('pick 太大 → 拒絕並說明', rej && /太大/.test(rej.message), rej && rej.message);
  } finally { global.document = realDoc; }

  // ── dropOpen：假的元素，記下監聽器，手動丟事件
  function fakeEl() {
    const L = {};
    return { L, addEventListener(n, f) { (L[n] = L[n] || []).push(f); }, fire(n, ev) { (L[n] || []).forEach((f) => f(ev)); } };
  }
  function fileEv(name, type, size, text) {
    const ev = { prevented: false, preventDefault() { this.prevented = true; }, dataTransfer: { types: ['Files'], files: [{ name, type: type || '', size: size || 1, arrayBuffer: async () => enc(text || 'x').buffer }] } };
    return ev;
  }
  {
    const el = fakeEl(); let opened = null, rejected = null;
    I.dropOpen(el, DOCX, (f) => { opened = f; }, (m) => { rejected = m; }, 100);
    const dv = fileEv('x.docx', '', 1, 'doc');
    el.fire('dragover', { dataTransfer: { types: ['Files'] }, preventDefault() { this.p = 1; } });
    el.fire('drop', dv);
    await new Promise((r) => setTimeout(r, 0));
    check('drop 認得的格式 → 開', opened && opened.name === 'x.docx' && dv.prevented, opened);
    check('drop 認得的格式 → 不說話', rejected === null, rejected);
  }
  {
    const el = fakeEl(); let opened = null, rejected = null;
    I.dropOpen(el, DOCX, (f) => { opened = f; }, (m) => { rejected = m; }, 100);
    const ev = fileEv('pic.png', 'image/png', 1);
    el.fire('drop', ev);
    await new Promise((r) => setTimeout(r, 0));
    check('drop 圖片 → 不歸這裡（不開、不說話；但仍擋住瀏覽器直接打開）', opened === null && rejected === null && ev.prevented);
  }
  {
    const el = fakeEl(); let opened = null, rejected = null;
    I.dropOpen(el, DOCX, (f) => { opened = f; }, (m) => { rejected = m; }, 100);
    const ev = fileEv('a.pdf', 'application/pdf', 1);
    el.fire('drop', ev);
    check('drop 不認得 → 說明可以開什麼', opened === null && /開不了「a.pdf」/.test(rejected || '') && /\.docx/.test(rejected || ''), rejected);
  }
  {
    const el = fakeEl(); let rejected = null;
    I.dropOpen(el, DOCX, () => {}, (m) => { rejected = m; }, 100);
    el.fire('drop', fileEv('big.docx', '', 500));
    check('drop 太大 → 說明', /太大/.test(rejected || ''), rejected);
  }
  {
    const el = fakeEl(); const ev = { dataTransfer: { types: ['text/plain'] }, preventDefault() { this.p = 1; } };
    I.dropOpen(el, DOCX, () => {}, () => {}, 100);
    el.fire('dragover', ev);
    check('dragover 非檔案不 preventDefault', !ev.p);
  }

  console.log('edit_import: ' + ok + ' 通過，' + bad.length + ' 失敗');
  if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
