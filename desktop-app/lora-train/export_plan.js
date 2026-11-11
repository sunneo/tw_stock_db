// lora-train/export_plan.js — 「依環境挑匯出格式」的純函式（DESIGN.lora-training.md §13）。
// 不下載、不執行任何轉換；只回答「在這個環境該提供哪些格式、預設哪個、缺什麼工具」。
// env: { runtime: 'web'|'desktop', backends: { onnxruntimeNode, llamaCpp, transformersJs }, tools: { optimum, convertHfToGguf, llamaQuantize } }
'use strict';
function pickFormats(env) {
    env = env || {}; const b = env.backends || {}; const t = env.tools || {};
    const out = { default: 'onnx-q8', formats: [], notes: [] };
    // ONNX q8 是 app 兩條主路徑（網頁 transformers.js／ort-web、桌面 onnxruntime-node）都吃的格式
    out.formats.push({ id: 'onnx-q8', usable: env.runtime === 'web' ? b.transformersJs !== false : b.onnxruntimeNode !== false,
        needs: [!t.optimum && 'optimum（或自寫 torch.onnx.export）', 'q8 量化步驟'].filter(Boolean), io: 'input_ids／attention_mask／position_ids／past_key_values.*' });
    // GGUF 只有在有 llama.cpp 後端時才提供（app 主路徑目前沒有吃 GGUF）
    const gguf = !!b.llamaCpp;
    out.formats.push({ id: 'gguf-q8_0', usable: gguf, needs: [!t.convertHfToGguf && 'convert_hf_to_gguf.py', !t.llamaQuantize && 'llama-quantize'].filter(Boolean) });
    if (!gguf) out.notes.push('沒有 llama.cpp 後端：不提供 GGUF 當預設，只在評量用途（mini_llama_server.py）列為選項');
    if (env.runtime === 'web') out.notes.push('網頁版不能做完整微調（WASM 記憶體與速度做不到）；只接受本機訓練後匯入的 ONNX q8');
    return out;
}
module.exports = { pickFormats };
if (require.main === module) {
    const assert = require('assert');
    assert.strictEqual(pickFormats({ runtime: 'web', backends: { transformersJs: true } }).default, 'onnx-q8');
    const d = pickFormats({ runtime: 'desktop', backends: { onnxruntimeNode: true, llamaCpp: true }, tools: {} });
    assert.ok(d.formats.find((f) => f.id === 'gguf-q8_0').usable);
    assert.ok(!pickFormats({ runtime: 'desktop', backends: { onnxruntimeNode: true } }).formats.find((f) => f.id === 'gguf-q8_0').usable);
    console.log('export_plan ok');
}
