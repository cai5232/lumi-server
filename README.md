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

`PORT` 由 Zeabur 自动注入，不需要手动填写。

## API

- `GET /health`
- `GET /v1/chats/:id`
- `POST /v1/chats/:id/messages`，JSON body：`{"content":"你好","systemPrompt":"可选"}`
