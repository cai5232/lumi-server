# Lumi Server

Lumi 的后端 API，独立部署在 VPS。

## 本地运行

```bash
npm install
npm run dev
```

默认端口为 `8787`，数据保存在 `data/threads.json`。生产环境请通过 `LUMI_DATA_DIR` 指定持久化目录，并把模型服务的密钥放在 Zeabur 环境变量中，不要写入代码或 iOS 客户端。

Zeabur 环境变量：

- `LUMI_MODEL_API_URL`：OpenAI 兼容的 Chat Completions 完整地址
- `LUMI_MODEL_API_KEY`：模型服务 API Key
- `LUMI_MODEL_NAME`：模型名称
- `LUMI_SYSTEM_PROMPT`：可选的默认系统提示词；客户端发送的 `systemPrompt` 会优先使用
- `LUMI_DATA_DIR`：建议设为 `/data`，并在 Zeabur 挂载持久化 Volume 到 `/data`
- `LUMI_CONTEXT_LIMIT`：可选，单个聊天窗口的估算 Token 上限，默认 `200000`
- `LUMI_COMPACT_AT`：可选，达到上限的比例后触发压缩，默认 `0.86`
- `LUMI_COMPACT_TAIL_TOKENS`：可选，压缩后保留的最近对话量，默认 `20000`
- `LUMI_MEMORY_API_URL`：记忆库地址，默认 `https://memorycore.zeabur.app`
- `LUMI_MEMORY_API_KEY`：可选，记忆库 API Key
- `LUMI_MEMORY_SEARCH_PATH`：可选，检索路径，默认 `/search`
- `LUMI_MEMORY_WRITE_PATH`：可选，写入路径，默认 `/memories`

`PORT` 由 Zeabur 自动注入，不需要手动填写。

## 自主唤醒时看屏幕

在 Lumi 设置中开启“保活”和“查看屏幕”并完成下面的邮件自动化后，AI 可在自主唤醒时选择看屏幕。每次选择查看时，后端会给 iPhone 发一封带有随机主题暗号的邮件，手机收到后自动运行快捷指令、截取当前屏幕并上传；AI 再用新截图生成回复。没有配置或没有及时收到截图时，后端会沿用现有的看屏请求通知。

自动截图需要在 Zeabur 配置以下环境变量；所有口令只放在服务端变量和本人手机快捷指令中：

- `LUMI_SCREEN_PEEK_TOKEN`：专用于截图上传的随机长口令，不要与 `LUMI_PUSH_API_TOKEN` 共用。
- `LUMI_SCREEN_PEEK_SMTP_HOST`、`LUMI_SCREEN_PEEK_SMTP_PORT`（默认 `465`）、`LUMI_SCREEN_PEEK_SMTP_USER`、`LUMI_SCREEN_PEEK_SMTP_PASSWORD`：发信邮箱的 SMTP 信息和应用专用密码。
- `LUMI_SCREEN_PEEK_EMAIL_FROM`：可选；默认用 SMTP 用户名作为发件人。
- `LUMI_SCREEN_PEEK_EMAIL_TO`：iPhone 邮件自动化接收触发邮件的邮箱。
- `LUMI_SCREEN_PEEK_EMAIL_SUBJECT`：独一无二的随机主题暗号，在 iPhone 自动化中使用同一个值。

在 iPhone“快捷指令”中创建“截屏”→“获取 URL 内容”快捷指令。后一步 URL 为 `https://lumi-tokyo-api.zeabur.app/v1/chats/default/screen-peek/frame`，方法选 `POST`，请求体选“文件”并使用上一步截屏；添加请求头 `Authorization: Bearer <LUMI_SCREEN_PEEK_TOKEN>`。再创建“收到邮件”自动化，同时限定发件人和主题暗号，运行上述快捷指令，并选择“立即运行”。在快捷指令的隐私设置中允许锁定时运行。先手动运行快捷指令，确认上传返回 `accepted: true`，再用一封测试邮件验证自动化；锁屏状态也应单独实测。

后端只接受带专用口令的 JPEG/PNG 截图，最大 3 MB。唤醒后最多等 45 秒的新图；每个聊天只在服务进程内暂存一张，交给模型后立即移除，未使用的图两分钟后过期。此方式要求单实例部署。截图会传给当前配置的聊天模型，因此不要在不希望分享屏幕内容时开启此功能。


## 163 邮箱 MCP

后端提供带 Bearer Token 鉴权的 Streamable HTTP MCP 端点：`POST /mcp`。Claude Desktop、Claude Code 等 MCP 客户端可连接此地址，并调用收件、读信、搜索、列出文件夹和发信工具。

在 Zeabur 添加以下服务端环境变量：

- `LUMI_MAIL_MCP_TOKEN`：随机生成的长令牌，MCP 客户端用它作为 Bearer Token。
- `LUMI_MAIL_ADDRESS`：163邮箱完整地址。
- `LUMI_MAIL_PASSWORD`：163邮箱设置中生成的客户端授权密码，不是网页登录密码。
- `LUMI_MAIL_IMAP_HOST`：默认 `imap.163.com`。
- `LUMI_MAIL_IMAP_PORT`：默认 `993`。
- `LUMI_MAIL_SMTP_HOST`：默认 `smtp.163.com`。
- `LUMI_MAIL_SMTP_PORT`：默认 `465`。
- `LUMI_MAIL_DISPLAY_NAME`：可选的发件人显示名，默认 `Lumi`。

