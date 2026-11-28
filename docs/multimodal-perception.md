# Independent Gemini audio/video perception

## Inspected architecture and scope

`src/index.js` owns the existing chat HTTP API, message archive, model routing, prompt injection, compaction and scheduling. `src/harness-runtime.js` owns the Agent SDK Session bridge; `src/chat-images.js` stores original image inputs; `src/context-summary.js` owns the existing emotional summary rules. The SwiftUI client has `ChatDetailView`, `ChatViewModel`, `ChatModels` and `LumiAPIClient`, with an explicit Xcode source list. The co-watch/audio-room analyzers are separate features and were not reused: their model configuration/streaming semantics would couple chat perception to other routes.

New `src/multimodal-perception.js` and `src/perception-routes.js` are independent of Harness, main API providers, memory and scheduling. The feature defaults off and has no inherited credentials. The client adds `MultimodalPerceptionView.swift` with settings, a composer attachment picker, original media player and expandable analysis. Existing recorded-voice and picture flows remain available.

## Data flow

1. Authenticated client uploads original audio/video bytes; the server persists them before analysis. No local frame extraction, audio removal, ASR replacement or main-model call occurs.
2. An independent `generateContent` request contains only the perception instructions and original media as `inlineData`, plus a fixed task label. It has no chat history, persona, memory, user-auth token or main-provider credentials.
3. Background status transitions `analyzing` → `ready` or `error`; the client polls. A separate retry endpoint only reruns perception. Server restarts mark uncertain in-flight work as interrupted instead of silently replaying a potentially paid request.
4. User sends `perceptionIDs` with the ordinary chat request. Only server-resolved completed analyses are accepted. `perceptionContext` serializes the observation as untrusted data in the current user turn. Existing `generateReply`/SDK/API routes produce the reply. Gemini never appears as a separate role.
5. `mediaPerceptions` persists with the user message. Original text, earlier turns and stable system prefix are unchanged. Existing historical `modelContent` maintains exact continuation prefixes. When existing compaction uses visible history, the observation is restored for retained media messages and included in token estimates/summary input. No compaction policy, threshold, Session policy or persona rule changes.

## Settings and protocols

`GET/PUT /v1/perception/settings`: independent `enabled`, `baseURL`, `apiKey`, `model`, `protocol` (`gemini`/`vertex`), `authMode` (`apiKey`/`bearer`), optional Vertex `project`/`location`. Blank/omitted key preserves the saved key; `clearAPIKey: true` removes it. GET never returns the key. Configuration and artifacts use private filesystem permissions under persistent `multimodal-perception/`.

Gemini base roots or `/v1beta` (also `/v1`) become `/models/{id}:generateContent`. Vertex supports express mode, project/location resources or an already complete `/models` base. API-key auth uses `x-goog-api-key`; Bearer auth uses `Authorization`. Standard Vertex accepts a currently valid access token; automatic Google OAuth/service-account renewal is not implemented. URLs never contain secrets and redirects are rejected.

A user-selectable editable ZenMux preset uses `https://zenmux.ai/api/vertex-ai`, `google/gemini-3.5-flash-lite`, Vertex protocol, Bearer auth. This follows ZenMux's native Vertex endpoint documentation; it does not borrow the main ZenMux key or enable the module automatically.

## File persistence, deduplication and cost boundaries

`POST /v1/perception/files` receives raw bytes (`Content-Type`, percent-encoded `X-File-Name`); GET by ID reports status. `GET .../{id}/content` provides authenticated original playback including byte ranges. `POST .../{id}/retry` is explicit; failed jobs are not automatically retried. All feature endpoints require existing app authorization.

The analysis ID combines a SHA256 of the original file, MIME type and SHA256 of analysis configuration (endpoint, protocol, auth/account key hash, project, model, prompt version and generation settings). Concurrent identical uploads coalesce. Completed results survive process restarts. Changing models or credentials creates a separate analysis rather than reusing another model/account's result. Same successful configuration/file does not make a second paid call. HTTP failures/timeouts do not switch providers or main models; users should understand an explicit retry after a network timeout can be charged again if the provider processed the first request.

First implementation accepts up to **12 MiB per original file** and up to four completed attachments per turn (client currently picks one at a time). This conservative inline transport limit avoids assuming that every Gemini-compatible relay supports the Google Files API or large inline bodies. Oversized files are rejected explicitly; no lossy automatic fallback. Google Files API / Cloud Storage / long-video chunking are not implemented. Photos video transfer requests `.current` encoding; files are uploaded directly. Device-supported formats/codecs and upstream modality support must be tested against the selected provider.

## Diagnostics and verification

`POST /v1/perception/test` explicitly makes a small, independently logged connection request; this verifies connectivity, not actual modality understanding. The settings screen also offers real original-video/audio tests; these do not call the main model. `GET /v1/perception/usage` keeps the latest 1000 standalone perception/connection records (model, time, elapsed ms, status, usage metadata, redacted error). It is not added to the main request-usage store. The settings screen shows the most recent 20.

Automated tests inject fake upstream responses; they verify raw video/audio bytes, protocol/auth paths, no history/persona/Nocturne disclosure, private key handling, durable deduplication, configuration invalidation, explicit failures/retries, restart interruption, safe analysis data framing, authenticated playback/ranges, real main chat-route integration, unchanged old messages/system prefix/Session, and failure isolation. Existing Harness, summary, original-tail, image, memory-tag and wake tests continue to run. These are contract/regression tests, not evidence of live Gemini semantic recognition or a production cache hit. Live video timeline, speech/audio-track recognition, audio understanding, usage and cache measurements remain to be accepted after an independent Key is supplied and the user selects real samples.

Sources checked 2026-11-27:
- https://ai.google.dev/gemini-api/docs/video-understanding
- https://ai.google.dev/gemini-api/docs/audio
- https://zenmux.ai/docs/api/vertexai/generate-content.html
- https://zenmux.ai/docs/guide/advanced/multimodal.html
