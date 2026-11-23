// node --test server/sandbox/sandbox.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  assertSandboxRestrictions,
  createRunnerManager,
  isSandboxed,
  normalizeAllowlist,
  normalizeRespondTo,
  normalizeRunner,
} from "./index.mjs";
import { createSandboxProxy, parseDotEnvValue } from "./proxy.mjs";
import { createSandboxMcpBridge, isAllowedSandboxTool } from "./mcp-bridge.mjs";
import { buildDockerArgs, containerName, prepareSandboxHome, writeSandboxEnv } from "./docker.mjs";

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);
const OWNER = "1".repeat(64);

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function unixHttpRequest(sockPath, { method = "GET", path: reqPath = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: sockPath,
        method,
        path: reqPath,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function unixJsonLine(sockPath, payload) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(sockPath);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify(payload)}\n`));
    sock.on("data", (chunk) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, idx)));
      }
    });
    sock.on("error", reject);
  });
}

test("runner and respondTo policy enforces sandbox invariant and allowlist validation", () => {
  assert.equal(normalizeRespondTo(undefined), "owner-only");
  assert.equal(normalizeRespondTo("ALLOWLIST"), "allowlist");
  assert.equal(normalizeRespondTo("anyone"), "anyone");
  assert.throws(() => normalizeRespondTo("everybody"), /Invalid respondTo/);

  // Auto-selects docker when respondTo != owner-only and runner is omitted.
  assert.equal(normalizeRunner(undefined, "owner-only"), "host");
  assert.equal(normalizeRunner(undefined, "anyone"), "docker");
  assert.equal(normalizeRunner("", "allowlist"), "docker");
  assert.equal(normalizeRunner("docker", "owner-only"), "docker");

  // Explicitly requesting host with shared access fails closed.
  assert.throws(() => normalizeRunner("host", "anyone"), /must use a sandboxed runner/);
  assert.throws(() => normalizeRunner("host", "allowlist"), /must use a sandboxed runner/);

  // OpenShell stub is registered but clearly refused until installed.
  assert.throws(() => normalizeRunner("openshell", "anyone"), /OpenShell/);
  assert.throws(() => normalizeRunner("unknown", "owner-only"), /Unknown runner/);

  // Allowlist normalization: deduplicates, lowercases, accepts string or array, rejects bad keys.
  assert.deepEqual(
    normalizeAllowlist(`${PUBKEY_A.toUpperCase()}, ${PUBKEY_B}\n${PUBKEY_A}`),
    [PUBKEY_A, PUBKEY_B],
  );
  assert.throws(() => normalizeAllowlist(["not-a-pubkey"]), /Invalid pubkey/);

  // Sandboxed agents cannot enable host desktop or orchestrator.
  assert.equal(isSandboxed({ runner: "host" }), false);
  assert.equal(isSandboxed({ runner: "docker" }), true);
  assert.doesNotThrow(() => assertSandboxRestrictions({ runner: "host", desktop: true, orchestrate: true }));
  assert.throws(() => assertSandboxRestrictions({ runner: "docker", desktop: true }), /host desktop/);
  assert.throws(() => assertSandboxRestrictions({ runner: "docker", orchestrate: true }), /host orchestration/);
});

test("parseDotEnvValue parses quoted, unquoted, and export dotenv lines", () => {
  const sample = [
    "# OPENCODE_GO_API_KEY=commented",
    "export OPENCODE_GO_API_KEY='real-secret-123'",
    'OTHER_KEY="abc"',
  ].join("\n");
  assert.equal(parseDotEnvValue(sample, "OPENCODE_GO_API_KEY"), "real-secret-123");
  assert.equal(parseDotEnvValue(sample, "OTHER_KEY"), "abc");
  assert.equal(parseDotEnvValue(sample, "MISSING"), "");
});

test("host credential proxy authenticates per-agent tokens and swaps real credentials for OpenCode Go, Claude, and Antigravity", async (t) => {
  const tmp = await makeTempDir("buzz-sandbox-proxy-");
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const upstreamCalls = [];
  let agyRefreshCalls = 0;

  const mockFetch = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const bodyText = init.body ? Buffer.from(init.body).toString("utf8") : "";
    upstreamCalls.push({ url, method: init.method, headers, bodyText });

    if (url === "https://opencode.example/zen/go/v1/chat/completions") {
      return new Response(JSON.stringify({ ok: true, provider: "opencode-go" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://anthropic.example/v1/messages?beta=true") {
      return new Response("event: ping\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url === "https://cloudcode.example/v1internal:loadCodeAssist") {
      return new Response(JSON.stringify({ tier: "pro" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://gemini.example/v1beta/models/gemini-4-neon:generateContent") {
      return new Response(JSON.stringify({ ok: true, provider: "gemini" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected", { status: 500 });
  };

  const proxy = createSandboxProxy({
    dataDir: path.join(tmp, "data"),
    runDir: path.join(tmp, "run"),
    fetchImpl: mockFetch,
    upstreams: {
      opencodeGo: "https://opencode.example/zen/go",
      anthropic: "https://anthropic.example",
      agyCloudcode: "https://cloudcode.example",
      agyGemini: "https://gemini.example",
    },
    credentials: {
      opencodeGo: async () => ({ apiKey: "REAL_OPENCODE_SECRET" }),
      anthropic: async () => ({ mode: "oauth", value: "REAL_CLAUDE_OAUTH_SECRET" }),
      geminiApiKey: async () => ({ apiKey: "REAL_GEMINI_API_SECRET" }),
      hasGeminiApiKey: async () => true,
      agyAccessToken: async () => {
        agyRefreshCalls += 1;
        return "REAL_GOOGLE_ACCESS_SECRET";
      },
      agyProjectId: async () => "my-agy-project",
    },
    rateLimit: 20,
    log: { warn() {} },
  });
  t.after(() => proxy.close());

  const { token, sockPath } = await proxy.ensureAgent(PUBKEY_A);
  assert.match(token, /^bhs_[0-9a-f]{32}$/);

  // 1. Missing/wrong token is rejected with 401.
  const badAuth = await unixHttpRequest(sockPath, {
    method: "POST",
    path: "/opencode-go/v1/chat/completions",
    headers: { authorization: "Bearer wrong_token" },
    body: "{}",
  });
  assert.equal(badAuth.status, 401);

  // 2. OpenCode Go route swaps fake bearer token for real host API key.
  const oc = await unixHttpRequest(sockPath, {
    method: "POST",
    path: "/opencode-go/v1/chat/completions",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4.1-flash" }),
  });
  assert.equal(oc.status, 200);
  assert.equal(JSON.parse(oc.body).provider, "opencode-go");
  assert.equal(upstreamCalls.at(-1).headers.authorization, "Bearer REAL_OPENCODE_SECRET");
  assert.ok(!oc.body.includes("REAL_OPENCODE_SECRET"));

  // 3. Claude Code connectivity probe HEAD /anthropic/api/hello succeeds without auth.
  const hello = await unixHttpRequest(sockPath, { method: "HEAD", path: "/anthropic/api/hello" });
  assert.equal(hello.status, 200);

  // 4. Claude Code /anthropic/v1/messages swaps fake OAuth token for real host OAuth token & streams SSE.
  const claude = await unixHttpRequest(sockPath, {
    method: "POST",
    path: "/anthropic/v1/messages?beta=true",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "claude-sonnet" }),
  });
  assert.equal(claude.status, 200);
  assert.match(claude.body, /event: ping/);
  assert.equal(upstreamCalls.at(-1).headers.authorization, "Bearer REAL_CLAUDE_OAUTH_SECRET");
  assert.equal(upstreamCalls.at(-1).headers["anthropic-beta"], "oauth-2025-04-20");

  // 5. Antigravity /agy/token rejects wrong refresh_token and issues synthetic token for valid one.
  const badToken = await unixHttpRequest(sockPath, {
    method: "POST",
    path: "/agy/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=refresh_token&refresh_token=bogus",
  });
  assert.equal(badToken.status, 401);

  const okToken = await unixHttpRequest(sockPath, {
    method: "POST",
    path: "/agy/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${token}`,
  });
  assert.equal(okToken.status, 200);
  assert.equal(JSON.parse(okToken.body).access_token, token);

  // 6. Antigravity /agy/cloudcode/* swaps fake bearer for real Google access token.
  const agy = await unixHttpRequest(sockPath, {
    method: "POST",
    path: "/agy/cloudcode/v1internal:loadCodeAssist",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ project: "my-agy-project" }),
  });
  assert.equal(agy.status, 200);
  assert.equal(JSON.parse(agy.body).tier, "pro");
  assert.equal(upstreamCalls.at(-1).headers.authorization, "Bearer REAL_GOOGLE_ACCESS_SECRET");
  assert.equal(agyRefreshCalls, 1);

  // 6b. Antigravity /agy/gemini/* swaps x-goog-api-key for real host GEMINI_API_KEY.
  const gem = await unixHttpRequest(sockPath, {
    method: "POST",
    path: "/agy/gemini/v1beta/models/gemini-4-neon:generateContent",
    headers: { "x-goog-api-key": token, "content-type": "application/json" },
    body: JSON.stringify({ contents: [] }),
  });
  assert.equal(gem.status, 200);
  assert.equal(JSON.parse(gem.body).provider, "gemini");
  assert.equal(upstreamCalls.at(-1).headers["x-goog-api-key"], "REAL_GEMINI_API_SECRET");

  // 7. Unknown route returns 404.
  const missing = await unixHttpRequest(sockPath, {
    method: "GET",
    path: "/evil/ssrf",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(missing.status, 404);
});

