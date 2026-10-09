// "widget" visual of "/media-presentation": an interactive piece the AI writes itself -- a small game, a simulator, a drag-and-drop exercise --
// as one self-contained HTML document. This is the one place a deck carries script, so it runs in a cage:
//
//   * a sandboxed iframe (`sandbox="allow-scripts"` only: no same-origin, so no cookies / Redmine session / parent DOM, no forms, no popups,
//     no navigation of the page) fed through `srcdoc`;
//   * a Content-Security-Policy meta tag in front of everything: no network of any kind (connect/img/script/style only inline or data:);
//   * the only way out is postMessage, spoken through the small `deck` object injected here (score / done / save / summary / grade).
//
// Why a cage at all: a deck may carry script here, and the cage is what keeps it from breaking the deck -- a widget's CSS, layout, keyboard focus,
// timers and errors stay inside its own rectangle (it cannot restyle the slide, hijack the page keys or throw into the player), and a script error
// is reported to the player instead of silently leaving a blank slide. No network / no page access is the security half of the same cage.
//
// The deck player (ai_chat_deck_player.js) owns the iframe and the other side of the protocol; this file only builds the document and keeps
// the protocol's field names in one place. Pure (no DOM): node-testable.
//
// Loadable both as a browser global (window.AiChatDeckWidget) and by node (test/media/deck_widget.test.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatDeckWidget = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_HTML = 120000;
  var MAX_GRADES = 20;   // AI gradings one widget may ask for (each is a model call)
  var CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

  // What a self-contained widget must not contain. The CSP already blocks all of these at run time; refusing them in the validator tells the
  // author (the model) why, instead of shipping a widget that silently shows nothing.
  function problems(html) {
    var h = String(html || ''), out = [];
    if (/<script[^>]+\bsrc\s*=/i.test(h)) { out.push('<script src=...> is not allowed: put the code inline (there is no network)'); }
    if (/<link\b/i.test(h)) { out.push('<link> is not allowed: put the css in <style>'); }
    if (/@import\b/i.test(h)) { out.push('@import is not allowed'); }
    if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/.test(h)) { out.push('network APIs (fetch / XMLHttpRequest / WebSocket ...) are not available in a widget'); }
    if (/(?:src|href|action|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(h) || /url\(\s*["']?\s*(?:https?:)?\/\//i.test(h)) { out.push('external urls are not allowed: everything must be inline (data: uris are fine)'); }
    if (/\b(?:window\.)?(?:top|parent)\.(?!postMessage)\w/.test(h) || /\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/.test(h)) { out.push('a widget cannot reach the page, cookies or browser storage: keep state in variables and use deck.save(data) to persist it'); }
    if (/<iframe\b|<embed\b|<object\b/i.test(h)) { out.push('nested frames / embeds are not allowed'); }
    return out;
  }

  // The injected SDK: window.deck.
  var SDK = '(function(){var P=window.parent,seq=0,pend={},onInit=null,init=null;' +
    'function send(m){m.t="deck";try{P.postMessage(m,"*");}catch(e){}}' +
    'window.addEventListener("message",function(e){var d=e.data;if(!d||d.t!=="deck")return;' +
    'if(d.op==="init"){init=d;window.deck.points=d.points;window.deck.data=d.data;if(onInit)onInit(d.data);}' +
    'else if(d.op==="grade-result"&&pend[d.id]){var f=pend[d.id];delete pend[d.id];f(d);}});' +
    'window.deck={points:10,data:null,' +
    'score:function(got,max,fb){send({op:"score",got:Number(got),max:max==null?null:Number(max),feedback:fb==null?"":String(fb)});},' +
    'done:function(){send({op:"done"});},' +
    'save:function(data){send({op:"state",data:data});},' +
    'summary:function(t){send({op:"summary",text:String(t)});},' +
    'onInit:function(fn){onInit=fn;if(init)fn(init.data);},' +
    'grade:function(answer){return new Promise(function(res,rej){var id=++seq;pend[id]=function(d){d.error?rej(new Error(d.error)):res({score:d.score,feedback:d.feedback});};send({op:"grade",id:id,answer:String(answer)});});}};' +
    'window.addEventListener("error",function(e){send({op:"error",message:String(e.message||e).slice(0,200)});});' +
    'window.addEventListener("unhandledrejection",function(e){send({op:"error",message:String(e.reason&&e.reason.message||e.reason||"rejected").slice(0,200)});});' +
    'send({op:"ready"});})();';

  var BASE_CSS = 'html,body{margin:0;height:100%;box-sizing:border-box}body{font-family:"Microsoft JhengHei","Noto Sans CJK TC",sans-serif;color:#0E2841;background:#fff;overflow:auto}*{box-sizing:border-box}';

  // html: the AI's body fragment or whole document -> the srcdoc of the iframe.
  // Order matters: the policy first, then the `deck` SDK, THEN the author's markup and scripts -- a game calls deck.score(0) the moment its
  // script runs, so deck must already exist (with the SDK after the body, that first call threw and the widget stayed a black canvas).
  function buildSrcdoc(html) {
    var h = String(html || ''), meta = '<meta http-equiv="Content-Security-Policy" content="' + CSP + '"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
    var head = meta + '<script>' + SDK + '</script>';
    if (/<html[\s>]/i.test(h) || /<!doctype/i.test(h)) {
      if (/<head[\s>]/i.test(h)) { return h.replace(/<head([^>]*)>/i, '<head$1>' + head); }
      if (/<html[^>]*>/i.test(h)) { return h.replace(/<html([^>]*)>/i, '<html$1><head>' + head + '</head>'); }
      return '<!doctype html><html><head>' + head + '</head><body>' + h + '</body></html>';
    }
    return '<!doctype html><html><head>' + head + '<style>' + BASE_CSS + '</style></head><body>' + h + '</body></html>';
  }

  return { MAX_HTML: MAX_HTML, MAX_GRADES: MAX_GRADES, CSP: CSP, problems: problems, buildSrcdoc: buildSrcdoc, SDK: SDK };
});
