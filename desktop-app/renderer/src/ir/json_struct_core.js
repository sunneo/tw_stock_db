/* JSON 型別 ↔ 各語言的資料結構（struct／class）與物件對應：由範例 JSON 或型別描述推出「結構描述」，再產生各語言的型別宣告；
 * C++（與 C）還會產生解析（load）與輸出（save）函式——自寫的小型 JSON 剖析器放進產生的程式，不引入外部函式庫。純函式 UMD。設計見 DESIGN.core-ir.md 第 15 節。
 *
 *   inferSchema(samples[, {name}])   → 結構描述（多個範例會合併：欄位缺的變「可省略」、出現 null 變「可空」、整數與浮點取浮點、對不起來的變 any）
 *   parseTypeDesc(desc[, {name}])    → 結構描述。desc 是 JSON（物件或字串）：值寫型別名 "int|float|bigint|str|bool|any"，後面加 ? 表示可空，陣列寫 [型別]，
 *                                      鍵後面加 ? 表示可省略，{"*": 型別} 表示鍵不固定的字典（鍵為字串）
 *   saveSchema(schema) / loadSchema(textOrObject)   結構描述 ↔ 文字（fa-struct v1，穩定、可存檔、可在 Python／nodejs 間傳遞）
 *   generate(schema, lang, opts)     → { ok, code, marshal, notes }。lang：cpp c python nodejs java csharp；marshal 表示產生的程式含 load／save（java、csharp 只有型別宣告）
 *   CPP_JSON_RUNTIME                 C++ 的通用 JSON 值（JV）＋剖析器＋輸出器（與 Python json.dumps 預設格式一致）；標準操作 json.loads／json.dumps 的 C++ 實作也用它
 *   schemaToIrType(schema)           → 中間語言的型別（IR.tyParse 的字串，struct 以 dict<str,any> 表示）
 * 數字：整數放得進 64 位元就是 int，放不進的是 bigint（以十進位字串保留，輸出原樣，不失精度）；有小數點或指數的是 float。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaJsonStruct = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const VERSION = 1;
    // ---------- 結構描述 ----------
    const P = (k) => ({ k });
    const isInt64 = (txt) => { const neg = txt[0] === '-'; const d = neg ? txt.slice(1) : txt; const lim = neg ? '9223372036854775808' : '9223372036854775807'; return d.length < lim.length || (d.length === lim.length && d <= lim); };
    // 用 JSON.parse 之前先把數字記下來：JavaScript 的 JSON.parse 會讓大整數失精度，所以自己掃一遍，把「整數字面值太大」的位置換成特殊物件
    function parseJsonKeepBig(text) {
        const BIG = Symbol.for('fa.bigint'); let i = 0; const n = text.length;
        const ws = () => { while (i < n && ' \t\n\r'.indexOf(text[i]) >= 0) i++; };
        const err = (m) => { throw new Error('JSON 格式錯誤：' + m + '（位置 ' + i + '）'); };
        function val() {
            ws(); const c = text[i];
            if (c === '{') { i++; const o = {}; const keys = []; ws(); if (text[i] === '}') { i++; return Object.defineProperty(o, '__order', { value: keys, enumerable: false }); } for (;;) { ws(); if (text[i] !== '"') err('物件的鍵要用字串'); const k = str(); ws(); if (text[i] !== ':') err('缺少 :'); i++; const v = val(); if (!Object.prototype.hasOwnProperty.call(o, k)) keys.push(k); Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; break; } err('物件缺少 , 或 }'); } return Object.defineProperty(o, '__order', { value: keys, enumerable: false }); }
            if (c === '[') { i++; const a = []; ws(); if (text[i] === ']') { i++; return a; } for (;;) { a.push(val()); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; break; } err('陣列缺少 , 或 ]'); } return a; }
            if (c === '"') return str();
            if (text.startsWith('true', i)) { i += 4; return true; } if (text.startsWith('false', i)) { i += 5; return false; } if (text.startsWith('null', i)) { i += 4; return null; }
            const m = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400)); if (!m) err('不認得的值'); i += m[0].length;
            if (!m[1] && !m[2]) return isInt64(m[0]) ? { [BIG]: false, v: Number(m[0]), raw: m[0] } : { [BIG]: true, raw: m[0] };
            return { [BIG]: false, f: true, v: Number(m[0]) };
        }
        function str() { const s = i; i++; while (i < n && text[i] !== '"') { if (text[i] === '\\') i++; i++; } if (i >= n) err('字串沒有結束'); i++; try { return JSON.parse(text.slice(s, i)); } catch (e) { err('字串跳脫錯誤'); } }
        const v = val(); ws(); if (i < n) err('後面還有多餘的內容'); return v;
    }
    const BIGK = Symbol.for('fa.bigint');
    const isNum = (v) => v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, BIGK);
    function inferOne(v) {
        if (v === null) return { k: 'null' };
        if (typeof v === 'number') return Number.isInteger(v) ? (Number.isSafeInteger(v) ? P('int') : P('bigint')) : P('float');
        if (typeof v === 'boolean') return P('bool'); if (typeof v === 'string') return P('str');
        if (isNum(v)) return v[BIGK] ? P('bigint') : v.f ? P('float') : P('int');
        if (Array.isArray(v)) { let el = null; v.forEach((x) => { const t = inferOne(x); el = el ? merge(el, t) : t; }); return { k: 'array', of: el || { k: 'any', empty: true } }; }
        const fields = (v.__order || Object.keys(v)).map((name) => ({ name, ty: inferOne(v[name]), opt: false })); return { k: 'object', fields };
    }
    function merge(a, b) {
        if (a.k === 'null') return Object.assign({}, b, { nullable: true }); if (b.k === 'null') return Object.assign({}, a, { nullable: true });
        const nullable = !!(a.nullable || b.nullable); const w = (x) => (nullable ? Object.assign(x, { nullable: true }) : x);
        if (a.k === 'any' && a.empty) return w(Object.assign({}, b)); if (b.k === 'any' && b.empty) return w(Object.assign({}, a));
        if (a.k === b.k) {
            if (a.k === 'array') return w({ k: 'array', of: merge(a.of, b.of) });
            if (a.k === 'map') return w({ k: 'map', of: merge(a.of, b.of) });
            if (a.k === 'object') { const names = a.fields.map((f) => f.name); b.fields.forEach((f) => { if (names.indexOf(f.name) < 0) names.push(f.name); }); return w({ k: 'object', fields: names.map((nm) => { const fa = a.fields.find((f) => f.name === nm), fb = b.fields.find((f) => f.name === nm); if (fa && fb) return { name: nm, ty: merge(fa.ty, fb.ty), opt: !!(fa.opt || fb.opt) }; return Object.assign({}, fa || fb, { opt: true }); }) }); }
            return w(Object.assign({}, a));
        }
        const set = [a.k, b.k].sort().join('+');
        if (set === 'float+int' || set === 'int+number' || set === 'float+number') return w(P('number')); if (set === 'bigint+int') return w(P('bigint'));
        return w({ k: 'any' });
    }
    // 把推出來的 null／empty 收尾：只有 null 的欄位當成 any（JV 本來就能裝 null）
    function finish(s) {
        if (s.k === 'null') return { k: 'any' };
        const o = Object.assign({}, s); delete o.empty;
        if (s.k === 'array') o.of = finish(s.of); if (s.k === 'map') o.of = finish(s.of);
        if (s.k === 'object') o.fields = s.fields.map((f) => Object.assign({}, f, { ty: finish(f.ty) }));
        return o;
    }
    function inferSchema(samples, opts) {
        const list = (Array.isArray(samples) ? samples : [samples]).map((x) => (typeof x === 'string' ? parseJsonKeepBig(x) : x));
        let s = null; list.forEach((v) => { const t = inferOne(v); s = s ? merge(s, t) : t; });
        return { fa_struct: VERSION, name: (opts && opts.name) || 'Root', type: finish(s || { k: 'any' }) };
    }
    function parseTypeDesc(desc, opts) {
        const d = typeof desc === 'string' ? (/^\s*[\[{"]/.test(desc) ? JSON.parse(desc) : desc) : desc;
        const prim = { int: 1, float: 1, number: 1, bigint: 1, str: 1, bool: 1, any: 1 };
        function one(x) {
            if (typeof x === 'string') { let t = x.trim(), nullable = false; if (t.endsWith('?')) { nullable = true; t = t.slice(0, -1); } if (t === 'string') t = 'str';  if (t === 'boolean') t = 'bool'; if (!prim[t]) throw new Error('不認得的型別：' + x); return nullable ? { k: t, nullable: true } : P(t); }
            if (Array.isArray(x)) { if (x.length !== 1) throw new Error('陣列的型別描述要剛好一個元素：' + JSON.stringify(x)); return { k: 'array', of: one(x[0]) }; }
            if (x && typeof x === 'object') { const ks = Object.keys(x); if (ks.length === 1 && ks[0] === '*') return { k: 'map', of: one(x['*']) }; return { k: 'object', fields: ks.map((k) => { const opt = k.endsWith('?'); return { name: opt ? k.slice(0, -1) : k, ty: one(x[k]), opt }; }) }; }
            throw new Error('看不懂的型別描述：' + JSON.stringify(x));
        }
        return { fa_struct: VERSION, name: (opts && opts.name) || 'Root', type: one(d) };
    }
    function saveSchema(schema, indent) { return JSON.stringify(schema, null, indent == null ? 2 : indent); }
    function loadSchema(x) {
        const s = typeof x === 'string' ? JSON.parse(x) : x; if (!s || s.fa_struct == null) throw new Error('不是 fa-struct 結構描述（缺 fa_struct 版本欄位）'); if (s.fa_struct > VERSION) throw new Error('結構描述版本 ' + s.fa_struct + ' 比這個程式新');
        (function chk(t) { if (!t || !t.k) throw new Error('結構描述的節點缺 k'); if (t.k === 'array' || t.k === 'map') chk(t.of); if (t.k === 'object') { if (!Array.isArray(t.fields)) throw new Error('object 缺 fields'); t.fields.forEach((f) => { if (typeof f.name !== 'string') throw new Error('欄位缺 name'); chk(f.ty); }); } else if (['int', 'float', 'number', 'bigint', 'str', 'bool', 'any', 'array', 'map', 'null'].indexOf(t.k) < 0) throw new Error('不認得的型別 ' + t.k); })(s.type);
        return s;
    }
    function schemaToIrType(t) {
        switch (t.k) { case 'array': return 'list<' + schemaToIrType(t.of) + '>'; case 'map': return 'dict<str,' + schemaToIrType(t.of) + '>'; case 'object': return 'dict<str,any>'; case 'bigint': return 'str'; case 'number': return 'float'; case 'null': case 'any': return 'any'; default: return t.k; }
    }

    // ---------- 命名 ----------
    const CPP_KW = new Set('alignas alignof and asm auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long main mutable namespace new noexcept not nullptr operator or private protected public register return short signed sizeof static struct switch template this throw true try typedef typeid typename union unsigned using virtual void volatile while xor stdin stdout stderr EOF NULL'.split(' '));
    const JS_KW = new Set('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof new return super switch this throw try typeof var void while with yield let static enum await implements package protected interface private public null true false'.split(' '));
    const PY_KW = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
    function ident(name, kw) { let s = String(name).replace(/[^A-Za-z0-9_]/g, '_'); if (!s || /^[0-9]/.test(s)) s = '_' + s; if (kw && kw.has(s)) s += '_'; return s; }
    const pascal = (s) => ident(s).replace(/(^|_)([a-z])/g, (m, a, b) => b.toUpperCase()).replace(/_+/g, '_');
    const q = (s) => JSON.stringify(String(s));
    // 收集所有 object 節點，給名字（父名_欄位名），回傳 post-order 清單
    function collectStructs(schema) {
        const out = [], used = new Set();
        const uniq = (nm) => { let x = nm, i = 2; while (used.has(x)) x = nm + '_' + (i++); used.add(x); return x; };
        (function walk(t, hint) { if (t.k === 'array' || t.k === 'map') return walk(t.of, hint + (t.k === 'array' ? '_item' : '_val')); if (t.k !== 'object') return; t.fields.forEach((f) => walk(f.ty, hint + '_' + ident(f.name))); t.sname = uniq(hint); out.push(t); })(schema.type, ident(schema.name || 'Root'));
        return out;
    }

    // ---------- C++ 的 JSON 執行期：通用值 JV、剖析器、輸出器 ----------
    const CPP_JSON_RUNTIME = String.raw`struct JV {
    enum T { NUL, BOOL, INT, BIGINT, FLOAT, STR, ARR, OBJ } t = NUL;
    bool b = false; long long i = 0; double d = 0; std::string s;
    std::vector<JV> a; std::vector<std::pair<std::string, JV>> o;
    JV() {}
    static JV of(bool v) { JV x; x.t = BOOL; x.b = v; return x; }
    static JV of(long long v) { JV x; x.t = INT; x.i = v; return x; }
    static JV of(int v) { return of((long long)v); }
    static JV of(double v) { JV x; x.t = FLOAT; x.d = v; return x; }
    static JV of(const std::string &v) { JV x; x.t = STR; x.s = v; return x; }
    static JV of(const char *v) { return of(std::string(v)); }
    static JV bigint(const std::string &digits) { JV x; x.t = BIGINT; x.s = digits; return x; }
    static JV array() { JV x; x.t = ARR; return x; }
    static JV object() { JV x; x.t = OBJ; return x; }
    bool is_null() const { return t == NUL; }
    size_t size() const { if (t == ARR) return a.size(); if (t == OBJ) return o.size(); if (t == STR) return s.size(); throw std::runtime_error("len() of non-container"); }
    std::vector<JV>::const_iterator begin() const { if (t != ARR) throw std::runtime_error("not iterable"); return a.begin(); }
    std::vector<JV>::const_iterator end() const { return a.end(); }
    bool has(const std::string &k) const { for (const auto &kv : o) if (kv.first == k) return true; return false; }
    const JV &at(const std::string &k) const { if (t != OBJ) throw std::runtime_error("not an object"); for (const auto &kv : o) if (kv.first == k) return kv.second; throw std::runtime_error("KeyError: " + k); }
    const JV &operator[](const std::string &k) const { return at(k); }
    const JV &operator[](const char *k) const { return at(std::string(k)); }
    const JV &operator[](long long idx) const { if (t != ARR) throw std::runtime_error("not an array"); long long n = (long long)a.size(); if (idx < 0) idx += n; if (idx < 0 || idx >= n) throw std::runtime_error("IndexError"); return a[(size_t)idx]; }
    const JV &operator[](int idx) const { return (*this)[(long long)idx]; }
    void set(const std::string &k, const JV &v) { for (auto &kv : o) if (kv.first == k) { kv.second = v; return; } o.emplace_back(k, v); }
    explicit operator long long() const { if (t == INT) return i; if (t == FLOAT) return (long long)d; if (t == BOOL) return b ? 1 : 0; if (t == BIGINT) return std::stoll(s); throw std::runtime_error("not a number"); }
    explicit operator double() const { if (t == FLOAT) return d; if (t == INT) return (double)i; if (t == BIGINT) return std::stod(s); throw std::runtime_error("not a number"); }
    explicit operator std::string() const { if (t == STR || t == BIGINT) return s; throw std::runtime_error("not a string"); }
    explicit operator bool() const { switch (t) { case NUL: return false; case BOOL: return b; case INT: return i != 0; case FLOAT: return d != 0; case STR: case BIGINT: return !s.empty(); case ARR: return !a.empty(); default: return !o.empty(); } }
};
static void fa_jv_utf8(std::string &out, unsigned cp) { if (cp < 0x80) out += (char)cp; else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); } else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); } else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 0x3F)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); } }
struct JvParser {
    const std::string &s; size_t p = 0;
    explicit JvParser(const std::string &src) : s(src) {}
    [[noreturn]] void fail(const char *m) { throw std::runtime_error(std::string("JSON parse error: ") + m + " at " + std::to_string(p)); }
    void ws() { while (p < s.size() && (s[p] == ' ' || s[p] == '\t' || s[p] == '\n' || s[p] == '\r')) p++; }
    unsigned hex4() { if (p + 4 > s.size()) fail("bad \\u escape"); unsigned v = 0; for (int k = 0; k < 4; k++) { char c = s[p++]; v <<= 4; if (c >= '0' && c <= '9') v |= c - '0'; else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10; else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10; else fail("bad \\u escape"); } return v; }
    std::string str() {
        p++; std::string out;
        for (;;) {
            if (p >= s.size()) fail("unterminated string"); unsigned char c = (unsigned char)s[p++];
            if (c == '"') break;
        if (c < 0x20) fail("control character in string");
            if (c != '\\') { out += (char)c; continue; }
            if (p >= s.size()) fail("bad escape"); char e = s[p++];
            switch (e) { case '"': out += '"'; break; case '\\': out += '\\'; break; case '/': out += '/'; break; case 'b': out += '\b'; break; case 'f': out += '\f'; break; case 'n': out += '\n'; break; case 'r': out += '\r'; break; case 't': out += '\t'; break;
                case 'u': { unsigned cp = hex4(); if (cp >= 0xD800 && cp < 0xDC00 && p + 1 < s.size() && s[p] == '\\' && s[p + 1] == 'u') { size_t save = p; p += 2; unsigned lo = hex4(); if (lo >= 0xDC00 && lo < 0xE000) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); else p = save; } fa_jv_utf8(out, cp); break; }
                default: fail("bad escape"); }
        }
        return out;
    }
    JV value(int depth) {
        if (depth > 512) fail("too deep"); ws(); if (p >= s.size()) fail("unexpected end"); char c = s[p];
        if (c == '{') { p++; JV r = JV::object(); ws(); if (p < s.size() && s[p] == '}') { p++; return r; } for (;;) { ws(); if (p >= s.size() || s[p] != '"') fail("expected string key"); std::string k = str(); ws(); if (p >= s.size() || s[p] != ':') fail("expected :"); p++; JV v = value(depth + 1); r.set(k, v); ws(); if (p < s.size() && s[p] == ',') { p++; continue; } if (p < s.size() && s[p] == '}') { p++; break; } fail("expected , or }"); } return r; }
        if (c == '[') { p++; JV r = JV::array(); ws(); if (p < s.size() && s[p] == ']') { p++; return r; } for (;;) { r.a.push_back(value(depth + 1)); ws(); if (p < s.size() && s[p] == ',') { p++; continue; } if (p < s.size() && s[p] == ']') { p++; break; } fail("expected , or ]"); } return r; }
        if (c == '"') return JV::of(str());
        if (s.compare(p, 4, "true") == 0) { p += 4; return JV::of(true); } if (s.compare(p, 5, "false") == 0) { p += 5; return JV::of(false); } if (s.compare(p, 4, "null") == 0) { p += 4; return JV(); }
        size_t st = p; if (p < s.size() && s[p] == '-') p++; if (p >= s.size() || !isdigit((unsigned char)s[p])) fail("bad value");
        if (s[p] == '0') p++; else while (p < s.size() && isdigit((unsigned char)s[p])) p++;
        bool fl = false; if (p < s.size() && s[p] == '.') { fl = true; p++; if (p >= s.size() || !isdigit((unsigned char)s[p])) fail("bad number"); while (p < s.size() && isdigit((unsigned char)s[p])) p++; }
        if (p < s.size() && (s[p] == 'e' || s[p] == 'E')) { fl = true; p++; if (p < s.size() && (s[p] == '+' || s[p] == '-')) p++; if (p >= s.size() || !isdigit((unsigned char)s[p])) fail("bad number"); while (p < s.size() && isdigit((unsigned char)s[p])) p++; }
        std::string txt = s.substr(st, p - st);
        if (fl) return JV::of(strtod(txt.c_str(), NULL));
        bool neg = txt[0] == '-'; std::string dg = neg ? txt.substr(1) : txt; const std::string lim = neg ? "9223372036854775808" : "9223372036854775807";
        if (dg.size() < lim.size() || (dg.size() == lim.size() && dg <= lim)) return JV::of((long long)(neg && dg == lim ? (-9223372036854775807LL - 1) : std::stoll(txt)));
        return JV::bigint(txt);
    }
};
static JV fa_jparse(const std::string &text) { JvParser ps(text); JV v = ps.value(0); ps.ws(); if (ps.p != text.size()) ps.fail("extra data"); return v; }
static std::string fa_jv_quote(const std::string &s) {
    std::string r = "\""; size_t i = 0;
    while (i < s.size()) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"') { r += "\\\""; i++; } else if (c == '\\') { r += "\\\\"; i++; } else if (c == '\n') { r += "\\n"; i++; } else if (c == '\r') { r += "\\r"; i++; } else if (c == '\t') { r += "\\t"; i++; } else if (c == '\b') { r += "\\b"; i++; } else if (c == '\f') { r += "\\f"; i++; }
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); r += b; i++; }
        else if (c < 0x80) { r += (char)c; i++; }
        else { unsigned cp; int n = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : 1; cp = c & (0x3F >> n); for (int k = 1; k <= n && i + k < s.size(); k++) cp = (cp << 6) | ((unsigned char)s[i + k] & 0x3F); i += n + 1; char b[16];
            if (cp >= 0x10000) { cp -= 0x10000; snprintf(b, sizeof b, "\\u%04x\\u%04x", 0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); } else snprintf(b, sizeof b, "\\u%04x", cp); r += b; }
    }
    return r + "\"";
}
static std::string fa_jv_float(double x) {
    if (x != x) return "NaN"; if (x == 1.0 / 0.0) return "Infinity"; if (x == -1.0 / 0.0) return "-Infinity";
    char b[64]; int p = 1; for (; p <= 17; p++) { snprintf(b, sizeof b, "%.*e", p - 1, x); if (strtod(b, NULL) == x) break; }
    std::string m = b; bool neg = m[0] == '-'; if (neg) m = m.substr(1); size_t epos = m.find('e'); std::string digs = m.substr(0, epos); int ex = atoi(m.c_str() + epos + 1); digs.erase(std::remove(digs.begin(), digs.end(), '.'), digs.end());
    while (digs.size() > 1 && digs.back() == '0') digs.pop_back();
    std::string r; int nd = (int)digs.size();
    if (ex >= -4 && ex < 16) { int dp = ex + 1; if (dp <= 0) r = "0." + std::string(-dp, '0') + digs; else if (dp >= nd) r = digs + std::string(dp - nd, '0') + ".0"; else r = digs.substr(0, dp) + "." + digs.substr(dp); }
    else { r = digs.substr(0, 1); if (nd > 1) r += "." + digs.substr(1); char eb[16]; snprintf(eb, sizeof eb, "e%c%02d", ex < 0 ? '-' : '+', ex < 0 ? -ex : ex); r += eb; }
    return (neg ? "-" : "") + r;
}
static void fa_jv_dump(const JV &v, std::string &out) {
    switch (v.t) {
        case JV::NUL: out += "null"; break; case JV::BOOL: out += v.b ? "true" : "false"; break; case JV::INT: out += std::to_string(v.i); break; case JV::BIGINT: out += v.s; break;
        case JV::FLOAT: out += fa_jv_float(v.d); break; case JV::STR: out += fa_jv_quote(v.s); break;
        case JV::ARR: out += "["; for (size_t k = 0; k < v.a.size(); k++) { if (k) out += ", "; fa_jv_dump(v.a[k], out); } out += "]"; break;
        case JV::OBJ: out += "{"; for (size_t k = 0; k < v.o.size(); k++) { if (k) out += ", "; out += fa_jv_quote(v.o[k].first); out += ": "; fa_jv_dump(v.o[k].second, out); } out += "}"; break;
    }
}
static std::string fa_jdump(const JV &v) { std::string r; fa_jv_dump(v, r); return r; }
static std::ostream &operator<<(std::ostream &os, const JV &v) { if (v.t == JV::STR) return os << v.s; if (v.t == JV::INT) return os << v.i; if (v.t == JV::FLOAT) return os << fa_jv_float(v.d); if (v.t == JV::BOOL) return os << (v.b ? "True" : "False"); if (v.t == JV::NUL) return os << "None"; if (v.t == JV::BIGINT) return os << v.s; return os << fa_jdump(v); }`;
    const CPP_INCLUDES = ['<iostream>', '<string>', '<vector>', '<map>', '<set>', '<algorithm>', '<optional>', '<fstream>', '<sstream>', '<stdexcept>', '<cstdio>', '<cstdlib>', '<cctype>', '<iterator>'];

    // ---------- C++ 型別宣告＋對應函式 ----------
    function genCpp(schema, opts) {
        opts = opts || {}; const structs = collectStructs(schema); const root = schema.name || 'Root'; const rn = ident(root, CPP_KW);
        const ty = (t) => { let r; switch (t.k) { case 'int': r = 'long long'; break; case 'float': r = 'double'; break; case 'number': r = 'Num'; break; case 'bigint': r = 'std::string'; break; case 'str': r = 'std::string'; break; case 'bool': r = 'bool'; break; case 'array': r = 'std::vector<' + ty(Object.assign({}, t.of, { nullable: false, _el: 1 })) + '>'; if (t.of.nullable) r = 'std::vector<std::optional<' + ty(Object.assign({}, t.of, { nullable: false })) + '>>'; break; case 'map': r = 'std::vector<std::pair<std::string, ' + (t.of.nullable ? 'std::optional<' + ty(Object.assign({}, t.of, { nullable: false })) + '>' : ty(t.of)) + '>>'; break; case 'object': r = t.sname; break; default: r = 'JV'; } return r; };
        const fty = (f) => { const base = ty(f.ty); return (f.ty.nullable || f.opt) && f.ty.k !== 'any' ? 'std::optional<' + base + '>' : base; };
        const L = []; L.push(...CPP_INCLUDES.map((h) => '#include ' + h), '');
        L.push('// ---- 由 FaJsonStruct 產生：JSON ↔ C++ 結構（自帶剖析器與輸出器，不用外部函式庫）----', CPP_JSON_RUNTIME, '');
        // 通用 get/put（JV ↔ 基本型別、容器）
        L.push(String.raw`static void jv_get(const JV &j, long long &v) { if (j.t == JV::INT) v = j.i; else throw std::runtime_error("expected integer"); }
static void jv_get(const JV &j, double &v) { if (j.t == JV::FLOAT) v = j.d; else if (j.t == JV::INT) v = (double)j.i; else if (j.t == JV::BIGINT) v = std::stod(j.s); else throw std::runtime_error("expected number"); }
static void jv_get(const JV &j, bool &v) { if (j.t == JV::BOOL) v = j.b; else throw std::runtime_error("expected boolean"); }
static void jv_get(const JV &j, std::string &v) { if (j.t == JV::STR) v = j.s; else if (j.t == JV::BIGINT) v = j.s; else if (j.t == JV::INT) v = std::to_string(j.i); else throw std::runtime_error("expected string"); }
static void jv_get(const JV &j, JV &v) { v = j; }
template <class T> static void jv_get(const JV &j, std::optional<T> &v) { if (j.t == JV::NUL) v.reset(); else { T x{}; jv_get(j, x); v = std::move(x); } }
template <class T> static void jv_get(const JV &j, std::vector<T> &v) { if (j.t != JV::ARR) throw std::runtime_error("expected array"); v.clear(); for (const JV &e : j.a) { T x{}; jv_get(e, x); v.push_back(std::move(x)); } }
template <class T> static void jv_get(const JV &j, std::vector<std::pair<std::string, T>> &v) { if (j.t != JV::OBJ) throw std::runtime_error("expected object"); v.clear(); for (const auto &kv : j.o) { T x{}; jv_get(kv.second, x); v.emplace_back(kv.first, std::move(x)); } }
static JV jv_put(long long v) { return JV::of(v); } static JV jv_put(double v) { return JV::of(v); } static JV jv_put(bool v) { return JV::of(v); } static JV jv_put(const JV &v) { return v; }
static JV jv_put(const std::string &v) { return JV::of(v); }
template <class T> static JV jv_put(const std::optional<T> &v) { return v ? jv_put(*v) : JV(); }
template <class T> static JV jv_put(const std::vector<T> &v) { JV r = JV::array(); for (const T &e : v) r.a.push_back(jv_put(e)); return r; }
template <class T> static JV jv_put(const std::vector<std::pair<std::string, T>> &v) { JV r = JV::object(); for (const auto &kv : v) r.set(kv.first, jv_put(kv.second)); return r; }`, '');
        // bigint 欄位用 std::string 存十進位字串：get 接受 INT／BIGINT，put 要輸出成數字（不是字串）→ 用包裝型別區分
        L.push('struct BigInt { std::string digits; };', 'struct Num { bool is_int = true; long long i = 0; double d = 0; };', String.raw`static void jv_get(const JV &j, Num &v) { if (j.t == JV::INT) { v.is_int = true; v.i = j.i; } else if (j.t == JV::FLOAT) { v.is_int = false; v.d = j.d; } else throw std::runtime_error("expected number"); }
static JV jv_put(const Num &v) { return v.is_int ? JV::of(v.i) : JV::of(v.d); }`, String.raw`static void jv_get(const JV &j, BigInt &v) { if (j.t == JV::BIGINT) v.digits = j.s; else if (j.t == JV::INT) v.digits = std::to_string(j.i); else throw std::runtime_error("expected integer"); }
static JV jv_put(const BigInt &v) { return JV::bigint(v.digits); }`, '');
        const bigTy = (t) => t; void bigTy;
        // 結構（bigint 欄位型別用 BigInt）
        const tyB = (t) => (t.k === 'bigint' ? 'BigInt' : t.k === 'number' ? 'Num' : t.k === 'array' ? 'std::vector<' + (t.of.nullable ? 'std::optional<' + tyB(Object.assign({}, t.of, { nullable: false })) + '>' : tyB(t.of)) + '>' : t.k === 'map' ? 'std::vector<std::pair<std::string, ' + (t.of.nullable ? 'std::optional<' + tyB(Object.assign({}, t.of, { nullable: false })) + '>' : tyB(t.of)) + '>>' : ty(t));
        const ftyB = (f) => { const base = tyB(f.ty); if (f.ty.k === 'any') return base; if (f.opt && f.ty.nullable) return 'std::optional<std::optional<' + base + '>>'; return f.opt || f.ty.nullable ? 'std::optional<' + base + '>' : base; };
        structs.forEach((s) => { L.push('struct ' + s.sname + ' {'); const seen = new Set(); s.fields.forEach((f) => { let id = ident(f.name, CPP_KW); while (seen.has(id)) id += '_'; seen.add(id); f.cid = id; L.push('    ' + ftyB(f) + ' ' + id + ';'); }); L.push('};'); });
        L.push('');
        structs.forEach((s) => {
            L.push('static void jv_get(const JV &j, ' + s.sname + ' &v) {', '    if (j.t != JV::OBJ) throw std::runtime_error("expected object for ' + s.sname + '");');
            s.fields.forEach((f) => { const k = q(f.name), id = 'v.' + f.cid; if (f.opt && f.ty.k !== 'any') L.push('    if (j.has(' + k + ')) { ' + id + '.emplace(); jv_get(j.at(' + k + '), *' + id + '); }'); else L.push('    jv_get(j.at(' + k + '), ' + id + ');'); });
            L.push('}', 'static JV jv_put(const ' + s.sname + ' &v) {', '    JV r = JV::object();');
            s.fields.forEach((f) => { L.push(f.opt && f.ty.k !== 'any' ? '    if (v.' + f.cid + ') r.set(' + q(f.name) + ', jv_put(*v.' + f.cid + '));' : '    r.set(' + q(f.name) + ', jv_put(v.' + f.cid + '));'); });
            L.push('    return r;', '}', '');
        });
        const rootTy = schema.type.k === 'object' ? schema.type.sname : tyB(schema.type);
        L.push('// ---- 對外介面：load（字串／檔案）、save（字串／檔案）----',
            'static ' + rootTy + ' ' + rn + '_load(const std::string &text) { ' + rootTy + ' v{}; jv_get(fa_jparse(text), v); return v; }',
            'static ' + rootTy + ' ' + rn + '_load_file(const std::string &path) { std::ifstream f(path, std::ios::binary); if (!f) throw std::runtime_error("cannot open " + path); std::string t((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>()); return ' + rn + '_load(t); }',
            'static std::string ' + rn + '_save(const ' + rootTy + ' &v) { return fa_jdump(jv_put(v)); }',
            'static void ' + rn + '_save_file(const std::string &path, const ' + rootTy + ' &v) { std::ofstream f(path, std::ios::binary); if (!f) throw std::runtime_error("cannot open " + path); f << ' + rn + '_save(v); }');
        if (opts.main) L.push('', 'int main() { std::string t((std::istreambuf_iterator<char>(std::cin)), std::istreambuf_iterator<char>()); try { ' + rootTy + ' v = ' + rn + '_load(t); std::cout << ' + rn + '_save(v) << "\\n"; } catch (const std::exception &e) { std::cout << "ERROR" << "\\n"; return 1; } return 0; }');
        return { ok: true, code: L.join('\n') + '\n', marshal: true, notes: ['bigint 欄位用 BigInt 包裝（十進位字串，輸出時還原成數字）', '可省略且可空的欄位用 optional<optional<T>>：外層表示有沒有這個鍵，內層表示值是不是 null，所以「缺少」與 null 分得開', '欄位順序依結構宣告，不依輸入的鍵順序'] };
    }

    // ---------- C 的 JSON 執行期：通用值 JV*、剖析器、輸出器（C 字串不能含 NUL，所以 JSON 的 \u0000 會被拒絕）----------
    const C_JSON_RUNTIME = String.raw`#pragma GCC diagnostic ignored "-Wunused-function"
typedef struct JV JV;
enum { JT_NUL, JT_BOOL, JT_INT, JT_BIG, JT_FLOAT, JT_STR, JT_ARR, JT_OBJ };
struct JV { int t; long long i; double d; char *s; JV **v; char **k; size_t n, cap; };
typedef char *BigStr;
typedef struct { int is_int; long long i; double d; } Num;
static char fa_err[256];
static int fa_fail(const char *m) { snprintf(fa_err, sizeof fa_err, "%s", m); return 1; }
static const char *fa_json_error(void) { return fa_err; }
static JV *jv_new(int t) { JV *x = (JV *)calloc(1, sizeof(JV)); x->t = t; return x; }
static char *jv_strndup(const char *s, size_t n) { char *r = (char *)malloc(n + 1); memcpy(r, s, n); r[n] = 0; return r; }
static char *jv_strdup(const char *s) { return jv_strndup(s, strlen(s)); }
static void jv_free(JV *x) { size_t k; if (!x) return; if (x->t == JT_STR || x->t == JT_BIG) free(x->s); if (x->t == JT_ARR || x->t == JT_OBJ) { for (k = 0; k < x->n; k++) { jv_free(x->v[k]); if (x->t == JT_OBJ) free(x->k[k]); } free(x->v); free(x->k); } free(x); }
static void jv_push(JV *a, JV *e, const char *key) { if (a->n == a->cap) { a->cap = a->cap ? a->cap * 2 : 4; a->v = (JV **)realloc(a->v, a->cap * sizeof(JV *)); if (a->t == JT_OBJ) a->k = (char **)realloc(a->k, a->cap * sizeof(char *)); } a->v[a->n] = e; if (a->t == JT_OBJ) a->k[a->n] = jv_strdup(key); a->n++; }
static void jv_set(JV *o, const char *key, JV *e) { size_t k; for (k = 0; k < o->n; k++) if (strcmp(o->k[k], key) == 0) { jv_free(o->v[k]); o->v[k] = e; return; } jv_push(o, e, key); }
static const JV *jv_get_key(const JV *o, const char *key) { size_t k; for (k = 0; k < o->n; k++) if (strcmp(o->k[k], key) == 0) return o->v[k]; return NULL; }
static JV *jv_copy(const JV *x) { JV *r = jv_new(x->t); size_t k; r->i = x->i; r->d = x->d; if (x->s) r->s = jv_strdup(x->s); for (k = 0; k < x->n; k++) jv_push(r, jv_copy(x->v[k]), x->t == JT_OBJ ? x->k[k] : NULL); return r; }
typedef struct { char *p; size_t n, cap; } SB;
static void sb_add(SB *b, const char *s, size_t n) { if (b->n + n + 1 > b->cap) { b->cap = (b->n + n + 1) * 2; b->p = (char *)realloc(b->p, b->cap); } memcpy(b->p + b->n, s, n); b->n += n; b->p[b->n] = 0; }
static void sb_str(SB *b, const char *s) { sb_add(b, s, strlen(s)); }
static void sb_utf8(SB *b, unsigned cp) { char t[4]; if (cp < 0x80) { t[0] = (char)cp; sb_add(b, t, 1); } else if (cp < 0x800) { t[0] = (char)(0xC0 | (cp >> 6)); t[1] = (char)(0x80 | (cp & 0x3F)); sb_add(b, t, 2); } else if (cp < 0x10000) { t[0] = (char)(0xE0 | (cp >> 12)); t[1] = (char)(0x80 | ((cp >> 6) & 0x3F)); t[2] = (char)(0x80 | (cp & 0x3F)); sb_add(b, t, 3); } else { t[0] = (char)(0xF0 | (cp >> 18)); t[1] = (char)(0x80 | ((cp >> 12) & 0x3F)); t[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); t[3] = (char)(0x80 | (cp & 0x3F)); sb_add(b, t, 4); } }
typedef struct { const char *s; size_t p, n; } JP;
static void jp_ws(JP *q) { while (q->p < q->n && (q->s[q->p] == ' ' || q->s[q->p] == '\t' || q->s[q->p] == '\n' || q->s[q->p] == '\r')) q->p++; }
static int jp_hex4(JP *q, unsigned *out) { unsigned v = 0; int k; if (q->p + 4 > q->n) return 1; for (k = 0; k < 4; k++) { char c = q->s[q->p++]; v <<= 4; if (c >= '0' && c <= '9') v |= (unsigned)(c - '0'); else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10); else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10); else return 1; } *out = v; return 0; }
static char *jp_str(JP *q) {
    SB b = {0, 0, 0}; q->p++; sb_add(&b, "", 0);
    for (;;) {
        unsigned char c; if (q->p >= q->n) { fa_fail("unterminated string"); free(b.p); return NULL; } c = (unsigned char)q->s[q->p++];
        if (c == '"') break;
        if (c < 0x20) { fa_fail("control character in string"); free(b.p); return NULL; }
        if (c != '\\') { sb_add(&b, (const char *)&c, 1); continue; }
        if (q->p >= q->n) { fa_fail("bad escape"); free(b.p); return NULL; } c = (unsigned char)q->s[q->p++];
        switch (c) { case '"': sb_str(&b, "\""); break; case '\\': sb_str(&b, "\\"); break; case '/': sb_str(&b, "/"); break; case 'b': sb_str(&b, "\b"); break; case 'f': sb_str(&b, "\f"); break; case 'n': sb_str(&b, "\n"); break; case 'r': sb_str(&b, "\r"); break; case 't': sb_str(&b, "\t"); break;
            case 'u': { unsigned cp; if (jp_hex4(q, &cp)) { fa_fail("bad \\u escape"); free(b.p); return NULL; }
                if (cp >= 0xD800 && cp < 0xDC00 && q->p + 1 < q->n && q->s[q->p] == '\\' && q->s[q->p + 1] == 'u') { size_t save = q->p; unsigned lo; q->p += 2; if (!jp_hex4(q, &lo) && lo >= 0xDC00 && lo < 0xE000) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); else q->p = save; }
                if (cp == 0) { fa_fail("NUL character in string is not supported in C"); free(b.p); return NULL; } sb_utf8(&b, cp); break; }
            default: fa_fail("bad escape"); free(b.p); return NULL; }
    }
    return b.p;
}
static JV *jp_value(JP *q, int depth) {
    char c; jp_ws(q); if (depth > 512) { fa_fail("too deep"); return NULL; } if (q->p >= q->n) { fa_fail("unexpected end"); return NULL; } c = q->s[q->p];
    if (c == '{') { JV *r = jv_new(JT_OBJ); q->p++; jp_ws(q); if (q->p < q->n && q->s[q->p] == '}') { q->p++; return r; }
        for (;;) { char *k; JV *v; jp_ws(q); if (q->p >= q->n || q->s[q->p] != '"') { fa_fail("expected string key"); jv_free(r); return NULL; } k = jp_str(q); if (!k) { jv_free(r); return NULL; } jp_ws(q);
            if (q->p >= q->n || q->s[q->p] != ':') { fa_fail("expected :"); free(k); jv_free(r); return NULL; } q->p++; v = jp_value(q, depth + 1); if (!v) { free(k); jv_free(r); return NULL; } jv_set(r, k, v); free(k); jp_ws(q);
            if (q->p < q->n && q->s[q->p] == ',') { q->p++; continue; } if (q->p < q->n && q->s[q->p] == '}') { q->p++; break; } fa_fail("expected , or }"); jv_free(r); return NULL; }
        return r; }
    if (c == '[') { JV *r = jv_new(JT_ARR); q->p++; jp_ws(q); if (q->p < q->n && q->s[q->p] == ']') { q->p++; return r; }
        for (;;) { JV *v = jp_value(q, depth + 1); if (!v) { jv_free(r); return NULL; } jv_push(r, v, NULL); jp_ws(q); if (q->p < q->n && q->s[q->p] == ',') { q->p++; continue; } if (q->p < q->n && q->s[q->p] == ']') { q->p++; break; } fa_fail("expected , or ]"); jv_free(r); return NULL; }
        return r; }
    if (c == '"') { JV *r = jv_new(JT_STR); r->s = jp_str(q); if (!r->s) { free(r); return NULL; } return r; }
    if (q->n - q->p >= 4 && strncmp(q->s + q->p, "true", 4) == 0) { JV *r = jv_new(JT_BOOL); r->i = 1; q->p += 4; return r; }
    if (q->n - q->p >= 5 && strncmp(q->s + q->p, "false", 5) == 0) { JV *r = jv_new(JT_BOOL); q->p += 5; return r; }
    if (q->n - q->p >= 4 && strncmp(q->s + q->p, "null", 4) == 0) { q->p += 4; return jv_new(JT_NUL); }
    { size_t st = q->p; int fl = 0, neg = 0; char *txt; size_t len; JV *r;
      if (q->s[q->p] == '-') { neg = 1; q->p++; } if (q->p >= q->n || !isdigit((unsigned char)q->s[q->p])) { fa_fail("bad value"); return NULL; }
      if (q->s[q->p] == '0') q->p++; else while (q->p < q->n && isdigit((unsigned char)q->s[q->p])) q->p++;
      if (q->p < q->n && q->s[q->p] == '.') { fl = 1; q->p++; if (q->p >= q->n || !isdigit((unsigned char)q->s[q->p])) { fa_fail("bad number"); return NULL; } while (q->p < q->n && isdigit((unsigned char)q->s[q->p])) q->p++; }
      if (q->p < q->n && (q->s[q->p] == 'e' || q->s[q->p] == 'E')) { fl = 1; q->p++; if (q->p < q->n && (q->s[q->p] == '+' || q->s[q->p] == '-')) q->p++; if (q->p >= q->n || !isdigit((unsigned char)q->s[q->p])) { fa_fail("bad number"); return NULL; } while (q->p < q->n && isdigit((unsigned char)q->s[q->p])) q->p++; }
      len = q->p - st; txt = jv_strndup(q->s + st, len);
      if (fl) { r = jv_new(JT_FLOAT); r->d = strtod(txt, NULL); free(txt); return r; }
      { const char *dg = neg ? txt + 1 : txt; const char *lim = neg ? "9223372036854775808" : "9223372036854775807"; size_t dl = strlen(dg), ll = strlen(lim);
        if (dl < ll || (dl == ll && strcmp(dg, lim) <= 0)) { r = jv_new(JT_INT); r->i = (neg && strcmp(dg, lim) == 0) ? (-9223372036854775807LL - 1) : strtoll(txt, NULL, 10); free(txt); return r; }
        r = jv_new(JT_BIG); r->s = txt; return r; } }
}
static JV *fa_jparse(const char *text) { JP q; JV *v; q.s = text; q.p = 0; q.n = strlen(text); v = jp_value(&q, 0); if (!v) return NULL; jp_ws(&q); if (q.p != q.n) { fa_fail("extra data"); jv_free(v); return NULL; } return v; }
static void sb_quote(SB *b, const char *s) {
    const unsigned char *u = (const unsigned char *)s; sb_str(b, "\"");
    while (*u) { unsigned char c = *u; char t[16];
        if (c == '"') { sb_str(b, "\\\""); u++; } else if (c == '\\') { sb_str(b, "\\\\"); u++; } else if (c == '\n') { sb_str(b, "\\n"); u++; } else if (c == '\r') { sb_str(b, "\\r"); u++; } else if (c == '\t') { sb_str(b, "\\t"); u++; } else if (c == '\b') { sb_str(b, "\\b"); u++; } else if (c == '\f') { sb_str(b, "\\f"); u++; }
        else if (c < 0x20) { snprintf(t, sizeof t, "\\u%04x", c); sb_str(b, t); u++; } else if (c < 0x80) { sb_add(b, (const char *)&c, 1); u++; }
        else { int n = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : 1, k; unsigned cp = c & (0x3Fu >> n); for (k = 1; k <= n && u[k]; k++) cp = (cp << 6) | (u[k] & 0x3Fu); u += n + 1;
            if (cp >= 0x10000) { cp -= 0x10000; snprintf(t, sizeof t, "\\u%04x\\u%04x", 0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); } else snprintf(t, sizeof t, "\\u%04x", cp); sb_str(b, t); } }
    sb_str(b, "\"");
}
static void sb_float(SB *b, double x) {
    char buf[64], eb[16]; int p, nd, ex, dp, i, j; char digs[40]; const char *m; int neg;
    if (x != x) { sb_str(b, "NaN"); return; } if (x > 1.7976931348623157e308) { sb_str(b, "Infinity"); return; } if (x < -1.7976931348623157e308) { sb_str(b, "-Infinity"); return; }
    for (p = 1; p <= 17; p++) { snprintf(buf, sizeof buf, "%.*e", p - 1, x); if (strtod(buf, NULL) == x) break; }
    m = buf; neg = *m == '-';
    if (neg) m++;
    j = 0; for (i = 0; m[i] && m[i] != 'e'; i++) if (m[i] != '.') digs[j++] = m[i]; digs[j] = 0; ex = atoi(m + i + 1); nd = j; while (nd > 1 && digs[nd - 1] == '0') digs[--nd] = 0;
    if (neg) sb_str(b, "-");
    if (ex >= -4 && ex < 16) { dp = ex + 1;
        if (dp <= 0) { sb_str(b, "0."); for (i = 0; i < -dp; i++) sb_str(b, "0"); sb_str(b, digs); }
        else if (dp >= nd) { sb_str(b, digs); for (i = 0; i < dp - nd; i++) sb_str(b, "0"); sb_str(b, ".0"); }
        else { sb_add(b, digs, (size_t)dp); sb_str(b, "."); sb_str(b, digs + dp); } }
    else { sb_add(b, digs, 1); if (nd > 1) { sb_str(b, "."); sb_str(b, digs + 1); } snprintf(eb, sizeof eb, "e%c%02d", ex < 0 ? '-' : '+', ex < 0 ? -ex : ex); sb_str(b, eb); }
}
static void sb_jv(SB *b, const JV *v) {
    char t[32]; size_t k;
    switch (v->t) { case JT_NUL: sb_str(b, "null"); break; case JT_BOOL: sb_str(b, v->i ? "true" : "false"); break; case JT_INT: snprintf(t, sizeof t, "%lld", v->i); sb_str(b, t); break; case JT_BIG: sb_str(b, v->s); break;
        case JT_FLOAT: sb_float(b, v->d); break; case JT_STR: sb_quote(b, v->s); break;
        case JT_ARR: sb_str(b, "["); for (k = 0; k < v->n; k++) { if (k) sb_str(b, ", "); sb_jv(b, v->v[k]); } sb_str(b, "]"); break;
        case JT_OBJ: sb_str(b, "{"); for (k = 0; k < v->n; k++) { if (k) sb_str(b, ", "); sb_quote(b, v->k[k]); sb_str(b, ": "); sb_jv(b, v->v[k]); } sb_str(b, "}"); break; }
}
static char *fa_jdump(const JV *v) { SB b = {0, 0, 0}; sb_add(&b, "", 0); sb_jv(&b, v); return b.p; }
static int get_ll(const JV *j, long long *v) { if (j->t != JT_INT) return fa_fail("expected integer"); *v = j->i; return 0; }
static JV *put_ll(const long long *v) { JV *x = jv_new(JT_INT); x->i = *v; return x; }
static void free_ll(long long *v) { (void)v; }
static int get_dbl(const JV *j, double *v) { if (j->t == JT_FLOAT) *v = j->d; else if (j->t == JT_INT) *v = (double)j->i; else if (j->t == JT_BIG) *v = strtod(j->s, NULL); else return fa_fail("expected number"); return 0; }
static JV *put_dbl(const double *v) { JV *x = jv_new(JT_FLOAT); x->d = *v; return x; }
static void free_dbl(double *v) { (void)v; }
static int get_bool(const JV *j, int *v) { if (j->t != JT_BOOL) return fa_fail("expected boolean"); *v = (int)j->i; return 0; }
static JV *put_bool(const int *v) { JV *x = jv_new(JT_BOOL); x->i = *v; return x; }
static void free_bool(int *v) { (void)v; }
static int get_str(const JV *j, char **v) { if (j->t != JT_STR) return fa_fail("expected string"); *v = jv_strdup(j->s); return 0; }
static JV *put_str(char *const *v) { JV *x = jv_new(JT_STR); x->s = jv_strdup(*v ? *v : ""); return x; }
static void free_str(char **v) { free(*v); *v = NULL; }
static int get_big(const JV *j, BigStr *v) { if (j->t == JT_BIG) *v = jv_strdup(j->s); else if (j->t == JT_INT) { char t[32]; snprintf(t, sizeof t, "%lld", j->i); *v = jv_strdup(t); } else return fa_fail("expected integer"); return 0; }
static JV *put_big(const BigStr *v) { JV *x = jv_new(JT_BIG); x->s = jv_strdup(*v ? *v : "0"); return x; }
static void free_big(BigStr *v) { free(*v); *v = NULL; }
static int get_num(const JV *j, Num *v) { if (j->t == JT_INT) { v->is_int = 1; v->i = j->i; } else if (j->t == JT_FLOAT) { v->is_int = 0; v->d = j->d; } else return fa_fail("expected number"); return 0; }
static JV *put_num(const Num *v) { JV *x; if (v->is_int) { x = jv_new(JT_INT); x->i = v->i; } else { x = jv_new(JT_FLOAT); x->d = v->d; } return x; }
static void free_num(Num *v) { (void)v; }
static int get_jv(const JV *j, JV **v) { *v = jv_copy(j); return 0; }
static JV *put_jv(JV *const *v) { return *v ? jv_copy(*v) : jv_new(JT_NUL); }
static void free_jv(JV **v) { jv_free(*v); *v = NULL; }`;
    const C_INCLUDES = ['<stdio.h>', '<stdlib.h>', '<string.h>', '<ctype.h>', '<math.h>'];

    // ---------- C 型別宣告＋對應函式 ----------
    function genC(schema, opts) {
        opts = opts || {}; const structs = collectStructs(schema); const rn = ident(schema.name || 'Root', CPP_KW);
        const code = []; const seen = {};
        const prim = { int: ['long long', 'll'], float: ['double', 'dbl'], bool: ['int', 'bool'], str: ['char *', 'str'], bigint: ['BigStr', 'big'], number: ['Num', 'num'], any: ['JV *', 'jv'] };
        const wrap = (kind, inner) => { // kind: 'Arr' | 'Map' | 'Opt'；inner：{ct, m}
            const nm = kind + '_' + inner.m; if (!seen[nm]) { seen[nm] = true;
                if (kind === 'Arr') code.push('typedef struct { ' + inner.ct + ' *d; size_t n; } ' + nm + ';',
                    'static int get_' + nm + '(const JV *j, ' + nm + ' *v) { size_t i; if (j->t != JT_ARR) return fa_fail("expected array"); v->n = 0; v->d = (' + inner.ct + ' *)calloc(j->n ? j->n : 1, sizeof(' + inner.ct + ')); for (i = 0; i < j->n; i++) { if (get_' + inner.m + '(j->v[i], &v->d[i])) return 1; v->n = i + 1; } return 0; }',
                    'static JV *put_' + nm + '(const ' + nm + ' *v) { size_t i; JV *r = jv_new(JT_ARR); for (i = 0; i < v->n; i++) jv_push(r, put_' + inner.m + '(&v->d[i]), NULL); return r; }',
                    'static void free_' + nm + '(' + nm + ' *v) { size_t i; for (i = 0; i < v->n; i++) free_' + inner.m + '(&v->d[i]); free(v->d); v->d = NULL; v->n = 0; }');
                else if (kind === 'Map') code.push('typedef struct { char **k; ' + inner.ct + ' *d; size_t n; } ' + nm + ';',
                    'static int get_' + nm + '(const JV *j, ' + nm + ' *v) { size_t i; if (j->t != JT_OBJ) return fa_fail("expected object"); v->n = 0; v->k = (char **)calloc(j->n ? j->n : 1, sizeof(char *)); v->d = (' + inner.ct + ' *)calloc(j->n ? j->n : 1, sizeof(' + inner.ct + ')); for (i = 0; i < j->n; i++) { v->k[i] = jv_strdup(j->k[i]); if (get_' + inner.m + '(j->v[i], &v->d[i])) { v->n = i + 1; return 1; } v->n = i + 1; } return 0; }',
                    'static JV *put_' + nm + '(const ' + nm + ' *v) { size_t i; JV *r = jv_new(JT_OBJ); for (i = 0; i < v->n; i++) jv_set(r, v->k[i], put_' + inner.m + '(&v->d[i])); return r; }',
                    'static void free_' + nm + '(' + nm + ' *v) { size_t i; for (i = 0; i < v->n; i++) { free(v->k[i]); free_' + inner.m + '(&v->d[i]); } free(v->k); free(v->d); v->k = NULL; v->d = NULL; v->n = 0; }');
                else code.push('typedef struct { int has; ' + inner.ct + ' v; } ' + nm + ';',
                    'static int get_' + nm + '(const JV *j, ' + nm + ' *v) { if (j->t == JT_NUL) { v->has = 0; return 0; } v->has = 1; return get_' + inner.m + '(j, &v->v); }',
                    'static JV *put_' + nm + '(const ' + nm + ' *v) { return v->has ? put_' + inner.m + '(&v->v) : jv_new(JT_NUL); }',
                    'static void free_' + nm + '(' + nm + ' *v) { if (v->has) free_' + inner.m + '(&v->v); v->has = 0; }'); }
            return { ct: nm, m: nm }; };
        const nn = (t) => Object.assign({}, t, { nullable: false });
        let info;
        const elem = (t) => (t.nullable ? wrap('Opt', info(nn(t))) : info(t));   // 陣列／字典的元素：可空就包 Opt
        info = (t) => { if (prim[t.k]) return { ct: prim[t.k][0], m: prim[t.k][1] }; if (t.k === 'array') return wrap('Arr', elem(t.of)); if (t.k === 'map') return wrap('Map', elem(t.of)); if (t.k === 'object') return { ct: t.sname, m: t.sname }; return { ct: 'JV *', m: 'jv' }; };
        structs.forEach((s) => {
            const fl = s.fields.map((f) => { f.cid = ident(f.name, CPP_KW); const base = info(nn(f.ty)); let ty, mode;
                if (f.ty.k === 'any') { ty = base; mode = 'plain'; } else if (f.opt && f.ty.nullable) { ty = wrap('Opt', wrap('Opt', base)); mode = 'optnull'; } else if (f.opt) { ty = wrap('Opt', base); mode = 'opt'; } else if (f.ty.nullable) { ty = wrap('Opt', base); mode = 'null'; } else { ty = base; mode = 'plain'; }
                return { f, ty, base, mode }; });
            const seenId = new Set(); fl.forEach((x) => { while (seenId.has(x.f.cid)) x.f.cid += '_'; seenId.add(x.f.cid); });
            code.push('typedef struct {' + fl.map((x) => ' ' + x.ty.ct + ' ' + x.f.cid + ';').join('') + (fl.length ? '' : ' int _empty;') + ' } ' + s.sname + ';');
            const g = ['static int get_' + s.sname + '(const JV *j, ' + s.sname + ' *v) {', '    const JV *e = NULL; (void)e; memset(v, 0, sizeof *v); if (j->t != JT_OBJ) return fa_fail("expected object");'];
            const pu = ['static JV *put_' + s.sname + '(const ' + s.sname + ' *v) {', '    JV *r = jv_new(JT_OBJ);'], fr = ['static void free_' + s.sname + '(' + s.sname + ' *v) {'];
            fl.forEach((x) => { const k = q(x.f.name), id = 'v->' + x.f.cid; const tm = x.ty.m;
                if (x.mode === 'opt' || x.mode === 'optnull') { const innerM = x.mode === 'opt' ? x.base.m : tm.replace(/^Opt_/, ''); g.push('    e = jv_get_key(j, ' + k + '); if (e) { ' + id + '.has = 1; if (get_' + innerM + '(e, &' + id + '.v)) return 1; }'); pu.push('    if (' + id + '.has) jv_set(r, ' + k + ', put_' + innerM + '(&' + id + '.v));'); fr.push('    free_' + tm + '(&' + id + ');'); }
                else { g.push('    e = jv_get_key(j, ' + k + '); if (!e) return fa_fail("missing key: ' + x.f.name.replace(/["\\]/g, '') + '"); if (get_' + tm + '(e, &' + id + ')) return 1;'); pu.push('    jv_set(r, ' + k + ', put_' + tm + '(&' + id + '));'); fr.push('    free_' + tm + '(&' + id + ');'); } });
            g.push('    return 0;', '}'); pu.push('    return r;', '}'); fr.push('}'); code.push(...g, ...pu, ...fr);
        });
        const root = info(nn(schema.type)); if (schema.type.k !== 'object') code.push('typedef ' + root.ct + ' ' + rn + ';');
        const RT = schema.type.k === 'object' ? schema.type.sname : rn; const rm = root.m;
        code.push('// ---- 對外介面：load（字串／檔案）傳回 0 成功（錯誤訊息用 fa_json_error()）、save 傳回 malloc 的字串（用完 free）、free 釋放結構內的記憶體 ----',
            'static int ' + rn + '_load(const char *text, ' + RT + ' *out) { JV *j = fa_jparse(text); int bad; if (!j) return 1; memset(out, 0, sizeof *out); bad = get_' + rm + '(j, out); jv_free(j); return bad; }',
            'static int ' + rn + '_load_file(const char *path, ' + RT + ' *out) { FILE *f = fopen(path, "rb"); char *buf; long n; int bad; if (!f) return fa_fail("cannot open file"); fseek(f, 0, SEEK_END); n = ftell(f); fseek(f, 0, SEEK_SET); buf = (char *)malloc((size_t)n + 1); n = (long)fread(buf, 1, (size_t)n, f); buf[n] = 0; fclose(f); bad = ' + rn + '_load(buf, out); free(buf); return bad; }',
            'static char *' + rn + '_save(const ' + RT + ' *v) { JV *j = put_' + rm + '(v); char *s = fa_jdump(j); jv_free(j); return s; }',
            'static int ' + rn + '_save_file(const char *path, const ' + RT + ' *v) { char *s = ' + rn + '_save(v); FILE *f = fopen(path, "wb"); if (!f) { free(s); return fa_fail("cannot open file"); } fputs(s, f); fclose(f); free(s); return 0; }',
            'static void ' + rn + '_free(' + RT + ' *v) { free_' + rm + '(v); }');
        if (opts.main) code.push('', 'int main(void) { size_t cap = 4096, n = 0; char *buf = (char *)malloc(cap); int ch; ' + RT + ' v; char *out; while ((ch = getchar()) != EOF) { if (n + 2 > cap) { cap *= 2; buf = (char *)realloc(buf, cap); } buf[n++] = (char)ch; } buf[n] = 0; if (' + rn + '_load(buf, &v)) { puts("ERROR"); return 1; } out = ' + rn + '_save(&v); puts(out); free(out); ' + rn + '_free(&v); free(buf); return 0; }');
        return { ok: true, code: C_INCLUDES.map((h) => '#include ' + h).join('\n') + '\n\n// ---- 由 FaJsonStruct 產生：JSON ↔ C 結構（自帶剖析器與輸出器）----\n' + C_JSON_RUNTIME + '\n\n' + code.join('\n') + '\n', marshal: true, notes: ['字串是 malloc 的 char *（JSON 的 \\u0000 會被拒絕：C 字串不能含 NUL）', 'bigint 欄位是十進位字串 BigStr', '陣列 {d, n}、字典 {k, d, n}、可省略／可空 {has, v}；用完呼叫 ' + rn + '_free'] };
    }


    // ---------- Python：dataclass＋from_dict／to_dict＋ loads／load／dumps／save ----------
    function genPython(schema, opts) {
        opts = opts || {}; const structs = collectStructs(schema); const nn = (t) => Object.assign({}, t, { nullable: false });
        let uid = 0;
        const from = (t, e) => { let r; const inner = nn(t);
            if (t.nullable) return '(None if ' + e + ' is None else ' + from(inner, e) + ')';
            switch (t.k) {
                case 'array': { const v = '_x' + (++uid); r = '[' + from(t.of, v) + ' for ' + v + ' in ' + e + ']'; break; }
                case 'map': { const v = '_v' + (++uid); r = '{_k: ' + from(t.of, v) + ' for _k, ' + v + ' in ' + e + '.items()}'; break; }
                case 'object': r = t.sname + '.from_dict(' + e + ')'; break;
                default: r = e;
            }
            return r; };
        const to = (t, e) => { if (t.nullable) return '(None if ' + e + ' is None else ' + to(nn(t), e) + ')';
            switch (t.k) {
                case 'array': { const v = '_x' + (++uid); return '[' + to(t.of, v) + ' for ' + v + ' in ' + e + ']'; }
                case 'map': { const v = '_v' + (++uid); return '{_k: ' + to(t.of, v) + ' for _k, ' + v + ' in ' + e + '.items()}'; }
                case 'object': return e + '.to_dict()';
                default: return e;
            } };
        const pyTy = (t) => { let r; switch (t.k) { case 'int': case 'bigint': r = 'int'; break; case 'float': r = 'float'; break; case 'number': r = 'float'; break; case 'str': r = 'str'; break; case 'bool': r = 'bool'; break; case 'array': r = 'List[' + pyTy(t.of) + ']'; break; case 'map': r = 'Dict[str, ' + pyTy(t.of) + ']'; break; case 'object': r = "'" + t.sname + "'"; break; default: r = 'Any'; } return t.nullable && r !== 'Any' ? 'Optional[' + r + ']' : r; };
        const L = ['# 由 FaJsonStruct 產生：JSON ↔ Python 資料類別（dataclass）。loads／load 讀入（字串／檔案），dumps／save 輸出（字串／檔案）。', 'from __future__ import annotations', 'import json', 'from dataclasses import dataclass', 'from typing import Any, Dict, List, Optional', '', '_MISSING = object()  # 可省略的欄位沒有出現時的值（不輸出）', ''];
        structs.forEach((s) => {
            const seen = new Set(); s.fields.forEach((f) => { let id = ident(f.name, PY_KW); while (seen.has(id)) id += '_'; seen.add(id); f.pid = id; });
            L.push('@dataclass', 'class ' + s.sname + ':');
            const req = s.fields.filter((f) => !f.opt), opt = s.fields.filter((f) => f.opt);
            if (!s.fields.length) L.push('    pass');
            req.forEach((f) => L.push('    ' + f.pid + ': ' + pyTy(f.ty))); opt.forEach((f) => L.push('    ' + f.pid + ': ' + pyTy(f.ty) + ' = _MISSING'));
            L.push('', '    @staticmethod', '    def from_dict(d):', '        if not isinstance(d, dict):', '            raise ValueError("expected object for ' + s.sname + '")');
            L.push('        return ' + s.sname + '(' + s.fields.map((f) => f.pid + '=' + (f.opt ? '(' + from(f.ty, 'd[' + q(f.name) + ']') + ' if ' + q(f.name) + ' in d else _MISSING)' : from(f.ty, 'd[' + q(f.name) + ']'))).join(', ') + ')');
            L.push('', '    def to_dict(self):', '        r = {}');
            s.fields.forEach((f) => { L.push(f.opt ? '        if self.' + f.pid + ' is not _MISSING:' : '        if True:', '            r[' + q(f.name) + '] = ' + to(f.ty, 'self.' + f.pid)); });
            L.push('        return r', '', '');
        });
        L.push('def loads(text):', '    """從 JSON 字串讀入，回傳根型別的物件。"""', '    return ' + from(schema.type, 'json.loads(text)'), '', '',
            'def load(path):', '    """從檔案讀入（UTF-8）。"""', '    with open(path, encoding="utf-8") as f:', '        return loads(f.read())', '', '',
            'def dumps(obj, **kw):', '    """輸出成 JSON 字串（參數同 json.dumps）。"""', '    return json.dumps(' + to(schema.type, 'obj') + ', **kw)', '', '',
            'def save(obj, path=None, **kw):', '    """輸出成 JSON；給 path 就寫檔（UTF-8）並回傳 None，沒給就回傳字串。"""', '    s = dumps(obj, **kw)', '    if path is None:', '        return s', '    with open(path, "w", encoding="utf-8") as f:', '        f.write(s)', '    return None');
        if (opts.main) L.push('', '', 'if __name__ == "__main__":', '    import sys', '    print(save(load(sys.argv[1])) if len(sys.argv) > 1 else save(loads(sys.stdin.read())))');
        return { ok: true, code: L.join('\n') + '\n', marshal: true, notes: ['bigint 是 Python int（不失精度）', 'number 欄位保留輸入的整數或浮點'] };
    }

    // ---------- nodejs：class＋fromJSON／toJSON＋ loads／load／dumps／save ----------
    function genNodejs(schema, opts) {
        opts = opts || {}; const structs = collectStructs(schema); const nn = (t) => Object.assign({}, t, { nullable: false }); let uid = 0;
        const from = (t, e) => { if (t.nullable) return '(' + e + ' == null ? null : ' + from(nn(t), e) + ')';
            switch (t.k) { case 'array': { const v = 'x' + (++uid); return e + '.map((' + v + ') => ' + from(t.of, v) + ')'; } case 'map': { const v = 'v' + (++uid); return 'Object.fromEntries(Object.entries(' + e + ').map(([k, ' + v + ']) => [k, ' + from(t.of, v) + ']))'; } case 'object': return t.sname + '.fromJSON(' + e + ')'; default: return e; } };
        const to = (t, e) => { if (t.nullable) return '(' + e + ' == null ? null : ' + to(nn(t), e) + ')';
            switch (t.k) { case 'array': { const v = 'x' + (++uid); return e + '.map((' + v + ') => ' + to(t.of, v) + ')'; } case 'map': { const v = 'v' + (++uid); return 'Object.fromEntries(Object.entries(' + e + ').map(([k, ' + v + ']) => [k, ' + to(t.of, v) + ']))'; } case 'object': return e + '.toJSON()'; default: return e; } };
        const jsTy = (t) => { let r; switch (t.k) { case 'int': case 'float': case 'number': r = 'number'; break; case 'bigint': r = 'number'; break; case 'str': r = 'string'; break; case 'bool': r = 'boolean'; break; case 'array': r = 'Array<' + jsTy(t.of) + '>'; break; case 'map': r = 'Object<string, ' + jsTy(t.of) + '>'; break; case 'object': r = t.sname; break; default: r = '*'; } return t.nullable && r !== '*' ? '?' + r : r; };
        const L = ['// 由 FaJsonStruct 產生：JSON ↔ JavaScript 類別。loads／load 讀入（字串／檔案），dumps／save 輸出（字串／檔案）。', "'use strict';", "const fs = require('fs');", ''];
        structs.forEach((s) => {
            s.fields.forEach((f) => { f.pid = ident(f.name, null); });
            L.push('class ' + s.sname + ' {', '    /** @param {{' + s.fields.map((f) => f.pid + (f.opt ? '?' : '') + ': ' + jsTy(f.ty)).join(', ') + '}} o */', '    constructor(o) { Object.assign(this, o); }',
                '    static fromJSON(o) {', '        if (o === null || typeof o !== "object" || Array.isArray(o)) throw new Error("expected object for ' + s.sname + '");');
            s.fields.forEach((f) => { const k = q(f.name); if (!f.opt) L.push('        if (!(' + k + ' in o)) throw new Error("missing key: ' + f.name.replace(/["\\]/g, '') + '");'); });
            L.push('        return new ' + s.sname + '({ ' + s.fields.map((f) => q(f.pid) + ': ' + (f.opt ? '(' + q(f.name) + ' in o ? ' + from(f.ty, 'o[' + q(f.name) + ']') + ' : undefined)' : from(f.ty, 'o[' + q(f.name) + ']'))).join(', ') + ' });', '    }',
                '    toJSON() {', '        const r = {};');
            s.fields.forEach((f) => { L.push(f.opt ? '        if (this[' + q(f.pid) + '] !== undefined) r[' + q(f.name) + '] = ' + to(f.ty, 'this[' + q(f.pid) + ']') + ';' : '        r[' + q(f.name) + '] = ' + to(f.ty, 'this[' + q(f.pid) + ']') + ';'); });
            L.push('        return r;', '    }', '}', '');
        });
        L.push('function loads(text) { return ' + from(schema.type, 'JSON.parse(text)') + '; }', 'function load(path) { return loads(fs.readFileSync(path, "utf8")); }', 'function dumps(obj, space) { return JSON.stringify(' + to(schema.type, 'obj') + ', null, space); }',
            'function save(obj, path, space) { const s = dumps(obj, space); if (path == null) return s; fs.writeFileSync(path, s, "utf8"); return null; }', '', 'module.exports = { ' + structs.map((s) => s.sname).join(', ') + (structs.length ? ', ' : '') + 'loads, load, dumps, save };');
        if (opts.main) L.push('', 'if (require.main === module) { const t = process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : fs.readFileSync(0, "utf8"); console.log(dumps(loads(t))); }');
        return { ok: true, code: L.join('\n') + '\n', marshal: true, notes: ['用 JSON.parse：超過 2^53 的整數會失去精度（bigint 欄位在這裡不是 BigInt），需要精準請用 Python／C／C++ 版', '輸出沒有空白（JSON.stringify 預設），與 Python json.dumps 的格式不同但內容相同'] };
    }

    // ---------- Java／C#：只有型別宣告（沒有 load／save；Java 標準函式庫沒有 JSON，C# 的 System.Text.Json 可直接用這些類別）----------
    function genJava(schema) {
        const structs = collectStructs(schema); const box = (s) => ({ long: 'Long', double: 'Double', boolean: 'Boolean' }[s] || s);
        const jt = (t, boxed) => { let r; switch (t.k) { case 'int': r = 'long'; break; case 'float': r = 'double'; break; case 'number': r = 'Number'; break; case 'bigint': r = 'java.math.BigInteger'; break; case 'str': r = 'String'; break; case 'bool': r = 'boolean'; break; case 'array': r = 'List<' + jt(t.of, true) + '>'; break; case 'map': r = 'Map<String, ' + jt(t.of, true) + '>'; break; case 'object': r = t.sname; break; default: r = 'Object'; } return boxed || t.nullable || t.__opt ? box(r) : r; };
        const L = ['// 由 FaJsonStruct 產生：JSON 結構的 Java 型別宣告（只有欄位；Java 標準函式庫沒有 JSON，讀寫請用 Jackson／Gson，欄位名就是 JSON 的鍵；鍵不是合法識別字時加底線）。', 'import java.util.*;', '', 'public class ' + ident(schema.name || 'Root') + 'Types {'];
        structs.forEach((s) => { const seen = new Set(); L.push('    public static class ' + s.sname + ' {'); s.fields.forEach((f) => { let id = ident(f.name, new Set(['abstract', 'boolean', 'class', 'default', 'double', 'enum', 'final', 'int', 'long', 'new', 'package', 'private', 'public', 'static', 'this', 'void', 'goto', 'const', 'char', 'byte', 'short', 'float', 'return', 'null', 'true', 'false', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'interface', 'extends', 'implements', 'instanceof', 'super', 'synchronized', 'transient', 'volatile', 'native', 'strictfp', 'assert', 'protected'])); while (seen.has(id)) id += '_'; seen.add(id); const fty = jt(Object.assign({}, f.ty, { __opt: f.opt })); L.push('        public ' + fty + ' ' + id + ';' + (id !== f.name ? ' // JSON 鍵：' + f.name.replace(/[\r\n]/g, ' ') : '')); }); L.push('    }'); });
        L.push('}'); return { ok: true, code: L.join('\n') + '\n', marshal: false, notes: ['只有型別宣告，沒有 load／save'] };
    }
    function genCsharp(schema) {
        const structs = collectStructs(schema);
        const ct = (t, opt) => { let r; switch (t.k) { case 'int': r = 'long'; break; case 'float': case 'number': r = 'double'; break; case 'bigint': r = 'System.Numerics.BigInteger'; break; case 'str': r = 'string'; break; case 'bool': r = 'bool'; break; case 'array': r = 'List<' + ct(t.of) + '>'; break; case 'map': r = 'Dictionary<string, ' + ct(t.of) + '>'; break; case 'object': r = t.sname; break; default: r = 'object'; } return (t.nullable || opt) && ['long', 'double', 'bool', 'System.Numerics.BigInteger'].indexOf(r) >= 0 ? r + '?' : r; };
        const KW = new Set('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'.split(' '));
        const L = ['// 由 FaJsonStruct 產生：JSON 結構的 C# 型別宣告（只有屬性；用 System.Text.Json.JsonSerializer.Deserialize<根型別>(text) 與 Serialize 讀寫，[JsonPropertyName] 對應 JSON 的鍵）。', 'using System.Collections.Generic;', 'using System.Text.Json.Serialization;', ''];
        structs.forEach((s) => { const seen = new Set(); L.push('public class ' + s.sname, '{'); s.fields.forEach((f) => { let id = ident(f.name, KW); while (seen.has(id)) id += '_'; seen.add(id); L.push('    [JsonPropertyName(' + q(f.name) + ')]' + (f.opt ? ' [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]' : ''), '    public ' + ct(f.ty, f.opt) + ' ' + id + ' { get; set; }'); }); L.push('}', ''); });
        return { ok: true, code: L.join('\n'), marshal: false, notes: ['只有型別宣告；可省略的欄位為 null 時不輸出（與 null 不分）'] };
    }
    const LANG_GEN = { cpp: genCpp, c: genC, python: genPython, nodejs: genNodejs, java: genJava, csharp: genCsharp };
    function generate(schema, lang, opts) { const g = LANG_GEN[lang === 'javascript' ? 'nodejs' : lang === 'c++' ? 'cpp' : lang === 'c#' ? 'csharp' : lang]; if (!g) return { ok: false, error: '不支援的語言：' + lang + '（支援 ' + Object.keys(LANG_GEN).join('、') + '）' }; const s = loadSchema(schema); try { return g(s, opts); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } }

    return { VERSION, inferSchema, parseTypeDesc, saveSchema, loadSchema, schemaToIrType, parseJsonKeepBig, collectStructs, genCpp, genC, genPython, genNodejs, genJava, genCsharp, generate, LANG_GEN, CPP_JSON_RUNTIME, C_JSON_RUNTIME, CPP_INCLUDES, ident, pascal, q };
});
