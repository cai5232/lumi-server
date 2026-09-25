# Lumi Server

Lumi 的后端 API，独立部署在 VPS。

## 本地运行

```bash
npm install
npm run dev
```

默认端口为 `8787`，数据保存在 `data/threads.json`。生产环境请通过 `LUMI_DATA_DIR` 指定持久化目录，并把模型服务的密钥放在 Zeabur 环境变量中，不要写入代码或 iOS 客户端。

Zeabur 环境变量：

- `LUMI_MODEL_API_URL`：OpenAI 兼容地址；可填完整的 `/chat/completions`，也可填到 `/v1`，服务会自动补齐路径
- `LUMI_MODEL_API_KEY`：模型服务 API Key
- `LUMI_MODEL_NAME`：模型名称
- `LUMI_SYSTEM_PROMPT`：可选的默认系统提示词；客户端发送的 `systemPrompt` 会优先使用
- `LUMI_DATA_DIR`：建议设为 `/data`，并在 Zeabur 挂载持久化 Volume 到 `/data`
- `LUMI_CONTEXT_LIMIT`：可选，单个聊天窗口的估算 Token 上限，默认 `200000`
- `LUMI_COMPACT_AT`：可选，达到上限的比例后触发压缩，默认 `0.85`
- `LUMI_COMPACT_TAIL_TOKENS`：可选，压缩后保留的最近对话量，默认 `20000`
- `LUMI_MEMORY_API_URL`：记忆库地址，默认 `https://memorycore.zeabur.app`
- `LUMI_MEMORY_API_KEY`：记忆库内部 Nook Token，填 memorycore 的 `OMBRE_NOOK_API_TOKEN`；用于检索/写入接口
- `LUMI_MEMORY_PASSWORD`：如果 memorycore 只提供密码登录，可填记忆库密码，后端会自动登录并复用会话
- `LUMI_MEMORY_SEARCH_PATH`：可选，检索路径，默认 `/api/search`
- `LUMI_MEMORY_WRITE_PATH`：可选，写入路径，默认 `/api/integrations/nook/memories`；该路径会写入可被 `/api/search` 检索的 buckets
- `LUMI_MEMORY_CACHE_TTL_MS`：可选，记忆检索缓存时间，默认 `300000`（5 分钟）；写入新记忆后会自动清空
- `LUMI_PROMPT_CACHE_ENABLED`：可选，Prompt Cache 开关，默认开启；设为 `false` 可关闭
- `LUMI_PROMPT_CACHE_TTL`：可选，Prompt Cache 时长，默认 `1h`，也可填 `5m`；Zeabur 中显式设置的变量优先于代码默认值
- `LUMI_COMPACT_TAIL_TOKENS`：上下文压缩后保留的完整最近对话轮 token 预算，默认 `20000`
- `LUMI_NATIVE_ANTHROPIC`：可选，默认关闭；设为 `true` 才切换 Claude 到 ZenMux Anthropic 原生接口，保持关闭可继续使用 OpenAI 兼容聊天接口
- `LUMI_APNS_KEY_ID`、`LUMI_APNS_TEAM_ID`、`LUMI_APNS_PRIVATE_KEY_BASE64`：Apple 推送凭据
- `LUMI_APNS_TOPIC`：可选，默认 `com.cai5232.LumiPush`
- `LUMI_PUSH_API_TOKEN`：必填随机长口令，保护推送登记和保活设置接口

`PORT` 由 Zeabur 自动注入，不需要手动填写。

## API

- `GET /health`
- `GET /v1/chats/:id`
- `POST /v1/chats/:id/messages`，JSON body：`{"content":"你好","systemPrompt":"可选"}`
- `POST /v1/chats/:id/messages` 也支持 `images`（base64 data URL 数组）、`emojiCatalog` 和语音授权；只有 AI 明确选择 `<speech>...</speech>` 才生成语音，TTS Key 只随本次请求传入、不落盘
- MiniMax 音色只使用 App 中手动填写的 Voice ID，不拉取音色目录；TTS Key 只随本次消息请求传入、不落盘
- `POST /v1/memories`，JSON body：`{"content":"要记住的内容","threadId":"可选"}`
- `GET /v1/settings/proactive` / `PUT /v1/settings/proactive`，需要 `Authorization: Bearer <LUMI_PUSH_API_TOKEN>`，用于读取/保存主动联系设置（默认关闭）
- `GET /v1/push/status`，查看 APNs 是否已配置及登记设备数量
- `POST /v1/push/register`，需要同一 Bearer 口令；由 App 自动登记 iOS 推送令牌

`GET /health` 会返回 Prompt Cache 的读写 token、缓存命中率和记忆检索缓存命中次数，便于确认缓存是否真正生效。缓存命中率按 `cache_read / (cache_read + cache_creation)` 计算，没有样本时返回 `null`。
Claude 缓存按稳定的系统提示词和历史消息设置断点；每次变化的时间戳、检索到的记忆和本轮输入放在断点之后，并把发送给模型的原文保存在服务端历史中，保证下一轮的缓存前缀完全一致。连续请求是否命中以模型返回的 `cache_read_input_tokens` 为准，首次写入、提示词改动或过期后的请求仍会产生缓存写入费用。
同一个健康接口也返回上下文压缩次数、当前活跃历史 token 估算及触发阈值。默认历史达到 200k 窗口的 85% 时蒸馏较早内容，保留最近约 20k token 的完整对话；摘要最多输出 25k token，并与后续新增历史继续融合。摘要生成会产生一次额外模型调用。

主动联系设置由 `/v1/settings/proactive` 保存到 `LUMI_DATA_DIR`，默认关闭。开启后，只有 APNs 已配置且至少有一台登记设备时，后端才会在静默时长届满时发起一次模型调用；该调用只带最近 8 条对话、摘要最多 4000 字符、最多生成 256 tokens，以控制冷启动账单。同一条用户消息不会重复收费，直到用户再次发消息才重新计时。它不是缓存保活请求；Anthropic 的缓存过期后，不能无成本地维持命中率。回复保存在聊天历史并经 Apple Push Notification service 发送系统通知。模型供应商需要返回 `usage.prompt_tokens_details.cached_tokens`（或 Anthropic 对应字段）才会有 Prompt Cache 命中统计。

当窗口估算 Token（包含当前输入）达到 `LUMI_CONTEXT_LIMIT × LUMI_COMPACT_AT` 时，后端会自动把较早历史蒸馏为
`<context_summary>`（用户画像、关系动态、关键事实、当前话题），保留最近对话继续发送给模型；摘要会在后续压缩时增量合并。

每条普通回复调用一次聊天模型；记忆关键词由后端本地提取，避免为检索另付一次模型调用。关键词只送给记忆库，不会塞进聊天提示词；返回的记忆原文和系统时间戳以标明 `source="system"` 的上下文放在本轮输入前，并从 `/health` 暴露搜索结果数与最近错误。模型可在回复末尾使用内部 `<memory>...</memory>` 标记选择写入长期记忆，后端会先创建潜流草稿，再调用 memorycore 的更新接口确认，最后在客户端显示“-------沈屿记下了这一刻-------”。
颜文字库第一轮只发送心情标签名；AI 自行决定是否输出 `<emoji_mood>`。只有选中标签后，后端才把这一类颜文字交给模型选一个，因此选择颜文字的回复会额外调用一次短模型请求；其他类别的颜文字不会送给模型。
