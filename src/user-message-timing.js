const nonMessageTypes = new Set(["call_status", "widget_submission"]);

function manualMessageTime(message) {
  if (message?.role !== "user" || nonMessageTypes.has(message.contentType)) return NaN;
  return Date.parse(message.createdAt);
}

function elapsedText(seconds) {
  const parts = [
    [86_400, "天"], [3600, "小时"], [60, "分钟"], [1, "秒"]
  ].flatMap(([size, unit]) => {
    const count = Math.floor(seconds / size);
    seconds %= size;
    return count ? [`${count} ${unit}`] : [];
  });
  return parts.join(" ") || "不足 1 秒";
}

export function userMessageTimingContext(messages, { incoming, now = Date.now() } = {}) {
  const incomingAt = manualMessageTime(incoming);
  const hasIncoming = Number.isFinite(incomingAt) && incomingAt <= now;
  const cutoff = hasIncoming ? incomingAt : now;
  let previousAt = NaN;
  for (const message of messages) {
    if (hasIncoming && (message === incoming || (incoming.id && message?.id === incoming.id))) continue;
    const at = manualMessageTime(message);
    if (at <= cutoff && (!Number.isFinite(previousAt) || at > previousAt)) previousAt = at;
  }

  const latestAt = hasIncoming ? incomingAt : previousAt;
  const observed = new Date(now).toISOString();
  const guidance = "以本轮实际消息时间为准。这个间隔只代表发消息的时间，请结合对话自然使用，不要复述内部标签。";
  if (!Number.isFinite(latestAt)) {
    return `<user_message_timing observed_at="${observed}" status="unknown">当前会话还没有可用的用户主动消息时间。${guidance}</user_message_timing>`;
  }

  const elapsed = Math.floor((now - latestAt) / 1000);
  const last = new Date(latestAt).toISOString();
  const latest = `截至本轮，距离用户最近一次主动发消息过去了 ${elapsedText(elapsed)}。`;
  if (!hasIncoming) {
    return `<user_message_timing observed_at="${observed}" last_sent_at="${last}" elapsed_seconds="${elapsed}">${latest}${guidance}</user_message_timing>`;
  }

  const gap = Math.floor((incomingAt - previousAt) / 1000);
  const previous = Number.isFinite(gap)
    ? `本轮刚收到她主动发来的新消息。她这条消息与再上一条主动消息相隔 ${elapsedText(gap)}。`
    : "本轮刚收到她主动发来的新消息，当前会话没有可用的更早主动消息时间。";
  const gapAttrs = Number.isFinite(gap)
    ? ` previous_sent_at="${new Date(previousAt).toISOString()}" previous_gap_seconds="${gap}"`
    : "";
  return `<user_message_timing observed_at="${observed}" last_sent_at="${last}" elapsed_seconds="${elapsed}" new_message="true"${gapAttrs}>${latest}${previous}${guidance}</user_message_timing>`;
}
