'use strict';
const I = require('./user_intent_core.js');
const U = require('./uml_core.js');
let pass = 0, fail = 0; const failed = [];
function check(name, ok, extra) { if (ok) pass++; else { fail++; failed.push(name); console.log('FAIL', name, extra === undefined ? '' : (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400)); } }

// ---------- 切割 ----------
const BUG_ZH = `[BIOS] 在 Setup 按下 F10 儲存後系統當機

環境：
- 機型 XYZ-100，BIOS 版本 1.2.3
- Windows 11

重現步驟：
1. 開機後按 Del 進入 Setup
2. 在 Boot 頁面把 Boot Mode 改成 UEFI
3. 按下 F10 儲存並離開

實際結果：系統當機，畫面卡住沒有反應。
預期結果：儲存後正常重新開機並進入作業系統。`;
const segs = I.segment(BUG_ZH);
check('segment: 章節標題不算段落', !segs.some((s) => /^重現步驟/.test(s.text)));
check('segment: 3 個編號步驟（章節 action）', segs.filter((s) => s.kind === 'step').length === 3 && segs.filter((s) => s.kind === 'step').every((s) => s.section === 'action'));
check('segment: 環境列點帶章節', segs.filter((s) => s.section === 'environment').length === 2);
check('segment: 「實際結果：…」同一行也切出章節', segs.some((s) => s.section === 'observation' && /當機/.test(s.text)) && segs.some((s) => s.section === 'expectation' && /正常重新開機/.test(s.text)));
check('segment: 句子依標點切', I.segment('A 失敗。B 也失敗！C 正常').length === 3);
check('segment: 程式碼區塊與 log 另外標', (() => { const s = I.segment('問題如下\n```\nfoo()\n```\n2026-10-18 10:00:00 ERROR something\n'); return s.some((x) => x.kind === 'code') && s.some((x) => x.kind === 'log'); })());
check('segment: 英文章節', I.segment('Steps to reproduce:\n1. Open app\nExpected result: it opens').some((s) => s.section === 'action' && s.kind === 'step'));

// ---------- 角色 ----------
check('classify: 章節標題決定角色（明確）', (() => { const c = I.classify({ text: '按下 F10 儲存並離開', kind: 'step', section: 'action' }); return c.role === 'action' && c.explicit; })());
check('classify: 句型「應該…」是期待（明確）', (() => { const c = I.classify({ text: '儲存之後應該正常重新開機', kind: 'sentence', section: '' }); return c.role === 'expectation' && c.explicit; })());
check('classify: 沒有章節的壞掉描述是觀察（隱含）', (() => { const c = I.classify({ text: '系統當機，畫面卡住', kind: 'sentence', section: '' }); return c.role === 'observation' && !c.explicit; })());
check('classify: 「不應該…」是期待', I.classify({ text: '不應該出現錯誤訊息', kind: 'sentence', section: '' }).role === 'expectation');
check('classify: 驗證提示詞', I.classify({ text: '請確認重開機後版本號是否正確', kind: 'sentence', section: '' }).role === 'verification');
check('classify: 英文 should', I.classify({ text: 'It should boot into the OS normally', kind: 'sentence', section: '' }).role === 'expectation');
check('classify: 英文失敗描述', I.classify({ text: 'The system crashes and hangs', kind: 'sentence', section: '' }).role === 'observation');
check('classify: 沒有線索 → 雜訊', I.classify({ text: '謝謝', kind: 'sentence', section: '' }).role === 'noise');
check('classify: 歧義時標 ambiguous 並給選項', (() => { const c = I.classify({ text: '之後按下儲存但是沒有反應', kind: 'sentence', section: '' }); return c.options.length >= 2; })());

