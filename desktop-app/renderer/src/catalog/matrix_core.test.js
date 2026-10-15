// node renderer/src/catalog/matrix_core.test.js
const Cat = require('./catalog_core.js'); const M = require('./matrix_core.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- 回傳型別推論
const inf = Cat.inferReturns;
let r = inf('remove_pdf_pages', '把 PDF 刪掉幾頁。回傳 {ok, pdf_file_id, filename, sizeBytes, originalPageCount} 之類。');
check('doc: field list becomes object', r.type === 'object{ok:bool,pdf_file_id:pdf_file,filename:text,sizeBytes:int,originalPageCount:int}' && r.type_src === 'doc', r);
r = inf('x', 'Returns {"ok":true,"count":3,"items":[1]} when done.'); check('doc: json literal values', r.type === 'object{ok:bool,count:int,items:list<any>}', r);
r = inf('transcribe_media', '回傳 {ok, language, durationSeconds, text（全文）, segments:[{start,end,text}]（分段）, transcript_file_id（另存）}'); check('doc: annotations after names and nested brackets', r.type.includes('durationSeconds:number') && r.type.includes('text:text') && r.type.includes('segments:list<any>') && r.type.includes('transcript_file_id:subtitle_file'), r);
r = inf('x', '回傳 {ok, ...}'); check('doc: ellipsis is skipped', r.type === 'object{ok:bool}', r);
r = inf('terminal_run', '回傳 {ok, exit_code, stdout, stderr}'); check('doc: process fields', r.type === 'object{ok:bool,exit_code:int,stdout:text,stderr:text}', r);
r = inf('compose_video', '回傳 {ok, hasAudio, hasCaptions, fps}'); check('doc: camelCase has* is bool', r.type === 'object{ok:bool,hasAudio:bool,hasCaptions:bool,fps:number}', r);
check('name: is_/has_', inf('is_valid', '').type === 'bool' && inf('has_more_items', '').type === 'bool' && inf('is_valid', '').type_src === 'name');
check('name: get_*_yaml', eq(inf('get_3d_scene_yaml', ''), { type: 'yaml', type_src: 'name' }));
check('name: list_ is list<dict>', inf('list_uploaded_files', '').type === 'list<dict>');
check('nothing to go on is json/none', eq(inf('fs_stat', '看檔案資訊'), { type: 'json', type_src: 'none' }));
check('every inferred type parses', ['回傳 {a, b:1, c:"x", d:[1], e:{}}', '回傳 {fileId, url, path}'].every((d) => { try { Cat.parseType(inf('t', d).type); return true; } catch (_) { return false; } }));
const uo = Cat.toolToUnit('t', { description: '回傳 {ok}', parametersSchema: { type: 'object', properties: {} } }, { returnsOverrides: { t: 'object{file_id:file_id}' } });
check('curated override wins and is marked', uo.returns.type === 'object{file_id:file_id}' && uo.returns.type_src === 'curated');
const ub = Cat.toolToUnit('t', { description: 'x', parametersSchema: { type: 'object', properties: {} } }, { returnsOverrides: { t: 'list<' } }); check('invalid override is ignored', ub.returns.type_src === 'none');
check('units validate with inferred returns', eq(Cat.validateUnit(Cat.toolToUnit('remove_pdf_pages', { description: '回傳 {ok, pdf_file_id}', parametersSchema: { type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'] } }, {})), []));

// --- 具體程度與接線分數
check('kinded files: generic file_id fits a kind only half-way, wrong kind never', M.matchScore('video_file', 'file_id') === 1 && M.matchScore('file_id', 'video_file') === 0.5 && M.matchScore('pdf_file', 'video_file') === 0 && M.matchScore('gif_file', 'image_file') === 1);
check('spec ordering', M.spec('file_id') === 1 && M.spec('text') < M.spec('list<file_id>') && M.spec('json') === 0 && M.spec('number') < 0.2);
check('matchScore: specific types connect', M.matchScore('file_id', 'file_id') === 1 && M.matchScore('path', 'text') === 0.15 && M.matchScore('text', 'path') === 0);
check('matchScore: unknown outputs never connect to specific inputs', M.matchScore('json', 'file_id') === 0 && M.matchScore('any', 'file_id') === 0);
check('matchScore: int to number', M.matchScore('int', 'number') > 0 && M.matchScore('number', 'int') === 0);

// --- 假目錄：下載 → 轉 PDF → 刪頁 → 擷取圖片；還有一個吃 url 的、一個只吃 text 的
const U = (name, params, returns, extra) => Object.assign({ id: 'tool:' + name, runtime: 'app', name, summary: '', params: params.map(([n, t, req]) => ({ name: n, kind: 'named', type: t, type_src: 'schema', required: !!req })), returns: { type: returns, type_src: 'doc' }, effects: ['state.read'], pure: false, avail: { state: 'builtin', needs: [] }, domains: [], tests: [], tier: 1 }, extra || {});
const units = [
    U('download', [['url', 'url', true]], 'object{ok:bool,file_id:file_id}'),
    U('to_pdf', [['file_id', 'file_id', true], ['page_size', 'text']], 'object{ok:bool,pdf_file_id:file_id}'),
    U('remove_pages', [['file_id', 'file_id', true], ['pages', 'list<int>', true]], 'object{ok:bool,pdf_file_id:file_id,filename:text}'),
    U('pdf_images', [['file_id', 'file_id', true]], 'object{ok:bool,image_file_id:file_id}'),
    U('describe', [['file_id', 'file_id', true]], 'object{text:text}'),
    U('say', [['text', 'text', true]], 'object{ok:bool}'),
    U('search', [['query', 'query', true]], 'object{urls:list<url>}'),
    U('mystery', [['x', 'text', true]], 'json'), U('hidden', [['file_id', 'file_id', true]], 'object{ok:bool}', { tier: 0 }), U('risky', [['file_id', 'file_id', true]], 'object{ok:bool}', { effects: ['unknown'] }),
    U('web_only', [['file_id', 'file_id']], 'object{ok:bool}', { avail: { state: 'unavailable', needs: ['desktop'] } }),
];
const mx = M.buildMatrix(units);
check('only tier 1, known effects, builtin units enter', eq(mx.ids, ['tool:download', 'tool:to_pdf', 'tool:remove_pages', 'tool:pdf_images', 'tool:describe', 'tool:say', 'tool:search', 'tool:mystery']), mx.ids);
const e = (a, b) => { const i = mx.index.get('tool:' + a), j = mx.index.get('tool:' + b); return mx.edges[i].get(j); };
check('download -> to_pdf through file_id', e('download', 'to_pdf') && e('download', 'to_pdf').out === 'file_id' && e('download', 'to_pdf').param === 'file_id' && e('download', 'to_pdf').score === 1, e('download', 'to_pdf'));
check('pdf output field feeds the next file_id input', e('to_pdf', 'remove_pages') && e('to_pdf', 'remove_pages').out === 'pdf_file_id', e('to_pdf', 'remove_pages'));
check('generic text connections are not edges by default', !e('describe', 'say') && !e('mystery', 'say'));
check('search urls feed download', !e('search', 'download'), e('search', 'download')); // list<url> 接不到 url（要先取一個元素，不是這一步的事）
check('no self edges', mx.units.every((_, i) => !mx.edges[i].has(i)));
check('stats', mx.stats.units === 8 && mx.stats.edges > 0 && mx.stats.density_pct > 0 && mx.stats.no_in >= 1 && Array.isArray(mx.stats.top_out), mx.stats);
const lo = M.buildMatrix(units, { minScore: 0.1 }); check('lowering minScore adds generic edges', lo.stats.edges > mx.stats.edges && !!lo.edges[lo.index.get('tool:describe')].get(lo.index.get('tool:say')));

// --- 布林矩陣
const A = M.newBits(5); M.setBit(A, 0, 1); M.setBit(A, 1, 2); M.setBit(A, 2, 3); M.setBit(A, 3, 4);
const A2 = M.boolMul(A, A); check('boolMul: A² has two-step edges only', M.getBit(A2, 0, 2) === 1 && M.getBit(A2, 1, 3) === 1 && M.getBit(A2, 0, 1) === 0 && M.getBit(A2, 0, 3) === 0);
const W = M.reachWithin(A, 4); check('reachWithin: cumulative', M.getBit(W[1], 0, 1) === 1 && M.getBit(W[1], 0, 2) === 0 && M.getBit(W[2], 0, 2) === 1 && M.getBit(W[2], 0, 1) === 1 && M.getBit(W[4], 0, 4) === 1 && M.getBit(W[4], 4, 0) === 0);
const big = M.newBits(70); M.setBit(big, 0, 65); M.setBit(big, 65, 69); check('boolMul across word boundaries', M.getBit(M.boolMul(big, big), 0, 69) === 1);

// --- 找接線
let res = M.findPipelines(mx, { from: 'url', to: 'file_id' }, { k: 10 });
check('pipelines from url to file_id found', res.paths.length >= 3 && res.start >= 1 && res.goal >= 1, [res.paths.length, res.start, res.goal]);
check('best path is shortest and strongest', res.paths[0].names.length === 1 && res.paths[0].names[0] === 'download', res.paths[0]);
const long = res.paths.find((p) => p.names.join('>') === 'download>to_pdf>remove_pages'); check('multi-step pipeline is found, via is recorded', !!long && long.via.length === 2 && long.via[0].out === 'file_id' && long.via[1].out === 'pdf_file_id', long);
check('longer paths score lower than their shorter prefixes', long && res.paths.find((p) => p.names.join('>') === 'download>to_pdf').score > long.score);
check('scores are within 0..1 and sorted', res.paths.every((p) => p.score > 0 && p.score <= 1) && res.paths.every((p, i, a) => !i || a[i - 1].score >= p.score));
check('extra required params are penalized and reported', long.extra_required.some((x) => x.unit === 'tool:remove_pages' && x.missing.includes('pages')), long.extra_required);
check('effects are collected', Array.isArray(long.effects) && long.effects.includes('state.read'));
res = M.findPipelines(mx, { from: 'url', to: 'file_id' }, { maxLen: 1 }); check('maxLen limits path length', res.paths.every((p) => p.names.length === 1));
res = M.findPipelines(mx, { from: { unit: 'tool:download' }, to: { unit: 'tool:pdf_images' } }, { k: 3 }); check('unit to unit', res.paths.length >= 1 && res.paths[0].names[0] === 'download' && res.paths[0].names.slice(-1)[0] === 'pdf_images', res.paths[0]);
res = M.findPipelines(mx, { from: 'url', to: 'yaml' }); check('no route gives empty, not an error', res.paths.length === 0);
res = M.findPipelines(mx, { from: 'bool', to: 'file_id' }); check('unknown start type gives empty', res.paths.length === 0 && res.start === 0);
check('no cycles in a path', M.findPipelines(mx, { from: 'file_id', to: 'file_id' }, { k: 50, maxLen: 5 }).paths.every((p) => new Set(p.units).size === p.units.length));
check('explain is readable', /download.*→\(file_id→file_id\) to_pdf/.test(M.findPipelines(mx, { from: 'url', to: 'file_id' }, { k: 10 }).paths.map(M.explain).join('\n')));
// 保護：搜尋展開上限
const dense = Array.from({ length: 40 }, (_, i) => U('d' + i, [['file_id', 'file_id', true]], 'object{file_id:file_id}')); const dm = M.buildMatrix(dense);
const t0 = Date.now(); const dr = M.findPipelines(dm, { from: 'file_id', to: 'path' }, { maxLen: 6, maxExpand: 5000 }); check('expansion cap keeps the search bounded', dr.expanded <= 5002 && Date.now() - t0 < 2000, [dr.expanded, Date.now() - t0]);
const dr2 = M.findPipelines(dm, { from: 'file_id', to: 'file_id' }, { maxLen: 3, k: 5 }); check('dense graph still returns top K', dr2.paths.length === 5 && dr2.found > 5, [dr2.paths.length, dr2.found]);
// --- 萬用結構（不明型別）：預設不接；允許時用低分「強制轉型」接上，路徑上標 cast
const ov = units.concat([U('opaque_a', [['x', 'text', true]], 'json'), U('needs_file', [['file_id', 'file_id', true]], 'object{ok:bool}')]);
const strict = M.buildMatrix(ov); const loose = M.buildMatrix(ov, { allowOpaque: true });
const ie = (m, a, b) => m.edges[m.index.get('tool:' + a)].get(m.index.get('tool:' + b));
check('opaque output does not connect by default', !ie(strict, 'opaque_a', 'needs_file'));
check('opaque output connects as a low-score cast when allowed', ie(loose, 'opaque_a', 'needs_file') && ie(loose, 'opaque_a', 'needs_file').cast === true && ie(loose, 'opaque_a', 'needs_file').score === 0.2 && loose.stats.edges > strict.stats.edges);
const castPath = M.findPipelines(loose, { from: { unit: 'tool:opaque_a' }, to: { unit: 'tool:needs_file' } }); check('cast path is marked and scored low', castPath.paths.length >= 1 && castPath.paths[0].via[0].cast === true && castPath.paths[0].score <= 0.2, castPath.paths[0]);
check('typed edges outrank cast edges', (() => { const r = M.findPipelines(loose, { from: 'url', to: 'file_id' }, { k: 20 }); const typed = r.paths.find((p) => p.via.every((v) => !v.cast)); const cast = r.paths.find((p) => p.via.some((v) => v.cast)); return typed && (!cast || typed.score > cast.score); })());
check('cast never fires for already-typed matches', !ie(loose, 'download', 'to_pdf').cast);
check('list<any> output does not feed a specific list input', M.matchScore('list<any>', 'list<file_id>') === 0 && M.matchScore('list<file_id>', 'list<file_id>') > 0 && M.matchScore('list<any>', 'list<any>') < 0.5);
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'matrix_core: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
