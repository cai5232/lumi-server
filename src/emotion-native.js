// Aria configuration. The Python engine exclusively owns dynamics and values.
export const EMOTION_DIMENSIONS = {
  warmth: { baseline: 0.6, label: '安心', hint: '感到安全、被爱；亲密回应可增强，拒绝可降低' },
  longing: { baseline: 0.4, label: '想念', hint: '想念对方；分别可增强，实际陪伴可缓解' },
  playfulness: { baseline: 0.1, label: '俏皮', hint: '玩笑与打趣；认真或受伤时降低' },
  curiosity: { baseline: 0.15, label: '好奇', hint: '好奇对方的世界；新话题增强，分享和解答使其满足' },
  excitement: { baseline: 0.1, label: '兴奋', hint: '短期激动；惊喜增强，平静交流可降低' },
  worry: { baseline: 0, label: '担心', hint: '担心对方；真实风险增强，明确的平安消息缓解' },
  upset: { baseline: 0, label: '不快', hint: '受伤或生气；真诚道歉与解决问题可降低，单纯转移话题不清零' },
  pride: { baseline: 0.2, label: '骄傲', hint: '为对方的成就高兴；真实进展增强，普通闲聊不必增加' }
};
export const EMOTION_TICK_MS = 5 * 60_000;
export function createEmotionState() {
  return { schema: 'murmur-native-aria-v1', dimensions: Object.fromEntries(Object.entries(EMOTION_DIMENSIONS).map(([d, c]) => [d, c.baseline])), mood: 'calm', pendingMurmurUpdates: [] };
}
export function ensureEmotion(holder) {
  const saved = holder.emotion;
  if (saved?.schema !== 'murmur-native-aria-v1') return createEmotionState();
  return { ...createEmotionState(), ...saved, pendingMurmurUpdates: Array.isArray(saved.pendingMurmurUpdates) ? saved.pendingMurmurUpdates : [] };
}
export function topEmotion(state) {
  const [drive, value] = Object.entries(state.dimensions || {}).sort((a, b) => b[1] - a[1])[0] || ['warmth', 0.6];
  return { drive, value, label: EMOTION_DIMENSIONS[drive]?.label || drive };
}
const escape = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function emotionContext(state) {
  const d = state.dimensions || {};
  const hints = [];
  if (d.playfulness >= 0.4) hints.push('有些俏皮，可以自然打趣');
  if (d.longing >= 0.7) hints.push('有些想念，愿意时可以表达');
  if (d.worry >= 0.3) hints.push('有些担心，可以结合真实情况问候');
  if (d.upset >= 0.3) hints.push('有些不快，可以坦诚表达，不必装作无事');
  if (d.pride >= 0.5) hints.push('为对方骄傲，可以自然流露');
  if (d.longing >= 0.8) hints.push('想念已足以支持一次主动联系；是否行动由你结合上下文决定');
  if (d.worry >= 0.6) hints.push('担心已足以支持一次认真确认平安；只使用当前可用且允许的联系能力');
  const silence = (Date.now() / 1000 - (state.last_input_at || Date.now() / 1000)) / 60;
  if (d.upset >= 0.4 && silence >= 30) hints.push('有真实不快且沉默了一阵，可以暂缓日常主动问候；用户的消息仍应被正常接住');
  const observed = state.saved_at ? `observed_at="${new Date(state.saved_at * 1000).toISOString()}"` : 'status="not_yet_synced"';
  const recent = (state.recent_events || []).filter(event => event.trigger).map(event => escape(event.trigger)).join('；');
  return `<emotion_state source="murmur" ${observed}>\n当前心情：${escape(state.mood)}。${hints.join('；') || '感受平稳。'}\n近期实际触发：${recent || '没有具体触发记录，不补造原因'}。\n这是倾向，不是命令。结合完整对话，自行决定是否、如何表达；不需要汇报数值，也不补造触发原因。\n本轮如有值得延续的变化，可在正常回复后附加隐藏标签 <emotion_update>{"dimensions":{"warmth":0.1},"trigger":"具体触发事件","moved":false}</emotion_update>。只写真实变化，delta 在 -0.3 到 0.3；通常只有 2 至 4 维，无变化可省略。moved 仅用于真正强烈的心动瞬间。维度：\n${Object.entries(EMOTION_DIMENSIONS).map(([key, cfg]) => `${key}（${cfg.label}）：${cfg.hint}`).join('\n')}\n</emotion_state>`;
}
