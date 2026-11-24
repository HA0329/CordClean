# 规则库参考 PC-Cleaner v0.9.19 扩展记录（2026-11-24）

> 参考文件：`D:\桌面\deepseek-harness\myproject\PC-Cleaner-v0.9.19\PC-Cleaner\pc_cleaner\rules.json`
> 范围：`packages/plugins/rule-pack`（只改规则数据与新增回归测试/文档，不改无关模块）
> 安全原则：不碰用户数据、不误删应用运行时文件、唯一入库管线 0 拒绝。

## 1. 差异分析

PC-Cleaner v0.9.19：**34 分类 / 300 目标**；CordClean 扩展前：37 分类 / 385 条规则（迁移时额外增加了 extra_* 分类），扩展后：**37 分类 / 395 条**。
按「分类 + 目标路径」逐条对齐后：

- **分类缺失**：`downloads_temp`、`downloads_installers`、`downloads_extracted`、`system_wer`、`dev_purge`、`broken_shortcuts`；
- **分类风险被弱化**：`system_logs`（PC moderate+require_admin → 我们 safe）、`database_compact`（PC moderate → 我们 safe）；
- **目标缺失（可按安全边界采纳的）**：NVIDIA ComputeCache；QQ 浏览器 / 搜狗浏览器缓存；Slack/Teams/飞书/Lark 缓存；传递优化跟踪日志；系统级 WER Temp；设备元数据缓存；
- **目标缺失但未采纳**：用户 Downloads 的未完成下载/安装包/镜像/压缩包（`downloads_*`）、`%WINDIR%`/`%PROGRAMDATA%` 下的单个日志文件（KB*.log/MEMORY.DMP/事件归档/ETL）、驱动器根 pnpm store、`$WinREAgent`、`found.*`、`<CWD>` 构建产物、Firefox compact_db、broken_shortcuts（详见 §5）；
- **写法过时/安全差异**：PC-Cleaner 允许 `clear_dir` 多路径、`skip_if_in_use`、`older_than_days`、`min_size_mb`、`require_extracted_sibling`；CordClean 已支持前者，`require_extracted_sibling` 未实现；
- PC 的 `broken_shortcuts` 在 CordClean 由独立 `shortcuts` 插件实现（规则包类型尚未实现，不重复造规则）。

## 2. 新增规则（10 条，均有来源标注）

| id | 分类 | 名称 | target | 风险 | 来源（PC-Cleaner 0.9.19） |
| --- | --- | --- | --- | --- | --- |
| gpu_caches-8 | gpu_caches | NVIDIA 计算缓存(ComputeCache) | clear_dir `%LOCALAPPDATA%/NVIDIA/ComputeCache` | safe | gpu_caches/NVIDIA 计算缓存 |
| web_cache-29 | web_cache | QQ 浏览器缓存 | glob_dirs `.../QQBrowser/User Data` `*/Cache` | safe | web_cache/QQ 浏览器缓存 |
| web_cache-30 | web_cache | QQ 浏览器代码缓存 | glob_dirs `.../QQBrowser/User Data` `*/Code Cache` | safe | web_cache/QQ 浏览器代码缓存 |
| web_cache-31 | web_cache | 搜狗浏览器缓存 | clear_dir `%LOCALAPPDATA%/SogouExplorer/WebCache` | safe | web_cache/搜狗浏览器缓存 |
| comm_caches-5 | comm_caches | Slack 缓存 | clear_dir paths Cache/Code Cache/GPUCache | safe | comm_caches/Slack 缓存 |
| comm_caches-6 | comm_caches | Microsoft Teams 缓存 | clear_dir paths AppData+LocalAppData 缓存 | safe | comm_caches/Microsoft Teams 缓存 |
| comm_caches-7 | comm_caches | 飞书/Lark 缓存 | clear_dir `feishu/cache` + `Lark/cache` | safe | comm_caches/飞书/Lark 缓存 |
| system_admin-18 | system_admin | 设备元数据缓存 | clear_dir `%PROGRAMDATA%/Microsoft/Windows/DeviceMetadataCache`，需管理员 | caution | system_admin/设备元数据缓存 |
| system_logs-29 | system_logs | 传递优化跟踪日志 | clear_dir `.../DeliveryOptimization/Logs`，需管理员 | caution | system_logs/传递优化跟踪日志 |
| crash_telemetry-6 | crash_telemetry | 系统级 WER 临时文件 | clear_dir `%PROGRAMDATA%/.../WER/Temp`，需管理员 | caution | system_wer/系统级 WER 临时文件 |