在163邮箱网页端开启 IMAP/SMTP 服务并生成客户端授权密码。不要把授权密码、Claude API Key或 MCP 令牌写进仓库。

让 Lumi 自己的 Claude API 对话使用邮箱工具，还需配置：

- `LUMI_MAIL_MCP_URL`：公开 HTTPS 地址，例如当前部署域名 `https://lumi-tokyo-api.zeabur.app/mcp`。
- `LUMI_MAIL_MCP_TOKEN`：与 MCP 入口鉴权使用的同一个随机长令牌。
- `LUMI_NATIVE_ANTHROPIC=true`：启用 Claude Messages API 和 MCP Connector。
- `LUMI_MODEL_API_URL=https://api.anthropic.com/v1`、`LUMI_MODEL_API_KEY`、`LUMI_MODEL_NAME`：Claude API 地址、密钥和 Claude 模型名称。

此接法要求 Claude API 能从公网 HTTPS 访问 Lumi 的 `/mcp` 地址。也可以把此地址和请求头 `Authorization: Bearer <LUMI_MAIL_MCP_TOKEN>` 配到 Claude Desktop、Claude Code 等 MCP 客户端。MCP 的 `mail_send` 会立即发信。“发给我”默认发至 `yanvn2026@outlook.com`。用户明确要求发信时，Lumi 会直接发送，不会二次确认；自主唤醒只能执行聊天历史中明确的具体发信请求，不会只因自行判断就发起邮件。邮件正文不增加模型 token 上限；服务器仍有 100000 字符上限，网易 SMTP 也有服务端大小限制。

自主唤醒继续走当前聊天的模型和上下文：它沿用当前线程选定的模型、聊天历史、压缩摘要、检索记忆和情绪状态。唤醒请求会明确列出当时可用的能力及用法：窥屏仅在用户启用该动作且截图邮件/快捷指令配置完整时出现；邮箱工具仅在 Claude MCP Connector 和 163 邮箱配置完整时出现。模型可用 `mail_inbox`、`mail_search`、`mail_read` 获取邮件内容，用 `mail_send` 立即发信；只有上下文中存在用户明确的发送请求或授权时才能在自主唤醒中发送。

## API

- `GET /health`
- `GET /v1/chats/:id`
- `POST /v1/chats/:id/messages`，JSON body：`{"content":"你好","systemPrompt":"可选"}`
- `POST /v1/memories`，JSON body：`{"content":"要记住的内容","threadId":"可选"}`
- `GET /v1/chats/:id/emotion/state|arc|regret|memory`，以及 `POST /v1/chats/:id/emotion/activate` / `POST /v1/chats/:id/emotion/memory`；这些接口需要 `Authorization: Bearer <LUMI_PUSH_API_TOKEN>`

### 情绪驱动力

所有聊天共用一份持久化的情绪状态，保存十类连续驱动力（想念、心软、心疼、好奇、促狭、躁动、后悔、欲望、低落、吃醋）。每 10 分钟向各自基线衰减；离线满 6 个 tick 后想念开始增长；最强驱动力达到 0.65 时每 20 分钟生成一条私密独白，达到 0.50 时按 Murmur 节奏经 Lumi APNs 推送。北京时间 16:00–00:00 静默时段会积攒想念推送，睡眠期间不发送情绪推送。普通聊天、哨兵主动消息、通话、梦境/睡眠阶段和图像整理请求都会收到这份共享驱动力上下文；动态情绪只放在每次请求的 user suffix，不拼进稳定缓存系统提示词。

`emotion/state` 返回当前驱动力；`emotion/arc?type=murmur&n=20` 读取独白，`emotion/regret?n=20` 读取检讨，`emotion/memory` 读取长期/短期情绪记忆。`POST emotion/activate` 支持 `{"type":"activate"}`、`{"type":"boost","drive":"attachment","delta":0.1}`、`{"type":"write_arc","drive":"attachment","text":"..."}` 和 `{"type":"tick"}`。`POST emotion/memory` 支持 `{"content":"..."}` 写短期记忆（最多 500 字）或 `{"scope":"long","content":"..."}` 写长期记忆。

此实现参考 [Murmur-50Feet](https://github.com/Nixie0/Murmur-50Feet)，保留其 MIT 许可，见 `THIRD_PARTY_NOTICES.md`。

当窗口估算 Token 达到 `LUMI_CONTEXT_LIMIT × LUMI_COMPACT_AT` 时，后端会自动把较早历史蒸馏为
`<context_summary>`（用户画像、关系动态、关键事实、当前话题），保留最近对话继续发送给模型；摘要会在后续压缩时增量合并。

每条消息会先由模型提取内部检索关键词，再向记忆库检索；关键词只用于记忆库请求，不会原样传给聊天模型。检索到的记忆正文会作为上下文注入模型。模型可在回复末尾使用内部 `<memory>...</memory>` 标记选择写入长期记忆，后端会移除该标记并在客户端显示“-------沈屿记下了这一刻-------”。
