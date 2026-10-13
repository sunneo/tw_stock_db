/* 「檔案用途」「函式做什麼」的說明產生器（UMD，純函式，不碰 DOM／網路／檔案）。
 * 分工（跟離線食譜同一個思路，DESIGN.project-index.md §17.4／§17.6）：
 *   事實由程式查：離線訓練器（Domain Resolver）的 FaBeh2 用 tree-sitter 語法樹（含組合語言掃描）＋基礎函式語意表，
 *               得到每個函式的註解、行為分類、呼叫了哪些標準函式（附白話語意）、被誰呼叫、複雜度。
 *   措辭交給小模型：把事實用「文字重排＋語意（FaBeh2.rerank／selectWithinBudget，有 _faSemEmbed 時用語意向量）」挑出放得下的幾句，
 *               再附一小段有界的真原始碼（extractSourceSpan）；模型只負責把已有的事實寫成一句話，不要它自己讀整份原始碼。
 *   沒有模型（或模型輸出不可用）時，程式組出來的說明就是最後答案——所以每一種說明都標「來源」：comment／auto／model。
 * beh 參數是 FaBeh2 的對外介面（可省略；省略時退成簡單截句）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaExplain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const BOILER_RE = /^\s*(?:copyright\b|\(c\)\s|spdx-|licen[sc]ed?\b|all rights reserved|permission is hereby granted|redistribution and use|this (?:program|file|software|library) is (?:free software|distributed|licensed|provided|part of)|unless required by applicable law|without warranty|the above copyright notice|(?:auto-?)?generated (?:by|file)|do not edit|this file was (?:auto-?)?generated)/i;
    const isBoilerplate = (t) => BOILER_RE.test(String(t || ''));
    const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const uniq = (a) => Array.from(new Set(a.filter(Boolean)));
    const firstSentences = (beh, text, n, kws) => {
        text = String(text || '').replace(/\s+/g, ' ').trim(); if (!text) return '';
        if (beh && beh.rerank) { try { return beh.rerank(text, kws || [], n); } catch (_) { /* 退成簡單截句 */ } }
        return (text.match(/[^。！？.!?]+[。！？.!?]?/g) || [text]).slice(0, n).join(' ').trim();
    };
    const nameWords = (n) => String(n || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.:]+/g, ' ').toLowerCase().split(/\s+/).filter((w) => w.length > 1);

    // 某個函式那一節的「最上層條列」：FaBeh2 的敘事每一步是一行 "- Opens a file…"（縮排的是參數說明，不要）
    function narrativeBullets(markdown, fnName, max) {
        const md = String(markdown || ''); if (!md) return [];
        const marker = '## `' + fnName + '`'; const i = md.indexOf(marker); if (i < 0) return [];
        const j = md.indexOf('\n## `', i + marker.length); const sec = md.slice(i, j < 0 ? md.length : j); const out = [];
        for (const l of sec.split('\n')) { const m = /^- (.+)$/.exec(l); if (!m) continue; const t = m[1].replace(/`/g, '').trim(); if (/^returns?\b/i.test(t) || /^\(?(?:no|none)\b/i.test(t)) continue; out.push(t); }
        return uniq(out).slice(0, max || 6);
    }

    // fn：FaBeh2 的函式記錄；o：{labels:{類別:標籤}, bullets:[], callers:[], beh, lang}
    function describeFn(fn, o) {
        o = o || {}; const labels = o.labels || {}; const beh = o.beh;
        const cats = Object.keys(fn.behaviors || {}); const catLabels = uniq(cats.map((c) => labels[c] || c));
        const apiCalls = new Set(); for (const c of cats) for (const x of fn.behaviors[c] || []) apiCalls.add(x);
        const own = (fn.all_calls || []).filter((c) => !apiCalls.has(c));
        const bullets = (o.bullets || []).map((b) => clip(b, 110));
        const keywords = uniq(nameWords(fn.name).concat(fn.all_calls || [], catLabels));
        let comment = fn.leading_comment_text ? String(fn.leading_comment_text) : ''; if (isBoilerplate(comment)) comment = '';
        const size = (fn.line_count || (fn.end_line && fn.line ? fn.end_line - fn.line + 1 : 0)) + ' 行' + (fn.complexity ? '，複雜度 ' + fn.complexity : '');
        let note, source;
        if (comment) { note = clip(firstSentences(beh, comment, 2, keywords), 160); source = 'comment'; }
        else {
            const parts = [];
            if (catLabels.length && !(fn.low_level && bullets.length)) parts.push(catLabels.slice(0, 3).join('、'));
            if (bullets.length) parts.push(bullets.slice(0, 3).join(' → '));
            if (own.length) parts.push('呼叫 ' + own.slice(0, 4).join('、'));
            note = '（自動分析）' + (parts.length ? parts.join('；') : '沒有辨識出標準函式呼叫') + '（' + size + '）'; source = 'auto';
        }
        const facts = ['函式名稱：' + fn.name];
        if (comment) facts.push('原始碼註解：' + clip(comment, 300));
        if (catLabels.length) facts.push('行為分類：' + catLabels.join('、'));
        if (bullets.length) facts.push('標準函式的語意：' + bullets.join('；'));
        if (own.length) facts.push('呼叫專案內的函式：' + own.slice(0, 8).join('、'));
        if ((o.callers || []).length) facts.push('被這些函式呼叫：' + o.callers.slice(0, 6).join('、'));
        facts.push('規模：' + size);
        return { name: fn.name, line: fn.line, end_line: fn.end_line, note, source, facts, keywords, cats, labels: catLabels, own, bullets, comment };
    }

    // o：{path, lang, header, fns:[describeFn 結果], importedBy:數字, imports:數字, labels, beh, lines}
    function describeFile(o) {
        o = o || {}; const beh = o.beh; const fns = o.fns || []; const labels = o.labels || {};
        const count = {}; for (const f of fns) for (const c of f.cats || []) count[c] = (count[c] || 0) + 1;
        const top = Object.keys(count).sort((a, b) => count[b] - count[a]).slice(0, 3).map((c) => labels[c] || c);
        const names = fns.slice(0, 6).map((f) => f.name);
        const kws = uniq(nameWords(String(o.path || '').split('/').pop().replace(/\.[^.]+$/, '')).concat(names, top));
        let header = o.header ? String(o.header) : ''; if (isBoilerplate(header)) header = '';
        const bits = [];
        if (o.lang) bits.push(o.lang + ' 檔');
        if (fns.length) bits.push('定義 ' + fns.length + ' 個函式（' + names.join('、') + (fns.length > names.length ? '…' : '') + '）');
        if (top.length) bits.push('主要行為：' + top.join('、'));
        if (o.importedBy) bits.push('被 ' + o.importedBy + ' 個檔案引用');
        let note, source;
        if (header) { note = clip(firstSentences(beh, header, 2, kws), 180); source = 'comment'; }
        else { note = '（自動分析）' + (bits.join('；') || '沒有辨識出可說明的內容'); source = 'auto'; }
        const facts = ['檔案：' + o.path];
        if (header) facts.push('檔頭註解：' + clip(header, 300));
        facts.push(bits.join('；'));
        const withNotes = fns.filter((f) => f.source === 'comment').slice(0, 8).map((f) => f.name + '：' + f.note);
        if (withNotes.length) facts.push('各函式的說明：' + withNotes.join('；'));
        if (o.imports) facts.push('引用了 ' + o.imports + ' 個專案內檔案');
        return { path: o.path, note, source, facts, keywords: kws, top, names };
    }

    // 資料夾：只用子檔案「已經有的說明」，不重新讀檔。o：{path, files:[{name, note, source}], dirs:[名稱], beh}
    // 挑代表性的幾句＝文字重排（FaBeh2.summarizeBlocks：語意向量相似度圖＋PageRank＋多樣性）；沒有 beh 就取有註解來源的前幾個。
    function describeFolder(o) {
        o = o || {}; const beh = o.beh; const files = (o.files || []).filter((f) => f && f.note); const dirs = o.dirs || [];
        const plain = (f) => String(f.note).replace(/^（自動分析）/, '');
        const real = files.filter((f) => f.source !== 'auto'); const pool = real.length ? real : files;
        let picked = [];
        if (pool.length) {
            let idx = null;
            if (beh && beh.summarizeBlocks && pool.length > 3) { try { const r = beh.summarizeBlocks(pool.map(plain), 3); idx = r.summary.map((t) => pool.findIndex((f) => plain(f) === t)).filter((i) => i >= 0); } catch (_) { idx = null; } }
            picked = (idx && idx.length ? idx.map((i) => pool[i]) : pool.slice(0, 3));
        }
        const bits = [files.length + ' 個檔案' + ((o.totalFiles || 0) > files.length ? '有說明（共 ' + o.totalFiles + ' 個）' : ''), dirs.length ? dirs.length + ' 個子資料夾（' + dirs.slice(0, 5).join('、') + (dirs.length > 5 ? '…' : '') + '）' : ''].filter(Boolean);
        const head = picked.map((f) => f.name + '：' + clip(plain(f), 50)).join('；');
        const note = '（自動分析）' + bits.join('；') + (head ? '。代表：' + head : '');
        const facts = ['資料夾：' + o.path, bits.join('；')].concat(picked.map((f) => '檔案 ' + f.name + '：' + clip(plain(f), 120)));
        return { path: o.path, name: String(o.path || '').replace(/\/$/, '').split('/').pop(), note, source: 'auto', facts, keywords: uniq(nameWords(String(o.path || '').replace(/\//g, ' '))) };
    }

    // FaBeh2.explain 的結果 → {file, fns}（主程式與匯出頁共用；r.markdown／r.functions／r.callgraph 都是 FaBeh2 的輸出）
    // o：{path, lang, labels, beh, importedBy, imports}
    function fromBehResult(r, o) {
        o = o || {}; const callers = (r.callgraph && r.callgraph.callers) || {};
        const fns = (r.functions || []).filter((f) => f && f.name && !/^<anonymous/.test(f.name)).map((f) => describeFn(f, { labels: o.labels, bullets: narrativeBullets(r.markdown, f.name, 6), callers: callers[f.name], beh: o.beh }));
        const hm = /^> \*\*原始碼註解\*\*：(.+)$/m.exec(r.markdown || '');
        const file = describeFile({ path: o.path, lang: String((r.meta && r.meta.language) || o.lang || ''), header: hm ? hm[1] : '', fns, importedBy: o.importedBy, imports: o.imports, labels: o.labels, beh: o.beh });
        return { file, fns, lang: String((r.meta && r.meta.language) || o.lang || '') };
    }

    // 簡體專用字（繁體沒有這個字形）：0.6B 模型常常用簡體回答，我們要的是繁體——含這些字的輸出一律不用
    const SIMPLIFIED = new Set(Array.from('这个们为从还对时开关说话过现种与产务条应点据线网图达远运连选级给总该义设实术书买发间问阳阴队项飞鸡鸟龙齿观见贝车长门风么吗让认识读写译动业东临乱习乡亏云亚亲仅仓仪众优伙会伟传伤伦伪体余侠侣侦侧侨俭债倾偿储儿兑党兰关兴养兽册军农冯冲决况冻净凉减凑凤凭凯击刍划刘则刚创删别制剂剑剧办励劲劳势勋勤区医华协单卖卢卫却厂厅历压厌县参双变叙叠只台叶号叹吓后听启员响团园围圆圣场坏块坚坛坝坟坠垫墙壮声壳处备复够头夸夹夺奋奖妇妈娱婴学孙宁宝实宠审宪宫宽宾寻导寿将尔尘尝尽层属岁岂岗岛岭巩币帅师帐带帮帜并库应庙废广庆庐废异弃张弹强归当录彻径恋恒恳恶悬惊惧惨惯愿懒戏战户扑执扩扫扬扰报抢护担拟拥择挂挡挥损换捡据掳搁摄摆撑敌数断旧时昙显晋晒晓暂术机杀杂权条来杨构枪柜标栏树样桥梦检棂楼榄欢欧歼殴毁毕毙气汇汉污汤沟没沥沦泪泽洁洒浅浇测济浑浓涛涡涣涨渐渔温湾溃滚满滞滤滥灭灯灵灾炉点炼烁烂烛烟烦热爱爷牍牵犹狈独狭狮猎猪猫献玛现珐琐电画畅疗疯痒盏盐监盖盘着矫码砖础础确硕硬碍离种积称稳穷窃窍竞笔笋筑签简粮紧纠红约级纪纫纯纲纳纵纷纸纹线练组细织终绍经绑结绕绘给络绝统继绩绪续维综缓编缘缩网罗罚罢羁习翘耸联聪肃肠肤肾胀胜胧脑脚脏脱腊腾舰艰艺节芦苏苹范茧荐荡荣药莱获营萧蒙虑虚虫蚁蛮补装裤见观规视览觉触计订认讨让训议讯记讲许论设访证评识诉词译试诗诚话诞询该详语误说请诸读课谁调谅谈谊谋谍谐谓谢谣谦谨谬贝负贡财责贤败账货质贩贪贫购贯贱贴贵贷贸费贺资赊赋赌赏赔赖赚赛赞赠赢赵趋跃踪车轧轨转轮软轰轻载较辅辆辈辉输辑辖辞边辽达迁迈运还这进远违连迟选递逻遗邓邮邻郑酱释针钉钓钟钢钥钦钱钻铁铃铜银铺链销锁锅锈锋错键锦镇镜长门闪闭问闯间闷闹闻阀阅队阳阴阵阶际陆陈险随隐难雏雾静面韩页顶项顺须顾顿颁颂预领颇频颗题颜额风飘飞饭饮饰饱饼馆馒马驰驱驳驴驶驻驾骂骄骆验骑惊骗体高鱼鲁鲜鸟鸡鸣鸭鸿麦黄黑齐齿龙龟'));
    function hasSimplified(t) { for (const ch of String(t)) if (SIMPLIFIED.has(ch)) return true; return false; }
    const FEWSHOT = [
        { role: 'user', content: '【資料】\n函式名稱：load_file\n行為分類：File I/O\n標準函式的語意：Opens a file as a buffered stream (FILE*)；Reads one line from a stream\n呼叫專案內的函式：check_line\n規模：8 行，複雜度 4\n\n請用繁體中文一句話（不超過60字）說明這個函式做什麼。只能根據【資料】，資料沒有的不要猜，不要只是把名稱翻成中文。直接輸出那一句話。' },
        { role: 'assistant', content: '開啟檔案並逐行讀取，每一行交給 check_line 檢查。' }
    ];

    // 小模型的提示詞。必要事實一定放；選用的（語意條列、各函式說明）用文字重排＋語意挑到放得下為止；原始碼只放有界的一小段。
    // kind：'fn'｜'file'；d：describeFn／describeFile 的結果；o：{span:字串, maxChars, beh}
    function buildMessages(kind, d, o) {
        o = o || {}; const beh = o.beh; const cap = o.maxChars || 1100; const what = kind === 'file' ? '檔案' : kind === 'folder' ? '資料夾' : '函式';
        const must = d.facts.slice(0, kind === 'file' ? 2 : 2); let rest = d.facts.slice(must.length);
        let used = must.join('\n').length; const keep = [];
        if (rest.length) {
            const budget = Math.max(0, cap - used - (o.span ? Math.min(o.span.length, 500) : 0));
            let ordered = rest;
            if (beh && beh.rerank && rest.join('\n').length > budget) {
                const sents = []; for (const f of rest) for (const s of String(f).split(/；/)) { const t = s.trim(); if (t) sents.push(t); }
                let idx = null; try { if (beh.selectWithinBudget) idx = beh.selectWithinBudget(sents, Math.max(8, Math.floor(budget / 6))); } catch (_) { idx = null; }
                ordered = idx && idx.length ? idx.map((i) => sents[i]) : sents;
            }
            for (const f of ordered) { if (used + f.length + 1 > cap && keep.length) break; keep.push(f); used += f.length + 1; }
        }
        const lines = must.concat(keep);
        let user = '【資料】\n' + lines.join('\n');
        if (o.span) user += '\n\n【原始碼片段】\n' + String(o.span).slice(0, 700);
        user += '\n\n請用繁體中文一句話（不超過60字）說明這個' + what + '做什麼。只能根據【資料】' + (o.span ? '與原始碼片段' : '') + '，資料沒有的不要猜，不要只是把名稱翻成中文。直接輸出那一句話。';
        return [{ role: 'system', content: '你是程式碼說明助手。一律使用繁體中文（台灣用語），不要用簡體字。你不會自己編造；事實都在使用者給的資料裡，你只負責把它寫成通順的一句話。' }].concat(FEWSHOT, [{ role: 'user', content: user }]);
    }

    // 模型輸出能不能用：去掉思考標記、取第一句、擋掉空的／太長的／只是複述名稱的／英文照抄的／拒答的
    // 大陸用語 → 台灣用語（字形是繁體、但 0.6B 常帶出簡體語料的詞）
    const MAINLAND = [['返回', '回傳'], ['內存', '記憶體'], ['函數', '函式'], ['堆區', '堆積區'], ['變量', '變數'], ['默認', '預設'], ['字符串', '字串'], ['數組', '陣列'], ['指針', '指標'], ['線程', '執行緒'], ['進程', '行程'], ['信息', '資訊'], ['軟件', '軟體'], ['接口', '介面'], ['調用', '呼叫'], ['文件', '檔案'], ['對象', '物件'], ['參數', '參數'], ['緩存', '快取'], ['代碼', '程式碼']];
    const taiwanize = (t) => { for (const [a, b] of MAINLAND) if (a !== b) t = t.split(a).join(b); return t; };
    // ground：這次給模型的全部資料文字；有給就要求輸出裡的英文識別字都出現在資料裡（擋掉編出來的函式名稱）
    function cleanModelNote(text, name, ground) {
        let t = String(text == null ? '' : text).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s>*\-#"'「『（(]+/, '').trim();
        t = t.split(/\n+/)[0].trim(); const m = /^(.*?[。！？])/.exec(t); if (m && m[1].length >= 8) t = m[1];
        t = t.replace(/^(?:說明|答案|摘要|這個(?:函式|檔案)(?:是)?)[:：]\s*/, '').replace(/["'」』]+$/, '').trim();
        if (t.length < 6 || t.length > 160) return null;
        if (name && t.replace(/[\s。、，,.]/g, '') === String(name).replace(/[\s_]/g, '')) return null;
        const cjk = (t.match(/[㐀-鿿]/g) || []).length; if (cjk < 4) return null;
        if (/(?:無法|沒辦法|不能|抱歉|對不起|資料中沒有|沒有提供)/.test(t) && t.length < 40) return null;
        if (/(.{3,}?)\1{3,}/.test(t)) return null;
        if (hasSimplified(t)) return null;
        t = taiwanize(t);
        if (ground != null) { const g = String(ground).toLowerCase(); for (const id of t.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []) if (g.indexOf(id.toLowerCase()) < 0) return null; }
        return t;
    }

    return { describeFn, describeFile, describeFolder, fromBehResult, narrativeBullets, buildMessages, cleanModelNote, isBoilerplate, hasSimplified, BOILER_RE };
});
