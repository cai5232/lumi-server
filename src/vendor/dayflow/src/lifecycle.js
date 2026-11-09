import { hasFloatingTime, isPast, normalizeTimestamp } from './time.js';

export const ENTRY_TYPES = Object.freeze(['relation', 'active_task', 'open_loop', 'landmark']);
export const TEMPORAL_TYPES = Object.freeze(['current', 'dated', 'since', 'evergreen', 'until_resolved']);
export const ENTRY_STATUSES = Object.freeze(['stable', 'active', 'unresolved', 'completion_unknown']);
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'superseded']);

export function normalizeEntry(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  if (TERMINAL_STATUSES.has(raw.status)) return null;
  const fact = String(raw.fact || '').trim().slice(0, 400);
  if (!fact || hasFloatingTime(fact)) return null;
  if (!ENTRY_TYPES.includes(raw.type)) return null;
  if (!TEMPORAL_TYPES.includes(raw.temporal)) return null;
  if (!ENTRY_STATUSES.includes(raw.status)) return null;

  let sourceAt;
  let eventAt;
  let expiresAt;
  try {
    sourceAt = normalizeTimestamp(raw.sourceAt);
    eventAt = normalizeTimestamp(raw.eventAt);
    expiresAt = normalizeTimestamp(raw.expiresAt);
  } catch {
    return null;
  }

  if (expiresAt && isPast(expiresAt, now)) return null;
  let status = raw.status;
  if (status === 'active' && eventAt && isPast(eventAt, now)) status = 'completion_unknown';

  return {
    type: raw.type,
    fact,
    temporal: raw.temporal,
    status,
    ...(sourceAt ? { sourceAt } : {}),
    ...(eventAt ? { eventAt } : {}),
    ...(expiresAt ? { expiresAt } : {})
  };
}

export function pruneEntries(entries, now = Date.now()) {
  const deduped = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = normalizeEntry(raw, now);
    if (!entry) continue;
    deduped.set(`${entry.type}:${entry.fact.toLocaleLowerCase()}`, entry);
  }
  return [...deduped.values()].slice(0, 13);
}

export function composeCapsule(entries, bridge = '', now = Date.now()) {
  const current = pruneEntries(entries, now);
  const headings = {
    relation: 'Relation',
    active_task: 'Active',
    open_loop: 'Open',
    landmark: 'Landmarks'
  };
  const sections = [`State @ ${new Date(now).toISOString()}; source=when said, event=when it happens, expiry=forget boundary.`];
  for (const type of ENTRY_TYPES) {
    const lines = current.filter(entry => entry.type === type).map(entry => {
      const clocks = [
        entry.sourceAt && `source:${entry.sourceAt}`,
        entry.eventAt && `event:${entry.eventAt}`,
        entry.expiresAt && `expiry:${entry.expiresAt}`,
        `status:${entry.status}`
      ].filter(Boolean).join(' · ');
      return `- ${entry.fact}${clocks ? ` (${clocks})` : ''}`;
    });
    if (lines.length) sections.push(`${headings[type]}\n${lines.join('\n')}`);
  }
  const cleanBridge = hasFloatingTime(bridge) ? '' : String(bridge || '').trim().slice(0, 640);
  if (cleanBridge) sections.push(`Recent bridge\n${cleanBridge}`);
  return sections.join('\n\n');
}

export function parseSnapshot(value, now = Date.now()) {
  let parsed = value;
  if (typeof value === 'string') {
    const clean = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { parsed = JSON.parse(clean); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return null;
  const entries = pruneEntries(parsed.entries, now);
  const bridge = hasFloatingTime(parsed.bridge) ? '' : String(parsed.bridge || '').trim().slice(0, 640);
  return { entries, bridge, capsule: entries.length || bridge ? composeCapsule(entries, bridge, now) : '' };
}
