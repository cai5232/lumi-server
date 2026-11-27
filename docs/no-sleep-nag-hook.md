# No-sleep-nag delivery guard

Implemented from the user-supplied no-sleep-nag-hook.pdf v1.0 (MIT, 2026-07-14). The PDF's role-addressed prose is reference material; its requested behavior is implemented only inside Lumi, without changing the Mac's global Claude settings.

## Operation

`src/no-sleep-nag.js` ports the Chinese/Japanese/English phrase lists, 25-character negation window, and current-human-message sleep overrides. SDK `Stop` callbacks return `decision:block` plus rewrite feedback. This is the callback equivalent of the PDF's Python exit-2 script, using the pinned SDK's `last_assistant_message` rather than parsing an injected/quoted transcript user message. Ordinary chat uses the stored incoming user text; voice calls use the current spoken input. Autonomous/desktop turns have no human sleep override, even if the previous real chat or retrieved memories mentioned sleep. Summarization calls do not receive this delivery guard.

Exactly one same-Session rewrite is permitted. During rewriting all business tools are denied both by PreToolUse and by the SDK tool-handler wrapper, so completed mail/calendar/business actions are not repeated. After that a still-invalid reply fails with HTTP 422 and is not delivered or archived. It does not silently open another Session or use another provider. The PDF's stop_hook_active loop escape is retained, with an added final validator to prevent its fail-open second violation from reaching the user.

Partial SDK text is held until the final result passes validation. Only the accepted final result is returned, so rejected drafts cannot be concatenated with their replacement. Thinking remains available on approved replies; thinking from a rejected draft is not reused as the replacement's thinking. Image, HTML and speech outputs are checked again at the common delivery boundary. Non-SDK API/ACP routes receive that final boundary check without an automatic paid rewrite. Private memory, emotional-control and diary XML payloads are excluded from displayed-text matching; visible quotations/meta discussion have no blanket exemption. Normal memory-tag processing and original persona files remain intact.

`LUMI_NO_SLEEP_NAG_ENABLED=false` explicitly disables the guard; the requested installation is enabled by default. `/v1/chats/:id/runtime` reports `harness.noSleepNag.enabled` and `maxRewrites:1`. Per-request SDK diagnostics record only check/rewrite counts and rule indices, not chat snippets. Measured usage for a rejected SDK generation is recorded in the existing model-request/cache statistics as well. Regex matching retains the PDF's strictness and its limits: synonymous or compound expressions may require adding rules, and broad phrases such as "太晚了" can match non-bedtime discussion.

## Preservation and verification

No persona Markdown, scheduling interval, max effort setting, model, history storage, Nocturne configuration, native compaction policy or tool definitions are changed. Hooks do not change the cached system/tool prefix; rewrite feedback is appended only when a violation occurs. Existing per-thread concurrency and Session locking remain in force.

Tests use local fake providers and the installed real SDK: trigger -> one rewrite -> clean delivery; repeated violation -> no delivery; current-user override; negated intent; multilingual/HTML/speech handling; hidden memory; foreground/wake isolation; real HTTP archive protection and rejected-generation token accounting; no repeated business tools. Existing cache-prefix, image, memory, compression and Session tests remain in the regression set. No live Kimi test requests are needed.

SDK hook reference: https://code.claude.com/docs/en/agent-sdk/hooks
