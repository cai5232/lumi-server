import { createHash } from "node:crypto";
import { nativeAlarmTools } from "./native-alarms.js";

export const NATIVE_ALARM_MCP_ID = "lumi-native-alarms";
export const NATIVE_ALARM_MCP_PATH = "/v1/native-alarms/mcp";

const mutations = { create_alarm: "create", update_alarm: "update", delete_alarm: "delete" };
const protocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26"];
const operationIDSchema = {
  type: "string", format: "uuid", description: "此操作的唯一 UUID。重试同一操作时使用同一个 UUID。"
};

export const nativeAlarmMcpTools = nativeAlarmTools.map(tool => Object.hasOwn(mutations, tool.name)
  ? { ...tool, inputSchema: {
    ...tool.inputSchema,
    properties: { ...tool.inputSchema.properties, operationID: operationIDSchema },
    required: [...tool.inputSchema.required, "operationID"]
  } }
  : tool);

function operationIDForTurn(turn, name, args) {
  const hash = createHash("sha256").update(JSON.stringify([turn, name, args], (key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex");
  return [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)].join("-");
}

export function createNativeAlarmMcp(store, notifyDevice) {
  async function callTool(name, args, { autonomous, turn } = { autonomous: true }) {
    const snapshot = await store.get();
    if (snapshot.device?.authorization !== "authorized" || !snapshot.device.allowAI ||
        (autonomous && !snapshot.device.allowAutonomous)) {
      throw Object.assign(new Error("当前模式没有 iPhone 闹钟权限。请在 Lumi 的系统闹钟设置中启用。"), { statusCode: 403 });
    }
    if (name === "list_alarms") return snapshot;
    if (name === "get_alarm_status") return store.status(args.operationID);
    const kind = mutations[name];
    const operationID = turn ? operationIDForTurn(turn, name, args) : args.operationID;
    const { alarmID, expectedRevision, config } = args;
    const task = await store.mutate({ kind, alarmID, expectedRevision, config },
      { source: "ai", autonomous, operationID });
    if (task.status === "pending") void notifyDevice();
    return { ...task, message: "仅 applied 表示 iPhone 已确认执行。推送和待同步状态都不等于成功。" };
  }

  async function handleMessage(message, enabled) {
    const id = message?.id;
    const reply = body => ({ jsonrpc: "2.0", id: id ?? null, ...body });
    const error = (code, message) => reply({ error: { code, message } });
    if (message?.jsonrpc !== "2.0" || typeof message.method !== "string" ||
        (id !== undefined && typeof id !== "string" && typeof id !== "number")) {
      return error(-32600, "Invalid Request");
    }
    // Notifications have no response and cannot invoke mutating tools.
    if (id === undefined) return null;
    switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      return reply({ result: {
        protocolVersion: protocolVersions.includes(requested) ? requested : protocolVersions[0],
        capabilities: { tools: {} },
        serverInfo: { name: NATIVE_ALARM_MCP_ID, version: "1.0.0" }
      } });
    }
    case "ping": return reply({ result: {} });
    case "tools/list": return reply({ result: { tools: enabled ? nativeAlarmMcpTools : [] } });
    case "tools/call": {
      const tool = nativeAlarmMcpTools.find(tool => tool.name === message.params?.name);
      const args = message.params?.arguments ?? {};
      if (!enabled || !tool || typeof args !== "object" || Array.isArray(args) ||
          tool.inputSchema.required.some(key => !Object.hasOwn(args, key)) ||
          Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) {
        return error(-32602, "Invalid or disabled alarm tool, or missing required arguments");
      }
      try {
        const result = await callTool(tool.name, args);
        return reply({ result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      } catch (error) {
        const text = error.statusCode ? error.message : "闹钟服务暂时不可用。";
        return reply({ result: { isError: true, content: [{ type: "text", text }] } });
      }
    }
    default: return error(-32601, "Method not found");
    }
  }
  async function handle(message, enabled) {
    // Lumi's older MCP clients negotiate the version that supports batches.
    if (!Array.isArray(message) || message.length === 0) return handleMessage(message, enabled);
    const responses = [];
    for (const request of message) {
      const response = await handleMessage(request, enabled);
      if (response) responses.push(response);
    }
    return responses.length ? responses : null;
  }

  return { callTool, handle };
}
