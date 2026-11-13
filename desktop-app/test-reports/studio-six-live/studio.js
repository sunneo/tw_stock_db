// 真實桌面版的工作室操作：在 iframe 的 DOM 找元素（讀取／定位），再用 CDP 真的滑鼠／鍵盤事件點擊（不用 element.click()）。
const { connect } = require('./cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(port = 9555) {
  const main = await connect(port);
  const fr = await connect(port, (t) => t.type === 'iframe' && t.url === 'about:srcdoc');
  return { main, fr };
}
// 在工作室 iframe 裡找元素（可用文字過濾），捲到可見後回傳它在主視窗座標的中心點
async function locate(s, sel, text) {
  const f = await s.main.evalIn(`(()=>{const f=[...document.querySelectorAll('iframe')].find(x=>x.srcdoc); const b=f.getBoundingClientRect(); return {x:b.x,y:b.y}})()`);
  const r = await s.fr.evalIn(`(()=>{const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>${text ? `e.textContent.includes(${JSON.stringify(text)})` : 'true'}); const e=els[0]; if(!e) return null; e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2,n:els.length,disabled:!!e.disabled}})()`);
  if (!r) throw new Error('找不到元素 ' + sel + ' ' + (text || ''));
  return { x: f.x + r.x, y: f.y + r.y, n: r.n, disabled: r.disabled };
}
async function clickBtn(s, text, sel = 'button') { const p = await locate(s, sel, text); if (p.disabled) throw new Error('按鈕停用：' + text); await s.main.click(p.x, p.y); await sleep(400); return p; }
async function frText(s, sel = 'body') { return s.fr.evalIn(`(document.querySelector(${JSON.stringify(sel)})||document.body).innerText`); }
async function shot(s, file) { return s.main.shot(file); }
module.exports = { open, locate, clickBtn, frText, shot, sleep };
// 下拉選單：原生 popup 送不進 CDP 的按鍵／點擊，所以用 select 的 value＋change 事件（與使用者選取走同一個 onchange）
async function setType(s, id) {
  const r = await s.fr.evalIn(`(()=>{const sel=[...document.querySelectorAll('select')][0]; sel.value=${JSON.stringify(id)}; sel.dispatchEvent(new Event('change',{bubbles:true})); return sel.value})()`);
  await sleep(700); return r;
}
module.exports.setType = setType;
// 在「訓練」頁的模型類型卡片裡找按鈕（只找該卡片內的，避免撞到別的分頁）
async function locateTypeBtn(s, label) {
  const f = await s.main.evalIn(`(()=>{const f=[...document.querySelectorAll('iframe')].find(x=>x.srcdoc); const b=f.getBoundingClientRect(); return {x:b.x,y:b.y}})()`);
  const r = await s.fr.evalIn(`(()=>{const card=[...document.querySelectorAll('.card')].filter(c=>c.textContent.includes('模型類型（先選'))[0]; if(!card) return null; const b=[...card.querySelectorAll('button')][${label}]; if(!b) return {missing:true}; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:!!b.disabled,title:b.title}})()`);
  if (!r || r.missing) throw new Error('找不到卡片內的按鈕 ' + label);
  return { x: f.x + r.x, y: f.y + r.y, disabled: r.disabled, title: r.title };
}
// 測試用墊片（不是產品修正）：沙盒 iframe 沒有 allow-same-origin，localStorage 會丟 SecurityError，
// mtGet/mtSet 把它吞掉，選的類型又被重畫成「語言模型」。這裡把這四個函式換成記憶體版本，讓後面的操作能進行。
async function shimMemoryStorage(s) {
  // 換掉 window.localStorage 的存取子（沙盒內會丟 SecurityError）為記憶體版 Storage；產品程式碼本身不動。
  return s.fr.evalIn(`(()=>{const m={}; const st={getItem:(k)=>(k in m?m[k]:null),setItem:(k,v)=>{m[k]=String(v)},removeItem:(k)=>{delete m[k]},clear:()=>{for(const k in m)delete m[k]},key:(i)=>Object.keys(m)[i]??null,get length(){return Object.keys(m).length}}; try{Object.defineProperty(window,'localStorage',{configurable:true,get(){return st}}); return 'shim ok: '+(typeof localStorage)+' '+(localStorage.getItem('x')===null)}catch(e){return 'shim failed: '+e}})()`);
}
module.exports.locateTypeBtn = locateTypeBtn; module.exports.shimMemoryStorage = shimMemoryStorage;
// 在 iframe 的輸入框真的打字：先真的點擊聚焦，再用 CDP insertText（輸入法等級的文字輸入）
async function typeIn(s, selector, text, nth = 0) {
  const p = await locate(s, selector);
  // 第 nth 個
  const f = await s.main.evalIn(`(()=>{const f=[...document.querySelectorAll('iframe')].find(x=>x.srcdoc); const b=f.getBoundingClientRect(); return {x:b.x,y:b.y}})()`);
  const r = await s.fr.evalIn(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})][${nth}]; e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
  await s.main.click(f.x + r.x, f.y + r.y); await sleep(200);
  await s.fr.evalIn(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})][${nth}]; e.select(); return 1})()`);
  await s.fr.send('Input.insertText', { text });
  await sleep(200);
  return s.fr.evalIn(`[...document.querySelectorAll(${JSON.stringify(selector)})][${nth}].value`);
}
module.exports.typeIn = typeIn;
// 讀「開始訓練」面板的文字（訊息與進度）
async function panelText(s) {
  return s.fr.evalIn(`(()=>{const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.includes('開始訓練')&&x.closest('button')===x)[0]; if(!b) return '(no start button)'; const box=b.parentElement.parentElement; return box.innerText})()`);
}
async function btnState(s, text) { return s.fr.evalIn(`(()=>{const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.includes(${JSON.stringify(text)}))[0]; return b?{disabled:b.disabled}:null})()`); }
module.exports.panelText = panelText; module.exports.btnState = btnState;
// 訓練面板裡的按鈕（文字完全相符、且與「開始訓練」同一面板）
async function clickPanelBtn(s, text) {
  const f = await s.main.evalIn(`(()=>{const f=[...document.querySelectorAll('iframe')].find(x=>x.srcdoc); const b=f.getBoundingClientRect(); return {x:b.x,y:b.y}})()`);
  const r = await s.fr.evalIn(`(()=>{const go=[...document.querySelectorAll('button')].filter(x=>x.textContent.includes('開始訓練'))[0]; if(!go) return null; const box=go.parentElement; const b=[...box.querySelectorAll('button')].filter(x=>x.textContent.trim()===${JSON.stringify(text)})[0]; if(!b) return {missing:true}; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:!!b.disabled}})()`);
  if (!r || r.missing) throw new Error('面板裡找不到按鈕 ' + text);
  if (r.disabled) throw new Error('按鈕停用：' + text);
  await s.main.click(f.x + r.x, f.y + r.y); await sleep(300);
}
module.exports.clickPanelBtn = clickPanelBtn;
