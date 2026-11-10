# Dayflow integration

Upstream: https://github.com/0xblewalker/dayflow
Pinned revision: 30b338c716e3025a175c2d9214a0959ec8165a77 (v0.3.0).
The unmodified source, README, package metadata and AGPL-3.0-only license are in src/vendor/dayflow. The integration source is published alongside it in this repository.

Dayflow is enabled by default. Daily mode uses a custom activation threshold from the existing context-compression settings (230000 on the current installation). Its verbatim tail is bounded at 5000 tokens; total landing budget includes the actual prompt/context overhead. It does not change the existing long-term memory database.

Migration retains threads.json, attached files, contextSummary and the already committed legacy boundary. The frozen legacy summary remains in the stable system prefix. Dayflow projects the archived messages after that boundary into a replaceable state capsule plus verbatim tail. It never overwrites or deletes the archive. Hidden retrieval/context wrappers are excluded from capsule inputs. Historical images become delivery receipts; current attachments retain their original transport.

TemporalGuard and evidence-aware meal slots are enabled in daily mode. These use timestamped source messages; relative plans expire rather than becoming a new tomorrow. Existing memory retrieval, MCP tools, proactive wakes and phone turns remain connected.

The summarizer uses the saved chat route, a strict JSON task, a 4000-token output cap and a 90-second deadline. Failed rotations retain committed state; they are recorded for the AI and use the prior projection for a normal request when its actual body still fits the model. A short cooldown avoids immediate paid retries. The previous request's token count cannot incorrectly block a smaller new projection. Old background compaction is disabled while Dayflow is enabled.

Authenticated APIs:
- GET /v1/settings/dayflow — policy and runtime status.
- PATCH /v1/settings/dayflow with {"mode":"daily"|"technical"|"story"} and/or {"enabled":boolean}.
- Existing /v1/settings/context-compression still controls the daily activation threshold.

Story mode preserves the existing verbatim request path and disables compaction. Technical mode follows upstream's larger-tail technical preset (activation 26000, landing 19000). Disabled mode returns to the legacy pipeline. No new conversation is created automatically. Recommendations to start fresh are reported as status only.

State: data/dayflow/settings.json and data/dayflow/states/<hashed-thread-and-legacy-boundary>.json. State writes are serialized per conversation, credentials are never stored in capsules, and files are private. Existing legacy state files are retained for rollback.

Validation: upstream 16 tests; adapter 4 tests; full backend rotation test with a mock model; normal chat/error observations/call-timeout regressions. No test messages are sent to the production conversation.

Reply timing is calculated independently from the complete archived timeline, so projection/compaction does not reset waiting duration. A real chat request includes client sent time (validated against server receipt), time since the last visible assistant message, and whether this is a reply or a follow-up. Autonomous wakes receive time since the last user message and since the first unanswered assistant message, with multiple wakes never resetting the original wait. Known failed send attempts and answered/spoken calls are distinguished from silence. Technical bubbles are excluded. These are observed send intervals, not read receipts or explanations for user behavior. No iOS update is required: the existing client already sends requestedAt and timeZone.

Request failure history remains available on subsequent chats and autonomous wakes after first delivery, independent of Dayflow's transient context projection. Acknowledgement marks first successful delivery only; it no longer removes a record from model context. New undelivered errors are prioritized, then recent delivered records are included up to a 40000-character payload budget. Original messages, errors and timestamps remain in request-failures.json; omitted records are counted explicitly. Delivery does not imply a fresh failure or confirmed resolution. No artificial user messages or extra model calls are created.
