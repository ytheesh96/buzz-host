// Host-side credential & egress proxy for sandboxed buzz-host agents.
//
// Each sandboxed agent gets:
//   1. Its own Unix domain socket under <runDir>/sandbox/<pubkey16>/proxy.sock (0600)
//   2. Its own opaque proxy token `bhs_<32hex>` stored in agents/<pubkey>/sandbox-token (0600)
//
// Inside the container, container-entry.mjs bridges 127.0.0.1:18461 <-> /run/buzz-sandbox/proxy.sock.
// Real host API keys and OAuth tokens NEVER enter any container: this proxy verifies
// the per-agent token, strips incoming auth headers, injects the real host credential,
// and forwards only to strictly allowlisted upstream provider URLs:
//   - /opencode-go/*  -> https://opencode.ai/zen/go/*        (Hermes + OpenCode Go)
//   - /anthropic/*    -> https://api.anthropic.com/*         (Claude Code OAuth or API key)
//   - /agy/token      -> synthetic OAuth token exchange      (Antigravity CLI)
//   - /agy/cloudcode/* -> https://daily-cloudcode-pa.googleapis.com/* (Antigravity CLI)

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";

const HEX64 = /^[0-9a-f]{64}$/;
const DEFAULT_RATE_LIMIT = 120; // requests per minute per agent
const RATE_WINDOW_MS = 60_000;
const AGY_DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const GEMINI_DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com";
const ANTHROPIC_DEFAULT_ENDPOINT = "https://api.anthropic.com";
const OPENCODE_GO_DEFAULT_ENDPOINT = "https://opencode.ai/zen/go";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Parse a KEY=VALUE line from a dotenv file (ignoring comments and quotes). */
export function parseDotEnvValue(text, key) {
  const lines = String(text || "").split(/\r?\n/);
  const prefix = `${key}=`;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
    if (!stripped.startsWith(prefix)) continue;
    let val = stripped.slice(prefix.length).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (val) return val;
  }
  return "";
}

/** Extract the agent's opaque proxy token from Authorization or x-api-key headers. */
export function extractProxyToken(headers) {
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m) return m[1];
  }
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  const googKey = headers["x-goog-api-key"];
  if (typeof googKey === "string" && googKey.trim()) return googKey.trim();
  return "";
}

async function readBodyBuffer(req, maxBytes = 16 << 20) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

