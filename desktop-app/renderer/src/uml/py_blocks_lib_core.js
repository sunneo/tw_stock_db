/* Python 區塊庫的資料：額外的陳述範本、運算式積木（科學函式與繪圖）、型別表、模組需求表。純資料，UMD，Python 專屬。
 *   SPEC_EXTRA / EXPR_EXTRA  跟 py_blocks_core 的 SPEC / EXPR_SPEC 同格式
 *   TYPES  範本 id → { decl:{槽位:型別}, use:{槽位:型別} }
 *          decl：這個槽位宣告（新增）一個變數，型別為：int float str list dict set any、'int*'（多個整數）、'elem'（it 槽位的元素型別）
 *          use ：這個槽位要填 → 'v:num|list|dict|set|str|any'＝已宣告的變數（型別相容）；'int|num|str|list|dict|iter|cond|any'＝運算式（型別相容）
 *   ETYPES 運算式積木 id → { ret, p:{槽位:型別} }
 *   REQ    範本／運算式積木 id → 需要先引入的模組（引入之後才能用）
 *   IMPORTS 引入積木 id → 它提供的模組名稱 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyBlocksLib = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const SPEC_EXTRA = [
        // ---- 結構化迴圈：初始化、條件、遞增都在範本裡，不會忘記終止 ----
        'for_counter|迴圈|從 {i:name} = {a} 開始，當 {i} < {b} 時重複，每輪最後 {i} 加 {s}：|$i = $a\nwhile $i < $b:\n    $$body\n    $i += $s',
        'for_countdown|迴圈|從 {i:name} = {a} 開始，當 {i} > {b} 時重複，每輪最後 {i} 減 {s}：|$i = $a\nwhile $i > $b:\n    $$body\n    $i -= $s',
        'while_counter|迴圈|當 {i} < {n} 時重複，每輪最後 {i} 加 {s}：|while $i < $n:\n    $$body\n    $i += $s',
        'while_countdown|迴圈|當 {i} > {n} 時重複，每輪最後 {i} 減 {s}：|while $i > $n:\n    $$body\n    $i -= $s',
        'for_range_down|迴圈|讓 {i:name} 從 {a} 倒數到 {b} 加一（每次減 1）：|for $i in range($a, $b, -1):\n    $$body',
        // ---- 引入模組（引入後才能用該模組的函式）----
        'import_math|引入|引入數學函式庫 math|import math',
        'import_numpy|引入|引入數值函式庫 numpy（用 np 稱呼）|import numpy as np',
        'import_plt|引入|引入繪圖函式庫 matplotlib.pyplot（用 plt 稱呼）|import matplotlib.pyplot as plt',
        'import_stat|引入|引入統計函式庫 statistics|import statistics',
        'import_random|引入|引入亂數函式庫 random|import random',
        'import_scipy|引入|引入科學計算函式庫 scipy 的積分與最佳化|from scipy import integrate, optimize',
        'import_collections|引入|引入集合函式庫 collections 的 deque 與 Counter|from collections import deque, Counter',
        'import_heapq|引入|引入堆積函式庫 heapq|import heapq',
        'import_bisect|引入|引入二分搜尋函式庫 bisect|import bisect',
        // ---- 繪圖（matplotlib.pyplot）----
        'plt_figure|繪圖|建立新圖|plt.figure()',
        'plt_plot|繪圖|畫折線圖：x 是 {x}，y 是 {y}|plt.plot($x, $y)',
        'plt_plot_label|繪圖|畫折線圖（圖例名稱 {lab}）：x 是 {x}，y 是 {y}|plt.plot($x, $y, label=$lab)',
        'plt_scatter|繪圖|畫散佈圖：x 是 {x}，y 是 {y}|plt.scatter($x, $y)',
        'plt_bar|繪圖|畫長條圖：位置 {x}，高度 {h}|plt.bar($x, $h)',
        'plt_hist|繪圖|畫直方圖：資料 {x}，分成 {n} 組|plt.hist($x, bins=$n)',
        'plt_pie|繪圖|畫圓餅圖：大小 {x}，標籤 {lab}|plt.pie($x, labels=$lab)',
        'plt_imshow|繪圖|顯示影像或矩陣 {a}|plt.imshow($a)',
        'plt_xlabel|繪圖|設定 x 軸名稱 {s}|plt.xlabel($s)',
        'plt_ylabel|繪圖|設定 y 軸名稱 {s}|plt.ylabel($s)',
        'plt_title|繪圖|設定圖的標題 {s}|plt.title($s)',
        'plt_legend|繪圖|顯示圖例|plt.legend()',
        'plt_grid|繪圖|顯示格線|plt.grid(True)',
        'plt_xlim|繪圖|設定 x 軸範圍從 {a} 到 {b}|plt.xlim($a, $b)',
        'plt_ylim|繪圖|設定 y 軸範圍從 {a} 到 {b}|plt.ylim($a, $b)',
        'plt_savefig|繪圖|把圖存成檔案 {path}|plt.savefig($path)',
        'plt_show|繪圖|顯示圖|plt.show()',
        'plt_subplots|繪圖|建立圖 {fig:name} 與座標軸 {ax:name}|$fig, $ax = plt.subplots()',
        'ax_plot|繪圖|在座標軸 {ax:name} 畫折線圖：x 是 {x}，y 是 {y}|$ax.plot($x, $y)',
        'ax_set_title|繪圖|設定座標軸 {ax:name} 的標題 {s}|$ax.set_title($s)',
        // ---- 亂數 ----
        'random_seed|科學|設定亂數種子為 {n}|random.seed($n)',
        'random_shuffle|科學|打亂清單 {l}|random.shuffle($l)',
        'np_seed|科學|設定 numpy 亂數種子為 {n}|np.random.seed($n)',
    ];
    const EXPR_EXTRA = [
        // ---- 科學函式（要先引入對應模組）----
        '平方根|科學·數學|{a} 的平方根|math.sqrt($a)', '正弦|科學·數學|{a}（弧度）的正弦|math.sin($a)', '餘弦|科學·數學|{a}（弧度）的餘弦|math.cos($a)', '正切|科學·數學|{a}（弧度）的正切|math.tan($a)', '反正切2|科學·數學|{a} 與 {b} 的 atan2（弧度）|math.atan2($a, $b)', '指數|科學·數學|e 的 {a} 次方|math.exp($a)', '自然對數|科學·數學|{a} 的自然對數|math.log($a)', '對數底10|科學·數學|{a} 的以 10 為底對數|math.log10($a)', '對數底2|科學·數學|{a} 的以 2 為底對數|math.log2($a)', '無條件捨去|科學·數學|{a} 無條件捨去成整數|math.floor($a)', '無條件進位|科學·數學|{a} 無條件進位成整數|math.ceil($a)', '最大公因數|科學·數學|{a} 與 {b} 的最大公因數|math.gcd($a, $b)', '階乘|科學·數學|{a} 的階乘|math.factorial($a)', '斜邊|科學·數學|{a} 與 {b} 的斜邊長|math.hypot($a, $b)', '弧度|科學·數學|{a} 度換成弧度|math.radians($a)', '度|科學·數學|{a} 弧度換成度|math.degrees($a)', '圓周率|科學·數學|圓周率 π|math.pi', '自然常數|科學·數學|自然常數 e|math.e',
        '陣列|科學·數值|{a} 轉成 numpy 陣列|np.array($a)', '零陣列|科學·數值|{a} 個 0 的 numpy 陣列|np.zeros($a)', '一陣列|科學·數值|{a} 個 1 的 numpy 陣列|np.ones($a)', '等差陣列|科學·數值|從 {a} 到 {b}（不含）每次 {s} 的 numpy 陣列|np.arange($a, $b, $s)', '等分陣列|科學·數值|從 {a} 到 {b} 平均分成 {n} 點的 numpy 陣列|np.linspace($a, $b, $n)', '內積|科學·數值|{a} 與 {b} 的內積|np.dot($a, $b)', '陣列平均|科學·數值|{a} 的平均|np.mean($a)', '陣列標準差|科學·數值|{a} 的標準差|np.std($a)', '陣列總和|科學·數值|{a} 的總和（numpy）|np.sum($a)', '累積和|科學·數值|{a} 的累積和|np.cumsum($a)', '陣列正弦|科學·數值|{a} 每個元素的正弦|np.sin($a)', '陣列餘弦|科學·數值|{a} 每個元素的餘弦|np.cos($a)', '陣列指數|科學·數值|{a} 每個元素的指數|np.exp($a)', '陣列平方根|科學·數值|{a} 每個元素的平方根|np.sqrt($a)', '向量長度|科學·數值|{a} 的向量長度（範數）|np.linalg.norm($a)', '反矩陣|科學·數值|矩陣 {a} 的反矩陣|np.linalg.inv($a)', '解線性方程|科學·數值|解線性方程組 {a} x = {b}|np.linalg.solve($a, $b)', '轉置|科學·數值|{a} 的轉置|np.transpose($a)', '最大值位置|科學·數值|{a} 最大值的位置|np.argmax($a)', '隨機陣列|科學·數值|{a} 個 0 到 1 的隨機數|np.random.rand($a)',
        '平均數|科學·統計|{a} 的平均數|statistics.mean($a)', '中位數|科學·統計|{a} 的中位數|statistics.median($a)', '樣本標準差|科學·統計|{a} 的標準差（樣本）|statistics.stdev($a)', '變異數|科學·統計|{a} 的變異數（樣本）|statistics.variance($a)', '眾數|科學·統計|{a} 的眾數|statistics.mode($a)',
        '隨機小數|科學·亂數|0 到 1 的隨機小數|random.random()', '隨機整數|科學·亂數|{a} 到 {b} 的隨機整數（含兩端）|random.randint($a, $b)', '隨機挑一個|科學·亂數|從 {a} 隨機挑一個|random.choice($a)',
        '定積分|科學·微積分|函式 {f} 從 {a} 到 {b} 的定積分|integrate.quad($f, $a, $b)[0]',
        '佇列|科學·集合|從 {a} 建立的佇列|deque($a)', '計數器|科學·集合|{a} 的計數器|Counter($a)', '二分位置|科學·集合|{a} 裡第一個不小於 {b} 的位置|bisect.bisect_left($a, $b)',
    ];
    const IMPORTS = { import_math: 'math', import_numpy: 'np', import_plt: 'plt', import_stat: 'statistics', import_random: 'random', import_scipy: 'integrate', import_collections: 'deque', import_heapq: 'heapq', import_bisect: 'bisect' };
    // 模組需求：id → 需要的模組（引入積木提供的名稱）
    const REQ = {};
    for (const id of Object.keys({ 平方根: 1, 正弦: 1, 餘弦: 1, 正切: 1, 反正切2: 1, 指數: 1, 自然對數: 1, 對數底10: 1, 對數底2: 1, 無條件捨去: 1, 無條件進位: 1, 最大公因數: 1, 階乘: 1, 斜邊: 1, 弧度: 1, 度: 1, 圓周率: 1, 自然常數: 1 })) REQ[id] = 'math';
    for (const id of ['陣列', '零陣列', '一陣列', '等差陣列', '等分陣列', '內積', '陣列平均', '陣列標準差', '陣列總和', '累積和', '陣列正弦', '陣列餘弦', '陣列指數', '陣列平方根', '向量長度', '反矩陣', '解線性方程', '轉置', '最大值位置', '隨機陣列', 'np_seed']) REQ[id] = 'np';
    for (const id of ['平均數', '中位數', '樣本標準差', '變異數', '眾數']) REQ[id] = 'statistics';
    for (const id of ['隨機小數', '隨機整數', '隨機挑一個', 'random_seed', 'random_shuffle']) REQ[id] = 'random';
    REQ['定積分'] = 'integrate'; REQ['佇列'] = 'deque'; REQ['計數器'] = 'deque'; REQ['二分位置'] = 'bisect'; REQ['init_deque'] = 'deque'; REQ['bfs_loop'] = 'deque';
    for (const id of ['plt_figure', 'plt_plot', 'plt_plot_label', 'plt_scatter', 'plt_bar', 'plt_hist', 'plt_pie', 'plt_imshow', 'plt_xlabel', 'plt_ylabel', 'plt_title', 'plt_legend', 'plt_grid', 'plt_xlim', 'plt_ylim', 'plt_savefig', 'plt_show', 'plt_subplots', 'ax_plot', 'ax_set_title']) REQ[id] = 'plt';

    const V = (t) => 'v:' + t;
    const TYPES = {
        // 輸入：宣告
        read_int: { decl: { n: 'int' } }, read_ints: { decl: { t: 'int*' } }, read_list: { decl: { a: 'list' } }, read_floats: { decl: { a: 'list' } }, read_float: { decl: { n: 'float' } }, read_str: { decl: { s: 'str' } }, read_strip: { decl: { s: 'str' } }, read_words: { decl: { w: 'list' } },
        read_n_ints: { decl: { a: 'list' }, use: { n: 'int' } }, read_n_lines: { decl: { a: 'list' }, use: { n: 'int' } }, read_n_strips: { decl: { a: 'list' }, use: { n: 'int' } }, read_matrix: { decl: { g: 'list' }, use: { n: 'int' } }, read_n_pairs: { decl: { a: 'list' }, use: { n: 'int' } },
        // 輸出
        print_value: { use: { e: 'any' } }, print_two: { use: { a: 'any', b: 'any' } }, print_star: { use: { e: 'iter' } }, print_join: { use: { e: 'iter' } }, print_join_sep: { use: { sep: 'str', e: 'iter' } }, print_join_str: { use: { sep: 'str', e: 'iter' } }, print_yesno: { use: { c: 'cond' } },
        // 資料：宣告
        init_list: { decl: { x: 'list' } }, init_dict: { decl: { x: 'dict' } }, init_set: { decl: { x: 'set' } }, init_zeros: { decl: { x: 'list' }, use: { n: 'int' } }, init_fill: { decl: { x: 'list' }, use: { n: 'int', v: 'any' } }, init_grid: { decl: { x: 'list' }, use: { n: 'int', m: 'int' } }, init_grid_fill: { decl: { x: 'list' }, use: { n: 'int', m: 'int', v: 'any' } }, init_deque: { decl: { q: 'list' }, use: { e: 'any' } },
        swap: { use: { a: V('any'), b: V('any') } }, fib_step: { use: { a: V('num'), b: V('num') } },
        len_of: { decl: { x: 'int' }, use: { e: 'iter' } }, sum_of: { decl: { x: 'any' }, use: { e: 'iter' } }, max_of: { decl: { x: 'any' }, use: { e: 'iter' } }, min_of: { decl: { x: 'any' }, use: { e: 'iter' } }, to_int: { decl: { x: 'int' }, use: { e: 'any' } }, to_str: { decl: { x: 'str' }, use: { e: 'any' } },
        split_by: { decl: { x: 'list' }, use: { s: 'str', sep: 'str' } }, join_by: { decl: { x: 'str' }, use: { sep: 'str', l: 'iter' } }, lower_of: { decl: { x: 'str' }, use: { s: 'str' } }, upper_of: { decl: { x: 'str' }, use: { s: 'str' } }, divmod_of: { decl: { q: 'int', r: 'int' }, use: { a: 'num', b: 'num' } },
        sorted_of: { decl: { x: 'list' }, use: { e: 'iter' } }, sorted_key: { decl: { x: 'list' }, use: { e: 'iter', k: 'any' } }, sorted_rev: { decl: { x: 'list' }, use: { e: 'iter' } }, reversed_of: { decl: { x: 'any' }, use: { e: 'iter' } },
        list_map: { decl: { x: 'list', v: 'elem:l' }, use: { l: 'iter', e: 'any' } }, list_filter: { decl: { x: 'list', v: 'elem:l' }, use: { l: 'iter', c: 'cond' } }, list_map_filter: { decl: { x: 'list', v: 'elem:l' }, use: { l: 'iter', c: 'cond', e: 'any' } }, set_of: { decl: { x: 'set' }, use: { e: 'iter' } },
        assign: { decl: { x: 'any' }, use: { e: 'any' } },
        // 更新
        incr: { use: { x: V('num') } }, decr: { use: { x: V('num') } }, add_to: { use: { x: V('num'), e: 'num' } }, sub_from: { use: { x: V('num'), e: 'num' } }, mul_by: { use: { x: V('num'), e: 'num' } }, floordiv_by: { use: { x: V('num'), e: 'num' } }, mod_by: { use: { x: V('num'), e: 'num' } },
        max_update: { use: { x: V('num'), e: 'num' } }, min_update: { use: { x: V('num'), e: 'num' } }, count_inc: { use: { d: V('dict'), k: 'any' } }, count_add: { use: { d: V('dict'), k: 'any', v: 'num' } }, group_append: { use: { d: V('dict'), k: 'any', v: 'any' } },
        // 集合
        append: { use: { l: V('list'), e: 'any' } }, extend: { use: { l: V('list'), e: 'iter' } }, pop_last: { use: { l: V('list') } }, add_set: { use: { s: V('set'), e: 'any' } }, sort_inplace: { use: { l: V('list') } }, sort_key: { use: { l: V('list'), k: 'any' } }, sort_rev: { use: { l: V('list') } }, reverse_inplace: { use: { l: V('list') } },
        // 迴圈：宣告迴圈變數
        for_range: { decl: { i: 'int' }, use: { n: 'int' } }, for_range_from: { decl: { i: 'int' }, use: { a: 'int', b: 'int' } }, for_range_step: { decl: { i: 'int' }, use: { a: 'int', b: 'int', s: 'int' } }, for_range_down: { decl: { i: 'int' }, use: { a: 'int', b: 'int' } },
        for_each: { decl: { x: 'elem:it' }, use: { it: 'iter' } }, for_enumerate: { decl: { i: 'int', x: 'elem:it' }, use: { it: 'iter' } }, for_items: { decl: { k: 'any', v: 'any' }, use: { d: V('dict') } }, for_zip: { decl: { x: 'any', y: 'any' }, use: { a: 'iter', b: 'iter' } },
        for_counter: { decl: { i: 'int' }, use: { a: 'num', b: 'num', s: 'num' } }, for_countdown: { decl: { i: 'int' }, use: { a: 'num', b: 'num', s: 'num' } }, while_counter: { use: { i: V('num'), n: 'num', s: 'num' } }, while_countdown: { use: { i: V('num'), n: 'num', s: 'num' } },
        while_do: { use: { c: 'cond' } }, while_forever: {}, bfs_loop: { decl: { u: 'any' }, use: { q: V('list') } },
        // 流程
        return_value: { use: { e: 'any' } }, return_none: {}, break_loop: {}, continue_loop: {}, do_nothing: {},
        // 演算法
        gcd_loop: { use: { a: V('num'), b: V('num') } }, binary_search: { decl: { lo: 'int', hi: 'int', mid: 'int' }, use: { a: 'int', b: 'int', c: 'cond' } }, sieve: { decl: { p: 'list', i: 'int', j: 'int' }, use: { n: 'int' } }, prefix_sums: { decl: { p: 'list', i: 'int' }, use: { a: V('list') } },
        // 繪圖
        plt_plot: { use: { x: 'iter', y: 'iter' } }, plt_plot_label: { use: { x: 'iter', y: 'iter', lab: 'str' } }, plt_scatter: { use: { x: 'iter', y: 'iter' } }, plt_bar: { use: { x: 'iter', h: 'iter' } }, plt_hist: { use: { x: 'iter', n: 'int' } }, plt_pie: { use: { x: 'iter', lab: 'iter' } }, plt_imshow: { use: { a: 'iter' } },
        plt_xlabel: { use: { s: 'str' } }, plt_ylabel: { use: { s: 'str' } }, plt_title: { use: { s: 'str' } }, plt_xlim: { use: { a: 'num', b: 'num' } }, plt_ylim: { use: { a: 'num', b: 'num' } }, plt_savefig: { use: { path: 'str' } }, plt_subplots: { decl: { fig: 'any', ax: 'any' } }, ax_plot: { use: { ax: V('any'), x: 'iter', y: 'iter' } }, ax_set_title: { use: { ax: V('any'), s: 'str' } },
        random_seed: { use: { n: 'int' } }, random_shuffle: { use: { l: V('list') } }, np_seed: { use: { n: 'int' } },
    };
    const ET = (ret, p) => ({ ret, p: p || {} });
    const ETYPES = {
        加: ET('any', { a: 'any', b: 'any' }), 減: ET('num', { a: 'num', b: 'num' }), 乘: ET('any', { a: 'any', b: 'int' }), 整除: ET('num', { a: 'num', b: 'num' }), 餘數: ET('num', { a: 'num', b: 'num' }), 次方: ET('num', { a: 'num', b: 'num' }), 負: ET('num', { a: 'num' }),
        等於: ET('cond', { a: 'any', b: 'any' }), 不等於: ET('cond', { a: 'any', b: 'any' }), 小於: ET('cond', { a: 'any', b: 'any' }), 小於等於: ET('cond', { a: 'any', b: 'any' }), 大於: ET('cond', { a: 'any', b: 'any' }), 大於等於: ET('cond', { a: 'any', b: 'any' }), 在裡面: ET('cond', { a: 'any', b: 'iter' }), 不在裡面: ET('cond', { a: 'any', b: 'iter' }),
        而且: ET('cond', { a: 'cond', b: 'cond' }), 或者: ET('cond', { a: 'cond', b: 'cond' }), 不是: ET('cond', { a: 'cond' }), 條件式: ET('any', { a: 'any', c: 'cond', b: 'any' }),
        第幾個: ET('any', { a: 'iter', i: 'int' }), 最後一個: ET('any', { a: 'iter' }), 切片: ET('iter', { a: 'iter', i: 'int', j: 'int' }), 從頭到: ET('iter', { a: 'iter', j: 'int' }), 從第幾個起: ET('iter', { a: 'iter', i: 'int' }), 反轉: ET('iter', { a: 'iter' }),
        長度: ET('int', { a: 'iter' }), 轉整數: ET('int', { a: 'any' }), 轉字串: ET('str', { a: 'any' }), 絕對值: ET('num', { a: 'num' }), 總和: ET('num', { a: 'iter' }), 最大值: ET('any', { a: 'iter' }), 最小值: ET('any', { a: 'iter' }), 較大: ET('num', { a: 'num', b: 'num' }), 較小: ET('num', { a: 'num', b: 'num' }),
        排序後: ET('list', { a: 'iter' }), 由大到小: ET('list', { a: 'iter' }), 轉清單: ET('list', { a: 'iter' }), 轉集合: ET('set', { a: 'iter' }), 範圍1: ET('iter', { a: 'int' }), 範圍2: ET('iter', { a: 'int', b: 'int' }),
        切單字: ET('list', { a: 'str' }), 依分隔切: ET('list', { a: 'str', b: 'str' }), 去空白: ET('str', { a: 'str' }), 小寫: ET('str', { a: 'str' }), 大寫: ET('str', { a: 'str' }), 出現次數: ET('int', { a: 'iter', b: 'any' }), 字典取值: ET('any', { a: 'dict', k: 'any', d: 'any' }), 所有鍵: ET('iter', { a: 'dict' }), 所有值: ET('iter', { a: 'dict' }), 所有鍵值: ET('iter', { a: 'dict' }), 連接: ET('str', { a: 'str', b: 'iter' }),
        二元組: ET('any', { a: 'any', b: 'any' }), 清單2: ET('list', { a: 'any', b: 'any' }), 空清單: ET('list'), 空字典: ET('dict'),
        平方根: ET('num', { a: 'num' }), 正弦: ET('num', { a: 'num' }), 餘弦: ET('num', { a: 'num' }), 正切: ET('num', { a: 'num' }), 反正切2: ET('num', { a: 'num', b: 'num' }), 指數: ET('num', { a: 'num' }), 自然對數: ET('num', { a: 'num' }), 對數底10: ET('num', { a: 'num' }), 對數底2: ET('num', { a: 'num' }), 無條件捨去: ET('int', { a: 'num' }), 無條件進位: ET('int', { a: 'num' }), 最大公因數: ET('int', { a: 'int', b: 'int' }), 階乘: ET('int', { a: 'int' }), 斜邊: ET('num', { a: 'num', b: 'num' }), 弧度: ET('num', { a: 'num' }), 度: ET('num', { a: 'num' }), 圓周率: ET('num'), 自然常數: ET('num'),
        陣列: ET('list', { a: 'iter' }), 零陣列: ET('list', { a: 'int' }), 一陣列: ET('list', { a: 'int' }), 等差陣列: ET('list', { a: 'num', b: 'num', s: 'num' }), 等分陣列: ET('list', { a: 'num', b: 'num', n: 'int' }), 內積: ET('num', { a: 'iter', b: 'iter' }), 陣列平均: ET('num', { a: 'iter' }), 陣列標準差: ET('num', { a: 'iter' }), 陣列總和: ET('num', { a: 'iter' }), 累積和: ET('list', { a: 'iter' }), 陣列正弦: ET('list', { a: 'iter' }), 陣列餘弦: ET('list', { a: 'iter' }), 陣列指數: ET('list', { a: 'iter' }), 陣列平方根: ET('list', { a: 'iter' }), 向量長度: ET('num', { a: 'iter' }), 反矩陣: ET('list', { a: 'iter' }), 解線性方程: ET('list', { a: 'iter', b: 'iter' }), 轉置: ET('list', { a: 'iter' }), 最大值位置: ET('int', { a: 'iter' }), 隨機陣列: ET('list', { a: 'int' }),
        平均數: ET('num', { a: 'iter' }), 中位數: ET('num', { a: 'iter' }), 樣本標準差: ET('num', { a: 'iter' }), 變異數: ET('num', { a: 'iter' }), 眾數: ET('any', { a: 'iter' }),
        隨機小數: ET('num'), 隨機整數: ET('int', { a: 'int', b: 'int' }), 隨機挑一個: ET('any', { a: 'iter' }), 定積分: ET('num', { f: 'any', a: 'num', b: 'num' }), 佇列: ET('list', { a: 'iter' }), 計數器: ET('dict', { a: 'iter' }), 二分位置: ET('int', { a: 'iter', b: 'any' }),
    };
    return { SPEC_EXTRA, EXPR_EXTRA, TYPES, ETYPES, REQ, IMPORTS };
});
