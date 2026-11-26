// Peer-host link commands behind `buzz-host links …` and `buzz-host-links`.
//
//   add <buzz-host-link:v1:…> [--name <override>]
//   list
//   test <id|name|machineId>
//   update <id|name|machineId> [--blob <buzz-host-link:v1:…>] [--name <name>] [--token <bhd_…>]
//   remove <id|name|machineId>
//   every command takes --json and --file <links.json>

import os from "node:os";
import path from "node:path";
import { createLinkManager } from "./links.mjs";
import { parseFlags, readConfig } from "./tokens-cli.mjs";

export function defaultLinkPaths({ env = process.env, home = os.homedir() } = {}) {
  return {
    linksFile: env.BUZZ_HOST_LINKS_FILE || path.join(home, ".config/buzz-host/links.json"),
    configFile: env.BUZZ_HOST_CONFIG || path.join(home, ".config/buzz-host/config.json"),
    libDir: env.BUZZ_HOST_LIB_DIR || path.join(home, ".local/lib/buzz-host"),
  };
}

export async function runLinks(
  argv,
  {
    prog = "buzz-host links",
    env = process.env,
    home = os.homedir(),
    out = (line) => process.stdout.write(`${line}\n`),
    err = (line) => process.stderr.write(`${line}\n`),
    ...overrides
  } = {},
) {
  const [cmd, ...args] = argv;
  const { flags, rest } = parseFlags(args);
  const defaults = defaultLinkPaths({ env, home });
  const linksFile =
    typeof flags.file === "string" && flags.file.trim() ? flags.file.trim() : (overrides.linksFile ?? defaults.linksFile);
  const configFile = overrides.configFile ?? defaults.configFile;
  const libDir = overrides.libDir ?? defaults.libDir;
  const cfg = await readConfig(configFile);
  const manager = createLinkManager({
    filePath: linksFile,
    config: () => cfg,
    libDir,
    WebSocketImpl: overrides.WebSocketImpl,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const json = (value) => out(JSON.stringify(value, null, 2));

  try {
    if (cmd === "add") {
      const blob = rest[0] || flags.blob;
      if (!blob) throw new Error(`Usage: ${prog} add <buzz-host-link:v1:…> [--name <name>]`);
      const { link } = await manager.add({
        blob,
        ...(typeof flags.name === "string" && flags.name.trim() ? { name: flags.name.trim() } : {}),
      });
      if (flags.json) {
        json({ link });
      } else {
        out(`Added link ${link.id} for "${link.name}" (machineId=${link.machineId})`);
        out(`Routes: ${link.routes.map((r) => (r.type === "iroh" ? `iroh:${r.nodeId.slice(0, 12)}…` : r.url)).join(", ")}`);
        out(`Test with: ${prog} test ${link.name}`);
      }
    } else if (cmd === "list") {
      const { links } = await manager.list();
      if (flags.json) {
        json({ links });
      } else if (!links.length) {
        out("No peer links configured.");
      } else {
        for (const l of links) {
          const routes = l.routes.map((r) => (r.type === "iroh" ? "iroh" : r.url)).join(",");
          const seen = l.lastSeenAt ? `lastSeen=${l.lastSeenAt}` : "never connected";
          out(`${l.id}  ${l.name}  [${l.status}]  machine=${l.machineId}  routes=${routes}  ${seen}`);
        }
      }
    } else if (cmd === "test") {
      const target = rest[0] || flags.id;
      if (!target) throw new Error(`Usage: ${prog} test <id|name|machineId>`);
      const result = await manager.test(target);
      if (flags.json) {
        json(result);
      } else {
        const agents = (result.hello.agents || []).length;
        const rts = (result.hello.runtimes || [])
          .filter((r) => r.available)
          .map((r) => r.id)
          .join("/");
        out(`${result.link.name}: ok (${agents} eligible agent${agents === 1 ? "" : "s"}, runtimes: ${rts || "none"}, access=${result.hello.limits?.access})`);
      }
    } else if (cmd === "update") {
      const target = rest[0] || flags.id;
      if (!target) throw new Error(`Usage: ${prog} update <id|name|machineId> [--blob <blob>] [--name <name>] [--token <bhd_…>]`);
      const patch = { selector: target };
      if (typeof flags.blob === "string") patch.blob = flags.blob;
      if (typeof flags.name === "string") patch.name = flags.name;
      if (typeof flags.token === "string") patch.token = flags.token;
      const { link } = await manager.update(patch);
      if (flags.json) json({ link });
      else out(`Updated link ${link.id} ("${link.name}")`);
    } else if (cmd === "remove") {
      const target = rest[0] || flags.id;
      if (!target) throw new Error(`Usage: ${prog} remove <id|name|machineId>`);
      const { link } = await manager.remove({ selector: target });
      if (flags.json) json({ link });
      else out(`Removed link ${link.id} ("${link.name}")`);
    } else {
      err(`Usage: ${prog} <add|list|test|update|remove> [options]`);
      return 2;
    }
    return 0;
  } catch (error) {
    err(`Error: ${error.message}`);
    return 1;
  } finally {
    await manager.close().catch(() => {});
  }
}
