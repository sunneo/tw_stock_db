// AIDoc log triage (the "recipe" behind the log_triage subagent / tool): which lines of a pasted block are the user's own words, which are log lines,
// which are stack frames. A line that contains Chinese can be any of them, so "contains CJK" is never used as a verdict.
//   A = the user's own words / a question      B = a log line printed by the program      C = a stack frame
// The program decides everything it can: C by the stack parser, B by the INDEX (the line must match a recorded log format string, verbatim), blank lines are skipped.
// Only the lines the program cannot decide go to a (small) model as a closed multiple-choice question; the answer is then VERIFIED by the program
// (a model that says B for a line the index does not know is overruled to A; a model that says C for a line that is no frame is overruled).
// Exposes `FaLogTriage` (browser, embedded into floating-assistant.js by scripts/embed-code-ui.js) and module.exports (node tests).
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaLogTriage = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var T = (typeof FaAidocTrace !== 'undefined' && FaAidocTrace) || (typeof require === 'function' ? require('./trace.js') : null);

  var QUESTION_RE = /[?？]\s*$|(?:嗎|呢|請問|怎麼|為什麼|為何|幫我|請幫|是誰|在哪|什麼問題)/;
  // verdicts: { n, raw, cls: 'A'|'B'|'C'|'skip'|'?', by: 'parser'|'index'|'rule'|'model'|'overruled', hit? }
  // hooks.logHit(msg) -> Promise<boolean|object>   (the index looked the message up: a recorded format string matches it)
  function classify(text, hooks) {
    hooks = hooks || {};
    var parsed = T.parse(String(text || ''));
    var frameAt = {};
    parsed.frames.forEach(function (f) { frameAt[f.line_no] = f; });
    var lines = String(text || '').split(/\r?\n/);
    var items = [];
    var chain = Promise.resolve();
    lines.forEach(function (raw, i) {
      chain = chain.then(function () {
        var n = i + 1, t = raw.trim();
        if (!t) { return; }
        if (frameAt[n]) { items.push({ n: n, raw: raw, cls: 'C', by: 'parser' }); return; }
        var msg = T.messageOf(raw);
        if (!T.isMessageLine(msg)) { items.push({ n: n, raw: raw, cls: QUESTION_RE.test(t) ? 'A' : 'skip', by: 'rule' }); return; }
        if (!hooks.logHit) { items.push({ n: n, raw: raw, cls: '?', by: 'rule', msg: msg }); return; }
        return Promise.resolve(hooks.logHit(msg)).then(function (hit) {
          if (hit) { items.push({ n: n, raw: raw, cls: 'B', by: 'index', msg: msg, hit: hit }); return; }
          // not in the index: a question is the user's words; anything else stays undecided (it may be a log from code outside the tree)
          items.push({ n: n, raw: raw, cls: QUESTION_RE.test(t) ? 'A' : '?', by: 'rule', msg: msg });
        });
      });
    });
    return chain.then(function () { return items; });
  }

  // closed multiple-choice prompt for ONE undecided line (small models answer one letter well, a paragraph badly)
  function choicePrompt(item) {
    return '下面這一行，是哪一種？只回一個字母。\n'
      + '一行：' + String(item.raw).slice(0, 300) + '\n'
      + 'A. 使用者自己說的話（問題、說明、備註）\n'
      + 'B. 程式印出來的 log 訊息\n'
      + 'C. 堆疊（backtrace）的一層\n'
      + '答：';
  }
  function letterOf(reply) { var m = /^\s*[\(\[（]?\s*([ABCabc])\b/.exec(String(reply || '')) || /\b([ABC])\b/.exec(String(reply || '')); return m ? m[1].toUpperCase() : ''; }

  // verify a model's letter against the facts. verify.isFrame(raw) -> bool, verify.logHit(msg) -> Promise<bool>
  function applyAnswer(item, reply, verify) {
    verify = verify || {};
    var L = letterOf(reply);
    if (!L) { return Promise.resolve(Object.assign({}, item, { cls: '?', by: 'model', note: 'no letter in the reply' })); }
    if (L === 'A') { return Promise.resolve(Object.assign({}, item, { cls: 'A', by: 'model' })); }
    if (L === 'C') {
      var isF = verify.isFrame ? verify.isFrame(item.raw) : T.parse(item.raw).frames.length > 0;
      return Promise.resolve(isF ? Object.assign({}, item, { cls: 'C', by: 'model' }) : Object.assign({}, item, { cls: 'A', by: 'overruled', note: 'the stack parser does not read it as a frame' }));
    }
    return Promise.resolve(verify.logHit ? verify.logHit(item.msg || T.messageOf(item.raw)) : false).then(function (hit) {
      return hit ? Object.assign({}, item, { cls: 'B', by: 'model', hit: hit }) : Object.assign({}, item, { cls: 'A', by: 'overruled', note: 'the index has no log format string that matches it' });
    });
  }

  // the whole recipe with an injected generate(prompt) -> Promise<string>; without a model the undecided lines are reported as undecided
  function run(text, hooks, generate) {
    return classify(text, hooks).then(function (items) {
      if (!generate) { return items; }
      return items.reduce(function (chain, it, i) {
        return chain.then(function () {
          if (it.cls !== '?') { return; }
          return Promise.resolve(generate(choicePrompt(it))).then(function (rep) { return applyAnswer(it, rep, hooks); }).then(function (r) { items[i] = r; });
        });
      }, Promise.resolve()).then(function () { return items; });
    });
  }

  function summary(items) {
    var c = { A: 0, B: 0, C: 0, '?': 0, skip: 0 };
    items.forEach(function (x) { c[x.cls] = (c[x.cls] || 0) + 1; });
    return c;
  }
  return { classify: classify, choicePrompt: choicePrompt, letterOf: letterOf, applyAnswer: applyAnswer, run: run, summary: summary };
});
