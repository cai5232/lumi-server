// DND applies to unsolicited contact, not replies or explicit promise alarms.
export function proactivePolicy(thread, settings) {
  return settings.threadId === thread?.id ? settings : (thread?.proactive || {});
}
export function autonomousContactAllowed(thread, settings, action = 'message', { requireEnabled = true } = {}) {
  const policy = proactivePolicy(thread, settings);
  if (policy.dnd === true || (requireEnabled && policy.enabled !== true)) return false;
  const actions = policy.actions || { message: true, phone: true, screen: false };
  return actions[action] === true;
}
export function hasAutonomousAction(thread, settings) {
  return ['message', 'phone', 'screen'].some(action => autonomousContactAllowed(thread, settings, action));
}

// Called inside the same disk-write queue used by foreground saves. A model
// response may commit only against the exact snapshot it started from.
export function mergeBackgroundSnapshots(current, original, updated, isBusy = () => false) {
  const committed = new Set();
  for (const [id, thread] of Object.entries(updated)) {
    if (JSON.stringify(thread) === JSON.stringify(original[id])) continue;
    if (isBusy(id) || JSON.stringify(current[id]) !== JSON.stringify(original[id])) continue;
    current[id] = thread;
    committed.add(id);
  }
  return committed;
}
