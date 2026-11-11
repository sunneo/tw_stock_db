#!/usr/bin/env bash
# 在一台新的 Linux 機器上，把拿到這個倉庫後該準備的環境設定好。
# 用法（在倉庫的 desktop-app 目錄，或任何位置用路徑呼叫）：
#   bash scripts/setup-linux.sh [--handoff <解開後的交接資料夾>] [--with-electron] [--with-python] [--prefix <Node 安裝位置>] [--yes]
# 做什麼（每一步都會先說明；沒有 root 權限也能跑，不會自己用 sudo）：
#   1. 檢查必要工具（git curl tar xz make gcc g++ python3）；缺的列出對應的安裝指令，不自動安裝系統套件。
#   2. 沒有 Node.js（或低於 18）就從 nodejs.org 下載官方 22.x 版壓縮檔，核對 sha256 後裝到 --prefix（預設 ~/.local/fa-node），不動系統。
#   3. 在 desktop-app 執行 npm ci（預設跳過 Electron 二進位檔：核心測試與建置用不到；加 --with-electron 才下載，約 100 MB 以上）。
#   4. （--handoff）把交接包 extras/ 裡的 wiki、.weak-harness、progress.jsonl、test-reports 放回正確位置。
#   5. （--with-python）建 lora-train/.venv（需要 Python 3.11 以上）並裝 torch 處理器版與 requirements.txt（約 220 MB）。
#   6. 自我檢查：語法檢查主要檔案、跑一個小測試。
# 下載來源：nodejs.org、registry.npmjs.org、（--with-python）pypi.org 與 download.pytorch.org、（--with-electron）github.com 的 Electron 釋出。
# 不會做：不推送、不發布、不改系統設定、不用 sudo、不碰金鑰檔。
set -euo pipefail

PREFIX="$HOME/.local/fa-node"; HANDOFF=""; WITH_ELECTRON=0; WITH_PY=0; YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --handoff) HANDOFF="$2"; shift 2;;
    --with-electron) WITH_ELECTRON=1; shift;;
    --with-python) WITH_PY=1; shift;;
    --prefix) PREFIX="$2"; shift 2;;
    --yes|-y) YES=1; shift;;
    -h|--help) sed -n '2,16p' "$0"; exit 0;;
    *) echo "不認得的參數：$1"; exit 2;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
ask() { [ "$YES" = 1 ] && return 0; printf '%s [y/N] ' "$1"; read -r a; [ "$a" = y ] || [ "$a" = Y ]; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESK="$(cd "$HERE/.." && pwd)"
TOP="$(cd "$DESK/.." && pwd)"
[ -f "$DESK/package.json" ] || { warn "找不到 $DESK/package.json，請在倉庫裡執行"; exit 1; }

# ---- 1. 必要工具 ----
say "1. 檢查必要工具"
missing=()
for c in git curl tar xz make gcc g++ python3; do command -v "$c" >/dev/null 2>&1 || missing+=("$c"); done
if [ ${#missing[@]} -gt 0 ]; then
  warn "缺少：${missing[*]}"
  if command -v apt-get >/dev/null 2>&1; then echo "  Debian/Ubuntu：sudo apt-get install -y git curl tar xz-utils build-essential python3 python3-venv"
  elif command -v dnf >/dev/null 2>&1; then echo "  Fedora/RHEL：sudo dnf install -y git curl tar xz make gcc gcc-c++ python3"
  elif command -v pacman >/dev/null 2>&1; then echo "  Arch：sudo pacman -S --needed git curl tar xz base-devel python"
  elif command -v zypper >/dev/null 2>&1; then echo "  openSUSE：sudo zypper install git curl tar xz make gcc gcc-c++ python3"
  else echo "  請用你的套件管理員安裝：${missing[*]}"; fi
  case " ${missing[*]} " in *" curl "*|*" tar "*|*" xz "*) warn "curl／tar／xz 缺少時無法下載 Node，先裝好再重跑。"; exit 1;; esac
  warn "gcc／g++／make／python3 缺少只會影響判題器與部分測試，可以先繼續。"
fi

# ---- 2. Node.js ----
say "2. Node.js"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -ge 18 ]; then need_node=0; echo "已有 Node $(node -v)，略過安裝。"; fi
fi
if [ "$need_node" = 1 ]; then
  case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; armv7l) arch=armv7l;; *) warn "不支援的 CPU：$(uname -m)"; exit 1;; esac
  base="https://nodejs.org/dist/latest-v22.x"
  echo "將從 $base 下載 linux-$arch 版 Node 22（約 25–30 MB）到 $PREFIX。"
  ask "繼續下載並安裝？" || { warn "已取消。"; exit 1; }
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  fname="$(grep -E "node-v[0-9.]+-linux-$arch\.tar\.xz$" "$tmp/SHASUMS256.txt" | awk '{print $2}' | head -1)"
  [ -n "$fname" ] || { warn "SHASUMS256.txt 裡找不到 linux-$arch 的檔案"; exit 1; }
  want="$(grep " $fname\$" "$tmp/SHASUMS256.txt" | awk '{print $1}')"
  curl -fL --retry 3 "$base/$fname" -o "$tmp/$fname"
  got="$(sha256sum "$tmp/$fname" | awk '{print $1}')"
  [ "$got" = "$want" ] || { warn "sha256 不符（預期 $want，實際 $got），中止。"; exit 1; }
  mkdir -p "$PREFIX"; tar -xJf "$tmp/$fname" -C "$PREFIX" --strip-components=1
  export PATH="$PREFIX/bin:$PATH"
  echo "已安裝 $(node -v) 到 $PREFIX（sha256 核對通過）。"
  line="export PATH=\"$PREFIX/bin:\$PATH\""
  if ! grep -qsF "$line" "$HOME/.profile" 2>/dev/null; then
    if ask "把 PATH 設定寫進 ~/.profile（之後新的終端機才找得到 node）？"; then echo "$line" >> "$HOME/.profile"; echo "已寫入。新終端機請 source ~/.profile。"; else echo "未寫入。本次請先執行：$line"; fi
  fi
