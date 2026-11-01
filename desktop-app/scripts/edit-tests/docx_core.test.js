// node scripts/edit-tests/docx_core.test.js -- /edit-docx 的文件核心：讀、沒改的區塊原樣輸出、package patching、動作、格式、清單、表格、程式白話
const C = require('../../renderer/src/edit/docx_core.js');
let JSZip = null; for (const p of ['jszip', '/home/julius.wang/claude/node_modules/jszip']) { try { JSZip = require(p); break; } catch (_) { /* */ } }
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const J = (x) => JSON.stringify(x);
const run = (spec, edits) => C.applyEdits(spec, edits, {});
const txt = (spec) => spec.objects.map((b) => b.type === 'table' ? b.rows.map((r) => r.join('|')).join('/') : C.plain(b));
(async () => {
  if (!JSZip) { console.log('（沒有 jszip，只跑不需要壓縮檔的測試）'); }
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const P = (t, ppr, rpr) => '<w:p>' + (ppr ? '<w:pPr>' + ppr + '</w:pPr>' : '') + '<w:r>' + (rpr ? '<w:rPr>' + rpr + '</w:rPr>' : '') + '<w:t xml:space="preserve">' + t + '</w:t></w:r></w:p>';
  const body = P('大標題', '<w:pStyle w:val="Heading1"/>') + P('第一段 hello &amp; world', '<w:spacing w:after="200"/>', '<w:rFonts w:ascii="Arial"/><w:sz w:val="28"/>')
    + '<w:p><w:r><w:t xml:space="preserve">普通 </w:t></w:r><w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>粗紅</w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>連結</w:t></w:r></w:hyperlink></w:p>'
    + P('項目一', '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') + P('項目二', '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
    + '<w:p><w:r><w:drawing><wp:inline xmlns:wp="x"><wp:docPr id="1" name="圖" descr="一張圖"/></wp:inline></w:drawing></w:r></w:p>'
    + '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>' + P('A1') + '</w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>' + P('B1') + '</w:tc></w:tr><w:tr><w:tc>' + P('A2', '', '<w:b/>') + '</w:tc><w:tc>' + P('B2') + '</w:tc></w:tr></w:tbl>'
    + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + P('結尾');
  const sect = '<w:sectPr><w:headerReference w:type="default" r:id="rId7"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>';
  const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ' + W + '><w:body>' + body + sect + '</w:body></w:document>';
  const makeOrig = async () => { const z = new JSZip(); z.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'); z.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'); z.file('word/document.xml', docXml); z.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="x/header" Target="header1.xml"/><Relationship Id="rId9" Type="x/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/></Relationships>'); z.file('word/header1.xml', '<w:hdr ' + W + '><w:p><w:r><w:t>頁首</w:t></w:r></w:p></w:hdr>'); z.file('word/styles.xml', '<w:styles ' + W + '><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>'); z.file('word/media/image1.png', new Uint8Array([1, 2, 3, 4])); return z.generateAsync({ type: 'uint8array' }); };
  if (JSZip) {
    const orig = await makeOrig(); const spec = await C.read(orig, JSZip, '範例');
    check('讀：區塊種類與文字', J(spec.objects.map((b) => b.type)) === J(['heading', 'para', 'para', 'li', 'li', 'raw', 'table', 'pagebreak', 'para']), spec.objects.map((b) => b.type));
    check('讀：文字（含實體解碼、多個 run、超連結）', txt(spec)[1] === '第一段 hello & world' && txt(spec)[2] === '普通 粗紅連結' && spec.objects[0].level === 1 && spec.objects[3].ordered === false);
    check('讀：格式保留在 rpr，超連結帶網址', C.rprHas(spec.objects[2].runs[1].rpr, 'b') && C.rprColor(spec.objects[2].runs[1].rpr) === '#FF0000' && spec.objects[2].runs[2].href === 'https://example.com/a?b=1&c=2', spec.objects[2].runs);
    check('讀：圖片段落成為 raw 並列在 notes', spec.objects[5].type === 'raw' && spec.notes.some((n) => /不能改/.test(n)));
    check('讀：表格儲存格文字', J(spec.objects[6].rows) === J([['A1', 'B1'], ['A2', 'B2']]));
    check('讀：head／sect 原文保存', spec.head.indexOf('<w:body>') > 0 && /headerReference/.test(spec.sect) && /<\/w:document>/.test(spec.tail));
    // 沒改：位元組一致（簽章相同；document.xml 重建後與原文一致）
    const same = await C.build(spec, JSZip, orig); const z1 = await JSZip.loadAsync(same); check('沒改過：document.xml 與原文逐字相同', (await z1.file('word/document.xml').async('string')) === docXml);
    check('沒改過：其他 part 原封不動', (await z1.file('word/header1.xml').async('string')).indexOf('頁首') > 0 && (await z1.file('word/media/image1.png').async('uint8array')).join() === '1,2,3,4');
    check('簽章：沒改相同、改了不同', spec.sig === C.sigOf(spec) && C.sigOf(run(spec, [{ op: 'set_text', id: spec.objects[1].id, text: 'x' }]).spec) !== spec.sig);
    // 改一段字：只有那一段的 XML 變，其餘區塊原文不變；段落的格式（spacing、字型大小）保留
    const id1 = spec.objects[1].id; let r = run(spec, [{ op: 'set_text', id: id1, text: '第一段 HELLO & world' }]); const out2 = await C.build(r.spec, JSZip, orig); const doc2 = await (await JSZip.loadAsync(out2)).file('word/document.xml').async('string');
    check('改字：只動那一段，其餘原文照舊', doc2.indexOf(P('大標題', '<w:pStyle w:val="Heading1"/>')) > 0 && doc2.indexOf('<w:tbl>') > 0 && doc2.indexOf(sect) > 0 && doc2.indexOf('HELLO &amp; world') > 0 && /<w:spacing w:after="200"\/>/.test(doc2) && /<w:sz w:val="28"\/>/.test(doc2), doc2.slice(200, 900));
    const back = await C.read(out2, JSZip, 'x'); check('改完再讀回：文字與其他區塊一致', txt(back)[1] === '第一段 HELLO & world' && back.objects.length === spec.objects.length && txt(back)[0] === '大標題');
    // 格式：整段粗體；只對某個字變紅；格式不吃掉原本的 rpr
    r = run(spec, [{ op: 'set_style', id: id1, bold: true }]); check('整段粗體保留字型與大小', C.rprHas(r.spec.objects[1].runs[0].rpr, 'b') && /<w:sz w:val="28"\/>/.test(r.spec.objects[1].runs[0].rpr) && /w:rFonts/.test(r.spec.objects[1].runs[0].rpr), r.spec.objects[1].runs);
    r = run(spec, [{ op: 'set_style', id: spec.objects[2].id, find: '普通', color: 'blue', underline: true }]); check('只改一個詞的格式（run 被切開，其餘不變）', J(r.spec.objects[2].runs.map((x) => x.t)) === J(['普通', ' ', '粗紅', '連結']) && C.rprColor(r.spec.objects[2].runs[0].rpr) === '#0070C0' && C.rprHas(r.spec.objects[2].runs[2].rpr, 'b') && C.rprHas(r.spec.objects[2].runs[0].rpr, 'u'), r.spec.objects[2].runs);
    r = run(spec, [{ op: 'set_style', id: spec.objects[2].id, find: '不存在', bold: true }]); check('找不到的字被擋下', r.applied.length === 0 && /not in that block/.test(r.rejected[0].error));
    // 改字時保留頭尾的格式
    r = run(spec, [{ op: 'set_text', id: spec.objects[2].id, text: '普通 粗紅連結！' }]); check('改字：中間沒動的格式保留、結尾新增沿用前一段格式', r.spec.objects[2].runs.length >= 3 && C.rprHas(r.spec.objects[2].runs[1].rpr, 'b'), r.spec.objects[2].runs);
    r = run(spec, [{ op: 'set_text', id: spec.objects[2].id, text: '普通 粗黑連結' }]); check('改字：中間改掉的字用改動處的格式', C.plain(r.spec.objects[2]) === '普通 粗黑連結' && r.spec.objects[2].runs.some((x) => x.t === '粗黑' && C.rprHas(x.rpr, 'b')) && r.spec.objects[2].runs.some((x) => x.rid), r.spec.objects[2].runs);
    // 標題層級、清單
    r = run(spec, [{ op: 'set_heading', id: id1, level: 2 }]); let o2 = await C.build(r.spec, JSZip, orig); let d3 = await (await JSZip.loadAsync(o2)).file('word/document.xml').async('string'); check('改成 H2：輸出 pStyle Heading2、補上樣式定義', /<w:pStyle w:val="Heading2"\/>/.test(d3) && /w:styleId="Heading2"/.test(await (await JSZip.loadAsync(o2)).file('word/styles.xml').async('string')));
    r = run(spec, [{ op: 'list_toggle', id: id1, ordered: true }]); o2 = await C.build(r.spec, JSZip, orig); const z3 = await JSZip.loadAsync(o2); d3 = await z3.file('word/document.xml').async('string'); check('編號清單：原檔沒有 numbering.xml 時補一份（內容類型與關聯都補）', /<w:numPr>/.test(d3) && !!z3.file('word/numbering.xml') && /numbering\.xml/.test(await z3.file('[Content_Types].xml').async('string')) && /numbering\.xml/.test(await z3.file('word/_rels/document.xml.rels').async('string')));
    const nb = await C.read(o2, JSZip, 'x'); check('清單改完讀回是清單且為編號', nb.objects[1].type === 'li' && nb.objects[1].ordered === true, nb.objects[1].type);
    // 表格：改儲存格保留框線與其他儲存格；加列
    r = run(spec, [{ op: 'set_cell', id: spec.objects[6].id, row: 1, col: 1, text: '新B2' }]); o2 = await C.build(r.spec, JSZip, orig); d3 = await (await JSZip.loadAsync(o2)).file('word/document.xml').async('string'); check('改表格儲存格：樣式、欄寬、其他格原樣', /w:tblStyle w:val="TableGrid"/.test(d3) && /w:gridCol w:w="3000"/.test(d3) && />A1</.test(d3) && />新B2</.test(d3) && />A2</.test(d3));
    r = run(spec, [{ op: 'table_rows', id: spec.objects[6].id, add: 'end' }]); o2 = await C.build(r.spec, JSZip, orig); const tb = await C.read(o2, JSZip, 'x'); check('表格加一列', tb.objects[6].rows.length === 3);
    // 新增區塊、刪除、搬移、取代
    r = run(spec, [{ op: 'add_block', after: id1, block: { type: 'para', text: '新段落' } }]); check('在某區塊後加一段', txt(r.spec)[2] === '新段落' && txt(r.spec).length === 10, txt(r.spec));
    r = run(spec, [{ op: 'add_block', after: 'end', block: { type: 'heading', level: 2, text: '尾' } }]); check('在最後加標題', r.spec.objects[r.spec.objects.length - 1].type === 'heading' && txt(r.spec).pop() === '尾');
    r = run(spec, [{ op: 'remove_block', id: spec.objects[8].id }, { op: 'move_block', id: id1, to: 'last' }]); check('刪除與移動', txt(r.spec).length === 8 && txt(r.spec).pop() === '第一段 hello & world');
    r = run(spec, [{ op: 'replace_all', find: 'hello', repl: 'HI' }, { op: 'replace_all', find: 'B2', repl: 'Z9' }]); check('全部取代（段落與表格）', txt(r.spec)[1] === '第一段 HI & world' && r.spec.objects[6].rows[1][1] === 'Z9');
    r = run(spec, [{ op: 'set_text', id: spec.objects[5].id, text: 'x' }]); check('圖片區塊不能當文字改', r.applied.length === 0 && r.rejected.length === 1);
    const b2 = await C.build(run(spec, [{ op: 'remove_block', id: spec.objects[8].id }]).spec, JSZip, orig); check('刪掉一段：圖片與其他原樣仍在', /<w:drawing>/.test(await (await JSZip.loadAsync(b2)).file('word/document.xml').async('string')));
    // 全新文件（沒有原檔）
    const sp0 = C.starter('report'); const nb2 = await C.build(sp0, JSZip); const z4 = await JSZip.loadAsync(nb2); const rb = await C.read(nb2, JSZip, 'r'); check('新文件：套件完整、讀回一致', ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml'].every((n) => !!z4.file(n)) && J(rb.objects.slice(0, 7).map((b) => b.type)) === J(sp0.objects.map((b) => b.type)) && rb.objects[1].level === 2 && rb.objects[4].type === 'li');
  }
  // ── 不需要壓縮檔的測試
  const sp = C.starter('report');
  check('範例文件', sp.objects.length === 7 && sp.objects[0].type === 'heading' && sp.objects[4].type === 'li');
  let r = run(sp, [{ op: 'set_style', id: sp.objects[2].id, bold: true, color: 'red' }]); check('顏色用中文名字也行（輸出 C00000）', C.rprColor(r.spec.objects[2].runs[0].rpr) === '#C00000');
  check('預覽 HTML：格式與跳脫', (() => { const h = C.blockHtml(r.spec.objects[2]); return /<strong>/.test(h) && /color:#C00000/.test(h); })() && /&lt;b&gt;/.test(C.blockHtml({ type: 'para', runs: [{ t: '<b>' }] })));
  check('預覽 HTML：連結只收 http/https/mailto', !/href=/.test(C.blockHtml({ type: 'para', runs: [{ t: 'x', rid: 'r1', href: 'javascript:alert(1)' }] })) && /href="https:/.test(C.blockHtml({ type: 'para', runs: [{ t: 'x', rid: 'r1', href: 'https://a.b' }] })));
  const pc = (t) => C.parseCommands(t, sp);
  let p = pc('把第 3 段改成：新的摘要'); check('白話：改字', p.edits[0].op === 'set_text' && p.edits[0].text === '新的摘要', p);
  p = pc('把第 1 段改成粗體；把第 3 段改成紅色'); check('白話：格式', p.edits.length === 2 && p.edits[0].bold === true && p.edits[1].color === '紅色', p);
  p = pc('把「重點一」變成粗體'); check('白話：只改一個詞的格式', p.edits[0] && p.edits[0].find === '重點一' && p.edits[0].bold === true && p.edits[0].id === sp.objects[4].id, p);
  p = pc('把第 3 段改成標題 3'); check('白話：標題層級', p.edits[0].op === 'set_heading' && p.edits[0].level === 3);
  p = pc('把第 3 段改成編號清單'); check('白話：轉清單', p.edits[0].op === 'convert_block' && p.edits[0].to === 'olist');
  p = pc('刪掉第 2 段'); check('白話：刪除', p.edits[0].op === 'remove_block');
  p = pc('在最後加一段：結語'); check('白話：加一段', p.edits[0].op === 'add_block' && p.edits[0].block.text === '結語');
  p = pc('在最後加標題：附錄'); check('白話：加標題', p.edits[0].block.type === 'heading' && p.edits[0].block.text === '附錄', p);
  p = pc('把「重點」全部改成「要點」'); check('白話：取代', p.edits[0].op === 'replace_all' && p.edits[0].repl === '要點');
  p = pc('把整份文件翻成英文'); check('讀不懂的交給 AI', p.edits.length === 0 && p.unmatched.length === 1);
  const pr = C.editPrompt(sp, '把摘要寫長一點', null); check('提示：有 id、類型、格式標記、動作字彙', /\[o\d+\] heading H1/.test(pr.user) && /set_style/.test(pr.system) && /Request: 把摘要寫長一點/.test(pr.user));
  check('AI 回覆只收封閉動作', C.parseEditsReply(J({ say: 'ok', edits: [{ op: 'set_text', id: 'o1', text: 'x' }, { op: 'eval', code: 'x' }] })).edits.length === 1);
  check('validate 整理壞資料（缺 id、壞 runs）', (() => { const v = C.validate({ objects: [{ type: 'para', runs: [{ t: 5 }, null, { t: 'a', rpr: '<w:b/>' }] }, { type: 'nope' }] }).spec; return v.objects.length === 1 && C.plain(v.objects[0]) === '5a' && !!v.objects[0].id; })());
  check('retext：純函式的幾種編輯', C.plain({ runs: C.retext([{ t: 'abc', rpr: 'X' }, { t: 'def', rpr: 'Y' }], 'abXYef') }) === 'abXYef' && C.retext([{ t: 'abc', rpr: 'X' }, { t: 'def', rpr: 'Y' }], 'abc').length === 1 && C.retext([], 'z')[0].t === 'z' && C.retext([{ t: 'a', rpr: 'X' }], '').length === 0);
  console.log('docx_core: ' + ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '：\n  ' + bad.join('\n  ') : '')); process.exit(bad.length ? 1 : 0);
})();
