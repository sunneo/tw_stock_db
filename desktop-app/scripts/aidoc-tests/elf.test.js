// P4 test: the ELF / DWARF reader against the real tools. gcc builds small -g programs in several flavours (DWARF 2-5, PIE / non-PIE, -O0 / -O2,
// 32 / 64 bit, compressed .debug_*), addr2line is the ground truth for EVERY instruction address of the programs.
// Run: node scripts/aidoc-tests/elf.test.js   (needs gcc, objdump, addr2line, strip)
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const E = require('../../renderer/src/aidoc/elf.js');
const SRC = path.join(__dirname, 'elf_src');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('FAIL: ' + m); } }
function sh(cmd, args, opts) { return cp.execFileSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 1 << 28 }, opts || {})); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'elftest-'));

const CONFIGS = [
  { id: 'dw5-O0-pie', flags: ['-gdwarf-5', '-O0'] },
  { id: 'dw4-O0-nopie', flags: ['-gdwarf-4', '-O0', '-no-pie'] },
  { id: 'dw3-O0', flags: ['-gdwarf-3', '-O0'] },
  { id: 'dw2-O0', flags: ['-gdwarf-2', '-O0'] },
  { id: 'dw5-O2', flags: ['-gdwarf-5', '-O2'] },
  { id: 'dw4-O2-gz', flags: ['-gdwarf-4', '-O2', '-Wl,--compress-debug-sections=zlib'] },
  { id: 'dw5-O1-gz-fs', flags: ['-gdwarf-5', '-O1', '-ffunction-sections', '-Wl,--gc-sections', '-gz'] },
  { id: 'm32-dw5-O0', flags: ['-m32', '-gdwarf-5', '-O0'] },
  { id: 'm32-dw4-O2-gz', flags: ['-m32', '-gdwarf-4', '-O2', '-Wl,--compress-debug-sections=zlib'] },
  { id: 'dw4-O2-zdebug', flags: ['-gdwarf-4', '-O2', '-Wl,--compress-debug-sections=zlib-gnu'], optional: true }
];

