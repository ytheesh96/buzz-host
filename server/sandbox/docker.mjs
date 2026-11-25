// Hardened Docker container runner for sandboxed buzz-host agents.
//
// Security properties:
//   - Non-root execution matching the host user's numeric UID:GID (so workspace
//     files remain owned cleanly without root escalation)
//   - --cap-drop=ALL, --security-opt=no-new-privileges:true, --read-only rootfs
//   - Resource bounds: --pids-limit, --memory, --cpus
//   - Strictly isolated bind mounts: ONLY this agent's workspace, its isolated
//     sandbox-home, its per-agent /run/buzz-sandbox sockets/dirs, and read-only
//     buzz-host runtime tools
//   - Egress: own bridge network (buzzsbx0, no inter-container traffic) behind a
//     root nftables table (firewall/) that drops traffic to this host, RFC1918,
//     the tailnet (100.64/10), link-local and multicast; docker-run refuses to
//     start while that unit is inactive
//   - Zero host API keys / OAuth credentials in the container: all LLM traffic
//     flows through 127.0.0.1:18461 -> /run/buzz-sandbox/proxy.sock -> host proxy

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);

export const DEFAULT_DOCKER_IMAGE = "buzz-host-sandbox:latest";
export const CONTAINER_PROXY_PORT = 18461;
export const DEFAULT_DOCKER_MEMORY = "1536m";
export const DEFAULT_DOCKER_CPUS = "2";
export const DEFAULT_DOCKER_PIDS_LIMIT = 256;
/** Dedicated bridge network; firewall/buzz-sandbox.nft matches its bridge name. */
export const SANDBOX_NETWORK = "buzz-sandbox";
export const SANDBOX_BRIDGE = "buzzsbx0";
export const SANDBOX_FIREWALL_UNIT = "buzz-sandbox-firewall.service";

const CONTAINER_SHIMS = {
  claude: "/opt/buzz-host/sandbox/container-shims/claude-agent-acp",
  hermes: "/opt/buzz-host/sandbox/container-shims/hermes-acp",
  antigravity: "/opt/buzz-host/sandbox/container-shims/antigravity-acp",
  codex: "/opt/buzz-host/sandbox/container-shims/codex-acp",
};

export function containerName(pubkey) {
  return `buzz-agent-${pubkey.slice(0, 16)}`;
}

export function containerShimFor(runtime) {
  const shim = CONTAINER_SHIMS[runtime];
  if (!shim) throw new Error(`Unsupported sandbox runtime: ${runtime}`);
  return shim;
}

