# LLM 厂商与接口核对（2026-09-16）

范围：PaperMirror 已支持的 11 个模型目录；文本翻译与解析接口。模型目录是精选列表，不是厂商完整产品目录或调用白名单。图像生成、语音、嵌入模型不属于此范围。自定义模型输入继续可用。

## 厂商核对与修改

| 厂商 | 本轮更新 | 官方依据 |
| --- | --- | --- |
| OpenAI | 增加 GPT-6 Astra；保留 Luna 默认；Astra 的 minimal/disabled 映射为支持的 low | [模型](https://developers.openai.com/api/docs/models)、[停用公告](https://developers.openai.com/api/docs/deprecations) |
| Google Gemini | 增加 3.8/3.7 Flash、3.1 Flash-Lite；维持 2.5 Flash 默认，避免无意改变现有账户选择 | [模型](https://ai.google.dev/gemini-api/docs/models)、[生命周期](https://ai.google.dev/gemini-api/docs/deprecations)、[思考参数](https://ai.google.dev/gemini-api/docs/generate-content/thinking) |
| Anthropic | 增加 Fable 5.1；Sonnet 5 等当前模型改用 adaptive thinking，拒绝不支持的自定义温度；旧 Haiku 保持预算参数 | [模型](https://platform.claude.com/docs/en/models/overview)、[迁移](https://platform.claude.com/docs/en/models/sonnet-5/migration-guide)、[停用公告](https://platform.claude.com/docs/en/about-claude/model-deprecations) |
| DeepSeek | 默认 deepseek-flash；移除旧 Flash 别名选项，已有官方配置迁移；V4 Pro 继续保留为高质量选项 | [价格及继续提供 Pro 的公告](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[请求参数](https://api-docs.deepseek.com/api/create-chat-completion/) |
| Kimi | 移除已停用 K2.5；保留 K3、K2.6；分别处理思考开关、固定温度和输出预算参数 | [模型及下线公告](https://platform.kimi.ai/docs/models)、[K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)、[K2.6](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart) |
| 阿里 Qwen | 更新为 3.8 Max、3.8 Max-0902、3.8 Flash、3.7 Plus/Flash，保留 Plus 默认 | [模型列表](https://help.aliyun.com/zh/model-studio/text-generation-model)、[OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) |
| 智谱 | 增加 GLM-5.3/5.3-Flash/5.2，默认 5.3；5.3 系列不能关闭思考，默认使用 low | [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash) |
| Groq | 默认 GPT-OSS-120B，增加 OSS-20B、Qwen3.8-27B；移除面向通用账户已不可用的旧推荐项 | [模型](https://console.groq.com/docs/models)、[停用公告及企业例外](https://console.groq.com/docs/deprecations) |
| OpenRouter | 按公开模型 API 的实际 ID 增加 Astra、Fable 5.1、Gemini 3.8、DeepSeek V4.1 Flash、Qwen3.8 | [实时目录](https://openrouter.ai/api/v1/models) |
| SiliconFlow | 增加 GLM-5.3、Qwen3.8-2.4T-A95B；保留该平台仍列出的 DeepSeek V4 Flash | [模型目录](https://www.siliconflow.com/models)、[中国区接口](https://docs.siliconflow.cn/docs/api/chat-completions-post) |
| Ollama | 增加 Qwen3.8、Qwen3.6、GPT-OSS；保留已有本地模型配置 | [模型库](https://ollama.com/library)、[OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility) |

## 接口行为

- DeepSeek 的 `reasoning_effort` 必须在请求顶层，不能嵌入 `thinking`。
- Kimi K3 使用 `max_completion_tokens`，不发送默认温度 0；K2.6 单独处理可关闭思考的模式。
- Gemini 3 使用 `thinkingLevel`，3.7/3.8 Flash 最低 low；2.5 保持 `thinkingBudget`，Pro 最低 128。响应中的 thought 内容不作为译文。
- Claude 当前系列不再发送不支持的手动思考预算；Fable 不能关闭思考。显式填写不支持的温度时给出配置错误，避免反复请求。
- Groq GPT-OSS 的思考强度使用 low/medium/high，并开放设置入口。
- 现有 Chat Completions、Claude Messages、Gemini generateContent 路由仍受官方支持，因此不为追新而切换协议。自定义地址和路径保留。

## 下线、旧版与平台差异

自动迁移只针对有明确依据的官方旧型号/别名，且仅在默认或精确匹配的官方域名生效。模型配置解析时迁移，后续保存配置时持久化；主引擎和并行引擎共用解析逻辑。自定义路径、代理、OpenRouter、SiliconFlow、Ollama 不套用原厂下线日期。

Groq 的 Llama 有企业账户例外，因此从通用推荐中移除，但不强制改写用户已保存的 Llama。Qwen/SiliconFlow 部分旧预设未在本次当前目录确认，移出精选列表不等于宣称其全部下线，亦不自动迁移。OpenAI GPT-5 Mini 等尚未到停用日的模型仍保留。

SiliconFlow 新型号有官方模型页面，但未用账户密钥核实中国区具体权限；选用前需测试连接。Ollama 模型需要用户自行拉取。各厂商地区、套餐、白名单可能影响可用性。

## 验证边界

运行源代码类型检查、测试代码类型检查、完整单元/语料测试和 XPI 打包校验。新增回归覆盖官方域名迁移隔离、迁移幂等、DeepSeek Pro 保留，以及 Kimi、Claude、Gemini、GLM、Groq 参数差异；已有 HTTP 模拟测试检查参数被拒后的重试。

未使用付费密钥调用所有厂商，也未用真实论文向这些服务发送测试请求。因此测试证明本地请求构造与回归行为，不代表所有套餐均已实测开通。价格和限流不硬编码为模型能力。