/** Default host credential loaders (reads host env/files lazily; never exposed to containers). */
export function createHostCredentialLoaders({
  homeDir = os.homedir(),
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  let agyCache = { token: "", expiresAt: 0, projectId: "" };

  async function loadOpenCodeGo() {
    if (env.OPENCODE_GO_API_KEY) return { apiKey: env.OPENCODE_GO_API_KEY };
    const dotEnv = await fs.readFile(path.join(homeDir, ".hermes/.env"), "utf8").catch(() => "");
    const apiKey = parseDotEnvValue(dotEnv, "OPENCODE_GO_API_KEY");
    if (!apiKey) throw new Error("OPENCODE_GO_API_KEY is not configured on host");
    return { apiKey };
  }

  async function loadAnthropic() {
    if (env.ANTHROPIC_API_KEY) return { mode: "api-key", value: env.ANTHROPIC_API_KEY };
    const raw = await fs
      .readFile(path.join(homeDir, ".claude/.credentials.json"), "utf8")
      .catch(() => "");
    if (raw) {
      const parsed = JSON.parse(raw);
      const token = parsed?.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token) return { mode: "oauth", value: token };
    }
    throw new Error("Neither ANTHROPIC_API_KEY nor ~/.claude/.credentials.json is available on host");
  }

  async function loadAgyTokenMeta() {
    const raw = await fs
      .readFile(path.join(homeDir, ".gemini/antigravity-acp/acp_token.json"), "utf8")
      .catch(() => "");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function loadAgyAccessToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && agyCache.token && now < agyCache.expiresAt - 60_000) {
      return agyCache.token;
    }
    const meta = await loadAgyTokenMeta();
    if (!meta?.refresh_token || !meta?.client_id || !meta?.client_secret) {
      throw new Error("~/.gemini/antigravity-acp/acp_token.json is not configured on host");
    }
    const tokenUri = meta.token_uri || "https://oauth2.googleapis.com/token";
    const body = new URLSearchParams({
      client_id: meta.client_id,
      client_secret: meta.client_secret,
      refresh_token: meta.refresh_token,
      grant_type: "refresh_token",
    });
    const resp = await fetchImpl(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => "")).slice(0, 200);
      throw new Error(`Antigravity OAuth refresh failed (${resp.status}): ${detail}`);
    }
    const json = await resp.json();
    if (!json?.access_token) throw new Error("Antigravity OAuth refresh returned no access_token");
    const expiresIn = Number(json.expires_in) || 3600;
    agyCache = {
      token: json.access_token,
      expiresAt: now + expiresIn * 1000,
      projectId: meta.project_id || "",
    };
    return agyCache.token;
  }

  async function getAgyProjectId() {
    if (agyCache.projectId) return agyCache.projectId;
    const meta = await loadAgyTokenMeta();
    return typeof meta?.project_id === "string" ? meta.project_id : "";
  }

  async function loadGeminiApiKey() {
    if (env.GEMINI_API_KEY) return { apiKey: env.GEMINI_API_KEY };
    const dotEnv = await fs.readFile(path.join(homeDir, ".hermes/.env"), "utf8").catch(() => "");
    const apiKey = parseDotEnvValue(dotEnv, "GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured on host");
    return { apiKey };
  }

  async function hasGeminiApiKey() {
    return loadGeminiApiKey().then(() => true, () => false);
  }

  return {
    opencodeGo: loadOpenCodeGo,
    anthropic: loadAnthropic,
    geminiApiKey: loadGeminiApiKey,
    hasGeminiApiKey,
    agyAccessToken: loadAgyAccessToken,
    agyProjectId: getAgyProjectId,
  };
}

