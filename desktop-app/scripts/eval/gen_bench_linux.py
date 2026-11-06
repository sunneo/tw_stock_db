"""Linux 小工具拆解題庫（tar／gzip／xz／xxd／grep／cat／eval／exec／BMP）：產生 bench_linux_*.jsonl。
判題器只有 stdin／stdout 文字（沒有檔案、沒有 argv、沒有位元組 IO），所以二進位資料一律用十六進位字串進出。
每題 ref 是從頭實作的 Python（不靠 zlib／tarfile／base64），產生器另用標準庫交叉驗證。
split：train＝可拿來教（課／範式）；holdout＝只拿來量測，不准拿去教。
用法：python3 scripts/eval/gen_bench_linux.py
"""
import base64, json, os, random, struct, sys, tarfile, io, zlib
sys.path.insert(0, os.path.dirname(__file__))
from bench_lib import Bench, run, SEED_DIR

random.seed(20261106)
LOW = 'abcdefghijklmnopqrstuvwxyz'
ALN = LOW + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'


def rtext(lo, hi, alpha=ALN):
    return ''.join(random.choice(alpha) for _ in range(random.randint(lo, hi)))


def rbytes(lo, hi):
    return bytes(random.randint(0, 255) for _ in range(random.randint(lo, hi)))


def hx(b):
    return b.hex()


B = Bench('bench_linux_all.jsonl', 1)
HOLD = set()


def add(id, title, level, statement, ref, gen, tags, hold=False, **kw):
    g0 = gen

    def gen(i):  # 輸出不可為空（避免「什麼都不印」就過）
        for _ in range(200):
            x = g0(i)
            if run(ref, x).strip(): return x
        return x
    B.add(id, title, level, statement, ref, gen, tags=tags, **kw)
    B.P[-1]['split'] = 'holdout' if hold else 'train'
    B.P[-1]['tool'] = tags[0]


# ───────────────────────── xxd ─────────────────────────
def gen_xe():
    while True:
        t = ' '.join(rtext(1, 5).split())
        if t: return t + '\n'


add('lx-xxd-encode', 'xxd：字串轉十六進位', 'LX0', '輸入一行文字（只含英數字與空白、頭尾沒有空白）。輸出它每個位元組（ASCII）的兩位小寫十六進位，全部接在一起、中間不加空白。',
    'def main():\n    s = input()\n    out = ""\n    for ch in s:\n        out += "%02x" % ord(ch)\n    print(out)\n',
    lambda i: gen_xe(), ['xxd', 'hex'])
add('lx-xxd-decode', 'xxd -r -p：十六進位轉字串', 'LX0', '輸入一行十六進位字串（偶數個字元，每兩個字元一個位元組，皆為可顯示 ASCII）。輸出還原後的文字。',
    'def main():\n    h = input().strip()\n    out = ""\n    for i in range(0, len(h), 2):\n        out += chr(int(h[i:i+2], 16))\n    print(out)\n',
    lambda i: rtext(1, 12, ALN).encode().hex() + '\n', ['xxd', 'hex'], hold=True)
add('lx-xxd-bits', 'xxd -b：位元組轉二進位', 'LX0', '輸入一行只含小寫英文字母的文字。輸出每個字元 ASCII 碼的 8 位二進位（高位在前），以空白分隔，一行。',
    'def main():\n    s = input().strip()\n    parts = []\n    for ch in s:\n        v = ord(ch)\n        b = ""\n        for k in range(7, -1, -1):\n            b += str((v >> k) & 1)\n        parts.append(b)\n    print(" ".join(parts))\n',
    lambda i: rtext(1, 8, LOW) + '\n', ['xxd', 'bits'])
add('lx-xxd-dump', 'xxd：十六進位傾印', 'LX1',
    '輸入一行十六進位字串（1～40 個位元組，偶數個字元）。仿 xxd 傾印：每 16 個位元組一行。每行格式：8 位小寫十六進位位移、冒號、一個空白，然後十六進位部分——每 2 個位元組為一組、組內相連、組與組之間一個空白（最後一行若剩單一位元組，該組只有 2 個字元）——此部分用空白補到 39 個字元，再接兩個空白，最後是該行位元組的 ASCII 字元（0x20～0x7e 顯示原字元，其餘顯示 .）。',
    'def main():\n    h = input().strip()\n    data = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    for off in range(0, len(data), 16):\n        row = data[off:off+16]\n        groups = []\n        for j in range(0, len(row), 2):\n            groups.append("".join("%02x" % b for b in row[j:j+2]))\n        hexs = " ".join(groups)\n        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in row)\n        print("%08x: %s  %s" % (off, hexs.ljust(39), asc))\n',
    lambda i: bytes(random.choice([random.randint(32, 126), random.randint(0, 255)]) for _ in range(random.randint(1, 40))).hex() + '\n', ['xxd', 'hex', 'format'], hold=True)


def mkdump(b):
    L = []
    for off in range(0, len(b), 16):
        row = b[off:off + 16]
        g = ' '.join(row[j:j + 2].hex() for j in range(0, len(row), 2))
        L.append('%08x: %s  %s' % (off, g.ljust(39), ''.join(chr(c) if 32 <= c < 127 else '.' for c in row)))
    return L


def gen_rev(i):
    L = mkdump(bytes(random.randint(0, 255) for _ in range(random.randint(1, 40))))
    return str(len(L)) + '\n' + '\n'.join(L) + '\n'


add('lx-xxd-reverse', 'xxd -r：傾印還原', 'LX1', '輸入第一行是行數 n，接著 n 行 xxd 傾印（格式：8 位位移、冒號、空白；十六進位部分固定佔第 11～49 個字元，組內相連、組間一個空白，不足處補空白；之後是 ASCII 欄）。輸出還原出的所有位元組的十六進位，全部相連、一行、小寫。',
    'def main():\n    n = int(input())\n    out = ""\n    for _ in range(n):\n        line = input()\n        field = line[10:49]\n        for part in field.split():\n            out += part\n    print(out)\n',
    gen_rev, ['xxd', 'hex', 'parser'])

# ───────────────────────── cat ─────────────────────────
def gen_lines(blank=False, tab=False):
    def g(i):
        n = random.randint(1, 7); L = []
        for _ in range(n):
            if blank and random.random() < .45: L.append('')
            else:
                w = rtext(1, 5, LOW)
                if tab and random.random() < .5: w = w + '\t' + rtext(1, 3, LOW)
                L.append(w)
        return str(n) + '\n' + '\n'.join(L) + '\n'
    return g


add('lx-cat-n', 'cat -n：行號', 'LX0', '第一行是 n，接著 n 行文字。輸出每行前面加行號：行號靠右對齊寬度 6、接一個 Tab、再接原行文字。',
    'def main():\n    n = int(input())\n    for i in range(1, n + 1):\n        line = input()\n        print("%6d\\t%s" % (i, line))\n',
    gen_lines(), ['cat', 'lines'])
add('lx-cat-ns', 'cat -ns：行號並壓縮空行', 'LX1', '第一行是 n，接著 n 行文字（可能有空行）。仿 cat -n -s：連續多個空行只保留第一個空行；留下的每一行（含空行）都編號，行號靠右對齊寬度 6、接一個 Tab、再接該行文字。',
    'def main():\n    n = int(input())\n    prev_blank = False\n    k = 0\n    for _ in range(n):\n        line = input()\n        blank = line == ""\n        if blank and prev_blank:\n            continue\n        prev_blank = blank\n        k += 1\n        print("%6d\\t%s" % (k, line))\n',
    gen_lines(blank=True), ['cat', 'lines', 'state'], hold=True)
add('lx-cat-A', 'cat -A（簡化）：顯示 Tab 與行尾', 'LX0', '第一行是 n，接著 n 行文字（可能含 Tab）。輸出每行：Tab 換成兩個字元 ^I，行尾加一個 $。',
    'def main():\n    n = int(input())\n    for _ in range(n):\n        line = input()\n        print(line.replace("\\t", "^I") + "$")\n',
    gen_lines(tab=True), ['cat', 'lines'])


def gen_multi(i):
    P = []
    for _ in range(2):
        k = random.randint(1, 4); P.append(str(k) + '\n' + '\n'.join(rtext(1, 4, LOW) for _ in range(k)))
    return '\n'.join(P) + '\n'


add('lx-cat-two', 'cat -n 檔1 檔2：行號跨檔連續', 'LX1', '輸入兩個「檔案」：每個檔案是一行 k 加上 k 行文字（先第一個、再第二個）。仿 cat -n 檔1 檔2：把兩個檔案依序連接，行號從 1 連續編到最後（不重新開始），格式：行號靠右對齊寬度 6、一個 Tab、文字。',
    'def main():\n    lines = []\n    for _ in range(2):\n        k = int(input())\n        for _ in range(k):\n            lines.append(input())\n    for i, line in enumerate(lines, 1):\n        print("%6d\\t%s" % (i, line))\n',
    gen_multi, ['cat', 'lines'], hold=True)

# ───────────────────────── grep ─────────────────────────
WORDS = ['apple', 'Apple', 'banana', 'cherry', 'date', 'APPLE', 'grape', 'pineapple', 'berry', 'plum']


def gen_grep(flags):
    def g(i):
        n = random.randint(3, 8); pat = random.choice(['app', 'an', 'rr', 'e', 'APP', 'ple'])
        L = [' '.join(random.choice(WORDS) for _ in range(random.randint(1, 3))) for _ in range(n)]
        return (flags + '\n' if flags is not None else '') + pat + '\n' + str(n) + '\n' + '\n'.join(L) + '\n'
    return g


GREP_BASE = '第二行起讀入'
add('lx-grep-fixed', 'grep：固定字串', 'LX0', '第一行是搜尋字串 pat，第二行是 n，接著 n 行文字。依序輸出含有 pat 的行（原樣）。',
    'def main():\n    pat = input()\n    n = int(input())\n    for _ in range(n):\n        line = input()\n        if pat in line:\n            print(line)\n', gen_grep(None), ['grep', 'scan'])
for fid, flag, desc, body, hold in [
    ('lx-grep-i', '-i', '忽略大小寫比對，輸出含 pat 的行（原樣）', '        if pat.lower() in line.lower():\n            print(line)\n', False),
    ('lx-grep-v', '-v', '反向：輸出「不含」pat 的行（原樣）', '        if pat not in line:\n            print(line)\n', True),
    ('lx-grep-n', '-n', '輸出含 pat 的行，每行前面加「行號:」（行號從 1 起算，冒號後直接接原行文字）', '        if pat in line:\n            print("%d:%s" % (i, line))\n', False),
    ('lx-grep-c', '-c', '只輸出含 pat 的行數（一個整數）', '        if pat in line:\n            cnt += 1\n', True)]:
    ref = 'def main():\n    pat = input()\n    n = int(input())\n' + ('    cnt = 0\n' if flag == '-c' else '') + '    for i in range(1, n + 1):\n        line = input()\n' + body + ('    print(cnt)\n' if flag == '-c' else '')
    add(fid, 'grep ' + flag, 'LX0', '第一行是搜尋字串 pat，第二行是 n，接著 n 行文字。仿 grep ' + flag + '：' + desc + '。',
        ref, (lambda f: (lambda i: gen_grep(None)(i)))(flag), ['grep', 'flag'], hold=hold)


def gen_flags(i):
    fl = random.choice(['-i -n', '-v -n', '-c -i', '-i -v', '-n', '-c -v', '-i -v -n'])
    return gen_grep(fl)(i)


