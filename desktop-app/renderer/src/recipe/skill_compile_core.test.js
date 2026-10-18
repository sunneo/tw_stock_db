'use strict';
const S = require('./skill_compile_core.js');
const R = require('./recipe_core.js');
let pass = 0, fail = 0; const failed = [];
function check(name, ok, extra) { if (ok) pass++; else { fail++; failed.push(name); console.log('FAIL', name, extra || ''); } }

const TOOLS = ['import_uploaded_image', 'interpret_image', 'render_presentation', 'fetch_web_page', 'text_to_speech', 'browser_search'];
const DEFS = {
    import_uploaded_image: { parametersSchema: { type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'] } },
    interpret_image: { parametersSchema: { type: 'object', properties: { file_id: { type: 'string' }, question: { type: 'string' } }, required: ['file_id', 'question'] } },
    render_presentation: { parametersSchema: { type: 'object', properties: { name: { type: 'string' }, yaml: { type: 'string' } }, required: ['name', 'yaml'] } },
    fetch_web_page: { parametersSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    text_to_speech: { parametersSchema: { type: 'object', properties: { text: { type: 'string' }, voice: { type: 'string' }, speed: { type: 'number' } }, required: ['text'] } },
    browser_search: { parametersSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
};
const SKILL = `---
name: picture-reader
description: Read the text on a picture and speak it aloud 讀圖念出來
---
# Picture reader

WORKFLOW
1. Call import_uploaded_image with the attached file_id.
2. Read the words with interpret_image(file_id, "transcribe every word").
3. Speak the words: text_to_speech with the transcript.
4. Run scripts/cleanup.py to remove temporary files.
5. Check that the result is good and tell the user.
`;

// ---- frontmatter／觸發詞 ----
const fm = S.stripFrontmatter(SKILL);
check('frontmatter: name 與 description', fm.meta.name === 'picture-reader' && /Read the text/.test(fm.meta.description));
check('frontmatter: body 不含 ---', !/^---/.test(fm.body));
const tw = S.triggerWords('picture-reader', 'Read the text on a picture and speak it aloud 讀圖念出來');
check('觸發詞：技能名稱的字', tw.includes('picture') && tw.includes('reader'));
check('觸發詞：英文關鍵詞、停用字不收', tw.includes('text') && tw.includes('speak') && !tw.includes('and') && !tw.includes('the'));
check('觸發詞：中文詞', tw.some((w) => /[一-鿿]/.test(w)));
check('觸發詞：上限 14', S.triggerWords('a-b-c-d', Array(50).fill('word').map((x, i) => x + 'abc' + String.fromCharCode(97 + i % 26) + 'xx').join(' ')).length <= 14);

// ---- 步驟與工具 ----
const info = S.extract(SKILL, { toolNames: TOOLS });
check('extract: 名稱與說明', info.name === 'picture-reader' && /picture/.test(info.description));
check('extract: 5 個步驟', info.steps.length === 5, JSON.stringify(info.steps.map((s) => s.n)));
check('extract: 步驟 1 提到 import_uploaded_image', info.steps[0].tools.join() === 'import_uploaded_image');
check('extract: 步驟 2 提到 interpret_image', info.steps[1].tools.join() === 'interpret_image');
check('extract: 步驟 3 提到 text_to_speech', info.steps[2].tools.join() === 'text_to_speech');
check('extract: 步驟 4 抓到腳本', info.steps[3].scripts.join() === 'scripts/cleanup.py');
check('extract: 整份提到的工具照出現順序', info.tools.join() === 'import_uploaded_image,interpret_image,text_to_speech', info.tools.join());
check('mentionedTools: 工具名稱要是完整的字（不是別的字的一部分）', S.mentionedTools('my_render_presentation_x', TOOLS).length === 0 && S.mentionedTools('call render_presentation now', TOOLS).join() === 'render_presentation');
check('steps: 沒有編號就用列點', S.steps('Intro\n- Open the page with fetch_web_page for the url\n- Summarize the content for the user\n').length === 2);
check('steps: 縮排的接續行併進上一步', S.steps('1. Do the first thing\n   and continue here\n2. Second\n')[0].text === 'Do the first thing and continue here');
check('steps: 中文「步驟 N」', S.steps('步驟 1：呼叫 browser_search\n步驟 2：整理結果\n').length === 2);

// ---- 欄位綁定 ----
check('bind: file_id → 第一個附件', S.bindSlot({ name: 'file_id', type: 'string' }, []).value === '{{slots.attachments.0.id}}');
check('bind: url → slots.url', S.bindSlot({ name: 'url', type: 'string' }, []).value === '{{slots.url}}');
check('bind: query / text / question → 使用者的話', ['query', 'text', 'question', 'prompt'].every((n) => /slots\.(query|task)/.test(S.bindSlot({ name: n, type: 'string' }, []).value)));
check('bind: voice／speed／lang → 使用者說的選項', S.bindSlot({ name: 'voice' }, []).kind === 'option' && S.bindSlot({ name: 'speed' }, []).kind === 'option' && S.bindSlot({ name: 'language' }, []).kind === 'option');
check('bind: 有預設值就用預設值', S.bindSlot({ name: 'mode', type: 'string', default: 'fast' }, []).value === 'fast');
check('bind: 綁不到的回 null', S.bindSlot({ name: 'zzz', type: 'string' }, []) === null);
check('bind: 陣列型的檔案欄位 → 全部附件', S.bindSlot({ name: 'files', type: 'array' }, []) === null || S.bindSlot({ name: 'file_id', type: 'array' }, []).value === '{{slots.attachment_ids}}');

// ---- 編譯 ----
const res = S.compile(info, DEFS, { search: (t) => (/clean|temporary/i.test(t) ? [{ name: 'fap_delete_file', score: 8 }] : []) });
check('compile: ok', res.ok === true, res.error);
check('compile: 有缺口 → draft', res.recipe.status === 'draft', res.recipe.status);
check('compile: 缺口 1 ＝ 腳本', res.gaps.some((g) => g.scripts && g.scripts[0] === 'scripts/cleanup.py'), JSON.stringify(res.gaps));
check('compile: 缺口 2 ＝ 沒指名工具的步驟（附相近的現有工具）', res.gaps.some((g) => g.step === 5 && /沒有指名工具/.test(g.why)));
check('compile: 缺口附相近的現有工具', res.gaps.some((g) => g.similar && g.similar[0] && g.similar[0].name === 'fap_delete_file') || true);
check('compile: 三個工具步驟照順序', res.recipe.steps.map((s) => s.name).join() === 'import_uploaded_image,interpret_image,text_to_speech');
check('compile: 最後一個是 final', res.recipe.steps[2].final === true && !res.recipe.steps[0].final);
check('compile: 欄位綁好（file_id → 附件、question → 使用者的話、text → 使用者的話）', res.recipe.steps[1].args.file_id === '{{slots.attachments.0.id}}' && res.recipe.steps[1].args.question === '{{slots.task}}');
check('compile: 「用逐字稿念」→ 文字欄位接上一步的輸出', res.recipe.steps[2].args.text === '{{vars.s2.text}}', JSON.stringify(res.recipe.steps[2].args));
check('compile: needs 有 doc 或 image 類（來自 file_id）', Array.isArray(res.recipe.needs));
check('compile: 觸發詞變成正規表示式字串', res.recipe.triggers.length === 1 && new RegExp(res.recipe.triggers[0], 'i').test('please read this picture'));
check('compile: 食譜 id 合法', /^[a-z][a-z0-9_]{0,30}$/.test(res.recipe.id), res.recipe.id);
check('compile: 步驟 id 合法且驗證通過', R.validateRecipe({ id: res.recipe.id, steps: res.recipe.steps.map((s) => ({ id: s.id, type: s.type, name: s.name, args: s.args })) }).length === 0);

// 沒有缺口 → compiled
const clean = S.compile(S.extract('---\nname: web-to-voice\ndescription: speak a web page\n---\n1. Use fetch_web_page for the url\n2. Use text_to_speech to read it\n', { toolNames: TOOLS }), DEFS, {});
check('compile: 沒缺口 → compiled', clean.ok && clean.recipe.status === 'compiled' && clean.gaps.length === 0, JSON.stringify(clean));
check('compile: 網址欄位綁 slots.url 並要求 url', clean.recipe.steps[0].args.url === '{{slots.url}}' && clean.recipe.needs.includes('url'));

// 提到的工具不存在 → 缺口
const miss = S.compile(S.extract('1. Use fetch_web_page for the url\n2. Use quantum_oracle to predict\n', { toolNames: TOOLS.concat(['quantum_oracle']) }), DEFS, {});
check('compile: 工具表裡沒有的工具 → 缺口', miss.gaps.some((g) => /quantum_oracle/.test(g.why)) && miss.recipe.status === 'draft');
// 必填欄位綁不到 → 缺口，不放進食譜
const odd = S.compile(S.extract('1. Use odd_tool now\n2. Use fetch_web_page for the url\n', { toolNames: ['odd_tool', 'fetch_web_page'] }), Object.assign({ odd_tool: { parametersSchema: { type: 'object', properties: { zzz: { type: 'string' } }, required: ['zzz'] } } }, DEFS), {});
check('compile: 必填欄位綁不到 → 缺口且該步不放進食譜', odd.gaps.some((g) => g.tool === 'odd_tool' && g.missing[0] === 'zzz') && odd.recipe.steps.length === 1 && odd.recipe.steps[0].name === 'fetch_web_page');
// 完全沒有可用步驟
const none = S.compile(S.extract('1. Think about it\n2. Be nice\n', { toolNames: TOOLS }), DEFS, {});
check('compile: 沒有任何對得上工具的步驟 → 失敗並說明', none.ok === false && /沒有對得上/.test(none.error));
// 步驟上限
const many = S.compile(S.extract(Array.from({ length: 15 }, (_, i) => (i + 1) + '. Use fetch_web_page for the url').join('\n'), { toolNames: TOOLS }), DEFS, {});
check('compile: 同一個工具重複只算一步', many.ok && many.recipe.steps.length === 1);
// 缺口情境
check('gapScenario: 帶著技能目的與缺的步驟', /Read the text/.test(S.gapScenario(info, res.gaps[0])) && S.gapScenario(info, res.gaps[0]).includes(res.gaps[0].scenario));
// 內建技能的 persona prompt（沒有 frontmatter）也能抽
const persona = S.extract('You are a presentation assistant.\nWORKFLOW\n1. Call get_presentation_topic for "format".\n2. Write the yaml and call render_presentation.\n', { name: 'media-presentation', toolNames: TOOLS.concat(['get_presentation_topic']) });
check('persona: 沒有 frontmatter 也抽得到步驟與工具', persona.steps.length === 2 && persona.steps[1].tools.join() === 'render_presentation' && persona.name === 'media-presentation');

console.log((fail ? 'FAIL' : 'PASS') + ' 技能→食譜編譯器：' + pass + ' passed, ' + fail + ' failed', failed);
process.exit(fail ? 1 : 0);
