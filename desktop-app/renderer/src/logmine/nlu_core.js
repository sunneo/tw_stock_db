/* 英文句子的離線理解（FaNlu）：詞類標註 → 片語切分 → 用 LALR 文法解析成子句 → 抽出「動作＋對象＋修飾＋引用的程式」框架 → 對上訓練器的意圖。
 * 跟程式語法同一個思路：結構是文法（資料），解析用分析表，解析不了就保留原句、標低信心，不硬猜；文法可以從例句繼續長。
 * 混合內容：FaNlu.understand 先用 FaMix 把輸入切成敘述與各種語言的區段，再把句子裡的「this shader」「the query below」「the error above」對回區段。
 * 純函式（UMD），只做英文；不連網、不呼叫模型。語意只到「做什麼、對什麼」這一層，不做推理。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaNlu = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const LR = (typeof FaLR !== 'undefined' && FaLR) || (typeof self !== 'undefined' && self.FaLR) || (typeof require === 'function' ? require('./lr_core.js') : null);
    const MIX = (typeof FaMix !== 'undefined' && FaMix) || (typeof self !== 'undefined' && self.FaMix) || (typeof require === 'function' ? require('./mix_core.js') : null);
    const S = (s) => new Set(String(s).split(/\s+/).filter(Boolean));

    // ---------- 詞表（通用知識，封閉類別很小；動詞與名詞只放常見的，其餘靠後綴與前後文）----------
    const DET = S('the a an this that these those my your our their its his her some any each every no all both another such');
    const PREP = S('of in on at for from with by about into over under after before between through during without within onto upon via per than like against among across behind beyond near inside outside above below');
    const PRON = S('i you he she it we they me him us them myself yourself itself themselves who whom one something anything nothing everything someone anyone everyone nobody somebody');
    const NUMW = S('one two three four five six seven eight nine ten eleven twelve twenty thirty hundred thousand first second third');
    const PARTICLE = S('up down off on out over away back in');
    const CONJ = S('and or but nor so yet because although if while when unless since whereas');
    const AUX = S('is are was were be been being am do does did have has had will would shall should can could may might must');
    const MODAL = S('can could would should will shall may might must');
    const WH = S('what why how when where which who whose whether');
    const ADV = S('also then please just still only really very quickly slowly again now already always never often maybe probably actually simply basically currently recently ago too even once twice here there then');
    const ADJ = S('smoother faster slower better worse bigger smaller clearer cleaner simpler shorter longer higher lower easier harder cheaper valid new old broken slow fast wrong right correct invalid empty missing blank black white red green blue unused duplicate local remote default simple large small big long short same different multiple single first last next previous current latest main weird strange random unexpected extra full free real useful clean dirty ready stuck blocked open closed public private fragment vertex mobile native legacy older newer better worse best worst little much many few more less most least own other');
    const NOUN = S('code error bug issue problem function method class object file folder directory path config configuration setting settings option options shader texture canvas page template script server client database query table row column index key value variable parameter argument module package library dependency version test tests build deploy deployment log logs output input response request endpoint api service job task cache memory cpu gpu performance speed time thing way part example case result result results list array string number type name id user users data text image video audio model prompt message command terminal shell process thread task branch commit patch diff repo repository project app application site website browser frame render rendering color colors pixel pixels vertex fragment uniform buffer program stack trace exception crash failure warning link button form field header footer style stylesheet markup tag element event handler hook plugin extension feature requirement spec design document doc docs readme report summary reason cause step steps point line lines word words sentence report email account password token session cookie store storage disk network port host address url domain site report manifest schema migration record entry item items group set map graph tree node edge');
    const VERB = S('bump pin tweak patch learn study unzip undo validate migrate decorate bundle forget remember wait expect allow prevent avoid ensure support expire name label tag pipe plot chart reduce cache index queue batch lock mirror sync poll stream drop retry center align hide resize stretch style scale rotate animate position wrap add remove delete create make build run execute start stop restart fix repair debug solve resolve troubleshoot explain describe show list display print find search look check test verify validate compile convert transform translate port migrate update upgrade install uninstall deploy configure set change rename move copy open read write save load parse format generate render draw optimize refactor review summarize analyze compare merge split sort filter count calculate compute help tell give get take use call return throw handle catch log trace monitor scan fetch download upload send receive connect disconnect enable disable apply revert undo redo commit push pull clone import export mock wrap extract replace insert append trim clean clear reset kill terminate schedule measure profile benchmark understand know see want need try make let keep put turn go come work fail break crash hang freeze load read pass reproduce rewrite simplify document comment describe improve speed investigate figure diagnose tune inspect');
    const IRREG = { ran: 'run', made: 'make', got: 'get', wrote: 'write', broke: 'break', built: 'build', found: 'find', took: 'take', gave: 'give', saw: 'see', went: 'go', came: 'come', kept: 'keep', put: 'put', left: 'leave', thought: 'think', told: 'tell', sent: 'send', lost: 'lose', chose: 'choose', began: 'begin', began: 'begin', did: 'do', done: 'do', has: 'have', had: 'have', is: 'be', are: 'be', was: 'be', were: 'be', am: 'be', been: 'be', being: 'be', does: 'do', better: 'good', worse: 'bad' };
    // 這些詞可以當動詞也可以當名詞：看前後文決定
    const AMBI = S('test build run log list show set display print format check change update use call return load read write start stop open close save copy move count sort filter map reset look trace work fix issue');
    const WANT = S('want need like wish hope try trying plan going wanna gonna');

    // 動詞的同義群（意圖比對用）：同一群算同一種動作
    const SYN = [
        ['show', 'display', 'list', 'print', 'view', 'see', 'output', 'give', 'tell'], ['fix', 'repair', 'debug', 'solve', 'resolve', 'troubleshoot', 'diagnose', 'investigate', 'figure'], ['explain', 'describe', 'summarize', 'understand', 'document', 'what', 'why', 'know'],
        ['convert', 'transform', 'translate', 'port', 'migrate', 'rewrite', 'turn', 'change'], ['find', 'search', 'locate', 'look', 'check', 'inspect'], ['create', 'make', 'build', 'generate', 'write', 'add', 'draw', 'render'], ['delete', 'remove', 'drop', 'clear', 'kill', 'terminate'],
        ['run', 'execute', 'start', 'launch', 'restart'], ['test', 'verify', 'validate', 'check', 'reproduce'], ['optimize', 'improve', 'speed', 'tune', 'refactor', 'simplify', 'clean', 'profile', 'benchmark'], ['compare', 'diff', 'merge'], ['install', 'setup', 'configure', 'deploy', 'set', 'enable', 'disable'],
        ['read', 'open', 'load', 'parse', 'fetch', 'download', 'import'], ['save', 'export', 'upload', 'send', 'push', 'commit'], ['review', 'analyze', 'measure', 'scan', 'monitor', 'trace', 'log'],
    ];
    const SYN_OF = new Map(); SYN.forEach((g, i) => g.forEach((w) => { if (!SYN_OF.has(w)) SYN_OF.set(w, []); SYN_OF.get(w).push(i); }));

    // 名詞 → 這種東西最可能是哪些語言的區段（用來把「this shader」對回程式區段）
    const NOUN_LANG = { shader: ['glsl'], fragment: ['glsl'], vertex: ['glsl'], texture: ['glsl'], glsl: ['glsl'], webgl: ['glsl', 'javascript'], function: ['javascript', 'python', 'php', 'glsl', 'shell', 'sql'], method: ['javascript', 'python', 'php'], class: ['python', 'php', 'javascript'], script: ['javascript', 'python', 'shell', 'php'], code: ['javascript', 'python', 'php', 'glsl', 'shell', 'sql', 'css', 'html'], snippet: ['javascript', 'python', 'php', 'glsl', 'shell', 'sql'], program: ['python', 'javascript', 'php', 'glsl'], helper: ['python', 'javascript', 'php'], config: ['toml', 'ini', 'yaml', 'json'], configuration: ['toml', 'ini', 'yaml', 'json'], settings: ['toml', 'ini', 'yaml', 'json'], setting: ['toml', 'ini', 'yaml', 'json'], manifest: ['toml', 'yaml', 'json'], file: ['toml', 'ini', 'yaml', 'json', 'python', 'javascript', 'php'], query: ['sql'], sql: ['sql'], table: ['sql'], page: ['html', 'php'], template: ['html', 'php'], markup: ['html'], html: ['html'], style: ['css'], stylesheet: ['css'], css: ['css'], command: ['shell'], terminal: ['shell'], error: ['trace'], trace: ['trace'], exception: ['trace'], log: ['trace'], output: ['trace'], crash: ['trace'], python: ['python'], php: ['php'], javascript: ['javascript'], json: ['json'], yaml: ['yaml'], toml: ['toml'], ini: ['ini'], shell: ['shell'], bash: ['shell'] };

    // ---------- 斷詞與詞類 ----------
    function splitSentences(text) {
        const out = []; const paras = String(text).split(/\n{2,}|\n(?=[-*•]\s)/); for (const para of paras) { const flat = para.replace(/\n/g, ' ').trim(); if (!flat) continue; let cur = ''; const toks = flat.split(/(?<=[.!?])\s+(?=[A-Z"'`(])/); for (const t of toks) { cur = t.trim(); if (cur) out.push(cur); } }
        return out;
    }
    function lex(sentence) {
        const toks = []; const re = /`[^`\n]+`|https?:\/\/\S+|(?:[A-Za-z]:)?(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+|\$[A-Za-z_]\w*|[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)+(?:\(\))?|[a-z]+(?:[A-Z][a-z0-9]+)+|[a-z]+(?:_[a-z0-9]+)+|[A-Za-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?|[^\sA-Za-z\d]/g; let m;
        while ((m = re.exec(sentence))) { const w = m[0]; let kind = 'word'; if (/^`/.test(w)) kind = 'code'; else if (/^https?:/.test(w)) kind = 'url'; else if (/\//.test(w) && /[\w.-]\/[\w.-]/.test(w)) kind = 'path'; else if (/^\$/.test(w) || /[A-Za-z_]\w*\.[A-Za-z_]/.test(w) || /^[a-z]+([A-Z][a-z0-9]+)+$/.test(w) || /^[a-z]+(_[a-z0-9]+)+$/.test(w)) kind = 'ident'; else if (/^\d/.test(w)) kind = 'num'; else if (/^[^\w\s]$/.test(w)) kind = 'punct'; toks.push({ w: kind === 'code' ? w.slice(1, -1) : w, raw: w, lower: w.toLowerCase(), kind, s: m.index, e: m.index + w.length }); }
        // 縮寫：don't → do + not
        const CT = { "can't": 'can', "won't": 'will', "shan't": 'shall', "cannot": 'can' }; const out = []; for (const t of toks) { if (CT[t.lower] && t.kind === 'word') { out.push(Object.assign({}, t, { w: CT[t.lower], lower: CT[t.lower] })); out.push(Object.assign({}, t, { w: 'not', lower: 'not' })); continue; } const m2 = /^(.+)n't$/.exec(t.lower); if (m2 && t.kind === 'word') { out.push(Object.assign({}, t, { w: m2[1], lower: m2[1] })); out.push(Object.assign({}, t, { w: 'not', lower: 'not' })); } else out.push(t); } return out;
    }
    function lemma(w) {
        const l = w.toLowerCase(); if (IRREG[l]) return IRREG[l]; if (VERB.has(l)) return l;
        if (/ies$/.test(l) && VERB.has(l.slice(0, -3) + 'y')) return l.slice(0, -3) + 'y'; if (/(es|s)$/.test(l) && !/ss$/.test(l)) { if (VERB.has(l.slice(0, -2))) return l.slice(0, -2); if (VERB.has(l.slice(0, -1))) return l.slice(0, -1); }
        if (/ing$/.test(l)) { const b = l.slice(0, -3); if (VERB.has(b)) return b; if (VERB.has(b + 'e')) return b + 'e'; if (b.length > 2 && b[b.length - 1] === b[b.length - 2] && VERB.has(b.slice(0, -1))) return b.slice(0, -1); }
        if (/ed$/.test(l)) { const b = l.slice(0, -2); if (VERB.has(b)) return b; if (VERB.has(b + 'e')) return b + 'e'; if (VERB.has(l.slice(0, -1))) return l.slice(0, -1); if (b.length > 2 && b[b.length - 1] === b[b.length - 2] && VERB.has(b.slice(0, -1))) return b.slice(0, -1); if (/ied$/.test(l) && VERB.has(l.slice(0, -3) + 'y')) return l.slice(0, -3) + 'y'; }
        return null;
    }
    // 詞類：封閉類別查表；動詞／名詞靠詞表、後綴、前後文
    function tag(toks, extra) {
        const xv = (extra && extra.verbs) || new Set(), xn = (extra && extra.nouns) || new Set(); const n = toks.length; const T = new Array(n); let pendingAux = false;
        for (let i = 0; i < n; i++) {
            const t = toks[i]; const l = t.lower; const prev = T[i - 1]; if (prev === 'VERB') pendingAux = false;
            if (t.kind === 'code' || t.kind === 'ident' || t.kind === 'path' || t.kind === 'url') { T[i] = 'CODE'; continue; } if (t.kind === 'num' || (t.kind === 'word' && NUMW.has(l) && /^(DET|ADJ|NUM|PREP)$/.test(T[i - 1] || ''))) { T[i] = 'NUM'; continue; } if (t.kind === 'punct') { T[i] = /^[.!?]$/.test(t.w) ? 'END' : (/^[,;:]$/.test(t.w) ? 'PUNCT' : 'PUNCT'); continue; }
            if (l === 'not' || l === 'never' || l === 'cannot') { T[i] = 'NEG'; if (l === 'cannot') T[i] = 'NEG'; continue; }
            if (l === 'to') { T[i] = 'TO'; continue; }
            if (l === 'so' && toks[i + 1] && (ADJ.has(toks[i + 1].lower) || ADV.has(toks[i + 1].lower))) { T[i] = 'ADV'; continue; }
            if (/^(when|while|because|unless|since|although|if|where)$/.test(l) && /^(NOUN|CODE|VERB|PRT)$/.test(prev || '')) { T[i] = 'REL'; continue; }
            if (WH.has(l) && (i === 0 || /^(PUNCT|CONJ|VERB)$/.test(prev || ''))) { T[i] = 'WH'; continue; }
            if (/^(where|when|which|whose)$/.test(l) && /^(NOUN|CODE)$/.test(prev || '')) { T[i] = 'REL'; continue; }
            if (PARTICLE.has(l) && prev === 'VERB') { const strict = /^(up|down|off|out|away|back)$/.test(l); const nx = toks[i + 1]; const endish = !nx || nx.kind === 'punct'; const pv = lemma(toks[i - 1].lower) || toks[i - 1].lower; if (strict || endish || (/^(turn|switch|log|sign|plug|hook|check)$/.test(pv) && nx && /^(the|a|an|this|that|my|your)$/.test(nx.lower))) { T[i] = 'PRT'; continue; } }
            if (l === 'like' && /^(MOD|AUX|PRON|ADV)$/.test(prev || '')) { T[i] = 'VERB'; continue; }
            if (DET.has(l)) { T[i] = 'DET'; continue; } if (PREP.has(l)) { T[i] = 'PREP'; continue; }
            if (AUX.has(l)) { T[i] = MODAL.has(l) ? 'MOD' : 'AUX'; if (/^(do|does|did|can|could|would|should|will|shall|may|might|must)$/.test(l)) pendingAux = true; continue; }
            if (PRON.has(l)) { T[i] = 'PRON'; continue; } if (CONJ.has(l)) { T[i] = 'CONJ'; continue; }
            if (ADV.has(l)) { T[i] = 'ADV'; continue; }
            const isVerbForm = VERB.has(l) || xv.has(l) || lemma(l) != null; const isNounForm = NOUN.has(l) || xn.has(l);
            const subjVerb = pendingAux && /^(NOUN|CODE|PRON)$/.test(prev || '') || (prev === 'PRON' && /^(i|you|we|they)$/.test(toks[i - 1].lower));
            if (subjVerb && (VERB.has(l) || xv.has(l) || lemma(l) != null) && !DET.has(l)) { T[i] = 'VERB'; pendingAux = false; continue; }
            if (subjVerb && !NOUN.has(l) && !ADJ.has(l) && !xn.has(l) && /^[a-z]+$/.test(l)) { T[i] = 'VERB'; pendingAux = false; continue; }
            const afterDet = /^(DET|ADJ)$/.test(prev || '') || (prev === 'PREP'); const afterTo = prev === 'TO' || prev === 'MOD' || prev === 'AUX' || prev === 'PRON' || prev === 'ADV' || i === 0 || prev === 'CONJ' || prev === 'NEG' || prev === 'PUNCT' || prev === 'END';
            const nx0 = toks[i + 1]; if (i === 0 && (VERB.has(l) || xv.has(l)) && nx0 && (PARTICLE.has(nx0.lower) || /^(the|a|an|this|that|my|your|these|those|all|every|each|some|any)$/.test(nx0.lower) || nx0.kind === 'code' || nx0.kind === 'ident' || nx0.kind === 'path')) { T[i] = 'VERB'; continue; }
            if ((prev === 'NEG' || prev === 'MOD') && !DET.has(l) && !ADJ.has(l) && /^[a-z]+$/.test(l) && !(NOUN.has(l) && !VERB.has(l) && lemma(l) == null)) { T[i] = 'VERB'; pendingAux = false; continue; }
            if (prev === 'VERB' && /ing$/.test(l) && lemma(l) != null && !/^(start|keep|stop|try|begin|finish|avoid|enjoy|mind|consider|prefer|go|come|stay|continue|quit|resume|like|love|hate)$/.test(lemma(toks[i - 1].lower) || toks[i - 1].lower)) { T[i] = 'NOUN'; continue; }
            if (ADJ.has(l) && !(isVerbForm && AMBI.has(l) && afterTo && !afterDet)) { // ADJ 後面還接名詞才算形容詞，否則（例如「is broken」）仍當形容詞
                T[i] = 'ADJ'; continue; }
            if (isVerbForm && isNounForm) { T[i] = afterDet && prev !== 'PREP' ? 'NOUN' : (afterTo ? 'VERB' : 'NOUN'); if (prev === 'PREP' && /ing$/.test(l)) T[i] = 'VERB'; continue; }
            if (isVerbForm && AMBI.has(l)) { T[i] = afterDet ? 'NOUN' : (afterTo ? 'VERB' : 'NOUN'); continue; }
            if (isVerbForm && !isNounForm) { const base = lemma(l); const inflectedOnly = base && base !== l; if ((afterDet || prev === 'NUM') && /s$/.test(l) && !/ss$/.test(l)) { T[i] = 'NOUN'; continue; } T[i] = (afterDet && !/ing$/.test(l) && !inflectedOnly) ? 'NOUN' : 'VERB'; if (afterDet && /ing$/.test(l)) T[i] = 'NOUN'; if (afterDet && inflectedOnly && /ed$/.test(l)) T[i] = 'ADJ'; continue; }
            if (isNounForm) { T[i] = 'NOUN'; continue; }
            if (/ly$/.test(l)) { T[i] = 'ADV'; continue; }
            if (/(tion|sion|ment|ness|ity|ance|ence|ship|age|ure|ism|ist)$/.test(l)) { T[i] = 'NOUN'; continue; }
            if (/(ing)$/.test(l)) { T[i] = afterDet ? 'NOUN' : (/^(TO|AUX|MOD|PRON|NEG|ADV)$/.test(prev || '') ? 'VERB' : 'ADJ'); continue; } if (/(ed)$/.test(l)) { T[i] = afterDet ? 'ADJ' : 'VERB'; continue; } if (/(able|ible|ful|less|ous|ive|al|ic)$/.test(l)) { T[i] = 'ADJ'; continue; }
            if (/^[A-Z]/.test(t.w) && i > 0) { T[i] = 'NOUN'; continue; } T[i] = 'NOUN';
        }
        // 補正：句首的動詞形（imperative）
        if (n && T[0] === 'NOUN' && (VERB.has(toks[0].lower) || xv.has(toks[0].lower)) && n > 1 && /^(DET|CODE|ADJ|NOUN|PRON|PREP|NUM)$/.test(T[1])) T[0] = 'VERB';
        if (n > 1 && T[0] === 'ADV' && toks[0].lower === 'please' && /^(NOUN|VERB)$/.test(T[1]) && (VERB.has(toks[1].lower) || xv.has(toks[1].lower))) T[1] = 'VERB';
        return T;
    }

    // ---------- 片語切分 ----------
    function chunk(toks, tags) {
        const ch = []; let i = 0; const n = toks.length; const push = (type, a, b) => ch.push({ type, a, b, text: toks.slice(a, b).map((x) => x.raw).join(' ') });
        while (i < n) {
            const t = tags[i];
            if (t === 'WH') { push('WH', i, i + 1); i++; continue; }
            if (t === 'CONJ') { push('CONJ', i, i + 1); i++; continue; } if (t === 'END') { push('END', i, i + 1); i++; continue; } if (t === 'PUNCT') { push('PUNCT', i, i + 1); i++; continue; }
            if (t === 'ADV') { push('ADV', i, i + 1); i++; continue; }
            if (t === 'MOD' || t === 'AUX' || t === 'NEG' || t === 'VERB' || (t === 'TO' && /^(VERB)$/.test(tags[i + 1] || ''))) { // 動詞片語：助動詞* 否定? 副詞* 動詞 (to 動詞)*
                let j = i; while (j < n && /^(MOD|AUX|NEG|ADV)$/.test(tags[j])) j++; if (j < n && tags[j] === 'VERB') { j++; while (j < n && tags[j] === 'PRT') j++; while (j + 1 < n && tags[j] === 'TO' && tags[j + 1] === 'VERB') { j += 2; while (j < n && tags[j] === 'PRT') j++; } push('VP', i, j); i = j; continue; }
                if (j > i) { push('AV', i, j); i = j; continue; } if (t === 'TO') { push('VP', i, i + 2); i += 2; continue; } push('VP', i, i + 1); i++; continue; }
            if (t === 'PREP' || t === 'TO') { push('PREP', i, i + 1); i++; continue; }
            if (/^(DET|ADJ|NOUN|CODE|NUM|PRON)$/.test(t)) { let j = i; if (t === 'PRON') { j = i + 1; } else { while (tags[j] === 'DET') j++; while (j < n && /^(ADJ|NUM)$/.test(tags[j])) j++; const k = j; while (j < n && /^(NOUN|CODE)$/.test(tags[j])) j++; if (j === k) { j = Math.max(j, i + 1); } } push('NP', i, j); i = j; continue; }
            push('X', i, i + 1); i++;
        }
        // 介系詞 + 名詞片語 → PP
        const out = []; for (let k = 0; k < ch.length; k++) { if (ch[k].type === 'PREP' && ch[k + 1] && ch[k + 1].type === 'NP') { out.push({ type: 'PP', a: ch[k].a, b: ch[k + 1].b, text: ch[k].text + ' ' + ch[k + 1].text, prep: ch[k].text.toLowerCase(), np: ch[k + 1] }); k++; } else out.push(ch[k]); }
        return out;
    }

    // ---------- 子句文法（資料）+ LALR 表 ----------
    // 終端符號是片語類別：NP VP PP WH CONJ END PUNCT ADV X；roles 說明每個位置在框架裡是什麼
    const P = (lhs, rhs, extra) => Object.assign({ lhs, rhs: rhs.split(' ').filter(Boolean) }, extra || {});
    const SEED = [
        P('text', 'sent'), P('text', 'text sent'),
        P('sent', 'clause END'), P('sent', 'clause PUNCT'), P('sent', 'clause'), P('sent', 'clause PUNCT clause'), P('sent', 'clause CONJ clause'), P('sent', 'END'),
        P('clause', 'imp', { roles: ['imp'] }), P('clause', 'ques', { roles: ['ques'] }), P('clause', 'decl', { roles: ['decl'] }),
        P('imp', 'ADV VP', { roles: ['adv', 'act'], type: 'imperative' }), P('imp', 'VP', { roles: ['act'], type: 'imperative' }), P('imp', 'ADV VP NP pps', { roles: ['adv', 'act', 'obj', 'pps'], type: 'imperative' }), P('imp', 'VP NP pps', { roles: ['act', 'obj', 'pps'], type: 'imperative' }),
        P('imp', 'VP pps', { roles: ['act', 'pps'], type: 'imperative' }), P('imp', 'ADV VP pps', { roles: ['adv', 'act', 'pps'], type: 'imperative' }), P('imp', 'VP NP NP pps', { roles: ['act', 'obj', 'obj2', 'pps'], type: 'imperative' }), P('imp', 'VP NP', { roles: ['act', 'obj'], type: 'imperative' }), P('imp', 'ADV VP NP', { roles: ['adv', 'act', 'obj'], type: 'imperative' }),
        P('decl', 'NP VP', { roles: ['subj', 'act'], type: 'declarative' }), P('decl', 'NP VP NP pps', { roles: ['subj', 'act', 'obj', 'pps'], type: 'declarative' }), P('decl', 'NP VP pps', { roles: ['subj', 'act', 'pps'], type: 'declarative' }), P('decl', 'NP VP NP', { roles: ['subj', 'act', 'obj'], type: 'declarative' }),
        P('decl', 'NP ADV VP', { roles: ['subj', 'adv', 'act'], type: 'declarative' }), P('decl', 'NP ADV VP NP pps', { roles: ['subj', 'adv', 'act', 'obj', 'pps'], type: 'declarative' }), P('decl', 'NP ADV VP NP', { roles: ['subj', 'adv', 'act', 'obj'], type: 'declarative' }), P('decl', 'NP ADV VP pps', { roles: ['subj', 'adv', 'act', 'pps'], type: 'declarative' }),
        P('decl', 'NP VP VP NP pps', { roles: ['subj', 'want', 'act', 'obj', 'pps'], type: 'desire' }), P('decl', 'NP VP VP NP', { roles: ['subj', 'want', 'act', 'obj'], type: 'desire' }), P('decl', 'NP VP VP pps', { roles: ['subj', 'want', 'act', 'pps'], type: 'desire' }), P('decl', 'NP VP VP', { roles: ['subj', 'want', 'act'], type: 'desire' }),
        P('ques', 'WH VP NP', { roles: ['wh', 'aux', 'subj'], type: 'question' }), P('ques', 'WH VP NP VP', { roles: ['wh', 'aux', 'subj', 'act'], type: 'question' }), P('ques', 'WH VP NP VP NP pps', { roles: ['wh', 'aux', 'subj', 'act', 'obj', 'pps'], type: 'question' }), P('ques', 'WH VP NP VP NP', { roles: ['wh', 'aux', 'subj', 'act', 'obj'], type: 'question' }), P('ques', 'WH VP NP VP pps', { roles: ['wh', 'aux', 'subj', 'act', 'pps'], type: 'question' }),
        P('ques', 'WH NP VP', { roles: ['wh', 'subj', 'act'], type: 'question' }), P('ques', 'WH NP VP NP pps', { roles: ['wh', 'subj', 'act', 'obj', 'pps'], type: 'question' }), P('ques', 'WH NP VP pps', { roles: ['wh', 'subj', 'act', 'pps'], type: 'question' }), P('ques', 'WH NP VP NP', { roles: ['wh', 'subj', 'act', 'obj'], type: 'question' }),
        P('ques', 'WH VP', { roles: ['wh', 'act'], type: 'question' }), P('ques', 'WH VP NP pps', { roles: ['wh', 'act', 'obj', 'pps'], type: 'question' }), P('ques', 'WH VP pps', { roles: ['wh', 'act', 'pps'], type: 'question' }),
        P('ques', 'VP NP VP NP pps', { roles: ['aux', 'subj', 'act', 'obj', 'pps'], type: 'request' }), P('ques', 'VP NP VP NP', { roles: ['aux', 'subj', 'act', 'obj'], type: 'request' }), P('ques', 'VP NP VP pps', { roles: ['aux', 'subj', 'act', 'pps'], type: 'request' }), P('ques', 'VP NP VP', { roles: ['aux', 'subj', 'act'], type: 'request' }),
        P('ques', 'VP NP ADV VP NP pps', { roles: ['aux', 'subj', 'adv', 'act', 'obj', 'pps'], type: 'request' }), P('ques', 'VP NP ADV VP NP', { roles: ['aux', 'subj', 'adv', 'act', 'obj'], type: 'request' }), P('ques', 'VP NP ADV VP pps', { roles: ['aux', 'subj', 'adv', 'act', 'pps'], type: 'request' }), P('ques', 'VP NP ADV VP', { roles: ['aux', 'subj', 'adv', 'act'], type: 'request' }),
        P('ques', 'VP NP VP VP NP pps', { roles: ['aux', 'subj', 'act', 'act2', 'obj', 'pps'], type: 'request' }), P('ques', 'VP NP VP VP NP', { roles: ['aux', 'subj', 'act', 'act2', 'obj'], type: 'request' }), P('ques', 'VP NP VP VP', { roles: ['aux', 'subj', 'act', 'act2'], type: 'request' }),
        P('ques', 'VP NP NP', { roles: ['aux', 'subj', 'pred'], type: 'question' }), P('ques', 'VP NP', { roles: ['aux', 'subj'], type: 'question' }), P('ques', 'VP NP pps', { roles: ['aux', 'subj', 'pps'], type: 'question' }),
        P('imp', 'VP WH NP VP', { roles: ['act', 'wh', 'subj', 'act2'], type: 'imperative' }), P('imp', 'VP WH NP VP pps', { roles: ['act', 'wh', 'subj', 'act2', 'pps'], type: 'imperative' }), P('imp', 'VP WH NP VP NP', { roles: ['act', 'wh', 'subj', 'act2', 'obj'], type: 'imperative' }), P('imp', 'VP WH NP VP NP pps', { roles: ['act', 'wh', 'subj', 'act2', 'obj', 'pps'], type: 'imperative' }), P('imp', 'VP WH NP', { roles: ['act', 'wh', 'subj'], type: 'imperative' }),
        P('decl', 'NP VP NP VP NP pps', { roles: ['subj', 'want', 'who', 'act', 'obj', 'pps'], type: 'desire' }), P('decl', 'NP VP NP VP NP', { roles: ['subj', 'want', 'who', 'act', 'obj'], type: 'desire' }), P('decl', 'NP VP NP VP pps', { roles: ['subj', 'want', 'who', 'act', 'pps'], type: 'desire' }), P('decl', 'NP VP NP VP', { roles: ['subj', 'want', 'who', 'act'], type: 'desire' }),
        P('ques', 'AV NP VP NP NP pps', { roles: ['aux', 'subj', 'act', 'obj', 'obj2', 'pps'], type: 'request' }), P('ques', 'AV NP VP NP NP', { roles: ['aux', 'subj', 'act', 'obj', 'obj2'], type: 'request' }),
        P('pps', 'PP'), P('pps', 'pps PP'),
    ];
    for (const p of SEED) { if (p.lhs === 'ques' && p.rhs[0] === 'VP' && p.rhs[1] === 'NP') p.rhs[0] = 'AV'; if (p.lhs === 'ques' && p.rhs[0] === 'WH' && p.rhs[1] === 'VP' && p.rhs[2] === 'NP') p.rhs[1] = 'AV'; }
    SEED.push(P('ques', 'WH AV NP AV', { roles: ['wh', 'aux', 'subj', 'act'], type: 'question' }), P('decl', 'NP AV NP', { roles: ['subj', 'aux', 'obj'], type: 'declarative' }), P('decl', 'NP AV', { roles: ['subj', 'aux'], type: 'declarative' }), P('decl', 'NP AV NP pps', { roles: ['subj', 'aux', 'obj', 'pps'], type: 'declarative' }), P('decl', 'NP AV pps', { roles: ['subj', 'aux', 'pps'], type: 'declarative' }));
    let TABLE = null; let GRAMMAR = { start: 'text', productions: SEED.slice() };
    function table() { if (!TABLE) TABLE = LR.build(GRAMMAR); return TABLE; }
    // 從例句學：解析不了的句子，把它的片語序列加成新的子句骨架（pps 重複的 PP 一般化）；加完重建表、重新驗證
    function learnSkeleton(chunks, toks, tags) {
        const used = chunks.filter((c) => c.type !== 'X' && c.type !== 'END'); if (!used.length) return false; const seq = [], roles = []; let actSeen = false;
        for (let i = 0; i < used.length; i++) { const c = used[i]; if (c.type === 'PP') { let j = i; while (used[j + 1] && used[j + 1].type === 'PP') j++; seq.push('pps'); roles.push('pps'); i = j; continue; } seq.push(c.type);
            if (c.type === 'AV') roles.push('aux'); else if (c.type === 'VP') { let hv = false; for (let q = c.a; q < c.b; q++) if (tags[q] === 'VERB') hv = true; if (hv && !actSeen) { roles.push('act'); actSeen = true; } else roles.push(hv ? 'act2' : 'aux'); }
            else if (c.type === 'NP') roles.push(actSeen ? (roles.includes('obj') ? 'obj2' : 'obj') : 'subj'); else if (c.type === 'WH') roles.push('wh'); else if (c.type === 'ADV') roles.push('adv'); else roles.push('x'); }
        const key = seq.join(' '); if (GRAMMAR.productions.some((p) => p.rhs.join(' ') === key && /^(imp|decl|ques)$/.test(p.lhs))) return false;
        const first = used[0]; const ft = tags[first.a]; const type = first.type === 'WH' ? 'question' : (first.type === 'AV' && /^(AUX|MOD)$/.test(ft) ? (seq.includes('NP') && seq.filter((s) => s === 'VP').length > 1 ? 'request' : 'question') : ((first.type === 'VP' || (first.type === 'ADV' && used[1] && used[1].type === 'VP')) ? 'imperative' : 'declarative'));
        GRAMMAR.productions.push({ lhs: type === 'imperative' ? 'imp' : (type === 'declarative' ? 'decl' : 'ques'), rhs: seq, roles, type, learned: true }); TABLE = null; return true;
    }
    const chunkTokens = (chunks) => chunks.filter((c) => c.type !== 'X').map((c) => ({ t: c.type, v: c.text, n: c.a }));

    // ---------- 框架 ----------
    const headOf = (toks, tags, c) => { for (let i = c.b - 1; i >= c.a; i--) if (/^(NOUN|CODE|NUM|PRON)$/.test(tags[i])) return i; return c.b - 1; };
    function npInfo(toks, tags, c) { if (!c) return null; const hi = headOf(toks, tags, c); const mods = []; for (let i = c.a; i < hi; i++) if (/^(ADJ|NOUN|NUM)$/.test(tags[i])) mods.push(toks[i].lower); return { head: toks[hi] ? (tags[hi] === 'CODE' ? toks[hi].w : toks[hi].lower) : '', code: tags[hi] === 'CODE', mods, text: c.text, a: c.a, b: c.b }; }
    function vpInfo(toks, tags, c) { let neg = false, modal = null; let verb = null; for (let i = c.a; i < c.b; i++) { if (tags[i] === 'NEG') neg = true; if (tags[i] === 'MOD') modal = toks[i].lower; if (tags[i] === 'VERB') verb = toks[i]; } if (!verb) { for (let i = c.a; i < c.b; i++) if (tags[i] === 'AUX' || tags[i] === 'MOD') verb = toks[i]; } const lem = verb ? (lemma(verb.lower) || verb.lower) : null; return { lemma: lem, raw: verb ? verb.lower : null, neg, modal, text: c.text }; }
    function walk(node, acc) { if (!node || node.leaf) return; const p = GRAMMAR.productions[node.prod - 1]; if (p && p.roles) { acc.nodes.push({ p, node }); } for (const k of node.children || []) walk(k, acc); }
    function frameOf(sentence0, extra) {
        let sentence = String(sentence0); for (let k = 0; k < 3; k++) { const n = sentence.replace(HEDGE, ''); if (n === sentence) break; sentence = n; }
        if (!sentence.trim()) return null;
        // 並列的動作：「Open X and change Y」→ 第一個動作是主框架，後面的接在 next
        { const tk = lex(sentence); const tg = tag(tk, extra); for (let i = 1; i < tk.length - 1; i++) { if ((tk[i].lower === 'and' || tk[i].lower === 'then') && tg[i] !== 'PREP') { let q = i + 1; while (q < tk.length && (tg[q] === 'ADV' || tk[q].lower === 'please')) q++; if (q < tk.length && (tg[q] === 'VERB' || (tg[q] === 'AV' && false)) && /^(VERB)$/.test(tg[q]) && (tg[i - 1] === 'NOUN' || tg[i - 1] === 'CODE' || tg[i - 1] === 'PRT' || tg[i - 1] === 'ADJ') && (VERB.has(tk[q].lower) || (extra && extra.verbs && extra.verbs.has(tk[q].lower)) || lemma(tk[q].lower) != null) && tg.slice(0, i).includes('VERB')) { const left = sentence.slice(0, tk[i].s).trim().replace(/[,;]\s*$/, ''); const right = sentence.slice(tk[q].s).trim(); const f0 = frameOfOne(left + '.', extra); if (f0) { f0.text = sentence0; f0.next = frameOf(right, extra); return f0; } } } } }
        return frameOfOne(sentence, extra);
    }
    function frameOfOne(sentence, extra) {
        const toks = lex(sentence); if (!toks.length) return null; const tags = tag(toks, extra); const relAt = tags.indexOf('REL'); const relText = relAt >= 0 ? sentence.slice(toks[relAt].s).replace(/[.!?]+\s*$/, '') : null; const allChunks = chunk(relAt >= 0 ? toks.slice(0, relAt) : toks, relAt >= 0 ? tags.slice(0, relAt) : tags).concat(relAt >= 0 ? [{ type: 'END', a: toks.length - 1, b: toks.length, text: '.' }] : []); const advs = allChunks.filter((c) => c.type === 'ADV'); const chunks = allChunks.filter((c) => c.type !== 'ADV'); const t = chunkTokens(chunks);
        let r = LR.parse(table(), t); let learned = false; if (!r.ok && extra && extra.learn) { if (learnSkeleton(chunks, toks, tags)) { r = LR.parse(table(), t); learned = r.ok; } }
        const frame = { rel: relText, text: sentence, tokens: toks.map((x, i) => x.w + '/' + tags[i]), chunks: chunks.map((c) => c.type + '[' + c.text + ']'), parsed: r.ok, learnedRule: learned, type: 'unknown', act: null, obj: null, obj2: null, subj: null, pps: [], wh: null, adv: null, code: [], confidence: 0 };
        if (!r.ok) { // 解析不了：保留原句、只給最粗的資訊（第一個動詞、第一個名詞片語），信心低
            const vps = chunks.filter((c) => c.type === 'VP'); const known = (q) => tags[q] === 'VERB' && (VERB.has(lemma(toks[q].lower) || toks[q].lower) || (extra && extra.verbs && extra.verbs.has(toks[q].lower))); const vp = vps.find((c) => { for (let q = c.a; q < c.b; q++) if (known(q)) return true; return false; }); const np = chunks.find((c) => c.type === 'NP' && c.a >= (vp ? vp.b : 0)); frame.adv = advs[0] ? advs[0].text.toLowerCase() : null; frame.act = vp ? vpInfo(toks, tags, vp) : null; frame.obj = np ? npInfo(toks, tags, np) : null; if (frame.act) { const first = tags[0]; frame.type = (first === 'AUX' && tags[1] === 'NEG') ? 'imperative' : (/[?]\s*$/.test(sentence) || first === 'WH' || first === 'MOD' || first === 'AUX' ? 'question' : (first === 'VERB' || (first === 'ADV' && tags[1] === 'VERB') ? 'imperative' : 'unknown')); if (frame.act && /^(want|need|like|wish|hope|try|plan)$/.test(vpLead(toks, tags, frame.act)) && /\bto\b/i.test(frame.act.text)) frame.type = 'desire'; frame.partial = true; } frame.pps = chunks.filter((c) => c.type === 'PP').map((c) => ({ prep: c.prep, np: npInfo(toks, tags, c.np) })); frame.confidence = frame.act ? 0.4 : 0.1; frame.error = r.error && { at: r.error.at, token: r.error.token, expected: (r.error.expected || []).slice(0, 8) }; return frame; }
        // 依文法的角色標記取出各部分；每個終端依序對應到 chunkTokens 的片語
        const used = chunks.filter((c) => c.type !== 'X'); const acc = { nodes: [] }; walk(r.tree, acc); const leaves = []; (function lv(n) { if (!n) return; if (n.leaf) leaves.push(n); else n.children.forEach(lv); })(r.tree); const byPos = new Map(); leaves.forEach((l, i) => byPos.set(l, used[i]));
        const leavesOf = (node) => { const out = []; (function lv(n) { if (n.leaf) out.push(n); else n.children.forEach(lv); })(node); return out; };
        const best = acc.nodes.filter((x) => x.p.type).sort((a, b) => leavesOf(b.node).length - leavesOf(a.node).length)[0]; if (!best) { frame.confidence = 0.3; return frame; }
        frame.type = best.p.type; const kids = best.node.children; best.p.roles.forEach((role, i) => { const kid = kids[i]; if (!kid) return; const ls = leavesOf(kid); if (role === 'pps') { for (const l of ls) { const c = byPos.get(l); if (c && c.type === 'PP') frame.pps.push({ prep: c.prep, np: npInfo(toks, tags, c.np) }); } return; } const c = byPos.get(ls[0]); if (!c) return; if (role === 'act' || role === 'act2' || role === 'want' || role === 'aux') { const vi = vpInfo(toks, tags, c); if (role === 'act') frame.act = vi; else if (role === 'act2') frame.act2 = vi; else if (role === 'want') frame.want = vi; else frame.aux = vi; } else if (role === 'obj' || role === 'subj' || role === 'obj2' || role === 'pred') { frame[role === 'pred' ? 'obj' : role] = npInfo(toks, tags, c); } else if (role === 'wh') frame.wh = toks[c.a].lower; else if (role === 'adv') frame.adv = toks[c.a].lower; });
        if (frame.adv == null && advs[0]) frame.adv = advs[0].text.toLowerCase();
        // 動詞後接動名詞（would you mind checking…）：真正的動作是那個動名詞
        if (frame.act && /^(mind|like|love|hate|start|stop|keep|try|enjoy|avoid|consider|prefer|begin|finish)$/.test(vpLead(toks, tags, frame.act)) && frame.act2) { frame.act = frame.act2; frame.gerund = true; }
        // 被動：is/are/was/were/be/been + 過去分詞，而且沒有受詞 → 主詞就是被作用的對象
        if (frame.act && !frame.obj && frame.subj && /(ed|en)$/.test(frame.act.raw || '') && frame.act.raw !== frame.act.lemma && (frame.type === 'question' || frame.type === 'declarative' || frame.type === 'request')) { frame.obj = frame.subj; frame.passive = true; }
        if (frame.type === 'request' && frame.aux && (!/^(can|could|would|will|should)$/.test(frame.aux.modal || frame.aux.raw || '') || !(frame.subj && /^(you|someone|anyone)$/.test(frame.subj.head)))) frame.type = 'question';
        // 包裝說法：「I want to X」「can you X」「how do I X」→ 真正的動作是裡面的那個
        if (frame.type === 'desire' && frame.want && /^(want|need|like|wish|hope|try|plan|go)$/.test(frame.want.lemma || '')) frame.wrapper = 'desire';
        if (frame.type === 'request' && frame.aux && /^(can|could|would|will|should)$/.test((frame.aux.modal || frame.aux.raw || ''))) frame.wrapper = 'request';
        if (!frame.act && frame.type === 'question' && frame.wh === 'what' && frame.subj) { frame.act = { lemma: 'explain', raw: 'what', neg: false, modal: null, text: 'what' }; frame.derivedAct = true; }
        if (frame.type === 'question' && frame.wh === 'what' && frame.act && /^(do|mean)$/.test(frame.act.lemma || '')) { frame.act = { lemma: 'explain', raw: 'what', neg: false, modal: null, text: 'what ... do' }; frame.derivedAct = true; }
        if (frame.type === 'imperative' && frame.wh) { frame.embedded = true; if (frame.wh === 'why') frame.intentKind = 'diagnose'; else if (frame.wh === 'how') frame.intentKind = 'how-to'; else frame.intentKind = 'explain'; }
        if (frame.act && /\bto\b/i.test(frame.act.text)) { frame.wrapper = 'desire'; frame.type = 'desire'; }
        if (frame.type === 'question' && frame.wh === 'why') frame.intentKind = 'diagnose'; else if (frame.type === 'question' && frame.wh === 'how') frame.intentKind = 'how-to'; else if (frame.type === 'question' && frame.wh === 'what') frame.intentKind = 'explain'; else if (frame.type === 'question' && frame.wh === 'where') frame.intentKind = 'locate';
        if (frame.act && frame.act.lemma === 'be' && frame.type === 'declarative') { frame.state = true; }
        // 程式引用：句子裡的 CODE 詞
        toks.forEach((x, i) => { if (tags[i] === 'CODE') frame.code.push({ text: x.w, kind: x.kind }); });
        // 指示詞：this/that/these/the above/below/following
        frame.deixis = /\b(this|these|that|those|above|below|following|attached|pasted|here|next|previous|last)\b/i.test(sentence) ? (sentence.match(/\b(this|these|that|those|above|below|following|attached|pasted|here|next|previous|last)\b/i)[1].toLowerCase()) : null;
        frame.confidence = frame.act ? (frame.derivedAct ? 0.6 : 0.85) : 0.5; if (frame.state && !frame.obj) frame.confidence = 0.5; return frame;
    }
    // 「是什麼動作」：把包裝去掉
    const vpLead = (toks, tags, act) => { const w = String(act.text || '').toLowerCase().split(/\s+/).filter((x) => !/^(not|n't|do|does|did|am|is|are|was|were|will|would|can|could|should|may|might|must|shall|have|has|had)$/.test(x))[0] || ''; return lemma(w) || w; };
    const actionOf = (f) => (f.act && f.act.lemma) || null;

    // ---------- 意圖比對（對上訓練器的意圖目錄）----------
    // catalog：[{ id, domain, tool, intent, examples:[…] }]；目錄項目的動詞與名詞用同一套管線分析一次，存起來
    function profileOf(entry, extra) {
        if (entry._p) return entry._p; const texts = [entry.intent].concat(entry.examples || []).filter(Boolean).slice(0, 6); const verbs = new Set(), nouns = new Set();
        for (const t of texts) { const toks = lex(String(t)); const tags = tag(toks, extra); toks.forEach((x, i) => { if (tags[i] === 'VERB') { const l = lemma(x.lower) || x.lower; verbs.add(l); } else if (tags[i] === 'NOUN' || tags[i] === 'CODE') nouns.add(x.lower); }); }
        const synIds = new Set(); verbs.forEach((v) => (SYN_OF.get(v) || []).forEach((i) => synIds.add(i))); const langs = new Set(entry.langs || []); nouns.forEach((x) => (NOUN_LANG[x] || []).forEach((l) => langs.add(l))); entry._p = { verbs, nouns, synIds, langs }; return entry._p;
    }
    function intentOf(frame, catalog, opts) {
        opts = opts || {}; const act = actionOf(frame); const nouns = new Set(); if (frame.obj) { nouns.add(frame.obj.head); frame.obj.mods.forEach((m) => nouns.add(m)); } if (frame.obj2) nouns.add(frame.obj2.head); frame.pps.forEach((p) => { if (p.np) { nouns.add(p.np.head); p.np.mods.forEach((m) => nouns.add(m)); } }); if (frame.subj) nouns.add(frame.subj.head);
        const langs = new Set(opts.langs || []); const wantSyn = new Set(act ? (SYN_OF.get(act) || []) : []); if (frame.intentKind === 'diagnose') (SYN_OF.get('fix') || []).forEach((i) => wantSyn.add(i)); if (frame.intentKind === 'explain') (SYN_OF.get('explain') || []).forEach((i) => wantSyn.add(i)); if (frame.intentKind === 'how-to') (SYN_OF.get('explain') || []).forEach((i) => wantSyn.add(i));
        const out = [];
        for (const e of catalog || []) {
            const p = profileOf(e, opts.extra); let s = 0; const ev = [];
            if (act && p.verbs.has(act)) { s += 0.3; ev.push('動作「' + act + '」直接出現在這個意圖裡'); } else { const shared = Array.from(wantSyn).filter((i) => p.synIds.has(i)); if (shared.length) { s += 0.2; ev.push('動作「' + act + '」跟這個意圖的動作同義（' + SYN[shared[0]].slice(0, 3).join('／') + '）'); } }
            const hit = Array.from(nouns).filter((x) => p.nouns.has(x)); if (hit.length) { s += Math.min(0.5, 0.25 * hit.length); ev.push('對象「' + hit.join('、') + '」在這個意圖裡'); }
            if (langs.size && Array.from(p.langs).some((l) => langs.has(l))) { s += 0.15; ev.push('引用的程式語言（' + Array.from(langs).join('、') + '）符合'); }
            if (s > 0) out.push({ id: e.id, domain: e.domain || null, tool: e.tool || null, score: Math.round(Math.min(1, s * (0.6 + 0.4 * frame.confidence)) * 100) / 100, evidence: ev });
        }
        // 只有動作對上、沒有任何對象或語言佐證的，不算數（動詞太泛：convert、show、run 到處都有）
        return out.filter((x) => x.score >= (opts.min || 0.3) || (x.evidence.length >= 2 && x.score >= 0.25)).sort((a, b) => b.score - a.score).slice(0, opts.top || 5);
    }

    // ---------- 單句、整份輸入 ----------
    function analyzeSentence(sentence, opts) { const f = frameOf(sentence, opts); return f; }
    function typeCompatible(noun, lang) { const ls = NOUN_LANG[noun]; return !!(ls && ls.includes(lang)); }
    // 把句子對回區段：「this shader」→ 最近的 GLSL 區段；沒有類型線索就找最近、最有信心的程式區段
    function resolve(frame, sentIdx, sentBlock, codeBlocks, mixBlocks) {
        if (!frame || !codeBlocks.length) return [];
        const hasDeixis = !!frame.deixis || /\b(it|them)\b/i.test(frame.text); const heads = []; if (frame.obj) { heads.push(frame.obj.head); frame.obj.mods.forEach((m) => heads.push(m)); } frame.pps.forEach((p) => { if (p.np) { heads.push(p.np.head); p.np.mods.forEach((m) => heads.push(m)); } }); if (frame.subj) heads.push(frame.subj.head);
        const cand = codeBlocks.map((b) => ({ b, dist: Math.abs(b.id - sentBlock), after: b.id > sentBlock })); const colon = /[:：]\s*$/.test(frame.text) || /\b(below|following|here)\b/i.test(frame.text); const refs = [];
        const typed = heads.filter((h) => NOUN_LANG[h]);
        for (const h of typed) { const ok = cand.filter((c) => typeCompatible(h, c.b.lang)); if (!ok.length) continue; ok.sort((x, y) => (colon ? (x.after === y.after ? x.dist - y.dist : (x.after ? -1 : 1)) : x.dist - y.dist)); refs.push({ block: ok[0].b.id, lang: ok[0].b.lang, reason: '「' + h + '」是' + (NOUN_LANG[h].slice(0, 2).join('／')) + '類的東西，最近的是第 ' + ok[0].b.fromLine + '–' + ok[0].b.toLine + ' 行的 ' + ok[0].b.name }); break; }
        if (!refs.length && (hasDeixis || frame.code.length === 0 && /\b(this|the above|below|following)\b/i.test(frame.text))) { cand.sort((x, y) => (colon ? (x.after === y.after ? x.dist - y.dist : (x.after ? -1 : 1)) : x.dist - y.dist)); const c = cand[0]; if (c) refs.push({ block: c.b.id, lang: c.b.lang, reason: '指示詞「' + (frame.deixis || 'it') + '」→ 最近的程式區段（第 ' + c.b.fromLine + '–' + c.b.toLine + ' 行的 ' + c.b.name + '）', weak: true }); }
        return refs;
    }
    var HEDGE_DEF = 1; const HEDGE = /^(?:i|we)\s+(?:think|believe|guess|suspect|feel|assume|noticed|notice|found|see)\s+(?:that\s+)?|^(?:it\s+seems|it\s+looks\s+like|maybe|perhaps|probably|honestly|basically|so|well|hi|hello|hey)[,\s]+/i;
    function splitClauses(sentence) {
        let s = String(sentence).trim(); for (let k = 0; k < 3; k++) { const n = s.replace(HEDGE, ''); if (n === s) break; s = n; }
        const parts = s.split(/[,;]\s+(?=(?:can|could|would|will|please|why|how|what|do|does|is|are|i|we|you|it|the|this|that|and|but|also|then))|\s+(?:but|so)\s+(?=(?:can|could|please|i|we|you|it))/i).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 2);
        return parts.length ? parts : [s];
    }
    function understand(text, opts) {
        opts = opts || {}; const mix = (opts.mix || MIX).analyze ? (opts.mix || MIX).analyze(text, { learned: opts.learned }) : null; if (!mix) return { ok: false, reason: '沒有混合內容分析器' };
        const blocks = mix.blocks; const allCode = blocks.filter((b) => b.kind !== 'prose' && b.lang !== 'unknown' && b.lang !== 'text'); const bigCode = allCode.filter((b) => b.lang !== 'html' || b.toLine - b.fromLine + 1 >= 2 || b.explicit); const codeBlocks = bigCode.length ? bigCode : allCode; const sentences = []; const catalog = opts.catalog || []; const extra = { verbs: opts.extraVerbs, nouns: opts.extraNouns, learn: opts.learn !== false };
        for (const b of blocks) { if (b.kind !== 'prose') continue; for (const s0 of splitSentences(b.text.split('\n').filter((l) => !/^\s*(```|~~~)/.test(l)).join('\n'))) for (const s of splitClauses(s0)) { const f = frameOf(s, extra); if (f && /(thanks|thank you|cheers|regards|let me know|best wishes)/i.test(s)) { f.type = 'social'; f.confidence = Math.min(f.confidence, 0.2); } if (!f) continue; const refs = resolve(f, sentences.length, b.id, codeBlocks, blocks); const langs = Array.from(new Set(refs.map((r) => r.lang))); const intents = catalog.length ? intentOf(f, catalog, { langs, extra, top: 3 }) : []; sentences.push({ block: b.id, text: s, frame: f, refs, intents, line: b.fromLine }); } }
        // 整份的意圖：句子的意圖加權（問句、祈使句、請求比陳述句重要）
        const weight = { imperative: 1, request: 1, question: 1, desire: 0.9, declarative: 0.35, unknown: 0.2 }; const agg = new Map(); for (const s of sentences) for (const it of s.intents) { const w = (weight[s.frame.type] || 0.3) * it.score; const cur = agg.get(it.id) || { id: it.id, domain: it.domain, tool: it.tool, score: 0, evidence: [] }; cur.score += w; if (cur.evidence.length < 3) cur.evidence.push('「' + s.text.slice(0, 60) + '」：' + it.evidence[0]); agg.set(it.id, cur); }
        const intents = Array.from(agg.values()).map((x) => Object.assign(x, { score: Math.round(Math.min(1, x.score) * 100) / 100 })).sort((a, b) => b.score - a.score).slice(0, 5);
        const asks = sentences.filter((s) => /^(imperative|request|question|desire)$/.test(s.frame.type)).map((s) => ({ kind: s.frame.intentKind || s.frame.type, act: actionOf(s.frame), object: s.frame.obj && s.frame.obj.text, refs: s.refs.map((r) => ({ block: r.block, lang: r.lang })), text: s.text }));
        return { ok: true, mix, sentences, asks, intents, languages: mix.languages, summary: summarize(asks, mix) };
    }
    function summarize(asks, mix) { if (!asks.length) return '沒有找到明確的要求（沒有祈使句、問句或「我想要…」的句子）。'; return asks.map((a) => (a.kind === 'diagnose' ? '診斷原因' : (a.kind === 'how-to' ? '詢問做法' : (a.kind === 'explain' ? '要求解釋' : (a.kind === 'locate' ? '找位置' : '動作')))) + (a.act ? '「' + a.act + '」' : '') + (a.object ? '對象「' + a.object + '」' : '') + (a.refs.length ? '，引用 ' + a.refs.map((r) => r.lang + ' 區段').join('、') : '')).join('；'); }

    return { splitSentences, splitClauses, lex, tag, chunk, lemma, frameOf, analyzeSentence, intentOf, profileOf, understand, resolve, learnSkeleton, table, SYN, NOUN_LANG, grammar: () => GRAMMAR, reset: () => { GRAMMAR = { start: 'text', productions: SEED.slice() }; TABLE = null; } };
});
