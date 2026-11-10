#!/usr/bin/env python
"""Rule-graded grouped eval: base vs base+adapter side by side. Grading ported from ref/lora/eval_run.py.

Generation: greedy, repetition_penalty 1.1, Qwen3 no-think, left-padded batches, adapter MERGED into the base for the
tuned pass (same as the reference). Prompt = chat template (+tools) + prefill (lora_common).
Grading per task/kind (reference rules): agent call_* -> tool name + arguments exact; planner -> tool (+query) exact;
rtool call -> name+arguments exact, ask -> must be a question and not 'not available', missing -> must say not available,
direct/nofit -> no trailing 'not sure'; uml ask_*/edit_* -> allowed value / letter; toolwire -> letter; colu (digit prefill)
-> digit; writer/agent use -> technical tokens from chosen present, none copied from rejected, no trailing 'unsure'.
Our unified rows (no task/kind) fall back to generic rules: <tool_call> name+args, {"choice": N}, letter, exact.
Groups reported (all of them, losses too): task/kind, group/<g>, seen/<seen>/<kind> (or heldout|seen by split),
pos/<kind>/<pos> (answer-position bias), plus domain/stage for unified rows.
Env: LORA_THREADS, LORA_EVAL_EVERY=n (every n-th row; same for base and tuned), LORA_EVAL_BATCH.

    lora-train/.venv/Scripts/python lora-train/eval_run.py --adapter_dir lora-train/out/adapter_r2 \
        --eval_file lora-train/data/heldout.jsonl [--eval_file ...] [--limit 200]
"""
import argparse, collections, json, os, random, re
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from lora_common import read_jsonl, normalize, prompt_text

TECH = re.compile(r"[A-Z]{3,}[A-Z0-9_]*|0x[0-9A-Fa-f]+|\d+|\w+(?:[/_.<>-]+[\w<>]+)+")


def tech(s):
    return set(TECH.findall(s))


def parse_call(t):
    m_ = re.search(r"<tool_call>\s*(\{.*?\})\s*(?:</tool_call>|$)", t, re.S)
    if not m_:
        return None
    try:
        return json.loads(m_.group(1))
    except Exception:
        return "bad"


def same_call(want, c):
    return isinstance(c, dict) and isinstance(want, dict) and c.get("name") == want.get("name") and c.get("arguments") == want.get("arguments")


def generic(x, o):
    ch = x["prefill"] + x["chosen"]   # prefill + continuation = the full intended assistant text
    if "<tool_call>" in ch:
        return same_call(parse_call(ch), parse_call((x["prefill"] + o).strip())), ""
    m_ = re.search(r'"choice"\s*:\s*"?(\d+)', ch)
    if m_:
        g = re.search(r'"choice"\s*:\s*"?(\d+)', x["prefill"] + o)
        return bool(g) and g.group(1) == m_.group(1), ""
    if re.fullmatch(r"\s*(答案[:：]\s*)?[A-Za-z]\s*", ch):
        w = re.search(r"([A-Za-z])\s*$", ch).group(1).upper()
        g = re.search(r"(?:答案[:：]\s*)?([A-Za-z])\s*[\.\)]?\s*$", o.strip().split("\n")[-1] if o.strip() else "")
        return bool(g) and g.group(1).upper() == w, ""
    return re.sub(r"\s+", "", o) == re.sub(r"\s+", "", ch), ""