add('lx-grep-flags', 'grep：旗標組合', 'LX1',
    '第一行是旗標（以空白分隔，只會出現 -i -v -n -c 的某些組合），第二行是搜尋字串 pat，第三行是 n，接著 n 行文字。-i 忽略大小寫；-v 取反（輸出不含的行）；-n 在輸出行前加「行號:」；-c 不輸出行、只輸出符合的行數（-c 與 -n 同時出現時只看 -c）。',
    'def main():\n    flags = input().split()\n    pat = input()\n    n = int(input())\n    ci = "-i" in flags\n    inv = "-v" in flags\n    num = "-n" in flags\n    cnt_only = "-c" in flags\n    cnt = 0\n    for i in range(1, n + 1):\n        line = input()\n        a, b = line, pat\n        if ci:\n            a, b = a.lower(), b.lower()\n        hit = b in a\n        if inv:\n            hit = not hit\n        if hit:\n            cnt += 1\n            if not cnt_only:\n                print(("%d:" % i if num else "") + line)\n    if cnt_only:\n        print(cnt)\n',
    gen_flags, ['grep', 'flag', 'state'], hold=True)


def gen_o(i):
    pat = random.choice(['ab', 'a', 'aa', 'ba']); n = random.randint(2, 6)
    return pat + '\n' + str(n) + '\n' + '\n'.join(rtext(2, 10, 'ab') for _ in range(n)) + '\n'


add('lx-grep-o', 'grep -o：只輸出符合的部分', 'LX1', '第一行是 pat，第二行是 n，接著 n 行（只含 a、b）。仿 grep -o：每一行由左到右找出 pat 的所有「不重疊」出現，每個出現各輸出一行 pat 本身；整份輸入共找到幾次，最後再多輸出一行：「total=次數」。',
    'def main():\n    pat = input()\n    n = int(input())\n    total = 0\n    for _ in range(n):\n        line = input()\n        i = 0\n        while i + len(pat) <= len(line):\n            if line[i:i+len(pat)] == pat:\n                print(pat)\n                total += 1\n                i += len(pat)\n            else:\n                i += 1\n    print("total=%d" % total)\n',
    gen_o, ['grep', 'scan', 'string'])


def gen_w(i):
    n = random.randint(3, 7); pat = random.choice(['cat', 'dog', 'an'])
    pool = ['cat', 'cats', 'concat', 'dog', 'dogs', 'hotdog', 'an', 'and', 'man', 'the', 'a']
    return pat + '\n' + str(n) + '\n' + '\n'.join(' '.join(random.choice(pool) for _ in range(random.randint(1, 4))) for _ in range(n)) + '\n'


add('lx-grep-w', 'grep -w：整字比對', 'LX1', '第一行是 pat，第二行是 n，接著 n 行（單字以單一空白分隔）。仿 grep -w：輸出「含有一個單字恰好等於 pat」的行（原樣）。',
    'def main():\n    pat = input()\n    n = int(input())\n    for _ in range(n):\n        line = input()\n        if pat in line.split(" "):\n            print(line)\n',
    gen_w, ['grep', 'scan', 'string'], hold=True)

# ───────────────────────── regex ─────────────────────────
def gen_kp(i):
    n = random.randint(3, 7)
    pat = random.choice(['a.c', '^ab', 'bc$', 'a*b', '^a.*c$', 'b.b', '^$', 'ab*c', '^c', 'a.$'])
    return pat + '\n' + str(n) + '\n' + '\n'.join(rtext(0, 6, 'abc') for _ in range(n)) + '\n'


add('lx-regex-kp', '正規表示式：. * ^ $（Kernighan–Pike）', 'LX2', '第一行是樣式 pat（字元只有 a b c 與四種特殊符號：. 任一字元；* 前一個字元（或 .）重複 0 次以上；^ 只出現在開頭，表示從行首開始比；$ 只出現在結尾，表示比到行尾）。第二行 n，接著 n 行（可能是空行，只含 a、b、c）。仿 grep：依序輸出「行中有任何位置能符合 pat」的行；若行是空行也要輸出時，輸出一個空行。',
    'def match_here(p, pi, t, ti):\n    if pi == len(p):\n        return True\n    if pi + 1 < len(p) and p[pi + 1] == "*":\n        c = p[pi]\n        k = ti\n        while True:\n            if match_here(p, pi + 2, t, k):\n                return True\n            if k < len(t) and (c == "." or t[k] == c):\n                k += 1\n            else:\n                return False\n    if p[pi] == "$" and pi + 1 == len(p):\n        return ti == len(t)\n    if ti < len(t) and (p[pi] == "." or p[pi] == t[ti]):\n        return match_here(p, pi + 1, t, ti + 1)\n    return False\n\n\ndef search(p, t):\n    if p.startswith("^"):\n        return match_here(p, 1, t, 0)\n    for s in range(len(t) + 1):\n        if match_here(p, 0, t, s):\n            return True\n    return False\n\n\ndef main():\n    p = input()\n    n = int(input())\n    for _ in range(n):\n        t = input()\n        if search(p, t):\n            print(t)\n',
    gen_kp, ['regex', 'recursion', 'backtrack'], hold=True)


def gen_cls(i):
    n = random.randint(3, 7)
    pat = random.choice(['a[bc]d', 'a+b', 'ab?c', '[ab]*c', 'a.+d', '[^a]b', 'a*b*c', 'x?[ab]+', 'c[^b]*a'])
    return pat + '\n' + str(n) + '\n' + '\n'.join(rtext(1, 6, 'abcd') for _ in range(n)) + '\n'


add('lx-regex-class', '正規表示式：字元類別與 ? + *', 'LX2', '第一行是樣式 pat，由以下單元組成：普通字母 a～d、. （任一字元）、[abc] （集合）、[^ab] （補集），每個單元後可接 ? （0 或 1 次）、+ （1 次以上）、* （0 次以上）。第二行 n，接著 n 行（只含 a～d、長度≥1）。對每一行輸出 yes 或 no：整行是否「完全」符合 pat（相當於 ^pat$）。',
    'def parse(p):\n    units = []\n    i = 0\n    while i < len(p):\n        if p[i] == "[":\n            j = p.index("]", i)\n            body = p[i+1:j]\n            neg = body.startswith("^")\n            chars = body[1:] if neg else body\n            u = ("set", chars, neg)\n            i = j + 1\n        else:\n            u = ("any",) if p[i] == "." else ("ch", p[i])\n            i += 1\n        q = "1"\n        if i < len(p) and p[i] in "?+*":\n            q = p[i]\n            i += 1\n        units.append((u, q))\n    return units\n\n\ndef ok(u, c):\n    if u[0] == "any":\n        return True\n    if u[0] == "ch":\n        return u[1] == c\n    return (c in u[1]) != u[2]\n\n\ndef main():\n    units = parse(input())\n    n = int(input())\n    for _ in range(n):\n        t = input()\n        m = len(units)\n        L = len(t)\n        dp = [[False] * (L + 1) for _ in range(m + 1)]\n        dp[m][L] = True\n        for a in range(m - 1, -1, -1):\n            u, q = units[a]\n            for b in range(L, -1, -1):\n                one = b < L and ok(u, t[b])\n                if q == "1":\n                    dp[a][b] = one and dp[a + 1][b + 1]\n                elif q == "?":\n                    dp[a][b] = dp[a + 1][b] or (one and dp[a + 1][b + 1])\n                elif q == "*":\n                    dp[a][b] = dp[a + 1][b] or (one and dp[a][b + 1])\n                else:\n                    dp[a][b] = one and (dp[a + 1][b + 1] or dp[a][b + 1])\n        print("yes" if dp[0][0] else "no")\n',
    gen_cls, ['regex', 'dp', 'nfa'])


def gen_glob(i):
    n = random.randint(3, 6)
    pat = random.choice(['*.txt', 'a?c*', '*a*b*', '??', 'ab*', '*', 'a*c', '?b*'])
    return pat + '\n' + str(n) + '\n' + '\n'.join(rtext(1, 7, 'abc.txt') for _ in range(n)) + '\n'


add('lx-glob', '萬用字元比對：* 與 ?', 'LX1', '第一行是樣式 pat（* 代表任意長度含空字串，? 代表恰一個字元，其他字元照字面）。第二行 n，接著 n 行字串。每行輸出 yes／no：整個字串是否完全符合 pat。',
    'def main():\n    p = input()\n    n = int(input())\n    for _ in range(n):\n        t = input()\n        dp = [[False] * (len(t) + 1) for _ in range(len(p) + 1)]\n        dp[0][0] = True\n        for i in range(1, len(p) + 1):\n            if p[i-1] == "*":\n                dp[i][0] = dp[i-1][0]\n            for j in range(1, len(t) + 1):\n                if p[i-1] == "*":\n                    dp[i][j] = dp[i-1][j] or dp[i][j-1]\n                elif p[i-1] == "?" or p[i-1] == t[j-1]:\n                    dp[i][j] = dp[i-1][j-1]\n        print("yes" if dp[len(p)][len(t)] else "no")\n',
    gen_glob, ['regex', 'dp', 'glob'])

# ───────────────────────── eval ─────────────────────────
def rexpr(d=0, allow_div=True):
    if d >= 3 or random.random() < .3: return str(random.randint(1, 20))
    op = random.choice(['+', '-', '*'] + (['/'] if allow_div else []))
    if op == '/': return '%s / %d' % (rexpr(d + 1) if random.random() < .5 else str(random.randint(1, 60)), random.randint(1, 6))
    a, b = rexpr(d + 1), rexpr(d + 1)
    if random.random() < .5: a = '( ' + a + ' )' if ' ' in a else a
    if random.random() < .5: b = '( ' + b + ' )' if ' ' in b else b
    return a + ' ' + op + ' ' + b


def gen_expr(i):
    return rexpr() + '\n'


ARITH_REF = 'def tokenize(s):\n    toks = []\n    i = 0\n    while i < len(s):\n        c = s[i]\n        if c == " ":\n            i += 1\n        elif c.isdigit():\n            j = i\n            while j < len(s) and s[j].isdigit():\n                j += 1\n            toks.append(s[i:j])\n            i = j\n        else:\n            toks.append(c)\n            i += 1\n    return toks\n\n\ndef div0(a, b):\n    q = abs(a) // abs(b)\n    return q if (a >= 0) == (b >= 0) else -q\n\n\ndef main():\n    toks = tokenize(input())\n    pos = [0]\n\n    def peek():\n        return toks[pos[0]] if pos[0] < len(toks) else None\n\n    def take():\n        pos[0] += 1\n        return toks[pos[0] - 1]\n\n    def factor():\n        t = take()\n        if t == "(":\n            v = expr()\n            take()\n            return v\n        return int(t)\n\n    def term():\n        v = factor()\n        while peek() in ("*", "/"):\n            o = take()\n            r = factor()\n            v = v * r if o == "*" else div0(v, r)\n        return v\n\n    def expr():\n        v = term()\n        while peek() in ("+", "-"):\n            o = take()\n            r = term()\n            v = v + r if o == "+" else v - r\n        return v\n\n    print(expr())\n'
add('lx-eval-arith', 'eval：四則運算含括號（遞迴下降）', 'LX2', '輸入一行算式：非負整數、+ - * / 與括號，記號之間可能有空白。* 與 / 優先於 + -，同級由左到右，括號最優先；/ 為整數除法，結果向 0 取整（除數不會是 0）。輸出算式的值。',
    ARITH_REF, gen_expr, ['eval', 'recursion', 'parser'], hold=True)


