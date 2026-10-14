// python_execute 沙盒：腳本 import micropip／PIL／numpy 會依 import 自動載入（以前一律 ModuleNotFoundError）；micropip 可以裝 PyPI 的純 Python 套件（fpdf2），img2pdf／pikepdf 沒有 wasm 版裝不起來（預期失敗）。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/python-autoload.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {};
const def = fa._getToolDefinition('python_execute', null);
const call = async (script) => { const t0 = Date.now(); try { const r = JSON.parse(await def.callback.call(fa, JSON.stringify({ script }))); return { ok: r.ok, out: String(r.stdout || '').slice(0, 200), err: String(r.stderr || r.error || '').split('\n').slice(-3).join(' | ').slice(0, 300), ms: Date.now() - t0 }; } catch (e) { return { thrown: String(e.message || e).slice(0, 200) }; } };
R.base = fa._pyodideIndexURL;
R.micropip = await call('import micropip\nprint("micropip", micropip.__version__)');
R.pil = await call('import PIL\nprint("PIL", PIL.__version__)');
R.numpy = await call('import numpy\nprint("numpy", numpy.__version__)');
R.install = await call('import micropip\nawait micropip.install("img2pdf")\nimport img2pdf\nprint("img2pdf", img2pdf.__version__)');
R.indexURL = fa._pyodideIndexURL;
return R;
