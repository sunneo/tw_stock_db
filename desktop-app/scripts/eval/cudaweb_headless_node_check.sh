#!/bin/bash
# 起 cudaweb_node_gpu_check.js 的伺服器＋無頭 Chrome（軟體 WebGPU／SwiftShader，獨立 user-data-dir），等結果檔，最後只關自己啟動的行程（以行程群組）。
# 用法：bash scripts/eval/cudaweb_headless_node_check.sh <dump 資料夾> <結果名稱> [埠=18786] [逾時秒=3000]
DIR="$1"; NAME="$2"; PORT="${3:-18786}"; TMO="${4:-3000}"
HERE="$(cd "$(dirname "$0")/../.." && pwd)"; RES="${TMPDIR:-/tmp}/cudaweb_node_gpu_${NAME}.result.json"; UD="$(mktemp -d /tmp/cudaweb_chrome_XXXXXX)"
rm -f "$RES"
if [ -n "$SERVER_CMD" ]; then RES="${TMPDIR:-/tmp}/$NAME.result.json"; rm -f "$RES"; setsid bash -c "$SERVER_CMD" > "$UD/server.log" 2>&1 &   # 例：SERVER_CMD="node scripts/eval/cudaweb_moss_pipeline_gpu_check.js <資料夾> <ref> <埠>"，NAME＝結果檔名（不含 .result.json）
else setsid node "$HERE/scripts/eval/cudaweb_node_gpu_check.js" "$DIR" "$NAME" "$PORT" > "$UD/server.log" 2>&1 &
fi
SP=$!
sleep 1
setsid google-chrome --headless=new --no-sandbox --user-data-dir="$UD/profile" --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-webgpu-adapter=swiftshader --disable-gpu-watchdog "http://127.0.0.1:$PORT/" > "$UD/chrome.log" 2>&1 &
CP=$!
for ((i=0;i<TMO;i+=5)); do [ -s "$RES" ] && break; sleep 5; done
curl -s "http://127.0.0.1:$PORT/quit" > /dev/null
kill -- -$CP 2>/dev/null; kill -- -$SP 2>/dev/null
rm -rf "$UD"
[ -s "$RES" ] && { cat "$RES" | head -c 3000; echo; } || echo "逾時：沒有結果檔"
