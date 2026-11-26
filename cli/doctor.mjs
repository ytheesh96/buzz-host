// `buzz-host doctor`: is this machine ready to run buzz-host and its agents?
// Every check is read-only. Each reports ok, warn (works, but look), fail
// (something won't work) or info (optional / for your information).

import { constants } from "node:fs";
import path from "node:path";
import { parseListenerConfig } from "../server/auth.mjs";
import { resolvePublicUrl } from "../server/tokens-cli.mjs";
import { listenerPorts, parseArgs, printJson } from "./host.mjs";

export const DOCTOR_USAGE = `Usage: buzz-host doctor [--json]

Check this machine: user service manager, linger, installed files, config,
buzz-host and its ports, iroh, agent runtimes (installed + signed in), Python,
Docker and tokens. Read-only; fixes are printed, never applied.
Exits 1 when a check fails, 0 otherwise (warnings don't fail it).

Options:
  --json   Print {ok, summary, checks[]}; each check is {id, status, message, hint?}
  -h, --help`;

const MARKS = { ok: "ok  ", warn: "warn", fail: "FAIL", info: "info" };

async function exists(fs, file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function onPath(fs, name, env) {
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    try {
      await fs.access(path.join(dir, name), constants.X_OK);
      return path.join(dir, name);
    } catch {}
  }
  return null;
}

/** The ACP adapter each runtime needs, and where its sign-in lives (null when it can't be checked here). */
function runtimeSpecs(host) {
  const lib = host.paths.lib;
  const h = host.home;
  const mac = host.platform === "darwin";
  return [
    {
      id: "claude",
      adapter: path.join(lib, "npm/node_modules/.bin/claude-agent-acp"),
      installHint: "run `buzz-host up` (it installs the Claude/Codex adapters)",
      signedIn: mac ? null : [path.join(h, ".claude/.credentials.json")],
      envKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      loginHint: "run `claude` once and sign in",
    },
    {
      id: "codex",
      adapter: path.join(lib, "npm/node_modules/.bin/codex-acp"),
      installHint: "run `buzz-host up` (it installs the Claude/Codex adapters)",
      signedIn: [path.join(h, ".codex/auth.json")],
      envKeys: ["OPENAI_API_KEY"],
      loginHint: "run `codex login`",
    },
    {
      id: "hermes",
      adapter: path.join(h, ".local/bin/hermes-acp"),
      installHint: "install Hermes (hermes-agent) for this user",
      signedIn: [path.join(h, ".hermes/auth.json")],
      envKeys: [],
      loginHint: "run `hermes login`",
    },
    {
      id: "antigravity",
      adapter: [
        path.join(h, ".local/share/mise/installs/antigravity-cli/latest/agy"),
        path.join(h, ".local/share/mise/shims/agy"),
      ],
      installHint: "install the Antigravity CLI (agy) with mise",
      signedIn: [path.join(h, ".gemini/google_accounts.json")],
      envKeys: [],
      loginHint: "run `agy` once and sign in",
    },
  ];
}

