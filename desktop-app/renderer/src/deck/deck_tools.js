/* /media-presentation 的工具與子任務（領域）。
 * 對應 redmine_ai_chat 的 media_presentation_tools.rb／media_presentation_design_agent.rb／media_snippets.rb／media_image_catalog.rb。
 * 純函式部分（Snippets、ImageCatalog、估算、圖片來源解析）可以用 node 測試；工具登記在最後的 methods 裡（掛到 FloatingAssistant.prototype）。 */
const FaDeckTools = (function () {
    'use strict';
    const SNIPPET_KINDS = { widget: 'w', code: 'c', patch: 'p' };
    const HANDLE = /^@([a-z])(\d+)$/;
    const MAX_DECK_MINUTES = 75;
    const MAX_ERRORS_SHOWN = 25;
    const MAX_IMAGES = 60;
    const MAX_DATA_URI_BYTES = 150000;
    const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/g;
    // 伺服器端才是錯誤、瀏覽器端只是警告的規則（見 DESIGN.media-presentation.md §1 原則 6）：生成當下就退回，模型可以馬上修
    const STRICT_WARNING = /mentions the speaking speed|removes and adds the identical line|snippet handle that was never defined|refers to code \/ a patch on an earlier slide/;

    // ---------------------------------------------------------------- 長文字的 handle（小遊戲 HTML、長程式碼、patch）
    class Snippets {
        constructor(widgetProblems, limits) { this.store = {}; this.kinds = {}; this.widgetProblems = widgetProblems || (() => []); this.limits = limits || { code: 400000, widget: 120000 }; }
        define(kind, content) {
            kind = String(kind || '');
            if (!SNIPPET_KINDS[kind]) return { error: 'kind must be one of: ' + Object.keys(SNIPPET_KINDS).join(', ') };
            const text = String(content == null ? '' : content);
            if (!text.trim()) return { error: 'content is required: the full html document (widget) or the code / patch text (code)' };
            if (kind === 'widget') {
                if (text.length > this.limits.widget) return { error: 'the widget html is longer than ' + this.limits.widget + ' characters -- make the game smaller' };
                const problems = this.widgetProblems(text);
                if (problems.length) return { error: 'the widget html is refused -- fix and call define_snippet again:\n- ' + problems.join('\n- ') };
            } else if (text.length > this.limits.code) return { error: 'the ' + kind + ' is longer than ' + this.limits.code + ' characters' };
            const letter = SNIPPET_KINDS[kind];
            const n = Object.keys(this.store).filter((h) => h.indexOf('@' + letter) === 0).length + 1;
            const handle = '@' + letter + n;
            this.store[handle] = text; this.kinds[handle] = kind;
            const field = kind === 'widget' ? 'html' : 'code';
            return { ok: true, handle, chars: text.length, lines: text.split('\n').length, use: 'in the deck yaml write  ' + field + ': "' + handle + '"  (the text is put in when the deck is saved)' };
        }
        // 把 deck 文件裡 widget 的 html／code 的 handle 換成儲存的文字（就地修改），回傳問題清單
        expand(data) {
            const problems = [];
            const FIELDS = { widget: { html: ['widget'] }, code: { code: ['code', 'patch'] } };
            if (!data || !Array.isArray(data.chapters)) return problems;
            data.chapters.forEach((ch, ci) => {
                if (!ch || !Array.isArray(ch.slides)) return;
                ch.slides.forEach((s, si) => {
                    if (!s || !s.visual || typeof s.visual !== 'object') return;
                    const nodes = [s.visual];
                    if (s.visual.kind === 'group' && Array.isArray(s.visual.items)) s.visual.items.filter((i) => i && typeof i === 'object').forEach((i) => nodes.push(i));
                    nodes.forEach((v, k) => {
                        const path = 'chapters[' + ci + '].slides[' + si + '].visual' + (k ? '.items[' + (k - 1) + ']' : '');
                        const spec = FIELDS[v.kind] || {};
                        Object.keys(spec).forEach((field) => {
                            if (typeof v[field] !== 'string' || !HANDLE.test(v[field].trim())) return;
                            const handle = v[field].trim();
                            if (this.store[handle] !== undefined && spec[field].indexOf(this.kinds[handle]) >= 0) {
                                v[field] = this.store[handle];
                                if (this.kinds[handle] === 'patch' && !('patch' in v)) v.patch = true;
                            } else {
                                const want = spec[field].map((x) => '"' + x + '"').join(' or ');
                                problems.push(path + '.' + field + ': ' + handle + ' was never defined -- call define_snippet(kind: ' + want + ', content: <the full text>) first and use the handle it returns (the text itself cannot be written as @-something)');
                            }
                        });
                    });
                });
            });
            return problems;
        }
    }

    // ---------------------------------------------------------------- 「看過的」圖片目錄（@img1…）
    class ImageCatalog {
        constructor() { this.entries = []; this.byUrl = {}; }
        add(url, o) {
            url = String(url || '').trim(); o = o || {};
            if (!url || this.entries.length >= MAX_IMAGES) return null;
            if (this.byUrl[url]) return this.byUrl[url];
            const e = { ref: '@img' + (this.entries.length + 1), url, alt: String(o.alt || '').slice(0, 120), from: String(o.from || ''), context: String(o.context || '').slice(0, 200) };
            this.entries.push(e); this.byUrl[url] = e; return e;
        }
        known(url) { return Object.prototype.hasOwnProperty.call(this.byUrl, String(url || '').trim()); }
        resolve(value) {
            const v = String(value == null ? '' : value).trim();
            const m = /^@img(\d+)$/.exec(v);
            if (m) { const e = this.entries[Number(m[1]) - 1]; return e ? e.url : null; }
            return this.known(v) ? v : null;
        }
        listing() {
            return this.entries.map((e) => { const r = { ref: e.ref, from: e.from }; if (e.alt) r.alt = e.alt; if (e.context) r.context = e.context; return r; });
        }
        // 掃描任何工具結果（物件、陣列、字串）裡的圖片：client-file/ID、markdown 圖片、帶 is_image／image content_type 的物件
        scan(obj, from) {
            from = String(from || '');
            const walk = (node, context) => {
                if (node == null) return;
                if (typeof node === 'string') { this.scanText(node, from); return; }
                if (Array.isArray(node)) { node.forEach((x) => walk(x, context)); return; }
                if (typeof node !== 'object') return;
                let data = node.data_url; if (typeof data === 'string' && data.length > MAX_DATA_URI_BYTES) data = null;
                const url = node.client_file_url || node.url || data;
                if (typeof url === 'string' && this.imageish(node, url)) this.add(url, { alt: node.filename || node.title || node.description, from, context });
                Object.keys(node).forEach((k) => { if (k !== 'data_url') walk(node[k], context); });
            };
            walk(obj, null);
            return this;
        }
        imageish(node, url) {
            if (node.is_image === true || node.type === 'image') return true;
            if (String(node.content_type || node.mimeType || '').indexOf('image/') === 0) return true;
            if (url.indexOf('client-file/') === 0) return true;
            return /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s)]*)?$/i.test(String(node.filename || '')) || /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s)]*)?$/i.test(url);
        }
        scanText(text, from) {
            const md = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g; let m;
            while ((m = md.exec(text))) {
                const before = text.slice(Math.max(0, m.index - 120), m.index), after = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
                this.add(m[2], { alt: m[1], from, context: (before + ' [IMAGE] ' + after).replace(/\n/g, ' ') });
            }
            const cf = /\bclient-file\/[\w-]+/g;
            while ((m = cf.exec(text))) this.add(m[0], { from });
        }
    }

    // ---------------------------------------------------------------- 估算與文件走訪
    function estimateMinutes(doc) {
        if (!doc || !Array.isArray(doc.chapters)) return 0;
        let speed = Number(doc.deck && doc.deck.speed); if (!(speed >= 0.5 && speed <= 2)) speed = 1;
        let seconds = 0;
        doc.chapters.forEach((ch) => {
            if (!ch || !Array.isArray(ch.slides)) return;
            ch.slides.forEach((s) => {
                if (!s || typeof s !== 'object') return;
                const text = String(s.narration || ''); const explicit = Number(s.duration) || 0;
                if (!text.trim()) { seconds += Math.max(explicit, 4); return; }
                const cjk = (text.match(CJK) || []).length;
                const words = (text.replace(CJK, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’\-.]*/g) || []).length;
                seconds += Math.max((cjk / 4.2 + words / 2.6) / speed + 0.9, 2.5, explicit);
            });
        });
        return seconds / 60;
    }
    function visualNodes(visual) {
        if (!visual || typeof visual !== 'object') return [];
        const nodes = [visual];
        if (visual.kind === 'group' && Array.isArray(visual.items)) visual.items.filter((i) => i && typeof i === 'object').forEach((i) => nodes.push(i));
        return nodes;
    }
    function eachSlide(data, fn) {
        (data.chapters || []).forEach((ch, ci) => (ch.slides || []).forEach((s, si) => fn(s, 'chapters[' + ci + '].slides[' + si + ']')));
    }
    // 圖片 handle 換成網址；沒看過的位址一律拒絕（圖片只能用「看過的」）。回傳問題清單
    function resolveImages(data, catalog) {
        const problems = [];
        const resolveInto = (obj, key, path) => {
            const s = String(obj[key] == null ? '' : obj[key]).trim();
            const hit = catalog.resolve(s);
            if (hit) { obj[key] = hit; return; }
            if (/^client-file\/[\w-]+$/.test(s)) { obj[key] = s; return; }
            if (s.indexOf('data:image/') === 0 && s.length <= MAX_DATA_URI_BYTES) { obj[key] = s; return; }
            problems.push(path + ': "' + s.slice(0, 80) + '" is not a picture this task has seen -- use a handle from list_source_images ("@img1"), or import it first with import_image_url / import_fap_image');
        };
        eachSlide(data, (slide, path) => {
            visualNodes(slide.visual).forEach((v, k) => {
                const np = path + '.visual' + (k ? '.items[' + (k - 1) + ']' : '');
                if (v.kind === 'image') {
                    if (Array.isArray(v.images)) v.images.forEach((im, i) => resolveInto(im, 'src', np + '.images[' + i + '].src'));
                    else resolveInto(v, 'src', np + '.src');
                } else if (v.kind === 'chart') resolveInto(v, 'src', np + '.src');
                else if (v.kind === 'svg' && String(v.src || '').trim()) resolveInto(v, 'src', np + '.src');
                else if ((v.kind === 'anim2d' || v.kind === 'scene3d') && String(v.ref || '').trim() && !/^client-file\/[\w-]+(\.[\w.-]+)?$/.test(String(v.ref).trim())) problems.push(np + '.ref: must be "client-file/<file_id>" of an uploaded ' + (v.kind === 'anim2d' ? '.2danim.yaml' : '.3dscene.yaml') + ' (or write the scene inline with "' + (v.kind === 'anim2d' ? 'kind: shapes' : 'scene:') + '")');
            });
        });
        return problems;
    }

    // ---------------------------------------------------------------- 子任務（領域）的系統提示（外掛 MediaPresentationDesignAgent.system_prompt 的移植）
    const SYSTEM_PROMPT = [
        'You are a focused presentation-design assistant working for another AI assistant. Your only job is to produce a real animated slide deck with render_presentation (or begin_presentation / add_chapters / finish_presentation for a long one) and answer briefly -- never describe slides in prose, and never paste deck yaml into your reply. The finished deck is shown to the user automatically as a player in the chat (you do not embed it).',
        '',
        'WHAT A DECK IS: chapters of slides in the deck template; every slide has a title, short bullets, a visual (a drawn diagram, a table, a real picture from the source, a flowchart ...) that is always in motion or revealed over time, narration that is read aloud by text-to-speech and shown as a subtitle bar, and a transition into it. The viewer plays it in a window and can export MP4 / PPTX. You write the DESCRIPTION (yaml); the renderer does the layout and animation.',
        '',
        'WORKFLOW',
        '1. Call get_presentation_topic for "format" and "visuals" (once per conversation; also "cues" / "sources" / "style" when needed, and "3d" whenever the subject is a physical thing or the user asks for 3D / a 3D presentation).',
        '2. GATHER THE MATERIAL before writing anything: read the files / pages the request points at with your tools (list_uploaded_files + parse_uploaded_file for uploaded files, fap_read_file / repo_ask for the user\'s folders, the "material" section the main assistant may have attached, text of web pages it read). Read ALL of a long source. Then call list_source_images: every picture the sources contain is there as "@img1", "@img2" ... Bring in other pictures with import_fap_image (a picture file in a folder) or import_image_url (a picture on a website).',
        '   THE SOURCES THE USER NAMES ARE WHERE TO START, NOT THE LIMIT. If the request names none, or they hold too little, never answer "I found no document / please give me ..." -- that is a failed job. Call get_presentation_topic("ai_features") when the subject is this AI itself, and fill what remains from your own knowledge (see the "sources" topic). A deck from general knowledge is a normal, complete result.',
        '3. DIGEST, do not copy: decide the storyline (chapters -> slides), what each slide\'s one point is, which picture/table/diagram shows it, and what the narration says. Tables in the source become table visuals; screenshots and diagrams become image visuals with callouts at the parts you talk about; processes and relationships you draw yourself as shapes/mermaid with the steps revealed in step with the narration. Use the source\'s real pictures wherever they carry information. Never invent figures or pictures that no tool returned; where the sources lack something, explain it from general knowledge (saying it is general) or omit it.',
        '4. Write the yaml and call render_presentation. If it reports problems, fix them all and call it again.',
        '5. Answer in the user\'s language: one or two sentences (what the deck covers: slides, chapters, approximate length, which sources it used). If part of the material could not be used (a picture that could not be imported, a table too wide), say that plainly.',
        '',
        'LONG REQUESTS STAY ONE PRESENTATION. A 30-minute talk is ONE deck of 50-70 slides (the length counts the speaking speed: at 1.5x speech the same slides play 1.5x shorter -- add slides to fill the asked time). It is too much to write in one reply, so build it in batches:',
        '1. Read the whole source first (all of it; keep your notes short), and plan the storyline: chapters with their slide counts and minutes.',
        '2. begin_presentation(deck: "title: ...\\nlang: zh-TW\\nspeed: 1.5") -> a draft id.',
        '3. add_chapters(draft, yaml) once per batch of about 8-12 minutes of content (3-5 chapters / 15-25 slides). A batch that is refused is fixed and sent again as the same batch. The result tells you the minutes so far; stop when the asked length is reached.',
        '4. finish_presentation(draft) assembles ONE deck and saves it. (A short deck, up to ~12 minutes, is a single render_presentation call.)',
        'Keep the whole talk coherent: one title slide at the start, a recap every few chapters, a summary at the end; do not restart or repeat yourself between batches, and never split the talk into several presentations.',
        '',
        'RULES THAT MATTER',
        '- Length: follow the request ("5 minutes", "3 chapters"); default about 8-12 slides, 25-40 seconds of narration each. Slide 1 is a title slide; the last is a summary. Chapters have 3-6 slides.',
        '- Narration is natural speech in the deck language, short sentences, 2-5 per slide, no markdown/URLs/emoji. Bullets are short fragments that echo the narration, not the narration itself. Make the narration\'s sentences line up with what appears (see cues).',
        '- Every slide with a picture/table/diagram uses layout split or visual; text-only slides are the exception (use them for chapter intros and the summary).',
        '- Pictures only by handle ("@img3") or "client-file/<id>" from a tool result. A table has <= 8 columns and <= 12 rows per slide: split long tables over several slides or keep the rows that matter and say so.',
        '- If the request is to change a deck made earlier (it mentions a file id / url), call get_presentation_yaml first and edit THAT yaml.',
        '- 2D and 3D mix in one format: a slide can hold a live 3D model (visual kind scene3d with an inline scene; the viewer can orbit and zoom it), with 2D labels/arrows over it (overlay) or a table/image beside it (group); deck.style: 3d (or stage: 3d on single slides) shows it through a viewport on the normal template page, and each 3D slide gets a CAMERA (slide.camera: a preset name, a shot mapping, or a list of shots with focus on a named node of the model and "at" a sentence) -- 3D here means the relation of the camera to the scene and model, not scenery. "A 3D presentation" = deck.style: 3d with a 3D model and camera shots on most slides (read get_presentation_topic("3d")). Do not use 3D for slides that are only text.',
        '- Interactive slides: long code / a log / a patch (more than ~12 lines) goes into a visual kind code (scrollable, syntax-highlighted, patches shown as a diff) instead of bullets or a picture; a shell the viewer can type into is kind terminal; when the user wants Q&A, a quiz, practice or a game, use kind quiz (scored answer cards, static key or AI grading) or kind widget (YOU write a small game / simulator as one self-contained HTML document, e.g. "reach 100 points at breakout"). Read get_presentation_topic("interactive") first: widget html runs in a no-network sandbox and the topic has the exact rules and a working example. The html of a widget and any long code are given with define_snippet (a handle "@w1" / "@c1" goes in the yaml) -- never paste them into the yaml. Every widget needs a "fallback" sentence (what PPTX / video show instead).',
        '  A quiz about code / a patch / a diagram shows that material on the SAME slide (group: code left, quiz right), with exactly one right answer visible on screen and an `explain` that agrees with `answer`; a patch you write is a real unified diff (hunk headers with line ranges, one leading space on context lines).',
        '- NARRATION IS ONLY WHAT THE AUDIENCE SHOULD HEAR. The user\'s instructions to YOU -- speaking speed ("說話速度 1.2 倍", "speak fast"), how long the talk should be, the language, "use a code window", slide numbers, tool / field / function names (deck.done(), kind: widget, wait: true) -- are settings and structure, never sentences of the talk. Speed goes into deck.speed ONLY; never write "說話速度 1.2 倍" or "這段簡報約六分鐘,用 1.2 倍速" into a narration (a narration that mentions the speaking speed is refused). Say what a presenter would say.',
        '- Voice: leave deck.voice out unless the user named one. Speaking speed: when the user asks for a faster or slower voice ("說話速度 1.5 倍", "speak slowly") set deck.speed to that number (0.5-2, default 1); the slides get shorter or longer by themselves, so keep the same text.',
    ].join('\n');

    // 領域登記用的工具名稱（子任務只看得到這些）
    const DOMAIN_TOOLS = ['render_presentation', 'begin_presentation', 'add_chapters', 'finish_presentation', 'define_snippet', 'get_presentation_topic',
        'get_presentation_yaml', 'open_existing_presentation', 'list_source_images', 'import_image_url', 'import_fap_image', 'get_3d_scene_topic',
        'list_uploaded_files', 'parse_uploaded_file', 'summarize_large_text', 'list_file_access_points', 'fap_list_files', 'fap_find_file', 'fap_read_file',
        'repo_ask', 'repo_read_doc'];

    // ---------------------------------------------------------------- 掛到 FloatingAssistant 的方法
    const methods = {
        // 一次簡報任務的狀態（圖片目錄、長文字 handle、分批草稿）；每次委派給簡報領域時重來
        _deckRun() {
            if (!this._deckRunState) this._deckBeginRun('');
            return this._deckRunState;
        },
        _deckBeginRun(taskText) {
            const Widget = window.AiChatDeckWidget;
            this._deckRunState = { catalog: new ImageCatalog(), snippets: new Snippets(Widget ? (h) => Widget.problems(h) : null), drafts: {}, nDrafts: 0 };
            if (taskText) this._deckRunState.catalog.scan(String(taskText), 'request');
            return this._deckRunState;
        },
        _deckCatalogNote(toolName, result) {
            if (!this._deckRunState || !this._deckInDomainRun) return;
            if (/^(render_presentation|begin_presentation|add_chapters|finish_presentation|define_snippet|get_presentation_topic|list_source_images)$/.test(toolName)) return;
            try { this._deckRunState.catalog.scan(typeof result === 'string' ? (() => { try { return JSON.parse(result); } catch (_) { return result; } })() : result, toolName); } catch (_) { /* 目錄只是方便，不能弄壞工具 */ }
        },
        _deckParseYaml(text) {
            try { return { data: window.jsyaml.load(String(text)) }; } catch (e) {
                return { error: 'yaml could not be parsed: ' + String(e && e.message || e) + '\nHint: a long text (a widget\'s html, code) inside a yaml string is the usual cause -- give it to define_snippet and write the handle (html: "@w1" / code: "@c1"); keep strings short, put a string with a colon or quote in double quotes, indent with spaces only.' };
            }
        },
        // 驗證一份簡報文件（格式、圖片 handle、內嵌場景、總長度）。會就地修改 data（handle 換成真值）。-> {error} 或 {warnings, minutes}
        async _deckCheck(data, toolName) {
            await this._deckEnsureRuntime();
            const Core = window.AiChatDeckCore, run = this._deckRun();
            const expand = run.snippets.expand(data);
            if (expand.length) return { error: 'the deck has ' + expand.length + ' problem(s) -- fix them all and call ' + toolName + ' again:\n- ' + expand.join('\n- ') };
            const res = Core.validate(data);
            const problems = res.errors.slice(); const warnings = [];
            res.warnings.forEach((w) => { if (STRICT_WARNING.test(w)) problems.push(w); else warnings.push(w); });
            if (!problems.length) {
                const minutes = estimateMinutes(data);
                if (minutes > MAX_DECK_MINUTES) return { error: 'this deck would play for about ' + Math.round(minutes) + ' minutes; the limit is ' + MAX_DECK_MINUTES + ' minutes for one presentation. Cut the least important parts.' };
                problems.push(...this._deckValidateScenes(data));
            }
            if (!problems.length) problems.push(...resolveImages(data, run.catalog));
            if (problems.length) {
                const shown = problems.slice(0, MAX_ERRORS_SHOWN);
                return { error: 'the deck has ' + problems.length + ' problem(s) -- fix them all and call ' + toolName + ' again:\n- ' + shown.join('\n- ') + (problems.length > shown.length ? '\n... and ' + (problems.length - shown.length) + ' more' : '') };
            }
            return { warnings: warnings.slice(0, 10), minutes: estimateMinutes(data) };
        },
        // 內嵌的 2D（shapes／overlay）與 3D 場景用各自引擎的驗證，畫不出來的在這裡就擋下
        _deckValidateScenes(data) {
            const problems = [];
            const y = window.jsyaml;
            eachSlide(data, (slide, path) => {
                visualNodes(slide.visual).forEach((node, k) => {
                    const np = path + '.visual' + (k ? '.items[' + (k - 1) + ']' : '');
                    const check2d = (scene, p) => {
                        try { const r = this._validate2DAnimationYaml(y.dump(Object.assign({ kind: 'ai_chat_animation_2d' }, scene)), {}); if (r && r.ok === false) problems.push(p + ': ' + r.error); } catch (e) { problems.push(p + ': ' + String(e && e.message || e)); }
                    };
                    if (node.kind === 'shapes' && node.scene && typeof node.scene === 'object') check2d(node.scene, np + '.scene');
                    if (node.overlay && node.overlay.scene && typeof node.overlay.scene === 'object') check2d(node.overlay.scene, np + '.overlay.scene');
                    if (node.kind === 'scene3d' && node.scene && typeof node.scene === 'object') {
                        // 播放器用移植過來的 3D 檢視器（巢狀 animation: {type, speed} 與扁平 animation: spin 兩種寫法都認），驗證也用它自己的規則
                        try { window.AiChat3D._internal.parseScene(JSON.stringify(node.scene)); } catch (e) { problems.push(np + '.scene: ' + String(e && e.message || e)); }
                    }
                });
            });
            return problems;
        },
        async _deckSaveChecked(data, name, checked) {
            const text = window.jsyaml.dump(data, { lineWidth: -1, noRefs: true });
            const saved = await this._deckSaveYaml(text, name || (data.deck && data.deck.title));
            const slides = data.chapters.reduce((n, c) => n + c.slides.length, 0);
            this._latestDeckUrl = saved.url;
            return { ok: true, type: 'deck', url: saved.url, file_id: saved.id, name: name || (data.deck && data.deck.title) || saved.name, title: (data.deck && data.deck.title) || '', slides, chapters: data.chapters.length, minutes: Math.round(checked.minutes * 10) / 10, warnings: checked.warnings };
        },
        async _deckRender(a) {
            const yamlText = String(a.yaml || '');
            if (!yamlText.trim()) return { error: 'yaml is required' };
            await this._ensureJsYamlLoaded();
            const parsed = this._deckParseYaml(yamlText); if (parsed.error) return { error: parsed.error };
            const data = parsed.data;
            const checked = await this._deckCheck(data, 'render_presentation'); if (checked.error) return checked;
            return this._deckSaveChecked(data, String(a.name || (data.deck && data.deck.title) || ''), checked);
        },
        async _deckBeginPresentation(a) {
            await this._ensureJsYamlLoaded();
            let deck = a.deck;
            if (typeof deck === 'string') { const p = this._deckParseYaml(deck); deck = p.error ? null : p.data; }
            if (!deck || typeof deck !== 'object' || !String(deck.title || '').trim()) return { error: 'deck must be the deck settings as a yaml mapping, e.g. "title: X\\nlang: zh-TW\\nspeed: 1.5"' };
            const run = this._deckRun(); const id = 'draft' + (++run.nDrafts);
            run.drafts[id] = { deck, chapters: [], name: String(a.name || deck.title) };
            return { ok: true, draft: id, note: 'now call add_chapters(draft, yaml) one batch of chapters at a time (about 8-12 minutes of content per batch), then finish_presentation(draft)' };
        },
        async _deckAddChapters(a) {
            await this._ensureJsYamlLoaded();
            const run = this._deckRun(); const draft = run.drafts[String(a.draft || '')];
            if (!draft) return { error: 'unknown draft ' + JSON.stringify(a.draft) + ' -- call begin_presentation first' };
            const p = this._deckParseYaml(a.yaml); if (p.error) return { error: p.error };
            const chapters = Array.isArray(p.data) ? p.data : (p.data && p.data.chapters);
            if (!Array.isArray(chapters) || !chapters.length) return { error: 'yaml must be a list of chapters ("- title: ...\\n  slides: [...]") or {chapters: [...]}' };
            const candidate = { deck: draft.deck, chapters };
            const checked = await this._deckCheck(candidate, 'add_chapters'); if (checked.error) return checked;
            draft.chapters.push(...candidate.chapters);
            const all = { deck: draft.deck, chapters: draft.chapters };
            return { ok: true, chapters_so_far: draft.chapters.length, slides_so_far: draft.chapters.reduce((n, c) => n + c.slides.length, 0), minutes_so_far: Math.round(estimateMinutes(all) * 10) / 10, warnings: checked.warnings };
        },
        async _deckFinishPresentation(a) {
            await this._ensureJsYamlLoaded();
            const run = this._deckRun(); const draft = run.drafts[String(a.draft || '')];
            if (!draft) return { error: 'unknown draft ' + JSON.stringify(a.draft) };
            if (!draft.chapters.length) return { error: 'the draft has no chapters yet -- call add_chapters first' };
            const data = { deck: draft.deck, chapters: draft.chapters };
            const checked = await this._deckCheck(data, 'finish_presentation'); if (checked.error) return checked;
            return this._deckSaveChecked(data, draft.name, checked);
        },
        async _deckImportImageBlob(blob, label, tool) {
            if (!blob || !/^image\//.test(blob.type || '')) return { error: 'that is not a picture (' + ((blob && blob.type) || 'unknown type') + ')' };
            if (blob.size > 8 * 1024 * 1024) return { error: 'the picture is larger than 8 MB' };
            const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' })[blob.type] || 'img';
            const id = await this.fileCache.put('deck-image-' + Date.now().toString(36) + '.' + ext, blob.type, blob, 'uploaded');
            const entry = this._deckRun().catalog.add('client-file/' + id, { alt: label, from: tool });
            return { ok: true, ref: entry ? entry.ref : null, url: 'client-file/' + id, source: label };
        },
        _registerDeckTools(registerOptional) {
            const parse = async (raw) => { try { return await this.repairJsonPayload(String(raw || '{}')); } catch (_) { return {}; } };
            const tool = (name, desc, schema, fn) => registerOptional(name, desc, async function (raw) {
                const a = await parse(raw);
                try { const r = await fn.call(this, a); return JSON.stringify(r); } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }); }
            }, schema);
            const obj = (props, req) => ({ type: 'object', properties: props, required: req || [], additionalProperties: false });
            tool('render_presentation',
                'Validate a deck description (YAML, see get_presentation_topic) and save it as the animated presentation, which is then shown to the user as a player. "yaml" is the whole document: {deck: {title, lang}, chapters: [{title, slides: [...]}]}. Pictures must be handles from list_source_images ("@img1") or "client-file/<id>". On success returns {"ok":true,...}. On a validation error it lists every problem with its field path: fix them and call again (you may call it several times).',
                obj({ name: { type: 'string', description: 'Short human-readable name of the presentation.' }, yaml: { type: 'string', description: 'The deck YAML document.' } }, ['name', 'yaml']),
                function (a) { return this._deckRender(a); });
            tool('define_snippet',
                'Store a LONG text for the deck and get a short handle for it, so you never have to put it (and escape it) inside the YAML. kind "widget": the full HTML document of an interactive piece / small game (inline css + js, no network; checked at once). kind "code": a long code listing or log. kind "patch": a git patch / unified diff. Returns a handle: "@w1" (widget), "@c1" (code) or "@p1" (patch) -- ONLY handles returned by this tool exist; never invent one. In the deck yaml write html: "@w1" for a widget visual, code: "@c1" for a code visual; the text replaces the handle when the deck is validated and saved. ALWAYS use this for a widget and for any code longer than ~10 lines.',
                obj({ kind: { type: 'string', enum: ['widget', 'code', 'patch'] }, content: { type: 'string', description: 'The text itself, exactly as it should appear (no yaml, no extra escaping).' } }, ['kind', 'content']),
                function (a) { return this._deckRun().snippets.define(a.kind, a.content); });
            tool('begin_presentation',
                'Start a LONG presentation (more than ~12 minutes / ~25 slides) that you will write in several batches -- all of it stays ONE deck. "deck" = the deck settings as a yaml mapping (title, lang, speed, voice, style, environment). Returns a draft id for add_chapters.',
                obj({ name: { type: 'string' }, deck: { type: 'string', description: 'Deck settings as yaml, e.g. "title: QaRobotZ User Guide\\nlang: zh-TW\\nspeed: 1.5".' } }, ['deck']),
                function (a) { return this._deckBeginPresentation(a); });
            tool('add_chapters',
                'Append a batch of chapters to a draft. "yaml" is a list of chapters ("- title: ...\\n  slides: [...]"; same slide format as render_presentation). The batch is validated at once (field-path errors: fix and call again with the same batch). Keep a batch to about 8-12 minutes of content. Returns how many chapters / slides / minutes the draft has so far.',
                obj({ draft: { type: 'string' }, yaml: { type: 'string', description: 'A list of chapters in yaml.' } }, ['draft', 'yaml']),
                function (a) { return this._deckAddChapters(a); });
            tool('finish_presentation',
                'Assemble every batch of a draft into ONE presentation, validate it as a whole and save it. Returns {"ok":true,...}; the deck is shown to the user as a player.',
                obj({ draft: { type: 'string' } }, ['draft']),
                function (a) { return this._deckFinishPresentation(a); });
            tool('get_presentation_topic',
                'Fetch the exact rules for one part of the deck format: "format" (overall shape, slide fields, transitions), "layout" (which layout to pick, pacing), "visuals" (every visual kind with its fields), "cues" (syncing pictures with narration), "sources" (turning files/folders/websites/screenshots/tables into slides), "interactive" (answer cards with scores, a live terminal, and widgets: small games / simulators you write yourself), "3d" (3D models, cameras) or "style" (writing and house style), "ai_features" (what this AI itself can do). Call "format" and "visuals" before writing your first deck.',
                obj({ topic: { type: 'string', enum: ['format', 'layout', 'visuals', '3d', 'cues', 'interactive', 'ai_features', 'sources', 'style'] } }, ['topic']),
                async function (a) {
                    const topic = String(a.topic || '');
                    const T = (typeof FA_DECK_SRC !== 'undefined' && FA_DECK_SRC.topics) || {};
                    const details = topic === 'ai_features' ? this._deckAiFeaturesText() : T[topic];
                    if (!details) return { error: 'unknown topic ' + JSON.stringify(topic) + ' -- must be one of: ' + Object.keys(T).join(', ') };
                    return { ok: true, topic, details };
                });
            tool('get_presentation_yaml',
                'Fetch the exact yaml of an existing presentation by its file id or url (the "file_id" / "url" of an earlier render_presentation result; default: the latest presentation of this conversation). Call this before changing a presentation made earlier -- edit THAT yaml, never re-write it from memory.',
                obj({ file_id: { type: 'string' } }),
                async function (a) { const key = a.file_id || this._latestDeckUrl; if (!key) return { error: 'no presentation in this conversation yet' }; return { ok: true, yaml: await this._deckReadYaml(key) }; });
            tool('open_existing_presentation',
                'Show a previously saved presentation (a .deck.yaml file made by render_presentation, or one the user uploaded) again as a player. "file_id" = its file id.',
                obj({ file_id: { type: 'string' } }, ['file_id']),
                async function (a) {
                    const text = await this._deckReadYaml(a.file_id); await this._ensureJsYamlLoaded();
                    const doc = window.jsyaml.load(text); const id = String(a.file_id).replace(/^client-file\//, '').replace(/\.deck\.yaml.*$/i, '');
                    return { ok: true, type: 'deck', url: 'client-file/' + id + '.deck.yaml', file_id: id, title: (doc && doc.deck && doc.deck.title) || '' };
                });
            tool('list_source_images',
                'List every picture seen so far in this task (uploaded pictures, screenshots, imported website/folder pictures, charts) as short handles "@img1", "@img2" ... with where each came from and the text around it. Use a handle as a deck image "src". Handles only exist for pictures that really came from a source.',
                obj({}),
                function () { const c = this._deckRun().catalog; return { ok: true, images: c.listing(), note: c.entries.length ? 'use the "ref" as the image src' : 'no pictures seen yet -- read the source first (list_uploaded_files, fap_read_file, import_image_url, import_fap_image)' }; });
            tool('import_image_url',
                'Bring a picture from a web page into the task: downloads the image at this http(s) url (png/jpeg/gif/webp/bmp/svg, up to 8 MB; cross-site addresses may need the asset proxy set in Advance Settings) and stores it. Returns its "@imgN" handle.',
                obj({ url: { type: 'string', description: 'Direct address of the image file.' } }, ['url']),
                async function (a) {
                    const u = String(a.url || '').trim(); if (!/^https?:\/\//i.test(u)) return { error: 'only http/https urls are allowed' };
                    const { resp } = await this._terminalHttpFetch('GET', u, { headers: { Accept: 'image/*' }, timeoutMs: 20000 });
                    if (!resp.ok) return { error: 'the server answered HTTP ' + resp.status };
                    const blob = await resp.blob(); let type = (resp.headers.get('content-type') || blob.type || '').split(';')[0].trim().toLowerCase();
                    return this._deckImportImageBlob(type && blob.type !== type ? new Blob([blob], { type }) : blob, 'web: ' + u.slice(0, 100), 'import_image_url');
                });
            tool('import_fap_image',
                'Bring a picture file from one of the user\'s authorised folders (or an uploaded file / a real path on the desktop) into the task: "ref" = fap:<name>/<path> (see list_file_access_points / fap_find_file). Returns its "@imgN" handle.',
                obj({ ref: { type: 'string' } }, ['ref']),
                async function (a) {
                    const src = await this._resolveTerminalCopySource(String(a.ref || ''));
                    const mime = /^image\//.test(src.mimeType) ? src.mimeType : (({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' })[String(src.filename).split('.').pop().toLowerCase()] || '');
                    return this._deckImportImageBlob(new Blob([src.bytes], { type: mime }), String(src.sourceLabel || src.filename), 'import_fap_image');
                });
            // 領域：內建技能「media-presentation」（BUILTIN_SKILLS）會自動變成 skill_<id> 領域，主助理把簡報工作整個委派過來
            // （子任務有自己的回合數與提示）；這裡只負責工具與 /media-presentation 指令
            this.register_slash_command('/media-presentation', '<要做的簡報：主題、來源、長度、語言…>',
                '做一份動畫簡報（章節、旁白、字幕、轉場；2D＋3D 混合、問答卡、程式碼視窗、終端機、AI 自創小遊戲），在對話裡播放，可匯出 MP4／PPTX／簡報封包。來源可以是上傳的檔案、授權的資料夾、網站，或只給主題。',
                (argsText, run) => (run || this)._deckSlashPresentation(argsText));
            this.register_slash_command('/media-open-presentation', '',
                '開啟之前匯出的簡報封包（.deckpack，或舊的 .deck.zip）：跳出選檔視窗，也可以直接把封包拖進對話或當附件選。作答紀錄與終端機畫面都會還原，不需要原本的素材來源。',
                (argsText, run) => (run || this)._deckPickPack());
        },
        // /media-presentation：直接把整個工作交給簡報領域（跳過主助理自己判斷要不要委派）
        async _deckSlashPresentation(argsText) {
            const text = String(argsText || '').trim();
            this.messages.push({ role: 'user', content: '/media-presentation' + (text ? ' ' + text : '') });
            this._renderMessageHistory();
            if (!text) {
                this._pushAssistantMessage('用法：/media-presentation <要做的簡報>\n例如：\n- /media-presentation BMC 韌體更新流程，5 分鐘，3 章，繁體中文\n- /media-presentation 把我授權的資料夾 fap:專案/docs 裡的設計文件講解成簡報，要有表格和流程圖\n- /media-presentation 做一份 3D 簡報介紹這張主機板（風扇、晶片、LED 的位置）\n- /media-presentation 介紹這個 AI 助理的所有功能，3D 風格\n- /media-presentation 把這個 patch 講解成簡報，最後出幾題選擇題', null);
                this._persistChatHistory(); this._renderMessageHistory();
                return;
            }
            const domainKey = this._deckDomainKey();
            if (!domainKey) {
                this._pushAssistantMessage('⚠️ 找不到內建技能「media-presentation」（可能被停用或刪除）。到 Advance Settings 的技能分頁重新啟用它。', null);
                this._renderMessageHistory(); this._persistChatHistory();
                return;
            }
            const result = await this._delegateToSubagentDomain(domainKey, text);
            this.messages.push(this._buildToolResultMessage('media_presentation', JSON.stringify(result), {}));
            const visibleText = result.ok ? (result.result || result.note || '（簡報已產生）') : '⚠️ 委派給「動畫簡報」失敗：' + result.error;
            this._pushAssistantMessage(visibleText, null);
            this._renderMessageHistory();
            this._persistChatHistory();
        },
        // 內建技能 media-presentation 對應的領域代號（skill_<id>）；技能被停用或刪除時是 null
        _deckDomainKey() {
            const b = (this.advancedSettings.skillBundles || []).find((x) => x.builtinId === 'builtin-skill-media-presentation' && x.enabled !== false);
            return b ? 'skill_' + b.id : null;
        },
        _deckIsDomain(domainKey) { return !!domainKey && domainKey === this._deckDomainKey(); },
        // 這個助理自己的功能清單（讓「介紹這個 AI」的簡報有真實內容）
        _deckAiFeaturesText() {
            const lines = ['Real features of this AI assistant (shipped catalog); slash commands are typed in the chat box, /help lists them all.'];
            try {
                if (this.slashCommands) for (const [cmd, def] of this.slashCommands) lines.push('- ' + cmd + (def.hint ? ' ' + def.hint : '') + (def.desc ? ': ' + String(def.desc).replace(/\s+/g, ' ').slice(0, 200) : ''));
            } catch (_) { /* 沒有就只有這一行 */ }
            return lines.join('\n');
        },
    };
    return { methods, Snippets, ImageCatalog, estimateMinutes, resolveImages, visualNodes, eachSlide, SYSTEM_PROMPT, DOMAIN_TOOLS, STRICT_WARNING, MAX_DECK_MINUTES };
})();
if (typeof module === 'object' && module.exports) module.exports = FaDeckTools;
