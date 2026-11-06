/* Python：Blockly 式的「程式區塊」body。純函式 UMD，Python 專屬（每個語言各自一份範本庫，不共用）。
 * 一個範本只定義一次：一行中文的受控自然語言（line）＋ 一小段 Python（py，用 $x 當槽位、$$body 當子區塊）。
 * 同一份定義兩個方向都用：
 *   區塊 → 程式：槽位填進 IR 圖樣（codegen）
 *   程式 → 區塊：把敘述 IR 跟圖樣做結構比對（反推）；比不到的收成通用的「程式」區塊（任何程式都表達得了）
 * 區塊樹：{t:範本id, slots:{名稱:IR}, bodies:{名稱:[區塊]}}；if 鏈用 {t:'if', branches:[{c, body}], els}；通用 {t:'stmt', ir}
 * 受控自然語言（CNL）：一行一個區塊，縮排兩格表示子區塊，模型只要寫這些已知的行（槽位是短的 Python 運算式）。
 *
 *   makeBlocks({parseTree, C2U}) → B
 *   B.TEMPLATES                        範本表（id、類別、line、py）
 *   B.fromIR(stmts) → blocks           程式 → 區塊（反推）
 *   B.toIR(blocks) → stmts             區塊 → 程式（codegen 的 IR）
 *   B.toCNL(blocks) → 文字             區塊 → 受控自然語言
 *   B.parseCNL(text) → {ok, blocks, errors}   受控自然語言 → 區塊（槽位用 tree-sitter 檢查）
 *   B.stats(blocks) → {blocks, generic, byTemplate}
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyBlocks = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    // id | 類別 | line（{槽位:種類}；種類 name＝名稱或名稱元組、省略＝運算式）| py（$槽位、$$子區塊；多行用 \n）
    const SPEC = [
        // ---- 輸入 ----
        'read_int|輸入|讀入整數 {n:name}|$n = int(input())',
        'read_ints|輸入|讀入一行整數 {t:name}|$t = map(int, input().split())',
        'read_list|輸入|讀入一行整數成清單 {a:name}|$a = list(map(int, input().split()))',
        'read_floats|輸入|讀入一行小數成清單 {a:name}|$a = list(map(float, input().split()))',
        'read_float|輸入|讀入小數 {n:name}|$n = float(input())',
        'read_str|輸入|讀入一行文字 {s:name}|$s = input()',
        'read_strip|輸入|讀入一行文字並去掉首尾空白 {s:name}|$s = input().strip()',
        'read_words|輸入|讀入一行並切成單字 {w:name}|$w = input().split()',
        'read_n_ints|輸入|讀入 {n} 行整數成清單 {a:name}|$a = [int(input()) for _ in range($n)]',
        'read_n_lines|輸入|讀入 {n} 行文字成清單 {a:name}|$a = [input() for _ in range($n)]',
        'read_n_strips|輸入|讀入 {n} 行文字（去空白）成清單 {a:name}|$a = [input().strip() for _ in range($n)]',
        'read_matrix|輸入|讀入 {n} 行整數成二維陣列 {g:name}|$g = [list(map(int, input().split())) for _ in range($n)]',
        'read_n_pairs|輸入|讀入 {n} 行兩個整數成清單 {a:name}|$a = [tuple(map(int, input().split())) for _ in range($n)]',
        // ---- 輸出 ----
        'print_value|輸出|印出 {e}|print($e)',
        'print_two|輸出|印出 {a} 和 {b}|print($a, $b)',
        'print_star|輸出|用空白分隔印出清單 {e}|print(*$e)',
        'print_join|輸出|用空白連接後印出清單 {e}|print(" ".join(map(str, $e)))',
        'print_join_sep|輸出|用 {sep} 連接後印出清單 {e}|print($sep.join(map(str, $e)))',
        'print_join_str|輸出|用 {sep} 連接字串清單 {e} 後印出|print($sep.join($e))',
        'print_yesno|輸出|如果 {c} 就印出 YES，否則印出 NO|print("YES" if $c else "NO")',
        'print_blank|輸出|印出空行|print()',
        // ---- 變數與資料 ----
        'init_list|資料|令 {x:name} 為空清單|$x = []',
        'init_dict|資料|令 {x:name} 為空字典|$x = {}',
        'init_set|資料|令 {x:name} 為空集合|$x = set()',
        'init_zeros|資料|令 {x:name} 為 {n} 個 0 的清單|$x = [0] * $n',
        'init_fill|資料|令 {x:name} 為 {n} 個 {v} 的清單|$x = [$v] * $n',
        'init_grid|資料|令 {x:name} 為 {n} 列 {m} 行都是 0 的二維陣列|$x = [[0] * $m for _ in range($n)]',
        'init_grid_fill|資料|令 {x:name} 為 {n} 列 {m} 行都是 {v} 的二維陣列|$x = [[$v] * $m for _ in range($n)]',
        'init_deque|資料|令 {q:name} 為從 {e} 開始的佇列|$q = deque([$e])',
        'swap|資料|交換 {a} 和 {b}|$a, $b = $b, $a',
        'fib_step|資料|同時更新：{a} 變成 {b}，{b} 變成 {a} 加 {b}|$a, $b = $b, $a + $b',
        'len_of|資料|令 {x:name} 為 {e} 的長度|$x = len($e)',
        'sum_of|資料|令 {x:name} 為 {e} 的總和|$x = sum($e)',
        'max_of|資料|令 {x:name} 為 {e} 的最大值|$x = max($e)',
        'min_of|資料|令 {x:name} 為 {e} 的最小值|$x = min($e)',
        'to_int|資料|令 {x:name} 為 {e} 轉成整數|$x = int($e)',
        'to_str|資料|令 {x:name} 為 {e} 轉成字串|$x = str($e)',
        'split_by|資料|令 {x:name} 為 {s} 依 {sep} 切開的清單|$x = $s.split($sep)',
        'join_by|資料|令 {x:name} 為用 {sep} 連接 {l} 的字串|$x = $sep.join($l)',
        'lower_of|資料|令 {x:name} 為 {s} 的小寫|$x = $s.lower()',
        'upper_of|資料|令 {x:name} 為 {s} 的大寫|$x = $s.upper()',
        'divmod_of|資料|令 {q:name} 和 {r:name} 為 {a} 除以 {b} 的商與餘數|$q, $r = divmod($a, $b)',
        'sorted_of|資料|令 {x:name} 為 {e} 排序後的新清單|$x = sorted($e)',
        'sorted_key|資料|令 {x:name} 為 {e} 依 {k} 排序後的新清單|$x = sorted($e, key=$k)',
        'sorted_rev|資料|令 {x:name} 為 {e} 由大到小排序後的新清單|$x = sorted($e, reverse=True)',
        'reversed_of|資料|令 {x:name} 為 {e} 反轉|$x = $e[::-1]',
        'list_map|資料|令 {x:name} 為 {l} 中每個 {v:name} 的 {e} 組成的清單|$x = [$e for $v in $l]',
        'list_filter|資料|令 {x:name} 為 {l} 中滿足 {c} 的每個 {v:name} 組成的清單|$x = [$v for $v in $l if $c]',
        'list_map_filter|資料|令 {x:name} 為 {l} 中滿足 {c} 的每個 {v:name} 的 {e} 組成的清單|$x = [$e for $v in $l if $c]',
        'set_of|資料|令 {x:name} 為 {e} 的集合|$x = set($e)',
        'assign|資料|令 {x} 等於 {e}|$x = $e',
        // ---- 更新 ----
        'incr|更新|{x} 加 1|$x += 1',
        'decr|更新|{x} 減 1|$x -= 1',
        'add_to|更新|{x} 加上 {e}|$x += $e',
        'sub_from|更新|{x} 減去 {e}|$x -= $e',
        'mul_by|更新|{x} 乘以 {e}|$x *= $e',
        'floordiv_by|更新|{x} 整除 {e}|$x //= $e',
        'mod_by|更新|{x} 取除以 {e} 的餘數|$x %= $e',
        'max_update|更新|{x} 取 {x} 與 {e} 的較大值|$x = max($x, $e)',
        'min_update|更新|{x} 取 {x} 與 {e} 的較小值|$x = min($x, $e)',
        'count_inc|更新|計數：{d} 的 {k} 加 1|$d[$k] = $d.get($k, 0) + 1',
        'count_add|更新|計數：{d} 的 {k} 加上 {v}|$d[$k] = $d.get($k, 0) + $v',
        'group_append|更新|把 {v} 放進 {d} 的 {k} 這一組|$d.setdefault($k, []).append($v)',
        // ---- 集合操作 ----
        'append|集合|把 {e} 加到清單 {l} 最後|$l.append($e)',
        'extend|集合|把 {e} 全部加到清單 {l} 最後|$l.extend($e)',
        'pop_last|集合|刪掉清單 {l} 的最後一個|$l.pop()',
        'add_set|集合|把 {e} 加入集合 {s}|$s.add($e)',
        'sort_inplace|集合|排序清單 {l}|$l.sort()',
        'sort_key|集合|依 {k} 排序清單 {l}|$l.sort(key=$k)',
        'sort_rev|集合|由大到小排序清單 {l}|$l.sort(reverse=True)',
        'reverse_inplace|集合|反轉清單 {l}|$l.reverse()',
        // ---- 迴圈 ----
        'for_range|迴圈|重複 {n} 次，用 {i:name} 計數：|for $i in range($n):\n    $$body',
        'for_range_from|迴圈|讓 {i:name} 從 {a} 到 {b} 減一：|for $i in range($a, $b):\n    $$body',
        'for_range_step|迴圈|讓 {i:name} 從 {a} 到 {b} 減一，每次加 {s}：|for $i in range($a, $b, $s):\n    $$body',
        'for_each|迴圈|對 {it} 裡的每個 {x:name}：|for $x in $it:\n    $$body',
        'for_enumerate|迴圈|對 {it} 的每個（編號 {i:name}、元素 {x:name}）：|for $i, $x in enumerate($it):\n    $$body',
        'for_items|迴圈|對字典 {d} 的每個（鍵 {k:name}、值 {v:name}）：|for $k, $v in $d.items():\n    $$body',
        'for_zip|迴圈|對 {a} 和 {b} 配對的每組（{x:name}、{y:name}）：|for $x, $y in zip($a, $b):\n    $$body',
        'while_do|迴圈|當 {c} 時重複：|while $c:\n    $$body',
        'while_forever|迴圈|一直重複（用 break 離開）：|while True:\n    $$body',
        'bfs_loop|迴圈|當佇列 {q} 不是空的就取出最前面的 {u:name} 處理：|while $q:\n    $u = $q.popleft()\n    $$body',
        // ---- 流程 ----
        'return_value|流程|回傳 {e}|return $e',
        'return_none|流程|結束函式|return',
        'break_loop|流程|跳出迴圈|break',
        'continue_loop|流程|略過這一輪|continue',
        'do_nothing|流程|什麼都不做|pass',
        // ---- 演算法片段 ----
        'gcd_loop|演算法|用輾轉相除法讓 {a:name} 變成 {a} 與 {b:name} 的最大公因數|while $b:\n    $a, $b = $b, $a % $b',
        'binary_search|演算法|二分搜尋：{lo:name} 從 {a}、{hi:name} 從 {b}，中點 {mid:name}，如果 {c} 就往右（{lo} 變成中點加 1），否則往左（{hi} 變成中點）|$lo, $hi = $a, $b\nwhile $lo < $hi:\n    $mid = ($lo + $hi) // 2\n    if $c:\n        $lo = $mid + 1\n    else:\n        $hi = $mid',
        'sieve|演算法|用篩法在 {p:name} 標出 0 到 {n} 的質數（True 是質數），迴圈變數 {i:name}、{j:name}|$p = [True] * ($n + 1)\n$p[0] = $p[1] = False\nfor $i in range(2, int($n ** 0.5) + 1):\n    if $p[$i]:\n        for $j in range($i * $i, $n + 1, $i):\n            $p[$j] = False',
        'prefix_sums|演算法|令 {p:name} 為 {a} 的前綴和（長度多 1），迴圈變數 {i:name}|$p = [0] * (len($a) + 1)\nfor $i in range(len($a)):\n    $p[$i + 1] = $p[$i] + $a[$i]',
    ];

    // 運算式積木（槽位的值也用選擇題選）：id | 類別 | line | py（$槽位）
    const EXPR_SPEC = [
        '加|算術|{a} + {b}|$a + $b', '減|算術|{a} - {b}|$a - $b', '乘|算術|{a} * {b}|$a * $b', '整除|算術|{a} // {b}|$a // $b', '餘數|算術|{a} % {b}|$a % $b', '次方|算術|{a} 的 {b} 次方|$a ** $b', '負|算術|-{a}|-$a',
        '等於|比較|{a} == {b}|$a == $b', '不等於|比較|{a} != {b}|$a != $b', '小於|比較|{a} < {b}|$a < $b', '小於等於|比較|{a} <= {b}|$a <= $b', '大於|比較|{a} > {b}|$a > $b', '大於等於|比較|{a} >= {b}|$a >= $b', '在裡面|比較|{a} 在 {b} 裡面|$a in $b', '不在裡面|比較|{a} 不在 {b} 裡面|$a not in $b',
        '而且|邏輯|{a} 而且 {b}|$a and $b', '或者|邏輯|{a} 或者 {b}|$a or $b', '不是|邏輯|不是 {a}|not $a', '條件式|邏輯|{a} 如果 {c} 否則 {b}|$a if $c else $b',
        '第幾個|取值|{a} 的第 {i} 個（從 0 算起）|$a[$i]', '最後一個|取值|{a} 的最後一個|$a[-1]', '切片|取值|{a} 從 {i} 到 {j} 之前|$a[$i:$j]', '從頭到|取值|{a} 的前 {j} 個|$a[:$j]', '從第幾個起|取值|{a} 從 {i} 開始到結尾|$a[$i:]', '反轉|取值|{a} 反轉|$a[::-1]',
        '長度|函式|{a} 的長度|len($a)', '轉整數|函式|{a} 轉成整數|int($a)', '轉字串|函式|{a} 轉成字串|str($a)', '絕對值|函式|{a} 的絕對值|abs($a)', '總和|函式|{a} 的總和|sum($a)', '最大值|函式|{a} 的最大值|max($a)', '最小值|函式|{a} 的最小值|min($a)', '較大|函式|{a} 和 {b} 較大的|max($a, $b)', '較小|函式|{a} 和 {b} 較小的|min($a, $b)',
        '排序後|函式|{a} 排序後|sorted($a)', '由大到小|函式|{a} 由大到小排序後|sorted($a, reverse=True)', '轉清單|函式|{a} 轉成清單|list($a)', '轉集合|函式|{a} 轉成集合|set($a)', '範圍1|函式|0 到 {a} 減一的範圍|range($a)', '範圍2|函式|{a} 到 {b} 減一的範圍|range($a, $b)',
        '切單字|方法|{a} 切成單字的清單|$a.split()', '依分隔切|方法|{a} 依 {b} 切開的清單|$a.split($b)', '去空白|方法|{a} 去掉首尾空白|$a.strip()', '小寫|方法|{a} 的小寫|$a.lower()', '大寫|方法|{a} 的大寫|$a.upper()', '出現次數|方法|{a} 裡 {b} 出現的次數|$a.count($b)', '字典取值|方法|字典 {a} 的 {k}（沒有就是 {d}）|$a.get($k, $d)', '所有鍵|方法|字典 {a} 的所有鍵|$a.keys()', '所有值|方法|字典 {a} 的所有值|$a.values()', '所有鍵值|方法|字典 {a} 的所有（鍵, 值）|$a.items()', '連接|方法|用 {a} 連接 {b}|$a.join($b)',
        '二元組|組合|（{a}, {b}）|($a, $b)', '清單2|組合|[{a}, {b}]|[$a, $b]', '空清單|組合|空清單|[]', '空字典|組合|空字典|{}',
    ];

    const PRE_H = '__h_', PRE_B = '__B_';
    const isHole = (e) => e && e.n === 'name' && typeof e.v === 'string' && e.v.startsWith(PRE_H);
    const isBodyStmt = (s) => s && s.k === 'expr' && s.e && s.e.n === 'call' && s.e.f && s.e.f.n === 'name' && String(s.e.f.v).startsWith(PRE_B) && !s.e.a.length;
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const isNameLike = (e) => e && (e.n === 'name' || (e.n === 'tuple' && e.xs.length > 0 && e.xs.every((x) => x.n === 'name')));
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const count = (x) => (x && typeof x === 'object' ? 1 + Object.values(x).reduce((s, v) => s + count(v), 0) : 0);

    function makeBlocks(env) {
        const { parseTree, C2U } = env; const LIB = env.lib || (typeof module === 'object' && module.exports ? require('./py_blocks_lib_core.js') : (typeof FaPyBlocksLib !== 'undefined' ? FaPyBlocksLib : { SPEC_EXTRA: [], EXPR_EXTRA: [], TYPES: {}, ETYPES: {}, REQ: {}, IMPORTS: {} }));
        const stmtsOfSource = (src) => { const tree = parseTree(src); if (!tree || tree.rootNode.hasError()) return null; const u = C2U.fromTree(tree.rootNode, { source: src }); return u.model.prelude; };
        const exprOf = (text) => { const body = stmtsOfSource(String(text).trim() + '\n'); if (!body || body.length !== 1 || body[0].k !== 'expr') return null; return body[0].e; };
        const exprText = (e) => { const t = C2U.toPython({ name: 'M', classes: [], relations: [], prelude: [{ k: 'expr', e }], order: [] }).trim(); return t; };
        const targetText = (e) => (e && e.n === 'tuple' && e.xs.length > 1 ? e.xs.map(exprText).join(', ') : exprText(e));
        const slotText = (kind, ir) => (kind === 'name' ? targetText(ir) : exprText(ir));

        // ---- 範本編譯 ----
        const TEMPLATES = SPEC.concat(LIB.SPEC_EXTRA).map((row) => {
            const [id, cat, line, py] = row.split('|'); const slots = {}; const lineRe = /\{(\w+)(?::(\w+))?\}/g; let m; while ((m = lineRe.exec(line))) { if (!slots[m[1]]) slots[m[1]] = m[2] || 'expr'; }
            const src = py.replace(/\$\$(\w+)/g, PRE_B + '$1()').replace(/\$(\w+)/g, PRE_H + '$1').replace(/\\n/g, '\n') + '\n';
            const pat = stmtsOfSource(src); if (!pat) throw new Error('範本 ' + id + ' 的 Python 解析失敗：' + py);
            const bodies = []; const walk = (l) => { for (const s of l) { if (isBodyStmt(s)) bodies.push(String(s.e.f.v).slice(PRE_B.length)); for (const k of ['a', 'b']) if (Array.isArray(s[k])) walk(s[k]); } }; walk(pat);
            return { id, cat, line, py, slots, pat, bodies, size: count(pat) };
        });
        const byId = {}; TEMPLATES.forEach((t) => { byId[t.id] = t; });
        const EXPRS = EXPR_SPEC.concat(LIB.EXPR_EXTRA).map((row) => { const [id, cat, line, py] = row.split('|'); const slots = []; const re = /\{(\w+)\}/g; let m; while ((m = re.exec(line))) if (!slots.includes(m[1])) slots.push(m[1]); const pat = exprOf(py.replace(/\$(\w+)/g, PRE_H + '$1')); if (!pat) throw new Error('運算式積木 ' + id + ' 解析失敗：' + py); return { id, cat, line, py, slots, pat }; });
        const exprById = {}; EXPRS.forEach((e) => { exprById[e.id] = e; });
        const fillHoles = (x, fills) => { if (Array.isArray(x)) return x.map((y) => fillHoles(y, fills)); if (x && typeof x === 'object') { if (isHole(x)) return clone(fills[x.v.slice(PRE_H.length)]); const o = {}; for (const k of Object.keys(x)) o[k] = fillHoles(x[k], fills); return o; } return x; };
        const buildExpr = (id, fills) => fillHoles(exprById[id].pat, fills);
        const ORDER = TEMPLATES.slice().sort((a, b) => b.size - a.size);

        // ---- 結構比對（程式 → 區塊）----
        function unify(p, x, ctx) {
            if (isHole(p)) { if (x == null || typeof x !== 'object') return false; const name = p.v.slice(PRE_H.length); const kind = ctx.tpl.slots[name]; if (kind === 'name' && !isNameLike(x)) return false; if (x && x.n === 'name' && x.v && String(x.v).startsWith(PRE_H)) return false; if (name in ctx.slots) return eq(ctx.slots[name], x); ctx.slots[name] = x; return true; }
            if (Array.isArray(p)) {
                if (!Array.isArray(x)) return false;
                const bi = p.findIndex(isBodyStmt);
                if (bi >= 0) { // 子區塊洞：前面 bi 句、後面 tail 句固定，中間（至少一句）都是子區塊
                    const tail = p.length - bi - 1; if (x.length < bi + 1 + tail) return false;
                    for (let i = 0; i < bi; i++) if (!unify(p[i], x[i], ctx)) return false;
                    for (let i = 0; i < tail; i++) if (!unify(p[bi + 1 + i], x[x.length - tail + i], ctx)) return false;
                    ctx.bodies[String(p[bi].e.f.v).slice(PRE_B.length)] = x.slice(bi, x.length - tail); return true;
                }
                if (p.length !== x.length) return false; for (let i = 0; i < p.length; i++) if (!unify(p[i], x[i], ctx)) return false; return true;
            }
            if (p && typeof p === 'object') {
                if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
                const keys = new Set(Object.keys(p).concat(Object.keys(x))); for (const k of keys) { const pv = p[k], xv = x[k]; if (pv === undefined && xv === undefined) continue; if (pv === undefined || xv === undefined) return false; if (!unify(pv, xv, ctx)) return false; } return true;
            }
            return p === x;
        }
        function matchAt(stmts, i) {
            for (const tpl of ORDER) {
                if (i + tpl.pat.length > stmts.length) continue;
                const ctx = { tpl, slots: {}, bodies: {} }; let ok = true;
                for (let j = 0; j < tpl.pat.length; j++) { if (!unify(tpl.pat[j], stmts[i + j], ctx)) { ok = false; break; } }
                if (ok && Object.keys(tpl.slots).every((k) => k in ctx.slots)) { const bodies = {}; for (const b of Object.keys(ctx.bodies)) bodies[b] = fromIR(ctx.bodies[b]); return { block: { t: tpl.id, slots: ctx.slots, bodies }, len: tpl.pat.length }; }
            }
            return null;
        }
        function fromIR(stmts) {
            const out = []; let i = 0;
            while (i < stmts.length) {
                const m = matchAt(stmts, i); if (m) { out.push(m.block); i += m.len; continue; }
                const s = stmts[i];
                if (s.k === 'if') { const branches = []; let cur = s, els = null; for (;;) { branches.push({ c: cur.c, body: fromIR(cur.a) }); if (cur.b.length === 1 && cur.b[0].k === 'if') { cur = cur.b[0]; continue; } els = cur.b.length ? fromIR(cur.b) : null; break; } out.push({ t: 'if', branches, els }); }
                else out.push({ t: 'stmt', ir: s });
                i++;
            }
            return out;
        }

        // ---- 區塊 → 程式 ----
        function subst(x, blk, tpl) {
            if (Array.isArray(x)) { const out = []; for (const s of x) { if (isBodyStmt(s)) { const name = String(s.e.f.v).slice(PRE_B.length); out.push(...toIR(blk.bodies[name] || [])); } else out.push(subst(s, blk, tpl)); } return out; }
            if (x && typeof x === 'object') { if (isHole(x)) return clone(blk.slots[x.v.slice(PRE_H.length)]); const o = {}; for (const k of Object.keys(x)) o[k] = subst(x[k], blk, tpl); return o; }
            return x;
        }
        function toIR(blocks) {
            const out = [];
            for (const b of blocks || []) {
                if (b.t === 'stmt') out.push(clone(b.ir));
                else if (b.t === 'if') { let node = null; const br = b.branches; const build = (i) => ({ k: 'if', c: clone(br[i].c), a: toIR(br[i].body), b: i + 1 < br.length ? [build(i + 1)] : (b.els ? toIR(b.els) : []) }); node = build(0); out.push(node); }
                else { const tpl = byId[b.t]; if (!tpl) throw new Error('不認得的區塊：' + b.t); out.push(...subst(tpl.pat, b, tpl)); }
            }
            return out;
        }

        // ---- 受控自然語言 ----
        const lineRes = TEMPLATES.map((t) => { let re = '^'; let last = 0; const r = /\{(\w+)(?::(\w+))?\}/g; let m; const order = []; while ((m = r.exec(t.line))) { re += t.line.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); re += '(.+?)'; order.push(m[1]); last = r.lastIndex; } re += t.line.slice(last).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'; const lit = t.line.replace(/\{[^}]*\}/g, '').length; return { t, re: new RegExp(re), order, lit }; }).sort((a, b) => b.lit - a.lit);
        function lineOf(t, slots) { return t.line.replace(/\{(\w+)(?::(\w+))?\}/g, (m0, n, k) => slotText(k || 'expr', slots[n])); }
        function toCNL(blocks, depth) {
            depth = depth || 0; const pad = '  '.repeat(depth); const out = [];
            for (const b of blocks) {
                if (b.t === 'stmt') { const py = C2U.toPython({ name: 'M', classes: [], relations: [], prelude: [b.ir], order: [] }).replace(/\s+$/, '').split('\n'); if (py.length === 1 && !/:\s*$/.test(py[0])) out.push(pad + '程式：' + py[0]); else { out.push(pad + '程式區塊：'); for (const l of py) out.push(pad + '  ' + l); } }
                else if (b.t === 'if') { b.branches.forEach((br, i) => { out.push(pad + (i === 0 ? '如果 ' : '否則如果 ') + exprText(br.c) + ' 就：'); out.push(toCNL(br.body, depth + 1)); }); if (b.els) { out.push(pad + '否則：'); out.push(toCNL(b.els, depth + 1)); } }
                else { const t = byId[b.t]; out.push(pad + lineOf(t, b.slots)); for (const name of t.bodies) out.push(toCNL(b.bodies[name] || [], depth + 1)); }
            }
            return out.filter((l) => l !== '').join('\n');
        }
        function parseCNL(text) {
            const rows = String(text || '').split('\n').filter((l) => l.trim().length).map((l) => ({ ind: Math.floor((l.length - l.trimStart().length) / 2), s: l.trim(), raw: l })); const errors = []; let pos = 0;
            const slotIR = (kind, str, lineNo) => { const e = exprOf(str); if (!e) { errors.push({ line: lineNo, msg: '槽位「' + str + '」不是合法的 Python 運算式' }); return null; } if (kind === 'name' && !isNameLike(e)) { errors.push({ line: lineNo, msg: '槽位「' + str + '」要是變數名稱（或用逗號分開的名稱）' }); return null; } return e; };
            function block(ind) {
                const out = [];
                while (pos < rows.length && rows[pos].ind >= ind) {
                    const r = rows[pos]; if (r.ind > ind) { errors.push({ line: pos + 1, msg: '縮排不對：' + r.s }); pos++; continue; } const ln = pos + 1; pos++;
                    let m;
                    if ((m = /^程式區塊：$/.exec(r.s))) { const raw = []; while (pos < rows.length && rows[pos].ind > ind) { raw.push(rows[pos].raw.slice(2 * (ind + 1))); pos++; } const st = stmtsOfSource(raw.join('\n') + '\n'); if (!st || !st.length) errors.push({ line: ln, msg: '程式區塊裡的 Python 解析失敗' }); else st.forEach((ir) => out.push({ t: 'stmt', ir })); continue; }
                    if ((m = /^程式：(.+)$/.exec(r.s))) { const st = stmtsOfSource(m[1] + '\n'); if (!st || st.length !== 1) errors.push({ line: ln, msg: '「程式：」後面要剛好一個 Python 敘述' }); else out.push({ t: 'stmt', ir: st[0] }); continue; }
                    if ((m = /^如果 (.+) 就：$/.exec(r.s))) {
                        const c = slotIR('expr', m[1], ln); const branches = [{ c, body: block(ind + 1) }]; let els = null;
                        while (pos < rows.length && rows[pos].ind === ind) { const n = rows[pos]; let mm; if ((mm = /^否則如果 (.+) 就：$/.exec(n.s))) { pos++; branches.push({ c: slotIR('expr', mm[1], pos), body: block(ind + 1) }); continue; } if (/^否則：$/.test(n.s)) { pos++; els = block(ind + 1); } break; }
                        out.push({ t: 'if', branches, els }); continue;
                    }
                    let hit = null; for (const L of lineRes) { const mm = L.re.exec(r.s); if (mm) { hit = { L, mm }; break; } }
                    if (!hit) { errors.push({ line: ln, msg: '看不懂這一行（不是已知的區塊）：' + r.s.slice(0, 40) }); while (pos < rows.length && rows[pos].ind > ind) pos++; continue; }
                    const slots = {}; const seenTxt = {}; hit.L.order.forEach((n, i) => { const tx = hit.mm[i + 1].trim(); if (n in seenTxt) { if (seenTxt[n] !== tx) errors.push({ line: ln, msg: '「' + n + '」這個槽位在同一行出現兩次，內容要一樣' }); return; } seenTxt[n] = tx; const ir = slotIR(hit.L.t.slots[n], tx, ln); if (ir) slots[n] = ir; });
                    const bodies = {}; for (const name of hit.L.t.bodies) { bodies[name] = (pos < rows.length && rows[pos].ind > ind) ? block(ind + 1) : []; if (!bodies[name].length) errors.push({ line: ln, msg: '「' + r.s.slice(0, 30) + '」下面要有縮排的內容' }); }
                    if (Object.keys(slots).length === Object.keys(hit.L.t.slots).length) out.push({ t: hit.L.t.id, slots, bodies });
                }
                return out;
            }
            const blocks = block(0); return { ok: !errors.length, blocks, errors };
        }
        function stats(blocks) { const st = { blocks: 0, generic: 0, byTemplate: {} }; const walk = (bl) => { for (const b of bl) { st.blocks++; if (b.t === 'stmt') st.generic++; else st.byTemplate[b.t] = (st.byTemplate[b.t] || 0) + 1; if (b.t === 'if') { b.branches.forEach((x) => walk(x.body)); if (b.els) walk(b.els); } else if (b.bodies) Object.values(b.bodies).forEach(walk); } }; walk(blocks); return st; }
        return { TEMPLATES, EXPRS, LIB, buildExpr, fromIR, toIR, toCNL, parseCNL, stats, exprOf, exprText, stmtsOfSource, byId };
    }
    return { makeBlocks, SPEC, EXPR_SPEC };
});
