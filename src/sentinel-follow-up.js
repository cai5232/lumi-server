export const MAX_FOLLOW_UP_MINUTES = 24 * 60;

export function normalizeFollowUpDecision(decision, allowedActions) {
  const minutes = Number(decision?.followUpMinutes);
  const requestedAction = decision?.followUpAction;
  const action = requestedAction === "call" ? "phone" : requestedAction;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_FOLLOW_UP_MINUTES) return null;
  if (!["message", "phone"].includes(action) || !allowedActions.includes(action)) return null;
  return { minutes, action };
}