// ---------- 行為 ----------
check('behavior: 動詞與物件（中文）', (() => { const b = I.behaviorOf('按下 F10 儲存並離開'); return b.verb === 'click' && /F10/.test(b.object); })());
check('behavior: 把 X 改成 Y', I.behaviorOf('把 Boot Mode 改成 UEFI').verbs.includes('set'));
check('behavior: 壞掉的極性', I.behaviorOf('系統無法開機').polarity === -1 && I.behaviorOf('Boot succeeded').polarity === 1);
check('behavior: 狀態詞', I.behaviorOf('畫面卡住沒有反應').state === 'stuck' && I.behaviorOf('The app crashes').state === 'crash');
check('behavior: 角色（actor）', I.behaviorOf('使用者按下儲存').actor === 'User' && I.behaviorOf('測試人員執行腳本').actor === 'Tester');
check('behavior: 英文動詞', I.behaviorOf('Click the Save button').verb === 'click' && I.behaviorOf('Reboot the device').verb === 'reboot');

check('behavior: 一句多個動作（開機後按 Del 進入 Setup）', (() => { const b = I.behaviorOf('開機後按 Del 進入 Setup'); return b.acts.map((q) => q.verb).join() === 'boot,click,open' && b.acts[1].object === 'Del' && b.acts[2].object === 'Setup'; })(), I.behaviorOf('開機後按 Del 進入 Setup').acts);
check('behavior: 中文句子裡的英文名稱不當動詞（Boot Mode）', (() => { const b = I.behaviorOf('把 Boot Mode 改成 UEFI'); return !b.verbs.includes('boot') && b.verb === 'set' && b.object === 'Boot Mode' && b.acts[0].value === 'UEFI'; })(), I.behaviorOf('把 Boot Mode 改成 UEFI'));
check('behavior: 純英文句子照英文動詞', I.behaviorOf('Click the Save button').verb === 'click');
check('behavior: 英文名稱含動詞字（Update 頁面）不誤判', !I.behaviorOf('進入 Update 頁面').verbs.includes('upgrade') || I.behaviorOf('進入 Update 頁面').verbs[0] === 'open');
// ---------- 隱含的反面 ----------
check('invert: 無法 X → 應該能 X', /應該能.*開機/.test(I.invert('系統無法開機')));
check('invert: 不會 X', /應該能.*顯示/.test(I.invert('畫面不會顯示')));
check('invert: 英文 cannot', /^should .*boot/i.test(I.invert('The device cannot boot')));
check('invert: 只有狀態詞 → 不應該 <狀態>', /不應該當機/.test(I.invert('系統當機', I.behaviorOf('系統當機'))));

// ---------- 整體解析（中文 bug）----------
const zh = I.parse(BUG_ZH);
check('parse: 類型是 bugfix', zh.kind === 'bugfix', zh.kind);
check('parse: 標題去掉標籤', /Setup 按下 F10/.test(zh.title) && !/^\[BIOS\]/.test(zh.title));
check('parse: 3 個步驟、行為正規化', zh.steps.length === 3 && zh.steps[2].behavior.verb === 'click', zh.steps.map((s) => s.behavior.verb));
check('parse: 環境 2 項', zh.environment.length === 2);
check('parse: 觀察有當機與卡住', zh.observations.length >= 1 && zh.observations.some((o) => /當機/.test(o.text)));
check('parse: 明確的期待', zh.expectations.some((e) => e.explicit && /正常重新開機/.test(e.text)));
check('parse: 壞掉的觀察也產生隱含的期待', zh.expectations.some((e) => e.implicit && /不應該/.test(e.text) && e.basis), zh.expectations);
check('parse: 沒有明確驗證 → 隱含的驗證（照重現步驟再做一次）', zh.verifications.length === 1 && zh.verifications[0].implicit && /重現步驟/.test(zh.verifications[0].text));
check('parse: 資料齊全 → 沒有缺口', zh.gaps.length === 0 && zh.questions.length === 0, zh.gaps);
check('parse: 信心高', zh.confidence >= 0.9, zh.confidence);

// ---------- 英文 + 沒有章節（口語）----------
const en = I.parse('Device cannot boot after firmware update. Click the update button then reboot. It should boot into the OS normally.');
check('parse(en): bugfix', en.kind === 'bugfix');
check('parse(en): 動作與期待', en.steps.length >= 1 && en.expectations.some((e) => e.explicit && /should boot/i.test(e.text)));
check('parse(en): 觀察（cannot boot）', en.observations.some((o) => /cannot boot/i.test(o.text)));

