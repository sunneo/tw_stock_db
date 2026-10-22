// node scripts/docgen-tests/docgen.test.js -- 文件撰寫器：掃描、事實、架構比對、範本選擇、組文件、驗證、輸出格式
const D = require('../../renderer/src/docgen/docgen_core.js'), R = require('../../renderer/src/docgen/docgen_render.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }

// ---- 指令參數
const o = D.parseOptions('fap:myproj wiki:http://w/a,http://w/b format:pdf,docx template:openbmc lang:en level:detailed analysis nokb noai version:1.2 給維護人員看的');
check('options: all keys', o.fap === 'myproj' && o.wiki.length === 2 && o.format.join() === 'pdf,docx' && o.template === 'openbmc' && o.lang === 'en' && o.level === 'detailed' && o.analysis && o.nokb && o.noai && o.version === '1.2', o);
check('options: free text stays as the request', o.rest === '給維護人員看的', o.rest);
check('options: defaults', (() => { const d = D.parseOptions(''); return d.format.join() === 'md' && d.lang === 'zh-TW' && d.level === 'standard' && !d.analysis; })());
check('options: wiki/markdown aliases and bad values are reported', (() => { const d = D.parseOptions('format:wiki,markdown,exe level:huge'); return d.format.join() === 'mediawiki,md' && d.unknown.indexOf('level:huge') >= 0; })(), D.parseOptions('format:wiki,markdown,exe level:huge'));
check('options: quoted value keeps spaces', D.parseOptions('fap:"my proj"').fap === 'my proj');
check('options: publish: is refused with a reason', D.parseOptions('publish:wiki').unknown.length === 1);

// ---- 範例專案
const bmc = [
  { path: 'meta-x/recipes-phosphor/fan/phosphor-fan.bb', text: 'SUMMARY = "Fan control"\nLICENSE = "Apache-2.0"\nDEPENDS += "sdbusplus"\ninherit meson systemd\n' },
  { path: 'meta-x/recipes-phosphor/fan/phosphor-fan.bbappend', text: 'SRC_URI += "file://x.patch"\n' },
  { path: 'src/main.cpp', text: '#include <sdbusplus/bus.hpp>\nint main(int argc, char** argv)\n{\n  auto bus = sdbusplus::bus::new_default();\n  bus.request_name("xyz.openbmc_project.Fan.Control");\n  return 0;\n}\n' },
  { path: 'README.md', text: '# Fan control\n\n風扇控制服務，透過 D-Bus 對外提供轉速調整。\n\n## Usage\n\n執行 phosphor-fan 即可。\n' },
  { path: 'src/redfish.cpp', text: 'auto r = "/redfish/v1/Chassis/{}/Thermal";\n' }
];
const fb = D.analyze(bmc);
check('analyze: counts files and source lines', fb.fileCount === 5 && fb.lineCount > 5, [fb.fileCount, fb.lineCount]);
check('analyze: entry, d-bus name and redfish route carry evidence', fb.entry.some((e) => e.ev === 'src/main.cpp:2') && fb.routes.some((r) => /xyz\.openbmc_project\.Fan\.Control/.test(r.name) && r.ev === 'src/main.cpp:5') && fb.routes.some((r) => /redfish/.test(r.name)), fb.routes);
check('analyze: bitbake recipe fields', fb.build.some((b) => b.name === 'BitBake SUMMARY' && b.detail === 'Fan control') && fb.build.some((b) => b.name === 'BitBake inherit'));
check('arch: openbmc is the top and passes the threshold', fb.arch[0].id === 'openbmc' && fb.arch[0].score >= D.THRESHOLD, fb.arch.slice(0, 3));
check('arch: reasons cite files', fb.arch[0].reasons.every((r) => /見 /.test(r)));
check('readme: title, intro, sections', fb.readme && fb.readme.title === 'Fan control' && /D-Bus/.test(fb.readme.intro) && fb.readme.sections.usage);
const sel = D.selectTemplate('design', fb, {});
check('select: openbmc design template', sel.template.id === 'openbmc' && /架構比對/.test(sel.reason), sel);

const web = [
  { path: 'package.json', text: '{\n "name": "shop-api",\n "version": "2.1.0",\n "main": "server.js",\n "scripts": { "start": "node server.js", "test": "mocha" },\n "dependencies": { "express": "^4.18.0", "pg": "^8.0.0" }\n}\n' },
  { path: 'server.js', text: "const express = require('express');\nconst app = express();\napp.get('/items', (q, r) => r.json([]));\napp.post('/items', (q, r) => r.json({}));\nconst port = process.env.PORT || 3000;\napp.listen(port);\n" },
  { path: 'db/schema.sql', text: 'CREATE TABLE IF NOT EXISTS items (id INT);\nCREATE TABLE orders (id INT);\n' },
  { path: 'test/items.test.js', text: "app.get('/ignored-in-tests', 1)\n" },
  { path: 'node_modules/express/index.js', text: "app.get('/vendor', 1)" }
];
const fw = D.analyze(web);
check('analyze: vendor and test files do not feed the facts', fw.skipped === 1 && !fw.routes.some((r) => /ignored|vendor/.test(r.name)) && fw.tests === 1, [fw.skipped, fw.routes]);
check('analyze: routes, env, data, deps, scripts', fw.routes.map((r) => r.name).join() === 'GET /items,POST /items' && fw.config.some((c) => c.name === 'PORT') && fw.data.map((d) => d.name).join() === 'items,orders' && fw.deps.some((d) => d.name === 'express') && fw.build.some((b) => b.name === 'npm run start'), fw);
check('select: web-service for both kinds of documents', D.selectTemplate('design', fw, {}).template.id === 'web-service' && D.selectTemplate('user', fw, {}).template.id === 'user-web-api');
check('select: a project nothing matches uses the generic template', (() => { const g = D.analyze([{ path: 'notes.txt', text: 'hello' }]); return D.selectTemplate('design', g, {}).template.id === 'design-generic' && D.selectTemplate('user', g, {}).template.id === 'user-generic'; })());
check('select: forced template wins; unknown id falls back', D.selectTemplate('design', fw, { template: 'cgi' }).template.id === 'cgi' && D.selectTemplate('design', fw, { template: 'nope' }).template.id === 'web-service');

const cli = [
  { path: 'tool.py', text: "import argparse\np = argparse.ArgumentParser()\np.add_argument('--input', '-i', help='輸入檔')\np.add_argument('--verbose', help='多說一點')\nsub = p.add_subparsers()\nsub.add_parser('init')\nsub.add_parser('run')\nif __name__ == '__main__':\n    pass\n" }
];
const fc = D.analyze(cli);
check('analyze: argparse options with help, subcommands, entry', fc.cli.length === 2 && fc.cli[0].name === '--input, -i' && fc.cli[0].detail === '輸入檔' && fc.special.filter((s) => s.group === '子命令').length === 2 && fc.entry.length === 1, fc);

const rtos = [{ path: 'src/app.c', text: '#include "FreeRTOS.h"\nvoid start(){ xTaskCreate(vSensor, "sensor", 256, NULL, 3, NULL); }\n' }, { path: 'link/stm32.ld', text: 'MEMORY {}' }, { path: 'startup_stm32f4.s', text: '.word 0' }];
const fr = D.analyze(rtos);
check('rtos: task is extracted with priority; rtos wins', fr.special.some((s) => s.group === 'RTOS 任務' && s.name === 'sensor' && /優先權 3/.test(s.detail)) && fr.arch[0].id === 'rtos', fr.arch.slice(0, 2));

// ---- 組文件
const built = D.build('design', fb, sel.template, { version: '0.9', lang: 'zh-TW' });
const heads = built.doc.blocks.filter((b) => b.t === 'h' && b.l === 1).map((b) => b.x);
check('build: sections follow the template order and skip empty ones', heads[0] === '概述' && heads.indexOf('系統架構') === 1 && heads.indexOf('資料模型') < 0, heads);
check('build: notes what was left out and why', built.omitted.indexOf('資料模型') >= 0 && built.doc.blocks.some((b) => b.t === 'ul' && b.items.some((i) => /資料模型/.test(i))));
check('build: the narration is plain statements about this project', built.steps.length === 5 && /5 個檔案/.test(built.steps[0].text) && !/我(將|會|要)/.test(built.steps.map((s) => s.text).join('')), built.steps);
check('build: every cited file exists', D.verify(built.doc, fb).length === 0, D.verify(built.doc, fb));
check('verify: a made-up citation is caught; duplicate headings are caught', (() => { const d = { blocks: [{ t: 'h', l: 1, x: 'A' }, { t: 'h', l: 1, x: 'A' }, { t: 'p', x: '見 ghost/file.c:12' }] }; const i = D.verify(d, fb); return i.length === 2; })());
check('build: english titles', (() => { const b = D.build('design', fw, D.selectTemplate('design', fw, {}).template, { lang: 'en' }); return b.doc.blocks.some((x) => x.t === 'h' && x.x === 'Overview') && /Design Document/.test(b.doc.title); })());
check('build: level limits the table rows', (() => { const many = []; for (let i = 0; i < 80; i++) many.push({ path: 'c' + i + '.js', text: 'process.env.VAR_NUMBER_' + i + '\n' }); const f = D.analyze(many); const t = D.selectTemplate('design', f, {}).template; const a = D.build('design', f, t, { level: 'brief' }), b = D.build('design', f, t, { level: 'detailed' }); const rows = (r) => Math.max.apply(null, r.doc.blocks.filter((x) => x.t === 'table').map((x) => x.rows.length)); return rows(a) === 8 && rows(b) > 25; })());
check('build: analysis option appends the appendix', D.build('design', fb, sel.template, { analysis: true }).doc.blocks.some((b) => b.t === 'h' && b.x === '分析附錄') && !built.doc.blocks.some((b) => b.t === 'h' && b.x === '分析附錄'));
check('build: user guide has install/usage parts that come from the readme', (() => { const f = D.analyze([{ path: 'README.md', text: '# T\n\nintro text here.\n\n## 安裝\n\nnpm i -g t\n\n## 使用\n\nt run\n' }, { path: 'a.py', text: "p.add_argument('--x', help='y')\n" }]); const b = D.build('user', f, D.selectTemplate('user', f, {}).template, {}); const s = JSON.stringify(b.doc.blocks); return /npm i -g t/.test(s) && /t run/.test(s) && /--x/.test(s); })());

// ---- 自訂範本
check('custom template: sanitized, never shadows a built-in id, needs sections', D.sanitizeTemplate({ id: 'openbmc', sections: ['overview'] }) === null && D.sanitizeTemplate({ id: 'mine', sections: [] }) === null && D.sanitizeTemplate({ id: 'My Tpl!', sections: ['overview'] }).id === 'mytpl');
check('custom template: chosen for its architecture, supports 自訂 sections', (() => { const ut = [{ id: 'mybmc', kind: 'design', arch: 'openbmc', label: '我們的 BMC 範本', sections: ['overview', '自訂:簽核流程|先過 CCB 再發版', 'build'] }]; const s = D.selectTemplate('design', fb, { userTemplates: ut }); const b = D.build('design', fb, s.template, {}); return s.template.id === 'mybmc' && b.doc.blocks.some((x) => x.t === 'h' && x.x === '簽核流程') && b.doc.blocks.some((x) => x.t === 'p' && /CCB/.test(x.x)); })());
check('custom template: listTemplates merges built-in and custom', D.listTemplates([{ id: 'zz', sections: ['overview'] }]).length === 20);

// ---- 潤飾驗收
check('rewrite: only long paragraphs are offered', (() => { const p = D.rewritePlan({ blocks: [{ t: 'h', x: 'a' }, { t: 'p', x: '短' }, { t: 'p', x: '這是一段夠長的說明文字，包含 `foo.js` 與 3 個項目的描述。' }] }); return p.length === 1 && p[0].index === 2; })());
const orig = '這個服務由 `server.js` 啟動，監聽埠 3000，提供 2 個路由（見 server.js:6）。';
check('rewrite: accepts a smoother sentence that keeps every identifier and number', D.acceptRewrite(orig, '服務從 `server.js` 啟動，在埠 3000 上提供 2 個路由（見 server.js:6）。').ok);
check('rewrite: rejects a lost identifier, a changed number, a new heading, new url, too short/long', !D.acceptRewrite(orig, '這個服務監聽埠 3000，提供 2 個路由（見 server.js:6）。').ok && !D.acceptRewrite(orig, '這個服務由 `server.js` 啟動，監聽埠 8080，提供 2 個路由（見 server.js:6）。').ok && !D.acceptRewrite(orig, '# 標題\n' + orig).ok && !D.acceptRewrite(orig, orig + ' 詳見 https://x.example/a').ok && !D.acceptRewrite(orig, '好').ok && !D.acceptRewrite(orig, orig + orig + orig).ok);

// ---- 輸出格式
const doc = { title: '範例 設計文件', subtitle: '給維護人員', meta: { version: '1.0', date: '2026-10-22', lang: 'zh-TW', template: '通用' }, blocks: [{ t: 'h', l: 1, x: '概述' }, { t: 'p', x: '這是 **重點** 與 `code`。' }, { t: 'ul', items: ['甲', '乙 `x`'] }, { t: 'ol', items: ['一', '二'] }, { t: 'table', head: ['名稱', '說明'], rows: [['`a|b`', '含 | 直線'], ['c', '<tag>']] }, { t: 'code', lang: 'js', x: 'let a = 1 < 2;' }, { t: 'fig', kind: 'mermaid', src: 'flowchart LR\nA-->B', caption: '示意' }, { t: 'quote', x: '引言' }, { t: 'pb' }, { t: 'h', l: 2, x: '細節' }, { t: 'p', x: '尾' }] };
const md = R.toMarkdown(doc), wk = R.toMediaWiki(doc), ht = R.toHtml(doc);
check('md: heading levels, table escaping, fenced blocks', /^# 範例 設計文件/.test(md) && /\n## 概述\n/.test(md) && /\| `a\\\|b` \|/.test(md) && /```mermaid\nflowchart LR/.test(md) && /```js\nlet a = 1 < 2;\n```/.test(md) && /\n### 細節\n/.test(md), md);
check('mediawiki: headings, lists, wikitable, code is escaped', /^= 範例 設計文件 =/.test(wk) && /\n== 概述 ==\n/.test(wk) && /\* 甲/.test(wk) && /\n# 一\n/.test(wk) && /\{\| class="wikitable"/.test(wk) && /'''重點'''/.test(wk) && /<code>code<\/code>/.test(wk) && /let a = 1 &lt; 2;/.test(wk) && /含 &#124; 直線/.test(wk), wk);
check('html: escaped content, toc, mermaid script only when there is a figure', /<title>範例 設計文件<\/title>/.test(ht) && /&lt;tag&gt;/.test(ht) && /<strong>重點<\/strong>/.test(ht) && /class="mermaid"/.test(ht) && /mermaid@10\.9\.1/.test(ht) && !/mermaid@/.test(R.toHtml({ title: 't', blocks: [{ t: 'p', x: 'x' }] })) && /<!doctype html>/.test(ht));
const pd = R.toPdfmake(doc);
check('pdfmake: uses the CJK font, has footer, table header and code block', pd.defaultStyle.font === 'NotoSansTC' && typeof pd.footer === 'function' && pd.content.some((c) => c.table && c.table.headerRows === 1) && pd.content.some((c) => c.table && c.table.body[0][0].style === 'code') && pd.content.some((c) => c.pageBreak === 'after'));
const dx = R.toDocxParts(doc);
check('docx: required parts, escaped text, heading styles, table, page break', ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels'].every((k) => dx[k]) && /Heading1/.test(dx['word/document.xml']) && /<w:tbl>/.test(dx['word/document.xml']) && /1 &lt; 2/.test(dx['word/document.xml']) && /w:br w:type="page"/.test(dx['word/document.xml']) && /heading 1/.test(dx['word/styles.xml']));
check('docx: tags are balanced', Object.keys(dx).every((k) => { const t = dx[k].replace(/<\?xml[^>]*\?>/, ''); const open = (t.match(/<[A-Za-z][^>]*[^/]>/g) || []).length, close = (t.match(/<\/[A-Za-z:]+>/g) || []).length; return open === close; }));
check('control characters never reach the xml', !/[\u0000-\u0008]/.test(R.toDocxParts({ title: 'a\u0001b', blocks: [{ t: 'p', x: 'x\u0002y' }] })['word/document.xml']));
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'docgen: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
