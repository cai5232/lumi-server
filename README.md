# Lumi Server

Lumi 的后端 API，独立部署在 VPS。

## 本地运行

```bash
npm install
npm run dev
```

默认端口为 `8787`，数据保存在 `data/threads.json`。生产环境请通过 `LUMI_DATA_DIR` 指定持久化目录，并把模型服务的密钥放在部署平台环境变量中，不要写入代码或 iOS 客户端。

部署环境变量：

- `LUMI_MODEL_API_URL`：OpenAI 兼容的 Chat Completions 完整地址
- `LUMI_MODEL_API_KEY`：模型服务 API Key
- `LUMI_MODEL_NAME`：模型名称
- 系统提示词：普通聊天和桌面伴读共用后端的规范系统提示词；桌面伴读额外附加 JSON 决策格式约束，不覆盖人物提示词
- `LUMI_DATA_DIR`：建议设为 `/data`，并在部署平台挂载持久化 Volume 到 `/data`
- `SENTINEL_INGEST_TOKEN`：快捷指令上报所选 App 的独立 Bearer 口令；不配置时该接口拒绝请求
- 上下文压缩：以上游上一条请求实际输入 Token 数为依据，达到 `LUMI_CONTEXT_LIMIT × LUMI_COMPACT_AT` 后，在下一条普通聊天请求中单独调用摘要模型压缩较早历史；默认窗口 `200000`、触发比例 `0.85`（约 170k）。保留最近至少 `10` 轮、最多 `15` 轮完整对话，并以约 `20000` token 为尾部目标；摘要模型默认使用当前聊天模型，也可通过 `LUMI_COMPACTION_MODEL` 单独指定。电话和主动提醒请求不触发压缩。
- `LUMI_MEMORY_API_URL`：记忆库地址，默认 `https://memorycore.zeabur.app`
- `LUMI_MEMORY_API_KEY`：可选，记忆库 API Key
- `LUMI_MEMORY_SEARCH_PATH`：可选，检索路径，默认 `/search`
- `LUMI_MEMORY_WRITE_PATH`：可选，写入路径，默认 `/memories`
- `LETTERS_MAP_BASE_URL`：藏宝地图服务地址，默认 `https://lumi-hidden-letters.zeabur.app`
- `LETTERS_MAP_PASSWORD`：藏宝地图服务密码，仅由后端代理使用，不要放入 iOS 客户端；配置后会把该服务的 MCP 自动加入 Lumi

## 聊天贴纸库

iOS 聊天输入框的贴纸按钮读取 `GET /v1/stickers`，新增贴纸使用 `POST /v1/stickers`（JSON 字段：`name`、`category`、`dataURL`，支持 JPEG、PNG、GIF、WebP，单张最大 2.5 MB）。读取和新增接口，以及贴纸图片读取接口，都使用现有 `LUMI_PUSH_API_TOKEN` Bearer 鉴权。贴纸目录和目录清单分别保存在 `LUMI_DATA_DIR/stickers/` 与 `LUMI_DATA_DIR/stickers.json`。

Coolify 部署时，将 `LUMI_DATA_DIR` 设为 `/data`，并把持久化 Volume 挂载到 `/data`；这样重新部署或重启后，贴纸图片和清单仍会保留。聊天记录只保存贴纸名称和资源路径，聊天模型收到名称文本，不会收到贴纸图片内容。

藏宝地图 MCP 地址为 `${LETTERS_MAP_BASE_URL}/mcp`，传输方式是 Streamable HTTP，授权头由后端使用 `LETTERS_MAP_PASSWORD` 自动生成。Lumi 会连接并读取原仓库提供的五个工具；聊天模型按对话需要调用。无需把地图页面或地图数据搬进 Lumi。
- `LUMI_WATCH_ANALYSIS_API_URL`、`LUMI_WATCH_ANALYSIS_API_KEY`、`LUMI_WATCH_ANALYSIS_MODEL`：可选的共看视频分析默认模型；iOS 页面填写的配置会按请求单独转发，不要求在这里配置

## 手机 App 活动（可选）

