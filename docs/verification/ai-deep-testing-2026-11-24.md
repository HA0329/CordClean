# AI 两插件真实模型深度测试记录（2026-11-24）

> 范围：`ai`（AI 清理顾问）与 `ai-workshop`（AI 插件工坊）。
> 真实模型：`api.deepseek.com`（deepseek-flash / deepseek-v4-pro）；临时 Key 仅通过环境变量注入，
> 未写入仓库/文档/截图/日志。所有验证使用隔离临时数据目录，不删除真实文件、不污染真实配置。

## 1. AI 清理顾问（ai）

### 第一轮矩阵（修复前，20 项 / 通过 19）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 真实 probe | ✅ | HTTP 200，deepseek-flash |
| 真实分析（补充说明） | ✅ | summary/建议基于本机画像；隐私捕获 13,234 字符请求体 |
| 隐私：出站不含真实路径/文件名 | ✅ | fixture 路径/`private-report-Q3.bin`/`客户名单…`/`私人目录` 均未出现 |
| 隐私：出站不含 API Key | ✅ | 请求体不包含 Key |
| 选择清理项 | ✅ | 2 项、6,291,456 B，全部是真实候选 itemId、0 越界 |
| 图片+文字分析（deepseek-flash） | ✅ | 真实 vision 返回；请求体含 image_url/base64 |
| 错误 Key | ✅ | `AUTH`（401），不重试 |
| 断网/连接拒绝 | ✅ | `NETWORK` |
| 非法模型 | ✅ | `BAD_REQUEST`（HTTP 400 可读信息） |
| 真实网络超时（本地黑洞服务） | ✅ | `TIMEOUT`，约 3.1s，不回退重打 |
| 取消 | ✅ | `CANCELLED` |
| 并发两次分析（修复前） | ✅/❌ | 两次都成功，未互相取消（发现缺陷 D2） |
| maxTokens=1 边界 | ✅ | 被安全规范化，不崩溃 |
| v4-pro + 图片 | ✅ | 明确「当前模型不支持图片输入」 |
| 超长中文补充说明 | ✅ | 正常分析 |
| 空补充说明（修复前） | ❌ | 偶发 `INVALID_RESPONSE`「模型没有返回最终答案（可能只输出了思维链）」 |
| 首次使用/未配置 Key | ✅ | `AUTH` 明确不可用 + 配置引导 |
| 重启后配置恢复 | ✅ | 同数据目录重启后 configured=true、模型保留 |

### 第二轮（修复前，7 项 / 通过 5）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 空补充说明连续 5 次 | ❌ 4/5 | 其中 1 次「输出被截断（length）」；低 maxTokens 时推理 token 挤占输出 |
| 真实请求级截断（max_tokens=4） | ✅ | `finish_reason=length`、truncated=true |
| 429 限流分类（本地真实 HTTP 429） | ✅ | `RATE_LIMIT`，status=429 |
| 直接回复路径 | ✅ | 返回「收到，不分析。」、0 建议 |
| deepseek-v4-pro 文本分析（maxTokens=4096） | ❌ | 推理 token 占满 4096 → 截断/空答 |
| 启动后立刻取消 | ✅ | `CANCELLED` |
| 顺序重复提交 3 次 | ✅ | 3/3 |

### 修复后真实复验

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 空补充说明连续 3 次 | ✅ 3/3 | 自动提高 max_tokens 重试后均成功 |
| deepseek-v4-pro（低 maxTokens） | ✅ | 自动重试 `max_tokens=16384` 后成功返回 |
| 并发提交两次 | ✅ | 第一次 `CANCELLED`、第二次成功（真实模型） |

## 2. AI 插件工坊（ai-workshop）

