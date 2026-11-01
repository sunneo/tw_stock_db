// 作曲的「理解需求」那一段(CoLU 形狀:封閉題由 AI 回答、程式逐欄核對、每一欄都有程式的預設退路;AI 不吐音符,音符仍由 music_compose.js 的範本作曲)。
//   decide(text, { ask, explicit, timeoutMs, attempts, onStep }) → { fields, sources, options, report }
//     ask(systemPrompt, userPrompt, { field, strict }) → Promise<string>(一次問一欄,字母作答;第二次起 strict=true 用更嚴格的提示重問):有 AI 時給;沒有(離線、額度用盡)就不給,整個走程式規則並在報告裡講明
//     explicit:呼叫端明確指定的欄位(工具參數 style／key／tempo／bars),視為使用者指定
//   欄位:style 風格範本(九種)、mood 情緒、speed 速度(慢中快)、mode 調式、lead 主奏樂器、bars 長度、key 調、tempo 速度數字、purpose 用途或場景描述(文字)
//   來源 sources[欄位]:'user'(使用者自己說的或指定的數字)／'ai'(AI 選的,核對過)／'rule'(程式規則從關鍵字猜的)／'default'(程式預設)
//   toOptions(fields) → 給 FaMidiCompose.compose 的選項;edit(plan, patch) → 使用者改某幾欄(標成 user)後的新規劃;describe(report) → 結果卡片的文字
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./music_compose.js')); else root.FaComposePlan = factory(root.FaMidiCompose || (typeof FaMidiCompose !== 'undefined' ? FaMidiCompose : undefined)); })(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';
  const STYLE_KEYS = ['pop', 'rock', 'jazz', 'blues', 'waltz', 'folk', 'lofi', 'edm', 'classical'], L = 'ABCDEFGHIJ';
  const MOODS = [['A', '明亮歡快'], ['B', '溫暖柔和'], ['C', '放鬆悠閒'], ['D', '憂鬱抒情'], ['E', '緊張懸疑'], ['F', '活力有勁'], ['G', '科技未來感'], ['H', '莊嚴壯闊']];
  const MOOD_STYLE = { A: 'pop', B: 'folk', C: 'lofi', D: 'lofi', E: 'edm', F: 'rock', G: 'edm', H: 'classical' };
  const MOOD_DRUM = { A: 0, B: 0, C: 0, D: 0, E: 1, F: 1, G: 1, H: 0 };
  const MOOD_SPEED = { A: 'B', B: 'A', C: 'A', D: 'A', E: 'B', F: 'C', G: 'B', H: 'B' };
  const MOOD_LEAD = { A: 'A', B: 'C', C: 'B', D: 'A', E: 'G', F: 'C', G: 'G', H: 'D' };
  const MOOD_WORDS = [['G', /科技|未來|數位|電子感|科幻|賽博|tech|cyber|futur/i], ['E', /緊張|懸疑|驚悚|刺激/], ['F', /活力|熱血|運動|動感|有勁|energetic/i], ['H', /莊嚴|壯闊|史詩|宏大|磅礡|epic/i], ['D', /憂鬱|悲傷|感傷|哀傷|傷感|抒情/], ['C', /放鬆|悠閒|慵懶|睡眠|咖啡|chill/i], ['B', /溫暖|柔和|溫柔|療癒/], ['A', /輕快|歡樂|開心|明亮|愉快|歡快/]];
  const SPEEDS = [['A', '慢'], ['B', '中'], ['C', '快']];
  const MODES = [['A', '大調'], ['B', '小調'], ['C', '自動(用範本的調式)']];
  const LEADS = [['A', '鋼琴', 0], ['B', '電鋼琴', 4], ['C', '吉他', 25], ['D', '弦樂(小提琴)', 40], ['E', '長笛(木管)', 73], ['F', '小號(銅管)', 56], ['G', '合成主奏', 80], ['H', '合成氛圍', 88], ['I', '顫音琴(鐘琴類)', 11], ['J', '自動(用範本的主奏)', null]];
  const BARS = [['A', 8], ['B', 16], ['C', 24], ['D', 32]];
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // 規則:從關鍵字猜(沒有 AI 時的全部、有 AI 時的退路)
  function ruleMood(text) { for (const [k, re] of MOOD_WORDS) if (re.test(text)) return k; return null; }
  function ruleSpeed(text) { if (/慢|緩|舒緩/.test(text)) return 'A'; if (/快|急促|疾/.test(text)) return 'C'; return null; }
  function ruleMode(text) { if (/小調/.test(text)) return 'B'; if (/大調/.test(text)) return 'A'; return null; }
  function ruleLead(text) { const m = [['A', /鋼琴|piano/i], ['B', /電鋼琴/], ['C', /吉他|guitar/i], ['D', /弦樂|小提琴|提琴|violin/i], ['E', /長笛|笛|木管|flute/i], ['F', /小號|銅管|trumpet/i], ['G', /合成主奏|合成器|synth/i], ['I', /顫音琴|鐘琴|木琴/]]; for (const [k, re] of m) if (re.test(text)) return k; return null; }
  function rulePurpose(text) { const m = /(?:用來|用於|拿來|作為|當作|給|for)\s*([^,，。;；\n]{1,40})/i.exec(text); return m ? m[1].replace(/(的)?(背景)?(音樂|曲子|配樂)?(使用)?$/, '').trim().slice(0, 40) : ''; }

  // 逐欄提問:一次只問一欄,選項字母作答,附範例;範例刻意和真實需求無關,避免模型照抄
  const FIELD_ORDER = ['style', 'mood', 'speed', 'mode', 'lead', 'bars'];
  function optionsOf(k) {
    if (k === 'style') return STYLE_KEYS.map((key, i) => [L[i], C.STYLES[key].name + '(' + (C.STYLES[key].mode === 'minor' ? '小調' : '大調') + ')']);
    if (k === 'mood') return MOODS; if (k === 'speed') return SPEEDS; if (k === 'mode') return MODES; if (k === 'lead') return LEADS.map((x) => [x[0], x[1]]); if (k === 'bars') return BARS.map((x) => [x[0], x[1] + ' 小節']);
    return [];
  }
  const ASK = { style: '曲子最適合哪一種風格範本(使用者要的風格、作曲家、樂派、情境不在清單裡時,選最接近的)', mood: '曲子的情緒', speed: '曲子的速度', mode: '曲子的調式', lead: '主奏樂器', bars: '曲子的長度' };
  const SHOTS = {
    style: [['想要一首下雨天咖啡館的音樂', 'F'], ['寫一首熱血的搖滾', 'B'], ['優雅的三拍子舞曲', 'E']],
    mood: [['安靜的夜晚讀書用', 'C'], ['遊戲 Boss 戰', 'E'], ['新手機發表會開場', 'G']],
    speed: [['悠閒的午後', 'A'], ['運動會進場', 'C'], ['一般的背景音樂', 'B']],
    mode: [['憂傷的告別', 'B'], ['生日快樂', 'A'], ['隨便一首', 'C']],
    lead: [['浪漫的小夜曲', 'D'], ['營火晚會', 'C'], ['電玩風格', 'G']],
    bars: [['很短的提示音樂', 'A'], ['一般長度', 'B'], ['長一點的完整曲子', 'D']]
  };
  // 單欄的題目。strict:上一次回的東西讀不懂,這次用更嚴格的版本(貼回上次的回覆、說明錯在哪)
  function questionOf(k, text, strict) {
    if (k === 'purpose') {
      const system = '你是作曲助理。用一句話(40 字內,繁體中文)說這首曲子的用途或場景。只回這一句話,不要任何說明、不要引號。沒有明確用途就回「無」。\n範例:\n需求:幫我做簡報開場音樂 → 簡報開場\n需求:隨便來一首 → 無' + (strict ? '\n【上一次你回的不是一句短話:「' + (strict.raw || '(空白)') + '」。這次第一個字就是答案,不要先說明或思考。】' : '');
      return { system, user: '需求:' + String(text).slice(0, 600) + ' →' };
    }
    const opts = optionsOf(k), letters = opts.map((x) => x[0]).join('');
    const shots = (SHOTS[k] || []).filter((x) => letters.indexOf(x[1]) >= 0).map((x) => '需求:' + x[0] + ' → ' + x[1]).join('\n');
    const system = '你是作曲助理的「需求理解」。這一題要選:' + ASK[k] + '。\n選項:' + opts.map((x) => x[0] + '=' + x[1]).join('、') + '\n只回一個字母(' + letters.charAt(0) + ' 到 ' + letters.charAt(letters.length - 1) + '),不要解釋、不要思考過程、不要標點。\n範例:\n' + shots +
      (strict ? '\n【上一次你回的是「' + (strict.raw || '(空白)') + '」,這不是合法答案。這次你回覆的第一個字元就必須是 ' + letters.split('').join('、') + ' 其中一個字母,後面什麼都不要寫。】' : '');
    return { system, user: '需求:' + String(text).slice(0, 600) + ' →' };
  }
  const stripThink = (raw) => { let t = String(raw == null ? '' : raw); t = t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ''); const open = t.search(/<think(?:ing)?>/i); if (open >= 0) t = t.slice(0, open); t = t.replace(/^[\s\S]*<\/think(?:ing)?>/i, ''); return t.replace(/```[a-z]*/gi, '').trim(); };
  // 寬容解析一欄的字母:剝掉思考、JSON、「答案:H」、開頭的字母、整句只有選項名稱;長篇英文思考文字裡不亂猜
  function parseLetter(raw, k) {
    const opts = optionsOf(k), allowed = opts.map((x) => x[0]).join(''); const t = stripThink(raw); if (!t) return null;
    const ok = (c) => { c = String(c || '').toUpperCase(); return c.length === 1 && allowed.indexOf(c) >= 0 ? c : null; };
    const js = t.match(/\{[\s\S]*?\}/); if (js) { try { const o = JSON.parse(js[0]); const v = o && (o[k] != null ? o[k] : Object.values(o)[0]); const c = ok(String(v == null ? '' : v).trim().charAt(0)); if (c) return c; } catch (_) { /* */ } }
    const head = /^[\s"'「『(（\[*]*([A-Za-z])(?![A-Za-z])/.exec(t); if (head && (head[1] === head[1].toUpperCase() || t.length <= 3) && ok(head[1])) return ok(head[1]);
    const ans = [...t.matchAll(/(?:答案|選擇|選項|我選|answer|choice|option)\s*(?:是|為|:|：|=|is)?\s*["「『(（*]*([A-Z])(?![A-Za-z])/gi)]; for (let i = ans.length - 1; i >= 0; i--) if (ans[i][1] === ans[i][1].toUpperCase() && ok(ans[i][1])) return ok(ans[i][1]);
    if (t.length <= 24) { const hit = opts.filter((x) => t.indexOf(String(x[1]).replace(/\(.*\)$/, '')) >= 0); if (hit.length === 1) return hit[0][0]; }
    return null;
  }
  function parsePurpose(raw) { let t = stripThink(raw).split(/\n/)[0].replace(/^[\s"'「『]+|[\s"'」』。]+$/g, '').trim(); if (!t || t === '無' || /^(none|n\/a)$/i.test(t)) return ''; if (/^(the user|user wants|i need|let me|okay|we need|first)/i.test(t) || t.length > 40) return null; return t; }

  const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('逾時 ' + Math.round(ms / 1000) + ' 秒')), ms); Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

  // 主流程
  async function decide(text, o) {
    o = o || {}; text = String(text || ''); const explicit = o.explicit || {}; const step = o.onStep || (() => {}); const report = { usedAi: false, aiError: '', attempts: 0, notes: [] };
    const base = C.parseRequest(text); // 使用者自己說的:風格詞、調、速度數字、小節數
    const userStyleWord = base.style && !base.styleNote; // 明確的風格詞(流行、爵士…)才算使用者指定;作曲家／樂派對應是程式猜的
    // 呼叫 AI:一次問一欄;每欄最多 attempts 次(第二次起用更嚴格的提示並貼回上次的回覆);兩次都讀不懂只那一欄退回預設
    // 使用者已經自己決定的欄位不問;連線類錯誤連兩次就停止問後面的欄位(不用每欄都等逾時);前三欄一個都沒答對也停止
    const ai = {}; report.perField = {}; report.aiMissing = []; report.calls = 0;
    // 以前學到的(使用者接受過的類似說法):那幾欄直接用,不再問 AI
    const learnedKeys = []; { let lp = null; try { lp = typeof o.learned === 'function' ? o.learned(text) : null; } catch (_) { lp = null; } if (lp) FIELD_ORDER.forEach((k) => { const v = lp[k]; if (v && optionsOf(k).some((x) => x[0] === v)) { ai[k] = v; learnedKeys.push(k); } }); }
    report.learned = learnedKeys.slice();
    if (typeof o.ask === 'function') {
      const attempts = o.attempts || 2, timeoutMs = o.timeoutMs || 20000;
      const skip = {}; if (explicit.style || userStyleWord) skip.style = '你說的'; if (explicit.tempo || base.tempo) skip.speed = '你說的'; if (ruleMode(text)) skip.mode = '你說的'; if (ruleLead(text)) skip.lead = '你說的'; if (explicit.bars || base.bars) skip.bars = '你說的';
      learnedKeys.forEach((k) => { skip[k] = '學到的'; }); const todo = FIELD_ORDER.filter((k) => !skip[k]).concat(rulePurpose(text) ? [] : ['purpose']); let stopWhy = '', failRun = 0, anyOk = false;
      for (const k of todo) {
        const pf = report.perField[k] = { ok: false, tries: 0, raw: '', error: '' };
        if (stopWhy) { pf.error = '沒有問(' + stopWhy + ')'; report.aiMissing.push(k); continue; }
        let netFail = 0;
        for (let i = 0; i < attempts && !pf.ok; i++) {
          const q = questionOf(k, text, i > 0 && pf.raw !== undefined && !pf.error.startsWith('連線') ? { raw: pf.raw.slice(0, 60) } : null); pf.tries = i + 1; report.calls++; step('問「' + (k === 'purpose' ? '用途' : ASK[k].slice(0, 6)) + '」第 ' + (i + 1) + ' 次…');
          try {
            const raw = await withTimeout(o.ask(q.system, q.user, { field: k, strict: i > 0 }), timeoutMs); pf.raw = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 80); pf.error = '';
            const v = k === 'purpose' ? parsePurpose(raw) : parseLetter(raw, k);
            if (v === null) { pf.error = pf.raw ? '讀不懂(' + pf.raw + ')' : '回了空白'; step('「' + k + '」' + pf.error); } else { ai[k] = v; pf.ok = true; pf.value = v; step('「' + k + '」AI 答:' + (v === '' ? '(無)' : v)); }
          } catch (e) { pf.error = '連線' + String((e && e.message) || e); netFail++; step('「' + k + '」問 AI 失敗:' + pf.error); }
        }
        if (pf.ok) { anyOk = true; failRun = 0; } else { report.aiMissing.push(k); failRun++; }
        if (netFail >= attempts) stopWhy = '前一欄連線連續失敗:' + pf.error; else if (!anyOk && failRun >= 3) stopWhy = '前三欄都沒答對,這個模型看來不適合,停止再問';
      }
      report.attempts = report.calls; report.usedAi = Object.keys(ai).length > learnedKeys.length || (learnedKeys.length > 0 && !todo.length);
      const firstBad = todo.map((k) => [k, report.perField[k]]).find((x) => x[1] && !x[1].ok);
      report.aiRaw = firstBad ? firstBad[1].raw : ''; if (!report.usedAi) report.aiError = firstBad ? '「' + firstBad[0] + '」' + firstBad[1].error : '沒有需要問 AI 的欄位';
      report.aiMissing = report.aiMissing.filter((k) => k !== 'purpose');
      if (!report.usedAi && learnedKeys.length && !report.aiError) report.aiError = '';
    } else report.aiError = o.noAiReason || '沒有可用的 AI(離線或沒有設定)';
    const f = {}, src = {};
    const set = (k, v, s) => { f[k] = v; src[k] = s; };
    // 風格:使用者指定 > 呼叫端指定 > AI > 規則(作曲家／情緒) > 預設
    if (explicit.style && C.STYLES[explicit.style]) set('style', explicit.style, 'user');
    else if (userStyleWord) set('style', base.style, 'user');
    else if (ai.style) set('style', STYLE_KEYS[L.indexOf(ai.style)], 'ai');
    else if (base.style) set('style', base.style, 'rule');
    else { const mk = ai.mood || ruleMood(text); if (mk) set('style', MOOD_STYLE[mk], 'rule'); else set('style', 'pop', 'default'); }
    // 情緒
    if (ai.mood) set('mood', ai.mood, 'ai'); else { const mk = ruleMood(text); if (mk) set('mood', mk, 'rule'); else set('mood', null, 'default'); }
    // 速度:使用者給了數字最優先(tempo 欄位);否則 慢中快
    if (explicit.tempo || base.tempo) set('tempo', clamp(Number(explicit.tempo || base.tempo), 40, 220), 'user'); else set('tempo', null, 'default');
    if (f.tempo == null) { if (ai.speed) set('speed', ai.speed, 'ai'); else { const sk = ruleSpeed(text); if (sk) set('speed', sk, 'rule'); else set('speed', f.mood ? MOOD_SPEED[f.mood] : 'B', f.mood ? 'rule' : 'default'); } } else set('speed', null, 'user');
    // 調式
    const tmpl = C.STYLES[f.style]; const tmplMode = tmpl.mode === 'minor' ? 'B' : 'A';
    if (ruleMode(text)) set('mode', ruleMode(text), 'user'); else if (ai.mode) set('mode', ai.mode, 'ai'); else set('mode', 'C', 'default');
    // 主奏樂器
    if (ruleLead(text)) set('lead', ruleLead(text), 'user'); else if (ai.lead && ai.lead !== 'J') set('lead', ai.lead, 'ai'); else if (ai.lead === 'J') set('lead', 'J', 'ai'); else if (f.mood) set('lead', MOOD_LEAD[f.mood], 'rule'); else set('lead', 'J', 'default');
    // 長度
    if (explicit.bars || base.bars) set('bars', clamp(Math.round(Number(explicit.bars || base.bars)), 4, 64), 'user'); else if (ai.bars) set('bars', BARS[L.indexOf(ai.bars)][1], 'ai'); else set('bars', 16, 'default');
    // 調
    if (explicit.key || base.key) set('key', explicit.key || base.key, 'user'); else set('key', 'C', 'default');
    // 用途(文字)
    const rp = rulePurpose(text); if (rp) set('purpose', rp, 'user'); else if (ai.purpose) set('purpose', ai.purpose, 'ai'); else set('purpose', '', 'default');
    if (base.styleNote && src.style === 'rule') report.notes.push(base.styleNote); else if (base.styleNote && src.style !== 'user') report.notes.push(base.styleNote);
    learnedKeys.forEach((k) => { if (src[k] === 'ai') src[k] = 'learned'; });
    const plan = { fields: f, sources: src };
    return finish(plan, report, tmplMode);
  }
  function finish(plan, report, tmplMode) {
    const f = plan.fields, tmpl = C.STYLES[f.style]; tmplMode = tmplMode || (tmpl.mode === 'minor' ? 'B' : 'A');
    const options = toOptions(f); const wantMode = f.mode === 'C' ? tmplMode : f.mode;
    const notes = (report.notes || []).slice();
    if (wantMode !== tmplMode) notes.push('調式想要' + (wantMode === 'A' ? '大調' : '小調') + ',但「' + tmpl.name + '」範本是' + (tmplMode === 'A' ? '大調' : '小調') + ',這版以範本為準(要' + (wantMode === 'A' ? '大調' : '小調') + '可以換成' + STYLE_KEYS.filter((k) => (C.STYLES[k].mode === 'minor') === (wantMode === 'B')).map((k) => C.STYLES[k].name).join('、') + '範本)');
    if (report.learned && report.learned.length) notes.push('這幾欄用你以前接受過的類似說法的選擇,沒有再問 AI:' + report.learned.join('、'));
    if (!report.usedAi) notes.unshift('這次沒有用 AI,用的是範本規則(' + (report.aiError || '沒有 AI') + ')');
    else { const bad = ['style', 'mood', 'speed', 'mode', 'lead', 'bars'].filter((k) => plan.sources[k] !== 'ai' && plan.sources[k] !== 'user' && report.aiMissing && report.aiMissing.indexOf(k) >= 0); if (bad.length) notes.push('AI 沒答對的欄位改用程式預設:' + bad.map((k) => { const pf = (report.perField || {})[k]; return k + (pf && pf.error ? '(' + pf.error.slice(0, 50) + ')' : ''); }).join('、')); }
    return { fields: f, sources: plan.sources, options, report: Object.assign({}, report, { notes, tmplName: tmpl.name, tmplMode }) };
  }
  // 規劃 → compose 的選項(純函式)
  function toOptions(f) {
    const st = C.STYLES[f.style] || C.STYLES.pop; const sp = f.tempo != null ? f.tempo : (f.speed === 'A' ? st.tempo[0] : f.speed === 'C' ? st.tempo[1] : Math.round((st.tempo[0] + st.tempo[1]) / 2));
    const lead = (LEADS.find((x) => x[0] === f.lead) || [])[2]; const drumIdx = f.mood ? Math.min(MOOD_DRUM[f.mood] || 0, Math.max(0, (st.drum ? st.drum.length : 1) - 1)) : 0;
    const title = (f.purpose ? f.purpose + '・' : '') + st.name + (f.mood ? '・' + (MOODS.find((x) => x[0] === f.mood) || [])[1] : '') + '・' + f.key;
    return { style: f.style, key: f.key, tempo: sp, bars: f.bars, progression: 0, lead: lead == null ? undefined : lead, drumIdx, title };
  }
  // 使用者改某幾欄(「改成…」):那幾欄標成 user,其他不動,重新算選項
  function edit(plan, patch) {
    const fields = Object.assign({}, plan.fields), sources = Object.assign({}, plan.sources), rp = plan.report || {};
    Object.keys(patch || {}).forEach((k) => { if (!(k in fields)) return; let v = patch[k]; if (k === 'tempo') v = v === '' || v == null ? null : clamp(Number(v), 40, 220); if (k === 'bars') v = clamp(Math.round(Number(v)), 4, 64); if (k === 'style' && !C.STYLES[v]) return; fields[k] = v; sources[k] = 'user'; if (k === 'tempo' && v == null) sources[k] = 'default'; if (k === 'tempo' && v != null) sources.speed = 'user'; if (k === 'speed') { fields.tempo = null; sources.tempo = 'default'; } });
    return finish({ fields, sources }, { usedAi: !!rp.usedAi, aiError: rp.aiError || '', aiMissing: [], notes: [] });
  }
  const SRC = { user: '你說的', learned: '以前學到的(你接受過類似的)', ai: 'AI 選的', rule: '程式規則猜的', default: '程式預設' };
  const labelOf = (k, f, C2) => {
    const st = C2.STYLES[f.style];
    switch (k) {
      case 'style': return st.name + '(' + f.style + ')'; case 'mood': return f.mood ? (MOODS.find((x) => x[0] === f.mood) || [])[1] : '(沒有指定)';
      case 'speed': return f.tempo != null ? f.tempo + ' 拍/分' : (SPEEDS.find((x) => x[0] === f.speed) || [])[1] + '(' + toOptions(f).tempo + ' 拍/分)';
      case 'mode': return (MODES.find((x) => x[0] === f.mode) || [])[1]; case 'lead': return (LEADS.find((x) => x[0] === f.lead) || [])[1]; case 'bars': return f.bars + ' 小節'; case 'key': return f.key + ' 調'; case 'purpose': return f.purpose || '(沒有)';
    }
    return '';
  };
  const ROWS = [['style', '風格範本'], ['mood', '情緒'], ['speed', '速度'], ['mode', '調式'], ['lead', '主奏樂器'], ['bars', '長度'], ['key', '調'], ['purpose', '用途']];
  // 結果卡片的說明:每個欄位的值與來源
  function describe(res, seed) {
    const sk = (k) => (k === 'speed' && res.fields.tempo != null ? res.sources.tempo : res.sources[k]);
    const rows = ROWS.map(([k, name]) => ({ key: k, name, value: labelOf(k, res.fields, C), source: sk(k), sourceLabel: SRC[sk(k)] || '' }));
    return { rows, notes: res.report.notes, usedAi: res.report.usedAi, seed, template: res.report.tmplName };
  }
  // 經驗:使用者接受的結果 → 這一句話對到哪幾欄的字母(只收使用者說的、AI 選的、學到的;程式猜的與預設不收)
  function learnPicks(res) {
    const f = res.fields, sr = res.sources, picks = {}, okSrc = (k) => sr[k] === 'ai' || sr[k] === 'user' || sr[k] === 'learned';
    if (okSrc('style')) picks.style = L[STYLE_KEYS.indexOf(f.style)]; if (f.mood && okSrc('mood')) picks.mood = f.mood; if (f.tempo == null && f.speed && okSrc('speed')) picks.speed = f.speed; if (f.mode && f.mode !== 'C' && okSrc('mode')) picks.mode = f.mode;
    if (f.lead && okSrc('lead')) picks.lead = f.lead; const bi = BARS.findIndex((x) => x[1] === f.bars); if (bi >= 0 && okSrc('bars')) picks.bars = BARS[bi][0];
    Object.keys(picks).forEach((k) => { if (!picks[k] || picks[k] === 'undefined') delete picks[k]; }); return picks;
  }
  // 找以前學到的類似說法(字元二連詞相似度 ≥ 0.7);entries:[{task, picks}]
  function matchLearned(text, entries) {
    const grams = (t) => { t = String(t || '').toLowerCase().replace(/\s+/g, ''); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
    const a = grams(text); if (a.size < 3) return null; let best = null, bs = 0;
    (entries || []).forEach((e) => { if (!e || !e.picks || !e.task) return; const b = grams(e.task); let inter = 0; a.forEach((x) => { if (b.has(x)) inter++; }); const sim = inter / (a.size + b.size - inter || 1); if (sim > bs) { bs = sim; best = e; } });
    return bs >= 0.7 ? best.picks : null;
  }
  return { learnPicks, matchLearned, STYLE_KEYS, MOODS, SPEEDS, MODES, LEADS, BARS, SRC, decide, parseLetter, parsePurpose, stripThink, questionOf, toOptions, edit, describe, rulePurpose, ruleMood };
});
