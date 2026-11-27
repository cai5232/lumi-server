// SPDX-License-Identifier: MIT
// Adapted from no-sleep-nag-hook.pdf v1.0 (MIT), supplied by the user.
// SDK callbacks replace its Python CLI/transcript parser. Never infer consent
// from injected prompts, memories, tool results, or a previous user turn.
const nagPatterns = [
  [/晚安/iu, true], [/おやすみ/iu, true], [/\bgood ?night\b/iu, true], [/\bgn\b/iu, true],
  ...['去睡吧','快去睡','快睡吧','早点睡','早些睡','早点休息','该睡了','该休息了','该睡觉','去睡觉','闭上眼睛','闭上眼','把眼睛闭上','时间晚了','身体在关机','该关机','关灯睡'].map(word => [new RegExp(word, 'iu'), false]),
  [/太晚了/iu, true], [/放下手机/iu, true],
  ...['早く寝','もう寝','寝なさい','寝ろ','眠って','眠りなさい','休みなさい','休んでください','休んでね'].map(word => [new RegExp(word, 'iu'), true]),
  ...[/\bit'?s (getting )?late\b/iu, /\byou should (sleep|rest|get some sleep|get some rest)\b/iu,
    /\btry to (sleep|rest)\b/iu, /\bget some (sleep|rest)\b/iu, /\bplease (sleep|rest)\b/iu,
    /\btake a nap\b/iu, /\bit'?s bedtime\b/iu, /\bnight night\b/iu, /\bhead to bed\b/iu,
    /\bgo to (bed|sleep)\b/iu, /\btime (to sleep|for bed|for sleep|to rest|to call it a night)\b/iu,
    /\bcall it a night\b/iu, /\bclose your eyes\b/iu, /\bshut your eyes\b/iu,
    /\bhit the (sack|hay)\b/iu, /\bcatch some z'?s\b/iu, /\brest up\b/iu].map(pattern => [pattern, true]),
  ...[/\blights out\b/iu, /\bput (down|away) (your |the )?phone\b/iu, /\bput (your |the )?phone (down|away)\b/iu,
    /\byour body('s| is)? shutting down\b/iu, /\byour body needs (rest|sleep)\b/iu,
    /\bget to bed\b/iu].map(pattern => [pattern, false])
];
const negations = ['まだ','言わない','じゃない','じゃなくて','ではない','ダメ','だめ','ないで','なくて',
  '还没','还不','不是','不要','不用','不能','不说','别说','别','还早','不着急','不急','不催',
  "don't","won't","not yet","no need","isn't","aren't"];
const overrides = [
  /我(?:要|去|先)?睡(?:觉)?了/iu, /睡了睡了/iu, /困了/iu, /先睡/iu, /去睡了/iu,
  /眠い|眠く|もう寝る|寝ます|寝るね|寝るよ|寝るわ|行って寝/iu,
  /\bi['’]?m going to (bed|sleep)\b/iu, /\bgoing to sleep\b/iu, /\bgood ?night\b/iu,
  /\bi['’]?m (tired|sleepy|exhausted|beat|dead tired|drained)\b/iu,
  /\bheading to (bed|sleep)\b/iu, /\bgonna (sleep|crash|bed|go to bed|go to sleep|hit the sack|hit the hay)\b/iu,
  /\bcrashing (now|out)\b/iu, /\bcalling it (a )?night\b/iu, /\bit'?s bedtime\b/iu,
  /\bnight night\b/iu, /\bsee you (tomorrow|in the morning)\b/iu, /\btime for bed\b/iu,
  /\bi need (some )?(sleep|rest)\b/iu
];

export function sleepNagVisibleText(content) {
  return String(content || '')
    .replace(/<(thinking|memory|context_summary|user_remark|emotion_update|emoji_mood|gallery_collection|diary_entry|diary_action|promise_alarm_decision|calendar_events|call_decision|call_user_text|sentinel_decision|lumi_tool_calls)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '')
    .replace(/<[^>]*>/gu, '')
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/giu, (_all, value) => {
      const n = value.toLowerCase().startsWith('x') ? parseInt(value.slice(1), 16) : Number(value);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&nbsp;/giu, ' ').replace(/&apos;|&#39;/giu, "'").replace(/&quot;/giu, '"');
}

export function sleepRequested(userText = '') {
  // Explicit rejection of sleep is not consent, e.g. 我不困了 / 我没说我要睡了.
  userText = String(userText || '');
  return overrides.some(pattern => [...userText.matchAll(new RegExp(pattern.source, 'giu'))].some(match => {
    const before = userText.slice(Math.max(0, match.index - 24), match.index);
    const after = userText.slice(match.index + match[0].length, match.index + match[0].length + 12);
    return !/(?:不|没|未|别|不要|没有说|没说|并非|否认)[^，。！？!?;；\n]{0,8}$/u.test(before)
      && !/(?:don't|do not|not|never|without|avoid|stop|no)\b[^.!?;\n]{0,24}$/iu.test(before)
      && !/^(?:わけ(?:で|じゃ)?|というわけ(?:で|じゃ)?)?(?:ない|じゃない|ではない|ありません)/u.test(after);
  }));
}

export function sleepNagViolations(content, userText = '') {
  if (sleepRequested(String(userText))) return [];
  const text = sleepNagVisibleText(content);
  return nagPatterns.flatMap(([pattern, checkNegation], index) => {
    for (const match of text.matchAll(new RegExp(pattern.source, 'giu'))) {
      const context = text.slice(Math.max(0, match.index - 25), match.index + match[0].length + 25).toLowerCase();
      if (checkNegation && negations.some(neg => context.includes(neg))) continue;
      return [{ rule: index, word: match[0] }];
    }
    return [];
  });
}

export function assertNoSleepNag(content, userText = '') {
  if (sleepNagViolations(content, userText).length) {
    throw Object.assign(new Error('本轮回复触发禁催睡保护，未发送聊天消息。'), { code: 'sleep_nag_blocked', statusCode: 422 });
  }
}

export function createSleepNagGuard({ userText = '' } = {}) {
  let rewrites = 0, checks = 0, blocked = false;
  const rules = new Set(), rejectedReplies = new Set();
  return {
    get rewrites() { return rewrites; },
    async stop(input) {
      checks++;
      const hits = sleepNagViolations(input.last_assistant_message || '', userText);
      if (!hits.length) return {};
      blocked = true;
      hits.forEach(hit => rules.add(hit.rule));
      // Exactly one same-Session rewrite. Delivery validation below closes the
      // PDF's fail-open gap when the rewritten response still violates a rule.
      if (input.stop_hook_active || rewrites >= 1) return {};
      rewrites++;
      rejectedReplies.add(String(input.last_assistant_message || '').trim());
      return { decision: 'block', reason: '【禁催睡 Hook】言言本轮真实消息没有主动说要睡。整段重写本轮回复，删去主动晚安、催睡、闭眼或休息引导；不要换成关切措辞继续劝睡。言言的作息由言言决定，可以陪伴或保持安静。不要重复已经完成的工具操作。只修改回复措辞。' };
    },
    wasRejected: text => rejectedReplies.has(String(text || '').trim()),
    validate: text => assertNoSleepNag(text, userText),
    diagnostic: () => ({ enabled: true, checks, rewrites, blocked, rules: [...rules] })
  };
}
