/* 標準函式庫通用轉接層：以「語意操作」為單位的語言中立目錄。純函式 UMD。設計見 DESIGN.core-ir.md 第 3 節。
 *
 * 一個操作 = { id, p:[參數型別], r:回傳型別, sem:語意（純度／副作用／錯誤行為／複雜度）, pit:[陷阱], cells:{語言→樣板}, h:{語言→[輔助函式 id]}, need:{語言→[匯入]} }
 * 語言鍵：py nodejs java c cpp cs rb pl（py＝Python，nodejs＝JavaScript／Node.js，cs＝C#，rb＝Ruby，pl＝Perl）。
 * 樣板：字串，$N＝第 N 個引數原文，@N＝第 N 個引數（必要時加括號，當接收者用），$*＝第 1 個起的其餘引數用逗號連起來；
 *       物件 {int:…,str:…,'*':…}＝依第 0 個引數的型別分派（list／dict／set／str／int／float／bool）；null＝這個語言沒有精準對應（見 cells 的註解與 degrade）。
 * 型別字串：'int'、'list<$e0>'（$e0＝第 0 個引數的元素型別）、'$k0'／'$v0'（字典的鍵／值型別）、'$0'（第 0 個引數的型別）、'$j'（所有引數型別合流）。
 * 每個操作列出語意差異與陷阱 pit，供轉換時提醒、及「無法精準對應」時降級（degrade）。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(typeof require === 'function' ? require('./ir_core.js') : root.FaIr); else root.FaIrOps = factory(root.FaIr); })(typeof self !== 'undefined' ? self : this, function (IR) {
    'use strict';
    const LANGS = ['py', 'nodejs', 'java', 'c', 'cpp', 'cs', 'rb', 'pl'];
    const LANG_OF = { python: 'py', nodejs: 'nodejs', javascript: 'nodejs', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', ruby: 'rb', perl: 'pl' };
    const OPS = {};
    // 簡寫：cells 用 [py, nodejs, java, c, cpp, cs, rb, pl] 的陣列
    function O(id, p, r, sem, cells, extra) {
        const c = {}; LANGS.forEach((l, i) => { c[l] = cells[i] === undefined ? null : cells[i]; });
        OPS[id] = Object.assign({ id, p, r, sem, cells: c, pit: [], h: {}, need: {} }, extra || {});
    }
    const PURE = '純函式', E_ERR = (s) => '錯誤：' + s;

    // ---------- 輸入輸出 ----------
    O('io.print_line', ['any'], 'void', '副作用：標準輸出＋換行', ['print($0)',
        { bool: 'console.log($0 ? "True" : "False")', '*': 'console.log($0)' },
        { bool: 'System.out.println(@0 ? "True" : "False")', '*': 'System.out.println($0)' },
        { int: 'printf("%lld\\n", (long long)($0))', str: 'puts($0)', bool: 'puts(@0 ? "True" : "False")', '*': 'printf("%g\\n", (double)($0))' },
        { bool: 'std::cout << (@0 ? "True" : "False") << "\\n"', '*': 'std::cout << ($0) << "\\n"' },
        { bool: 'Console.WriteLine(@0 ? "True" : "False")', '*': 'Console.WriteLine($0)' },
        { bool: 'puts(@0 ? "True" : "False")', '*': 'puts($0)' }, 'print "$0\\n"'],
    { stmt: true, pit: ['Python 的布林印成 True／False，其他語言多是小寫 true／false，要明確轉', '浮點數的列印格式各語言不同（Python 用最短可還原表示，Java 用科學記號門檻不同，C 用 %g）→ 需要固定位數時用 fmt.fixed', 'JavaScript 的整數超過 2^53 會失精度或印成科學記號'] });
    O('io.read_line', [], 'str', '副作用：讀標準輸入一行（不含換行）；到檔尾 Python 丟 EOFError', ['input()', 'fa_readLine()', 'fa_readLine()', 'fa_readLine()', 'fa_readLine()', 'Console.ReadLine()', 'gets.chomp', 'do { my $l = <STDIN>; chomp $l; $l }'],
        { h: { nodejs: ['fa_readLine'], java: ['fa_readLine'], c: ['fa_readLine'], cpp: ['fa_readLine'] }, pit: ['檔尾行為：Python 丟例外，Java readLine 回 null，C fgets 回 NULL，Ruby gets 回 nil——轉換時統一成「檔尾回空字串」並標註', '行尾的 \\r（Windows 換行）Python 的 input 會保留，要由呼叫端 strip'] });
    O('io.read_all', [], 'str', '副作用：讀完標準輸入', ['sys.stdin.read()', 'require("fs").readFileSync(0, "utf8")', 'fa_readAll()', 'fa_readAll()', null, 'Console.In.ReadToEnd()', '$stdin.read', 'do { local $/; <STDIN> }'], { h: { java: ['fa_readAll'], c: ['fa_readAll'] }, need: { py: ['sys'] }, pit: ['位元組與字元：Python 依區域編碼解碼，C 是原始位元組'] });

    // ---------- 轉型 ----------
    O('conv.int', ['any'], 'int', '字串→整數會剖析（失敗丟錯）；浮點→整數朝零截斷', [
        'int($0)',
        { str: 'fa_parseInt($0)', '*': 'Math.trunc($0)' },
        { str: 'Long.parseLong(@0.trim())', float: '(long)($0)', bool: '($0 ? 1L : 0L)', '*': '(long)($0)' },
        { str: 'strtoll($0, NULL, 10)', '*': '(long long)($0)' },
        { str: 'std::stoll($0)', '*': '(long long)($0)' },
        { str: 'long.Parse($0)', '*': '(long)($0)' },
        { str: 'Integer($0)', '*': '@0.to_i' }, 'int($0)'],
    { h: { nodejs: ['fa_parseInt'] }, pit: ['JavaScript parseInt 會吃前綴 "12abc"→12，Python 丟 ValueError → 用嚴格剖析輔助函式', 'C strtoll 失敗不丟錯（回 0）；要檢查需看 endptr——目前降級為不檢查並標註', '浮點轉整數是朝零截斷（int(-2.7)=-2），不是 floor'] });
    O('conv.float', ['any'], 'float', '字串→浮點（失敗丟錯）', ['float($0)', { str: 'Number($0)', '*': '$0' }, { str: 'Double.parseDouble(@0.trim())', '*': '(double)($0)' }, { str: 'strtod($0, NULL)', '*': '(double)($0)' }, { str: 'std::stod($0)', '*': '(double)($0)' }, 'double.Parse($0)', 'Float($0)', '($0 + 0)'], { pit: ['Number("") 是 0 而 Python 丟錯'] });
    O('conv.str', ['any'], 'str', '轉成字串', ['str($0)', { bool: '($0 ? "True" : "False")', '*': 'String($0)' }, { bool: '(@0 ? "True" : "False")', int: 'Long.toString($0)', '*': 'String.valueOf($0)' }, { int: 'fa_itoa($0)', '*': null }, { int: 'std::to_string($0)', '*': 'std::to_string($0)' }, '$0.ToString()', '$0.to_s', '"$0"'], { h: { c: ['fa_itoa'] }, pit: ['布林 True／False 的大小寫', '浮點的字串表示各語言不同'] });
    O('conv.bool', ['any'], 'bool', '真值判斷（Python 的 bool(x)：0、空字串、空容器為 False）', ['bool($0)', { int: '($0 !== 0)', str: '($0.length > 0)', list: '($0.length > 0)', '*': 'Boolean($0)' }, { int: '($0 != 0)', str: '(!@0.isEmpty())', list: '(!@0.isEmpty())', '*': '($0 != 0)' }, { int: '($0 != 0)', str: '(@0[0] != 0)', list: '(@0.n > 0)', '*': '($0 != 0)' }, '($0 != 0)', '($0 != 0)', null, null], { pit: ['JavaScript 的空陣列 [] 是真值（Python 為假）', 'JavaScript 的 "0" 是真值'] });

    // ---------- 數值 ----------
    O('num.abs', ['int'], '$0', PURE, ['abs($0)', 'Math.abs($0)', 'Math.abs($0)', { float: 'fabs($0)', '*': 'llabs($0)' }, 'std::abs($0)', 'Math.Abs($0)', '@0.abs', 'abs($0)'], { pit: ['Java／C 的 abs(最小整數) 溢位仍是負數；Python 整數無上限'] });
    O('num.min', ['int', 'int'], '$j', PURE, ['min($0, $1)', 'Math.min($0, $1)', 'Math.min($0, $1)', { float: 'fmin($0, $1)', '*': 'fa_min($0, $1)' }, 'std::min($0, $1)', 'Math.Min($0, $1)', '[$0, $1].min', 'List::Util::min($0, $1)'], { h: { c: ['fa_min'] }, need: { pl: ['List::Util'] }, pit: ['含 NaN 時各語言結果不同'] });
    O('num.max', ['int', 'int'], '$j', PURE, ['max($0, $1)', 'Math.max($0, $1)', 'Math.max($0, $1)', { float: 'fmax($0, $1)', '*': 'fa_max($0, $1)' }, 'std::max($0, $1)', 'Math.Max($0, $1)', '[$0, $1].max', 'List::Util::max($0, $1)'], { h: { c: ['fa_max'] }, need: { pl: ['List::Util'] } });
    O('list.min', ['list<T>'], '$e0', E_ERR('空串列丟 ValueError'), ['min($0)', 'Math.min(...$0)', 'Collections.min($0)', 'fa_list_min($0)', '*std::min_element(@0.begin(), @0.end())', 'Enumerable.Min($0)', '@0.min', 'List::Util::min(@{$0})'], { h: { c: ['fa_list_min'] }, need: { pl: ['List::Util'] }, pit: ['空串列：JavaScript 回 Infinity、C++ 未定義、Python／Java 丟錯', 'JavaScript 展開運算子在元素數十萬以上會爆堆疊'] });
    O('list.max', ['list<T>'], '$e0', E_ERR('空串列丟 ValueError'), ['max($0)', 'Math.max(...$0)', 'Collections.max($0)', 'fa_list_max($0)', '*std::max_element(@0.begin(), @0.end())', 'Enumerable.Max($0)', '@0.max', 'List::Util::max(@{$0})'], { h: { c: ['fa_list_max'] }, need: { pl: ['List::Util'] }, pit: ['同 list.min'] });
    O('list.sum', ['list<int>'], '$e0', PURE + '；O(n)', ['sum($0)', '$0.reduce((a, b) => a + b, 0)', '$0.stream().mapToLong(Long::longValue).sum()', 'fa_list_sum($0)', 'std::accumulate(@0.begin(), @0.end(), 0LL)', 'Enumerable.Sum($0)', '@0.sum', 'List::Util::sum0(@{$0})'], { h: { c: ['fa_list_sum'] }, need: { pl: ['List::Util'] }, pit: ['整數溢位：Python 無上限，Java／C 為 64 位元環繞，JavaScript 超過 2^53 失精度', '浮點加總的順序影響結果（Python 3.12 起 sum 用補償加總）'] });
    O('int.floordiv', ['int', 'int'], 'int', E_ERR('除以 0'), ['$0 // $1', 'Math.floor(@0 / @1)', 'Math.floorDiv($0, $1)', 'fa_floordiv($0, $1)', 'fa_floordiv($0, $1)', 'fa_floordiv($0, $1)', '@0.div($1)', 'POSIX::floor($0 / $1)'], { h: { c: ['fa_floordiv'], cpp: ['fa_floordiv'], cs: ['fa_floordiv'] }, need: { pl: ['POSIX'] }, pit: ['Python 的 // 是向負無限取整（-7//2=-4），C／C++／C#／Java 的 / 是朝零截斷（-7/2=-3）→ 用 floorDiv', 'JavaScript 用浮點除法，超過 2^53 的整數不精確', '除以 0：Python／Java／C#／Ruby 丟錯，JavaScript 得 Infinity，C 是未定義行為'] });
    O('int.mod', ['int', 'int'], 'int', E_ERR('除以 0'), ['$0 % $1', '((@0 % @1) + $1) % @1', 'Math.floorMod($0, $1)', 'fa_mod($0, $1)', 'fa_mod($0, $1)', 'fa_mod($0, $1)', '@0 % $1', '$0 % $1'], { h: { c: ['fa_mod'], cpp: ['fa_mod'], cs: ['fa_mod'] }, pit: ['Python／Ruby／Perl 的 % 結果與除數同號（-7%3=2），C／C++／C#／Java／JavaScript 與被除數同號（-7%3=-1）→ 用 floorMod', 'JavaScript 的括號寫法在被除數很大時仍有浮點精度問題'] });
    O('num.div', ['num', 'num'], 'float', E_ERR('除以 0（Python）'), ['$0 / $1', '$0 / $1', '((double)@0 / @1)', '((double)@0 / @1)', '((double)@0 / @1)', '((double)@0 / @1)', '@0.fdiv($1)', '$0 / $1'], { pit: ['Python 3 的 / 永遠是浮點除法；Java／C 兩個整數相除是整數除法，必須轉 double', '除以 0：Python 丟錯，其他語言得 Infinity／NaN'] });
    O('int.pow', ['int', 'int'], 'int', PURE + '；負指數 Python 會變浮點', ['$0 ** $1', 'Math.pow($0, $1)', 'fa_ipow($0, $1)', 'fa_ipow($0, $1)', 'fa_ipow($0, $1)', '(long)Math.Pow($0, $1)', '$0 ** $1', '$0 ** $1'], { h: { java: ['fa_ipow'], c: ['fa_ipow'] }, pit: ['Python 的整數次方無上限；Java／C 為 64 位元環繞；JavaScript 為浮點'] });
    O('math.sqrt', ['float'], 'float', E_ERR('負數 Python 丟 ValueError，其他回 NaN'), ['math.sqrt($0)', 'Math.sqrt($0)', 'Math.sqrt($0)', 'sqrt($0)', 'std::sqrt($0)', 'Math.Sqrt($0)', 'Math.sqrt($0)', 'sqrt($0)'], { need: { py: ['math'] }, pit: ['負數：Python 丟錯、其他回 NaN'] });
    O('math.floor', ['float'], 'int', PURE, ['math.floor($0)', 'Math.floor($0)', '(long)Math.floor($0)', '(long long)floor($0)', '(long long)std::floor($0)', '(long)Math.Floor($0)', '@0.floor', 'POSIX::floor($0)'], { need: { py: ['math'], pl: ['POSIX'] } });
    O('math.ceil', ['float'], 'int', PURE, ['math.ceil($0)', 'Math.ceil($0)', '(long)Math.ceil($0)', '(long long)ceil($0)', '(long long)std::ceil($0)', '(long)Math.Ceiling($0)', '@0.ceil', 'POSIX::ceil($0)'], { need: { py: ['math'], pl: ['POSIX'] } });
    O('math.gcd', ['int', 'int'], 'int', PURE, ['math.gcd($0, $1)', 'fa_gcd($0, $1)', 'fa_gcd($0, $1)', 'fa_gcd($0, $1)', 'std::gcd($0, $1)', '(long)System.Numerics.BigInteger.GreatestCommonDivisor($0, $1)', '@0.gcd($1)', 'fa_gcd($0, $1)'], { h: { nodejs: ['fa_gcd'], java: ['fa_gcd'], c: ['fa_gcd'] }, need: { py: ['math'] }, pit: ['結果恆為非負；gcd(0,0)=0'] });
    O('num.round', ['float'], 'int', '銀行家捨入（四捨六入五成雙）', ['round($0)', 'fa_roundEven($0)', '(long)Math.rint($0)', '(long long)nearbyint($0)', '(long long)std::nearbyint($0)', '(long)Math.Round($0, MidpointRounding.ToEven)', '@0.round(half: :even)', 'sprintf("%.0f", $0)'], { h: { nodejs: ['fa_roundEven'] }, pit: ['Python 的 round 是五成雙（round(2.5)=2、round(3.5)=4）；JavaScript Math.round 是四捨五入且負數往正無限（Math.round(-0.5) 為 -0、Math.round(2.5)=3）'] });
    O('fmt.fixed', ['float', 'int'], 'str', '固定小數位格式化（精確的二進位值、五成雙）', ['"%.*f" % ($1, $0)', 'fa_fixed($0, $1)', 'new java.math.BigDecimal($0).setScale((int)($1), java.math.RoundingMode.HALF_EVEN).toPlainString()', 'fa_fixed($0, $1)', null, '$0.ToString("F" + $1, System.Globalization.CultureInfo.InvariantCulture)', '"%.#{$1}f" % $0', 'sprintf("%.${1}f", $0)'], { h: { nodejs: ['fa_fixed'], c: ['fa_fixed'] }, pit: ['JavaScript 的 toFixed 在「精確平手」時進位（0.125.toFixed(2) 得 0.13，Python 與 C 是 0.12；實測）——用精確展開＋五成雙的輔助函式', 'Java 的 String.format("%.2f") 用「四捨五入（HALF_UP）」對十進位展開，0.125→0.13，而 Python／C 是 0.12——用 BigDecimal(精確值)＋HALF_EVEN 才對得上', '負的接近零（-0.001）Python 印 -0.00，Java 的 BigDecimal 路徑印 0.00（未處理）；無窮大與 NaN 各語言寫法不同', '區域設定：C# 要指定 InvariantCulture，否則小數點可能變逗號'] });
    O('rand.randint', ['int', 'int'], 'int', '副作用：亂數；含兩端', ['random.randint($0, $1)', '($0 + Math.floor(Math.random() * ($1 - $0 + 1)))', '($0 + new Random().nextInt((int)($1 - $0 + 1)))', '($0 + rand() % ($1 - $0 + 1))', null, 'new Random().Next((int)$0, (int)$1 + 1)', 'rand($0..$1)', '($0 + int(rand($1 - $0 + 1)))'], { need: { py: ['random'] }, pit: ['亂數種子與演算法各語言不同，同種子不會得到同序列；C 的 rand()%n 有取模偏差'] });
    O('time.now_seconds', [], 'float', '副作用：讀時鐘；自 1970 起的秒（浮點）', ['time.time()', 'Date.now() / 1000', 'System.currentTimeMillis() / 1000.0', '(double)time(NULL)', null, 'DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0', 'Time.now.to_f', 'time()'], { need: { py: ['time'] }, pit: ['C 的 time() 只有整數秒'] });

    // ---------- 容器共通 ----------
    O('coll.len', ['any'], 'int', PURE + '；O(1)（C 的字串 O(n)）', [
        'len($0)',
        { dict: '@0.size', set: '@0.size', '*': '@0.length' },
        { str: '(long)@0.length()', '*': '(long)@0.size()' },
        { str: '(long long)strlen($0)', list: '@0.n', '*': null },
        '(long long)@0.size()',
        { str: '@0.Length', '*': '@0.Count' }, '@0.length', { list: 'scalar(@{$0})', dict: 'scalar(keys %{$0})', '*': 'length($0)' }],
    { pit: ['字串長度的單位：Python 數 Unicode 碼位，Java／JavaScript 數 UTF-16 碼元（emoji 算 2），C 數位元組（UTF-8 中文算 3）——含非 ASCII 時結果不同，需要使用者確認或改用碼位計數'] });
    O('coll.contains', ['any', 'any'], 'bool', PURE + '；list/str O(n)、dict/set O(1)', [
        '$1 in $0',
        { dict: '@0.has($1)', set: '@0.has($1)', '*': '@0.includes($1)' },
        { dict: '@0.containsKey($1)', '*': '@0.contains($1)' },
        { str: '(strstr($0, $1) != NULL)', list: 'fa_list_contains($0, $1)', '*': null },
        { dict: '(@0.count($1) > 0)', str: '(@0.find($1) != std::string::npos)', '*': '(std::find(@0.begin(), @0.end(), $1) != @0.end())' },
        { dict: '@0.ContainsKey($1)', '*': '@0.Contains($1)' }, { dict: '@0.key?($1)', '*': '@0.include?($1)' }, { dict: 'exists $0->{$1}', '*': 'scalar(grep { $_ == $1 } @{$0})' }],
    { h: { c: ['fa_list_contains'] }, pit: ['JavaScript 的 includes 對 NaN 為真而 == 為假；陣列 includes 用嚴格相等，無自動轉型', '字串的 in 是子字串判斷，串列的 in 是元素相等'] });

    // ---------- 串列 ----------
    O('list.new', [], 'list<unknown>', '空串列', ['[]', '[]', 'new ArrayList<>()', 'fa_new()', '{}', 'new List<T>()', '[]', '[]'], { emit: 'node', h: { c: ['fa_new'] } });
    O('list.filled', ['T', 'int'], 'list<$0>', PURE + '；O(n)', ['[$0] * $1', 'new Array($1).fill($0)', 'new ArrayList<>(Collections.nCopies((int)($1), $0))', 'fa_filled($0, $1)', 'std::vector<decltype($0)>($1, $0)', 'Enumerable.Repeat($0, (int)$1).ToList()', 'Array.new($1, $0)', '[($0) x $1]'], { h: { c: ['fa_filled'] }, pit: ['元素是可變物件時所有位置共用同一個參考（[[0]*m]*n 的經典陷阱）——Python 與 JavaScript fill 相同，Java nCopies 也相同，轉換時語意一致但常是 bug 來源'] });
    O('list.append', ['list<T>', 'T'], 'void', '副作用：就地加到尾端；攤銷 O(1)', ['@0.append($1)', '@0.push($1)', '@0.add($1)', 'fa_push(&$0, $1)', '@0.push_back($1)', '@0.Add($1)', '@0.push($1)', 'push @{$0}, $1'], { stmt: true, h: { c: ['fa_push'] }, pit: ['C：串列以值傳入函式時，對參數 append 不會回到呼叫端（別名語意不同）——轉換器對「參數被 append」標記為不支援，需要改傳指標'] });
    O('list.pop', ['list<T>'], '$e0', E_ERR('空串列丟 IndexError'), ['@0.pop()', 'fa_pop($0)', '@0.remove(@0.size() - 1)', 'fa_pop(&$0)', null, 'fa_pop($0)', '@0.pop', 'pop @{$0}'], { h: { nodejs: ['fa_pop'], c: ['fa_pop'], cs: [] }, pit: ['空串列：JavaScript 回 undefined 不丟錯 → 用輔助函式補丟錯'] });
    O('list.insert', ['list<T>', 'int', 'T'], 'void', '副作用；O(n)', ['@0.insert($1, $2)', '@0.splice($1, 0, $2)', '@0.add((int)($1), $2)', null, '@0.insert(@0.begin() + ($1), $2)', '@0.Insert((int)$1, $2)', '@0.insert($1, $2)', 'splice(@{$0}, $1, 0, $2)'], { stmt: true, pit: ['索引超出範圍時 Python 夾到尾端，Java 丟 IndexOutOfBounds'] });
    O('list.reverse', ['list<T>'], 'void', '副作用：就地反轉', ['@0.reverse()', '@0.reverse()', 'Collections.reverse($0)', 'fa_list_reverse($0)', 'std::reverse(@0.begin(), @0.end())', '@0.Reverse()', '@0.reverse!', '@{$0} = reverse @{$0}'], { stmt: true, h: { c: ['fa_list_reverse'] } });
    O('list.sorted', ['list<T>'], 'list<$e0>', '回傳新串列，穩定排序；O(n log n)', ['sorted($0)', { str: '[...@0].sort()', '*': '[...@0].sort((a, b) => a - b)' }, 'fa_sorted($0)', 'fa_sorted($0)', 'fa_sorted($0)', 'Enumerable.OrderBy($0, x => x).ToList()', '@0.sort', 'sort { $a <=> $b } @{$0}'], { h: { java: ['fa_sorted'], c: ['fa_sorted'] }, pit: ['JavaScript 預設 sort 是字串字典序（[10,9,1].sort()→[1,10,9]）：數字必須給比較函式', 'C 的 qsort 不穩定；排序鍵相同的記錄會改變相對順序（純整數看不出來）', '字串排序：Python 依碼位，Java／JavaScript 依 UTF-16 碼元，C 依位元組——非 ASCII 時順序可能不同', 'Perl 的 sort 預設是字串字典序，數字要用 <=>'] });
    O('list.index_of', ['list<T>', 'T'], 'int', E_ERR('找不到 Python 丟 ValueError，其他回 -1'), ['@0.index($1)', '@0.indexOf($1)', '(long)@0.indexOf($1)', null, null, '@0.IndexOf($1)', '@0.index($1)', null], { pit: ['找不到：Python 丟錯，其他語言回 -1——語意不同，轉換時需補檢查'] });
    O('list.copy', ['list<T>'], '$0', '淺拷貝', ['list($0)', '[...$0]', 'new ArrayList<>($0)', 'fa_list_copy($0)', '$0', 'new List<T>($0)', '@0.dup', '[@{$0}]'], { h: { c: ['fa_list_copy'] } });
    O('list.get', ['list<T>', 'int'], '$e0', E_ERR('越界 IndexError；Python 允許負索引'), ['$0[$1]', '$0[$1]', '$0.get((int)($1))', '$0.d[$1]', '$0[$1]', '$0[$1]', '$0[$1]', '$0->[$1]'], { pit: ['負索引：Python a[-1] 是最後一個；JavaScript 得 undefined，Java 丟例外，C 是未定義行為——轉換器對字面負索引改寫成 len-k；變數索引需要使用者確認', '越界：JavaScript 得 undefined 不丟錯，C 未定義'] });
    O('list.set', ['list<T>', 'int', 'T'], 'void', '副作用', ['$0[$1] = $2', '$0[$1] = $2', '$0.set((int)($1), $2)', '$0.d[$1] = $2', '$0[$1] = $2', '$0[$1] = $2', '$0[$1] = $2', '$0->[$1] = $2'], { stmt: true });
    O('list.slice', ['list<T>', 'int', 'int'], 'list<$e0>', '回傳新串列；範圍夾在邊界內', ['$0[$1:$2]', '@0.slice($1, $2)', 'new ArrayList<>($0.subList((int)Math.max(0, $1), (int)Math.min($0.size(), $2)))', null, null, '@0.GetRange((int)$1, (int)($2 - $1))', '@0[$1...$2]', '[@{$0}[$1..$2-1]]'], { pit: ['Java subList 越界丟例外而 Python 夾邊界；subList 是原串列的「視圖」，不是拷貝，要包 new ArrayList'] });

    // ---------- 字串 ----------
    O('str.char_at', ['str', 'int'], 'str', E_ERR('越界'), ['$0[$1]', '$0[$1]', 'String.valueOf($0.charAt((int)($1)))', '$0[$1]', 'std::string(1, $0[$1])', '$0[(int)$1].ToString()', '$0[$1]', 'substr($0, $1, 1)'], { pit: ['C：結果是 char 而不是長度 1 的字串，只能與另一個 char 比較；轉換器限制只在比較時使用', '字元的單位同 coll.len（碼位 vs 碼元 vs 位元組）'] });
    O('str.split_ws', ['str'], 'list<str>', '依任意空白切開並丟掉空欄位', ['$0.split()', 'fa_splitWs($0)', 'fa_splitWs($0)', null, null, '$0.Split((char[])null, StringSplitOptions.RemoveEmptyEntries)', '$0.split', "split(' ', $0)"], { h: { nodejs: ['fa_splitWs'], java: ['fa_splitWs'] }, pit: ['JavaScript 的 split(/\\s+/) 對前導空白會產生空欄位——輔助函式先 trim', 'C 沒有字串串列型別 → 常見組合 split+int 請用 str.split_ints'] });
    O('str.split_sep', ['str', 'str'], 'list<str>', '依分隔字串切開（保留空欄位）', ['$0.split($1)', '$0.split($1)', 'fa_split($0, $1)', null, null, '$0.Split($1)', '$0.split($1, -1)', 'split(quotemeta($1), $0, -1)'], { h: { java: ['fa_split'] }, pit: ['Java 的 String.split 吃正規表示式且丟掉結尾空欄位——輔助函式用 Pattern.quote 且 limit=-1', 'Ruby 預設也會丟掉結尾空欄位，要給 -1'] });
    O('str.split_ints', ['str'], 'list<int>', '慣用語：list(map(int, s.split()))；依空白切開並轉整數', ['list(map(int, $0.split()))', 'fa_splitInts($0)', 'fa_splitInts($0)', 'fa_splitInts($0)', null, 'Array.ConvertAll($0.Split((char[])null, StringSplitOptions.RemoveEmptyEntries), long.Parse).ToList()', '$0.split.map(&:to_i)', 'map { int($_) } split(" ", $0)'], { h: { nodejs: ['fa_splitInts'], java: ['fa_splitInts'], c: ['fa_splitInts'] }, pit: ['慣用語被認出來才能在沒有字串串列型別的 C 裡表達'] });
    O('str.strip', ['str'], 'str', PURE, ['$0.strip()', '$0.trim()', '$0.trim()', 'fa_strip($0)', null, '$0.Trim()', '$0.strip', '($0 =~ s/^\\s+|\\s+$//gr)'], { h: { c: ['fa_strip'] }, pit: ['空白字元的定義略有不同（Java trim 只去 <=U+0020）'] });
    O('str.upper', ['str'], 'str', PURE, ['$0.upper()', '$0.toUpperCase()', '$0.toUpperCase(Locale.ROOT)', null, null, '$0.ToUpperInvariant()', '$0.upcase', 'uc($0)'], { pit: ['特殊字元（德文 ß→SS）與土耳其語 i 的區域問題；Java 要指定 Locale.ROOT'] });
    O('str.lower', ['str'], 'str', PURE, ['$0.lower()', '$0.toLowerCase()', '$0.toLowerCase(Locale.ROOT)', null, null, '$0.ToLowerInvariant()', '$0.downcase', 'lc($0)'], {});
    O('str.join', ['str', 'list<str>'], 'str', PURE, ['$0.join($1)', '@1.join($0)', 'String.join($0, $1)', null, null, 'string.Join($0, $1)', '@1.join($0)', 'join($0, @{$1})'], { pit: ['Python 的 join 要求每項都是字串，其他語言的 join 會自動轉型——輸入含數字時要先 conv.str'] });
    O('str.join_num', ['str', 'list<int>'], 'str', '慣用語：sep.join(map(str, 整數串列))', ['$0.join(map(str, $1))', '@1.join($0)', 'fa_joinNums($0, $1)', 'fa_joinNums($0, $1)', null, 'string.Join($0, $1)', '@1.join($0)', 'join($0, @{$1})'], { h: { java: ['fa_joinNums'], c: ['fa_joinNums'] }, pit: ['元素若是布林，Python 會印 True／False，其他語言是 true／false——本慣用語只對整數串列成立'] });
    O('list.sort', ['list<T>'], 'void', '副作用：就地排序，穩定', ['@0.sort()', { str: '@0.sort()', '*': '@0.sort((a, b) => a - b)' }, 'Collections.sort($0)', 'fa_sort($0)', 'std::sort(@0.begin(), @0.end())', '@0.Sort()', '@0.sort!', '@{$0} = sort { $a <=> $b } @{$0}'], { stmt: true, h: { c: ['fa_sort'] }, pit: ['同 list.sorted 的穩定性與預設字典序陷阱'] });
    O('str.replace',['str', 'str', 'str'], 'str', PURE + '（全部取代，不是正規表示式）', ['$0.replace($1, $2)', '$0.split($1).join($2)', '$0.replace($1, $2)', null, null, '$0.Replace($1, $2)', '$0.gsub($1, $2)', '($0 =~ s/\\Q$1\\E/$2/gr)'], { pit: ['JavaScript replace 只換第一個、replaceAll 要 Node 15+、字串取代要避開正規表示式的特殊字元；Ruby gsub 的第一參數字串當字面值但第二參數的反斜線有特殊意義'] });
    O('str.startswith', ['str', 'str'], 'bool', PURE, ['$0.startswith($1)', '$0.startsWith($1)', '$0.startsWith($1)', '(strncmp($0, $1, strlen($1)) == 0)', '(@0.rfind($1, 0) == 0)', '$0.StartsWith($1, StringComparison.Ordinal)', '$0.start_with?($1)', '(index($0, $1) == 0)'], { pit: ['C#：StartsWith(string) 預設用文化比較，要指定 Ordinal'] });
    O('str.endswith', ['str', 'str'], 'bool', PURE, ['$0.endswith($1)', '$0.endsWith($1)', '$0.endsWith($1)', null, null, '$0.EndsWith($1, StringComparison.Ordinal)', '$0.end_with?($1)', null], {});
    O('str.find', ['str', 'str'], 'int', '找不到回 -1', ['$0.find($1)', '$0.indexOf($1)', '(long)$0.indexOf($1)', 'fa_find($0, $1)', '(long long)(int)@0.find($1)', '$0.IndexOf($1, StringComparison.Ordinal)', '($0.index($1) || -1)', 'index($0, $1)'], { h: { c: ['fa_find'] }, pit: ['Ruby 的 index 找不到回 nil，位置 0 在 Ruby 是真值但需注意 ||'] });
    O('str.concat', ['str', 'str'], 'str', PURE + '；產生新字串（迴圈內連接是 O(n²)）', ['$0 + $1', '$0 + $1', '$0 + $1', 'fa_concat($0, $1)', '$0 + $1', '$0 + $1', '$0 + $1', '$0 . $1'], { h: { c: ['fa_concat'] }, pit: ['C 的 fa_concat 配置新記憶體且不釋放（洩漏）；Perl 用 . 而不是 +', 'Java／JavaScript／C# 的字串加整數會自動轉型而 Python 丟 TypeError——轉換器只在兩邊都是 str 時用本操作'] });
    O('str.repeat', ['str', 'int'], 'str', PURE, ['$0 * $1', '$0.repeat($1)', '$0.repeat((int)($1))', null, null, 'string.Concat(Enumerable.Repeat($0, (int)$1))', '$0 * $1', '$0 x $1'], { pit: ['負次數：Python 回空字串，JavaScript／Java 丟例外；Java 的 String.repeat 要 JDK 11'] });
    O('str.slice', ['str', 'int', 'int'], 'str', PURE + '（範圍夾在邊界內）', ['$0[$1:$2]', '$0.slice($1, $2)', 'fa_slice($0, $1, $2)', null, '@0.substr($1, $2 - $1)', '$0.Substring((int)$1, (int)($2 - $1))', '$0[$1...$2]', 'substr($0, $1, $2 - $1)'], { h: { java: ['fa_slice'] }, pit: ['Java／C# 的 substring 越界丟例外而 Python 夾邊界 → 輔助函式先夾邊界'] });
    O('str.is_digit', ['str'], 'bool', PURE, ['$0.isdigit()', '/^[0-9]+$/.test($0)', '$0.matches("[0-9]+")', null, null, '$0.All(char.IsDigit)', '$0.match?(/\\A\\d+\\z/)', '($0 =~ /^[0-9]+$/)'], { pit: ['Python isdigit 對其他文字的數字（如全形數字）也為真；空字串為假'] });
    O('str.char_code', ['str'], 'int', '碼位', ['ord($0)', '$0.codePointAt(0)', '(long)$0.codePointAt(0)', '(long long)(unsigned char)$0[0]', null, '(long)char.ConvertToUtf32($0, 0)', '$0.ord', 'ord($0)'], { pit: ['C 只取第一個位元組'] });
    O('str.from_code', ['int'], 'str', PURE, ['chr($0)', 'String.fromCodePoint($0)', 'new String(Character.toChars((int)($0)))', null, null, 'char.ConvertFromUtf32((int)$0)', '$0.chr(Encoding::UTF_8)', 'chr($0)'], {});

    // ---------- 字典／集合 ----------
    O('dict.new', [], 'dict<unknown,unknown>', '空字典（插入順序）', ['{}', 'new Map()', 'new LinkedHashMap<>()', null, '{}', 'new Dictionary<K,V>()', '{}', '{}'], { emit: 'node', pit: ['Java HashMap 不保證順序，要保留 Python 的插入順序必須用 LinkedHashMap；C 沒有內建雜湊表（轉換器標為不支援，或需要附帶執行階段函式庫）'] });
    O('dict.get', ['dict<K,V>', 'K'], '$v0', E_ERR('缺鍵 KeyError'), ['$0[$1]', 'fa_dget($0, $1)', 'fa_dget($0, $1)', null, '$0.at($1)', '$0[$1]', '$0.fetch($1)', '$0->{$1}'], { h: { nodejs: ['fa_dget'], java: ['fa_dget'] }, pit: ['Java Map.get 缺鍵回 null（拆箱時 NPE）、JavaScript Map.get 回 undefined——輔助函式補丟錯', '鍵的相等：JavaScript Map 用 SameValueZero，物件鍵是參考相等；Java 用 equals/hashCode'] });
    O('dict.get_default', ['dict<K,V>', 'K', 'V'], '$v0', PURE, ['$0.get($1, $2)', '(@0.has($1) ? @0.get($1) : $2)', '@0.getOrDefault($1, $2)', null, null, '@0.GetValueOrDefault($1, $2)', '@0.fetch($1, $2)', '($0->{$1} // $2)'], { pit: ['值為 None/null 時 getOrDefault 與 Python 的 get 行為不同（Python 回 None，Java 回預設值）'] });
    O('dict.put', ['dict<K,V>', 'K', 'V'], 'void', '副作用', ['$0[$1] = $2', '@0.set($1, $2)', '@0.put($1, $2)', null, '$0[$1] = $2', '$0[$1] = $2', '$0[$1] = $2', '$0->{$1} = $2'], { stmt: true });
    O('dict.delete', ['dict<K,V>', 'K'], 'void', E_ERR('缺鍵 KeyError'), ['del $0[$1]', '@0.delete($1)', '@0.remove($1)', null, '@0.erase($1)', '@0.Remove($1)', '@0.delete($1)', 'delete $0->{$1}'], { stmt: true, pit: ['缺鍵時只有 Python 丟錯，其他語言靜默'] });
    O('dict.sorted_keys', ['dict<K,V>'], 'list<$k0>', '依鍵排序的鍵串列', ['sorted($0)', '[...@0.keys()].sort((a, b) => a - b)', 'new ArrayList<>(new TreeMap<>($0).keySet())', null, null, '@0.Keys.OrderBy(k => k).ToList()', '@0.keys.sort', 'sort { $a <=> $b } keys %{$0}'], { pit: ['JavaScript 的 sort 預設字典序——數字鍵必須給比較函式'] });
    O('dict.keys', ['dict<K,V>'], 'list<$k0>', '插入順序的鍵', ['list($0.keys())', '[...@0.keys()]', 'new ArrayList<>($0.keySet())', null, null, '@0.Keys.ToList()', '@0.keys', 'keys %{$0}'], { pit: ['Perl 的 keys 順序不保證；Java 需 LinkedHashMap 才保證插入順序'] });
    O('set.add', ['set<T>', 'T'], 'void', '副作用', ['@0.add($1)', '@0.add($1)', '@0.add($1)', null, '@0.insert($1)', '@0.Add($1)', '@0.add($1)', '$0->{$1} = 1'], { stmt: true });

    // ---------- 檔案、JSON、正規表示式 ----------
    O('file.read_all', ['str'], 'str', '副作用：讀檔；找不到丟錯', ['open($0, encoding="utf-8").read()', 'require("fs").readFileSync($0, "utf8")', 'new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get($0)), java.nio.charset.StandardCharsets.UTF_8)', 'fa_readFile($0)', null, 'File.ReadAllText($0)', 'File.read($0)', 'do { local $/; open(my $f, "<", $0) or die; <$f> }'], { h: { c: ['fa_readFile'] }, pit: ['編碼：Python open 預設用區域編碼，要明確指定 utf-8；換行轉換（Windows）', 'Java 8 沒有 Files.readString'] });
    O('file.write_all', ['str', 'str'], 'void', '副作用：覆寫檔案', ['open($0, "w", encoding="utf-8").write($1)', 'require("fs").writeFileSync($0, $1)', 'java.nio.file.Files.write(java.nio.file.Paths.get($0), $1.getBytes(java.nio.charset.StandardCharsets.UTF_8))', null, null, 'File.WriteAllText($0, $1)', 'File.write($0, $1)', 'do { open(my $f, ">", $0) or die; print $f $1; close $f }'], { stmt: true, pit: ['Python 的 open(...).write 不保證立刻關檔（靠垃圾回收），其他語言通常立即寫入'] });
    O('regex.search', ['str', 'str'], 'bool', '字串中是否有符合；正規表示式', ['re.search($1, $0) is not None', 'new RegExp($1).test($0)', 'java.util.regex.Pattern.compile($1).matcher($0).find()', null, 'std::regex_search($0, std::regex($1))', 'System.Text.RegularExpressions.Regex.IsMatch($0, $1)', '$0.match?(Regexp.new($1))', '($0 =~ /$1/)'], { need: { py: ['re'] }, pit: ['正規表示式方言不同：lookbehind、命名群組語法（Python (?P<n>)、JavaScript (?<n>)）、\\d 是否含 Unicode、POSIX 字元類別、跳脫規則；轉換器只保證簡單子集（字元類、量詞、群組、錨點），其餘標原生區塊並請使用者確認'] });
    O('json.dumps', ['any'], 'str', PURE + '（鍵順序依插入）', ['json.dumps($0)', 'JSON.stringify($0)', null, null, null, 'System.Text.Json.JsonSerializer.Serialize($0)', '$0.to_json', 'encode_json($0)'], { need: { py: ['json'], rb: ['json'], pl: ['JSON::PP'] }, pit: ['Python 預設分隔符是 ", " 與 ": "（有空白），JavaScript 是無空白；ensure_ascii 預設不同（Python 逸出非 ASCII）；NaN／Infinity 的處理不同', 'Java 標準函式庫沒有 JSON → 需要第三方函式庫（降級：標原生區塊並請使用者決定）'] });
    O('json.loads', ['str'], 'any', E_ERR('格式錯誤丟錯'), ['json.loads($0)', 'JSON.parse($0)', null, null, null, 'System.Text.Json.JsonSerializer.Deserialize<object>($0)', 'JSON.parse($0)', 'decode_json($0)'], { need: { py: ['json'], rb: ['json'], pl: ['JSON::PP'] }, pit: ['大整數：JavaScript 超過 2^53 失精度；Python 保留；浮點與整數的區分（1 vs 1.0）'] });

    // ---------- 輔助函式（各語言各一份；輸出器依用到的操作貼在檔案開頭）----------
    const HELPERS = {
        nodejs: {
            fa_readLine: 'const __fa_lines = require("fs").readFileSync(0, "utf8").split("\\n"); let __fa_li = 0;\nfunction fa_readLine() { return __fa_li < __fa_lines.length ? __fa_lines[__fa_li++].replace(/\\r$/, "") : ""; }',
            fa_parseInt: 'function fa_parseInt(s) { if (!/^\\s*[+-]?\\d+\\s*$/.test(s)) throw new Error("invalid literal for int(): " + s); return parseInt(s, 10); }',
            fa_splitWs: 'function fa_splitWs(s) { s = s.trim(); return s === "" ? [] : s.split(/\\s+/); }',
            fa_splitInts: 'function fa_splitInts(s) { s = s.trim(); return s === "" ? [] : s.split(/\\s+/).map(fa_parseInt); }',
            fa_pop: 'function fa_pop(a) { if (a.length === 0) throw new Error("pop from empty list"); return a.pop(); }',
            fa_dget: 'function fa_dget(m, k) { if (!m.has(k)) throw new Error("KeyError: " + k); return m.get(k); }',
            fa_gcd: 'function fa_gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; }',
            fa_fixed: 'function fa_fixed(x, d) { if (!isFinite(x)) return Number.isNaN(x) ? "nan" : (x < 0 ? "-inf" : "inf"); const neg = x < 0 || Object.is(x, -0), ax = Math.abs(x); if (ax >= 1e21) return (neg ? "-" : "") + BigInt(ax).toString() + (d > 0 ? "." + "0".repeat(d) : ""); const s = ax.toFixed(Math.min(100, d + 30)); const dot = s.indexOf("."), ip = s.slice(0, dot), fp = s.slice(dot + 1), keep = fp.slice(0, d), rest = fp.slice(d); let up = false; if (rest.length) { const c = rest.charCodeAt(0) - 48; if (c > 5) up = true; else if (c === 5) up = /[1-9]/.test(rest.slice(1)) ? true : (Number((ip + keep).slice(-1)) % 2 === 1); } let digits = (ip + keep).split(""); if (up) { let i = digits.length - 1; while (i >= 0) { if (digits[i] === "9") { digits[i] = "0"; i--; } else { digits[i] = String(Number(digits[i]) + 1); break; } } if (i < 0) digits.unshift("1"); } const all = digits.join(""), il = all.length - d; return (neg ? "-" : "") + all.slice(0, il) + (d > 0 ? "." + all.slice(il) : ""); }',
            fa_roundEven: 'function fa_roundEven(x) { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; }'
        },
        java: {
            fa_readLine: 'static BufferedReader __br = new BufferedReader(new InputStreamReader(System.in));\n    static String fa_readLine() { try { String l = __br.readLine(); return l == null ? "" : l.replaceAll("\\\\r$", ""); } catch (IOException e) { throw new RuntimeException(e); } }',
            fa_readAll: 'static String fa_readAll() { try { return new String(System.in.readAllBytes(), "UTF-8"); } catch (IOException e) { throw new RuntimeException(e); } }',
            fa_splitWs: 'static List<String> fa_splitWs(String s) { s = s.trim(); return s.isEmpty() ? new ArrayList<String>() : new ArrayList<String>(Arrays.asList(s.split("\\\\s+"))); }',
            fa_splitInts: 'static List<Long> fa_splitInts(String s) { List<Long> r = new ArrayList<>(); for (String t : fa_splitWs(s)) r.add(Long.parseLong(t)); return r; }',
            fa_joinNums: 'static String fa_joinNums(String sep, List<Long> a) { StringBuilder sb = new StringBuilder(); for (int i = 0; i < a.size(); i++) { if (i > 0) sb.append(sep); sb.append(a.get(i)); } return sb.toString(); }',
            fa_split: 'static List<String> fa_split(String s, String sep) { return new ArrayList<String>(Arrays.asList(s.split(java.util.regex.Pattern.quote(sep), -1))); }',
            fa_sorted: 'static <T extends Comparable<T>> List<T> fa_sorted(List<T> a) { List<T> r = new ArrayList<>(a); Collections.sort(r); return r; }',
            fa_dget: 'static <K, V> V fa_dget(Map<K, V> m, K k) { if (!m.containsKey(k)) throw new RuntimeException("KeyError: " + k); return m.get(k); }',
            fa_ipow: 'static long fa_ipow(long b, long e) { long r = 1; while (e > 0) { if ((e & 1) == 1) r *= b; b *= b; e >>= 1; } return r; }',
            fa_gcd: 'static long fa_gcd(long a, long b) { a = Math.abs(a); b = Math.abs(b); while (b != 0) { long t = a % b; a = b; b = t; } return a; }',
            fa_slice: 'static String fa_slice(String s, long a, long b) { long n = s.length(); if (a < 0) a = Math.max(0, a + n); if (b < 0) b = Math.max(0, b + n); a = Math.min(a, n); b = Math.min(b, n); return a >= b ? "" : s.substring((int) a, (int) b); }'
        },
        c: {
            fa_list: 'typedef struct { long long *d; long long n, cap; } IL;',
            fa_new: 'static IL fa_new(void) { IL l = {0, 0, 0}; return l; }',
            fa_push: 'static void fa_push(IL *l, long long v) { if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 8; l->d = (long long *)realloc(l->d, l->cap * sizeof(long long)); } l->d[l->n++] = v; }',
            fa_pop: 'static long long fa_pop(IL *l) { if (l->n == 0) { fprintf(stderr, "pop from empty list\\n"); exit(1); } return l->d[--l->n]; }',
            fa_filled: 'static IL fa_filled(long long x, long long n) { IL l = fa_new(); for (long long i = 0; i < n; i++) fa_push(&l, x); return l; }',
            fa_list_copy: 'static IL fa_list_copy(IL a) { IL l = fa_new(); for (long long i = 0; i < a.n; i++) fa_push(&l, a.d[i]); return l; }',
            fa_list_sum: 'static long long fa_list_sum(IL a) { long long s = 0; for (long long i = 0; i < a.n; i++) s += a.d[i]; return s; }',
            fa_list_min: 'static long long fa_list_min(IL a) { if (a.n == 0) { fprintf(stderr, "min() of empty list\\n"); exit(1); } long long m = a.d[0]; for (long long i = 1; i < a.n; i++) if (a.d[i] < m) m = a.d[i]; return m; }',
            fa_list_max: 'static long long fa_list_max(IL a) { if (a.n == 0) { fprintf(stderr, "max() of empty list\\n"); exit(1); } long long m = a.d[0]; for (long long i = 1; i < a.n; i++) if (a.d[i] > m) m = a.d[i]; return m; }',
            fa_list_contains: 'static int fa_list_contains(IL a, long long x) { for (long long i = 0; i < a.n; i++) if (a.d[i] == x) return 1; return 0; }',
            fa_list_reverse: 'static void fa_list_reverse(IL a) { for (long long i = 0, j = a.n - 1; i < j; i++, j--) { long long t = a.d[i]; a.d[i] = a.d[j]; a.d[j] = t; } }',
            fa_sorted: 'static int fa_cmp(const void *x, const void *y) { long long a = *(const long long *)x, b = *(const long long *)y; return a < b ? -1 : a > b; }\nstatic IL fa_sorted(IL a) { IL l = fa_list_copy(a); if (l.n > 1) qsort(l.d, l.n, sizeof(long long), fa_cmp); return l; }',
            fa_sort: 'static int fa_cmp2(const void *x, const void *y) { long long a = *(const long long *)x, b = *(const long long *)y; return a < b ? -1 : a > b; }\nstatic void fa_sort(IL a) { if (a.n > 1) qsort(a.d, a.n, sizeof(long long), fa_cmp2); }',
            fa_joinNums: 'static char *fa_joinNums(const char *sep, IL a) { size_t cap = 64 + (size_t)a.n * 24 + (size_t)(a.n > 0 ? a.n - 1 : 0) * strlen(sep), n = 0; char *s = (char *)malloc(cap); s[0] = 0; for (long long i = 0; i < a.n; i++) { if (i) { strcpy(s + n, sep); n += strlen(sep); } n += (size_t)sprintf(s + n, "%lld", a.d[i]); } return s; }',
            fa_min: 'static long long fa_min(long long a, long long b) { return a < b ? a : b; }',
            fa_max: 'static long long fa_max(long long a, long long b) { return a > b ? a : b; }',
            fa_floordiv: 'static long long fa_floordiv(long long a, long long b) { if (b == 0) { fprintf(stderr, "division by zero\\n"); exit(1); } long long q = a / b; if ((a % b != 0) && ((a < 0) != (b < 0))) q--; return q; }',
            fa_mod: 'static long long fa_mod(long long a, long long b) { if (b == 0) { fprintf(stderr, "modulo by zero\\n"); exit(1); } long long r = a % b; if (r != 0 && ((r < 0) != (b < 0))) r += b; return r; }',
            fa_ipow: 'static long long fa_ipow(long long b, long long e) { long long r = 1; while (e > 0) { if (e & 1) r *= b; b *= b; e >>= 1; } return r; }',
            fa_gcd: 'static long long fa_gcd(long long a, long long b) { if (a < 0) a = -a; if (b < 0) b = -b; while (b) { long long t = a % b; a = b; b = t; } return a; }',
            fa_readLine: 'static char *fa_readLine(void) { size_t cap = 256, n = 0; char *s = (char *)malloc(cap); int ch; while ((ch = getchar()) != EOF && ch != \'\\n\') { if (n + 1 >= cap) { cap *= 2; s = (char *)realloc(s, cap); } s[n++] = (char)ch; } if (n && s[n - 1] == \'\\r\') n--; s[n] = 0; return s; }',
            fa_readAll: 'static char *fa_readAll(void) { size_t cap = 4096, n = 0; char *s = (char *)malloc(cap); int ch; while ((ch = getchar()) != EOF) { if (n + 1 >= cap) { cap *= 2; s = (char *)realloc(s, cap); } s[n++] = (char)ch; } s[n] = 0; return s; }',
            fa_splitInts: 'static IL fa_splitInts(const char *s) { IL l = fa_new(); char *e; while (1) { while (*s == \' \' || *s == \'\\t\' || *s == \'\\r\') s++; if (!*s) break; long long v = strtoll(s, &e, 10); if (e == s) { fprintf(stderr, "invalid literal for int()\\n"); exit(1); } fa_push(&l, v); s = e; } return l; }',
            fa_itoa: 'static char *fa_itoa(long long v) { char *s = (char *)malloc(32); snprintf(s, 32, "%lld", v); return s; }',
            fa_concat: 'static char *fa_concat(const char *a, const char *b) { size_t x = strlen(a), y = strlen(b); char *s = (char *)malloc(x + y + 1); memcpy(s, a, x); memcpy(s + x, b, y + 1); return s; }',
            fa_strip: 'static char *fa_strip(const char *a) { while (*a == \' \' || *a == \'\\t\' || *a == \'\\n\' || *a == \'\\r\') a++; size_t n = strlen(a); while (n && (a[n - 1] == \' \' || a[n - 1] == \'\\t\' || a[n - 1] == \'\\n\' || a[n - 1] == \'\\r\')) n--; char *s = (char *)malloc(n + 1); memcpy(s, a, n); s[n] = 0; return s; }',
            fa_find: 'static long long fa_find(const char *a, const char *b) { const char *p = strstr(a, b); return p ? (long long)(p - a) : -1; }',
            fa_fixed: 'static char *fa_fixed(double x, long long d) { char *s = (char *)malloc(400); snprintf(s, 400, "%.*f", (int)d, x); return s; }',
            fa_readFile: 'static char *fa_readFile(const char *p) { FILE *f = fopen(p, "rb"); if (!f) { fprintf(stderr, "cannot open file\\n"); exit(1); } fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET); char *s = (char *)malloc(n + 1); size_t r = fread(s, 1, n, f); s[r] = 0; fclose(f); return s; }'
        }
    };
    // 輔助函式的相依（先貼被依賴的）
    const HDEPS = { c: { fa_new: ['fa_list'], fa_push: ['fa_list'], fa_pop: ['fa_list'], fa_filled: ['fa_new', 'fa_push'], fa_list_copy: ['fa_new', 'fa_push'], fa_list_sum: ['fa_list'], fa_list_min: ['fa_list'], fa_list_max: ['fa_list'], fa_list_contains: ['fa_list'], fa_list_reverse: ['fa_list'], fa_sorted: ['fa_list_copy'], fa_sort: ['fa_list'], fa_joinNums: ['fa_list'], fa_splitInts: ['fa_new', 'fa_push'] }, java: { fa_splitInts: ['fa_splitWs'] }, nodejs: { fa_splitInts: ['fa_parseInt'] } };

    // ---------- 查表 ----------
    const has = (id) => !!OPS[id];
    const get = (id) => OPS[id] || null;
    const ids = () => Object.keys(OPS);
    const baseOf = (ty) => (ty && ty.t) || 'unknown';
    function pick(cell, argTys) {
        if (cell == null || typeof cell === 'string') return cell;
        const b = baseOf(argTys && argTys[0]); if (cell[b] !== undefined) return cell[b];
        if (b === 'unknown' || b === 'any') { return cell['*'] !== undefined ? cell['*'] : null; }
        return cell['*'] !== undefined ? cell['*'] : null;
    }
    // 回傳型別：依引數型別代入
    function retType(op, argTys) {
        const o = OPS[op]; if (!o) return IR.T.unknown; const r = o.r; const a0 = (argTys && argTys[0]) || IR.T.unknown;
        if (r === '$j') return (argTys || []).reduce((acc, t, i) => (i === 0 ? t : IR.tyJoin(acc, t)), IR.T.unknown);
        if (/\$/.test(r)) {
            const elem = (a0.a && a0.a[0]) || (a0.t === 'str' ? IR.T.str : IR.T.unknown);
            const tys = { e0: elem, k0: (a0.t === 'dict' && a0.a[0]) || IR.T.unknown, v0: (a0.t === 'dict' && a0.a[1]) || IR.T.unknown, 0: a0, 1: (argTys && argTys[1]) || IR.T.unknown };
            const sub = (s) => s.replace(/\$(e0|k0|v0|0|1)/g, (m, k) => '@@' + k + '@@'); const s = sub(r);
            const m = /^@@(e0|k0|v0|0|1)@@$/.exec(s); if (m) return tys[m[1]];
            const m2 = /^(list|set)<@@(e0|k0|v0|0|1)@@>$/.exec(s); if (m2) return { t: m2[1], a: [tys[m2[2]]] };
            return IR.tyParse(r.replace(/\$\w+/g, 'unknown'));
        }
        return IR.tyParse(r);
    }
    // 展開樣板。args：[{raw, atom}]。回傳 {code, helpers, needs, missing}
    function render(op, lang, args, argTys) {
        const o = OPS[op]; const L = LANG_OF[lang] || lang; if (!o) return { code: null, missing: '不認得的操作 ' + op };
        const cell = pick(o.cells[L], argTys || []); if (cell == null) return { code: null, missing: op + ' 在 ' + lang + ' 沒有精準對應' + (argTys && argTys[0] ? '（引數型別 ' + IR.tyStr(argTys[0]) + '）' : '') };
        const code = cell.replace(/([$@])(\d|\*)/g, (m, sig, n) => { if (n === '*') return args.slice(1).map((a) => a.raw).join(', '); const a = args[+n]; if (!a) return m; return sig === '@' ? a.atom : a.raw; });
        return { code, helpers: (o.h[L] || []).slice(), needs: (o.need[L] || []).slice() };
    }
    // 一段運算式文字是不是「原子」（可直接當接收者／運算元，不必再加括號）：最外層（括號外、引號外）沒有空白，且不以一元運算子開頭
    function atomic(s) {
        s = String(s); if (/^[-+!~*&]/.test(s)) return false; let depth = 0, q = null;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
            if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
            if ('([{'.indexOf(ch) >= 0) depth++; else if (')]}'.indexOf(ch) >= 0) depth--; else if (depth === 0 && /\s/.test(ch)) return false;
        }
        return true;
    }
    // 展開輔助函式相依；回傳依序要貼的程式
    function helperSource(lang, idsUsed) {
        const L = LANG_OF[lang] || lang, tbl = HELPERS[L] || {}, deps = (HDEPS[L] || {}), seen = [], out = [];
        const add = (id) => { if (seen.indexOf(id) >= 0) return; seen.push(id); (deps[id] || []).forEach(add); if (tbl[id] != null) out.push(tbl[id]); };
        idsUsed.forEach(add); return out;
    }
    // 該語言的覆蓋：沒有精準對應的操作清單
    function coverage() { const out = {}; LANGS.forEach((l) => { const n = ids().filter((id) => { const c = OPS[id].cells[l]; return c != null && !(typeof c === 'object' && Object.keys(c).every((k) => c[k] == null)); }).length; out[l] = { mapped: n, total: ids().length }; }); return out; }

    // ---------- Python 原始碼的辨識表（Python「進」模組用）：慣用寫法 → 操作 id ----------
    const PY = {
        func: { len: 'coll.len', int: 'conv.int', float: 'conv.float', str: 'conv.str', bool: 'conv.bool', abs: 'num.abs', sum: 'list.sum', round: 'num.round', chr: 'str.from_code', ord: 'str.char_code', input: 'io.read_line' },
        func2: { min: 'num.min', max: 'num.max', pow: 'int.pow' },        // 兩個引數時
        func1: { min: 'list.min', max: 'list.max', sorted: 'list.sorted' },  // 一個引數時
        method: { append: 'list.append', pop: 'list.pop', insert: 'list.insert', reverse: 'list.reverse', index: 'list.index_of', copy: 'list.copy', strip: 'str.strip', upper: 'str.upper', lower: 'str.lower', replace: 'str.replace', startswith: 'str.startswith', endswith: 'str.endswith', find: 'str.find', keys: 'dict.keys', add: 'set.add', isdigit: 'str.is_digit' },
        module: { 'math.sqrt': 'math.sqrt', 'math.floor': 'math.floor', 'math.ceil': 'math.ceil', 'math.gcd': 'math.gcd', 'random.randint': 'rand.randint', 'time.time': 'time.now_seconds', 'json.dumps': 'json.dumps', 'json.loads': 'json.loads', 'sys.stdin.read': 'io.read_all' }
    };

    return { LANGS, LANG_OF, OPS, HELPERS, PY, has, get, ids, pick, retType, render, helperSource, atomic, coverage, count: () => ids().length };
});