export function createSandboxProxy({
  dataDir,
  runDir,
  homeDir = os.homedir(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  credentials,
  upstreams = {},
  rateLimit = DEFAULT_RATE_LIMIT,
  log = console,
}) {
  const creds = credentials ?? createHostCredentialLoaders({ homeDir, env, fetchImpl });
  const endpoints = {
    opencodeGo: (upstreams.opencodeGo || OPENCODE_GO_DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    anthropic: (upstreams.anthropic || ANTHROPIC_DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    agyCloudcode: (upstreams.agyCloudcode || AGY_DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    agyGemini: (upstreams.agyGemini || GEMINI_DEFAULT_ENDPOINT).replace(/\/+$/, ""),
  };

  /** pubkey -> { token, server, sockPath, hits: number[] } */
  const agents = new Map();

  const sandboxDir = (pubkey) => path.join(runDir, "sandbox", pubkey.slice(0, 16));
  const sockPathFor = (pubkey) => path.join(sandboxDir(pubkey), "proxy.sock");
  const tokenFileFor = (pubkey) => path.join(dataDir, pubkey, "sandbox-token");

  async function ensureToken(pubkey) {
    const existing = agents.get(pubkey)?.token;
    if (existing) return existing;
    const file = tokenFileFor(pubkey);
    const saved = (await fs.readFile(file, "utf8").catch(() => "")).trim();
    if (/^bhs_[0-9a-f]{32}$/.test(saved)) return saved;
    const token = `bhs_${randomBytes(16).toString("hex")}`;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${token}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
    return token;
  }

  function checkRateLimit(entry) {
    const now = Date.now();
    const cutoff = now - RATE_WINDOW_MS;
    while (entry.hits.length && entry.hits[0] < cutoff) entry.hits.shift();
    if (entry.hits.length >= rateLimit) return false;
    entry.hits.push(now);
    return true;
  }

  async function forwardUpstream({ req, res, targetUrl, extraHeaders, bodyBuf }) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      if (lower === "authorization" || lower === "x-api-key" || lower === "x-goog-api-key") continue;
      if (Array.isArray(v)) {
        for (const item of v) headers.append(lower, item);
      } else if (v !== undefined) {
        headers.set(lower, v);
      }
    }
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v !== undefined && v !== null) headers.set(k, v);
    }

    const method = (req.method || "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && bodyBuf && bodyBuf.length > 0;
    const upstreamResp = await fetchImpl(targetUrl, {
      method,
      headers,
      body: hasBody ? bodyBuf : undefined,
      redirect: "manual",
    });

    const outHeaders = {};
    for (const [k, v] of upstreamResp.headers.entries()) {
      const lower = k.toLowerCase();
      if (HOP_BY_HOP.has(lower)) continue;
      // Node fetch decompresses transparently; strip content-encoding so clients don't double-decode.
      if (lower === "content-encoding") continue;
      outHeaders[lower] = v;
    }
    res.writeHead(upstreamResp.status, outHeaders);
    if (!upstreamResp.body || method === "HEAD") {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(upstreamResp.body);
    stream.on("error", () => {
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);
  }

  async function handleRequest(pubkey, entry, req, res) {
    try {
      if (!checkRateLimit(entry)) {
        return sendJson(res, 429, { error: { message: "Sandbox proxy rate limit exceeded" } });
      }
      const rawUrl = req.url || "/";
      const parsed = new URL(rawUrl, "http://sandbox-proxy.local");
      const pathname = parsed.pathname;
      const search = parsed.search || "";
      const method = (req.method || "GET").toUpperCase();

      // 1. Antigravity synthetic OAuth token exchange (validates agent's refresh_token).
      if (pathname === "/agy/token" && method === "POST") {
        const bodyBuf = await readBodyBuffer(req, 64 * 1024);
        const text = bodyBuf.toString("utf8");
        let refreshToken = "";
        const ct = String(req.headers["content-type"] || "").toLowerCase();
        if (ct.includes("application/json")) {
          try {
            refreshToken = String(JSON.parse(text)?.refresh_token || "");
          } catch {}
        } else {
          refreshToken = new URLSearchParams(text).get("refresh_token") || "";
        }
        if (!safeEqual(refreshToken, entry.token)) {
          return sendJson(res, 401, { error: "invalid_grant", error_description: "Invalid sandbox token" });
        }
        return sendJson(res, 200, {
          access_token: entry.token,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }

      // 2. Claude Code connectivity health probe (`HEAD /anthropic/api/hello` sends no auth header).
      if (pathname === "/anthropic/api/hello" && (method === "HEAD" || method === "GET")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(method === "HEAD" ? undefined : "{}");
        return;
      }

      // All inference/provider routes require the per-agent opaque proxy token.
      const presented = extractProxyToken(req.headers);
      if (!safeEqual(presented, entry.token)) {
        return sendJson(res, 401, { error: { message: "Unauthorized sandbox proxy token" } });
      }

      // 3. Hermes + OpenCode Go: /opencode-go/* -> https://opencode.ai/zen/go/*
      if (pathname.startsWith("/opencode-go/")) {
        const suffix = pathname.slice("/opencode-go".length);
        const { apiKey } = await creds.opencodeGo();
        const bodyBuf = method === "GET" || method === "HEAD" ? null : await readBodyBuffer(req);
        await forwardUpstream({
          req,
          res,
          targetUrl: `${endpoints.opencodeGo}${suffix}${search}`,
          extraHeaders: { authorization: `Bearer ${apiKey}` },
          bodyBuf,
        });
        return;
      }

      // 4. Claude Code: /anthropic/* -> https://api.anthropic.com/*
      if (pathname.startsWith("/anthropic/")) {
        const suffix = pathname.slice("/anthropic".length);
        const auth = await creds.anthropic();
        const extraHeaders =
          auth.mode === "api-key"
            ? { "x-api-key": auth.value }
            : { authorization: `Bearer ${auth.value}` };
        const bodyBuf = method === "GET" || method === "HEAD" ? null : await readBodyBuffer(req);
        await forwardUpstream({
          req,
          res,
          targetUrl: `${endpoints.anthropic}${suffix}${search}`,
          extraHeaders,
          bodyBuf,
        });
        return;
      }

      // 5. Antigravity Cloud Code API: /agy/cloudcode/* -> https://daily-cloudcode-pa.googleapis.com/*
      if (pathname.startsWith("/agy/cloudcode/")) {
        const suffix = pathname.slice("/agy/cloudcode".length);
        const accessToken = await creds.agyAccessToken(false);
        const bodyBuf = method === "GET" || method === "HEAD" ? null : await readBodyBuffer(req);
        await forwardUpstream({
          req,
          res,
          targetUrl: `${endpoints.agyCloudcode}${suffix}${search}`,
          extraHeaders: { authorization: `Bearer ${accessToken}` },
          bodyBuf,
        });
        return;
      }

      // 6. Antigravity Gemini Developer API: /agy/gemini/* -> https://generativelanguage.googleapis.com/*
      if (pathname.startsWith("/agy/gemini/")) {
        const suffix = pathname.slice("/agy/gemini".length);
        const { apiKey } = await creds.geminiApiKey();
        const bodyBuf = method === "GET" || method === "HEAD" ? null : await readBodyBuffer(req);
        await forwardUpstream({
          req,
          res,
          targetUrl: `${endpoints.agyGemini}${suffix}${search}`,
          extraHeaders: { "x-goog-api-key": apiKey },
          bodyBuf,
        });
        return;
      }

      sendJson(res, 404, { error: { message: `Unknown sandbox proxy route: ${pathname}` } });
    } catch (error) {
      const code = error?.statusCode || 502;
      log.warn?.(`sandbox-proxy [${pubkey.slice(0, 8)}]: ${error.message}`);
      if (!res.headersSent) {
        sendJson(res, code, { error: { message: error.message || "Proxy error" } });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }

  async function ensureAgent(pubkey) {
    if (!HEX64.test(pubkey)) throw new Error("Invalid agent pubkey");
    const token = await ensureToken(pubkey);
    const sockPath = sockPathFor(pubkey);
    const existing = agents.get(pubkey);
    if (existing && existing.server.listening) {
      return { token, sockPath };
    }

    await fs.mkdir(path.dirname(sockPath), { recursive: true, mode: 0o700 });
    await fs.rm(sockPath, { force: true });

    const entry = { token, sockPath, server: null, hits: [] };
    const server = createServer((req, res) => {
      void handleRequest(pubkey, entry, req, res);
    });
    entry.server = server;

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, resolve);
    });
    await fs.chmod(sockPath, 0o600);
    agents.set(pubkey, entry);
    return { token, sockPath };
  }

  async function removeAgent(pubkey) {
    const entry = agents.get(pubkey);
    agents.delete(pubkey);
    if (entry?.server) {
      await new Promise((resolve) => entry.server.close(() => resolve()));
    }
    await fs.rm(sockPathFor(pubkey), { force: true }).catch(() => {});
  }

  async function close() {
    await Promise.all([...agents.keys()].map((pubkey) => removeAgent(pubkey)));
  }

  return {
    ensureAgent,
    removeAgent,
    close,
    sockPathFor,
    getAgyProjectId: () => creds.agyProjectId?.() ?? Promise.resolve(""),
    hasGeminiApiKey: () => creds.hasGeminiApiKey?.() ?? Promise.resolve(false),
  };
}
