# Lumi Server

Lumi 的后端 API，独立部署在 VPS。

## 本地运行

```bash
npm install
npm run dev
```

默认端口为 `8787`，数据保存在 `data/threads.json`。生产环境请通过 `LUMI_DATA_DIR` 指定持久化目录，并把模型服务的密钥放在 VPS 环境变量中，不要写入代码或 iOS 客户端。

## API

- `GET /health`
- `GET /v1/chats/:id`
- `POST /v1/chats/:id/messages`，JSON body：`{"content":"你好"}`
