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
# 被 sh（dash 等）誤用時改用 bash 重跑；腳本用了 bash 專有語法
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
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
# 每個階段標題前面印上「上一階段用了幾秒」，之後才看得出哪一段慢（2026-11-23）
PUB_T0=$(date +%s); STAGE_T=$PUB_T0; STAGE_NAME=""
say() {
  local now; now=$(date +%s)
  [ -n "$STAGE_NAME" ] && printf '   （%s用了 %s 秒）\n' "$STAGE_NAME" "$((now - STAGE_T))"
  STAGE_T=$now; STAGE_NAME="$*"
  printf '\n== %s\n' "$*"
}
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
with_trailer() { if [ -n "$TRAILER" ]; then printf '%s\n\n%s\n' "$1" "$TRAILER"; else printf '%s\n' "$1"; fi; }

cd "$APP"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "desktop-app" ] || { echo "目前在分支「$BRANCH」，要在 desktop-app 分支發布" >&2; exit 1; }

# ---- 0. 來源要先提交 ----
# 發布只提交「建置產生的檔案」。同一個資料夾可能有別的工作階段改到一半，
# 沒提交的來源變更會被嵌入、建置進發布內容，所以有就停下來（2026-11-14 v403／v404 掃進半成品的教訓）。
GENERATED_RE='^(renderer/floating-assistant\.js|renderer/floating-assistant\.min\.js|renderer/update-manifest\.json|web-lazy/.*)$'
PREFIX="$(git rev-parse --show-prefix)"   # 例如 desktop-app/；porcelain 的路徑是相對於 repo 根目錄
DIRTY="$(git -c core.quotepath=false status --porcelain --untracked-files=all -- renderer scripts skills '*.js' '*.json' | cut -c4- | sed 's/.* -> //; s/^"//; s/"$//' | sed "s#^$PREFIX##" | grep -Ev "$GENERATED_RE" || true)"
if [ -n "$DIRTY" ]; then
  echo "還有沒提交的來源變更（可能是別的工作階段做到一半），發布會把它們嵌入建置；請先提交或等對方完成：" >&2
  printf '%s\n' "$DIRTY" | sed 's/^/  /' >&2
  if [ "$DRY" = 1 ]; then echo "（dry-run：只警告，繼續）" >&2; else exit 1; fi
fi

# ---- 1. 建置與檢查 ----
if [ "$BUILD" = 1 ]; then
  say "建置（embed-code-ui → build-assistant）"
  node scripts/embed-code-ui.js >/dev/null
  node build-assistant.js >/dev/null
fi
say "語法檢查"
node --check renderer/src/floating-assistant.js
node --check renderer/bootstrap.js
say "網頁版延遲載入檔案檢查（web-lazy 與 manifest 一致）"
node scripts/web-lazy-check.js || exit 1

# ---- 2. 版號與提交 ----
# 版號的唯一維護處是 desktop-app/PATCH_VERSION（對照遠端 manifest.v2.json／manifest.json／patch commit 訊息，取最大再 +1）；見 scripts/release-version.js、DESIGN.release.md
[ -n "$VERSION" ] || VERSION="$(node scripts/release-version.js next)"
say "版號 $VERSION（PATCH_VERSION 跟這次提交一起更新）"
if [ "$DRY" != 1 ]; then node scripts/release-version.js claim "$VERSION" || exit 1; git add PATCH_VERSION; fi
say "提交並推到 $REMOTE/desktop-app"
# 只提交建置產生的檔案（嵌入後的 renderer/src/floating-assistant.js、組合檔、更新清單、網頁區塊）
git add -- renderer/src/floating-assistant.js renderer/floating-assistant.js renderer/floating-assistant.min.js renderer/update-manifest.json
git add -A -- web-lazy
if git diff --cached --quiet; then echo "沒有新的建置產物要提交"; else
  MSG_FILE="$(mktemp)"; with_trailer "$COMMIT_MSG" > "$MSG_FILE"
  run git commit -q -F "$MSG_FILE"; rm -f "$MSG_FILE"
