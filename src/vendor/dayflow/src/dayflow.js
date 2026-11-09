import { capsuleSourceText, decayImages, isRecallMessage } from './media.js';
import { composeCapsule, parseSnapshot, pruneEntries } from './lifecycle.js';
import { SNAPSHOT_INSTRUCTION } from './prompts.js';
import { resolvePolicy } from './profiles.js';
import { MemoryStateStore } from './stores/memory.js';
import { conversationStartedAt, shouldStartFresh } from './day-boundary.js';
import { autoTune } from './calibrate.js';
import { applyEphemeralSlots } from './slots.js';

const DEFAULT_CAPSULE_LIMIT = 1_800;
const MIN_RELEASE_TOKENS = 2_000;

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  let ascii = 0;
  for (const character of text) if (character.codePointAt(0) <= 0x7f) ascii++;
  return Math.ceil(ascii / 4 + (text.length - ascii) * 0.8);
}

function messageTokens(message, estimator) {
  return estimator(message?.content) + 4;
}

function anchorOf(message) {
  const text = capsuleSourceText(message);
  return `${message?.role || ''}:${text.slice(0, 96)}`;
}

function cutForTail(messages, retainTokens, estimator) {
  let retained = 0;
  let cut = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    retained += messageTokens(messages[index], estimator);
    if (retained >= retainTokens) { cut = index; break; }
  }
  while (cut < messages.length && messages[cut]?.role !== 'user') cut++;
  return cut;
}

