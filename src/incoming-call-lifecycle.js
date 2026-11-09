import { randomUUID } from 'node:crypto';
export const INCOMING_CALL_TIMEOUT_MS = 45_000;
export const MISSED_CALL_INPUT = '暂时无人接听';
export function newIncomingCall(reason, now = Date.now()) {
  return { id: randomUUID(), initiator: 'assistant', state: 'pending', reason: String(reason || '想听听你的声音').slice(0, 120), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + INCOMING_CALL_TIMEOUT_MS).toISOString(), turns: [] };
}
// Called inside the durable thread mutation queue; answering and expiry compete
// for the same pending state, so only one can win.
export function expireIncomingCall(thread, callID, now = Date.now()) {
  const call = thread?.calls?.find(item => item.id === callID && item.initiator === 'assistant');
  if (!call || call.state !== 'pending' || now < Date.parse(call.expiresAt)) return false;
  call.state = 'ended';
  call.endedAt = new Date(now).toISOString();
  call.endReason = 'unanswered';
  call.missedFollowUp = { state: 'pending', requestedAt: call.endedAt };
  thread.messages.push({ id: randomUUID(), role: 'assistant', content: '暂时无人接听，通话已挂断', contentType: 'call_status', callID: call.id, callInitiator: 'assistant', callStatus: 'missed', createdAt: call.endedAt });
  return true;
}
export function claimMissedCallFollowUp(call, now = Date.now()) {
  if (call?.endReason !== 'unanswered' || call.missedFollowUp?.state !== 'pending') return false;
  call.missedFollowUp.state = 'generating';
  call.missedFollowUp.startedAt = new Date(now).toISOString();
  return true;
}
