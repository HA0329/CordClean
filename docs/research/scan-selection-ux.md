# 主流清理工具如何帮助用户勾选扫描结果

> 调研目的：为 CordClean 扫描结果选择体验升级（详见 [`docs/scan-selection-design.md`](../scan-selection-design.md)）提供市场依据。
> 调研时间：2026-10-20。方法：优先官方文档/官方帮助，官方资料不足时用可查的第三方教程补充，并在文中标注核实程度。
> 范围：只关注"扫描结果 → 用户选择 → 确认清理"这一段交互，不评估清理能力本身。

## 0. 结论速览

1. **决策单位上移是共同规律**：没有主流产品把上千个文件平铺给用户勾选。360、火绒、腾讯管家、CCleaner、Dism++、Windows 磁盘清理、CleanMyMac 都以「类别 / 任务 / 场景」为勾选单位，文件级明细只作为下钻。
2. **默认勾选 = 厂商推荐**，不是"全选"：国内工具倾向"默认勾选全部安全类别 + 一键清理"；国外工具倾向"默认给出推荐 + Review 调整"（CleanMyMac 默认全选任务但可逐 tile 跳过；BleachBit 要求用户先读描述再勾选）。
3. **风险靠"默认策略 + 说明 + 确认门"三层处理**，而不是让用户自己判断：危险项默认不勾或需专家模式解锁（BleachBit protected options）、清理前二次确认（360/腾讯管家）、一句话说明 + 忽略列表（CCleaner/Glary/CleanMyMac）。
4. **"看不懂的项"的标准解法是：名字 + 一句说明 + 默认不选**。Dism++ 用中文说明列，BleachBit 用 cleaner 描述 + Preview，Windows 磁盘清理用类别说明，火绒/管家用"点击查看详情/需要确认才深度清理"。
5. **千条级必须做聚合与渐进披露**：先给汇总（类别/场景/tile + 大小 + 占比），再下钻明细；明细提供排序/搜索（CCleaner 的 sort/search、WizTree 的按大小 File View）。
6. **多数产品不做"按大小/风险筛选"**：按大小找大头通常交给 WizTree/TreeSize 这类空间分析器；把"按大小排序/阈值筛选"直接做进清理器是 CordClean 可以差异化的点。

## 1. 统一观察维度

| # | 维度 | 含义 |
| --- | --- | --- |
| 1 | 结果展示形式 | 平铺 / 按类别分组 / 按任务或场景分组 / tile 卡片 |
| 2 | 默认勾选策略 | 默认全选、默认推荐、默认部分勾选、默认不勾 |
| 3 | 风险与说明呈现 | 风险分级、说明文案、危险项警告、忽略列表 |
| 4 | 批量选择 | 全选/反选、按类别、按大小阈值、按筛选结果 |
| 5 | 筛选 / 排序 / 搜索 | 按大小、文件数、名称、类型过滤 |
| 6 | 详情 / 预览 | 展开类别、文件级预览、打开位置 |
| 7 | 清理确认与可恢复性 | 二次确认、备份/还原、撤销、忽略项 |
| 8 | 对"看不懂的项"的处理 | 默认不选、说明、详情入口、专家模式 |

## 2. 产品逐个分析

### 2.1 360 安全卫士（体验清理 Pro）