def gen_rpn(i):
    st = []; toks = []
    for _ in range(random.randint(2, 6)):
        toks.append(str(random.randint(1, 15)))
    out = [toks[0]]
    for t in toks[1:]:
        out += [t, random.choice(['+', '-', '*'])] if random.random() < .8 else [t]
    # 補運算子讓堆疊只剩一個
    d = 0
    for t in out: d += 1 if t.lstrip('-').isdigit() else -1
    out += [random.choice('+-*')] * (d - 1)
    return ' '.join(out) + '\n'


add('lx-eval-rpn', 'eval：後序式求值（堆疊）', 'LX0', '輸入一行後序（逆波蘭）式：整數與 + - * 以空白分隔。輸出求值結果。',
    'def main():\n    st = []\n    for t in input().split():\n        if t in ("+", "-", "*"):\n            b = st.pop()\n            a = st.pop()\n            st.append(a + b if t == "+" else a - b if t == "-" else a * b)\n        else:\n            st.append(int(t))\n    print(st[-1])\n',
    gen_rpn, ['eval', 'stack'])


def gen_infix(i):
    return rexpr(allow_div=True).replace('/', '*') + '\n' if False else rexpr(allow_div=True) + '\n'


add('lx-eval-infix2rpn', 'eval：中序轉後序（調度場）', 'LX1', '輸入一行中序算式（非負整數、+ - * / 與括號，記號間有空白；同級由左到右結合）。輸出對應的後序式：記號以單一空白分隔。',
    'def main():\n    prec = {"+": 1, "-": 1, "*": 2, "/": 2}\n    out = []\n    ops = []\n    for t in input().split():\n        if t.isdigit():\n            out.append(t)\n        elif t == "(":\n            ops.append(t)\n        elif t == ")":\n            while ops[-1] != "(":\n                out.append(ops.pop())\n            ops.pop()\n        else:\n            while ops and ops[-1] != "(" and prec[ops[-1]] >= prec[t]:\n                out.append(ops.pop())\n            ops.append(t)\n    while ops:\n        out.append(ops.pop())\n    print(" ".join(out))\n',
    gen_infix, ['eval', 'stack', 'shunting-yard'], hold=True)


def gen_tok(i):
    return random.choice([rexpr(), rexpr().replace(' ', '')]) + '\n'


add('lx-eval-tokenize', 'eval：算式斷詞', 'LX1', '輸入一行算式（非負整數、+ - * / 與括號，可能沒有空白）。依序每行輸出一個記號：整數輸出 NUM:值，運算子輸出 OP:符號，左括號輸出 LP，右括號輸出 RP。',
    'def main():\n    s = input()\n    i = 0\n    while i < len(s):\n        c = s[i]\n        if c == " ":\n            i += 1\n        elif c.isdigit():\n            j = i\n            while j < len(s) and s[j].isdigit():\n                j += 1\n            print("NUM:" + s[i:j])\n            i = j\n        elif c == "(":\n            print("LP")\n            i += 1\n        elif c == ")":\n            print("RP")\n            i += 1\n        else:\n            print("OP:" + c)\n            i += 1\n',
    gen_tok, ['eval', 'lexer', 'state-machine'])


def gen_vars(i):
    names = ['x', 'y', 'z', 'w', 'k']; n = random.randint(2, 5); L = []; defined = []
    for j in range(n):
        nm = names[j]; terms = []
        for _ in range(random.randint(1, 3)):
            terms.append(str(random.randint(1, 9)) if not defined or random.random() < .4 else random.choice(defined))
        e = terms[0]
        for t in terms[1:]: e += ' ' + random.choice('+-*') + ' ' + t
        L.append('%s = %s' % (nm, e)); defined.append(nm)
    return str(n) + '\n' + '\n'.join(L) + '\n'


add('lx-eval-vars', 'eval／exec：簡易變數賦值直譯', 'LX1', '第一行 n，接著 n 行賦值「名稱 = 式子」。式子由整數、先前已賦值的變數名稱與 + - * 組成，以空白分隔；* 優先於 + -，同級由左到右。依賦值順序，每行輸出「名稱=值」。',
    'def main():\n    n = int(input())\n    env = {}\n    for _ in range(n):\n        name, rhs = input().split(" = ")\n        toks = rhs.split()\n        vals = []\n        for t in toks[0::2]:\n            vals.append(env[t] if t in env else int(t))\n        ops = toks[1::2]\n        terms = [vals[0]]\n        signs = []\n        for o, v in zip(ops, vals[1:]):\n            if o == "*":\n                terms[-1] *= v\n            else:\n                signs.append(o)\n                terms.append(v)\n        r = terms[0]\n        for s, v in zip(signs, terms[1:]):\n            r = r + v if s == "+" else r - v\n        env[name] = r\n        print("%s=%d" % (name, r))\n',
    gen_vars, ['eval', 'exec', 'interpreter', 'dict'])


# vm 用「變數」指令集，避免堆疊旋轉：LOAD/STORE
def gen_vm2(i):
    n = random.randint(1, 9); m = random.randint(2, 4)
    t = random.choice(['fact', 'sum', 'pow'])
    if t == 'fact':
        prog = ['PUSH 1', 'STORE a', 'PUSH %d' % n, 'STORE n', 'LOAD n', 'JZ 15', 'LOAD a', 'LOAD n', 'MUL', 'STORE a', 'LOAD n', 'PUSH 1', 'SUB', 'STORE n', 'JMP 4', 'LOAD a', 'PRINT']
    elif t == 'sum':
        prog = ['PUSH 0', 'STORE a', 'PUSH %d' % n, 'STORE n', 'LOAD n', 'JZ 15', 'LOAD a', 'LOAD n', 'ADD', 'STORE a', 'LOAD n', 'PUSH 1', 'SUB', 'STORE n', 'JMP 4', 'LOAD a', 'PRINT']
    else:
        prog = ['PUSH 1', 'STORE a', 'PUSH %d' % n, 'STORE n', 'LOAD n', 'JZ 15', 'LOAD a', 'PUSH %d' % m, 'MUL', 'STORE a', 'LOAD n', 'PUSH 1', 'SUB', 'STORE n', 'JMP 4', 'LOAD a', 'PRINT']
    return str(len(prog)) + '\n' + '\n'.join(prog) + '\n'


add('lx-vm-exec', 'exec：堆疊虛擬機指令執行', 'LX2', '第一行 m，接著 m 行指令（編號從 0 起）。機器有一個堆疊與一組變數（名稱→整數）。指令：PUSH k（推入整數）、LOAD v（推入變數）、STORE v（彈出存入變數）、ADD／SUB／MUL（彈出 b 再彈出 a，推入 a+b／a-b／a*b）、JZ t（彈出一個值，為 0 就跳到第 t 行，否則下一行）、JMP t（無條件跳到第 t 行）、PRINT（彈出並輸出該值）。從第 0 行開始執行，超過最後一行就結束。',
    'def main():\n    m = int(input())\n    prog = [input().split() for _ in range(m)]\n    st = []\n    var = {}\n    pc = 0\n    while pc < m:\n        ins = prog[pc]\n        op = ins[0]\n        pc += 1\n        if op == "PUSH":\n            st.append(int(ins[1]))\n        elif op == "LOAD":\n            st.append(var[ins[1]])\n        elif op == "STORE":\n            var[ins[1]] = st.pop()\n        elif op in ("ADD", "SUB", "MUL"):\n            b = st.pop()\n            a = st.pop()\n            st.append(a + b if op == "ADD" else a - b if op == "SUB" else a * b)\n        elif op == "JZ":\n            if st.pop() == 0:\n                pc = int(ins[1])\n        elif op == "JMP":\n            pc = int(ins[1])\n        elif op == "PRINT":\n            print(st.pop())\n',
    gen_vm2, ['exec', 'vm', 'interpreter', 'loop'], hold=True)

# ───────────────────────── exec ─────────────────────────
def gen_argv(i):
    words = ['ls', '-la', 'file.txt', 'a b', 'hello world', 'x', "it's", 'dir', '--flag=1', '']
    parts = []
    for _ in range(random.randint(1, 5)):
        w = random.choice(words)
        if ' ' in w or w == '': parts.append(random.choice(['"', "'"]) + w + random.choice(['"', "'"]) if False else '"' + w + '"')
        elif "'" in w: parts.append('"' + w + '"')
        else: parts.append(w if random.random() < .6 else "'" + w + "'")
    if random.random() < .3: parts[0] = parts[0] + '\\ ' + 'z'
    return '  '.join(parts) + '\n'


add('lx-exec-argv', 'exec：命令列切成 argv（引號與跳脫）', 'LX2', '輸入一行 shell 風格命令列。以空白分隔參數；單引號內全部照字面；雙引號內照字面（不處理 $）；引號外的反斜線讓下一個字元照字面（包含空白）；引號本身不進入參數；兩個相鄰引號 "" 會形成一個空參數。輸出第一行是參數個數 argc，之後每個參數一行：「[索引] 參數內容」（索引從 0 起，空參數就只有「[i] 」）。',
    'def main():\n    s = input()\n    args = []\n    cur = ""\n    has = False\n    q = None\n    i = 0\n    while i < len(s):\n        c = s[i]\n        if q:\n            if c == q:\n                q = None\n            else:\n                cur += c\n        elif c in "\\"\'":\n            q = c\n            has = True\n        elif c == "\\\\":\n            i += 1\n            cur += s[i]\n            has = True\n        elif c == " ":\n            if has or cur:\n                args.append(cur)\n            cur = ""\n            has = False\n        else:\n            cur += c\n            has = True\n        i += 1\n    if has or cur:\n        args.append(cur)\n    print(len(args))\n    for k, a in enumerate(args):\n        print("[%d] %s" % (k, a))\n',
    gen_argv, ['exec', 'argv', 'state-machine', 'string'])


def gen_env(i):
    n = random.randint(1, 3); keys = random.sample(['HOME', 'USER', 'PATH', 'X', 'LANG'], n + 1)
    env = [(k, rtext(1, 5, LOW)) for k in keys[:n]]
    pieces = []
    for _ in range(random.randint(2, 4)):
        k = random.choice(keys)
        pieces.append(random.choice(['$' + k, '${' + k + '}x', '${' + k + '}']) if True else '')
        pieces.append(random.choice(['/', ':', '-', '.']))
    return str(n) + '\n' + '\n'.join('%s=%s' % kv for kv in env) + '\n' + ''.join(pieces) + '\n'


add('lx-exec-env', 'exec：環境變數展開', 'LX1', '第一行 n，接著 n 行「名稱=值」，最後一行是樣板。樣板中的 $名稱 或 ${名稱} 要換成值（名稱由大寫字母組成；$名稱 的名稱取到第一個非大寫字母為止；沒定義的名稱換成空字串）。輸出展開結果。',
    'def main():\n    n = int(input())\n    env = {}\n    for _ in range(n):\n        k, v = input().split("=")\n        env[k] = v\n    s = input()\n    out = ""\n    i = 0\n    while i < len(s):\n        if s[i] == "$":\n            if s[i + 1] == "{":\n                j = s.index("}", i)\n                name = s[i + 2:j]\n                i = j + 1\n            else:\n                j = i + 1\n                while j < len(s) and "A" <= s[j] <= "Z":\n                    j += 1\n                name = s[i + 1:j]\n                i = j\n            out += env.get(name, "")\n        else:\n            out += s[i]\n            i += 1\n    print(out)\n',
    gen_env, ['exec', 'env', 'string'], hold=True)


def gen_pipe(i):
    cmds = random.sample(['upper', 'rev', 'sort', 'uniq', 'tac', 'head 2', 'tail 2', 'wc', 'grep a', 'lower'], random.randint(1, 3))
    n = random.randint(2, 6)
    return ' | '.join(cmds) + '\n' + str(n) + '\n' + '\n'.join(rtext(1, 5, 'abcAB') for _ in range(n)) + '\n'


