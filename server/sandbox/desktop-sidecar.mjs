// The desktop of a sandboxed (Docker) agent: a second hardened container next
// to the agent's own, running buzz-host's desktop launcher (Xvnc + Xfce) and
// cua-driver (issue #39). desktop/desktop.mjs drives it; this file only knows
// Docker.
//
// Same hardening as the agent container (docker.mjs): non-root as this user,
// --cap-drop=ALL, no-new-privileges, read-only rootfs, resource limits, and
// the filtered buzz-sandbox network (internet only; the start fails closed
// while the egress filter is down). It mounts only:
//   - the agent's desktop dir (rw): xdg config, browser profile, env, logs
//   - the agent's socket dir (rw): rfb.sock and cua.sock come out here
//   - buzz-host's desktop launcher and this entry script (ro)
//   - the cua-driver release dir (ro)
//   - a passwd/group naming this uid (dbus refuses to run without one)
//   - optionally the agent's workspace (rw) at /workspace, the same folder its
//     agent container has there (~/buzz-sandboxes/<tokenId> for a guest's
//     owner-only agents, else ~/buzz-agents/<pubkey>); ~/Workspace links to it
// Every other path is mounted at its host path, so the env file, the browser
// wrapper and launch_app paths mean the same on both sides. No agent key,
// relay auth or credentials are mounted.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SANDBOX_NETWORK, SANDBOX_BRIDGE, SANDBOX_FIREWALL_UNIT } from "./docker.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENTRY = path.join(HERE, "desktop", "entry.sh");
export const DEFAULT_DESKTOP_IMAGE = process.env.BUZZ_SANDBOX_DESKTOP_IMAGE || "buzz-host-desktop:latest";
const MARKER = "sidecar";

export const containerName = (pubkey) => `buzz-desktop-${pubkey.slice(0, 16)}`;

/** The desktop dir belongs to a sidecar desktop (vs. a host one). */
export const isSidecar = (dir) => fs.existsSync(path.join(dir, MARKER));
export const writeMarker = (dir) => fs.writeFileSync(path.join(dir, MARKER), "docker\n", { mode: 0o600 });
export const clearMarker = (dir) => fs.rmSync(path.join(dir, MARKER), { force: true });

/** The hardened `docker run` arguments. Pure, for tests. */
export function buildDesktopArgs({
  pubkey,
  dir,
  socketDir,
  launcherDir,
  cuaDriver,
  workspaceDir,
  env = {},
  image = DEFAULT_DESKTOP_IMAGE,
  network = SANDBOX_NETWORK,
  memory = process.env.BUZZ_SANDBOX_DESKTOP_MEMORY || "2048m",
  cpus = process.env.BUZZ_SANDBOX_DESKTOP_CPUS || "2",
  pidsLimit = Number(process.env.BUZZ_SANDBOX_DESKTOP_PIDS_LIMIT) || 512,
  uid = process.getuid?.() ?? 1000,
  gid = process.getgid?.() ?? 1000,
}) {
  const ro = (p) => ["-v", `${p}:${p}:ro`];
  const rw = (p) => ["-v", `${p}:${p}:rw`];
  const allEnv = {
    HOME: path.join(dir, "home"),
    USER: "agent",
    LANG: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    BUZZ_DESKTOP_LAUNCHER: path.join(launcherDir, "launcher.sh"),
    BUZZ_DESKTOP_CUA: cuaDriver,
    BUZZ_DESKTOP_LOG: path.join(dir, "launcher.log"),
    ...env,
  };
  const args = [
    "run",
    "-d",
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
    // Chromium's renderers share memory through /dev/shm.
    "--shm-size=512m",
    "--log-driver=none",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m",
    "--tmpfs",
    "/var/tmp:rw,nosuid,nodev,size=64m",
    "-v",
    `${path.join(dir, "passwd")}:/etc/passwd:ro`,
    "-v",
    `${path.join(dir, "group")}:/etc/group:ro`,
    ...rw(dir),
    ...rw(socketDir),
    ...ro(launcherDir),
    ...ro(path.dirname(ENTRY)),
    ...ro(path.dirname(cuaDriver)),
  ];
  if (workspaceDir) {
    if (!path.isAbsolute(workspaceDir) || /[:\r\n,]/.test(workspaceDir))
      throw new Error("desktop sidecar: workspaceDir must be an absolute path without ':' or ','");
    args.push("-v", `${path.resolve(workspaceDir)}:/workspace:rw`);
  }
  for (const [k, v] of Object.entries(allEnv)) {
    if (v === undefined || v === null || v === "") continue;
    if (/[\r\n]/.test(String(v))) throw new Error(`desktop sidecar: ${k} has a newline`);
    args.push("-e", `${k}=${v}`);
  }
  args.push(image, "bash", ENTRY);
  return args;
}

