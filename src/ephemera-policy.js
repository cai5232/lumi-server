export const EPHEMERA_SERVER_ID = 'ephemera-date';
export const EPHEMERA_MCP_URL = 'https://ephemera-date.107.174.137.23.sslip.io/mcp';
const tools = new Set(['date_open','date_view','date_route','date_edit','date_send','date_live','date_close','date_inbox','date_memory']);
export function isTrustedEphemera(server) {
  return server?.id === EPHEMERA_SERVER_ID && server?.url === EPHEMERA_MCP_URL;
}
export function ephemeraWriteAllowed(server, tool) {
  return isTrustedEphemera(server) && tools.has(tool?.name);
}
export function ephemeraTrace(entry, trace) {
  return isTrustedEphemera(entry?.server)
    ? {name:trace.name, arguments:'约会内容已隐藏，请在 Us → 约会纸品查看。', result:trace.succeeded ? '约会工具执行成功；未公开的内容已隐藏。' : '约会工具执行失败；详情已返回给 AI。', succeeded:trace.succeeded, ephemeraSealed:true}
    : trace;
}
export function sealEphemeraReply(content, thinking, traces) {
  if (!traces.some(trace=>trace.ephemeraSealed)) return thinking ? `<thinking>${thinking}</thinking>\n${content.trim()}` : content.trim();
  return content.replace(/<(thinking|think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi,'').trim();
}
export const EPHEMERA_MODEL_GUIDE = '约会纸品已经接入 Us。可以调用 date_* 工具编写、调整、寄出约会，完整阅读工具返回的说明和校验错误。寄出前确认必要信息。未揭晓的地点、路线、信件和惊喜不要写进聊天正文、思考摘要、HTML 或其他工具；请让她去 Us → 约会纸品拆信查看。date_inbox 可以查看待办；没有待办就不要杜撰。';
// Read-only ledger: no claim/done side effects. Reminders and her "please write"
// requests become visible on normal replies and existing autonomous wakes.
export async function ephemeraContext(settings) {
  const server=settings?.servers?.find(server=>server.enabled && isTrustedEphemera(server));
  if(!server)return '';
  try {
    const response=await fetch(EPHEMERA_MCP_URL.replace(/\/mcp$/,'/context'),{headers:{...server.headers,accept:'text/plain'},redirect:'error',signal:AbortSignal.timeout(3000)});
    if(!response.ok)return '<ephemera_context>约会待办暂时读取失败；可用 date_inbox 重试，不要编造状态。</ephemera_context>';
    const text=(await response.text()).slice(0,16000);
    return `<ephemera_context source="private-date-engine">\n${text}\n如有待办，使用 date_inbox 领取并处理；不要将未公开的约会细节转述到聊天。</ephemera_context>`;
  } catch {return '<ephemera_context>约会待办暂时不可达；不要编造状态。</ephemera_context>';}
}
