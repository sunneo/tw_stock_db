// 函式行為卡（唯讀）在真 Electron：python 走完整中間語言（第二層）與行為分析器（第一層）。用法：node scripts/eval/real_electron.run.js behavior_card
// 注意：nodejs／java／c 的第一層要載入對應文法（沒快取時會用既有機制連網下載），這裡不跑，只驗 python。
const fa = window.fa; const R = {}; const ok = (k, v) => { R[k] = v; };
ok('scripts', [].slice.call(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)));
ok('tool', !!fa.tools.behavior_card);
const PY = '# 計算陣列總和\nfrom typing import List\n\n\ndef total(a: List[int]) -> int:\n    """Return the sum of all elements."""\n    # accumulator\n    s = 0\n    for x in a:  # walk the list\n        s += x\n    return s\n\n\ndef main():\n    n = int(input())\n    a = list(map(int, input().split()))\n    print(total(a))  # 輸出總和\n\n\nif __name__ == "__main__":\n    main()\n';
const call = async (a) => JSON.parse(await fa.tools.behavior_card.callback.call(fa, JSON.stringify(a)));
const before = PY;
const l2 = await call({ source: PY }); ok('python_level2', { ok: l2.ok, level: l2.level, names: (l2.cards || []).map((c) => c.name), totalStd: (l2.cards || []).find((c) => c.name === 'total') && l2.cards.find((c) => c.name === 'total').std, mainCalls: (l2.cards || []).find((c) => c.name === 'main') && l2.cards.find((c) => c.name === 'main').calls, mainEffects: (l2.cards || []).find((c) => c.name === 'main') && l2.cards.find((c) => c.name === 'main').effects, totalPure: (l2.cards || []).find((c) => c.name === 'total') && l2.cards.find((c) => c.name === 'total').pure, blocks: (l2.cards || []).find((c) => c.name === 'total') && l2.cards.find((c) => c.name === 'total').blocks, design: l2.design, readOnly: l2.readOnly, mdHead: (l2.markdown || '').split('\n').slice(0, 8) });
const l1 = await call({ source: PY, level: 1 }); ok('python_level1', { ok: l1.ok, level: l1.level, names: (l1.cards || []).map((c) => c.name), totalCalls: (l1.cards || []).find((c) => c.name === 'total') && l1.cards.find((c) => c.name === 'total').calls });
const one = await call({ source: PY, function: 'total' }); ok('function_filter', { ok: one.ok, names: (one.cards || []).map((c) => c.name) });
const missing = await call({ source: PY, function: 'nope' }); ok('missing_function', { ok: missing.ok, error: missing.error });
const empty = await call({ source: '' }); ok('empty_source', { ok: empty.ok, error: empty.error });
const lang = await call({ source: 'x = 1', language: 'ruby' }); ok('unsupported_lang', { ok: lang.ok, error: lang.error });
ok('source_unchanged', before === PY);
return R;
