// `buzz-host tokens create|create-admin|list|revoke`: the same code as the
// `buzz-host-tokens` compatibility shim (server/tokens-cli.mjs), pointed at
// this host's tokens.json and config.json.

import { runTokens } from "../server/tokens-cli.mjs";

export const TOKENS_USAGE = `Usage: buzz-host tokens <command> [options]

Commands:
  create [--label <name>] [--owner <64-hex>] [--max-agents <n>] [--max-concurrency <n>]
         [--runtimes hermes,claude,antigravity] [--allow-host-desktop] [--no-sandbox-desktop] [--url wss://…]
                          Guest token (bhg_): a sandboxed friend account with caps
  create-admin [--label <name>] [--owner <64-hex>] [--url wss://…]
                          Admin token (bha_): full access to this host, like a password
  create-delegate --label <name> --owner <64-hex> [--agents all|<pk,…>] [--runtimes claude,codex]
                  [--access sandboxed|host] [--workspaces ~/Work,…] [--max-concurrency 2] [--expires 90d]
                          Delegate token (bhd_): scoped cross-machine worker execution + pairing blob
  list                    Every token's id, role, label, owner and status (never the secret)
  revoke <tok_…>          Cut a token off; buzz-host drops its connections within ~15 s

Every command takes --json (one JSON document on stdout) and --file <tokens.json>.
The secret is printed once, at creation, together with a 1-paste URL: <url>#token=<secret>.
The URL is --url, else publicGuestUrl in config.json, else ws://127.0.0.1:<guestPort>
when that is empty. \`buzz-host-tokens <command>\` still works and does the same.`;

export async function runTokensCommand(argv, host, io) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    io.out(TOKENS_USAGE);
    return argv.length ? 0 : 2;
  }
  return runTokens(argv, {
    prog: "buzz-host tokens",
    env: host.env,
    home: host.home,
    tokensFile: host.paths.tokens,
    configFile: host.paths.config,
    machineIdFile: host.paths.machineId,
    runDir: host.runDir,
    out: io.out,
    err: io.err,
  });
}