/** Fail closed like docker-run: no egress filter, no container. */
async function ensureNetwork() {
  try {
    await run("systemctl", ["is-active", "--quiet", SANDBOX_FIREWALL_UNIT], { timeout: 5_000 });
  } catch {
    throw new Error(
      `${SANDBOX_FIREWALL_UNIT} is not active; refusing to start a sandboxed desktop without the egress filter (run: sudo server/sandbox/install-firewall.sh)`,
    );
  }
  const inspect = () =>
    run("docker", ["network", "inspect", "-f", '{{index .Options "com.docker.network.bridge.name"}}', SANDBOX_NETWORK], {
      timeout: 10_000,
    });
  let out;
  try {
    out = await inspect();
  } catch {
    await run(
      "docker",
      [
        "network",
        "create",
        "--driver",
        "bridge",
        "--subnet",
        process.env.BUZZ_SANDBOX_SUBNET || "172.30.0.0/24",
        "-o",
        `com.docker.network.bridge.name=${SANDBOX_BRIDGE}`,
        "-o",
        "com.docker.network.bridge.enable_icc=false",
        SANDBOX_NETWORK,
      ],
      { timeout: 15_000 },
    ).catch(() => {});
    out = await inspect();
  }
  const bridge = out.stdout.trim();
  if (bridge !== SANDBOX_BRIDGE)
    throw new Error(`docker network ${SANDBOX_NETWORK} must use bridge ${SANDBOX_BRIDGE} (got '${bridge}')`);
}

/** ~/Workspace -> /workspace inside the container (dangling on the host side,
 *  where nothing follows it). Never replaces a real file the user made. */
function linkWorkspace(dir, withWorkspace) {
  const link = path.join(dir, "home", "Workspace");
  let current = null;
  try {
    current = fs.lstatSync(link);
  } catch {}
  if (current && !current.isSymbolicLink()) return;
  if (!withWorkspace) {
    if (current) fs.rmSync(link, { force: true });
    return;
  }
  if (current && fs.readlinkSync(link) === "/workspace") return;
  if (current) fs.rmSync(link, { force: true });
  fs.symlinkSync("/workspace", link);
}

function writeIdentity(dir, uid, gid) {
  fs.mkdirSync(path.join(dir, "home"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, "passwd"),
    `root:x:0:0:root:/root:/usr/sbin/nologin\nagent:x:${uid}:${gid}:agent:${path.join(dir, "home")}:/bin/bash\n`,
    { mode: 0o644 },
  );
  fs.writeFileSync(path.join(dir, "group"), `root:x:0:\nagent:x:${gid}:\n`, { mode: 0o644 });
}

/** Start the container; returns the host pid of its init (runs as this user). */
export async function run_(pubkey, opts) {
  const image = opts.image ?? DEFAULT_DESKTOP_IMAGE;
  try {
    await run("docker", ["image", "inspect", image], { timeout: 10_000 });
  } catch {
    throw new Error(`desktop: image ${image} is not built (run server/sandbox/build-image.sh --desktop)`);
  }
  await ensureNetwork();
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  writeIdentity(opts.dir, uid, gid);
  linkWorkspace(opts.dir, Boolean(opts.workspaceDir));
  await remove(pubkey);
  await run("docker", buildDesktopArgs({ pubkey, uid, gid, ...opts }), { timeout: 60_000 });
  const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Pid}}", containerName(pubkey)], {
    timeout: 10_000,
  });
  const pid = Number(stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("desktop: the desktop container did not start");
  return pid;
}
export { run_ as run };

export async function remove(pubkey) {
  await run("docker", ["rm", "-f", containerName(pubkey)], { timeout: 20_000 }).catch(() => {});
}
