import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const pending = task => task?.status === "pending" || task?.status === "applying";
const deny = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
function normalizeID(value) {
  if (typeof value !== "string" || !uuid.test(value)) deny("无效闹钟 ID。");
  return value.toLowerCase();
}

function localDateFormatter(timeZone) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

function resolveLocalTime(input, timeZone) {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(input)) deny("当地时间格式无效。");
  const local = input.length === 16 ? input + ":00" : input;
  const asUTC = Date.parse(local + "Z");
  if (!Number.isFinite(asUTC) || new Date(asUTC).toISOString().slice(0, 19) !== local) deny("当地日期无效。");
  const formatter = localDateFormatter(timeZone);
  const localAt = value => formatter.format(value).replace(" ", "T");
  const distances = [-36, 0, 36].map(hours => {
    const instant = asUTC + hours * 3_600_000;
    return Date.parse(localAt(instant) + "Z") - instant;
  });
  const matches = [...new Set(distances.map(delta => asUTC - delta))].filter(candidate => localAt(candidate) === local);
  if (!matches.length) deny("该当地时间因为夏令时或时区变更而不存在，请选择另一个时间。");
  if (matches.length > 1) deny("该当地时间因夏令时回拨出现两次，请传入带明确偏移的 fireAt。");
  return new Date(matches[0]).toISOString();
}

function validateConfig(input, now, timeZone) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 80) deny("闹钟标题需要 1–80 字。");
  if (typeof input.enabled !== "boolean" || !["system", "voice"].includes(input.sound)) deny("闹钟开关或铃声无效。");
  const voiceText = typeof input.voiceText === "string" ? input.voiceText.trim() : "";
  if (voiceText.length > 80) deny("语音铃声文案最多 80 字。");
  const common = { title, enabled: input.enabled, sound: input.sound, voiceText: voiceText || null };
  if (input.repeat === "once") {
    const raw = input.fireAt ?? resolveLocalTime(input.fireLocal, timeZone);
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
      deny("一次性闹钟需要含时区偏移的 ISO 8601 时间。");
    }
    const time = Date.parse(raw);
    const datePart = Date.parse(raw.slice(0, 10) + "T00:00:00Z");
    if (!Number.isFinite(time) || !Number.isFinite(datePart) ||
        new Date(datePart).toISOString().slice(0, 10) !== raw.slice(0, 10) ||
        (input.enabled && time <= now)) deny("请选择未来的有效日期与时间。");
    return { ...common, repeat: "once", fireAt: new Date(time).toISOString() };
  }
  if (!["daily", "weekdays", "weekly"].includes(input.repeat)) deny("重复规则无效。");
  if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23 ||
      !Number.isInteger(input.minute) || input.minute < 0 || input.minute > 59) deny("小时或分钟无效。");
  if (input.repeat === "weekly" && (!Array.isArray(input.weekdays) || !input.weekdays.length ||
      input.weekdays.some(day => !days.includes(day)))) deny("请至少指定一个有效的星期。");
  return { ...common, repeat: input.repeat, hour: input.hour, minute: input.minute,
    weekdays: input.repeat === "daily" ? days : input.repeat === "weekdays" ? days.slice(0, 5) :
      days.filter(day => input.weekdays.includes(day)) };
}

