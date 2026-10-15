// node renderer/src/catalog/catalog_core.test.js
const C = require('./catalog_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 型別字串
for (const s of ['text', 'number', 'list<text>', 'list<list<int>>', 'enum<a|b|c>', 'union<text|int>', 'object{a:text,b:list<int>}', 'dict', 'any']) check('type round trip: ' + s, C.typeToString(C.parseType(s)) === s, C.typeToString(C.parseType(s)));
for (const s of ['list<', 'enum<>', 'object{a}', 'text text', '123']) { let threw = false; try { C.parseType(s); } catch (_) { threw = true; } check('bad type rejected: ' + s, threw); }
check('empty type is any', C.parseType('').k === 'any');

// --- 相容
const as = C.isAssignable;
check('int fits number', as('int', 'number')); check('number does not fit int', !as('number', 'int'));
check('path fits text, text does not fit path', as('path', 'text') && !as('text', 'path'));
check('any both ways', as('any', 'int') && as('list<text>', 'any'));
check('list covariance', as('list<int>', 'list<number>') && !as('list<number>', 'list<int>'));
check('enum subset', as('enum<a|b>', 'enum<a|b|c>') && !as('enum<a|b|c>', 'enum<a|b>') && as('enum<a|b>', 'text') && !as('text', 'enum<a|b>'));
check('union both sides', as('int', 'union<text|int>') && !as('bool', 'union<text|int>') && as('union<int|number>', 'number'));
check('object needs the target fields', as('object{a:text,b:int}', 'object{a:text}') && !as('object{a:text}', 'object{a:text,b:int}'));
check('json and dict', as('json', 'dict') && as('dict', 'json') && !as('json', 'text'));

// --- JSON Schema → 型別
const st = C.schemaType;
check('string', eq(st({ type: 'string' }, 'text'), { type: 'text', src: 'schema' }));
check('name refines string', st({ type: 'string' }, 'file_path').type === 'path' && st({ type: 'string' }, 'url').type === 'url' && st({ type: 'string' }, 'file_id').type === 'file_id' && st({ type: 'string' }, 'query').type === 'query' && st({ type: 'string' }, 'x').type === 'text');
check('name refinement is marked name', st({ type: 'string' }, 'url').src === 'name');
check('integer/number/boolean', st({ type: 'integer' }).type === 'int' && st({ type: 'number' }).type === 'number' && st({ type: 'boolean' }).type === 'bool');
check('array of strings', st({ type: 'array', items: { type: 'string' } }).type === 'list<text>');
check('array without items is unknown', eq(st({ type: 'array' }), { type: 'list<any>', src: 'none' }));
check('enum', st({ type: 'string', enum: ['a', 'b'] }).type === 'enum<a|b>');
check('object with properties', st({ type: 'object', properties: { a: { type: 'string' }, n: { type: 'integer' } } }).type === 'object{a:text,n:int}');
check('object without properties is dict', st({ type: 'object' }).type === 'dict');
check('oneOf is a union', st({ oneOf: [{ type: 'string' }, { type: 'integer' }] }).type === 'union<text|int>');
check('type list with null', st({ type: ['string', 'null'] }).type === 'text');
check('no type is any/none', eq(st({}), { type: 'any', src: 'none' }) && eq(st(null), { type: 'any', src: 'none' }));
check('every produced type parses', [{ type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } } } } } }, { enum: ['a b', 'c|d'] }, { type: ['string', 'number'] }].every((s) => { try { C.parseType(st(s).type); return true; } catch (_) { return false; } }));

