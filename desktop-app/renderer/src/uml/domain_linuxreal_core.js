/* 領域包：真實 Linux 程式設計範式（環境變數、命令列引數、結束碼、子行程、管線、fork、檔案輸入輸出、本機 socket）。格式見 domain_registry_core.js。
 * 和 domain_linuxsem_core.js（純函式的事件模擬）不同：這裡產生的程式「真的」呼叫作業系統（os.environ、sys.argv、sys.exit、subprocess、os.fork、open、socket），
 * 要靠判題器（judge-runner.js）的 argv／env／files／expectFiles／expectExit／needs 才能驗證——測試除了 {in, out} 還帶那些欄位（見判題器開頭註解）。
 * 骨架不含 def（沒有執行緒回呼），所以 socket 用單執行緒：先 listen、客戶端 connect（連線排進 backlog）、送出，再 accept。
 * 需要 fork 的範式在 Windows 由判題器交給 WSL（mode wsl），沒有 WSL 就回 UNAVAILABLE，不是失敗。
 * 差異點（輸出格式、結束碼規則、轉換方式）是槽位，由沙盒窮舉；檔名／標記／埠一律從敘述抽，抽不到就拒絕渲染。train／holdout 見 domain_linuxreal.test.js。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaDomainLinuxreal = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    function make(PAR) {
        const { S, code } = PAR.dsl;
        const D = (id, algo, label, slots, py, extra) => Object.assign({ id, algo, paradigm: 'simulation', label, slots, py }, extra || {});
        const lines = (N) => N.g || N.L[0];
        // 從敘述抽「沒設定時印的標記」：「…沒有／沒設定／未設定…印「X」」或 <X>
        const mark = (I) => { const m = /(?:沒有|沒設定|未設定|不存在|找不到)[^「。]{0,24}[「『"]([^」』"]*)[」』"]/.exec(String(I.statement)); if (!m) throw new Error('抽不到沒設定時的標記'); return m[1]; };
        const fname = (I, re, what) => { const m = re.exec(String(I.statement)); if (!m) throw new Error('抽不到' + what); return m[1]; };
        const skeletons = [
            D('lr.env-report', 'real-env-report', '環境變數查詢：標準輸入每行一個名稱，程式讀行程的環境變數，輸出值（可含「名稱=值」格式），環境裡沒有的輸出敘述指定的標記；結束碼是沒設定的個數、或有任何沒設定就 1、或固定 0',
                [S('fmt', '輸出格式', [['value', 'value'], ['pair', 'pair']]), S('ex', '結束碼', [['count', 'count'], ['flag', 'flag'], ['zero', 'zero']])],
                (c, N, I) => { const mk = mark(I);
                    return code(['import os', 'import sys', 'miss = 0', 'for line in ' + lines(N) + ':', '    name = line.strip()', '    if not name:', '        continue', '    v = os.environ.get(name)', '    if v is None:', '        miss += 1', '        print(' + JSON.stringify(mk) + ')', '    else:', '        print(' + (c.fmt === 'pair' ? 'name + "=" + v' : 'v') + ')', 'sys.exit(' + (c.ex === 'count' ? 'miss' : c.ex === 'flag' ? '1 if miss else 0' : '0') + ')']); }, { limit: 6 }),
            D('lr.argv-report', 'real-argv-report', '命令列引數：輸出引數個數（不含程式名），接著把引數排序後（升冪、降冪或原順序）每個一行；結束碼是最長引數的長度（上限 255）、引數個數、或固定 0',
                [S('ord', '排序', [['asc', 'asc'], ['desc', 'desc'], ['given', 'given']]), S('ex', '結束碼', [['maxlen', 'maxlen'], ['count', 'count'], ['zero', 'zero']])],
                (c) => code(['import sys', 'args = sys.argv[1:]', 'print(len(args))', 'for a in ' + (c.ord === 'asc' ? 'sorted(args)' : c.ord === 'desc' ? 'sorted(args, reverse=True)' : 'args') + ':', '    print(a)', 'sys.exit(' + (c.ex === 'maxlen' ? 'min(255, max([len(a) for a in args] + [0]))' : c.ex === 'count' ? 'len(args)' : '0') + ')']), { limit: 9 }),
            D('lr.spawn-env', 'real-spawn-env', '子行程與環境變數：標準輸入第一行 n 與子行程結束碼 k，接著 n 行「名稱=值」，最後一行一個名稱 q；父行程啟動子行程（同一個 Python 直譯器），子行程印出環境變數 q 的值（沒有印 none）並以 k 結束；環境只放這 n 個變數（不繼承）或繼承父行程再加上這 n 個；父行程轉印子行程的輸出，結束碼照子行程或固定 0',
                [S('inh', '子行程環境', [['clean', 'clean'], ['inherit', 'inherit']]), S('ex', '父行程結束碼', [['child', 'child'], ['zero', 'zero']])],
                (c, N) => { const L = lines(N);
                    return code(['import os', 'import subprocess', 'import sys', 'rows = list(' + L + ')', 'n, k = [int(x) for x in rows[0].split()]', 'env = dict(os.environ) if "' + c.inh + '" == "inherit" else {}', 'for r in rows[1:1 + n]:', '    key, val = r.split("=", 1)', '    env[key] = val', 'q = rows[1 + n].strip()', 'p = subprocess.run([sys.executable, "-c", "import os, sys; print(os.environ.get(sys.argv[1], \\"none\\")); sys.exit(int(sys.argv[2]))", q, str(k)], env=env, capture_output=True, text=True)', 'print(p.stdout.strip())', 'sys.exit(' + (c.ex === 'child' ? 'p.returncode' : '0') + ')']); }, { limit: 4 }),
            D('lr.file-transform', 'real-file-transform', '文字檔轉換：讀目前目錄的輸入檔，逐行處理後寫進輸出檔（每行反轉字元、整檔行序反轉、去除重複行保留第一次、依長度穩定排序、加行號「n: 」），標準輸出印寫入的行數或位元組數',
                [S('op', '處理', [['rc', 'rc'], ['rl', 'rl'], ['uq', 'uq'], ['sl', 'sl'], ['nm', 'nm']]), S('cnt', '標準輸出', [['lines', 'lines'], ['bytes', 'bytes']])],
                (c, N, I) => { const fi = fname(I, /(?:讀|輸入檔)[^。，]{0,10}?([\w.-]+\.\w+)/, '輸入檔名'), fo = fname(I, /(?:寫|輸出檔)[^。，]{0,10}?([\w.-]+\.\w+)/, '輸出檔名');
                    const body = { rc: ['res = [x[::-1] for x in rows]'], rl: ['res = rows[::-1]'], uq: ['res = []', 'for x in rows:', '    if x not in res:', '        res.append(x)'], sl: ['res = sorted(rows, key=len)'], nm: ['res = [str(i + 1) + ": " + x for i, x in enumerate(rows)]'] }[c.op];
                    return code(['rows = open(' + JSON.stringify(fi) + ').read().split("\\n")', 'if rows and rows[-1] == "":', '    rows.pop()'].concat(body, ['text = "".join(x + "\\n" for x in res)', 'open(' + JSON.stringify(fo) + ', "w").write(text)', c.cnt === 'lines' ? 'print(len(res))' : 'print(len(text.encode()))'])); }, { limit: 10 }),
            D('lr.file-merge', 'real-file-merge', '多檔案合併：命令列引數是若干個檔名，每個檔案每行一個整數；程式依序讀入全部，合併後（升冪、降冪或依讀入順序）寫進輸出檔每行一個，標準輸出印整數總和或個數',
                [S('ord', '輸出檔順序', [['asc', 'asc'], ['desc', 'desc'], ['given', 'given']]), S('st', '標準輸出', [['sum', 'sum'], ['count', 'count']])],
                (c, N, I) => { const fo = fname(I, /(?:寫進|寫到|輸出檔)[^。，]{0,8}?([\w.-]+\.\w+)/, '輸出檔名');
                    return code(['import sys', 'nums = []', 'for fn in sys.argv[1:]:', '    for ln in open(fn).read().split():', '        nums.append(int(ln))', 'res = ' + (c.ord === 'asc' ? 'sorted(nums)' : c.ord === 'desc' ? 'sorted(nums, reverse=True)' : 'nums'), 'open(' + JSON.stringify(fo) + ', "w").write("".join(str(x) + "\\n" for x in res))', c.st === 'sum' ? 'print(sum(nums))' : 'print(len(nums))']); }, { limit: 6 }),
            D('lr.file-binary', 'real-file-binary', '二進位檔轉換：讀目前目錄的二進位輸入檔，每個位元組轉換（與 0xFF 互斥或、加 1 取模 256、高低半位元組對調）或整檔位元組反轉後寫進輸出檔，標準輸出印位元組數',
                [S('op', '轉換', [['xor', 'xor'], ['add', 'add'], ['swap', 'swap'], ['rev', 'rev']])],
                (c, N, I) => { const fi = fname(I, /(?:讀|輸入檔)[^。，]{0,10}?([\w.-]+\.bin)/, '輸入檔名'), fo = fname(I, /(?:寫|輸出檔)[^。，]{0,10}?([\w.-]+\.bin)/, '輸出檔名');
                    const e = { xor: 'bytes(b ^ 255 for b in data)', add: 'bytes((b + 1) % 256 for b in data)', swap: 'bytes(((b & 15) << 4) | (b >> 4) for b in data)', rev: 'data[::-1]' }[c.op];
                    return code(['data = open(' + JSON.stringify(fi) + ', "rb").read()', 'res = ' + e, 'open(' + JSON.stringify(fo) + ', "wb").write(res)', 'print(len(res))']); }, { limit: 4 }),
            D('lr.sock-echo', 'real-sock-echo', '本機 socket 回應伺服器：命令列第一個引數是埠；程式在 127.0.0.1 開 TCP 伺服器並 listen；標準輸入每行一則訊息：另開客戶端 socket 連線並送出（送完關閉寫入端），伺服器 accept 後收完整則訊息、回覆轉換結果（轉大寫、字元反轉、長度、大小寫對調），客戶端印出收到的回覆',
                [S('tf', '轉換', [['up', 'up'], ['rev', 'rev'], ['len', 'len'], ['sw', 'sw']])],
                (c, N) => { const e = { up: 'data.upper()', rev: 'data[::-1]', len: 'str(len(data))', sw: 'data.swapcase()' }[c.tf];
                    return code(['import socket', 'import sys', 'port = int(sys.argv[1])', 'srv = socket.socket()', 'srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)', 'srv.bind(("127.0.0.1", port))', 'srv.listen(5)', 'for line in ' + lines(N) + ':', '    msg = line.rstrip("\\n")', '    cl = socket.create_connection(("127.0.0.1", port))', '    cl.sendall(msg.encode())', '    cl.shutdown(socket.SHUT_WR)', '    conn, addr = srv.accept()', '    buf = b""', '    while True:', '        part = conn.recv(4096)', '        if not part:', '            break', '        buf += part', '    data = buf.decode()', '    conn.sendall((' + e + ').encode())', '    conn.close()', '    out = b""', '    while True:', '        part = cl.recv(4096)', '        if not part:', '            break', '        out += part', '    print(out.decode())', '    cl.close()', 'srv.close()']); }, { limit: 4 }),
            D('lr.fork-pipe', 'real-fork-pipe', 'fork 與管線：標準輸入第一行 n，之後 n 個整數；對每個整數 fork 一個子行程計算（平方、階乘取模 1000003、二進位 1 的個數、十進位位數和），子行程把結果寫進管線後以某個值當結束碼離開（x 除以 10 的餘數，或結果除以 7 的餘數）；父行程依序讀管線、waitpid 取結束碼，每個整數輸出一行「結果 結束碼」',
                [S('f', '計算', [['sq', 'sq'], ['fac', 'fac'], ['pop', 'pop'], ['ds', 'ds']]), S('ex', '子行程結束碼', [['mod10', 'mod10'], ['mod7', 'mod7']])],
                (c, N) => { const f = { sq: ['    y = x * x'], fac: ['    y = 1', '    for i in range(2, x + 1):', '        y = y * i % 1000003'], pop: ['    y = bin(x).count("1")'], ds: ['    y = sum(int(ch) for ch in str(x))'] }[c.f];
                    return code(['import os', 'xs = [int(v) for v in ' + lines(N) + '[1:]]', 'for x in xs:'].concat(f, ['    r, w = os.pipe()', '    pid = os.fork()', '    if pid == 0:', '        os.close(r)', '        os.write(w, str(y).encode())', '        os._exit(' + (c.ex === 'mod10' ? 'x % 10' : 'y % 7') + ')', '    os.close(w)', '    res = os.read(r, 100).decode()', '    os.close(r)', '    _, st = os.waitpid(pid, 0)', '    print(res, os.WEXITSTATUS(st))'])); }, { limit: 8 }),
            D('lr.pipe-chain', 'real-pipe-chain', '子行程管線：標準輸入的整段文字餵給由兩個子行程接起來的管線（各是一個 Python 直譯器的小過濾器）：第一段（排序行、轉大寫、行序反轉），第二段（相鄰去重、計行數、加行號）；父行程輸出管線最後的輸出',
                [S('a', '第一段', [['sort', 'sort'], ['up', 'up'], ['rev', 'rev']]), S('b', '第二段', [['uniq', 'uniq'], ['wc', 'wc'], ['nl', 'nl']])],
                (c, N) => { const A = { sort: 'import sys; sys.stdout.write("".join(sorted(sys.stdin.readlines())))', up: 'import sys; sys.stdout.write(sys.stdin.read().upper())', rev: 'import sys; sys.stdout.write("".join(sys.stdin.readlines()[::-1]))' }[c.a];
                    const Bc = { uniq: 'import sys\\nprev = None\\nfor l in sys.stdin:\\n    if l != prev:\\n        sys.stdout.write(l)\\n    prev = l', wc: 'import sys; print(len(sys.stdin.readlines()))', nl: 'import sys\\nfor i, l in enumerate(sys.stdin):\\n    sys.stdout.write(str(i + 1) + chr(32) + l)' }[c.b];
                    return code(['import subprocess', 'import sys', 'text = "".join(x + "\\n" for x in ' + lines(N) + ')', 'p1 = subprocess.Popen([sys.executable, "-c", ' + JSON.stringify(A) + '], stdin=subprocess.PIPE, stdout=subprocess.PIPE)', 'p2 = subprocess.Popen([sys.executable, "-c", "' + Bc + '"], stdin=p1.stdout, stdout=subprocess.PIPE)', 'p1.stdout.close()', 'p1.stdin.write(text.encode())', 'p1.stdin.close()', 'out = p2.communicate()[0]', 'p1.wait()', 'sys.stdout.write(out.decode().replace("\\r\\n", "\\n"))']); }, { limit: 9 })
        ];
        // 偵測詞用「全部都出現」的先行斷言（敘述的子句順序和距離不定）；順序＝優先序
        const ALL = (...parts) => new RegExp('^' + parts.map((x) => '(?=[\\s\\S]*' + x + ')').join(''), 'i');
        const algos = [
            { key: 'real-sock-echo', re: ALL('(?:127\\.0\\.0\\.1|socket|TCP)') },
            { key: 'real-fork-pipe', re: ALL('fork', '(?:管線|waitpid)') },
            { key: 'real-spawn-env', re: ALL('子行程', '環境變數'), veto: /fork/i },
            { key: 'real-pipe-chain', re: ALL('(?:兩個子行程|子行程[^。]{0,30}管線)'), veto: /fork/i },
            { key: 'real-file-merge', re: ALL('命令列引數', '檔名') },
            { key: 'real-argv-report', re: ALL('命令列引數', '(?:個數|排序)'), veto: /檔名/ },
            { key: 'real-env-report', re: ALL('環境變數', '(?:沒設定|未設定|不存在|找不到|沒有設|查詢|讀取|查)') },
            { key: 'real-file-binary', re: ALL('二進位', '檔', '位元組') },
            { key: 'real-file-transform', re: ALL('讀', '寫', '\\.txt'), veto: /命令列引數/ }
        ].map((x) => Object.assign(x, { pri: true, raw: true, rawAll: true, veto: new RegExp((x.veto ? x.veto.source + '|' : '') + '事件|set K V|export K|bind fd') })); // 「事件」＝linuxsem 的純函式事件模擬題，不是真實 IO
        const paradigms = {}; for (const sk of skeletons) paradigms[sk.algo] = ['simulation'];
        return { id: 'linuxreal', label: '真實 Linux 程式設計（環境變數、命令列引數、結束碼、子行程、管線、fork、檔案輸入輸出、本機 socket）', requires: [], judge: { checker: 'tokens', timeoutMs: 30000 }, algos, paradigms, skeletons };
    }
    return { make };
});