test("host credential proxy enforces per-agent rate limit", async (t) => {
  const tmp = await makeTempDir("buzz-sandbox-rl-");
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const proxy = createSandboxProxy({
    dataDir: path.join(tmp, "data"),
    runDir: path.join(tmp, "run"),
    rateLimit: 2,
    log: { warn() {} },
  });
  t.after(() => proxy.close());

  const { sockPath } = await proxy.ensureAgent(PUBKEY_A);
  const r1 = await unixHttpRequest(sockPath, { method: "HEAD", path: "/anthropic/api/hello" });
  const r2 = await unixHttpRequest(sockPath, { method: "HEAD", path: "/anthropic/api/hello" });
  const r3 = await unixHttpRequest(sockPath, { method: "HEAD", path: "/anthropic/api/hello" });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 429);
});

test("scoped MCP bridge pins pubkey server-side, allows memory/optional attention, and blocks host tools", async (t) => {
  const tmp = await makeTempDir("buzz-sandbox-mcp-");
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  let attentionEnabled = false;
  const seenCalls = [];
  const bridge = createSandboxMcpBridge({
    runDir: path.join(tmp, "run"),
    isAttentionEnabled: async () => attentionEnabled,
    callTool: async (pubkey, name, args) => {
      seenCalls.push({ pubkey, name, args });
      return `ok:${pubkey.slice(0, 4)}:${name}`;
    },
    log: { warn() {} },
  });
  t.after(() => bridge.close());

  const { sockPath } = await bridge.ensureAgent(PUBKEY_A);

  // Spoofed pubkey in payload is ignored; server pins PUBKEY_A.
  const mem = await unixJsonLine(sockPath, { pubkey: PUBKEY_B, name: "mem_get", args: { slug: "core" } });
  assert.equal(mem.result, `ok:${PUBKEY_A.slice(0, 4)}:mem_get`);
  assert.equal(seenCalls.at(-1).pubkey, PUBKEY_A);

  // Attention tools blocked while Attention is off.
  const attOff = await unixJsonLine(sockPath, { name: "interest_list", args: {} });
  assert.match(attOff.error, /not permitted/);
  assert.equal(isAllowedSandboxTool("interest_list", { attentionEnabled: false }), false);

  // Attention tools allowed once enabled.
  attentionEnabled = true;
  const attOn = await unixJsonLine(sockPath, { name: "interest_list", args: {} });
  assert.equal(attOn.result, `ok:${PUBKEY_A.slice(0, 4)}:interest_list`);

  // Host-only tools (orchestrator, hermes profile, unknown) are ALWAYS blocked.
  for (const blocked of ["orch_delegate", "orch_capabilities", "_ensure_hermes_profile", "desktop_click"]) {
    const res = await unixJsonLine(sockPath, { name: blocked, args: {} });
    assert.match(res.error, /not permitted/, `${blocked} should be blocked`);
  }
});

