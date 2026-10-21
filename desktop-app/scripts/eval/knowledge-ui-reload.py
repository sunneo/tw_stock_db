import json, time
from playwright.sync_api import sync_playwright
step1 = """async () => {
  const fa = window.fa; const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const NL = String.fromCharCode(10);
  fa.messages = []; document.querySelectorAll('.fwin-pop,.fwin-ph,.fki').forEach((e) => e.remove()); if (fa._kiPanels) fa._kiPanels.clear();
  await fa._kiAdd({ text: '# 蜘蛛' + NL + NL + '多數蜘蛛會結網捕食昆蟲。' + NL, name: '蜘蛛.md', kind: 'md' });
  const cmd = fa.slashCommands['/knowledge'] || fa.slashCommands.get('/knowledge'); const run = cmd.handler || cmd.run || cmd; await run('ui', fa); await wait(1200);
  fa._persistChatHistory(); await wait(800);
  return { popped: !!document.querySelector('.fwin-pop'), msgs: fa.messages.length };
}"""
step2 = """async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const fa = window.fa;
  for (let i = 0; i < 60 && !document.querySelector('.fki'); i++) await wait(250);
  const p = document.querySelector('.fki');
  for (let i = 0; i < 40 && p && !p.querySelector('.src'); i++) await wait(250);
  return { in_chat: !!p, popped: !!document.querySelector('.fwin-pop'), sources: p ? Array.from(p.querySelectorAll('.src .nm')).map((e) => e.textContent) : null, messages: fa.messages.length, tools: p ? Array.from(p.querySelectorAll('.bar button')).map((b) => b.textContent) : null };
}"""
with sync_playwright() as pw:
    b = pw.chromium.connect_over_cdp('http://127.0.0.1:9344')
    pg = [x for c in b.contexts for x in c.pages if 'devtools' not in x.url][0]
    print('step1', json.dumps(pg.evaluate(step1), ensure_ascii=True))
    pg.reload(); pg.wait_for_function("window.__faBootstrapReady===true", timeout=90000); time.sleep(3)
    print('step2', json.dumps(pg.evaluate(step2), ensure_ascii=True))
