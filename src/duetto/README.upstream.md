# Duetto

*listen together, in tune.*

**Duetto** is a self-hostable listen-together music player for two, with a bring-your-own-AI companion
that *actually listens* — it hears the audio of every song you share a room with, remembers the
moments you point at a lyric, and grows a memory of what each song means to the two of you.

## Features

- **Real audio playback** — play/pause, seek, prev/next, live progress, play modes (loop / one / shuffle); the next track's stream URL is prefetched the moment playback starts, so lock-screen/background playback never stalls
- **Listen together** — share a room; play / pause / seek sync in real time over WebSocket; share songs into the room chat as cards; status cards announce who played, paused, hearted, or collected what (system-triggered pauses like screen locks are filtered out)
- **An AI that actually listens** — the companion downloads the very stream you're hearing and listens to it with a multimodal model (falls back to full timed lyrics if your endpoint can't take audio). Analyses are made once per song and cached forever. Every chat request carries: playback position, the exact lyric line playing right now, how many times you've played the song together, the listening analysis, and the rolling memory grown from your conversations about it
- **Two reply styles**, switchable in room settings — split chat bubbles (WeChat-style), or a single full reply with a visible thinking chain you can unfold
- **Quote a lyric** — long-press a line (in the full lyric page or the room's floating ball) and it rides your next message as a WeChat-style quote block, lands in the song's archive as the exact passage
- **Ask about this lyric** — tap any line, ask in your own words or via quick chips; every exchange becomes a presence note; six notes roll into a first-person memory the AI keeps for that song
- **DJ actions** — the AI can play / switch / pause / resume / share / heart / queue songs through inline commands; shared songs auto-queue and start playing
- **NetEase Cloud Music integration** — QR login, playlists, search, daily recommendations, personal FM, lyrics with translation toggle, artist pages, likes, batch playlist editing
- **Add your own songs** — paste a direct audio URL under Library → Local
- **Themes & customization** — five palette skins (凝脂 / 豆青 / 雪青 / 藕荷 / 霁蓝) + full custom palette, wallpaper, per-surface opacity & blur, bubble colors, two room top-bar styles, draggable floating ball
- **Lyric niceties** — swipe-to-seek with snap line, four lyric fonts, adjustable size
- **Installable PWA** — manifest + icons, media-session lock-screen controls
- **External memory hook** — point `context_url` at your own memory/RAG service and its output joins the prompt
- **Prompt transparency** — `GET /api/prompt-preview` shows the exact system prompt your model receives
- Ships **empty of private data** — `data/` is gitignored; bring your own songs, key, and content

**中文功能与操作指南：[GUIDE.md](GUIDE.md)**

## Quick start

> Requires **Node 24+** (uses Node's built-in SQLite).

```bash
npm install
npm start
```

Open **http://localhost:4183/pkg/index.html** (change port with `PORT=8080 npm start`).

## Listen together

Everyone opening the same server shares room `main` by default; add `?room=yourcode` to the URL
for a private room and share that link. Playback syncs in real time across the room.

## Configure your AI

Open the **Together** tab (bottom nav) → **Model settings** → fill in your OpenAI-compatible
**endpoint** + **API key** → hit **Pull models** and pick one → optionally write a **persona**
and a **chat style** → Save. Keys entered in the UI live in your browser's localStorage and are
only sent to your own server, which forwards them to your endpoint.

You can also set a server-wide default in `data/settings.json` (`ai.base_url` / `ai.api_key` /
`ai.model` / `ai.style`). The stored key is never returned by the API — `GET /api/settings` masks
it — and `data/` is gitignored, so nothing private ships with the repo.

**Analysis model (optional).** The second block in Model settings picks the model used to *listen
to* songs (audio in) and write impressions. Fill in as much or as little as you like — just a model
name, just a key, or a full endpoint+key+name — anything missing is borrowed from your chat config.
Leave it empty to use the chat model. Server-side defaults: `ai.a_model` / `ai.a_base` / `ai.a_key`.

**External memory (optional).** Set `ai.context_url` in `data/settings.json` to a POST endpoint of
your own. Each chat turn Duetto sends `{message, song, user, ai}` and injects the returned
`{context}` text into the prompt as shared memory. 4-second budget; failures are silent.

## How it works

- **Frontend** (`frontend/pkg/`): React 18 + Babel standalone (no build step), `sync.js`
  (real-time room sync), `claude-bridge.js` (AI plumbing), `image-slot.js` (local images via IndexedDB).
- **Backend** (`server/index.mjs`): Express + WebSocket, zero database dependencies — the long-term
  archive (plays, songs with cached lyrics and rolling memories, presence notes, analyses, room
  events) lives in SQLite via Node's built-in `node:sqlite`; JSON files hold only ephemeral state.

## Updating

```bash
git pull
npm install
# restart the server (systemctl / pm2 / however you run it)
```

Your data is safe across updates — settings, PIN, and the SQLite archive all live under `data/`,
which is gitignored and never touched by `git pull`. Tables are created with `IF NOT EXISTS`, so an
existing database keeps working. Frontend assets are cache-busted by version, so users just refresh.

## Behind a reverse proxy

Point your proxy at the server (default 4183), serve at your domain root, and **proxy `/ws`** for sync.

## Security note

Duetto ships a built-in **PIN gate** (see the Security section above): on first open you set a PIN,
and after that every API call and the sync socket require the token derived from it. Until a PIN is
set, the server refuses all non-auth requests, so a fresh deployment is not open by default.

This is a single-secret lock meant for a two-person / trusted-room app, **not** a full multi-user
auth system. For anything internet-facing, still put it behind **HTTPS** and consider an additional
upstream gate (reverse-proxy auth, Cloudflare Access, Tailscale, or a private LAN) for defense in
depth. All music-account actions and room/archive reads sit behind the PIN gate.

## Security

- **Built-in access gate.** On first open Duetto asks you to set a PIN (min 4 chars). After that,
  every `/api/*` call and the `/ws` sync socket require the token derived from it — new devices
  enter the PIN once. Auth state lives in `data/auth.json`; delete that file to reset the PIN.
- Mutating NetEase endpoints (like / playlist add / delete / FM trash / logout) are POST-only.
- `/api/models` only accepts `https://` endpoints (SSRF mitigation).
- `/api/prompt-preview` and everything else sit behind the gate.
- **Known upstream advisories:** `npm audit` reports 3 findings inside
  `NeteaseCloudMusicApi → music-metadata / file-type` (2 high / 1 moderate). No fixed upstream
  release exists yet; tracked for future upstream bumps. They sit in the music-metadata parsing
  path of the NetEase proxy, not in Duetto's own code.
- For internet-facing deployments, serve over **HTTPS** (also required for PWA + background audio).

## Privacy

No keys, personal data, playlists, or chat logs ship with this project. `data/` is gitignored. Runtime
data stays on the deployment host under `data/`; model keys entered in the UI are stored in that
browser's localStorage and are sent to the self-hosted backend only when making model requests.

## License

MIT — see LICENSE.
