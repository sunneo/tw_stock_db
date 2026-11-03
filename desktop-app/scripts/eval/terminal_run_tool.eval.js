// 第 8 條：用真的 terminal_run 工具（fa.tools.terminal_run.callback，傳 JSON 字串、回 JSON 字串）呼叫；沒有人按的 zenity 要在預設 120 秒停掉並收窗
const fa = window.fa; const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
R.loaded = { scripts: Array.from(document.scripts).map((s) => s.src).filter((s) => /floating-assistant/.test(s)), has_tool: !!(fa.tools && fa.tools.terminal_run) };
const created = JSON.parse(await fa.tools.terminal_create.callback(JSON.stringify({ name: 'tool-eval' })));
R.created_ok = created.ok;
await wait(800);
const run = async (command) => { const t0 = Date.now(); const raw = await fa.tools.terminal_run.callback(JSON.stringify({ id_or_name: 'tool-eval', command })); const j = JSON.parse(raw); return Object.assign({ ms: Date.now() - t0 }, { ok: j.ok, exit_code: j.exit_code, stdout: String(j.stdout || '').slice(0, 80), stderr: String(j.stderr || '').slice(0, 80), error: j.error }); };
R.echo = await run('echo hello');
const wins = () => document.querySelectorAll('.gui-window[data-window]').length;
const p = run('zenity --entry --text=nobody');
await wait(1500); R.wins_during = wins();
R.zenity = await p;
R.wins_after = wins();
return R;
