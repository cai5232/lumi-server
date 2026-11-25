# 小动物画室与唤醒提示词

若若画室源码固定在 `vendor/ruoruo-chibi-studio/UPSTREAM_COMMIT`，保留上游 README、SKILL、模板、参考资料与授权。使用其原版 Node 渲染器，默认 pastel，sharp 转成最长边 1600 的 PNG。不调用任何绘图供应商。

模型通过现有业务工具桥使用 `lumi_chibi_read`（只读画室素材）和 `lumi_chibi_render`（有界 JSON 绘图）。不开放 Bash、任意文件、任意 SVG 或网络。渲染在独立进程进行，30 秒限时、堆内存和图片大小限制；每轮最多四张。成功后工具执行回执随聊天永久保存，PNG 单独存放 `/data/chibi-images`。读取图片需要现有聊天授权。前端复用原有图片消息链路，点开大图、长按选择保存到相册，仅请求相册添加权限。

原有 `/v1/settings/system-prompt` GET/PUT 保持不变；模拟 HTTP/SDK 测试验证修改后的角色提示词在重启恢复同一 Session 后生效。SDK 自定义 system prompt 的 `snapshot:false` 继续保留，不因提示词修改重建会话。

新增 `/v1/settings/autonomy-prompt` 和 `/v1/settings/wake-scene-prompt` GET/PUT（均需授权）。请求及回执为 `{prompt, revision}`，原子保存、校验旧 revision，冲突返回 409。两个独立文件保存在 `/data`，每次相应唤醒读取。缺省正文逐字来自原始 Markdown 的 wake_task，原始文件不变。仅替换任务正文；active_actions、wake_decision 协议、手机活动摘要、情境报告和动作权限保持服务器所有。日常聊天不加载这些规则。iOS 设置中的“自主唤醒提示词”编辑自主时间正文，页面底部可进入“情境唤醒提示词”。

验证：本地原模板 PNG 实际渲染并视觉检查；HTTP+模拟 SDK 工具调用、图片鉴权/持久化/SSE 完成回执；原有记忆幂等、重启恢复、画像更新、故障归档、自动压缩及原文保留；真实固定 SDK 的本地模拟上游合约；iPhone Debug 编译。未对真实 Kimi 发起测试或保温请求。原有 engawa-photos 的三个 VM 集成夹具仍存在缺失状态/全局变量的基线失败；其三个纯图片工具测试通过，新的完整 HTTP 图片链路测试通过。