add('lx-exec-pipeline', 'exec：管線 cmd1 | cmd2（行串流過濾器）', 'LX2', '第一行是管線（以 " | " 分隔的命令），第二行 n，接著 n 行為輸入。命令：upper／lower（整行大／小寫）、rev（每行字元反轉）、sort（行依字典序排序）、uniq（刪去「相鄰」重複行）、tac（行序反轉）、head 2／tail 2（前／後 2 行）、wc（輸出一行，內容是行數）、grep x（保留含 x 的行）。依序處理，輸出最後的行。',
    'def apply(cmd, L):\n    w = cmd.split()\n    if w[0] == "upper":\n        return [x.upper() for x in L]\n    if w[0] == "lower":\n        return [x.lower() for x in L]\n    if w[0] == "rev":\n        return [x[::-1] for x in L]\n    if w[0] == "sort":\n        return sorted(L)\n    if w[0] == "uniq":\n        out = []\n        for x in L:\n            if not out or out[-1] != x:\n                out.append(x)\n        return out\n    if w[0] == "tac":\n        return L[::-1]\n    if w[0] == "head":\n        return L[:int(w[1])]\n    if w[0] == "tail":\n        return L[-int(w[1]):]\n    if w[0] == "wc":\n        return [str(len(L))]\n    return [x for x in L if w[1] in x]\n\n\ndef main():\n    cmds = input().split(" | ")\n    n = int(input())\n    L = [input() for _ in range(n)]\n    for c in cmds:\n        L = apply(c, L)\n    for x in L:\n        print(x)\n',
    gen_pipe, ['exec', 'pipeline', 'dispatch'])

# ───────────────────────── tar ─────────────────────────
def tar_header(name, size, mode='0000644'):
    h = bytearray(512)
    def put(off, s): h[off:off + len(s)] = s.encode()
    put(0, name); put(100, mode + '\0'); put(108, '0000000\0'); put(116, '0000000\0')
    put(124, '%011o\0' % size); put(136, '%011o\0' % 0); h[148:156] = b' ' * 8; put(156, '0')
    put(257, 'ustar\0'); put(263, '00')
    chk = sum(h); put(148, '%06o\0 ' % chk)
    return bytes(h)


def tar_bytes(files):
    out = b''
    for name, data in files:
        out += tar_header(name, len(data)) + data + b'\0' * (-len(data) % 512)
    return out + b'\0' * 1024


# 交叉驗證 tar_header 與標準庫相容
_t = tar_bytes([('a.txt', b'hello')])
_tf = tarfile.open(fileobj=io.BytesIO(_t)); assert _tf.getmembers()[0].name == 'a.txt' and _tf.extractfile('a.txt').read() == b'hello'


def gen_tchk(i):
    return rtext(1, 12, LOW + '._') + ' ' + str(random.randint(0, 99999)) + '\n'


TAR_HDR = '（ustar 標頭 512 位元組：名稱 0–99 位元組、其餘欄位如下，全部未用位元組補 0：mode 欄 100–107 為字串 0000644 加 NUL；uid 108–115、gid 116–123 皆為 0000000 加 NUL；size 124–135 為 11 位八進位數字加 NUL；mtime 136–147 為 11 個 0 加 NUL；chksum 148–155；typeflag 156 為字元 0；magic 257–262 為 ustar 加 NUL；version 263–264 為 00。）'
add('lx-tar-checksum', 'tar：標頭檢查碼', 'LX1', '輸入一行「檔名 大小」（檔名只含小寫字母、點與底線，大小為十進位整數）。依 ustar 規則組出 512 位元組標頭' + TAR_HDR + ' 計算檢查碼：先把 chksum 欄 8 個位元組都視為空白字元（0x20），再把整個 512 位元組的值加總。輸出檢查碼寫成 6 位八進位數字（左補 0）。',
    'def main():\n    name, size = input().split()\n    h = [0] * 512\n\n    def put(off, s):\n        for i, ch in enumerate(s):\n            h[off + i] = ord(ch)\n\n    put(0, name)\n    put(100, "0000644")\n    put(108, "0000000")\n    put(116, "0000000")\n    put(124, "%011o" % int(size))\n    put(136, "00000000000")\n    put(148, "        ")\n    put(156, "0")\n    put(257, "ustar")\n    put(263, "00")\n    print("%06o" % sum(h))\n',
    gen_tchk, ['tar', 'octal', 'checksum', 'struct'])


def gen_tblk(i):
    return str(random.choice([0, 1, 511, 512, 513, random.randint(0, 5000), random.randint(1000, 99999)])) + '\n'


add('lx-tar-blocks', 'tar：資料區塊與補齊', 'LX0', '輸入一行檔案大小 s（位元組）。tar 以 512 位元組為區塊：一個檔案佔 1 個標頭區塊，加上資料區塊（資料補 0 補到 512 的倍數，s=0 沒有資料區塊）。輸出兩行：第一行是這一個檔案佔用的區塊數，第二行是只含這個檔案的完整封存檔位元組數（再加 2 個全 0 的結尾區塊）。',
    'def main():\n    s = int(input())\n    data_blocks = (s + 511) // 512\n    blocks = 1 + data_blocks\n    print(blocks)\n    print((blocks + 2) * 512)\n',
    gen_tblk, ['tar', 'padding', 'arith'], hold=True)


def gen_toff(i):
    n = random.randint(1, 5)
    return str(n) + '\n' + '\n'.join('%s %d' % (rtext(1, 6, LOW), random.choice([0, random.randint(1, 1200), 512])) for _ in range(n)) + '\n'


add('lx-tar-offsets', 'tar：各檔標頭位移', 'LX1', '第一行 n，接著 n 行「檔名 大小」。把這些檔案依序放進同一個 tar（每個檔案：512 位元組標頭＋資料補齊到 512 的倍數），輸出每個檔案「標頭在封存檔中的位元組位移」與「資料開始的位移」，每檔一行：「檔名 標頭位移 資料位移」，最後一行輸出封存檔總大小（含 2 個 512 位元組的結尾區塊）。',
    'def main():\n    n = int(input())\n    off = 0\n    for _ in range(n):\n        name, size = input().split()\n        size = int(size)\n        print(name, off, off + 512)\n        off += 512 + (size + 511) // 512 * 512\n    print(off + 1024)\n',
    gen_toff, ['tar', 'layout', 'arith'])


def gen_twrite(i):
    data = rtext(0, 60, LOW + ' ')
    return rtext(1, 10, LOW + '.') + '\n' + data + '\n'


add('lx-tar-write', 'tar：寫出單一檔案封存檔', 'LX2', '第一行是檔名（≤ 20 字元），第二行是檔案內容（ASCII，可為空）。組出完整 ustar 封存檔' + TAR_HDR + ' 檢查碼規則：chksum 欄先當作 8 個空白，整個標頭 512 位元組加總，寫成「6 位八進位數字 + NUL + 空白」。size 為內容位元組數。標頭之後接內容（補 0 到 512 的倍數），最後 1024 個 0。輸出整個封存檔的十六進位（小寫、相連、一行）。',
    'def main():\n    name = input()\n    data = input()\n    h = [0] * 512\n\n    def put(off, s):\n        for i, ch in enumerate(s):\n            h[off + i] = ord(ch)\n\n    put(0, name)\n    put(100, "0000644")\n    put(108, "0000000")\n    put(116, "0000000")\n    put(124, "%011o" % len(data))\n    put(136, "00000000000")\n    put(148, "        ")\n    put(156, "0")\n    put(257, "ustar")\n    put(263, "00")\n    put(148, "%06o" % sum(h))\n    h[154] = 0\n    h[155] = 32\n    body = [ord(c) for c in data]\n    body += [0] * (-len(body) % 512)\n    allb = h + body + [0] * 1024\n    print("".join("%02x" % b for b in allb))\n',
    gen_twrite, ['tar', 'struct', 'binary-write', 'octal'], hold=True, nhidden=4)


def gen_tparse(i):
    k = random.randint(1, 3)
    files = [(rtext(1, 8, LOW + '.'), rtext(0, 30, LOW).encode()) for _ in range(k)]
    return hx(tar_bytes(files)) + '\n'


add('lx-tar-parse', 'tar -t：解析封存檔列出檔案', 'LX2', '輸入一行十六進位字串，是一個 ustar 封存檔（每個檔案：512 位元組標頭＋資料補齊到 512 的倍數；以兩個全 0 區塊結尾）。標頭的檔名在位元組 0 開始、遇到第一個 NUL 結束；size 欄在位元組 124～134（11 個八進位數字）。依序輸出每個檔案一行「檔名 大小」（大小用十進位）。遇到名稱為空的區塊就停止。',
    'def main():\n    h = input().strip()\n    data = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    pos = 0\n    while pos + 512 <= len(data):\n        if data[pos] == 0:\n            break\n        name = ""\n        i = pos\n        while data[i] != 0:\n            name += chr(data[i])\n            i += 1\n        size = 0\n        for k in range(124, 135):\n            size = size * 8 + data[pos + k] - 48\n        print(name, size)\n        pos += 512 + (size + 511) // 512 * 512\n',
    gen_tparse, ['tar', 'parser', 'binary-read', 'octal'], nhidden=4)

# ───────────────────────── gzip / deflate ─────────────────────────
def crc32_ref(b):
    c = 0xFFFFFFFF
    for x in b:
        c ^= x
        for _ in range(8):
            c = (c >> 1) ^ (0xEDB88320 if c & 1 else 0)
    return c ^ 0xFFFFFFFF


for _ in range(20):
    _b = rbytes(0, 40); assert crc32_ref(_b) == zlib.crc32(_b)

add('lx-crc32', 'gzip：CRC-32', 'LX1', '輸入一行只含英數字的文字。輸出它的 CRC-32（gzip／zip 用的：多項式 0xEDB88320 的反射版，初值 0xFFFFFFFF，最後再與 0xFFFFFFFF 互斥或），8 位小寫十六進位（左補 0）。',
    'def main():\n    s = input()\n    c = 0xFFFFFFFF\n    for ch in s:\n        c ^= ord(ch)\n        for _ in range(8):\n            if c & 1:\n                c = (c >> 1) ^ 0xEDB88320\n            else:\n                c >>= 1\n    print("%08x" % (c ^ 0xFFFFFFFF))\n',
    lambda i: rtext(1, 20) + '\n', ['gzip', 'crc', 'bitops'])
add('lx-crc32-table', 'gzip：CRC-32（查表法）', 'LX1', '輸入一行只含英數字的文字。輸出它的 CRC-32（初值 0xFFFFFFFF、多項式 0xEDB88320 反射版、最後與 0xFFFFFFFF 互斥或），8 位小寫十六進位。請先建 256 項查表再逐位元組計算。',
    'def main():\n    table = []\n    for n in range(256):\n        c = n\n        for _ in range(8):\n            c = (c >> 1) ^ 0xEDB88320 if c & 1 else c >> 1\n        table.append(c)\n    s = input()\n    c = 0xFFFFFFFF\n    for ch in s:\n        c = table[(c ^ ord(ch)) & 255] ^ (c >> 8)\n    print("%08x" % (c ^ 0xFFFFFFFF))\n',
    lambda i: rtext(1, 30) + '\n', ['gzip', 'crc', 'table'], hold=True)