fi
# 先固定要推的 commit，再推「這個 SHA」：別的工作階段可能在同一分支上同時提交，推完才讀 HEAD 會讀到沒推上去的新 commit（網頁版就會釘到遠端沒有的 SHA）
HEAD_SHA="$(git rev-parse HEAD)"
run git push -q "$REMOTE" "$HEAD_SHA:refs/heads/desktop-app"
echo "desktop-app HEAD = $HEAD_SHA"
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
  # 推送失敗一定要中止（以前接 `| tail -1 || true` 會吞掉失敗，v354 就是這樣印出「完成」但遠端沒更新）
  PUSH_OUT="$(git push --force "$REMOTE" desktop-app-patch:desktop-app-patch 2>&1)" || { echo "$PUSH_OUT" >&2; echo "推送 desktop-app-patch 失敗，中止" >&2; exit 1; }
  printf '%s\n' "$PUSH_OUT" | grep -v 'warning\|negotiation\|acknowledg' | tail -1
  # 以遠端實際的提交核對（不是本機分支）
  REMOTE_SHA="$(git ls-remote "$REMOTE" refs/heads/desktop-app-patch | cut -c1-40)"
  [ "$REMOTE_SHA" = "$COMMIT" ] || { echo "遠端 desktop-app-patch（${REMOTE_SHA:-沒有}）不是剛組出的 $COMMIT，中止" >&2; exit 1; }
  echo "遠端 desktop-app-patch 已是 $COMMIT"
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
  OLD="$(grep -o "var SHA = '[0-9a-f]\{40\}'" "$WEB_REPO/web/index.html" | head -1 | grep -o '[0-9a-f]\{40\}')"   # v417 起釘在 var SHA（jsDelivr 網址與 aiweb 的 FA_SHA 是同一個值）"
  [ -n "$OLD" ] || { echo "web/index.html 裡找不到釘住的 SHA" >&2; exit 1; }
  if [ "$OLD" = "$HEAD_SHA" ]; then echo "網頁版已經釘在這個 SHA"; else
    if [ "$DRY" = 1 ]; then echo "[dry-run] 把 web/index.html、web/aiweb/index.html 的 ${OLD:0:8} 換成 ${HEAD_SHA:0:8}，產生全螢幕 GUI 入口頁（node scripts/gen-aiweb-pages.js），提交並推到 main"; else
      sed -i "s/$OLD/$HEAD_SHA/g" "$WEB_REPO/web/index.html" "$WEB_REPO/web/aiweb/index.html"
      for f in web/index.html web/aiweb/index.html; do grep -q "$HEAD_SHA" "$WEB_REPO/$f" || { echo "$f 沒換成功" >&2; exit 1; }; done
      # 全螢幕 GUI 入口頁（web/aiweb/<指令>/、fa-gui.js、gui 清單、aiweb 的 #/指令 轉址）同一個 SHA 一起產生，見 scripts/gen-aiweb-pages.js
      node scripts/gen-aiweb-pages.js --web "$WEB_REPO" --sha "$HEAD_SHA" || { echo "全螢幕 GUI 入口頁產生失敗，中止" >&2; exit 1; }
      grep -q "$HEAD_SHA" "$WEB_REPO/web/aiweb/fa-gui.js" || { echo "web/aiweb/fa-gui.js 沒釘到新 SHA" >&2; exit 1; }
      WMSG="$(mktemp)"; with_trailer "網頁版：載入的 floating-assistant 釘到 ${HEAD_SHA:0:8}（$NOTES）" > "$WMSG"
      git -C "$WEB_REPO" add -A -- web/index.html web/aiweb
      git -C "$WEB_REPO" commit -q -F "$WMSG"; rm -f "$WMSG"
      git -C "$WEB_REPO" push -q "$REMOTE" main
      CODE="$(curl -sI -o /dev/null -w '%{http_code}' "https://raw.githubusercontent.com/sunneo/tw_stock_db/$HEAD_SHA/desktop-app/renderer/floating-assistant.js" || true)"
      node scripts/web-lazy-check.js --remote "$HEAD_SHA" || echo "⚠️ 網頁版區塊檔遠端驗證沒過（CDN 可能還沒更新，稍後重跑 node scripts/web-lazy-check.js --remote $HEAD_SHA）" >&2
      echo "釘住的檔案網址回應：HTTP $CODE（Pages 約 1～2 分鐘後換上新版；要確認頁面實際載入的版本，用 fa._createProgressWidget.toString() 之類檢查）"
      WARM_PENDING=1   # 預熱放在「完成」之後做（見檔尾 prewarm_cdn），不擋發布
    fi
  fi
fi

# 結尾清殘留（2026-11-16）：只清命令列含 fa-cold- 暫存標記的行程（預熱與量測留下的 Chrome），不碰使用者的 Chrome。失敗只略過，不擋發布。
node scripts/cleanup-orphans.js --kill || true

if [ "$DRY" = 1 ]; then say "完成（dry-run，什麼都沒推）：patch v$VERSION、desktop-app $HEAD_SHA"; else say "完成：patch v$VERSION、desktop-app $HEAD_SHA"; fi

# 冷載入預熱（2026-11-15 加、2026-11-23 移到「完成」之後）：對新釘的 jsDelivr 網址各發一次 curl，讓使用者第一次造訪網頁版就是 HIT。
# 發布早在上面「遠端驗證通過」時就生效了，這段只是加速網頁版第一次載入，所以放在完成標記之後；
# 同時 12 個請求（原本一個接一個要 2～4 分鐘），整段上限 60 秒，超過就放棄，失敗只警告。
if [ "${WARM_PENDING:-0}" = 1 ]; then
  WARM_T0=$(date +%s)
  WARM_LIST="$(mktemp)"; WARM_OUT="$(mktemp)"; node scripts/web-warm-urls.js "$HEAD_SHA" > "$WARM_LIST" 2>/dev/null || true   # 不用 process substitution，sh 也能跑
  if command -v timeout >/dev/null 2>&1; then WARM_RUN="timeout 60"; else WARM_RUN=""; fi
  grep -v '^$' "$WARM_LIST" | $WARM_RUN xargs -P 12 -n 1 sh -c 'c=$(curl -s -o /dev/null --max-time 15 -w "%{http_code}" "$0" || true); [ "$c" = 200 ] || echo "FAIL ${c:-無回應} $0"' > "$WARM_OUT" 2>/dev/null || true
  WARM_TOTAL=$(grep -c . "$WARM_LIST" || true); WARM_FAIL=$(grep -c '^FAIL' "$WARM_OUT" || true)
  grep '^FAIL' "$WARM_OUT" | head -3 | sed 's/^FAIL \([^ ]*\) /⚠️ jsDelivr 預熱失敗（HTTP \1）：/' >&2 || true
  rm -f "$WARM_LIST" "$WARM_OUT"
  echo "jsDelivr 預熱：$WARM_TOTAL 個網址，失敗 $WARM_FAIL 個（只是警告，不影響發布；用了 $(( $(date +%s) - WARM_T0 )) 秒）"
fi
echo "PUBLISH_DONE"
