// 原生執行器的主程序 IPC（階段 3）：渲染程序經 preload 的 desktopAPI.nativeRunner 呼叫這裡。
// 只註冊 fa:native:* 四個通道；子程序目前是假引擎（見 child.js）。
// fake 欄位（假引擎旋鈕）只在環境變數 FA_DEBUG_NATIVE_FAKE=1 時才會被轉給子程序，正式環境忽略。
'use strict';

const path = require('path');
const { createNativeRunnerHost } = require('./host.js');

function register(ipcMain, deps) {
    const app = deps.app;
    const getWindow = deps.getMainWindow || (() => null);
    let host = null;
    function getHost() {
        if (host) return host;
        const userData = app.getPath('userData');
        host = createNativeRunnerHost({
            childPath: path.join(__dirname, 'child.js'),
            progressFile: path.join(userData, 'native-runner', 'progress.jsonl'),
            idleMs: 10 * 60 * 1000,
            graceMs: 5000,
            log: (m) => console.log(m),
        });
        return host;
    }
    ipcMain.handle('fa:native:status', () => getHost().status());
    ipcMain.handle('fa:native:run', async (event, req) => {
        const rid = req && req.rid ? String(req.rid) : '';
        const sendEvent = (kind, data) => {
            try { const w = getWindow(); const wc = (w && w.webContents) || event.sender; wc.send('fa:native:event', Object.assign({ rid, kind }, data)); } catch (_) { /* 視窗已關閉 */ }
        };
        const fake = process.env.FA_DEBUG_NATIVE_FAKE === '1' && req && req.fake ? req.fake : undefined;
        try {
            const r = await getHost().run({
                messages: req && req.messages,
                template: req && req.template,
                gen: req && req.gen,
                seed: req && req.seed,
                maxTokens: req && req.maxTokens,
                timeoutMs: req && req.timeoutMs,
                stream: !!(req && req.stream),
                fake,
                onStart: (id) => sendEvent('start', { id }),
                onToken: (text) => sendEvent('token', { text }),
                onProgress: (m) => sendEvent('progress', { stage: m.stage, tokens: m.tokens }),
            });
            return { ok: true, result: r };
        } catch (e) {
            return { ok: false, code: e.code || 'internal', message: String((e && e.message) || e), timeout: !!e.timeout, exitCode: e.exitCode == null ? null : e.exitCode };
        }
    });
    ipcMain.handle('fa:native:cancel', (_event, req) => getHost().cancel(req && req.id));
    ipcMain.handle('fa:native:dispose', () => getHost().dispose('渲染程序要求'));
    ipcMain.handle('fa:native:reenable', () => { getHost().reenable(); return getHost().status(); });
}

module.exports = { register };