iPhone「快捷指令」可在所选 App 打开时调用 `POST /v1/sentinel/events`，JSON 请求体：`{"app":"X","timeZone":"America/New_York"}`。请求头用 `Authorization: Bearer 你的 SENTINEL_INGEST_TOKEN`。令牌只在 Zeabur 服务环境变量和你自己的快捷指令里设置，不要放进共享链接。

Lumi 只保存所选 App 名称和接收时间，最多保留 7 天；主动唤醒会把最近活动作为聊天背景，并按近一小时活动量适度缩短间隔。凌晨 1:00–5:00 的活动只在主动联系已启用、用户至少 30 分钟没有给 Lumi 发消息、且勿扰/睡眠未开启时安排短消息；不会因 App 活动拨电话。停用快捷指令自动化即可停止上报。

## 檐廊 Engawa MCP

把独立部署的 Engawa MCP 地址填入 `ENGAWA_MCP_URL`，例如 `https://engawa.example.zeabur.app/mcp`。Lumi 后端会自动把“檐廊 Engawa”加入 iOS 的“设置 → MCP 工具”，可以在那里启用或关闭；不需要在手机里保存服务凭证。

聊天和自主唤醒只会向模型开放 `web_read`、`rss_read`、`shelf`、`shelf_suggest`、`sky_tonight`、`apod`、`daily_art`、`arxiv_new`、`daily_poem`、`on_this_day` 和 `hobby_corner`。书架与兴趣的增删工具仍可在 MCP 设置中手动调用。Engawa 的 HTTP 服务不带内置认证；部署前请确认 Zeabur 服务访问策略，避免把可写的 MCP 端点交给不受信任的调用方。Lumi 到 Engawa 的请求只使用公开 HTTPS 地址。

`PORT` 由 Zeabur 自动注入，不需要手动填写。

## 本机外卖助手

云端服务不能访问 Mac 的 `127.0.0.1:9222`。在本仓库的 `takeout-agent/` 运行 `npm install && npm run start-mac`，助手会连到 Lumi 的 `/v1/takeout/bridge`，并复用独立的 `~/Documents/Codex/LumiTakeoutChromeBridge` Chrome 档案。设置 `LUMI_TAKEOUT_BRIDGE_TOKEN` 后，桥接接口只接受这个专用令牌（也兼容既有 `LUMI_PUSH_API_TOKEN`）；在 Mac 上运行 `npm run setup-token` 可将专用令牌隐藏输入并保存到 macOS Keychain。已有购物车走本机助手的直接结算流程，不搜索商品，也不重新加购。关键词点单脚本默认从 `~/Documents/Codex/ai-order-takeout/script/order.js` 加载，可用 `LUMI_TAKEOUT_ORDER_SCRIPT` 覆盖路径。

助手在聊天回复或自主唤醒时都可自主决定何时点外卖；无需用户当前消息或上下文先表达点餐意愿，也无需固定口令或额外确认。助手想下单时可直接使用购物车，或自行选品搜索，并按用户授权自动提交付款、不设金额上限。购物车订单必须匹配已保存地址“桃李春风如山13幢2单元1210”。读不清商品或金额、地址不符、需要确认地址或出现安全验证时立即停止。支付口令只在 Mac 本机从 `~/.takeout_pay` 读取，不会发送到云端。安全验证必须由本人完成，助手不会绕过。

Mac、专用 Chrome 和助手进程都必须保持运行且电脑不能睡眠；屏幕熄灭可以。外卖助手运行后，Lumi 可自行决定何时下单，不必等用户先查看购物车或发出下单指令。

## 共享手帐日历

共享日历由当前 Lumi 后端提供 API 和 Streamable HTTP MCP，不需要再单独部署一个日历服务。事件、便签、页面 PNG 和变更记录保存在 `LUMI_DATA_DIR/calendar.json` 与 `LUMI_DATA_DIR/calendar-pages/`；Zeabur 应把 `LUMI_DATA_DIR` 指向已挂载的持久卷（当前服务挂载点为 `/data`）。日历 API 复用 `LUMI_PUSH_API_TOKEN` 鉴权，也可单独设置 `LUMI_CALENDAR_MCP_TOKEN`；iOS 页面入口是首页日历，MCP 地址为 `https://lumi-tokyo-api.zeabur.app/v1/calendar/mcp`。

