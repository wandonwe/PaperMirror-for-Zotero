# LLM 厂商与接口核对（2026-11-19，5.0）

范围：PaperMirror 支持的 16 个翻译服务；文本翻译与解析接口。模型目录是精选列表，不是厂商完整目录，也不是调用白名单，自定义模型输入继续可用。上一轮核对见 [LLM-PROVIDERS-2026-09-16.md](LLM-PROVIDERS-2026-09-16.md)。

## 厂商核对与修改

| 厂商 | 本轮更新 | 官方依据 |
| --- | --- | --- |
| OpenAI | 默认改为 `gpt-6-luna`（面向高并发、低成本）；目录换成 GPT-6 系列（6.2 Sol、6.2 Astra、6.1 Terra），GPT-5.x 移到旧版。GPT-6 没有 `minimal` 档：Luna/Terra 映射为 `none`，Astra/Sol 映射为 `low`（OpenRouter 的 `openai/` 同款适用）。已公告停用的 gpt-5 / gpt-5-mini / gpt-5-nano（12-11）、gpt-4.1 / gpt-4.1-mini（2027-01-14）、gpt-5.4-nano / gpt-5.1（2027-04-01）到期当天才按官方替代型号迁移，已停用的 gpt-4.1-nano 立即迁移 | [模型](https://developers.openai.com/api/docs/models)、[停用公告](https://developers.openai.com/api/docs/deprecations) |
| Anthropic | 默认改为 `claude-sonnet-5-5`；目录：Opus 5.5、Fable 5.2、Haiku 5.5，旧版保留 Sonnet 5 / Opus 5 / Fable 5.1 / Opus 4.8 / Haiku 4.5。逐型号处理思考：Haiku 5.5、Opus 5 可 `disabled`；Sonnet 5.5 拒收 `disabled`，改发 `between_tools` + effort low；Opus 5.5、Fable、Mythos 关不掉，发 adaptive + effort low。修复：Haiku 5.5 此前会收到预算思考 + 温度 0（400），Sonnet 5.5 会收到 `disabled`（400）。claude-sonnet-4-5 于 11-30 到期后迁到 Sonnet 5.5；已停用的 Sonnet 4 改迁到 Sonnet 5.5 | [模型](https://platform.claude.com/docs/en/about-claude/models/overview)、[API 2026-10-21 迁移](https://platform.claude.com/docs/en/api/migration-2026-10-21)、[停用公告](https://platform.claude.com/docs/en/about-claude/model-deprecations) |
| Google Gemini | 默认改为 `gemini-3.8-flash`（官方给新项目的推荐；2.5 系列仅限已有用户）；新增 `gemini-4-argon`、3.5 Flash-Lite、3 Flash 预览，2.5 移到旧版。Gemini 4 只接受 `thinkingLevel`、最低 low（`thinkingBudget` 会 400，此前的代码会发它）。已自动路由的 3.7 Flash → 3.8 Flash、3.5 Flash → 3.6 Flash 直接迁移；3.1 Flash-Lite 于 2027-05-07 后迁到 3.5 Flash-Lite | [模型](https://ai.google.dev/gemini-api/docs/models)、[生命周期](https://ai.google.dev/gemini-api/docs/deprecations)、[思考参数](https://ai.google.dev/gemini-api/docs/generate-content/thinking) |
| DeepSeek | 不变：默认 `deepseek-flash`（V4.1 Flash），保留 V4 Pro；`thinking.type` 优先于 `reasoning_effort`，翻译默认关闭思考 | [价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[请求参数](https://api-docs.deepseek.com/api/create-chat-completion/) |
| Kimi | 新增 `kimi-k3.1-pro`、`kimi-k3.1-pro-highspeed`；默认仍为 `kimi-k3`；K2.6 不再向新注册账户开放，移到旧版。K3.1 与 K3 同一契约：总是思考、effort 只有 low/high/max（默认 max，翻译发 low），温度固定 1.0 须省略，输出上限用 `max_completion_tokens`。修复：此前型号匹配写成 `kimi-k3` 后接 `-` 或结尾，K3.1 会被当作普通模型发温度 0 和 `max_tokens`。`kimi-latest` 迁到 K3 | [K3.1 Pro 快速开始](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart)、[思考强度](https://platform.kimi.ai/docs/guide/use-reasoning-effort)、[模型](https://platform.kimi.ai/docs/models) |
| 阿里 Qwen | 默认仍为 `qwen3.7-plus`（官方的均衡推荐）；新增 `qwen4-max`（质量）、`qwen3.8-flash`（成本），3.8 Max / 3.7 Flash 移到旧版。旧地址 `dashscope.aliyuncs.com/compatible-mode/v1` 仍可用；官方现推荐按工作空间的 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，可在 Base URL 里填写 | [模型列表](https://help.aliyun.com/zh/model-studio/text-generation-model)、[OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) |
| 智谱 | 默认 `glm-5.3`（总是思考，翻译发 effort low）；新增 GLM-5.3-FlashX、免费的 GLM-4.7-Flash | [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3) |
| Groq | 默认 `openai/gpt-oss-120b`；新增预览 `minimaxai/minimax-m2.7`；Llama 3.x 已对免费/开发者层停用，不再列出 | [模型](https://console.groq.com/docs/models)、[停用公告](https://console.groq.com/docs/deprecations) |
| OpenRouter | 目录换成公开页面上能核实的 slug：`openai/gpt-6.2-sol`、`anthropic/claude-sonnet-5.5`、`anthropic/claude-opus-5.5`、`qwen/qwen4-max`、`google/gemini-3.8-flash`、`deepseek/deepseek-v4.1-flash`、`moonshotai/kimi-k3` 等 | [模型页](https://openrouter.ai/models)、[OpenAI 模型](https://openrouter.ai/~openai)、[Sonnet 5.5](https://openrouter.ai/anthropic/claude-sonnet-5.5) |
| SiliconFlow | 目录只保留官方 chat-completions 文档模型枚举里有的 ID：修正 `THUDM/GLM-4.5-Air` → `zai-org/GLM-4.5-Air`；新增 GLM-5.1、Kimi-K2.6、Qwen3.5-397B、Qwen3.6-35B-A3B；移出枚举里查不到 ID 的 GLM-5.3 / Qwen3.8 预设（可手动输入）。默认仍为 `deepseek-ai/DeepSeek-V4-Flash` | [chat-completions 参考](https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions) |
| Ollama | 新增 `gemma4`；移出模型库里查不到的 `qwen3.8`，`mistral-small3.1`、`deepseek-r1` 不再列出（后者推理开销大，仍可手动输入）；默认仍为 `qwen3.5` | [模型库](https://ollama.com/library) |
| DeepL | 无需改动：`/v2/translate`，Free 用 `api-free.deepl.com`、Pro 用 `api.deepl.com`，`Authorization: DeepL-Auth-Key`，JSON 请求体均为当前写法 | [translate 参考](https://developers.deepl.com/api-reference/translate) |
| 微软 / 谷歌免费引擎、OpenAI 兼容、自定义端点 | 无模型目录，不涉及 | — |

## 菜单栏「翻译服务」只显示已设置的引擎

- 免费引擎（微软、谷歌）始终显示；
- 需要密钥的服务商：已保存密钥才显示（系统凭据库或明文回退首选项，只判断有无，不读出密钥）；
- OpenAI 兼容 / 自定义端点：填了 Base URL 才显示；Ollama：保存过配置才显示；
- 当前正在使用的引擎始终显示；
- 每次打开菜单都会重新判断（最多等 0.8 秒，凭据库卡住时用上一次的清单），刚在设置里填的密钥不用重开阅读器就能出现。

## 不改的部分

- Claude 请求头仍为 `anthropic-version: 2023-06-01`。新版本 `2026-10-21` 对我们唯一的影响是采样参数一律 400；当前模型本来就不发温度，而 Sonnet 4.6 等旧模型在旧版本下还能用温度 0 保证译文稳定，代理/网关也仍按 `x-api-key` 鉴权。
- 已保存的型号只在官方域名、无自定义路径时迁移；代理、OpenRouter、SiliconFlow、Ollama 不套用原厂停用日期。已公告但未到期的型号不提前改。

## 验证边界

运行源代码类型检查、测试代码类型检查和全部单元/语料测试（1982 项通过）。新增回归：菜单过滤规则、凭据库超时时的回退、Claude 各型号的思考与温度、Gemini 4 的 thinkingLevel、GPT-6 的强度映射、Kimi K3.1 的参数、到期迁移的日期边界。

未用付费密钥调用任何厂商。部分官方页面（OpenRouter 实时 JSON、SiliconFlow 中文文档）本轮未能直接读取，用其公开页面和英文参考代替；SiliconFlow 新上架的部署 ID 与账户权限需在设置里「测试连接」确认。
