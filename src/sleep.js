export function shouldTriggerNightmare({ cycle, alreadyTriggered, roll, probability }) {
  return !alreadyTriggered && cycle >= 1 && roll < probability;
}

export function resolveNightmareDecision(output, reentryRoll, reentryProbability) {
  const decision = String(output || "").match(/AI_DECISION\s*[:：]\s*(send_message|continue_sleep|sentinel)\b/i)?.[1]?.toLowerCase() || "sentinel";
  const message = String(output || "").match(/<message\b[^>]*>([\s\S]*?)<\/message>/i)?.[1]?.trim()
    || String(output || "").match(/(?:^|\n)MESSAGE\s*[:：]\s*([\s\S]*?)(?=\n(?:AI_DECISION|OUTCOME|SCENARIO|ADVERSARIAL_TWIST|AGENT_DREAM_RESPONSE|MISSING_SKILL|RECOVERY_PATH)\s*[:：]|$)/i)?.[1]?.trim()
    || "";
  if (decision === "continue_sleep") {
    const reenteredSleep = reentryRoll < reentryProbability;
    return { decision, reenteredSleep, message: "" };
  }
  return { decision, reenteredSleep: false, message: decision === "send_message" ? message : "" };
}
