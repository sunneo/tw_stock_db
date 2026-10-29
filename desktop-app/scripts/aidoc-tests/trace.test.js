// AIDoc debugging locator: backtrace / log parsing, candidate ranking, tree-version check, citation check.   node scripts/aidoc-tests/trace.test.js
var path = require('path');
var T = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'aidoc', 'trace.js'));
var pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('FAIL: ' + m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' -- got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

// ---- gdb
var g = T.parse('#0  0x00007ffff7a2d1c9 in raise () from /lib/x86_64-linux-gnu/libc.so.6\n#1  0x0000555555555171 in ipmi_exec_main (argc=2, argv=0x7ffe) at src/ipmi/exec.c:123\n#2  main (argc=1) at src/main.c:40\n#3  0x00007ffff7a1 in __libc_start_main () from /lib/libc.so.6');
eq(g.frames.length, 4, 'gdb frames');
eq([g.frames[0].func, g.frames[0].lib, g.frames[0].file], ['raise', '/lib/x86_64-linux-gnu/libc.so.6', ''], 'gdb libc frame has a lib, no file');
eq([g.frames[1].func, g.frames[1].file, g.frames[1].line, g.frames[1].addr], ['ipmi_exec_main', 'src/ipmi/exec.c', 123, '0x0000555555555171'], 'gdb source frame');
eq([g.frames[2].func, g.frames[2].file, g.frames[2].line], ['main', 'src/main.c', 40], 'gdb frame without address');
eq(g.formats, ['gdb'], 'gdb format only');

// ---- kernel oops
var k = T.parse('Linux version 5.15.0-198-generic (buildd@lcy02) #209\nCall Trace:\n <TASK>\n dump_stack_lvl+0x48/0x70\n ? vfs_read.isra.0+0x2c/0x90\n ipmi_si_irq_handler+0x1a/0x80 [ipmi_si]\n RIP: 0010:foo_bar.cold+0x5/0x20\n [<ffffffff81234567>] old_style+0x12/0x34');
eq(k.frames.map(function (f) { return f.func; }), ['dump_stack_lvl', 'vfs_read', 'ipmi_si_irq_handler', 'foo_bar', 'old_style'], 'kernel funcs, compiler suffixes removed');
eq(k.frames[2].module, 'ipmi_si', 'kernel module');
ok(k.frames[1].inexact === true, 'a "?" frame is marked inexact');
eq(k.versions.kernel, '5.15.0-198-generic', 'kernel version from the banner');

// ---- python, java, js
var p = T.parse('Traceback (most recent call last):\n  File "/app/web/server.py", line 88, in handle\n    do()\n  File "<stdin>", line 1, in <module>');
eq([p.frames[0].func, p.frames[0].file, p.frames[0].line], ['handle', '/app/web/server.py', 88], 'python frame');
eq(p.frames[1].func, '', 'python <module> has no function');
var j = T.parse('Exception in thread "main" java.lang.NullPointerException\n\tat com.acme.net.Client.send(Client.java:57)\n\tat com.acme.Main.main(Main.java:12)');
eq([j.frames[0].func, j.frames[0].qual, j.frames[0].file, j.frames[0].line], ['send', 'com::acme::net::Client', 'Client.java', 57], 'java frame');
var n = T.parse('Error: boom\n    at handler (/srv/app/lib/x.js:12:5)\n    at async /srv/app/y.mjs:3:9\n    at Object.<anonymous> (file:///srv/app/z.js:1:1)');
eq(n.frames.map(function (f) { return f.file + ':' + f.line; }), ['/srv/app/lib/x.js:12', '/srv/app/y.mjs:3', '/srv/app/z.js:1'], 'node frames');
eq(n.frames[0].func, 'handler', 'node function');

// ---- go + rust
var go = T.parse('goroutine 1 [running]:\nmain.(*Server).handle(0xc000010000)\n\t/app/server.go:42 +0x1f\nmain.main()\n\t/app/main.go:10 +0x25');
eq(go.frames.length, 2, 'go: the location line joins the function line');
eq([go.frames[0].func, go.frames[0].file, go.frames[0].line], ['handle', '/app/server.go', 42], 'go frame');
var rs = T.parse("thread 'main' panicked at src/main.rs:5:9:\nboom\nstack backtrace:\n   0: std::panicking::begin_panic\n   3: myapp::net::send\n             at ./src/net.rs:77:13");
ok(rs.frames.some(function (f) { return f.fmt === 'rustpanic' && f.file === 'src/main.rs' && f.line === 5; }), 'rust panic location');
ok(rs.frames.some(function (f) { return f.func === 'send' && f.file === './src/net.rs' && f.line === 77; }), 'rust frame gets the at-location');

// ---- glibc backtrace_symbols / asan
var gl = T.parse('./prog(parse_cfg+0x1a) [0x401136]\n/lib/x86_64-linux-gnu/libc.so.6(+0x2d1c9) [0x7f00]\n#0 0x4f2a1c in handle_req /src/net/req.c:55:13');
eq([gl.frames[0].func, gl.frames[0].off, gl.frames[0].module], ['parse_cfg', '0x1a', './prog'], 'glibc frame');
eq(gl.frames[1].func, '', 'glibc frame with no symbol');
eq([gl.frames[2].func, gl.frames[2].file, gl.frames[2].line, gl.frames[2].col], ['handle_req', '/src/net/req.c', 55, 13], 'asan frame');

// ---- journal / log lines: only file:line references; prose is not a frame
var lg = T.parse('Oct 29 12:00:01 bmc bmcweb[812]: error at /usr/src/bmcweb/http/http_server.hpp:212 connection reset\nOct 29 12:00:02 bmc systemd[1]: Started something.\nOct 29 12:00:03 bmc app[9]: assertion failed (drivers/net/foo.c:77)');
eq(lg.frames.map(function (f) { return f.file + ':' + f.line; }), ['/usr/src/bmcweb/http/http_server.hpp:212', 'drivers/net/foo.c:77'], 'log file:line refs');
eq(T.parse('1: first point\n2: second point\nhello world 12:30').frames.length, 0, 'numbered prose is not a rust backtrace');
eq(T.parse('').frames.length, 0, 'empty input');

// ---- candidate ranking
var defs = [{ name: 'init', kind: 'function', path: 'drivers/a/init.c', line: 10 }, { name: 'init', kind: 'function', path: 'drivers/b/init.c', line: 20 }];
var r1 = T.rankCandidates({ func: 'init', file: '/build/linux/drivers/b/init.c', line: 21 }, defs, ['drivers/b/init.c']);
eq([r1.status, r1.picks.length, r1.picks[0].path], ['exact', 1, 'drivers/b/init.c'], 'name + file agree -> exact');
var r2 = T.rankCandidates({ func: 'init' }, defs, []);
eq([r2.status, r2.picks.length], ['ambiguous', 2], 'two same-name statics and no file -> ambiguous, both listed');
var r3 = T.rankCandidates({ func: 'init', file: '/x/elsewhere/other.c' }, defs, []);
eq(r3.status, 'ambiguous', 'frame file missing from the tree: same-name definitions are only candidates');
var r4 = T.rankCandidates({ func: 'raise' }, [], []);
eq(r4.status, 'none', 'no definition -> none');
var r5 = T.rankCandidates({ func: 'only_one' }, [{ name: 'only_one', path: 'x/y.c', line: 3 }], []);
eq(r5.status, 'unique', 'single definition, no file -> unique');
var r6 = T.rankCandidates({ func: 'x', file: 'src/q.c', line: 9 }, [], ['lib/src/q.c']);
eq([r6.status, r6.files[0]], ['file', 'lib/src/q.c'], 'file known, function not in the index');
var r7 = T.rankCandidates({ func: 'Foo' }, [{ name: 'foo', path: 'a.c', line: 1 }], []);
eq(r7.status, 'unique', 'case-only match still found'); ok(/大小寫/.test(r7.note), 'and says it was a case-only match');

// ---- tree version
eq(T.treeCheck({ git: 'abcdef1234567890' }, { git: 'abcdef1' }).level, 'ok', 'same commit');
eq(T.treeCheck({ git: 'abcdef1234567890' }, { git: '1234567' }).level, 'warn', 'different commit warns');
eq(T.treeCheck(null, { git: '1234567' }).level, 'unknown', 'index has no tree ref -> unknown, never "ok"');
eq(T.treeCheck({ git: 'abcdef1234567890' }, {}).level, 'unknown', 'trace has no version -> unknown');
eq(T.parse('commit: 0123abc9').versions.git, '0123abc9', 'commit sha from the trace');
eq(T.parse('Build-ID: 1f2e3d4c5b6a7988').versions.build_id, '1f2e3d4c5b6a7988', 'build-id from the trace');

// ---- citations
var located = [{ path: 'src/ipmi/exec.c', line: 123, from: 120, to: 132 }];
eq(T.checkCitations('see `src/ipmi/exec.c:125` and /build/src/ipmi/exec.c:123', located), { ok: true, bad: [] }, 'cited places that were located');
var bad = T.checkCitations('the bug is at src/ipmi/exec.c:400 and util.c:9', located);
eq([bad.ok, bad.bad], [false, ['src/ipmi/exec.c:400', 'util.c:9']], 'places that were not located are reported');

// ---- names that are Object.prototype members must not break anything
ok(T.parse('#1  0x1 in constructor () at a.c:1\n#2 toString () at b.c:2').frames.length === 2, 'constructor / toString frames');


// ---- P2: log message literals
var C1 = 'static int f(struct device *dev) {\n  dev_err(dev, "failed to map registers (%d)\\n", ret);\n  pr_info("hello " PRIu64 " world\\n", x);\n  printk(KERN_ERR "ipmi: BMC not responding after %d retries\\n", n);\n  fprintf(stderr, "%s: %d", a, b);\n  lg2::error("Unable to open {PATH}", "PATH", p);\n  phosphor::logging::log<level::ERR>("Failed to read sensor");\n  if (catalog("not a log call at all")) {}\n  return x;\n}';
var L1 = T.extractLogs(C1, 'cpp');
eq(L1.map(function (x) { return x.l + ':' + x.fn; }), ['2:dev_err', '3:pr_info', '4:printk', '6:lg2::error', '7:phosphor::logging::log'], 'C/C++ log calls found with their lines; "%s: %d" has no fixed text and a non-log call is ignored');
eq(L1[1].fmt, 'hello  world', 'adjacent C literals joined across a PRIu64-like macro');
eq(L1[2].fmt, 'ipmi: BMC not responding after %d retries', 'KERN_ERR prefix macro skipped, \\n removed');
var PY = T.extractLogs('logger.warning("Cannot connect to %s: %s" % (h, e))\nraise ValueError(f"bad port {port} given")\nprint("short")', 'py');
eq(PY.map(function (x) { return x.fn; }), ['logger.warning', 'ValueError'], 'python: logger.warning and raise; a one-word print is too generic to index');
var JS = T.extractLogs('console.error(`request ${id} timed out`); throw new Error("config file is missing");', 'js');
eq(JS.map(function (x) { return x.fmt; }), ['request ${id} timed out', 'config file is missing'], 'js: template literal and throw new Error');
var GO = T.extractLogs('log.Printf("listen failed: %v", err); eprintln!("unable to bind {}", addr)', 'go');
eq(GO.length, 2, 'go / rust style calls');
eq(T.extractLogs('printk("hello world here");', 'txt').length, 0, 'unsupported language: nothing');

var pat = T.fmtPattern('ipmi: BMC not responding after %d retries');
ok(new RegExp(pat.src).test('ipmi: BMC not responding after 3 retries') && !new RegExp(pat.src).test('ipmi: BMC not responding after x retriez'), '%d is a wildcard, the rest must match');
ok(new RegExp(T.fmtPattern('100%% done for {name}: ${x}').src).test('100% done for bob: 12'), '%%, {name}, ${x}');
ok(new RegExp(T.fmtPattern('mapped %pS at %08llx').src).test('mapped foo+0x10/0x20 at 0000dead'), 'kernel %pS and width/length modifiers');
eq(T.messageOf('Oct 29 12:00:01 bmc ipmid[812]: BMC not responding after 3 retries'), 'BMC not responding after 3 retries', 'syslog prefix stripped');
eq(T.messageOf('2026-10-29T12:00:01+0800 bmc ipmid[812]: x y z'), 'x y z', 'iso journal prefix stripped');
eq(T.messageOf('[  123.456789] i2c i2c-1: timeout waiting for bus'), 'i2c i2c-1: timeout waiting for bus', 'kernel timestamp stripped');

var rows = [{ path: 'a/ipmi.c', line: 40, fn: 'printk', fmt: 'ipmi: BMC not responding after %d retries' }, { path: 'b/other.c', line: 9, fn: 'pr_err', fmt: 'BMC not responding' }, { path: 'c/x.c', line: 1, fn: 'pr_err', fmt: 'unrelated text goes here' }];
var mm = T.matchLogs('ipmi: BMC not responding after 3 retries', rows);
eq(mm.map(function (x) { return x.path; }), ['a/ipmi.c', 'b/other.c'], 'candidates verified by pattern, longest fixed text first');
eq(T.judgeLogMatches(mm).status, 'best', 'one clearly longest pattern -> best');
var tie = T.judgeLogMatches(T.matchLogs('failed to open the device', [{ path: 'p.c', line: 1, fn: 'e', fmt: 'failed to open the device' }, { path: 'q.c', line: 2, fn: 'e', fmt: 'failed to open the device' }]));
eq([tie.status, tie.picks.length], ['ambiguous', 2], 'the same message in two places -> ambiguous, both listed');
eq(T.judgeLogMatches([]).status, 'none', 'no match');
ok(T.judgeLogMatches(T.matchLogs('short msg here', [{ path: 'p.c', line: 1, fn: 'e', fmt: 'short msg' }])).weak === true, 'short fixed text is flagged weak');
eq(T.parse('Oct 29 12:00:01 bmc app[1]: something failed badly\n#1 0x1 in f () at a.c:1').others.length, 1, 'parse() returns the lines that are not frames');

// ---- P3: function-level call edges
var CC = '#include <x.h>\n/* foo(bar) in comment */\nstatic int helper(int x) {\n  const char *s = "not_a_call(1) {";\n  return x + 1;\n}\n\nint ipmi_exec_main(int argc,\n                   char **argv)\n{\n  char *p = NULL;\n  helper(argc);\n  if (argc) { do_other(p); }\n  return *p;\n}\nint declared_only(int);\n';
var CE = T.extractCalls(CC, 'c', [{ n: 'helper', k: 'function', l: 3 }, { n: 'ipmi_exec_main', k: 'function', l: 8 }, { n: 'declared_only', k: 'function', l: 16 }]);
eq(CE.map(function (e) { return e.c + '>' + e.f + '@' + e.l; }), ['ipmi_exec_main>helper@12', 'ipmi_exec_main>do_other@13'], 'C: calls inside the body only; comment / string contents, if(), the declaration and the parameter list are not calls');
var PE = T.extractCalls('def a():\n    x = b_func(1)\n    # c_func()\n    return d_func(x)\n\ndef e():\n    pass_call()\n', 'py', [{ n: 'a', k: 'function', l: 1 }, { n: 'e', k: 'function', l: 6 }]);
eq(PE.map(function (e) { return e.c + '>' + e.f + '@' + e.l; }), ['a>b_func@2', 'a>d_func@4', 'e>pass_call@7'], 'python: indentation delimits the body');
eq(T.extractCalls('function f() { g(); }', 'lua', [{ n: 'f', k: 'function', l: 1 }]).length, 0, 'a language without call graph support gives no edges');
eq(T.extractCalls('int f(void) { return 1; }', 'c', [{ n: 'f', k: 'function', l: 1 }]).length, 0, 'a function that calls nothing');
eq(T.chainCheck([{ caller: 'main', path: 'm.c', line: 3 }], { func: 'MAIN' }).level, 'match', 'chain: the next frame is a recorded caller (case-insensitive)');
eq(T.chainCheck([{ caller: 'main', path: 'm.c', line: 3 }], { func: 'other' }).level, 'missing', 'chain: callers known, the stack frame is none of them');
eq(T.chainCheck([], { func: 'x' }).level, 'unknown', 'chain: no caller edges');

// ---- Chinese log text: the script only extracts / matches; whether it is a log is decided by the index (verbatim match)
var ZL = T.extractLogs('void f(){\n  log_error("無法連線到伺服器，請稍後再試 %d", n);\n  log_error("失敗");\n}\n', 'c');
eq(ZL.length, 1, 'Chinese log literal with enough fixed text is indexed; a 2-character one is not');
eq(T.isMessageLine('無法連線到伺服器'), true, 'a Chinese message line can be looked up');
eq(T.isMessageLine('好'), false, 'a one-character line is not');
eq(T.judgeLogMatches(T.matchLogs('無法連線到伺服器，請稍後再試 3', [{ path: 'a.c', line: 2, fn: 'log_error', fmt: ZL[0].fmt }])).status, 'best', 'Chinese message matches the indexed Chinese format string');
eq(T.matchLogs('今天天氣很好呢', [{ path: 'a.c', line: 2, fn: 'log_error', fmt: ZL[0].fmt }]).length, 0, 'the users own Chinese sentence does not match any log');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
