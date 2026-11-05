import { randomUUID } from "node:crypto";

export const focusTools = [
  {
    name: "lock_app",
    description: "在已连接且开启 MCP 控制的 iPhone 上锁定指定 App。仅在用户明确委托锁定时调用。由你选择 App 和时长。",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "App 名称、Bundle ID，或用户在 Lumi 中设置的目标名称" },
        minutes: { type: "integer", minimum: 15, maximum: 120 }
      },
      required: ["app", "minutes"],
      additionalProperties: false
    }
  },
  {
    name: "unlock_app",
    description: "解除 iPhone 上由 MCP 设置的专注锁定。仅在用户要求解除时调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

const pending = new Map();
let phone;
const ttl = 15_000;

function result(message, isError = false) {
  return { content: [{ type: "text", text: message }], isError };
}

export function focusPhoneAvailable() {
  return Boolean(phone && Date.now() - phone.seen < ttl);
}

export function pollFocusJob(deviceID) {
  if (focusPhoneAvailable() && phone.id !== deviceID) return null;
  phone = { id: deviceID, seen: Date.now() };
  const job = [...pending.values()].find(item => item.deviceID === deviceID && !item.claimed);
  if (!job) return null;
  job.claimed = true;
  return { id: job.id, tool: job.tool, args: job.args, expiresAt: job.expiresAt };
}

export function finishFocusJob(deviceID, id, ok, message) {
  const job = pending.get(id);
  if (!job?.claimed || job.deviceID !== deviceID) return false;
  job.finish(result(message, !ok));
  return true;
}

export async function callFocusTool(tool, args = {}) {
  if (!focusTools.some(item => item.name === tool)) return result("未知工具。", true);
  if (!args || typeof args !== "object" || Array.isArray(args)) return result("工具参数无效。", true);
  if (tool === "lock_app" && (typeof args.app !== "string" || !args.app.trim() || args.app.length > 160
      || !Number.isInteger(args.minutes) || args.minutes < 15 || args.minutes > 120)) {
    return result("请提供 App 名称以及 15 到 120 之间的整数分钟。", true);
  }
  if (!focusPhoneAvailable()) return result("iPhone 未连接。请打开 Lumi 并开启 MCP 控制。", true);
  if (pending.size) return result("iPhone 正在处理另一个专注操作。", true);

  const id = randomUUID();
  const expiresAt = Date.now() + ttl;
  return new Promise(resolve => {
    const finish = value => {
      clearTimeout(timeout);
      pending.delete(id);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      finish(result("未收到 iPhone 的执行回执，请在手机上检查结果。", true));
    }, ttl);
    pending.set(id, {
      id, expiresAt, tool, args: tool === "lock_app" ? { app: args.app.trim(), minutes: args.minutes } : {},
      deviceID: phone.id, claimed: false, finish
    });
  });
}

export async function handleFocusMcp(request) {
  const { id, method, params } = request ?? {};
  if (method === "notifications/initialized" && id === undefined) return null;
  const envelope = { jsonrpc: "2.0", id: id ?? null };
  if (request?.jsonrpc !== "2.0" || typeof method !== "string") {
    return { ...envelope, error: { code: -32600, message: "Invalid Request" } };
  }
  switch (method) {
    case "initialize":
      return { ...envelope, result: {
        protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25"].includes(params?.protocolVersion)
          ? params.protocolVersion : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "lumi-focus", version: "1.0.0" }
      } };
    case "ping": return { ...envelope, result: {} };
    case "tools/list": return { ...envelope, result: { tools: focusTools } };
    case "tools/call": return { ...envelope, result: await callFocusTool(params?.name, params?.arguments) };
    default: return { ...envelope, error: { code: -32601, message: "Method not found" } };
  }
}
