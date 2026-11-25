// Pluggable sandbox runner registry & policy enforcement for buzz-host.
//
// Runners:
//   - "host":      native systemd process on the host (owner-only ONLY)
//   - "docker":    hardened Docker container + host-side credential proxy
//   - "openshell": reserved stub for future NVIDIA OpenShell VPS deployments
//
// Security invariant:
//   Any agent with respondTo !== "owner-only" ("allowlist" or "anyone") MUST
//   run in a sandboxed runner (never "host"), and sandboxed agents cannot
//   enable host orchestration or host Hermes profiles. A sandboxed agent may
//   have a desktop: it runs in its own sidecar container
//   (desktop-sidecar.mjs), never on the host.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSandboxProxy } from "./proxy.mjs";
import { createSandboxMcpBridge } from "./mcp-bridge.mjs";
import {
  DEFAULT_DOCKER_IMAGE,
  checkDockerAvailability,
  prepareSandboxHome,
  stopDockerContainer,
  writeSandboxEnv,
} from "./docker.mjs";
import { openshellRunner } from "./openshell.mjs";
import { remove as removeDesktopSidecar } from "./desktop-sidecar.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
export const MAX_ALLOWLIST = 200;

export const RESPOND_TO_MODES = new Set(["owner-only", "allowlist", "anyone"]);

export const RUNNERS = {
  host: { id: "host", title: "Host (owner-only)", sandboxed: false },
  docker: { id: "docker", title: "Docker sandbox", sandboxed: true },
  openshell: { id: "openshell", title: "NVIDIA OpenShell", sandboxed: true },
};

export function normalizeRespondTo(value, fallback = "owner-only") {
  if (value === undefined || value === null || value === "") return fallback;
  const clean = String(value).trim().toLowerCase();
  if (!RESPOND_TO_MODES.has(clean)) {
    throw new Error(`Invalid respondTo mode "${value}" (expected owner-only, allowlist, or anyone)`);
  }
  return clean;
}

/** Normalize an allowlist from an array or comma/whitespace-separated string of 64-hex pubkeys. */
export function normalizeAllowlist(value, fallback = []) {
  if (value === undefined || value === null) return [...fallback];
  const rawList = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : null;
  if (!rawList) throw new Error("respondToAllowlist must be a list of 64-hex pubkeys");
  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    const clean = String(item ?? "").trim().toLowerCase();
    if (!clean) continue;
    if (!HEX64.test(clean)) {
      throw new Error(`Invalid pubkey in respondToAllowlist: "${clean.slice(0, 24)}"`);
    }
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  if (out.length > MAX_ALLOWLIST) {
    throw new Error(`respondToAllowlist cannot exceed ${MAX_ALLOWLIST} pubkeys`);
  }
  return out;
}

/** Validate and normalize runner + respondTo together, enforcing the sandbox invariant. */
export function normalizeRunner(value, respondTo = "owner-only", fallback = "host") {
  const mode = normalizeRespondTo(respondTo);
  const explicit = value !== undefined && value !== null && String(value).trim() !== "";
  let runner = explicit ? String(value).trim().toLowerCase() : "";

  if (!runner) {
    if (mode !== "owner-only") {
      runner = fallback && fallback !== "host" ? fallback : "docker";
    } else {
      runner = fallback || "host";
    }
  }

  if (!Object.hasOwn(RUNNERS, runner)) {
    throw new Error(`Unknown runner "${runner}"`);
  }
  if (runner === "openshell") {
    openshellRunner.validateSelectable();
  }
  if (mode !== "owner-only" && runner === "host") {
    throw new Error('Shared agents (respondTo != "owner-only") must use a sandboxed runner (docker)');
  }
  return runner;
}

export function isSandboxed(meta) {
  return Boolean(meta?.runner && meta.runner !== "host");
}

export function assertSandboxRestrictions(meta) {
  if (!isSandboxed(meta)) return;
  if (meta.orchestrate === true) {
    throw new Error("Sandboxed agents cannot enable host orchestration");
  }
}