def grade(x, o):
    k = x["kind"]; t = o.strip(); c = parse_call(t); task = x["task"]
    if task == "agent" and k in ("call_ref", "call_rag", "call_other"):
        ok = same_call(parse_call(x["chosen"]), c); return ok, "call" if ok else t[:80]
    if task == "planner":
        want = json.loads('{"tool": "' + x["chosen"]); full = x["prefill"] + t; e = full.find("}")
        try:
            got = json.loads(full[: e + 1])
        except Exception:
            return False, "bad json"
        ok = got.get("tool") == want["tool"] and (want["tool"] == "none" or got.get("query") == want["query"]); return ok, "plan" if ok else full[:80]
    if task == "rtool":
        if k == "call":
            ok = same_call(parse_call(x["chosen"]), c); return ok, "call" if ok else t[:100]
        if c is not None:
            return False, "called a tool"
        if not t:
            return False, "empty"
        if k == "ask":
            return ("?" in t or "？" in t or re.search(r"which|what|please|請問|請", t, re.I)) is not None and not re.search(r"not available|沒有", t), t[:60]
        if k == "missing":
            return bool(re.search(r"not available|isn.t available|does not exist|doesn.t exist|not in the list|不存在|沒有這個", t, re.I)), t[:80]
        return True, ""
    if task == "uml":
        if k.startswith("ask"):
            m_ = re.search(r'"answer"\s*:\s*"([^"]*)"', x["prefill"] + o)
            ok = bool(m_) and m_.group(1) == re.search(r'"answer": "([^"]*)"', x["chosen"]).group(1)
            return ok, "" if ok else ("format: " if not m_ else "wrong " + m_.group(1) + ": ") + o[:30]
        if k.startswith("edit"):
            m_ = re.search(r'"?\s*([A-Za-z])\b', o); ok = bool(m_) and m_.group(1).upper() == re.search(r'"([A-Z])"', x["chosen"]).group(1)
            return ok, "" if ok else "wrong " + (m_.group(1) if m_ else "?")
    if task == "toolwire":
        m_ = re.search(r'"choice"\s*:\s*"?\s*([A-Ca-c1-3])\b', o) or re.match(r'\A\s*["\']?\s*([A-Ca-c])\s*["\']?\s*[.)]?\s*\Z', o) or re.search(r"\banswer\s*(?:is|:)?\s*([A-Ca-c])\b", o, re.I)
        if not m_:
            return False, "format: " + o[:40]
        g = m_.group(1); g = "ABC"[int(g) - 1] if g.isdigit() else g.upper(); ok = g == re.search(r'"([ABC])"', x["chosen"]).group(1)
        return ok, "" if ok else "wrong " + g
    if task == "colu" and re.fullmatch(r"\s*\d\s*\}?\s*", x["chosen"]):   # reference colu rows: digit continuation after a '{"choice":' prefill
        m_ = re.match(r"\s*(\d)\s*\}?", o); got = m_.group(1) if m_ else None; fmt = bool(re.match(r"\s*\d\s*\}", o)); ok = got is not None and got == x["chosen"].strip()[0]
        return ok, "" if ok else ("format: " if not fmt else "wrong " + str(got) + ": ") + o[:30]
    if task in ("agent", "writer") or k in ("unsure", "direct", "nofit", "use", "answer", "copycode"):
        if c is not None:
            return False, "called a tool"
        if not t:
            return False, "empty"
        unsure = bool(re.search(r"(not sure|不確定|不确定)[。.!]*$", t, re.I))
        if k == "unsure":
            return (t.rstrip(".。").lower() in ("not sure", "不確定")), t[:60]
        if k in ("direct", "nofit", "ask"):
            return not unsure, ""
        rej = x.get("rejected") or ""; need = tech(x["chosen"]) - tech(rej); bad = tech(rej) - tech(x["chosen"])
        if unsure:
            return False, "trailing unsure: " + t[-40:]
        if need - tech(t):
            return False, "missing " + ",".join(sorted(need - tech(t))) + " | " + t[:60]
        if bad & tech(t):
            return False, "copied other " + ",".join(sorted(bad & tech(t)))
        return True, ""
    return generic(x, o)


def safe_grade(x, o):
    try:
        return grade(x, o)
    except Exception as e:   # malformed reference-style row or odd output -> count as wrong, never crash the whole eval
        return False, "grader error: " + type(e).__name__


def answer_pos(x):
    if x.get("pos") is not None:
        return str(x["pos"])
    p = (x.get("meta") or {}).get("pos")
    if p is not None:
        return str(p)
    m = re.search(r'"choice"\s*:\s*"?(\d+)', x["prefill"] + x["chosen"]) or re.search(r"^\s*(\d)\s*\}?\s*$", x["chosen"])
    return m.group(1) if m else None


def run_model(model, tok, rows, max_new):
    outs = {}; B = int(os.environ.get("LORA_EVAL_BATCH", 12))
    order = sorted(range(len(rows)), key=lambda i: len(prompt_text(tok, rows[i])))
    for s in range(0, len(order), B):
        idx = order[s: s + B]
        enc = tok([prompt_text(tok, rows[i]) for i in idx], return_tensors="pt", padding=True)
        mx = 4 if all(rows[i]["task"] == "colu" and rows[i]["prefill"] for i in idx) else max_new
        with torch.no_grad():
            g = model.generate(**enc, max_new_tokens=mx, do_sample=False, repetition_penalty=1.1, pad_token_id=tok.pad_token_id)
        for j, i in enumerate(idx):
            outs[i] = tok.decode(g[j][enc["input_ids"].shape[1]:], skip_special_tokens=True)
        print(f"[eval] {min(s + B, len(order))}/{len(order)}", flush=True)
    return outs


