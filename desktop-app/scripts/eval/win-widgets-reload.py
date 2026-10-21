import json, time
from playwright.sync_api import sync_playwright
step2 = """async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms)); const fa = window.fa;
  for (let i = 0; i < 80 && !(document.querySelector('.fwd iframe') && document.querySelector('.fsb')); i++) await wait(250);
  const hv = document.querySelector('.fwd'); const sb = document.querySelector('.fsb');
  for (let i = 0; i < 40 && sb && !/可寫|唯讀/.test(sb.textContent); i++) await wait(250);
  return { html_in_chat: !!hv, html_iframe_has_content: !!(hv && hv.querySelector('iframe') && hv.querySelector('iframe').srcdoc.includes('你好')), html_popped: !!(hv && hv.classList.contains('fwin-pop')), sqlite_in_chat: !!sb, sqlite_popped: !!(sb && sb.classList.contains('fwin-pop')), sqlite_connected: !!(sb && /可寫|唯讀/.test(sb.textContent)), messages: fa.messages.length };
}"""
with sync_playwright() as pw:
    b = pw.chromium.connect_over_cdp('http://127.0.0.1:9344')
    pg = [x for c in b.contexts for x in c.pages if 'devtools' not in x.url][0]
    pg.reload(); pg.wait_for_function("window.__faBootstrapReady===true", timeout=90000); time.sleep(3)
    print('after_reload', json.dumps(pg.evaluate(step2), ensure_ascii=True))
