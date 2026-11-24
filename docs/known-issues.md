# 已知问题（环境/工具链）

## 2026-11-24：PAT HTTPS 推送偶发挂死（本机 GitHub 加速环境）

**现象**：`git push https://<PAT>@github.com/...` 在本机多次出现命令长时间无输出（首次约 6 分钟、后续一次 300 秒被看门狗终止），但远端有时已实际收到推送。

**根因判断（环境）**：
- 本机 GitHub 访问经过 Steam++ 加速器/hosts（`api.github.com`、`release-assets.githubusercontent.com` 等被映射）；
- 默认 schannel 吊销检查失败（`CRYPT_E_NO_REVOCATION_CHECK`），只能用单次 `-c http.sslVerify=false`；
- 加速链路对长时间 HTTPS 上传/响应可能挂起，表现为 git 无进度输出；服务端实际可能已完成。

**当前处置约定**：
1. 每次推送都使用带超时的执行方式（如 `Start-Process` + `WaitForExit(120s)`，超时杀进程），并加
   `-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30`；
2. **不要盲推**：推送前后用短超时网页/`ls-remote` 核对远端 HEAD（允许 12–20s 超时）；
3. 若网页已显示目标提交，视为推送成功，不重复推；
4. 多提交可合并为一次推送，减少挂起次数；tag 与 main 分两次推（先 tag 后 main，避免 Release 工作流抢建 tag）；
5. 备选方案（未验证）：SSH over 443（`ssh.github.com:443`）需要本机配置 SSH key；或改用 GitHub Desktop/网页上传。
   本机未配置 SSH key，故未在本轮切换。

**最近一次**：2026-11-24 12:38 的推送挂起 300s 被看门狗终止，但网页核对 `d3ebbf7` 已到达远端；
后续提交改用带超时写法并逐次网页核对。

> 该问题只影响本机推送通道，不影响应用运行与 GitHub Actions。