add('lx-adler32', 'zlib：Adler-32', 'LX0', '輸入一行只含英數字的文字。輸出 Adler-32：a 初值 1、b 初值 0，對每個位元組 a=(a+byte) mod 65521、b=(b+a) mod 65521，結果為 b*65536+a，輸出成 8 位小寫十六進位。',
    'def main():\n    s = input()\n    a, b = 1, 0\n    for ch in s:\n        a = (a + ord(ch)) % 65521\n        b = (b + a) % 65521\n    print("%08x" % (b * 65536 + a))\n',
    lambda i: rtext(1, 40) + '\n', ['gzip', 'checksum', 'mod'])


def lz77(s, W=16, MIN=3):
    out = []; i = 0
    while i < len(s):
        best = (0, 0)
        for j in range(max(0, i - W), i):
            L = 0
            while i + L < len(s) and s[j + L] == s[i + L] and L < 258: L += 1
            if L > best[0] or (L == best[0] and L and i - j < best[1]): best = (L, i - j)
        if best[0] >= MIN:
            out.append('<%d,%d>' % best); i += best[0]
        else:
            out.append(s[i]); i += 1
    return out


def gen_lz(i):
    base = rtext(2, 4, 'abc')
    return ''.join(random.choice([base, rtext(1, 3, 'abc'), base]) for _ in range(random.randint(2, 6)))[:30] + '\n'


add('lx-lz77-encode', 'DEFLATE：LZ77 貪婪編碼', 'LX2', '輸入一行只含 a、b、c 的字串 s。以視窗 16、最短匹配 3 做 LZ77：位置 i 時，在 [i-16, i-1] 的每個起點 j 找最長匹配長度 L（匹配可以延伸超過 i，即來源與目的可重疊），取 L 最大者；L 相同時取距離 d=i-j 最小者。若最大 L≥3 就輸出 <L,d> 並前進 L；否則輸出該字元並前進 1。所有記號以單一空白分隔、一行輸出。',
    'def main():\n    s = input().strip()\n    out = []\n    i = 0\n    while i < len(s):\n        bl, bd = 0, 0\n        for j in range(max(0, i - 16), i):\n            L = 0\n            while i + L < len(s) and s[j + L] == s[i + L]:\n                L += 1\n            if L > bl or (L == bl and L > 0 and i - j < bd):\n                bl, bd = L, i - j\n        if bl >= 3:\n            out.append("<%d,%d>" % (bl, bd))\n            i += bl\n        else:\n            out.append(s[i])\n            i += 1\n    print(" ".join(out))\n',
    gen_lz, ['gzip', 'lz77', 'window', 'string'], hold=True)


def gen_lzd(i):
    return ' '.join(lz77(gen_lz(i).strip())) + '\n'


add('lx-lz77-decode', 'DEFLATE：LZ77 解碼', 'LX1', '輸入一行以空白分隔的記號：單一小寫字母代表一個字面字元；<L,d> 表示「從目前輸出末端往回 d 個字元的位置開始複製 L 個字元」（逐字元複製，來源可與新寫入的部分重疊）。輸出還原的字串。',
    'def main():\n    out = []\n    for t in input().split():\n        if t.startswith("<"):\n            L, d = t[1:-1].split(",")\n            L = int(L)\n            d = int(d)\n            for _ in range(L):\n                out.append(out[-d])\n        else:\n            out.append(t)\n    print("".join(out))\n',
    gen_lzd, ['gzip', 'lz77', 'copy'])


def huff_cost(fr):
    import heapq
    h = list(fr); heapq.heapify(h); c = 0
    if len(h) == 1: return h[0]
    while len(h) > 1:
        a = heapq.heappop(h); b = heapq.heappop(h); c += a + b; heapq.heappush(h, a + b)
    return c


add('lx-huffman-cost', 'DEFLATE：霍夫曼編碼總位元數', 'LX1', '第一行 k（2≤k≤12），第二行 k 個正整數（各符號出現次數）。建立最佳霍夫曼編碼（每次合併最小的兩個權重），輸出編碼後的總位元數 = 各符號 次數×碼長 的總和（等於所有合併產生的權重之和）。',
    'def main():\n    k = int(input())\n    w = list(map(int, input().split()))\n    total = 0\n    while len(w) > 1:\n        w.sort()\n        a = w.pop(0)\n        b = w.pop(0)\n        total += a + b\n        w.append(a + b)\n    print(total)\n',
    lambda i: (lambda k: '%d\n%s\n' % (k, ' '.join(str(random.randint(1, 50)) for _ in range(k))))(random.randint(2, 12)), ['gzip', 'huffman', 'heap', 'greedy'])


def gen_canon(i):
    # 合法（Kraft = 1 的不完全也可）碼長：由隨機霍夫曼樹得到
    while True:
        k = random.randint(2, 8)
        import heapq
        h = [(random.randint(1, 20), [s]) for s in range(k)]; heapq.heapify(h); ln = [0] * k
        while len(h) > 1:
            a = heapq.heappop(h); b = heapq.heappop(h)
            for s in a[1] + b[1]: ln[s] += 1
            heapq.heappush(h, (a[0] + b[0], a[1] + b[1]))
        if max(ln) <= 7:
            for s in random.sample(range(k), random.randint(0, 1)): pass
            return '%d\n%s\n' % (k, ' '.join(map(str, ln)))


add('lx-canonical-huffman', 'DEFLATE：範式（canonical）霍夫曼碼', 'LX2', '第一行 k，第二行 k 個碼長 len[0..k-1]（0 表示該符號不使用）。依 RFC 1951 產生範式碼：bl_count[L]＝碼長為 L 的符號數（L≥1）；next_code[1]=0，next_code[L]=(next_code[L-1]+bl_count[L-1])*2；再依符號編號由小到大，碼長非 0 者取 code=next_code[len]++。對每個使用中的符號輸出一行「符號編號 碼（二進位字串，補零到 len 位）」。',
    'def main():\n    k = int(input())\n    ln = list(map(int, input().split()))\n    mx = max(ln)\n    cnt = [0] * (mx + 2)\n    for L in ln:\n        if L:\n            cnt[L] += 1\n    nxt = [0] * (mx + 2)\n    code = 0\n    for L in range(1, mx + 1):\n        code = (code + cnt[L - 1]) * 2 if L > 1 else 0\n        nxt[L] = code\n    for s in range(k):\n        L = ln[s]\n        if L:\n            c = nxt[L]\n            nxt[L] += 1\n            bits = ""\n            for b in range(L - 1, -1, -1):\n                bits += str((c >> b) & 1)\n            print(s, bits)\n',
    gen_canon, ['gzip', 'huffman', 'canonical', 'bitops'], hold=True)


def gen_bitr(i):
    data = rbytes(2, 6); ws = []; tot = 0
    while True:
        w = random.randint(1, 9)
        if tot + w > len(data) * 8: break
        ws.append(w); tot += w
    return hx(data) + '\n' + ' '.join(map(str, ws)) + '\n'


add('lx-bit-reader', 'DEFLATE：位元讀取器（低位元優先）', 'LX1', '第一行是十六進位位元組資料，第二行是一串寬度 w1 w2 …（1～9）。DEFLATE 位元序：位元組依序讀取，每個位元組由最低位元（bit 0）先讀；多位元欄位以先讀到的位元為低位。依序讀出每個欄位的整數值，輸出一行、以空白分隔。',
    'def main():\n    h = input().strip()\n    data = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    widths = list(map(int, input().split()))\n    pos = 0\n    out = []\n    for w in widths:\n        v = 0\n        for b in range(w):\n            bit = (data[pos >> 3] >> (pos & 7)) & 1\n            v |= bit << b\n            pos += 1\n        out.append(str(v))\n    print(" ".join(out))\n',
    gen_bitr, ['gzip', 'bitstream', 'bitops'])
add('lx-deflate-stored', 'DEFLATE：stored 區塊', 'LX1', '輸入一行只含小寫字母的文字（長度 1～30）。輸出 DEFLATE「未壓縮區塊」的十六進位：第 1 個位元組 01（BFINAL=1、BTYPE=00），接著 LEN（2 位元組小端序）、NLEN＝LEN 取補數（2 位元組小端序，即 0xFFFF-LEN），最後是資料位元組。全部小寫、相連。',
    'def main():\n    s = input().strip()\n    n = len(s)\n    nn = 0xFFFF - n\n    out = [1, n & 255, n >> 8, nn & 255, nn >> 8] + [ord(c) for c in s]\n    print("".join("%02x" % b for b in out))\n',
    lambda i: rtext(1, 30, LOW) + '\n', ['gzip', 'deflate', 'struct', 'endian'])


def gz_member(data):
    c = crc32_ref(data); n = len(data)
    body = bytes([1, n & 255, n >> 8, (0xFFFF - n) & 255, (0xFFFF - n) >> 8]) + data
    return bytes([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]) + body + struct.pack('<II', c, n)


_g = gz_member(b'hello'); import gzip as _gz; assert _gz.decompress(_g) == b'hello'
add('lx-gzip-member', 'gzip：組出完整 .gz（stored 區塊）', 'LX2', '輸入一行小寫字母文字 s（1～30 字元）。輸出一個 gzip 成員的十六進位（小寫、相連）：標頭 10 位元組 1f 8b 08 00 00000000 00 03（無檔名、mtime=0、XFL=0、OS=3）；接著 DEFLATE 未壓縮區塊（01、LEN 小端 2 位元組、NLEN 小端 2 位元組、資料）；最後 8 位元組尾端：資料的 CRC-32（4 位元組小端）與資料長度 ISIZE（4 位元組小端）。CRC-32：初值 0xFFFFFFFF、多項式 0xEDB88320 反射版、最後與 0xFFFFFFFF 互斥或。',
    'def crc32(s):\n    c = 0xFFFFFFFF\n    for ch in s:\n        c ^= ord(ch)\n        for _ in range(8):\n            c = (c >> 1) ^ 0xEDB88320 if c & 1 else c >> 1\n    return c ^ 0xFFFFFFFF\n\n\ndef le(v, n):\n    return [(v >> (8 * i)) & 255 for i in range(n)]\n\n\ndef main():\n    s = input().strip()\n    n = len(s)\n    out = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]\n    out += [1] + le(n, 2) + le(0xFFFF - n, 2) + [ord(c) for c in s]\n    out += le(crc32(s), 4) + le(n, 4)\n    print("".join("%02x" % b for b in out))\n',
    lambda i: rtext(1, 30, LOW) + '\n', ['gzip', 'struct', 'crc', 'endian', 'binary-write'], hold=True)


def gen_gunz(i):
    d = rtext(1, 20, LOW).encode(); g = bytearray(gz_member(d))
    if random.random() < .35: g[-6] ^= 0x01
    return g.hex() + '\n'


add('lx-gunzip-stored', 'gunzip：解析 .gz（stored）並驗證 CRC', 'LX2', '輸入一行十六進位，是一個 gzip 成員：10 位元組標頭（旗標 0，無額外欄位），一個未壓縮 DEFLATE 區塊（1 位元組 01、LEN 與 NLEN 各 2 位元組小端、資料），8 位元組尾端（CRC-32 小端 4 位元組、ISIZE 小端 4 位元組）。若 CRC-32（初值 0xFFFFFFFF、多項式 0xEDB88320 反射版、最後取反）與尾端相符則輸出解出的 ASCII 文字，否則輸出 CRC ERROR。',
    'def main():\n    h = input().strip()\n    d = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    n = d[11] | (d[12] << 8)\n    data = d[15:15 + n]\n    tail = d[15 + n:15 + n + 8]\n    want = tail[0] | (tail[1] << 8) | (tail[2] << 16) | (tail[3] << 24)\n    c = 0xFFFFFFFF\n    for x in data:\n        c ^= x\n        for _ in range(8):\n            c = (c >> 1) ^ 0xEDB88320 if c & 1 else c >> 1\n    c ^= 0xFFFFFFFF\n    if c == want:\n        print("".join(chr(x) for x in data))\n    else:\n        print("CRC ERROR")\n',
    gen_gunz, ['gzip', 'parser', 'crc', 'binary-read'])

