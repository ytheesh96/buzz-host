// `buzz-host logs [agent]`: journalctl --user on Linux, the log files in
// ~/Library/Logs/buzz-host on macOS, through server/service-manager.mjs.

import { spawn } from "node:child_process";
import { intOption, parseArgs, printJson } from "./host.mjs";

export const LOGS_USAGE = `Usage: buzz-host logs [agent] [-n <lines>] [-f] [--json]

Show buzz-host's log, or one agent's (name, or a pubkey prefix of 4+ hex digits).
Linux reads the user journal (journalctl --user), macOS ~/Library/Logs/buzz-host.

Options:
  -n, --lines <n>   How many lines (default 80, at most 500)
  -f, --follow      Keep printing new lines (not with --json)
  --json            Print {target, unit, lines[]}
  -h, --help`;

/** Start `command` with the terminal attached; resolves with its exit code. */
function follow(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(signal ? 130 : (code ?? 0)));
  });
}

export async function runLogs(argv, host, io, { followFn = follow } = {}) {
  const { opts, positional } = parseArgs(argv, {
    flags: ["json", "follow"],
    values: ["lines"],
    short: { n: "lines", f: "follow" },
  });
  if (opts.help) {
    io.out(LOGS_USAGE);
    return 0;
  }
  if (positional.length > 1) throw new Error("logs takes at most one agent");
  if (opts.follow && opts.json) throw new Error("--follow can't be combined with --json");
  const lines = intOption(opts.lines, "lines", 80, { max: 500 });
  const sm = host.services;
  const agent = positional.length ? await host.findAgent(positional[0]) : null;
  const unit = agent ? sm.unit(agent.pubkey) : sm.server.unit;

  if (opts.follow) {
    if (host.platform === "linux") return followFn("journalctl", ["--user", "-u", unit, "-n", String(lines), "-f", "-o", "short-iso"]);
    const file = agent ? sm.logPath(agent.pubkey) : sm.server.logPath;
    return followFn("tail", ["-n", String(lines), "-F", file]);
  }
  const text = agent ? await sm.logs(agent.pubkey, lines) : await sm.server.logs(lines);
  if (opts.json) {
    const all = text.split("\n");
    if (all.at(-1) === "") all.pop();
    printJson(io, { target: agent ? { pubkey: agent.pubkey, name: agent.name } : "server", unit, lines: all });
  } else if (text) io.out(text.replace(/\n$/, ""));
  else io.err(`no log lines for ${unit}`);
  return 0;
}