### 真实模型主矩阵（修正测试夹具后，28/28 通过）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 生成 v2 包 | ✅ | 7.5–18s，files=index.mjs、零依赖、id 由模型按需求命名 |
| 宿主 validate | ✅ | errors=0（warnings 为自动修复提示） |
| 安装→启用→注册任务 | ✅ | `external:deep-temp-large` active，任务 `deep-temp-large` |
| 生成插件真实运行 | ✅ | 扫描 TEMP 命中 11 项、0 错误 |
| 卸载 → 无残留 | ✅ | 插件从列表消失，`.ai-packages`/`generated-plugins` 无残留 |
| 卸载后重装 | ✅ | 再次安装成功（`uninstall-package` 后无「已安装」残留状态） |
| 第三方依赖（is-number@^7） | ✅ | 模型声明依赖；真实 npm 下载；node_modules 存在；安装→启用→卸载 |
| 原生插件（kind=native） | ✅ | 生成/validate/安装/启用/卸载 |
| UI 贡献（client.mode=page） | ✅ | `clientPage` 返回 `{pluginId, entry:'index.html'}`；安装/卸载 |
| 依赖下载失败回滚 | ✅ | 依赖不存在时安装报错，插件目录不存在、无临时残留（真实 npm E404） |
| 空需求 | ✅ | `BAD_REQUEST` |
| 生成中取消 | ✅ | `CANCELLED`；取消后下一次生成成功 |
| 并发提交 | ✅ | 前一次 `CANCELLED`，后一次成功，不串结果 |
| 错误 Key / 断网 / 非法模型 | ✅ | `AUTH` / `NETWORK` / `BAD_REQUEST` 可读错误 |
| 中文/空格/超长需求 | ✅ | 真实生成成功（`deep-unicode-task`） |
| 超时（本地黑洞服务） | ✅ | `TIMEOUT`，约 6s，不长期挂起 |
| 安装后重启 | ✅ | 重启后插件自动加载 active；卸载后无残留 |
| 同名重复安装 | ✅ | 明确拒绝「同名插件已安装」 |

### 三类生成插件“运行”加深（6/6 通过）

| 类型 | 结果 | 证据 |
| --- | --- | --- |
| 依赖插件 | ✅ | 安装 active，任务 `deep-run-dep` 真实扫描命中 11 项 / 0 错误；卸载无残留 |
| 原生插件 | ✅ | active，任务 `deep-run-native` 扫描命中 500 项 / 0 错误；卸载无残留 |
| UI 插件 | ✅ | active，任务 `deep-run-ui` 扫描命中 1,916 项 / 0 错误；clientPage 可解析；卸载无残留 |

### 事务级补充（4/4 通过，无真实模型）

| 场景 | 结果 |
| --- | --- |
| 依赖安装失败 → 回滚并清理 | ✅（npm E404，插件目录/临时目录均无残留） |
| 正常安装 → 同名重复安装拒绝 | ✅ |
| 卸载后目录清理 | ✅ |
| 回滚后再次安装成功 | ✅ |

## 3. 发现的缺陷与修复

### D1 顾问空输出/截断不重试（真实缺陷，已修）

- 现象：真实模型偶发只返回思维链/空内容；低 `maxTokens` 切换推理模型时被截断，直接报 `INVALID_RESPONSE`，用户需手动再点一次/调 token。
- 修复：`analyze` 对 `INVALID_RESPONSE`（空内容/非法 JSON/截断）自动重试一次，并把 `max_tokens` 提升到至少 16384（按模型上限收敛）；截断信息仍保留在最终错误中。真实复验：空补充说明 3/3、v4-pro 低 token 通过。
- 回归测试：`tests/ai-hardening.test.ts` 新增「首次空内容自动重试成功」「持续空内容只重试一次」；截断用例更新为两次流式尝试、不回退非流式。

### D2 顾问并发提交不取消旧分析（真实缺陷，已修）

- 现象：连续/并发调用 `analyze` 时两次请求同时进行、都可能成功并覆盖缓存，浪费 token。
- 修复：新分析开始时 abort 上一次分析；首次以 `CANCELLED` 结束，第二次正常返回。
- 回归测试：新增并发提交用例（stub 挂起第一次请求、第二次成功后校验状态）；真实模型复验一次 `CANCELLED` + 一次成功。

### 测试夹具问题（非产品缺陷）

- 宿主 validate 使用 `version: 'test'` 时，清单 `engines.cordclean` 被校验为 `^test` 非法 → 测试脚本改用真实版本号；
- 包插件卸载误用 `plugins/uninstall`（只适用于单文件 external），已改用 `plugins/uninstall-package`；
- 回滚夹具缺少 `permissions/apply`，已补全后真实触发了 npm 依赖失败回滚；
- 修复后工坊 28/28、事务 4/4、三类运行 6/6。

## 4. 仍存在的局限

- 真实 provider 无法强制 429；限流分类用本地真实 HTTP 429 验证（`RATE_LIMIT`/status=429），非真实 provider 限流。
- 工坊 `maxTokens` 下限为 32768，真实输出截断分支难以稳定触发；截断/重试逻辑由单测覆盖。
- AI 输出语义正确性仍依赖模型；生成插件的“可运行”验证到安装/启用/真实扫描/卸载，不等于对所有生成变体做穷举运行时冒烟。
- 本轮未重新做 UI 页面切换/刷新的交互式截图回归（无 UI 代码改动）；应用重启、插件持久化、页面渲染由既有 e2e 覆盖。
- 未发版：版本号/Release 保持 v0.6.14，等待用户确认。