所有新增规则均带 `note`：`来源：PC-Cleaner v0.9.19 <分类>/<目标>`，并带 `skipIfInUse: true`（需管理员的加 `requiresAdmin`）。

## 3. 风险等级校正（迁移时弱化）

| 分类 | 原 | 校正后 | 依据 |
| --- | --- | --- | --- |
| system_logs | safe | **caution**（全部规则 caution + requiresAdmin） | PC-Cleaner v0.9.19 system_logs 为 moderate + require_admin |
| database_compact | safe | **caution** | PC-Cleaner v0.9.19 database_compact 为 moderate；VACUUM 不删数据但会临时占磁盘 |

分类总数仍 37，规则任务数仍 31（31 类默认任务），任务总数 38 不变。

## 4. 真实扫描前后对比

同一台机器、默认设置、隔离 dataDir，扫描全部默认规则任务：

| 指标 | 扩展前 | 扩展后 | 变化 |
| --- | --- | --- | --- |
| 入库规则（接受） | 296 | **306** | +10 |
| 规则任务 | 31 | 31 | 0 |
| 扫描项 | 462 | **463** | +1 |
| 可清理体积 | 3,442,944,594 B | **3,444,019,092 B** | +1,074,498 B（+1.07 MB） |
| 扫描错误 | 0 | **0** | 0 |
| 扫描取消 | false | false | — |

新增唯一命中项：`C:\ProgramData\Microsoft\Windows\DeviceMetadataCache`（713,480 B，设备元数据缓存，可重建）。
其余新增规则在本机目标不存在/已由既有规则覆盖，产生 0 项（无虚假命中）。
`web_cache` 体积小幅变化（+0.36 MB）为两次扫描间浏览器缓存自然变化，项数不变；非新增规则造成。
误报检查：逐项检查受影响分类（system_admin/web_cache/system_logs/crash_telemetry/gpu_caches/comm_caches）扫描路径，全部为缓存/日志目录，无用户文档或应用运行时文件。

插件审计（`scripts/audit-plugin.ts rule-pack`）：31 任务 / 468 项 / 3564.6 MB / **扫描错误 0 / 契约违例 0**。
唯一入库管线：初始化日志 **0 条规则被安全门拒绝**。

## 5. 未采纳项与理由

| 未采纳 | 理由 |
| --- | --- |
| downloads_temp / downloads_installers / downloads_extracted（用户下载目录 15 条） | 用户 Downloads 被路径策略视为受保护用户数据；实测加入 `glob_files` 后 5 条规则被安全门拒绝（违反 0 拒绝），且清理用户下载不符合“不碰用户数据”原则 |
| `%WINDIR%`/`%PROGRAMDATA%` 下的单个日志/转储文件（KB*.log、MEMORY.DMP、Archive-*.evtx、DeliveryOptimization Logs `*.etl` 等） | `glob_files` 在受保护根上无 clear 语义，会被安全门拒绝；不放宽安全门就无法安全支持；仅采纳其中的 `clear_dir` 日志目录（DeliveryOptimization/Logs） |
| chkdsk `found.*`、驱动器根 `.pnpm-store`、`$WinREAgent` | 驱动器根/受保护根且非清空语义，既有的安全门明确拒绝 |
| Firefox `places.sqlite`/`formhistory.sqlite` compact_db | compact_db 在受保护 AppData 下且非 clear 语义，安全门拒绝；不为此放宽安全门 |
| `<CWD>` 的 `__pycache__`/构建产物 find_dirs | 支持 `<CWD>` 会引入任意当前目录递归删除风险；不采纳 |
| `require_extracted_sibling`（已解压压缩包） | 现有 RuleTarget 未实现该字段，无法安全判定“已解压”；不造伪规则 |
| broken_shortcuts 三条 | 已由独立 `shortcuts` 插件（真实 .lnk 解析 + 失效目标检测）覆盖，规则包该类型尚未实现，不重复 |
| 下载安装包（msix/appx/iso/zip/7z/rar/cab） | 与 downloads 同类，用户数据风险；仅保留在本记录，不加入规则库 |

## 6. 验证

- 新增 `tests/rule-pack-pc-v0919.test.ts`（4 条）：来源标注、数量、风险校正、安全边界、入库 306/任务 31；
- `tests/rules.test.ts`、`tests/rule-pack-evaluator.test.ts` 通过；
- 规则库插件审计：0 错误 0 契约违例；
- 真实扫描前后对比见 §4；
- 全量回归：typecheck、107 文件 / 939 用例、build、docs:check、e2e 通过（见发布前报告）。
