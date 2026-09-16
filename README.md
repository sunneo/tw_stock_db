# shell-tools-backup

Backup mirror for small bash_execute sandbox command engines (jq-wasm browser ESM build, fast-xml-parser UMD build). See floating-assistant.js FA_ASSET_URLS.shellToolsBackupBase / _ensureJqLoaded / _ensureXqXmlParserLoaded.

這個branch可能同時裝著多個彼此獨立的小型資源（各自一個子資料夾），每個子資料夾底下都有自己的`manifest.json`（切成20MB份數，需要時才切）：

- `jq-wasm/`：來源 jq-wasm-flat，3 個檔案，1.0 MB
- `xml-parser/`：來源 xml-parser，1 個檔案，0.1 MB

This branch is force-pushed on regeneration — it carries no history, only the current snapshot of the resources listed above.
