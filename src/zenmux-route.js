export function configuredZenMuxRoute(env, savedKey) {
  const managedInApp = savedKey !== undefined;
  if (!managedInApp && env.LUMI_ZENMUX_ONLY !== "true") return null;

  const key = savedKey ?? String(env.LUMI_MODEL_API_KEY || "").trim();
  const model = String(env.LUMI_ZENMUX_MODEL || (!managedInApp && env.LUMI_MODEL_NAME) || "moonshotai/kimi-k3").trim();
  const supplier = String(env.LUMI_ZENMUX_PROVIDER || "moonshotai").trim();
  if (!String(env.LUMI_PUSH_API_TOKEN || "").trim()) {
    throw new Error("ZenMux-only settings require LUMI_PUSH_API_TOKEN");
  }
  if (!/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(model)) {
    throw new Error("LUMI_ZENMUX_MODEL or LUMI_MODEL_NAME must be a ZenMux model ID without a supplier suffix");
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(supplier)) {
    throw new Error("LUMI_ZENMUX_PROVIDER must be one ZenMux provider slug");
  }

  return {
    provider: "custom",
    model: `${model}:${supplier}`,
    customProvider: { url: "https://zenmux.ai/api/v1", key, apiFormat: "openai", chatPath: "/chat/completions" }
  };
}
