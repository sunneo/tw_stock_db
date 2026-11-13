// 真的桌面版：選類型→（可選）選輸出→填名稱／步數／路徑／Python→真的滑鼠點「開始訓練」→輪詢進度到結束或停止
const st = require('./studio');
const cfg = JSON.parse(process.env.CFG);
(async () => {
  const s = await st.open();
  await st.shimMemoryStorage(s);
  if (cfg.output) { await s.fr.evalIn(`window.__mem.o=${JSON.stringify(cfg.output)}; 1`); }
  await st.setType(s, cfg.type);
  if (cfg.outputClick != null) { const p = await st.locateTypeBtn(s, cfg.outputClick); await s.main.click(p.x, p.y); await st.sleep(500); }
  await st.typeIn(s, 'input[placeholder^="輸出名稱"]', cfg.name);
  if (cfg.steps != null) await st.typeIn(s, 'input[type=number]', String(cfg.steps));
  const pathSel = 'input[placeholder="資料夾完整路徑"], input[placeholder="檔案完整路徑"]';
  for (let i = 0; i < (cfg.paths || []).length; i++) await st.typeIn(s, pathSel, cfg.paths[i], i);
  if (cfg.python) await st.typeIn(s, 'input[placeholder^="訓練用 Python"]', cfg.python);
  await st.sleep(300);
  await st.shot(s, `${process.env.S}/${cfg.tag}-filled.png`);
  await st.clickBtn(s, '開始訓練');
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < (cfg.maxSec || 300) * 1000) {
    await st.sleep(1500);
    const t = (await st.panelText(s)).split('\n').slice(-2).join(' | ');
    if (t !== last) { console.log(((Date.now() - t0) / 1000).toFixed(0) + 's: ' + t.slice(0, 400)); last = t; }
    if (cfg.stopAfterSec && Date.now() - t0 > cfg.stopAfterSec * 1000) { await st.clickPanelBtn(s, '停止'); console.log('>>> 按了停止（真的滑鼠）'); cfg.stopAfterSec = null; }
    if (/完成。|已停止|失敗|缺套件|沒有啟動|讀取狀態失敗|不合法|不存在|找不到|缺/.test(last) && !/執行中/.test(last)) break;
  }
  await st.sleep(1000);
  await st.shot(s, `${process.env.S}/${cfg.tag}-end.png`);
  console.log('--- final panel ---\n' + (await st.panelText(s)).slice(-600));
  s.main.close(); s.fr.close();
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
