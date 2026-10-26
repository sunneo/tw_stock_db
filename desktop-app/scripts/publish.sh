#!/usr/bin/env bash
# 更新網頁＋發布 patch：建置 → 提交推到 desktop-app → 組 desktop-app-patch（永遠單一 commit、強制推）→ 驗證 → 網頁版釘新的 commit SHA。
# 流程的來源與踩過的坑見 .claude/skills/publish-live-update-patch/SKILL.md；這支腳本把那份技能的標準流程寫成可重複執行的指令。
#
# 用法：scripts/publish.sh -m "這次改了什麼" [--dry-run] [--no-web] [--version N] [--skip-build] [--commit-msg "提交訊息"]
#   -m / --notes    patch 的備註（也是預設的提交訊息）；必填
#   --dry-run       只建置、檢查、組出 patch 內容並列出會做什麼；不提交、不推、不改網頁
#   --no-web        只發 patch，不動網頁版（videos-嗨投資 的 main）
#   --version N     patch 版本號（預設：遠端 manifest 的版本 + 1）
#   --skip-build    不重新建置（用現有的 renderer 檔案）
#   --commit-msg    desktop-app 分支的提交訊息（預設用備註）
# 環境變數：
#   WEB_REPO        網頁版的 repo（預設 <本 repo>/../videos-嗨投資）
#   PUBLISH_TRAILER 附在每個提交訊息最後的一行（例如 "Co-Authored-By: ..."），預設不加
#   REMOTE          遠端名稱（預設 origin）
set -euo pipefail

NOTES=""; DRY=0; WEB=1; VERSION=""; BUILD=1; COMMIT_MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    -m|--notes) NOTES="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --no-web) WEB=0; shift ;;
    --version) VERSION="$2"; shift 2 ;;
    --skip-build) BUILD=0; shift ;;
    --commit-msg) COMMIT_MSG="$2"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "不認得的參數：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done
[ -n "$NOTES" ] || { echo "要用 -m 寫這次 patch 的備註" >&2; exit 2; }
[ -n "$COMMIT_MSG" ] || COMMIT_MSG="$NOTES"
REMOTE="${REMOTE:-origin}"
TRAILER="${PUBLISH_TRAILER:-}"

APP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(git -C "$APP" rev-parse --show-toplevel)"
WEB_REPO="${WEB_REPO:-$ROOT/../videos-嗨投資}"
# 給 node 看的路徑（Git Bash 的 /tmp 之類 node 看不到）
if command -v cygpath >/dev/null 2>&1; then W() { cygpath -m "$1"; }; else W() { printf '%s' "$1"; }; fi
say() { printf '\n== %s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
with_trailer() { if [ -n "$TRAILER" ]; then printf '%s\n\n%s\n' "$1" "$TRAILER"; else printf '%s\n' "$1"; fi; }

cd "$APP"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "desktop-app" ] || { echo "目前在分支「$BRANCH」，要在 desktop-app 分支發布" >&2; exit 1; }

# ---- 1. 建置與檢查 ----
if [ "$BUILD" = 1 ]; then
  say "建置（embed-code-ui → build-assistant）"
  node scripts/embed-code-ui.js >/dev/null
  node build-assistant.js >/dev/null
fi
say "語法檢查"
node --check renderer/src/floating-assistant.js
node --check renderer/bootstrap.js

# ---- 2. 版號與提交 ----
# 版號的唯一維護處是 desktop-app/PATCH_VERSION（對照遠端 manifest.v2.json／manifest.json／patch commit 訊息，取最大再 +1）；見 scripts/release-version.js、DESIGN.release.md
[ -n "$VERSION" ] || VERSION="$(node scripts/release-version.js next)"
say "版號 $VERSION（PATCH_VERSION 跟這次提交一起更新）"
if [ "$DRY" != 1 ]; then node scripts/release-version.js claim "$VERSION" || exit 1; git add PATCH_VERSION; fi
say "提交並推到 $REMOTE/desktop-app"
git add -A renderer scripts
if git diff --cached --quiet; then echo "沒有新的 renderer／scripts 變更要提交"; else
  MSG_FILE="$(mktemp)"; with_trailer "$COMMIT_MSG" > "$MSG_FILE"
  run git commit -q -F "$MSG_FILE"; rm -f "$MSG_FILE"
fi
run git push -q "$REMOTE" desktop-app
HEAD_SHA="$(git rev-parse HEAD)"; echo "desktop-app HEAD = $HEAD_SHA"
if [ -n "$(git status --porcelain -- renderer scripts)" ]; then echo "注意：renderer／scripts 還有沒提交的變更（dry-run 時正常）" >&2; fi

# ---- 3. 組 patch ----
say "組 desktop-app-patch"
git fetch -q "$REMOTE" desktop-app-patch 2>/dev/null || true
echo "版本 $VERSION"
PATCH_DIR="$(mktemp -d)"; trap 'rm -rf "$PATCH_DIR" "${PATCH_INDEX:-}"' EXIT
node scripts/publish-manifest.js "$(W "$PATCH_DIR")" "$VERSION" "$NOTES"

