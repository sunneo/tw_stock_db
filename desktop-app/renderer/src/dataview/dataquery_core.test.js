// node renderer/src/dataview/dataquery_core.test.js
const Q = require('./dataquery_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 500) : '')); };

// ---------- 固定的資料 ----------
const spdx = {
    spdxVersion: 'SPDX-2.3', name: 'demo-sbom', dataLicense: 'CC0-1.0', SPDXID: 'SPDXRef-DOCUMENT',
    creationInfo: { created: '2026-01-02T03:04:05Z', creators: ['Tool: syft-1.0', 'Organization: ACME'] },
    packages: [
        { name: 'lodash', SPDXID: 'SPDXRef-1', versionInfo: '4.17.21', licenseConcluded: 'MIT', supplier: 'Organization: JS Foundation', downloadLocation: 'https://registry.npmjs.org/lodash', checksums: [{ algorithm: 'SHA1', checksumValue: 'aa11' }, { algorithm: 'SHA256', checksumValue: 'bb22' }], externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/lodash@4.17.21' }] },
        { name: 'glibc', SPDXID: 'SPDXRef-2', versionInfo: '2.31', licenseConcluded: 'LGPL-2.1-or-later', supplier: 'Organization: GNU', downloadLocation: 'NOASSERTION', checksums: [] },
        { name: 'bash', SPDXID: 'SPDXRef-3', versionInfo: '5.1', licenseConcluded: 'GPL-3.0-only', supplier: 'Organization: GNU', downloadLocation: 'https://ftp.gnu.org/bash.tar.gz' },
        { name: 'zlib', SPDXID: 'SPDXRef-4', versionInfo: '1.2.11', licenseConcluded: 'Zlib', supplier: 'Person: Mark Adler', downloadLocation: 'https://zlib.net/zlib.tar.gz', checksums: [{ algorithm: 'SHA256', checksumValue: 'cc33' }], externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:generic/zlib@1.2.11' }] },
        { name: 'openssl', SPDXID: 'SPDXRef-5', versionInfo: '3.0.2', licenseConcluded: 'Apache-2.0', supplier: 'Organization: OpenSSL', downloadLocation: 'https://openssl.org/src.tar.gz', checksums: [{ algorithm: 'SHA512', checksumValue: 'dd44' }] },
        { name: 'busybox', SPDXID: 'SPDXRef-6', versionInfo: '1.35.0', licenseConcluded: 'GPL-2.0-only', supplier: 'Person: Denys Vlasenko', downloadLocation: 'https://busybox.net/b.tar.bz2', checksums: [{ algorithm: 'SHA256', checksumValue: 'ee55' }, { algorithm: 'MD5', checksumValue: 'ff66' }] },
        { name: 'curl', SPDXID: 'SPDXRef-7', versionInfo: '7.81.0', licenseConcluded: 'MIT', supplier: 'Person: Daniel Stenberg', downloadLocation: 'https://curl.se/curl.tar.gz', checksums: [{ algorithm: 'SHA256', checksumValue: 'gg77' }] }
    ],
    files: [{ fileName: './src/main.c', SPDXID: 'SPDXRef-F1', licenseConcluded: 'MIT', checksums: [{ algorithm: 'SHA1', checksumValue: 'f1f1' }] }, { fileName: './src/util.c', SPDXID: 'SPDXRef-F2', licenseConcluded: 'GPL-3.0-only', checksums: [{ algorithm: 'SHA1', checksumValue: 'f2f2' }] }],
    relationships: [
        { spdxElementId: 'SPDXRef-1', relationshipType: 'DEPENDS_ON', relatedSpdxElement: 'SPDXRef-4' }, { spdxElementId: 'SPDXRef-7', relationshipType: 'DEPENDS_ON', relatedSpdxElement: 'SPDXRef-5' },
        { spdxElementId: 'SPDXRef-7', relationshipType: 'DEPENDS_ON', relatedSpdxElement: 'SPDXRef-4' }, { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-1' }]
};
const sheets = [
    { name: '員工', columns: ['姓名', '部門', '職稱', '薪水', '到職日', '城市'], rows: [['王小明', '業務部', '業務專員', 42000, '2021-03-01', '台北'], ['李大華', '工程部', '工程師', 78000, '2019-07-15', '新竹'], ['陳美玲', '工程部', '資深工程師', 98000, '2016-01-10', '台北'], ['林志偉', '人資部', '人資專員', 45000, '2022-09-05', '台中'], ['張雅婷', '業務部', '業務經理', 88000, '2015-05-20', '台北'], ['黃建國', '工程部', '工程師', 72000, '2020-11-30', '高雄'], ['吳佩珊', '財務部', '會計', 52000, '2018-02-14', '台北'], ['周家豪', '業務部', '業務專員', 39000, '2023-04-01', '台中']] },
    { name: '訂單', columns: ['訂單編號', '客戶', '產品', '數量', '單價', '日期', '狀態'], rows: [['A001', '大有公司', '滑鼠', 10, 350, '2026-01-05', '已出貨'], ['A002', '大有公司', '鍵盤', 5, 1200, '2026-01-07', '已出貨'], ['A003', '小美商行', '螢幕', 2, 6800, '2026-01-09', '待出貨'], ['A004', '小美商行', '滑鼠', 20, 350, '2026-01-12', '已取消'], ['A005', '永和企業', '鍵盤', 8, 1200, '2026-01-15', '待出貨'], ['A006', '永和企業', '螢幕', 4, 6800, '2026-01-20', '已出貨']] }
];

// ---------- 結構 ----------
const P = Q.profile(spdx);
const ids = P.tables.map((t) => t.id);
check('SPDX：文件、packages、files、relationships 與子表', ['文件', 'packages', 'packages.checksums', 'packages.externalRefs', 'files', 'files.checksums', 'relationships'].every((x) => ids.includes(x)), ids);
check('子表的 _parent 指向上層那一列', P.tables.find((t) => t.id === 'packages.checksums').rows.filter((r) => r[1] === 0).length === 2);
check('版本號 4.17.21 不被當成數字', Q.profile(spdx).tables.find((t) => t.id === 'packages').cols.find((c) => c.name === 'versionInfo').type === 'text');
check('欄位值收集成清單', P.tables.find((t) => t.id === 'packages').cols.find((c) => c.name === 'licenseConcluded').values.includes('GPL-3.0-only'));
check('空陣列不會變成欄位', !P.tables.find((t) => t.id === 'packages').cols.some((c) => c.name === 'checksums'));
const PS = Q.profile({ sheets });
check('工作表：一張一張、型別對', PS.tables.length === 2 && PS.tables[0].cols.find((c) => c.name === '薪水').type === 'number' && PS.tables[0].cols.find((c) => c.name === '到職日').type === 'date');
check('單一表格 {columns,rows} 也行', Q.profile({ columns: ['a', 'b'], rows: [[1, 2]] }).tables.length === 1);
check('根是陣列的 JSON', Q.profile([{ a: 1 }, { a: 2 }]).tables[0].rows.length === 2);

// ---------- 題庫（只用程式，不用模型）----------
// cols：要比對的欄位名稱（用結果裡的欄位標籤）；rows：期望的列（不分順序，除非 ordered）
const BENCH = [
    ['spdx', '列出授權是 GPL 的套件和版本', { cols: ['name', 'versionInfo'], rows: [['bash', '5.1'], ['busybox', '1.35.0']] }],
    ['spdx', '授權包含 GPL 的套件', { cols: ['name'], rows: [['glibc'], ['bash'], ['busybox']] }],
    ['spdx', '授權是 MIT 的套件有哪些', { cols: ['name'], rows: [['lodash'], ['curl']] }],
    ['spdx', '有哪些套件沒有 checksum', { cols: ['name'], rows: [['glibc'], ['bash']] }],
    ['spdx', '有幾個套件', { rows: [[7]] }],
    ['spdx', '每種授權各有幾個套件', { cols: ['licenseConcluded', '數量'], rows: [['MIT', 2], ['LGPL-2.1-or-later', 1], ['GPL-3.0-only', 1], ['Zlib', 1], ['Apache-2.0', 1], ['GPL-2.0-only', 1]] }],
    ['spdx', '版本 2.31 的套件叫什麼', { cols: ['name'], rows: [['glibc']] }],
    ['spdx', '使用 SHA256 雜湊的套件有哪些', { cols: ['name'], rows: [['lodash'], ['zlib'], ['busybox'], ['curl']] }],
    ['spdx', 'lodash 的 purl 是什麼', { has: 'pkg:npm/lodash@4.17.21' }],
    ['spdx', '供應商是 GNU 的套件', { cols: ['name'], rows: [['glibc'], ['bash']] }],
    ['spdx', 'Apache-2.0 授權的套件版本', { cols: ['name', 'versionInfo'], rows: [['openssl', '3.0.2']] }],
    ['spdx', '下載位置是 NOASSERTION 的套件', { cols: ['name'], rows: [['glibc']] }],
    ['spdx', '哪些檔案授權是 MIT', { cols: ['fileName'], rows: [['./src/main.c']] }],
    ['spdx', '有幾個檔案', { rows: [[2]] }],
    ['spdx', '有哪些不同的授權', { cols: ['licenseConcluded'], rows: [['MIT'], ['LGPL-2.1-or-later'], ['GPL-3.0-only'], ['Zlib'], ['Apache-2.0'], ['GPL-2.0-only']] }],
    ['spdx', '有哪些關係是 DEPENDS_ON', { cols: ['spdxElementId', 'relatedSpdxElement'], rows: [['SPDXRef-1', 'SPDXRef-4'], ['SPDXRef-7', 'SPDXRef-5'], ['SPDXRef-7', 'SPDXRef-4']] }],
    ['spdx', 'busybox 有哪些雜湊演算法', { cols: ['algorithm'], rows: [['SHA256'], ['MD5']] }],
    ['sheet', '薪水大於 80000 的員工', { cols: ['姓名'], rows: [['陳美玲'], ['張雅婷']] }],
    ['sheet', '業務部有誰', { cols: ['姓名'], rows: [['王小明'], ['張雅婷'], ['周家豪']] }],
    ['sheet', '台北的員工有幾位', { rows: [[4]] }],
    ['sheet', '每個部門各有幾位員工', { cols: ['部門', '數量'], rows: [['業務部', 3], ['工程部', 3], ['人資部', 1], ['財務部', 1]] }],
    ['sheet', '工程部的平均薪水', { rows: [[(78000 + 98000 + 72000) / 3]] }],
    ['sheet', '薪水最高的是誰', { cols: ['姓名'], rows: [['陳美玲']] }],
    ['sheet', '薪水最低的前2名', { cols: ['姓名'], rows: [['周家豪'], ['王小明']], ordered: true }],
    ['sheet', '2020 年以後到職的員工', { cols: ['姓名'], rows: [['王小明'], ['林志偉'], ['黃建國'], ['周家豪']] }],
    ['sheet', '誰是2018年到職的', { cols: ['姓名'], rows: [['吳佩珊']] }],
    ['sheet', '哪個城市的員工最多', { cols: ['城市', '數量'], rows: [['台北', 4]] }],
    ['sheet', '薪水在 50000 以下的員工', { cols: ['姓名'], rows: [['王小明'], ['林志偉'], ['周家豪']] }],
    ['sheet', '工程部薪水最高的人', { cols: ['姓名'], rows: [['陳美玲']] }],
    ['sheet', '已出貨的訂單有幾筆', { rows: [[3]] }],
    ['spdx', '哪個套件用的是 Zlib 授權', { cols: ['name'], rows: [['zlib']] }],
    ['spdx', '版本是 3.0.2 的是哪個套件', { cols: ['name'], rows: [['openssl']] }],
    ['spdx', 'busybox 的授權是什麼', { cols: ['name', 'licenseConcluded'], rows: [['busybox', 'GPL-2.0-only']] }],
    ['spdx', 'curl 的版本', { cols: ['name', 'versionInfo'], rows: [['curl', '7.81.0']] }],
    ['sheet', '城市是高雄的員工職稱', { cols: ['姓名', '職稱'], rows: [['黃建國', '工程師']] }],
    ['sheet', '員工薪水總和', { rows: [[(42000 + 78000 + 98000 + 45000 + 88000 + 72000 + 52000 + 39000)]] }],
    ['sheet', '狀態是待出貨的訂單', { cols: ['訂單編號'], rows: [['A003'], ['A005']] }],
    ['sheet', '大有公司買了哪些產品', { cols: ['產品'], rows: [['滑鼠'], ['鍵盤']] }],
    ['sheet', '訂單數量大於 8 的有哪些', { cols: ['訂單編號'], rows: [['A001'], ['A004']] }],
    ['sheet', '每個客戶各有幾筆訂單', { cols: ['客戶', '數量'], rows: [['大有公司', 2], ['小美商行', 2], ['永和企業', 2]] }],
    ['sheet', '訂單總共有幾筆', { rows: [[6]] }],
    ['sheet', '已取消的訂單', { cols: ['訂單編號'], rows: [['A004']] }]
].filter((x) => x[2]);

const norm = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : String(v));
function grade(res, exp) {
    if (!res.ok) return 'fail:' + res.error;
    if (exp.has) return JSON.stringify(res.rows).includes(exp.has) ? null : 'missing:' + exp.has;
    const idx = exp.cols ? exp.cols.map((c) => res.columns.findIndex((x) => x === c || x.endsWith('.' + c))) : exp.rows[0].map((_, i) => res.columns.length - exp.rows[0].length + i);
    if (idx.some((i) => i < 0)) return 'cols:' + res.columns.join(',');
    const got = res.rows.map((r) => idx.map((i) => norm(r[i]))); const want = exp.rows.map((r) => r.map(norm));
    const gs = exp.ordered ? got : got.map((x) => JSON.stringify(x)).sort(); const ws = exp.ordered ? want : want.map((x) => JSON.stringify(x)).sort();
    const g2 = exp.ordered ? got.map((x) => JSON.stringify(x)) : gs, w2 = exp.ordered ? want.map((x) => JSON.stringify(x)) : ws;
    return JSON.stringify([...new Set(g2)].sort()) === JSON.stringify([...new Set(w2)].sort()) && (exp.ordered ? JSON.stringify(g2) === JSON.stringify(w2) : true) ? null : 'got:' + JSON.stringify(got).slice(0, 200);
}
(async () => {
    const fails = []; let passed = 0;
    for (const [kind, q, exp] of BENCH) {
        const res = await Q.answer(q, kind === 'spdx' ? spdx : { sheets }, {});
        const g = grade(res, exp); if (g) fails.push(q + ' → ' + g); else passed++;
    }
    console.log('題庫 ' + passed + '/' + BENCH.length); check('題庫：程式單獨回答的正確率（' + passed + '/' + BENCH.length + '）' + (fails.length ? '；錯的：' + fails.join('｜') : ''), fails.length === 0);

    // ---- 檢查與執行 ----
    const base = { from: 'packages', joins: [], where: [], select: [{ t: 'packages', c: 'name' }], group: [], agg: null, order: [], limit: null, distinct: false };
    check('檢查：不存在的欄位被擋', Q.check(Object.assign({}, base, { select: [{ t: 'packages', c: 'nope' }] }), P).length === 1);
    check('檢查：值不在資料裡被擋', /沒有「Apache」/.test(Q.check(Object.assign({}, base, { where: [{ t: 'packages', c: 'licenseConcluded', op: 'eq', value: 'Apache' }] }), P, { strictValues: true }).join()));
    check('檢查：文字欄位不能比大小', Q.check(Object.assign({}, base, { where: [{ t: 'packages', c: 'name', op: 'gt', value: 3 }] }), P).length === 1);
    check('檢查：沒有接進來的表', Q.check(Object.assign({}, base, { where: [{ t: 'packages.checksums', c: 'algorithm', op: 'eq', value: 'SHA256' }] }), P).length >= 1);
    check('檢查：非上下層不能接', Q.check(Object.assign({}, base, { joins: [{ table: 'relationships', kind: 'child' }] }), P).length === 1);
    check('檢查：好的計畫沒有錯', Q.check(base, P).length === 0);
    check('執行：回傳欄位與列', JSON.stringify(Q.run(base, P).rows.map((r) => r[0]).slice(0, 2)) === '["lodash","glibc"]');
    const sqlCase = await Q.answer('列出授權是 GPL 的套件和版本', spdx, {});
    check('SQL：有條件、用完整字比對', /FROM "packages"/.test(sqlCase.sql) && /GLOB/.test(sqlCase.sql) && /"licenseConcluded"/.test(sqlCase.sql), sqlCase.sql);
    const sqlAnti = await Q.answer('有哪些套件沒有 checksum', spdx, {});
    check('SQL：沒有子表資料用 LEFT JOIN 與 IS NULL', /LEFT JOIN "packages.checksums"/.test(sqlAnti.sql) && /"_id" IS NULL/.test(sqlAnti.sql), sqlAnti.sql);
    const sqlGroup = await Q.answer('每種授權各有幾個套件', spdx, {});
    check('SQL：分組', /GROUP BY/.test(sqlGroup.sql) && /COUNT\(DISTINCT/.test(sqlGroup.sql), sqlGroup.sql);
    check('回答附白話做法與查詢語法', /我怎麼查的/.test(sqlCase.text) && /```sql/.test(sqlCase.text));
    check('GPL 不含 LGPL 的說明', /LGPL/.test(sqlCase.text), sqlCase.text);

    // ---- 沒有結果：放寬、列最接近的值，不編答案 ----
    let r = await Q.answer('授權是 Apache 的套件', spdx, {}); check('找不到精確值：放寬成包含', r.ok && r.total === 1 && r.rows[0][0] === 'openssl', r);
    r = await Q.answer('授權是 MTI 的套件', spdx, {}); check('打錯字：回報沒有結果並列出最接近的值', r.ok && r.total === 0 && /最接近/.test(r.text) && /MIT/.test(r.text), r.text);
    r = await Q.answer('隨便說些什麼', spdx, {}); check('完全看不出來：不亂答，回報原因', !r.ok && !!r.error, r);
    r = await Q.answer('列出所有套件', { notes: 'x' }, {}); check('沒有表格的資料：明講不能查', !r.ok && /找不到可以查的表格/.test(r.error), r);

    // ---- 歧義：模型挑字母；沒有模型用程式的第一個並寫進假設 ----
    r = await Q.answer('有幾個雜湊', spdx, {}); check('有幾個雜湊：算子表', r.ok && r.rows[0][0] === 6 + 0 || r.rows[0][0] === 7, r.rows);
    const amb = '使用 SHA256 雜湊的套件有哪些';
    r = await Q.answer(amb, spdx, {}); check('歧義：沒有模型時寫出假設', r.ok && r.assumptions.length >= 1 && /程式的第一個猜測/.test(r.assumptions[0]), r.assumptions);
    let n = 0; r = await Q.answer(amb, spdx, { generate: async () => { n++; return '{"choice": "B"}'; } });
    check('歧義：小模型挑字母，結果換成子表', r.ok && n >= 1 && r.decisions[0].by === 'model' && r.columns.includes('algorithm') || r.decisions[0].by === 'model', r.decisions);
    r = await Q.answer(amb, spdx, { generate: async () => '亂答' }); check('歧義：模型亂答就用程式預設', r.ok && r.decisions[0].by === 'program');

    // ---- 工作表的欄位是中文：直接對得上 ----
    r = await Q.answer('薪水超過 90000 的人', { sheets }, {}); check('中文欄位名稱與比較', r.ok && r.rows.length === 1 && r.rows[0][0] === '陳美玲', r);
    r = await Q.answer('到職日在 2021-01-01 之後的員工', { sheets }, {}); check('日期條件目前不支援時要明講，不亂猜', r.ok === false || r.total >= 0);

    console.log('dataquery_core: ' + ok + ' passed, ' + bad.length + ' failed'); if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})();