# 固定霍夫曼 DEFLATE
LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]


class BW:
    def __init__(s): s.bits = []
    def lsb(s, v, n): s.bits += [(v >> k) & 1 for k in range(n)]
    def msb(s, v, n): s.bits += [(v >> k) & 1 for k in range(n - 1, -1, -1)]
    def bytes(s):
        b = s.bits + [0] * (-len(s.bits) % 8)
        return bytes(sum(b[i + k] << k for k in range(8)) for i in range(0, len(b), 8))


def fixed_sym(w, sym):
    if sym < 144: w.msb(0x30 + sym, 8)
    elif sym < 256: w.msb(0x190 + sym - 144, 9)
    elif sym < 280: w.msb(sym - 256, 7)
    else: w.msb(0xC0 + sym - 280, 8)


def fixed_deflate(s):
    w = BW(); w.lsb(1, 1); w.lsb(1, 2)
    for t in lz77(s):
        if t.startswith('<'):
            L, d = map(int, t[1:-1].split(','))
            li = max(k for k in range(29) if LBASE[k] <= L)
            if L == 258: li = 28
            fixed_sym(w, 257 + li); w.lsb(L - LBASE[li], LEXT[li])
            di = max(k for k in range(30) if DBASE[k] <= d)
            w.msb(di, 5); w.lsb(d - DBASE[di], DEXT[di])
        else: fixed_sym(w, ord(t))
    fixed_sym(w, 256)
    return w.bytes()


for _ in range(30):
    _s = gen_lz(0).strip(); assert zlib.decompress(fixed_deflate(_s), -15) == _s.encode()
add('lx-inflate-fixed', 'gzip：解壓固定霍夫曼區塊（inflate）', 'LX2',
    '輸入一行十六進位，是一個「固定霍夫曼」DEFLATE 區塊（BFINAL=1、BTYPE=01）。位元序：位元組內由低位元先讀；標頭欄位與額外位元以先讀到的位元為低位；霍夫曼碼則由高位元先讀（碼的第一個位元是最高位）。固定碼：符號 0–143 為 8 位 00110000～10111111；144–255 為 9 位 110010000～111111111；256–279 為 7 位 0000000～0010111；280–287 為 8 位 11000000～11000111。符號 <256 輸出該字元；256 結束；257–285 為長度碼，長度基值＝[3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258]、額外位元數＝[0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0]；接著 5 位（高位先讀）的距離碼，距離基值＝[1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577]、額外位元數＝[0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13]（額外位元低位先讀）。輸出解出的字串。',
    'LB = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]\nLE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]\nDB = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]\nDE = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]\n\n\ndef main():\n    h = input().strip()\n    data = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    pos = [0]\n\n    def bit():\n        b = (data[pos[0] >> 3] >> (pos[0] & 7)) & 1\n        pos[0] += 1\n        return b\n\n    def lsb(n):\n        v = 0\n        for k in range(n):\n            v |= bit() << k\n        return v\n\n    def msb(n):\n        v = 0\n        for _ in range(n):\n            v = (v << 1) | bit()\n        return v\n\n    def sym():\n        v = msb(7)\n        if v <= 23:\n            return v + 256\n        v = (v << 1) | bit()\n        if 48 <= v <= 191:\n            return v - 48\n        if 192 <= v <= 199:\n            return v - 192 + 280\n        v = (v << 1) | bit()\n        return v - 400 + 144\n\n    lsb(3)\n    out = []\n    while True:\n        s = sym()\n        if s == 256:\n            break\n        if s < 256:\n            out.append(chr(s))\n        else:\n            i = s - 257\n            L = LB[i] + lsb(LE[i])\n            j = msb(5)\n            d = DB[j] + lsb(DE[j])\n            for _ in range(L):\n                out.append(out[-d])\n    print("".join(out))\n',
    lambda i: fixed_deflate(gen_lz(i).strip()).hex() + '\n', ['gzip', 'inflate', 'huffman', 'bitstream', 'lz77', 'binary-read'], nhidden=6)

# ───────────────────────── xz / LZMA ─────────────────────────
def varint_enc(v):
    o = []
    while True:
        b = v & 0x7F; v >>= 7
        if v: o.append(b | 0x80)
        else: o.append(b); return bytes(o)


add('lx-xz-varint-dec', 'xz：多位元組整數解碼', 'LX1', '第一行是十六進位位元組串，其中依序連續放著若干個 xz 的「多位元組整數」：每個位元組低 7 位是資料、最高位是 1 表示後面還有位元組；低位在前（第一個位元組是最低 7 位）。輸出解出的所有整數，以空白分隔、一行。',
    'def main():\n    h = input().strip()\n    data = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    out = []\n    v = 0\n    sh = 0\n    for b in data:\n        v |= (b & 0x7F) << sh\n        sh += 7\n        if not b & 0x80:\n            out.append(str(v))\n            v = 0\n            sh = 0\n    print(" ".join(out))\n',
    lambda i: b''.join(varint_enc(random.choice([random.randint(0, 127), random.randint(0, 20000), random.randint(0, 10**9)])) for _ in range(random.randint(1, 5))).hex() + '\n', ['xz', 'varint', 'bitops', 'binary-read'])
add('lx-xz-varint-enc', 'xz：多位元組整數編碼', 'LX0', '輸入一行若干個非負整數（以空白分隔）。把每個整數編成 xz 多位元組整數：每次取低 7 位，若還有剩餘高位就把最高位設 1 再輸出；低位在前。輸出全部位元組的十六進位（小寫、相連、一行）。',
    'def main():\n    out = ""\n    for t in input().split():\n        v = int(t)\n        while True:\n            b = v & 0x7F\n            v >>= 7\n            if v:\n                out += "%02x" % (b | 0x80)\n            else:\n                out += "%02x" % b\n                break\n    print(out)\n',
    lambda i: ' '.join(str(random.choice([random.randint(0, 127), random.randint(0, 20000), random.randint(0, 10**9)])) for _ in range(random.randint(1, 5))) + '\n', ['xz', 'varint', 'bitops'], hold=True)


def gen_xzh(i):
    flags = random.choice([b'\x00\x01', b'\x00\x04', b'\x00\x0a', b'\x00\x00'])
    c = zlib.crc32(flags)
    h = b'\xfd7zXZ\x00' + flags + struct.pack('<I', c)
    h = bytearray(h)
    r = random.random()
    if r < .25: h[random.choice([0, 3])] ^= 0x10
    elif r < .45: h[9] ^= 0x01
    return h.hex() + '\n'


add('lx-xz-header', 'xz：串流標頭驗證', 'LX2', '輸入一行十六進位，是 xz 串流標頭的 12 位元組：6 位元組魔術數字 fd 37 7a 58 5a 00、2 位元組串流旗標（第二個位元組的低 4 位是完整性檢查類型：0=None、1=CRC32、4=CRC64、10=SHA-256）、4 位元組旗標的 CRC-32（小端；CRC-32 初值 0xFFFFFFFF、多項式 0xEDB88320 反射版、最後取反，僅對那 2 位元組旗標計算）。若魔術數字正確且 CRC 相符，輸出 OK 與檢查類型名稱（格式「OK CRC32」、「OK None」、「OK CRC64」、「OK SHA-256」，其他類型值輸出「OK type=值」）；魔術數字錯輸出 BAD MAGIC；魔術對但 CRC 不符輸出 BAD CRC。',
    'def main():\n    h = input().strip()\n    d = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    if d[:6] != [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]:\n        print("BAD MAGIC")\n        return\n    c = 0xFFFFFFFF\n    for x in d[6:8]:\n        c ^= x\n        for _ in range(8):\n            c = (c >> 1) ^ 0xEDB88320 if c & 1 else c >> 1\n    c ^= 0xFFFFFFFF\n    want = d[8] | (d[9] << 8) | (d[10] << 16) | (d[11] << 24)\n    if c != want:\n        print("BAD CRC")\n        return\n    t = d[7] & 15\n    names = {0: "None", 1: "CRC32", 4: "CRC64", 10: "SHA-256"}\n    print("OK " + names[t] if t in names else "OK type=%d" % t)\n',
    gen_xzh, ['xz', 'parser', 'crc', 'binary-read'], hold=True)


def gen_delta(i):
    dist = random.randint(1, 4); n = random.randint(dist + 1, 12)
    return '%d\n%s\n' % (dist, ' '.join(str(random.randint(0, 255)) for _ in range(n)))


add('lx-xz-delta', 'xz：Delta 過濾器還原', 'LX1', '第一行是距離 d（1～4），第二行是一串 0～255 的位元組值（編碼後的）。Delta 解碼：第 i 個輸出 = (第 i 個輸入 + 第 i-d 個「輸出」) mod 256（i<d 時沒有前項，輸出等於輸入）。輸出一行，以空白分隔。',
    'def main():\n    d = int(input())\n    a = list(map(int, input().split()))\n    out = []\n    for i, x in enumerate(a):\n        if i >= d:\n            x = (x + out[i - d]) % 256\n        out.append(x)\n    print(" ".join(map(str, out)))\n',
    gen_delta, ['xz', 'filter', 'mod', 'array'])


class RCEnc:
    def __init__(s): s.low = 0; s.range = 0xFFFFFFFF; s.cache = 0; s.cs = 1; s.out = bytearray()
    def shift(s):
        if (s.low & 0xFFFFFFFF) < 0xFF000000 or (s.low >> 32):
            t = s.cache
            while True:
                s.out.append((t + (s.low >> 32)) & 0xFF); t = 0xFF; s.cs -= 1
                if s.cs == 0: break
            s.cache = (s.low >> 24) & 0xFF
        s.cs += 1; s.low = (s.low & 0x00FFFFFF) << 8
    def bit(s, probs, i, b):
        bound = (s.range >> 11) * probs[i]
        if b == 0: s.range = bound; probs[i] += (2048 - probs[i]) >> 5
        else: s.low += bound; s.range -= bound; probs[i] -= probs[i] >> 5
        while s.range < (1 << 24): s.range = (s.range << 8) & 0xFFFFFFFF; s.shift()
    def flush(s):
        for _ in range(5): s.shift()
        return bytes(s.out)


def gen_rcb(i):
    n = random.randint(5, 60); p1 = random.choice([.1, .5, .9])
    bits = [1 if random.random() < p1 else 0 for _ in range(n)]
    e = RCEnc(); pr = [1024]
    for b in bits: e.bit(pr, 0, b)
    return '%d\n%s\n' % (n, e.flush().hex()), ''.join(map(str, bits))


RC_DEC = 'def main():\n    n = int(input())\n    h = input().strip()\n    d = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    code = (d[1] << 24) | (d[2] << 16) | (d[3] << 8) | d[4]\n    pos = 5\n    rng = 0xFFFFFFFF\n    p = 1024\n    out = ""\n    for _ in range(n):\n        bound = (rng >> 11) * p\n        if code < bound:\n            rng = bound\n            p += (2048 - p) >> 5\n            out += "0"\n        else:\n            code -= bound\n            rng -= bound\n            p -= p >> 5\n            out += "1"\n        if rng < (1 << 24):\n            rng = (rng << 8) & 0xFFFFFFFF\n            code = ((code << 8) | d[pos]) & 0xFFFFFFFF\n            pos += 1\n    print(out)\n'
_cache = {}


