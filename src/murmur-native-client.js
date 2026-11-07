// Native REST API; one character engine is shared across chats.
const reads = new Set(['state', 'mood', 'vitals', 'baselines', 'history', 'moved']);
const writes = new Set(['update', 'tick', 'sleep', 'snapshot', 'restore', 'presence', 'outreach']);
export async function requestMurmurEmotion(threadID, operation, payload, { fetchImpl = fetch, timeoutMS = 5_000, query = '' } = {}) {
  const base = String(process.env.MURMUR_SERVICE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('MURMUR_SERVICE_URL is required for the native engine');
  const method = payload === undefined ? 'GET' : 'POST';
  if (!(method === 'GET' ? reads : writes).has(operation)) throw new Error('unsupported_native_emotion_operation');
  const response = await fetchImpl(`${base}/emotion/${operation}${query}`, {
    method,
    headers: { authorization: `Bearer ${process.env.MURMUR_INTERNAL_TOKEN || ''}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(timeoutMS),
    ...(method === 'POST' ? { body: JSON.stringify(payload) } : {})
  });
  if (!response.ok) throw new Error(`Murmur ${operation} returned HTTP ${response.status}`);
  const result = await response.json();
  if (operation === 'update' && (!result?.state || !result?.applied || typeof result.mood !== 'string')) throw new Error('Murmur did not acknowledge the emotion update');
  return result;
}
