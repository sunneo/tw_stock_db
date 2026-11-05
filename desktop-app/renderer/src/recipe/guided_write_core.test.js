// node renderer/src/recipe/guided_write_core.test.js
// 文法引導寫作：機械演算法算出每個位置合法的 token，模型（這裡用「神諭選擇器」——它知道目標程式，但只能從文法給出的合法選項裡挑）做選擇題。
// 神諭走得完＝文法的合法選項涵蓋了目標程式的每一步；走不完＝文法有洞。這不是模型能力的證據，只證明機械那一半是對的。
const assert = require('assert'); const fs = require('fs'); const path = require('path');
const W = require('./guided_write_core.js'); const F = require('./syntax_fix_core.js'); const G = require('./grammar_core.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };

const { makeOracle } = require('./code_loop_fake.js');

const PYFN = { add: 'def add(a, b):\n    return a + b\n', loops: 'def f(xs, k):\n    total = 0\n    for i in range(len(xs)):\n        if xs[i] > k:\n            total += xs[i]\n        elif xs[i] == k:\n            total -= 1\n        else:\n            continue\n    while total > 100:\n        total //= 2\n    return total\n' };
const BR = {
  c: ['long long add(long long a, long long b) { return a + b; }', 'int f(int *a, int n) {\n  int s = 0;\n  for (int i = 0; i < n; i++) { if (a[i] % 2 == 0) s += a[i]; else continue; }\n  printf("%d\\n", s);\n  return s;\n}'],
  cpp: ['int f(vector<int> &v) {\n  int s = 0;\n  for (int i = 0; i < (int)v.size(); i++) { s += v[i]; }\n  cout << s << endl;\n  return s;\n}'],
  java: ['static int f(int[] a) {\n  int s = 0;\n  for (int x : a) { s += x; }\n  System.out.println(s);\n  return s;\n}'],
  csharp: ['static int F(int[] a) {\n  int s = 0;\n  foreach (var x in a) { s += x; }\n  Console.WriteLine(s);\n  return s;\n}'],
  nodejs: ["function f(a) {\n  let s = 0;\n  for (const x of a) { s += x; }\n  console.log(s);\n  return s;\n}"]
};
const sigOf = (lang, src) => lang === 'python' ? src.split('\n')[0].replace(/:\s*$/, '') : src.slice(0, src.indexOf('{')).trim();

(async () => {
  await t('python：神諭只能從文法給的合法選項挑，兩個函式（含 for／if／elif／else／while、縮排進出）完整寫出且和目標一致', async () => {
    for (const [k, src] of Object.entries(PYFN)) { const o = makeOracle('python', src); const r = await W.guidedWriteFunction({ lang: 'python', spec: '示範', node: { name: k === 'add' ? 'add' : 'f', signature: sigOf('python', src), purpose: '' }, choose: o.choose, free: o.choose && o.free, onEvent: o.onEvent, opts: { maxChoices: 900 } }); assert.ok(r.ok, k + ' → ' + r.reason + ' ' + (r.detail || '') + JSON.stringify(o.stats.misses.slice(0, 2)) + ' trace=' + JSON.stringify(r.trace.slice(-6)) + ' code=' + JSON.stringify(r.code)); assert.strictEqual(r.code.replace(/\s+/g, ''), src.replace(/\s+/g, ''), k + '\n' + r.code); }
  });
  await t('python：20 個種子程式的每個函式都能由神諭走完；組起來真的跑，全部 AC（機械那一半是對的）', async () => {
    const R = require('../../../judge-runner.js'); const C = require('./code_loop_core.js'); const probs = fs.readFileSync(path.join(__dirname, 'seed', 'problems.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); let totalChoose = 0, totalFree = 0, fns = 0;
    for (const p of probs) {
      const src = p.ref.python; const chunks = src.split(/\n(?=def )/); const pre = chunks.filter((x) => !/(^|\n)def /.test(x)); const parts = chunks.filter((x) => /(^|\n)def /.test(x)); const names = parts.map((x) => /def (\w+)/.exec(x)[1]); const codes = pre.map((x) => x.replace(/\s+$/, '') + '\n'); // 非函式的前置行（import）原樣
      for (const part of parts) { const nm = /def (\w+)/.exec(part)[1]; const text = part.replace(/\s+$/, '') + '\n'; const o = makeOracle('python', text); const r = await W.guidedWriteFunction({ lang: 'python', spec: p.statement, node: { name: nm, signature: sigOf('python', text), purpose: '' }, plan: names.map((x) => ({ name: x, signature: 'def ' + x + '()' })), choose: o.choose, free: o.choose && o.free, onEvent: o.onEvent, opts: { maxChoices: 900 } });
        assert.ok(r.ok, p.id + '.' + nm + ' → ' + r.reason + ' ' + (r.detail || '') + ' ' + JSON.stringify(o.stats.misses.slice(0, 2)) + '\ncode so far:\n' + r.code + '\ntrace tail=' + JSON.stringify(r.trace.slice(-16))); totalChoose += r.calls.choose; totalFree += r.calls.free; fns++; codes.push((r.imports || []).join('\n') + '\n' + r.code); }
      const program = C.assemble('python', codes); const res = await R.judge({ lang: 'python', source: program, problem: p }); assert.strictEqual(res.verdict, 'AC', p.id + ' → ' + res.verdict + ' ' + res.detail + '\n' + program);
    }
    console.log('    （' + fns + ' 個函式，平均每個 ' + (totalChoose / fns).toFixed(1) + ' 次選擇題、' + (totalFree / fns).toFixed(1) + ' 次自己寫名稱／字面值）');
  });
  await t('c／cpp／java／csharp／nodejs：各自的神諭走完，輸出的本體與目標逐 token 一致（各自獨立的文法與先驗）', async () => {
    for (const lang of Object.keys(BR)) for (const src of BR[lang]) { const o = makeOracle(lang, src); const nm = /(\w+)\s*\(/.exec(sigOf(lang, src))[1]; const r = await W.guidedWriteFunction({ lang, spec: '示範', node: { name: nm, signature: sigOf(lang, src), purpose: '' }, choose: o.choose, free: o.choose && o.free, onEvent: o.onEvent, opts: { maxChoices: 900 } }); assert.ok(r.ok, lang + ' ' + nm + ' → ' + r.reason + ' ' + (r.detail || '') + ' ' + JSON.stringify(o.stats.misses.slice(0, 2))); const got = F.lex(lang, r.code).map((x) => x.v).join(' '); const want = F.lex(lang, src).map((x) => x.v).join(' '); assert.strictEqual(got, want, lang + '\n' + r.code); }
  });
  await t('選項的過濾是機械的、各語言各自的：C 的選項沒有 new／instanceof；Java 沒有指標與 sizeof；asm 預設不出現、只有 C／C++ 且明說才開', async () => {
    const opts = (lang, prefix, extra) => { const E = G.expectedAt(lang, F.lex(lang, prefix)); return W.buildOptions(lang, E.expected, F.lex(lang, prefix), Object.assign({ lang, plan: [], ext: {}, own: 'f' }, extra || {})); };
    const c = opts('c', 'int f(void) { '), j = opts('java', 'class A { void f() { '), cp = opts('cpp', 'int f() { ');
    assert.ok(!c.kw.includes('asm') && !c.kw.includes('__asm__') && !cp.kw.includes('asm'), 'asm 預設被機械丟掉'); assert.ok(opts('c', 'int f(void) { ', { allowInlineAsm: true }).kw.includes('__asm__') && opts('cpp', 'int f() { ', { allowInlineAsm: true }).kw.includes('asm'));
    assert.ok(!j.kw.includes('asm') && !opts('java', 'class A { void f() { ', { allowInlineAsm: true }).kw.includes('asm'), 'Java 沒有 asm，開了旗標也沒有');
    assert.ok(!c.kw.includes('new') && !c.kw.includes('throw') && c.kw.includes('return') && c.kw.includes('if')); assert.ok(j.kw.includes('new') && j.kw.includes('throw') && !j.kw.includes('sizeof') && !j.punct.includes('&'));
    assert.ok(c.punct.includes('*') && c.punct.includes('&')); assert.ok(W.MEMBERS.c.length === 0 && W.MEMBERS.python.includes('append') && !W.MEMBERS.python.includes('push_back') && W.MEMBERS.cpp.includes('push_back'));
  });
  await t('機械可決定的自動補（不問模型）：標頭之後的 { 或 :；只有一個合法選項時；簽名在文法上不合法就拒絕', async () => {
    let asked = 0; const never = async () => { asked++; return null; };
    const r = await W.guidedWriteFunction({ lang: 'python', node: { name: 'f', signature: 'def f(a b)', purpose: '' }, choose: never, free: never }); assert.ok(!r.ok && r.reason === 'bad_signature'); assert.strictEqual(asked, 0);
    const r2 = await W.guidedWriteFunction({ lang: 'c', node: { name: 'f', signature: 'int f(int a)', purpose: '' }, choose: never, free: never }); assert.ok(!r2.ok && r2.reason === 'choose_failed' && asked >= 1, '本體的 { 是自動補的，第一個要選的才問模型');
    assert.ok(r2.code.startsWith('int f(int a) {'));
    assert.strictEqual((await W.guidedWriteFunction({ lang: 'ruby', node: { name: 'f', signature: 'def f' }, choose: never })).reason, 'unsupported_lang');
  });
  await t('模型亂選／沒答：不會寫出非法程式；預算與步數有上限；free 寫出不合法的名稱會被拒絕', async () => {
    const o = makeOracle('c', BR.c[0]); let bad = 0; const choose = async (m, opts) => { bad++; return null; }; const r = await W.guidedWriteFunction({ lang: 'c', node: { name: 'add', signature: 'long long add(long long a, long long b)' }, choose, free: o.free }); assert.ok(!r.ok && r.reason === 'choose_failed');
    const r2 = await W.guidedWriteFunction({ lang: 'python', node: { name: 'f', signature: 'def f(a)' }, choose: async (m, opts) => 0, free: async () => 'if', opts: { maxChoices: 5 } }); assert.ok(!r2.ok && ['max_choices', 'free_failed', 'max_steps', 'grammar_stuck', 'no_legal_option', 'choose_failed'].includes(r2.reason), r2.reason);
  });
  await t('importsFor：各語言各自的規則（C 依用到的名稱補 stdio／stdlib；Java 補 java.util；C# 補 System；Python 補 sys／collections；nodejs 補 fs）', async () => {
    assert.deepStrictEqual(W.importsFor('c', ['printf', 'qsort', 'x']), ['#include <stdio.h>', '#include <stdlib.h>']); assert.deepStrictEqual(W.importsFor('java', ['Scanner', 'x']), ['import java.util.*;']); assert.deepStrictEqual(W.importsFor('python', ['sys', 'deque']), ['import sys', 'from collections import deque']);
    assert.ok(W.importsFor('cpp', []).includes('using namespace std;') && W.importsFor('csharp', []).includes('using System;') && W.importsFor('nodejs', ['fs']).length === 1); assert.deepStrictEqual(W.importsFor('c', ['x']), []);
  });
  await t('rank 策略（約束解碼）：機械給合法集合、語言模型游標打分取最高；python 兩個函式與 20 個種子程式的每個函式都走得完，沒有任何一次字母選擇題', async () => {
    const { makeFakeLm } = require('./code_loop_fake.js');
    const expectedOf = (lang, src) => { const lines = (() => { const toks = F.lex('python', src); const out = []; let cur = null; toks.forEach((x) => { if (x.t === 'nl') { cur = null; return; } if (!cur) { cur = { col: x.col, tokens: [] }; out.push(cur); } cur.tokens.push({ t: x.t, v: x.v }); }); const cols = Array.from(new Set(out.map((l) => l.col))).sort((a, b) => a - b); return out.map((l) => ({ level: cols.indexOf(l.col), tokens: l.tokens })); })(); return W.renderPython(lines).replace(/\n$/, '') + '<|im_end|>'; };
    for (const [k, src] of Object.entries(PYFN)) { const lm = makeFakeLm(expectedOf('python', src)); const r = await W.guidedWriteFunction({ lang: 'python', spec: '示範', node: { name: k === 'add' ? 'add' : 'f', signature: sigOf('python', src), purpose: '' }, lm, choose: async () => { throw new Error('rank 策略不該問字母選擇題'); }, free: async () => { throw new Error('不該呼叫 free'); } }); assert.ok(r.ok, k + ' → ' + r.reason + ' ' + (r.detail || '') + '\n' + r.code); assert.strictEqual(r.code.replace(/\s+/g, ''), src.replace(/\s+/g, ''), k + '\n' + r.code); assert.ok(r.calls.rank > 0 && r.calls.choose === 0); assert.strictEqual(lm.stats.opens, 1, '一個函式只開一次游標（KV 快取增量提交）'); }
    const R = require('../../../judge-runner.js'); const C = require('./code_loop_core.js'); const probs = fs.readFileSync(path.join(__dirname, 'seed', 'problems.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); let ranks = 0, fns = 0;
    for (const p of probs) { const chunks = p.ref.python.split(/\n(?=def )/); const pre = chunks.filter((x) => !/(^|\n)def /.test(x)); const parts = chunks.filter((x) => /(^|\n)def /.test(x)); const names = parts.map((x) => /def (\w+)/.exec(x)[1]); const codes = pre.map((x) => x.replace(/\s+$/, '') + '\n');
      for (const part of parts) { const nm = /def (\w+)/.exec(part)[1]; const text = part.replace(/\s+$/, '') + '\n'; const lm = makeFakeLm(expectedOf('python', text)); const r = await W.guidedWriteFunction({ lang: 'python', spec: p.statement, node: { name: nm, signature: sigOf('python', text), purpose: '' }, plan: names.map((x) => ({ name: x, signature: 'def ' + x + '()' })), lm }); assert.ok(r.ok, p.id + '.' + nm + ' → ' + r.reason + ' ' + (r.detail || '') + '\n' + r.code); ranks += r.calls.rank; fns++; codes.push((r.imports || []).join('\n') + '\n' + r.code); }
      const res = await R.judge({ lang: 'python', source: C.assemble('python', codes), problem: p }); assert.strictEqual(res.verdict, 'AC', p.id + ' → ' + res.verdict + ' ' + res.detail); }
    console.log('    （' + fns + ' 個函式，平均每個 ' + (ranks / fns).toFixed(1) + ' 次打分——一次打分取代一次選擇題，沒有字母格式的問題）');
  });
  console.log('\n' + n + ' passed'); process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
