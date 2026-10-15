// node renderer/src/catalog/shape_core.test.js
const Cat = require('./catalog_core.js'); const Sh = require('./shape_core.js');
let pass = 0, fail = 0; const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log('FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };
const ts = (v, k) => Sh.toTypeString(Sh.typeOfValue(v, k));

// ---- 單一值 ----
check('int/number/bool/text', ts(3) === 'int' && ts(3.5) === 'number' && ts(true) === 'bool' && ts('x') === 'text');
check('url by value', ts('https://a.com/x') === 'url');
check('file id by key', ts('f_123', 'pdf_file_id') === 'pdf_file' && ts('f_1', 'file_id') === 'file_id' && ts('f_1', 'video_file_id') === 'video_file');
check('path by key only', ts('C:\\a\\b.txt', 'path') === 'path' && ts('C:\\a\\b.txt', 'note') === 'text');
check('multiline never path', ts('a\nb', 'path') === 'text');
check('object', ts({ ok: true, pages: 3, pdf_file_id: 'f1' }) === 'object{ok:bool,pages:int,pdf_file_id:pdf_file}', ts({ ok: true, pages: 3, pdf_file_id: 'f1' }));
check('list of objects', ts({ items: [{ a: 1 }, { a: 2.5 }] }) === 'object{items:list<object{a:number}>}', ts({ items: [{ a: 1 }, { a: 2.5 }] }));
check('empty list stays any', ts({ rows: [] }) === 'object{rows:list<any>}');
check('too many keys → dict', ts(Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['k' + i, i]))) === 'dict');
check('weird keys → dict', ts({ 'a-b': 1 }) === 'dict');
check('depth cap', /list<any>|dict/.test(ts({ a: { b: { c: { d: 1 } } } })), ts({ a: { b: { c: { d: 1 } } } }));

// ---- 合併 ----
const m = (a, b) => Sh.toTypeString(Sh.merge(Sh.typeOfValue(a), Sh.typeOfValue(b)));
check('int+number → number', m({ v: 1 }, { v: 2.5 }) === 'object{v:number}');
check('path+url → text', m({ u: 'https://x.com' }, { u: 'plain' }) === 'object{u:text}');
check('pdf_file+video_file → file_id', Sh.toTypeString(Sh.merge({ k: 'pdf_file' }, { k: 'video_file' })) === 'file_id');
check('null + text → text nullable', Sh.merge(Sh.typeOfValue(null), Sh.typeOfValue('x')).nullable === true && m({ a: null }, { a: 'x' }) === 'object{a:text}');
check('conflict → union', m({ a: 1 }, { a: 'x' }) === 'object{a:union<int|text>}', m({ a: 1 }, { a: 'x' }));
check('too many alternatives → any', Sh.toTypeString(Sh.merge(Sh.merge(Sh.merge({ k: 'int' }, { k: 'text' }), { k: 'bool' }), { k: 'list', of: { k: 'int' } })) === 'any');
check('empty list merges with typed list', m({ r: [] }, { r: [1, 2] }) === 'object{r:list<int>}', m({ r: [] }, { r: [1, 2] }));
const o = Sh.merge(Sh.typeOfValue({ a: 1, b: 'x' }), Sh.typeOfValue({ a: 2 }));
check('missing field is optional', o.opt.b === true && !o.opt.a && Sh.toTypeString(o) === 'object{a:int,b:text}');
check('object+dict → dict', Sh.toTypeString(Sh.merge(Sh.typeOfValue({ a: 1 }), Sh.typeOfValue({}))) === 'dict');

// ---- 樣本抽取 ----
const msgs = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'count_pages', arguments: '{"pdf":"f"}' } }, { id: 'c2', function: { name: 'count_pages', arguments: '{}' } }, { id: 'c3', function: { name: 'web_x', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true, pages: 12, title: 'T' }) },
  { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ ok: false, error: '沒有檔案' }) },
  { role: 'tool', tool_call_id: 'c3', content: 'not json at all' },
];
const sm = Sh.samplesFromMessages(msgs);
check('samples skip failures and non-json', sm.length === 1 && sm[0].tool === 'count_pages', sm);
check('samples skip error-object', Sh.samplesFromMessages([{ role: 'assistant', tool_calls: [{ id: 'z', function: { name: 'a_b' } }] }, { role: 'tool', tool_call_id: 'z', content: '{"error":{"code":1}}' }]).length === 0);
const tm = Sh.samplesFromTurns([{ calls: [{ name: 'fs_stat', ok: true, res: { size: 10, path: 'C:\\x' } }, { name: 'fs_stat', ok: false, res: { size: 1 } }, { name: 'fs_stat', ok: true, res: {} }] }]);
check('turn samples partial, failures skipped', tm.length === 1 && tm[0].partial.size === 10, tm);

