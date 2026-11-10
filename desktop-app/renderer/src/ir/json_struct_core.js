/* JSON 型別 ↔ 各語言的資料結構（struct／class）與物件對應：由範例 JSON 或型別描述推出「結構描述」，再產生各語言的型別宣告；
 * C++（與 C）還會產生解析（load）與輸出（save）函式——自寫的小型 JSON 剖析器放進產生的程式，不引入外部函式庫。純函式 UMD。設計見 DESIGN.core-ir.md 第 15 節。
 *
 *   inferSchema(samples[, {name}])   → 結構描述（多個範例會合併：欄位缺的變「可省略」、出現 null 變「可空」、整數與浮點取浮點、對不起來的變 any）
 *   parseTypeDesc(desc[, {name}])    → 結構描述。desc 是 JSON（物件或字串）：值寫型別名 "int|float|bigint|str|bool|any"，後面加 ? 表示可空，陣列寫 [型別]，
 *                                      鍵後面加 ? 表示可省略，{"*": 型別} 表示鍵不固定的字典（鍵為字串）
 *   saveSchema(schema) / loadSchema(textOrObject)   結構描述 ↔ 文字（fa-struct v1，穩定、可存檔、可在 Python／nodejs 間傳遞）
 *   generate(schema, lang, opts)     → { ok, code, marshal, notes }。lang：cpp c python nodejs java csharp；marshal 表示產生的程式含 load／save
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
            if (c == '"') break; if (c < 0x20) fail("control character in string");
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
    return { VERSION, inferSchema, parseTypeDesc, saveSchema, loadSchema, schemaToIrType, parseJsonKeepBig, collectStructs, genCpp, CPP_JSON_RUNTIME, CPP_INCLUDES, ident, pascal, q };
});