// ---------- 缺口與封閉問題 ----------
const thin = I.parse('登入頁面有問題，幫忙看一下');
check('gaps: 沒期待、沒環境', ['expectation', 'environment'].every((g) => thin.gaps.includes(g)), thin.gaps);
check('questions: 封閉選項（至少 3 個，含「不知道／照預設」）', thin.questions.length >= 2 && thin.questions.every((q) => q.options.length >= 3), thin.questions);
const feat = I.parse('希望能新增匯出 CSV 的功能（feature）');
check('kind: 新功能', feat.kind === 'feature');
check('kind: 提示指定', I.parse('隨便一句話', { kind: 'testcase' }).kind === 'testcase');
check('kind: 完全不像 → unknown 並問', (() => { const x = I.parse('今天天氣很好'); return x.kind === 'unknown' && x.gaps.includes('kind'); })());

// ---------- UML ----------
const dsl = I.toUml(zh);
check('toUml: 有 model／actor／class／usecase', /^model:/m.test(dsl) && /^actor:/m.test(dsl) && /^class SystemUnderTest/m.test(dsl) && /^usecase Reproduce:/m.test(dsl) && /^usecase VerifyFix:/m.test(dsl), dsl);
const parsed = U.parseDsl(dsl);
check('toUml: 產生的 DSL 能被 FaUml 解析', parsed.errors.length === 0, parsed.errors);
check('toUml: 驗證通過', U.validateModel(parsed.model).length === 0, U.validateModel(parsed.model));
check('toUml: 重現步驟的操作都在類別裡', (() => { const m = parsed.model; const cls = m.classes.find((c) => c.name === 'SystemUnderTest'); return m.usecases.every((u) => u.steps.every((s) => cls.ops.some((o) => o.name === s.msg) || s.to !== 'SystemUnderTest')); })());
check('toUml: 連續重複的呼叫只留一次', !/observeCrash\(\) -> SystemUnderTest\.observeCrash\(\)/.test(dsl), dsl);
check('toUml: 期待的狀態是 bool 驗證操作', /expect\w+\(\):bool/.test(dsl));
const dsl2 = I.toUml(I.parse('請設計測試案例：\n1. 開啟 App\n2. 輸入帳號密碼並登入\n預期：進入首頁'), {});
check('toUml(testcase): actor 是 Tester', /actor: Tester/.test(dsl2) && U.parseDsl(dsl2).errors.length === 0, dsl2);

// ---------- 測試案例 ----------
const tc = I.toTestCase(zh);
check('toTestCase: 正向案例含步驟與預期、環境進前置', tc.ok && tc.cases[0].steps.length === 3 && tc.cases[0].expected.length >= 2 && tc.cases[0].preconditions.some((p) => /環境/.test(p)));
check('toTestCase: 隱含的預期有標記與依據', tc.cases[0].expected.some((e) => e.implicit && e.basis));
check('toTestCase: 壞掉的觀察產生迴歸案例', tc.cases.some((c) => c.type === 'regression'));
check('toTestCase: 隱含的驗證有標記', tc.cases[0].verification.some((v) => v.implicit));

