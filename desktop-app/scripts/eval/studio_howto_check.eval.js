// 「如何使用」簡報的示意圖在真 Electron 裡排版截圖（兩種主題、簡單／進階）。用法：FA_EVAL=studio_howto_check xvfb-run -a node scripts/eval/studio_firstrun.run.js
// 內容直接取自 FaStudioHowto.buildDeck(mode, theme)；只畫在覆蓋層上，不寫任何資料。
return (async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (globalThis.__FA_HOWTO_SRC) (0, eval)(globalThis.__FA_HOWTO_SRC); // 工作目錄的未嵌入版本（UMD 會設定 window.FaStudioHowto）
    const H = globalThis.__FA_HOWTO_SRC ? window.FaStudioHowto : FaStudio.FaStudioHowto; const out = {};
    for (const mode of ['simple', 'adv']) for (const theme of ['light', 'dark']) {
        const d = H.buildDeck(mode, theme); const slides = d.chapters.reduce((a, c) => a.concat(c.slides), []);
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:1000px;z-index:99999;overflow:auto;display:flex;flex-wrap:wrap;gap:8px;padding:8px;align-content:flex-start;background:' + (theme === 'dark' ? '#0d1117' : '#ffffff');
        slides.forEach((s) => { const w = document.createElement('div'); w.style.cssText = 'width:416px;height:234px;'; w.innerHTML = s.visual.svg.replace('<svg ', '<svg width="416" height="234" '); ov.appendChild(w); });
        document.body.appendChild(ov); await wait(400);
        console.log('[shot] check-' + mode + '-' + theme); await wait(200);
        out[mode + '-' + theme] = slides.map((s) => s.title + '｜' + (s.visual.svg.match(/<text[^>]*>([^<]*)<\/text>/g) || []).length + ' 段文字');
        ov.remove();
    }
    return out;
})();
