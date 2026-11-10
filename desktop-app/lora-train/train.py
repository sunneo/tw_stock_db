#!/usr/bin/env python
"""One-command, resumable, progressive LoRA pipeline for this project (run through train.sh / train.bat / train.ps1).

Stages (each writes out/runs/<name>/done/<stage>; re-running skips finished ones, --force redoes):
  tools     node extract_tools.js          -> data/real_tools_all.json (all registered tools + held-out split)
  data      node gen/merge_dataset.js      -> data/train.jsonl, data/heldout.jsonl
  sft       train_lora.py                  -> out/runs/<name>/sft            (LoRA SFT, CPU)
  eval_sft  eval_run.py                    -> out/runs/<name>/eval_sft.json  (base vs tuned, every group, ship gate)
  dpo       train_dpo.py                   -> out/runs/<name>/dpo            (skipped if no row has `rejected`)
  eval_dpo  eval_run.py                    -> out/runs/<name>/eval_dpo.json
  pack      pack_adapter.js                -> out/release/<name>/            (20 MB shards + manifest.json + join.js)
Env knobs: LORA_THREADS, LORA_BATCH, LORA_SEQ, LORA_EVAL_EVERY, DPO_MAX (see README.md).
"""
import argparse, json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(HERE)
ALL = ["tools", "data", "sft", "eval_sft", "dpo", "eval_dpo", "pack"]
FAST_BLOCKLY = "bench_L0_L5_L6.jsonl,bench_L1_L2.jsonl,bench_L3_L4.jsonl,bench_extra.jsonl"


def run(cmd, env=None, cwd=HERE):
    print("\n$ " + " ".join(cmd), flush=True)
    r = subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})})
    if r.returncode != 0:
        sys.exit(f"command failed ({r.returncode}): {' '.join(cmd)}")


def has_rejected(path):
    with open(path, encoding="utf-8") as f:
        return any('"rejected"' in l and json.loads(l).get("rejected") for l in f)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", default=time.strftime("r%Y%m%d"), help="run/release name, e.g. r3")
    ap.add_argument("--stages", default=",".join(ALL), help="comma list; default all")
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--base", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--blockly-files", default=FAST_BLOCKLY, help="blockly_matrix seed files (slow ones skipped by default)")
    ap.add_argument("--force", action="store_true", help="redo stages even if marked done")
    a = ap.parse_args()

    py = sys.executable
    run_dir = os.path.join(HERE, "out", "runs", a.name); done = os.path.join(run_dir, "done")
    os.makedirs(done, exist_ok=True)
    train = os.path.join(HERE, "data", "train.jsonl"); held = os.path.join(HERE, "data", "heldout.jsonl")
    sft_dir, dpo_dir = os.path.join(run_dir, "sft"), os.path.join(run_dir, "dpo")
    stages = [s.strip() for s in a.stages.split(",") if s.strip()]
    bad = [s for s in stages if s not in ALL]
    if bad:
        sys.exit(f"unknown stage(s): {bad}; valid: {ALL}")

    def stage(name, fn):
        if name not in stages:
            return
        mark = os.path.join(done, name)
        if os.path.exists(mark) and not a.force:
            print(f"== {name}: already done (use --force to redo)"); return
        print(f"\n==== stage {name} ====", flush=True); t0 = time.time(); fn()
        open(mark, "w").write(f"{time.time() - t0:.0f}s\n"); print(f"==== {name} done in {time.time() - t0:.0f}s ====")

    stage("tools", lambda: run(["node", "extract_tools.js"], cwd=HERE))
    stage("data", lambda: run(["node", os.path.join("gen", "merge_dataset.js")], env={"BLOCKLY_MATRIX_SEED_FILES": a.blockly_files}))

    def sft():
        run([py, "train_lora.py", "--model_name_or_path", a.base, "--train_file", train, "--output_dir", sft_dir,
             "--num_train_epochs", str(a.epochs), "--learning_rate", str(a.lr), "--logging_steps", "5", "--save_steps", "200"])

    def eval_(adapter, out):
        if not os.path.exists(held) or os.path.getsize(held) == 0:
            print("no heldout rows: skipping eval"); return
        run([py, "eval_run.py", "--base", a.base, "--adapter_dir", adapter, "--eval_file", held, "--json_out", out])

    def dpo():
        if not has_rejected(train):
            print("no row has `rejected`: skipping DPO (dpo adapter = sft adapter)")
            shutil.rmtree(dpo_dir, ignore_errors=True); shutil.copytree(sft_dir, dpo_dir); return
        run([py, "train_dpo.py", "--base", a.base, "--adapter_dir", sft_dir, "--train_file", train, "--output_dir", dpo_dir])

    def pack():
        final = dpo_dir if os.path.isdir(dpo_dir) else sft_dir
        ev = os.path.join(run_dir, "eval_dpo.json")
        if not os.path.exists(ev):
            ev = os.path.join(run_dir, "eval_sft.json")
        run(["node", "pack_adapter.js", final, a.name, ev])
        print(f"\nRelease ready: {os.path.join(HERE, 'out', 'release', a.name)}\n"
              f"Publish: copy that folder into the `lora-adapters` branch as <name>/ (see README.md).")

    stage("sft", sft)
    stage("eval_sft", lambda: eval_(sft_dir, os.path.join(run_dir, "eval_sft.json")))
    stage("dpo", dpo)
    stage("eval_dpo", lambda: eval_(dpo_dir, os.path.join(run_dir, "eval_dpo.json")))
    stage("pack", pack)


if __name__ == "__main__":
    main()
