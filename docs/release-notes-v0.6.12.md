# CordClean v0.6.12 发布说明

**发布日期：2026-11-23** · 前置版本：v0.6.11

本次更新分两部分：先把两个 AI 插件按「可用性/正确性」加固（未配置 Key 时明确不可用，不做离线绕过），再把 12 个内置插件的整改结果收口并发布。无破坏性数据格式变更。

## AI 插件加固

### AI 清理顾问（`ai`）

- **提示词契约**：分析提示词限制 `taskId` 只能来自任务画像、体积不得大于画像、JSON 必须可解析，并附合法示例；插件生成提示词补充 JSON 转义、禁止 TODO 占位符、`files` 路径规则与可解析示例；修复 `imageHint` 里 `\n` 字面量显示 bug；
- **生成结果可用性**：新增 `preparePluginDraft` 预检（files 路径归一、单文件包装 `index.mjs`、`manifest.entry`/`client` 按实际文件修复、依赖与相对 import 校验、占位符/体积/文件数上限），校验失败带具体错误自动重试；不放松 `checkPluginSource` 安全闸门；
- **错误分类与重试**：新增 `isRetryableAiCode` 统一判定；429/503 遵守 `Retry-After`（含 0、上限 10s）、退避等待可取消；`CANCELLED` 不再错误回退非流式；SSE `finish_reason=length` 正确报「输出被截断」；`AUTH` 直接失败不重复请求；
- **结果可信度**：虚构 suggestion `taskId` 降级为「未关联任务」，空 summary 中性兜底；
- **引导准确性**：未配置 Key / 未启用 / 关闭在线 AI / 无模型时明确「不可用 + 如何配置」，不做任何离线暗示或绕过。

### AI 插件工坊（`ai-workshop`）

- 新增 `contract.ts`：工坊 system prompt 注入 v2 包契约（清单/files/client/import 白名单/禁止 API/`emit_plugin` 输出要求）；`prepareWorkshopDraft` 做安装前自检 + 自动修复（apiVersion/engines/kind/entry/permissions/inject/contributes.commands/client 声明/依赖/反斜杠路径/bridge），错误可读并回喂模型重试；复用 shared 的 `validatePluginManifest`/`checkPluginSource` 与宿主 bridge 检查，不放松安全限制；
- 失败按 truncated / contract / syntax / empty 分类，给出准确错误码（契约错误 → BAD_REQUEST，界面归为校验失败）；新增 retry 阶段进度；仅截断时扩容 token；只有 files 无 code 时按 entry → `index.mjs` 兜底；校验期间取消返回 CANCELLED；
- 无 Key/无模型时明确不可用 + 去配置；安装失败可读归因并自动重新校验；展示「已自动修复」记录与安装前二次校验说明。

## 内置插件整改收口（v0.6.11 后）

- **核心**：`cleaner.scan({ taskIds })` 传未知 id 改为报错（不再静默回退全量扫描）；空数组仍表示全部任务；
- **empty-dirs**：AppData/ProgramData/Windows/Program Files/CordClean 自身数据目录 + Windows shell 文件夹列入白名单，默认扫描根改为用户主目录；真实扫描 1,123 项/30 错误 → 1 项/0 错误；
- **large-files / duplicates**：应用运行时库与程序/系统目录加入排除表；真实扫描 large-files 3 项/613 MB → 2 项/386 MB、duplicates 12 项/30.4 MB → 7 项/16.3 MB，避免把微信 `flue.dll`、应用 DLL/onnx 模型当垃圾；
- **registry**：新增孤儿卸载项检测（安装目录/卸载器已丢失），只读探测 + `.reg` 备份清理；
- **leftovers**：扩大残留目录扫描根（`%LOCALAPPDATA%\Programs`、`%PROGRAMDATA%`）并排除自身/系统/缓存目录，目录项只提示不可删；
- **scheduler**：新增「启动补跑错过的计划」与 `nextRunAt` 计算；事件带 `nextAt` + `appRunningOnly:true`，明确仅在应用运行期间定时；
- **shortcuts**：修复 MSI advertised/UWP 快捷方式误判，新增悬空 `file://` `.url` 检测；
- **recycle**：新增 `$I/$R` 配对异常检测与清理（孤立元数据/数据文件、损坏 `$I`），异常项默认不勾选；
- **startup**：计划任务从「只报告」升级为可禁用/可恢复（`schtasks /Change /DISABLE|/ENABLE`，可注入 runner，dryRun 无副作用），HKLM/计划任务/公共启动文件夹标记需管理员；
- **rule-pack**：被安全门拒绝规则 17 → 0、扫描权限错误噪声 72 → 0；删除 16 条无法安全执行的规则（驱动器根/受保护 Windows 目录/受保护 Firefox compact_db），总规则 401 → 385（默认装载 31 类/296 条），真实命中保持 467 项 / 约 3.88 GB。

## 验证结果

- `pnpm typecheck` / `pnpm typecheck:ui`：通过；
- `pnpm test`：**106 个测试文件 / 931 个用例通过**（v0.6.11 为 95/716）；
- `pnpm build`：通过（UI + Electron 外壳）；
- `pnpm docs:check`：通过（12 插件 / 38 任务 / 73 RPC / 106 文件 / 931 用例 / 385 规则）；
- `node scripts/e2e-ui.mjs`：7 页面 + 侧边栏折叠/搜索/快捷键 + 扫描全链路通过，无 JS 异常；
- 12 个内置插件 `scripts/audit-plugin.ts --clean`：契约违例 0；分析类插件沙箱真实清理复核 0 残留；
- AI 相关测试 25 文件 / 173 用例通过；本地 stub 实测：未配置 Key → AUTH 明确不可用；在线分析虚构 taskId 正确降级；生成的插件草稿经宿主 `validateAiPluginPackage` 0 错误。

## 兼容性与升级注意

- 未配置 API Key 时 AI 两插件保持**不可用**（这是预期行为），界面只提供配置引导，不提供离线/模板绕过；
- `cleaner.scan` 对未知 taskIds 从「静默全量扫描」改为抛错；外部脚本若曾依赖该回退行为需修正；
- 规则库总量 401 → 385（删除的是从未生效的安全门拒绝规则）；默认装载 31 类/296 条；
- 计划任务清理只是**禁用**（可恢复），不会删除任务；HKLM/计划任务操作需要管理员；
- 数据目录、设置结构、插件默认启用状态、清理/隔离/恢复安全限制均无破坏性变更，可直接覆盖升级。

## 已知限制

- scheduler 只在应用运行期间触发，启动时只补「最近一次错过的触发点」；
- AI 分析/生成的语义正确性仍依赖模型质量与提示词，界面保留人工复核；
- 「可运行」验证到安装前校验 + 静态契约 + 沙箱清理，未做真实模型端到端安装后运行时冒烟；
- 本机系统较干净，registry/leftovers/recycle/shortcuts 真实命中为 0，其检测能力由注入式单测覆盖。