function build(c) {
  const out = path.join(tmp, c.id);
  try { sh('gcc', c.flags.concat(['main.c', 'util.c', '-o', out]), { cwd: SRC, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return null; }
  return out;
}
// every instruction address of the code (objdump), addr2line's answers for them
function truth(bin) {
  const dis = sh('objdump', ['-d', '--no-show-raw-insn', '-j', '.text', bin]);
  const addrs = [];
  dis.split('\n').forEach((l) => { const m = /^\s+([0-9a-f]+):\s/.exec(l); if (m) { addrs.push(BigInt('0x' + m[1])); } });
  const o = sh('addr2line', ['-e', bin, '-f'].concat(addrs.map((a) => '0x' + a.toString(16)))).trim().split('\n');
  const rows = [];
  for (let i = 0; i < addrs.length; i++) {
    const fn = o[2 * i], loc = o[2 * i + 1] || '';
    const m = /^(.*):(\d+|\?)(?: \(discriminator \d+\))?$/.exec(loc);
    rows.push({ addr: addrs[i], func: fn, file: m ? m[1] : loc, line: m && m[2] !== '?' ? +m[2] : 0 });
  }
  return rows;
}

(async () => {
  for (const c of CONFIGS) {
    const bin = build(c);
    if (!bin) { if (!c.optional) { ok(false, c.id + ': gcc could not build'); } else { console.log('skip ' + c.id + ' (toolchain cannot build it)'); } continue; }
    const buf = fs.readFileSync(bin);
    // half of the configs go through a Blob (the File.slice path), the others through a plain buffer
    const elf = await E.open(/gz/.test(c.id) ? new Blob([buf]) : new Uint8Array(buf), { name: path.basename(bin) });
    const rows = truth(bin);
    const f = await elf.linesAt(rows.map((r) => r.addr));
    let bad = 0, nolineBoth = 0, matched = 0;
    for (const r of rows) {
      const got = f.found.get(r.addr.toString());
      if (!r.line) { if (got && got.line) { bad++; if (bad < 4) { console.log('  ' + c.id + ' expected no line at 0x' + r.addr.toString(16) + ', got ' + got.file + ':' + got.line); } } else { nolineBoth++; } continue; }
      const sameFile = got && path.basename(got.file) === path.basename(r.file);
      if (got && got.line === r.line && sameFile) { matched++; } else { bad++; if (bad < 4) { console.log('  ' + c.id + ' @0x' + r.addr.toString(16) + ' addr2line ' + path.basename(r.file) + ':' + r.line + ' mine ' + (got ? path.basename(got.file) + ':' + got.line : 'none')); } }
    }
    ok(bad === 0 && matched > 20, c.id + ': ' + rows.length + ' addresses, ' + matched + ' lines equal addr2line, ' + bad + ' differ, ' + nolineBoth + ' both without line');
    // absolute path from the line table equals addr2line's when the table carries the compilation directory (DWARF 5)
    if (/dw5/.test(c.id)) { const r0 = rows.find((r) => r.line); const g0 = f.found.get(r0.addr.toString()); ok(g0.file === r0.file, c.id + ': full path ' + (g0 && g0.file) + ' vs ' + r0.file); }
    // symbols (only -O0: with inlining addr2line -f names the inlined function)
    if (/O0/.test(c.id)) {
      let sbad = 0, scnt = 0;
      for (const r of rows) {
        if (!r.line) { continue; }
        const s = await elf.symbolAt(r.addr);
        scnt++;
        if (!s || s.func !== r.func || !s.inside) { sbad++; if (sbad < 4) { console.log('  sym @0x' + r.addr.toString(16) + ' addr2line ' + r.func + ' mine ' + (s && s.func)); } }
      }
      ok(sbad === 0 && scnt > 20, c.id + ': ' + scnt + ' symbols equal addr2line -f (' + sbad + ' differ)');
    }
    if (c.id === 'dw5-O0-pie') {
      ok(elf.info.type === 3 && elf.info.bits === 64 && elf.info.machineName === 'x86-64', 'header: ' + elf.info.typeName + ' ' + elf.info.bits + ' ' + elf.info.machineName);
      const bid = await elf.loadBuildId();
      const rd = sh('readelf', ['-n', bin]).match(/Build ID:\s*([0-9a-f]+)/);
      ok(rd && bid === rd[1], 'build-id equals readelf: ' + bid);
      ok(elf.info.hasLines && elf.info.hasSymbols, 'has lines and symbols');
    }
    if (/gz|zdebug/.test(c.id)) { ok(elf.info.compressed, c.id + ': compression is detected'); }
  }

  // ---------------------------------------------------------------- frames: the glibc / gdb / sanitizer formats, base, build-id
  const pie = path.join(tmp, 'dw5-O0-pie');
  const T = require('../../renderer/src/aidoc/trace.js');
  E.setCleanFunc(T.cleanFunc);
  const elf = await E.open(new Uint8Array(fs.readFileSync(pie)), { name: 'prog' });
  const nm = {}; sh('nm', [pie]).split('\n').forEach((l) => { const m = /^([0-9a-f]+) [Tt] (\S+)$/.exec(l); if (m) { nm[m[2]] = BigInt('0x' + m[1]); } });
  const bid = await elf.loadBuildId();
  // a call inside crash_here -> add3 line: take a real call site from the disassembly
  const dis = sh('objdump', ['-d', '--no-show-raw-insn', pie]);
  const callAdd3 = (() => { const m = /^\s+([0-9a-f]+):\s+call\s+[0-9a-f]+ <add3>/m.exec(dis.split('<crash_here>:')[1] || ''); return BigInt('0x' + m[1]); })();
  const retAddr = callAdd3 + 5n;                   // return address of that call
  const base = 0x55d3c2a4b000n;
  const truthLine = (a) => sh('addr2line', ['-e', pie, '0x' + a.toString(16)]).trim();
  // 1. glibc backtrace format: "prog(crash_here+0x1a) [0x...]" , PIE base derived from func+off
  const symOff = retAddr - nm.crash_here;
  const txt1 = ['prog(add3+0x10) [0x' + (base + nm.add3 + 0x10n).toString(16) + ']',
    'prog(crash_here+0x' + symOff.toString(16) + ') [0x' + (base + retAddr).toString(16) + ']',
    'prog(main+0x40) [0x' + (base + nm.main + 0x40n).toString(16) + ']',
    '/lib/x86_64-linux-gnu/libc.so.6(+0x29d90) [0x7f1b2c829d90]'].join('\n');
  let parsed = T.parse(txt1);
  let rep = await E.resolveFrames(elf, parsed.frames, { build_id: bid }, {});
  ok(rep.base === base, 'base derived from func+off: ' + (rep.base && rep.base.toString(16)));
  ok(rep.items.length === 3, 'libc frame is not resolved against prog (' + rep.items.length + ' frames)');
  ok(rep.items[1].func === 'crash_here' && rep.items[1].status === 'line', 'crash_here resolved with a line');
  const t1 = truthLine(retAddr - 1n);              // return addresses are looked up at addr-1
  ok(rep.items[1].file && t1.endsWith(path.basename(rep.items[1].file) + ':' + rep.items[1].line), 'return address looked up at addr-1: mine ' + path.basename(rep.items[1].file) + ':' + rep.items[1].line + ' addr2line ' + t1);
  ok(rep.buildId.level === 'ok', 'build-id equal -> ok');
  ok(!rep.notes.some((n) => /不是 4096/.test(n)), 'no suspicious base note');
  // 2. module offset form: prog(+0x1171) [0x...]: base = addr - off, no symbol name needed
  const txt2 = 'prog(+0x' + (nm.add3 + 0x10n).toString(16) + ') [0x' + (base + nm.add3 + 0x10n).toString(16) + ']';
  rep = await E.resolveFrames(elf, T.parse(txt2).frames, {}, {});
  ok(rep.base === base && rep.items[0].func === 'add3', 'module-offset form gives the base and the function');
  ok(rep.buildId.level === 'unknown', 'no build-id in the stack -> unknown, not ok');
  // 3. gdb frames with absolute addresses and no way to know the base: asks for --base, still no guess
  const txt3 = '#0  0x' + (base + nm.add3 + 0x10n).toString(16) + ' in add3 (a=1) at util.c:7\n#1  0x' + (base + retAddr).toString(16) + ' in crash_here (p=0x0) at util.c:19';
  rep = await E.resolveFrames(elf, T.parse(txt3).frames, {}, {});
  ok(rep.base === null && rep.items.every((i) => i.status === 'none') && rep.notes.some((n) => /--base/.test(n)), 'PIE with unknown base: nothing guessed, --base requested');
  rep = await E.resolveFrames(elf, T.parse(txt3).frames, {}, { base: '0x' + base.toString(16) });
  ok(rep.items[0].status === 'line' && rep.items[0].func === 'add3', 'user-supplied base resolves the frames');
  const t0 = truthLine(nm.add3 + 0x10n);
  ok(t0.endsWith(path.basename(rep.items[0].file) + ':' + rep.items[0].line), 'gdb #0 equals addr2line (exact pc): ' + path.basename(rep.items[0].file) + ':' + rep.items[0].line + ' vs ' + t0);
  // 4. wrong base -> outside the image, said so
  rep = await E.resolveFrames(elf, T.parse(txt3).frames, {}, { base: '0x10000' });
  ok(rep.items.every((i) => i.vaddr === null && i.notes.some((n) => /不在 ELF 的位址範圍/.test(n))), 'a wrong base is detected (address outside the image)');
  // 5. unrelocated addresses (inside the image) -> assumption stated
  rep = await E.resolveFrames(elf, T.parse('#0  0x' + (nm.add3 + 0x10n).toString(16) + ' in add3 () at util.c:7').frames, {}, {});
  ok(rep.base === 0n && /假設/.test(rep.baseHow), 'unrelocated: base=0 is announced as an assumption');
  // 6. build-id mismatch -> loud warning
  rep = await E.resolveFrames(elf, T.parse(txt2).frames, { build_id: 'deadbeef00112233445566778899aabbccddeeff' }, {});
  ok(rep.buildId.level === 'bad' && /不可信/.test(rep.buildId.msg), 'build-id mismatch is a warning');
  rep = await E.resolveFrames(elf, T.parse(txt2).frames, { build_id: bid.slice(0, 12) }, {});
  ok(rep.buildId.level === 'ok', 'a shortened build-id (prefix) in the stack still matches');
  // 7. sanitizer "(module+0xoff)" lines
  const txt7 = '    #1 0x' + (base + nm.main + 0x20n).toString(16) + ' (/home/x/prog+0x' + (nm.main + 0x20n).toString(16) + ') (BuildId: ' + bid + ')';
  const mf = E.parseModuleFrames(txt7);
  ok(mf.length === 1 && mf[0].module === '/home/x/prog', 'sanitizer module+offset line is parsed');
  mf.forEach((f, i) => { f.n = i + 2; });
  rep = await E.resolveFrames(elf, mf, {}, {});
  ok(rep.items[0].func === 'main' && rep.items[0].status === 'line', 'sanitizer frame resolves to main with a line');
  // 8. applyToFrames: ELF is the authority; the frame then carries file:line
  parsed = T.parse(txt1); rep = await E.resolveFrames(elf, parsed.frames, { build_id: bid }, {}); E.applyToFrames(rep);
  ok(parsed.frames[1].file && parsed.frames[1].line > 0 && parsed.frames[1].func === 'crash_here', 'applyToFrames fills file/line/func');
  ok(E.reportLines(rep).join('\n').includes('crash_here'), 'report mentions the function');
  // 9. wrong module name -> nothing is resolved, and it says why
  rep = await E.resolveFrames(elf, T.parse('other(foo+0x1) [0x55d3c2a4b171]\nthird(bar+0x1) [0x55d3c2a4b171]').frames, {}, {});
  ok(rep.items.length === 0 && rep.notes.some((n) => /沒有 frame 屬於/.test(n)), 'unrelated modules: no frame resolved, reported');
  rep = await E.resolveFrames(elf, T.parse('other(+0x' + (nm.add3 + 0x10n).toString(16) + ') [0x55d3c2a4b171]').frames, {}, {});
  ok(rep.items.length === 1 && rep.notes.some((n) => /假設就是它/.test(n)), 'a single different module name is assumed, announced');

  // ---------------------------------------------------------------- stripped variants
  const noDbg = path.join(tmp, 'nodbg'); sh('strip', ['--strip-debug', '-o', noDbg, pie]);
  const e2 = await E.open(new Uint8Array(fs.readFileSync(noDbg)), { name: 'prog' });
  rep = await E.resolveFrames(e2, T.parse(txt2).frames, {}, {});
  ok(rep.items[0].status === 'symbol' && rep.items[0].func === 'add3' && rep.notes.some((n) => /沒有 `\.debug_line`/.test(n)), 'no debug info: symbol + offset, "no line numbers" said plainly');
  const allStripped = path.join(tmp, 'stripped'); sh('strip', ['-s', '-o', allStripped, pie]);
  const e3 = await E.open(new Uint8Array(fs.readFileSync(allStripped)), { name: 'prog' });
  rep = await E.resolveFrames(e3, T.parse(txt2).frames, {}, {});
  ok(rep.items[0].status !== 'line' && rep.notes.some((n) => /已 strip/.test(n)), 'fully stripped: reported');
  // ---------------------------------------------------------------- bad input
  let err = ''; try { await E.open(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64])); } catch (e) { err = e.message; }
  ok(/not an ELF/.test(err), 'not an ELF is refused: ' + err);
  err = ''; try { await E.open(new Uint8Array(fs.readFileSync(pie)).subarray(0, 3000)); } catch (e) { err = e.message; }
  ok(/truncated|past the end/.test(err), 'truncated file is refused: ' + err);
  // demangler
  ok(E.demangle('_ZN3foo3barEv') === 'foo::bar' && E.demangle('_Z3bazi') === 'baz' && E.demangle('plain') === 'plain' && E.demangle('_ZN3FooC2Ev') === 'Foo::Foo', 'simple demangling');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(2); });
