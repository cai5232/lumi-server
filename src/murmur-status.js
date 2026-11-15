import { randomUUID } from "node:crypto";
import { EMOTION_DIMENSIONS } from "./emotion-native.js";

export const nativeStatusOperations = new Set(["state", "history", "vitals", "moved", "baselines"]);

const legacyDimensions = {
  attachment: "longing",
  tenderness: "warmth",
  mischief: "playfulness",
  anger: "upset"
};

export function nativeUpdate(parsed) {
  const supplied = parsed.dimensions ?? parsed.changes ?? { [parsed.drive]: parsed.delta };
  const dimensions = {};
  for (const [key, value] of Object.entries(supplied)) {
    const dimension = Object.hasOwn(EMOTION_DIMENSIONS, key)
      ? key
      : Object.hasOwn(legacyDimensions, key) ? legacyDimensions[key] : undefined;
    if (dimension && typeof value === "number" && Number.isFinite(value) && value !== 0) {
      dimensions[dimension] = Math.max(-0.3, Math.min(0.3, value));
    }
  }
  const trigger = parsed.trigger ?? parsed.reason;
  if (!Object.keys(dimensions).length && parsed.moved !== true) return null;
  return {
    event_id: randomUUID(), source: "internal", dimensions,
    trigger: typeof trigger === "string" ? trigger.slice(0, 240) : "",
    moved: parsed.moved === true
  };
}

export function createNativeMurmurClient({ baseURL, token, fetchImpl = fetch }) {
  const base = String(baseURL || "").replace(/\/+$/, "");
  let protocol;
  let checkedAt = 0;
  let discovery;

  async function request(operation, { query = "", payload } = {}) {
    const writing = payload !== undefined;
    const response = await fetchImpl(`${base}/emotion/${operation}${query}`, {
      method: writing ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token || ""}`,
        ...(writing ? { "content-type": "application/json" } : {})
      },
      ...(writing ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(5_000),
      redirect: "error"
    });
    if (!response.ok) {
      const error = new Error(`Murmur ${operation} returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    if (operation === "state" && (!data?.dimensions || typeof data.mood !== "string")) {
      throw new Error("Murmur returned an invalid native state");
    }
    if (operation === "update" && (!data?.state || !data.applied || typeof data.mood !== "string")) {
      throw new Error("Murmur did not acknowledge the native emotion update");
    }
    return data;
  }

  async function detect() {
    if (!base) return false;
    if (protocol === true || (protocol === false && Date.now() - checkedAt < 60_000)) return protocol;
    if (!discovery) {
      discovery = request("state").then(() => {
        protocol = true;
        return true;
      }, error => {
        if (error.status !== 404 && error.status !== 405) throw error;
        protocol = false;
        checkedAt = Date.now();
        return false;
      }).finally(() => { discovery = undefined; });
    }
    return discovery;
  }

  return {
    detect,
    get available() { return protocol === true; },
    async read(operation, searchParams = new URLSearchParams()) {
      if (!nativeStatusOperations.has(operation)) throw new Error("Unsupported native Murmur read");
      let query = "";
      if (operation === "history" || operation === "moved") {
        const n = Number(searchParams.get("n") || 50);
        query = `?n=${Math.max(1, Math.min(200, Number.isFinite(n) ? Math.floor(n) : 50))}`;
      }
      return request(operation, { query });
    },
    async update(payload) { return request("update", { payload }); }
  };
}
