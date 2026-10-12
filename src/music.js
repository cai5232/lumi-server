import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ncm from "NeteaseCloudMusicApi";

function sendJSON(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(payload));
}

function normalizeSong(song) {
  return {
    id: String(song.id),
    title: song.name || "未知歌曲",
    artist: (song.ar || song.artists || []).map((artist) => artist.name).join(" / "),
    album: (song.al || song.album || {}).name || "",
    cover: String((song.al || song.album || {}).picUrl || "").replace(/^http:/, "https:"),
    durationSeconds: Math.round((song.dt || song.duration || 0) / 1000)
  };
}

export function createMusicService(dataDir) {
  const statePath = join(dataDir, "music-room-state.json");
  const cookiePath = join(dataDir, "ncm-cookie.txt");
  let cookie = "";
  let cookieReady = readFile(cookiePath, "utf8").then((value) => { cookie = value; }).catch(() => {});
  let stateWriteQueue = Promise.resolve();

  async function readState(room) {
    try {
      const rooms = JSON.parse(await readFile(statePath, "utf8"));
      const state = rooms[room];
      if (!state) return null;
      const elapsed = state.isPlaying ? Math.max(0, Date.now() - Number(state.updatedAt || 0)) / 1000 : 0;
      const rawPosition = Math.max(0, Number(state.positionSeconds) || 0) + elapsed;
      const positionSeconds = state.durationSeconds > 0 ? Math.min(state.durationSeconds, rawPosition) : rawPosition;
      return { ...state, positionSeconds };
    } catch {
      return null;
    }
  }

  async function writeState(room, state) {
    const operation = stateWriteQueue.then(async () => {
      let rooms = {};
      try { rooms = JSON.parse(await readFile(statePath, "utf8")); } catch {}
      rooms[room] = state;
      await mkdir(dataDir, { recursive: true });
      const tempPath = statePath + ".tmp";
      await writeFile(tempPath, JSON.stringify(rooms), { mode: 0o600 });
      await chmod(tempPath, 0o600);
      await rename(tempPath, statePath);
    });
    stateWriteQueue = operation.catch(() => {});
    return operation;
  }

  async function saveCookie(value) {
    await mkdir(dataDir, { recursive: true });
    cookie = String(value || "");
    await writeFile(cookiePath, cookie, { mode: 0o600 });
    await chmod(cookiePath, 0o600);
    cookieReady = Promise.resolve();
  }

  async function profile() {
    await cookieReady;
    if (!cookie) return null;
    try { return (await ncm.login_status({ cookie })).body?.data?.profile || null; }
    catch { return null; }
  }

  return async function handleMusicRequest(req, res, url) {
    const route = url.pathname.slice("/v1/music/".length);
    try {
      if (route === "room/state" && req.method === "GET") {
        const room = String(url.searchParams.get("room") || "main").slice(0, 64);
        return sendJSON(res, 200, { state: await readState(room) });
      }
      if (route === "room/state" && req.method === "PUT") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const input = raw ? JSON.parse(raw) : {};
        const room = String(input.room || "main").slice(0, 64);
        const songID = String(input.songID || "").slice(0, 32);
        const title = String(input.title || "").slice(0, 200);
        if (!songID || !title) return sendJSON(res, 400, { error: "song_required" });
        const previous = await readState(room);
        const state = {
          room, songID, title, artist: String(input.artist || "").slice(0, 200),
          cover: String(input.cover || "").replace(/^http:/, "https:").slice(0, 2000),
          durationSeconds: Math.max(0, Math.min(86400, Number(input.durationSeconds) || 0)),
          positionSeconds: Math.max(0, Math.min(86400, Number(input.positionSeconds) || 0)),
          isPlaying: Boolean(input.isPlaying),
          actorID: String(input.actorID || "").slice(0, 80),
          revision: (Number(previous?.revision) || 0) + 1,
          updatedAt: Date.now()
        };
        await writeState(room, state);
        return sendJSON(res, 200, { state });
      }
      if (route === "netease/status" && req.method === "GET") {
        const account = await profile();
        return sendJSON(res, 200, { logged: Boolean(account), nickname: account?.nickname || "" });
      }
      if (route === "netease/qr" && req.method === "GET") {
        await cookieReady;
        const keyResult = await ncm.login_qr_key({});
        const key = keyResult.body?.data?.unikey;
        const qrResult = await ncm.login_qr_create({ key, qrimg: true });
        return sendJSON(res, 200, { key, image: qrResult.body?.data?.qrimg || "" });
      }
      if (route === "netease/qr/check" && req.method === "GET") {
        await cookieReady;
        const result = await ncm.login_qr_check({ key: String(url.searchParams.get("key") || "") });
        const code = Number(result.body?.code || 0);
        if (code === 803 && result.body?.cookie) {
          await saveCookie(result.body.cookie);
          const account = await profile();
          return sendJSON(res, 200, { code, logged: true, nickname: account?.nickname || "" });
        }
        return sendJSON(res, 200, { code, message: String(result.body?.message || "") });
      }
      if (route === "netease/search" && req.method === "GET") {
        await cookieReady;
        const keywords = String(url.searchParams.get("q") || "").trim().slice(0, 100);
        if (!keywords) return sendJSON(res, 200, { songs: [] });
        const result = await ncm.cloudsearch({ keywords, limit: 30, cookie });
        return sendJSON(res, 200, { songs: (result.body?.result?.songs || []).map(normalizeSong) });
      }
      if (route === "netease/song-url" && req.method === "GET") {
        await cookieReady;
        const result = await ncm.song_url_v1({ id: String(url.searchParams.get("id") || ""), level: "standard", cookie });
        const streamURL = result.body?.data?.[0]?.url || "";
        return sendJSON(res, 200, { url: String(streamURL).replace(/^http:/, "https:") });
      }
      if (route === "netease/logout" && req.method === "POST") {
        await saveCookie("");
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 404, { error: "not_found" });
    } catch (error) {
      console.warn("[music]", String(error?.message || error).slice(0, 300));
      return sendJSON(res, 502, { error: "music_service_unavailable" });
    }
  };
}
