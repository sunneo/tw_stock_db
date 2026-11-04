// 原生執行器的提示樣板模組（純函式，子程序與測試都可用，不依賴 transformers.js）。
// 每個模型一個樣板，以名稱登記在 TEMPLATES；run 訊息的 template 欄位指定名稱（預設 'qwen3-chatml'）。
// 'qwen3-chatml'：Qwen3 的 ChatML 格式。
//   訊息：<|im_start|>{role}\n{content}<|im_end|>\n
//   生成提示：<|im_start|>assistant\n；enable_thinking 為 false 時補上空的思考區塊 <think>\n\n</think>\n\n（Qwen3 官方做法）。
//   歷史的 assistant 訊息會去掉 <think>...</think>（官方樣板也只保留最後一輪的思考）。
//   prefill：接在生成提示之後的原始文字（不加結束標記）。
'use strict';

const THINK_BLOCK_RE = /<think>[\s\S]*?<\/think>\s*/g;

function qwen3ChatML(messages, opts) {
    opts = opts || {};
    if (!Array.isArray(messages)) throw new Error('messages 必須是陣列');
    let s = '';
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m || typeof m.role !== 'string') throw new Error('第 ' + i + ' 則訊息缺少 role');
        let content = m.content == null ? '' : String(m.content);
        if (m.role === 'assistant') content = content.replace(THINK_BLOCK_RE, '');
        if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) throw new Error('不支援的 role：' + m.role);
        s += '<|im_start|>' + m.role + '\n' + content + '<|im_end|>\n';
    }
    s += '<|im_start|>assistant\n';
    if (opts.enable_thinking === false) s += '<think>\n\n</think>\n\n';
    if (opts.prefill) s += String(opts.prefill);
    return s;
}

const TEMPLATES = {
    'qwen3-chatml': qwen3ChatML,
};

// 依名稱套用樣板；未知名稱直接丟錯（不靜默退回預設）
function applyTemplate(name, messages, opts) {
    const fn = TEMPLATES[name || 'qwen3-chatml'];
    if (!fn) throw new Error('未知的提示樣板：' + name + '（可用：' + Object.keys(TEMPLATES).join('、') + '）');
    return fn(messages, opts || {});
}

module.exports = { TEMPLATES, applyTemplate, qwen3ChatML };
