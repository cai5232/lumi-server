# Dayflow · 日序

**A cache-aware attention and forgetting layer for high-frequency everyday AI chat.**

**面向高频 AI 日常陪伴聊天的缓存感知型注意力与遗忘层。**

> Your model has 1M context. Dayflow lets it use 26K clearly.

Dayflow keeps the complete conversation in your archive while projecting a small, high-signal working set to the model: one replaceable temporal state capsule plus a bounded verbatim tail.

It does not pretend compaction is lossless. It is designed to keep one busy day of short, stateful conversation coherent—and to recommend a fresh conversation before repeated compression turns prose into a photocopy of a photocopy.

## Why

Large context capacity is not the same thing as reliable attention. In everyday companion chat, old meals, delivered packages, expired “tomorrow” plans, and previously attached image bytes keep paying rent in every request even after they stop helping.

Dayflow applies a deliberately opinionated lifecycle:

```text
recent verbatim turns   → keep precisely
live events today       → keep as structured state
completed errands       → retire
old images              → keep a delivery receipt, not pixels
stable long-term memory → leave to an external memory system
recalled evidence       → use for one request, do not re-ingest
raw history             → retain as the final source of truth
```

## Presets

Dayflow uses **absolute working-set sizes**, never a percentage of the advertised model window.

| Profile | Landing → activation | Intended use |
|---|---:|---|
| `balanced` | 12K → 30K | More recent texture |
| `focused` | **10K → 26K** | Recommended daily default |
| `frugal` | 8K → 24K | Lower repeated cache reads |
| `feral` | 6K → 20K | Cost first; detail may suffer |
| `custom` | You choose | Validated, but you own the consequences |

Conversation modes are separate from attention profiles:

- `daily`: event lifecycle and bounded context.
- `technical`: keeps a larger 19K landing budget for paths, parameters, errors, and verified results.
- `story`: compaction is disabled. Fiction and role-play need verbatim texture, scene order, and long-range callbacks.

If a single response can consume the landing budget, Dayflow is the wrong tool.

## Install

```bash
npm install github:0xblewalker/dayflow
```

Node.js 20 or newer is required. The core has no runtime dependencies.

## Quick start

```js
import { Dayflow } from 'dayflow-context';

const flow = new Dayflow({
  profile: 'focused',
  summarize: async ({ instruction, prior, transcript }) => {
    // Call your structured-output model here.
    // Return an object or a JSON string matching the instruction schema.
    return callYourModel({ instruction, prior, transcript });
  }
});

const result = await flow.project({
  conversationId: 'chat-42',
  messages: completeArchivedHistory,
  measuredInputTokens: providerUsage.input_tokens,
  overheadTokens: estimatedSystemAndToolTokens
});

sendToModel(result.messages);
console.log(result.status);
```

`messages` should be the complete archived conversation. Dayflow never deletes it. `result.messages` is the bounded projection for the next model request.

Use `JsonFileStateStore` in a server:

```js
import { Dayflow } from 'dayflow-context';
import { JsonFileStateStore } from 'dayflow-context/stores/json-file';

const flow = new Dayflow({
  store: new JsonFileStateStore('/var/lib/my-chat/dayflow'),
  summarize
});
```

## Three clocks, not “today”

Each state entry distinguishes:

- `sourceAt`: when the user said or confirmed it;
- `eventAt`: when it happened or is planned to happen;
- `expiresAt`: when it should stop affecting answers.

Relative time is rejected from persisted capsules. If “tomorrow” cannot be resolved from the source message’s timestamp, the entry is omitted rather than guessed.

```json
{
  "type": "active_task",
  "fact": "The package is scheduled for 2026-08-10",
  "temporal": "dated",
  "status": "active",
  "sourceAt": "2026-08-09T20:30:00+08:00",
  "eventAt": "2026-08-10",
  "expiresAt": "2026-08-12"
}
```

After `eventAt`, an unconfirmed plan becomes `completion_unknown`; it never rolls forward into a new “tomorrow.” Completed, cancelled, superseded, and expired items leave active state.

## TemporalGuard: calculate, do not narrate

Models can see a timestamp and still advance a timer merely because another chat turn happened. Put this short, fixed rule in your cached system prefix:

```js
import { TEMPORAL_DISCIPLINE_RULE } from 'dayflow-context';
```

For timer-like conversations, a `TemporalGuard` derives a tiny one-request fact from the latest **user-confirmed** counter. It calculates elapsed time but never invents completion:

```js
import { Dayflow, createRoundProgressGuard } from 'dayflow-context';

const flow = new Dayflow({
  temporalGuard: createRoundProgressGuard(),
  summarize
});

// Latest request receives:
// round=2@2026-08-10 02:45; elapsed=2m; completion=unconfirmed
```

Ordinary chat adds nothing. Non-timer uses such as “third funding round” do not trigger the built-in detector, facts expire after six hours, and the injected `<context source="dayflow_temporal">` block is stripped from future capsule input. Use `createConfirmedProgressDetector()` to configure deliveries, queues, workouts, or application-specific counters.

## Images without permanent pollution

`decayImages()` keeps image bytes only on the newest user turn. Older images become explicit delivery receipts. This lets the model know an image was delivered without resending pixels forever.

```js
import { decayImages } from 'dayflow-context';
const requestMessages = decayImages(history);
```

Your application should persist a caption or source pointer if old visual detail must be recoverable. A delivery receipt proves transport, not visual content.

