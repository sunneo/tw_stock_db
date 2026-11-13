#!/usr/bin/env bash
# train_multi.sh 完成判定的小測試（§32.1）：用假的訓練程式（不載模型）驗證 [done]／[paused]／[fail]／跳過與續訓。
set -u; cd "$(dirname "$0")"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/data" "$T/bin"
echo '{}' > "$T/data/a.jsonl"; echo '{}' > "$T/data/b.jsonl"; echo '{}' > "$T/data/c.jsonl"
# 假訓練：依 MODE（環境變數）與 --train_file 的名字決定輸出。a 直接完成；b 第一段暫停、續訓時完成；c 失敗。
cat > "$T/bin/fake_train.sh" <<'FAKE'
#!/usr/bin/env bash
out=""; res=""; tf=""
while [ $# -gt 0 ]; do case "$1" in --output_dir) out="$2"; shift 2;; --resume_from_checkpoint) res="$2"; shift 2;; --train_file) tf="$2"; shift 2;; *) shift;; esac; done
mkdir -p "$out"; echo "fake weights" > "$out/adapter_model.safetensors"
case "$tf" in
  *a.jsonl) echo "[done] adapter saved to $out" ;;
  *b.jsonl) if [ -z "$res" ]; then mkdir -p "$out/checkpoint-5"; echo "[paused] step=5"; echo "[done] adapter saved to $out"; else echo "[done] adapter saved to $out"; fi ;;
  *c.jsonl) echo "boom" >&2; exit 3 ;;
esac
FAKE
chmod +x "$T/bin/fake_train.sh"
# 第一次跑
TRAIN_PY="$T/bin/fake_train.sh" TRAIN_DATA_DIR="$T/data" TRAIN_OUT_ROOT="$T/out" LORA_THREADS=1 bash train_multi.sh a b c > "$T/run1.txt" 2>&1
# 第二次跑：a 應跳過；b 應從 checkpoint 續訓並完成；c 仍失敗
TRAIN_PY="$T/bin/fake_train.sh" TRAIN_DATA_DIR="$T/data" TRAIN_OUT_ROOT="$T/out" LORA_THREADS=1 bash train_multi.sh a b c > "$T/run2.txt" 2>&1
pass=0; fail=0
check() { if eval "$2"; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1"; cat "$T/run1.txt" "$T/run2.txt"; fi; }
check "第一次：a 完成" 'grep -q "^\[done\] a" "$T/run1.txt"'
check "第一次：b 暫停（不算完成，不跳過）" 'grep -q "^\[paused\] b" "$T/run1.txt"'
check "第一次：c 失敗" 'grep -q "^\[fail\] c" "$T/run1.txt"'
check "第一次：b 暫停時根目錄已有權重，但仍不算完成（證明不能用根目錄判定）" '[ -f "$T/out/b/adapter/adapter_model.safetensors" ] && grep -q "^\[paused\] b" "$T/run1.txt"'
check "第二次：a 跳過" 'grep -q "^\[skip\] a" "$T/run2.txt"'
check "第二次：b 從 checkpoint 續訓並完成" 'grep -q "^\[resume\] b" "$T/run2.txt" && grep -q "^\[done\] b" "$T/run2.txt"'
check "第二次：c 仍失敗（不被跳過）" 'grep -q "^\[fail\] c" "$T/run2.txt"'
echo "train_multi 測試：通過 $pass、失敗 $fail"
[ "$fail" -eq 0 ]
