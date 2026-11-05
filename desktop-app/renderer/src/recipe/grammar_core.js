/* 文法驅動的「當下合法 token」預測（純函式，UMD，不碰 I/O）。
 * 使用者的想法：不是靠手寫補丁清單，而是由 AST／文法分析「我現在在哪個位置、這裡可以選什麼關鍵字、符號、名詞」，再從合法的選項裡選。
 * 做法：Earley 解析器（Aycock-Horspool 處理可空規則）＋各語言家族的語句級文法（EBNF 字串，編譯成 BNF）。
 *   expectedAt(lang, tokens)  → { ok, consumed, failAt, expected:[terminal…], classes:{keywords,punct,names,literals} }
 *       tokens 是 syntax_fix_core.lex 的結果（只取 t／v）。逐 token 掃描：全部吃完＝ok，expected 是「下一個可以接什麼」；
 *       中途吃不下＝failAt 是第一個不合法的 token 的索引，expected 是「那個位置合法的終端」（關鍵字、符號、ID／NUM／STR 這類需要名詞或字面值的類別）。
 *   parseOk(lang, tokens)     → 整段是否合法（給候選過濾：套用編輯後這段文法還吃不吃得下）
 *   LANGS／supports(lang)     每種語言各有一份獨立的文法（python、c、cpp、java、csharp、nodejs）：不共用——C 的合法 token 不會出現 Java 的 instanceof，Java 沒有指標，C++ 才有 ::。python 以邏輯行為單位。
 * 誠實的範圍：這是「語句級的子集文法」，不是完整語言規格（沒有模板、巨集、裝飾器參數細節、f-string 內部、正規表示式字面值…）。
 * 吃不下合法程式時（文法有洞）呼叫端要以編譯器的位置為準、把文法預測當作加分的來源而不是唯一的來源——syntax_fix_core 就是這樣用的。
 * 文法沒有涵蓋的語言（ruby、perl、bash、組語）expectedAt 回 {supported:false}。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaGrammar = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // 每種語言一份獨立的文法（使用者規定：不同語言不能共用；C 的合法 token 不能出現 Java 的 instanceof、Java 沒有指標、C++ 才有 ::）。
    // 下面的 build(lang) 只是「把這一種語言的規則寫成文字」的文字巨集：每個語言各自編譯、各自快取，執行時彼此完全隔離。
    const LANGS = ['python', 'c', 'cpp', 'java', 'csharp', 'nodejs'];
    const FAMILY_OF = {}; LANGS.forEach((l) => { FAMILY_OF[l] = l; }); // 相容舊介面：每個語言自成一格，沒有「家族共用」
    function buildBraceLang(L) {
        const c = L === 'c', cpp = L === 'cpp', java = L === 'java', cs = L === 'csharp', js = L === 'nodejs';
        const R = [];
        R.push('Program -> Item*');
        R.push("Item -> " + (c || cpp || cs ? ['PP'] : []).concat(c ? ['TypeDef'] : cpp ? ['Import', 'NsDecl', 'TypeDef'] : java ? ['Import', 'TypeDef'] : cs ? ['Import', 'NsDecl', 'TypeDef'] : ['Import', 'TypeDef']).concat(['FuncDef', 'Decl', 'Stmt']).join(' | '));
        if (cpp) { R.push("Import -> 'using' 'namespace' QName ';' | 'using' QName ';'"); R.push("NsDecl -> 'namespace' QName Block"); }
        if (java) R.push("Import -> ('import'|'package') 'static'? QName ';'");
        if (cs) { R.push("Import -> 'using' 'static'? QName ';'"); R.push("NsDecl -> 'namespace' QName Block"); }
        if (js) R.push("Import -> 'import' (ID | '*' 'as' ID | '{' ID (',' ID)* '}') 'from' STR ';'?");
        R.push(c ? "QName -> ID" : (cpp ? "QName -> ID ('::' ID)*" : "QName -> ID ('.' (ID|'*'))*"));
        if (!js) {
            R.push(c ? "TypeDef -> ('struct'|'union'|'enum') ID? Block ID? ';'" : cpp ? "TypeDef -> Mod* ('class'|'struct'|'union'|'enum') ID TypeArgs? Bases? Block ';'" : java ? "TypeDef -> Mod* ('class'|'interface'|'enum') ID TypeArgs? Bases? Block" : "TypeDef -> Mod* ('class'|'struct'|'interface'|'enum') ID TypeArgs? Bases? Block ';'?");
            if (!c) R.push(cpp ? "Bases -> ':' Mod* Type (',' Mod* Type)*" : java ? "Bases -> ('extends'|'implements') Type (',' Type)*" : "Bases -> ':' Type (',' Type)*");
            const mods = c ? ['static', 'const', 'extern', 'unsigned', 'signed', 'volatile', 'register', 'inline'] : cpp ? ['public', 'private', 'protected', 'static', 'const', 'virtual', 'override', 'inline', 'extern', 'unsigned', 'signed', 'volatile', 'constexpr', 'explicit'] : java ? ['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized'] : ['public', 'private', 'protected', 'internal', 'static', 'readonly', 'const', 'abstract', 'virtual', 'override', 'sealed', 'partial', 'async', 'unsafe'];
            R.push('Mod -> ' + mods.map((m) => "'" + m + "'").join('|'));
            const qual = c ? [] : cpp ? ["'const'", "'noexcept'", "'override'", "'final'"] : java ? ["'throws' QName (',' QName)*"] : [];
            R.push("FuncDef -> Mod* Type" + (c ? '' : '?') + " QName '(' Params? ')'" + (qual.length ? " Qual*" : '') + " (Block | ';')"); if (qual.length) R.push('Qual -> ' + qual.join('|'));
            R.push("Params -> Param (',' Param)*");
            R.push(c ? "Param -> Mod* Type ID? ('[' Expr? ']')* | '...'" : cpp ? "Param -> Mod* Type ID? ('[' Expr? ']')* ('=' Expr)? | '...'" : java ? "Param -> Mod* Type '...'? ID" : "Param -> Mod* ('ref'|'out'|'params')? Type ID ('=' Expr)?");
            R.push("Decl -> Mod* Type Declarator (',' Declarator)* ';'" + (c || cpp ? " | 'typedef' (Type | Agg) ID ';'" : '') + (cs ? " | 'var' Declarator (',' Declarator)* ';'" : ''));
            if (c || cpp) R.push("Agg -> ('struct'|'union'|'enum') ID? Block");
            R.push(c ? "Declarator -> '*'* ID ('[' Expr? ']')* ('=' Init)?" : cpp ? "Declarator -> ('*'|'&')* ID ('[' Expr? ']')* ('=' Init | '(' Args? ')' | Brace)?" : java ? "Declarator -> ID ('[' ']')* ('=' Init)?" : "Declarator -> ID ('=' Init)?");
            R.push("Init -> Expr | Brace"); R.push("Brace -> '{' (Init (',' Init)* ','?)? '}'");
            const prim = c ? ['int', 'long', 'short', 'char', 'double', 'float', 'void', 'unsigned', 'signed'] : cpp ? ['int', 'long', 'short', 'char', 'double', 'float', 'void', 'bool', 'unsigned', 'signed', 'auto'] : java ? ['int', 'long', 'short', 'char', 'double', 'float', 'void', 'boolean', 'byte'] : ['int', 'long', 'short', 'char', 'double', 'float', 'void', 'bool', 'byte', 'decimal', 'object'];
            R.push('PrimType -> ' + prim.map((m) => "'" + m + "'").join('|'));
            R.push(c ? "TypeName -> PrimType+ | ('struct'|'union'|'enum') ID | ID" : "TypeName -> PrimType+ | QName");
            R.push(c ? "Type -> 'const'? TypeName '*'* ('const' '*'*)?" : cpp ? "Type -> 'const'? TypeName TypeArgs? ('[' ']')* ('*'|'&')*" : java ? "Type -> TypeName TypeArgs? ('[' ']')*" : "Type -> TypeName TypeArgs? ('[' ']')* '?'?");
            if (!c) { R.push("TypeArgs -> '<' (TArg (',' TArg)*)? '>'"); R.push("TArg -> Type" + (java ? " | '?'" : '')); }
        } else {
            R.push("TypeDef -> 'class' ID ('extends' Postfix)? Block");
            R.push("FuncDef -> ('async')? 'function' '*'? ID? '(' Params? ')' Block");
            R.push("Params -> Param (',' Param)* ','?"); R.push("Param -> '...'? (ID | Pattern) ('=' Expr)?");
            R.push("Decl -> ('var'|'let'|'const') Declarator (',' Declarator)* ';'?");
            R.push("Declarator -> (ID | Pattern) ('=' Init)?"); R.push("Pattern -> '[' (ID? (',' ID?)*)? ']' | '{' (ID (',' ID)*)? '}'"); R.push("Init -> Expr");
        }
        R.push("Block -> '{' Item* '}'");
        const forEach = cpp ? "ForInit ':' Expr" : java ? "Mod* Type ID ':' Expr" : cs ? "Type ID 'in' Expr" : js ? "('var'|'let'|'const') (ID | Pattern) ('of'|'in') Expr" : null;
        R.push("Stmt -> Block | 'if' '(' Expr ')' Stmt ('else' Stmt)? | 'while' '(' Expr ')' Stmt | 'do' Stmt 'while' '(' Expr ')' ';' | " + (cs ? "('for'|'foreach')" : "'for'") + " '(' ForHead ')' Stmt | 'return' Expr? ';' | 'break' ';' | 'continue' ';' | 'switch' '(' Expr ')' '{' Case* '}'" + (c ? '' : " | 'throw' Expr ';' | 'try' Block Catch* ('finally' Block)?") + " | Expr ';' | ';'");
        R.push("ForHead -> ForInit? ';' Expr? ';' ExprList?" + (forEach ? ' | ' + forEach : ''));
        R.push(js ? "ForInit -> ('var'|'let'|'const') Declarator (',' Declarator)* | ExprList" : "ForInit -> Mod* Type Declarator (',' Declarator)* | ExprList");
        R.push("Case -> ('case' Expr | 'default') ':' Item*");
        if (!c) R.push(js ? "Catch -> 'catch' ('(' ID ')')? Block" : cpp ? "Catch -> 'catch' '(' (Param | '...') ')' Block" : "Catch -> 'catch' '(' Param? ')' Block");
        if (c || cpp) { // 內聯組語屬於 C／C++ 各自的 CoLU：asm／__asm__／__asm 關鍵字、字串樣板、輸出／輸入／clobber 清單
            R.push("Stmt -> AsmStmt"); R.push("AsmStmt -> ('asm'|'__asm__'|'__asm') ('volatile'|'__volatile__')? 'goto'? '(' STR+ AsmTail? ')' ';'");
            R.push(cpp ? "AsmTail -> (AsmColon AsmList?)+" : "AsmTail -> (':' AsmList?)+"); if (cpp) R.push("AsmColon -> ':' | '::'");
            R.push("AsmList -> AsmOp (',' AsmOp)*"); R.push("AsmOp -> ('[' ID ']')? STR ('(' Expr ')')?");
        }
        R.push("ExprList -> Expr (',' Expr)*"); R.push('Expr -> Assign');
        R.push("Assign -> LValue AssignOp Assign | Ternary"); R.push(c || cpp ? "LValue -> Postfix | '*' Unary" : "LValue -> Postfix"); // 賦值左邊必須是可賦值的目標（不能是比較式）
        R.push("AssignOp -> '='|'+='|'-='|'*='|'/='|'%='|'&='|'|='|'^='|'<<='|'>>='" + (java || js ? "|'>>>='" : ''));
        R.push("Ternary -> LogOr ('?' Expr ':' Ternary)?");
        R.push("LogOr -> LogAnd ('||' LogAnd)*"); R.push("LogAnd -> BitOr ('&&' BitOr)*"); R.push("BitOr -> BitXor ('|' BitXor)*"); R.push("BitXor -> BitAnd ('^' BitAnd)*"); R.push("BitAnd -> Eq ('&' Eq)*");
        R.push(js ? "Eq -> Rel (('=='|'!='|'==='|'!==') Rel)*" : "Eq -> Rel (('=='|'!=') Rel)*");
        R.push("Rel -> Shift (('<'|'>'|'<='|'>='" + (java ? "|'instanceof'" : cs ? "|'is'|'as'" : js ? "|'instanceof'|'in'" : '') + ") Shift)*");
        R.push("Shift -> Add (('<<'|'>>'" + (java || js ? "|'>>>'" : '') + ") Add)*");
        R.push("Add -> Mul (('+'|'-') Mul)*"); R.push("Mul -> Unary (('*'|'/'|'%') Unary)*");
        const un = ["'!'", "'~'", "'-'", "'+'", "'++'", "'--'"].concat(c || cpp ? ["'*'", "'&'", "'sizeof'"] : []).concat(cpp ? ["'delete'"] : []).concat(js ? ["'typeof'", "'await'", "'void'", "'delete'"] : []).concat(cs ? ["'typeof'", "'await'"] : []);
        R.push('Unary -> (' + un.join('|') + ') Unary | ' + (js ? '' : 'Cast | ') + 'Postfix');
        if (!js) R.push("Cast -> '(' Type ')' Unary");
        R.push("Postfix -> Primary Trailer*");
        R.push("Trailer -> '(' Args? ')' | '[' Expr ']' | '.' ID | '++' | '--'" + (c || cpp ? " | '->' ID" : '') + (cpp ? " | '::' ID" : ''));
        const lits = ["ID", "NUM", "STR+", "'true'", "'false'"].concat(c ? ["'NULL'"] : cpp ? ["'nullptr'", "'this'"] : java ? ["'null'", "'this'", "'super'"] : cs ? ["'null'", "'this'", "'base'"] : ["'null'", "'undefined'", "'this'", "'super'"]);
        R.push('Primary -> ' + lits.join(' | ') + " | '(' Expr ')'" + (c ? " | 'sizeof' '(' (Type | Expr) ')'" : cpp ? " | 'sizeof' '(' (Type | Expr) ')' | New" : (java || cs) ? " | New | Lambda" + (cs ? " | PrimType '.' ID" : '') : " | New | Lambda | ArrLit | ObjLit"));
        if (c) { R.push("Args -> Expr (',' Expr)*"); }
        else {
            R.push("Args -> Expr (',' Expr)*");
            R.push(cpp ? "New -> 'new' Type ('(' Args? ')' | ('[' Expr? ']')+ Brace?)" : java ? "New -> 'new' Type ('(' Args? ')' ('{' Item* '}')? | ('[' Expr? ']')+ Brace?)" : cs ? "New -> 'new' Type? ('(' Args? ')' Brace? | ('[' Expr? ']')+ Brace? | Brace)" : "New -> 'new' Postfix");
            if (java) R.push("Lambda -> (ID | '(' Params? ')') '->' (Expr | Block)");
            if (cs) R.push("Lambda -> (ID | '(' Params? ')') '=>' (Expr | Block)");
            if (js) { R.push("Lambda -> ('async')? (ID | '(' Params? ')') '=>' (Expr | Block) | ('async')? 'function' ID? '(' Params? ')' Block"); R.push("ArrLit -> '[' (Expr (',' Expr)* ','?)? ']'"); R.push("ObjLit -> '{' (Prop (',' Prop)* ','?)? '}'"); R.push("Prop -> (ID | STR | NUM) ':' Expr | ID"); }
        }
        return R;
    }
    const PYTHON = [
        "Line -> Decorator | Header | Simple (';' Simple)* ';'?",
        "Decorator -> '@' Dotted ('(' Args? ')')?",
        "Dotted -> ID ('.' ID)*",
        "Suite -> Simple (';' Simple)* ';'?",
        "Header -> 'async'? 'def' ID '(' Params? ')' ('->' Expr)? ':' Suite? | 'class' ID ('(' Args? ')')? ':' Suite? | 'if' Expr ':' Suite? | 'elif' Expr ':' Suite? | 'else' ':' Suite? | 'async'? 'for' ExprList 'in' ExprList ':' Suite? | 'while' Expr ':' Suite? | 'try' ':' Suite? | 'except' (Expr ('as' ID)?)? ':' Suite? | 'finally' ':' Suite? | 'async'? 'with' WithItem (',' WithItem)* ':' Suite? | 'match' Expr ':' | 'case' Expr ('if' Expr)? ':' Suite?",
        "WithItem -> Expr ('as' Expr)?",
        "Params -> Param (',' Param)* ','?",
        "Param -> ('*'|'**')? ID (':' Expr)? ('=' Expr)? | '*' | '/'",
        "Simple -> 'pass' | 'break' | 'continue' | 'return' ExprList? | 'raise' (Expr ('from' Expr)?)? | Import | 'global' ID (',' ID)* | 'nonlocal' ID (',' ID)* | 'assert' Expr (',' Expr)? | 'del' ExprList | 'yield' ExprList? | ExprStmt",
        "Import -> 'import' DottedAs (',' DottedAs)* | 'from' ('.'* Dotted | '.'+) 'import' ('*' | '(' ImpNames ')' | ImpNames)",
        "DottedAs -> Dotted ('as' ID)?",
        "ImpNames -> ImpName (',' ImpName)* ','?",
        "ImpName -> ID ('as' ID)?",
        "ExprStmt -> ExprList (AugOp ExprList | ('=' (ExprList | 'yield' ExprList?))+ | ':' Expr ('=' ExprList)?)?",
        "AugOp -> '+='|'-='|'*='|'/='|'//='|'%='|'**='|'&='|'|='|'^='|'<<='|'>>='|'@='",
        "ExprList -> StarExpr (',' StarExpr)* ','?",
        "StarExpr -> '*'? Expr",
        "Expr -> Lambda | OrTest ('if' OrTest 'else' Expr)? | ID ':=' Expr",
        "Lambda -> 'lambda' Params? ':' Expr",
        "OrTest -> AndTest ('or' AndTest)*",
        "AndTest -> NotTest ('and' NotTest)*",
        "NotTest -> 'not' NotTest | Comp",
        "Comp -> BitOr (CompOp BitOr)*",
        "CompOp -> '<'|'>'|'=='|'>='|'<='|'!='|'in'|'not' 'in'|'is' 'not'?",
        "BitOr -> BitXor ('|' BitXor)*",
        "BitXor -> BitAnd ('^' BitAnd)*",
        "BitAnd -> Shift ('&' Shift)*",
        "Shift -> Arith (('<<'|'>>') Arith)*",
        "Arith -> Term (('+'|'-') Term)*",
        "Term -> Factor (('*'|'/'|'//'|'%'|'@') Factor)*",
        "Factor -> ('+'|'-'|'~') Factor | Power",
        "Power -> Await ('**' Factor)?",
        "Await -> 'await'? Atom Trailer*",
        "Trailer -> '(' Args? ')' | '[' Subs ']' | '.' ID",
        "Subs -> Sub (',' Sub)* ','?",
        "Sub -> Expr? (':' Expr? (':' Expr?)?)?",
        "Atom -> ID | NUM | STR+ | 'None' | 'True' | 'False' | '...' | '(' (Expr CompFor+ | ExprList | 'yield' ExprList?)? ')' | '[' (Expr CompFor+ | ExprList)? ']' | '{' (DictBody | ExprList | Expr CompFor+)? '}'",
        "DictBody -> DictItem (',' DictItem)* ','? | DictItem CompFor+",
        "DictItem -> Expr ':' Expr | '**' Expr",
        "CompFor -> 'async'? 'for' ExprList 'in' OrTest ('if' OrTest)*",
        "Args -> Arg (',' Arg)* ','?",
        "Arg -> '*' Expr | '**' Expr | ID '=' Expr | Expr CompFor+ | Expr"
    ];
    const RULES = { python: PYTHON }; for (const l of LANGS) if (l !== 'python') RULES[l] = buildBraceLang(l);
    // 軟關鍵字（contextual keyword）：文法裡有這個字面，但也可以當識別字用，所以不放進保留字集合——各語言自己的清單
    const SOFT = { python: new Set(['match', 'case', 'async', 'await']), c: new Set([]), cpp: new Set(['override', 'final', 'auto']), java: new Set(['var']), csharp: new Set(['var', 'async', 'await', 'partial', 'is', 'as', 'in', 'readonly', 'sealed', 'object', 'decimal']), nodejs: new Set(['async', 'await', 'of', 'let', 'from', 'as']) };

    // ---------- EBNF → BNF ----------
    function compile(lines, soft) {
        const prods = new Map(); let aux = 0;
        const TOK = /'[^']*'|[A-Za-z_][A-Za-z0-9_]*|[()|*+?]/g;
        const add = (nt, rhs) => { if (!prods.has(nt)) prods.set(nt, []); prods.get(nt).push(rhs); };
        for (const line of lines) {
            const [lhs, body] = line.split(' -> '); const toks = body.match(TOK); let p = 0;
            const newAux = () => '_a' + (++aux);
            const parseAlt = () => { const alts = [parseSeq()]; while (toks[p] === '|') { p++; alts.push(parseSeq()); } return alts; };
            const parseSeq = () => { const seq = []; while (p < toks.length && toks[p] !== '|' && toks[p] !== ')') seq.push(parsePostfix()); return seq; };
            const parsePostfix = () => {
                let atom = parseAtom();
                for (;;) {
                    if (toks[p] === '*') { p++; const n = newAux(); add(n, []); add(n, [n, atom]); atom = n; }
                    else if (toks[p] === '+') { p++; const n = newAux(); add(n, [atom]); add(n, [n, atom]); atom = n; }
                    else if (toks[p] === '?') { p++; const n = newAux(); add(n, []); add(n, [atom]); atom = n; }
                    else break;
                }
                return atom;
            };
            const parseAtom = () => { const t = toks[p++]; if (t === '(') { const alts = parseAlt(); p++; if (alts.length === 1 && alts[0].length === 1) return alts[0][0]; const n = newAux(); for (const a of alts) add(n, a); return n; } return t; };
            const alts = parseAlt(); for (const a of alts) add(lhs.trim(), a);
        }
        // 終端與非終端的區分：prods 有的是非終端；其餘（單引號字面、全大寫類別）是終端
        const nts = new Set(prods.keys());
        const rules = []; for (const [lhs, list] of prods) for (const rhs of list) rules.push({ lhs, rhs, id: rules.length });
        const byLhs = new Map(); for (const r of rules) { if (!byLhs.has(r.lhs)) byLhs.set(r.lhs, []); byLhs.get(r.lhs).push(r); }
        const nullable = new Set(); let ch = true; while (ch) { ch = false; for (const r of rules) if (!nullable.has(r.lhs) && r.rhs.every((s) => nullable.has(s))) { nullable.add(r.lhs); ch = true; } }
        const keywords = new Set(); for (const r of rules) for (const s of r.rhs) if (s[0] === "'" && /^'[A-Za-z_]+'$/.test(s)) keywords.add(s.slice(1, -1));
        if (soft) for (const w of soft) keywords.delete(w);
        return { rules, byLhs, nts, nullable, keywords };
    }
    const COMPILED = {}; const grammarOf = (fam) => COMPILED[fam] || (COMPILED[fam] = compile(RULES[fam], SOFT[fam]));

    // ---------- 終端比對 ----------
    function matches(G, term, tok) {
        if (term[0] === "'") { const lit = term.slice(1, -1); return tok.v === lit && (tok.t === 'op' || tok.t === 'id'); }
        if (term === 'ID') return tok.t === 'id' && !G.keywords.has(tok.v);
        if (term === 'NUM') return tok.t === 'num';
        if (term === 'STR') return tok.t === 'str' && !tok.bad;
        if (term === 'PP') return tok.t === 'pp';
        return false;
    }

    // ---------- Earley ----------
    // 回傳 { ok, consumed, failAt, expected:Set<terminal> }。start：起始非終端；tokens：{t,v}[]
    function earley(G, start, tokens, opts) {
        opts = opts || {}; const n = tokens.length; const sets = []; const seen = [];
        const itemKey = (r, d, o) => r + ':' + d + ':' + o;
        const addItem = (i, r, d, o) => { const k = itemKey(r.id, d, o); if (seen[i].has(k)) return; seen[i].add(k); sets[i].push({ r, d, o }); };
        for (let i = 0; i <= n; i++) { sets.push([]); seen.push(new Set()); }
        for (const r of G.byLhs.get(start)) addItem(0, r, 0, 0);
        let failAt = -1, expectedAtFail = null, maxSteps = opts.maxItems || 400000, steps = 0;
        const expectedOf = (i) => { const e = new Set(); for (const it of sets[i]) { if (it.d < it.r.rhs.length) { const s = it.r.rhs[it.d]; if (!G.nts.has(s)) e.add(s); } } return e; };
        for (let i = 0; i <= n; i++) {
            for (let q = 0; q < sets[i].length; q++) {
                if (++steps > maxSteps) return { ok: false, consumed: i, failAt: i, expected: new Set(), aborted: true };
                const it = sets[i][q];
                if (it.d < it.r.rhs.length) {
                    const sym = it.r.rhs[it.d];
                    if (G.nts.has(sym)) { for (const r of G.byLhs.get(sym)) addItem(i, r, 0, i); if (G.nullable.has(sym)) addItem(i, it.r, it.d + 1, it.o); }
                    else if (i < n && matches(G, sym, tokens[i])) addItem(i + 1, it.r, it.d + 1, it.o);
                } else {
                    for (const p of sets[it.o]) if (p.d < p.r.rhs.length && p.r.rhs[p.d] === it.r.lhs) addItem(i, p.r, p.d + 1, p.o);
                }
            }
            if (i < n && sets[i + 1].length === 0) { failAt = i; expectedAtFail = expectedOf(i); break; }
        }
        if (failAt >= 0) return { ok: false, consumed: failAt, failAt, expected: expectedAtFail };
        return { ok: true, consumed: n, failAt: -1, expected: expectedOf(n), complete: sets[n].some((it) => it.r.lhs === start && it.o === 0 && it.d === it.r.rhs.length) };
    }

    // 把終端集合分成：關鍵字、符號、名詞（ID）、字面值（NUM／STR）、前處理
    function classify(G, expected) {
        const c = { keywords: [], punct: [], names: expected.has('ID'), literals: [], other: [] };
        for (const t of expected) { if (t[0] === "'") { const v = t.slice(1, -1); (/^[A-Za-z_]+$/.test(v) ? c.keywords : c.punct).push(v); } else if (t === 'NUM' || t === 'STR') c.literals.push(t); else if (t !== 'ID') c.other.push(t); }
        c.keywords.sort(); c.punct.sort(); return c;
    }

    // 泛型尾端的 `>>`／`>>>` 詞法分析器讀成位移運算子：在 cpp／java／csharp，若同一條敘述裡有 ≥2 個「接在識別字後、後面是型別開頭」的未收尾 `<`，就把它拆成多個 `>`
    function splitGenericShifts(lang, tokens) {
        if (lang !== 'cpp' && lang !== 'java' && lang !== 'csharp') return tokens;
        const out = []; let open = 0;
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.t === 'op' && (t.v === ';' || t.v === '{' || t.v === '}')) open = 0;
            if (t.t === 'op' && t.v === '<' && out.length && out[out.length - 1].t === 'id' && tokens[i + 1] && (tokens[i + 1].t === 'id' || tokens[i + 1].v === '?' || tokens[i + 1].v === '>')) open++;
            if (t.t === 'op' && t.v === '>') open = Math.max(0, open - 1);
            if (t.t === 'op' && (t.v === '>>' || t.v === '>>>') && open >= t.v.length) { for (let k = 0; k < t.v.length; k++) out.push(Object.assign({}, t, { v: '>', splitFrom: t.v })); open -= t.v.length; continue; }
            out.push(t);
        }
        return out;
    }
    // 語言入口。tokens：lex 的結果（clike 不含換行；python 傳入「一條邏輯行」的 token，不含 nl）
    function expectedAt(lang, tokens, opts) {
        const fam = FAMILY_OF[lang]; if (!fam) return { supported: false, ok: false, expected: [], classes: { keywords: [], punct: [], names: false, literals: [], other: [] } };
        const G = grammarOf(fam); const start = fam === 'python' ? 'Line' : 'Program';
        const toks2 = splitGenericShifts(lang, tokens); const r = earley(G, start, toks2.map((t) => ({ t: t.t, v: t.v, bad: t.bad })), opts);
        return { supported: true, ok: r.ok, consumed: r.consumed, failAt: r.failAt, complete: !!r.complete, expected: Array.from(r.expected), classes: classify(G, r.expected), aborted: !!r.aborted };
    }
    // 整段是否是「合法而完整」的（clike：Program 完整；python：一條完整的行）
    function parseOk(lang, tokens, opts) { const r = expectedAt(lang, tokens, opts); return r.supported && r.ok && r.complete; }
    // 可以續寫到多遠：回傳吃掉的 token 數（吃不下就是 failAt）；給候選過濾比較「編輯前後文法進展」
    function progress(lang, tokens, opts) { const r = expectedAt(lang, tokens, opts); return r.supported ? (r.ok ? tokens.length : r.failAt) : -1; }

    const supports = (lang) => !!RULES[lang];
    return { LANGS, supports, FAMILY_OF, compile, grammarOf, earley, expectedAt, parseOk, progress, classify, RULES };
});
