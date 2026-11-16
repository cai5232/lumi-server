# Lumi 原生闹钟

## 开启

- 用 Xcode 26 或更新版本构建 Lumi。旧版 iOS 可以继续运行 Lumi，闹钟页面显示 iOS 26+ 的要求。
- 在 Lumi 主 target 保留 **Push Notifications** 签名能力，并在 **Background Modes** 勾选 **Remote notifications**。已在 Info.plist 添加 `remote-notification`。AlarmKit 授权通过 `NSAlarmKitUsageDescription` 和 `AlarmManager.requestAuthorization()` 完成。本功能使用 AlarmKit 的原生响铃展示，无倒计时 Live Activity。
- 使用现有 APNs 环境、App 签名、后端鉴权和已保存的模型线路。VPS 的持久化数据目录会新增 `native-alarms.json`。
- 在 iPhone 打开 **Lumi → Settings → 系统闹钟**，启用闹钟并授予 Apple 权限。AI 管理与 VPS 自主安排分别授权，初始为关闭。当前绑定一个主 iPhone。

## 时间、同步与回执

- 一次性使用 `Alarm.Schedule.fixed`。服务端将设备当地日期解析为绝对时刻。夏令时跳过的时间需重新选择；回拨产生两个候选时刻时，请指定偏移量。
- 重复使用 `Alarm.Schedule.relative` 和每周星期规则。iPhone 根据自己的当地时间执行。
- AI 工具返回操作 ID、版本及状态。iPhone 的完成回执才会令操作变为 `applied`。打开 App、返回前台、前端收到变更工具结果及后台静默推送都可以触发同步。
- 同一闹钟的编辑必须传当前版本。未被手机领取的请求可被新版本替换；已经领取的请求要等手机回执。设备使用操作 UUID 作为 AlarmKit ID，重试时识别已安装的闹钟。手机保留尚未回传的回执。已过期的一次性任务不补响。
- 静默推送只负责提示同步，交付由 iOS 决定。App 被强制退出、设备离线或未解锁时，不能承诺 VPS 操作会在指定时间前执行。已经由 AlarmKit 登记的闹钟由系统负责触发。
- 管理范围是 Lumi 创建的闹钟。Apple 时钟及其他 App 的闹钟不在这个列表中。

## 语音铃声

使用 Lumi 已配置的语音服务生成，手机将结果转换为最多 25 秒的 16-bit Linear PCM CAF，保存到容器的 `Library/Sounds`，然后以文件名交给 AlarmKit。修改配置时生成新文件并重新登记。已登记的声音不依赖响铃时访问 VPS 或 TTS。合成或音频构建失败时提交系统铃声，并在回执中标记回退。

## 真机核对

1. 建立两分钟后的一次性闹钟并等到「已同步」。锁屏并保持 Lumi 在后台，确认声音和系统停止按钮。
2. 用配置的语音服务重复一遍；再使语音服务暂不可用，确认状态显示系统铃声。
3. 修改为工作日闹钟，再关闭并删除。确认只影响 Lumi 的闹钟。
4. 在有/无静默推送执行机会时各创建一次 VPS 任务。分别确认后台回执，以及打开 App 后才执行的待同步任务。
5. 检查取消授权、强制退出、跨时区和设备重启场景。尤其核对重启后第一次解锁之前，自定义语音的实际可用性。

## Lumi 闹钟 MCP

「Settings → Tools」会自动列出后端管理的「iPhone 系统闹钟」MCP。Lumi 在现有模型请求中提供五个闹钟工具，沿用手机端的 AI 闹钟权限。MCP 的开关控制工具可用性。

服务端提供 `/v1/native-alarms/mcp`，使用 Streamable HTTP 和现有 Lumi Bearer 鉴权。外部 MCP 调用按自主活动权限执行，写操作需传入唯一的 `operationID`，重试时应复用该 UUID。工具返回手机回执，`pending` 表示已排队，`applied` 表示 iPhone 已执行。
