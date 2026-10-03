
    // ================= 由下而上的敘事（linetrace_tools：fold／render）=================
    const INCREMENT_RE = /^(?:(\+\+|--)\s*(\*{0,2}[\w.$\[\]]+)|(\*{0,2}[\w.$\[\]]+)\s*(\+\+|--))$/;
    const COMPOUND_RE = /^(\*{0,2}[\w.$\[\]]+)\s*(\+=|-=|\*=|\/=|%=|\|=|&=|\^=)\s*(.+)$/;
    const PLAIN_RE = /^(\*{0,2}[\w.$\[\]]+)\s*=(?!=)\s*(.+)$/;
    const COMPOUND_VERBS = { '+=': 'increments {lhs} by {rhs}', '-=': 'decrements {lhs} by {rhs}', '*=': 'multiplies {lhs} by {rhs}', '/=': 'divides {lhs} by {rhs}', '%=': 'sets {lhs} to its remainder modulo {rhs}', '|=': 'bitwise-ORs {rhs} into {lhs}', '&=': 'bitwise-ANDs {rhs} into {lhs}', '^=': 'bitwise-XORs {rhs} into {lhs}' };
    function fallbackAssignmentPhrase(text) {
        text = text.trim().replace(/;+$/, '').trim(); let m = INCREMENT_RE.exec(text);
        if (m) { const target = m[2] || m[3]; const op = m[1] || m[4]; return (op === '++' ? 'increments' : 'decrements') + ' `' + target + '`'; }
        m = COMPOUND_RE.exec(text); if (m) return COMPOUND_VERBS[m[2]].replace('{lhs}', '`' + m[1] + '`').replace('{rhs}', '`' + m[3] + '`');
        m = PLAIN_RE.exec(text); if (m) return 'sets `' + m[1] + '` to `' + m[2] + '`';
        return null;
    }
    function fallbackLeafPhrase(node) {
        const kind = node.kind;
        if (kind === 'return_statement') { const v = (node.text || '').slice('return'.length).trim().replace(/;+$/, '').trim(); return v ? 'returns ' + v : 'returns'; }
        if (kind === 'break_statement') return 'breaks out of the loop';
        if (kind === 'continue_statement') return 'continues to the next iteration';
        if (kind === 'goto_statement') return (node.text || '').replace(/;+$/, '');
        if (kind === 'raise_statement' || kind === 'throw_statement') return 'raises/throws ' + (node.text || '').replace(/^(raise|throw)\s*/, '').replace(/;+$/, '');
        if (kind === 'flow_control_statement') { const t = (node.text || '').trim().replace(/;+$/, ''); const fw = t.split(/\s+/)[0] || ''; if (fw === 'break') return 'breaks out of the loop'; if (fw === 'continue') return 'continues to the next iteration'; if (fw === 'return') { const v = t.slice(6).trim(); return v ? 'returns ' + v : 'returns'; } }
        if (node.calls && node.calls.length) { const c = node.calls; if (c.length === 1 && c[0] === 'break') return 'breaks out of the loop'; if (c.length === 1 && c[0] === 'continue') return 'continues to the next iteration'; if (c.length === 1 && c[0] === 'return') return 'returns'; return 'calls ' + c.map((x) => '`' + x + '()`').join(', '); }
        return fallbackAssignmentPhrase(node.text || '');
    }
    function appendCalleeNarratives(desc, calls, resolve) {
        if (!resolve || !desc) return desc; const extras = [];
        for (const cn of calls || []) { const n = resolve(cn); if (n) extras.push('`' + cn + '()` itself: ' + n); }
        if (!extras.length) return desc;
        return desc.trimEnd().replace(/\.+$/, '') + ' (' + extras.join('; ') + ')';
    }
    const MERGEABLE = /^calls (`[^`]+\(\)`(?:, `[^`]+\(\)`)*)$/;
    function oxford(items) { if (items.length === 1) return items[0]; if (items.length === 2) return items[0] + ' and ' + items[1]; return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1]; }
    function mergeLeafFragments(phrases, subject) {
        subject = subject || 'it'; if (!phrases.length) return '';
        if (phrases.length === 1) { const f = phrases[0]; return /[.)]\s*$/.test(f) ? f : f.trimEnd() + '.'; }
        const cleaned = phrases.map((p) => p.trimEnd().replace(/\.+$/, '')); const groups = [];
        for (const p of cleaned) { const m = MERGEABLE.exec(p); if (m) { const objs = m[1].split(',').map((o) => o.trim()); if (groups.length && groups[groups.length - 1][0] === 'calls') groups[groups.length - 1][1].push(...objs); else groups.push(['calls', objs]); } else groups.push([null, [p]]); }
        const clauses = groups.map(([verb, objs]) => (verb === 'calls' ? 'calls ' + oxford(objs) : objs[0]));
        if (clauses.length === 1) return subject + ' ' + clauses[0] + '.';
        return subject + ' ' + clauses.slice(0, -1).join(', ') + ', and ' + clauses[clauses.length - 1] + '.';
    }
    function conditionPhrase(node) { let text = (node.text || '').replace(/\{+$/, '').trim(); for (const kw of ['if', 'while', 'switch']) if (text.startsWith(kw + ' ')) { text = text.slice(kw.length).trim(); break; } if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim(); return text; }
    function emptyNarrativeMessage(lines) { return !lines.length ? '(empty function body)' : '(no call/return/branch to narrate - see the ' + lines.length + ' line-by-line statement(s) below for the raw effect)'; }
    // 區塊上的註解：文字重排後取最相關的句子（跟這個區塊真正呼叫的名稱、行為分類關鍵字比對）
    function rerankComment(comment, node, maxSentences) {
        const kw = (node.calls || []).concat(node.categories || []); return rerank(comment, kw, maxSentences || 2);
    }
    const trimDot = (s) => String(s || '').trim().replace(/[。.]+$/, '');
    function foldNodes(nodes, resolve, subject, opt) {
        opt = opt || {}; const fragments = []; let leaf = [];
        const flush = () => { if (leaf.length) { fragments.push(mergeLeafFragments(leaf, subject)); leaf = []; } };
        const withNote = (node, text) => (opt.useComments !== false && node.comment ? trimDot(rerankComment(node.comment, node)) + ' (' + text.replace(/\.+$/, '') + ').' : text);
        for (const node of nodes) {
            const kind = node.kind;
            if (kind === 'if_statement') {
                flush(); let cd = node.explanation || '`' + conditionPhrase(node) + '`'; cd = appendCalleeNarratives(cd, node.calls || [], resolve);
                if (node.is_guard_clause) { const aside = foldNodes(node.children || [], resolve, undefined, opt).join(' ') || 'it stops here'; fragments.push('(guard: ' + (node.comment && opt.useComments !== false ? trimDot(rerankComment(node.comment, node)) + ' — ' : '') + cd + ' -- if so, ' + aside + ')'); }
                else { const then = foldNodes(node.children || [], resolve, undefined, opt).join(' ') || 'nothing further'; const els = node.else_children; const pre = node.comment && opt.useComments !== false ? trimDot(rerankComment(node.comment, node)) + ' — ' : ''; if (els && els.length) fragments.push(pre + 'Checks: ' + cd + ' If so: ' + then + ' Otherwise: ' + foldNodes(els, resolve, undefined, opt).join(' ')); else fragments.push(pre + 'Checks: ' + cd + ' If so: ' + then); }
            } else if (kind === 'for_statement' || kind === 'while_statement' || kind === 'do_statement') {
                flush(); const body = foldNodes(node.children || [], resolve, undefined, opt).join(' ') || 'nothing further'; const pre = node.comment && opt.useComments !== false ? trimDot(rerankComment(node.comment, node)) + ' — ' : '';
                if (node.is_infinite_loop) fragments.push(pre + 'As its ongoing/continuous behavior: ' + body);
                else { let ld = node.explanation || '`' + conditionPhrase(node) + '`'; ld = appendCalleeNarratives(ld, node.calls || [], resolve); if (ld.trimEnd().endsWith(':')) fragments.push(pre + ld + ' ' + body); else fragments.push(pre + 'Loop: ' + ld + ' Each pass: ' + body); }
            } else if (kind === 'switch_statement') {
                flush(); const body = foldNodes(node.children || [], resolve, undefined, opt).join(' ') || 'nothing'; let sd = node.explanation || '`' + conditionPhrase(node) + '`'; sd = appendCalleeNarratives(sd, node.calls || [], resolve); fragments.push('Branches: ' + sd + ' It will ' + body);
            } else {
                let frag = node.explanation || fallbackLeafPhrase(node);
                if (frag) { frag = appendCalleeNarratives(frag, node.calls || [], resolve); frag = withNote(node, frag); if (frag.includes('\n')) { flush(); fragments.push(/\.\s*$/.test(frag) ? frag : frag.trimEnd() + '.'); } else leaf.push(frag); }
            }
        }
        flush(); return fragments;
    }
    function foldFunctionNarrative(trace, resolve, opt) {
        const tree = buildCompoundBlockTree(trace.lines); const frags = foldNodes(tree, resolve, 'This function', opt);
        return frags.length ? frags.join(' ') : emptyNarrativeMessage(trace.lines);
    }
    const firstLine = (t) => t.split('\n', 1)[0];
    const contLines = (t) => t.split('\n').slice(1);
    function bulletWithCont(first, rest) { const out = ['- ' + first]; rest.forEach((l) => out.push('  ' + l)); return out; }
    function renderNarrativeLines(nodes, resolve, opt) {
        opt = opt || {}; const out = [];
        const noteOf = (n) => (opt.useComments !== false && n.comment ? trimDot(rerankComment(n.comment, n)) : '');
        for (const node of nodes) {
            const kind = node.kind; const note = noteOf(node);
            if (kind === 'if_statement') {
                const cd = node.explanation || '`' + conditionPhrase(node) + '`';
                if (node.is_guard_clause) { out.push('<details>', '<summary>Guard: ' + (note ? note + ' — ' : '') + firstLine(cd) + '</summary>', ''); out.push(...contLines(cd)); out.push(...renderNarrativeLines(node.children || [], resolve, opt)); out.push('', '</details>', ''); }
                else {
                    out.push(...bulletWithCont((note ? note + ' — ' : '') + 'Checks: ' + firstLine(cd), contLines(cd)));
                    out.push('', '<details open>', '<summary>If so...</summary>', ''); out.push(...renderNarrativeLines(node.children || [], resolve, opt)); out.push('', '</details>');
                    if (node.else_children && node.else_children.length) { out.push('<details open>', '<summary>Otherwise...</summary>', ''); out.push(...renderNarrativeLines(node.else_children, resolve, opt)); out.push('', '</details>'); }
                    out.push('');
                }
            } else if (kind === 'for_statement' || kind === 'while_statement' || kind === 'do_statement') {
                let summary, extra = [];
                if (node.is_infinite_loop) summary = 'Ongoing/continuous behavior (repeats until an explicit break/return)';
                else { const ld = node.explanation || '`' + conditionPhrase(node) + '`'; summary = 'Loop: ' + firstLine(ld); extra = contLines(ld); }
                out.push('<details open>', '<summary>' + (note ? note + ' — ' : '') + summary + '</summary>', ''); out.push(...extra); out.push(...renderNarrativeLines(node.children || [], resolve, opt)); out.push('', '</details>', '');
            } else if (kind === 'switch_statement') {
                const sd = node.explanation || '`' + conditionPhrase(node) + '`';
                out.push('<details open>', '<summary>Branches: ' + firstLine(sd) + '</summary>', ''); out.push(...contLines(sd)); out.push(...renderNarrativeLines(node.children || [], resolve, opt)); out.push('', '</details>', '');
            } else {
                const frag = node.explanation || fallbackLeafPhrase(node); if (!frag) continue;
                if (note) { out.push('- ' + note); out.push('  <details><summary>what it does</summary>', ''); out.push(...frag.split('\n').map((l) => '  ' + l)); out.push('', '  </details>'); }
                else out.push(...bulletWithCont(firstLine(frag), contLines(frag)));
                if (resolve) for (const cn of node.calls || []) { const md = resolve(cn); if (md) { out.push('<details>', '<summary>`' + cn + '()` itself...</summary>', ''); out.push(...md.split('\n')); out.push('', '</details>'); } }
            }
        }
        return out;
    }
    function renderFunctionNarrativeMarkdown(trace, resolve, opt) { const tree = buildCompoundBlockTree(trace.lines); const lines = renderNarrativeLines(tree, resolve, opt); return lines.length ? lines.join('\n') : emptyNarrativeMessage(trace.lines); }

    // ================= 文字重排（engine/textrank.py）=================
    const STOP = S('the a an and or but if then else of to in on for with as by at from is are was were be been being this that these those it its into via not no so than which who whom whose what when where how also can will would should could may might do does did has have had i you he she we they them him her his our your their there here'.split(/\s+/));
    function splitSentences(text) {
        text = String(text || '').replace(/\s+/g, ' ').trim(); if (!text) return []; const out = []; let start = 0;
        for (let i = 0; i < text.length; i++) { const ch = text[i]; if ('。！？'.indexOf(ch) >= 0) { out.push(text.slice(start, i + 1).trim()); start = i + 1; } else if ('.!?'.indexOf(ch) >= 0 && (i + 1 === text.length || text[i + 1] === ' ')) { out.push(text.slice(start, i + 1).trim()); start = i + 1; } }
        if (start < text.length) out.push(text.slice(start).trim()); return out.filter(Boolean);
    }
    function embedBlock(text) {
        const filtered = text.replace(/[A-Za-z][A-Za-z0-9_'\-]*/g, (w) => (STOP.has(w.toLowerCase()) ? '' : w)).trim() || text;
        if (typeof globalThis._faSemEmbed === 'function') return globalThis._faSemEmbed(filtered, 256, typeof globalThis.FA_SEM_LEX !== 'undefined' ? globalThis.FA_SEM_LEX : undefined);
        const v = new Float32Array(256); for (const t of (filtered.toLowerCase().match(/[a-z0-9]+|[㐀-鿿]/g) || [])) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } v[h % 256] += 1; } let n = 0; for (let i = 0; i < 256; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; for (let i = 0; i < 256; i++) v[i] /= n; return v;
    }
    const cosine = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };
    function pagerank(adj, damping, maxIter, tol) {
        damping = damping || 0.85; maxIter = maxIter || 100; tol = tol || 1e-4; const n = adj.length; if (!n) return []; if (n === 1) return [1];
        const rs = adj.map((r) => r.reduce((a, b) => a + b, 0)); let sc = new Array(n).fill(1 / n);
        for (let it = 0; it < maxIter; it++) { const ns = []; for (let i = 0; i < n; i++) { let inc = 0; for (let j = 0; j < n; j++) { if (i === j || rs[j] === 0) continue; inc += adj[j][i] / rs[j] * sc[j]; } ns.push((1 - damping) / n + damping * inc); } let diff = 0; for (let i = 0; i < n; i++) diff += Math.abs(ns[i] - sc[i]); sc = ns; if (diff < tol) break; }
        const tot = sc.reduce((a, b) => a + b, 0) || 1; return sc.map((s) => s / tot);
    }
    function similarityGraph(blocks, minSim) { const n = blocks.length; const vs = blocks.map(embedBlock); const adj = Array.from({ length: n }, () => new Array(n).fill(0)); for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const s = cosine(vs[i], vs[j]); if (s >= minSim) { adj[i][j] = s; adj[j][i] = s; } } return adj; }
    function rankBlocks(blocks, minSim) { const n = blocks.length; if (!n) return []; const sc = pagerank(similarityGraph(blocks, minSim === undefined ? 0.05 : minSim)); return blocks.map((t, i) => ({ index: i, text: t, score: sc[i] })); }
    function clusterBlocks(blocks, minSim) {
        const n = blocks.length; if (!n) return []; const adj = similarityGraph(blocks, minSim === undefined ? 0.4 : minSim); const parent = Array.from({ length: n }, (_, i) => i);
        const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (adj[i][j] > 0) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
        const groups = {}; for (let i = 0; i < n; i++) (groups[find(i)] = groups[find(i)] || []).push(i);
        return Object.values(groups).map((m) => { let rep = m[0]; if (m.length > 1) { const sub = m.map((a) => m.map((b) => adj[a][b])); const sc = pagerank(sub); rep = m[sc.indexOf(Math.max(...sc))]; } return { representative_index: rep, representative_text: blocks[rep], member_indices: m.slice().sort((a, b) => a - b), member_count: m.length }; }).sort((a, b) => b.member_count - a.member_count);
    }
    function summarizeBlocks(blocks, topN, minSim, diversity) {
        topN = topN || 5; diversity = diversity === undefined ? 0.4 : diversity; const ranked = rankBlocks(blocks, minSim); if (!ranked.length) return { summary: [], kept_count: 0, total_count: 0 };
        const vs = blocks.map(embedBlock); const cen = {}; ranked.forEach((r) => { cen[r.index] = r.score; }); const byScore = ranked.slice().sort((a, b) => b.score - a.score);
        const floor = 0.4 * (byScore[0] ? byScore[0].score : 0); let qualified = byScore.filter((r) => r.score >= floor).map((r) => r.index); if (qualified.length < topN) qualified = byScore.slice(0, topN).map((r) => r.index);
        const pool = new Set(qualified.slice(0, Math.max(topN * 3, qualified.length))); const selected = []; const remaining = new Set(pool);
        while (remaining.size && selected.length < topN) { let best = null, bv = null; for (const idx of remaining) { const red = selected.length ? Math.max(...selected.map((s) => cosine(vs[idx], vs[s]))) : 0; const val = (1 - diversity) * cen[idx] - diversity * red; if (bv === null || val > bv) { bv = val; best = idx; } } selected.push(best); remaining.delete(best); }
        const kept = selected.slice().sort((a, b) => a - b); return { summary: kept.map((i) => blocks[i]), kept_count: kept.length, total_count: blocks.length };
    }
    // 從一段文字挑出最相關的句子（保持原順序）
    function rerank(text, keywords, maxSentences) {
        const sents = splitSentences(text); if (sents.length <= (maxSentences || 2)) return sents.join(' ');
        const kw = new Set((keywords || []).map((k) => String(k).toLowerCase()).filter((k) => k.length > 1));
        const tok = (s) => new Set(s.toLowerCase().match(/[a-z_][a-z0-9_]+|[一-鿿]{2,}/g) || []); const sets = sents.map(tok);
        const score = sents.map((s, i) => { let sc = 0; for (const w of sets[i]) if (kw.has(w)) sc += 2; for (let j = 0; j < sents.length; j++) if (j !== i) { let o = 0; for (const w of sets[i]) if (sets[j].has(w)) o++; sc += o / Math.max(4, sets[i].size + sets[j].size); } return sc - i * 0.01; });
        const idx = score.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, maxSentences || 2).map((x) => x[1]).sort((a, b) => a - b);
        return idx.map((i) => sents[i]).join(' ');
    }
    function extractKeywords(text, topN, windowSize) {
        topN = topN || 10; windowSize = windowSize || 4; const words = [];
        for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_'\-]*|[一-鿿]+/g)) { const ch = m[0]; if (/^[一-鿿]+$/.test(ch)) { for (let i = 0; i < ch.length - 1; i++) words.push(ch.slice(i, i + 2)); } else { const l = ch.toLowerCase(); if (!STOP.has(l) && l.length > 2) words.push(l); } }
        const vocab = Array.from(new Set(words)).sort(); if (!vocab.length) return []; const idx = {}; vocab.forEach((w, i) => { idx[w] = i; }); const n = vocab.length; const adj = Array.from({ length: n }, () => new Array(n).fill(0));
        for (let i = 0; i < words.length; i++) for (let j = i + 1; j < Math.min(i + windowSize, words.length); j++) { const a = idx[words[i]], b = idx[words[j]]; if (a !== b) { adj[a][b] += 1; adj[b][a] += 1; } }
        const sc = pagerank(adj); return Array.from({ length: n }, (_, i) => i).sort((a, b) => sc[b] - sc[a]).slice(0, topN).map((i) => ({ word: vocab[i], score: sc[i] }));
    }
    const lengthUnits = (text) => { const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length; return cjk + (text.replace(/[㐀-鿿豈-﫿]+/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length; };
    function selectWithinBudget(sentences, target, diversity) {
        diversity = diversity === undefined ? 0.45 : diversity; const ranked = rankBlocks(sentences); if (!ranked.length) return []; const vs = sentences.map(embedBlock); const cen = {}; ranked.forEach((r) => { cen[r.index] = r.score; });
        const remaining = new Set(sentences.map((_, i) => i)); const selected = []; let used = 0;
        while (remaining.size) { let best = null, bv = null; for (const idx of remaining) { const red = selected.length ? Math.max(...selected.map((s) => cosine(vs[idx], vs[s]))) : 0; const val = (1 - diversity) * cen[idx] - diversity * red; if (bv === null || val > bv) { bv = val; best = idx; } } const bu = lengthUnits(sentences[best]); if (selected.length && used + bu > target) break; selected.push(best); used += bu; remaining.delete(best); if (used >= target) break; }
        return selected.sort((a, b) => a - b);
    }