- **展示形式**：场景化分组。C 盘清理、隐私清理、社交软件清理等场景，扫描后展示每个场景的垃圾大小与占比；C 盘清理内部再分"常规项、大文件、重复文件、虚拟内存、休眠文件、系统备份文件"。
- **默认勾选**：一键扫描全部场景后，"智能推荐需要清理的项目"（报道级描述，未细化到每项默认状态）。
- **风险与说明**：识别重要文件/程序，用二次弹窗避免误删；社交软件中的图片视频提供二次确认；隐私清理需要用户选择后筛选。
- **批量选择**：场景级选择 + 一键扫描/清理；未提及按大小阈值或按筛选结果批量。
- **筛选排序搜索**：社交软件清理支持缩略图浏览筛选；未提及排序/搜索。
- **详情预览**：视频/图片缩略图；清理完成后显示结果与释放空间。
- **确认与恢复**：主要靠清理前二次弹窗；未见撤销/回收站机制。
- **对"看不懂"的处理**：用场景名 + 智能推荐 + 二次确认兜底。
- **→ 启示**：场景/任务就是用户的心智单位；"占比"比绝对大小更能表达轻重；重要项用二次确认做显式闸门。
- 来源：[TechWeb：360 安全卫士极速版清理 Pro 发布（2023-04-27）](https://m.techweb.com.cn/article/2023-04-27/2925575.shtml)（第三方报道，非官方文档）

### 2.2 火绒安全（垃圾清理）

- **展示形式**：先按类别（系统垃圾、注册表垃圾、常用软件垃圾、快捷方式等）勾选，扫描后在列表中展示明细。
- **默认勾选**：默认自动勾选所有类别，用户可取消不需要的类别后再"扫描垃圾"（搜索结果为默认勾选的类别）。
- **风险与说明**：扫描前提示"先退出正在运行的其他软件"；未提供显式风险分级。
- **批量选择**：类别级全选/取消是主要批量手段；扫描后可逐项取消勾选。
- **筛选排序搜索**：未见。
- **详情预览**：可点击每一个项目查看详情并确认。
- **确认与恢复**：点「一键清理」执行；未见撤销。
- **对"看不懂"的处理**：类别默认勾选 + 单项详情 + 单项取消。
- **→ 启示**：类别级开关 + 明细微调的经典两段式；"默认全选"安全的前提是规则库足够保守。
- 来源：[火绒官方：为硬盘瘦身 一键清理电脑垃圾文件](https://www.huorong.cn/document/info/productions/120.html)（官方文章，2018 年，界面可能已随版本变化）

### 2.3 腾讯电脑管家

- **展示形式**：基础清理按垃圾类型勾选后扫描；对需要确认的垃圾（在线缓存、游戏补丁、聊天图片等）进入「深度清理」二次界面；另有「清理文件」按文件特征标识帮助判断。
- **默认勾选**：基础清理默认勾选相关垃圾类型；深度清理中由用户勾选要清理的内容。
- **风险与说明**：明确告知深度清理可能删除使用痕迹、并可能关闭正在运行的程序；清理文件会按文件特征打标识。
- **批量选择**：类型级勾选；深度清理中按项勾选。
- **筛选排序搜索**：未见。
- **详情预览**：深度清理界面列出内容供确认；未见文件级预览。
- **确认与恢复**：两段式确认（基础清理 → 视情况深度清理）；未见撤销。
- **对"看不懂"的处理**：把有副作用的清理放进需要确认的"深度清理"。
- **→ 启示**：「安全默认 + 显式升级」的分级门很值得借鉴：默认动作永远安全，会关闭程序/删使用痕迹的动作必须用户确认。
- 来源：[腾讯电脑管家官方帮助：清理垃圾](https://guanjia.qq.com/help/qllj.html)（官方帮助，页面对应管家 10/11 版本）

### 2.4 CCleaner（Custom Clean vs Health Check）

- **展示形式**：两种模式。
  - **Health Check**：极简界面，扫描后给出 Privacy / Space（Pro 还有 Speed / Security）等板块，用户点一下即可清理/优化。
  - **Custom Clean**：左侧是 Windows / Applications 两个 tab 下的类别树；Analyze 后结果屏按"文件来自哪个应用、文件数、文件大小"分组显示。点击某个类别行进入 **Detailed results** 屏看具体文件。
- **默认勾选**：Custom Clean 由用户勾选类别后 Analyze（是否记忆上次勾选，官方文章未说明）；Health Check 是"推荐即执行"。
- **风险与说明**：提供 Exclude List，可在 Detailed results 中右键「Add to Exclude List」排除单个项目，事前一劳永逸；未见显式风险分级。
- **批量选择**：类别级勾选是主要方式（左右面板勾选类别），未见"按大小/按筛选结果"批量。
- **筛选排序搜索**：结果屏右键可排序（Tree order / File size / File count / Time taken）、搜索特定文件、保存为文本；Detailed results 可按 Description / Size 排序、搜索/下拉切换类别。
- **详情预览**：Detailed results 文件级列表，可右键「Open containing folder」；Analyze 屏本身不展示文件级内容。
- **确认与恢复**：Analyze（预演）→ Run Cleaner（执行）两段式；未见撤销，靠 Exclude List 事前防护。
- **对"看不懂"的处理**：类别名 + 应用名 + 可下钻看单文件；官方明确"需要更多自定义请用 Custom Clean，Health Check 给普通用户"。
- **→ 启示**：Analyze → 分组结果 → Detailed results 是标准的"总览→明细"三层信息架构；"按大小/文件数排序"在结果屏就有；Exclude List 是零成本的"别碰这些"。
- 来源：[CCleaner 官方：Custom Clean's analysis and results function](https://support.ccleaner.com/articles/en_US/Master_Article/custom-clean-s-analysis-and-results-function)、[Custom Clean's detailed results function](https://support.ccleaner.com/articles/en_US/Master_Article/custom-clean-s-detailed-results-function)、[What is Health Check?](https://support.ccleaner.com/articles/en_US/Master_Article/what-is-health-check)

### 2.5 BleachBit

- **展示形式**：左侧是 cleaner 列表，每个 cleaner 下有一个或多个选项复选框；点 cleaner 名称，右侧显示该 cleaner 的描述。
- **默认勾选**：官方流程是"读描述 → 勾选想清理的选项 → Preview → Delete"，默认不替用户做推荐；高危选项即使勾选也会在清理阶段被过滤。
- **风险与说明**：**保护机制做得最细**。默认（未开专家模式）时，高风险选项（保存的密码、系统空闲空间擦除、Shellbags、最近文档、缩略图、深度扫描等）会在预览阶段被过滤/跳过，并显示信息条「This option is protected. To bypass protection, enable expert mode.」；专家模式需用户确认警告，且每个保护选项有具体警告文案。文档直接建议"不懂或让你不安的选项就禁用"。
- **批量选择**：以选项级勾选为主；官方文档未描述"全选/反选"按钮。
- **筛选排序搜索**：无（cleaner 树结构固定）。
- **详情预览**：**Preview 是核心**——点击 Preview 列出将被删除的文件，安全且不改系统；可反复调整选择再预览，直到满意才 Delete。
- **确认与恢复**：Preview + 删除确认；未开专家模式时 "Confirm before delete" 锁定为常开；未见撤销/备份。
- **对"看不懂"的处理**：默认护栏（危险项默认拦截）+ 描述 + Preview + "不懂就别选"的官方建议。
- **→ 启示**：这与 CordClean v2 的"risky 永不批量推荐、必须逐项勾选、清理时强制隔离"是同一思路；"预览清单 + 可反复调整"值得直接移植到清理前确认摘要。
- 来源：[BleachBit 官方文档：General usage](https://docs.bleachbit.org/doc/general-usage/)、[Expert mode / Protected options](https://docs.bleachbit.org/doc/expert-mode/)、[BleachBit Features](https://www.bleachbit.org/features)

### 2.6 Dism++（空间回收）

- **展示形式**：左侧功能模块 → 「空间回收」列出清理项（系统更新缓存、临时文件、过期补丁、Windows.old 备份等），每项前有复选框并配中文说明；勾选后点确定，扫描并清理。
- **默认勾选**：第三方教程称"勾选你要清理的项目（建议全选）"；默认状态未见官方说明（待核实）。
- **风险与说明**：每项有中文说明；规则整体偏保守；教程特别提示"被系统保护的更新缓存"不确定就先不勾、"AppX 部署缓存"可能导致 UWP 应用出问题，不确定别勾。
- **批量选择**：项目级勾选；未见按大小批量。
- **筛选排序搜索**：未见。
- **详情预览**：说明列（无文件级预览）；清理项即最小决策单位。
- **确认与恢复**：确定后执行；系统级清理，未见撤销。
- **对"看不懂"的处理**：靠中文说明 + "不确定就不勾"的保守建议。
- **→ 启示**：说明列是成本最低的可解释性方案；"默认保守"让"全选"这个心智可以被接受。CordClean 的 38 个任务同样适合在组行直接放一句说明。
- 来源：[SegmentFault：Dism++ 使用图文（2026）](https://segmentfault.com/a/1190000047835759)（第三方教程）；官方仓库：[Chuyu-Team/Dism-Multi-language](https://github.com/Chuyu-Team/Dism-Multi-language)

### 2.7 Windows 磁盘清理 / 存储感知

- **展示形式**：
  - **磁盘清理**：按「要删除的文件」列出类别（临时安装文件、下载的程序文件、临时 Internet 文件、回收站、临时文件、脱机文件、旧 Chkdsk 文件、内容索引目录文件等），每类带说明；部分类别带「查看文件」按钮；选"清理系统文件"可提权重扫系统项。
  - **存储感知**：不是逐项勾选，而是配置策略（临时文件清理、回收站保留天数、下载文件夹保留天数、OneDrive 云内容脱水阈值、运行频率），到条件自动清理。
- **默认勾选**：磁盘清理按类别勾选并记住设置（`cleanmgr /sageset` 会把选择存进注册表配置）；存储感知默认开启、低磁盘空间时自动运行。
- **风险与说明**：官方文档逐条解释每个选项是什么、删除会怎样（如回收站项说明"文件在清空回收站前并未永久删除"）；"查看文件"按钮提供轻量预览。
- **批量选择**：类别级全选；存储感知是"设一次策略，自动执行"。
- **筛选排序搜索**：未见。
- **详情预览**：部分类别可"查看文件"（打开对应文件夹）。
- **确认与恢复**：磁盘清理点「确定」后二次确认；回收站项本身可恢复；未见其他撤销。
- **对"看不懂"的处理**：类别描述 + 查看文件；系统文件需要提权，天然提高门槛。
- **→ 启示**：① 每个可勾选类别都配"这是什么/删了会怎样"一句话；② "查看文件"是可选的轻量预览入口；③ 存储感知代表另一条路线——把推荐策略变成可配置的自动化，适合 CordClean 未来的「定时推荐/自动清理」。
- 来源：[Microsoft Learn：cleanmgr（含各清理项说明与 View Files 按钮）](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cleanmgr)、[Microsoft Learn：Configure Storage Sense](https://learn.microsoft.com/en-us/windows/configuration/storage/storage-sense)

### 2.8 CleanMyMac（Smart Care → Review）

- **展示形式**：扫描结果以 tile 卡片展示各模块（Cleanup、Protection、Performance、Applications、My Clutter），每个 tile 显示可安全释放的总量、威胁数、维护任务数、更新数、重复文件数。
- **默认勾选**：**默认勾选全部 Smart Care 任务**；用户可在 tile 左上角取消勾选跳过某个任务。点 tile 里的「Review」进入细节调整具体选择。
- **风险与说明**：官方称 Safety Database（多年积累的安全数据库）用于防止误删、保护用户数据；"除非你选择，否则不会删除用户文件或应用数据"；可在设置里把模块/类别/组从扫描中排除，也可用忽略列表排除文件/文件夹/应用；被取消勾选的模块在结果页仍显示但置灰，可重新 Enable。
- **批量选择**：模块/类别/组级勾选，且级联（取消模块会取消其下类别与组）。
- **筛选排序搜索**：未见（Review 内按模块组织）。
- **详情预览**：tile → Review 两级；对应 CleanMyMac 的 Large & Old Files 等模块还有专门的文件审视流程。
- **确认与恢复**：Review 后 Run；未见撤销，靠 Safety Database + 忽略列表事前防护。
- **对"看不懂"的处理**：先给 tile 级汇总与推荐，细节藏在 Review 里；不确定的整个模块可以跳过并在结果里置灰显示。
- **→ 启示**：① "默认全选推荐 + 逐 tile 跳过"比"默认全不选"更高效；② 置灰显示被跳过的模块，正好对应 CordClean 要解决的"受保护项看不到，用户以为漏扫"；③ 级联勾选（模块→类别→组）与我们的 CategoryGroup → TaskGroup 结构一致。
- 来源：[MacPaw 官方支持：Run Smart Care to clean, protect and optimize your Mac](https://macpaw.com/support/cleanmymac/knowledgebase/smart-care)

### 2.9 Wise Disk Cleaner（可选）

- **展示形式**：提供 7 类清理项；扫描后以列表展示无用文件。
- **默认勾选**：**不是全部选中**；官方建议不知道就保持默认设置。官方明确警告不要清理：保存的密码、表单历史、Cookies，除非确有需要。
- **风险与说明**：官方给出"不要清理"的危险清单；可对单项右键「ignore this item」。
- **批量选择**：类别/单项勾选。
- **筛选排序搜索**：未见。
- **详情预览**：扫描结果列表，逐项可取消勾选。
- **确认与恢复**：点「Clean」执行；未见撤销。
- **对"看不懂"的处理**：默认少选 + 危险清单 + 忽略项。
- **→ 启示**："默认不勾危险项"与"给出明确危险清单"是低成本、高可信的做法，可直接用于 CordClean 的风险说明文案。
- 来源：[WiseCleaner 官方教程（德文）：Wise Disk Cleaner User Guide](http://www.wisecleaner.eu/wise-disk-cleaner-user-guide.html)

### 2.10 Glary Disk Cleaner（可选）

- **展示形式**：比 Windows 自带磁盘清理更细的类别列表（系统/用户临时文件、缩略图缓存、错误报告、日志文件、内存转储、回收站、无效快捷方式、过时 Windows 更新等），并**显示详细扫描结果，可选择单个文件删除**。
- **默认勾选**：未见明确说明；类别级勾选。
- **风险与说明**：忽略列表（exclude files/locations）；删除前可创建备份，出问题可一键恢复；有清理历史。
- **批量选择**：类别级 + 单文件选择。
- **筛选/排序/搜索**：未见。
- **详情预览**：详细扫描结果列表即明细。
- **确认与恢复**：**备份 + 一键恢复**是同类中较少见的可恢复性设计。
- **对"看不懂"的处理**：类别细化 + 忽略列表 + 备份兜底。
- **→ 启示**：对高风险项"先备份再删"比"事后道歉"更可靠；CordClean 已有隔离/预演机制，可把"可恢复"作为清理确认页的卖点。
- 来源：[ZOL 软件百科：Glary Disk Cleaner 功能介绍](https://xiazai.zol.com.cn/baike/440114.shtml)（第三方软件介绍，未与官方文档交叉核实）

### 2.11 WizTree / TreeSize 类空间分析器（大文件视角，可选）

- **展示形式**：TreeMap 按大小可视化整个磁盘；File View 按大小排序列出所有文件/文件夹；自动标记重复文件；可按文件名/类型搜索（支持通配符）；可导出 CSV 或复制到剪贴板。
- **默认勾选**：不涉及勾选清理，只做"发现"；删除是辅助动作。
- **风险与说明**：官方明确警告"不要删除系统运行必需的文件"。
- **批量选择**：不适用。
- **筛选排序搜索**：**按大小排序是核心**，配合名称/类型过滤。
- **详情预览**：点击文件定位、查看重复项。
- **确认与恢复**：不负责。
- **对"看不懂"的处理**：不处理，假定用户能识别文件。
- **→ 启示**：大文件场景下"按大小排序 + 搜索"就是最高效的选择方式；CordClean 明细视图的 size-desc/mtime 排序、搜索、阈值筛选正是把这类体验内建进清理器。
- 来源：[WizTree 官方：About / Features](https://www.diskanalyzer.com/about)

## 3. 横向对比

| 产品 | 展示形式 | 默认勾选 | 风险/说明 | 批量选择 | 筛选/排序/搜索 | 详情/预览 | 确认/恢复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 360 安全卫士 | 场景分组 + 占比 | 智能推荐 | 重要项二次弹窗 | 场景级、一键 | 缩略图筛选 | 缩略图 | 二次确认，无撤销 |
| 火绒安全 | 类别 → 明细 | 全类别默认勾选 | 提示退出运行软件 | 类别级、单项 | — | 单项详情 | 一键清理，无撤销 |
| 腾讯电脑管家 | 类型勾选 → 扫描 → 深度清理 | 类型默认勾选 | 说明副作用（关程序/删痕迹） | 类型级、深度清理内逐项 | — | 深度清理确认界面 | 两段式确认，无撤销 |
| CCleaner | 类别树 → 分组结果 → 明细 | 用户勾选类别 | Exclude List | 类别级 | **排序/搜索/导出** | 文件级明细 + 打开位置 | Analyze → Run，无撤销 |
| BleachBit | cleaner 列表 + 描述 | 用户显式勾选 | **protected 选项 + 专家模式警告** | 选项级 | — | **Preview 文件清单** | 删除确认常开，无撤销 |
| Dism++ | 清理项列表 + 说明 | 建议全选（未核实） | 中文说明 + 保守建议 | 项级 | — | 说明列 | 确定后执行，无撤销 |
| Windows 磁盘清理/存储感知 | 类别列表 / 自动策略 | 勾选并记忆 / 默认开启 | 逐项说明 + 查看文件 | 类别级 / 策略 | — | 查看文件 | 二次确认；回收站可恢复 |
| CleanMyMac | tile 卡片 → Review | **全任务默认勾选、可跳过** | Safety DB + 忽略列表 | 模块/类别/组级联 | — | tile → Review 两级 | Run，无撤销 |
| Wise Disk Cleaner | 类别列表 → 结果列表 | 非全选 + 危险清单 | 忽略项 + 危险清单 | 类别/单项 | — | 结果列表 | Clean，无撤销 |
| Glary Disk Cleaner | 细分类别 + 明细 | 类别级（未核实） | 忽略列表 + 备份 | 类别 + 单文件 | — | 明细列表 | **备份/一键恢复** + 历史 |
| WizTree | TreeMap + 按大小列表 | 不适用 | 删除警告 | 不适用 | **按大小排序 + 搜索** | 定位/重复项 | 不负责 |

## 4. 可借鉴的模式（12 条）

| # | 模式 | 代表产品 | 说明 |
| --- | --- | --- | --- |
| P1 | **决策单位上移到类别/任务** | 360、火绒、CCleaner、Dism++、Windows、CleanMyMac | 每个组给大小、项数、勾选框；文件级只下钻 |
| P2 | **推荐选择而非全选** | 360（智能推荐）、CleanMyMac（默认全选推荐 tile） | 默认勾选要能解释"为什么推荐"，且可一键恢复推荐 |
| P3 | **风险分层 + 默认不勾** | BleachBit、Wise、Dism++ | 危险项默认不勾；必须用户显式操作才纳入 |
| P4 | **一句话说明/描述列** | Dism++、BleachBit、Windows 磁盘清理 | "这是什么、删了会怎样"，是"看不懂"的最低成本解法 |
| P5 | **清理前预览/确认摘要** | BleachBit Preview、CCleaner Analyze、360 二次弹窗 | 列出将删除内容与总量，让用户确认后再动手 |
| P6 | **渐进披露（总览 → 明细 → 文件）** | CleanMyMac tile→Review、CCleaner 结果→Detailed results | 首屏不被上千行淹没 |
| P7 | **按大小/数量排序 + 搜索** | CCleaner、WizTree | 找大头、定位具体文件的标准手段 |
| P8 | **按类/按筛选结果批量勾选** | 火绒、CleanMyMac 级联勾选 | 三态组勾选（全选/部分/未选）是主流 |
| P9 | **忽略列表（事前排除）** | CCleaner Exclude List、Glary、CleanMyMac、Wise | 比事后恢复更可靠；一次设置长期生效 |
| P10 | **高风险操作的显式门** | 腾讯管家"深度清理"、BleachBit 专家模式、360 二次弹窗 | 有副作用（关程序/删痕迹/危险选项）必须确认 |
| P11 | **可恢复性 / 备份** | Glary（备份+恢复）、Windows 回收站 | 不可逆清理里少见的兜底；可作为差异化卖点 |
| P12 | **被排除项的可见性** | CleanMyMac（置灰 tile） | 让用户知道"不是漏扫，是被策略排除"，减少不信任 |

## 5. CordClean 适配建议

> 对应 v2 设计：三视图（分组总览 / 逐项明细 / 受保护项）、`recommendIds`、`groupByCategory` / `groupByTask`、`filterItems` / `sortItems`、`summarizeSelection`。

| 模式 | CordClean 做法 | 优先级 | 千条级适用性 |
| --- | --- | --- | --- |
| P1 决策单位上移 | 分组总览按 CategoryGroup → TaskGroup 聚合（count/bytes/recommendCount/占比），组行三态勾选 | **P0** | ✅ 千条级一屏决策 |
| P2 推荐选择 | `recommendIds`：safe 且未被保护 → 推荐；顶部横幅说明"已按安全策略推荐 N 项（M）"，提供「应用推荐/恢复推荐」 | **P0** | ✅ 只算一次、按组聚合展示 |
| P3 风险分层 | safe 推荐、caution 默认不勾、risky 永不批量推荐必须逐项勾、protected 不可勾；risky 清理时强制隔离 | **P0** | ✅ 策略是常量级，不随条数增长 |
| P4 说明呈现 | 组行 tooltip + 明细行 name 下方显示 `note` + 风险文案固定短语；受保护项显示保护原因 | **P0** | ✅ 文本按行渲染，分页可控 |
| P5 预览/确认摘要 | 清理前确认页展示项数/总大小/风险分布/受保护数，高风险项单独列出（预演能力已有，补摘要） | **P0** | ✅ 汇总由 `summarizeSelection` 计算 |
| P6 渐进披露 | 分组总览（默认）→ 展开前 3 大项样例 → 明细视图分页（100/200/500） | **P0** | ✅ 首屏只渲染 ≤ 任务数行 |
| P7 排序/搜索 | 明细视图：size-desc / size-asc / mtime-desc / name / risk-desc + 搜索路径/名称 | **P0** | ✅ 纯函数排序 + 分页 |
| P8 批量助手 | 应用推荐、全选/反选**当前筛选结果**、按组勾选、本页全选、清空 | **P0** | ✅ 基于 Set<id>，跨页保留 |
| P9 忽略/排除列表 | 对"永远别清"的路径做排除（规则层或用户层），排除项在受保护视图中可见 | P1 | ✅ 建议作用于规则筛选阶段 |
| P10 高风险显式门 | risky 项逐项勾选 + 确认页单独区块 + 清理隔离 | **P0** | ✅ 与 P3 同源 |
| P11 可恢复性 | 已有预演/隔离；在确认页标注"高风险项清理后可从隔离区恢复"（若实现支持） | P1 | ✅ 与条数无关 |
| P12 排除项可见性 | 「受保护项」只读视图 + 原因列，横幅提示"已跳过受保护 X 项"，避免误以为漏扫 | **P0** | ✅ 只多一个列表 |
| P13 场景化入口 | 按"释放空间/隐私清理/大文件"等场景组织入口（可选，放在分类之上） | P2 | ⚠️ 需要额外信息架构，非首期 |
| P14 清理结果/历史 | 清理完成页展示释放空间、失败项与原因；可选历史记录 | P1 | ✅ 与条数无关 |

## 6. 千条级结果的适用性判断

### 适合千条级（建议直接采用）

- **聚合分组 + 三态组勾选**：千条结果压缩成 38 个任务行 / 若干类别行，决策单位从"条"变"组"。
- **推荐策略 + 顶部汇总横幅**：默认勾选由纯函数计算，不依赖用户逐条阅读；横幅交代"推荐多少、高风险多少、受保护多少"。
- **明细筛选/排序/搜索/分页**：只在用户想微调时使用；分页 + 只渲染当前页，避免千行 DOM。
- **按大小阈值批量**（选大于 100 MB）：把千条砍成几十条"大头"，是最符合清理动机的批量方式。
- **纯函数计算（group/filter/sort/summarize）**：一次遍历聚合，千条级性能可控。
- **受保护项只读视图**：解释"为什么没出现在可清理列表里"。

### 不适合 / 需要改造

- **逐条人工勾选的平铺表格**：千条级不可行（没有任何调研产品这么做），必须聚合。
- **首屏展开全部文件明细**：CCleaner 的 Detailed results 之所以可用，是因为先有类别结果屏；直接给千行会淹没用户。
- **无限层级树**（cleaner 树再嵌套文件树）：对 CordClean 的"任务 + 文件"两层够用，再深会增加认知负担。
- **TreeMap 空间占比可视化**：对"按类别找大头"收益有限，交互与性能成本高；用分组行占比条即可替代。
- **每行都展开说明/预览文件清单**：会拖慢渲染；说明放 tooltip/详情抽屉，预览只在确认页汇总。
- **默认全选**：国内工具敢默认全选是因为规则库保守；CordClean 任务含 caution/risky，默认应为"应用推荐"而非"全选"。

### 折中做法

- 明细默认只显示"推荐 + 已选"或按大小降序的 Top N；其余用筛选/搜索触达。
- 分组总览默认折叠，只展开用户点开的组；展开时只给前 3 大项样例。
- 搜索只作用于明细视图，不对分组视图做全文高亮，避免性能与视觉噪音。

## 7. 与 v2 设计的对照检查

v2 设计已覆盖：分组总览/明细/受保护三视图、推荐选择策略、风险分层、说明（note + 风险文案 + tooltip）、批量助手、详情抽屉、排序、纯函数性能约束——与调研结论方向一致。

可补强的点：

1. **确认页摘要**：BleachBit/CCleaner 都强调"清理前看清要删什么"；建议在确认对话框中固定展示项数、总大小、风险分布、受保护/跳过数，risky 项单独列出，而不是只问"确定清理吗"。
2. **分组行占比**：360 用"场景占比"表达轻重，比绝对大小更直观；可在分组行加占比条。
3. **排除列表**：CCleaner/Glary/CleanMyMac 都有忽略/排除机制；CordClean 若已有路径保护规则，可考虑让用户在详情抽屉里"加入忽略"，并在受保护视图看到它。
4. **清理结果页**：多家有清理完成反馈（360、Glary 历史）；建议清理后展示释放空间、失败原因，作为"可解释"的闭环。
5. **"包含谨慎项"默认值**：建议默认关闭（与 BleachBit/Wise 的保守默认一致），并在横幅里说明其对推荐量的影响。

## 8. 未核实与风险提示

- **360**：默认勾选粒度、"智能推荐"的具体规则来自 2023 年第三方报道，未见官方交互文档；当前版本可能变化。
- **火绒 / 腾讯管家**：引用的官方帮助页分别对应 2018 年文章与管家 10/11 版本，当前 6.0/V16 界面可能不同。
- **CCleaner**：Custom Clean 是否记忆上次类别勾选、Detailed results 是否支持逐文件勾选（而非仅排除）未逐条确认；"Health Check 默认执行推荐"基于官方文章描述。
- **BleachBit**：官方文档未描述全选/反选按钮；默认勾选状态以"用户显式勾选"为准。
- **Dism++**：默认勾选状态、说明列的具体呈现来自第三方教程；官方文档（chuyu.me）未取到可用页面。
- **Glary**：备份/恢复、忽略列表等来自 ZOL 软件介绍页，未与官方文档交叉核实。
- **可恢复性**：除 Windows 回收站、Glary 备份外，多数产品未见撤销/回收站机制，文中按"未见"记录而非"没有"。
- 本文引用页面均于 2026-10-20 抓取；产品界面迭代快，具体控件以实际版本为准。

## 9. 参考来源

**官方文档 / 官方帮助**

- 火绒安全：[为硬盘瘦身 一键清理电脑垃圾文件](https://www.huorong.cn/document/info/productions/120.html)
- 腾讯电脑管家：[清理垃圾（帮助）](https://guanjia.qq.com/help/qllj.html)
- CCleaner：[Custom Clean's analysis and results function](https://support.ccleaner.com/articles/en_US/Master_Article/custom-clean-s-analysis-and-results-function)
- CCleaner：[Custom Clean's detailed results function](https://support.ccleaner.com/articles/en_US/Master_Article/custom-clean-s-detailed-results-function)
- CCleaner：[What is Health Check?](https://support.ccleaner.com/articles/en_US/Master_Article/what-is-health-check)
- BleachBit：[General usage](https://docs.bleachbit.org/doc/general-usage/)
- BleachBit：[Expert mode / Protected options](https://docs.bleachbit.org/doc/expert-mode/)
- BleachBit：[Features](https://www.bleachbit.org/features)
- Microsoft Learn：[cleanmgr（Disk Cleanup 各清理项说明）](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cleanmgr)
- Microsoft Learn：[Configure Storage Sense](https://learn.microsoft.com/en-us/windows/configuration/storage/storage-sense)
- MacPaw（CleanMyMac）：[Run Smart Care to clean, protect and optimize your Mac](https://macpaw.com/support/cleanmymac/knowledgebase/smart-care)
- WiseCleaner：[Wise Disk Cleaner User Guide（德文）](http://www.wisecleaner.eu/wise-disk-cleaner-user-guide.html)
- WizTree：[About / Features](https://www.diskanalyzer.com/about)
- Dism++ 官方仓库：[Chuyu-Team/Dism-Multi-language](https://github.com/Chuyu-Team/Dism-Multi-language)（仅用于产品身份，未从 README 提取结论）

**第三方报道 / 教程（已在正文标注）**

- TechWeb：[360 安全卫士极速版清理 Pro 发布](https://m.techweb.com.cn/article/2023-04-27/2925575.shtml)
- SegmentFault：[Dism++ 下载与图文使用教程](https://segmentfault.com/a/1190000047835759)
- ZOL 软件百科：[Glary Disk Cleaner 功能介绍](https://xiazai.zol.com.cn/baike/440114.shtml)