PATCH_INDEX="$(mktemp -u)"
GIT_DIR_ABS="$(git rev-parse --absolute-git-dir)"
TREE="$(cd "$PATCH_DIR" && GIT_DIR="$GIT_DIR_ABS" GIT_WORK_TREE="$PATCH_DIR" GIT_INDEX_FILE="$PATCH_INDEX" sh -c 'git add -A >/dev/null 2>&1; git write-tree')"
[ "${#TREE}" = 40 ] || { echo "write-tree 失敗（tree=[$TREE]）" >&2; exit 1; }
PMSG="$(mktemp)"; with_trailer "desktop-app-patch: v$VERSION - $NOTES" > "$PMSG"
COMMIT="$(cd "$PATCH_DIR" && GIT_DIR="$GIT_DIR_ABS" git commit-tree "$TREE" -F "$PMSG")"; rm -f "$PMSG"
[ "${#COMMIT}" = 40 ] || { echo "commit-tree 失敗（commit=[$COMMIT]）" >&2; exit 1; }
echo "patch commit = $COMMIT"

if [ "$DRY" = 1 ]; then
  echo "[dry-run] git update-ref refs/heads/desktop-app-patch $COMMIT"
  echo "[dry-run] git push --force $REMOTE desktop-app-patch:desktop-app-patch"
else
  git update-ref refs/heads/desktop-app-patch "$COMMIT"
  git push --force "$REMOTE" desktop-app-patch:desktop-app-patch 2>&1 | grep -v 'warning\|negotiation\|acknowledg' | tail -1 || true
fi

# ---- 4. 驗證 patch ----
say "驗證 patch（遠端 manifest 版本與每個檔案的檢查碼）"
if [ "$DRY" = 1 ]; then echo "[dry-run] 略過"; else
  BAD=0
  for f in $(node -e "const m=require('$(W "$PATCH_DIR")/manifest.json');console.log(Object.keys(m.files).join(' '))"); do
    A="$(git show "desktop-app-patch:$f" | md5sum | cut -c1-32)"; B="$(node -e "console.log(require('$(W "$PATCH_DIR")/manifest.json').files['$f'].md5)")"
    [ "$A" = "$B" ] || { echo "檢查碼不符：$f（$A ≠ $B）" >&2; BAD=1; }
  done
  [ "$BAD" = 0 ] || { echo "patch 驗證失敗" >&2; exit 1; }
  echo "版本 $(git show desktop-app-patch:manifest.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version))")，檢查碼都對"
  echo "遠端（CDN 可能有一小段時間還是舊的）：curl -sS \"https://raw.githubusercontent.com/sunneo/tw_stock_db/desktop-app-patch/manifest.json?_cb=\$(date +%s)\""
fi

# ---- 5. 網頁版：釘到新的 commit SHA ----
if [ "$WEB" = 1 ]; then
  say "網頁版（$WEB_REPO）釘到 ${HEAD_SHA:0:8}"
  [ -d "$WEB_REPO/web" ] || { echo "找不到網頁版 repo：$WEB_REPO（用 WEB_REPO 指定，或 --no-web）" >&2; exit 1; }
  OLD="$(grep -o 'tw_stock_db/[0-9a-f]\{40\}' "$WEB_REPO/web/index.html" | head -1 | cut -d/ -f2)"
  [ -n "$OLD" ] || { echo "web/index.html 裡找不到釘住的 SHA" >&2; exit 1; }
  if [ "$OLD" = "$HEAD_SHA" ]; then echo "網頁版已經釘在這個 SHA"; else
    if [ "$DRY" = 1 ]; then echo "[dry-run] 把 web/index.html、web/aiweb/index.html 的 ${OLD:0:8} 換成 ${HEAD_SHA:0:8}，提交並推到 main"; else
      sed -i "s/$OLD/$HEAD_SHA/g" "$WEB_REPO/web/index.html" "$WEB_REPO/web/aiweb/index.html"
      for f in web/index.html web/aiweb/index.html; do grep -q "$HEAD_SHA" "$WEB_REPO/$f" || { echo "$f 沒換成功" >&2; exit 1; }; done
      WMSG="$(mktemp)"; with_trailer "網頁版：載入的 floating-assistant 釘到 ${HEAD_SHA:0:8}（$NOTES）" > "$WMSG"
      git -C "$WEB_REPO" add web/index.html web/aiweb/index.html
      git -C "$WEB_REPO" commit -q -F "$WMSG"; rm -f "$WMSG"
      git -C "$WEB_REPO" push -q "$REMOTE" main
      CODE="$(curl -sI -o /dev/null -w '%{http_code}' "https://raw.githubusercontent.com/sunneo/tw_stock_db/$HEAD_SHA/desktop-app/renderer/floating-assistant.js" || true)"
      echo "釘住的檔案網址回應：HTTP $CODE（Pages 約 1～2 分鐘後換上新版；要確認頁面實際載入的版本，用 fa._createProgressWidget.toString() 之類檢查）"
    fi
  fi
fi

if [ "$DRY" = 1 ]; then say "完成（dry-run，什麼都沒推）：patch v$VERSION、desktop-app $HEAD_SHA"; else say "完成：patch v$VERSION、desktop-app $HEAD_SHA"; fi
