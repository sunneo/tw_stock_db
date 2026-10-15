/* 單元目錄的核心（UMD，純函式，不碰 DOM）：把「已登記的工具」（名稱＋說明＋JSON Schema）轉成單元描述（id、參數與型別、副作用、可用性、信任等級），
 * 並提供格式驗證、型別字串解析與相容判斷、評量統計。設計見 DESIGN.unit-catalog.md。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const VERSION = 1;
    const EFFECTS = ['fs.read', 'fs.write', 'net', 'proc', 'time', 'random', 'env', 'desktop', 'browser', 'ui', 'state.read', 'state.write', 'delegate', 'unknown'];
    const TYPE_SRC = ['annotation', 'stub', 'schema', 'doc', 'name', 'probe', 'curated', 'none'];
    const AVAIL = ['builtin', 'installed', 'cached', 'needs-network', 'disabled', 'unavailable'];
    // 型別詞彙：基本型別、由基本型別特化的（path 是一種 text），容器型別
    const SPECIAL = { path: 'text', url: 'text', file_id: 'text', yaml: 'text', code: 'text', query: 'text' };

    // ===== 型別字串：text number int bool any dict json path…、list<T>、enum<a|b>、union<A|B>、object{k:T,…} =====
    function parseType(s) {
        s = String(s || '').trim(); if (!s) return { k: 'any' };
        let i = 0; const peek = () => s[i];
        function ident() { const m = /^[A-Za-z_][\w.-]*/.exec(s.slice(i)); if (!m) throw new Error('型別不合法：' + s); i += m[0].length; return m[0]; }
        function ws() { while (s[i] === ' ') i++; }
        function one() {
            ws(); const name = ident(); ws();
            if (name === 'list' && peek() === '<') { i++; const t = one(); ws(); if (s[i++] !== '>') throw new Error('list< 缺少 >：' + s); return { k: 'list', of: t }; }
            if ((name === 'enum' || name === 'union') && peek() === '<') { i++; const items = []; for (;;) { ws(); if (name === 'enum') { const m = /^[^|>]+/.exec(s.slice(i)); if (!m) throw new Error('enum 空的：' + s); items.push(m[0].trim()); i += m[0].length; } else items.push(one()); ws(); if (s[i] === '|') { i++; continue; } if (s[i] === '>') { i++; break; } throw new Error('缺少 > ：' + s); } return name === 'enum' ? { k: 'enum', values: items } : { k: 'union', of: items }; }
            if (name === 'object' && peek() === '{') { i++; const fields = {}; for (;;) { ws(); if (s[i] === '}') { i++; break; } const key = ident(); ws(); if (s[i++] !== ':') throw new Error('object 欄位缺少 :：' + s); fields[key] = one(); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; break; } throw new Error('object 缺少 }：' + s); } return { k: 'object', fields }; }
            return { k: name };
        }
        const t = one(); ws(); if (i < s.length) throw new Error('型別後面多了東西：' + s); return t;
    }
    function typeToString(t) {
        if (!t) return 'any'; if (t.k === 'list') return 'list<' + typeToString(t.of) + '>'; if (t.k === 'enum') return 'enum<' + t.values.join('|') + '>'; if (t.k === 'union') return 'union<' + t.of.map(typeToString).join('|') + '>';
        if (t.k === 'object') return 'object{' + Object.keys(t.fields).map((k) => k + ':' + typeToString(t.fields[k])).join(',') + '}'; return t.k;
    }
    // from 的值能不能放進 to 的位置（保守：不確定就 false；any 兩邊都通）
    function isAssignable(from, to) {
        if (typeof from === 'string') from = parseType(from); if (typeof to === 'string') to = parseType(to);
        if (from.k === 'any' || to.k === 'any') return true;
        if (from.k === 'union') return from.of.every((f) => isAssignable(f, to)); if (to.k === 'union') return to.of.some((t) => isAssignable(from, t));
        if (from.k === 'enum') { if (to.k === 'enum') return from.values.every((v) => to.values.includes(v)); return isAssignable({ k: 'text' }, to); }
        if (to.k === 'enum') return false;
        if (from.k === 'list' && to.k === 'list') return isAssignable(from.of, to.of);
        if (from.k === 'object' && to.k === 'object') return Object.keys(to.fields).every((k) => k in from.fields && isAssignable(from.fields[k], to.fields[k]));
        if (from.k === to.k) return true;
        if (from.k === 'int' && to.k === 'number') return true;
        if (SPECIAL[from.k] && to.k === SPECIAL[from.k]) return true; // path → text（具體 → 一般），反過來不行
        if (from.k === 'json' && (to.k === 'dict' || to.k === 'list')) return true; if (from.k === 'dict' && to.k === 'json') return true;
        return false;
    }

    // ===== JSON Schema → 單元的型別 =====
    const NAME_TYPES = [[/(^|_)(path|dir|folder|filepath|file_path|cwd)$/i, 'path'], [/(^|_)(url|uri|href|link)$/i, 'url'], [/(^|_)(file_id|fileid)$/i, 'file_id'], [/(^|_)(yaml|yml)$/i, 'yaml'], [/^(code|script|source)$/i, 'code'], [/^(query|pattern|keyword|q)$/i, 'query']];
    function schemaType(sc, pname, depth) {
        depth = depth || 0;
        if (!sc || typeof sc !== 'object') return { type: 'any', src: 'none' };
        if (Array.isArray(sc.enum) && sc.enum.length && sc.enum.length <= 24) return { type: 'enum<' + sc.enum.map((x) => String(x).replace(/[|<>]/g, '_')).join('|') + '>', src: 'schema' };
        const alt = sc.oneOf || sc.anyOf; if (Array.isArray(alt) && alt.length) { const ts = alt.map((a) => schemaType(a, pname, depth + 1)); return { type: 'union<' + ts.map((x) => x.type).join('|') + '>', src: ts.some((x) => x.src === 'none') ? 'none' : 'schema' }; }
        let ty = Array.isArray(sc.type) ? sc.type.filter((x) => x !== 'null') : sc.type; if (Array.isArray(ty)) { if (ty.length === 1) ty = ty[0]; else return { type: 'union<' + ty.map((x) => baseOf(x)).join('|') + '>', src: 'schema' }; }
        if (ty === 'string') { const hit = NAME_TYPES.find(([re]) => re.test(pname || '')); return hit ? { type: hit[1], src: 'name' } : { type: 'text', src: 'schema' }; }
        if (ty === 'array') { const it = sc.items ? schemaType(sc.items, '', depth + 1) : { type: 'any', src: 'none' }; return { type: 'list<' + it.type + '>', src: it.src === 'none' ? 'none' : 'schema' }; }
        if (ty === 'object' || sc.properties) {
            const props = sc.properties; if (!props || !Object.keys(props).length || depth >= 2) return { type: 'dict', src: 'schema' };
            const parts = []; let allKnown = true; for (const k of Object.keys(props).slice(0, 16)) { if (!/^[A-Za-z_][\w.-]*$/.test(k)) { return { type: 'dict', src: 'schema' }; } const t = schemaType(props[k], k, depth + 1); if (t.src === 'none') allKnown = false; parts.push(k + ':' + t.type); }
            return { type: 'object{' + parts.join(',') + '}', src: allKnown ? 'schema' : 'none' };
        }
        if (ty) return { type: baseOf(ty), src: 'schema' };
        if (/(^|_)(seconds|secs|sec|ms|count|limit|offset|index|top_k|size|width|height|fps)$|^(max|min)_/i.test(pname || '')) return { type: 'number', src: 'name' }; // schema 沒寫型別，只能從參數名稱猜（信任度低，標 name）
        return { type: 'any', src: 'none' };
    }
    function baseOf(x) { return x === 'integer' ? 'int' : x === 'number' ? 'number' : x === 'boolean' ? 'bool' : x === 'string' ? 'text' : x === 'object' ? 'dict' : x === 'array' ? 'list<any>' : x === 'null' ? 'null' : 'any'; }

    // ===== 副作用規則（依工具名稱；不執行任何東西）=====
    const R = (re, ...effects) => ({ re, effects });
    const EFFECT_RULES = [
        R(/^fs_(read_file|list_files|stat|find_file|grep)$/, 'fs.read', 'desktop'), R(/^fs_(write_file|mkdir|remove)$/, 'fs.write', 'desktop'),
        R(/^fap_(list_files|read_file|find_file)$/, 'fs.read'), R(/^list_file_access_points$/, 'fs.read'), R(/^fap_(write_file|apply_patch|copy_from_storage|copy_to_storage)$/, 'fs.write'), R(/^fap_download_url$/, 'fs.write', 'net'),
        R(/^(attachment_apply_patch)$/, 'state.write'), R(/^(apply_git_patch|coding_edit|coding_patch_tool)$/, 'fs.write', 'desktop'), R(/^coding_(read_file|task_state|workspace)$/, 'fs.read', 'desktop'),
        R(/^git_(status|log|inspect)$/, 'fs.read', 'desktop'), R(/^git_(commit)$/, 'fs.write', 'desktop'), R(/^git_(clone|pull)$/, 'fs.write', 'net', 'desktop'), R(/^git_push$/, 'net', 'desktop'),
        R(/^(coding_run_tests|coding_run_check|run_command|bash_execute|python_execute)$/, 'proc'), R(/^(run_command|coding_run_tests|coding_run_check)$/, 'desktop'),
        R(/^(terminal_|tmux_)/, 'proc'), R(/^tmux_/, 'desktop'), R(/^terminal_cp_/, 'fs.write'), R(/^sandbox_(html|worker|mock|py_app)$/, 'proc', 'ui'),
        R(/^(browser_search|fetch_web_page|import_image_url|youtube_download|language_explore)$/, 'net'), R(/^(text_to_speech|transcribe_media)$/, 'net'), // 中文語音走 API 轉接；轉逐字稿第一次要下載模型（只列出我確定會連網的，其餘靠抽樣核對補） R(/^youtube_download$/, 'fs.write'),
        R(/^(gerrit|github_ci|jenkins|ci_connections|ci_triage)$/, 'net'), R(/^(pipeline_inspect|ci_guide)$/, 'state.read'),
        R(/^browser_(status|list_tabs|get_page_text|get_page_structure|get_elements|screenshot|list_downloads)$/, 'browser'), R(/^browser_(create_tab_group|create_tab|navigate|close|activate_tab|scroll|mouse|type_text|press_key|click|wait_download)$/, 'browser', 'ui'),
        R(/^delegate_to_subagent$/, 'delegate'), R(/^call_ai_function$/, 'proc', 'state.read'), R(/^playbook_state$/, 'state.read', 'state.write'), R(/^delegate_to_machine$/, 'delegate', 'net'), R(/^list_remote_machines$/, 'net'), R(/^(summarize_large_text|interpret_image|image_to_text|batch_process_items)$/, 'delegate'),
        R(/^(add|delete|define|register|store|set|learn|teach|annotate|create)_|^(skill_create|log_learn|behavior_define|ref_define|glue_define|rag_store_graph_node|rag_delete|define_snippet|image_parts_teach|image_parts_annotate)$/, 'state.write'),
        R(/^(list|get|query|lookup|read|explain|ref_lookup|ref_types|ref_resolve|ref_validate|ref_expand|log_ask|glue_list|glue_report|skill_list|skill_read|rag_query_graph|rag_chunk_document|programming_knowledge|programming_domains|language_explore|repo_|uefi_parse|diagnose_|lookup_|mix_|uml_guide|uml_design|design_choices|sandbox_capabilities|offline_trainer|big_content|get_tool_details)/, 'state.read'),
        R(/^(render_|begin_presentation|add_chapters|finish_presentation|open_existing_presentation|import_|cute_picture|ask_user_card|pptx_to_deck|uml_to_code|set_viewer_state|image_(decompose|rig))/, 'ui', 'state.write'),
        R(/^(parse_uploaded_file|extract_|merge_pdfs|remove_pdf_pages|images_to_pdf|compare_images|office_export_slide_images|pptx_inspect|compose_video|text_to_speech|concat_audio|burn_subtitles|convert_|transcribe_media|start_dubbing_session|analyze_large_file|get_large_file_analysis_chunk|list_uploaded_files)/, 'state.read', 'state.write'),
    ];
    function effectsOf(name) {
        const base = String(name).replace(/__[0-9a-f-]{20,}$/i, ''); const set = new Set();
        for (const r of EFFECT_RULES) if (r.re.test(base)) r.effects.forEach((e) => set.add(e));
        if (/^read_skill_file$/.test(base)) set.add('state.read');
        if (!set.size) set.add('unknown');
        return EFFECTS.filter((e) => set.has(e));
    }

    // ===== 工具 → 單元 =====
    const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    function summaryOf(desc) { const s = String(desc || '').replace(/\s+/g, ' ').trim(); const m = /^(.{2,160}?(?:[。！？]|[.!?](?=\s|$)))/.exec(s); return clip(m ? m[1] : s, 160); }
    function toolToUnit(name, tool, ctx) {
        ctx = ctx || {}; const sc = tool && tool.parametersSchema; const props = (sc && sc.properties) || {}; const req = new Set((sc && sc.required) || []);
        const params = Object.keys(props).map((k) => { const t = schemaType(props[k], k, 0); const p = { name: k, kind: 'named', type: t.type, type_src: t.src, required: req.has(k) }; if (props[k] && props[k].default !== undefined) p.default = props[k].default; const d = clip(props[k] && props[k].description, 120); if (d) p.description = d; return p; });
        const effects = effectsOf(name); const domains = (ctx.domainsOf && ctx.domainsOf[name]) || [];
        let state = 'builtin'; if (ctx.platform === 'web' && effects.includes('desktop')) state = 'unavailable'; else if (domains.length && ctx.domainEnabled && domains.every((d) => ctx.domainEnabled[d] === false)) state = 'disabled';
        const typedAll = params.every((p) => p.type_src !== 'none' && p.type !== 'any');
        const tier = (sc && tool.description && !effects.includes('unknown') && typedAll && state !== 'unavailable') ? 1 : 0;
        const u = { id: 'tool:' + name, runtime: 'app', name, summary: summaryOf(tool && tool.description), params, returns: { type: 'json', type_src: 'none' }, effects, pure: false, avail: { state, needs: effects.includes('desktop') ? ['desktop'] : [] }, domains, tests: [], tier };
        if (!sc) u.no_schema = true; return u;
    }
    function validateUnit(u) {
        const errs = []; if (!u || typeof u !== 'object') return ['不是物件'];
        if (!/^[a-z]+:[\w.-]+$/.test(u.id || '')) errs.push('id 格式不對：' + u.id); if (!u.runtime) errs.push('缺少 runtime'); if (!u.name) errs.push('缺少 name');
        if (!Array.isArray(u.params)) errs.push('params 不是陣列'); else { const seen = new Set(); for (const p of u.params) { if (!p.name) errs.push('參數沒有名稱'); else if (seen.has(p.name)) errs.push('參數重複：' + p.name); else seen.add(p.name); try { parseType(p.type); } catch (e) { errs.push('參數 ' + p.name + ' 的型別不合法：' + e.message); } if (!TYPE_SRC.includes(p.type_src)) errs.push('參數 ' + p.name + ' 的 type_src 不認得：' + p.type_src); } }
        if (!u.returns || !u.returns.type) errs.push('缺少 returns'); else { try { parseType(u.returns.type); } catch (e) { errs.push('回傳型別不合法：' + e.message); } }
        if (!Array.isArray(u.effects) || !u.effects.length && !u.pure) errs.push('effects 要有內容（沒有副作用才能 pure:true）'); else for (const e of u.effects) if (!EFFECTS.includes(e)) errs.push('不認得的 effect：' + e);
        if (u.pure && u.effects.length) errs.push('pure:true 但 effects 不是空的'); if (!u.avail || !AVAIL.includes(u.avail.state)) errs.push('avail.state 不合法'); if (![0, 1].includes(u.tier)) errs.push('tier 只能是 0 或 1');
        return errs;
    }
    function buildCatalog(tools, domains, opts) {
        opts = opts || {}; const domainsOf = {}, domainEnabled = {};
        for (const [k, d] of Object.entries(domains || {})) { domainEnabled[k] = d.enabled !== false; if (Array.isArray(d.toolNames)) for (const n of d.toolNames) (domainsOf[n] = domainsOf[n] || []).push(k); }
        const ctx = { domainsOf, domainEnabled, platform: opts.platform || 'desktop' }; const units = [];
        for (const name of Object.keys(tools || {}).sort()) units.push(toolToUnit(name, tools[name], ctx));
        return { version: VERSION, source: 'app-tools', generatedAt: opts.now || new Date().toISOString(), platform: ctx.platform, units, stats: stats(units) };
    }
    // 評量表（DESIGN.unit-catalog.md 第七節）
    function stats(units) {
        const n = units.length; let params = 0, typed = 0, srcSchema = 0, srcName = 0, tier1 = 0, known = 0, noSchema = 0, invalid = 0; const byEffect = {}; const untyped = [];
        for (const u of units) { if (validateUnit(u).length) invalid++; if (u.no_schema) noSchema++; if (!u.effects.includes('unknown')) known++; if (u.tier === 1) tier1++; for (const e of u.effects) byEffect[e] = (byEffect[e] || 0) + 1; for (const p of u.params) { params++; const ok = p.type_src !== 'none' && p.type !== 'any'; if (ok) typed++; if (p.type_src === 'schema') srcSchema++; if (p.type_src === 'name') srcName++; if (!ok) untyped.push(u.name + '.' + p.name); } }
        const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
        return { units: n, no_schema: noSchema, invalid, tier1, tier1_pct: pct(tier1, n), params, typed_param_pct: pct(typed, params), typed_by_schema_pct: pct(srcSchema, params), typed_by_name_pct: pct(srcName, params), untyped: untyped.slice(0, 60), effects_known_pct: pct(known, n), by_effect: byEffect };
    }
    function index(catalog) { return catalog.units.map((u) => ({ id: u.id, name: u.name, summary: u.summary, tier: u.tier, avail: u.avail.state, effects: u.effects })); }

    return { VERSION, EFFECTS, TYPE_SRC, AVAIL, parseType, typeToString, isAssignable, schemaType, effectsOf, summaryOf, toolToUnit, validateUnit, buildCatalog, stats, index };
});
