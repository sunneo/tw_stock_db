// 作曲樹:AI 當作曲家(設計見 DESIGN.music.md「作曲樹」)。由上而下切成小而封閉的節點,每個節點一題、程式核對、失敗只重做該節點,最後由程式組裝成整首曲子。
//   節點:form 曲式 → harmony.<組> 和聲(羅馬數字和弦串)→ voices.<組>.texture／bass／drum 聲部分工(字母)→ motif 主題動機(音級加時值)→ 程式發展與組裝
//   組(group):main(前奏、主歌、主題、尾奏)、lift(副歌、再現)、contrast(橋段、發展)
//   plan(res, { ask, timeoutMs, attempts, onStep, onlyIds }) → Promise<tree>   res 是 FaComposePlan.decide 的結果(要它的 fields／options)
//   compose(tree, seed) → { song, style, options, seed, tries, warnings, sections, styleNote, fixes }   同樹同種子同曲;不丟例外(整個壞掉就退回範本作曲並寫進 warnings)
//   redo(tree, id, opts) 只重問一個節點;setNode(tree, id, value) 使用者自己給值(標 user,會核對);describe(tree) 結果卡片的樹狀列;learnNodes(tree) 可回流的 AI 節點
//   tree 是純 JSON:{ v, style, key, tempo, bars, mode, lead, nodes:{ id:{ value, source:'ai'|'fixed'|'template'|'user', tries, raw, error } } }
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./midi_core.js'), require('./music_compose.js')); else root.FaComposeTree = factory(root.FaMidi || (typeof FaMidi !== 'undefined' ? FaMidi : undefined), root.FaMidiCompose || (typeof FaMidiCompose !== 'undefined' ? FaMidiCompose : undefined)); })(typeof self !== 'undefined' ? self : this, function (M, C) {
  'use strict';
  const PPQ = 480, L = 'ABCDEFGH';
  const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
  const DUR = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25 };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function rng(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const stripThink = (raw) => { let t = String(raw == null ? '' : raw); t = t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ''); const open = t.search(/<think(?:ing)?>/i); if (open >= 0) t = t.slice(0, open); t = t.replace(/^[\s\S]*<\/think(?:ing)?>/i, ''); return t.replace(/```[a-z]*/gi, '').trim(); };
  const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('逾時 ' + Math.round(ms / 1000) + ' 秒')), ms); Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

  // ---------- 曲式 ----------
  const ROLE = { 前奏: 'intro', 主歌: 'verse', 副歌: 'chorus', 橋段: 'bridge', 尾奏: 'outro', 主題: 'theme', 發展: 'dev', 再現: 'recap' };
  const WEIGHT = { intro: 0.5, verse: 1, chorus: 1, bridge: 0.75, outro: 0.5, theme: 1, dev: 1, recap: 1 };
  const ENERGY = { intro: 0.45, verse: 0.65, chorus: 1, bridge: 0.75, outro: 0.4, theme: 0.7, dev: 0.85, recap: 1 };
  const GROUP = { intro: 'main', verse: 'main', theme: 'main', outro: 'main', chorus: 'lift', recap: 'lift', bridge: 'contrast', dev: 'contrast' };
  const GROUP_NAME = { main: '主段', lift: '高潮段', contrast: '對比段' };
  const FORMS = [
    ['A', '兩段式(主歌、副歌)', '主歌 副歌'],
    ['B', '流行完整(前奏、主歌、副歌、主歌、副歌、尾奏)', '前奏 主歌 副歌 主歌 副歌 尾奏'],
    ['C', '帶橋段(前奏、主歌、副歌、主歌、副歌、橋段、副歌、尾奏)', '前奏 主歌 副歌 主歌 副歌 橋段 副歌 尾奏'],
    ['D', '簡短(前奏、主歌、副歌、尾奏)', '前奏 主歌 副歌 尾奏'],
    ['E', '古典三段(主題、發展、再現)', '主題 發展 再現'],
    ['F', '單段循環(只有主歌)', '主歌']
  ].map((f) => ({ id: f[0], name: f[1], names: f[2].split(' ') }));
  function formOf(id) { return FORMS.find((f) => f.id === id) || FORMS[1]; }
  function feasibleForms(bars) { return FORMS.filter((f) => f.names.length * 2 <= bars); }
  function defaultForm(bars) { return bars >= 24 ? 'C' : bars >= 16 ? 'B' : bars >= 8 ? 'D' : bars >= 4 ? 'A' : 'F'; }
  // 把總小節數按權重分給各段(每段至少 2 小節,最大餘數法),回傳 [{ name, role, group, from, to, energy }]
  function layout(formId, bars) {
    const f = formOf(formId); const names = f.names.length * 2 <= bars ? f.names : ['主歌']; const roles = names.map((n) => ROLE[n]);
    const n = names.length; let rest = bars - 2 * n; const wsum = roles.reduce((a, r) => a + WEIGHT[r], 0); const raw = roles.map((r) => (rest * WEIGHT[r]) / wsum);
    const give = raw.map((x) => Math.floor(x)); let left = rest - give.reduce((a, b) => a + b, 0); raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach((p) => { if (left > 0) { give[p[1]]++; left--; } });
    let at = 0; return names.map((nm, i) => { const len = 2 + give[i]; const s = { name: nm, role: roles[i], group: GROUP[roles[i]], from: at, to: at + len, energy: ENERGY[roles[i]] }; at += len; return s; });
  }
  function checkForm(id, bars) { // 順序合法:副歌／再現前面要有主歌／主題;尾奏在最後;總長對得上
    const f = FORMS.find((x) => x.id === id); if (!f) return '沒有這個曲式字母'; if (f.names.length * 2 > bars) return '曲子只有 ' + bars + ' 小節,放不下「' + f.name.slice(0, 8) + '」';
    const secs = layout(id, bars); if (secs[secs.length - 1].to !== bars) return '小節數加不起來'; let seen = false;
    for (let i = 0; i < secs.length; i++) { const r = secs[i].role; if (r === 'verse' || r === 'theme') seen = true; if ((r === 'chorus' || r === 'recap') && !seen) return '副歌前面沒有主歌'; if (r === 'outro' && i !== secs.length - 1) return '尾奏不在最後'; }
    return '';
  }
  function groupsOf(formId, bars) { const out = []; layout(formId, bars).forEach((s) => { if (out.indexOf(s.group) < 0) out.push(s.group); }); return out; }

  // ---------- 和聲 ----------
  // 記號 → { d: 級數(0 起算), q: 和弦性質 };大調與小調各一份封閉詞彙
  const VOC = {
    major: { I: [0, 'M'], ii: [1, 'm'], iii: [2, 'm'], IV: [3, 'M'], V: [4, 'M'], vi: [5, 'm'], V7: [4, '7'], ii7: [1, 'm7'], Imaj7: [0, 'M7'], IVmaj7: [3, 'M7'], vi7: [5, 'm7'], I7: [0, '7'], IV7: [3, '7'] },
    minor: { i: [0, 'm'], ii: [1, 'd'], III: [2, 'M'], iv: [3, 'm'], v: [4, 'm'], V: [4, 'M'], VI: [5, 'M'], VII: [6, 'M'], V7: [4, '7'], i7: [0, 'm7'], iv7: [3, 'm7'], VImaj7: [5, 'M7'], IIImaj7: [2, 'M7'] }
  };
  const TONIC_START = { major: ['I', 'Imaj7', 'I7', 'vi', 'IV', 'vi7', 'IVmaj7', 'ii', 'ii7'], minor: ['i', 'i7', 'VI', 'iv', 'VImaj7', 'III', 'ii'] };
  function tokenOf(mode, t) { // 寬容:大小寫、全形、°/dim 等;找不到(或大小寫不能唯一對上)回 null
    t = String(t || '').replace(/[()（）\[\]「」『』"'`*]/g, '').replace(/°|o$/g, '').trim(); if (!t) return null; const voc = VOC[mode]; if (voc[t]) return t;
    const hit = Object.keys(voc).filter((k) => k.toLowerCase() === t.toLowerCase()); return hit.length === 1 ? hit[0] : null;
  }
  const SEP = /[\s,，、|｜→>＞\-–—/／]+/;
  function parseChords(raw, mode) { // 在回覆裡找最長的一串合法和弦(該行大部分要是和弦,英文思考文字不算);回傳 null＝讀不懂
    const lines = stripThink(raw).split(/\n/); let best = null;
    for (const line of lines) {
      const toks = line.replace(/^[^:：]{0,12}[:：]/, '').split(SEP).filter(Boolean); if (!toks.length) continue; let run = [], cur = [];
      toks.forEach((t) => { const k = tokenOf(mode, t); if (k) cur.push(k); else { if (cur.length > run.length) run = cur; cur = []; } }); if (cur.length > run.length) run = cur;
      if (run.length >= 2 && run.length >= toks.length * 0.6 && (!best || run.length > best.length)) best = run;
    }
    return best ? best.slice(0, 8) : null;
  }
  function checkChords(list, mode, group) { // 回傳 '' 或不合格原因
    if (list.length < 2 || list.length > 8) return '和弦數量要 2 到 8 個(你給了 ' + list.length + ' 個)';
    if (new Set(list).size < 2) return '全部是同一個和弦';
    for (let i = 2; i < list.length; i++) if (list[i] === list[i - 1] && list[i] === list[i - 2]) return '同一個和弦連續出現三次以上';
    if (group === 'main' && TONIC_START[mode].indexOf(list[0]) < 0) return '主段的第一個和弦要從主和弦或它的近親開始(' + TONIC_START[mode].slice(0, 4).join('、') + ')';
    return '';
  }
  const chordOf = (mode, tok) => { const v = VOC[mode][tok]; return { d: v[0], q: v[1] }; };
  function tokenFor(mode, c) { const voc = VOC[mode]; return Object.keys(voc).find((k) => voc[k][0] === c.d && voc[k][1] === c.q) || null; }
  const GENERIC = { major: { main: 'I V vi IV', lift: 'IV I V vi', contrast: 'vi IV I V' }, minor: { main: 'i VI III VII', lift: 'iv i VII i', contrast: 'VI VII i v' } };
  function templateChords(style, mode, group) { // 風格範本的和弦進行(調式相同時)換成記號;對不上就用通用進行
    const st = C.STYLES[style]; const idx = { main: 0, lift: 1, contrast: 2 }[group] || 0;
    if (st && st.mode === mode) { const toks = st.progs[idx % st.progs.length].map((c) => tokenFor(mode, { d: c.d, q: c.q })); if (toks.every(Boolean)) return toks; }
    return GENERIC[mode][group].split(' ');
  }

  // ---------- 聲部 ----------
  const TEXTURES = [['A', '柱式和弦(每小節按一次)', 'X...............', 'hold'], ['B', '分解和弦(八分音符輪流彈和弦音)', 'x.x.x.x.x.x.x.x.', 'arp'], ['C', '切分(反拍按和弦)', '..x...x...x...x.', 'hold'], ['D', '持續鋪底(長音墊底)', 'X.......x.......', 'hold']];
  const BASSES = [['A', '根音四分音符', 'X...x...x...x...', ''], ['B', '根音八分音符', 'X.x.x.x.X.x.x.x.', ''], ['C', '行走低音(根音、三音、五音、三音)', 'X...x...x...x...', 'walk'], ['D', '搖擺(根音加五音)', 'X.....x.X.....x.', 'oompah'], ['E', '持續根音(每小節一個長音)', 'X...............', '']];
  const tex = (l) => TEXTURES.find((x) => x[0] === l) || TEXTURES[0], bas = (l) => BASSES.find((x) => x[0] === l) || BASSES[0];
  function drumChoices(style) { const st = C.STYLES[style] || {}; const pats = (st.drum || []).slice(0, 4); return pats.map((p, i) => [L[i], '鼓型 ' + p, p]).concat([['X', '不用鼓', null]]); }
  const drum = (style, l) => drumChoices(style).find((x) => x[0] === l) || null;
  function templateVoice(style, group, kind) {
    const st = C.STYLES[style] || C.STYLES.pop; const hi = group === 'lift';
    if (kind === 'texture') return { classical: 'B', waltz: 'A', jazz: 'C', folk: 'B', lofi: 'D', edm: 'C' }[style] || (hi ? 'C' : 'A');
    if (kind === 'bass') return { root8: 'B', walk: 'C', oompah: 'D', root4: 'A' }[st.bass] || 'A';
    return st.drum ? (group === 'main' ? 'A' : L[Math.min(1, st.drum.length - 1)]) : 'X';
  }

  // ---------- 動機 ----------
  const MOTIF_RE = /^([1-7])([+\-]?)[:：]?(w|h|q|e|s)(\.?)$/i;
  function parseMotif(raw) {
    const lines = stripThink(raw).split(/\n/); let best = null;
    for (const line of lines) {
      const toks = line.replace(/^[^:：\d]{0,12}[:：]\s*(?=[1-7])/, '').split(/[\s,，、|｜→>＞]+/).filter(Boolean); let cur = [], run = [];
      toks.forEach((t) => { const m = MOTIF_RE.exec(t.replace(/＋/g, '+').replace(/－/g, '-')); if (m) cur.push({ deg: Number(m[1]), oct: m[2] === '+' ? 1 : m[2] === '-' ? -1 : 0, dur: m[3].toLowerCase(), dot: !!m[4] }); else { if (cur.length > run.length) run = cur; cur = []; } }); if (cur.length > run.length) run = cur;
      if (run.length >= 3 && run.length >= toks.length * 0.6 && (!best || run.length > best.length)) best = run;
    }
    return best;
  }
  const beatsOf = (n) => DUR[n.dur] * (n.dot ? 1.5 : 1);
  const motifText = (ns) => ns.map((n) => n.deg + (n.oct > 0 ? '+' : n.oct < 0 ? '-' : '') + ':' + n.dur + (n.dot ? '.' : '')).join(' ');
  const idxOf = (n) => (n.deg - 1) + 7 * n.oct;
  // 核對與小幅修正(總拍數差一點就調整最後一個音的時值);回傳 { notes, fixed, problem }
  function checkMotif(ns, bpb) {
    if (!ns || ns.length < 3) return { problem: '音符太少(至少 3 個)' }; if (ns.length > 20) return { problem: '音符太多(最多 20 個)' };
    let total = ns.reduce((a, n) => a + beatsOf(n), 0), fixed = false; const goals = [2 * bpb, 3 * bpb, 4 * bpb];
    const goal = goals.reduce((b, g) => (Math.abs(g - total) < Math.abs(b - total) ? g : b), goals[0]);
    ns = ns.map((n) => Object.assign({}, n));
    if (Math.abs(total - goal) > 1e-6) {
      const diff = goal - total; if (Math.abs(diff) > 1.01) return { problem: '時值加起來是 ' + total + ' 拍,要剛好 ' + 2 * bpb + ' 拍(2 小節)、' + 3 * bpb + ' 拍或 ' + 4 * bpb + ' 拍' };
      const last = ns[ns.length - 1]; const want = beatsOf(last) + diff; const hit = Object.keys(DUR).map((k) => [k, false]).concat(Object.keys(DUR).map((k) => [k, true])).find((p) => Math.abs(DUR[p[0]] * (p[1] ? 1.5 : 1) - want) < 1e-6);
      if (!hit) return { problem: '時值加起來是 ' + total + ' 拍,差一點又調不好,要剛好 ' + goal + ' 拍' }; last.dur = hit[0]; last.dot = hit[1]; fixed = true;
    }
    const idx = ns.map(idxOf); if (Math.min.apply(null, idx) < -3 || Math.max.apply(null, idx) > 10) return { problem: '音域太寬' };
    for (let i = 1; i < idx.length; i++) if (Math.abs(idx[i] - idx[i - 1]) > 7) return { problem: '第 ' + i + ' 到 ' + (i + 1) + ' 個音跳超過八度' };
    if (new Set(idx).size < 2) return { problem: '所有音都一樣高' };
    return { notes: ns, fixed };
  }
  function templateMotif(style, bpb) { // 程式依風格節奏型產生的動機(固定種子,同風格同拍號同一個)
    const st = C.STYLES[style] || C.STYLES.pop; const r = rng(7 + style.length * 13); const pick = (a) => a[Math.floor(r() * a.length) % a.length]; const out = [];
    let deg = pick([1, 3, 5]);
    for (let b = 0; b < 2; b++) {
      const rh = pick(st.melody).split(' '); let tot = 0; rh.forEach((x) => { tot += DUR[x]; }); const k = bpb / tot;
      rh.forEach((x, i) => { const d = DUR[x] * k; const key = Object.keys(DUR).find((q) => Math.abs(DUR[q] - d) < 1e-6); const dot = !key ? Object.keys(DUR).find((q) => Math.abs(DUR[q] * 1.5 - d) < 1e-6) : null; if (b === 1 && i === rh.length - 1) deg = pick([1, 3, 5]); else if (out.length) deg = clamp(deg + pick([-2, -1, -1, 1, 1, 2]), 1, 7); out.push({ deg, oct: 0, dur: key || dot || 'q', dot: !key && !!dot }); });
    }
    const total = out.reduce((a, n) => a + beatsOf(n), 0); const chk = checkMotif(out, bpb); return chk.notes && Math.abs(total - 2 * bpb) < 1e-6 ? chk.notes : [{ deg: 1, oct: 0, dur: 'q', dot: false }, { deg: 3, oct: 0, dur: 'q', dot: false }, { deg: 5, oct: 0, dur: 'q', dot: false }, { deg: 3, oct: 0, dur: 'q', dot: false }].concat(bpb === 4 ? [{ deg: 4, oct: 0, dur: 'q', dot: false }, { deg: 3, oct: 0, dur: 'q', dot: false }, { deg: 2, oct: 0, dur: 'q', dot: false }, { deg: 1, oct: 0, dur: 'q', dot: false }] : [{ deg: 4, oct: 0, dur: 'q', dot: false }, { deg: 2, oct: 0, dur: 'q', dot: false }, { deg: 1, oct: 0, dur: 'q', dot: false }, { deg: 1, oct: 0, dur: 'q', dot: false }].slice(0, 2));
  }

  // ---------- 節點表 ----------
  const bpbOf = (style) => { const ts = (C.STYLES[style] || C.STYLES.pop).timesig; return ts[0] * (4 / ts[1]); };
  function nodeIds(t) { // 現在這棵樹需要哪些節點(依曲式的組)
    const ids = ['form']; const gs = groupsOf(t.nodes.form ? t.nodes.form.value : defaultForm(t.bars), t.bars);
    gs.forEach((g) => ids.push('harmony.' + g)); gs.forEach((g) => { ids.push('voices.' + g + '.texture', 'voices.' + g + '.bass'); if ((C.STYLES[t.style] || {}).drum) ids.push('voices.' + g + '.drum'); }); ids.push('motif'); return ids;
  }
  const LABEL = (id) => { const p = id.split('.'); if (id === 'form') return '曲式'; if (id === 'motif') return '主題動機'; if (p[0] === 'harmony') return GROUP_NAME[p[1]] + '和聲'; return GROUP_NAME[p[1]] + ({ texture: '伴奏織體', bass: '貝斯型', drum: '鼓型' })[p[2]]; };
  const letterOpts = (t, id) => {
    if (id === 'form') return feasibleForms(t.bars).map((f) => [f.id, f.name]);
    const k = id.split('.')[2]; if (k === 'texture') return TEXTURES.map((x) => [x[0], x[1]]); if (k === 'bass') return BASSES.map((x) => [x[0], x[1]]); return drumChoices(t.style).map((x) => [x[0], x[1]]);
  };
  function templateValue(t, id) {
    if (id === 'form') return defaultForm(t.bars); if (id === 'motif') return motifText(templateMotif(t.style, bpbOf(t.style)));
    const p = id.split('.'); if (p[0] === 'harmony') return templateChords(t.style, t.mode, p[1]).join(' '); return templateVoice(t.style, p[1], p[2]);
  }
  // 核對一個節點的值(字串),回傳 { value, fixed } 或 { problem }
  function validateNode(t, id, value) {
    const v = String(value == null ? '' : value).trim();
    if (id === 'motif') { const ns = parseMotif(v); if (!ns) return { problem: '動機格式不對(要像 1:q 3:q 5:e 4:e 3:h)' }; const c = checkMotif(ns, bpbOf(t.style)); return c.problem ? { problem: c.problem } : { value: motifText(c.notes), fixed: c.fixed }; }
    const p = id.split('.');
    if (p[0] === 'harmony') { const l = parseChords(v, t.mode); if (!l) return { problem: '沒有讀到和弦串' }; const pr = checkChords(l, t.mode, p[1]); return pr ? { problem: pr } : { value: l.join(' ') }; }
    const c = v.toUpperCase().charAt(0); if (id === 'form') { const pr = checkForm(c, t.bars); return pr ? { problem: pr } : { value: c }; }
    if (!letterOpts(t, id).some((x) => x[0] === c)) return { problem: '不是合法選項字母' }; return { value: c };
  }

  // ---------- 題目 ----------
  const ctxLine = (t, res) => '曲子:' + (C.STYLES[t.style] ? C.STYLES[t.style].name : t.style) + '風格、' + t.key + (t.mode === 'minor' ? ' 小調' : ' 大調') + '、' + t.tempo + ' 拍/分、' + t.bars + ' 小節' + ((res && res.mood) ? '、情緒:' + res.mood : '') + (t.purpose ? '、用途:' + t.purpose : '') + (t.task ? '\n需求:' + String(t.task).slice(0, 300) : '');
  function questionOf(t, id, strict) {
    const ctx = ctxLine(t, t.moodName ? { mood: t.moodName } : null); const sfx = strict ? '\n【上一次你回的是「' + (strict.raw || '(空白)') + '」,不合格:' + (strict.why || '格式不對') + '。這次只回答案本身,第一個字元就是答案,後面什麼都不要寫。】' : '';
    if (id === 'form' || id.indexOf('voices.') === 0) {
      const opts = letterOpts(t, id), letters = opts.map((x) => x[0]).join(''); const what = id === 'form' ? '整首曲子的曲式(段落安排)' : GROUP_NAME[id.split('.')[1]] + '的' + ({ texture: '和弦伴奏織體', bass: '貝斯彈法', drum: '鼓型' })[id.split('.')[2]];
      const shots = { form: '曲子:16 小節的輕快流行歌 → B\n曲子:6 小節的短小提示音 → A', texture: '曲子:溫柔的抒情歌 → B\n曲子:緊湊的電子舞曲 → C', bass: '曲子:爵士 → C\n曲子:抒情慢歌 → A', drum: '曲子:搖滾 → B\n曲子:鋼琴獨奏 → X' }[id === 'form' ? 'form' : id.split('.')[2]];
      return { system: '你是作曲家。這一題要決定:' + what + '。\n選項:' + opts.map((x) => x[0] + '=' + x[1]).join('、') + '\n只回一個字母(' + letters.split('').join('、') + '),不要解釋、不要思考過程、不要標點。\n範例:\n' + shots + sfx, user: ctx + ' →' };
    }
    const g = id.split('.')[1];
    if (id.indexOf('harmony.') === 0) {
      const voc = Object.keys(VOC[t.mode]).join(' '); const ex = t.mode === 'minor' ? 'i VI III VII' : 'I V vi IV';
      return { system: '你是作曲家。這一題要寫「' + GROUP_NAME[g] + '」的和弦進行,一個和弦一小節,共 4 個(2 到 8 個都可以),會循環到這一段結束。\n只能用這些羅馬數字和弦:' + voc + '\n只回和弦串,用空白隔開,不要解釋、不要思考過程。\n範例:\n曲子:大調流行主歌 → I V vi IV\n曲子:大調爵士 → ii7 V7 Imaj7 vi7\n曲子:小調電子舞曲 → i VI III VII' + (g === 'main' ? '\n主段第一個和弦要從主和弦開始(大調 I、小調 i)。' : g === 'lift' ? '\n高潮段要比主段更有力,常從 IV(小調 iv 或 VI)開始。' : '\n對比段要和主段不同,常從 vi(小調 VI)開始。') + '\n這一題本調:' + (t.mode === 'minor' ? '小調(例 ' + ex + ')' : '大調(例 ' + ex + ')') + sfx, user: ctx + ' →' };
    }
    const bpb = bpbOf(t.style); const prog = (t.nodes['harmony.main'] && t.nodes['harmony.main'].value) || templateChords(t.style, t.mode, 'main').join(' ');
    return { system: '你是作曲家。這一題要寫整首曲子的「主題動機」:' + 2 * bpb + ' 拍(2 小節,每小節 ' + bpb + ' 拍)的短旋律,之後程式會把它重複、模進、反行、變奏展開成整首。\n格式:每個音寫「音級:時值」,用空白隔開。音級 1～7(1 是主音),後面加 + 代表高八度、- 代表低八度;時值 w=全音符(4 拍) h=二分(2 拍) q=四分(1 拍) e=八分(0.5 拍) s=十六分(0.25 拍),時值後加 . 代表附點。\n所有時值加起來必須剛好 ' + 2 * bpb + ' 拍。強拍盡量落在和弦音上,結尾落在 1、3 或 5。\n只回動機,不要解釋、不要思考過程。\n範例:\n曲子:輕快流行 → 1:q 3:q 5:e 4:e 3:h\n曲子:抒情 → 5-:h 1:q. 2:e 3:h' + sfx, user: ctx + '\n主段和弦:' + prog + ' →' };
  }

  // 字母題的寬容解析
  function parseLetterIn(raw, allowed, names) {
    const t = stripThink(raw); if (!t) return null; const ok = (c) => { c = String(c || '').toUpperCase(); return c.length === 1 && allowed.indexOf(c) >= 0 ? c : null; };
    const js = t.match(/\{[\s\S]*?\}/); if (js) { try { const o = JSON.parse(js[0]); const c = ok(String(Object.values(o)[0] == null ? '' : Object.values(o)[0]).trim().charAt(0)); if (c) return c; } catch (_) { /* */ } }
    const head = /^[\s"'「『(（\[*]*([A-Za-z])(?![A-Za-z])/.exec(t); if (head && (head[1] === head[1].toUpperCase() || t.length <= 3) && ok(head[1])) return ok(head[1]);
    const ans = [...t.matchAll(/(?:答案|選擇|選項|我選|answer|choice|option)\s*(?:是|為|:|：|=|is)?\s*["「『(（*]*([A-Z])(?![A-Za-z])/gi)]; for (let i = ans.length - 1; i >= 0; i--) if (ans[i][1] === ans[i][1].toUpperCase() && ok(ans[i][1])) return ok(ans[i][1]);
    if (t.length <= 24) { const hit = names.filter((x) => t.indexOf(String(x[1]).replace(/\(.*$/, '')) >= 0); if (hit.length === 1) return hit[0][0]; }
    return null;
  }

  // ---------- 規劃:逐節點提問 ----------
  function newTree(res, o) {
    const f = (res && res.fields) || {}; const opt = (res && res.options) || {}; const style = C.STYLES[opt.style || f.style] ? (opt.style || f.style) : 'pop'; const st = C.STYLES[style];
    const mode = f.mode === 'A' ? 'major' : f.mode === 'B' ? 'minor' : st.mode;
    return { v: 1, style, key: opt.key || f.key || 'C', tempo: opt.tempo || Math.round((st.tempo[0] + st.tempo[1]) / 2), bars: clamp(Number(opt.bars || f.bars) || 16, 4, 64), mode, lead: Number.isInteger(opt.lead) ? opt.lead : null, title: opt.title || '', purpose: f.purpose || '', task: (o && o.task) || '', moodName: '', nodes: {} };
  }
  async function fill(t, o) {
    o = o || {}; const step = o.onStep || (() => {}); const attempts = o.attempts || 2, timeoutMs = o.timeoutMs || 25000; const only = o.onlyIds ? new Set(o.onlyIds) : null;
    let stopWhy = '', failRun = 0, anyOk = false, calls = 0;
    // 節點會隨曲式改變:先放好範本預設,再依序問(曲式問完才知道有哪些組)
    for (let guard = 0; guard < 40; guard++) {
      const ids = nodeIds(t); const next = ids.find((id) => (only ? only.has(id) && !(t.nodes[id] && t.nodes[id].done) : !t.nodes[id])); if (!next) break;
      const tpl = templateValue(t, next); const nd = t.nodes[next] = { value: tpl, source: 'template', tries: 0, raw: '', error: '', done: true };
      if (o.learnedNodes && o.learnedNodes[next]) { const lr = validateNode(t, next, o.learnedNodes[next]); if (!lr.problem) { nd.value = lr.value; nd.source = 'learned'; continue; } }
      if (typeof o.ask !== 'function') { nd.error = o.noAiReason || '沒有可用的 AI(離線或沒有設定)'; continue; }
      if (stopWhy) { nd.error = '沒有問(' + stopWhy + ')'; continue; }
      let netFail = 0;
      for (let i = 0; i < attempts && nd.source !== 'ai' && nd.source !== 'fixed'; i++) {
        const q = questionOf(t, next, i > 0 && !nd.error.startsWith('連線') ? { raw: nd.raw.slice(0, 60), why: nd.error } : null); nd.tries = i + 1; calls++; step('問「' + LABEL(next) + '」第 ' + (i + 1) + ' 次…');
        try {
          const raw = await withTimeout(o.ask(q.system, q.user, { node: next, strict: i > 0 }), timeoutMs); nd.raw = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 80); nd.error = '';
          let r; if (next === 'motif' || next.indexOf('harmony.') === 0) r = validateNode(t, next, stripThink(raw)); else { const opts = letterOpts(t, next); const c = parseLetterIn(raw, opts.map((x) => x[0]).join(''), opts); r = c ? validateNode(t, next, c) : { problem: nd.raw ? '讀不懂' : '回了空白' }; }
          if (r.problem) { nd.error = r.problem + (nd.raw ? '(' + nd.raw + ')' : ''); step('「' + LABEL(next) + '」' + nd.error); } else { nd.value = r.value; nd.source = r.fixed ? 'fixed' : 'ai'; nd.error = ''; step('「' + LABEL(next) + '」AI 答:' + String(r.value).slice(0, 40) + (r.fixed ? '(程式修正了時值)' : '')); }
        } catch (e) { nd.error = '連線' + String((e && e.message) || e); netFail++; step('「' + LABEL(next) + '」問 AI 失敗:' + nd.error); }
      }
      if (nd.source === 'ai' || nd.source === 'fixed') { anyOk = true; failRun = 0; } else failRun++;
      if (netFail >= attempts) stopWhy = '前一個節點連線連續失敗:' + nd.error; else if (!anyOk && failRun >= 3) stopWhy = '前三個節點都沒答對,這個模型看來不適合,其餘用範本預設';
    }
    t.calls = (t.calls || 0) + calls; return t;
  }
  async function plan(res, o) { const t = newTree(res, o); if (o && o.moodName) t.moodName = o.moodName; return fill(t, o); }
  async function redo(t, id, o) { // 只重問一個節點,其餘不動;曲式變了,新出現的組補上範本預設(再問)
    const t2 = JSON.parse(JSON.stringify(t)); delete t2.nodes[id]; const ids = new Set([id]); await fill(t2, Object.assign({}, o, { onlyIds: [id] }));
    if (id === 'form') await fill(t2, Object.assign({}, o, { onlyIds: nodeIds(t2).filter((x) => !t2.nodes[x]) })); void ids; return t2;
  }
  function rebase(old, res) { // 使用者改了風格、調、速度、長度等規格:保留還合法的節點(含 AI 決定的),其餘用範本
    const t = newTree(res, { task: old.task }); t.moodName = old.moodName; t.purpose = old.purpose || t.purpose;
    for (let g = 0; g < 40; g++) { const id = nodeIds(t).find((x) => !t.nodes[x]); if (!id) break; const o2 = old.nodes[id]; const r = o2 ? validateNode(t, id, o2.value) : null; t.nodes[id] = r && !r.problem ? { value: r.value, source: o2.source, tries: o2.tries, raw: o2.raw, error: '', done: true } : { value: templateValue(t, id), source: 'template', tries: 0, raw: '', error: '', done: true }; }
    return t;
  }
  function usable(t) { return Object.keys(t.nodes).some((id) => t.nodes[id].source !== 'template'); }
  function setNode(t, id, value) { // 使用者給值(標 user);回傳 { tree } 或 { error }
    const r = validateNode(t, id, value); if (r.problem) return { error: r.problem }; const t2 = JSON.parse(JSON.stringify(t)); t2.nodes[id] = { value: r.value, source: 'user', tries: 0, raw: '', error: '', done: true };
    nodeIds(t2).forEach((x) => { if (!t2.nodes[x]) t2.nodes[x] = { value: templateValue(t2, x), source: 'template', tries: 0, raw: '', error: '', done: true }; }); return { tree: t2 };
  }

  // ---------- 組裝 ----------
  function build(t, seed) {
    const st = C.STYLES[t.style]; const r = rng(seed); const bpb = bpbOf(t.style); const steps = t.mode === 'minor' ? MINOR : MAJOR; const pc0 = C.KEYS[t.key] == null ? 0 : C.KEYS[t.key];
    const baseP = 60 + pc0 - (pc0 > 6 ? 12 : 0); const pitchOf = (i) => baseP + 12 * Math.floor(i / 7) + steps[((i % 7) + 7) % 7]; const nodeV = (id) => (t.nodes[id] || { value: templateValue(t, id) }).value;
    const secs = layout(nodeV('form'), t.bars); const cells = bpb * 4; const fixes = { melody: 0 }; const problems = [];
    const harm = {}; groupsOf(nodeV('form'), t.bars).forEach((g) => { harm[g] = nodeV('harmony.' + g).split(' ').map((k) => chordOf(t.mode, k)); });
    const voice = (g) => ({ tex: tex(nodeV('voices.' + g + '.texture')), bas: bas(nodeV('voices.' + g + '.bass')), drm: st.drum ? drum(t.style, nodeV('voices.' + g + '.drum')) : null });
    const motif = checkMotif(parseMotif(nodeV('motif')), bpb).notes || templateMotif(t.style, bpb); const mBars = Math.max(1, Math.round(motif.reduce((a, n) => a + beatsOf(n), 0) / bpb));
    const lead = [], chordT = [], bassT = [], drumT = []; const add = (arr, tb, d, n, v) => { arr.push({ t: Math.round(tb * PPQ), d: Math.max(1, Math.round(d * PPQ)), n: clamp(Math.round(n), 0, 127), v: clamp(Math.round(v), 1, 127) }); };
    const chordsPerBar = []; let lastRoot = 0;
    secs.forEach((s) => {
      const prog = harm[s.group]; const vo = voice(s.group); const vf = 0.6 + 0.4 * s.energy; const quiet = s.role === 'intro' || s.role === 'outro';
      for (let b = s.from; b < s.to; b++) {
        const lastBar = b === t.bars - 1; const ch = lastBar ? { d: 0, q: t.mode === 'minor' ? 'm' : 'M' } : prog[(b - s.from) % prog.length]; const rootPc = (pc0 + steps[ch.d]) % 12; const tones = C.chordTones(rootPc, ch.q).map((x) => (rootPc + x) % 12); chordsPerBar[b] = { rootPc, tones, ch }; lastRoot = rootPc; const t0 = b * bpb;
        // 和弦伴奏
        const hits = []; for (let i = 0; i < cells; i++) { const c = vo.tex[2][i % 16]; if (c !== '.') hits.push([i, c === 'X']); }
        hits.forEach((h, k) => { const next = k + 1 < hits.length ? hits[k + 1][0] : cells; const d = (next - h[0]) * 0.25 - 0.05; if (lastBar) { if (k === 0) tones.forEach((p) => add(chordT, t0, bpb - 0.1, 48 + ((p % 12) + 12) % 12, 70)); return; }
          if (vo.tex[3] === 'arp') add(chordT, t0 + h[0] * 0.25, d + 0.05, 48 + tones[k % tones.length] + (k % (tones.length * 2) >= tones.length ? 12 : 0), (h[1] ? 66 : 58) * vf);
          else tones.forEach((p) => add(chordT, t0 + h[0] * 0.25, d, 48 + p, (h[1] ? 72 : 62) * vf)); });
        // 貝斯
        const bn = 36 + rootPc; if (lastBar) add(bassT, t0, bpb - 0.1, bn, 85); else {
          const bh = []; for (let i = 0; i < cells; i++) { const c = vo.bas[2][i % 16]; if (c !== '.') bh.push([i, c === 'X']); }
          bh.forEach((h, k) => { const next = k + 1 < bh.length ? bh[k + 1][0] : cells; const d = Math.min((next - h[0]) * 0.25, 1) * 0.95; let n = bn;
            if (vo.bas[3] === 'walk') n = bn + (k % 4 === 0 ? 0 : ((tones[k % 4 === 2 ? 2 % tones.length : 1] - rootPc) + 12) % 12); else if (vo.bas[3] === 'oompah' && k % 2 === 1) n = bn + 7; else if (vo.bas[2] === 'X.x.x.x.X.x.x.x.' && k % 4 === 3 && r() < 0.3) n = bn + 7;
            add(bassT, t0 + h[0] * 0.25, d, n, (h[1] ? 90 : 72) * vf); });
        }
        // 鼓
        if (vo.drm && vo.drm[2]) { const pat = vo.drm[2]; for (let i = 0; i < cells; i++) { const c = pat[i % pat.length]; if (c === '.' || (quiet && c !== 'h' && c !== 'r')) continue; if (lastBar && i > 0) continue; add(drumT, t0 + i * 0.25, 0.2, ({ k: 36, s: 38, h: 42, o: 46, t: 45, c: 49, r: 51 })[c] || 42, (c === 'k' || c === 's' ? 100 : 70) * vf); } }
      }
    });
    // 旋律:由動機依段落角色發展
    const dev = (ns, op, k) => { // ns:[{ idx, beats }];回傳新陣列
      const cp = ns.map((x) => ({ idx: x.idx, beats: x.beats })); const first = cp[0].idx;
      if (op === 'orig') return cp; if (op === 'seq') return cp.map((x) => ({ idx: x.idx + k, beats: x.beats }));
      if (op === 'inv') return cp.map((x) => ({ idx: first - (x.idx - first), beats: x.beats })); if (op === 'retro') { const idxs = cp.map((x) => x.idx).reverse(); return cp.map((x, i) => ({ idx: idxs[i], beats: x.beats })); }
      if (op === 'answer') { const ref = cp.length > 1 ? cp[cp.length - 2].idx : cp[cp.length - 1].idx; cp[cp.length - 1].idx = Math.round(ref / 7) * 7; return cp; } if (op === 'up') return cp.map((x) => ({ idx: x.idx + 7, beats: x.beats }));
      if (op === 'frag') { const out = []; let tot = 0; for (const x of cp) { if (tot + x.beats > bpb + 1e-6) break; out.push(x); tot += x.beats; } if (tot < bpb - 1e-6) out.push({ idx: 0, beats: bpb - tot }); return out; }
      return cp;
    };
    const base = motif.map((n) => ({ idx: idxOf(n), beats: beatsOf(n) }));
    const OPS = { main: [['orig'], ['answer'], ['orig'], ['seq', -1, 'answer']], lift: [['seq', 2], ['orig'], ['seq', 2], ['orig', 'answer']], contrast: [['inv'], ['retro'], ['inv', 'seq', 1], ['orig', 'answer']] };
    const rot = Math.floor(r() * 2);
    let prevIdx = null;
    secs.forEach((s) => {
      const nph = Math.ceil((s.to - s.from) / mBars); const vf = 0.6 + 0.4 * s.energy; let t0 = s.from * bpb; const end = s.to * bpb;
      for (let p = 0; p < nph && t0 < end - 1e-6; p++) {
        let ns; const opsList = s.role === 'intro' || s.role === 'outro' ? null : OPS[s.group][(p + (s.role === 'verse' ? rot * 0 : 0)) % 4];
        if (s.role === 'intro') { if (p === 0 && t.bars >= 16) { t0 += mBars * bpb; continue; } ns = dev(base, 'frag'); } else if (s.role === 'outro') ns = p === 0 ? dev(base, 'orig') : dev(base, 'frag'); else { ns = base.map((x) => ({ idx: x.idx, beats: x.beats })); opsList.forEach((o2) => { if (typeof o2 === 'string' && ['orig', 'answer', 'inv', 'retro', 'frag'].indexOf(o2) >= 0) ns = dev(ns, o2, 0); else if (o2 === 'seq') ns = dev(ns, 'seq', opsList[opsList.indexOf('seq') + 1]); }); }
        // 若序列平移後音域跑掉,整句移八度
        const shiftBy = (k) => { ns = ns.map((x) => ({ idx: x.idx + 7 * k, beats: x.beats })); }; const rangeOf = () => [Math.min.apply(null, ns.map((x) => pitchOf(x.idx))), Math.max.apply(null, ns.map((x) => pitchOf(x.idx)))];
        let rg = rangeOf(); while (rg[0] < 58) { shiftBy(1); rg = rangeOf(); } while (rg[1] > 86) { shiftBy(-1); rg = rangeOf(); }
        { const mean = ns.reduce((acc, x) => acc + pitchOf(x.idx), 0) / ns.length; let bestK = 0, bestC = 1e9; for (let k = -2; k <= 2; k++) { const lo2 = rg[0] + 12 * k, hi2 = rg[1] + 12 * k; if (lo2 < 58 || hi2 > 86) continue; const first = pitchOf(ns[0].idx) + 12 * k; const cost = (prevIdx != null ? 0.6 * Math.abs(first - pitchOf(prevIdx)) : 0) + Math.abs(mean + 12 * k - 71); if (cost < bestC) { bestC = cost; bestK = k; } } if (bestK) shiftBy(bestK); }
        let tt = t0; ns.forEach((x, ni) => {
          if (tt >= end - 1e-6) return; const bar = Math.floor(tt / bpb + 1e-9); const local = tt - bar * bpb; const info = chordsPerBar[bar]; let idx = x.idx; let d = Math.min(x.beats, end - tt);
          const strong = Math.abs(local) < 1e-6 || (bpb === 4 && Math.abs(local - 2) < 1e-6) || x.beats >= 1.5 || ni === ns.length - 1;
          if (strong && info) { const okP = (i) => { const pc = pitchOf(i) % 12; const q = (pc - info.rootPc + 12) % 12; return info.tones.indexOf(pc) >= 0 && q !== 11 && q !== 1; }; if (!okP(idx)) { const cand = [-1, 1, -2, 2, -3, 3].map((k) => idx + k).find(okP); if (cand != null) { idx = cand; fixes.melody++; } } }
          if (bar === t.bars - 1) { idx = Math.round((idx - 0) / 7) * 7; d = Math.min(bpb, end - tt); if (local > 1e-6) { tt += x.beats; return; } }
          add(lead, tt, d * 0.95, pitchOf(idx), (strong ? 92 : 80) * vf + (r() * 6 - 3)); prevIdx = idx; tt += x.beats;
        });
        t0 += mBars * bpb;
      }
    });
    // 聲部連接:相鄰兩音跳超過八度時,把後面的音折回八度內(離開那個狀態就恢復原音高)
    { let off = 0; for (let i = 1; i < lead.length; i++) { const prev = lead[i - 1].n; const raw = lead[i].n; if (Math.abs(raw - prev) <= 12) { off = 0; continue; } let best = raw, bl = Math.abs(raw - prev); [-24, -12, 12, 24].forEach((o2) => { const c = raw + o2; if (c >= 55 && c <= 91 && Math.abs(c - prev) < bl) { bl = Math.abs(c - prev); best = c; } }); void off; lead[i].n = best; fixes.melody++; } }
    // 整體檢查
    if (!lead.length) problems.push('沒有旋律'); else {
      const lo = Math.min.apply(null, lead.map((n) => n.n)), hi = Math.max.apply(null, lead.map((n) => n.n)); if (lo < 55 || hi > 91) problems.push('旋律音域超出範圍 ' + lo + '-' + hi);
      for (let i = 1; i < lead.length; i++) if (Math.abs(lead[i].n - lead[i - 1].n) > 12) { problems.push('第 ' + i + ' 個音跳進超過八度'); break; }
      const per = bpb * PPQ; const hasBar = new Set(lead.map((n) => Math.floor(n.t / per))); let empty = 0; secs.forEach((s) => { if (s.role === 'intro' || s.role === 'outro') return; for (let b = s.from; b < s.to; b++) if (!hasBar.has(b)) empty++; }); if (empty) problems.push(empty + ' 個小節沒有旋律');
      const endT = Math.max.apply(null, lead.concat(bassT).map((n) => n.t + n.d)); if (endT > t.bars * per + 2) problems.push('曲子超過 ' + t.bars + ' 小節');
    }
    let song = M.emptySong(); song.title = t.title || (st.name + '・' + t.key); song.tempos = [{ t: 0, bpm: t.tempo }]; song.timesig = { n: st.timesig[0], d: st.timesig[1] };
    song = M.addTrack(song, '旋律', t.lead != null ? t.lead : st.inst.lead); song = M.addTrack(song, '和弦', st.inst.chord); song = M.addTrack(song, '貝斯', st.inst.bass); if (st.drum && drumT.length) song = M.addTrack(song, '鼓', 0, true);
    song.tracks[0].notes = lead; song.tracks[1].notes = chordT; song.tracks[2].notes = bassT; if (song.tracks[3]) song.tracks[3].notes = drumT; void lastRoot;
    return { song, sections: secs, problems, fixes };
  }
  function compose(t, seed) {
    seed = Number(seed) || 1; let last = null, tries = 0;
    try {
      for (; tries < 6; tries++) { last = build(t, seed + tries); if (!last.problems.length) return { song: M.validate(last.song), style: t.style, options: optionsOf(t), seed: seed + tries, tries: tries + 1, warnings: [], sections: last.sections, styleNote: '', fixes: last.fixes }; }
      return { song: M.validate(last.song), style: t.style, options: optionsOf(t), seed: seed + tries - 1, tries, warnings: last.problems, sections: last.sections, styleNote: '', fixes: last.fixes };
    } catch (e) {
      const c = C.compose(Object.assign({}, optionsOf(t), { seed })); c.warnings = (c.warnings || []).concat(['作曲樹組裝失敗(' + String((e && e.message) || e) + '),這次改用範本作曲']); c.fixes = { melody: 0 }; c.fallback = true; return c;
    }
  }
  function optionsOf(t) { return { style: t.style, key: t.key, tempo: t.tempo, bars: t.bars, progression: 0, lead: t.lead == null ? undefined : t.lead, title: t.title }; }

  // ---------- 說明 ----------
  const SRC = { learned: '以前學到的', ai: 'AI 決定', fixed: '程式修正', template: '範本預設', user: '你指定' };
  function prettyValue(t, id, v) {
    if (id === 'form') { const f = FORMS.find((x) => x.id === v); return f ? f.names.join('→') : v; }
    if (id === 'motif' || id.indexOf('harmony.') === 0) return v; const o = letterOpts(t, id).find((x) => x[0] === v); return o ? o[1] : v;
  }
  function describe(t) { // 樹狀列:[{ id, depth, label, value, source, sourceLabel, note, tries, raw }]
    const rows = []; nodeIds(t).forEach((id) => { const n = t.nodes[id] || { value: '', source: 'template' }; rows.push({ id, depth: id === 'form' || id === 'motif' ? 1 : id.split('.').length, label: LABEL(id), value: prettyValue(t, id, n.value), raw_value: n.value, source: n.source, sourceLabel: SRC[n.source] || n.source, note: n.source === 'template' && n.error ? n.error : '', tries: n.tries || 0, raw: n.raw || '' }); });
    const counts = {}; rows.forEach((r) => { counts[r.source] = (counts[r.source] || 0) + 1; }); return { rows, counts };
  }
  function learnNodes(t) { return nodeIds(t).filter((id) => t.nodes[id] && (t.nodes[id].source === 'ai' || t.nodes[id].source === 'user') && (id === 'motif' || id.indexOf('harmony.') === 0)).map((id) => ({ id, value: t.nodes[id].value })); }
  return { rebase, usable, plan, compose, redo, setNode, describe, learnNodes, parseChords, parseMotif, checkMotif, checkChords, checkForm, layout, validateNode, questionOf, nodeIds, templateValue, FORMS, VOC, TEXTURES, BASSES, drumChoices, fill, newTree };
});
