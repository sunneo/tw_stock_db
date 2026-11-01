// 作曲的「理解需求」那一段(CoLU 形狀:封閉題由 AI 回答、程式逐欄核對、每一欄都有程式的預設退路;AI 不吐音符,音符仍由 music_compose.js 的範本作曲)。
//   decide(text, { ask, explicit, timeoutMs, attempts }) → { fields, sources, options, report }
//     ask(systemPrompt, userPrompt) → Promise<string>:有 AI 時給;沒有(離線、額度用盡)就不給,整個走程式規則並在報告裡講明
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

  function questionOf() {
    const sty = STYLE_KEYS.map((k, i) => L[i] + '=' + C.STYLES[k].name + '(' + (C.STYLES[k].mode === 'minor' ? '小調' : '大調') + ',速度 ' + C.STYLES[k].tempo[0] + '–' + C.STYLES[k].tempo[1] + ')').join('、');
    const system = '你是作曲助理的「需求理解」。只回一個 JSON 物件,不要任何說明。欄位都填選項字母(purpose 除外):\n' +
      'style 風格範本:' + sty + '。使用者要的風格(包含作曲家、樂派、情境)不在清單裡時,選最接近的那一個字母。\n' +
      'mood 情緒:' + MOODS.map((x) => x[0] + '=' + x[1]).join('、') + '\n' +
      'speed 速度:' + SPEEDS.map((x) => x[0] + '=' + x[1]).join('、') + '\n' +
      'mode 調式:' + MODES.map((x) => x[0] + '=' + x[1]).join('、') + '(選的風格範本若是小調而你選大調,程式會以範本為準,所以請選和調式一致的範本)\n' +
      'lead 主奏樂器:' + LEADS.map((x) => x[0] + '=' + x[1]).join('、') + '\n' +
      'bars 長度(小節):' + BARS.map((x) => x[0] + '=' + x[1]).join('、') + '\n' +
      'purpose 用途或場景:一句話(40 字內),沒有就空字串。\n範例:{"style":"H","mood":"G","speed":"B","mode":"B","lead":"G","bars":"B","purpose":"簡報開場"}';
    return system;
  }
  // 解析 AI 的回答:逐欄核對,不在清單內的欄位回 null(呼叫端用規則或預設補);整個讀不懂就 {}
  function parseAnswer(text) {
    const out = {}; const m = String(text || '').match(/\{[\s\S]*?\}/); if (!m) return out; let o; try { o = JSON.parse(m[0]); } catch (_) { return out; } if (!o || typeof o !== 'object') return out;
    const letter = (v, allowed) => { const c = String(v == null ? '' : v).trim().charAt(0).toUpperCase(); return allowed.indexOf(c) >= 0 ? c : null; };
    const f = { style: letter(o.style, L.slice(0, 9)), mood: letter(o.mood, 'ABCDEFGH'), speed: letter(o.speed, 'ABC'), mode: letter(o.mode, 'ABC'), lead: letter(o.lead, L), bars: letter(o.bars, 'ABCD') };
    Object.keys(f).forEach((k) => { if (f[k]) out[k] = f[k]; });
    if (typeof o.purpose === 'string') out.purpose = o.purpose.trim().slice(0, 40);
    return out;
  }

  const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('逾時 ' + Math.round(ms / 1000) + ' 秒')), ms); Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

  // 主流程
  async function decide(text, o) {
    o = o || {}; text = String(text || ''); const explicit = o.explicit || {}; const report = { usedAi: false, aiError: '', attempts: 0, notes: [] };
    const base = C.parseRequest(text); // 使用者自己說的:風格詞、調、速度數字、小節數
    const userStyleWord = base.style && !base.styleNote; // 明確的風格詞(流行、爵士…)才算使用者指定;作曲家／樂派對應是程式猜的
    // 呼叫 AI(最多 attempts 次,每次有逾時);失敗不整個放棄,只是這次沒有 AI 的答案
    let ai = {};
    if (typeof o.ask === 'function') {
      const attempts = o.attempts || 2, timeoutMs = o.timeoutMs || 20000;
      for (let i = 0; i < attempts && !Object.keys(ai).length; i++) {
        report.attempts = i + 1;
        try { const raw = await withTimeout(o.ask(questionOf(), '使用者的需求:' + text.slice(0, 600)), timeoutMs); ai = parseAnswer(raw); if (!Object.keys(ai).length) report.aiError = 'AI 的回答讀不懂(' + String(raw || '').slice(0, 40).replace(/\s+/g, ' ') + ')'; }
        catch (e) { report.aiError = String((e && e.message) || e); }
      }
      report.usedAi = Object.keys(ai).length > 0; report.aiMissing = report.usedAi ? ['style', 'mood', 'speed', 'mode', 'lead', 'bars'].filter((k) => !ai[k]) : [];
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
    const plan = { fields: f, sources: src };
    return finish(plan, report, tmplMode);
  }
  function finish(plan, report, tmplMode) {
    const f = plan.fields, tmpl = C.STYLES[f.style]; tmplMode = tmplMode || (tmpl.mode === 'minor' ? 'B' : 'A');
    const options = toOptions(f); const wantMode = f.mode === 'C' ? tmplMode : f.mode;
    const notes = (report.notes || []).slice();
    if (wantMode !== tmplMode) notes.push('調式想要' + (wantMode === 'A' ? '大調' : '小調') + ',但「' + tmpl.name + '」範本是' + (tmplMode === 'A' ? '大調' : '小調') + ',這版以範本為準(要' + (wantMode === 'A' ? '大調' : '小調') + '可以換成' + STYLE_KEYS.filter((k) => (C.STYLES[k].mode === 'minor') === (wantMode === 'B')).map((k) => C.STYLES[k].name).join('、') + '範本)');
    if (!report.usedAi) notes.unshift('這次沒有用 AI,用的是範本規則(' + (report.aiError || '沒有 AI') + ')');
    else { const bad = ['style', 'mood', 'speed', 'mode', 'lead', 'bars'].filter((k) => plan.sources[k] !== 'ai' && plan.sources[k] !== 'user' && report.aiMissing && report.aiMissing.indexOf(k) >= 0); if (bad.length) notes.push('AI 沒答對的欄位改用程式預設:' + bad.join('、')); }
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
  const SRC = { user: '你說的', ai: 'AI 選的', rule: '程式規則猜的', default: '程式預設' };
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
  return { STYLE_KEYS, MOODS, SPEEDS, MODES, LEADS, BARS, SRC, decide, parseAnswer, questionOf, toOptions, edit, describe, rulePurpose, ruleMood };
});
