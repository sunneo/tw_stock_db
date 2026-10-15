// node renderer/src/dataview/data_core.test.js
const C = require('./data_core.js');
let jszip = null, jsyaml = null; try { jszip = require('jszip'); } catch (_) {} try { jsyaml = require('js-yaml'); } catch (_) {}
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
    // --- 格式判斷
    check('detect json', C.detectFormat('{"a":1}') === 'json' && C.detectFormat('', 'JSON') === 'json');
    check('detect toml', C.detectFormat('[server]\nport = 80\n') === 'toml');
    check('detect yaml', C.detectFormat('a: 1\nb: [1,2]\n') === 'yaml');

    // --- JSON 解析錯誤位置
    const bj = C.parse('{\n  "a": 1,\n  "b": }\n', 'json'); check('json error has line', !bj.ok && bj.error.line === 3, bj);

    // --- TOML
    const toml = `# 設定\ntitle = "TOML 範例"\nowner.name = "Tom"\n\n[database]\nenabled = true\nports = [ 8000, 8001,\n  8002 ]\ndata = [ ["delta", "phi"], [3.14] ]\ntemp = { cpu = 79.5, case = 72.0 }\n\n[servers.alpha]\nip = "10.0.0.1"\nrole = 'front\\end'\n\n[[products]]\nname = "Hammer"\nsku = 738594937\n\n[[products]]\nname = "Nail"\ncolor = "gray"\nmulti = """\nline1\nline2"""\nhex = 0xDEAD_BEEF\ndt = 1979-05-27T07:32:00Z\n`;
    const tp = C.parse(toml, 'toml');
    check('toml parses', tp.ok, tp.error);
    if (tp.ok) {
        const d = tp.data;
        check('toml dotted key', d.owner.name === 'Tom' && d.title === 'TOML 範例');
        check('toml array multi-line + nested', eq(d.database.ports, [8000, 8001, 8002]) && eq(d.database.data, [['delta', 'phi'], [3.14]]));
        check('toml inline table', d.database.temp.cpu === 79.5 && d.database.temp.case === 72);
        check('toml nested table + literal string', d.servers.alpha.ip === '10.0.0.1' && d.servers.alpha.role === 'front\\end');
        check('toml array of tables', d.products.length === 2 && d.products[1].color === 'gray' && d.products[1].multi === 'line1\nline2' && d.products[1].hex === 0xDEADBEEF && d.products[1].dt === '1979-05-27T07:32:00Z');
        const back = C.parse(C.stringifyToml(d), 'toml'); check('toml round trip', back.ok && eq(back.data, d), back.error);
    }
    const dup = C.parse('a = 1\na = 2\n', 'toml'); check('toml duplicate key rejected with line', !dup.ok && dup.error.line === 2, dup);
    const badT = C.parse('a = \n', 'toml'); check('toml missing value', !badT.ok);

    // --- YAML（js-yaml 由呼叫端提供）
    if (jsyaml) {
        const deps = { yamlLoad: jsyaml.load, yamlDump: jsyaml.dump, yamlLoadAll: jsyaml.loadAll };
        const y = C.parse('a: 1\nb:\n  - x\n  - y\n', 'yaml', deps); check('yaml parse', y.ok && eq(y.data, { a: 1, b: ['x', 'y'] }));
        const y2 = C.parse('a: 1\n---\nb: 2\n', 'yaml', deps); check('yaml multi-doc becomes array', y2.ok && eq(y2.data, [{ a: 1 }, { b: 2 }]));
        const ye = C.parse('a: [1, 2\n', 'yaml', deps); check('yaml error line', !ye.ok && ye.error.line >= 1, ye);
        check('yaml stringify', C.stringify({ a: 1, b: [1, 2] }, 'yaml', deps).includes('b:\n  - 1'));
        check('yaml without parser says so', C.parse('a: 1', 'yaml').needDeps === 'yaml');
    }

    // --- CSV
    const csv = 'name,note\n"Smith, J","say ""hi""\nbye"\nplain,\n';
    const pc = C.parseCsv(csv); check('csv quoted comma/quote/newline', eq(pc.rows, [['name', 'note'], ['Smith, J', 'say "hi"\nbye'], ['plain', '']]), pc.rows);
    check('csv tab auto-detect', C.parseCsv('a\tb\n1\t2\n').delim === '\t');
    const sc = C.sheetToCsv({ columns: ['a', 'b'], rows: [['x,y', 'q"z'], [1, true]] }, { bom: false }); check('csv write', sc === 'a,b\r\n"x,y","q""z"\r\n1,true\r\n', sc);

    // --- 上色
    const hj = C.highlight('{\n  "name": "x",\n  "n": -1.5e3, "ok": true, "z": null\n}', 'json');
    check('json highlight kinds', hj[1][1].c === 'k' && hj[1][4].c === 's' && hj[2].some((t) => t.c === 'n') && hj[2].some((t) => t.c === 'b') && hj[2].some((t) => t.c === 'z'), hj[1]);
    check('json highlight keeps text', hj.map((l) => l.map((t) => t.t).join('')).join('\n') === '{\n  "name": "x",\n  "n": -1.5e3, "ok": true, "z": null\n}');
    const hy = C.highlight('# c\nname: demo  # tail\nlist:\n  - a: 1\n  - 2\ntext: |\n  keep: this\n  also\nnext: true\n', 'yaml');
    check('yaml comment/key/bool', hy[0][0].c === 'c' && hy[1][0].c === 'k' && hy[1].some((t) => t.c === 'c') && hy[8].some((t) => t.c === 'b'), hy[8]);
    check('yaml block scalar not parsed as key', hy[6].length === 1 && hy[6][0].c === 's', hy[6]);
    const ht = C.highlight('[a.b]\nk = "v" # c\nn = 3\nd = 1979-05-27\n', 'toml');
    check('toml highlight', ht[0].some((t) => t.c === 'h') && ht[1].some((t) => t.c === 's') && ht[1].some((t) => t.c === 'c') && ht[2].some((t) => t.c === 'n') && ht[3].some((t) => t.c === 'd'), ht);
    const pm = C.prettyIfMinified('{"a":[1,2,3],"b":{"c":"' + 'x'.repeat(400) + '"}}', 'json'); check('minified json is pretty-printed', pm.pretty && pm.text.split('\n').length > 5);

    // --- SPDX（最複雜的範例）→ 表格
    const spdx = {
        spdxVersion: 'SPDX-2.3', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT', name: 'demo-sbom', documentNamespace: 'https://example.com/x',
        creationInfo: { created: '2026-01-01T00:00:00Z', creators: ['Tool: syft', 'Organization: Acme'] },
        packages: [
            { SPDXID: 'SPDXRef-Package-a', name: 'a', versionInfo: '1.0', licenseConcluded: 'GPL-3.0', downloadLocation: 'NOASSERTION', checksums: [{ algorithm: 'SHA1', checksumValue: 'aa' }, { algorithm: 'SHA256', checksumValue: 'bb' }], externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/a@1.0' }], licenseInfoFromFiles: ['GPL-3.0', 'MIT'] },
            { SPDXID: 'SPDXRef-Package-b', name: 'b', versionInfo: '2.1', licenseConcluded: 'MIT', downloadLocation: 'https://x', supplier: { name: 'Org', url: 'u' } },
        ],
        files: [{ SPDXID: 'SPDXRef-File-1', fileName: './a.c', checksums: [{ algorithm: 'SHA1', checksumValue: 'cc' }] }],
        relationships: [{ spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-Package-a' }, { spdxElementId: 'SPDXRef-Package-a', relationshipType: 'DEPENDS_ON', relatedSpdxElement: 'SPDXRef-Package-b' }],
    };
    const tt = C.toTables(spdx);
    const names = tt.sheets.map((s) => s.name);
    check('spdx sheets', ['summary', 'packages', 'packages.checksums', 'packages.externalRefs', 'files', 'files.checksums', 'relationships'].every((n) => names.includes(n)), names);
    const pk = tt.sheets.find((s) => s.name === 'packages'); const ck = tt.sheets.find((s) => s.name === 'packages.checksums');
    check('spdx primary = biggest tabular', tt.primary === 'packages' || tt.primary === 'relationships', tt.primary);
    check('spdx scalar array joined', pk.rows[0][pk.columns.indexOf('licenseInfoFromFiles')] === 'GPL-3.0; MIT');
    check('spdx nested object flattened', pk.columns.includes('supplier.name') && pk.rows[1][pk.columns.indexOf('supplier.name')] === 'Org');
    check('spdx child sheet links to parent', ck.columns[0] === '_parent' && ck.rows.length === 2 && ck.rows[0][0] === 1 && ck.rows[0][1] === 'SPDXRef-Package-a', ck.rows[0]);
    const sm = tt.sheets.find((s) => s.name === 'summary'); check('summary has creationInfo and no big arrays', sm.rows.some((r) => r[0] === 'creationInfo.created') && !sm.rows.some((r) => /^packages/.test(r[0])));

    // 其他形狀
    const t2 = C.toTables([{ a: 1, b: 'x' }, { a: 2, c: true }]); check('array of objects, union columns', eq(t2.sheets[0].columns, ['a', 'b', 'c']) && t2.sheets[0].rows[1][1] === '');
    const t3 = C.toTables({ x1: { v: 1 }, x2: { v: 2 } }); check('dict of objects gets _key', t3.sheets[0].columns[0] === '_key' && t3.sheets[0].rows[1][0] === 'x2', t3.sheets[0]);
    const t4 = C.toTables({ '@graph': [{ type: 'Package', name: 'p' }, { type: 'File', fileName: 'f' }, { type: 'File', fileName: 'g' }] }); check('graph split by type', t4.sheets.some((s) => s.name === '@graph_File' && s.rows.length === 2) && t4.sheets.some((s) => s.name === '@graph_Package'), t4.sheets.map((s) => s.name));
    const t5 = C.toTables(42); check('scalar data', t5.sheets[0].rows[0][1] === 42);
    const longcell = C.toTables([{ a: 'x'.repeat(40000) }]); check('cell truncated to Excel limit', longcell.sheets[0].rows[0][0].length === 32767);
    const names31 = C.toTables({ [('very.long.name'.repeat(5))]: [{ a: 1 }], [('very.long.name'.repeat(5)) + '2']: [{ a: 1 }] }).sheets.map((s) => s.name); check('sheet names <=31 and unique', names31.every((n) => n.length <= 31) && new Set(names31.map((n) => n.toLowerCase())).size === names31.length, names31);

    // --- XLSX 寫入再讀回
    if (jszip) {
        const bytes = await C.buildXlsx(tt.sheets, { JSZip: jszip });
        check('xlsx is a zip', bytes[0] === 0x50 && bytes[1] === 0x4b);
        const rd = await C.readXlsx(bytes, { JSZip: jszip });
        check('xlsx sheets round trip', rd.sheets.map((s) => s.name).join('|') === tt.sheets.map((s) => s.name).join('|'), rd.sheets.map((s) => s.name));
        const rp = rd.sheets.find((s) => s.name === 'packages');
        check('xlsx cell values round trip', rp.rows.length === 2 && rp.rows[0][rp.columns.indexOf('name')] === 'a' && rp.rows[1][rp.columns.indexOf('versionInfo')] === '2.1' && rp.columns.includes('supplier.name'));
        const tn = await C.buildXlsx([{ name: 'T', columns: ['n', 'b', 's'], rows: [[1.5, true, 'a<&>"\u0001z']] }], { JSZip: jszip }); const r2 = await C.readXlsx(tn, { JSZip: jszip });
        check('xlsx number/bool/escaped text', r2.sheets[0].rows[0][0] === 1.5 && r2.sheets[0].rows[0][1] === true && r2.sheets[0].rows[0][2] === 'a<&>"z', r2.sheets[0].rows[0]);
    }

    // --- 樹與搜尋
    const data = { a: { b: [1, { c: 'needle' }], d: 'x' }, e: 2 };
    let rows = C.visibleRows(data, new Set(['']), {}); check('tree: root expanded shows children only', rows.map((r) => r.path).join('|') === '|/a|/e', rows.map((r) => r.path));
    const sr = C.searchTree(data, 'needle'); check('tree search finds value and opens ancestors', eq(sr.hits, ['/a/b/1/c']) && sr.open.has('/a') && sr.open.has('/a/b/1'), sr);
    rows = C.visibleRows(data, new Set(['', ...sr.open]), {}); check('tree after search shows hit', rows.some((r) => r.path === '/a/b/1/c' && r.value === 'needle'));
    check('getByPath', C.getByPath(data, '/a/b/1/c') === 'needle');
    check('defaultExpanded limits depth', !C.defaultExpanded({ a: { b: { c: {} } } }, 2, 100).has('/a/b'));
    const st = C.searchText(['abc', 'xAbCx abc'], 'abc'); check('text search case-insensitive', st.length === 3 && st[1].col === 1, st);
    check('outline', C.outline(spdx).includes('packages'));
    console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'data_core: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXC', e && e.stack || e); process.exit(1); });
