// All emotion readers and writers use the same independently deployed engine.
export async function requestMurmurEmotion(threadID, operation, payload, { fetchImpl = fetch, timeoutMS = 5_000 } = {}) {
  const base = String(process.env.MURMUR_SERVICE_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  const response = await fetchImpl(`${base}/internal/v1/chats/${encodeURIComponent(threadID || "default")}/emotion/${operation}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${process.env.MURMUR_INTERNAL_TOKEN || ""}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
    signal: AbortSignal.timeout(timeoutMS),
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  if (!response.ok) throw new Error(`Murmur ${operation} returned HTTP ${response.status}`);
  const result = await response.json();
  if (operation === "update" && (result?.ok !== true || !result.state?.drives)) throw new Error("Murmur did not acknowledge the emotion update");
  return result;
}
