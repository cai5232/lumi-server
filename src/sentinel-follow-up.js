export const DEFAULT_WAKE_MINUTES = 50;

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