// --- 副作用
const ef = C.effectsOf;
check('fs read is desktop', eq(ef('fs_read_file'), ['fs.read', 'desktop']));
check('fap read needs no desktop', eq(ef('fap_read_file'), ['fs.read']));
check('git clone', eq(ef('git_clone'), ['fs.write', 'net', 'desktop']));
check('python_execute is proc', ef('python_execute').includes('proc') && !ef('python_execute').includes('desktop'));
check('terminal and tmux', ef('terminal_run').includes('proc') && ef('tmux_start_session').includes('desktop'));
check('fetch is net', eq(ef('fetch_web_page'), ['net']));
check('browser control', ef('browser_click').includes('ui') && ef('browser_get_page_text').includes('browser') && !ef('browser_get_page_text').includes('ui'));
check('render has ui and state.write', ef('render_3d_scene').includes('ui') && ef('render_3d_scene').includes('state.write'));
check('lookups read state', eq(ef('lookup_error_code'), ['state.read']) && eq(ef('ref_lookup'), ['state.read']));
check('define writes state', ef('behavior_define').includes('state.write') && ef('add_ai_function').includes('state.write'));
check('delegate', eq(ef('delegate_to_subagent'), ['delegate']) && ef('delegate_to_machine').includes('net'));
check('unknown is conservative', eq(ef('totally_new_tool'), ['unknown']));
check('suffix id is ignored', eq(ef('read_skill_file__4f8a41c9-5d9c-449f-869c-f3442fa7c794'), ['state.read']));
check('effects are in vocabulary order and unique', ef('git_clone').every((e, i, a) => C.EFFECTS.indexOf(e) >= 0 && a.indexOf(e) === i));

// --- 工具 → 單元
const schema = { type: 'object', properties: { file_path: { type: 'string', description: '要讀的檔案' }, offset: { type: 'integer', default: 0 }, mode: { type: 'string', enum: ['text', 'hex'] } }, required: ['file_path'] };
const u = C.toolToUnit('fs_read_file', { description: '讀一個檔案。回傳內容與 has_more。多的細節。', parametersSchema: schema }, { platform: 'desktop', domainsOf: { fs_read_file: ['files'] }, domainEnabled: { files: true } });
check('unit shape', u.id === 'tool:fs_read_file' && u.runtime === 'app' && u.name === 'fs_read_file' && u.summary === '讀一個檔案。' && eq(u.params.map((p) => p.name), ['file_path', 'offset', 'mode']), u);
check('unit params typed', u.params[0].type === 'path' && u.params[0].required === true && u.params[1].type === 'int' && u.params[1].default === 0 && u.params[2].type === 'enum<text|hex>' && u.params[1].required === false, u.params);
check('unit validates', eq(C.validateUnit(u), []), C.validateUnit(u));
check('tier 1 when typed and effects known', u.tier === 1 && eq(u.avail, { state: 'builtin', needs: ['desktop'] }), [u.tier, u.avail]);
const uw = C.toolToUnit('fs_read_file', { description: 'x', parametersSchema: schema }, { platform: 'web' }); check('desktop-only is unavailable on web and tier 0', uw.avail.state === 'unavailable' && uw.tier === 0);
const ud = C.toolToUnit('fap_read_file', { description: 'x', parametersSchema: schema }, { domainsOf: { fap_read_file: ['a', 'b'] }, domainEnabled: { a: false, b: false } }); check('disabled when every domain is off', ud.avail.state === 'disabled');
const ud2 = C.toolToUnit('fap_read_file', { description: 'x', parametersSchema: schema }, { domainsOf: { fap_read_file: ['a', 'b'] }, domainEnabled: { a: false, b: true } }); check('not disabled when one domain is on', ud2.avail.state === 'builtin');
const un = C.toolToUnit('mystery', { description: 'd', parametersSchema: { type: 'object', properties: { x: {} } } }); check('unknown tool/untyped param is tier 0 and still valid', un.tier === 0 && un.effects[0] === 'unknown' && eq(C.validateUnit(un), []), C.validateUnit(un));
const ns = C.toolToUnit('no_schema_tool', { description: 'd' }); check('no schema marked', ns.no_schema === true && ns.params.length === 0 && ns.tier === 0);

// --- 驗證會抓到錯誤
check('validate: bad id', C.validateUnit(Object.assign({}, u, { id: 'Bad Id' })).length > 0);
check('validate: duplicate param', C.validateUnit(Object.assign({}, u, { params: [u.params[0], u.params[0]] })).some((e) => /重複/.test(e)));
check('validate: bad type', C.validateUnit(Object.assign({}, u, { params: [Object.assign({}, u.params[0], { type: 'list<' })] })).some((e) => /型別/.test(e)));
check('validate: bad effect', C.validateUnit(Object.assign({}, u, { effects: ['teleport'] })).some((e) => /effect/.test(e)));
check('validate: pure with effects', C.validateUnit(Object.assign({}, u, { pure: true })).some((e) => /pure/.test(e)));
check('validate: empty effects but not pure', C.validateUnit(Object.assign({}, u, { effects: [] })).length > 0);
check('validate: pure with no effects is fine', eq(C.validateUnit(Object.assign({}, u, { effects: [], pure: true })), []));

