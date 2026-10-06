/* 設計檢視器的資料（FaView）：把「設計＋實作」整理成一棵可以逐層深入的節點樹——系統 → 套件 → 類別／使用案例 → 操作——
 * 每個節點有自己的圖（UML 子圖）、設計說明（為什麼這樣）、參考（對應的原始碼檔案與行號、用到的 library 文件、相關節點）與可以做的動作（切細、重新設計這一區…）。
 * 全部由程式從 UML 模型與產生出來的檔案推出來——**弱的 AI 或離線訓練器也能用同一套節點與動作逐步深入**：每個動作都是封閉的、有型別的小操作。
 * 純函式（UMD）。viewer 的 HTML 在 uml-viewer.template.html；這裡只負責資料與把資料塞進 HTML。
 */
(function (root, factory) {
    const U = (typeof FaUml !== 'undefined' && FaUml) || (root && root.FaUml) || (typeof require === 'function' ? require('./uml_core.js') : null);
    const D = (typeof FaDesign !== 'undefined' && FaDesign) || (root && root.FaDesign) || (typeof require === 'function' ? require('./design_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(U, D);
    else root.FaView = factory(U, D);
})(typeof self !== 'undefined' ? self : this, function (U, D) {
    'use strict';
    const snake = (s) => U.FILTERS.snake(s), pascal = (s) => U.FILTERS.pascal(s);
    // 第三方 library 的文件連結（資料）
    const LIB_DOCS = { fastapi: 'https://fastapi.tiangolo.com/', uvicorn: 'https://www.uvicorn.org/', sqlalchemy: 'https://docs.sqlalchemy.org/en/20/', pydantic: 'https://docs.pydantic.dev/latest/', pytest: 'https://docs.pytest.org/', typer: 'https://typer.tiangolo.com/', httpx: 'https://www.python-httpx.org/', pyjwt: 'https://pyjwt.readthedocs.io/', apscheduler: 'https://apscheduler.readthedocs.io/', structlog: 'https://www.structlog.org/', celery: 'https://docs.celeryq.dev/', pymongo: 'https://pymongo.readthedocs.io/', express: 'https://expressjs.com/', commander: 'https://github.com/tj/commander.js', prisma: 'https://www.prisma.io/docs', zod: 'https://zod.dev/', vitest: 'https://vitest.dev/', pino: 'https://getpino.io/', axios: 'https://axios-http.com/', jsonwebtoken: 'https://github.com/auth0/node-jsonwebtoken', 'node-cron': 'https://github.com/node-cron/node-cron', bullmq: 'https://docs.bullmq.io/', 'spring-boot-web': 'https://docs.spring.io/spring-boot/', picocli: 'https://picocli.info/', 'spring-data-jpa': 'https://docs.spring.io/spring-data/jpa/reference/', 'junit-jupiter': 'https://junit.org/junit5/', slf4j: 'https://www.slf4j.org/', 'spring-security': 'https://docs.spring.io/spring-security/reference/' };
    const ROLE_LABEL = { domain: '領域類別', repository: 'Repository 介面', 'repository-sql': 'Repository 實作（SQL）', orm: 'ORM 模型', schema: 'API schema', factory: '工廠', service: '使用案例 service', api: 'API 路由', cli: '命令列', test: '測試', config: '設定／基礎' };

    // ---------- 符號索引：從原始碼找出定義（類別、函式、方法）與行號，對應回 UML ----------
    function symbolIndex(files, model) {
        const names = model.classes.map((c) => c.name); const ucNames = model.usecases.map((u) => ({ uc: u, cn: pascal(String(u.name).replace(/[^A-Za-z0-9_ ]/g, ' ').trim() || 'UseCase') }));
        const out = []; const classRe = /^(\s*)(?:export\s+)?(?:public\s+)?(?:abstract\s+)?(?:@dataclass\s+)?(class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/; const defRe = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
        const jsMethod = /^(\s+)(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:[A-Za-z_<>\[\],.? ]+\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{?\s*;?\s*$/;
        const owner = (sym) => { // 符號名稱 → UML 類別
            for (const n of names) { if (sym === n || sym === n + 'Row' || sym === n + 'Base' || sym === n + 'Create' || sym === n + 'Read' || sym === n + 'Repository' || sym === 'InMemory' + n + 'Repository' || sym === 'Sql' + n + 'Repository' || sym === 'new_' + snake(n) || sym === '_new_' + snake(n)) return n; }
            return null;
        };
        const roleOf = (path, sym, n) => { if (sym === n) return /(^|\/)tests?\//.test(path) ? 'test' : 'domain'; if (sym === n + 'Row') return 'orm'; if (/Create$|Read$|Base$/.test(sym)) return 'schema'; if (sym === 'Sql' + n + 'Repository') return 'repository-sql'; if (/Repository$/.test(sym)) return 'repository'; if (/^_?new_/.test(sym)) return 'factory'; return 'domain'; };
        for (const f of files) {
            if (!/\.(py|ts|java)$/.test(f.path)) continue; const lines = String(f.content).split('\n'); let cur = null; let curIndent = -1;
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i]; let m;
                if ((m = classRe.exec(l))) { const sym = m[3]; cur = { name: sym, indent: m[1].length }; curIndent = m[1].length; const n = owner(sym); const ucm = ucNames.find((x) => sym === x.cn + 'Service' || sym === x.cn + 'Test');
                    if (n) out.push({ file: f.path, line: i + 1, name: sym, kind: 'class', node: 'class:' + n, role: roleOf(f.path, sym, n) });
                    else if (ucm) out.push({ file: f.path, line: i + 1, name: sym, kind: 'class', node: 'usecase:' + ucm.uc.name, role: /Test$/.test(sym) ? 'test' : 'service' });
                    continue; }
                if ((m = defRe.exec(l))) { const sym = m[2]; const ind = m[1].length;
                    if (cur && ind > cur.indent) { const n = owner(cur.name); if (n) { const cls = model.classes.find((c) => c.name === n); const op = cls && cls.ops.find((o) => o.name === sym || snake(o.name) === sym); if (op) out.push({ file: f.path, line: i + 1, name: n + '.' + op.name, kind: 'op', node: 'op:' + n + '.' + op.name, role: roleOf(f.path, cur.name, n) }); }
                        const ucm = ucNames.find((x) => cur.name === x.cn + 'Service'); if (ucm && sym === 'execute') out.push({ file: f.path, line: i + 1, name: ucm.cn + '.execute', kind: 'op', node: 'usecase:' + ucm.uc.name, role: 'service' }); }
                    else { const ucm = ucNames.find((x) => sym === snake(x.cn) || sym === 'test_' + snake(x.cn)); if (ucm) out.push({ file: f.path, line: i + 1, name: sym, kind: 'func', node: 'usecase:' + ucm.uc.name, role: /^test_/.test(sym) ? 'test' : (/cli\.py$/.test(f.path) ? 'cli' : 'api') }); const en = names.find((n) => sym === 'new_' + snake(n) || sym === 'test_' + snake(n) + '_crud'); if (en) out.push({ file: f.path, line: i + 1, name: sym, kind: 'func', node: 'class:' + en, role: /^test_/.test(sym) ? 'test' : 'factory' }); }
                    continue; }
                if (/\.(ts|java)$/.test(f.path) && cur && (m = jsMethod.exec(l)) && m[1].length > cur.indent && !/^(if|for|while|switch|return|catch|throw|new)$/.test(m[2])) { const n = owner(cur.name); if (n) { const cls = model.classes.find((c) => c.name === n); const op = cls && cls.ops.find((o) => o.name === m[2]); if (op) out.push({ file: f.path, line: i + 1, name: n + '.' + op.name, kind: 'op', node: 'op:' + n + '.' + op.name, role: roleOf(f.path, cur.name, n) }); } const ucm = ucNames.find((x) => cur.name === x.cn + 'Service'); if (ucm && m[2] === 'execute') out.push({ file: f.path, line: i + 1, name: ucm.cn + '.execute', kind: 'op', node: 'usecase:' + ucm.uc.name, role: 'service' }); }
            }
            // 路由 / 指令（decorator 的下一行是函式）：對應使用案例
            for (let i = 0; i < lines.length; i++) { const m = /@(?:usecase_router\.(?:get|post|delete)|app\.command)\("\/?([a-z0-9-]+)"\)/.exec(lines[i]); if (m) { const ucm = ucNames.find((x) => (snake(x.cn) || '').replace(/_/g, '-') === m[1]); if (ucm) out.push({ file: f.path, line: i + 1, name: m[1], kind: 'route', node: 'usecase:' + ucm.uc.name, role: /cli\.py$/.test(f.path) ? 'cli' : 'api' }); } }
            // 使用案例的 TS/Java 測試與 controller
            for (let i = 0; i < lines.length; i++) { const m = /@PostMapping\("\/([a-z0-9-]+)"\)|router\.post\("\/([a-z0-9-]+)"/.exec(lines[i]); if (m) { const key = m[1] || m[2]; const ucm = ucNames.find((x) => (snake(x.cn) || '').replace(/_/g, '-') === key); if (ucm) out.push({ file: f.path, line: i + 1, name: key, kind: 'route', node: 'usecase:' + ucm.uc.name, role: 'api' }); } }
        }
        // 檔案層級的對應（沒有符號可標時）：測試檔
        for (const f of files) { const m = /(?:tests?\/(?:test_)?|\/)([A-Za-z0-9_]+?)(?:\.test)?(?:Test)?\.(?:py|ts|java)$/.exec(f.path); if (!m || !/tests?\//.test(f.path)) continue; const ucm = ucNames.find((x) => snake(x.cn) === snake(m[1]) || x.cn === m[1].replace(/Test$/, '')); if (ucm && !out.some((s) => s.file === f.path && s.node === 'usecase:' + ucm.uc.name)) out.push({ file: f.path, line: 1, name: f.path, kind: 'file', node: 'usecase:' + ucm.uc.name, role: 'test' }); }
        return out;
    }

    // ---------- 設計說明（程式從模型推出，每一段都能對到設計決定）----------
    function usedIn(model, className) { return model.usecases.filter((u) => u.steps.some((s) => s.to === className) || u.actor === className).map((u) => u.name); }
    function relText(model, name) { const R = { inherit: '繼承', implement: '實作', compose: '組成', aggregate: '聚合', assoc: '關聯', depend: '依賴' }; return model.relations.filter((r) => r.from === name || r.to === name).map((r) => (r.from === name ? '它 ' + R[r.kind] + ' ' + r.to : r.from + ' ' + R[r.kind] + ' 它') + (r.label ? '（' + r.label + '）' : '')); }
    function classDesign(model, c, design) {
        const uses = usedIn(model, c.name); const rels = relText(model, c.name); const lines = [];
        lines.push(c.name + (c.label ? '（' + c.label + '）' : '') + ' 是' + ({ class: '一般類別', interface: '介面', enum: '列舉', abstract: '抽象類別' }[c.kind] || '類別') + '。');
        if (uses.length) lines.push('它出現在使用案例：' + uses.join('、') + '。'); else lines.push('目前沒有任何使用案例用到它（可能是輔助類別，或設計還沒補完）。');
        if (rels.length) lines.push('關係：' + rels.join('；') + '。');
        if (c.kind === 'enum') lines.push('值：' + (c.values || []).join('、') + '。'); else { if (c.attrs.length) lines.push('屬性：' + c.attrs.map((a) => a.name + ':' + U.typeToString(a.type)).join('、') + '。'); if (c.ops.length) lines.push('操作：' + c.ops.map((o) => o.name + '(' + o.params.map((p) => p.name).join(', ') + ')').join('、') + '。'); }
        const per = design && design.choices && design.choices.find((x) => x.concern === 'persistence'); if (per && per.option !== 'none' && c.kind === 'class' && c.attrs.some((a) => a.name === 'id')) lines.push('它是實體（有 id），資料儲存選「' + per.optionLabel + '」，所以有 Repository 與 ' + (per.option === 'memory' ? '記憶體實作' : 'SQL 實作與 ORM 模型') + '。');
        return lines.join('\n');
    }
    function usecaseDesign(model, u) { const L = ['使用案例「' + u.name + '」：' + u.actor + ' 想完成' + (u.summary ? '「' + u.summary + '」' : '這件事') + '。']; if (u.steps.length) L.push('呼叫順序：' + u.actor + ' → ' + u.steps.map((s) => s.to + '.' + s.msg + '()').join(' → ') + '。'); else L.push('還沒有呼叫順序（設計還沒補完）。'); return L.join('\n'); }
    function systemDesign(model, design, glue) {
        const L = [model.name + '：' + model.classes.length + ' 個類別、' + model.usecases.length + ' 個使用案例、' + model.relations.length + ' 條關係。'];
        if (design && design.architecture) L.push('架構：' + design.architecture.label + '（' + design.architecture.by + '：' + design.architecture.reason + '）。');
        if (design && design.choices) L.push('抉擇：' + design.choices.filter((c) => c.option !== 'none').map((c) => c.label + '＝' + c.optionLabel + (c.lib && c.lib !== 'none' ? '（' + c.lib + '）' : '') + ' [' + c.by + ']').join('；') + '。');
        if (glue && glue.length) L.push('膠水：' + glue.map((g) => g.id).join('、') + '。');
        return L.join('\n');
    }

    // ---------- 節點樹 ----------
    // input: { model, files:[{path,content,region}], design, glue, scenario, language, dsl, packages? }
    function buildBundle(input) {
        const model = input.model; const files = input.files || []; const design = input.design || {}; const glue = input.glue || []; const packages = input.packages || (D ? D.packagesOf(model) : []);
        const symbols = symbolIndex(files, model); const nodes = {}; const add = (n) => { nodes[n.id] = Object.assign({ children: [], diagram: null, design: { summary: '', decisions: [] }, reference: { files: [], libs: [], related: [] }, actions: [] }, n); return nodes[n.id]; };
        const filesOf = (nodeId) => { const seen = new Map(); for (const s of symbols) if (s.node === nodeId && (s.kind === 'class' || s.kind === 'file' || s.kind === 'route' || s.kind === 'func')) { const k = s.file + ':' + s.role; if (!seen.has(k)) seen.set(k, { path: s.file, role: s.role, roleLabel: ROLE_LABEL[s.role] || s.role, line: s.line, symbol: s.name }); } return Array.from(seen.values()); };
        const libsOf = () => { const out = []; for (const c of design.choices || []) if (c.lib && c.lib !== 'none' && !out.some((x) => x.name === c.lib)) out.push({ name: c.lib, concern: c.label, doc: LIB_DOCS[c.lib] || '' }); return out; };
        const root = add({ id: 'system', level: 'system', title: model.name, parent: null, diagram: { kind: 'overview' }, design: { summary: systemDesign(model, design, glue), decisions: [{ who: design.architecture ? design.architecture.by : 'program', what: '架構：' + (design.architecture ? design.architecture.label : '未選'), why: design.architecture ? design.architecture.reason : '' }].concat((design.choices || []).filter((c) => c.option !== 'none' || c.by !== 'default').map((c) => ({ who: c.by, what: c.label + '：' + c.optionLabel + (c.lib && c.lib !== 'none' ? '（' + c.lib + '）' : ''), why: c.reason }))) }, reference: { files: files.filter((f) => /^(README\.md|docs\/|requirements\.txt|package\.json)/.test(f.path)).map((f) => ({ path: f.path, role: 'config', roleLabel: '專案', line: 1 })), libs: libsOf(), related: [] }, actions: ['rework-system', 'add-usecase'] });
        // 套件：關係與使用案例連通的類別群；只有一個套件就不多一層
        const classNodeParent = (name) => { if (packages.length <= 1) return 'system'; const p = packages.find((x) => x.classes.includes(name)); return p ? 'package:' + p.name : 'system'; };
        if (packages.length > 1) for (const p of packages) { const n = add({ id: 'package:' + p.name, level: 'package', title: p.name + '（套件）', parent: 'system', diagram: { kind: 'class', classes: p.classes }, design: { summary: '套件「' + p.name + '」：' + p.classes.join('、') + '。這一群類別靠關係與使用案例連在一起，可以當成一個子系統看。', decisions: [{ who: 'program', what: '分群', why: '依關係與使用案例的連通分量（packagesOf）' }] }, reference: { files: [], libs: [], related: [] }, actions: ['rework-region'] }); root.children.push(n.id); }
        for (const c of model.classes) {
            const parent = classNodeParent(c.name); const id = 'class:' + c.name; const rel = Array.from(new Set(model.relations.filter((r) => r.from === c.name || r.to === c.name).map((r) => (r.from === c.name ? r.to : r.from))));
            const n = add({ id, level: 'class', title: c.name + (c.label ? '（' + c.label + '）' : ''), kind: c.kind, parent, diagram: { kind: 'class', classes: [c.name].concat(rel), focus: c.name }, design: { summary: classDesign(model, c, design), decisions: [{ who: 'program', what: '類別的來源', why: usedIn(model, c.name).length ? '被使用案例 ' + usedIn(model, c.name).join('、') + ' 用到' : '情境中的領域概念' }] }, reference: { files: filesOf(id), libs: [], related: rel.map((x) => 'class:' + x).concat(usedIn(model, c.name).map((x) => 'usecase:' + x)) }, actions: ['rework-region', 'add-members', 'show-code'] });
            nodes[parent].children.push(id);
            for (const o of c.ops) { const oid = 'op:' + c.name + '.' + o.name; const used = model.usecases.filter((u) => u.steps.some((s) => s.to === c.name && s.msg === o.name)); const sy = symbols.filter((s) => s.node === oid); const op = add({ id: oid, level: 'op', title: c.name + '.' + o.name + '(' + o.params.map((p) => p.name + ':' + U.typeToString(p.type)).join(', ') + '):' + U.typeToString(o.returns), parent: id, diagram: { kind: 'ops', classes: [c.name], focus: o.name }, design: { summary: '操作 ' + c.name + '.' + o.name + (used.length ? ' 在使用案例 ' + used.map((u) => u.name).join('、') + ' 裡被呼叫。' : ' 目前沒有被任何使用案例呼叫。') + '\n簽章：' + o.name + '(' + o.params.map((p) => p.name + ':' + U.typeToString(p.type)).join(', ') + '):' + U.typeToString(o.returns) + '。', decisions: [] }, reference: { files: sy.map((s) => ({ path: s.file, role: s.role, roleLabel: ROLE_LABEL[s.role] || s.role, line: s.line, symbol: s.name })), libs: [], related: used.map((u) => 'usecase:' + u.name) }, actions: ['show-code'] }); nodes[id].children.push(oid); }
        }
        for (const u of model.usecases) { const id = 'usecase:' + u.name; const parts = Array.from(new Set(u.steps.map((s) => s.to))); const n = add({ id, level: 'usecase', title: u.name + '（' + u.actor + '）', parent: 'system', diagram: { kind: 'sequence', usecase: u.name, classes: parts }, design: { summary: usecaseDesign(model, u), decisions: [{ who: 'program', what: '呼叫順序', why: '依使用案例的步驟（動作表或模型的回答）' }] }, reference: { files: filesOf(id), libs: [], related: parts.map((x) => 'class:' + x) }, actions: ['rework-region', 'show-code'] }); root.children.push(id); }
        // 反向：符號 → 節點、檔案 → 符號
        return { version: 1, title: model.name, language: input.language || 'python', scenario: input.scenario || '', dsl: input.dsl || U.toDsl(model), design: { architecture: design.architecture, choices: (design.choices || []).map((c) => ({ concern: c.concern, label: c.label, optionLabel: c.optionLabel, option: c.option, lib: c.lib, by: c.by, reason: c.reason })) }, glue: glue.map((g) => ({ id: g.id, slot: g.slot, label: g.label, verified: g.verified, source: g.source })), model, nodes, root: 'system', symbols, files: files.map((f) => ({ path: f.path, region: f.region || '', content: f.content })), roleLabels: ROLE_LABEL };
    }
    // 把資料塞進 viewer 的 HTML（避免 </script> 提早結束）
    function viewerHtml(template, bundle) { const json = JSON.stringify(bundle).replace(/</g, '\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029'); return String(template).replace('__BUNDLE__', () => json); }
    // 節點 → 訓練器可以學的參考文字（離線模型問「Cart 是做什麼的」時用）
    function nodeReferences(bundle) { return Object.values(bundle.nodes).filter((n) => n.level === 'class' || n.level === 'usecase').map((n) => ({ id: n.id, title: n.title, text: n.design.summary + (n.reference.files.length ? '\n檔案：' + n.reference.files.map((f) => f.path + ':' + f.line).join('、') : '') })); }
    return { LIB_DOCS, ROLE_LABEL, symbolIndex, buildBundle, viewerHtml, nodeReferences, classDesign, usecaseDesign, systemDesign };
});