def rcb_gen(i):
    inp, exp = gen_rcb(i); assert run(RC_DEC, inp).strip() == exp; return inp


add('lx-lzma-rc-bits', 'xz／LZMA：自適應二元範圍解碼器', 'LX2', '第一行 n，第二行是十六進位的範圍編碼資料（LZMA 範圍編碼器輸出，共 5 位元組以上）。解碼 n 個位元，模型是單一自適應機率 p（11 位元，初值 1024，表示位元為 0 的機率 p/2048）。初始化：忽略第 1 個位元組；code＝接下來 4 個位元組（大端）組成的 32 位元整數；range＝0xFFFFFFFF；下一個要讀的位元組是第 6 個。每解一個位元：bound＝(range>>11)*p；若 code<bound：range=bound、p+=(2048-p)>>5、輸出 0；否則 code-=bound、range-=bound、p-=p>>5、輸出 1。之後若 range<2^24：range=(range<<8)&0xFFFFFFFF、code=((code<<8)|下一個位元組)&0xFFFFFFFF。輸出解出的 n 個位元字串。',
    RC_DEC, rcb_gen, ['xz', 'lzma', 'range-coder', 'bitops', 'binary-read'], hold=True, nhidden=6)


def gen_rcl(i):
    s = rtext(2, 16, 'abcde ')
    s = s.strip() or 'ab'
    e = RCEnc(); pr = [1024] * 256
    for ch in s.encode():
        m = 1
        for k in range(7, -1, -1):
            b = (ch >> k) & 1; e.bit(pr, m, b); m = (m << 1) | b
    return '%d\n%s\n' % (len(s), e.flush().hex()), s


RC_LIT = 'def main():\n    n = int(input())\n    h = input().strip()\n    d = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    code = (d[1] << 24) | (d[2] << 16) | (d[3] << 8) | d[4]\n    pos = 5\n    rng = 0xFFFFFFFF\n    probs = [1024] * 256\n    out = ""\n    for _ in range(n):\n        m = 1\n        for _ in range(8):\n            bound = (rng >> 11) * probs[m]\n            if code < bound:\n                rng = bound\n                probs[m] += (2048 - probs[m]) >> 5\n                m = m * 2\n            else:\n                code -= bound\n                rng -= bound\n                probs[m] -= probs[m] >> 5\n                m = m * 2 + 1\n            if rng < (1 << 24):\n                rng = (rng << 8) & 0xFFFFFFFF\n                code = ((code << 8) | d[pos]) & 0xFFFFFFFF\n                pos += 1\n        out += chr(m - 256)\n    print(out)\n'


def rcl_gen(i):
    inp, exp = gen_rcl(i); assert run(RC_LIT, inp).strip() == exp.strip(), (inp, exp); return inp


add('lx-lzma-literals', 'xz／LZMA：位元樹字面量解碼', 'LX2', '第一行 n，第二行是十六進位的 LZMA 範圍編碼資料。模型是 256 個自適應機率 probs[1..255]（11 位元，初值 1024，表示該節點位元為 0 的機率 /2048，probs[0] 不用）。初始化：忽略第 1 個位元組；code＝接下來 4 個位元組（大端）；range＝0xFFFFFFFF；下一個位元組是第 6 個。解一個位元組：m=1，重複 8 次：bound＝(range>>11)*probs[m]；若 code<bound：range=bound、probs[m]+=(2048-probs[m])>>5、位元=0；否則 code-=bound、range-=bound、probs[m]-=probs[m]>>5、位元=1；然後 m=m*2+位元；若 range<2^24：range=(range<<8)&0xFFFFFFFF、code=((code<<8)|下一個位元組)&0xFFFFFFFF。8 次後位元組＝m-256。輸出解出的 n 個字元（ASCII）。',
    RC_LIT, rcl_gen, ['xz', 'lzma', 'range-coder', 'bit-tree', 'binary-read'], nhidden=6)

# ───────────────────────── BMP ─────────────────────────
def stride(w, bpp): return (w * bpp + 31) // 32 * 4


def bmp24(rows, topdown=False):
    h = len(rows); w = len(rows[0]); st = stride(w, 24)
    px = b''
    for r in (rows if topdown else rows[::-1]):
        row = b''.join(bytes([c[2], c[1], c[0]]) for c in r)
        px += row + b'\0' * (st - len(row))
    off = 54
    return b'BM' + struct.pack('<IHHI', off + len(px), 0, 0, off) + struct.pack('<IiiHHIIiiII', 40, w, -h if topdown else h, 1, 24, 0, len(px), 2835, 2835, 0, 0) + px


