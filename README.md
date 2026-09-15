# bash-wasm-backup

busybox 1.38.0 (ash + coreutils) compiled to wasm32-wasi via wasi-sh (https://github.com/sunneo/wasi-sh, forked from alganet/wasi-sh), plus a single-file esbuild bundle of its ISC-licensed JS runtime (wasi-sh.bundle.mjs, exports run/memoryFs — bundled instead of the loose src/*.mjs tree because raw.githubusercontent.com serves .mjs as text/plain+nosniff, which blocks native ESM import(); the bundle is fetched as text and loaded via a Blob URL instead, see floating-assistant.js's _ensureBashWasmLoaded). Used by floating-assistant.js's bash_execute tool. busybox.wasm itself is GPL-2.0 (see LICENSE-busybox-GPL2.txt); the JS runtime is ISC (see LICENSE-wasi-sh-ISC.txt).

Files split into 20MB parts where needed (see `wasi-sh/manifest.json`). This branch is force-pushed on regeneration — it holds exactly one binary asset, nothing else, and carries no history.
