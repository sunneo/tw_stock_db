// 老師迴圈接離線組合（真實 Electron）：① _otTeacherTryOffline 對 Python 判題項目走離線組合；② 老師的解答用 deriveLesson 抽成執行期的課（要自己重做過判題才收）、存、匯出；③ 抽不成課／沒過的不收。
// 用法：xvfb-run -a node scripts/eval/run_eval.js scripts/eval/teach-lesson.eval.js 17962
const fa = window.fa; const R = {};
const api = window.desktopAPI; const execApi = api.exec || api.execApi || null; if (execApi && execApi.setSettings) await execApi.setSettings({ execEnabled: true, execConfirmRequired: false });
try { localStorage.removeItem('fa_py_runtime_lessons'); } catch (_) {} fa._pyRuntimeLessons = null;
// ① 離線組合（不給模型）做得出的項目
const st = '輸入 n（0<=n<=90），輸出第 n 個費氏數（F0=0, F1=1）。';
const chk = FaTeacherCheck.normalize({ kind: 'judge', lang: 'python', tests: [{ in: '10\n', out: '55\n' }, { in: '0\n', out: '0\n' }, { in: '1\n', out: '1\n' }] }).check;
const item = { key: st, check: chk };
const off = await fa._otTeacherTryOffline(st, { opts: {} }, item); R.tryOffline = { ok: off.ok, by: off.by };
R.tryOfflineChecked = off.ok ? (await fa._otTeacherCheck(item, off.output)).ok : null;
// ② 老師的解答 → 課（用一個沒有範式的算法：把 algo 認成 fib，但這裡只驗證流程；解答用矩陣快速冪寫法，跟內建不同）
const teacher = 'def solve(n):\n    def mul(a, b):\n        return [[a[0][0]*b[0][0]+a[0][1]*b[1][0], a[0][0]*b[0][1]+a[0][1]*b[1][1]], [a[1][0]*b[0][0]+a[1][1]*b[1][0], a[1][0]*b[0][1]+a[1][1]*b[1][1]]]\n    r = [[1, 0], [0, 1]]\n    m = [[1, 1], [1, 0]]\n    while n:\n        if n & 1:\n            r = mul(r, m)\n        m = mul(m, m)\n        n >>= 1\n    print(r[0][1])\n';
const l1 = await fa._pyLearnLesson(st, teacher, item); R.learn = { ok: l1.ok, uniqueId: !!(l1.lesson && l1.lesson.id !== 'fib#1'), reason: l1.reason, id: l1.lesson && l1.lesson.id, algo: l1.lesson && l1.lesson.algo };
R.stored = fa._pyLessonsLoad().length; R.persisted = JSON.parse(localStorage.getItem('fa_py_runtime_lessons') || '[]').length; R.exportOk = JSON.parse(fa._pyLessonsExport()).lessons.length;
// ③ 錯的解答不收
const wrong = 'def solve(n):\n    print(n)\n'; const l2 = await fa._pyLearnLesson(st, wrong, item); R.wrongRejected = !l2.ok; R.wrongReason = l2.reason;
const l3 = await fa._pyLearnLesson('今天天氣好不好', 'def solve(n):\n    pass\n', item); R.unknownRejected = !l3.ok;
// ④ 老師迴圈整合：離線重做不出來（桩）、但老師回報的 Python 解答在程式碼圍欄裡 → 迴圈要把它抽成課，項目算教會；回歸失敗要把課移除
try { localStorage.removeItem('fa_py_runtime_lessons'); } catch (_) {} fa._pyRuntimeLessons = null;
{ const keep = { tryOff: fa._otTeacherTryOffline, run: fa._runSubAgentTask, auto: fa.advancedSettings.offlineAutoTrain, regress: fa._otTeacherRegress, save: fa._otTeacherSave, snap: fa._otTeacherSnapshot, restore: fa._otTeacherRestore };
  try {
    fa.advancedSettings.offlineAutoTrain = 'on'; fa._otTeacherTryOffline = async () => ({ ok: false, why: '桩：離線沒做出來' }); fa._otTeacherSave = async () => {}; fa._otTeacherSnapshot = async () => ({}); fa._otTeacherRestore = async () => ({ ok: true });
    fa._runSubAgentTask = async () => ({ text: '解法：\n```python\n' + teacher + '\n```\n{"status":"solved","summary":"矩陣快速冪","extended":["x"]}' });
    const mkS = () => ({ id: 's_t', goal: '費氏', state: 'running', mode: 'single', items: [{ key: st, status: 'pending', attempts: 0, check: chk }], idx: 0, opts: { maxRounds: 8, maxTeach: 1, delayMs: 0, maxFailures: 3 }, log: [], consecutiveFailures: 0 });
    fa._otTeacherRegress = async () => []; const s1 = mkS(); await fa._otTeacherLoop(s1); const it = s1.items[0];
    R.loopFromTeacherCode = { status: it.status, verified: !!it.verified, lesson: it.lesson, from: it.lessonFrom, stored: fa._pyLessonsLoad().length };
    try { localStorage.removeItem('fa_py_runtime_lessons'); } catch (_) {} fa._pyRuntimeLessons = null;
    fa._otTeacherRegress = async () => [{ key: 'x', why: '退步' }]; const s2 = mkS(); await fa._otTeacherLoop(s2);
    R.regressRemovesLesson = { status: s2.items[0].status, stored: fa._pyLessonsLoad().length };
  } finally { fa._otTeacherTryOffline = keep.tryOff; fa._runSubAgentTask = keep.run; fa.advancedSettings.offlineAutoTrain = keep.auto; fa._otTeacherRegress = keep.regress; fa._otTeacherSave = keep.save; fa._otTeacherSnapshot = keep.snap; fa._otTeacherRestore = keep.restore; } }
try { localStorage.removeItem('fa_py_runtime_lessons'); } catch (_) {} fa._pyRuntimeLessons = null;
return R;