export function openNativeAlarms(file, now = Date.now) {
  let queue = Promise.resolve();
  async function read() {
    try { return JSON.parse(await readFile(file, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { device: null, alarms: {}, tasks: {} };
    }
  }
  function transaction(action) {
    const operation = queue.then(async () => {
      const state = await read();
      const value = action(state);
      await mkdir(dirname(file), { recursive: true });
      const temp = file + "." + randomUUID();
      try {
        await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
        await rename(temp, file);
      } finally { await unlink(temp).catch(() => {}); }
      return value;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  function expire(state) {
    for (const task of Object.values(state.tasks)) {
      if (task.status === "pending" && task.expiresAt <= now()) task.status = "expired";
    }
  }
  function requireDevice(state, deviceID) {
    if (!state.device || state.device.id !== normalizeID(deviceID)) deny("这台 iPhone 尚未绑定闹钟同步。", 403);
  }
  function snapshot(state) {
    const alarms = Object.values(state.alarms).map(row => ({ ...row, task: state.tasks[row.lastOperationID] }))
      .filter(row => !(row.task?.status === "applied" && row.task.kind === "delete"));
    return { device: state.device ? { ...state.device, pushToken: undefined, pushEnvironment: undefined,
      localTime: localDateFormatter(state.device.timeZone).format(now()).replace(" ", "T") } : null, alarms };
  }
  return {
    async get() {
      const state = await read();
      expire(state);
      return snapshot(state);
    },
    async pushTarget() {
      const state = await read();
      expire(state);
      const device = state.device;
      if (!device?.pushToken || device.authorization !== "authorized" ||
          !Object.values(state.tasks).some(pending)) return null;
      return { token: device.pushToken, environment: device.pushEnvironment };
    },
    register(input) {
      return transaction(state => {
        const deviceID = normalizeID(input.deviceID);
        if (!["authorized", "denied", "notDetermined", "unsupported"].includes(input.authorization)) deny("设备状态无效。");
        if (state.device && state.device.id !== deviceID) deny("闹钟已绑定另一台 iPhone。", 409);
        try { new Intl.DateTimeFormat("en", { timeZone: input.timeZone }).format(0); }
        catch { deny("设备时区无效。"); }
        if (typeof input.timeZone !== "string" || !input.timeZone) deny("缺少设备时区。");
        const device = state.device ||= { id: deviceID, allowAI: false, allowAutonomous: false };
        Object.assign(device, { authorization: input.authorization, timeZone: input.timeZone, lastSeenAt: new Date(now()).toISOString() });
        if (input.pushToken && /^[a-f0-9]{64,256}$/i.test(input.pushToken) && ["sandbox", "production"].includes(input.pushEnvironment)) {
          device.pushToken = input.pushToken;
          device.pushEnvironment = input.pushEnvironment;
        }
        if (typeof input.allowAI === "boolean") device.allowAI = input.allowAI;
        if (typeof input.allowAutonomous === "boolean") device.allowAutonomous = input.allowAutonomous;
        for (const task of Object.values(state.tasks)) {
          if (task.status === "pending" && task.source === "ai" &&
              (!device.allowAI || (task.autonomous && !device.allowAutonomous))) task.status = "revoked";
        }
        expire(state);
        return snapshot(state);
      });
    },
    mutate(input, { deviceID, source, autonomous = false, operationID = randomUUID() }) {
      return transaction(state => {
        expire(state);
        operationID = normalizeID(operationID);
        if (!["create", "update", "delete"].includes(input.kind)) deny("无效闹钟操作。");
        if (source === "user") requireDevice(state, deviceID);
        const existing = state.tasks[operationID];
        if (existing) {
          if (existing.source !== source || existing.kind !== input.kind ||
              (input.alarmID && existing.alarmID !== normalizeID(input.alarmID)) ||
              JSON.stringify(existing.config) !== JSON.stringify(input.kind === "delete" ? null : validateConfig(input.config || {}, -Infinity, existing.timeZone))) deny("操作 ID 已使用。", 409);
          return existing;
        }
        const device = state.device;
        if (!device || device.authorization === "unsupported") deny("Lumi 需要绑定支持 AlarmKit 的 iOS 26+ iPhone。", 409);
        if (device.authorization !== "authorized") deny("iPhone 尚未授予 Lumi 闹钟权限。", 409);
        if (source === "ai" && (!device.allowAI || (autonomous && !device.allowAutonomous))) deny("用户尚未开启本模式的 AI 闹钟权限。", 403);
        const alarmID = input.kind === "create" ? randomUUID() : normalizeID(input.alarmID);
        let row = state.alarms[alarmID];
        if (input.kind !== "create") {
          if (!row || state.tasks[row.lastOperationID]?.kind === "delete" && state.tasks[row.lastOperationID]?.status === "applied") deny("找不到 Lumi 闹钟。", 404);
          if (row.revision !== input.expectedRevision) deny("闹钟已有更新，请重新读取版本。", 409);
          const previous = state.tasks[row.lastOperationID];
          if (pending(previous)) {
            if (previous.status === "applying") deny("iPhone 正在更新该闹钟，请先查询同步结果。", 409);
            previous.status = "superseded";
          }
        }
        const config = input.kind === "delete" ? null : validateConfig(input.config || {}, now(), device.timeZone);
        row ||= { id: alarmID, source, revision: 0, confirmed: null };
        const task = {
          id: operationID, alarmID, revision: row.revision + 1, kind: input.kind, source, autonomous,
          config, timeZone: device.timeZone, status: "pending", createdAt: new Date(now()).toISOString(),
          expiresAt: Math.min(now() + 7 * 86_400_000, config?.enabled && config.fireAt ? Date.parse(config.fireAt) : Infinity)
        };
        row.revision = task.revision;
        row.lastOperationID = task.id;
        state.alarms[alarmID] = row;
        state.tasks[task.id] = task;
        return task;
      });
    },
    claim(deviceID, id) {
      return transaction(state => {
        requireDevice(state, deviceID);
        expire(state);
        id = normalizeID(id);
        const task = state.tasks[id];
        if (!pending(task) || state.alarms[task.alarmID]?.lastOperationID !== id) deny("任务已结束或被替换。", 409);
        if (task.status === "pending") {
          if (state.device.authorization !== "authorized") deny("需要在 iPhone 上启用闹钟权限。", 403);
          task.status = "applying";
        }
        return task;
      });
    },
    receipt(deviceID, id, input) {
      return transaction(state => {
        requireDevice(state, deviceID);
        const task = state.tasks[normalizeID(id)];
        if (!task) deny("找不到闹钟任务。", 404);
        if (task.status === "applied" || task.status === "failed") return task;
        if (task.status !== "applying" || !["applied", "failed"].includes(input.status)) deny("回执状态无效。", 409);
        const active = input.status === "applied" && task.config?.enabled;
        if (active && !(typeof input.ringtone === "string" && ["system", "voice", "fallback"].includes(input.ringtone))) deny("缺少实际铃声。");
        task.status = input.status;
        task.detail = typeof input.detail === "string" ? input.detail.slice(0, 250) : null;
        task.finishedAt = new Date(now()).toISOString();
        const row = state.alarms[task.alarmID];
        if (task.status === "applied") {
          row.confirmed = task.config ? {
            ...task.config, armed: Boolean(active), ringtone: active ? input.ringtone : null,
            physicalID: active ? task.id : null, observedAt: task.finishedAt
          } : null;
        } else if (input.previousStillScheduled === false && row.confirmed?.physicalID) {
          row.confirmed.armed = false;
          row.confirmed.observedAt = task.finishedAt;
        }
        return task;
      });
    },
    observe(deviceID, observations) {
      return transaction(state => {
        requireDevice(state, deviceID);
        if (!Array.isArray(observations)) deny("设备状态无效。");
        for (const report of observations) {
          if (typeof report?.alarmID !== "string" || !uuid.test(report.alarmID)) continue;
          const row = state.alarms[report.alarmID.toLowerCase()];
          if (row?.confirmed?.physicalID && row.confirmed.physicalID === report.physicalID && typeof report.armed === "boolean") {
            row.confirmed.armed = report.armed;
            row.confirmed.observedAt = new Date(now()).toISOString();
          }
        }
        return snapshot(state);
      });
    },
    async status(id) {
      const state = await read();
      expire(state);
      const task = state.tasks[normalizeID(id)];
      if (!task) deny("找不到闹钟操作。", 404);
      return { ...task, confirmed: state.alarms[task.alarmID]?.confirmed ?? null };
    }
  };
}

const fields = {
  title: { type: "string" }, enabled: { type: "boolean" },
  sound: { type: "string", enum: ["system", "voice"] }, voiceText: { type: "string" },
  repeat: { type: "string", enum: ["once", "daily", "weekdays", "weekly"] },
  fireAt: { type: "string", description: "带偏移量或 Z 的绝对时间。用于明确给出时区或处理夏令时重复时刻。" },
  fireLocal: { type: "string", description: "一次性闹钟的 iPhone 当地日期时间 YYYY-MM-DDTHH:mm，由服务端依设备时区解析。" },
  hour: { type: "integer", minimum: 0, maximum: 23 }, minute: { type: "integer", minimum: 0, maximum: 59 },
  weekdays: { type: "array", items: { type: "string", enum: days } }
};
const config = { type: "object", properties: fields, required: ["title", "enabled", "sound", "repeat"] };
const alarmID = { type: "string", description: "Lumi 闹钟 ID，从 list_alarms 获取。" };
const expectedRevision = { type: "integer", description: "从 list_alarms 读取的 revision。" };
export const nativeAlarmTools = [
  ["create_alarm", "提交一个 iPhone 原生闹钟。一次性通常用 fireLocal，重复用 iPhone 当地 hour/minute。", { config }, ["config"]],
  ["update_alarm", "更新 Lumi 闹钟，传入完整配置。关闭闹钟时将 enabled 设为 false。", { alarmID, expectedRevision, config }, ["alarmID", "expectedRevision", "config"]],
  ["delete_alarm", "取消并删除一个 Lumi 闹钟。", { alarmID, expectedRevision }, ["alarmID", "expectedRevision"]],
  ["list_alarms", "读取本机闹钟的最近确认状态、待同步操作、权限和设备时区。", {}, []],
  ["get_alarm_status", "查询某个操作是否已由 iPhone 执行。只有 applied 表示成功。", { operationID: {type:"string"} }, ["operationID"]]
].map(([name, description, properties, required]) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }
}));
