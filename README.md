# whisper-model-backup

Single-commit backup of the Whisper `q8` model (`onnx-community/whisper-base`) used by floating-assistant.js `transcribe_media`. Large files split into 20MB parts.

Consumed by `_prefetchWhisperModelFromRepo()` when the HuggingFace fetch fails. Regenerate with `node web/tools/build-whisper-backup-branch.mjs --commit --push`.
