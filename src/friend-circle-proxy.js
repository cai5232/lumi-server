import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";

const prefix = "/api/federation/";
const bodyLimit = 256 * 1024;
const responseHeaders = ["content-type", "content-security-policy", "content-disposition", "x-content-type-options", "referrer-policy"];

export function isFriendCirclePath(path) {
  return path.startsWith(prefix);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > bodyLimit) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createFriendCircleProxy({ directory, origin, authorized, send }) {
  return async (req, res, url) => {
    res.setHeader("cache-control", "no-store");
    if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
    if (!["GET", "POST", "PUT"].includes(req.method)) return send(res, 405, { error: "method_not_allowed" });
    if (req.method !== "GET" && req.headers.origin !== origin) return send(res, 403, { error: "origin_mismatch" });
    if (!directory) return send(res, 503, { error: "friend_circle_unavailable" });
    const tail = url.pathname.slice(prefix.length);
    if (!/^[a-z0-9_/-]+$/i.test(tail) || tail.includes("//")) return send(res, 404, { error: "not_found" });

    try {
      let body;
      if (req.method !== "GET") {
        if (Number(req.headers["content-length"]) > bodyLimit) {
          req.resume();
          return send(res, 413, { error: "request_too_large" });
        }
        body = await readBody(req);
        if (!body) return send(res, 413, { error: "request_too_large" });
      }
      const [rawToken, rawPrincipal] = await Promise.all([
        readFile(join(directory, "gateway-token"), "utf8"),
        readFile(join(directory, "principal"), "utf8")
      ]);
      const token = rawToken.trim();
      const principal = rawPrincipal.trim();
      if (!/^[a-zA-Z0-9_-]{43,128}$/.test(token) || !/^https:\/\/[a-z0-9.-]+\/federation\//i.test(principal)) {
        return send(res, 503, { error: "friend_circle_unavailable" });
      }
      await new Promise((resolve, reject) => {
        const upstream = request({
          socketPath: join(directory, "gateway.sock"),
          path: url.pathname + url.search,
          method: req.method,
          headers: {
            authorization: "Bearer " + token,
            "x-fc-local-principal": principal,
            origin,
            ...(req.headers["x-federation-media"] === "links" ? { "x-federation-media": "links" } : {}),
            ...(body ? { "content-type": "application/json", "content-length": body.length } : {})
          }
        }, response => {
          if ((response.statusCode || 500) >= 300 && (response.statusCode || 500) < 400) {
            response.resume();
            reject(new Error("unexpected federation redirect"));
            return;
          }
          for (const header of responseHeaders) {
            if (response.headers[header]) res.setHeader(header, response.headers[header]);
          }
          res.statusCode = response.statusCode || 502;
          response.once("error", reject);
          response.once("end", resolve);
          response.pipe(res);
        });
        res.once("close", () => { if (!res.writableFinished) upstream.destroy(); });
        upstream.setTimeout(25_000, () => upstream.destroy(new Error("gateway timeout")));
        upstream.once("error", reject);
        upstream.end(body);
      });
    } catch (error) {
      if (res.headersSent) res.destroy();
      else return send(res, error.code === "ENOENT" ? 503 : 502, { error: "friend_circle_unavailable" });
    }
  };
}