fi
command -v node >/dev/null 2>&1 || { warn "node 仍不在 PATH"; exit 1; }

# ---- 3. npm 依賴 ----
say "3. npm 依賴（desktop-app）"
cd "$DESK"
if [ "$WITH_ELECTRON" = 1 ]; then echo "會下載 Electron 二進位檔（含在 npm ci 的安裝後步驟）。"; else export ELECTRON_SKIP_BINARY_DOWNLOAD=1; echo "跳過 Electron 二進位檔（核心測試與建置不需要；要真 Electron 驗證再用 --with-electron 重跑）。"; fi
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

# ---- 4. 放回交接包的額外檔案 ----
if [ -n "$HANDOFF" ]; then
  say "4. 放回交接包的額外檔案"
  ex="$HANDOFF/extras"
  [ -d "$ex" ] || { warn "找不到 $ex"; exit 1; }
  [ -d "$ex/wiki" ] && { mkdir -p "$TOP/wiki"; cp -a "$ex/wiki/." "$TOP/wiki/"; echo "wiki/ 已放回 $TOP/wiki"; }
  if [ -d "$ex/desktop-app" ]; then cp -a "$ex/desktop-app/." "$DESK/"; echo "desktop-app 的額外檔案已放回。"; fi
  [ -d "$ex/_outside" ] && echo "extras/_outside 內是倉庫外路徑，請自行決定放哪裡。"
fi

# ---- 5. Python 訓練環境（選用）----
if [ "$WITH_PY" = 1 ]; then
  say "5. Python 訓練環境（lora-train/.venv，需要 Python 3.11 以上）"
  py=""
  for c in python3.13 python3.12 python3.11 python3; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys;sys.exit(0 if sys.version_info>=(3,11) else 1)'; then py="$c"; break; fi
  done
  [ -n "$py" ] || { warn "找不到 Python 3.11 以上；先安裝（例如 apt install python3.12 python3.12-venv）再用 --with-python 重跑。"; exit 1; }
  echo "使用 $($py --version)。將下載 torch 處理器版約 121 MB 與其他套件（合計約 220 MB，來源 pypi.org、download.pytorch.org）。"
  ask "繼續安裝？" || { warn "略過 Python 環境。"; WITH_PY=0; }
  if [ "$WITH_PY" = 1 ]; then
    V="$DESK/lora-train/.venv"
    rm -rf "$V"   # 上次失敗留下的半成品環境
    if ! "$py" -m venv "$V" 2>/tmp/fa-venv.err; then
      rm -rf "$V"
      pyver="$("$py" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
      warn "建立虛擬環境失敗（常見原因：系統 Python 沒附 ensurepip）：$(tail -1 /tmp/fa-venv.err)"
      echo "  方案 A（建議，要 root）：sudo apt-get install -y python${pyver}-venv   （Fedora：sudo dnf install python3-pip；Arch 已內建）"
      echo "  方案 B（不用 root）：先建沒有 pip 的環境，再從 bootstrap.pypa.io 下載 get-pip.py（約 2.5 MB）安裝 pip。"
      if ask "改用方案 B 嗎（會下載 https://bootstrap.pypa.io/get-pip.py）？"; then
        "$py" -m venv --without-pip "$V" || { rm -rf "$V"; warn "連 --without-pip 都失敗，請先照方案 A 安裝後重跑。"; exit 1; }
        curl -fsSL https://bootstrap.pypa.io/get-pip.py -o /tmp/fa-get-pip.py
        "$V/bin/python" /tmp/fa-get-pip.py
        rm -f /tmp/fa-get-pip.py
      else
        warn "已略過 Python 環境。裝好 python${pyver}-venv 後請用 --with-python 重跑。"; exit 1
      fi
    fi
    "$V/bin/python" -m pip install --upgrade pip
    "$DESK/lora-train/.venv/bin/python" -m pip install torch -r "$DESK/lora-train/requirements.txt" --extra-index-url https://download.pytorch.org/whl/cpu
    "$DESK/lora-train/.venv/bin/python" -c 'import torch,transformers,peft;print("torch",torch.__version__,"transformers",transformers.__version__,"peft",peft.__version__)'
  fi
fi

# ---- 6. 自我檢查 ----
say "6. 自我檢查"
fail=0
for f in renderer/src/floating-assistant.js main-ext.js scripts/run-core-tests.js; do node --check "$f" && echo "語法 OK：$f" || { warn "語法失敗：$f"; fail=1; }; done
if [ -f renderer/src/studio/fatrain_core.test.js ]; then node renderer/src/studio/fatrain_core.test.js 2>&1 | tail -1 || fail=1; fi

say "完成"
echo "倉庫：$TOP"
echo "下一步：讀 $DESK/docs/HANDOFF.md 第 0 節（主文件）。"
echo "常用：node scripts/run-core-tests.js（整套約數分鐘，一天一次）；只跑動到的測試檔：node <測試檔>。"
echo "注意：scripts/qrun.js 是 Windows 的隱藏排隊執行器，Linux 上不需要，直接跑命令。"
[ "$fail" = 0 ] || { warn "自我檢查有失敗項目，請看上面輸出。"; exit 1; }
