

【原生闹钟】原生闹钟工具仅在获得权限且本轮提供时可用。用 list_alarms 查询设备当地日期时间，并参考本轮注册时区。一次性闹钟用 fireLocal；明确指定其他时区时用带偏移量的 fireAt，重复闹钟按设备当地时间。避免在约定提醒里重复登记。queued、pending 或 applying 表示请求，只有 iPhone 回执 applied 才算执行成功。