export function createRunnerManager({
  dataDir,
  runDir,
  workDir,
  libDir,
  homeDir = os.homedir(),
  dockerImage = DEFAULT_DOCKER_IMAGE,
  callTool,
  isAttentionEnabled,
  isDesktopEnabled = null,
  computerModule = null,
  log = console,
}) {
  const proxy = createSandboxProxy({ dataDir, runDir, homeDir, log });
  const mcpBridge = createSandboxMcpBridge({
    runDir,
    callTool,
    isAttentionEnabled,
    isDesktopEnabled,
    computerModule,
    log,
  });

  const sandboxRunDir = (pubkey) => path.join(runDir, "sandbox", pubkey.slice(0, 16));
  const controlDirFor = (pubkey) => path.join(runDir, `${pubkey.slice(0, 16)}.d`);

  async function availableRunners({ fresh = false } = {}) {
    const [docker, openshell] = await Promise.all([
      checkDockerAvailability({ image: dockerImage, fresh }),
      openshellRunner.availability(),
    ]);
    return [
      {
        id: "host",
        title: "Host (owner-only)",
        available: true,
        note: "Runs natively as a systemd service; restricted to owner-only.",
      },
      docker,
      openshell,
    ];
  }

  /** Prepare sockets, isolated home, and env files for a sandboxed agent. No-op for host runner. */
  async function prepareAgent(pubkey, meta) {
    if (!isSandboxed(meta)) {
      await proxy.removeAgent(pubkey);
      await mcpBridge.removeAgent(pubkey);
      return null;
    }
    assertSandboxRestrictions(meta);

    const agentDir = path.join(dataDir, pubkey);
    const runSubdir = sandboxRunDir(pubkey);
    const controlDir = controlDirFor(pubkey);
    await Promise.all([
      fs.mkdir(path.join(runSubdir, "agent"), { recursive: true, mode: 0o700 }),
      fs.mkdir(path.join(agentDir, "fresh"), { recursive: true, mode: 0o700 }),
      fs.mkdir(path.join(agentDir, "wake", "results"), { recursive: true, mode: 0o700 }),
      fs.mkdir(controlDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(path.join(workDir, pubkey), { recursive: true }),
    ]);

    const [{ token }, _mcp, agyProjectId, useGeminiApiKey] = await Promise.all([
      proxy.ensureAgent(pubkey),
      mcpBridge.ensureAgent(pubkey),
      proxy.getAgyProjectId().catch(() => ""),
      proxy.hasGeminiApiKey().catch(() => false),
    ]);

    await prepareSandboxHome({
      agentDir,
      pubkey,
      model: meta.model || "",
      proxyToken: token,
      agyProjectId,
      useGeminiApiKey,
    });

    const withAttention = isAttentionEnabled ? await isAttentionEnabled(pubkey) : false;
    // A restart re-lists tools: drop the shared desktop client so the
    // agent's new sessions see its current desktop setting.
    mcpBridge.dropComputer(pubkey);
    const envFile = await writeSandboxEnv({
      agentDir,
      sandboxRunDir: runSubdir,
      pubkey,
      meta,
      proxyToken: token,
      withAttention,
      useGeminiApiKey,
    });

    return { sandboxRunDir: runSubdir, controlDir, envFile, libDir };
  }

  /** Re-establish proxy and MCP Unix sockets on buzz-host startup for active sandboxed agents. */
  async function reconcileOnStartup(metas) {
    for (const m of metas) {
      if (!m?.activated || !isSandboxed(m)) continue;
      try {
        await prepareAgent(m.pubkey, m);
      } catch (error) {
        log.error?.(`sandbox reconcile ${m.pubkey.slice(0, 8)}: ${error.message}`);
      }
    }
  }

  async function cleanupAgent(pubkey) {
    await Promise.all([stopDockerContainer(pubkey), removeDesktopSidecar(pubkey)]);
    await Promise.all([proxy.removeAgent(pubkey), mcpBridge.removeAgent(pubkey)]);
    await fs.rm(sandboxRunDir(pubkey), { recursive: true, force: true }).catch(() => {});
  }

  async function close() {
    await Promise.all([proxy.close(), mcpBridge.close()]);
  }

  return {
    availableRunners,
    prepareAgent,
    reconcileOnStartup,
    cleanupAgent,
    close,
    proxy,
    mcpBridge,
  };
}