def group_names(x):
    g = [f"{x['task']}/{x['kind']}"]
    grp = x.get("group") or (x.get("meta") or {}).get("family")
    if grp:
        g.append("group/" + grp)
    g.append(f"seen/{x['seen']}/{x['kind']}" if x.get("seen") else ("heldout/" if x.get("split") == "heldout" else "seen/") + x["task"])
    p = answer_pos(x)
    if p is not None:
        g.append(f"pos/{x['kind']}/{p}")
    return g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--adapter_dir", required=True)
    ap.add_argument("--eval_file", action="append", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--max_new", type=int, default=110)
    ap.add_argument("--targets", default="", help="comma list of group-name substrings that must clearly win; default = groups with n>=5 and base<50%% (excluding pos/*)")
    ap.add_argument("--win_margin", type=float, default=0.10)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--json_out", default="")
    a = ap.parse_args()

    torch.set_num_threads(int(os.environ.get("LORA_THREADS", torch.get_num_threads())))
    rows = [normalize(r) for f in a.eval_file for r in read_jsonl(f)]
    every = int(os.environ.get("LORA_EVAL_EVERY", 1))
    rows = rows[::every]
    if a.limit and len(rows) > a.limit:
        random.Random(a.seed).shuffle(rows); rows = rows[: a.limit]
    print(f"[eval] rows={len(rows)} (LORA_EVAL_EVERY={every}, limit={a.limit}; identical rows for base and tuned)", flush=True)

    from peft import PeftModel
    tok = AutoTokenizer.from_pretrained(a.base); tok.padding_side = "left"
    m = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.float32).eval()
    base_out = run_model(m, tok, rows, a.max_new)
    m = PeftModel.from_pretrained(m, a.adapter_dir).merge_and_unload().eval()
    tuned_out = run_model(m, tok, rows, a.max_new)

    st = collections.defaultdict(lambda: [0, 0, 0]); det = []
    for i, x in enumerate(rows):
        ob, ot = safe_grade(x, base_out[i]), safe_grade(x, tuned_out[i])
        for name in group_names(x):
            st[name][0] += 1; st[name][1] += bool(ob[0]); st[name][2] += bool(ot[0])
        det.append({"i": i, "id": x.get("id"), "key": f"{x['task']}/{x['kind']}", "base_ok": bool(ob[0]), "tuned_ok": bool(ot[0]), "base_out": base_out[i], "tuned_out": tuned_out[i], "note": ot[1]})

    print("group\tn\tbase\ttuned\tflag")
    regress, res = [], {}
    for name, (n, b, t) in sorted(st.items()):
        flag = "REGRESSION" if t < b else ""
        if flag:
            regress.append(name)
        res[name] = {"n": n, "base": b, "tuned": t}
        print(f"{name}\t{n}\t{b}/{n}\t{t}/{n}\t{flag}")
    kinds = {k: v for k, v in st.items() if "/" in k and not k.startswith(("group/", "seen/", "heldout/", "pos/"))}
    print(f"TOTAL base {sum(v[1] for v in kinds.values())}/{sum(v[0] for v in kinds.values())}  tuned {sum(v[2] for v in kinds.values())}/{sum(v[0] for v in kinds.values())}")

    if a.targets:
        wanted = [s.strip() for s in a.targets.split(",") if s.strip()]
        targets = [k for k in st if any(w in k for w in wanted)]
    else:
        targets = [k for k, (n, b, t) in st.items() if n >= 5 and b / n < 0.5 and not k.startswith("pos/")]
    weak = [k for k in targets if not (st[k][2] - st[k][1] >= 2 and (st[k][2] - st[k][1]) / st[k][0] >= a.win_margin)]
    print("\n=== ship gate (rule: SHIP only if no group regresses AND target groups clearly win) ===")
    r1 = not regress
    print(f"[{'PASS' if r1 else 'FAIL'}] no group regresses vs base" + ("" if r1 else f" -> regressed: {regress}"))
    r2 = bool(targets) and not weak
    print(f"[{'PASS' if r2 else 'FAIL'}] every target group wins by >= {a.win_margin:.0%} and >= 2 rows (targets={len(targets)})" + ("" if r2 else f" -> not clearly winning: {weak or 'no target groups found'}"))
    print("Notes: 'clearly win' = +%.0f%% and >=2 rows is a heuristic, not a significance test; groups with n<5 are noisy; rule grading != real user experience; not verified on the q8/ONNX runtime." % (a.win_margin * 100))
    print("VERDICT:", "SHIP-CANDIDATE" if (r1 and r2) else "DO NOT SHIP")
    if a.json_out:
        json.dump({"groups": res, "regress": regress, "targets": targets, "not_winning": weak, "rows": det}, open(a.json_out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