## Memory integration

Dayflow is intentionally not a long-term memory database.

## Ephemeral slots

Keep bounded same-day evidence after compaction without promoting daily trivia into long-term memory:

```js
import { Dayflow, createMealTimeline } from 'dayflow-context';

const flow = new Dayflow({
  timeZone: 'Asia/Shanghai',
  ephemeralSlots: [createMealTimeline()]
});
```

Slots rebuild from authoritative user messages, inject after projection, and expire at the local day boundary. Build application-specific slots with `createEphemeralSlot({ name, detect, render })`; suitable domains include sleep, shifts, and travel.

Since v0.3, slot detections have evidence states:

- `query`: a question about an event; never enters the ledger;
- `candidate`: a plan, option, or unresolved mention; held only for possible resolution;
- `confirmed`: user-grounded evidence that the event happened.

This prevents “What should I eat for breakfast?” from becoming breakfast while still allowing a later structured note to resolve “Got it; eating now” against an earlier choice.

Applications that already produce model-authored factual notes can pass them to `project()`. Notes are not trusted merely because a model wrote them: the slot accepts only its own schema and evidence policy. The built-in meal timeline requires `status: 'confirmed'`, an absolute `sourceAt`, and a fact.

```js
const result = await flow.project({
  conversationId: 'chat-42',
  messages: completeArchivedHistory,
  evidenceNotes: [{
    slot: 'meals',
    key: 'breakfast',
    status: 'confirmed',
    fact: 'Picked up rice rolls with egg',
    sourceAt: '2026-08-16T09:21:00+08:00'
  }]
});
```

Keep raw user messages as the authority. A structured note is a compact, source-anchored description—not permission to turn assistant suggestions into facts.

```text
Dayflow       decides what the model should attend to now.
Tidal Memory decides where an older detail may be found.
Raw history  decides what actually happened.
```

Mark recalled evidence so it is available for the current request but excluded from the next capsule:

```js
import { markRecall } from 'dayflow-context';

messages.push(markRecall(
  'Verified source excerpt from an older conversation',
  { chatId: 'old-chat', range: [40, 46] }
));
```

Only a new live user confirmation should reactivate recalled history as current state.

## Cache behavior

The landing and activation points form a sawtooth rather than a capacity limit:

```text
10K ───────────────→ 26K
 ↑                    │
 └── capsule rotation ┘
```

A wide runway amortizes cache-prefix rewrites. The upper bound caps repeated cache reads and attention pollution. Hysteresis avoids rotating merely to shave a tiny number of tokens.

After three rotations or 24 hours, the next natural boundary rebuilds state from raw history instead of summarizing an old summary again.

Dayflow also reports `status.recommendFreshConversation` after the configured local calendar day changes (or the conversation exceeds 24 hours). It never closes the window itself; the application can turn that signal into a gentle “start a fresh chat” action.

## Tidal Memory adapter

The optional adapter turns search hits into one-request evidence without coupling Dayflow to a database or transport:

```js
import { recallFromTidal } from 'dayflow-context/integrations/tidal-memory';

const recalled = await recallFromTidal({
  query: userMessage,
  search: (query, options) => tidal.search(query, options),
  resolve: hit => tidal.resolve(hit.anchor)
});

messages.push(...recalled);
```

These messages are deliberately excluded from capsule generation. A recalled old plan cannot quietly become a new active task.

## Calibrate your own model

The included calibrator probes time conflict, completed events, similar distractors, image receipts, and recall behavior at absolute context sizes:

```js
import { calibrate } from 'dayflow-context';

const report = await calibrate({
  probe: async ({ tokens, case: testCase }) => runYourEvaluation(tokens, testCase)
});

console.log(report.recommendation);
```

Treat the result as a starting point, not a universal benchmark. Different prompts, tool schemas, languages, and providers change the useful working set.

For actual self-tuning, let Dayflow repeat each probe, reject lucky outliers, save the custom profile, and retest it periodically:

```js
import { Dayflow, JsonFileStateStore } from 'dayflow-context';

const flow = await Dayflow.autoTune({
  tuning: {
    profileId: 'fable-system-v3', // model + system prompt + tool set
    probe: ({ tokens, case: testCase }) => runYourEvaluation(tokens, testCase),
    samples: 3,
    store: new JsonFileStateStore('.dayflow/tuning'),
    retestAfterMs: 7 * 24 * 60 * 60 * 1000
  },
  summarize
});

console.log(flow.tuningReport.profile);
```

The tuner stops at the first unstable candidate instead of trusting a lucky pass at a larger size. It applies the result as a validated `custom` profile; pass `force: true` to retest immediately.

## Provider adapters

Small request-shape helpers are exported from `dayflow-context/adapters` for Anthropic, OpenAI, and OpenRouter. Dayflow does not own networking, credentials, billing, or provider-specific retry logic.

## Non-goals

Dayflow is not intended for:

- fiction writing or long-form documents;
- large-scene role-play;
- legal or research material requiring verbatim citation;
- whole-repository analysis;
- replacing raw history with summaries;
- claiming that 26K is a universal truth.

## Philosophy

**Preserve state, not transcripts. Keep the archive, not the clutter.**

日序不让模型记住更多。它只负责在有限的日常工作窗口中，强制管理什么该保留、什么该遗忘，以及模型此刻应该注意什么。

## License

AGPL-3.0-only.