MCP 暴露 `calendar` 工具，支持查看日期范围、查看某日手帐和页面图片、创建/修改/删除安排、添加便签及点赞。普通对话会获得当天日历上下文，也会从用户明确提及的安排中提取候选日程；提取器会跳过低置信度和重复项。服务端变更会沿用已注册的 APNs 设备通知。

可选变量：`LUMI_CALENDAR_FILE`（自定义 JSON 文件路径）、`LUMI_CALENDAR_TIMEZONE`（默认 `Asia/Shanghai`）、`LUMI_CALENDAR_MCP_URL`（自定义 MCP URL）、`LUMI_CALENDAR_EXTRACTOR_PROVIDER`、`LUMI_CALENDAR_EXTRACTOR_MODEL`、`LUMI_CALENDAR_EXTRACTOR_MIN_CHARS`、`LUMI_CALENDAR_EXTRACTOR_MIN_CONFIDENCE`。

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

自主唤醒继续走当前聊天的模型和上下文：它沿用当前线程选定的模型、聊天历史、压缩摘要、检索记忆和情绪状态。唤醒请求会明确列出当时可用的能力及用法：窥屏仅在用户启用该动作且截图邮件/快捷指令配置完整时出现；邮箱工具仅在 Claude MCP Connector 和 163 邮箱配置完整时出现；Engawa 只提供公共内容读取工具。模型可用 `mail_inbox`、`mail_search`、`mail_read` 获取邮件内容，用 `mail_send` 立即发信。普通聊天按用户请求发送；自主唤醒可以自行决定给 `yanvn2026@outlook.com` 写信，但服务端会拒绝其他收件人和任何抄送。

`mail_send` 成功后，后端按聊天线程把收件人、主题、完整正文、发信时间和 SMTP 消息 ID 写入 `LUMI_DATA_DIR/sent-mail.jsonl`。下一轮普通聊天和自主唤醒会自动看到最近五封已发送邮件的摘要；模型还可用 `mail_sent_search` 检索更早的发信记录，并用 `mail_sent_read` 读取完整正文。这个记录与聊天历史、压缩摘要、长期记忆检索一同进入后续模型请求；请将 `LUMI_DATA_DIR` 放在 Zeabur 持久化卷上，避免部署重启后丢失发信记录。

## API

### Duetto listen-together app

The complete Duetto listen-together experience is bundled under `src/duetto` and served through Lumi. Open `/together-listen` or `/pkg/index.html`; Lumi proxies its `/api/*`, `/pkg/*`, and `/ws` real-time socket to a loopback-only sidecar. It includes NetEase playlists/recommendations/FM/lyrics/translations/artist pages/comments/likes and playlist editing; queued playback modes and prefetch; room sync/chat; lyric quoting and questions; listening archive and AI song analysis/memories/DJ; model settings, prompt preview, five palettes and custom appearance.

The sidecar uses Node's built-in SQLite and requires Node 22.5+. Its PIN, NetEase session and archive are isolated under `LUMI_DATA_DIR/duetto`. Upstream source and MIT license are included in `src/duetto`; operator guide: `src/duetto/GUIDE.md`.


- `GET /v1/music/netease/status|qr|qr/check?key=...`: account status and QR login
- `GET /v1/music/netease/search?q=...` and `GET /v1/music/netease/song-url?id=...`: song search and stream resolution
- `GET /v1/music/room/state?room=main` / `PUT /v1/music/room/state`: shared playback state
- `GET /v1/music/room/messages?room=main` / `POST /v1/music/room/messages`: shared room chat, capped at 500 persisted messages
- `POST /v1/music/netease/logout`: disconnect the NetEase account

