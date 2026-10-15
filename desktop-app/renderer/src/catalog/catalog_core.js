/* 單元目錄的核心（UMD，純函式，不碰 DOM）：把「已登記的工具」（名稱＋說明＋JSON Schema）轉成單元描述（id、參數與型別、副作用、可用性、信任等級），
 * 並提供格式驗證、型別字串解析與相容判斷、評量統計。設計見 DESIGN.unit-catalog.md。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const VERSION = 1;
    const EFFECTS = ['fs.read', 'fs.write', 'net', 'proc', 'time', 'random', 'env', 'desktop', 'browser', 'ui', 'state.read', 'state.write', 'delegate', 'unknown'];
    const TYPE_SRC = ['annotation', 'stub', 'schema', 'doc', 'name', 'default', 'probe', 'curated', 'none'];
    const AVAIL = ['builtin', 'installed', 'cached', 'needs-network', 'disabled', 'unavailable'];
    // 型別詞彙：基本型別、由基本型別特化的（path 是一種 text），容器型別
    // 具體型別 → 它的上一層（可以放進上一層的位置，反過來不行）。檔案識別碼依媒體種類細分：pdf_file、video_file… 都是 file_id；gif_file 同時是 image_file
    const SPECIAL = { path: 'text', url: 'text', file_id: 'text', yaml: 'text', code: 'text', query: 'text', pdf_file: 'file_id', video_file: 'file_id', audio_file: 'file_id', image_file: 'file_id', gif_file: 'image_file', subtitle_file: 'file_id' };
    const KINDS = { pdf: 'pdf_file', video: 'video_file', audio: 'audio_file', image: 'image_file', gif: 'gif_file', subtitle: 'subtitle_file' };

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
        for (let k = from.k, guard = 0; SPECIAL[k] && guard < 4; k = SPECIAL[k], guard++) if (SPECIAL[k] === to.k) return true; // path → text、gif_file → image_file → file_id → text（具體 → 一般），反過來不行
        if (from.k === 'json' && (to.k === 'dict' || to.k === 'list')) return true; if (from.k === 'dict' && to.k === 'json') return true;
        return false;
    }

    // ===== JSON Schema → 單元的型別 =====
    const NAME_TYPES = [[/(^|_)(pdf|video|audio|image|gif|subtitle)_?file_?id$/i, 'KIND'], [/(^|_)(path|dir|folder|filepath|file_path|cwd)$/i, 'path'], [/(^|_)(url|uri|href|link)$/i, 'url'], [/(^|_)(file_id|fileid)$/i, 'file_id'], [/(^|_)(yaml|yml)$/i, 'yaml'], [/^(code|script|source)$/i, 'code'], [/^(query|pattern|keyword|q)$/i, 'query']];
    function schemaType(sc, pname, depth) {
        depth = depth || 0;
        if (!sc || typeof sc !== 'object') return { type: 'any', src: 'none' };
        if (Array.isArray(sc.enum) && sc.enum.length && sc.enum.length <= 24) return { type: 'enum<' + sc.enum.map((x) => String(x).replace(/[|<>]/g, '_')).join('|') + '>', src: 'schema' };
        const alt = sc.oneOf || sc.anyOf; if (Array.isArray(alt) && alt.length) { const ts = alt.map((a) => schemaType(a, pname, depth + 1)); return { type: 'union<' + ts.map((x) => x.type).join('|') + '>', src: ts.some((x) => x.src === 'none') ? 'none' : 'schema' }; }
        let ty = Array.isArray(sc.type) ? sc.type.filter((x) => x !== 'null') : sc.type; if (Array.isArray(ty)) { if (ty.length === 1) ty = ty[0]; else return { type: 'union<' + ty.map((x) => baseOf(x)).join('|') + '>', src: 'schema' }; }
        if (ty === 'string') { const hit = NAME_TYPES.find(([re]) => re.test(pname || '')); if (hit) { if (hit[1] === 'KIND') return { type: KINDS[/(pdf|video|audio|image|gif|subtitle)/i.exec(pname)[1].toLowerCase()], src: 'name' }; return { type: hit[1], src: 'name' }; } if (/file_?id/i.test(sc.description || '')) { const kd = /^(pdf|video|audio|image|gif|subtitle|captions?|srt)$/i.exec(pname || ''); return { type: kd ? (KINDS[kd[1].toLowerCase()] || 'subtitle_file') : 'file_id', src: 'doc' }; } return { type: 'text', src: 'schema' }; } // 參數說明提到 file_id（例如「影片 file_id 或檔名」）→ file_id
        if (ty === 'array') { const it = sc.items ? schemaType(sc.items, '', depth + 1) : { type: 'any', src: 'none' }; if (it.type === 'text' && /file_?id/i.test((sc.description || '') + ' ' + ((sc.items && sc.items.description) || ''))) return { type: 'list<file_id>', src: 'doc' }; return { type: 'list<' + it.type + '>', src: it.src === 'none' ? 'none' : 'schema' }; }
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

    // ===== 回傳型別推論 =====
    // 工具的回傳值都是 JSON 字串，Schema 沒有回傳結構。這裡從兩個來源推：
    //   ① 說明文字裡的「回傳 {ok, pdf_file_id, filename…}」這種欄位清單（type_src:'doc'）；
    //   ② 沒有清單時，從工具名稱推（is_／has_ → bool、*_yaml → yaml、list_ → 清單，type_src:'name'）；
    //   都推不出來 → json（type_src:'none'），列在設計文件的清單裡讓人手動補。
    // 欄位型別一律從欄位名稱／字面值推，不是從實際回傳值學來的——信任度低，規劃時要看 type_src。
    const FIELD_RULES = [
        [/^(ok|success|has_more|hasmore|truncated|done|exists|found|ready|valid|verification_skipped|likely_binary)$/i, 'bool'], [/^(is|has|can|should)([A-Z_]|$)/, 'bool'],
        [/(seconds|secs)$/i, 'number'], [/^(fps|framerate)$/i, 'number'], [/^(exit_?code|frames|samplerate|channels|nextoffset)$/i, 'int'], [/^(stdout|stderr|output|language|voice|kind)$/i, 'text'],
        [/(^|_)pdf_?file_?id$/i, 'pdf_file'], [/(^|_)video_?file_?id$/i, 'video_file'], [/(^|_)audio_?file_?id$/i, 'audio_file'], [/(^|_)gif_?file_?id$/i, 'gif_file'], [/(^|_)(subtitle|transcript|srt)_?file_?id$/i, 'subtitle_file'], [/(^|_)image_?file_?id$/i, 'image_file'],
        [/(^|_)file_?id$/i, 'file_id'], [/(^|_)(url|href|link)$/i, 'url'], [/(^|_)(path|dir|folder|cwd)$/i, 'path'], [/(^|_)(yaml|yml)$/i, 'yaml'], [/^(code|script|source)$/i, 'code'],
        [/(^|_)(count|total|size|sizebytes|bytes|length|page|pages|index|offset|limit|width|height|seconds|duration|ms|status|line|lines)$|(count|pages|bytes)$/i, 'int'],
        [/^(score|ratio|confidence|progress|percent)$/i, 'number'],
        [/(^|_)(text|content|message|error|reason|summary|title|description|name|filename|label|note|hint|mermaid|markdown|html|answer|result_text)$/i, 'text'],
    ];
    function fieldType(name, literal) {
        const n = String(name).trim();
        if (literal !== undefined) { const v = String(literal).trim(); if (/^(true|false)$/i.test(v)) return 'bool'; if (/^-?\d+$/.test(v)) return 'int'; if (/^-?\d+\.\d+$/.test(v)) return 'number'; if (/^\[/.test(v)) return 'list<any>'; if (/^\{/.test(v)) return 'dict'; if (/^["']/.test(v) && !FIELD_RULES.some(([re]) => re.test(n))) return 'text'; }
        for (const [re, ty] of FIELD_RULES) if (re.test(n)) return ty;
        if (/(s|list|items|results|entries|blocks|sentences|intents|rows|files|pages)$/i.test(n) && !/(status|address|class|process|progress|bytes)$/i.test(n)) return 'list<any>';
        return 'any';
    }
    function splitTop(s) { const out = []; let d = 0, q = '', cur = ''; for (const c of s) { if (q) { cur += c; if (c === q) q = ''; continue; } if (c === '"' || c === "'") { q = c; cur += c; continue; } if ('[{('.includes(c)) d++; else if (']})'.includes(c)) d--; if (c === ',' && d === 0) { out.push(cur); cur = ''; } else cur += c; } if (cur.trim()) out.push(cur); return out; }
    function inferReturns(name, description) {
        const desc = String(description || '').replace(/\s+/g, ' ');
        let m = null; const lead = /(?:回傳|返回|returns?)(?:[^{}]{0,60}?)\{/i.exec(desc);
        if (lead) { // 找到配對的 }（欄位裡可能有巢狀的 {…}）
            const s0 = lead.index + lead[0].length - 1; let d = 0, e = -1; for (let i = s0; i < desc.length && i < s0 + 800; i++) { if (desc[i] === '{') d++; else if (desc[i] === '}' && --d === 0) { e = i; break; } }
            if (e > s0 + 3) m = [null, desc.slice(s0, e + 1)];
        }
        if (m) {
            const fields = {}; let n = 0;
            for (const item of splitTop(m[1].slice(1, -1))) {
                const it = item.trim(); if (!it || /^\.{2,}$|^…$/.test(it)) continue;
                const km = /^["']?([A-Za-z_][\w]*)["']?(?:\s*[（(][^）)]*[）)])?\s*(?::\s*(.+))?$/.exec(it); if (!km) continue;
                const key = km[1]; const lit = km[2] !== undefined ? km[2].trim() : undefined; if (lit !== undefined && /^[…\.]+$/.test(lit)) continue;
                fields[key] = fieldType(key, lit && /^(true|false|-?\d+(\.\d+)?|\[.*|\{.*|["'].*)$/i.test(lit) ? lit : undefined); if (++n >= 16) break;
            }
            if (n >= 1) return { type: 'object{' + Object.keys(fields).map((k) => k + ':' + fields[k]).join(',') + '}', type_src: 'doc' };
        }
        const base = String(name).replace(/__[0-9a-f-]{20,}$/i, '');
        if (/^(is|has|can|should)_/.test(base)) return { type: 'bool', type_src: 'name' };
        if (/_yaml$/.test(base) && /^get_/.test(base)) return { type: 'yaml', type_src: 'name' };
        if (/^list_/.test(base)) return { type: 'list<dict>', type_src: 'name' };
        return { type: 'json', type_src: 'none' };
    }

    // ===== Python 原型（extract_py.py 的輸出）→ 單元 =====
    // 註解字串（str、list[str]、Optional[int]、int | None、Union[A,B]、dict[str, Any]、Path…）→ 我們的型別詞彙。對不上的回傳 null（不猜）。
    const PY_SIMPLE = { str: 'text', int: 'int', float: 'number', bool: 'bool', bytes: 'bytes', bytearray: 'bytes', none: 'null', nonetype: 'null', any: 'any', object: 'any', dict: 'dict', mapping: 'dict', mutablemapping: 'dict', ordereddict: 'dict', defaultdict: 'dict',
        list: 'list<any>', sequence: 'list<any>', iterable: 'list<any>', tuple: 'list<any>', set: 'list<any>', frozenset: 'list<any>', collection: 'list<any>', path: 'path', pathlike: 'path', complex: 'number', decimal: 'number', fraction: 'number', callable: 'callable',
        // typeshed 常用的名稱：數字協定、緩衝區、路徑別名（別名在轉換時多半已展開，這裡是沒展開的保底）
        supportsfloat: 'number', supportsint: 'int', supportsindex: 'int', supportscomplex: 'number', real: 'number', number: 'number', readablebuffer: 'bytes', writablebuffer: 'bytes', buffer: 'bytes', strpath: 'path', strorbytespath: 'path', filedescriptororpath: 'path', hashable: 'any' };
    // 執行時的模組名稱 → typeshed 裡真正定義函式的模組（os.path 在 typeshed 只是轉出，定義在 posixpath／ntpath）
    const STUB_MODULE_ALIAS = { 'os.path': 'posixpath', 'collections.abc': '_collections_abc', 'importlib.abc': 'importlib.abc' };
    // 聯集收斂：int 是 number 的一種；text 與 path 並列時取 path（「字串或路徑物件」的意圖是路徑）
    function collapseUnion(nn) { let a = Array.from(new Set(nn)); if (a.includes('number')) a = a.filter((x) => x !== 'int'); if (a.includes('path')) a = a.filter((x) => x !== 'text'); return a.length === 1 ? a[0] : 'union<' + a.join('|') + '>'; }
    function splitTopComma(s) { const out = []; let d = 0, cur = ''; for (const c of s) { if (c === '[') d++; else if (c === ']') d--; if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += c; } if (cur.trim()) out.push(cur.trim()); return out; }
    function pyTypeToType(ann) {
        if (ann === undefined || ann === null) return null; let s = String(ann).trim().replace(/^typing\./, '').replace(/typing\./g, '').replace(/^['"]|['"]$/g, ''); if (!s) return null;
        if (/^<class '([\w.]+)'>$/.test(s)) s = /^<class '([\w.]+)'>$/.exec(s)[1].split('.').pop();
        const bar = splitTopBar(s); if (bar.length > 1) { const ts = bar.map(pyTypeToType); if (ts.some((x) => x === null)) return null; const nn = ts.filter((x) => x !== 'null'); if (!nn.length) return 'null'; return collapseUnion(nn); }
        const g = /^([\w.]+)\[(.*)\]$/.exec(s);
        if (g) {
            const head = g[1].split('.').pop().toLowerCase(), args = splitTopComma(g[2]);
            if (head === 'optional') return pyTypeToType(args[0]); if (head === 'union') { const ts = args.map(pyTypeToType); if (ts.some((x) => x === null)) return null; const nn = ts.filter((x) => x !== 'null'); return nn.length ? collapseUnion(nn) : 'null'; }
            if (['pathlike', 'supportsabs', 'supportsround'].includes(head)) return head === 'pathlike' ? 'path' : 'number';
            if (['list', 'sequence', 'iterable', 'set', 'frozenset', 'collection', 'tuple', 'mutablesequence', 'deque'].includes(head)) { const el = head === 'tuple' ? null : pyTypeToType(args[0]); return 'list<' + (el || 'any') + '>'; }
            if (['dict', 'mapping', 'mutablemapping', 'ordereddict', 'defaultdict'].includes(head)) return 'dict'; if (head === 'callable') return 'callable'; if (head === 'literal') { const vals = args.map((a) => a.replace(/^['"]|['"]$/g, '')).filter((a) => /^[\w.-]+$/.test(a)); return vals.length === args.length && vals.length ? 'enum<' + vals.join('|') + '>' : 'text'; }
            return null;
        }
        const k = s.split('.').pop().toLowerCase(); return PY_SIMPLE[k] || null;
    }
    function splitTopBar(s) { const out = []; let d = 0, cur = ''; for (const c of s) { if (c === '[') d++; else if (c === ']') d--; if (c === '|' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += c; } out.push(cur.trim()); return out; }
    function pyDefaultType(def) { if (def === null || def === undefined) return null; const d = String(def).trim(); if (/^(True|False)$/.test(d)) return 'bool'; if (/^-?\d+$/.test(d)) return 'int'; if (/^-?\d+\.\d*(e[+-]?\d+)?$/i.test(d)) return 'number'; if (/^(['"]).*\1$/.test(d)) return 'text'; return null; }
    function unitFromPyProto(p, ctx) {
        ctx = ctx || {}; const params = []; const callableParam = []; const smods = ctx.stubs && ctx.stubs.modules; const sp = smods && ((smods[p.module] && smods[p.module][p.name]) || (STUB_MODULE_ALIAS[p.module] && smods[STUB_MODULE_ALIAS[p.module]] && smods[STUB_MODULE_ALIAS[p.module]][p.name])); // 型別存根轉出來的表（stub_to_types.py）
        for (const pp of (p.params || [])) {
            if (pp.kind === 'VAR_POSITIONAL' || pp.kind === 'VAR_KEYWORD') continue; // *args／**kwargs 不進單元參數（要用就人工補）
            let ty = pyTypeToType(pp.annotation), src = ty ? 'annotation' : null;
            if (!ty && sp) { const sq = (sp.params || []).find((q) => q.name === pp.name); const st = sq && pyTypeToType(sq.annotation); if (st && st !== 'any') { ty = st; src = 'stub'; } } // 型別存根（typeshed）：標準庫沒有註解時的主要來源
            if (!ty) { const hit = NAME_TYPES.find(([re]) => re.test(pp.name)); if (hit && hit[1] !== 'KIND') { ty = hit[1]; src = 'name'; } }
            if (!ty) { const dt = pyDefaultType(pp.default); if (dt) { ty = dt; src = 'default'; } }
            if (!ty) { ty = 'any'; src = 'none'; }
            if (ty === 'callable') callableParam.push(pp.name);
            const o = { name: pp.name, kind: pp.kind === 'POSITIONAL_ONLY' ? 'positional' : (pp.kind === 'KEYWORD_ONLY' ? 'keyword' : 'named'), type: ty, type_src: src, required: pp.default === null || pp.default === undefined }; if (pp.default !== null && pp.default !== undefined) o.default = pp.default; params.push(o);
        }
        let rt = pyTypeToType(p.returns), rtSrc = 'annotation'; if (!rt && sp) { const sr = pyTypeToType(sp.returns); if (sr && sr !== 'any') { rt = sr; rtSrc = 'stub'; } } const effects = (p.effects && p.effects.length) ? p.effects.filter((e) => EFFECTS.includes(e)) : []; const pure = !!p.pure && !effects.length;
        const hasSig = Array.isArray(p.params); const state = p.stdlib ? 'builtin' : (ctx.installed && ctx.installed.includes(p.module.split('.')[0]) ? 'installed' : 'needs-network');
        const typedAll = hasSig && params.every((q) => q.type_src !== 'none' && q.type !== 'any' && q.type !== 'callable');
        const u = { id: 'py:' + p.module + '.' + p.name, runtime: 'python', name: p.module + '.' + p.name, summary: summaryOf(p.summary), params, returns: rt ? { type: rt, type_src: rtSrc } : { type: 'any', type_src: 'none' }, effects: pure ? [] : (effects.length ? effects : ['unknown']), pure, avail: { state, needs: [] }, domains: [], tests: (p.tests || []).slice(0, 3),
            call: { runtime: 'python', import: p.module, qualname: p.name, via: 'pyodide' }, sig_src: p.sig_src || 'none' };
        if (p.version) u.version = p.version; if (p.pure_src) u.pure_src = p.pure_src; if (p.effects_src) u.effects_src = p.effects_src; if (p.effect_evidence && p.effect_evidence.length) u.effect_evidence = p.effect_evidence.slice(0, 6);
        // 信任等級 1：簽名完整、參數型別都明確（不含 callable）、副作用已知、可用、而且有測試案例或回傳型別明確
        u.tier = (u.pure_src !== 'static' && typedAll && !callableParam.length && rt !== 'callable' && !u.effects.includes('unknown') && (state === 'builtin' || state === 'installed') && (u.tests.length > 0 || !!rt)) ? 1 : 0; return u;
    }

    // ===== 工具 → 單元 =====
    const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    function summaryOf(desc) { const s = String(desc || '').replace(/\s+/g, ' ').trim(); const m = /^(.{2,160}?(?:[。！？]|[.!?](?=\s|$)))/.exec(s); return clip(m ? m[1] : s, 160); }
    // 人工補強：ctx.returnsOverrides[工具名稱] ＝ 型別字串，優先於推論（type_src:curated）；不合法的型別字串直接忽略
    function overrideReturns(name, ctx) { const o = ctx && ctx.returnsOverrides && ctx.returnsOverrides[name]; if (!o) return null; try { parseType(o); } catch (_) { return null; } return { type: o, type_src: 'curated' }; }
    function toolToUnit(name, tool, ctx) {
        ctx = ctx || {}; const sc = tool && tool.parametersSchema; const props = (sc && sc.properties) || {}; const req = new Set((sc && sc.required) || []);
        const params = Object.keys(props).map((k) => { const t = schemaType(props[k], k, 0); const p = { name: k, kind: 'named', type: t.type, type_src: t.src, required: req.has(k) }; if (props[k] && props[k].default !== undefined) p.default = props[k].default; const d = clip(props[k] && props[k].description, 120); if (d) p.description = d; return p; });
        const effects = effectsOf(name); const domains = (ctx.domainsOf && ctx.domainsOf[name]) || [];
        let state = 'builtin'; if (ctx.platform === 'web' && effects.includes('desktop')) state = 'unavailable'; else if (domains.length && ctx.domainEnabled && domains.every((d) => ctx.domainEnabled[d] === false)) state = 'disabled';
        const typedAll = params.every((p) => p.type_src !== 'none' && p.type !== 'any');
        const tier = (sc && tool.description && !effects.includes('unknown') && typedAll && state !== 'unavailable') ? 1 : 0;
        const u = { id: 'tool:' + name, runtime: 'app', name, summary: summaryOf(tool && tool.description), params, returns: overrideReturns(name, ctx) || inferReturns(name, tool && tool.description), effects, pure: false, avail: { state, needs: effects.includes('desktop') ? ['desktop'] : [] }, domains, tests: [], tier };
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
        const ctx = { domainsOf, domainEnabled, platform: opts.platform || 'desktop', returnsOverrides: opts.returnsOverrides || {} }; const units = [];
        for (const name of Object.keys(tools || {}).sort()) units.push(toolToUnit(name, tools[name], ctx));
        for (const u of (opts.extraUnits || [])) units.push(u); // 從別的來源（Python 套件、JavaScript、bash）抽出來的單元
        return { version: VERSION, source: 'app-tools', generatedAt: opts.now || new Date().toISOString(), platform: ctx.platform, units, stats: stats(units) };
    }
    // 評量表（DESIGN.unit-catalog.md 第七節）
    function stats(units) {
        const n = units.length; let params = 0, typed = 0, srcSchema = 0, srcName = 0, tier1 = 0, known = 0, noSchema = 0, invalid = 0; const byEffect = {}; const untyped = []; let retTyped = 0; const retSrc = {}; const retNone = [];
        for (const u of units) { const rt = u.returns || {}; retSrc[rt.type_src] = (retSrc[rt.type_src] || 0) + 1; if (rt.type !== 'json' && rt.type !== 'any') retTyped++; else retNone.push(u.name); if (validateUnit(u).length) invalid++; if (u.no_schema) noSchema++; if (!u.effects.includes('unknown')) known++; if (u.tier === 1) tier1++; for (const e of u.effects) byEffect[e] = (byEffect[e] || 0) + 1; for (const p of u.params) { params++; const ok = p.type_src !== 'none' && p.type !== 'any'; if (ok) typed++; if (p.type_src === 'schema') srcSchema++; if (p.type_src === 'name') srcName++; if (!ok) untyped.push(u.name + '.' + p.name); } }
        const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
        return { units: n, no_schema: noSchema, invalid, tier1, tier1_pct: pct(tier1, n), params, typed_param_pct: pct(typed, params), typed_by_schema_pct: pct(srcSchema, params), typed_by_name_pct: pct(srcName, params), untyped: untyped.slice(0, 60), effects_known_pct: pct(known, n), returns_typed_pct: pct(retTyped, n), returns_by_src: retSrc, returns_unknown: retNone.slice(0, 400), by_effect: byEffect };
    }
    function index(catalog) { return catalog.units.map((u) => ({ id: u.id, name: u.name, summary: u.summary, tier: u.tier, avail: u.avail.state, effects: u.effects })); }

    return { VERSION, EFFECTS, TYPE_SRC, AVAIL, unitFromPyProto, pyTypeToType, inferReturns, fieldType, parseType, typeToString, isAssignable, schemaType, effectsOf, summaryOf, toolToUnit, validateUnit, buildCatalog, stats, index };
});
