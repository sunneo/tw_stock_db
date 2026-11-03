const fs = require('fs'); const p = 'renderer/src/floating-assistant.js';
let s = fs.readFileSync(p, 'utf8');
function rep(a, b) { const n = s.split(a).length - 1; if (n !== 1) throw new Error('count ' + n + ': ' + a.slice(0, 60)); s = s.replace(a, () => b); }
rep("async _terminalTryPythonAsync(session, argsText, guiTimeoutSec) {", "async _terminalTryPythonAsync(session, argsText, guiTimeoutSec, stdinText, probe) {");
rep("        if (!PA.needsAsync(src)) return false;\n        const cwd = session.cwd || '/';",
"        if (!PA.needsAsync(src)) return false;\n        if (probe) return true;   // 只問「這支程式要不要走 Worker」（管線尾端用：確定要走才去跑前面的段）\n        const cwd = session.cwd || '/';");
rep("{ timeoutMs: cap ? cap * 1000 : 0 }));",
"{ timeoutMs: cap ? cap * 1000 : 0, stdin: stdinText !== undefined ? { text: String(stdinText) } : (cap ? { noInput: true } : {}) }));");
rep("const unregisterAbort", "const unregisterAbort"); 
fs.writeFileSync(p, s);