export async function runChecks(host) {
  const { fs, env, run, paths } = host;
  const checks = [];
  const add = (id, status, message, hint) => checks.push({ id, status, message, ...(hint && status !== "ok" && { hint }) });
  const sm = host.services;
  const config = await host.config();

  // --- user service manager
  if (host.platform === "linux") {
    let ok = true;
    try {
      await run("systemctl", ["--user", "show-environment"], { timeout: 15_000 });
      add("service-manager", "ok", "systemd --user is available");
    } catch (error) {
      ok = false;
      add("service-manager", "fail", `systemctl --user is not usable (${(error.stderr || error.message || "").trim().split("\n")[0]})`,
        "log in through a session with a user systemd (a desktop login or `ssh` with pam_systemd), or set XDG_RUNTIME_DIR");
    }
    if (ok) {
      let linger = "";
      try {
        linger = (await run("loginctl", ["show-user", host.user, "-p", "Linger"], { timeout: 15_000 })).stdout.trim();
      } catch {}
      if (/Linger=yes/.test(linger)) add("linger", "ok", `lingering is on for ${host.user}`);
      else add("linger", "warn", `lingering is ${linger ? "off" : "unknown"} for ${host.user}: buzz-host and its agents stop when you log out`,
        `run \`sudo loginctl enable-linger ${host.user}\` (or \`buzz-host up\`)`);
    }
  } else {
    try {
      await run("launchctl", ["print", `gui/${host.uid}`], { timeout: 15_000 });
      add("service-manager", "ok", `launchd gui/${host.uid} domain is available`);
    } catch {
      add("service-manager", "fail", `no launchd gui/${host.uid} domain: nobody is logged in to the desktop`,
        "log in to the Mac (enable automatic login on a headless Mac)");
    }
  }

  // --- installed files and config
  const installed = (await exists(fs, path.join(paths.lib, "buzz-host.mjs"))) && (await exists(fs, paths.serviceFile));
  if (installed) add("install", "ok", `buzz-host is installed in ${paths.lib}`);
  else add("install", "fail", `buzz-host is not installed (missing ${paths.lib}/buzz-host.mjs or ${paths.serviceFile})`, "run `buzz-host up`");

  if (!(await exists(fs, paths.config))) {
    add("config", "fail", `${paths.config} is missing`, "run `buzz-host up`");
  } else {
    try {
      const raw = JSON.parse(await fs.readFile(paths.config, "utf8"));
      parseListenerConfig(raw, paths.config);
      add("config", "ok", `${paths.config} is valid`);
    } catch (error) {
      add("config", "fail", error.message, `fix ${paths.config}`);
    }
  }

  // --- buzz-host and its ports
  const state = await sm.server.status();
  const ports = listenerPorts(config);
  if (state === "active") {
    add("server", "ok", `${sm.server.unit} is running`);
    const tokenOk = await host.healthy(ports.guest);
    add("port-token", tokenOk ? "ok" : "fail", tokenOk ? `token listener answers on 127.0.0.1:${ports.guest}` : `nothing answers on 127.0.0.1:${ports.guest}/health`,
      "check `buzz-host logs`; another program may hold the port (change guestPort in config.json)");
    if (ports.tailnet) {
      const ok = await host.healthy(ports.tailnet);
      add("port-tailnet", ok ? "ok" : "fail", ok ? `tailnet listener answers on 127.0.0.1:${ports.tailnet}` : `nothing answers on 127.0.0.1:${ports.tailnet}/health`, "check `buzz-host logs`");
    }
  } else {
    add("server", "fail", `${sm.server.unit} is ${state}`, "run `buzz-host restart` (or `buzz-host up`), then `buzz-host logs`");
  }
  const url = resolvePublicUrl(config);
  if (/^ws:\/\/127\.0\.0\.1[:/]/.test(url)) add("public-url", "info", `connections need an SSH tunnel: no public URL is set (${url})`, "expose it (e.g. `tailscale funnel`) and run `buzz-host up --url wss://…`");
  else add("public-url", "info", `clients connect to ${url}`);

  // --- iroh
  if (config.iroh === false) add("iroh", "info", "iroh is turned off in config.json");
  else if (!(await exists(fs, path.join(paths.bin, "buzz-host-iroh")))) add("iroh", "info", "buzz-host-iroh is not installed, so there's no iroh route (the bundle ships it)");
  else {
    const addr = (await host.fs.readFile(path.join(host.runDir, "iroh-addr.json"), "utf8").catch(() => "")).trim();
    if (addr) add("iroh", "ok", "the iroh endpoint is up");
    else add("iroh", state === "active" ? "warn" : "info", "the iroh endpoint is not up yet", "give it a few seconds after start; see `buzz-host logs`");
  }

  // --- binaries agents need
  const missingBins = [];
  for (const name of ["buzz-acp", "buzz", "acp-proxy"]) {
    if (!(await exists(fs, path.join(paths.bin, name)))) missingBins.push(name);
  }
  if (missingBins.length) add("binaries", "fail", `missing from ${paths.bin}: ${missingBins.join(", ")}`, "run `buzz-host up` (bundle) or `./deploy.sh` (checkout)");
  else add("binaries", "ok", "buzz-acp, buzz and acp-proxy are installed");
  const python = await onPath(fs, "python3", env);
  add("python", python ? "ok" : "fail", python ? `python3 is ${python}` : "python3 is not on PATH (acp-proxy needs it)", python ? undefined : "install python3");

  // --- runtimes: on PATH/installed, and signed in
  let anyRuntime = false;
  for (const spec of runtimeSpecs(host)) {
    const adapters = [spec.adapter].flat();
    let found = null;
    for (const file of adapters) if (!found && (await exists(fs, file))) found = file;
    if (!found) {
      add(`runtime-${spec.id}`, "info", `${spec.id}: not installed`, spec.installHint);
      continue;
    }
    anyRuntime = true;
    const viaEnv = spec.envKeys.find((k) => env[k]);
    let signedIn = viaEnv ? true : null;
    if (signedIn === null && spec.signedIn) {
      signedIn = false;
      for (const file of spec.signedIn) if (await exists(fs, file)) signedIn = true;
    }
    if (signedIn === true) add(`runtime-${spec.id}`, "ok", `${spec.id}: installed and signed in${viaEnv ? ` (${viaEnv})` : ""}`);
    else if (signedIn === false) add(`runtime-${spec.id}`, "warn", `${spec.id}: installed, but no sign-in found`, spec.loginHint);
    else add(`runtime-${spec.id}`, "ok", `${spec.id}: installed (sign-in not checkable on ${host.platform})`);
  }
  if (!anyRuntime) add("runtimes", "warn", "no agent runtime is installed, so agents can't answer", "install one (see the runtime-* lines)");

  // --- optional
  const docker = await onPath(fs, "docker", env);
  add("docker", "info", docker ? "docker is on PATH (sandboxed agents available)" : "docker is not on PATH (only host agents; sandboxed agents need it)");

  // --- tokens
  try {
    const tokens = JSON.parse(await fs.readFile(paths.tokens, "utf8")).tokens ?? [];
    const live = tokens.filter((t) => !t.revokedAt);
    add("tokens", "info", `${live.length} active access token(s) (${live.filter((t) => t.role === "admin").length} admin), ${tokens.length - live.length} revoked`);
  } catch (error) {
    if (error.code === "ENOENT") add("tokens", "info", "no access tokens yet", "`buzz-host pair` makes the first one");
    else add("tokens", "warn", `can't read ${paths.tokens} (${error.message})`);
  }
  return checks;
}

export async function runDoctor(argv, host, io) {
  const { opts } = parseArgs(argv, { flags: ["json"] });
  if (opts.help) {
    io.out(DOCTOR_USAGE);
    return 0;
  }
  const checks = await runChecks(host);
  const count = (status) => checks.filter((c) => c.status === status).length;
  const summary = { ok: count("ok"), warn: count("warn"), fail: count("fail"), info: count("info") };
  const ok = summary.fail === 0;
  if (opts.json) printJson(io, { ok, summary, checks });
  else {
    for (const c of checks) {
      io.out(`[${MARKS[c.status]}] ${c.message}`);
      if (c.hint && c.status !== "ok") io.out(`        -> ${c.hint}`);
    }
    io.out("");
    io.out(`${summary.ok} ok, ${summary.warn} warning(s), ${summary.fail} failure(s)`);
  }
  return ok ? 0 : 1;
}
