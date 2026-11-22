# CC SDK session continuity

Lumi's ordinary chat and autonomous-wake sessions are persistent and separate per thread/scope. Once a Session ID exists, only a new application `compactedAt` marker proactively replaces it. A new thread or scope still creates its first session normally. SDK transcript loss is reported as an error without creating an automatic replacement or switching providers.

History hash, persona, model, effort, system prompt and tool-definition changes no longer select a new session. Current options are applied on resume. The SDK custom system-prompt option uses `snapshot:false`, so updates actually reach the upstream system prompt on an existing session; unchanged text remains unchanged. Changing model/effort/system/tool prefixes can still invalidate provider caches. Retaining a Session ID does not guarantee a cache hit or one-hour retention.

Private session checkpoints retain a cursor over the active Lumi archive. Newly appended turns from another scope, corrections and exclusions are delivered as quoted historical updates before the current turn. Old text identifies the superseded version; these updates do not replay past tools or write Nocturne memories. Existing sessions migrate through their matching archive checkpoint/prefix without resetting. If a legacy checkpoint cannot be matched, the current archive view is synchronized once, subject to the existing context budget; it is never silently truncated.

Excluding/deleting a message from Lumi's active archive does **not** physically erase its old text from a resumed SDK transcript. Corrections instruct the model which version is authoritative. Physical removal from the model context occurs when Lumi next compacts/rebuilds. The permanent chat archive and the original emotional-summary/recent-original-text policy remain application-owned.

Tests use fake SDKs or localhost model servers with synthetic keys, including actual pinned-SDK wire checks for updated system prompts and tool definitions on the same Session ID. No production model calls are necessary to verify this policy.
