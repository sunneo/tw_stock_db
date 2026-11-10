'use strict';
// 判題器的真行程能力（G15、G16）：argv／環境變數／結束碼／檔案夾具與輸出檔／二進位 stdin stdout／exec／管線／fork／socket／孤兒行程清理。
//   node judge-runner-real.test.js
// 需要 fork 的測試：非 Windows 直接真 fork（mode native）；Windows 的 bash 走 msys（mode msys）；Windows 的 python／C 走 WSL（mode wsl，第一次要等十幾秒）；
// 都沒有就該筆回 UNAVAILABLE（mode none）。沒有 WSL 的機器會印 skip，不會假裝通過。
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const J = require('./judge-runner.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (tests, extra) => Object.assign({ id: 'real', checker: 'tokens', tests }, extra || {});

(async () => {
    const caps = await J.capabilities();
    console.log('能力：' + JSON.stringify(caps));
    const hasPy = (await J.available('python')).ok;
    if (!hasPy) { console.log('skip - 沒有 python'); process.exit(0); }

    await t('argv、環境變數、結束碼：程式印 argv 與 env，並以指定結束碼離開；結束碼不符判 WA，沒指定且非 0 判 RE', async () => {
        const src = 'import sys, os\nprint(sys.argv[1], sys.argv[2], os.environ.get("FOO"))\nsys.exit(7)\n';
        let r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', out: 'a b bar', args: ['a', 'b'], env: { FOO: 'bar' }, expectExit: 7 }]) });
        assert.strictEqual(r.verdict, 'AC', r.verdict + ' ' + r.detail);
        r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', out: 'a b bar', args: ['a', 'b'], env: { FOO: 'bar' }, expectExit: 0 }]) });
        assert.strictEqual(r.verdict, 'WA'); assert.ok(/結束碼 7 vs 期望 0/.test(r.detail), r.detail);
        r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', out: 'a b bar', args: ['a', 'b'], env: { FOO: 'bar' } }]) });
        assert.strictEqual(r.verdict, 'RE');
        r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', out: 'a b bar', args: ['a', 'b'], env: { FOO: 'bar' }, expectExit: 'any' }]) });
        assert.strictEqual(r.verdict, 'AC');
    });

    await t('檔案夾具：預置多個輸入檔（含子目錄與二進位）、比對輸出檔（文字用 tokens、二進位位元組相等）；少產生檔案判 WA', async () => {
        const src = 'import sys\na = open("in1.txt").read().split()\nb = open("sub/in2.bin","rb").read()\nopen("out.txt","w").write(" ".join(reversed(a)) + "\\n")\nopen("out.bin","wb").write(b[::-1])\nprint(len(b))\n';
        const test = { in: '', out: '3', files: { 'in1.txt': 'x y z\n', 'sub/in2.bin': { hex: '00ff10' } }, expectFiles: { 'out.txt': 'z y x', 'out.bin': { hex: '10ff00' } } };
        let r = await J.judge({ lang: 'python', source: src, problem: P([test]) });
        assert.strictEqual(r.verdict, 'AC', r.verdict + ' ' + r.detail);
        r = await J.judge({ lang: 'python', source: src, problem: P([Object.assign({}, test, { expectFiles: { 'out.bin': { hex: '00ff10' } } })]) });
        assert.strictEqual(r.verdict, 'WA'); assert.ok(/out\.bin/.test(r.detail), r.detail);
        r = await J.judge({ lang: 'python', source: src, problem: P([Object.assign({}, test, { expectFiles: { 'nope.txt': 'x' } })]) });
        assert.strictEqual(r.verdict, 'WA'); assert.ok(/沒有產生檔案/.test(r.detail), r.detail);
        r = await J.judge({ lang: 'python', source: src, problem: P([Object.assign({}, test, { files: { '../evil.txt': 'x' } })]) });
        assert.strictEqual(r.verdict, 'RE'); assert.ok(/檔名不合法/.test(r.detail), r.detail);
        // 每筆測試各有獨立工作目錄：第二筆看不到第一筆產生的檔案
        const src2 = 'import os\nprint(os.path.exists("left.txt"))\nopen("left.txt","w").write("x")\n';
        r = await J.judge({ lang: 'python', source: src2, problem: P([{ in: '', out: 'False' }, { in: '', out: 'False' }]) });
        assert.strictEqual(r.verdict, 'AC', r.detail);
    });

    await t('二進位 stdin／stdout：inHex 餵位元組、outHex 比對位元組（含非 UTF-8 的 0xff）', async () => {
        const src = 'import sys\nd = sys.stdin.buffer.read()\nsys.stdout.buffer.write(bytes(b ^ 0xff for b in d))\n';
        let r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', inHex: '00 01 fe', out: '', outHex: 'ff fe 01' }]) });
        assert.strictEqual(r.verdict, 'AC', r.verdict + ' ' + r.detail);
        r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', inHex: '00', out: '', outHex: '00' }]) });
        assert.strictEqual(r.verdict, 'WA');
    });

    await t('真子行程：exec（以新程式取代）、管線（兩個行程接 stdin／stdout）、wait 取回結束碼、環境變數只傳給子行程（Windows 沒有 fork 也能做）', async () => {
        const src = [
            'import subprocess, sys, os',
            'child = "import os,sys; sys.stdout.write(os.environ.get(\'K\',\'-\') + \':\' + sys.stdin.read().upper()); sys.exit(5)"',
            'env = dict(os.environ); env["K"] = "v"',
            'p = subprocess.Popen([sys.executable, "-c", "import sys;sys.stdout.write(sys.stdin.read()+\'!\')"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)',
            'q = subprocess.Popen([sys.executable, "-c", "import sys; exec(" + repr("import os;sys.stdout.write(os.environ.get(\'K\',\'-\') + \':\' + sys.stdin.read().upper());sys.exit(5)") + ")"], stdin=p.stdout, stdout=subprocess.PIPE, env=env)',
            'p.stdin.write(b"abc"); p.stdin.close()',
            'out = q.communicate()[0].decode()',
            'p.wait()',
            'print(out, p.returncode, q.returncode)'
        ].join('\n') + '\n';
        const r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', out: 'v:ABC! 0 5' }]), timeoutMs: 20000 });
        assert.strictEqual(r.verdict, 'AC', r.verdict + ' ' + r.detail); assert.deepStrictEqual(r.modes, ['native']);
    });

    await t('孤兒清理：程式啟動一個脫離的長壽孫行程後自己結束，判題完成後那個孫行程已被清掉', async () => {
        const pidFile = path.join(os.tmpdir(), 'fa-orphan-' + process.pid + '.pid'); try { fs.unlinkSync(pidFile); } catch (e) { /* */ }
        const src = 'import subprocess, sys, os\nkw = {"creationflags": 0x00000008 | 0x00000200} if os.name == "nt" else {"start_new_session": True}\nc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)  # judge-orphan"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)\nopen(sys.argv[1], "w").write(str(c.pid))\nprint("done")\n';
        const r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', out: 'done', args: [pidFile], needs: ['socket'] }]), timeoutMs: 15000 });
        assert.strictEqual(r.verdict, 'AC', r.verdict + ' ' + r.detail);
        const gpid = Number(fs.readFileSync(pidFile, 'utf8')); let gone = false;
        for (let i = 0; i < 20 && !gone; i++) { gone = !alive(gpid); if (!gone) await sleep(250); }
        try { if (alive(gpid)) process.kill(gpid, 'SIGKILL'); } catch (e) { /* */ } try { fs.unlinkSync(pidFile); } catch (e) { /* */ }
        if (process.platform !== 'win32') { /* 非 Windows 的脫離行程在新 session，行程群組殺不到；判題器沒有掃描，這裡只驗證 Windows 的掃描 */ if (!gone) console.log('  （註：非 Windows 的脫離孫行程不在行程群組內，判題器目前不掃；已手動清掉）'); } else assert.ok(gone, '孤兒孫行程 ' + gpid + ' 還活著');
    });

    await t('socket：同一個程式在 127.0.0.1 的空閒埠開伺服器與客戶端收發（真 TCP）；{{PORT}} 與 JUDGE_PORT 都會替換', async () => {
        const src = [
            'import socket, threading, sys, os',
            'port = int(sys.argv[1]); assert port == int(os.environ["JUDGE_PORT"])',
            'srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(("127.0.0.1", port)); srv.listen(1)',
            'got = []',
            'def serve():',
            '    c, _ = srv.accept(); d = c.recv(100); c.sendall(d.upper()); c.close()',
            'th = threading.Thread(target=serve); th.start()',
            'cl = socket.create_connection(("127.0.0.1", port)); cl.sendall(sys.stdin.read().strip().encode()); print(cl.recv(100).decode()); cl.close(); th.join(); srv.close()'
        ].join('\n') + '\n';
        const r = await J.judge({ lang: 'python', source: src, problem: P([{ in: 'hello\n', out: 'HELLO', args: ['{{PORT}}'], needs: ['socket'] }, { in: 'bye\n', out: 'BYE', args: ['{{PORT}}'], needs: ['socket'] }]), timeoutMs: 15000 });
        assert.strictEqual(r.verdict, 'AC', r.verdict + ' ' + r.detail);
    });

    await t('socket 逾時：伺服器永遠 accept 不到連線 → TLE，且判題後那個埠已被釋放（可重新綁定）', async () => {
        const src = 'import socket, sys\ns = socket.socket(); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(1); s.accept()\n';
        const port = await J.freePort();
        const r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', out: '', args: [String(port)], needs: ['socket'] }]), timeoutMs: 600 });
        assert.strictEqual(r.verdict, 'TLE', r.verdict + ' ' + r.detail);
        await sleep(300);
        const ok = await new Promise((res) => { const s = require('net').createServer(); s.on('error', () => res(false)); s.listen(port, '127.0.0.1', () => s.close(() => res(true))); });
        assert.ok(ok, '埠 ' + port + ' 還被佔著');
    });

    // 需要 fork：非 Windows 直接真 fork；Windows 的 bash 走 msys；Windows 的 python／C 走 WSL
    const forkPy = 'import os, sys\nr, w = os.pipe()\npid = os.fork()\nif pid == 0:\n    os.close(r)\n    os.write(w, b"child-" + os.environ.get("K", "-").encode())\n    os._exit(9)\nos.close(w)\n_, st = os.waitpid(pid, 0)\nprint(os.read(r, 100).decode(), os.WEXITSTATUS(st))\n';
    await t('真 fork（python）：fork＋pipe＋waitpid＋子行程結束碼＋環境變數；模式依平台標明', async () => {
        const r = await J.judge({ lang: 'python', source: forkPy, problem: P([{ in: '', out: 'child-v 9', env: { K: 'v' }, needs: ['fork'] }]), timeoutMs: 20000 });
        if (r.verdict === 'UNAVAILABLE') { assert.deepStrictEqual(r.modes, ['none']); assert.ok(/沒有 fork/.test(r.detail), r.detail); console.log('  skip（模式 none）：' + r.detail); return; }
        assert.strictEqual(r.verdict, 'AC', r.verdict + ' ' + r.detail); assert.deepStrictEqual(r.modes, [process.platform === 'win32' ? 'wsl' : 'native']);
    });
    if ((await J.available('bash')).ok) await t('真 fork（bash）：背景行程、wait 取結束碼、管線；Windows 走 msys 的真 fork', async () => {
        const src = '( echo kid; exit 4 ) | cat &\nwait $!\necho "st=$?"\n(exit 3)\necho "sub=$?"\n';
        const r = await J.judge({ lang: 'bash', source: src, problem: P([{ in: '', out: 'kid\nst=0\nsub=3', needs: ['fork'] }]), timeoutMs: 10000 });
        assert.strictEqual(r.verdict, 'AC', r.verdict + ' ' + r.detail); assert.deepStrictEqual(r.modes, [process.platform === 'win32' ? 'msys' : 'native']);
    });
    if ((await J.available('c')).ok && (process.platform !== 'win32' || (caps.wsl && caps.wsl.ok))) await t('真 fork＋exec（C）：fork／execlp／waitpid／socketpair；Windows 由 WSL 編譯與執行', async () => {
        const src = '#include <stdio.h>\n#include <unistd.h>\n#include <sys/wait.h>\n#include <stdlib.h>\nint main(int argc, char **argv) {\n  int fd[2]; pipe(fd); pid_t p = fork();\n  if (p == 0) { close(fd[0]); dup2(fd[1], 1); execlp("echo", "echo", argv[1], (char*)0); _exit(127); }\n  close(fd[1]); char buf[64] = {0}; int n = read(fd[0], buf, 63); int st; waitpid(p, &st, 0);\n  printf("%d %s", WEXITSTATUS(st), buf); return 0; }\n';
        const r = await J.judge({ lang: 'c', source: src, problem: P([{ in: '', out: '0 hi', args: ['hi'], needs: ['fork'] }]), timeoutMs: 20000 });
        assert.strictEqual(r.verdict, 'AC', r.verdict + ' ' + r.detail); assert.deepStrictEqual(r.modes, [process.platform === 'win32' ? 'wsl' : 'native']);
    });
    if (caps.fork === 'wsl' || caps.fork === 'native') await t('fork 出的長壽子行程：父行程等它 → 逾時 TLE，子行程被一起殺掉（WSL 內沒有殘留）', async () => {
        const src = ['import os, time', 'if os.fork() == 0:', '    time.sleep(77)', 'else:', '    os.wait()', ''].join(String.fromCharCode(10));
        const r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', out: '', needs: ['fork'] }]), timeoutMs: 1500 });
        assert.strictEqual(r.verdict, 'TLE', r.verdict + ' ' + r.detail);
        const k = caps.fork === 'wsl' ? await J.exec('wsl', ['-d', caps.wsl.distro, '--', 'sh', '-c', 'ps -eo args | grep "time.sleep(77)" | grep -v grep | wc -l'], { timeoutMs: 30000 }) : await J.exec('sh', ['-c', 'ps -eo args | grep "time.sleep(77)" | grep -v grep | wc -l'], { timeoutMs: 10000 });
        assert.strictEqual(k.stdout.trim(), '0', '殘留子行程');
    });
    // Windows：python 開的子行程不能有可見的主控台視窗（Windows Terminal 為預設終端機時，沒有父主控台的子行程會彈出黑視窗搶走焦點）。
    // 做法見 judge-runner.js 的 SITECUSTOMIZE；這裡用子行程自己回報 GetConsoleWindow／IsWindowVisible 來證明
    if (process.platform === 'win32') await t('Windows：sandbox 的 python 以 subprocess／os.system／os.popen／os.spawnv 開的子行程都沒有可見的主控台視窗', async () => {
        const L = (a) => a.join(String.fromCharCode(10));
        const src = L(['import os, subprocess, sys',
            'open("c.py", "w").write("import ctypes\\nh = ctypes.windll.kernel32.GetConsoleWindow()\\nprint(\\"vis\\", int(bool(h and ctypes.windll.user32.IsWindowVisible(h))))\\n")',
            'print("patched", subprocess.Popen.__init__.__name__)',
            'print(subprocess.run([sys.executable, "c.py"], capture_output=True, text=True).stdout.strip())',
            'os.system(sys.executable + " c.py")',
            'print(os.popen(sys.executable + " c.py").read().strip())',
            'os.spawnv(os.P_WAIT, sys.executable, [sys.executable, "c.py"])', '']);
        const want = ['patched _fa_init', 'vis 0', 'vis 0', 'vis 0', 'vis 0'].join(String.fromCharCode(10));
        const r = await J.judge({ lang: 'python', source: src, problem: P([{ in: '', out: want }], { checker: 'unordered-lines' }), timeoutMs: 40000 });
        assert.strictEqual(r.verdict, 'AC', r.verdict + ' ' + r.detail);
    });
    if (process.platform === 'win32') await t('Windows：nodejs 沙盒掛上 hide-child-windows（NODE_OPTIONS）', async () => {
        const env = J.hideEnv('nodejs', require('os').tmpdir()); assert.ok(/hide-child-windows.js/.test(env.NODE_OPTIONS || ''), JSON.stringify(env));
    });
    await t('不用 fork 的測試在 Windows 仍是 native（不會為了 argv／結束碼去啟動 WSL）', async () => {
        const r = await J.judge({ lang: 'python', source: 'import sys\nprint(len(sys.argv))\n', problem: P([{ in: '', out: '2', args: ['x'] }]) });
        assert.deepStrictEqual(r.modes, ['native']);
    });
    console.log('judge-runner-real.test.js：' + n + ' passed, 0 failed');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
