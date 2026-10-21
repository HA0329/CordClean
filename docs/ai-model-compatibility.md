# AI 模型与接口兼容策略（应对未来变化）

> 本文记录我们对 DeepSeek 官方接口的核对结果，以及「模型名/接口字段以后又变了怎么办」的约定。
> 目标：**模型名是数据，不是代码**；接口变化只改适配层，不改内核与界面业务逻辑。

## 1. 官方接口核对（2026-10-20 查阅）

来源（官方文档）：

- [Your First API Call](https://api-docs.deepseek.com/)
- [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Lists Models（GET /models）](https://api-docs.deepseek.com/api/list-models/)
- [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)

### 1.1 当前模型 ID 与底层版本

| API 模型 ID（请求用） | 实际提供服务的版本 | 备注 |
| --- | --- | --- |
| `deepseek-flash` | **DeepSeek-V4.1-Flash-1017** | 官方推荐、本项目默认；支持文本 + 图片 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 复杂推理，不支持图片 |

重要区别：

- **`DeepSeek-V4.1-Flash` 是「底层模型版本/显示名」，不是请求里的模型 ID**；请求里应写 `deepseek-flash`。
- 官方明确指出旧 ID `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍被接受，但对应模型已退役，请求会被路由到 DeepSeek-V4.1-Flash-1017 并按 Flash 计费。
- 更早的 `deepseek-chat` / `deepseek-reasoner` / `deepseek-coder` 已不是当前文档主推 ID。

### 1.2 接口形态与元数据

- OpenAI 兼容 base：`https://api.deepseek.com`；Anthropic 兼容 base：`https://api.deepseek.com/anthropic`。
- 官方同时提供 **Chat Completions、Responses API、Anthropic Messages API** 三种形态；本项目 `apiShape` 的 `chat` / `responses` / `messages` 与之一一对应。
- `GET /models` 返回的不只是 ID，还包括：`name`（显示名）、`context_window`、`max_output_tokens`、`input_modalities`、`output_modalities`、`effort.supported_levels` / `default_level`、`api_capabilities`（如 Anthropic system prompt 行为）。**这是运行时能力的首选来源。**
- 聊天参数：`thinking: {type: enabled|disabled}`、`reasoning_effort: none|low|high|max`（`minimal`→`low`，`medium`/`xhigh`→`high`）、`max_tokens` 上限 384K、`stream`、`response_format` 等。
- 思考模式下 `temperature` / `presence_penalty` / `frequency_penalty` 无效；思维链在 `reasoning_content`。

## 2. 本项目的应对方式

### 2.1 稳定 ID + 别名表

- 请求始终发送**稳定 ID**（默认 `deepseek-flash`）。
- `packages/plugins/ai/src/config.ts` 维护 `LEGACY_MODEL_ALIASES`：官方明确说明的旧 ID → 稳定 ID（含 `deepseek-chat`、`deepseek-reasoner`、`deepseek-coder`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`）。
- **未知模型名原样保留**：用户手填的新模型、代理模型、私有网关模型不会被改名。
- 迁移只发生一次，日志记录「旧名 → 新名」，配置保存后固化为稳定 ID。

### 2.2 `/models` 是显示名与能力的事实来源

- 界面候选列表优先来自 `/models`：ID 用于请求，`name` 用于「模型版本」展示，`context_window` / `max_output_tokens` / `input_modalities` 用于能力判断。
- 内置 `FALLBACK_MODELS` 只在离线/拉取失败时兜底，**不作为硬编码真相**；在线时以接口返回为准。
- 模型的上下文/输出上限会参与请求收敛：`max_tokens = min(用户配置, /models.max_output_tokens)`，不会静默抬高用户设置。
- 支持「手动输入模型名」：官方列表没有的 ID 也能用，界面明确提示「会原样发送」。

### 2.3 适配层隔离接口差异

- `adapters.ts` 负责三种形态的请求组装与响应解析；`http.ts` 负责超时/重试/SSE。
- 新参数优先通过 `extraBody` / `extraHeaders` 逃生舱验证；验证稳定后再进适配层。
- 流式失败自动回退非流式；两种路径共用同一套解析与 UI。
- 推理等级做了抽象映射（auto/off/low/medium/high/max），由适配层映射成官方的 `thinking` + `reasoning_effort`（OpenAI 形态）/ `reasoning` + `output_config`（Anthropic 形态）。

### 2.4 失败时的行为

| 变化 | 行为 |
| --- | --- |
| 模型改名 | 别名表迁移；未知名保留；界面可手动刷新 `/models` |
| 模型下线/返回 404 或 400 | 原始 HTTP 错误与厂商 message 透传到界面；不猜测、不自动重试无意义请求 |
| 新增参数 | `extraBody` / `extraHeaders` 直接加，不必重新发布 |
| 新增接口形态 | 新增一个 `ApiShape` 适配器；UI 配置项与探测/测试随之可用 |
| 流式接口异常 | 自动回退非流式；仍失败则给出明确错误 |
| `/models` 不可用 | 回退内置目录，并标记「模型来源：内置目录」 |

## 3. 以后模型名/接口又变了，按这个清单改

1. **先核对官方文档**：确认「请求 ID」「底层版本名」「旧 ID 是否仍被接受」「参数/路径是否变化」。
2. **只改别名表/适配层**：
   - ID 改名 → 更新 `LEGACY_MODEL_ALIASES` 与 `FALLBACK_MODELS` 兜底；
   - 字段改名 → 在 `adapters.ts` 增加映射，旧字段保留兼容；
   - 新形态 → 新增适配器与 `DEFAULT_PATHS`；
   - 新能力 → 优先从 `/models` 元数据读取，不写死版本号。
3. **更新测试**：
   - 别名迁移：`tests/ai-config-defaults.test.ts`；
   - `/models` 能力收敛：`tests/ai-model-metadata.test.ts`；
   - 流式/非流式：`tests/ai-stream-analyze.test.ts`、`tests/ai-sse.test.ts`。
4. **跑契约验证**：`pnpm typecheck && pnpm typecheck:ui && pnpm test`；有条件再用真实 Key 跑一次「测试连接 + 小分析」。
5. **更新本文档与 README/缺陷台账**，记录日期、旧 ID、新 ID、官方链接。

## 4. 相关文件

- `packages/plugins/ai/src/config.ts`：默认值、别名、配置规范化
- `packages/plugins/ai/src/models.ts`：`/models` 拉取与内置兜底
- `packages/plugins/ai/src/adapters.ts`：三种形态的请求/响应适配
- `packages/plugins/ai/src/http.ts`：超时、重试、SSE
- `packages/plugins/ai/src/service.ts`：分析编排、能力收敛、探测
- `packages/ui/src/views/AiView.vue`：模型选择/手动输入/版本展示/状态栏
- `tests/ai-config-defaults.test.ts`、`tests/ai-model-metadata.test.ts`、`tests/ai-stream-analyze.test.ts`
