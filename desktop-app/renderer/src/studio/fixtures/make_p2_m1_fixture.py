"""P2 M1 的參考產生器（HF tokenizers）：用小測試分片訓練一個位元組級 BPE，輸出
  - p2_m1_tokenizer.json：HF 的分詞器檔（JS 端讀同一份）
  - p2_m1_expected.json：HF 對每一列「攤平後文字」的詞元 id（逐 token 比對的真值）
攤平規則與 llm_full_data.js 的 flattenRow 相同：text 直接用；messages 用 "role: content\\n" 串接。

用法：python make_p2_m1_fixture.py  （在本資料夾執行；需要 tokenizers 套件）
"""
import json
import os
import sys

from tokenizers import Tokenizer, decoders, models, pre_tokenizers, trainers

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
SHARD = os.path.join(HERE, "p2_m1_shard.jsonl")


def flatten(obj):
    if isinstance(obj.get("messages"), list):
        return "".join("%s: %s\n" % (m.get("role", "user"), m.get("content", "")) for m in obj["messages"])
    if isinstance(obj.get("text"), str):
        return obj["text"]
    return None


def main():
    texts = []
    with open(SHARD, encoding="utf-8") as f:
        for ln in f:
            if not ln.strip():
                continue
            t = flatten(json.loads(ln))
            if t:
                texts.append(t)
    tok = Tokenizer(models.BPE())
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tok.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(vocab_size=320, min_frequency=2,
                                  initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
                                  special_tokens=[])
    tok.train_from_iterator(texts, trainer=trainer)
    tok.save(os.path.join(HERE, "p2_m1_tokenizer.json"))
    expected = [{"text": t, "ids": tok.encode(t, add_special_tokens=False).ids} for t in texts]
    with open(os.path.join(HERE, "p2_m1_expected.json"), "w", encoding="utf-8") as f:
        json.dump({"tokenizers_version": __import__("tokenizers").__version__, "rows": expected}, f, ensure_ascii=False, indent=1)
    print("rows", len(expected), "vocab", tok.get_vocab_size(), "tokens(total)", sum(len(e["ids"]) for e in expected))


if __name__ == "__main__":
    main()