function serialize(messages) {
  return messages
    .filter(message => !isRecallMessage(message))
    .map(message => {
      const text = capsuleSourceText(message).slice(0, 6_000);
      return text ? `[${message.role}]${message.createdAt ? ` [${message.createdAt}]` : ''}: ${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function projection(capsule, tail) {
  if (!capsule) return tail;
  return [
    { role: 'user', content: `<context source="dayflow_state">\n${capsule}\n</context>`, metadata: { dayflow: { capsule: true } } },
    { role: 'assistant', content: 'State received. Continue from the live conversation.', metadata: { dayflow: { capsuleAck: true } } },
    ...tail
  ];
}

function clampTail(policy, measuredInputTokens, tailTokens, overheadTokens) {
  const available = policy.budget.landingTokens - Math.max(0, overheadTokens);
  return Math.min(
    policy.budget.maximumTailTokens,
    Math.max(policy.budget.minimumTailTokens, available > 0 ? available : tailTokens)
  );
}

export class Dayflow {
  static async autoTune({ tuning, ...options } = {}) {
    const report = await autoTune(tuning);
    const flow = new Dayflow({ ...options, profile: 'custom', customProfile: report.profile });
    flow.tuningReport = report;
    return flow;
  }

  constructor({
    mode = 'daily',
    profile = 'focused',
    customProfile,
    summarize,
    store = new MemoryStateStore(),
    tokenEstimator = estimateTokens,
    decayMedia = true,
    capsuleMaxChars = DEFAULT_CAPSULE_LIMIT,
    timeZone = 'Asia/Shanghai',
    freshConversationAfterMs = 86_400_000,
    temporalGuard, ephemeralSlots = [],
    now = () => Date.now()
  } = {}) {
    this.policy = resolvePolicy({ mode, profile, customProfile });
    this.summarize = summarize;
    this.store = store;
    this.tokenEstimator = tokenEstimator;
    this.decayMedia = decayMedia;
    this.capsuleMaxChars = capsuleMaxChars;
    this.timeZone = timeZone;
    this.freshConversationAfterMs = freshConversationAfterMs;
    this.temporalGuard = temporalGuard;
    this.ephemeralSlots = ephemeralSlots;
    this.now = now;
  }

  async status(conversationId) {
    const state = await this.store.load(conversationId);
    return {
      mode: this.policy.mode,
      profile: this.policy.profile,
      enabled: this.policy.enabled,
      budget: this.policy.budget,
      epoch: state?.epoch || 1,
      rotations: state?.rotations || 0,
      coveredMessages: state?.covered || 0,
      lastInputTokens: state?.lastInputTokens || 0,
      projectedInputTokens: state?.projectedInputTokens || 0,
      capsuleUpdatedAt: state?.capsuleUpdatedAt,
      conversationStartedAt: state?.conversationStartedAt,
      recommendFreshConversation: shouldStartFresh({
        startedAt: state?.conversationStartedAt,
        now: this.now(),
        timeZone: this.timeZone,
        maxAgeMs: this.freshConversationAfterMs
      })
    };
  }

  async project({
    conversationId,
    messages,
    evidenceNotes = [],
    measuredInputTokens = 0,
    overheadTokens = 0,
    force = false
  }) {
    if (!conversationId) throw new TypeError('conversationId is required');
    if (!Array.isArray(messages)) throw new TypeError('messages must be an array');
    const allMessages = this.policy.enabled && this.decayMedia ? decayImages(messages) : messages;
    if (!this.policy.enabled) {
      return {
        messages: allMessages,
        rotated: false,
        bypassed: true,
        reason: this.policy.reason,
        status: await this.status(conversationId)
      };
    }

    const now = this.now();
    let state = await this.store.load(conversationId);
    const firstAnchor = allMessages.length ? anchorOf(allMessages[0]) : '';
    if (state && (state.covered > allMessages.length || (state.anchor && state.anchor !== firstAnchor))) state = null;
    state ||= {
      version: 1,
      epoch: 1,
      rotations: 0,
      covered: 0,
      anchor: firstAnchor,
      conversationStartedAt: conversationStartedAt(allMessages, now),
      epochStartedAt: now,
      entries: [],
      bridge: ''
    };
    state.entries = pruneEntries(state.entries, now);
    state.capsule = state.entries.length || state.bridge
      ? composeCapsule(state.entries, state.bridge, now)
      : '';

    let working = allMessages.slice(state.covered);
    const workingTokens = working.reduce((sum, message) => sum + messageTokens(message, this.tokenEstimator), 0);
    const observedTokens = Math.max(measuredInputTokens, workingTokens + overheadTokens);
    const shouldRotate = force || observedTokens >= this.policy.budget.activateTokens;
    let rotated = false;
    let rebuilt = false;

    if (shouldRotate && working.length > 4) {
      if (typeof this.summarize !== 'function') {
        throw new TypeError('A summarize callback is required when Dayflow reaches a rotation boundary');
      }
      const retainTokens = clampTail(this.policy, measuredInputTokens, workingTokens, overheadTokens);
      const cutRelative = cutForTail(working, retainTokens, this.tokenEstimator);
      if (cutRelative > 0 && cutRelative < working.length) {
        const released = working.slice(0, cutRelative)
          .reduce((sum, message) => sum + messageTokens(message, this.tokenEstimator), 0);
        if (force || released >= MIN_RELEASE_TOKENS) {
          const dueForRebuild = state.rotations >= this.policy.rebuildAfterRotations
            || now - state.epochStartedAt >= this.policy.rebuildAfterMs;
          const leavingMessages = dueForRebuild
            ? allMessages.slice(0, state.covered + cutRelative)
            : working.slice(0, cutRelative);
          const rawSnapshot = await this.summarize({
            instruction: SNAPSHOT_INSTRUCTION,
            prior: dueForRebuild ? [] : state.entries,
            priorBridge: dueForRebuild ? '' : state.bridge,
            messages: leavingMessages,
            transcript: serialize(leavingMessages),
            rebuild: dueForRebuild,
            now: new Date(now).toISOString()
          });
          const snapshot = parseSnapshot(rawSnapshot, now);
          if (snapshot) {
            state.entries = snapshot.entries;
            state.bridge = snapshot.bridge;
            state.capsule = snapshot.capsule.slice(0, this.capsuleMaxChars);
            state.covered += cutRelative;
            state.anchor = anchorOf(allMessages[0]);
            state.capsuleUpdatedAt = now;
            state.projectedInputTokens = this.policy.budget.landingTokens;
            rotated = true;
            if (dueForRebuild) {
              state.epoch += 1;
              state.rotations = 0;
              state.epochStartedAt = now;
              rebuilt = true;
            } else {
              state.rotations += 1;
            }
            working = allMessages.slice(state.covered);
          }
        }
      }
    }

    state.lastInputTokens = measuredInputTokens;
    state.activationTokens = this.policy.budget.activateTokens;
    state.updatedAt = now;
    await this.store.save(conversationId, state);
    const status = await this.status(conversationId);
    let projectedMessages = projection(state.capsule, working);
    let temporalFacts = [];
    if (this.temporalGuard) {
      if (typeof this.temporalGuard.apply !== 'function') throw new TypeError('temporalGuard must implement apply()');
      const guarded = await this.temporalGuard.apply(projectedMessages, { sourceMessages: allMessages, now });
      projectedMessages = guarded.messages;
      temporalFacts = guarded.facts;
    }
    const slotted = await applyEphemeralSlots(projectedMessages, { sourceMessages: allMessages, evidenceNotes, slots: this.ephemeralSlots, now, timeZone: this.timeZone });
    projectedMessages = slotted.messages;
    return {
      messages: projectedMessages,
      rotated,
      rebuilt,
      bypassed: false,
      temporalFacts,
      ephemeralSlots: slotted.slots,
      status
    };
  }
}
