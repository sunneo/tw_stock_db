# 用法：bash run_pair.sh <tag> <ids 逗號> <seed>
cd /d/Downloads/videos-嗨投資-desktop-app/desktop-app
S=/c/Users/sunneo/AppData/Local/Temp/claude/1845096e089295dd/55f6386b-065f-490b-8586-b172e1541f15/scratchpad/sdxs
MD="C:/Users/sunneo/AppData/Local/Temp/claude/1845096e089295dd/6b498b68-965f-496b-aa6b-59a7ba912b4a/scratchpad/models/sdxs-int8"
ELECTRON_RUN_AS_NODE=1 NAB_ORT="$(node scripts/eval/find_installed_runtime.js | tr -d '\r' | sed 's#\\#/#g')/node_modules/onnxruntime-node" MODELS="$MD" OUT="$(cygpath -w $S)/pair_$1" SD="$(cygpath -w $PWD)/renderer/src/imagegen/local_sd.js" IDS="$2" SEED="$3" THREADS=4 timeout 300 node_modules/electron/dist/electron.exe $(cygpath -w $S)/native_stages.js > $S/pair_$1.native.log 2>&1
node $(cygpath -w $S)/run_wasm_stages.js "$(cygpath -w $S)/pair_$1" "$MD" "$(cygpath -w $PWD/node_modules/electron/dist/electron.exe)" "$(cygpath -w $PWD)" > $S/pair_$1.wasm.log 2>&1
echo done > $S/pair_$1.done