// ---- 推論 ----
const full = [{ tool: 't1', value: { ok: true, pages: 3 } }, { tool: 't1', value: { ok: true, pages: 5, note: 'x' } }, { tool: 't2', value: [1, 2] }, { tool: 't3', value: {} }];
const inf = Sh.infer(full);
check('infer merges', inf.t1.type === 'object{ok:bool,pages:int,note:text}' && inf.t1.samples === 2 && inf.t1.optional.join() === 'note', inf.t1);
check('infer list', inf.t2.type === 'list<int>');
check('infer empty dict loose', inf.t3.loose === true);
const part = Sh.infer([{ tool: 'p', partial: { size: 10, name: 'a' } }, { tool: 'p', partial: { size: 11 } }]);
check('partial-only → object, all optional', part.p.type === 'object{size:int,name:text}' && part.p.samples === 0 && part.p.partial_samples === 2 && part.p.optional.length === 2, part.p);
const mix = Sh.infer([{ tool: 'q', value: { a: 1 } }, { tool: 'q', partial: { b: 'x' } }]);
check('partial adds optional fields to full', mix.q.type === 'object{a:int,b:text}' && mix.q.optional.join() === 'b', mix.q);

// ---- 套進目錄 ----
const mk = (name, rt, src) => ({ id: 'tool:' + name, runtime: 'app', name, returns: { type: rt, type_src: src || 'none' } });
const units = [mk('t1', 'json'), mk('t2', 'any'), mk('t3', 'json'), mk('t4', 'object{ok:bool,items:list<any>,count:int}', 'doc'), mk('t5', 'text', 'curated'), mk('t6', 'json'), { id: 'py:m.f', runtime: 'python', name: 'm.f', returns: { type: 'any', type_src: 'none' } }];
const obs = Object.assign({}, inf, { t4: { type: 'object{ok:bool,items:list<object{id:int}>,count:int,extra:text}', samples: 4, partial_samples: 0, optional: [], loose: false }, t5: { type: 'int', samples: 3, loose: false }, 'm.f': { type: 'int', samples: 9, loose: false } });
const bo = Sh.buildOverrides(units, obs);
check('json → observed', bo.overrides.t1 && bo.overrides.t1.type_src === 'observed' && bo.overrides.t1.samples === 2 && bo.overrides.t1.optional.join() === 'note', bo.overrides.t1);
check('doc object only loose fields refined', bo.overrides.t4 && bo.overrides.t4.type === 'object{ok:bool,items:list<object{id:int}>,count:int}' && bo.overrides.t4.type_src === 'doc', bo.overrides.t4);
check('curated never overwritten', !bo.overrides.t5);
check('python units not touched', !bo.overrides['m.f']);
check('loose observation skipped and listed', !bo.overrides.t3 && bo.report.skipped_loose.includes('t3'), bo.report);
check('no samples listed', bo.report.no_samples.includes('t6'));
check('minSamples respected', !Sh.buildOverrides([mk('x', 'json')], { x: { type: 'int', samples: 1, loose: false } }, { minSamples: 2 }).overrides.x);

// ---- 進目錄：returnsOverrides 接受物件，型別來源 observed ----
const cat = Cat.buildCatalog({ t1: { description: '做事', parametersSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } } }, {}, { returnsOverrides: { t1: bo.overrides.t1 } });
const u1 = cat.units[0];
check('catalog uses observed override', u1.returns.type === 'object{ok:bool,pages:int,note:text}' && u1.returns.type_src === 'observed' && u1.returns.samples === 2 && u1.returns.optional[0] === 'note', u1.returns);
check('catalog still accepts string override', Cat.buildCatalog({ t1: { description: 'x', parametersSchema: { type: 'object', properties: {} } } }, {}, { returnsOverrides: { t1: 'int' } }).units[0].returns.type_src === 'curated');
check('bad override type ignored', Cat.buildCatalog({ t1: { description: 'x', parametersSchema: { type: 'object', properties: {} } } }, {}, { returnsOverrides: { t1: { type: 'list<', type_src: 'observed' } } }).units[0].returns.type_src === 'none');
check('unit still validates', Cat.validateUnit(u1).length === 0, Cat.validateUnit(u1));

// ---- 狀態可以存檔後接著累積 ----
let st = Sh.accumulate({}, [{ tool: 'a', value: { x: 1 } }]); st = JSON.parse(JSON.stringify(st)); st = Sh.accumulate(st, [{ tool: 'a', value: { x: 2, y: 'q' } }, { tool: 'a', partial: { z: true } }]); st = JSON.parse(JSON.stringify(st));
const sa = Sh.summarize(st).a; check('state round-trips and keeps accumulating', sa.type === 'object{x:int,y:text,z:bool}' && sa.samples === 2 && sa.optional.join() === 'y,z', sa);

console.log('shape_core: ' + pass + ' passed' + (fail ? ', ' + fail + ' FAILED' : '')); process.exit(fail ? 1 : 0);
