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
    const STRICT_WARNING = /an English slide \(lang: en\) has Chinese characters|the narration is mostly English but|mentions the speaking speed|removes and adds the identical line|snippet handle that was never defined|refers to code \/ a patch on an earlier slide|already say the answer|but the slide shows nothing/;

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
                            if ((typeof v[field] !== 'string' || !v[field].trim()) && typeof v.src === 'string' && HANDLE.test(v.src.trim())) { v[field] = v.src.trim(); delete v.src; } // 代號寫在 src：移到它該在的欄位
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


    // ---------------------------------------------------------------- YAML 機械性小錯：自動補引號再重試（不改文字，只加引號與跳脫）
    // 常見的壞法：值裡有「: 」（冒號加空白）、值裡有「 #」（會被當註解）、@c1 這種代號沒加引號、句中引號、缺結尾引號。
    // 只在第一次解析失敗時才用，而且只動「看起來有問題」的那幾行；區塊文字（| 與 >）裡面完全不碰。
    // 這一行（縮排 indent）是哪個 key 底下的清單項目：往上找最近一個「key:」（後面沒有值）的行
    function listParentKey(lines, i, indent) {
        for (let j = i - 1; j >= 0; j--) {
            const l = lines[j]; if (!l.trim() || /^\s*#/.test(l)) continue;
            const ind = l.length - l.replace(/^ +/, '').length;
            if (/^\s*-\s/.test(l) && ind >= indent) continue; // 同一個清單的前一項
            if (ind > indent) continue;
            const m = /^\s*([A-Za-z_][\w-]*):\s*$/.exec(l); return m && ind <= indent ? m[1] : null;
        }
        return null;
    }
    function autoQuoteYaml(text) {
        const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
        const fixed = []; let blockIndent = -1;
        const quote = (v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
        const closesProperly = (v) => { // "…" 開頭，第一個沒跳脫的結尾引號剛好在最後
            let i = 1; while (i < v.length) { if (v[i] === '\\') { i += 2; continue; } if (v[i] === '"') break; i++; }
            return i === v.length - 1;
        };
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]; const indent = line.length - line.replace(/^ +/, '').length;
            if (blockIndent >= 0) { if (line.trim() === '' || indent > blockIndent) continue; blockIndent = -1; }
            if (/^\s*#/.test(line) || !line.trim()) continue;
            const prefix = /^\s*(?:-\s+)*/.exec(line)[0]; let rest = line.slice(prefix.length);
            let key = '';
            // 文字清單（bullets）裡的「說明: 內容」是一句話，不是一組 key: value：整句加引號（不加的話 YAML 會把它讀成物件）
            if (/^\s*-\s/.test(line) && !/^["'\[{]/.test(rest) && /^[^:]{1,40}:(\s|$)/.test(rest) && listParentKey(lines, i, indent) === 'bullets') {
                const whole = rest.replace(/\s+$/, ''); if (whole) { lines[i] = prefix + quote(whole); fixed.push(i + 1); continue; }
            }
            const km = /^([^\s:#"'\[\]{},&*!|>%@`-][^:#"'\[\]{}]*?|"[^"]*"):(\s+|$)/.exec(rest);
            if (km) { key = km[0]; rest = rest.slice(km[0].length); }
            const v = rest.replace(/\s+$/, '');
            if (!v) continue;
            if (/^[|>][-+0-9]*$/.test(v)) { blockIndent = indent; continue; }
            let out = null;
            if (v[0] === '"') { if (!closesProperly(v)) out = (v.length > 1 && v[v.length - 1] === '"' && !/\\$/.test(v.slice(0, -1)) ? '"' + v.slice(1, -1).replace(/(^|[^\\])"/g, '$1\\"') + '"' : (/^"(?:[^"\\]|\\.)*"\s*\S/.test(v) ? quote(v) : v + '"')); }
            else if (v[0] === "'") { if (!(v.length > 1 && v[v.length - 1] === "'")) out = quote(v); }
            else if (v[0] === '[' || v[0] === '{') { const q = v.replace(/([:\[,]\s*)(@[a-z]\d+)(?=\s*[,}\]])/g, '$1"$2"'); if (q !== v) out = q; } // 一行的 { } 與 [ ]：只把沒加引號的 @c1 代號補上引號
            else if (/: |:$| #|^[@`%*&!?]|^- /.test(v)) out = quote(v);
            if (out && out !== v) { lines[i] = prefix + key + out; fixed.push(i + 1); }
        }
        return { text: lines.join('\n'), fixed };
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
            if (/^(map|actor|bust|cg|fx):/.test(s)) return; // a drawn picture (map:village, actor:liu_bei ...): nothing to resolve, the renderer draws it
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
                } else if (v.kind === 'collage') {
                    (Array.isArray(v.items) ? v.items : []).forEach((it, i) => { if (it && typeof it === 'object') { resolveInto(it, 'src', np + '.items[' + i + '].src'); if (it.portrait) resolveInto(it, 'portrait', np + '.items[' + i + '].portrait');
                        // the other pictures of a character: its states (src, frames that are pictures), keys / triggers that swap the picture
                        const pth = np + '.items[' + i + ']';
                        for (const nm of Object.keys(it.states || {})) { const d = it.states[nm]; if (d && typeof d === 'object') { if (d.src) resolveInto(d, 'src', pth + '.states.' + nm + '.src'); const fr = d.frames; (Array.isArray(fr) ? [fr] : (fr && typeof fr === 'object' ? Object.values(fr) : [])).forEach((arr) => { if (Array.isArray(arr)) arr.forEach((e, q) => { if (typeof e === 'string') resolveInto(arr, q, pth + '.states.' + nm + '.frames[' + q + ']'); }); }); } }
                        (it.keys || []).forEach((kf, q) => { if (kf && kf.src) resolveInto(kf, 'src', pth + '.keys[' + q + '].src'); });
                        (it.triggers || []).forEach((tr, q) => { if (tr && tr.src) resolveInto(tr, 'src', pth + '.triggers[' + q + '].src'); }); } });
                } else if (v.kind === 'chart') resolveInto(v, 'src', np + '.src');
                else if (v.kind === 'svg' && String(v.src || '').trim()) resolveInto(v, 'src', np + '.src');
                else if ((v.kind === 'anim2d' || v.kind === 'scene3d') && String(v.ref || '').trim() && !/^client-file\/[\w-]+(\.[\w.-]+)?$/.test(String(v.ref).trim())) problems.push(np + '.ref: must be "client-file/<file_id>" of an uploaded ' + (v.kind === 'anim2d' ? '.2danim.yaml' : '.3dscene.yaml') + ' (or write the scene inline with "' + (v.kind === 'anim2d' ? 'kind: shapes' : 'scene:') + '")');
            });
        });
        return problems;
    }


    // ---------------------------------------------------------------- 存檔前額外拒絕的幾種殘留（在 handle 換成文字之後檢查）
    const isUrlLike = (v) => /^(https?:\/\/|client-file\/|data:)/i.test(String(v || '').trim());
    function deckLeftovers(data) {
        const problems = [];
        if (!data || !Array.isArray(data.chapters)) return problems;
        const codeUse = {};
        eachSlide(data, (slide, path) => {
            visualNodes(slide.visual).forEach((v, k) => {
                const np = path + '.visual' + (k ? '.items[' + (k - 1) + ']' : '');
                if (v.kind === 'code') {
                    if (typeof v.src === 'string' && v.src.trim() && !isUrlLike(v.src)) problems.push(np + '.src: "' + v.src.slice(0, 60) + '" is not a url -- a code visual takes its text in  code: "@c1"  (a handle from define_snippet), not in src');
                    if (typeof v.code === 'string' && v.code.trim().length >= 80) {
                        const key = v.code.trim(), title = String(slide.title || '').trim();
                        (codeUse[key] = codeUse[key] || []).push({ title, path: np });
                    }
                }
                if (v.kind === 'widget') {
                    const html = typeof v.html === 'string' ? v.html.trim() : '';
                    if (!html && typeof v.src === 'string' && v.src.trim() && !isUrlLike(v.src)) problems.push(np + ': a widget needs its full html  html: "@w1"  (define_snippet kind widget first); "' + v.src.slice(0, 60) + '" is only a file name and there is no such file');
                    else if (!html) problems.push(np + '.html: missing -- give the whole game as define_snippet(kind: "widget") and write html: "@w1"');
                }
                if (v.kind === 'image' && typeof v.src === 'string' && /^@[a-z]\d+$/.test(v.src.trim()) && !/^@img\d+$/.test(v.src.trim())) problems.push(np + '.src: "' + v.src.trim() + '" is a code / widget handle, not a picture -- a picture src is "@imgN" from list_source_images');
            });
        });
        Object.keys(codeUse).forEach((key) => {
            const uses = codeUse[key], titles = Array.from(new Set(uses.map((u) => u.title)));
            if (uses.length > 1 && titles.length > 1) problems.push(uses[1].path + ': the same code text is used on "' + titles.slice(0, 3).join('" and "') + '" -- slides on different topics need their own code (show the part that slide is about)');
        });
        // 任何地方還留著 @c1 這種代號（寫在 bullets、旁白、標題裡等）：沒換成文字就是寫錯欄位
        const walk = (node, path) => {
            if (typeof node === 'string') { if (/^@[a-z]\d+$/.test(node.trim()) && !/^@img\d+$/.test(node.trim())) problems.push(path + ': "' + node.trim() + '" is a snippet handle left in the wrong place -- handles only go in  html:  or  code:  of a widget / code visual'); return; }
            if (Array.isArray(node)) { node.forEach((x, i) => walk(x, path + '[' + i + ']')); return; }
            if (node && typeof node === 'object') Object.keys(node).forEach((k) => walk(node[k], path + '.' + k));
        };
        walk(data.chapters, 'chapters');
        return problems.slice(0, 40);
    }

    // ---------------------------------------------------------------- 子任務（領域）的系統提示（外掛 MediaPresentationDesignAgent.system_prompt 的移植）
    const SYSTEM_PROMPT = [
        'You are a focused presentation-design assistant working for another AI assistant. Your only job is to produce a real animated slide deck with render_presentation (or begin_presentation / add_chapters / finish_presentation for a long one) and answer briefly -- never describe slides in prose, and never paste deck yaml into your reply. The finished deck is shown to the user automatically as a player in the chat (you do not embed it).',
        '',
        'ATTACHED FILES ARE THE MATERIAL. When the task text contains "[附件：name（file_id=…）、…]" the user attached those files to THIS request: they are the source, in that order. Do NOT call list_uploaded_files to guess among older uploads, never ask which file, and never make up content when files were attached. Pictures: import_uploaded_image(file_id) for each -> "@imgN", one slide per picture (layout visual, or split with the text beside it) in the attached order. A picture with text on it (English captions, a page of a book, a slide): read it with interpret_image(file_id, "transcribe every word on this picture exactly, keep line breaks") and use THAT text -- never invent what is written. A video (mp4): visual kind video with src "client-file/<file_id>" (see get_presentation_topic("visuals")). A PDF / pptx / document: parse_uploaded_file / pptx_to_deck. Your final answer lists which attached file became which slide and says plainly which could not be used.',
        'CHINESE SUBTITLES UNDER AN ENGLISH VOICE ("中文字幕、英語發音", "字幕用中文，聲音念英文"): ONE slide, narration = the English text that is SPOKEN (voice af_* or deck.lang/slide.lang en), caption = the Chinese subtitle shown on screen (same number of sentences, same order; the viewer sees the Chinese while hearing the English). Do NOT make two slides for this. If you only have Chinese text, write narration in Chinese and set the voice to an English one: the app translates it for the voice and keeps your Chinese as the subtitle (deck.captions: original, the default). Both languages on screen at once (Chinese big, English smaller under it): deck.captions: bilingual (or a list of up to 3 tracks, top to bottom: [zh, en]). Every slide still has ONE spoken language.',
        'LIVELY / CHILDREN\'S TEACHING SLIDES ("活潑", "小朋友", "繪本", a story, characters that talk): use ONE visual of kind collage per slide (get_presentation_topic("visuals") has the format): the pictures pop in as the narration names them ("this is a spider, this is a monkey"), circled (ring), swinging (swing), with a name tag (label) and speech bubbles (say) for dialogue; a story can have scenes (going into the house = camera zoom, or scenes with effect zoom), a character that runs in (keys + bob), story text (texts) and sound effects (sounds / sfx) -- describe the slide like a small game scene: stage, characters, what each does and when, what is said, which sound goes with it. Pictures: cute_picture first, then your own svg drawings; a collage item needs a picture handle. RPG / VISUAL-NOVEL STORY SCENES ("RPG對話", "人物走路", "頭像", a story with a map): the same collage, with DRAWN pictures that need no picture file -- src map:house_interior | map:village | map:peach_orchard (a 16 x 9 tile map, z 0, w 1), actor:<preset> (a walking pixel character; presets liu_bei, guan_yu, zhang_fei, mother, villager_m, villager_f, elder, soldier, child, or any name with a look {skin fair|tan|dark|red, hair black|gray|brown|white, hairStyle topknot|long|short|bun|wild, beard none|short|long|bushy, robe green|red|blue|black|brown|gray|yellow|white, head none|headband|hat}), bust:<preset> (a big half-length portrait for a close-up scene), cg:peach_oath | cg:dusk_hall (a big picture background), fx:petals; place an actor on the map grid with tx, ty (tile 0..15 across, 0..8 down; it stands at the bottom centre of that tile; tw = width in tiles, default 1.3) and make it walk with keys [{at:{sentence:N}, sec:2, tx, ty}] -- it turns toward where it walks and swings its legs by itself, and each step sounds; a line of dialogue is say:[{text, sentence:N, style:box}] on the speaker (style box = an RPG dialogue box with its portrait and name, text typed out, blinking arrow; style subtitle = film subtitles with its name; name: gives the name of the speaker); visual spotlight:true lights the speaker and dims the others; scenes [{scene, at:{sentence:N}, effect:black}] with items scene: <name> change the map by going through black; curtain:[{at, sec, alpha}] is a black curtain (alpha 1 = black) for a fade out at the end. One narration sentence per story beat (a line, a walk, a scene change) -- at:{sentence:N} ties it to the voice. DIALOGUE AND VOICES: a line need not be tied to the narration -- say: [{id: "l1", text, style: box, at: {sentence: 2, edge: end, offset: 0.5}}, {id: "l2", text, at: {line: "l1", edge: end, offset: 0.3}}]: it starts when narration sentence 2 has been read, or after another line (the length comes from the text), and the slide lasts until the last line and walk are done; so the narration can tell a story (or be missing) and then the characters speak with voices of their own: voice: calm | deep | rough | elder | old_woman | young | child | narrator | none (a blip for every character typed; a drawn character has a default voice) or numbers {pitch, wave, jitter, vibrato, noise, len, rate, vol}. Any key, scene or curtain can wait for a line the same way: at: {line: "l2", edge: end, offset: 1}. STATES, FRAMES AND TRIGGERS of a character picture: sheet: {cols, rows, dirs?} makes a sprite sheet (a row for each direction); states: {walk: {frames: [0,1,2,3], fps: 6}, idle: {frames: [1]}, bow: {src: "@img2", sheet: {cols: 3, rows: 1}, frames: [0,1,2,2], fps: 4, loop: false}, wave: {frames: {down: [8,9], up: [12,13]}}, nod: {pose: bow}} (a list of frames = the columns of the row of the direction it faces; facing: false = cell numbers counted row by row; a frame can be a picture handle; pose = a drawn character bows / jumps / shakes / surprises); auto: {moving: walk, still: idle} says which state it is in while it moves / stands; keys: [{at, state: bow, hold: 1.5}, {at, src: "@img9"}] switch the state (hold = seconds, then back) or swap the picture at a time; triggers: [{when: {tile: [11,5]}, state: bow, hold: 1.5}, {when: {near: [10,5], r: 1.2, item: "liu"}, src: "@door_open"}] switch when it (or the picture with that id) stands on a tile / gets near a place -- a door that opens when somebody comes. DEPTH, HEIGHT AND SHADOWS (2.5D): visual depth: y draws the objects of a map (trees, houses, tables) and the pictures on the map grid (tx, ty) in the order of their feet, so a character walking behind a tree is hidden by it and in front of it hides it (without depth: y characters are always on top of the map); tz: <tiles> (also in keys: [{at, sec, tz: 1.5}, {at, sec, tz: 0}] for a jump) lifts a picture above the ground, its shadow stays on the ground and shrinks; shadow: true | false is the soft shadow under a picture (default: on for characters with depth: y or a height); parallax: 0..1 (1 = moves with the world, 0 = stays on the screen when the camera moves: far scenery). PICTURES THE APP MAKES: make_character_sprite (a walking character as pixel art: real, anime or cute style) and make_object_sprite (a tree, house, table...) return handles for tx, ty, tw, pixel: true items; pixel_art draws a small picture from your own palette and rows of letters. The offline recipe plan_rpg_story builds all of this from a story text. For a story or a list of things the app can build the stage by itself (the offline recipe deck_from_story: characters and places found in the text become pictures that pop in, quotes become speech bubbles, running / blowing / knocking become movement and sounds).',
        'TRANSLATION / BILINGUAL REQUESTS ("English voice from the words on the screen, plus a translation text and a translation voice"): one slide is spoken by ONE voice in ONE language, so give every source page TWO slides in a row -- slide A: the page picture, lang: en, narration = the English text read from the picture (translated to natural English only when the picture has none); slide B: the SAME picture again, lang: zh-TW, bullets = the translation as short lines, narration = the Chinese translation read aloud. Say so in the final answer. Keep the order of the pages.',
        'WHAT A DECK IS: chapters of slides in the deck template; every slide has a title, short bullets, a visual (a drawn diagram, a table, a real picture from the source, a flowchart ...) that is always in motion or revealed over time, narration that is read aloud by text-to-speech and shown as a subtitle bar, and a transition into it. The viewer plays it in a window and can export MP4 / PPTX. You write the DESCRIPTION (yaml); the renderer does the layout and animation.',
        '',
        'WORKFLOW',
        '1. Call get_presentation_topic for "format" and "visuals" (once per conversation; also "cues" / "sources" / "style" when needed, and "3d" whenever the subject is a physical thing or the user asks for 3D / a 3D presentation).',
        '2. GATHER THE MATERIAL before writing anything: read the files / pages the request points at with your tools (list_uploaded_files + parse_uploaded_file for uploaded files, fap_read_file / repo_ask for the user\'s folders, the "material" section the main assistant may have attached, text of web pages it read). Read ALL of a long source -- a long article (a wiki page, a news story, a whole novel, a long document) is read by its table of contents: article_outline(url | file_id) lists the sections with their sizes, then article_section(...) reads the ones you need (all of them, one after another, for a deck that covers the whole text) -- never page blindly through it. Then call list_source_images: every picture the sources contain is there as "@img1", "@img2" ... Bring in other pictures with import_fap_image (a picture file in a folder) or import_image_url (a picture on a website).',
        '   TOOLS OF THE APP COME FIRST: when this task\'s prompt also lists tools of the app / website the user is in, the data and pictures that app itself holds (records, charts, analyses, lists) MUST come from those tools -- never open a browser, search the web or guess numbers for something such a tool returns. A tool that returns a picture (a chart) puts its "client-file/<id>" in meta.client_file_url: use that (it is also listed by list_source_images as an "@imgN" handle).',
        '   THE SOURCES THE USER NAMES ARE WHERE TO START, NOT THE LIMIT. If the request names none, or they hold too little, never answer "I found no document / please give me ..." -- that is a failed job. Call get_presentation_topic("ai_features") when the subject is this AI itself, and fill what remains from your own knowledge (see the "sources" topic). A deck from general knowledge is a normal, complete result.',
        '3. DIGEST, do not copy: decide the storyline (chapters -> slides), what each slide\'s one point is, which picture/table/diagram shows it, and what the narration says. Tables in the source become table visuals; screenshots and diagrams become image visuals with callouts at the parts you talk about; processes and relationships you draw yourself as shapes/mermaid with the steps revealed in step with the narration. Use the source\'s real pictures wherever they carry information. Never invent figures, data or real-world pictures (photos, screenshots, charts) that no tool returned -- illustrations the request asks for that you draw yourself are a different thing (see the rule on drawing below); where the sources lack something, explain it from general knowledge (saying it is general) or omit it.',
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
        'MATERIAL THAT LIVES ON ANOTHER MACHINE: when this computer is in a remote group (list_remote_machines) and the data the request is about is not here (nothing in the uploaded files, the folders or this app\'s own tools -- for example a stock website\'s watch list, charts or analyses live on the machine that runs that website), do NOT answer "I have no file". Call list_remote_machines, pick the machine that would hold it, and call delegate_to_machine(task, machine) with a COMPLETE description of what to fetch (the other machine cannot see this conversation): the data as text and the pictures / charts as files. The pictures come back as client-file urls (or @img handles) you can use in image visuals, the texts in "texts". Then build the deck HERE from that material (the voice, the player and the export stay local). The other machine must have "accept sub-task sharing" switched on; if it is refused or no machine fits, say exactly that and what you tried.',
        'LANGUAGE OF THE VOICE: each slide is spoken by ONE voice in ONE language. The deck language (deck.lang, default zh-TW) is the default; a slide that must be spoken in English gets  lang: en  and its narration is written ENTIRELY in English -- translate any Chinese into English (our English voice cannot pronounce Chinese: it spells every character out, "chinese letter chinese letter"). A Chinese slide may contain English terms (product names, units, code); they are read by the Chinese voice. Never put a long English passage into a Chinese slide, never put Chinese words into an English slide; if you cannot write a good English version, keep the slide Chinese. The validator refuses mixed narration. When the user says the whole deck is in Traditional Chinese, every narration is Chinese (English product names stay as names).',
        'SLIDES THAT ARE ONLY A PICTURE OR A CHART (no text, no notes): pptx_to_deck reads them with the vision model and puts the result in outline[].vision = {status: ok | unconfirmed | failed | empty, text}. ok = a vision model really looked at it: write the narration as what the presenter most likely says about it, from that text (numbers and names exactly as read, the point of the chart in 1-3 sentences) and nothing the description does not support. unconfirmed = the description may not come from a vision model: treat it as weak and say so. failed / empty: do NOT invent a talk from the file name -- keep the picture, write a neutral narration only if the title says what it is, and list the slide as "not read". For pictures you imported yourself (a browser screenshot, an attachment) call interpret_image with a specific question (what text, numbers, axes, legend; what it shows; what is unclear) before writing about them. In the final answer always list which slides were written from vision, which from the author\'s own notes, and which could not be read.',
        'LEARNING FROM A MODEL (a .pptx, an earlier deck, or an existing skill such as a weekly-report skill): when the user gives one as the example to follow, READ IT FIRST and imitate its procedure and its shape, never only its look.',
        '1. A .pptx: call pptx_to_deck(file_id) -- it returns the draft yaml, an outline of every slide, the theme colours / fonts and warnings. (extract_pptx_images + interpret_image let you actually look at a slide picture when the outline is not enough.)',
        '2. A skill: skill_list, then skill_read(name) and read the whole SKILL.md and every script / reference it points to. Write down for yourself in 2-3 lines WHAT IT PRODUCES (sections, slide order, which slide has a table / a screenshot / a chart, the tone, the length) and HOW IT GETS ITS DATA (which files or which people\'s reports it reads, which web pages it opens and screenshots, what it counts or compares).',
        '3. Redo the SAME procedure for the NEW inputs with your own tools: uploaded files with parse_uploaded_file, folders with fap_*, web pages with the browser_* tools (browser_status first; browser_screenshot with save: true gives a file id you can use as client-file/<id> in an image visual, with callouts pointing at what changed), the app\'s own tools -- then build the deck with the same structure and the same order of sections as the model.',
        '4. Say honestly which steps you could not reproduce (no browser connected, a script that needs a program you cannot run, a page that needs a login) and what you did instead. Never make up data to fill a slide the model had. In one sentence offer to save the procedure as a reusable skill (the skill-creator does that); do not do it unasked.',
        '- A video the user attached (an mp4 file id) can play inside a slide: visual kind video (play, replay, fast-forward, speed, an A-B loop that repeats one part N times; see get_presentation_topic("visuals")). You cannot hear it: for "watch this, then answer" use a video slide followed by a quiz slide, and take the correct answer from the transcript the user gave you or ask the user -- never invent what is said.',
        '',
        'RULES THAT MATTER',
        '- Length: follow the request ("5 minutes", "3 chapters"); default about 8-12 slides, 25-40 seconds of narration each. Slide 1 is a title slide; the last is a summary. Chapters have 3-6 slides.',
        '- Narration is natural speech in the deck language, short sentences, 2-5 per slide, no markdown/URLs/emoji. Bullets are short fragments that echo the narration, not the narration itself. Make the narration\'s sentences line up with what appears (see cues).',
        '- Every slide with a picture/table/diagram uses layout split or visual; text-only slides are the exception (use them for chapter intros and the summary).',
        '- THE REQUEST IS A CHECKLIST. Before writing the yaml, list for yourself every concrete thing the user asked for (the content, each kind of element, the look: colours / cute / formal, who it is for, how the viewer interacts) and before render_presentation re-read the yaml against that list. Nothing on it may be quietly dropped or replaced by something easier; if a requirement cannot be met, say exactly which one and why in your final answer. The final answer says in one short line how each main requirement was met.',
        '- WHEN THE REQUEST NEEDS PICTURES OR A LOOK ("objects", "cute", "warm colours", "for children", icons, cartoon) and no tool returned real pictures: for everyday things (fruits, animals, sun, house ...) FIRST call cute_picture (no arguments lists them, with correct zhuyin) and use its "@imgN" handles; for anything it does not have, YOU DRAW IT: a visual kind svg (or shapes) with real shapes for each object -- circles, ellipses, rounded rects, paths, a face with two eyes for a cute style, outlines in a darker tone of the fill. A WORD STANDING IN FOR A PICTURE ("Apple" written in grey text, "(picture here)", an empty box) is a failed slide. A big emoji drawn as text inside the svg (font-size 200+) is an acceptable picture when the object is hard to draw (emoji are forbidden only in the narration). Every object looks different and is recognisable on its own. The look the user asked for goes into the visuals: for a warm style give every svg / scene a full background rectangle in a warm colour (#FFF1DC, #FFE0B2) and fill objects from a warm palette (#FFB74D, #FF8A65, #FFD54F, #F48FB1, #A5D6A7); AND set deck.colors (get_presentation_topic "format") to the same warm family so the page frame -- background, titles, bars, subtitle bar -- follows the look too; do this for any look the user names.',
        '- A QUESTION ABOUT A THING ON THE SLIDE: the picture and the question are on the SAME slide (group: picture left, quiz card right), one question per slide, each slide with ITS OWN picture. Ask exactly what the user wanted ("這是什麼?" with the picture shown); the options are real candidates and the right one matches the picture. Never ask the viewer to choose a symbol / word for a picture that is not on the screen, never an answer that is not among the options, never the same picture for different questions. For language-learning decks (注音, ABC, vocabulary) the symbol / letter is shown BIG next to its object, and every fact is checked before you write it: the first sound of the object\'s name must really be that symbol; take the zhuyin of every word from cute_picture, never from memory (蘋果 starts with ㄆ, not ㄅ); when you are not sure of a word, choose one you are sure of.',
        '- Pictures only by handle ("@img3") or "client-file/<id>" from a tool result. A table has <= 8 columns and <= 12 rows per slide: split long tables over several slides or keep the rows that matter and say so.',
        '- If the request is to change a deck made earlier (it mentions a file id / url), call get_presentation_yaml first and edit THAT yaml.',
        '- 2D and 3D mix in one format: a slide can hold a live 3D model (visual kind scene3d with an inline scene; the viewer can orbit and zoom it), with 2D labels/arrows over it (overlay) or a table/image beside it (group); deck.style: 3d (or stage: 3d on single slides) shows it through a viewport on the normal template page, and each 3D slide gets a CAMERA (slide.camera: a preset name, a shot mapping, or a list of shots with focus on a named node of the model and "at" a sentence) -- 3D here means the relation of the camera to the scene and model, not scenery. "A 3D presentation" = deck.style: 3d with a 3D model and camera shots on most slides (read get_presentation_topic("3d")). Do not use 3D for slides that are only text.',
        '- Interactive slides: long code / a log / a patch (more than ~12 lines) goes into a visual kind code (scrollable, syntax-highlighted, patches shown as a diff) instead of bullets or a picture; a shell the viewer can type into is kind terminal; when the user wants Q&A, a quiz, practice or a game, use kind quiz (scored answer cards, static key or AI grading) or kind widget (YOU write a small game / simulator as one self-contained HTML document, e.g. "reach 100 points at breakout"). Read get_presentation_topic("interactive") first: widget html runs in a no-network sandbox and the topic has the exact rules and a working example. The html of a widget and any long code are given with define_snippet (a handle "@w1" / "@c1" goes in the yaml) -- never paste them into the yaml. Every widget needs a "fallback" sentence (what PPTX / video show instead).',
        '  A quiz about code / a patch / a diagram shows that material on the SAME slide (group: code left, quiz right), with exactly one right answer visible on screen and an `explain` that agrees with `answer`; a patch you write is a real unified diff (hunk headers with line ranges, one leading space on context lines).',
        '- NARRATION IS ONLY WHAT THE AUDIENCE SHOULD HEAR. The user\'s instructions to YOU -- speaking speed ("說話速度 1.2 倍", "speak fast"), how long the talk should be, the language, "use a code window", slide numbers, tool / field / function names (deck.done(), kind: widget, wait: true) -- are settings and structure, never sentences of the talk. Speed goes into deck.speed ONLY; never write "說話速度 1.2 倍" or "這段簡報約六分鐘,用 1.2 倍速" into a narration (a narration that mentions the speaking speed is refused). Say what a presenter would say.',
        '- Voice: leave deck.voice out unless the user named one. Speaking speed: when the user asks for a faster or slower voice ("說話速度 1.5 倍", "speak slowly") set deck.speed to that number (0.5-2, default 1); the slides get shorter or longer by themselves, so keep the same text.',
    ].join('\n');

    // 領域登記用的工具名稱（子任務只看得到這些）
    const DOMAIN_TOOLS = ['render_presentation', 'begin_presentation', 'add_chapters', 'finish_presentation', 'define_snippet', 'verify_presentation', 'article_outline', 'article_section', 'get_presentation_topic',
        'get_presentation_yaml', 'open_existing_presentation', 'list_source_images', 'cute_picture', 'make_object_sprite', 'make_character_sprite', 'pixel_art', 'import_uploaded_image', 'import_image_url', 'import_fap_image', 'get_3d_scene_topic',
        'list_uploaded_files', 'parse_uploaded_file', 'summarize_large_text', 'list_file_access_points', 'fap_list_files', 'fap_find_file', 'fap_read_file',
        'repo_ask', 'repo_read_doc',
        // 讀懂 pptx 與其他技能、照著做：pptx 轉草稿、抽圖、看圖、讀技能；要蒐集網頁畫面時用瀏覽器工具（有連線才可用）
        'list_remote_machines', 'delegate_to_machine', 'render_chart', 'pptx_to_deck', 'extract_pptx_images', 'interpret_image', 'skill_list', 'skill_read',
        'browser_status', 'browser_list_tabs', 'browser_create_tab', 'browser_navigate', 'browser_get_page_text', 'browser_get_page_structure', 'browser_screenshot', 'browser_close'];

    // ---------------------------------------------------------------- 內建的可愛插圖（暖色、有臉）：給「兒童教學、可愛風、物件」這類需求用，不必上網找圖（網路圖常是壞連結或灰框）
    // 每項附正確的注音（逐字、聲調），教注音的簡報一定要用這裡的注音，不要憑記憶寫。
    const CUTE = (function () {
        const INK = '#5B3A29';
        const face = (x, y, k) => { k = k || 1; return '<circle cx="' + (x - 15 * k) + '" cy="' + y + '" r="' + 4.5 * k + '" fill="' + INK + '"/><circle cx="' + (x + 15 * k) + '" cy="' + y + '" r="' + 4.5 * k + '" fill="' + INK + '"/><ellipse cx="' + (x - 26 * k) + '" cy="' + (y + 10 * k) + '" rx="' + 7 * k + '" ry="' + 4.5 * k + '" fill="#FF9AA2" opacity=".65"/><ellipse cx="' + (x + 26 * k) + '" cy="' + (y + 10 * k) + '" rx="' + 7 * k + '" ry="' + 4.5 * k + '" fill="#FF9AA2" opacity=".65"/><path d="M' + (x - 8 * k) + ' ' + (y + 7 * k) + ' Q' + x + ' ' + (y + 17 * k) + ' ' + (x + 8 * k) + ' ' + (y + 7 * k) + '" fill="none" stroke="' + INK + '" stroke-width="3" stroke-linecap="round"/>'; };
        const circ = (cx, cy, r, f, s) => '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + f + '"' + (s ? ' stroke="' + s + '" stroke-width="4"' : '') + '/>';
        const ell = (cx, cy, rx, ry, f, s) => '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '" fill="' + f + '"' + (s ? ' stroke="' + s + '" stroke-width="4"' : '') + '/>';
        const path = (d, f, s) => '<path d="' + d + '" fill="' + f + '"' + (s ? ' stroke="' + s + '" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"' : '') + '/>';
        const rect = (x, y, w, h, f, rx, s) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (rx || 0) + '" fill="' + f + '"' + (s ? ' stroke="' + s + '" stroke-width="4"' : '') + '/>';
        const star = (cx, cy, R, r, f, s) => { const p = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? r : R; p.push((cx + q * Math.cos(a)).toFixed(1) + ',' + (cy + q * Math.sin(a)).toFixed(1)); } return '<polygon points="' + p.join(' ') + '" fill="' + f + '"' + (s ? ' stroke="' + s + '" stroke-width="4" stroke-linejoin="round"' : '') + '/>'; };
        const wrap = (body) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="400" height="400"><rect width="200" height="200" rx="28" fill="#FFF4E6"/>' + body + '</svg>';
        const LIST = [
            ['蘋果', 'ㄆㄧㄥˊ ㄍㄨㄛˇ', (() => wrap(path('M100 60 C60 40 28 70 36 118 C44 160 76 176 100 166 C124 176 156 160 164 118 C172 70 140 40 100 60 Z', '#FF6B6B', '#C0392B') + path('M100 60 Q98 40 108 28', 'none', '#7B4B2A') + path('M104 44 Q130 22 146 40 Q124 56 104 44 Z', '#7CC576', '#4E9A4A') + face(100, 112)))],
            ['香蕉', 'ㄒㄧㄤ ㄐㄧㄠ', (() => wrap(path('M44 70 Q50 150 130 168 Q168 172 176 140 Q130 150 96 112 Q70 84 66 52 Q50 50 44 70 Z', '#FFD93D', '#D9A400') + path('M60 50 L68 34 L78 40 L72 56 Z', '#8B6B3A', '#6B4A1A') + face(112, 140, 0.8)))],
            ['草莓', 'ㄘㄠˇ ㄇㄟˊ', (() => wrap(path('M100 52 C50 46 30 90 52 130 C70 164 90 176 100 176 C110 176 130 164 148 130 C170 90 150 46 100 52 Z', '#FF5D73', '#C73650') + path('M70 56 L100 40 L130 56 L112 66 L100 58 L88 66 Z', '#7CC576', '#4E9A4A') + circ(78, 100, 3, '#FFE9A8') + circ(122, 100, 3, '#FFE9A8') + circ(100, 138, 3, '#FFE9A8') + face(100, 112, 0.9)))],
            ['西瓜', 'ㄒㄧ ㄍㄨㄚ', (() => wrap(path('M24 92 A76 76 0 0 0 176 92 Z', '#FF6F7D', '#2E8B57') + path('M24 92 A76 76 0 0 0 176 92 L170 92 A70 70 0 0 1 30 92 Z', '#CFF2B8') + circ(70, 112, 4, INK) + circ(130, 112, 4, INK) + circ(100, 128, 4, INK) + '<path d="M90 100 Q100 110 110 100" fill="none" stroke="' + INK + '" stroke-width="3" stroke-linecap="round"/>'))],
            ['橘子', 'ㄐㄩˊ ㄗˇ', (() => wrap(circ(100, 112, 62, '#FFA53F', '#E0771A') + path('M100 52 Q112 36 128 44 Q116 60 100 52 Z', '#7CC576', '#4E9A4A') + face(100, 112)))],
            ['貓咪', 'ㄇㄠ ㄇㄧ', (() => wrap(path('M52 84 L50 38 L88 64 Z', '#FFB36B', '#C97A2B') + path('M148 84 L150 38 L112 64 Z', '#FFB36B', '#C97A2B') + circ(100, 112, 62, '#FFC98B', '#C97A2B') + face(100, 108) + path('M92 128 L108 128 L100 136 Z', '#FF8FA3') + '<path d="M40 112 L68 116 M40 128 L68 124 M160 112 L132 116 M160 128 L132 124" stroke="' + INK + '" stroke-width="2.5" stroke-linecap="round"/>'))],
            ['小狗', 'ㄒㄧㄠˇ ㄍㄡˇ', (() => wrap(ell(48, 96, 20, 40, '#C98B5A', '#8A5A33') + ell(152, 96, 20, 40, '#C98B5A', '#8A5A33') + circ(100, 108, 58, '#F2C79A', '#B9824F') + ell(100, 132, 24, 18, '#FFF4E6', '#B9824F') + circ(100, 124, 6, INK) + face(100, 100)))],
            ['小魚', 'ㄒㄧㄠˇ ㄩˊ', (() => wrap(ell(92, 104, 58, 40, '#FF9F5A', '#D9701F') + path('M146 104 L182 76 L182 132 Z', '#FFB878', '#D9701F') + circ(70, 94, 6, '#fff', INK) + circ(70, 94, 2.5, INK) + '<path d="M60 116 Q72 126 84 116" fill="none" stroke="' + INK + '" stroke-width="3" stroke-linecap="round"/>' + circ(110, 96, 8, '#FFC48A') + circ(112, 116, 7, '#FFC48A')))],
            ['兔子', 'ㄊㄨˋ ㄗˇ', (() => wrap(ell(76, 44, 14, 38, '#FFF', '#C9B8A8') + ell(124, 44, 14, 38, '#FFF', '#C9B8A8') + ell(76, 48, 6, 24, '#FFB6C1') + ell(124, 48, 6, 24, '#FFB6C1') + circ(100, 116, 54, '#FFFFFF', '#C9B8A8') + face(100, 112) + circ(100, 128, 4, '#FF8FA3')))],
            ['小鴨', 'ㄒㄧㄠˇ ㄧㄚ', (() => wrap(ell(100, 134, 52, 36, '#FFE066', '#D9A400') + circ(100, 84, 38, '#FFE066', '#D9A400') + path('M120 88 Q148 88 148 98 Q134 108 118 100 Z', '#FF9F43', '#D9701F') + circ(88, 78, 5, INK) + ell(76, 94, 7, 4.5, '#FF9AA2')))],
            ['太陽', 'ㄊㄞˋ ㄧㄤˊ', (() => wrap((() => { let r = ''; for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; r += '<line x1="' + (100 + 58 * Math.cos(a)).toFixed(1) + '" y1="' + (100 + 58 * Math.sin(a)).toFixed(1) + '" x2="' + (100 + 80 * Math.cos(a)).toFixed(1) + '" y2="' + (100 + 80 * Math.sin(a)).toFixed(1) + '" stroke="#FFB300" stroke-width="8" stroke-linecap="round"/>'; } return r; })() + circ(100, 100, 46, '#FFD54F', '#F5A700') + face(100, 98)))],
            ['月亮', 'ㄩㄝˋ ㄌㄧㄤˋ', (() => wrap(path('M128 34 A66 66 0 1 0 166 128 A54 54 0 0 1 128 34 Z', '#FFE08A', '#E0B030') + circ(88, 112, 4.5, INK) + '<path d="M80 128 Q92 138 104 130" fill="none" stroke="' + INK + '" stroke-width="3" stroke-linecap="round"/>' + ell(74, 124, 7, 4.5, '#FF9AA2') + star(160, 54, 10, 4.5, '#FFE08A')))],
            ['星星', 'ㄒㄧㄥ ㄒㄧㄥ', (() => wrap(star(100, 104, 72, 34, '#FFD54F', '#E0A800') + face(100, 106, 0.8)))],
            ['花', 'ㄏㄨㄚ', (() => wrap(rect(95, 112, 10, 66, '#7CC576', 4) + path('M100 150 Q70 150 66 126 Q92 126 100 150 Z', '#7CC576') + (() => { let r = ''; for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; r += circ((100 + 30 * Math.cos(a)).toFixed(1), (92 + 30 * Math.sin(a)).toFixed(1), 20, '#FF9AA2', '#E06A78'); } return r; })() + circ(100, 92, 20, '#FFD54F', '#E0A800') + '<circle cx="94" cy="90" r="2.5" fill="' + INK + '"/><circle cx="106" cy="90" r="2.5" fill="' + INK + '"/><path d="M95 98 Q100 103 105 98" fill="none" stroke="' + INK + '" stroke-width="2.5" stroke-linecap="round"/>'))],
            ['房子', 'ㄈㄤˊ ㄗˇ', (() => wrap(rect(46, 92, 108, 80, '#FFD9A0', 6, '#C98B3A') + path('M32 98 L100 40 L168 98 Z', '#FF8A65', '#C0583A') + rect(86, 122, 28, 50, '#A8714A', 4, '#7B4B2A') + rect(56, 108, 24, 22, '#BDE7FF', 3, '#6BA5C9') + rect(124, 108, 24, 22, '#BDE7FF', 3, '#6BA5C9') + circ(108, 148, 2.5, '#FFE08A')))],
            ['汽車', 'ㄑㄧˋ ㄔㄜ', (() => wrap(path('M26 120 L40 92 Q44 84 54 84 L134 84 Q146 84 152 96 L174 120 Q182 124 182 134 L182 144 L26 144 Z', '#FF7A6B', '#C0483A') + path('M52 92 L132 92 L148 116 L46 116 Z', '#BDE7FF', '#6BA5C9') + circ(62, 148, 18, '#5B3A29') + circ(62, 148, 8, '#E8D5C4') + circ(146, 148, 18, '#5B3A29') + circ(146, 148, 8, '#E8D5C4') + circ(174, 128, 5, '#FFE08A')))],
            ['球', 'ㄑㄧㄡˊ', (() => wrap(circ(100, 104, 64, '#FF8A65', '#C0583A') + '<path d="M40 84 Q100 120 160 84 M44 140 Q100 98 156 140 M100 40 L100 168" fill="none" stroke="#FFF4E6" stroke-width="5"/>' + star(150, 46, 9, 4, '#FFD54F')))],
            ['杯子', 'ㄅㄟ ㄗˇ', (() => wrap(path('M52 64 L148 64 L138 160 Q137 172 126 172 L74 172 Q63 172 62 160 Z', '#FFD9A0', '#C98B3A') + path('M146 84 Q184 84 180 116 Q176 142 140 140', 'none', '#C98B3A') + rect(58, 64, 84, 14, '#FF8A65', 6) + face(100, 120, 0.85)))],
            ['書', 'ㄕㄨ', (() => wrap(path('M30 52 Q70 40 100 58 Q130 40 170 52 L170 156 Q130 144 100 162 Q70 144 30 156 Z', '#FFE0B2', '#C98B3A') + '<path d="M100 58 L100 162" stroke="#C98B3A" stroke-width="4"/><path d="M44 76 Q70 70 88 80 M44 96 Q70 90 88 100 M112 80 Q130 70 156 76 M112 100 Q130 90 156 96" fill="none" stroke="#E8C48A" stroke-width="4" stroke-linecap="round"/>' + circ(70, 130, 3, '#FF8A65')))],
            ['雞蛋', 'ㄐㄧ ㄉㄢˋ', (() => wrap(path('M100 34 C140 34 162 88 162 120 C162 156 134 176 100 176 C66 176 38 156 38 120 C38 88 60 34 100 34 Z', '#FFFBF2', '#D8C9B0') + face(100, 118)))],
        ];
        const byName = {}; LIST.forEach((x) => { byName[x[0]] = x; });
        return {
            names: LIST.map((x) => x[0]),
            catalog: () => LIST.map((x) => ({ name: x[0], zhuyin: x[1], first_sound: x[1].charAt(0) })),
            find: (n) => { n = String(n || '').trim(); const x = byName[n] || LIST.find((y) => y[0].indexOf(n) >= 0 || n.indexOf(y[0]) >= 0); return x ? { name: x[0], zhuyin: x[1], svg: x[2]() } : null; },
        };
    })();

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
                const af = autoQuoteYaml(text);
                if (af.fixed.length) { try { const data = window.jsyaml.load(af.text); if (data && typeof data === 'object') return { data, fixes: af.fixed }; } catch (_) { /* 補了引號還是不行：照原本的錯誤回報 */ } }
                return { error: 'yaml could not be parsed: ' + String(e && e.message || e) + '\nHint: a long text (a widget\'s html, code) inside a yaml string is the usual cause -- give it to define_snippet and write the handle (html: "@w1" / code: "@c1"); keep strings short, put a string with a colon or quote in double quotes, indent with spaces only.' };
            }
        },
        // 驗證一份簡報文件（格式、圖片 handle、內嵌場景、總長度）。會就地修改 data（handle 換成真值）。-> {error} 或 {warnings, minutes}
        async _deckCheck(data, toolName) {
            await this._deckEnsureRuntime();
            const Core = window.AiChatDeckCore, run = this._deckRun();
            const expand = run.snippets.expand(data).concat(deckLeftovers(data));
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
        // 對已存好的簡報重跑同一套檢查，並看引用的檔案（client-file/…）還在不在
        async _deckVerify(a) {
            const key = a.file_id || this._latestDeckUrl; if (!key) return { error: 'no presentation in this conversation yet -- give the file_id' };
            await this._ensureJsYamlLoaded();
            let text; try { text = await this._deckReadYaml(key); } catch (e) { return { error: 'cannot read that presentation: ' + String((e && e.message) || e) }; }
            const parsed = this._deckParseYaml(text); if (parsed.error) return { error: parsed.error };
            const data = parsed.data;
            const refs = new Set(); const seen = (n) => { if (typeof n === 'string') { const re = /client-file\/([\w-]+)/g; let m; while ((m = re.exec(n))) refs.add(m[1]); } else if (Array.isArray(n)) n.forEach(seen); else if (n && typeof n === 'object') Object.keys(n).forEach((k) => seen(n[k])); };
            seen(data && data.chapters);
            const self = String(key).replace(/^client-file\//, '').replace(/\.deck\.yaml.*$/i, '');
            const missing = []; for (const id of refs) { if (id === self) continue; let rec = null; try { rec = await this.fileCache.get(id); } catch (_) { /* 當作不見了 */ } if (!rec) missing.push('client-file/' + id); }
            const checked = await this._deckCheck(data, 'verify_presentation');
            const problems = []; if (checked.error) problems.push(checked.error);
            if (missing.length) problems.push('files the presentation uses that no longer exist: ' + missing.slice(0, 20).join(', ') + ' -- re-import them and fix the slides, or the player shows blanks');
            if (problems.length) return { ok: false, problems, missing_files: missing };
            return { ok: true, slides: data.chapters.reduce((n, c) => n + (c.slides || []).length, 0), minutes: Math.round(checked.minutes * 10) / 10, files_checked: refs.size, warnings: checked.warnings };
        },
        _deckNoteFixes(checked, parsed) {
            if (parsed && parsed.fixes && parsed.fixes.length) { checked.warnings = (checked.warnings || []).concat('yaml: the text had small quoting mistakes; quotes were added automatically on line(s) ' + parsed.fixes.slice(0, 12).join(', ') + ' (the words were not changed). Put a text that contains ": " or " #" or starts with @ in double quotes next time.'); }
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
            this._deckNoteFixes(checked, parsed);
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
            this._deckNoteFixes(checked, p);
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
        async _deckImportImageBlob(blob, label, tool, opt) {
            if (!blob || !/^image\//.test(blob.type || '')) return { error: 'that is not a picture (' + ((blob && blob.type) || 'unknown type') + ')' };
            if (blob.size > 8 * 1024 * 1024) return { error: 'the picture is larger than 8 MB' };
            if (blob.size < 1000 && blob.type !== 'image/svg+xml' && !(opt && opt.tiny)) return { error: 'that picture is only ' + blob.size + ' bytes: it is a broken / removed-image placeholder (a site that says the image no longer exists, a 1-pixel image), not a real picture. Do not use it. Use cute_picture for everyday things, or draw the thing yourself as a visual kind svg.' };
            const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' })[blob.type] || 'img';
            const id = await this.fileCache.put('deck-image-' + Date.now().toString(36) + '.' + ext, blob.type, blob, 'uploaded');
            const entry = this._deckRun().catalog.add('client-file/' + id, { alt: label, from: tool });
            return { ok: true, ref: entry ? entry.ref : null, url: 'client-file/' + id, source: label };
        },
        // 只有圖片／圖表的投影片：真的用視覺模型去讀（走 _visionDescribe：線上視覺模型、離線模型的優先順序與備援，跟 interpret_image 同一條路），
        // 並如實回報有沒有讀成功（status: ok｜unconfirmed｜failed｜empty）——讀不到就是讀不到，不能讓模型用檔名編一段話
        async _pptxShrinkToDataUrl(blob, maxSide) {
            const bmp = await createImageBitmap(blob), k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k)); const g = c.getContext('2d'); g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
            try { bmp.close(); } catch (_) { /* */ } return c.toDataURL('image/jpeg', 0.88);
        },
        async _pptxVision(blob, title) {
            try {
                const dataUrl = await this._pptxShrinkToDataUrl(blob, 1600);
                const prompt = '這是一頁簡報' + (title ? '（標題：「' + title + '」）' : '') + '，整頁只有這張圖，可能是圖表、截圖或表格。請：1) 逐項照抄圖上讀得到的所有文字、數字、座標軸、圖例與單位；2) 說明它在呈現什麼（資料、趨勢、比較、結論）；3) 明確列出看不清楚或不確定的地方，不要用猜的補。用繁體中文回答。';
                const r = await this._visionDescribe({ images: [dataUrl], prompt, runLlm: () => this._interpretImageWithVisionModel(dataUrl, prompt) });
                if (!r || !r.ok) return { status: 'failed', error: String((r && r.error) || '視覺模型沒有回應').slice(0, 200) };
                const text = String(r.backend === 'llm' ? (r.llm && r.llm.description) : r.text || '').trim(), confirmed = r.backend === 'llm' ? !!(r.llm && r.llm.visionConfirmed) : false;
                return { status: !text ? 'empty' : confirmed ? 'ok' : 'unconfirmed', backend: r.backend, vision_confirmed: confirmed, text: text.slice(0, 3000) };
            } catch (e) { return { status: 'failed', error: String((e && e.message) || e).slice(0, 200) }; }
        },
        // pptx 的原生圖表：從圖表檔（ppt/charts/chartN.xml）讀出類型、標題、類別與各系列的數值
        _pptxChartData(doc) {
            const tag = (el, n) => Array.from(el.getElementsByTagName(n));
            const plot = tag(doc, 'c:plotArea')[0]; if (!plot) return null;
            const KINDS = { 'c:barChart': 'bar', 'c:bar3DChart': 'bar', 'c:lineChart': 'line', 'c:line3DChart': 'line', 'c:pieChart': 'pie', 'c:pie3DChart': 'pie', 'c:doughnutChart': 'pie', 'c:areaChart': 'area', 'c:area3DChart': 'area', 'c:scatterChart': 'scatter', 'c:radarChart': 'radar', 'c:bubbleChart': 'bubble' };
            let node = null, type = ''; for (const k of Object.keys(KINDS)) { const e = tag(plot, k)[0]; if (e) { node = e; type = KINDS[k]; break; } }
            if (!node) return null;
            const pts = (el) => { const out = []; if (!el) return out; for (const pt of tag(el, 'c:pt')) { const i = Number(pt.getAttribute('idx')), v = pt.getElementsByTagName('c:v')[0]; out[i] = v ? v.textContent : ''; } return out; };
            const series = tag(node, 'c:ser').map((s, i) => {
                const tx = tag(s, 'c:tx')[0], nm = tx && tag(tx, 'c:v')[0], cat = tag(s, 'c:cat')[0] || tag(s, 'c:xVal')[0], val = tag(s, 'c:val')[0] || tag(s, 'c:yVal')[0];
                return { name: (nm && nm.textContent) || ('系列 ' + (i + 1)), cats: pts(cat), vals: pts(val).map((v) => (v === undefined || v === '' ? null : Number(v))) };
            });
            if (!series.length || !series.some((s) => s.vals.some((v) => v != null && isFinite(v)))) return null;
            const cats = (series[0].cats.length ? series[0].cats : series[0].vals).map((c, i) => (series[0].cats.length ? (c == null ? '' : String(c)) : String(i + 1)));
            const dir = tag(node, 'c:barDir')[0], grp = tag(node, 'c:grouping')[0], chartEl = tag(doc, 'c:chart')[0];
            const tEl = chartEl && Array.from(chartEl.children).find((e) => e.nodeName === 'c:title');
            return { type, horizontal: !!dir && dir.getAttribute('val') === 'bar', grouping: grp ? grp.getAttribute('val') : 'clustered', title: tEl ? tag(tEl, 'a:t').map((t) => t.textContent).join('') : '', cats, series: series.map((s) => ({ name: s.name, vals: s.vals })) };
        },
        // 圖表資料畫成 SVG（長條、折線、面積、圓餅；其他類型回空字串，由呼叫端改成資料表）
        _chartSvg(ch, pal) {
            if (!['bar', 'line', 'area', 'pie'].includes(ch.type)) return '';
            const W = 960, H = 540, F = ' font-family="Microsoft JhengHei,Noto Sans CJK TC,sans-serif"';
            const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), col = (i) => pal[i % pal.length];
            const fmt = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100));
            const nice = (max) => { if (max <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(max))), f = max / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
            let g = '<rect width="' + W + '" height="' + H + '" fill="#FFFFFF"/>'; const top = ch.title ? 58 : 26;
            if (ch.title) g += '<text x="' + (W / 2) + '" y="38" text-anchor="middle" font-size="26" font-weight="bold" fill="#222"' + F + '>' + esc(ch.title) + '</text>';
            const S = ch.series, N = ch.cats.length;
            if (ch.type === 'pie') {
                const vals = S[0].vals.map((v) => Math.max(0, v || 0)), sum = vals.reduce((a, b) => a + b, 0) || 1, cx = 300, cy = top + (H - top - 20) / 2, r = Math.min(190, (H - top - 40) / 2); let a0 = -Math.PI / 2;
                vals.forEach((v, i) => { const a1 = a0 + (v / sum) * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0, x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
                    if (v > 0) { g += vals.filter((q) => q > 0).length === 1 ? '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + col(i) + '"/>' : '<path d="M' + cx + ',' + cy + ' L' + x0.toFixed(1) + ',' + y0.toFixed(1) + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(1) + ',' + y1.toFixed(1) + ' Z" fill="' + col(i) + '" stroke="#fff" stroke-width="2"/>';
                        if (v / sum > 0.04) { const am = (a0 + a1) / 2; g += '<text x="' + (cx + r * 0.65 * Math.cos(am)).toFixed(1) + '" y="' + (cy + r * 0.65 * Math.sin(am) + 6).toFixed(1) + '" text-anchor="middle" font-size="18" font-weight="bold" fill="#fff"' + F + '>' + Math.round(v / sum * 100) + '%</text>'; } }
                    a0 = a1; });
                ch.cats.slice(0, 14).forEach((c, i) => { const y = top + 20 + i * 30; g += '<rect x="560" y="' + (y - 14) + '" width="18" height="18" fill="' + col(i) + '"/><text x="588" y="' + y + '" font-size="18" fill="#333"' + F + '>' + esc(String(c).slice(0, 18)) + '（' + fmt(vals[i] || 0) + '）</text>'; });
                return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + g + '</svg>';
            }
            const stacked = ch.type === 'bar' && /stacked/i.test(ch.grouping), legend = S.length > 1, x0 = ch.type === 'bar' && ch.horizontal ? 160 : 96, x1 = W - 50, y0 = top + 8, y1 = H - (legend ? 82 : 52);
            let lo = 0, hi = 0;
            if (stacked) { for (let i = 0; i < N; i++) { let pos = 0, neg = 0; S.forEach((s) => { const v = s.vals[i] || 0; if (v >= 0) pos += v; else neg += v; }); hi = Math.max(hi, pos); lo = Math.min(lo, neg); } }
            else S.forEach((s) => s.vals.forEach((v) => { if (v != null && isFinite(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); } }));
            const step = nice((hi - lo) / 5 || 1); hi = Math.ceil(hi / step) * step; lo = Math.floor(lo / step) * step; if (hi === lo) hi = lo + step;
            const horiz = ch.type === 'bar' && ch.horizontal, vx = (v) => x0 + (v - lo) / (hi - lo) * (x1 - x0), vy = (v) => y1 - (v - lo) / (hi - lo) * (y1 - y0);
            const gw = horiz ? (y1 - y0) / N : (x1 - x0) / N, fs = N > 10 ? 12 : 16;
            for (let t = lo; t <= hi + step / 2; t += step) {
                if (horiz) g += '<line x1="' + vx(t) + '" y1="' + y0 + '" x2="' + vx(t) + '" y2="' + y1 + '" stroke="#DDD"/><text x="' + vx(t) + '" y="' + (y1 + 22) + '" text-anchor="middle" font-size="14" fill="#555"' + F + '>' + fmt(t) + '</text>';
                else g += '<line x1="' + x0 + '" y1="' + vy(t) + '" x2="' + x1 + '" y2="' + vy(t) + '" stroke="#DDD"/><text x="' + (x0 - 8) + '" y="' + (vy(t) + 5) + '" text-anchor="end" font-size="14" fill="#555"' + F + '>' + fmt(t) + '</text>';
            }
            ch.cats.forEach((c, i) => { const label = esc(String(c).slice(0, horiz ? 10 : 12)); if (horiz) g += '<text x="' + (x0 - 8) + '" y="' + (y0 + gw * (i + 0.5) + 5) + '" text-anchor="end" font-size="' + fs + '" fill="#333"' + F + '>' + label + '</text>'; else { const cx = x0 + gw * (i + 0.5), cy = y1 + 24; g += N > 10 ? '<text transform="translate(' + cx + ',' + cy + ') rotate(-35)" text-anchor="end" font-size="' + fs + '" fill="#333"' + F + '>' + label + '</text>' : '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" font-size="' + fs + '" fill="#333"' + F + '>' + label + '</text>'; } });
            if (ch.type === 'bar') {
                const base = Math.max(lo, Math.min(0, hi)), bw = stacked ? gw * 0.6 : gw * 0.72 / S.length;
                for (let i = 0; i < N; i++) { let pos = 0, neg = 0; S.forEach((s, si) => { const v = s.vals[i]; if (v == null || !isFinite(v)) return; let a, b;
                    if (stacked) { if (v >= 0) { a = pos; b = pos + v; pos = b; } else { a = neg; b = neg + v; neg = b; } } else { a = base; b = v; }
                    const off = stacked ? gw * 0.2 : gw * 0.14 + si * bw;
                    if (horiz) g += '<rect x="' + Math.min(vx(a), vx(b)).toFixed(1) + '" y="' + (y0 + gw * i + off).toFixed(1) + '" width="' + Math.abs(vx(b) - vx(a)).toFixed(1) + '" height="' + bw.toFixed(1) + '" fill="' + col(si) + '"/>';
                    else g += '<rect x="' + (x0 + gw * i + off).toFixed(1) + '" y="' + Math.min(vy(a), vy(b)).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.abs(vy(b) - vy(a)).toFixed(1) + '" fill="' + col(si) + '"/>';
                    if (!stacked && N * S.length <= 24) g += horiz ? '<text x="' + (vx(b) + 6).toFixed(1) + '" y="' + (y0 + gw * i + off + bw / 2 + 5).toFixed(1) + '" font-size="14" fill="#333"' + F + '>' + fmt(v) + '</text>' : '<text x="' + (x0 + gw * i + off + bw / 2).toFixed(1) + '" y="' + (vy(b) - 6).toFixed(1) + '" text-anchor="middle" font-size="14" fill="#333"' + F + '>' + fmt(v) + '</text>'; }); }
            } else {
                S.forEach((s, si) => { const p = s.vals.map((v, i) => (v == null || !isFinite(v) ? null : [x0 + gw * (i + 0.5), vy(v)])).filter(Boolean); if (!p.length) return;
                    if (ch.type === 'area') g += '<polygon points="' + p.map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).concat([p[p.length - 1][0].toFixed(1) + ',' + vy(Math.max(lo, 0)).toFixed(1), p[0][0].toFixed(1) + ',' + vy(Math.max(lo, 0)).toFixed(1)]).join(' ') + '" fill="' + col(si) + '" fill-opacity="0.45"/>';
                    g += '<polyline points="' + p.map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ') + '" fill="none" stroke="' + col(si) + '" stroke-width="4"/>';
                    p.forEach((q, k) => { g += '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="5" fill="' + col(si) + '"/>'; if (N * S.length <= 24) g += '<text x="' + q[0].toFixed(1) + '" y="' + (q[1] - 12).toFixed(1) + '" text-anchor="middle" font-size="14" fill="#333"' + F + '>' + fmt(s.vals.filter((v, i) => v != null && isFinite(v))[k]) + '</text>'; }); });
            }
            g += '<line x1="' + x0 + '" y1="' + y1 + '" x2="' + x1 + '" y2="' + y1 + '" stroke="#888"/>';
            if (legend) S.slice(0, 8).forEach((s, i) => { const lx = x0 + i * Math.min(170, (x1 - x0) / Math.min(S.length, 8)); g += '<rect x="' + lx + '" y="' + (H - 36) + '" width="16" height="16" fill="' + col(i) + '"/><text x="' + (lx + 22) + '" y="' + (H - 23) + '" font-size="15" fill="#333"' + F + '>' + esc(String(s.name).slice(0, 12)) + '</text>'; });
            return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' + g + '</svg>';
        },
        // ---------------------------------------------------------------- 讀懂 pptx：把 pptx 轉成簡報草稿（deck YAML）與結構摘要
        // 讀順序、章節（pptx 的「節」）、每頁標題／內文／表格／圖片／內嵌影片、講者備忘稿，並回報主題色與字型，讓模型照著原來的結構與風格重做。
        async _pptxToDeck(record, opts) {
            opts = opts || {};
            await this._ensureJSZipLoaded(); await this._ensureJsYamlLoaded();
            let zip; try { zip = await JSZip.loadAsync(record.blob); } catch (e) { return { ok: false, error: '這個檔案不是有效的 pptx（讀不開 zip：' + String((e && e.message) || e).slice(0, 80) + '）' }; }
            const warnings = [];
            const rd = async (p) => { const f = zip.file(p); return f ? f.async('string') : null; };
            const parse = (s) => new DOMParser().parseFromString(s, 'application/xml');
            const tag = (el, name) => Array.from(el.getElementsByTagName(name));
            const relsOf = async (part) => {
                const i = part.lastIndexOf('/'), x = await rd(part.slice(0, i) + '/_rels/' + part.slice(i + 1) + '.rels'), m = {}; if (!x) return m;
                for (const r of tag(parse(x), 'Relationship')) m[r.getAttribute('Id')] = { type: r.getAttribute('Type') || '', target: r.getAttribute('Target') || '' };
                return m;
            };
            const resolve = (part, target) => { if (target.startsWith('/')) return target.slice(1); const parts = part.slice(0, part.lastIndexOf('/')).split('/'); for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.' && seg !== '') parts.push(seg); } return parts.join('/'); };
            const presXml = await rd('ppt/presentation.xml'); if (!presXml) return { ok: false, error: '不是有效的 pptx（找不到 ppt/presentation.xml）' };
            const pres = parse(presXml), presRels = await relsOf('ppt/presentation.xml');
            const sldIds = tag(pres, 'p:sldId').map((e) => ({ id: e.getAttribute('id'), rid: e.getAttribute('r:id') }));
            const sectionOf = {}; for (const sec of tag(pres, 'p14:section')) for (const s of tag(sec, 'p14:sldId')) sectionOf[s.getAttribute('id')] = sec.getAttribute('name');
            const describe = opts.describe_images !== false; let visionLeft = Math.max(0, Math.min(30, Number(opts.vision_limit) || 12)); const visionJobs = [];
            const max = Math.max(1, Math.min(150, Number(opts.max_slides) || 150)), mode = ['notes', 'bullets', 'none'].includes(opts.narration) ? opts.narration : 'notes';
            const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }, VID = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg' };
            const paraText = (p) => tag(p, 'a:t').map((t) => t.textContent).join('').replace(/\s+/g, ' ').trim();
            const paras = (sp) => tag(sp, 'a:p').map((p) => ({ t: paraText(p) })).filter((p) => p.t).map((p) => p.t);
            const slides = [], outline = []; let imgCount = 0, vidCount = 0, chartCount = 0, chartDone = 0, noteCount = 0;
            const PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#264478', '#9E480E'];
            { const tx0 = await rd('ppt/theme/theme1.xml'); if (tx0) { const td0 = parse(tx0), acc = []; for (const c of ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']) { const e = tag(td0, 'a:' + c)[0], v = e && e.getElementsByTagName('a:srgbClr')[0]; if (v && v.getAttribute('val')) acc.push('#' + v.getAttribute('val')); } if (acc.length >= 3) PALETTE.splice(0, acc.length, ...acc); } }
            const base = String(record.filename || 'slides').replace(/\.pptx$/i, '');
            for (let si = 0; si < sldIds.length && slides.length < max; si++) {
                const rel = presRels[sldIds[si].rid]; if (!rel) continue; const part = resolve('ppt/presentation.xml', rel.target), xml = await rd(part); if (!xml) continue;
                const sx = parse(xml), rels = await relsOf(part), n = si + 1;
                const title = [], subtitle = [], body = [], other = [];
                for (const sp of tag(sx, 'p:sp')) {
                    const ph = tag(sp, 'p:ph')[0], type = ph ? (ph.getAttribute('type') || 'body') : '', ps = paras(sp); if (!ps.length) continue;
                    if (type === 'title' || type === 'ctrTitle') title.push(...ps); else if (type === 'subTitle') subtitle.push(...ps); else if (/^(sldNum|dt|ftr|hdr)$/.test(type)) continue; else if (type) body.push(...ps); else other.push(...ps);
                }
                const tables = tag(sx, 'a:tbl').map((tbl) => tag(tbl, 'a:tr').map((tr) => tag(tr, 'a:tc').map((tc) => paras(tc).join(' '))));
                const pics = [], vids = [];
                for (const pic of tag(sx, 'p:pic')) {
                    const v = tag(pic, 'a:videoFile')[0], b = tag(pic, 'a:blip')[0];
                    if (v && rels[v.getAttribute('r:link')]) vids.push(resolve(part, rels[v.getAttribute('r:link')].target));
                    else if (b && rels[b.getAttribute('r:embed')]) pics.push(resolve(part, rels[b.getAttribute('r:embed')].target));
                }
                const chartTags = tag(sx, 'c:chart').length, charts = []; chartCount += chartTags;
                for (const cr of Object.values(rels).filter((r) => /\/chart$/.test(r.type))) { const cx = await rd(resolve(part, cr.target)); if (cx) { const cd = this._pptxChartData(parse(cx)); if (cd) charts.push(cd); } }
                let notes = ''; const nrel = Object.values(rels).find((r) => /\/notesSlide$/.test(r.type));
                if (nrel) { const nx = await rd(resolve(part, nrel.target)); if (nx) { const nd = parse(nx); notes = tag(nd, 'p:sp').filter((sp) => { const ph = tag(sp, 'p:ph')[0]; return ph && ph.getAttribute('type') === 'body'; }).map((sp) => paras(sp).join(' ')).join(' ').trim(); } }
                if (notes) noteCount++;
                let layoutName = ''; const lrel = Object.values(rels).find((r) => /\/slideLayout$/.test(r.type));
                if (lrel) { const lx = await rd(resolve(part, lrel.target)); if (lx) { const m = /<p:cSld[^>]*\sname="([^"]*)"/.exec(lx); layoutName = m ? m[1] : ''; } }
                const sl = { title: (title.join(' ') || body.shift() || other.shift() || '（無標題 ' + n + '）').slice(0, 120) };
                const bullets = body.concat(other).map((t) => t.slice(0, 220));
                let moreBullets = [], tableMore = [], tableHead = null;
                let kind = 'text', visual = null, picBlob = null;
                if (vids.length) {
                    const p = vids[0], ext = (p.split('.').pop() || '').toLowerCase(), entry = zip.file(p);
                    if (entry && VID[ext]) { const blob = new Blob([await entry.async('uint8array')], { type: VID[ext] }), id = await this.fileCache.put(base + '_slide' + n + '.' + ext, VID[ext], blob, 'uploaded'); visual = { kind: 'video', src: 'client-file/' + id, title: sl.title.slice(0, 60), fallback: '第 ' + n + ' 頁的內嵌影片' }; kind = 'video'; vidCount++; }
                    else warnings.push('第 ' + n + ' 頁的影片「' + p + '」不能用（' + (entry ? '格式 .' + ext + ' 不支援' : '檔案不在 pptx 裡，可能是連結到外部檔案') + '）');
                }
                if (!visual && tables.length) {
                    const t = tables[0].filter((r) => r.length); if (t.length) {
                        let head = t[0], rows = t.slice(1); if (head.length > 8) { warnings.push('第 ' + n + ' 頁的表格超過 8 欄，只留前 8 欄'); head = head.slice(0, 8); rows = rows.map((r) => r.slice(0, 8)); }
                        const clean = (rs) => rs.map((r) => head.map((_, i) => String(r[i] || '').slice(0, 120)));
                        if (rows.length > 12) { tableMore = clean(rows.slice(12)); rows = rows.slice(0, 12); }
                        visual = { kind: 'table', header: head.map((c) => c.slice(0, 120)), rows: clean(rows) }; kind = 'table'; tableHead = visual.header;
                    }
                }
                if (!visual && charts.length) {
                    const ch = charts[0], svg = this._chartSvg(ch, PALETTE);
                    if (svg) { visual = { kind: 'svg', svg }; kind = 'chart'; chartDone++; }
                    else if (ch.cats.length && ch.series.length && ch.cats.length <= 12 && ch.series.length <= 7) {
                        visual = { kind: 'table', header: [ch.title || '圖表資料'].concat(ch.series.map((s) => s.name)).map((c) => String(c).slice(0, 60)), rows: ch.cats.map((c, i) => [String(c).slice(0, 60)].concat(ch.series.map((s) => String(s.vals[i] == null ? '' : s.vals[i])))) }; kind = 'table'; chartDone++;
                        warnings.push('第 ' + n + ' 頁的圖表類型「' + ch.type + '」畫不出來，改成資料表');
                    }
                    if (charts.length > 1) warnings.push('第 ' + n + ' 頁有 ' + charts.length + ' 個圖表，只匯入第一個');
                }
                if (!visual && pics.length) {
                    const refs = [];
                    for (const p of pics.slice(0, 8)) {
                        const ext = (p.split('.').pop() || '').toLowerCase(), entry = zip.file(p);
                        if (!entry || !IMG[ext]) { warnings.push('第 ' + n + ' 頁的圖片 ' + p.split('/').pop() + ' 沒有匯入（' + (entry ? '格式 .' + ext + ' 不支援，例如 emf／wmf' : '檔案不存在') + '）'); continue; }
                        const pb = new Blob([await entry.async('uint8array')], { type: IMG[ext] }); if (!picBlob && ext !== 'svg') picBlob = pb;
                        const r = await this._deckImportImageBlob(pb, 'pptx: ' + record.filename + ' 第 ' + n + ' 頁', 'pptx_to_deck');
                        if (r && r.ok) { refs.push(r.ref || r.url); imgCount++; } else warnings.push('第 ' + n + ' 頁的圖片沒有匯入：' + ((r && r.error) || ''));
                    }
                    if (refs.length) { visual = refs.length === 1 ? { kind: 'image', src: refs[0] } : { kind: 'image', images: refs.map((src) => ({ src })) }; kind = 'picture'; }
                }
                if (chartTags > charts.length) warnings.push('第 ' + n + ' 頁有 ' + (chartTags - charts.length) + ' 個圖表讀不出資料（可能是嵌入的 Excel 物件或不支援的圖表類型）');
                if (!visual && kind === 'text' && !bullets.length && !subtitle.length) kind = 'heading';
                if (si === 0 && !visual && (subtitle.length || bullets.length <= 2)) { sl.layout = 'title'; const subs = subtitle.concat(bullets).slice(0, 2); if (subs.length) sl.subtitle = subs.join(' ').slice(0, 200); bullets.length = 0; }
                else if (kind === 'heading') sl.layout = 'topic';
                if (subtitle.length && sl.layout !== 'title') bullets.unshift(subtitle.join(' ').slice(0, 220));
                if (bullets.length > 6 && sl.layout !== 'title') moreBullets = bullets.splice(6);
                if (bullets.length && sl.layout !== 'title') sl.bullets = bullets.slice();
                if (visual) sl.visual = visual;
                if (mode === 'notes' && notes) sl.narration = notes.slice(0, 1200); else if (mode === 'bullets' && sl.bullets) sl.narration = sl.bullets.join('。').slice(0, 1200) + '。';
                if (notes && mode !== 'notes') sl.notes = notes.slice(0, 1200);
                let vision = null;
                if (describe && picBlob && kind === 'picture' && !sl.bullets && !notes && sl.layout !== 'title') {
                    if (visionLeft > 0) {
                        visionLeft--; vision = { status: 'pending' }; visionJobs.push({ vision, blob: picBlob, title: sl.title, n });
                    } else vision = { status: 'skipped', note: '超過 vision_limit，沒有讀；需要的話對這頁的圖片用 interpret_image' };
                }
                const sec = sectionOf[sldIds[si].id] || '', baseTitle = sl.title;
                if (tableMore.length) { const parts = Math.ceil(tableMore.length / 12); sl.title = baseTitle.slice(0, 100) + ' (1/' + (parts + 1) + ')'; warnings.push('第 ' + n + ' 頁的表格有 ' + (tableMore.length + 12) + ' 列，分成 ' + (parts + 1) + ' 頁'); }
                slides.push({ section: sec, sl });
                for (let k = 0; k * 12 < tableMore.length; k++) slides.push({ section: sec, sl: { title: baseTitle.slice(0, 100) + ' (' + (k + 2) + '/' + (Math.ceil(tableMore.length / 12) + 1) + ')', visual: { kind: 'table', header: tableHead, rows: tableMore.slice(k * 12, k * 12 + 12) } } });
                if (moreBullets.length) { warnings.push('第 ' + n + ' 頁有 ' + (moreBullets.length + 6) + ' 條內文，超過 6 條的分成續頁'); for (let k = 0; k < moreBullets.length; k += 6) slides.push({ section: sec, sl: { title: baseTitle.slice(0, 100) + '（續）', bullets: moreBullets.slice(k, k + 6) } }); }
                outline.push({ n, title: sl.title, layout_in_pptx: layoutName, imported_as: sl.layout || (visual ? visual.kind : 'content'), bullets: (sl.bullets || []).length, notes: !!notes, pictures: pics.length, tables: tables.length, video: vids.length, charts: charts.length, image_only: !!vision, vision: vision || undefined });
            }
            // 看圖很慢（每張十幾到幾十秒）：同時最多 3 張一起讀
            for (let i = 0; i < visionJobs.length; i += 3) {
                await Promise.all(visionJobs.slice(i, i + 3).map(async (j) => {
                    Object.assign(j.vision, await this._pptxVision(j.blob, j.title));
                    if (j.vision.status !== 'ok') warnings.push('第 ' + j.n + ' 頁只有圖片：' + (j.vision.status === 'failed' ? '看圖失敗（' + j.vision.error + '）' : j.vision.status === 'unconfirmed' ? '讀圖結果無法確認是視覺模型看的（可能不準）' : '讀圖沒有內容') + '，請當作「沒讀到」處理，不要編內容');
                }));
            }
            if (!slides.length) return { ok: false, error: '這個 pptx 裡沒有讀到任何投影片' };
            const chapters = []; let cur = null;
            for (const s of slides) { const name = s.section || ''; if (!cur || (name && name !== cur.title)) { cur = { title: name || String(opts.title || base).slice(0, 80), slides: [] }; chapters.push(cur); } cur.slides.push(s.sl); }
            // 主題色與字型（讓模型知道原本的風格；簡報樣板是全站統一的，這裡只報告不套用）
            const theme = {}; const tx = await rd('ppt/theme/theme1.xml');
            if (tx) { const td = parse(tx); theme.colors = {}; for (const c of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']) { const e = tag(td, 'a:' + c)[0]; const v = e && (e.getElementsByTagName('a:srgbClr')[0] || e.getElementsByTagName('a:sysClr')[0]); if (v) theme.colors[c] = v.getAttribute('val') || v.getAttribute('lastClr'); } const mj = tag(td, 'a:majorFont')[0], mn = tag(td, 'a:minorFont')[0]; theme.fonts = { heading: mj && mj.getElementsByTagName('a:latin')[0] ? mj.getElementsByTagName('a:latin')[0].getAttribute('typeface') : '', body: mn && mn.getElementsByTagName('a:latin')[0] ? mn.getElementsByTagName('a:latin')[0].getAttribute('typeface') : '' }; }
            const doc = { deck: { title: String(opts.title || base).slice(0, 120), lang: opts.lang || 'zh-TW' }, chapters };
            return { ok: true, source: record.filename, slide_count: slides.length, chapter_count: chapters.length, pictures_imported: imgCount, videos_imported: vidCount, charts_imported: chartDone, charts_not_imported: chartCount - chartDone, slides_with_notes: noteCount, narration_from: mode, theme, outline, warnings, yaml: window.jsyaml.dump(doc, { lineWidth: 120, noRefs: true }) };
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
                obj({ kind: { type: 'string', enum: ['widget', 'code', 'patch'] }, content: { type: 'string', description: 'The text itself, exactly as it should appear (no yaml, no extra escaping).' }, snippets: { type: 'array', description: 'Several snippets in ONE call: [{kind, content}, ...] (use this instead of kind / content when the deck has more than one code listing or widget). Every valid one is stored; the result lists each handle in order, and an error for the ones that were refused.', items: { type: 'object', properties: { kind: { type: 'string', enum: ['widget', 'code', 'patch'] }, content: { type: 'string' } }, required: ['kind', 'content'] } } }, []),
                function (a) {
                    const sn = this._deckRun().snippets;
                    if (Array.isArray(a.snippets) && a.snippets.length) {
                        const results = a.snippets.slice(0, 20).map((x, i) => { const r = sn.define(x && x.kind, x && x.content); return r.error ? { index: i, ok: false, error: r.error } : { index: i, ok: true, kind: x.kind, handle: r.handle, chars: r.chars, use: r.use }; });
                        const bad = results.filter((r) => !r.ok);
                        return { ok: bad.length === 0, handles: results.filter((r) => r.ok), errors: bad, note: bad.length ? 'the others are stored; fix only the refused ones and send them again' : undefined };
                    }
                    if (!a.kind) return { error: 'give kind and content, or snippets: [{kind, content}, ...]' };
                    return sn.define(a.kind, a.content);
                });
            tool('begin_presentation',
                'Start a LONG presentation (more than ~12 minutes / ~25 slides) that you will write in several batches -- all of it stays ONE deck. "deck" = the deck settings as a yaml mapping (title, lang, speed, voice, style, environment). Returns a draft id for add_chapters.',
                obj({ name: { type: 'string' }, deck: { type: 'string', description: 'Deck settings as yaml, e.g. "title: Product User Guide\\nlang: zh-TW\\nspeed: 1.5".' } }, ['deck']),
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
                    const run = this._deckRun(); run.topicsGiven = run.topicsGiven || {};
                    if (run.topicsGiven[topic]) { run.topicsGiven[topic]++; return { ok: true, topic, already_given: true, note: 'You already have the "' + topic + '" rules above in this conversation (this is call #' + run.topicsGiven[topic] + '). Use them; do not ask again -- write the deck now.' }; }
                    const T = (typeof FA_DECK_SRC !== 'undefined' && FA_DECK_SRC.topics) || {};
                    const details = topic === 'ai_features' ? this._deckAiFeaturesText() : T[topic];
                    if (!details) return { error: 'unknown topic ' + JSON.stringify(topic) + ' -- must be one of: ' + Object.keys(T).join(', ') };
                    run.topicsGiven[topic] = 1;
                    return { ok: true, topic, details };
                });
            tool('get_presentation_yaml',
                'Fetch the exact yaml of an existing presentation by its file id or url (the "file_id" / "url" of an earlier render_presentation result; default: the latest presentation of this conversation). Call this before changing a presentation made earlier -- edit THAT yaml, never re-write it from memory.',
                obj({ file_id: { type: 'string' } }),
                async function (a) { const key = a.file_id || this._latestDeckUrl; if (!key) return { error: 'no presentation in this conversation yet' }; return { ok: true, yaml: await this._deckReadYaml(key) }; });
            tool('verify_presentation',
                'Re-run every check on a presentation that is already saved (the same rules render_presentation applies) and check that the files it points at (pictures, videos, uploaded scenes) still exist. "file_id" = the presentation\'s file id or url (default: the latest of this conversation). Returns {"ok":true,...} with warnings, or the list of problems with their field paths and the files that are gone.',
                obj({ file_id: { type: 'string' } }),
                async function (a) { return this._deckVerify(a); });
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
            tool('cute_picture',
                'Built-in cute, warm-coloured illustrations of everyday things, each with its CORRECT zhuyin (注音) and Chinese name. USE THESE for children / cute / learning decks instead of searching the web (web pictures are often broken links or grey boxes). Call with no arguments to list what exists ({name, zhuyin, first_sound}); call with name to get the picture: it returns an "@imgN" handle (use it as the image src, e.g. visual {kind: image, src: "@img3"}) plus the zhuyin to teach. Copy the zhuyin exactly as returned -- never write zhuyin from memory. If the thing you need is not in the list, draw it yourself as a visual kind svg.',
                obj({ name: { type: 'string', description: 'The thing, e.g. 蘋果 (omit to list all).' } }),
                async function (a) {
                    if (!a.name) return { ok: true, pictures: CUTE.catalog(), note: 'call cute_picture with a name to get its picture handle' };
                    const f = CUTE.find(a.name); if (!f) return { ok: false, error: 'no built-in picture called ' + JSON.stringify(a.name) + '; available: ' + CUTE.names.join(', ') + '. Draw anything else yourself as an svg visual.' };
                    const r = await this._deckImportImageBlob(new Blob([f.svg], { type: 'image/svg+xml' }), 'cute: ' + f.name, 'cute_picture');
                    return r.error ? r : { ok: true, name: f.name, zhuyin: f.zhuyin, ref: r.ref, url: r.url };
                });
            tool('make_object_sprite',
                'Draw a small PIXEL-ART picture of ONE object for a story scene (tree, pine, house, table, chest, rock, well): the app builds it from 3D shapes, flattens it, and pixelates it (default frame 32x48, house 64x48, 16 colours, dark outline, bottom-centre anchored so it stands on its tile). Returns an "@imgN" handle; put it in a collage item { src: "@imgN", tx, ty, tw, pixel: true } (tw = width in map tiles, about 1.3; a house about 3). Use it when the story needs an object that a drawn map does not have; it is not for people (a person is actor:<preset>). Options: color (tree: green | dark | autumn | pink; chest: brown | blue | red; rock: gray | brown; table: wood | dark | white), wall (house: cream | white | gray | brick), roof (house, well: red | blue | brown | green), scale, frame [w, h], palette (2..64), outline dark | shade | none.  It needs no network and no 3D library.',
                obj({ kind: { type: 'string', enum: ['tree', 'pine', 'house', 'table', 'chest', 'rock', 'well'] }, color: { type: 'string' }, wall: { type: 'string' }, roof: { type: 'string' }, scale: { type: 'number' }, frame: { type: 'array', items: { type: 'integer' } }, palette: { type: 'integer' }, outline: { type: 'string', enum: ['dark', 'shade', 'none'] } }, ['kind']),
                async function (a) { return this._deckMakeObjectSprite(a || {}); });
            tool('make_character_sprite',
                'Make a walking PIXEL-ART character (a sprite sheet: 4 columns of walk frames x 4 rows of directions down, left, right, up; 32x48 each) for a story scene: the app builds a 3D person, photographs it from 4 sides in 4 walk poses, and pixelates them with ONE shared palette. Give a preset (liu_bei, guan_yu, zhang_fei, mother, villager_m, villager_f, elder, soldier, child) or a look {skin fair|tan|dark|red, hair black|gray|brown|white, hairStyle topknot|long|short|bun|wild, beard none|short|long|bushy, robe green|red|blue|black|brown|gray|yellow|white, head none|headband|hat}, and a style: real (realistic proportions, more colours), anime (slim, big eyes, cel-shaded), cute (big head, round eyes, blush; default anime). Returns an "@imgN" handle; use it as a collage item { src: "@imgN", sheet: {cols: 4, rows: 4, dirs: "down,left,right,up", idle: 1}, tx, ty, tw: 1.3, pixel: true, name } -- it turns toward where it walks and swings its legs by itself (keys tx/ty). It needs no network and no 3D library (the app has its own small renderer); actor:<preset> is the picture drawn directly, with no sheet.',
                obj({ preset: { type: 'string' }, look: { type: 'object' }, style: { type: 'string', enum: ['real', 'anime', 'cute'] }, name: { type: 'string' }, frame: { type: 'array', items: { type: 'integer' } }, palette: { type: 'integer' } }),
                async function (a) { return this._deckMakeCharacterSprite(a || {}); });
            tool('pixel_art',
                'Draw a small PIXEL-ART picture (an item, a prop, a tile, an icon) from a description YOU write -- no code. The app checks every field, draws it, and shows you the result back as a text preview (one character per pixel) so you can check it. Fields: palette {"a": "#c0392b", "b": "#2c3e50", ...} (ONE character -> one colour; "." and space are transparent), rows ["..aabb..", ...] (one string per pixel row, each character a palette key; short rows are padded), mirror "x" | "y" | "xy" (rows draw only the left / top half), ops (<= 40, in order after the rows): {op: "rect", x, y, w, h, c, fill?} {op: "line", x1, y1, x2, y2, c} {op: "circle", cx, cy, r, c, fill?} {op: "ellipse", cx, cy, rx, ry, c, fill?} {op: "fill", x, y, c} {op: "dot", x, y, c} {op: "erase", x, y, w, h}, size [w, h] (4..64 each side; default from rows), shade true (automatic light on the top-left edges and shadow on the bottom-right: the pixel-art look), outline true or "#rrggbb" (1-pixel outline). Or give template (heart, sword, potion, coin, key, flower, mushroom, gem, chest) with recolor {"r": "#3366ff"} (palette key -> colour). Returns an "@imgN" handle: use it as a collage item { src: "@imgN", tx, ty, tw, pixel: true } (tw = width in map tiles; a tile is 16 pixels wide). If it reports errors, fix exactly the fields it names and call again.',
                obj({ palette: { type: 'object' }, rows: { type: 'array', items: { type: 'string' } }, mirror: { type: 'string', enum: ['x', 'y', 'xy'] }, ops: { type: 'array', items: { type: 'object' } }, size: { type: 'array', items: { type: 'integer' } }, shade: { type: 'boolean' }, outline: { description: 'true or a colour #rrggbb' }, template: { type: 'string' }, recolor: { type: 'object' }, name: { type: 'string' } }),
                async function (a) { return this._deckMakePixelArt(a || {}); });
            tool('import_uploaded_image',
                'Bring a picture the user attached (or uploaded earlier) into the task: "file_id" = the id in the task text ("[附件：name（file_id=…）]") or from list_uploaded_files. Returns its "@imgN" handle for an image visual. Call it once per attached picture, in the order the user attached them.',
                obj({ file_id: { type: 'string' } }, ['file_id']),
                async function (a) {
                    const id = String(a.file_id || '').replace(/^client-file\//, '').trim(); const rec = id ? await this.fileCache.get(id) : null;
                    if (!rec || !rec.blob) return { ok: false, error: 'no uploaded file with that id (use the file_id written in the task text, or call list_uploaded_files)' };
                    if (!/^image\//.test(rec.mimeType || rec.blob.type || '')) return { ok: false, error: 'that file is not a picture (' + (rec.mimeType || 'unknown type') + '): for a PDF use parse_uploaded_file, for a video use a visual of kind video with src client-file/' + id };
                    return this._deckImportImageBlob(rec.blob.type ? rec.blob : new Blob([rec.blob], { type: rec.mimeType }), 'upload: ' + (rec.filename || id), 'import_uploaded_image');
                });
            tool('import_image_url',
                'Bring a picture from a web page into the task: downloads the image at this http(s) url (png/jpeg/gif/webp/bmp/svg, up to 8 MB; cross-site addresses may need the asset proxy set in Advance Settings) and stores it. Returns its "@imgN" handle.',
                obj({ url: { type: 'string', description: 'Direct address of the image file.' } }, ['url']),
                async function (a) {
                    const u = String(a.url || '').trim(); if (!/^https?:\/\//i.test(u)) return { error: 'only http/https urls are allowed' };
                    if (/placehold|placeholder|dummyimage|fakeimg|lorempixel|picsum\.photos|placekitten|placeimg/i.test(u)) return { error: 'that is a placeholder-picture service (it returns a grey box with the text you gave it), not a real picture. Do not use it: draw the object yourself as a visual kind svg (see the rule on drawing pictures), or use a real picture from a tool / the sources.' };
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
            tool('render_chart',
                'Draw a chart from data and get it as a picture: bar (vertical columns, or horizontal), line, area or pie. Returns the chart (shown to the user) and "url" -- use it in a deck as a visual {kind: chart, src: <url>} (see get_presentation_topic("visuals")). Give "categories" (the x-axis labels, <= 40) and "series" (<= 8 lines of {name, values: [numbers, same length as categories]}); a pie uses the first series only. stacked: true stacks the series of a bar chart; horizontal: true lays a bar chart on its side. Use it for real numbers from the sources (a table, a report, a pptx chart) -- never for made-up data.',
                obj({ type: { type: 'string', enum: ['bar', 'column', 'line', 'area', 'pie'] }, title: { type: 'string' }, categories: { type: 'array', items: { type: 'string' } }, series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] } }, stacked: { type: 'boolean' }, horizontal: { type: 'boolean' }, colors: { type: 'array', items: { type: 'string', description: 'hex colours like #4472C4' } } }, ['type', 'categories', 'series']),
                async function (a) {
                    const cats = Array.isArray(a.categories) ? a.categories.map((c) => String(c)).slice(0, 40) : [], ser = Array.isArray(a.series) ? a.series.slice(0, 8) : [];
                    if (!cats.length) return { ok: false, error: 'categories is required (the labels of the x-axis)' }; if (!ser.length) return { ok: false, error: 'series is required: [{name, values: [...]}]' };
                    const series = ser.map((s, i) => ({ name: String((s && s.name) || ('系列 ' + (i + 1))), vals: cats.map((_, k) => { const v = s && Array.isArray(s.values) ? Number(s.values[k]) : NaN; return isFinite(v) ? v : null; }) }));
                    if (!series.some((s) => s.vals.some((v) => v != null))) return { ok: false, error: 'series[].values must be numbers' };
                    const type = a.type === 'column' ? 'bar' : String(a.type || 'bar'); if (!['bar', 'line', 'area', 'pie'].includes(type)) return { ok: false, error: 'type must be bar, column, line, area or pie' };
                    const pal = (Array.isArray(a.colors) ? a.colors : []).filter((c) => /^#[0-9a-f]{3,8}$/i.test(String(c))).concat(['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#264478', '#9E480E']);
                    const svg = this._chartSvg({ type, horizontal: !!a.horizontal, grouping: a.stacked ? 'stacked' : 'clustered', title: String(a.title || ''), cats, series }, pal);
                    if (!svg) return { ok: false, error: 'could not draw that chart' };
                    const blob = new Blob([svg], { type: 'image/svg+xml' }), id = await this.fileCache.put('chart-' + Date.now().toString(36) + '.svg', 'image/svg+xml', blob, 'generated');
                    return { type: 'drawing', svg, ok: true, url: 'client-file/' + id, file_id: id, note: 'in a deck: visual: {kind: chart, src: "client-file/' + id + '"}' };
                });
            tool('pptx_to_deck',
                'Read a .pptx the user uploaded (file_id from list_uploaded_files) and understand it: returns a draft deck YAML (slide order, sections as chapters, titles, bullets, tables, pictures, embedded videos, speaker notes as narration), an outline of every slide (what it held and how it was imported), the theme colours and fonts, and warnings for what could not be imported (charts, unsupported picture formats, over-long tables). Pictures are imported and referenced by handle. Use it to (a) turn a pptx into a playable deck, or (b) learn the STRUCTURE and STYLE of a model pptx (for example last week\'s report) so the new deck follows it: same sections, same slide order, a table where it had a table, a screenshot where it had a screenshot. Edit the returned yaml as needed and call render_presentation. narration: "notes" (default: speaker notes are spoken), "bullets" (the bullets are read out) or "none" (silent slides).',
                obj({ file_id: { type: 'string', description: 'The uploaded .pptx (file id from list_uploaded_files).' }, narration: { type: 'string', enum: ['notes', 'bullets', 'none'] }, max_slides: { type: 'integer', description: 'Read only the first N slides (default all, at most 150).' }, describe_images: { type: 'boolean', description: 'Read slides that are only a picture / chart with the vision model (default true).' }, vision_limit: { type: 'integer', description: 'At most this many slides are read with vision (default 12, max 30).' }, title: { type: 'string', description: 'Deck title (default: the file name).' }, lang: { type: 'string', description: 'zh-TW (default), en, ...' } }, ['file_id']),
                async function (a) {
                    const rec = await this.fileCache.get(String(a.file_id || '').replace(/^client-file\//, ''));
                    if (!rec || !rec.blob) return { error: 'no uploaded file with that id (call list_uploaded_files)' };
                    if (!/\.pptx$/i.test(rec.filename || '') && !/presentationml/.test(rec.mimeType || '')) return { error: 'that file is not a .pptx (' + (rec.filename || rec.mimeType || 'unknown') + ')' };
                    return this._pptxToDeck(rec, a);
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
    return { methods, Snippets, ImageCatalog, autoQuoteYaml, deckLeftovers, estimateMinutes, resolveImages, visualNodes, eachSlide, SYSTEM_PROMPT, DOMAIN_TOOLS, STRICT_WARNING, MAX_DECK_MINUTES };
})();
if (typeof module === 'object' && module.exports) module.exports = FaDeckTools;
