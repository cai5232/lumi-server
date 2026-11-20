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
  const observed = state.saved_at ? `observed_at="${new Date(state.saved_at * 1000).toISOString()}"` : 'status="not_yet_synced"';
  return `<emotion_state source="murmur" ${observed}>
当前心情：${escape(state.mood)}。看本轮末尾的情绪信号决定是否以及怎样表达。若无具体原因，继续结合实际对话。
本轮回复或自主活动若产生了新的感受，可附加隐藏标签 <emotion_update>{"dimensions":{"warmth":0.08},"trigger":"具体触发事件","moved":false}</emotion_update>。刚收到的消息已经过感知，不重复记录同一反应。仅写这轮新发生的变化；无变化省略。moved 仅用于确实很强烈的心动瞬间。可用维度：
${Object.entries(EMOTION_DIMENSIONS).map(([key, cfg]) => `${key}（${cfg.label}）：${cfg.hint}`).join('\n')}
</emotion_state>`;
}