async function writePrivate(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Write isolated container-side config files for Hermes, Claude Code, and Antigravity.
 *  Contains ONLY the synthetic proxy token and 127.0.0.1 proxy URLs — never host secrets. */
export async function prepareSandboxHome({
  agentDir,
  pubkey,
  model = "",
  proxyToken,
  agyProjectId = "",
  useGeminiApiKey = false,
  proxyPort = CONTAINER_PROXY_PORT,
}) {
  const sandboxHome = path.join(agentDir, "sandbox-home");
  const hermesDir = path.join(sandboxHome, ".hermes");
  const claudeDir = path.join(sandboxHome, ".claude");
  const agyDir = path.join(sandboxHome, ".gemini", "antigravity-acp");
  const agyCliDir = path.join(sandboxHome, ".gemini", "antigravity-cli");
  const agyGuardPluginDir = path.join(sandboxHome, ".gemini", "config", "plugins", "buzz-host-guards");

  await Promise.all([
    fs.mkdir(hermesDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(claudeDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(agyDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(agyCliDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(agyGuardPluginDir, { recursive: true, mode: 0o700 }),
  ]);

  const proxyBase = `http://127.0.0.1:${proxyPort}`;
  const defaultHermesModel =
    model && !model.includes("::") ? model.replace(/^opencode-go:/, "") : "deepseek-v4.1-flash";

  // Hermes config + .env pointing strictly to the container-local proxy bridge.
  // Disable Hermes's built-in cronjob toolset so scheduled wakes go through Buzz Attention.
  const hermesConfig = [
    "model:",
    `  default: ${JSON.stringify(defaultHermesModel)}`,
    "  provider: opencode-go",
    `  base_url: '${proxyBase}/opencode-go/v1'`,
    "  api_mode: chat_completions",
    "terminal:",
    "  backend: local",
    "  cwd: /workspace",
    "  timeout: 180",
    "agent:",
    "  max_turns: 200",
    "  verbose: false",
    "  disabled_toolsets:",
    "    - cronjob",
    "",
  ].join("\n");
  await writePrivate(path.join(hermesDir, "config.yaml"), hermesConfig);

  const hermesEnv = [
    `OPENCODE_GO_API_KEY=${proxyToken}`,
    `OPENCODE_GO_BASE_URL=${proxyBase}/opencode-go/v1`,
    `BUZZHOST_AGENT=${pubkey}`,
    "",
  ].join("\n");
  await writePrivate(path.join(hermesDir, ".env"), hermesEnv);

  // Claude Code settings + onboarding flag (no credentials here; CLAUDE_CODE_OAUTH_TOKEN + ANTHROPIC_BASE_URL passed via env).
  await writePrivate(
    path.join(claudeDir, "settings.json"),
    `${JSON.stringify({ skipDangerousModePermissionPrompt: true }, null, 2)}\n`,
  );
  await writePrivate(
    path.join(sandboxHome, ".claude.json"),
    `${JSON.stringify({ hasCompletedOnboarding: true, numStartups: 1 }, null, 2)}\n`,
  );

  // Antigravity settings: prefer headless gemini-api-key mode via host proxy when
  // GEMINI_API_KEY is configured on host; otherwise configure synthetic OAuth metadata.
  await writePrivate(
    path.join(agyDir, "settings.json"),
    `${JSON.stringify({ auth: { type: useGeminiApiKey ? "gemini-api-key" : "oauth-personal" } }, null, 2)}\n`,
  );
  if (useGeminiApiKey) {
    await writePrivate(
      path.join(agyCliDir, "settings.json"),
      `${JSON.stringify({ modelProvider: "gemini" }, null, 2)}\n`,
    );
  }
  await writePrivate(
    path.join(agyDir, "acp_token.json"),
    `${JSON.stringify(
      {
        client_id: "buzz-sandbox-client",
        client_secret: "buzz-sandbox-secret",
        project_id: agyProjectId || "buzz-sandbox",
        refresh_token: proxyToken,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        token_uri: `${proxyBase}/agy/token`,
      },
      null,
      2,
    )}\n`,
  );

  // Antigravity PreToolUse guard plugin: denies built-in `schedule` so
  // background timers/crons go through Buzz Attention instead.
  await writePrivate(
    path.join(agyGuardPluginDir, "plugin.json"),
    `${JSON.stringify({ name: "buzz-host-guards" }, null, 2)}\n`,
  );
  await writePrivate(
    path.join(agyGuardPluginDir, "hooks.json"),
    `${JSON.stringify(
      {
        "buzz-host-no-schedule": {
          PreToolUse: [
            {
              matcher: "schedule",
              hooks: [{ type: "command", command: "./deny-schedule.sh", timeout: 5 }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  const denyScript = path.join(agyGuardPluginDir, "deny-schedule.sh");
  await writePrivate(
    denyScript,
    "#!/bin/sh\ncat >/dev/null\n" +
      "printf '%s\\n' '{\"decision\":\"deny\",\"reason\":\"Runtime scheduling (schedule) is disabled for Buzz agents because it wakes invisibly outside Buzz. Use Buzz Attention (interest_set + watch_add) instead so your owner has visibility in Buzz, or tell your owner if Attention is off.\"}'\n",
  );
  await fs.chmod(denyScript, 0o755);

  return sandboxHome;
}

/** Write the container `--env-file` (0600 on host) and the stripped-shell `agent-creds.env`
 *  so secrets never appear in `docker run` CLI argv. */
export async function writeSandboxEnv({
  agentDir,
  sandboxRunDir,
  pubkey,
  meta,
  proxyToken,
  withAttention = false,
  useGeminiApiKey = false,
  proxyPort = CONTAINER_PROXY_PORT,
}) {
  const proxyBase = `http://127.0.0.1:${proxyPort}`;
  const key = (await fs.readFile(path.join(agentDir, "key"), "utf8")).trim();
  const authTag = (await fs.readFile(path.join(agentDir, "auth.json"), "utf8")).trim();

  const adaptersJson = JSON.stringify({
    claude: ["claude-agent-acp"],
    hermes: ["/usr/local/bin/hermes-acp"],
    antigravity: [
      "/opt/antigravity/agy",
      "acp",
      "--dangerously-skip-permissions",
      "--disable-telemetry",
      "--cloud_code_endpoint",
      `${proxyBase}/agy/cloudcode`,
    ],
  });

  const envEntries = {
    HOME: "/home/agent",
    USER: "agent",
    PATH: "/opt/buzz-host/sandbox/container-bin:/opt/buzz-host/bin:/usr/local/bin:/usr/bin:/bin",
    BUZZ_HOST_SANDBOX: "1",
    BUZZ_HOST_AGENT: pubkey,
    BUZZHOST_AGENT: pubkey,
    BUZZ_MANAGED_AGENT: pubkey,
    BUZZ_HOST_LIB: "/opt/buzz-host",
    BUZZ_HOST_AGENT_DIR: "/run/buzz-sandbox/agent",
    BUZZ_HOST_CONTROL_DIR: "/run/buzz-sandbox/control",
    BUZZ_HOST_CONTROL_SOCK: "/run/buzz-sandbox/control.sock",
    BUZZ_HOST_MCP_SOCK: "/run/buzz-sandbox/mcp.sock",
    BUZZ_SANDBOX_PROXY_SOCK: "/run/buzz-sandbox/proxy.sock",
    BUZZ_SANDBOX_PROXY_PORT: String(proxyPort),
    BUZZ_SANDBOX_ATTENTION: withAttention ? "1" : "0",
    BUZZ_HOST_ADAPTERS_JSON: adaptersJson,
    BUZZ_RELAY_URL: meta.community,
    BUZZ_PRIVATE_KEY: key,
    BUZZ_AUTH_TAG: authTag,
    BUZZ_ACP_AGENT_OWNER: meta.owner,
    BUZZ_ACP_AGENT_COMMAND: containerShimFor(meta.runtime),
    BUZZ_ACP_AGENTS: String(meta.concurrency ?? 4),
    BUZZ_ACP_MODEL: meta.model || "",
    BUZZ_ACP_RESPOND_TO: meta.respondTo || "owner-only",
    BUZZ_ACP_RESPOND_TO_ALLOWLIST:
      meta.respondTo === "allowlist" && Array.isArray(meta.respondToAllowlist)
        ? meta.respondToAllowlist.join(",")
        : "",
    BUZZ_ACP_SESSION_POLICY: "thread",
    BUZZ_ACP_RELAY_OBSERVER: "true",
    BUZZ_ACP_LAZY_POOL: meta.lazyPool === false ? "" : "true",
    BUZZ_ACP_IDLE_POOL_SLEEP: meta.lazyPool === false ? "" : String(meta.idlePoolSleepSecs ?? 300),
    BUZZ_ACP_FRESH_SESSION_DIR: "/run/buzz-sandbox/fresh",
    BUZZ_ACP_WAKE_DIR: "/run/buzz-sandbox/wake",
    BUZZ_ACP_SYSTEM_PROMPT_FILE: meta.hasInstructions ? "/run/buzz-sandbox/instructions.md" : "",
    BUZZ_ACP_MCP_COMMAND: "/opt/buzz-host/sandbox/container-bin/buzz-mcp",
    // Provider proxy endpoints + synthetic per-agent token (zero host secrets).
    OPENCODE_GO_API_KEY: proxyToken,
    OPENCODE_GO_BASE_URL: `${proxyBase}/opencode-go/v1`,
    HERMES_HOME: "/home/agent/.hermes",
    HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
    ANTHROPIC_BASE_URL: `${proxyBase}/anthropic`,
    CLAUDE_CODE_OAUTH_TOKEN: proxyToken,
    CLAUDE_CODE_DISABLE_CRON: "1",
    BUZZ_SANDBOX_AGY_ENDPOINT: `${proxyBase}/agy/cloudcode`,
    ...(useGeminiApiKey
      ? {
          GEMINI_API_KEY: proxyToken,
          GOOGLE_GEMINI_BASE_URL: `${proxyBase}/agy/gemini`,
        }
      : {}),
  };

  // Docker --env-file format: raw KEY=VALUE lines (no shell quoting, no embedded newlines).
  const envLines = Object.entries(envEntries)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, "")}`);

  const envFile = path.join(agentDir, "sandbox.env");
  await writePrivate(envFile, `${envLines.join("\n")}\n`);

  // Also write agent-creds.env inside sandboxRunDir for container-bin/buzz
  // (Hermes strips BUZZ_* env vars from its terminal tool).
  const sq = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
  const credsLines = [
    `export BUZZ_PRIVATE_KEY=${sq(key)}`,
    `export BUZZ_AUTH_TAG=${sq(authTag)}`,
    `export BUZZ_RELAY_URL=${sq(meta.community.replace(/^ws/, "http"))}`,
  ].join("\n");
  await writePrivate(path.join(sandboxRunDir, "agent-creds.env"), `${credsLines}\n`);

  return envFile;
}

/** Build the hardened `docker run` argument array. Pure function for testability. */
export function buildDockerArgs({
  pubkey,
  agentDir,
  workspaceDir,
  sandboxRunDir,
  controlDir,
  libDir,
  agyBinaryPath = "",
  hasInstructions = false,
  image = DEFAULT_DOCKER_IMAGE,
  network = SANDBOX_NETWORK,
  memory = DEFAULT_DOCKER_MEMORY,
  cpus = DEFAULT_DOCKER_CPUS,
  pidsLimit = DEFAULT_DOCKER_PIDS_LIMIT,
  uid = process.getuid?.() ?? 1000,
  gid = process.getgid?.() ?? 1000,
}) {
  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    containerName(pubkey),
    "--user",
    `${uid}:${gid}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--read-only",
    "--network",
    network,
    "--dns",
    "1.1.1.1",
    "--dns",
    "8.8.8.8",
    "--dns-search",
    ".",
    `--pids-limit=${pidsLimit}`,
    `--memory=${memory}`,
    `--cpus=${cpus}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--tmpfs",
    "/var/tmp:rw,nosuid,nodev,size=128m",
    "--workdir",
    "/workspace",
    "--env-file",
    path.join(agentDir, "sandbox.env"),
    "-v",
    `${workspaceDir}:/workspace:rw`,
    "-v",
    `${path.join(agentDir, "sandbox-home")}:/home/agent:rw`,
    "-v",
    `${sandboxRunDir}:/run/buzz-sandbox:rw`,
    "-v",
    `${controlDir}:/run/buzz-sandbox/control:rw`,
    "-v",
    `${path.join(agentDir, "fresh")}:/run/buzz-sandbox/fresh:rw`,
    "-v",
    `${path.join(agentDir, "wake")}:/run/buzz-sandbox/wake:rw`,
    "-v",
    `${libDir}:/opt/buzz-host:ro`,
  ];

  if (hasInstructions) {
    args.push("-v", `${path.join(agentDir, "instructions.md")}:/run/buzz-sandbox/instructions.md:ro`);
  }
  if (agyBinaryPath) {
    args.push("-v", `${agyBinaryPath}:/opt/antigravity/agy:ro`);
  }

  args.push(image, "node", "/opt/buzz-host/sandbox/container-entry.mjs");
  return args;
}

let dockerAvailCache = null;

export async function checkDockerAvailability({ image = DEFAULT_DOCKER_IMAGE, fresh = false } = {}) {
  if (!fresh && dockerAvailCache && Date.now() - dockerAvailCache.at < 15_000) {
    return dockerAvailCache.value;
  }
  let daemonOk = false;
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5_000 });
    daemonOk = true;
  } catch {
    daemonOk = false;
  }
  let imageOk = false;
  if (daemonOk) {
    try {
      await run("docker", ["image", "inspect", image], { timeout: 5_000 });
      imageOk = true;
    } catch {
      imageOk = false;
    }
  }
  let firewallOk = false;
  try {
    await run("systemctl", ["is-active", "--quiet", SANDBOX_FIREWALL_UNIT], { timeout: 5_000 });
    firewallOk = true;
  } catch {
    firewallOk = false;
  }
  const value = {
    id: "docker",
    title: "Docker sandbox",
    available: daemonOk && imageOk && firewallOk,
    daemonAvailable: daemonOk,
    imageBuilt: imageOk,
    egressFilter: firewallOk,
    image,
    note: !daemonOk
      ? "Docker daemon is not reachable."
      : !imageOk
        ? `Image ${image} not built yet (run server/sandbox/build-image.sh).`
        : !firewallOk
          ? `Egress filter ${SANDBOX_FIREWALL_UNIT} is not active (run: sudo server/sandbox/install-firewall.sh).`
          : "Hardened container with host-side credential proxy and LAN/tailnet egress filter.",
  };
  dockerAvailCache = { at: Date.now(), value };
  return value;
}

export async function stopDockerContainer(pubkey) {
  const name = containerName(pubkey);
  await run("docker", ["rm", "-f", name], { timeout: 15_000 }).catch(() => {});
}
