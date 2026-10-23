<!-- 從 TODO.md 拆出（2026-10-23）：內容原封不動，只是改成一份一個主題。 -->

# TODO：程式設計 domain 的 patch 小工具與 CI/CD（2026-10-14）

已完成並驗證的內容見 [DESIGN.coding-ci.md](DESIGN.coding-ci.md)。還沒做：

- [ ] 用**真的需要登入**的 Gerrit／GitHub／Jenkins 實測一次（認證標頭、Gerrit `/a/` 前綴、Jenkins crumb、反向代理／SSO 環境）；目前只驗過公開服務與本機假伺服器。
- [ ] 真實弱模型走完整修 bug 流程（提示詞遵從度）；路由器是否把「修 bug／CI 失敗」導向 `coding`。
- [ ] Gerrit：回覆個別留言（reply／resolve）、`rebase`／`submit` 這類 review 動作；GitLab／Zuul／Azure DevOps 的連線。
- [ ] 網頁版的 `coding_edit`／`coding_patch_tool`（目前只有桌面版）。
- [ ] Jenkinsfile 解析：動態 stage、`@Library` 共享函式庫。
- [ ] 設定頁「CI/CD 連線」目前只在工程模式顯示；若要常駐可以從 `ADVANCED_ENGINEERING_CATS` 拿掉。