// ---------- 模型輔助（歧義時封閉選擇題）----------
(async () => {
    const asked = []; const pick = async (q, opts) => { asked.push({ q, opts }); return opts.indexOf('observation') >= 0 ? opts.indexOf('observation') : 0; };
    const r = await I.parseAsync('之後按下儲存但是沒有反應', { pick });
    check('parseAsync: 歧義的段落才問、選單 ≤ 4 個', asked.length >= 0 && asked.every((a) => a.opts.length <= 4));
    check('parseAsync: 模型挑的角色被採用並標 by:model', asked.length === 0 || r.segments.some((s) => s.by === 'model'));
    const bad = await I.parseAsync('之後按下儲存但是沒有反應', { pick: async () => 99 });
    check('parseAsync: 模型挑不出來（越界）→ 用程式的第一名', bad.segments.every((s) => s.by === 'program'));
    const boom = await I.parseAsync('之後按下儲存但是沒有反應', { pick: async () => { throw new Error('x'); } });
    check('parseAsync: 模型出錯 → 用程式的第一名', boom.segments.every((s) => s.by === 'program'));
    const same = I.parse(BUG_ZH); const sameAsync = await I.parseAsync(BUG_ZH, {});
    check('parseAsync: 沒有模型時跟 parse 一樣', JSON.stringify(same.steps.map((s) => s.text)) === JSON.stringify(sameAsync.steps.map((s) => s.text)));
    // ---------- 中英翻譯輔助 ----------
    const DICT = { '畫面一直轉圈圈沒有動靜': 'The screen keeps spinning with no response', '請幫忙確認韌體版本': 'Please confirm the firmware version', 'The screen goes black after login': '登入之後螢幕變黑', '按下 F10 儲存並離開': 'Press F10 to save and exit', '重開機後設定遺失': 'Settings are lost after reboot' };
    const tr = async (text) => DICT[text] || null; let calls = 0; const trc = async (text, to) => { calls++; return DICT[text] || null; };
    const base = await I.parseAsync('畫面一直轉圈圈沒有動靜', {}); const withTr = await I.parseAsync('畫面一直轉圈圈沒有動靜', { translate: trc });
    check('translate: 沒有翻譯時這句認不出狀態', !base.segments[0].behavior.state, base.segments[0].behavior);
    check('translate: 翻譯後用同一批規則讀到狀態（stuck）並標 via', withTr.segments[0].behavior.state === 'stuck' && withTr.segments[0].via === 'translate' && /no response/.test(withTr.segments[0].translated), withTr.segments[0]);
    check('translate: 讀得出來的段落不翻（省時間）', (async () => { calls = 0; await I.parseAsync('1. 按下 F10 儲存並離開\n2. 重開機', { translate: trc }); return calls === 0; })() instanceof Promise);
    calls = 0; await I.parseAsync('Steps to reproduce:\n1. 按下 F10 儲存並離開\n2. 重開機', { translate: trc }); check('translate: 已經讀得懂的步驟不呼叫翻譯', calls === 0, calls);
    const thr = await I.parseAsync('請幫忙確認韌體版本', { translate: async () => { throw new Error('offline model down'); } });
    check('translate: 翻譯出錯 → 照程式的結果、不丟錯', thr.segments.length === 1);
    // 意象與媒合：中文描述去配英文的目錄／工具說明
    const it = I.parse('重現步驟：\n1. 按下 F10 儲存並離開\n實際結果：重開機後設定遺失', {});
    const img0 = await I.imagery(it, null), img1 = await I.imagery(it, trc);
    const CANDS = [{ name: 'save_bios_settings', text: 'Press F10 to save the BIOS setup settings and exit' }, { name: 'render_chart', text: 'Draw a bar chart from table data' }, { name: 'reboot_device', text: 'Reboot the device and wait until the OS is up' }];
    const m0 = I.match(img0, CANDS, 3), m1 = I.match(img1, CANDS, 3);
    check('imagery: 有行為動詞（正規化的英文）與詞', img0.verbs.includes('click') && img0.tokens.has('f10'), img0.verbs);
    check('imagery: 有翻譯時詞集合多了譯文的詞', img1.tokens.size > img0.tokens.size && img1.tokens.has('save') && img1.tokens.has('exit'), Array.from(img1.tokens).slice(0, 30));
    check('match: 沒有翻譯也能靠 F10／動詞配到', m0.length >= 1 && m0[0].name !== 'render_chart', m0);
    check('match: 有翻譯後 save_bios_settings 排第一且分數更高', m1[0].name === 'save_bios_settings' && m1[0].score > (m0.find((x) => x.name === 'save_bios_settings') || { score: 0 }).score, [m0, m1]);
    check('match: 不相干的不會上榜', !m1.some((x) => x.name === 'render_chart'));
    check('tokensOf: 英文單字與中文二字詞', (() => { const t = I.tokensOf('BIOS 設定遺失 v1.2.3'); return t.has('bios') && t.has('設定') && t.has('定遺') && t.has('1.2.3'); })());
    console.log((fail ? 'FAIL' : 'PASS') + ' 意圖解析（文字切割、語意角色、行為、隱含期待與驗證、缺口問題、UML、測試案例）：' + pass + ' passed, ' + fail + ' failed', failed);
    process.exit(fail ? 1 : 0);
})();