test("Docker sandbox config and args harden container and never leak host secrets or meta.json", async (t) => {
  const tmp = await makeTempDir("buzz-sandbox-docker-");
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const agentDir = path.join(tmp, "agents", PUBKEY_A);
  const sandboxRunDir = path.join(tmp, "run", "sandbox", PUBKEY_A.slice(0, 16));
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(sandboxRunDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "key"), "f".repeat(64) + "\n", { mode: 0o600 });
  await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(["auth", OWNER, "sig", "0".repeat(128)]), {
    mode: 0o600,
  });

  const proxyToken = "bhs_" + "9".repeat(32);
  const sandboxHome = await prepareSandboxHome({
    agentDir,
    pubkey: PUBKEY_A,
    model: "opencode-go:deepseek-v4.1-flash",
    proxyToken,
    agyProjectId: "proj-123",
  });

  const hermesYaml = await fs.readFile(path.join(sandboxHome, ".hermes/config.yaml"), "utf8");
  const hermesEnv = await fs.readFile(path.join(sandboxHome, ".hermes/.env"), "utf8");
  const agySettings = JSON.parse(
    await fs.readFile(path.join(sandboxHome, ".gemini/antigravity-acp/settings.json"), "utf8"),
  );
  const agyToken = JSON.parse(
    await fs.readFile(path.join(sandboxHome, ".gemini/antigravity-acp/acp_token.json"), "utf8"),
  );
  assert.match(hermesYaml, /http:\/\/127\.0\.0\.1:18461\/opencode-go\/v1/);
  assert.match(hermesEnv, new RegExp(`OPENCODE_GO_API_KEY=${proxyToken}`));
  assert.deepEqual(agySettings, { auth: { type: "oauth-personal" } });
  assert.equal(agyToken.token_uri, "http://127.0.0.1:18461/agy/token");
  assert.equal(agyToken.refresh_token, proxyToken);
  assert.equal(agyToken.project_id, "proj-123");

  const envFile = await writeSandboxEnv({
    agentDir,
    sandboxRunDir,
    pubkey: PUBKEY_A,
    meta: {
      community: "wss://omarchy.tail65c5a9.ts.net",
      owner: OWNER,
      runtime: "hermes",
      model: "",
      concurrency: 2,
      respondTo: "anyone",
      respondToAllowlist: [],
      hasInstructions: true,
    },
    proxyToken,
    withAttention: false,
  });
  const envContent = await fs.readFile(envFile, "utf8");
  assert.match(envContent, /BUZZ_ACP_RESPOND_TO=anyone/);
  assert.match(envContent, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:18461\/anthropic/);
  assert.match(envContent, new RegExp(`CLAUDE_CODE_OAUTH_TOKEN=${proxyToken}`));
  assert.match(envContent, /BUZZ_HOST_SANDBOX=1/);

  const args = buildDockerArgs({
    pubkey: PUBKEY_A,
    agentDir,
    workspaceDir: path.join(tmp, "work", PUBKEY_A),
    sandboxRunDir,
    controlDir: path.join(tmp, "run", `${PUBKEY_A.slice(0, 16)}.d`),
    libDir: "/opt/host-lib",
    agyBinaryPath: "/opt/host-agy",
    hasInstructions: true,
    uid: 1000,
    gid: 1000,
  });

  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges:true"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--dns"));
  assert.ok(args.includes("1.1.1.1"));
  assert.ok(args.includes("--dns-search"));
  assert.ok(args.includes("--user"));
  assert.ok(args.includes("1000:1000"));
  assert.ok(args.includes("--env-file"));
  assert.ok(args.includes(containerName(PUBKEY_A)));
  // Secrets must NOT appear in CLI argv, and agentDir itself must NOT be mounted directly.
  assert.ok(!args.join(" ").includes(proxyToken));
  assert.ok(!args.includes(`${agentDir}:`));
  assert.ok(args.includes(`${path.join(agentDir, "instructions.md")}:/run/buzz-sandbox/instructions.md:ro`));
  assert.ok(args.includes("/opt/host-agy:/opt/antigravity/agy:ro"));
});

