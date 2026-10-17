import sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
from playwright.sync_api import sync_playwright
HELLO = '@msg = private constant [14 x i8] c"hello from IR\00"\ndeclare i32 @puts(ptr)\ndefine i32 @main() {\nentry:\n  %r = call i32 @puts(ptr @msg)\n  ret i32 3\n}\n'
CAT = 'declare i32 @getchar()\ndeclare i32 @putchar(i32)\ndefine i32 @main() {\nentry:\n  br label %loop\nloop:\n  %c = call i32 @getchar()\n  %eof = icmp slt i32 %c, 0\n  br i1 %eof, label %done, label %out\nout:\n  %r = call i32 @putchar(i32 %c)\n  br label %loop\ndone:\n  ret i32 0\n}\n'
SCRIPT = """llcheck hello.ll; echo check=$?
lli hello.ll; echo lli=$?
llc hello.ll -o hello.wasm -v; ls hello.wasm; wasmrun hello.wasm; echo wasmrun=$?
lli hello.ll | tr a-z A-Z
lli hello.ll > out.txt; cat out.txt
echo 'abc 中文' | lli cat.ll
lli nothere.ll; echo missing=$?
wasmrun hello.ll; echo notwasm=$?
llc --help; lli -h
"""
with sync_playwright() as p:
    b = p.chromium.connect_over_cdp('http://127.0.0.1:9344'); page = [pg for c in b.contexts for pg in c.pages if 'devtools' not in pg.url][0]
    r = page.evaluate("async (a) => { const r = await fa.tools.bash_execute.callback.call(fa, JSON.stringify(a)); return String(r); }", { 'script': SCRIPT, 'input_files': { 'hello.ll': HELLO, 'cat.ll': CAT } })
    j = json.loads(r); print('exit', j.get('exit_code')); print(j.get('stdout')); print('[stderr]', j.get('stderr'), j.get('error') or '')
