// `buzz-host links add|list|test|update|remove`: peer host links for
// cross-machine delegation (server/links-cli.mjs).

import path from "node:path";
import { runLinks } from "../server/links-cli.mjs";

export const LINKS_USAGE = `Usage: buzz-host links <command> [options]

Commands:
  add <buzz-host-link:v1:…> [--name <override>]
                          Save a peer host link from a pairing blob minted by \`tokens create-delegate\`
  list                    List saved peer links and their status (never prints secrets)
  test <id|name>          Connect to the peer host and run delegate.hello
  update <id|name> [--blob <blob>] [--name <name>] [--token <bhd_…>]
                          Update a link's routes, name, or rotate its delegate token
  remove <id|name>        Remove a saved peer link

Every command takes --json and --file <links.json>. \`buzz-host-links <command>\` does the same.`;

export async function runLinksCommand(argv, host, io) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    io.out(LINKS_USAGE);
    return argv.length ? 0 : 2;
  }
  const linksFile = host.env.BUZZ_HOST_LINKS_FILE || path.join(host.home, ".config/buzz-host/links.json");
  return runLinks(argv, {
    prog: "buzz-host links",
    env: host.env,
    home: host.home,
    linksFile,
    configFile: host.paths.config,
    libDir: host.paths.lib,
    out: io.out,
    err: io.err,
  });
}