test("runnerManager prepares and cleans up a docker agent cleanly", async (t) => {
  const tmp = await makeTempDir("buzz-sandbox-mgr-");
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const dataDir = path.join(tmp, "data");
  const runDir = path.join(tmp, "run");
  const workDir = path.join(tmp, "work");
  const agentDir = path.join(dataDir, PUBKEY_A);
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "key"), "e".repeat(64) + "\n", { mode: 0o600 });
  await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(["auth", OWNER, "sig", "0".repeat(128)]), {
    mode: 0o600,
  });

  const mgr = createRunnerManager({
    dataDir,
    runDir,
    workDir,
    libDir: "/opt/lib",
    homeDir: tmp,
    callTool: async () => "ok",
    isAttentionEnabled: async () => false,
    log: { warn() {}, error() {} },
  });
  t.after(() => mgr.close());

  const prepared = await mgr.prepareAgent(PUBKEY_A, {
    pubkey: PUBKEY_A,
    owner: OWNER,
    community: "wss://omarchy.tail65c5a9.ts.net",
    runtime: "claude",
    model: "",
    concurrency: 2,
    runner: "docker",
    respondTo: "anyone",
    respondToAllowlist: [],
    hasInstructions: false,
  });

  assert.ok(prepared);
  await fs.access(path.join(prepared.sandboxRunDir, "proxy.sock"));
  await fs.access(path.join(prepared.sandboxRunDir, "mcp.sock"));
  await fs.access(prepared.envFile);

  await mgr.cleanupAgent(PUBKEY_A);
  await assert.rejects(() => fs.access(path.join(prepared.sandboxRunDir, "proxy.sock")));
});