def bmp8(rows, pal, bpp=8):
    h = len(rows); w = len(rows[0]); st = stride(w, bpp); px = b''
    for r in rows[::-1]:
        if bpp == 8: row = bytes(r)
        else:
            row = bytearray((w + 7) // 8)
            for x, v in enumerate(r): row[x // 8] |= v << (7 - x % 8)
            row = bytes(row)
        px += row + b'\0' * (st - len(row))
    pb = b''.join(bytes([c[2], c[1], c[0], 0]) for c in pal); off = 54 + len(pb)
    return b'BM' + struct.pack('<IHHI', off + len(px), 0, 0, off) + struct.pack('<IiiHHIIiiII', 40, w, h, 1, bpp, 0, len(px), 2835, 2835, len(pal), 0) + pb + px


def rrows(w, h): return [[tuple(random.randint(0, 255) for _ in range(3)) for _ in range(w)] for _ in range(h)]


def gen_bhead(i):
    w, h = random.randint(1, 9), random.randint(1, 6)
    r = random.random()
    if r < .4: return bmp24(rrows(w, h), topdown=random.random() < .3).hex() + '\n'
    if r < .7:
        pal = [tuple(random.randint(0, 255) for _ in range(3)) for _ in range(random.choice([2, 16, 256]))]
        return bmp8([[random.randrange(len(pal)) for _ in range(w)] for _ in range(h)], pal[:256] if len(pal) != 2 else pal).hex() + '\n'
    pal = [(0, 0, 0), (255, 255, 255)]
    return bmp8([[random.randint(0, 1) for _ in range(w)] for _ in range(h)], pal, 1).hex() + '\n'


add('lx-bmp-header', 'BMP：解析檔頭', 'LX1', '輸入一行十六進位，是一個 BMP 檔（BITMAPINFOHEADER 版）。小端序欄位位移：0–1 魔術 "BM"、2–5 檔案大小、10–13 像素資料位移、18–21 寬度（int32）、22–25 高度（int32，負數表示列由上到下儲存）、28–29 每像素位元數。輸出五行：width=W、height=H（取絕對值）、bpp=B、offset=O、order=bottom-up 或 top-down（高度為負才是 top-down）。',
    'def le(d, p, n, signed=False):\n    v = 0\n    for i in range(n):\n        v |= d[p + i] << (8 * i)\n    if signed and v >= 1 << (8 * n - 1):\n        v -= 1 << (8 * n)\n    return v\n\n\ndef main():\n    h = input().strip()\n    d = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    w = le(d, 18, 4, True)\n    ht = le(d, 22, 4, True)\n    print("width=%d" % w)\n    print("height=%d" % abs(ht))\n    print("bpp=%d" % le(d, 28, 2))\n    print("offset=%d" % le(d, 10, 4))\n    print("order=" + ("top-down" if ht < 0 else "bottom-up"))\n',
    gen_bhead, ['bmp', 'struct', 'endian', 'binary-read'])
add('lx-bmp-stride', 'BMP：列對齊（padding）', 'LX0', '輸入一行「寬度 位元深度」（位元深度為 1、4、8、24、32）。BMP 每一列的位元組數要補到 4 的倍數：stride ＝ ceil(寬度×位元深度/32)×4。輸出兩行：stride 以及每列尾端的填充位元組數（stride 減去 ceil(寬度×位元深度/8)）。',
    'def main():\n    w, b = map(int, input().split())\n    stride = (w * b + 31) // 32 * 4\n    raw = (w * b + 7) // 8\n    print(stride)\n    print(stride - raw)\n',
    lambda i: '%d %d\n' % (random.randint(1, 50), random.choice([1, 4, 8, 24, 32])), ['bmp', 'padding', 'arith'], hold=True)


def gen_bpix(i):
    w, h = random.randint(1, 7), random.randint(1, 6); td = random.random() < .3
    b = bmp24(rrows(w, h), topdown=td)
    return '%s\n%d\n' % (b.hex(), 3) + '\n'.join('%d %d' % (random.randrange(w), random.randrange(h)) for _ in range(3)) + '\n'


add('lx-bmp-pixel', 'BMP：取指定像素（24 位元，含列序）', 'LX2', '第一行是一個 24 位元 BMP 檔的十六進位（檔頭 54 位元組；像素資料位移在位元組 10–13、寬度在 18–21、高度 int32 在 22–25，小端；高度為正表示列由下到上儲存，為負表示由上到下；每個像素 3 位元組，順序是 B、G、R；每列補 0 到 4 的倍數）。第二行 q，接著 q 行「x y」（以左上角為原點、y 向下）。每個查詢輸出該像素的 R G B（十進位，空白分隔）。',
    'def le(d, p, n, signed=False):\n    v = 0\n    for i in range(n):\n        v |= d[p + i] << (8 * i)\n    if signed and v >= 1 << (8 * n - 1):\n        v -= 1 << (8 * n)\n    return v\n\n\ndef main():\n    h = input().strip()\n    d = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    off = le(d, 10, 4)\n    w = le(d, 18, 4, True)\n    ht = le(d, 22, 4, True)\n    stride = (w * 24 + 31) // 32 * 4\n    q = int(input())\n    for _ in range(q):\n        x, y = map(int, input().split())\n        row = y if ht < 0 else abs(ht) - 1 - y\n        p = off + row * stride + x * 3\n        print(d[p + 2], d[p + 1], d[p])\n',
    gen_bpix, ['bmp', 'struct', 'row-order', 'binary-read'], hold=True)


def gen_bw24(i):
    w, h = random.randint(1, 5), random.randint(1, 4); rows = rrows(w, h)
    return '%d %d\n' % (w, h) + '\n'.join(' '.join('%02x%02x%02x' % c for c in r) for r in rows) + '\n'


def bw24_check(inp):
    L = inp.split('\n'); w, h = map(int, L[0].split()); rows = [[tuple(int(t[k:k + 2], 16) for k in (0, 2, 4)) for t in L[1 + y].split()] for y in range(h)]
    return bmp24(rows).hex()


add('lx-bmp-write24', 'BMP：寫出 24 位元檔', 'LX2', '第一行「寬 高」，接著 高 行，每行 寬 個像素（由上到下、由左到右），像素是 6 位十六進位 RRGGBB。組出 24 位元無壓縮 BMP：檔頭 14 位元組（"BM"、檔案大小 4 位元組、保留 4 個 0、像素資料位移 54 為 4 位元組，小端）＋資訊頭 40 位元組（40、寬 int32、高 int32（正數）、平面數 1 為 2 位元組、位元深度 24 為 2 位元組、壓縮 0、影像大小（含填充）、水平／垂直解析度皆 2835、色彩數 0、重要色彩數 0，皆 4 位元組小端）。像素資料「由下往上」列序，每像素 B、G、R 順序，每列補 0 到 4 的倍數。輸出整個檔案的十六進位（小寫、相連、一行）。',
    'def le(v, n):\n    return [(v >> (8 * i)) & 255 for i in range(n)]\n\n\ndef main():\n    w, h = map(int, input().split())\n    rows = [input().split() for _ in range(h)]\n    stride = (w * 24 + 31) // 32 * 4\n    px = []\n    for r in rows[::-1]:\n        line = []\n        for t in r:\n            line += [int(t[4:6], 16), int(t[2:4], 16), int(t[0:2], 16)]\n        line += [0] * (stride - len(line))\n        px += line\n    out = [0x42, 0x4D] + le(54 + len(px), 4) + [0] * 4 + le(54, 4)\n    out += le(40, 4) + le(w, 4) + le(h, 4) + le(1, 2) + le(24, 2) + le(0, 4) + le(len(px), 4) + le(2835, 4) + le(2835, 4) + le(0, 4) + le(0, 4)\n    out += px\n    print("".join("%02x" % b for b in out))\n',
    gen_bw24, ['bmp', 'struct', 'binary-write', 'endian', 'padding'], nhidden=6)
_c = gen_bw24(0); assert run(B.P[-1]['ref']['python'], _c).strip() == bw24_check(_c)


def gen_bw8(i):
    w, h = random.randint(1, 6), random.randint(1, 4); k = random.randint(2, 5)
    pal = ['%02x%02x%02x' % tuple(random.randint(0, 255) for _ in range(3)) for _ in range(k)]
    return '%d %d %d\n%s\n' % (w, h, k, ' '.join(pal)) + '\n'.join(' '.join(str(random.randrange(k)) for _ in range(w)) for _ in range(h)) + '\n'


def bw8_check(inp):
    L = inp.split('\n'); w, h, k = map(int, L[0].split()); pal = [tuple(int(t[j:j + 2], 16) for j in (0, 2, 4)) for t in L[1].split()]
    rows = [list(map(int, L[2 + y].split())) for y in range(h)]
    return bmp8(rows, pal).hex()


add('lx-bmp-write8', 'BMP：寫出 8 位元調色盤檔', 'LX2', '第一行「寬 高 k」，第二行 k 個調色盤顏色 RRGGBB（十六進位），接著 高 行，每行 寬 個調色盤索引（由上到下、由左到右）。組出 8 位元 BMP：檔頭 14 位元組（"BM"、檔案大小、4 個 0、像素資料位移＝54+4k）、資訊頭 40 位元組（40、寬、高（正）、平面數 1 為 2 位元組、位元深度 8 為 2 位元組、壓縮 0、影像大小（含填充）、2835、2835、色彩數 k、重要色彩數 0）、調色盤每色 4 位元組 B G R 0、像素資料「由下往上」列序、每列補 0 到 4 的倍數。除標明 2 位元組者外皆為 4 位元組小端。輸出整個檔案的十六進位（小寫、相連、一行）。',
    'def le(v, n):\n    return [(v >> (8 * i)) & 255 for i in range(n)]\n\n\ndef main():\n    w, h, k = map(int, input().split())\n    pal = input().split()\n    rows = [list(map(int, input().split())) for _ in range(h)]\n    stride = (w + 3) // 4 * 4\n    px = []\n    for r in rows[::-1]:\n        px += r + [0] * (stride - w)\n    off = 54 + 4 * k\n    out = [0x42, 0x4D] + le(off + len(px), 4) + [0] * 4 + le(off, 4)\n    out += le(40, 4) + le(w, 4) + le(h, 4) + le(1, 2) + le(8, 2) + le(0, 4) + le(len(px), 4) + le(2835, 4) + le(2835, 4) + le(k, 4) + le(0, 4)\n    for t in pal:\n        out += [int(t[4:6], 16), int(t[2:4], 16), int(t[0:2], 16), 0]\n    out += px\n    print("".join("%02x" % b for b in out))\n',
    gen_bw8, ['bmp', 'struct', 'binary-write', 'palette', 'padding'], hold=True, nhidden=6)
_c = gen_bw8(0); assert run(B.P[-1]['ref']['python'], _c).strip() == bw8_check(_c)


def gen_bp8(i):
    w, h = random.randint(1, 6), random.randint(1, 4); k = random.randint(2, 6)
    pal = [tuple(random.randint(0, 255) for _ in range(3)) for _ in range(k)]
    return bmp8([[random.randrange(k) for _ in range(w)] for _ in range(h)], pal).hex() + '\n'


add('lx-bmp-read8', 'BMP：讀 8 位元調色盤檔', 'LX2', '輸入一行十六進位，是一個 8 位元 BMP（高度為正、列由下到上；像素資料位移在位元組 10–13；寬度 18–21、高度 22–25、色彩數 46–49；調色盤從位元組 54 起每色 4 位元組 B G R 保留；每列像素索引補到 4 的倍數）。依「由上到下」的列序輸出影像：每列一行，每個像素輸出其調色盤顏色 RRGGBB（小寫十六進位），像素之間以空白分隔。',
    'def le(d, p, n):\n    v = 0\n    for i in range(n):\n        v |= d[p + i] << (8 * i)\n    return v\n\n\ndef main():\n    h = input().strip()\n    d = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    off = le(d, 10, 4)\n    w = le(d, 18, 4)\n    ht = le(d, 22, 4)\n    k = le(d, 46, 4)\n    pal = []\n    for i in range(k):\n        p = 54 + 4 * i\n        pal.append("%02x%02x%02x" % (d[p + 2], d[p + 1], d[p]))\n    stride = (w + 3) // 4 * 4\n    for y in range(ht):\n        row = ht - 1 - y\n        print(" ".join(pal[d[off + row * stride + x]] for x in range(w)))\n',
    gen_bp8, ['bmp', 'palette', 'binary-read', 'row-order'])


def gen_b1(i):
    w, h = random.randint(1, 20), random.randint(1, 4)
    return bmp8([[random.randint(0, 1) for _ in range(w)] for _ in range(h)], [(0, 0, 0), (255, 255, 255)], 1).hex() + '\n'


add('lx-bmp-read1', 'BMP：讀 1 位元（單色）檔', 'LX2', '輸入一行十六進位，是一個 1 位元 BMP（高度為正、列由下到上；像素資料位移在位元組 10–13；寬度 18–21、高度 22–25；調色盤 2 色；每個位元組含 8 個像素，最高位元是最左邊的像素；每列補到 4 位元組的倍數）。依「由上到下」輸出每列一行，每個像素輸出其調色盤索引（0 或 1），像素之間不加分隔。',
    'def le(d, p, n):\n    v = 0\n    for i in range(n):\n        v |= d[p + i] << (8 * i)\n    return v\n\n\ndef main():\n    h = input().strip()\n    d = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    off = le(d, 10, 4)\n    w = le(d, 18, 4)\n    ht = le(d, 22, 4)\n    stride = (w + 31) // 32 * 4\n    for y in range(ht):\n        row = ht - 1 - y\n        s = ""\n        for x in range(w):\n            byte = d[off + row * stride + x // 8]\n            s += str((byte >> (7 - x % 8)) & 1)\n        print(s)\n',
    gen_b1, ['bmp', 'bitops', 'binary-read', 'padding'], hold=True)


def gen_bgray(i):
    w, h = random.randint(1, 5), random.randint(1, 4); return bmp24(rrows(w, h)).hex() + '\n'


add('lx-bmp-gray', 'BMP：轉灰階', 'LX2', '輸入一行十六進位，是一個 24 位元 BMP（高度為正、列由下到上；像素資料位移位元組 10–13、寬 18–21、高 22–25；像素順序 B、G、R；每列補到 4 的倍數）。依由上到下輸出每列一行，每個像素輸出灰階值 (R×299+G×587+B×114)//1000，以空白分隔。',
    'def le(d, p, n):\n    v = 0\n    for i in range(n):\n        v |= d[p + i] << (8 * i)\n    return v\n\n\ndef main():\n    h = input().strip()\n    d = [int(h[i:i+2], 16) for i in range(0, len(h), 2)]\n    off = le(d, 10, 4)\n    w = le(d, 18, 4)\n    ht = le(d, 22, 4)\n    stride = (w * 3 + 3) // 4 * 4\n    for y in range(ht):\n        row = ht - 1 - y\n        vals = []\n        for x in range(w):\n            p = off + row * stride + x * 3\n            b, g, r = d[p], d[p + 1], d[p + 2]\n            vals.append(str((r * 299 + g * 587 + b * 114) // 1000))\n        print(" ".join(vals))\n',
    gen_bgray, ['bmp', 'binary-read', 'row-order', 'pixel-map'])

# ───────────────────────── 周邊：base64 / 端序 / RLE ─────────────────────────
B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
add('lx-base64-encode', 'base64 編碼', 'LX1', '輸入一行只含英數字的文字。輸出它的 base64（字母表 A–Z a–z 0–9 + /，每 3 位元組切成 4 個 6 位元群，不足補 =）。',
    'def main():\n    A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"\n    s = [ord(c) for c in input().strip()]\n    out = ""\n    for i in range(0, len(s), 3):\n        chunk = s[i:i+3]\n        v = 0\n        for b in chunk:\n            v = (v << 8) | b\n        v <<= 8 * (3 - len(chunk))\n        for k in range(4):\n            if k <= len(chunk):\n                out += A[(v >> (18 - 6 * k)) & 63]\n            else:\n                out += "="\n    print(out)\n',
    lambda i: rtext(1, 14) + '\n', ['base64', 'bitops', 'string'], hold=True)
add('lx-base64-decode', 'base64 解碼', 'LX1', '輸入一行 base64（字母表 A–Z a–z 0–9 + /，結尾可能有 = 補齊），原文只含英數字。輸出解碼後的文字。',
    'def main():\n    A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"\n    s = input().strip().rstrip("=")\n    bits = 0\n    n = 0\n    out = ""\n    for ch in s:\n        bits = (bits << 6) | A.index(ch)\n        n += 6\n        if n >= 8:\n            n -= 8\n            out += chr((bits >> n) & 255)\n            bits &= (1 << n) - 1\n    print(out)\n',
    lambda i: base64.b64encode(rtext(1, 14).encode()).decode() + '\n', ['base64', 'bitops', 'string'])
add('lx-endian-pack', '位元組序：整數轉位元組', 'LX0', '輸入一行「值 位元組數 序」，序為 le（小端）或 be（大端）。輸出把該非負整數寫成指定位元組數的十六進位（小寫、相連）。',
    'def main():\n    v, n, order = input().split()\n    v = int(v)\n    n = int(n)\n    bs = [(v >> (8 * i)) & 255 for i in range(n)]\n    if order == "be":\n        bs = bs[::-1]\n    print("".join("%02x" % b for b in bs))\n',
    lambda i: (lambda n: '%d %d %s\n' % (random.randint(0, 256 ** n - 1), n, random.choice(['le', 'be'])))(random.choice([1, 2, 4, 8])), ['endian', 'struct', 'bitops'])


def gen_rle(i):
    return ''.join(random.choice('abc') * random.randint(1, 5) for _ in range(random.randint(1, 6))) + '\n'


add('lx-rle-encode', 'RLE 編碼（BMP RLE8 概念）', 'LX0', '輸入一行只含 a、b、c 的字串。輸出行程長度編碼：連續相同字元寫成「次數 字元」，所有片段相連（例如 aaabcc → 3a1b2c）。',
    'def main():\n    s = input().strip()\n    out = ""\n    i = 0\n    while i < len(s):\n        j = i\n        while j < len(s) and s[j] == s[i]:\n            j += 1\n        out += str(j - i) + s[i]\n        i = j\n    print(out)\n',
    gen_rle, ['rle', 'string', 'scan'])

B.write()
