# Voice cache stability and Agent Loop token totals

## Production findings

The user screenshot's 17:03 request corresponds to 2026-11-27T09:03:07.013Z (device display UTC+8). It is a single Lumi generation with **seven** SDK model invocations: read chibi studio, prepare, check, render, render again, send, then final response. Total input was 689270, with 655243 cache-read tokens and 34027 uncached input tokens; total output was 17009, including 4934 thinking tokens. The last invocation had 110080 input tokens (842 uncached + 109238 cached). The total does not describe one context/window. The no-sleep-nag guard checked once and rewrote zero times.

The screenshot's 17:24 request made three model invocations while posting and reading social updates, totaling 351408 input / 342884 cached tokens. The next 17:36 foreground chat had 125056 input / 19456 cached tokens. The Session ID and all 89 tool definitions were unchanged. Its system differed by exactly the 306 characters in prompts/voice.md: previous SDK wakes removed that module when allowSpeech=false, while the TTS-enabled foreground chat restored it. Removing only that module from the foreground request makes the two recorded system strings byte-identical. At 17:38 the API reported 125056 cached of 129945 input (96.24%); at 17:44 it reported 129945 of 132420 (98.13%).

## Fix

Retain the existing voice module, verbatim, in the stable system prefix. The existing per-turn <speech_enabled> flag and speech-style suffix continue to control permission and speech formatting; the backend still parses and synthesizes speech only when enabled. This keeps rule priority and speech functionality intact at a fixed 306-character prefix cost, avoiding recurrent history-prefix invalidation. Persona files and tool definitions do not change, and this patch does not rebuild Sessions. Application compaction remains the only rebuild trigger.

The full HTTP/scheduler test now exercises TTS-enabled chat -> autonomous wake (TTS disabled) -> TTS-enabled chat -> muted chat, asserting exact system/tool equality, same Session, and the correct per-turn speech_enabled flags. Existing image, memory, compaction and no-sleep-nag tests remain in the regression set.

The usage rows continue to report real aggregate consumption across all SDK invocations; they must not be changed to report only the final call. Autonomous tool permissions and max effort remain unchanged. No real Kimi probes are needed to validate this prefix fix.