Music routes use `LUMI_PUSH_API_TOKEN` Bearer authentication. The NetEase session is stored in `LUMI_DATA_DIR/ncm-cookie.txt` with owner-only file permissions; room state and chat are stored in `music-room-state.json` and `music-room-messages.json`. Keep `LUMI_DATA_DIR` on a persistent volume.
- `GET /health`
- `GET /v1/chats/:id`
- `POST /v1/chats/:id/messages`，JSON body：`{"content":"你好","systemPrompt":"可选"}`；设置 `"stream":true` 时，服务端按 SSE 发送正文文字片段和最终完整响应，不支持上游流式的线路也会获得视觉分段效果
- `GET /v1/watch/analysis-config`、`POST /v1/watch/analyze`：Bearer 鉴权；将当前视频帧转发给单独配置的 OpenAI 兼容视觉模型，不上传或保存完整视频
- `POST /v1/memories`，JSON body：`{"content":"要记住的内容","threadId":"可选"}`
- `/v1/letters-map`：经 Lumi API 授权后转发藏宝地图服务；需配置地图服务环境变量
- `GET /v1/chats/:id/emotion/state|arc|history|regret|memory`，以及 `POST /v1/chats/:id/emotion/activate` / `POST /v1/chats/:id/emotion/memory`；这些接口需要 `Authorization: Bearer <LUMI_PUSH_API_TOKEN>`
- `POST /v1/companion/devices`、`POST /v1/companion/observe`、`DELETE /v1/companion/devices/:id`：macOS 桌面伴读配对与观察接口，使用独立的 `LUMI_DESKTOP_COMPANION_PAIR_TOKEN` 配对；观察按设备绑定的 Lumi 会话和自定义模型路由生成。观察请求可带 `force: true` 跳过两分钟冷却，仍受并发和请求预算限制。最近一次经过敏感信息过滤的屏幕文本、窗口标题和弹幕会作为该会话的隐藏模型上下文保存最多 6 小时，到期清理，不写入可见聊天记录或桌面事件日志

### Promise Alarm 约定提醒

`/promise-alarm` 集成了完整的 Promise Alarm 应用：Lumi 普通聊天会把当轮对话交给提醒服务识别，已有约定会进入后续模型上下文；到点后生成的消息会写入对应 Lumi 聊天，并尝试通过 APNs 提醒设备。独立演示聊天和原有的 capture/context/cancel/fired API 也保留在同一页面下。网页入口：`https://你的服务域名/promise-alarm`。

部署需要 Python 3.9+（只使用标准库）。Node 服务会自动启动内部 Python 服务，监听回环地址，不需要额外暴露端口。服务会把约定数据库保存在 `LUMI_DATA_DIR/promise-alarm/promises.db`。

默认复用 `LUMI_MODEL_API_URL`、`LUMI_MODEL_API_KEY`、`LUMI_MODEL_NAME` 和 `LUMI_SYSTEM_PROMPT`。当前模型接口需兼容 OpenAI Chat Completions。可用以下变量覆盖提醒服务的配置：

- `LUMI_PROMISE_ALARM_ENABLED=false`：关闭提醒服务（默认开启）。
- `LUMI_PROMISE_ALARM_PORT`：内部端口，默认 `18768`。
- `PROMISE_API_BASE`、`PROMISE_API_KEY`、`PROMISE_MODEL`、`PROMISE_PERSONA`：覆盖复用的模型配置。
- `PROMISE_UTC_OFFSET_HOURS`：提醒使用的 UTC 时差，默认北京时间 `8`。

Promise Alarm 上游代码及网页完整保存在 `promise-alarm/`，其原有 PolyForm Noncommercial 许可和 Required Notice 继续适用于该目录；详见 `promise-alarm/LICENSE` 和 `THIRD_PARTY_NOTICES.md`。

### 情绪驱动力

所有聊天共用一份持久化的情绪状态，保存十类连续驱动力（想念、心软、心疼、好奇、促狭、躁动、后悔、欲望、低落、吃醋）。每 10 分钟向各自基线衰减；离线满 6 个 tick 后想念开始增长；最强驱动力达到 0.65 时每 20 分钟生成一条私密独白，达到 0.50 时按 Murmur 节奏经 Lumi APNs 推送。北京时间 16:00–00:00 静默时段会积攒想念推送，睡眠期间不发送情绪推送。普通聊天、哨兵主动消息、通话、梦境/睡眠阶段和图像整理请求都会收到这份共享驱动力上下文；动态情绪只放在每次请求的 user suffix，不拼进稳定缓存系统提示词。

