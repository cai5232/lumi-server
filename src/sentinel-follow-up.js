export const DEFAULT_WAKE_MINUTES = 18;
export const SILENT_WAKE_TOKEN = "[[LUMI_SILENT_WAKE]]";

// This is an application cadence, not a model-written appointment. Explicit
// reminders still use their own scheduler.
export function wakeOutcome(generated, allowedActions) {
  const decision = generated.sentinelDecision || {};
  const raw = generated.content || "";
  const silent = generated.silentWake === true || raw.includes(SILENT_WAKE_TOKEN) || decision.action === "none" || allowedActions.every(action => action === "none");
  return {
    action: silent ? "none" : allowedActions.includes(decision.action) ? decision.action : "message",
    nextWakeMinutes: DEFAULT_WAKE_MINUTES,
    followUp: null,
    silent
  };
}

export function wakeSessionScope({ callMode, desktopCompanion, proactive, runtime }) {
  return callMode ? "call" : desktopCompanion ? "desktop" : proactive && runtime !== "kimi-harness" ? "wake" : "chat";
}

export function wakeIntervalMinutes(value, fallback = DEFAULT_WAKE_MINUTES) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 1 ? Math.round(minutes) : fallback;
}

export function normalizeFollowUpDecision(decision, allowedActions) {
  const minutes = Number(decision?.followUpMinutes);
  const requestedAction = decision?.followUpAction;
  const action = requestedAction === "call" ? "phone" : requestedAction;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) return null;
  if (!["message", "phone"].includes(action) || !allowedActions.includes(action)) return null;
  return { minutes: wakeIntervalMinutes(minutes), action };
}
