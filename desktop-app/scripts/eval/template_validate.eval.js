// 原生樣板驗證：WASM 側（真 Electron，桌面版使用的 transformers.js 分詞器與聊天樣板）對 scripts/eval/template_cases.json 的每組 messages，
// 取出實際的樣板文字與 input ids，寫入 %TEMP%\nvw-out\template-wasm.json。
// 之後由 scripts/eval/template_validate.js（node）用原生 nr-template.js 與 nr-tokenizer.js 產生同樣的文字與 ids，逐組比對。
// 只載入分詞器（不載入模型），不下載模型；分詞器檔從快取取得（與應用程式相同的 transformers.js 版本與 repo）。
return (async () => {
    const REPO = 'D:\\Downloads\\videos-嗨投資-desktop-app\\desktop-app';
    const OUT = 'C:\\Users\\sunneo\\AppData\\Local\\Temp\\nvw-out\\template-wasm.json';
    const rawfs = window.desktopAPI.rawfs;
    const cases = JSON.parse((await rawfs.readFile(REPO + '\\scripts\\eval\\template_cases.json', 'utf8')).text);
    const L = await import(FA_ASSET_URLS.transformersJs);
    L.env.useBrowserCache = true; L.env.allowLocalModels = false;
    const tok = await L.AutoTokenizer.from_pretrained('onnx-community/Qwen3-0.6B-ONNX');
    const rows = [];
    for (const c of cases) {
        const opts = { add_generation_prompt: true, enable_thinking: c.enable_thinking };
        const text = tok.apply_chat_template(c.messages, Object.assign({ tokenize: false }, opts));
        const ids = tok.apply_chat_template(c.messages, Object.assign({ tokenize: true, return_dict: false }, opts));
        const flat = Array.isArray(ids) && Array.isArray(ids[0]) ? ids[0] : ids;
        const full = c.prefill ? text + c.prefill : text;
        // 與原生端相同的比對對象：同一段樣板文字，用 WASM 側的分詞器編碼（不加特殊前綴）
        const idsFull = Array.from(tok.encode(full, { add_special_tokens: false })).map((x) => Number(x));
        rows.push({ id: c.id, text: full, ids: idsFull });
    }
    await rawfs.mkdir('C:\\Users\\sunneo\\AppData\\Local\\Temp\\nvw-out');
    await rawfs.writeFile(OUT, { text: JSON.stringify({ tokenizer_repo: 'onnx-community/Qwen3-0.6B-ONNX', transformers: 'cdn 3.7.5', rows }, null, 1) });
    console.log('[eval-file] template_validate wrote ' + rows.length + ' rows to ' + OUT);
    return { rows: rows.length, out: OUT };
})();
