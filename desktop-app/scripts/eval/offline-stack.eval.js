// 離線思考堆疊接線的實機驗證（真的 Electron）：node scripts/eval/code-slash.run.js offline-stack
const fa = window.fa; const R = {};
R.module = typeof FaOfflineStack !== 'undefined';
R.wire_fail = await fa._offlineStackWire('求陣列最大值', { ok: false, rounds: [{ by: 'recipe', ok: false, reason: '沒有配方' }, { by: 'paradigm', ok: false, tried: 3, reason: '都沒過' }] });
R.wire_ok = await fa._offlineStackWire('求陣列最大值', { ok: true, source: 'def main():\n    print(1)\n', rounds: [{ by: 'paradigm', ok: true, tried: 2 }] });
try {
  const bridge = fa._codeJudgeBridge(); R.judge = !!bridge.judge;
  const tests = [{ in: '5\n3 1 4 1 5\n', out: '5\n' }, { in: '3\n-1 -2 -3\n', out: '-1\n' }];
  const r = await fa._codeOffline({ text: '給一個整數 n 和 n 個整數，輸出其中的最大值。', problem: { id: 't', title: 't', statement: '給一個整數 n 和 n 個整數，輸出其中的最大值。', tests } }, bridge);
  R.offline = { ok: r.ok, reason: r.reason, by: r.by, hasStack: Array.isArray(r.stack), stackLines: r.stack && r.stack.length, stuckAt: r.stuckAt, stackNote: r.stackNote, rounds: (r.rounds || []).map((x) => x.by + (x.ok ? '✔' : '✘')) };
} catch (e) { R.offline = 'ERR ' + e.message; }
return R;
