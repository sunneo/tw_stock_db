// 範本的 YAML 子集解析（純函式、UMD）。與 renderer/src/pybridge/guitpl_yaml.py 是同一份規格的兩個實作，兩邊必須給出同樣的紀錄
// （yaml_core.test.js 用同一批樣本比對兩邊）。支援範圍見 guitpl_yaml.py 的說明：區塊對照與區塊陣列（只能用空格）、行內陣列與行內對照、
// 雙引號（JSON 跳脫）與單引號字串、整數、小數、true／false／null／~、註解；不支援錨點、別名、標籤、多行字串、合併鍵、tab。
//   FaGuiTplYaml.parseDocuments(text) -> [紀錄物件…]（文件以單獨一行的 --- 分開）；寫錯丟 Error（訊息是中文）
//   FaGuiTplYaml.toJsonl(text)        -> 同樣的紀錄寫成一行一筆的 jsonl 文字
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.FaGuiTplYaml = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NUMBER_RE = /^[-+]?(\d+)(\.\d+)?([eE][-+]?\d+)?$/;

  function stripComment(s) {
    var q = null, i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (q) {
        if (c === '\\' && q === '"') { i += 2; continue; }
        if (c === q) {
          if (q === "'" && s.charAt(i + 1) === "'") { i += 2; continue; }
          q = null;
        }
      } else if ((c === '"' || c === "'") && (i === 0 || ' \t[{,:-'.indexOf(s.charAt(i - 1)) >= 0)) {
        q = c;
      } else if (c === '#' && (i === 0 || ' \t'.indexOf(s.charAt(i - 1)) >= 0)) {
        return s.slice(0, i);
      }
      i++;
    }
    return s;
  }

  // 雙引號字串（JSON 跳脫）從 s 開頭讀一個，回傳 [值, 結束位置]；JSON.parse 要整段，所以先找結尾
  function rawDecodeString(s) {
    var j = 1;
    while (j < s.length) {
      if (s.charAt(j) === '\\') { j += 2; continue; }
      if (s.charAt(j) === '"') { break; }
      j++;
    }
    if (j >= s.length) { throw new Error('雙引號字串沒有結尾或跳脫字元不對：' + s); }
    var v;
    try { v = JSON.parse(s.slice(0, j + 1)); } catch (e) { throw new Error('雙引號字串沒有結尾或跳脫字元不對：' + s); }
    return [v, j + 1];
  }

  function scalar(s) {
    s = s.trim();
    if (s === '') { return null; }
    var c = s.charAt(0);
    if (c === '"') {
      var r = rawDecodeString(s);
      if (s.slice(r[1]).trim()) { throw new Error('字串後面還有多餘的字：' + s); }
      return r[0];
    }
    if (c === "'") {
      if (s.length < 2 || s.charAt(s.length - 1) !== "'") { throw new Error('單引號字串沒有結尾：' + s); }
      return s.slice(1, -1).replace(/''/g, "'");
    }
    if ('&*!'.indexOf(c) >= 0) { throw new Error('不支援錨點、別名與標籤：' + s); }
    if ('|>'.indexOf(c) >= 0) { throw new Error('不支援多行字串（| 與 >）：請用雙引號字串加 \\n'); }
    if (s === 'true' || s === 'True') { return true; }
    if (s === 'false' || s === 'False') { return false; }
    if (s === 'null' || s === 'Null' || s === '~') { return null; }
    if (NUMBER_RE.test(s)) { return Number(s); }
    return s;
  }

  function quotedKeyEnd(s) {
    var q = s.charAt(0), i = 1;
    while (i < s.length) {
      if (s.charAt(i) === '\\' && q === '"') { i += 2; continue; }
      if (s.charAt(i) === q) {
        if (q === "'" && s.charAt(i + 1) === "'") { i += 2; continue; }
        return i;
      }
      i++;
    }
    return -1;
  }

  // `鍵: 值` 或 `鍵:` → [鍵, 值字串]；不是對照行回 null
  function splitKey(s) {
    if (!s) { return null; }
    var c = s.charAt(0);
    if (c === '[' || c === '{') { return null; }
    if (c === '"' || c === "'") {
      var i = quotedKeyEnd(s);
      if (i < 0 || s.charAt(i + 1) !== ':' || (s.length > i + 2 && s.charAt(i + 2) !== ' ')) { return null; }
      return [scalar(s.slice(0, i + 1)), s.slice(i + 2).trim()];
    }
    var j = s.indexOf(': ');
    if (j < 0) {
      if (s.charAt(s.length - 1) === ':') { j = s.length - 1; } else { return null; }
    }
    var key = s.slice(0, j).trim();
    if (!key || '&*!|>?%@`'.indexOf(key.charAt(0)) >= 0) { return null; }
    return [key, s.slice(j + 1).trim()];
  }

  function Flow(s) { this.s = s; this.i = 0; }
  Flow.prototype.ws = function () { while (this.i < this.s.length && ' \t'.indexOf(this.s.charAt(this.i)) >= 0) { this.i++; } };
  Flow.prototype.value = function () {
    this.ws();
    if (this.i >= this.s.length) { throw new Error('行內寫法沒有寫完：' + this.s); }
    var c = this.s.charAt(this.i), out, c2;
    if (c === '[') {
      this.i++; out = []; this.ws();
      if (this.s.charAt(this.i) === ']') { this.i++; return out; }
      for (;;) {
        out.push(this.value()); this.ws();
        c2 = this.s.charAt(this.i); this.i++;
        if (c2 === ',') { this.ws(); if (this.s.charAt(this.i) === ']') { this.i++; return out; } continue; }
        if (c2 === ']') { return out; }
        throw new Error('行內陣列要用逗號分隔、用 ] 結尾：' + this.s);
      }
    }
    if (c === '{') {
      this.i++; out = {}; this.ws();
      if (this.s.charAt(this.i) === '}') { this.i++; return out; }
      for (;;) {
        this.ws();
        var key = this.token(':');
        this.ws();
        if (this.s.charAt(this.i) !== ':') { throw new Error('行內對照缺少冒號：' + this.s); }
        this.i++;
        out[key] = this.value(); this.ws();
        c2 = this.s.charAt(this.i); this.i++;
        if (c2 === ',') { this.ws(); if (this.s.charAt(this.i) === '}') { this.i++; return out; } continue; }
        if (c2 === '}') { return out; }
        throw new Error('行內對照要用逗號分隔、用 } 結尾：' + this.s);
      }
    }
    return this.token(',]}');
  };
  Flow.prototype.token = function (stops) {
    this.ws();
    var c = this.s.charAt(this.i), j;
    if (c === '"' || c === "'") {
      j = this.i + 1;
      var closed = false;
      while (j < this.s.length) {
        if (this.s.charAt(j) === '\\' && c === '"') { j += 2; continue; }
        if (this.s.charAt(j) === c) {
          if (c === "'" && this.s.charAt(j + 1) === "'") { j += 2; continue; }
          closed = true; break;
        }
        j++;
      }
      if (!closed) { throw new Error('行內的引號字串沒有結尾：' + this.s); }
      var lit = this.s.slice(this.i, j + 1);
      this.i = j + 1;
      return scalar(lit);
    }
    j = this.i;
    while (j < this.s.length && stops.indexOf(this.s.charAt(j)) < 0) { j++; }
    var raw = this.s.slice(this.i, j);
    this.i = j;
    return scalar(raw);
  };

  function flowOrScalar(s) {
    s = s.trim();
    if (s && (s.charAt(0) === '[' || s.charAt(0) === '{')) {
      var f = new Flow(s), v = f.value();
      f.ws();
      if (f.i !== s.length) { throw new Error('行內寫法後面還有多餘的字：' + s); }
      return v;
    }
    return scalar(s);
  }

  function linesOf(text) {
    var out = [];
    text.split('\n').forEach(function (raw, idx) {
      raw = raw.replace(/\r$/, '');
      var lead = raw.slice(0, raw.length - raw.replace(/^\s+/, '').length);
      if (lead.indexOf('\t') >= 0) { throw new Error('第 ' + (idx + 1) + ' 行：縮排不能用 tab'); }
      var body = stripComment(raw).replace(/\s+$/, '');
      if (!body.trim()) { return; }
      out.push({ indent: body.length - body.replace(/^ +/, '').length, content: body.trim(), n: idx + 1 });
    });
    return out;
  }

  function isDash(c) { return c === '-' || c.indexOf('- ') === 0; }

  function Parser(lines) { this.l = lines; this.i = 0; }
  Parser.prototype.block = function (indent) {
    return isDash(this.l[this.i].content) ? this.seq(indent) : this.map(indent);
  };
  Parser.prototype.map = function (indent) {
    var out = {};
    while (this.i < this.l.length) {
      var ln = this.l[this.i];
      if (ln.indent < indent) { break; }
      if (ln.indent > indent) { throw new Error('第 ' + ln.n + ' 行：縮排對不上'); }
      if (isDash(ln.content)) { break; }
      var kv = splitKey(ln.content);
      if (kv === null) { throw new Error('第 ' + ln.n + ' 行：不是「鍵: 值」的寫法：' + ln.content); }
      var key = kv[0], rest = kv[1];
      if (key === '<<') { throw new Error('第 ' + ln.n + ' 行：不支援合併鍵 <<'); }
      if (Object.prototype.hasOwnProperty.call(out, key)) { throw new Error('第 ' + ln.n + ' 行：鍵重複：' + key); }
      this.i++;
      if (rest) { out[key] = flowOrScalar(rest); }
      else if (this.i < this.l.length && (this.l[this.i].indent > indent || (this.l[this.i].indent === indent && isDash(this.l[this.i].content)))) {
        out[key] = this.block(this.l[this.i].indent);
      } else { out[key] = null; }
    }
    return out;
  };
  Parser.prototype.seq = function (indent) {
    var out = [];
    while (this.i < this.l.length) {
      var ln = this.l[this.i];
      if (ln.indent < indent) { break; }
      if (ln.indent > indent) { throw new Error('第 ' + ln.n + ' 行：縮排對不上'); }
      if (!isDash(ln.content)) { break; }
      var rest = ln.content.slice(1).replace(/^ +/, '');
      var offset = ln.content.length - rest.length;
      if (!rest) {
        this.i++;
        if (this.i < this.l.length && this.l[this.i].indent > indent) { out.push(this.block(this.l[this.i].indent)); } else { out.push(null); }
      } else if (splitKey(rest) !== null && '[{'.indexOf(rest.charAt(0)) < 0) {
        this.l[this.i] = { indent: indent + offset, content: rest, n: ln.n };
        out.push(this.map(indent + offset));
      } else {
        this.i++;
        out.push(flowOrScalar(rest));
      }
    }
    return out;
  };

  function parseDocuments(text) {
    var docs = [], cur = [];
    String(text).replace(/\r\n/g, '\n').split('\n').forEach(function (raw) {
      if (raw.replace(/\s+$/, '') === '---' || raw.indexOf('--- ') === 0) { docs.push(cur.join('\n')); cur = []; } else { cur.push(raw); }
    });
    docs.push(cur.join('\n'));
    var records = [];
    docs.forEach(function (d) {
      var lines = linesOf(d);
      if (!lines.length) { return; }
      var p = new Parser(lines), v = p.block(lines[0].indent);
      if (p.i < lines.length) { throw new Error('第 ' + lines[p.i].n + ' 行：多出來的內容（縮排不對？）'); }
      if (v === null || typeof v !== 'object' || Array.isArray(v)) { throw new Error('每份文件（以 --- 分開）要是一筆「鍵: 值」的紀錄'); }
      records.push(v);
    });
    return records;
  }

  function toJsonl(text) { return parseDocuments(text).map(function (r) { return JSON.stringify(r); }).join('\n') + '\n'; }

  return { parseDocuments: parseDocuments, toJsonl: toJsonl };
}));