// --- 目錄與評量
const cat = C.buildCatalog({ fs_read_file: { description: '讀檔。', parametersSchema: schema }, mystery: { description: 'd', parametersSchema: { type: 'object', properties: { x: {} } } }, fap_read_file: { description: '讀。', parametersSchema: schema } }, { files: { enabled: true, toolNames: ['fs_read_file'] } }, { now: '2026-01-01T00:00:00Z' });
check('catalog is sorted and complete', eq(cat.units.map((x) => x.name), ['fap_read_file', 'fs_read_file', 'mystery']) && cat.version === 1 && cat.generatedAt === '2026-01-01T00:00:00Z');
check('catalog domains attached', cat.units.find((x) => x.name === 'fs_read_file').domains[0] === 'files');
check('stats', cat.stats.units === 3 && cat.stats.invalid === 0 && cat.stats.tier1 === 2 && cat.stats.effects_known_pct === 66.7 && cat.stats.params === 7 && cat.stats.by_effect.desktop === 1, cat.stats);
check('index is compact', eq(Object.keys(C.index(cat)[0]), ['id', 'name', 'summary', 'tier', 'avail', 'effects']));
check('catalog serializes', JSON.parse(JSON.stringify(cat)).units.length === 3);
check('untyped number-like param inferred from name', eq(C.schemaType({}, 'start_seconds'), { type: 'number', src: 'name' }) && C.schemaType({}, 'times').src === 'none' && C.schemaType({ description: 'x' }, 'fps').type === 'number');
check('call_ai_function and playbook_state are not unknown', !C.effectsOf('call_ai_function').includes('unknown') && !C.effectsOf('playbook_state').includes('unknown'));
check('stats split by source and list untyped', cat.stats.typed_by_schema_pct !== undefined && cat.stats.typed_by_name_pct !== undefined && Array.isArray(cat.stats.untyped) && cat.stats.untyped.includes('mystery.x'), cat.stats);
check('tools that can reach the network are marked net', ef('text_to_speech').includes('net') && ef('transcribe_media').includes('net') && ef('language_explore').includes('net'));
check('param description mentioning file_id makes it a file_id (kind from the name)', st({ type: 'string', description: '影片 file_id 或檔名' }, 'video').type === 'video_file' && st({ type: 'string', description: '要處理的 file_id' }, 'target').type === 'file_id' && st({ type: 'string', description: '要處理的 file_id' }, 'target').src === 'doc' && st({ type: 'string', description: '一般文字' }, 'video').type === 'text');
check('kinded file ids by name', st({ type: 'string' }, 'pdf_file_id').type === 'pdf_file' && st({ type: 'string' }, 'video_file_id').type === 'video_file' && st({ type: 'string' }, 'file_id').type === 'file_id');
check('kinded assignability', C.isAssignable('video_file', 'file_id') && C.isAssignable('video_file', 'text') && !C.isAssignable('file_id', 'video_file') && !C.isAssignable('pdf_file', 'video_file') && C.isAssignable('gif_file', 'image_file') && C.isAssignable('gif_file', 'file_id'));
check('array of file_id by description', st({ type: 'array', items: { type: 'string' }, description: 'files＝file_id 或檔名' }, 'files').type === 'list<file_id>' && st({ type: 'array', items: { type: 'string' } }, 'files').type === 'list<text>');
check('name rule still wins over description', st({ type: 'string', description: 'file_id' }, 'url').type === 'url');
check('subtitle kind from name and from field', st({ type: 'string', description: '字幕 file_id' }, 'subtitle').type === 'subtitle_file' && C.inferReturns('t', '回傳 {ok, transcript_file_id}').type === 'object{ok:bool,transcript_file_id:subtitle_file}' && C.isAssignable('subtitle_file', 'file_id') && !C.isAssignable('pdf_file', 'subtitle_file'));
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'catalog_core: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