`emotion/state` 返回当前驱动力；`emotion/history?hours=24&n=500` 返回驱动力变化快照，背景 tick 每 10 分钟记录一次，聊天中的实际变化会立即记录，保留最近 7 天；`emotion/arc?type=murmur&n=20` 读取独白，`emotion/regret?n=20` 读取检讨，`emotion/memory` 读取长期/短期情绪记忆。`POST emotion/activate` 支持 `{"type":"activate"}`、`{"type":"boost","drive":"attachment","delta":0.1}`、`{"type":"write_arc","drive":"attachment","text":"..."}` 和 `{"type":"tick"}`。`POST emotion/memory` 支持 `{"content":"..."}` 写短期记忆（最多 500 字）或 `{"scope":"long","content":"..."}` 写长期记忆。

此实现参考 [Murmur-50Feet](https://github.com/Nixie0/Murmur-50Feet)，保留其 MIT 许可，见 `THIRD_PARTY_NOTICES.md`。

当上游上一条请求实际输入 Token 达到 `LUMI_CONTEXT_LIMIT × LUMI_COMPACT_AT` 时，后端会在普通聊天回复前通过一条独立摘要请求，把较早历史蒸馏为 `<context_summary>`，然后用「系统提示词 + 滚动摘要 + 最近原文」替换旧上下文。默认 `LUMI_CONTEXT_LIMIT=200000`、`LUMI_COMPACT_AT=0.85`，即约 170k 触发；最近完整对话至少保留 10 轮、最多 15 轮，目标约 20k token。摘要会在后续压缩时与旧摘要增量合并，不修改或删除存档聊天记录。摘要调用沿用当前前端自定义 API 路线；默认使用聊天模型，`LUMI_COMPACTION_MODEL` 可选填单独的摘要模型名，`LUMI_COMPACT_SUMMARY_TOKENS` 可选调整摘要最大输出，默认 25000。

每条消息会先由模型提取内部检索关键词，再向记忆库检索；关键词只用于记忆库请求，不会原样传给聊天模型。检索到的记忆正文会作为上下文注入模型。模型可在回复末尾使用内部 `<memory>...</memory>` 标记选择写入长期记忆，后端会移除该标记并在客户端显示“-------沈屿记下了这一刻-------”。

### 世界书

在 iPhone 的「设置 → 世界书管理」添加世界书和条目，选择「全局选用」后点击「保存到后端」。支持 Kelivo JSON 导入/导出、关键词或正则匹配、大小写、常驻、扫描深度、优先级、五种插入位置、消息角色和持续/冷却/延迟规则。时间规则统计真实用户及助手消息，重复准备同一历史不会重复计数。

`GET /v1/world-books` 和 `PUT /v1/world-books` 使用现有 `LUMI_PUSH_API_TOKEN` 的 Bearer 鉴权。保存时发送读取时的 `revision`，过期版本返回 409，避免覆盖其他设备修改。数据原子持久化在 `LUMI_DATA_DIR/world-books.json`。`GET/PUT /v1/chats/:id/world-books` 的 `bookIds: null` 继承全局选择，空数组表示本聊天不使用世界书。预览仅展示文本匹配；实际计时由服务器聊天记录决定。

世界书行为移植自 Kelivo（AGPL-3.0），详见 `THIRD_PARTY_NOTICES.md` 和 `LICENSES/Kelivo-AGPL-3.0.txt`。对应源码：https://github.com/cai5232/lumi-server。


## Proactive native calls

Assistant-initiated calls use the registered iOS PushKit token and expire after 30 seconds. The sentinel can place at most one proactive call per local calendar day, only between 12:00 and 23:00 in `LUMI_USER_TIME_ZONE` (defaults to `Asia/Shanghai`), and never while Do Not Disturb is enabled or a sleep transition is pending. `PUT /v1/settings/proactive` accepts `dnd: true|false`; the setting is persisted with the proactive configuration. Call-control and pending-call routes require the existing `LUMI_PUSH_API_TOKEN` Bearer authorization.

During calls, iOS may send a short `voiceContext` cue based on the speaker's own baseline. The server treats it as a weak hint and keeps spoken words authoritative. `softVoice: true` lowers playback volume and adjusts supported TTS settings. Saying goodnight triggers a gentle response and schedules hangup 18 seconds after playback, unless the user speaks again.

## 即时指令

普通聊天与自主联系可以在回复末尾产生隐藏的 `<countdown>{"title":"喝水","minutes":1}</countdown>` 标签；省略 `minutes` 时仅记录用时。指令从服务端发出时计时，最长 24 小时。状态保存在 `LUMI_DATA_DIR/instant-commands.json`，不需要 D1 或新增数据库。复用已注册的 APNs 发送新指令通知。

原生客户端使用以下接口，均需要现有的 `LUMI_PUSH_API_TOKEN` Bearer 鉴权：

- `GET /v1/chats/:threadID/commands`：待完成指令。
- `POST /v1/chats/:threadID/commands/:id/started`：返回原始开始时间，不重置倒计时。
- `POST /v1/chats/:threadID/commands/:id/complete`：记录完成用时并移出队列。
- `DELETE /v1/chats/:threadID/commands/:id`：取消，不生成反馈。

完成反馈按聊天隔离，注入下一轮普通聊天的动态尾部；回复持久保存后才确认消费，模型失败不会丢失反馈。该实现兼容 NEST 的标签格式，使用 Lumi 自有存储和 SwiftUI 界面，没有引入参考仓库的 Workers/D1 代码。

## Solo controls and sleep inbox

- `POST /v1/solo/trigger` requires the existing API token and an `Idempotency-Key`. It starts one private Solo run using the saved encrypted custom route, bypassing automatic desire/idle thresholds. Sleeping or busy conversations return 409. Repeating an accepted key never starts a second run, including across server restarts.
- `GET/PUT /v1/settings/solo` also supports `cooldownMinutes` (5–1440; default 60). Existing clients may omit it. Automatic Solo still requires an idle, non-foreground conversation and sufficient desire; manual runs do not send a chat message.
- A farewell keyword arms sleep after the configured silence delay (production default 60 minutes). Sleeping user messages are durably saved first. Each unique receipt has a 25% independent wake chance; the fifth receipt in that sleep session forces wake. Request retries never add a receipt or reroll the chance.
- A silent receipt returns `replyDeferred: true` and a stable empty compatibility `assistantMessage`; this placeholder is never inserted into conversation history. Images use the existing durable attachment store.
- Random/forced wake and natural wake all supply the complete sleeping inbox and the full latest sleep-session dreams to the model. Inbox IDs are acknowledged only after successful output; restart and failure preserve unanswered messages. Natural wake responds to an inbox even when proactive contact is disabled. New foreground sends cancel background generation and share its conversation persistence reservation.
- `GET /v1/chats/:id/sleep?offset=0&limit=30` is authenticated and returns current activity, sleep policy, pending message count, and complete dream bodies with pagination. Dream text removes private emotion-update markup, not narrative. Ordinary dreams remain outside the visible chat transcript.


### 压缩异常恢复

摘要使用独立的整理提示词，不重复注入聊天人物提示词和其中的旧摘要。默认按最多 60,000 字符分批（可用 `LUMI_COMPACT_CHUNK_CHARS` 调整）；空响应或缺少完整摘要标签时，在同一模型线路上以非流式请求修复一次。额度、鉴权及网络错误不会作为格式问题重复调用。只有完整成功的批次才保存检查点，全部完成后才提交新摘要，原始聊天记录始终保留。

聊天、通话、桌面伴读和自主唤醒发送模型请求前，会检查上一轮实测输入与当前请求估算（含系统背景及工具定义）。超过 `LUMI_CONTEXT_LIMIT` 时返回明确的压缩未完成错误，不再继续发送巨量历史。触发阈值与失败后的冷却仍沿用现有设置；线路额度恢复或切换到可用线路后，下一次普通聊天会按冷却状态重试压缩。

压缩失败的冷却按模型、接口和凭据绑定；切换线路可立即重试，原线路的冷却会跨重启保留。冷却和已有任务会打印明确的 `[compaction] skipped` 日志。超量聊天会返回真实的摘要失败原因与重试时间，不再只显示通用上限错误。
